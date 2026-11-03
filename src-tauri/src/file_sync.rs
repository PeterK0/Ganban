//! Desktop-only: download a project's files from the daemon into a local folder,
//! mirroring the server's `<project>/<rel_path>` layout so the owner can keep a
//! synced copy on disk. One-way (server -> disk); skips files already present at
//! the same size. Streams over HTTP so it works whether this machine is the host
//! or a remote client of it.

use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct FileSyncSummary {
    pub downloaded: u32,
    pub skipped: u32,
    pub failed: u32,
    pub total: u32,
    pub dest: String,
}

#[derive(serde::Deserialize)]
struct RemoteFile {
    id: i64,
    file_name: String,
    #[serde(default)]
    rel_path: Option<String>,
    #[serde(default)]
    size_bytes: i64,
}

/// Sanitize one path component: strip separators/colons/nul, reject `.`/`..`.
fn safe_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build `<root>/<project>/<rel...>` safely — rejects any `..` traversal so a
/// hostile rel_path can't escape the sync root.
fn safe_join(root: &Path, project: &str, rel: &str) -> Option<PathBuf> {
    let mut path = root.join(safe_component(project));
    for part in rel.split(['/', '\\']) {
        let p = part.trim();
        if p.is_empty() || p == "." {
            continue;
        }
        if p == ".." {
            return None;
        }
        path.push(safe_component(p));
    }
    Some(path)
}

#[tauri::command]
pub async fn sync_project_files(
    base_url: String,
    token: String,
    project_id: i64,
    project_name: String,
    root: String,
) -> Result<FileSyncSummary, String> {
    let base = base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let files: Vec<RemoteFile> = client
        .get(format!("{base}/projects/{project_id}/files"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("listing files: {e}"))?
        .error_for_status()
        .map_err(|e| format!("listing files: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parsing file list: {e}"))?;

    let root_path = Path::new(&root);
    let proj_dir = root_path.join(safe_component(&project_name));
    let total = files.len() as u32;
    let (mut downloaded, mut skipped, mut failed) = (0u32, 0u32, 0u32);

    for f in files {
        let rel = f
            .rel_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .unwrap_or(&f.file_name);
        let Some(dest) = safe_join(root_path, &project_name, rel) else {
            failed += 1;
            continue;
        };
        // Skip files already present at the same size (cheap change check).
        if let Ok(meta) = std::fs::metadata(&dest) {
            if f.size_bytes > 0 && meta.len() as i64 == f.size_bytes {
                skipped += 1;
                continue;
            }
        }
        let resp = match client
            .get(format!("{base}/projects/files/{}/download", f.id))
            .bearer_auth(&token)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => {
                failed += 1;
                continue;
            }
        };
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        if let Some(parent) = dest.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                failed += 1;
                continue;
            }
        }
        if std::fs::write(&dest, &bytes).is_ok() {
            downloaded += 1;
        } else {
            failed += 1;
        }
    }

    Ok(FileSyncSummary {
        downloaded,
        skipped,
        failed,
        total,
        dest: proj_dir.to_string_lossy().into_owned(),
    })
}

