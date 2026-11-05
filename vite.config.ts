import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

/** What build is this? Git short hash + build time, compiled into the bundle
 * (`__GANBAN_BUILD__`) AND written to dist/build.json. The two let a running
 * client compare itself with what the host currently serves — a phone that
 * cached yesterday's index.html can tell, and say "reload", instead of
 * looking like a bug report ("there is no Your devices option"). */
function buildStamp(): { hash: string; at: string } {
  let hash = "dev";
  try {
    hash = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (dirty) hash += "+";
  } catch {
    /* no git — "dev" */
  }
  return { hash, at: new Date().toISOString() };
}
const BUILD = buildStamp();

/** The SHA-256 of the certificate GitHub Releases' APKs are signed with (public): the release
 * workflow's VITE_GITHUB_ANDROID_CERT, else src-tauri/updater/github-android-cert.txt. A phone
 * offers GitHub Releases only when its own signature matches (docs/design/UPDATES.md). */
function githubAndroidCert(): string {
  // @ts-expect-error process is a nodejs global
  const env = (process.env.VITE_GITHUB_ANDROID_CERT as string | undefined) ?? "";
  if (env.trim()) return env.trim();
  const file = resolve("src-tauri/updater/github-android-cert.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
function buildJson() {
  return {
    name: "ganban-build-json",
    generateBundle() {
      // @ts-expect-error rollup plugin context
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify(BUILD) });
    },
  };
}

/** A tiny Vite plugin that copies pdf.js's WASM decoders (jbig2, openjpeg,
 * quickjs-eval, qcms) from node_modules to a stable served path `/pdfjs-wasm/`
 * in BOTH dev (publicDir) and build (dist). pdf.js v6 needs `wasmUrl` to find
 * these — without it, scanned PDFs with JBig2-encoded images fail to render
 * ("Jbig2Error: JBig2 failed to initialize") and the wasm decoders never load.
 * No binaries are committed: the files are copied from the installed
 * pdfjs-dist on every dev start / build. */
function pdfjsWasmCopy() {
  const srcDir = resolve("node_modules/pdfjs-dist/wasm");
  const outDir = resolve("public/pdfjs-wasm");
  const copy = () => {
    if (!existsSync(srcDir)) return;
    cpSync(srcDir, outDir, { recursive: true, force: true });
  };
  return {
    name: "pdfjs-wasm-copy",
    configResolved() { copy(); },
    configureServer() { copy(); },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const daemon = process.env.GANBAN_DAEMON_URL || "http://127.0.0.1:8765";

// The daemon's HTTP route prefixes. In `tauri dev` the desktop webview talks to
// the in-process daemon directly (via its stored base URL), but a plain BROWSER
// opened at this dev origin (:1420) has no daemon — every daemonFetch would
// otherwise SPA-fall-back to index.html and fail with "Unrecognized token '<'".
// Proxy these to the running daemon so the dev browser works like the app.
const DAEMON_ROUTES = [
  "/agent", "/ai", "/atlas", "/calendar", "/chat", "/chats", "/comments",
  "/download", "/email", "/emoji", "/enroll", "/events", "/files", "/giphy",
  "/health", "/invoke", "/me", "/projects", "/reindex", "/routines", "/search",
  "/secretary", "/snapshot", "/sync", "/sync-folders", "/tabs", "/tasks", "/tools",
];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsWasmCopy(), buildJson()],
  define: { __GANBAN_BUILD__: JSON.stringify(BUILD), __GITHUB_ANDROID_CERT__: JSON.stringify(githubAndroidCert()) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    proxy: Object.fromEntries(
      DAEMON_ROUTES.map((p) => [p, { target: daemon, changeOrigin: true, ws: true }])
    ),
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
