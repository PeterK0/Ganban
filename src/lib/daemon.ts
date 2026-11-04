/**
 * Daemon transport configuration + low-level HTTP client.
 *
 * This is the single place that knows about the headless `ganban-server`
 * daemon: where it lives, how to reach it, and how to detect whether we are
 * running as a mobile thin client (which must always use HTTP because it has no
 * local database).
 *
 * `src/lib/api.ts` routes through here on mobile; the desktop "Sync" view uses
 * `checkHealth`/`getSnapshot` directly for read-through display.
 */

import { abortError, isAbortError, trackUpload } from "./uploads";
import type { Project, Task, CalendarSubscription, CalendarSyncResult } from "../types";
import { notify, updateNotif } from "../store/notifications";

const DAEMON_URL_KEY = "ganban-daemon-url";
const DEVICE_TOKEN_KEY = "ganban-device-token";
const FORCE_MOBILE_KEY = "ganban-force-mobile";

/**
 * The device token, stored in the app's private storage (localStorage in the
 * Android WebView is sandboxed to this app). Sent as a Bearer token on every
 * daemon request.
 */
export function getDeviceToken(): string | null {
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}
export function setDeviceToken(token: string | null): void {
  if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token);
  else localStorage.removeItem(DEVICE_TOKEN_KEY);
}

// When a request comes back 401 (token expired/revoked), the token is cleared
// and this handler fires so the app can route back to enrollment.
let onUnauthorized: (() => void) | null = null;
/** A 401 from the host. Drop the credential — and tell the gate ONLY if there
 * was one: "signed out by the host" means a token we held was rejected. A 401
 * on a fresh device with no token is simply "not signed in yet", and saying
 * otherwise sent a brand-new Home Screen app looking for a revocation. */
function handleUnauthorized(): void {
  const hadToken = !!getDeviceToken();
  setDeviceToken(null);
  if (hadToken && onUnauthorized) onUnauthorized();
}

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Add a default scheme and strip any trailing slash. */
function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}

/** The configured daemon base URL (e.g. `http://100.x.y.z:8765`), or null. */
export function getDaemonBaseUrl(): string | null {
  const v = localStorage.getItem(DAEMON_URL_KEY);
  return v && v.trim() ? normalizeBaseUrl(v) : null;
}

/** Persist (or clear) the daemon base URL. */
export function setDaemonBaseUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed) localStorage.setItem(DAEMON_URL_KEY, normalizeBaseUrl(trimmed));
  else localStorage.removeItem(DAEMON_URL_KEY);
}

/**
 * Whether this client is a mobile thin client (→ always talk HTTP to the
 * daemon, never a local `invoke`).
 *
 * Detection is by webview user-agent. A dev override (`?mobile=1` in the URL or
 * `localStorage['ganban-force-mobile']='1'`) lets you exercise the mobile UI in
 * a desktop browser before you have a device attached.
 */
export function isMobilePlatform(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mobile") === "1") return true;
    if (localStorage.getItem(FORCE_MOBILE_KEY) === "1") return true;
  } catch {
    /* window/localStorage unavailable — fall through to UA sniffing */
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua);
}

const TRANSPORT_MODE_KEY = "ganban-transport-mode"; // "local" | "online"

/** The desktop's data source: its own local DB ("local") or a remote host over
 * HTTP ("online"). Only meaningful on the desktop; mobile/web are always HTTP. */
export function getTransportMode(): "local" | "online" {
  try {
    return localStorage.getItem(TRANSPORT_MODE_KEY) === "online" ? "online" : "local";
  } catch {
    return "local";
  }
}
export function setTransportMode(mode: "local" | "online"): void {
  try {
    localStorage.setItem(TRANSPORT_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Whether we are running inside the Tauri runtime (desktop or the native app). */
export function isTauri(): boolean {
  try {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  } catch {
    return false;
  }
}

/**
 * A plain browser client — the touch UI served by the daemon over the tailnet,
 * NOT the installed app. Such clients always talk HTTP, and the daemon is simply
 * the page's own origin (so no URL/QR is needed — they opened it from the host).
 */
export function isWebClient(): boolean {
  return typeof window !== "undefined" && !isTauri();
}

/** The installed desktop app acting as an online client of a remote host: it
 * routes the whole command surface over HTTP to the enrolled daemon instead of
 * its local SQLite DB. */
export function isDesktopOnline(): boolean {
  return isTauri() && !isWebClient() && !isMobilePlatform() && getTransportMode() === "online";
}

/**
 * A client whose DATA AND IDENTITY both live on a daemon it doesn't own: the
 * installed app in online mode, or any browser served by the host. Both
 * authenticate with a device token, so neither may show the local-profile gate
 * or the first-run "how should this machine run?" choice — those questions
 * belong to the machine holding the database, and are already answered here.
 */
export function isHostedClient(): boolean {
  return isDesktopOnline() || isWebClient();
}

/** The base URL to use for daemon calls: a web client is served by the daemon, so
 * its own origin is authoritative; the native app uses its enrolled URL. */
function effectiveBaseUrl(): string | null {
  if (isWebClient()) return window.location.origin.replace(/\/+$/, "");
  return getDaemonBaseUrl();
}

/** The base URL the app's daemon calls currently target (web client = page
 * origin; desktop = the saved daemon URL). Exported for display/diagnostics —
 * e.g. the Tools panel shows which host you're connected to. */
export function currentDaemonUrl(): string | null {
  return effectiveBaseUrl();
}

/** Whether there's a daemon to talk to (so chat / search / AI calls can run).
 * True for a web client (served by one), or any client with a daemon URL set —
 * including a desktop hosting its own in-process daemon, regardless of
 * local/online transport mode. */
export function hasDaemon(): boolean {
  return !!effectiveBaseUrl();
}

/** Read an invite token from the page URL — how browser joiners arrive from a
 * link the owner sent them. Prefers the fragment (`#invite=…`, kept out of
 * server logs/Referer); falls back to the query (`?invite=…`) for robustness. */
export function inviteTokenFromUrl(): string | null {
  try {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite");
    if (fromHash && fromHash.trim()) return fromHash.trim();
    const fromQuery = new URLSearchParams(window.location.search).get("invite");
    return fromQuery && fromQuery.trim() ? fromQuery.trim() : null;
  } catch {
    return null;
  }
}

/** Error thrown by the daemon transport, carrying the HTTP status when known. */
/** The host REJECTED the credential (401) — as opposed to being unreachable,
 * restarting, or erroring. Gates must treat these differently: the first means
 * "pair again", the second means "wait / retry" with the token kept. */
export function isUnauthorized(e: unknown): boolean {
  return e instanceof DaemonError && e.status === 401;
}

export class DaemonError extends Error {
  status?: number;
  /** Machine-readable cause, e.g. "ENDPOINT_MISSING" (host on an older build). */
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "DaemonError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Should this daemon request be tunnelled through Rust instead of `window.fetch`?
 *
 * A *built* desktop app loads from a secure `tauri://` origin, so macOS
 * WKWebView blocks any plain-`http://` request to a *remote* host as mixed
 * content — fatal for "run as a client of a host" over the tailnet (the symptom
 * is `fetch` throwing "Load failed" while `curl` to the same host succeeds).
 * The `daemon_http` Rust command (reqwest) has no webview origin/ATS/mixed-
 * content rules, so we route remote calls through it.
 *
 * Only desktop + a non-loopback URL needs this: the host's own loopback daemon
 * is trustworthy (window.fetch works), the browser web client is same-origin,
 * and mobile keeps its existing transport. Gated on the URL — not the transport
 * mode — so the connect-time health check (which runs before the app flips to
 * online) is tunnelled too.
 */
function shouldRouteThroughRust(url: string): boolean {
  if (!isTauri() || isMobilePlatform()) return false;
  try {
    const host = new URL(url).hostname;
    return !(host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]");
  } catch {
    return false;
  }
}

/** Daemon transport. Tunnels through Rust on a desktop app talking to a remote
 * host (see {@link shouldRouteThroughRust}); `window.fetch` everywhere else.
 * Returns a real `Response` either way, so callers are unchanged. The Rust path
 * carries text bodies — binary payloads use their own dedicated commands. */
async function transportFetch(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  if (!shouldRouteThroughRust(url)) return fetch(url, init);
  const { invoke } = await import("@tauri-apps/api/core");
  const headers = { ...(init?.headers as Record<string, string> | undefined) };
  // Strings as-is. File uploads DON'T come through here any more (uploadBody
  // streams them over raw IPC); the byte-array fallback remains only for small
  // binary bodies — it builds a JSON number array, so keep it small.
  const raw = init?.body as unknown;
  let body: string | null = null;
  let bodyBytes: number[] | null = null;
  if (typeof raw === "string") body = raw;
  else if (raw instanceof Blob) bodyBytes = Array.from(new Uint8Array(await raw.arrayBuffer()));
  else if (raw instanceof ArrayBuffer) bodyBytes = Array.from(new Uint8Array(raw));
  else if (raw instanceof Uint8Array) bodyBytes = Array.from(raw);
  try {
    const r = await invoke<{ status: number; body: string }>("daemon_http", {
      req: {
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers,
        body,
        bodyBytes,
        timeoutMs,
      },
    });
    return new Response(r.body ? r.body : null, { status: r.status });
  } catch (e) {
    // invoke rejects with a string; surface it as an Error so daemonFetch's
    // catch produces a useful "Could not reach daemon …" message.
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "request failed");
  }
}

/** How an upload reports progress / gets cancelled, and how it's labelled in
 * the upload bar (see lib/uploads.ts). */
export interface UploadOptions {
  target?: string;
  group?: string;
  /** Small background uploads (a pasted screenshot): no bar, no bell. */
  quiet?: boolean;
}

const UPLOAD_CHUNK = 4 * 1024 * 1024;

/**
 * POST a file as the raw request body — with progress and cancel, and
 * WITHOUT materialising it on the UI thread.
 *
 * - Direct (loopback host, web client, mobile): XMLHttpRequest streams the
 *   File from disk and reports upload progress natively (fetch can't).
 * - Desktop → remote host (the mixed-content Rust tunnel): 4 MB slices over
 *   Tauri's raw binary IPC into a streaming request (file_sync::daemon_upload_*).
 *   This replaces turning the whole file into a JSON number array, which froze
 *   the app on big files.
 */
async function uploadBody(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (sent: number) => void,
  signal: AbortSignal
): Promise<{ status: number; text: string }> {
  const total = file.size;
  if (signal.aborted) throw abortError();
  if (!shouldRouteThroughRust(url)) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        onProgress(total);
        resolve({ status: xhr.status, text: xhr.responseText });
      };
      xhr.onerror = () => reject(new DaemonError("Upload failed — the host couldn't be reached or dropped the connection."));
      xhr.onabort = () => reject(abortError());
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const id = await invoke<number>("daemon_upload_start", { req: { url, headers, total } });
  let sent = 0;
  try {
    while (sent < total) {
      if (signal.aborted) throw abortError();
      const end = Math.min(total, sent + UPLOAD_CHUNK);
      const chunk = new Uint8Array(await file.slice(sent, end).arrayBuffer());
      try {
        await invoke("daemon_upload_chunk", chunk, { headers: { "x-upload-id": String(id) } });
      } catch (e) {
        // The host answered early (usually: refused the file) — read why below.
        if (String(e).includes("host-stopped")) break;
        throw e;
      }
      sent = end;
      onProgress(sent);
    }
    const r = await invoke<{ status: number; body: string }>("daemon_upload_finish", { id });
    return { status: r.status, text: r.body };
  } catch (e) {
    void invoke("daemon_upload_cancel", { id }).catch(() => {});
    if (isAbortError(e)) throw e;
    throw new DaemonError(typeof e === "string" ? e : e instanceof Error ? e.message : "upload failed");
  }
}

/** A file on this machine's disk (desktop), found by list_upload_files. */
export interface DiskFile {
  path: string;
  name: string;
  size: number;
  /** The path under a picked or dropped folder ("Brief/maps/route.png"). */
  relPath?: string | null;
}

/** Whether uploads can stream straight from disk: the desktop app, where a
 * native picker or drop yields paths. */
export function canUploadFromDisk(): boolean {
  return isTauri() && !isMobilePlatform();
}

/** The files behind picked or dropped paths: a folder expands to every file
 * under it (dotfiles skipped), each with its path under the folder. */
export async function listUploadFiles(paths: string[]): Promise<DiskFile[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DiskFile[]>("list_upload_files", { paths });
}

/** A content type from a file name, for files that come from disk without the
 * browser's guess (the host serves it back on download and inline preview). */
export function guessContentType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", heic: "image/heic", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", json: "application/json", html: "text/html", zip: "application/zip",
    mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] ?? "application/octet-stream";
}

let diskUploadSeq = 0;

/**
 * POST a file on disk as the raw request body (desktop). Rust reads and
 * streams it (file_sync::daemon_upload_from_disk), so no file bytes pass
 * through the webview: a big upload no longer keeps the UI thread busy.
 */