/// Open one project file in the OS default app (the "Open" action in the Files
/// tab — downloading worked, opening in-app didn't). Streams the file to a temp
/// dir, then hands it to the system opener. Works on the host (loopback → owner,
/// no token) and on remote clients (bearer device token). Desktop-only; mobile/
/// web fall back to download in the caller.
#[tauri::command]
pub async fn open_remote_file(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    url_path: String,
    file_name: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base = base_url.trim_end_matches('/');
    let path_part = if url_path.starts_with('/') { url_path.clone() } else { format!("/{url_path}") };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(format!("{base}{path_part}"));
    if !token.trim().is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download: {e}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("download: {e}"))?;
    // Namespace the temp copy by the url_path (which embeds the file id + kind) so
    // two files that share a display name — "report.pdf" in different projects —
    // can't collide/overwrite each other on near-simultaneous opens.
    let dir = std::env::temp_dir().join("ganban-open").join(safe_component(&url_path));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The OS picks the app by EXTENSION: a display name like "Manual" (kit
    // captions) opened raw PDF bytes in TextEdit (field, 2026-08-01). When
    // the name has no extension, sniff one from the magic bytes; anything
    // unrecognized keeps the bare name (the OS will ask).
    let mut name = safe_component(&file_name);
    if !name.contains('.') {
        let ext = match () {
            _ if bytes.starts_with(b"%PDF") => Some("pdf"),
            _ if bytes.starts_with(b"\x89PNG") => Some("png"),
            _ if bytes.starts_with(b"\xff\xd8\xff") => Some("jpg"),
            _ if bytes.starts_with(b"GIF8") => Some("gif"),
            _ if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => Some("webp"),
            _ if bytes.starts_with(b"PK\x03\x04") => Some("zip"),
            _ => None,
        };
        if let Some(ext) = ext {
            name = format!("{name}.{ext}");
        }
    }
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A generic JSON/text request to the daemon, run in Rust (reqwest) instead of
/// the webview's `fetch`.
///
/// Why this exists: a *built* desktop app loads from a secure `tauri://` origin,
/// so macOS WKWebView blocks any plain-`http://` request to a *remote* host as
/// mixed content — fatal for "run as a client of a host" over the tailnet (the
/// symptom is `fetch` throwing "Load failed" while `curl` to the very same host
/// succeeds). reqwest has no webview origin / ATS / mixed-content rules, so the
/// frontend tunnels remote daemon calls through here and rebuilds a `Response`,
/// leaving `daemonFetch`'s logic unchanged. Loopback (the host's own daemon) and
/// the browser web client stay on `fetch`. Binary payloads use the dedicated
/// streaming commands (e.g. `open_remote_file`), not this.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHttpReq {
    pub url: String,
    pub method: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: Option<String>,
    /// A raw binary body (file uploads); takes precedence over `body` when set.
    pub body_bytes: Option<Vec<u8>>,
    /// Request timeout; `None` or `0` means no timeout (for long LLM streams).
    pub timeout_ms: Option<u64>,
}

