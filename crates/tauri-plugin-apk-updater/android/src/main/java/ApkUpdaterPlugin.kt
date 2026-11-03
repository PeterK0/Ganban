// The phone updates itself from the host (ADR 0007, docs/design/UPDATES.md), or from
// GitHub Releases on a GitHub build (ADR 0008).
//
//   apk_version()                      → { versionCode, versionName }
//   apk_download(url, token?, sha256,  → { path, size }      (streams to cache/updates/,
//                onProgress?)                                  checks the sha256 unless empty)
//   apk_install(path, openSettings?)   → { status: "started" | "needs_permission" }
package app.ganban.apkupdater

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    var token: String? = null
    /** Empty: don't check (a GitHub asset without a digest; Android still refuses
     * an APK signed by another key). */
    var sha256: String = ""
    var onProgress: Channel? = null
}

@InvokeArg
class InstallArgs {
    lateinit var path: String
    /** false: when installs aren't allowed yet, just say so (the app coming back
     * from Android's setting asks this way, so it never reopens it). */
    var openSettings: Boolean = true
}

private const val APK_NAME = "ganban-update.apk"

@TauriPlugin
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {

    /** Downloads land here; `res/xml/file_paths.xml` exposes it to the FileProvider. */
    private fun updatesDir(): File = File(activity.cacheDir, "updates").apply { mkdirs() }

    @Command
    fun apkVersion(invoke: Invoke) {
        try {
            val pm = activity.packageManager
            @Suppress("DEPRECATION")
            val info = pm.getPackageInfo(activity.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
            else @Suppress("DEPRECATION") info.versionCode.toLong()
            val ret = JSObject()
            ret.put("versionCode", code)
            ret.put("versionName", info.versionName ?: "")
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject("Couldn't read the app's version: ${e.message}")
        }
    }

    @Command
    fun apkDownload(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadArgs::class.java)
        // Off the calling thread: an APK is tens of MB over the tailnet.
        Thread {
            val dest = File(updatesDir(), APK_NAME)
            val part = File(updatesDir(), "$APK_NAME.part")
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(args.url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    // No transparent gzip: the progress and the length check use the real size.
                    setRequestProperty("Accept-Encoding", "identity")
                    // GitHub's asset links redirect (https to https, which this follows) to a CDN.
                    args.token?.takeIf { it.isNotEmpty() }?.let { setRequestProperty("Authorization", "Bearer $it") }
                }
                val code = conn.responseCode
                if (code != 200) {
                    // A token means the host; none means a GitHub release asset.
                    val fromHost = !args.token.isNullOrEmpty()
                    invoke.reject(
                        when {
                            fromHost && (code == 401 || code == 403) -> "The host refused the download (HTTP $code): pair this phone again."
                            fromHost && code == 404 -> "The host has no Android build."
                            fromHost -> "The host answered HTTP $code."
                            else -> "The download failed (HTTP $code)."
                        }
                    )
                    return@Thread
                }
                val total = conn.contentLengthLong
                val digest = MessageDigest.getInstance("SHA-256")
                var done = 0L
                var lastSent = 0L
                part.delete()
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            done += n
                            // At most ~every 256 KB, so the webview isn't flooded.
                            if (done - lastSent >= 256 * 1024) {
                                lastSent = done
                                sendProgress(args.onProgress, done, total)
                            }
                        }
                    }
                }
                sendProgress(args.onProgress, done, total)
                if (total >= 0 && done != total) {
                    part.delete()
                    invoke.reject("The download stopped early ($done of $total bytes).")
                    return@Thread
                }
                val got = digest.digest().joinToString("") { "%02x".format(it) }
                val want = args.sha256.trim()
                if (want.isNotEmpty() && !got.equals(want, ignoreCase = true)) {
                    part.delete()
                    invoke.reject("The download is damaged (its sha256 doesn't match the published one).")
                    return@Thread
                }
                dest.delete()
                if (!part.renameTo(dest)) {
                    part.delete()
                    invoke.reject("Couldn't save the download.")
                    return@Thread
                }
                val ret = JSObject()
                ret.put("path", dest.absolutePath)
                ret.put("size", done)
                invoke.resolve(ret)
            } catch (e: Exception) {
                part.delete()
                invoke.reject("The download failed: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                conn?.disconnect()
            }
        }.start()
    }

    private fun sendProgress(channel: Channel?, done: Long, total: Long) {
        if (channel == null) return
        val ev = JSObject()
        ev.put("downloaded", done)
        ev.put("total", total)
        channel.send(ev)
    }

    @Command
    fun apkInstall(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        try {
            // Only what apk_download wrote: never hand an arbitrary file to the installer.
            val file = File(args.path).canonicalFile
            if (file != File(updatesDir(), APK_NAME).canonicalFile || !file.isFile) {
                invoke.reject("No downloaded update to install.")
                return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !activity.packageManager.canRequestPackageInstalls()
            ) {
                // Android asks once per app: "Allow from this source". The app
                // asks again (openSettings = false) when the user comes back.
                if (!args.openSettings) {
                    val ret = JSObject()
                    ret.put("status", "needs_permission")
                    invoke.resolve(ret)
                    return
                }
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}")
                )
                activity.startActivity(intent)
                val ret = JSObject()
                ret.put("status", "needs_permission")
                invoke.resolve(ret)
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            val ret = JSObject()
            ret.put("status", "started")
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject("Couldn't start the install: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