async function uploadDiskBody(
  url: string,
  path: string,
  headers: Record<string, string>,
  onProgress: (sent: number) => void,
  signal: AbortSignal
): Promise<{ status: number; text: string }> {
  if (signal.aborted) throw abortError();
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const key = `d${Date.now().toString(36)}_${diskUploadSeq++}`;
  const progress = new Channel<number>();
  progress.onmessage = (sent) => onProgress(sent);
  const cancel = () => void invoke("daemon_upload_from_disk_cancel", { key }).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const r = await invoke<{ status: number; body: string }>("daemon_upload_from_disk", {
      req: { key, url, headers, path },
      onProgress: progress,
    });
    return { status: r.status, text: r.body };
  } catch (e) {
    if (signal.aborted) throw abortError();
    throw new DaemonError(typeof e === "string" ? e : e instanceof Error ? e.message : "upload failed");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

const isDiskFile = (s: File | DiskFile): s is DiskFile => !(s instanceof Blob);

/** Upload under the manager (upload bar, queue, cancel) and turn the host's
 * answer into a parsed result or a DaemonError. `source` is a File the page
 * holds, or (desktop) a file on disk that Rust streams itself. */
async function managedUpload<T>(
  url: string,
  source: File | DiskFile,
  opts: UploadOptions,
  label?: string
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  return trackUpload<T>(
    { name: label ?? source.name, size: source.size, target: opts.target, group: opts.group, quiet: opts.quiet },
    async ({ onProgress, signal }) => {
      const res = isDiskFile(source)
        ? await uploadDiskBody(url, source.path, headers, onProgress, signal)
        : await uploadBody(url, source, headers, onProgress, signal);
      if (res.status < 200 || res.status >= 300) {
        let msg = res.status === 413 ? "File too large for the host" : `HTTP ${res.status}`;
        try {
          const body = JSON.parse(res.text);
          // "Invalid input: file exceeds…" → "File exceeds…" for the upload bar.
          if (body && typeof body.error === "string") msg = body.error.replace(/^Invalid input:\s*/i, "").replace(/^./, (c: string) => c.toUpperCase());
        } catch {
          /* non-JSON */
        }
        if (res.status === 401) handleUnauthorized();
        throw new DaemonError(msg, res.status);
      }
      return (res.text ? JSON.parse(res.text) : undefined) as T;
    }
  );
}

type StreamMsg =
  | { event: "status"; status: number }
  | { event: "chunk"; data: number[] }
  | { event: "done" }
  | { event: "error"; message: string };

/** Streaming transport. Like {@link transportFetch}, but the Rust path relays
 * the response over a Tauri channel and rebuilds a *streaming* `Response`, so
 * SSE chat reads tokens live and `res.blob()`/`res.arrayBuffer()` collect a
 * binary download. `window.fetch` everywhere it isn't a desktop+remote call.
 * `timeoutMs = 0` means no timeout (LLM generations and large files). An abort
 * stops the JS-side read; the server-side request runs to completion (v1). */
async function streamFetch(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  if (!shouldRouteThroughRust(url)) return fetch(url, init);
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const headers = { ...(init?.headers as Record<string, string> | undefined) };
  const channel = new Channel<StreamMsg>();
  let resolveStatus!: (s: number) => void;
  let rejectStatus!: (e: Error) => void;
  const statusReady = new Promise<number>((res, rej) => {
    resolveStatus = res;
    rejectStatus = rej;
  });
  let gotStatus = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const fail = (err: Error) => {
    if (!gotStatus) rejectStatus(err);
    else
      try {
        ctrl?.error(err);
      } catch {
        /* already closed */
      }
  };
  channel.onmessage = (m) => {
    if (m.event === "status") {
      gotStatus = true;
      resolveStatus(m.status);
    } else if (m.event === "chunk") {
      try {
        ctrl?.enqueue(new Uint8Array(m.data));
      } catch {
        /* closed */
      }
    } else if (m.event === "done") {
      try {
        ctrl?.close();
      } catch {
        /* already closed */
      }
    } else {
      fail(new Error(m.message));
    }
  };
  const body = typeof init?.body === "string" ? init.body : null;
  void invoke("daemon_http_stream", {
    req: { url, method: (init?.method ?? "GET").toUpperCase(), headers, body, timeoutMs },
    onEvent: channel,
  }).catch((e) => fail(new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "stream failed")));
  const signal = init?.signal;
  if (signal) {
    const onAbort = () => fail(new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const status = await statusReady;
  return new Response(stream, { status });
}

/** The page is going away (lib/restartFlush.ts, installUnloadFlush): requests
 * from now on are `keepalive`, so the browser finishes them after the page is
 * gone. Off again if the page comes back from the back-forward cache. */
let unloading = false;
/** Browsers allow 64 KiB of keepalive bodies in flight per page, in bytes. */
const KEEPALIVE_BUDGET = 60_000;
let keepaliveBytes = 0;
/** Whether the page is going away (setUnloading). */
export const isUnloading = (): boolean => unloading;
export function setUnloading(on: boolean): void {
  unloading = on;
  keepaliveBytes = 0;
}

/**
 * Low-level fetch against the daemon. Resolves to the parsed JSON body (or
 * `undefined` for 204). Throws `DaemonError` on transport/HTTP failure, using
 * the daemon's `{ "error": ... }` body as the message when present.
 */
export async function daemonFetch<T>(
  path: string,
  init?: RequestInit,
  baseOverride?: string,
  timeoutMs = 8000
): Promise<T> {
  const base = baseOverride ? normalizeBaseUrl(baseOverride) : effectiveBaseUrl();
  if (!base) {
    throw new DaemonError("No daemon URL configured. Connect to a daemon first.");
  }

  // Fail fast instead of hanging forever on an unreachable host (fetch has no
  // default timeout). Only send a JSON content-type when there's actually a
  // body, so bodyless GET/DELETE stay CORS "simple" requests (no preflight).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body != null) headers["content-type"] = "application/json";
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    // A body past what's left of the keepalive budget goes as usual, and may not make it.
    let keepalive = {};
    if (unloading) {
      const bytes = typeof init?.body === "string" ? new TextEncoder().encode(init.body).length : 0;
      if (keepaliveBytes + bytes <= KEEPALIVE_BUDGET) {
        keepaliveBytes += bytes;
        keepalive = { keepalive: true };
      }
    }
    res = await transportFetch(base + path, { ...init, ...keepalive, headers, signal: controller.signal }, timeoutMs);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new DaemonError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s reaching daemon at ${base}. Check the address (use 127.0.0.1 on the same machine, or your tailnet IP from a phone) and that the daemon is running.`
      );
    }
    throw new DaemonError(
      `Could not reach daemon at ${base} (${e instanceof Error ? e.message : "network error"})`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
      if (body && typeof body.code === "string") code = body.code;
    } catch {
      /* non-JSON error body */
    }
    // Token expired or revoked → drop it and let the app re-enroll.
    if (res.status === 401) {
      handleUnauthorized();
    }
    throw new DaemonError(msg, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 whose body is HTML is the daemon's SPA fallback for an UNKNOWN
    // route — i.e. this client knows an endpoint the connected host doesn't
    // (version skew: a newer client against an older host daemon). Surface that
    // instead of the raw "Unrecognized token '<'".
    const looksHtml =
      text.trimStart().startsWith("<") || (res.headers.get("content-type") ?? "").includes("text/html");
    if (looksHtml) {
      throw new DaemonError(`“${path}” isn’t available on the connected host yet.`, res.status, "ENDPOINT_MISSING");
    }
    throw new DaemonError(`The daemon returned an unreadable response for “${path}”.`, res.status);
  }
}

/** A `/invoke` RPC against a SPECIFIC host with an EXPLICIT token — reads and
 * mutates NONE of the active-transport globals, so it's safe to fan out across
 * workspaces concurrently (K2 Stage C aggregation). A 401 here is the caller's
 * to handle (that workspace's token expired); it never clears the active
 * session or triggers global re-enrollment. */
export async function invokeOnHost<T>(
  url: string,
  token: string | null,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 8000
): Promise<T> {
  const base = normalizeBaseUrl(url);
  if (!base) throw new DaemonError("workspace has no URL");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // transportFetch tunnels through Rust when this is a desktop app talking to
    // a remote (non-loopback) host — the merged multi-workspace view fans out
    // here, and a built .app's webview would otherwise block plain-http as mixed
    // content ("Load failed").
    const res = await transportFetch(
      `${base}/invoke`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ command, args: args ?? {} }),
        signal: controller.signal,
      },
      timeoutMs
    );
    if (!res.ok) throw new DaemonError(await errorMessage(res), res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** The host's `{ "error": … }` message for a failed response, else `HTTP <status>`. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* non-JSON error body */
  }
  return `HTTP ${res.status}`;
}

/** A GET against a SPECIFIC host with an EXPLICIT token (invokeOnHost's
 * sibling for plain routes such as `/me`). Touches no transport globals. */
export async function getOnHost<T>(url: string, token: string | null, path: string, timeoutMs = 8000): Promise<T> {
  const base = normalizeBaseUrl(url);
  if (!base) throw new DaemonError("workspace has no URL");
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await transportFetch(`${base}${path}`, { method: "GET", headers, signal: controller.signal }, timeoutMs);
    if (!res.ok) throw new DaemonError(await errorMessage(res), res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface HealthResponse {
  status: string;
  version: string;
  service?: string;
}

/** Hit `GET /health`. Pass `baseOverride` to test a URL before saving it. */
export async function checkHealth(baseOverride?: string): Promise<HealthResponse> {
  return daemonFetch<HealthResponse>("/health", { method: "GET" }, baseOverride);
}

export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  counts: { projects: number; tasks: number };
}

/** Coarse read-through of the whole (active) database for the desktop Sync view. */
export async function getSnapshot(): Promise<Snapshot> {
  return daemonFetch<Snapshot>("/snapshot", { method: "GET" });
}

export interface EnrolledUser {
  id: number;
  username: string;
  full_name: string;
  is_owner: boolean;
  /** Present on /me and /enroll responses (the full user row is returned). */
  profile_json?: string;
}

export interface EnrollResult {
  device_token: string;
  user: EnrolledUser;
}

/**
 * Enroll this device against `url` using a one-time enrollment token (from the
 * desktop's pairing/invite QR). Persists the daemon URL + the returned device
 * token on success.
 */
export async function enrollDevice(
  url: string,
  enrollmentToken: string,
  deviceLabel?: string,
  displayName?: string
): Promise<EnrollResult> {
  const res = await daemonFetch<EnrollResult>(
    "/enroll",
    {
      method: "POST",
      body: JSON.stringify({ token: enrollmentToken, device_label: deviceLabel, display_name: displayName }),
    },
    url
  );
  setDaemonBaseUrl(url);
  setDeviceToken(res.device_token);
  return res;
}

export interface MeResponse {
  user: EnrolledUser;
  memberships: { project_id: number; project_name: string; role: string }[];
}

/** The authenticated user + their project memberships. Verifies the token. */
export async function getMe(): Promise<MeResponse> {
  const me = await daemonFetch<MeResponse>("/me", { method: "GET" });
  // On a hosted client the pairing decides who you are. The legacy local
  // marker (`currentUserId`) still feeds a few call sites (acting user in the
  // editor, "my assignments", quiz attempts) — keep it equal to the truth so
  // nothing on this device can disagree with the host about who is using it.
  if (isHostedClient() && me?.user?.id != null) {
    try {
      localStorage.setItem("currentUserId", String(me.user.id));
    } catch {
      /* storage unavailable — the server still stamps authorship */
    }
  }
  return me;
}

/** A semantic-search hit from the host's RAG corpus (ragrat). */
export interface RagHit {
  collection: string;
  source: string; // e.g. "task-<sync_uuid>.md" or a shared file name
  position: number;
  text: string;
  domains?: string[];
  score: number;
  aliases?: { source: string; position: number }[];
}

/**
 * Semantic search over a project's knowledge base (tasks/comments/areas + shared
 * files), served by the host's ragrat sidecar. Scope is enforced host-side: the
 * caller must be a member of `projectId`. Throws DaemonError when RAG is disabled
 * (404) or the host/embedder is unreachable.
 */
export async function searchKnowledgeBase(
  query: string,
  projectId: number,
  limit = 10,
  filters?: Record<string, string>,
): Promise<RagHit[]> {
  const body = await daemonFetch<{ hits: RagHit[] }>("/search", {
    method: "POST",
    body: JSON.stringify({ query, project_id: projectId, limit, filters }),
  });
  return body.hits ?? [];
}

/** A project's corpus facets: role → value → document count, as recorded by
 * ragrat at ingest time. Values feed `searchKnowledgeBase` filters on click. */
// ---- Atlas (Epoch I): shared knowledge collections no project owns ---- //

/** One registered Atlas collection (ragrat collection "atlas-<slug>"). */
export interface AtlasCollection {
  id: number;
  slug: string;
  name: string;
  source_dir: string;
  /** Owner-private: hidden from members in the registry + read routes. The
   * project Atlas lens is how curated slices reach members. */
  owner_only?: boolean;
  auto_index?: boolean;
  dirty_at?: string | null;
  created_at: string;
  last_ingest_at?: string | null;
}

export interface AtlasLibraryFile {
  rel_path: string;
  size_bytes: number;
  modified: number | null;
}
export interface AtlasLibraryListing {
  files: AtlasLibraryFile[];
  /** Ganban-managed folder (uploadable) vs a user-owned folder (read-only here). */
  managed: boolean;
  dirty_at: string | null;
  last_ingest_at: string | null;
  auto_index: boolean;
}

/** The files in a collection's source folder (owner). */
export async function listAtlasFiles(id: number): Promise<AtlasLibraryListing> {
  return daemonFetch(`/atlas/collections/${id}/files`);
}

/** Upload into a MANAGED library folder. NEVER indexes — press “Index now”
 * (or enable auto-index, which debounces behind a 90s quiet period). */
export async function uploadAtlasFile(id: number, file: File, relPath?: string, opts: UploadOptions = {}): Promise<void> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const q = new URLSearchParams({ rel_path: relPath || file.name });
  await managedUpload<unknown>(`${base}/atlas/collections/${id}/files?${q.toString()}`, file, { target: "Atlas library", ...opts }, relPath || file.name);
}

export async function deleteAtlasFile(id: number, relPath: string): Promise<void> {
  await daemonFetch(`/atlas/collections/${id}/files?rel_path=${encodeURIComponent(relPath)}`, { method: "DELETE" });
}

/** Owner: copy a project file's blob into a managed library (server-side). */
export async function importProjectFileToAtlas(collectionId: number, projectFileId: number, relPath?: string): Promise<void> {
  await daemonFetch(`/atlas/collections/${collectionId}/import-project-file`, {
    method: "POST",
    body: JSON.stringify({ project_file_id: projectFileId, rel_path: relPath ?? null }),
  });
}

/** Owner: copy a library file into a project's files (quota-checked). */
export async function importAtlasFileToProject(projectId: number, collectionId: number, relPath: string): Promise<ProjectFile> {
  return daemonFetch(`/projects/${projectId}/import-atlas-file`, {
    method: "POST",
    body: JSON.stringify({ collection_id: collectionId, rel_path: relPath }),
  });
}

/** Whether members may copy this project's files into their OWN Atlas
 * (owner-granted; feeds the “Add to my Atlas” affordance). */
export async function getMemberAtlasExport(projectId: number): Promise<boolean> {
  const r = await daemonFetch<{ enabled: boolean }>(`/projects/${projectId}/member-atlas-export`);
  return r.enabled;
}
export async function setMemberAtlasExport(projectId: number, enabled: boolean): Promise<void> {
  await daemonFetch(`/projects/${projectId}/member-atlas-export`, { method: "PUT", body: JSON.stringify({ enabled }) });
}

// ---- The member's OWN Atlas (their machine's loopback daemon, where they
// are the owner). This is how a work brief's documents reach the corpus the
// member's local agents actually search — MEMBER_AGENTS in file form. ----

async function localAtlasFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = localDaemonBase();
  if (!base) throw new DaemonError("No local Ganban daemon on this machine — Atlas import needs your own host running.");
  const res = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* non-JSON */ }
    throw new DaemonError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function listLocalAtlasCollections(): Promise<AtlasCollection[]> {
  return localAtlasFetch("/atlas/collections");
}
export async function createLocalAtlasCollection(slug: string, name: string): Promise<{ collection: AtlasCollection }> {
  return localAtlasFetch("/atlas/collections", { method: "POST", body: JSON.stringify({ slug, name, source_dir: "", owner_only: false }) });
}
export async function uploadLocalAtlasFile(collectionId: number, bytes: ArrayBuffer, relPath: string): Promise<void> {
  const base = localDaemonBase();
  if (!base) throw new DaemonError("No local Ganban daemon on this machine.");
  const res = await fetch(`${base}/atlas/collections/${collectionId}/files?rel_path=${encodeURIComponent(relPath)}`, {
    method: "POST",
    body: bytes,
  });
  if (!res.ok) throw new DaemonError(`Local Atlas upload failed: HTTP ${res.status}`, res.status);
}

export async function setAtlasAutoIndex(id: number, enabled: boolean): Promise<void> {
  await daemonFetch(`/atlas/collections/${id}/auto-index`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export async function listAtlasCollections(): Promise<AtlasCollection[]> {
  return daemonFetch("/atlas/collections", { method: "GET" });
}
/** Owner-only: register a collection and start its first ingest. `ownerOnly`
 * keeps it private to the owner (members never see it on the Atlas page). */
export async function createAtlasCollection(
  slug: string,
  name: string,
  sourceDir: string,
  ownerOnly = false
): Promise<{ collection: AtlasCollection; job_id?: string | null }> {
  return daemonFetch("/atlas/collections", {
    method: "POST",
    body: JSON.stringify({ slug, name, source_dir: sourceDir, owner_only: ownerOnly }),
  });
}
/** Owner-only: flip a collection's owner-private flag. */
export async function setAtlasVisibility(id: number, ownerOnly: boolean): Promise<{ ok: boolean; owner_only: boolean }> {
  return daemonFetch(`/atlas/collections/${id}/visibility`, { method: "POST", body: JSON.stringify({ owner_only: ownerOnly }) });
}
/** Owner-only: unregister (the corpus dir stays on disk). */
export async function deleteAtlasCollection(id: number): Promise<{ ok: boolean; freed: FreedReport | null }> {
  return daemonFetch(`/atlas/collections/${id}`, { method: "DELETE" });
}
/** Owner-only: re-ingest the collection's source folder. */
export async function reingestAtlasCollection(id: number): Promise<{ job_id: string }> {
  return daemonFetch(`/atlas/collections/${id}/reingest`, { method: "POST" });
}
export async function atlasFacets(slug: string): Promise<Record<string, Record<string, number>>> {
  return daemonFetch(`/atlas/facets?slug=${encodeURIComponent(slug)}`, { method: "GET" });
}
export async function atlasSearch(
  slug: string,
  query: string,
  limit = 10,
  filters?: Record<string, string>
): Promise<RagHit[]> {
  return daemonFetch("/atlas/search", { method: "POST", body: JSON.stringify({ slug, query, limit, filters }) });
}
/** Run metadata + documents table + on-disk paths for one Atlas collection. */
export interface AtlasManifest {
  run: {
    started_at?: string;
    finished_at?: string;
    figures?: { total: number; described: number };
    enrichment?: { enabled: boolean; model?: string; endpoint?: string };
    convert_fingerprint?: string;
    embedding?: { enabled?: boolean; model?: string };
  };
  documents: { relative_path: string; format?: string; size_bytes?: number; domains?: string[]; ingested_at?: string }[];
  /** Disk accounting from ragrat (null when the engine is unreachable). */
  stats?: { total_bytes?: number; corpus_bytes?: number; index_bytes?: number; chunk_count?: number; doc_count?: number } | null;
  paths: { source_dir: string; out_dir: string; corpus_dir: string };
}
export async function atlasManifest(slug: string): Promise<AtlasManifest> {
  return daemonFetch(`/atlas/manifest?slug=${encodeURIComponent(slug)}`, { method: "GET" });
}
/** The last ingest's audit report markdown (failures, figure accounting). */
export async function atlasReport(slug: string): Promise<{ report: string }> {
  return daemonFetch(`/atlas/report?slug=${encodeURIComponent(slug)}`, { method: "GET" });
}

/** The caller's OWN per-user state for a stash tab (game saves, lists, stats).
 * Member-gated, keyed server-side by the authenticated identity. */
export async function getTabUserState(projectId: number, tabId: string): Promise<Record<string, unknown>> {
  return daemonFetch(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/state`, { method: "GET" });
}
/** Save the caller's own tab state (64 KB cap server-side). */
export async function setTabUserState(projectId: number, tabId: string, state: unknown): Promise<void> {
  await daemonFetch<unknown>(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/state`, {
    method: "PUT",
    body: JSON.stringify({ state }),
  });
}

/** ragrat's freed-space accounting for a deleted collection. */
export interface FreedReport {
  freed_bytes?: number;
  corpus_bytes?: number;
  index_bytes?: number;
  doc_count?: number | null;
  chunk_count?: number | null;
}
/** Flip a project's "AI may read files" switch. Disabling deletes the
 * project's index collection — the response reports what that freed. */
export async function setProjectAiFiles(projectId: number, enabled: boolean): Promise<{ enabled: boolean; freed: FreedReport | null }> {
  return daemonFetch(`/projects/${projectId}/ai-files`, { method: "POST", body: JSON.stringify({ enabled }) });
}

/** One leaderboard row for a stash tab (player name resolved server-side). */
export interface TabScore {
  user_id: number;
  display_name: string;
  kind: string;
  score: number;
  meta_json: string;
  created_at: string;
}
/** The project's leaderboard feed for one tab (member view, newest first). */
export async function listTabScores(projectId: number, tabId: string): Promise<{ scores: TabScore[] }> {
  return daemonFetch(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/scores`, { method: "GET" });
}
/** Post the caller's own score (client-reported — friendly ranking, not anti-cheat). */
export async function postTabScore(projectId: number, tabId: string, kind: string, score: number, meta: unknown): Promise<void> {
  await daemonFetch<unknown>(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/scores`, {
    method: "POST",
    body: JSON.stringify({ kind, score, meta }),
  });
}

/** A full normalized corpus document (markdown) by its search-hit source path. */
export async function atlasDocument(slug: string, source: string): Promise<{ source: string; content: string }> {
  return daemonFetch(`/atlas/document?slug=${encodeURIComponent(slug)}&source=${encodeURIComponent(source)}`, { method: "GET" });
}

/** A project tab's saved configuration blob (e.g. the Atlas tab's filters). */
export async function getProjectTabConfig(projectId: number, tabId: string): Promise<Record<string, unknown>> {
  return daemonFetch(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/config`, { method: "GET" });
}
/** Admin-only: save a project tab's configuration. */
export async function setProjectTabConfig(projectId: number, tabId: string, config: unknown): Promise<void> {
  await daemonFetch(`/projects/${projectId}/tabs/${encodeURIComponent(tabId)}/config`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

export async function getCorpusFacets(projectId: number): Promise<Record<string, Record<string, number>>> {
  const body = await daemonFetch<{ facets: Record<string, Record<string, number>> }>(
    `/ai/facets?project_id=${projectId}`,
    { method: "GET" },
  );
  return body.facets ?? {};
}

/** Owner-only: force an immediate re-index of a project's corpus (the host also
 * polls automatically). Returns the ragrat job id. */
export async function reindexProject(projectId: number): Promise<string> {
  const body = await daemonFetch<{ job_id: string }>("/reindex", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId }),
  });
  return body.job_id;
}