#[derive(serde::Serialize, Debug)]
pub struct DaemonHttpResp {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub async fn daemon_http(req: DaemonHttpReq) -> Result<DaemonHttpResp, String> {
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
        .map_err(|e| format!("bad method: {e}"))?;
    let mut builder = reqwest::Client::builder();
    match req.timeout_ms {
        Some(0) | None => {}
        Some(ms) => builder = builder.timeout(Duration::from_millis(ms)),
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(bytes) = req.body_bytes {
        rb = rb.body(bytes);
    } else if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let resp = rb.send().await.map_err(|e| format!("{e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("{e}"))?;
    Ok(DaemonHttpResp { status, body })
}

// ---- "Show in folder" (this machine) --------------------------------------------

#[derive(serde::Serialize)]
pub struct RevealResult {
    /// "file" = revealed with the file selected; "folder" = the file isn't at
    /// its saved path, the nearest folder that still exists was opened;
    /// "none" = nothing of that path exists here (attached on another machine).
    pub outcome: &'static str,
    pub opened: Option<String>,
}

/// The nearest existing ancestor worth opening: at least one level INSIDE a
/// home directory (`/Users/<me>/X`) — opening `/Users` or `/` because a path
/// came from another machine would be noise, not help.
fn nearest_useful_dir(p: &Path) -> Option<PathBuf> {
    p.ancestors().skip(1).find(|a| a.components().count() >= 4 && a.is_dir()).map(Path::to_path_buf)
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

/// Show a task attachment's saved location in Finder / Explorer — the
/// member-side "where does this project live on MY machine" shortcut. Replaces
/// the old "verify", which checked the HOST's disk (meaningless for a member)
/// and never told you anything you could act on.
#[tauri::command]
pub async fn reveal_local_path(app: tauri::AppHandle, path: String) -> Result<RevealResult, String> {
    use tauri_plugin_opener::OpenerExt;
    let p = expand_home(path.trim());
    if p.is_file() {
        app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())?;
        return Ok(RevealResult { outcome: "file", opened: Some(p.display().to_string()) });
    }
    let dir = if p.is_dir() { Some(p.clone()) } else { nearest_useful_dir(&p) };
    match dir {
        Some(d) => {
            app.opener().open_path(d.to_string_lossy().to_string(), None::<String>).map_err(|e| e.to_string())?;
            Ok(RevealResult { outcome: if d == p { "file" } else { "folder" }, opened: Some(d.display().to_string()) })
        }
        None => Ok(RevealResult { outcome: "none", opened: None }),
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::*;

    #[test]
    fn nearest_folder_stays_inside_a_home() {
        let tmp = std::env::temp_dir().join(format!("ganban_reveal_{}", std::process::id()));
        let deep = tmp.join("Projects/Chief Mate/notes");
        std::fs::create_dir_all(&deep).unwrap();
        // Moved file: its folder still exists → that folder.
        assert_eq!(nearest_useful_dir(&deep.join("gone.pdf")), Some(deep.clone()));
        // Missing subfolders → climbs to the closest one that exists.
        assert_eq!(nearest_useful_dir(&deep.join("a/b/c.pdf")), Some(deep.clone()));
        // Another machine's home: never falls back to /Users or /.
        assert_eq!(nearest_useful_dir(Path::new("/Users/nobody-here-xyz/Documents/x.pdf")), None);
        assert_eq!(nearest_useful_dir(Path::new("/x.pdf")), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

// ---- Streaming uploads (desktop → remote host) ------------------------------

/// Chunked upload sessions. The webview sends a big file in ~4 MB slices over
/// Tauri's RAW binary IPC (`invoke(cmd, Uint8Array)` — no JSON), and each slice
/// feeds a streaming reqwest body. The old path turned the whole file into a
/// JSON array of numbers on the UI thread (a 200 MB file = 200M JS numbers),
/// freezing the app and risking the webview. A small bounded channel gives
/// backpressure: memory stays at a few chunks, and the progress the webview
/// shows is what the network actually took.
#[derive(Default)]
pub struct UploadSessions(std::sync::Mutex<UploadMap>);

#[derive(Default)]
pub struct UploadMap {
    next: u64,
    map: std::collections::HashMap<u64, UploadSession>,
}

struct UploadSession {
    tx: tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
    task: tokio::task::JoinHandle<Result<DaemonHttpResp, String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonUploadReq {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    /// Exact byte count — sent as Content-Length so the host can refuse an
    /// over-quota file before a single byte crosses the network.
    pub total: u64,
}

type ChunkTx = tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>;

/// Start a POST whose body is fed chunk by chunk through the returned sender
/// (bounded: a full channel makes the sender wait — backpressure). Dropping
/// the sender ends the body; the handle yields the host's answer.
fn spawn_streaming_upload(
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    total: u64,
) -> Result<(ChunkTx, tokio::task::JoinHandle<Result<DaemonHttpResp, String>>), String> {
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(3);
    let body = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|chunk| (chunk, rx)) });
    let mut rb = client
        .post(url)
        .header(reqwest::header::CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(body));
    for (k, v) in headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    let task = tokio::spawn(async move {
        let resp = rb.send().await.map_err(|e| format!("{e}"))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| format!("{e}"))?;
        Ok(DaemonHttpResp { status, body })
    });
    Ok((tx, task))
}

/// Open an upload: the request starts now and reads its body from the chunks.
#[tauri::command]
pub async fn daemon_upload_start(state: tauri::State<'_, UploadSessions>, req: DaemonUploadReq) -> Result<u64, String> {
    let (tx, task) = spawn_streaming_upload(&req.url, &req.headers, req.total)?;
    let mut g = state.0.lock().map_err(|_| "upload state poisoned".to_string())?;
    g.next += 1;
    let id = g.next;
    g.map.insert(id, UploadSession { tx, task });
    Ok(id)
}

/// One slice of an upload: raw bytes in the IPC body, the session in the
/// `x-upload-id` header. Resolves once the network side accepted the slice
/// (backpressure), so the caller's progress is honest.
#[tauri::command]
pub async fn daemon_upload_chunk(state: tauri::State<'_, UploadSessions>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id: u64 = request
        .headers()
        .get("x-upload-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| "missing upload id".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary chunk".into());
    };
    let chunk = bytes.clone();
    let tx = {
        let g = state.0.lock().map_err(|_| "upload state poisoned".to_string())?;
        g.map.get(&id).map(|s| s.tx.clone()).ok_or_else(|| "unknown upload".to_string())?
    };
    // A closed channel means the request already ended — usually the host
    // refused the file; daemon_upload_finish returns its answer.
    tx.send(Ok(chunk)).await.map_err(|_| "host-stopped".to_string())
}

/// End the body and wait for the host's answer.
#[tauri::command]
pub async fn daemon_upload_finish(state: tauri::State<'_, UploadSessions>, id: u64) -> Result<DaemonHttpResp, String> {
    let session = {
        let mut g = state.0.lock().map_err(|_| "upload state poisoned".to_string())?;
        g.map.remove(&id).ok_or_else(|| "unknown upload".to_string())?
    };
    drop(session.tx); // end of stream → the request completes
    session.task.await.map_err(|e| e.to_string())?
}

/// Abandon an upload (the user cancelled): drop the request mid-flight.
#[tauri::command]
pub async fn daemon_upload_cancel(state: tauri::State<'_, UploadSessions>, id: u64) -> Result<(), String> {
    let session = state.0.lock().map_err(|_| "upload state poisoned".to_string())?.map.remove(&id);
    if let Some(s) = session {
        s.task.abort();
    }
    Ok(())
}

// ----- Uploads straight from disk -----
//
// The desktop picks files natively and hands Rust their paths: Rust reads and
// streams each file to the host, so no file bytes cross into the webview. Big
// files used to go through it in 4 MB slices (file.slice() → raw IPC), which
// kept the webview's main thread busy for the whole upload: scrolling still
// worked, but clicks barely got through.

/// A file to upload, found by expanding picked or dropped paths.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UploadEntry {
    pub path: String,
    pub name: String,
    /// The path under a picked folder, starting with the folder's own name
    /// ("Brief/maps/route.png"), as a browser's folder picker reports it.
    /// `None` for a file picked on its own.
    pub rel_path: Option<String>,
    pub size: u64,
}

/// Expand picked or dropped paths into the files to upload: a file as itself, a
/// folder as every file under it (sorted). Inside a folder, dotfiles and
/// dot-folders (.DS_Store, .git) are skipped and symlinks aren't followed.
fn expand_upload_paths(paths: &[PathBuf]) -> Vec<UploadEntry> {
    fn entry(path: &Path, rel_path: Option<String>, size: u64) -> UploadEntry {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        UploadEntry { path: path.to_string_lossy().into_owned(), name, rel_path, size }
    }
    fn walk(dir: &Path, rel: &str, out: &mut Vec<UploadEntry>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut children: Vec<_> = rd.flatten().collect();
        children.sort_by_key(|c| c.file_name());
        for c in children {
            let name = c.file_name().to_string_lossy().into_owned();
            let Ok(kind) = c.file_type() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let child_rel = format!("{rel}/{name}");
            if kind.is_dir() {
                walk(&c.path(), &child_rel, out);
            } else if kind.is_file() {
                if let Ok(meta) = c.metadata() {
                    out.push(entry(&c.path(), Some(child_rel), meta.len()));
                }
            }
        }
    }
    let mut out = Vec::new();
    for p in paths {
        let Ok(meta) = std::fs::symlink_metadata(p) else { continue };
        if meta.is_file() {
            out.push(entry(p, None, meta.len()));
        } else if meta.is_dir() {
            let folder = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            walk(p, &folder, &mut out);
        }
    }
    out
}

/// The files behind picked or dropped paths (see [`expand_upload_paths`]).
#[tauri::command]
pub async fn list_upload_files(paths: Vec<String>) -> Result<Vec<UploadEntry>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tokio::task::spawn_blocking(move || expand_upload_paths(&paths)).await.map_err(|e| e.to_string())
}

/// How much of a file is read per body chunk.
const DISK_READ: usize = 256 * 1024;

/// How often progress is reported while a file streams.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// POST the file at `path` as the raw request body, streamed from disk, with
/// its exact size as Content-Length (so the host can refuse an over-quota file
/// before reading it). `progress` gets the bytes handed to the network, at most
/// once per `every` and always at the end.
async fn upload_from_disk(
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    path: &Path,
    every: Duration,
    progress: impl Fn(u64) + Send + Sync + 'static,
) -> Result<DaemonHttpResp, String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    let total = file.metadata().await.map_err(|e| format!("{}: {e}", path.display()))?.len();