/** One ragrat ingest job in the indexing queue. The daemon's worker pool runs
 * different projects' jobs concurrently; same-project jobs serialize (one
 * LanceDB writer per collection). */
export interface IndexJob {
  id: string;
  kind: string; // "ingest"
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  /** Running job with a cancel pending — it stops after its current file. */
  cancel_requested?: boolean;
  /** The Ganban project this job indexes (server-annotated; null if unattributable). */
  project_id?: number | null;
  params?: Record<string, unknown> | null;
  /** Live per-file progress while running (ragrat keeps it in memory only). */
  progress?: { done: number; total: number; current: string } | null;
  /** Worker's narration — only present on the single-job endpoint. */
  log?: string[];
}

/** Owner-only: the available Ollama models — the host's engine, or a remote
 * one when `endpoint` is given (the personality editor's Test connection). */
export async function listOllamaModels(endpoint?: string): Promise<string[]> {
  const q = endpoint?.trim() ? `?endpoint=${encodeURIComponent(endpoint.trim())}` : "";
  return await daemonFetch<string[]>(`/ai/models${q}`);
}

/** The indexing queue + history, scoped to projects you can see (owner: all). */
export async function listIndexJobs(): Promise<IndexJob[]> {
  return await daemonFetch<IndexJob[]>("/ai/jobs");
}

/** One job with its live log trail (member of its project, or owner). */
export async function getIndexJob(jobId: string): Promise<IndexJob> {
  return await daemonFetch<IndexJob>(`/ai/jobs/${encodeURIComponent(jobId)}`);
}

/** Cancel a still-queued ingest job (member of its project, or owner). */
export async function cancelIndexJob(jobId: string): Promise<void> {
  await daemonFetch<unknown>(`/ai/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

/** A chat thread (host-only AI assistant). */
export interface Chat {
  id: number;
  project_id: number;
  user_id?: number | null;
  profile_id?: number | null;
  title?: string | null;
  /** When true, every project member can read this thread (not just the author). */
  is_public?: boolean;
  /** Server-computed: whether the authenticated caller authored this thread. */
  is_mine?: boolean;
  /** In the bin since (null/absent = live). */
  deleted_at?: string | null;
  /** Pinned to the top of its project's chat list. */
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}
/** One message in a chat thread. */
export interface ChatMessage {
  id: number;
  chat_id: number;
  role: "user" | "assistant" | "system";
  content: string;
  sources_json?: string | null;
  /** Read tools the agent invoked for this turn (JSON array of names). */
  tools_json?: string | null;
  created_at: string;
}
/** A cited source surfaced for an assistant turn. */
export interface ChatSource {
  source: string;
  score?: number;
  label?: string;
}
/** A write the assistant proposed this turn — applied only on explicit approval. */
export interface ToolProposal {
  id: number;
  tool: string;
  summary: string;
  /** Whether THIS viewer may resolve it — under an 'owner' approval policy a
   * member sees their own pending work read-only. Absent = true (own card
   * fresh from a chat turn). */
  can_approve?: boolean;
  proposer_id?: number;
  /** For the inbox headline: “Alice (via agent)” when origin === 'agent'. */
  proposer_name?: string | null;
  origin?: 'agent' | null;
}
export interface StreamChatHandlers {
  onToken: (delta: string) => void;
  onSources?: (sources: ChatSource[]) => void;
  /** Stage transitions during a turn (e.g. the model has started generating). */
  onStage?: (info: { stage: string; model?: string }) => void;
  /** Read tools the agent invoked this turn (when use_tools was set). */
  onTools?: (names: string[]) => void;
  /** Write actions the agent proposed (gated — require approval to apply). */
  onProposals?: (proposals: ToolProposal[]) => void;
  onDone?: (info: {
    chat_id: number;
    message_id: number;
    usage?: { prompt_tokens: number; completion_tokens: number; duration_ms: number };
  }) => void;
  onError?: (message: string) => void;
}

/** Result of testing a candidate AI connection (server-side probe). */
export interface AiTestResult {
  ok: boolean;
  error?: string;
  models?: string[]; // Ollama: available model names
  version?: string; // ragrat: reported version
}

/** Owner-only: probe a candidate ragrat/Ollama connection from the host (the
 * host reaches its own loopback engines; a remote client can't). */
export async function testAiConnection(
  kind: "ollama" | "ragrat",
  conn: { base_url?: string; url?: string; token?: string }
): Promise<AiTestResult> {
  return daemonFetch<AiTestResult>("/ai/test", {
    method: "POST",
    body: JSON.stringify({ kind, ...conn }),
  });
}

export interface PullProgress {
  status?: string;
  completed?: number;
  total?: number;
}

/** Owner-only: pull an Ollama model on the host, streaming progress. Resolves
 * when the pull finishes; throws on transport/HTTP/pull error. */
export async function pullModel(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await streamFetch(`${base}/ai/pull`, { method: "POST", headers, body: JSON.stringify({ model }), signal }, 0);
  if (res.status === 401) {
    handleUnauthorized();
    throw new DaemonError("Session expired — re-pair with the host.", 401);
  }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b && typeof b.error === "string") msg = b.error;
    } catch {
      /* non-JSON */
    }
    throw new DaemonError(msg, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data = "";
  const dispatch = () => {
    if (event === "progress") {
      try {
        onProgress(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "error") {
      throw new DaemonError(data);
    }
    event = "message";
    data = "";
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") dispatch();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
    }
  }
}

/** Owner-only: probe an embedding model's output dimensions on the host. */
export async function embedTest(model: string): Promise<{ ok: boolean; dimensions?: number; endpoint?: string; model?: string; error?: string }> {
  return daemonFetch("/ai/embed-test", { method: "POST", body: JSON.stringify({ model }) });
}

/** Owner-only: re-ingest every project (after changing the embedding model). */
export async function reembedAll(): Promise<{ reindexed: number }> {
  return daemonFetch("/ai/reembed", { method: "POST", body: "{}" });
}

/** Dispatch an agent task ASYNCHRONOUSLY. Returns a job_id immediately; the
 * server runs the task (Ollama/pi) in the background. Poll getAgentTaskStatus
 * until status === 'done'. This avoids HTTP connection timeouts on long-running
 * model generations (pi takes 30-60s+; Tailscale drops idle connections). */
export interface AgentTaskResult {
  text: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
}

export async function dispatchAgentTask(body: {
  task_class: string;
  prompt: string;
  system_prompt?: string;
  profile_id?: number | null;
}): Promise<{ job_id: string; status: string }> {
  return daemonFetch<{ job_id: string; status: string }>("/ai/agent-task", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Poll for an async agent task's result. Returns { status: 'running' } or
 * { status: 'done', result: AgentTaskResult, error: string | null }. */
export async function getAgentTaskStatus(jobId: string): Promise<{
  status: 'running' | 'done';
  result?: AgentTaskResult | null;
  error?: string | null;
}> {
  return daemonFetch(`/ai/agent-task/${jobId}`);
}

/** Run a one-shot agent task on THIS MACHINE'S engine (loopback daemon),
 * regardless of which workspace is active. This is the member-side half of
 * MEMBER_AGENTS §2: “her agent, her machine, her budget” — the draft is
 * produced by the LOCAL model and ledgered on the LOCAL ledger; the host
 * only ever sees the resulting proposal. Loopback = owner, no token. */
/** The base URL of THIS MACHINE'S embedded daemon — never the active
 * (possibly remote) workspace. main.tsx stores the discovered loopback URL
 * under the workspaces module's key; fall back to the active URL only when
 * it IS loopback (owner on the host). Null = no local daemon here. */
export function localDaemonBase(): string | null {
  const local = localStorage.getItem("ganban-local-url"); // workspaces.ts LOCAL_URL_KEY
  if (local && local.trim()) return local.replace(/\/+$/, "");
  const active = getDaemonBaseUrl();
  if (active && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(active + "/")) return active;
  return null;
}

export async function runLocalAgentTask(body: {
  task_class: string;
  prompt: string;
  system_prompt?: string;
}): Promise<AgentTaskResult> {
  // HER machine, HER model, HER ledger — a member's laptop with the host as
  // its active workspace must not silently run this on the host.
  const base = localDaemonBase();
  if (!base) {
    throw new DaemonError("Your local assistant isn't running — start Ganban's engines on this machine first.");
  }
  const res = await fetch(`${base}/ai/agent-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* non-JSON */ }
    throw new DaemonError(`Local agent task failed: ${msg}`, res.status);
  }
  const { job_id } = await res.json();
  if (!job_id) throw new DaemonError("Local agent task failed: no job id returned.");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const st = await fetch(`${base}/ai/agent-task/${job_id}`).then((r) => r.json());
    if (st.status === "done") {
      if (st.error) throw new DaemonError(`Local agent task failed: ${st.error}`);
      return st.result as AgentTaskResult;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new DaemonError("Local agent task timed out after 5 minutes.");
}

/** OCR a PDF via ragrat's Docling+rapidocr pipeline (scanned-PDF fallback).
 * Takes raw PDF bytes (the caller slices the pages it wants with pdf-lib).
 * ASYNC job: the POST uploads the bytes and returns a job_id immediately
 * (Docling on CPU takes 1-5 min for 10 scanned pages — holding a connection
 * that long fails over Tailscale, same as agent tasks). We poll the shared
 * async-job endpoint until done. Returns the extracted markdown text. */
export async function ocrPdf(bytes: Uint8Array, fileName = "scan.pdf"): Promise<string> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const encoded = fileName.replace(/ /g, "%20").replace(/#/g, "%23").replace(/&/g, "%26").replace(/\?/g, "%3F");
  const headers: Record<string, string> = { "content-type": "application/pdf" };
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await transportFetch(
    `${base}/ai/ocr?file_name=${encoded}`,
    { method: "POST", body: bytes as unknown as BodyInit, headers },
    120000, // upload only — the OCR itself runs as a background job
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* non-JSON */ }
    throw new DaemonError(`OCR failed: ${msg}`, res.status);
  }
  const { job_id } = await res.json();
  if (!job_id) throw new DaemonError("OCR failed: no job id returned.");

  // Poll every 2s until the OCR job completes (or 10 minutes elapse).
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const status = await daemonFetch<{ status: string; result?: { text?: string } | null; error?: string | null }>(
      `/ai/agent-task/${job_id}`,
    );
    if (status.status === "done") {
      if (status.error) throw new DaemonError(`OCR failed: ${status.error}`);
      return status.result?.text ?? "";
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new DaemonError("OCR timed out after 10 minutes.");
}

/** Owner-only: re-read ragrat/Ollama connection settings on the host live
 * (applies an AI Engines change without a daemon restart). */
export async function reloadAi(): Promise<{ rag_enabled: boolean }> {
  const r = await daemonFetch<{ rag_enabled: boolean }>("/ai/reload", { method: "POST", body: "{}" });
  // Screens that show "the knowledge engine isn't set up" look again.
  window.dispatchEvent(new Event(KNOWLEDGE_ENGINE_CHANGED));
  return r;
}

/** Fired after the host re-reads its AI engine settings. */
export const KNOWLEDGE_ENGINE_CHANGED = "ganban:knowledge-engine-changed";

/** Whether the host has the optional knowledge engine (ragrat) set up: a yes/no,
 * never its address. Throws on a host too old to say. */
export async function getKnowledgeEngineSetUp(): Promise<boolean> {
  return (await daemonInvoke<{ setUp: boolean }>("get_knowledge_engine")).setUp;
}

/** A redacted, read-only diagnostics snapshot for the bug reporter. */
export interface DiagnosticsBundle {
  generated_at: string;
  app: { server_version: string };
  platform: { os: string; arch: string; family: string };
  uptime_secs: number;
  log_dir?: string | null;
  server_log_tail: string;
  engine_logs: { name: string; tail: string }[];
  ledger_recent: {
    id: number;
    at: string;
    status: string;
    tool: string;
    summary: string;
    project_id?: number | null;
    routine_id?: number | null;
    model?: string | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    duration_ms?: number | null;
  }[];
  note?: string;
}

/** Owner-only: fetch the host's diagnostics bundle (versions, platform, log
 * tails, slim ledger). Already redacted host-side. */
export async function getDiagnostics(): Promise<DiagnosticsBundle> {
  return daemonFetch<DiagnosticsBundle>("/diagnostics");
}

/** Owner-only: download a full (redacted) host log file — the newest server log
 * by default, or a named `*.log` from the host's log dir. Returns text + the
 * host's filename (for the saved file). */
export async function fetchHostLog(file?: string): Promise<{ name: string; text: string }> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const qs = file ? `?file=${encodeURIComponent(file)}` : "";
  const res = await transportFetch(`${base}/diagnostics/log${qs}`, { headers }, 0);
  if (res.status === 401) {
    handleUnauthorized();
    throw new DaemonError("Session expired — re-pair with the host.", 401);
  }
  if (!res.ok) throw new DaemonError(`HTTP ${res.status}`, res.status);
  const text = await res.text();
  if (text.trimStart().startsWith("<") || (res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new DaemonError(`“/diagnostics/log” isn’t available on the connected host yet.`, res.status, "ENDPOINT_MISSING");
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="?([^";]+)"?/);
  return { name: m?.[1] ?? file ?? "ganban-server.log", text };
}

/** An AI model profile / personality. */
export interface ModelProfile {
  id: number;
  name: string;
  model: string;
  system_prompt?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  role?: string | null;
  /** Epoch H: remote Ollama base URL this profile runs against (null = local). */
  endpoint?: string | null;
  /** Shown when the remote engine is unreachable (a sleeping box ≠ an error). */
  fallback_note?: string | null;
  /** Custom profile picture as a data-URL. */
  avatar?: string | null;
  /** Cached model capabilities (JSON string of ModelMeta) for the vCard. */
  model_meta?: string | null;
  created_at: string;
  updated_at: string;
}

/** A model's capabilities snapshot (from Ollama /api/show), shown on the vCard. */
export interface ModelMeta {
  context_length?: number | null;
  family?: string | null;
  parameter_size?: string | null;
  quantization?: string | null;
  capabilities?: string[] | null;
}

/** Parse a profile's cached model_meta JSON into a ModelMeta (null on absent/bad). */
export function parseModelMeta(json: string | null | undefined): ModelMeta | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ModelMeta;
  } catch {
    return null;
  }
}

/** Owner-only: live model capabilities for the vCard preview before saving. */
export async function getModelInfo(model: string): Promise<ModelMeta> {
  return daemonFetch<ModelMeta>(`/ai/model-info?model=${encodeURIComponent(model)}`);
}

/** Owner-only: list model profiles + which is active + which is the secretary
 * + the model routing table (task class → profile id, e.g. routing.tools). */
export async function listProfiles(): Promise<{
  profiles: ModelProfile[];
  active_id: number | null;
  secretary_id?: number | null;
  routing?: Record<string, number>;
}> {
  return daemonFetch("/ai/profiles", { method: "GET" });
}
/** Owner-only: designate (id) or clear (null) the secretary's personality. */
export async function setSecretaryProfile(id: number | null): Promise<void> {
  await daemonFetch("/ai/secretary-profile", { method: "POST", body: JSON.stringify({ id }) });
}
/** Owner-only: route a task class ("tools") to a profile, or clear it (null) so
 * the class runs on the conversation's own personality. */
export async function setRoutingProfile(taskClass: string, id: number | null): Promise<void> {
  await daemonFetch("/ai/routing", { method: "POST", body: JSON.stringify({ task_class: taskClass, id }) });
}

/** Set the full protocol for a task class: runner (ollama/pi) + model. For
 * Ollama, `profileId` picks a model_profiles row; for pi, `model` is a model
 * pattern like "anthropic/claude-sonnet-4". Pass nulls to clear. */
export async function setTaskProtocol(body: {
  task_class: string;
  runner: "ollama" | "pi";
  profile_id?: number | null;
  model?: string | null;
}): Promise<void> {
  await daemonFetch("/ai/routing", {
    method: "POST",
    body: JSON.stringify({
      task_class: body.task_class,
      runner: body.runner,
      id: body.profile_id ?? null,
      model: body.model ?? null,
    }),
  });
}

/** A protocol (Epoch R): the repeatability artifact. Versions are immutable;
 * status lifecycle: draft → (dry-run) → dryrun → (owner approves) → approved. */
export interface ProtocolVersionInfo {
  version: number;
  status: "draft" | "dryrun" | "approved" | "retired";
  content_hash: string;
  created_at: string;
  trigger: string | null;
  engine: { runner: string; profile_id: number | null; model: string | null } | null;
}
export interface ProtocolInfo {
  slug: string;
  name: string;
  task_class: string;
  active_version: number | null;
  versions: ProtocolVersionInfo[];
}

/** Demonstration synthesis (R.4 Phase A): a recorded demonstration becomes a
 * protocol DRAFT — steps into the enforced frontmatter, narration into the
 * briefing — and enters the normal lifecycle (review, dry-run, activate). */
export async function synthesizeDemo(
  name: string,
  steps: unknown[],
  narration: string
): Promise<{ slug: string; version: number; content_hash: string; frontmatter: unknown; briefing: string }> {
  return daemonFetch("/ai/demo/synthesize", { method: "POST", body: JSON.stringify({ name, steps, narration }) });
}

/** Owner-only: every protocol with its full version history. */
export async function listProtocols(): Promise<{ protocols: ProtocolInfo[] }> {
  return daemonFetch("/ai/protocols");
}

// --------------------------------------------------------------------------- //
// Oracle — the Assistant's workflow builder (owner-only automations). A
// definition is a small node graph; the server validates it against the
// runner's compiled-in catalog (reject, never coerce) and runs it as an async
// job. Writes only ever FILE PROPOSALS — a workflow can't bypass the gate.
// --------------------------------------------------------------------------- //

export interface OracleNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params?: Record<string, string>;
}
export interface OracleWire {
  from: string;
  to: string;
}
export interface OracleDefinition {
  nodes: OracleNode[];
  wires: OracleWire[];
}
export interface OracleWorkflow {
  id: number;
  name: string;
  status: 'live' | 'paused';
  definition: OracleDefinition;
  updated_at: string;
  last_run_at: string | null;
  /** Per-node log of the last run — {status, preview?, note?} by node id. */
  last_results?: Record<string, { status: string; preview?: string; note?: string }> | null;
}

export async function listOracleWorkflows(): Promise<{ workflows: OracleWorkflow[]; node_types: string[] }> {
  return daemonFetch("/ai/oracle");
}

/** An `/invoke` command against the SAME daemon the Oracle stores and runs
 * on. The Oracle's pickers must use THIS, never the api.ts transport switch:
 * a desktop in local mode would otherwise populate dropdowns from the
 * laptop's own SQLite while the workflow executes on the host — colliding
 * numeric ids resolve to entirely different projects (the “picked Ganban,
 * ran against archived ZZ” incident). One daemon, one source of truth. */
export async function daemonInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return daemonFetch<T>("/invoke", { method: "POST", body: JSON.stringify({ command, args: args ?? {} }) });
}
export async function createOracleWorkflow(name: string, definition: OracleDefinition): Promise<{ id: number }> {
  return daemonFetch("/ai/oracle", { method: "POST", body: JSON.stringify({ name, definition }) });
}
export async function updateOracleWorkflow(
  id: number,
  patch: { name?: string; status?: 'live' | 'paused'; definition?: OracleDefinition }
): Promise<void> {
  await daemonFetch(`/ai/oracle/${id}`, { method: "PUT", body: JSON.stringify(patch) });
}
export async function deleteOracleWorkflow(id: number): Promise<void> {
  await daemonFetch(`/ai/oracle/${id}`, { method: "DELETE" });
}

/** Recent workflow runs, newest first — the Bridge's monitoring feed. */
/** Abort the active run of a workflow (manual or scheduled): remaining nodes
 * are marked aborted, the in-flight node's request is dropped mid-generation. */
export async function cancelOracleRun(workflowId: number): Promise<boolean> {
  const r = await daemonFetch<{ cancelled: boolean }>(`/ai/oracle/${workflowId}/cancel`, { method: "POST" });
  return r.cancelled;
}

/** Live progress of every ACTIVE run, keyed by workflow id — the reattach
 * surface: the Bridge polls this so leaving the tab loses nothing. */
export async function listActiveOracleRuns(): Promise<Record<string, Pick<OracleRunResult, 'run_id' | 'nodes'>>> {
  const r = await daemonFetch<{ runs: Record<string, Pick<OracleRunResult, 'run_id' | 'nodes'>> }>(`/ai/oracle/active`);
  return r.runs;
}

export async function listOracleRuns(): Promise<{ runs: { id: number; name: string; status: string; created_at: string; updated_at: string; workflow_id?: number | null; results?: Record<string, { status: string; preview?: string; note?: string }> | null }[] }> {
  return daemonFetch("/ai/oracle/runs");
}

/** Owner-only: the host's routines (rundown etc.), with triggers + last runs. */
export interface RoutineInfo {
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  trigger_json: string;
  last_run_at?: string | null;
}
export async function listRoutines(): Promise<RoutineInfo[]> {
  return daemonFetch("/routines");
}
export async function runRoutine(id: number): Promise<unknown> {
  return daemonFetch(`/routines/${id}/run`, { method: "POST", body: "{}" });
}

export interface OracleRunNodeResult {
  status: 'done' | 'failed' | 'skipped' | 'running' | 'frozen' | 'aborted';
  preview: string;
  note?: string;
}
export interface OracleRunResult {
  run_id: number;
  status: 'done' | 'partial' | 'failed' | 'aborted';
  nodes: Record<string, OracleRunNodeResult>;
}

/** Run a workflow and wait for it (async job under the hood — model steps
 * can take minutes and held connections die over Tailscale). `onProgress`
 * fires on every poll while the run walks the graph — the canvas can show
 * which node is executing RIGHT NOW instead of a spinner and a verdict.
 * `from` = partial re-run: execute that node + everything downstream, freeze
 * the rest to the last run's outputs (debug the tail without re-fetching).
 * `only` (with `from`) = notebook cell: execute JUST that node; downstream
 * memory stays untouched. */