    struct Reading<P> {
        file: tokio::fs::File,
        sent: u64,
        reported: std::time::Instant,
        progress: P,
    }
    let start = Reading { file, sent: 0, reported: std::time::Instant::now(), progress };
    let body = futures_util::stream::unfold(Some(start), move |state| async move {
        let mut r = state?;
        let mut buf = vec![0u8; DISK_READ];
        match r.file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                r.sent += n as u64;
                if r.sent >= total || r.reported.elapsed() >= every {
                    (r.progress)(r.sent);
                    r.reported = std::time::Instant::now();
                }
                Some((Ok::<_, std::io::Error>(buf), Some(r)))
            }
            Err(e) => Some((Err(e), None)),
        }
    });

    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let mut rb = client
        .post(url)
        .header(reqwest::header::CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(body));
    for (k, v) in headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    // A host that refuses the file early (storage full, no access) answers and
    // closes while the body is still going out; the reset can beat its answer
    // to us, and reqwest then says only "error sending request".
    let resp = rb.send().await.map_err(|e| {
        if (e.is_request() || e.is_body()) && !e.is_builder() && !e.is_connect() {
            format!("The host closed the connection before the upload finished — it may have refused the file (storage full, or no access). ({e})")
        } else {
            format!("{e}")
        }
    })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("{e}"))?;
    Ok(DaemonHttpResp { status, body })
}