export async function runOracleWorkflow(
  id: number,
  onProgress?: (partial: Pick<OracleRunResult, 'run_id' | 'nodes'>) => void,
  from?: string,
  only = false
): Promise<OracleRunResult> {
  const { job_id } = await daemonFetch<{ job_id: string }>(`/ai/oracle/${id}/run`, {
    method: "POST",
    body: JSON.stringify(from ? { from, only } : {}),
  });
  // The run is a SERVER job — the client's only job is to keep listening.
  // Local models on modest hardware legitimately take 10+ minutes per step
  // (field: a desktop-class host chewing a 4-model news digest), so the poll follows
  // the job's own status for as long as it reports running, with a generous
  // absolute safety net against zombie jobs.
  const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) {
    const st = await daemonFetch<{
      status: string;
      progress?: Pick<OracleRunResult, 'run_id' | 'nodes'> | null;
      result?: OracleRunResult | null;
      error?: string | null;
    }>(`/ai/agent-task/${job_id}`);
    if (st.status === "done") {
      if (st.error) throw new DaemonError(`Run failed: ${st.error}`);
      return st.result as OracleRunResult;
    }
    if (st.progress && onProgress) onProgress(st.progress);
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new DaemonError("Gave up polling after 90 minutes — check Bridge › Recent runs; the job may still finish server-side.");
}

/** One typed input declaration — the gallery's install wizard IS these. */
export interface ProtocolInput {
  name: string;
  type: "string" | "int" | "bool" | "folder_path" | "profile";
  required?: boolean;
  default?: unknown;
  label?: string;
}
export interface GalleryEntry {
  slug: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown> & { inputs?: ProtocolInput[] };
  briefing: string;
}

/** Owner-only: the built-in protocol gallery (pre-built templates). */
export async function getProtocolGallery(): Promise<{ gallery: GalleryEntry[] }> {
  return daemonFetch("/ai/protocols/gallery");
}

/** Owner-only: the builder's save — an immutable new version. The frontmatter
 * is a JSON object (YAML never appears); validation rejects, never coerces. */
export async function createProtocol(body: {
  slug: string;
  name: string;
  frontmatter: Record<string, unknown>;
  briefing?: string;
  activate?: boolean;
}): Promise<{ slug: string; version: number; content_hash: string }> {
  return daemonFetch("/ai/protocols", { method: "POST", body: JSON.stringify(body) });
}

/** R.2 dry-run harness: run a version's engine against a task-class fixture.
 * Cost-metered (a 'dryrun' ledger row); on pass, draft → dryrun. Nothing is
 * applied anywhere. Can take a while (a real model generation). */
export async function dryRunProtocol(slug: string, version: number): Promise<{
  passed: boolean;
  note: string;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  duration_ms?: number | null;
  preview?: string;
}> {
  return daemonFetch(`/ai/protocols/${encodeURIComponent(slug)}/dry-run`, {
    method: "POST",
    body: JSON.stringify({ version }),
  }, undefined, 300000); // a real model generation — generous timeout
}

/** Owner approval: activate a version (manual: directly; routine/rule: only
 * after a passed dry-run). */
export async function activateProtocol(slug: string, version: number): Promise<void> {
  await daemonFetch(`/ai/protocols/${encodeURIComponent(slug)}/activate`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

/** Deactivate a protocol (versions remain; the task class falls back to defaults). */
export async function deactivateProtocol(slug: string): Promise<void> {
  await daemonFetch(`/ai/protocols/${encodeURIComponent(slug)}/deactivate`, { method: "POST", body: "{}" });
}
/** Owner-only: create (no id) or update a model profile. */
export async function upsertProfile(
  p: { id?: number; name: string; model: string; system_prompt?: string; temperature?: number; max_tokens?: number; role?: string; avatar?: string | null; endpoint?: string; fallback_note?: string }
): Promise<ModelProfile> {
  return daemonFetch("/ai/profiles", { method: "POST", body: JSON.stringify(p) });
}
/** Owner-only: delete a model profile. */
export async function deleteProfile(id: number): Promise<void> {
  await daemonFetch(`/ai/profiles/${id}`, { method: "DELETE" });
}

/** A loadout: a named bundle a personality carries (tools + prompt + sub-model). */
export interface Loadout {
  id: number;
  name: string;
  description: string;
  prompt_fragment?: string | null;
  routing_profile_id?: number | null;
  tools: string[];
}
/** Owner-only: every loadout, with the tool names it grants. */
export async function listLoadouts(): Promise<Loadout[]> {
  return daemonFetch("/ai/loadouts", { method: "GET" });
}
export async function createLoadout(input: {
  name: string;
  description?: string;
  prompt_fragment?: string | null;
  routing_profile_id?: number | null;
  tools?: string[];
}): Promise<Loadout> {
  return daemonFetch("/ai/loadouts", { method: "POST", body: JSON.stringify(input) });
}
export async function updateLoadout(
  id: number,
  input: { name?: string; description?: string; prompt_fragment?: string | null; routing_profile_id?: number | null; tools?: string[] }
): Promise<Loadout> {
  return daemonFetch(`/ai/loadouts/${id}`, { method: "PUT", body: JSON.stringify(input) });
}
export async function deleteLoadout(id: number): Promise<void> {
  await daemonFetch(`/ai/loadouts/${id}`, { method: "DELETE" });
}
/** The loadout ids a personality carries. */
export async function getProfileLoadouts(profileId: number): Promise<number[]> {
  return daemonFetch(`/ai/profiles/${profileId}/loadouts`, { method: "GET" });
}
/** Owner-only: set which loadouts a personality carries. */
export async function setProfileLoadouts(profileId: number, loadoutIds: number[]): Promise<void> {
  await daemonFetch<unknown>(`/ai/profiles/${profileId}/loadouts`, { method: "PUT", body: JSON.stringify({ loadout_ids: loadoutIds }) });
}
/** Owner-only: make a profile the active one. */
export async function setActiveProfile(id: number): Promise<void> {
  await daemonFetch("/ai/active-profile", { method: "POST", body: JSON.stringify({ id }) });
}

/** The caller's personal container (hidden from project lists), made on first ask: where
 * their Personal chats live. Only they reach it, the host owner included. */
export async function personalSpaceId(): Promise<number> {
  return (await daemonInvoke<{ projectId: number }>("ensure_personal_space")).projectId;
}
/** A member's chat threads in a project (their own). */
export async function listChats(projectId: number): Promise<Chat[]> {
  return daemonFetch<Chat[]>(`/chats?project_id=${projectId}`, { method: "GET" });
}
/** The messages of a chat thread, oldest first. */
export async function getChatMessages(chatId: number): Promise<ChatMessage[]> {
  return daemonFetch<ChatMessage[]>(`/chats/${chatId}/messages`, { method: "GET" });
}
/** Per-comment, per-emoji reaction tally. `mine` > 0 = the caller reacted. */
export interface ReactionSummary {
  comment_id: number;
  emoji: string;
  count: number;
  mine: number;
}

/** All reaction tallies for a task's comments (member-scoped, host-served). */
export async function getTaskReactions(taskId: number): Promise<ReactionSummary[]> {
  return daemonFetch<ReactionSummary[]>(`/tasks/${taskId}/reactions`);
}

/** Reaction tallies for every comment in a project (the comment board). */
export async function getProjectReactions(projectId: number): Promise<ReactionSummary[]> {
  return daemonFetch<ReactionSummary[]>(`/projects/${projectId}/reactions`);
}

/** Toggle the caller's emoji reaction on a comment. Returns whether it's now set. */
export async function toggleCommentReaction(commentId: number, emoji: string): Promise<boolean> {
  const r = await daemonFetch<{ reacted: boolean }>(`/comments/${commentId}/react`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  });
  return r.reacted;
}

/** A custom emoji: a named small image, used in comments/reactions as `:name:`. */
export interface CustomEmoji {
  id: number;
  name: string;
  image: string; // resized data-URL
  user_id?: number;
  created_at: string;
}

/** All custom emojis (host-served, shared by the team). */
export async function listCustomEmojis(): Promise<CustomEmoji[]> {
  return daemonFetch<CustomEmoji[]>("/emoji");
}

/** Add a custom emoji (any member). `image` is a small resized data-URL. */
export async function createCustomEmoji(name: string, image: string): Promise<CustomEmoji> {
  return daemonFetch<CustomEmoji>("/emoji", { method: "POST", body: JSON.stringify({ name, image }) });
}

/** Remove a custom emoji (owner or the member who added it). */
export async function deleteCustomEmoji(id: number): Promise<void> {
  await daemonFetch(`/emoji/${id}`, { method: "DELETE" });
}

/** Publish (share with the team) or unpublish a chat. Author or project admin. */
export async function setChatPublic(chatId: number, isPublic: boolean): Promise<Chat> {
  return daemonFetch<Chat>(`/chats/${chatId}/publish`, {
    method: "POST",
    body: JSON.stringify({ public: isPublic }),
  });
}

/** Pin / unpin a chat — pinned threads float to the top of the list. */
export async function setChatPinned(chatId: number, pinned: boolean): Promise<Chat> {
  return daemonFetch<Chat>(`/chats/${chatId}/pin`, {
    method: "POST",
    body: JSON.stringify({ pinned }),
  });
}

/** Stage 1 of deletion: move a thread to the bin (restorable). */
export async function binChat(chatId: number): Promise<void> {
  await daemonFetch(`/chats/${chatId}/bin`, { method: "POST" });
}
/** Bring a binned thread back. */
export async function restoreChat(chatId: number): Promise<void> {
  await daemonFetch(`/chats/${chatId}/restore`, { method: "POST" });
}
/** Stage 2: permanently delete — the host refuses unless the chat is binned. */
export async function purgeChat(chatId: number): Promise<void> {
  await daemonFetch(`/chats/${chatId}`, { method: "DELETE" });
}
/** The caller's binned threads in a project. */
export async function listBinnedChats(projectId: number): Promise<Chat[]> {
  return daemonFetch<Chat[]>(`/chats/binned?project_id=${projectId}`, { method: "GET" });
}

/**
 * Stream a per-project RAG chat turn over SSE. Bypasses daemonFetch (which
 * buffers the body and aborts after 8s — unusable for a long generation),
 * replicating its Bearer-token + 401-re-enroll handling. Resolves when the
 * stream ends; throws DaemonError on transport/HTTP failure before the stream.
 */
export async function streamChat(
  body: { project_id: number; chat_id?: number; message: string; top_k?: number; profile_id?: number; use_tools?: boolean },
  handlers: StreamChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await streamFetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify(body), signal }, 0);
  if (res.status === 401) {
    handleUnauthorized();
    throw new DaemonError("Session expired — re-pair with the host.", 401);
  }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b && typeof b.error === "string") msg = b.error;
    } catch {
      /* non-JSON */
    }
    throw new DaemonError(msg, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data = "";
  const dispatch = () => {
    if (event === "token") handlers.onToken(data);
    else if (event === "sources") {
      try {
        handlers.onSources?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "stage") {
      try {
        handlers.onStage?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "tools") {
      try {
        handlers.onTools?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "proposals") {
      try {
        handlers.onProposals?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "done") {
      try {
        handlers.onDone?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "error") {
      handlers.onError?.(data);
    }
    event = "message";
    data = "";
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        dispatch(); // blank line terminates an SSE event
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
      }
    }
  }
  if (data) dispatch(); // flush a trailing un-terminated event
}

// ---- Secretary (owner-only, host-served) ----------------------------------
// A grounded, cross-project daily assistant. The brief is deterministic facts
// (no model); the chat is an ephemeral grounded SSE stream (no persistence —
// the client replays its own history each turn); the rundown is a per-project
// digest, stored host-side and regenerated on demand.

/** One upcoming event, pre-bucketed/formatted by the host (local timezone). */
export interface EventBrief {
  id: number;
  title: string;
  date: string; // YYYY-MM-DD (host local)
  weekday: string;
  all_day: boolean;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
  projects: string[];
  bucket: "today" | "tomorrow" | "upcoming";
}
/** The authoritative day context: current date/time + the next week of events. */
export interface DailyBrief {
  today: string;
  now: string;
  weekday: string;
  events: EventBrief[];
  today_count: number;
  tomorrow_count: number;
}
/** One project's line in the daily rundown. */
export interface ProjectRundown {
  project_id: number;
  project_name: string;
  summary: string;
  flags: string[];
}
/** The assembled per-project daily digest. */
export interface Rundown {
  run_date: string;
  generated_at: string;
  projects: ProjectRundown[];
  omitted: number;
}

/** The deterministic daily brief (no LLM call). Owner-only. */
export async function getDailyBrief(): Promise<DailyBrief> {
  return daemonFetch<DailyBrief>("/secretary/brief", { method: "GET" });
}
/** The latest stored rundown, or null if none has been generated yet. */
export async function getLatestRundown(): Promise<Rundown | null> {
  return daemonFetch<Rundown | null>("/secretary/rundown", { method: "GET" });
}
/** (Re)generate today's rundown (several LLM calls — allow a generous timeout). */
export async function generateRundown(): Promise<Rundown> {
  return daemonFetch<Rundown>("/secretary/rundown", { method: "POST", body: "{}" }, undefined, 180000);
}

export interface SecretaryHandlers {
  onToken: (delta: string) => void;
  onStage?: (info: { stage: string; model?: string }) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * Stream a grounded secretary turn over SSE. Like `streamChat`, but the request
 * carries the running conversation (`history`) since the secretary keeps no
 * server-side state, and there are no retrieval sources to surface.
 */
export async function streamSecretary(
  body: { message: string; history?: { role: string; content: string }[] },
  handlers: SecretaryHandlers,
  signal?: AbortSignal
): Promise<void> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await streamFetch(`${base}/secretary/chat`, { method: "POST", headers, body: JSON.stringify(body), signal }, 0);
  if (res.status === 401) {
    handleUnauthorized();
    throw new DaemonError("Session expired — re-pair with the host.", 401);
  }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b && typeof b.error === "string") msg = b.error;
    } catch {
      /* non-JSON */
    }
    throw new DaemonError(msg, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data = "";
  const dispatch = () => {
    if (event === "token") handlers.onToken(data);
    else if (event === "stage") {
      try {
        handlers.onStage?.(JSON.parse(data));
      } catch {
        /* ignore */
      }
    } else if (event === "done") {
      handlers.onDone?.();
    } else if (event === "error") {
      handlers.onError?.(data);
    }
    event = "message";
    data = "";
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") dispatch();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
    }
  }
  if (data) dispatch();
}

/** Approve + apply a write the assistant proposed (by proposal id). The host
 * re-checks scope, executes once (consumed), ledgers the applied action, and
 * returns the result. */
export async function executeProposal(proposalId: number): Promise<{ ok: boolean; command: string; result: unknown }> {
  return daemonFetch("/tools/execute", { method: "POST", body: JSON.stringify({ proposal_id: proposalId }) });
}

/** Reject a write the assistant proposed: consumes the proposal server-side (no
 * domain change) and ledgers the rejection. */
export async function rejectProposal(proposalId: number): Promise<{ ok: boolean }> {
  return daemonFetch("/tools/reject", { method: "POST", body: JSON.stringify({ proposal_id: proposalId }) });
}

/** A folder-sync mapping: a local folder (e.g. one kept mirrored by OneDrive/
 * Nextcloud/Google Drive's desktop client) imported into a project's files. */
export interface SyncFolder {
  id: number;
  project_id: number;
  path: string;
  /** Comma-separated extension allowlist (no dots); empty = all. */
  include_ext: string;
  /** Per-file ceiling in bytes; 0 = unlimited. */
  max_bytes: number;
  enabled: boolean;
  last_scan_at?: string | null;
  last_result?: string | null;
  created_at: string;
}
export interface FolderScanSummary {
  added: number;
  updated: number;
  unchanged: number;
  filtered: number;
  errors: [string, string][];
}
export async function listSyncFolders(): Promise<SyncFolder[]> {
  return daemonFetch("/sync-folders", { method: "GET" });
}
export async function createSyncFolder(projectId: number, path: string, includeExt: string, maxBytes: number): Promise<SyncFolder> {
  return daemonFetch("/sync-folders", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId, path, include_ext: includeExt, max_bytes: maxBytes }),
  });
}
export async function updateSyncFolder(id: number, patch: { enabled?: boolean; include_ext?: string; max_bytes?: number }): Promise<SyncFolder> {
  return daemonFetch(`/sync-folders/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}
export async function deleteSyncFolder(id: number): Promise<void> {
  await daemonFetch<void>(`/sync-folders/${id}`, { method: "DELETE" });
}
export async function runSyncFolder(id: number): Promise<FolderScanSummary> {
  return daemonFetch(`/sync-folders/${id}/run`, { method: "POST" });
}

/** One compiled-in stash tab, as the host reports it (availability is decided
 * at build time by server feature flags; enablement is per project). */
export interface TabDescriptor {
  id: string;
  name: string;
  icon: string;
  /** 1 = panel-only (no tools); 2 = contributes agent tools. */
  tier: number;
  description: string;
  has_tools: boolean;
}
/** Every tab compiled into the host binary. */
export async function listAvailableTabs(): Promise<TabDescriptor[]> {
  return daemonFetch("/tabs", { method: "GET" });
}
/** The tab ids enabled for a project. */
export async function getProjectTabs(projectId: number): Promise<string[]> {
  return daemonFetch(`/projects/${projectId}/tabs`, { method: "GET" });
}
/** Enable/disable a tab on a project (project admins and up). */
export async function setProjectTab(projectId: number, tabId: string, enabled: boolean): Promise<void> {
  await daemonFetch(`/projects/${projectId}/tabs`, { method: "PUT", body: JSON.stringify({ tab_id: tabId, enabled }) });
}

/** A project file's raw bytes in memory (authorized GET; for panels that work
 * on file contents, e.g. the PDF tab). Distinct from downloadProjectFile,
 * which saves to disk. */
export async function fetchProjectFileBytes(fileId: number): Promise<ArrayBuffer> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await streamFetch(`${base}/projects/files/${fileId}/download`, { headers }, 0);
  if (!res.ok) throw new DaemonError(`HTTP ${res.status}`, res.status);
  return res.arrayBuffer();
}

/** Raw bytes of a SHARED task attachment, over HTTP in every mode (unlike
 * getDaemonFileBlob, whose desktop branch reads the local replica — wrong on
 * a desktop in online mode, where blobs live only on the host). */
export async function fetchAttachmentBytes(attachmentId: number): Promise<ArrayBuffer> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await streamFetch(`${base}/files/${attachmentId}`, { headers }, 0);
  if (!res.ok) throw new DaemonError(`HTTP ${res.status}`, res.status);
  return res.arrayBuffer();
}

/** A field-level snapshot of what a proposed write would change. */
export interface ProposalDetails {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}
/** One entry of the caller's pending-proposal inbox. */
/** Host health snapshot + history from /system/stats (owner-only). */
export interface HostStats {
  now: { cpu_pct: number; gpu_pct?: number | null; mem_used: number; mem_total: number; disk_free: number; disk_total: number; db_bytes: number };
  uptime_seconds: number;
  requests: {
    count: number;
    avg_ms: number;
    slow_1s: number;
    /** The host's rolling window (absent on older hosts). */
    traffic?: {
      per_min: number;
      window_secs: number;
      window_count: number;
      top_calls: { key: string; count: number }[];
      /** Peer address ("this host" = loopback: this machine's own app/UI). */
      top_clients: { key: string; count: number }[];
    };
  };
  history: { ts: string; cpu_pct: number; gpu_pct?: number | null; mem_used: number; mem_total: number; disk_free: number; disk_total: number; db_bytes: number }[];
}
/** Host vitals. `history: false` skips the 8-hour series (the live tiles and
 * the header chip only need `now`) — see lib/hostPoll.ts for the shared pollers. */
export async function getHostStats(opts: { history?: boolean } = {}): Promise<HostStats> {
  return daemonFetch<HostStats>(opts.history === false ? "/system/stats?history=0" : "/system/stats");
}

export interface PendingProposal {
  id: number;
  project_id: number;
  /** Resolved on the host that owns the id (see AgentAction.project_name). */
  project_name?: string | null;
  chat_id: number;
  tool: string;
  summary: string;
  details?: ProposalDetails;
  proposer_id?: number;
  /** For the inbox headline: “Alice (via agent)” when origin === 'agent'. */
  proposer_name?: string | null;
  origin?: 'agent' | null;
  /** Whether THIS viewer may resolve it (approval policy); absent = true. */
  can_approve?: boolean;
  /** When it was filed — approval queues without times are unrankable. */
  created_at?: string;
}
/** Who resolves a project's agent proposals (MEMBER_AGENTS prereq 3):
 * 'proposer' (default — each member reviews their own agent's work) or
 * 'owner' (stricter desks — the owner approves everything). */
export async function getApprovalPolicy(projectId: number): Promise<{ policy: 'proposer' | 'owner' }> {
  return daemonFetch(`/projects/${projectId}/approval-policy`);
}

/** Owner-only: set the project's approval policy. */
export async function setApprovalPolicy(projectId: number, policy: 'proposer' | 'owner'): Promise<void> {
  await daemonFetch(`/projects/${projectId}/approval-policy`, { method: 'PUT', body: JSON.stringify({ policy }) });
}

/** The member-agent return path (MEMBER_AGENTS §2): submit a locally-produced
 * write as a durable proposal ON THE HOST — validated by the same gate as a
 * host chat turn, attributed “(via agent)” when viaAgent is set. Nothing
 * executes until someone with the approval right resolves it. */
export async function submitProposal(
  projectId: number,
  tool: string,
  args: Record<string, unknown>,
  viaAgent = false
): Promise<{ id: number; tool: string; summary: string }> {
  return daemonFetch("/invoke", {
    method: "POST",
    body: JSON.stringify({ command: "submit_proposal", args: { projectId, tool, args, viaAgent } }),
  });
}

/** The caller's pending write proposals across projects, oldest first. */
export async function listPendingProposals(): Promise<PendingProposal[]> {
  return daemonFetch("/tools/proposals", { method: "GET" });
}

/** One agent tool in the catalog (what the assistant CAN do on this build). */
export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  class: "read" | "write";
  /** Writes ride propose → approve → execute; never auto-run. */
  gated: boolean;
  /** "builtin" | "tab:<id>". */
  source: string;
  /** What must be enabled for the model to see it ("rag" | "atlas" | tab id). */
  requires?: string | null;
}
/** One tool ragrat publishes on its MCP surface (its own tool plane). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}
/** The knowledge engine's self-report (owner-only; null for members). */
export interface ToolEngine {
  configured: boolean;
  base_url?: string;
  /** ragrat's GET /status verbatim (version, mounts, mcp_mounts, embedder). */
  status?: Record<string, unknown> | null;
  /** Tools listed off ragrat's root MCP mount (best-effort; null if unreachable). */
  mcp_tools?: McpTool[] | null;
}
export interface ToolCatalog {
  /** The host daemon's version (env!(CARGO_PKG_VERSION)) — surfaces client/host skew. */
  version?: string;
  tools: ToolInfo[];
  engine: ToolEngine | null;
}
/** Inspect every agent tool this build offers, plus (owner) the ragrat/MCP
 * engine status — the Tools panel. Read-only; executes nothing. */
export async function getToolCatalog(): Promise<ToolCatalog> {
  return daemonFetch("/tools/catalog", { method: "GET" });
}

/** A declarative ("registry") agent tool — defined as data, owner-managed. */
export interface RegistryTool {
  id: number;
  name: string;
  description: string;
  params_json: string;
  class: string;
  binding_kind: string;
  binding_json: string;
  enabled: boolean;
}
/** The binding kinds + allowlisted commands a new registry tool may use. */
export interface RegistryBindings {
  kinds: string[];
  ops_commands: string[];
  /** For the mcp binding: ragrat's real mounts + the tools on each. */
  mcp_mounts?: { mount: string; tools: string[] }[];
}
/** Owner-only: list/define/toggle/delete declarative tools. */
export async function listRegistryTools(): Promise<RegistryTool[]> {
  return daemonFetch("/tools/registry", { method: "GET" });
}
export async function getRegistryBindings(): Promise<RegistryBindings> {
  return daemonFetch("/tools/registry/bindings", { method: "GET" });
}
export async function createRegistryTool(input: {
  name: string;
  description: string;
  binding_kind: string;
  binding_json: string;
  class?: string;
  params_json?: string;
}): Promise<RegistryTool> {
  return daemonFetch("/tools/registry", { method: "POST", body: JSON.stringify(input) });
}
export async function setRegistryToolEnabled(id: number, enabled: boolean): Promise<void> {
  await daemonFetch<unknown>(`/tools/registry/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) });
}
export async function deleteRegistryTool(id: number): Promise<void> {
  await daemonFetch<unknown>(`/tools/registry/${id}`, { method: "DELETE" });
}

/** Owner-only connector secrets (for the http binding). Names only — values are
 * write-only and never returned. */
export async function listConnectorSecrets(): Promise<string[]> {
  return daemonFetch("/ai/connector-secrets", { method: "GET" });
}
export async function setConnectorSecret(name: string, value: string): Promise<void> {
  await daemonFetch<unknown>("/ai/connector-secrets", { method: "PUT", body: JSON.stringify({ name, value }) });
}
export async function deleteConnectorSecret(name: string): Promise<void> {
  await daemonFetch<unknown>(`/ai/connector-secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/** One row of the agent action ledger (what was applied or rejected, by whom,
 * from which conversation/routine). */
export interface AgentAction {
  id: number;
  status: "applied" | "rejected";
  user_id: number;
  profile_id?: number | null;
  /** Null for cross-project work (a routine run like the daily rundown). */
  project_id: number | null;
  /** Resolved on the HOST that owns the id — clients must never look a bare
   * project id up in a merged multi-workspace store (ids collide). */
  project_name?: string | null;
  chat_id?: number | null;
  routine_id?: number | null;
  tool: string;
  summary: string;
  args_json: string;
  result_json?: string | null;
  created_at: string;
}
/** The activity ledger, newest first. With a project id: that project's trail
 * (any member); without: the global trail (owner-only). */
export async function listAgentActions(projectId?: number | null, limit = 100): Promise<AgentAction[]> {
  const q = new URLSearchParams();
  if (projectId != null) q.set("project_id", String(projectId));
  q.set("limit", String(limit));
  return daemonFetch(`/agent/actions?${q.toString()}`, { method: "GET" });
}

/** Upload a file as a shared attachment on `taskId` (raw body + metadata in the
 * query). Returns the created attachment. Used by networked clients (the desktop
 * shares local files instead). */
export async function uploadSharedFile(taskId: number, file: File, opts: UploadOptions = {}): Promise<unknown> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const q = new URLSearchParams({
    task_id: String(taskId),
    file_name: file.name,
    file_type: file.type || "application/octet-stream",
  });
  return managedUpload<unknown>(`${base}/files/upload?${q.toString()}`, file, opts);
}

/** Upload a file onto a task as a host-stored attachment, keeping its path
 * under a picked or dropped folder (`relPath`, "Brief/maps/route.png"). A
 * DiskFile streams from disk in Rust (desktop); a File streams from the page
 * without being read into memory (web). */
export async function uploadTaskFile(
  taskId: number,
  file: File | DiskFile,
  relPath?: string,
  opts: UploadOptions = {}
): Promise<unknown> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const q = new URLSearchParams({
    task_id: String(taskId),
    file_name: file.name,
    file_type: (isDiskFile(file) ? guessContentType(file.name) : file.type) || "application/octet-stream",
  });
  if (relPath) q.set("rel_path", relPath);
  return managedUpload<unknown>(`${base}/files/upload?${q.toString()}`, file, opts, relPath || file.name);
}

/** Upload a file onto an event (host-stored, no project quota), keeping its
 * path under a picked or dropped folder. Admins only; streams like task files. */
export async function uploadEventFile(
  eventId: number,
  file: File | DiskFile,
  relPath?: string,
  opts: UploadOptions = {}
): Promise<unknown> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const q = new URLSearchParams({
    event_id: String(eventId),
    file_name: file.name,
    file_type: (isDiskFile(file) ? guessContentType(file.name) : file.type) || "application/octet-stream",
  });
  if (relPath) q.set("rel_path", relPath);
  return managedUpload<unknown>(`${base}/event-files/upload?${q.toString()}`, file, opts, relPath || file.name);
}

/** Save an event file via the browser/webview. */
export async function downloadEventFile(id: number, fileName: string): Promise<void> {
  await deliverDownload(`/event-files/${id}`, fileName);
}

/** Open an event file in the OS default app (download fallback off-desktop). */
export async function openEventFile(id: number, fileName: string): Promise<void> {
  await openDaemonFile(`/event-files/${id}`, fileName);
}

/** Fetch a shared attachment's bytes as a Blob, transport-aware: a thin client
 * (mobile/web) fetches /files/:id with auth; the desktop reads it locally via
 * Tauri. Used to render daemon-hosted images inline (auth can't ride an <img>). */
export async function getDaemonFileBlob(id: number): Promise<Blob> {
  // Route through the daemon's HTTP endpoint whenever one is reachable —
  // including a desktop talking to its own embedded loopback daemon. The HTTP
  // response now carries Content-Type, so the blob is typed correctly for <img>.
  // The Tauri invoke path is a fallback for the rare no-daemon-yet window
  // (early startup, before the loopback port is known).
  const base = effectiveBaseUrl();
  if (base) {
    const headers: Record<string, string> = {};
    const token = getDeviceToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await streamFetch(`${base}/files/${id}`, { headers }, 0);
    if (!res.ok) throw new DaemonError(`image ${res.status}`, res.status);
    return res.blob();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const [mime, bytes] = await invoke<[string, number[]]>("read_attachment_bytes", { attachmentId: id });
  return new Blob([new Uint8Array(bytes)], { type: mime });
}

/** Fetch a PROJECT file (uploaded via the Files tab / model-kit images) as a
 * typed Blob. Project files are served from /projects/files/:fid/download —
 * NOT /files/:id (that route is for task attachments). Using the wrong route
 * returns a 404, which surfaces as "cannot locate the file". */
export async function getProjectFileBlob(fileId: number): Promise<Blob> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await streamFetch(`${base}/projects/files/${fileId}/download`, { headers }, 0);
  if (!res.ok) throw new DaemonError(`project file ${res.status}`, res.status);
  return res.blob();
}

/** What a (re)connect of the pulse stream means for the caller. */
export interface PulseOpen {
  /** A reconnect (not this subscription's first connect). */
  resumed: boolean;
  /** Pulses may have been missed while disconnected — refetch. False only
   * when the host's `hello` id equals the last pulse id we saw (nothing
   * happened in between); older hosts send no ids → always true. */
  missed: boolean;
}

/** Freshness push (G3): subscribe to the host's coarse "something changed"
 * pulses (entity kind / command name, never payloads). Returns an unsubscribe.
 * EventSource can't set headers, so auth rides the query — hex token, URL-safe,
 * honoured by the server only on this non-mutating stream and downloads.
 * EventSource auto-reconnects; `onOpen` fires on every (re)connect with
 * whether anything may have been missed — the host ends the stream every
 * ~10 min to re-check the token, and refetching everything on each of those
 * routine reconnects is what made the UI flash. */
export function subscribeDataPulse(
  onPulse: (what: string) => void,
  onOpen?: (info: PulseOpen) => void,
  // K2 Stage C: an EXPLICIT host so the desktop can hold one stream per
  // workspace. Omitted → the active-transport globals (mobile/web single-host).
  source?: { url: string | null; token: string | null }
): () => void {
  let es: EventSource | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // The last pulse id seen on this subscription (`epoch:seq` from the host).
  let lastId: string | null = null;
  let opened = false;
  const opening = (helloId: string | null) => {
    const resumed = opened;
    opened = true;
    const missed = !resumed || !helloId || helloId !== lastId;
    if (helloId) lastId = helloId;
    onOpen?.({ resumed, missed });
  };
  const scheduleReconnect = (ms: number) => {
    if (!closed) retry = setTimeout(connect, ms);
  };

  // A built/dev desktop app talking to a REMOTE host can't use EventSource: it's
  // a webview GET to a remote http origin, which WKWebView blocks as mixed
  // content (same wall as fetch). Stream the SSE pulses through the Rust
  // transport instead and parse them by hand. The server ends the stream every
  // ~10min to re-auth, so a clean end just reconnects.
  const connectViaRust = async (base: string, token: string | null) => {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await streamFetch(`${base}/events/stream`, { headers }, 0);
    } catch {
      scheduleReconnect(5_000);
      return;
    }
    if (closed) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    if (!res.ok || !res.body) {
      scheduleReconnect(res.status === 401 ? 30_000 : 5_000);
      return;
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let event = "message";
    let data = "";
    let id: string | null = null;
    let greeted = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") {
            if (event === "hello") {
              greeted = true;
              opening(id);
            } else if (event === "changed") {
              if (!greeted) {
                greeted = true; // an older host without hello: count as missed
                opening(null);
              }
              if (id) lastId = id;
              onPulse(data);
            }
            event = "message";
            data = "";
            id = null;
          } else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
        }
      }
    } catch {
      /* stream cancelled (unsubscribe) or dropped — reconnect below unless closed */
    }
    reader = null;
    scheduleReconnect(1_500);
  };

  // EventSource auto-reconnects only on DROPPED connections; a non-200
  // response (expired/revoked token, server mid-restart) fails it permanently.
  // Recreate on that terminal state — with a freshly-read token — so the
  // stream heals instead of dying silently for the rest of the session.
  const connect = () => {
    if (closed) return;
    const base = source ? (source.url ? normalizeBaseUrl(source.url) : null) : effectiveBaseUrl();
    if (!base) {
      retry = setTimeout(connect, 30_000); // URL may be set later (Sync → host)
      return;
    }
    const token = source ? source.token : getDeviceToken();
    if (shouldRouteThroughRust(base)) {
      void connectViaRust(base, token);
      return;
    }
    if (typeof EventSource === "undefined") return;
    es = new EventSource(`${base}/events/stream${token ? `?token=${token}` : ""}`);
    es.addEventListener("hello", (e) => opening((e as MessageEvent).lastEventId || null));
    es.addEventListener("changed", (e) => {
      const id = (e as MessageEvent).lastEventId;
      if (id) lastId = id;
      onPulse((e as MessageEvent).data);
    });
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        retry = setTimeout(connect, 30_000);
      }
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
    reader?.cancel().catch(() => {});
  };
}

/** Fetch a shared attachment (with auth) and save it via the browser/webview. */
export async function downloadSharedFile(id: number, fileName: string): Promise<void> {
  await deliverDownload(`/files/${id}`, fileName);
}

/** A file stored on the host against a project (not a task). Bytes live only on
 * the host — this row is host-only and never syncs to replicas. */
export interface ProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_type?: string | null;
  rel_path?: string | null;
  size_bytes: number;
  uploaded_by?: number | null;
  created_at: string;
  /** Whether the AI overview (the project's knowledge base) may index it. New files start out. */
  ai_included: boolean;
}

/** List a project's host-stored files (any member). */
export async function listProjectFiles(projectId: number): Promise<ProjectFile[]> {
  return await daemonFetch<ProjectFile[]>(`/projects/${projectId}/files`);
}

/** A shared task attachment, surfaced in a project's central file view. */
export interface ProjectAttachment {
  id: number;
  task_id: number;
  task_title: string;
  file_name: string;
  file_type?: string | null;
  storage_size: number;
  /** False = legacy local-path attachment (no host copy, not downloadable here). */
  is_shared?: boolean;
  /** Original local path — meaningful only on the machine that attached it. */
  file_path?: string;
  created_at: string;
  /** Whether the AI overview may index it. New files start out. */
  ai_included: boolean;
  /** Its path among the task's folders, file name included; null when loose. */
  rel_path?: string | null;
  /** Who attached it. */
  uploaded_by?: number | null;
}

/** List ALL task attachments across a project (host-stored and legacy local). */
export async function listProjectAttachments(projectId: number): Promise<ProjectAttachment[]> {
  return await daemonFetch<ProjectAttachment[]>(`/projects/${projectId}/attachments`);
}

/** Attended "save a webpage" (the interim before a render
 * sidecar): opens the dedicated capture window at `url`; the owner browses to
 * the exact page they want and presses Save; the rendered DOM (scripts
 * stripped, <base> injected) plus the body text arrive over the title-channel
 * transport as `page://message` chunks; both land in the project's Files under
 * pages/ — ready for a file.read node. Desktop-only, owner-driven, artifact
 * inert: the same acceptable-trust argument as attended replay. */
/** Inflate a base64'd gzip payload (the page-save transport compresses — the
 * title channel pays per character). Same engine on both ends, so if the
 * capture window could gzip, this window can gunzip. */
async function gunzipB64(b64: string): Promise<string> {
  if (!b64) return "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

export async function capturePageToProject(
  projectId: number,
  url: string,
  onStatus?: (s: string) => void
): Promise<ProjectFile[]> {
  if (!isTauri() || isMobilePlatform()) throw new DaemonError("Saving webpages needs the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  return await new Promise<ProjectFile[]>((resolve, reject) => {
    const bufs: Record<string, string[]> = { html: [], text: [] };
    let meta: { url?: string; title?: string; enc?: string } = {};
    let expectedBytes = 0;
    let receivedBytes = 0;
    let settled = false;
    let unlisten: (() => void) | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      fn();
    };

    void listen<Record<string, unknown>>("page://message", (e) => {
      const m = e.payload;
      const kind = m.kind as string;
      if (kind === "page_begin") {
        meta = { url: m.url as string, title: m.title as string, enc: m.enc as string };
        expectedBytes = (m.bytes as number) || 0;
        onStatus?.("Receiving page…");
      } else if (kind === "page_chunk") {
        const data = m.data as string;
        bufs[m.doc as string]?.push(data);
        receivedBytes += data.length;
        if (expectedBytes > 0) {
          const pct = Math.min(100, Math.round((receivedBytes / expectedBytes) * 100));
          onStatus?.(`Receiving page… ${pct}% (${Math.round(receivedBytes / 1024)} / ${Math.round(expectedBytes / 1024)} KB)`);
        }
      } else if (kind === "page_done") {
        finish(() => {
          void (async () => {
            try {
              onStatus?.("Uploading…");
              const slug = (meta.title || meta.url || url)
                .toLowerCase()
                .replace(/https?:\/\//, "")
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "page";
              const gz = meta.enc === "gz";
              const html = gz ? await gunzipB64(bufs.html.join("")) : bufs.html.join("");
              const text = gz ? await gunzipB64(bufs.text.join("")) : bufs.text.join("");
              const files: ProjectFile[] = [];
              files.push(
                await uploadProjectFile(
                  projectId,
                  new File([html], `${slug}.html`, { type: "text/html" }),
                  `pages/${slug}.html`
                )
              );
              if (text.trim()) {
                files.push(
                  await uploadProjectFile(
                    projectId,
                    new File([text], `${slug}.txt`, { type: "text/plain" }),
                    `pages/${slug}.txt`
                  )
                );
              }
              await invoke("page_capture_stop");
              resolve(files);
            } catch (err) {
              await invoke("page_capture_stop").catch(() => {});
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        });
      } else if (kind === "stopped") {
        finish(() => reject(new DaemonError("Page capture cancelled.")));
      }
    }).then((un) => {
      unlisten = un;
      // Window opens only once the listener is live — no missed chunks.
      invoke("page_capture_start", { url }).catch((e) =>
        finish(() => reject(new Error(typeof e === "string" ? e : "could not open the capture window")))
      );
    });
  });
}

/** A project's explicit folders (empty ones included — folders that contain
 * files are additionally derived from rel_paths by the browser UI). */
export async function listProjectFolders(projectId: number): Promise<string[]> {
  return await daemonFetch<string[]>(`/projects/${projectId}/folders`);
}

/** Create a (possibly empty) folder in a project's file browser. Idempotent. */
export async function createProjectFolder(projectId: number, relPath: string): Promise<void> {
  await daemonFetch(`/projects/${projectId}/folders`, {
    method: "POST",
    body: JSON.stringify({ rel_path: relPath }),
  });
}

/** Rename a project file (rel_path leaf tracks the new name server-side). */
export async function renameProjectFile(fileId: number, fileName: string): Promise<ProjectFile> {
  return await daemonFetch<ProjectFile>(`/projects/files/${fileId}`, {
    method: "PATCH",
    body: JSON.stringify({ file_name: fileName }),
  });
}

/** Move project files into a folder (`dir: ""` = back to the root). */
export async function moveProjectFiles(projectId: number, ids: number[], dir: string): Promise<void> {
  await daemonFetch(`/projects/${projectId}/files/move`, {
    method: "POST",
    body: JSON.stringify({ ids, dir }),
  });
}

/** Fetch a daemon file as a Blob (inline previews). Same auth as daemonFetch.
 * MUST use streamFetch, not transportFetch: the daemon_http Rust bridge
 * returns the body as a STRING, which UTF-8-mangles binary bytes — image
 * previews came back as broken placeholders on the desktop. streamFetch's
 * chunked byte channel is the binary-safe path (getProjectFileBlob's, i.e.
 * how My Models images already load). */
export async function daemonFetchBlob(urlPath: string, timeoutMs = 15000, signal?: AbortSignal): Promise<Blob> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await streamFetch(base + urlPath, { headers, signal }, timeoutMs);
  if (!res.ok) throw new DaemonError(`HTTP ${res.status}`);
  return await res.blob();
}

/** True when the data on screen genuinely lives on THIS machine — the active
 * daemon is a loopback (or we're in local transport with no daemon at all).
 * NOT the same as transport mode: an owner laptop runs "local" transport for
 * its own DB while every daemonFetch targets the remote host. */
export function servingFromThisMachine(): boolean {
  if (!isTauri() || isMobilePlatform()) return false;
  const cur = effectiveBaseUrl();
  if (!cur) return getTransportMode() === "local";
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(cur + "/");
}

/** Open the folder where this machine's file blobs live (host desktop only —
 * the "where did my 20 GB go" button). Gated on servingFromThisMachine(): on
 * a client of a remote host the store is remote and a local reveal would show
 * an unrelated (likely empty) folder — refuse instead of lying. */
export async function revealStorageFolder(): Promise<void> {
  if (!servingFromThisMachine()) {
    throw new DaemonError("The file store lives on the host — open this on the host machine.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = await invoke<{ data_dir: string }>("get_storage_paths");
  const { openPath } = await import("@tauri-apps/plugin-opener");
  // pf/ appears with the first stored file — fall back up the tree until
  // something exists.
  try {
    await openPath(`${paths.data_dir}/shared/pf`);
  } catch {
    try {
      await openPath(`${paths.data_dir}/shared`);
    } catch {
      await openPath(paths.data_dir);
    }
  }
}

/** Upload one file to a project's host store (raw body + metadata in the query).
 * `relPath` carries the path within a picked folder so the tree is preserved.
 * `file` is a File the page holds, or (desktop) a file on disk. */
export async function uploadProjectFile(
  projectId: number,
  file: File | DiskFile,
  relPath?: string,
  opts: UploadOptions = {}
): Promise<ProjectFile> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const q = new URLSearchParams({
    file_name: file.name,
    file_type: (isDiskFile(file) ? guessContentType(file.name) : file.type) || "application/octet-stream",
  });
  if (relPath) q.set("rel_path", relPath);
  return managedUpload<ProjectFile>(`${base}/projects/${projectId}/files/upload?${q.toString()}`, file, opts, relPath || file.name);
}

/** Delete a project file (member). */
export async function deleteProjectFile(fileId: number): Promise<void> {
  await daemonFetch<void>(`/projects/files/${fileId}`, { method: "DELETE" });
}

/** Delete a task attachment record (+ its host copy, if any). The uploader's
 * local original is untouched. */
export async function deleteSharedAttachment(attachmentId: number): Promise<void> {
  await daemonFetch<void>(`/files/${attachmentId}`, { method: "DELETE" });
}

/** Result of batch-pushing local attachments to the host. */
export interface ShareLocalSummary {
  shared: number;
  skipped_shared: number;
  failures: [string, string][];
}
/** Push every legacy local-path attachment of a project to the host. */
export async function pushLocalFiles(projectId: number): Promise<ShareLocalSummary> {
  return daemonFetch(`/projects/${projectId}/files/share-local`, { method: "POST" });
}
/** Push ONE local attachment to the host. */
export async function pushLocalFile(attachmentId: number): Promise<unknown> {
  return daemonFetch(`/files/${attachmentId}/share`, { method: "POST" });
}
/** Allocate a project file to a task (becomes a shared task attachment). */
export async function assignFileToTask(fileId: number, taskId: number): Promise<unknown> {
  return daemonFetch(`/projects/files/${fileId}/assign`, { method: "POST", body: JSON.stringify({ task_id: taskId }) });
}
/** Detach a shared attachment from its task back into a plain project file. */
export async function unassignAttachment(attachmentId: number): Promise<unknown> {
  return daemonFetch(`/files/${attachmentId}/unassign`, { method: "POST" });
}

/** A host-stored file whose bytes are gone from disk (found by the audit). */
export interface MissingFile {
  id: number;
  /** "project" = a Files-tab upload; "attachment" = a shared task attachment. */
  kind: "project" | "attachment";
  file_name: string;
  size_bytes: number;
}

/** Integrity audit: this project's host-stored files whose blobs are missing. */
export async function auditProjectFiles(projectId: number): Promise<MissingFile[]> {
  return daemonFetch(`/projects/${projectId}/files/audit`, { method: "GET" });
}

/** Remove every missing file the audit finds (project rows deleted; shared
 * attachments revert to unshared). Returns how many were cleared. */
export async function clearMissingFiles(projectId: number): Promise<{ cleared: number }> {
  return daemonFetch(`/projects/${projectId}/files/clear-missing`, { method: "POST" });
}

/** Raw-body POST of a file's bytes (the upload/restore transport). */
async function rawFilePost<T>(path: string, file: File): Promise<T> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const headers: Record<string, string> = {};
  const token = getDeviceToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await transportFetch(`${base}${path}`, { method: "POST", body: file, headers }, 0);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      /* non-JSON */
    }
    throw new DaemonError(msg, res.status);
  }
  return res.json();
}

/** Re-upload bytes for an existing project file — fixes a broken link found by
 * the audit; the file id (and every reference to it) is preserved. */
export async function restoreProjectFile(fileId: number, file: File): Promise<ProjectFile> {
  const q = new URLSearchParams({ file_type: file.type || "application/octet-stream" });
  return rawFilePost(`/projects/files/${fileId}/restore?${q.toString()}`, file);
}

/** Re-upload bytes for an existing shared task attachment (same id/task link). */
export async function restoreSharedFile(attachmentId: number, file: File): Promise<unknown> {
  return rawFilePost(`/files/${attachmentId}/restore`, file);
}

/** Fetch a project file's bytes (with auth) and save it via the browser/webview. */
/** Download a daemon file, with start/done feedback in the notification center.
 * Desktop/web: fetch (auth) → blob → <a download>. Mobile: the WebView can't
 * save a blob, so hand the URL (token in the query — hex, URL-safe) to the system
 * browser, which downloads it natively (and shows its own OS notification). */
/** Hand a Blob to the platform's downloader (desktop webview and browsers
 * alike honour <a download>). The ONE seam for "save these bytes as a file"
 * — report exports use it too. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deliverDownload(urlPath: string, fileName: string): Promise<void> {
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const token = getDeviceToken();
  const nid = notify({ kind: "progress", category: "system", title: `Downloading ${fileName}…` });
  try {
    if (isMobilePlatform()) {
      const sep = urlPath.includes("?") ? "&" : "?";
      const url = `${base}${urlPath}${sep}token=${token ?? ""}`;
      // Installed app (Tauri): hand the URL to the system browser, which saves it
      // natively. A plain mobile browser (the touch UI served over the tailnet)
      // has no Tauri runtime, so openUrl would throw — there, just navigate to the
      // Content-Disposition: attachment URL, which downloads natively.
      let opened = false;
      if (isTauri()) {
        try {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(url);
          opened = true;
        } catch {
          /* opener unavailable — fall through to a plain navigation */
        }
      }
      if (!opened) window.open(url, "_blank", "noopener");
      updateNotif(nid, { kind: "success", title: `Opening ${fileName}`, body: "Saving via your browser's downloads." });
      return;
    }
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await streamFetch(`${base}${urlPath}`, { headers }, 0);
    if (!res.ok) throw new DaemonError(`Could not download (HTTP ${res.status})`, res.status);
    const blob = await res.blob();
    downloadBlob(fileName, blob);
    updateNotif(nid, { kind: "success", title: `Downloaded ${fileName}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateNotif(nid, { kind: "error", title: "Download failed", body: `${fileName}: ${msg}` });
    if (isMobilePlatform()) alert(`Download failed: ${msg}`); // no notification UI on mobile
  }
}

export async function downloadProjectFile(fileId: number, fileName: string): Promise<void> {
  await deliverDownload(`/projects/files/${fileId}/download`, fileName);
}

/** Open a daemon file in the OS default app (desktop). Streams it to a temp file
 * host-side-in-Rust (auth handled there) then hands it to the system opener. On
 * mobile/web there's no default-app concept, so fall back to the native download.
 * Reuses the host (loopback → owner) vs remote (bearer) auth, like deliverDownload. */
async function openDaemonFile(urlPath: string, fileName: string): Promise<void> {
  if (!isTauri() || isMobilePlatform()) {
    await deliverDownload(urlPath, fileName);
    return;
  }
  const base = effectiveBaseUrl();
  if (!base) throw new DaemonError("Not connected to a daemon.");
  const nid = notify({ kind: "progress", category: "system", title: `Opening ${fileName}…` });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_remote_file", { baseUrl: base, token: getDeviceToken() ?? "", urlPath, fileName });
    updateNotif(nid, { kind: "success", title: `Opened ${fileName}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateNotif(nid, { kind: "error", title: "Couldn't open", body: `${fileName}: ${msg}` });
  }
}