/// Uploads from disk in flight, by the key the frontend gave each, so one can
/// be cancelled.
#[derive(Default)]
pub struct DiskUploads(std::sync::Mutex<std::collections::HashMap<String, DiskUpload>>);

enum DiskUpload {
    Running(tokio::task::AbortHandle),
    /// Cancelled before its upload registered (the two calls raced). Kept a
    /// minute at most: a cancel can also land just after its upload finished.
    Cancelled(std::time::Instant),
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUploadReq {
    pub key: String,
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub path: String,
}

/// Upload a file from disk to the host (see [`upload_from_disk`]); bytes sent
/// arrive on `on_progress`. Resolves with the host's answer, or "cancelled".
#[tauri::command]
pub async fn daemon_upload_from_disk(
    state: tauri::State<'_, DiskUploads>,
    req: DiskUploadReq,
    on_progress: tauri::ipc::Channel<u64>,
) -> Result<DaemonHttpResp, String> {
    let key = req.key.clone();
    let task = tokio::spawn(async move {
        let report = move |sent: u64| {
            let _ = on_progress.send(sent);
        };
        upload_from_disk(&req.url, &req.headers, Path::new(&req.path), PROGRESS_EVERY, report).await
    });
    {
        let mut g = state.0.lock().map_err(|_| "upload state poisoned".to_string())?;
        if matches!(g.get(&key), Some(DiskUpload::Cancelled(_))) {
            task.abort();
        }
        g.insert(key.clone(), DiskUpload::Running(task.abort_handle()));
    }
    let res = task.await;
    if let Ok(mut g) = state.0.lock() {
        g.remove(&key);
    }
    match res {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err("cancelled".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Cancel an upload from disk: the request is dropped mid-flight, and the host
/// discards what it spooled.
#[tauri::command]
pub fn daemon_upload_from_disk_cancel(state: tauri::State<'_, DiskUploads>, key: String) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|_| "upload state poisoned".to_string())?;
    g.retain(|_, u| !matches!(u, DiskUpload::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
    match g.remove(&key) {
        Some(DiskUpload::Running(h)) => h.abort(),
        _ => {
            g.insert(key, DiskUpload::Cancelled(std::time::Instant::now()));
        }
    }
    Ok(())
}

/// Streaming variant of `daemon_http`: relays the response chunk-by-chunk over a
/// Tauri channel. The frontend rebuilds a streaming `Response`, so SSE chat
/// reads tokens *live* (not buffered) and `res.blob()` collects a file download
/// incrementally. Exists for the same reason as `daemon_http` — a built `.app`'s
/// webview can't fetch a remote http host (mixed content). Status arrives first
/// so the frontend can construct the Response before the body finishes.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamMsg {
    Status { status: u16 },
    Chunk { data: Vec<u8> },
    Done,
    Error { message: String },
}

#[tauri::command]
pub async fn daemon_http_stream(
    req: DaemonHttpReq,
    on_event: tauri::ipc::Channel<StreamMsg>,
) -> Result<(), String> {
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
        .map_err(|e| format!("bad method: {e}"))?;
    let mut builder = reqwest::Client::builder();
    match req.timeout_ms {
        Some(0) | None => {}
        Some(ms) => builder = builder.timeout(Duration::from_millis(ms)),
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let mut resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamMsg::Error { message: format!("{e}") });
            return Err(format!("{e}"));
        }
    };
    let _ = on_event.send(StreamMsg::Status { status: resp.status().as_u16() });
    loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                if on_event.send(StreamMsg::Chunk { data: bytes.to_vec() }).is_err() {
                    return Ok(()); // receiver gone (cancelled / navigated away)
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = on_event.send(StreamMsg::Error { message: format!("{e}") });
                return Err(format!("{e}"));
            }
        }
    }
    let _ = on_event.send(StreamMsg::Done);
    Ok(())
}


#[cfg(test)]
mod upload_stream_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-shot HTTP server: reads the request head; if the declared length
    /// is over `refuse_over`, answers 400 at once (like the host refusing an
    /// over-quota file) — else reads the whole body and echoes its size + sum.
    async fn one_shot_server(refuse_over: u64) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/upload", listener.local_addr().unwrap());
        let h = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            let head_end = loop {
                let n = sock.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
            let len: u64 = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .expect("content-length framing");
            if len > refuse_over {
                let body = r#"{"error":"file exceeds the project's remaining storage"}"#;
                let _ = sock
                    .write_all(format!("HTTP/1.1 400 Bad Request\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes())
                    .await;
                return;
            }
            let mut body: Vec<u8> = buf[head_end..].to_vec();
            while (body.len() as u64) < len {
                let n = sock.read(&mut tmp).await.unwrap();
                assert!(n > 0, "body ended early");
                body.extend_from_slice(&tmp[..n]);
            }
            let sum: u64 = body.iter().map(|b| *b as u64).sum();
            let reply = format!(r#"{{"size":{},"sum":{}}}"#, body.len(), sum);
            sock.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
        });
        (url, h)
    }

    #[tokio::test]
    async fn chunks_stream_in_order_with_content_length() {
        let (url, server) = one_shot_server(u64::MAX).await;
        let chunks: Vec<Vec<u8>> = (0..10u8).map(|i| vec![i; 1_000_003]).collect();
        let total: u64 = chunks.iter().map(|c| c.len() as u64).sum();
        let (tx, task) = spawn_streaming_upload(&url, &Default::default(), total).unwrap();
        for c in &chunks {
            tx.send(Ok(c.clone())).await.unwrap();
        }
        drop(tx);
        let resp = task.await.unwrap().unwrap();
        server.await.unwrap();
        assert_eq!(resp.status, 200);
        let expect_sum: u64 = chunks.iter().flatten().map(|b| *b as u64).sum();
        assert_eq!(resp.body, format!(r#"{{"size":{total},"sum":{expect_sum}}}"#));
    }

    #[tokio::test]
    async fn an_early_refusal_stops_the_sender_and_finish_reports_it() {
        let (url, server) = one_shot_server(1024).await;
        let total = 64 * 1024 * 1024u64;
        let (tx, task) = spawn_streaming_upload(&url, &Default::default(), total).unwrap();
        // Keep feeding like the webview would; the sends must start failing
        // (receiver gone) instead of buffering 64 MB.
        let mut sent = 0u64;
        let mut stopped = false;
        while sent < total {
            if tx.send(Ok(vec![0u8; 4 * 1024 * 1024])).await.is_err() {
                stopped = true;
                break;
            }
            sent += 4 * 1024 * 1024;
        }
        drop(tx);
        let resp = task.await.unwrap();
        server.await.unwrap();
        match resp {
            Ok(r) => {
                assert_eq!(r.status, 400);
                assert!(r.body.contains("remaining storage"), "{}", r.body);
            }
            // Some stacks surface the reset instead of the early response —
            // either way the upload ends promptly with an error, not a hang.
            Err(e) => assert!(!e.is_empty()),
        }
        assert!(stopped || sent >= total, "sender either stopped early or finished");
    }
}

#[cfg(test)]
mod disk_upload_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gansty_upload_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_picked_folder_expands_to_its_files_with_paths_under_the_folder() {
        let root = scratch("expand");
        let folder = root.join("Brief");
        std::fs::create_dir_all(folder.join("maps")).unwrap();
        std::fs::write(folder.join("plan.pdf"), b"12345").unwrap();
        std::fs::write(folder.join("maps").join("route.png"), b"123").unwrap();
        std::fs::write(folder.join(".DS_Store"), b"x").unwrap();
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::write(folder.join(".git").join("HEAD"), b"x").unwrap();
        let loose = root.join("notes.txt");
        std::fs::write(&loose, b"1").unwrap();

        let mut got = expand_upload_paths(&[folder.clone(), loose.clone()]);
        got.sort_by(|a, b| a.path.cmp(&b.path));
        let rows: Vec<(String, Option<String>, u64)> = got.iter().map(|e| (e.name.clone(), e.rel_path.clone(), e.size)).collect();
        assert_eq!(
            rows,
            vec![
                ("route.png".into(), Some("Brief/maps/route.png".into()), 3),
                ("plan.pdf".into(), Some("Brief/plan.pdf".into()), 5),
                ("notes.txt".into(), None, 1),
            ],
            "dotfiles skipped; a loose file has no folder path"
        );
    }

    /// A one-shot HTTP server: answers with how many body bytes it read.
    async fn byte_counting_host() -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/projects/1/files/upload", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 64 * 1024];
            let head_end = loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .expect("a declared content-length");
            let mut body = buf[head_end..].to_vec();
            while body.len() < len {
                let n = sock.read(&mut chunk).await.unwrap();
                body.extend_from_slice(&chunk[..n]);
            }
            let reply = format!("{{\"received\":{}}}", body.len());
            let resp = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}", reply.len());
            sock.write_all(resp.as_bytes()).await.unwrap();
            body
        });
        (url, task)
    }

    #[tokio::test]
    async fn a_file_streams_from_disk_with_honest_progress() {
        let dir = scratch("stream");
        let path = dir.join("big.bin");
        let data: Vec<u8> = (0..3 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let (url, host) = byte_counting_host().await;

        let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
        let sink = seen.clone();
        let headers = std::collections::HashMap::from([("authorization".to_string(), "Bearer t".to_string())]);
        let resp = upload_from_disk(&url, &headers, &path, Duration::ZERO, move |sent| sink.lock().unwrap().push(sent))
            .await
            .unwrap();

        assert_eq!((resp.status, resp.body.as_str()), (200, format!("{{\"received\":{}}}", data.len()).as_str()));
        assert_eq!(host.await.unwrap(), data, "the host got the file byte for byte");
        let seen = seen.lock().unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress only rises: {seen:?}");
        assert_eq!(seen.last().copied(), Some(data.len() as u64), "progress ends at the file size");
    }

    #[tokio::test]
    async fn a_host_refusing_early_ends_the_upload_with_its_reason() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/projects/1/files/upload", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut chunk = [0u8; 16 * 1024];
            let _ = sock.read(&mut chunk).await.unwrap(); // the head; the body is never read
            let reply = r#"{"error":"Invalid input: file exceeds the project's remaining storage"}"#;
            let resp = format!("HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let dir = scratch("refused");
        let path = dir.join("huge.bin");
        std::fs::write(&path, vec![7u8; 8 * 1024 * 1024]).unwrap();
        // The host's answer when it wins the race, else a message that says
        // what likely happened; never a hang.
        match upload_from_disk(&url, &Default::default(), &path, Duration::ZERO, |_| {}).await {
            Ok(resp) => {
                assert_eq!(resp.status, 400);
                assert!(resp.body.contains("remaining storage"), "{}", resp.body);
            }
            Err(e) => assert!(e.contains("may have refused the file"), "{e}"),
        }
    }

    /// The commands as the webview calls them (daemon.ts: listUploadFiles,
    /// uploadDiskBody), through Tauri's IPC on the mock runtime.
    #[test]
    fn the_webview_lists_and_uploads_files_from_disk_over_ipc() {
        use serde_json::{json, Value};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        let app = mock_builder()
            .manage(DiskUploads::default())
            .invoke_handler(tauri::generate_handler![list_upload_files, daemon_upload_from_disk, daemon_upload_from_disk_cancel])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let call = |cmd: &str, body: Value| {
            let request = tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            get_ipc_response(&webview, request).map(|b| b.deserialize::<Value>().unwrap())
        };

        let dir = scratch("ipc");
        std::fs::write(dir.join("a.txt"), b"hello host").unwrap();
        let listed = call("list_upload_files", json!({ "paths": [dir.to_string_lossy()] })).unwrap();
        let folder = dir.file_name().unwrap().to_string_lossy();
        assert_eq!(listed[0]["relPath"], format!("{folder}/a.txt"), "{listed}");
        assert_eq!(listed[0]["size"], 10);

        let (url, host) = tauri::async_runtime::block_on(byte_counting_host());
        let resp = call(
            "daemon_upload_from_disk",
            json!({
                "req": { "key": "d1", "url": url, "headers": {}, "path": listed[0]["path"] },
                "onProgress": "__CHANNEL__:7",
            }),
        )
        .unwrap();
        assert_eq!(resp, json!({ "status": 200, "body": "{\"received\":10}" }));
        assert_eq!(tauri::async_runtime::block_on(host).unwrap(), b"hello host");
        assert_eq!(call("daemon_upload_from_disk_cancel", json!({ "key": "d1" })).unwrap(), Value::Null, "cancelling a finished upload is harmless");
    }

    #[tokio::test]
    async fn a_missing_file_fails_before_any_request() {
        let err = upload_from_disk("http://127.0.0.1:9/x", &Default::default(), Path::new("/no/such/file"), Duration::ZERO, |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("/no/such/file"), "{err}");
    }
}