/** Open a project shared file in the OS default app (download fallback off-desktop). */
export async function openProjectFile(fileId: number, fileName: string): Promise<void> {
  await openDaemonFile(`/projects/files/${fileId}/download`, fileName);
}

/** Open a task-attachment shared file in the OS default app. */
export async function openSharedFile(id: number, fileName: string): Promise<void> {
  await openDaemonFile(`/files/${id}`, fileName);
}

// Pure invite/pairing payload helpers live in invite.pure.ts (DOM/Tauri-free so
// they unit-test); re-exported here so the many `from './daemon'` importers are
// unaffected. probeHost stays below — it needs fetch.
export {
  isTailnetUrl,
  diagnoseUnreachable,
  enrollQr,
  inviteLink,
  parseEnrollPayload,
  parseInviteLink,
} from "./invite.pure";
export type { EnrollPayload } from "./invite.pure";

/** Open a URL in the system browser — installed app via the Tauri opener, plain
 * browser via window.open. Used for the Tailscale "accept the shared machine"
 * step (acceptance happens in the recipient's own browser, by their consent). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* opener unavailable — fall through to a plain navigation */
    }
  }
  window.open(url, "_blank", "noopener");
}

/** Quick unauthenticated reachability check of a host's `/health`. Returns
 * true only if the daemon actually answered; false on any timeout/network
 * error. Cheap preflight so a join can DIAGNOSE instead of hanging. */
export async function probeHost(url: string, timeoutMs = 6000): Promise<boolean> {
  const base = url.trim().replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await transportFetch(`${base}/health`, { signal: ctrl.signal }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Imported calendars (owner-only, host-served) -------------------------
// Fetching an external ICS feed can take longer than the default 8s, so the
// create/sync calls use a generous timeout.
const ICS_TIMEOUT_MS = 30000;

/** List the owner's imported-calendar subscriptions. */
export async function listCalendarSubscriptions(): Promise<CalendarSubscription[]> {
  return await daemonFetch<CalendarSubscription[]>("/calendar/subscriptions");
}

/** Add a subscription from an ICS/webcal URL; the host immediately pulls its events. */
export async function createCalendarSubscription(input: {
  name: string;
  url: string;
  color?: string | null;
}): Promise<{ subscription: CalendarSubscription; sync: CalendarSyncResult }> {
  return await daemonFetch(
    "/calendar/subscriptions",
    { method: "POST", body: JSON.stringify(input) },
    undefined,
    ICS_TIMEOUT_MS
  );
}

/** Re-fetch a subscription and upsert its events (preserving allocations). */
export async function syncCalendarSubscription(id: number): Promise<CalendarSyncResult> {
  return await daemonFetch(
    `/calendar/subscriptions/${id}/sync`,
    { method: "POST" },
    undefined,
    ICS_TIMEOUT_MS
  );
}

/** Delete a subscription; its imported events are kept (orphaned to native). */
export async function deleteCalendarSubscription(id: number): Promise<void> {
  await daemonFetch(`/calendar/subscriptions/${id}`, { method: "DELETE" });
}

// ---- Email (owner-managed IMAP accounts, host-served) ----------------------
// Ganban is a read-only IMAP client of the owner's existing mailbox: it syncs
// envelopes, the owner links threads to projects (publishing them to members +
// the RAG corpus), and agent drafts land in the mailbox's Drafts folder — it
// can never send. Talking to an IMAP server is slow, so test/sync calls use
// generous timeouts.
const IMAP_TIMEOUT_MS = 60000;

/** An owner-configured IMAP account. The password is write-only: the server
 * never serializes it back. */
export interface EmailAccount {
  id: number;
  label: string;
  host: string;
  port: number;
  username: string;
  /** Comma-separated folders to sync envelopes from. */
  folders: string;
  /** Where approved drafts are APPENDed ("" = auto-detect at sync). */
  drafts_folder: string;
  /** Envelope sync horizon in days. */
  horizon_days: number;
  enabled: boolean;
  last_sync_at?: string | null;
  last_result?: string | null;
  created_at: string;
}

/** A conversation in a synced mailbox. `project_id` set = linked to a project. */
export interface EmailThread {
  id: number;
  account_id: number;
  /** Stamped per request: from one of MY mailboxes (link/unlink/draft are mine to do). */
  is_mine?: boolean;
  thread_key: string;
  subject: string;
  last_date?: string | null;
  message_count: number;
  project_id?: number | null;
  created_at: string;
}

/** One message's envelope (+ body text once its thread is linked). */
export interface EmailMessage {
  id: number;
  account_id: number;
  thread_id: number;
  folder: string;
  uid: number;
  message_id: string;
  subject: string;
  from_addr: string;
  date?: string | null;
  /** Extracted text body — present only after the thread was linked. */
  body_text?: string | null;
  created_at: string;
}

/** Outcome of one account sync (`folders` is how many folders were scanned). */
export interface EmailSyncSummary {
  new_messages: number;
  folders: number;
  errors: string[];
}

/** Credentials for creating or testing an account (server defaults: port 993,
 * folders "INBOX", horizon 90 days, label = username). */
export interface EmailAccountInput {
  label?: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  folders?: string;
  horizon_days?: number;
  /** OAuth path: a completed sign-in to claim + the client that backs it. */
  oauth_flow_id?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
}

/** Start a Gmail (XOAUTH2) sign-in with the user's own Google OAuth client.
 * Returns the URL to open in a browser + a flow id to poll. */
export async function beginEmailOAuth(clientId: string, clientSecret?: string): Promise<{ flow_id: string; auth_url: string }> {
  return daemonFetch("/email/oauth/begin", {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
}

/** Poll a sign-in: { status: "pending" | "done" (with email) | "error" (with error) }. */
export async function pollEmailOAuth(flowId: string): Promise<{ status: "pending" | "done" | "error"; email?: string; error?: string }> {
  return daemonFetch(`/email/oauth/poll/${flowId}`, { method: "GET" });
}

/** Owner-only: list the configured IMAP accounts (passwords omitted). */
export async function listEmailAccounts(): Promise<EmailAccount[]> {
  return daemonFetch("/email/accounts", { method: "GET" });
}

/** Owner-only: add an IMAP account; the host starts syncing its envelopes. */
export async function createEmailAccount(input: EmailAccountInput): Promise<EmailAccount> {
  return daemonFetch("/email/accounts", { method: "POST", body: JSON.stringify(input) }, undefined, IMAP_TIMEOUT_MS);
}

/** Owner-only: probe credentials WITHOUT saving; returns the mailbox's folders. */
export async function testEmailAccount(input: EmailAccountInput): Promise<{ ok: boolean; folders: string[] }> {
  return daemonFetch("/email/accounts/test", { method: "POST", body: JSON.stringify(input) }, undefined, IMAP_TIMEOUT_MS);
}

/** Owner-only: enable/disable an account's background sync. */
export async function updateEmailAccount(id: number, patch: { enabled?: boolean }): Promise<void> {
  await daemonFetch<void>(`/email/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** Owner-only: remove an account (and its credentials) from the host. */
export async function deleteEmailAccount(id: number): Promise<void> {
  await daemonFetch<void>(`/email/accounts/${id}`, { method: "DELETE" });
}

/** Owner-only: sync an account's envelopes now (also runs periodically). */
export async function syncEmailAccount(id: number): Promise<EmailSyncSummary> {
  return daemonFetch(`/email/accounts/${id}/sync`, { method: "POST" }, undefined, IMAP_TIMEOUT_MS);
}

/** The caller's OWN mailbox threads not yet linked to any project (the link
 * browser) — each member sees their inbox, never anyone else's. */
export async function listUnlinkedEmailThreads(): Promise<EmailThread[]> {
  return daemonFetch("/email/threads/unlinked", { method: "GET" });
}

/** Owner-only: link a thread to a project (null = unlink). Linking publishes
 * it to that project's members and queues its bodies for fetching. */
export async function linkEmailThread(id: number, projectId: number | null): Promise<EmailThread> {
  return daemonFetch(`/email/threads/${id}/link`, { method: "POST", body: JSON.stringify({ project_id: projectId }) });
}

/** A thread's messages (member of its linked project, or owner). */
export async function listEmailThreadMessages(id: number): Promise<EmailMessage[]> {
  return daemonFetch(`/email/threads/${id}/messages`, { method: "GET" });
}

/** The threads linked to a project (any member). */
export async function listProjectEmailThreads(projectId: number): Promise<EmailThread[]> {
  return daemonFetch(`/projects/${projectId}/email/threads`, { method: "GET" });
}
