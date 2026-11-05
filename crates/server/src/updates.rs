//! Client updates from the host (ADR 0007, `docs/design/UPDATES.md`).
//!
//! `ops/update.sh` builds, signs and publishes the clients into `<APP_DIR>/client-builds/`
//! (`desktop/<target>-<arch>/` and `android/`, each with a `manifest.json`) and writes its
//! progress to `<APP_DIR>/update-status.json` and `<LOGS>/update.log`. This module reads those:
//! the `/updates/…` routes the Tauri updater and the phone download from, `get_client_builds`,
//! and the owner's `start_host_update` / `get_host_update_status`.
//!
//! The update itself runs as its own launchd job (`com.ganban.updater`), never as a child of
//! the server, because it restarts the server.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Request};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use ganban_core::error::AppError;
use serde::Deserialize;
use serde_json::{json, Value};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::AuthDownload;

/// The launchd job that runs `ops/update.sh` (installed by `ops/install.sh`).
pub const UPDATER_LABEL: &str = "com.ganban.updater";
/// How many lines of the update log `get_host_update_status` returns.
const LOG_LINES: usize = 200;
/// The most of the log read for that tail.
const LOG_TAIL_BYTES: u64 = 256 * 1024;
/// How long a status the server wrote ("starting", no pid yet) counts as running before
/// `ops/update.sh` takes it over.
const START_GRACE_SECS: i64 = 90;
/// How many lines of the updater job's own launchd log a stalled update shows.
const LAUNCHD_LOG_LINES: usize = 40;
/// What `GANBAN_CLIENT_BUILDS` may say (`ops/install.sh` refuses anything else).
const CLIENT_BUILDS: [&str; 5] = ["none", "desktop", "android", "desktop,android", "android,desktop"];

/// Where the update machinery lives on this host. Resolved once from the environment
/// (the LaunchAgents set `GANBAN_APP_DIR` and `GANBAN_LOGS`); tests pass their own, in a
/// request extension or through `Ctx::with_update_paths`.
#[derive(Clone, Debug)]
pub struct UpdatePaths {
    pub app_dir: PathBuf,
    pub logs: PathBuf,
    /// `launchctl`, overridable (`LAUNCHCTL`) like `ops/` does, for tests.
    pub launchctl: PathBuf,
}

impl UpdatePaths {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let app_dir = var("GANBAN_APP_DIR")
            .or_else(|| var("GANBAN_DB").and_then(|db| db.parent().map(Path::to_path_buf)))
            .or_else(|| dirs::data_dir().map(|d| d.join("com.scs.gansty")))
            .unwrap_or_else(|| PathBuf::from("."));
        let logs = var("GANBAN_LOGS")
            .or_else(|| dirs::home_dir().map(|h| h.join("Library/Logs/ganban")))
            .unwrap_or_else(|| app_dir.join("logs"));
        let launchctl = var("LAUNCHCTL").unwrap_or_else(|| PathBuf::from("/bin/launchctl"));
        UpdatePaths { app_dir, logs, launchctl }
    }

    fn builds(&self) -> PathBuf {
        self.app_dir.join("client-builds")
    }

    fn status_file(&self) -> PathBuf {
        self.app_dir.join("update-status.json")
    }

    fn log_file(&self) -> PathBuf {
        self.logs.join("update.log")
    }

    /// The updater job's stdout and stderr (`StandardOutPath` in its plist): what
    /// `ops/update.sh` printed before its own log began, or why it never ran.
    fn launchd_log_file(&self) -> PathBuf {
        self.logs.join("updater.out.log")
    }

    fn install_env(&self) -> PathBuf {
        self.app_dir.join("install.env")
    }
}

/// This process's paths, from the environment.
pub(crate) fn shared() -> Arc<UpdatePaths> {
    static PATHS: OnceLock<Arc<UpdatePaths>> = OnceLock::new();
    PATHS.get_or_init(|| Arc::new(UpdatePaths::from_env())).clone()
}

// ============== Versions ==============

/// `0.5.975` → `[0, 5, 975]`; a pre-release or build suffix is ignored. `None` when it
/// isn't a dotted number.
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let parts: Option<Vec<u64>> = core.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty() && p.len() <= 4)
}

/// Whether `build` is newer than the client's `current`. A client whose version can't be
/// read is offered the build: the host's build is the one to run.
pub fn is_newer(build: &str, current: &str) -> bool {
    match (parse_version(build), parse_version(current)) {
        (Some(mut b), Some(mut c)) => {
            let n = b.len().max(c.len());
            b.resize(n, 0);
            c.resize(n, 0);
            b > c
        }
        (Some(_), None) => true,
        (None, _) => false,
    }
}

// ============== Builds on disk ==============

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DesktopManifest {
    version: String,
    target: String,
    arch: String,
    pub_date: String,
    /// The `.app.tar.gz`, beside the manifest.
    file: String,
    /// The minisign signature (the `.sig` file's text).
    signature: String,
    #[serde(default)]
    notes: Option<String>,
    /// The updater public key the bundle was signed for (manifests from before run-time
    /// update sources have none; the host's `keys/updater.key.pub` stands in).
    #[serde(default)]
    pubkey: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AndroidManifest {
    version: String,
    version_code: u64,
    pub_date: String,
    file: String,
    sha256: String,
    /// The SHA-256 of the APK's signing certificate (hex, colons allowed), when the build knew it.
    #[serde(default)]
    cert_sha256: Option<String>,
}

/// A certificate fingerprint as 64 lowercase hex digits, or none.
fn cert_hex(s: &str) -> Option<String> {
    let hex: String = s.chars().filter(|c| !matches!(c, ':' | ' ')).collect::<String>().to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

/// The host's updater public key: the build's own word, else `<APP_DIR>/keys/updater.key.pub`.
fn updater_pubkey(paths: &UpdatePaths, from_manifest: Option<&str>) -> Option<String> {
    let k = from_manifest
        .map(str::to_string)
        .or_else(|| std::fs::read_to_string(paths.app_dir.join("keys/updater.key.pub")).ok())?;
    let k = k.trim();
    (!k.is_empty() && k.len() <= 1024).then(|| k.to_string())
}

/// A Tauri `{{target}}` or `{{arch}}`: `darwin`, `aarch64`, `x86_64`. Nothing that could
/// leave the builds folder.
fn plain_word(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A file name a manifest may point at: inside its own folder, not hidden.
fn plain_file(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('.') && !s.contains(['/', '\\', '\0'])
}

/// A published build: its manifest, the file it names, and that file's size.
struct Published<M> {
    manifest: M,
    file: PathBuf,
    size: u64,
}

fn read_published<M: serde::de::DeserializeOwned>(dir: &Path, file_of: impl Fn(&M) -> &str) -> Option<Published<M>> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let manifest: M = serde_json::from_str(&text).ok()?;
    let name = file_of(&manifest);
    if !plain_file(name) {
        return None;
    }
    let file = dir.join(name);
    let size = std::fs::metadata(&file).ok().filter(|m| m.is_file())?.len();
    Some(Published { manifest, file, size })
}

fn desktop_build(paths: &UpdatePaths, target: &str, arch: &str) -> Option<Published<DesktopManifest>> {
    if !plain_word(target) || !plain_word(arch) {
        return None;
    }
    let dir = paths.builds().join("desktop").join(format!("{target}-{arch}"));
    read_published(&dir, |m: &DesktopManifest| &m.file)
}

/// The first desktop build published (the host builds for its own target only).
fn any_desktop_build(paths: &UpdatePaths) -> Option<Published<DesktopManifest>> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(paths.builds().join("desktop")).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.iter().find_map(|d| {
        let name = d.file_name()?.to_str()?;
        let (target, arch) = name.split_once('-')?;
        desktop_build(paths, target, arch)
    })
}

fn android_build(paths: &UpdatePaths) -> Option<Published<AndroidManifest>> {
    read_published(&paths.builds().join("android"), |m: &AndroidManifest| &m.file)
}

/// `get_client_builds`: what the host offers, for Settings → Updates and the phone's check.
/// `target`/`arch` pick a desktop build; without them, the one the host built. Each build says
/// what signed it, so a device can choose this host as its update source: the desktop's updater
/// public key (`pubkey`, which the app pins) and the APK's certificate (`certSha256`, which the
/// phone compares with its own signature).
pub(crate) fn client_builds(paths: &UpdatePaths, target: Option<&str>, arch: Option<&str>) -> Value {
    let desktop = match (target, arch) {
        (Some(t), Some(a)) => desktop_build(paths, t, a),
        _ => any_desktop_build(paths),
    };
    let desktop = desktop.map(|b| {
        let m = b.manifest;
        let pubkey = updater_pubkey(paths, m.pubkey.as_deref());
        json!({ "version": m.version, "target": m.target, "arch": m.arch, "pubDate": m.pub_date, "size": b.size, "pubkey": pubkey })
    });
    let android = android_build(paths).map(|b| {
        let m = b.manifest;
        let cert = m.cert_sha256.as_deref().and_then(cert_hex);
        json!({ "version": m.version, "versionCode": m.version_code, "pubDate": m.pub_date, "size": b.size, "sha256": m.sha256, "certSha256": cert })
    });
    json!({ "desktop": desktop, "android": android })
}

// ============== Routes ==============

fn paths_of(req: &Request) -> Arc<UpdatePaths> {
    req.extensions().get::<Arc<UpdatePaths>>().cloned().unwrap_or_else(shared)
}

/// Stream a file with Range support (`ServeFile` answers 206/416 and HEAD).
async fn serve_file(path: &Path, mime: &'static str, download_name: &str, req: Request) -> Response {
    let mut res = match ServeFile::new(path).oneshot(req).await {
        Ok(res) => res.map(Body::new),
        Err(never) => match never {},
    };
    if res.status().is_success() {
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
        let name: String = download_name.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
            res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    res
}

/// The base URL the client reached us at, for the updater's absolute `url`.
fn base_url(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let ok = !host.is_empty()
        && host.len() <= 255
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b));
    if !ok {
        return None;
    }
    let https = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    Some(format!("{}://{host}", if https { "https" } else { "http" }))
}

/// `GET /updates/desktop/:target/:arch/:current_version` (the Tauri updater's check: `200`
/// with the build when it's newer, else `204`) and `GET /updates/desktop/:target/:arch/bundle`
/// (the signed `.app.tar.gz`, with Range). One route: the last segment tells them apart.
pub(crate) async fn desktop_route(
    AuthDownload(_user): AuthDownload,
    UrlPath((target, arch, last)): UrlPath<(String, String, String)>,
    req: Request,
) -> Response {
    let paths = paths_of(&req);
    let Some(build) = desktop_build(&paths, &target, &arch) else {
        if last == "bundle" {
            return (StatusCode::NOT_FOUND, "no desktop build for this platform").into_response();
        }
        return StatusCode::NO_CONTENT.into_response();
    };
    if last == "bundle" {
        let name = build.manifest.file.clone();
        return serve_file(&build.file, "application/gzip", &name, req).await;
    }
    if !is_newer(&build.manifest.version, &last) {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Some(base) = base_url(req.headers()) else {
        return (StatusCode::BAD_REQUEST, "no usable Host header").into_response();
    };
    let m = build.manifest;
    let notes = m.notes.unwrap_or_else(|| format!("Ganban {}, built on the host.", m.version));
    axum::Json(json!({
        "version": m.version,
        "notes": notes,
        "pub_date": m.pub_date,
        "url": format!("{base}/updates/desktop/{target}/{arch}/bundle"),
        "signature": m.signature,
    }))
    .into_response()
}

/// `GET /updates/android/apk`: the release APK, with Range.
pub(crate) async fn android_apk_route(AuthDownload(_user): AuthDownload, req: Request) -> Response {
    let paths = paths_of(&req);
    let Some(build) = android_build(&paths) else {
        return (StatusCode::NOT_FOUND, "no Android build on this host").into_response();
    };
    let name = format!("Ganban-{}.apk", build.manifest.version);
    serve_file(&build.file, "application/vnd.android.package-archive", &name, req).await
}

// ============== Host update ==============

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

/// Whether this pid is a live `ops/update.sh` (as the script itself checks): after a crash or a
/// reboot the pid may belong to some other process, which must not hold the status at "running".
fn pid_alive(pid: i64) -> bool {
    pid > 0
        && std::process::Command::new("/bin/ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .output()
            .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("update.sh"))
}

fn read_status(paths: &UpdatePaths) -> Value {
    std::fs::read_to_string(paths.status_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "state": "idle" }))
}

/// Whether the status says an update is under way that is still alive: `ops/update.sh`'s
/// pid lives, or the server just started it and the script hasn't taken over yet.
fn is_running(status: &Value) -> bool {
    if status["state"] != "running" {
        return false;
    }
    match status["pid"].as_i64() {
        Some(pid) => pid_alive(pid),
        None => status["startedAt"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| (now() - t.with_timezone(&chrono::Utc)).num_seconds() < START_GRACE_SECS),
    }
}

/// The last `max_lines` lines of a log, from `from` on (the offset this run started at).
fn log_tail(file: &Path, from: u64, max_lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = if from > len { 0 } else { from };
    let start = from.max(len.saturating_sub(LOG_TAIL_BYTES));
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.take(LOG_TAIL_BYTES).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = strip_ansi(&String::from_utf8_lossy(&buf));
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}

/// The log without terminal escapes (`update.sh` prints its steps in bold).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Which clients `ops/update.sh` builds: `GANBAN_CLIENT_BUILDS` in `<APP_DIR>/install.env`,
/// where `ops/install.sh` keeps it (the updater job's environment doesn't set it, so that file
/// is what `update.sh` reads). `desktop,android` when the file doesn't say; `None` without an
/// install.env (no service here) or with a value `install.sh` would refuse.
fn client_builds_setting(paths: &UpdatePaths) -> Option<String> {
    let text = std::fs::read_to_string(paths.install_env()).ok()?;
    let value = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("GANBAN_CLIENT_BUILDS="))
        .next_back()
        .map(|v| v.trim().trim_matches(['\'', '"']).to_string());
    match value {
        None => Some("desktop,android".into()),
        Some(v) if v.is_empty() => Some("desktop,android".into()),
        Some(v) => CLIENT_BUILDS.contains(&v.as_str()).then_some(v),
    }
}

/// The status file and the log, as the card reads them (no launchd).
fn status_from_files(paths: &UpdatePaths) -> (Value, bool) {
    let s = read_status(paths);
    let mut state = s["state"].as_str().unwrap_or("idle").to_string();
    let mut step = s["step"].clone();
    let stalled = state == "running" && !is_running(&s);
    if stalled {
        // A crash, a reboot or a kill: the script never wrote its end. Without a pid, the
        // script never wrote at all: launchd didn't start it, or it died on its first line.
        let at = s["step"].as_str().unwrap_or("starting");
        step = json!(if s["pid"].as_i64().is_some() {
            format!("{at} (the update stopped without finishing)")
        } else {
            format!("{at} (the update didn't start: ops/update.sh never reported in)")
        });
        state = "failed".into();
    }
    let client = |k: &str| s["clients"][k].as_str().unwrap_or("").to_string();
    let v = json!({
        "state": state,
        "step": step,
        "startedAt": s["startedAt"],
        "finishedAt": s["finishedAt"],
        "fromBuild": s["fromBuild"],
        "toBuild": s["toBuild"],
        "clients": { "desktop": client("desktop"), "android": client("android") },
        "clientBuilds": client_builds_setting(paths),
        "log": log_tail(&paths.log_file(), s["logOffset"].as_u64().unwrap_or(0), LOG_LINES),
    });
    (v, stalled)
}

/// `last exit code = 78: EX_CONFIG` in `launchctl print`'s output → `78: EX_CONFIG`; `None`
/// when the job never exited (or the line isn't there).
fn last_exit_code(print: &str) -> Option<String> {
    let v = print.lines().find_map(|l| l.trim().strip_prefix("last exit code"))?.trim_start().strip_prefix('=')?.trim();
    (!v.is_empty() && !v.starts_with('(')).then(|| v.to_string())
}

/// This user's id, for launchd's `gui/<uid>` domain.
async fn uid() -> Result<String, AppError> {
    static UID: OnceLock<String> = OnceLock::new();
    if let Some(u) = UID.get() {
        return Ok(u.clone());
    }
    let out = run(Path::new("/usr/bin/id"), &["-u"]).await?;
    let u = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if u.is_empty() || !u.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput("could not tell this user's id".into()));
    }
    Ok(UID.get_or_init(|| u).clone())
}

/// `launchctl print` for the updater job: `None` when it isn't installed (or launchctl
/// can't be run), else what it printed.
async fn updater_job(paths: &UpdatePaths) -> Option<String> {
    let job = format!("gui/{}/{UPDATER_LABEL}", uid().await.ok()?);
    let out = run(&paths.launchctl, &["print", &job]).await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `get_host_update_status`: the brief's shape, from the status file and the log, plus
/// whether the updater job is installed and which clients this host builds. When an update
/// stopped without finishing, `launchd` says what launchd saw: the job's last exit code and
/// the tail of its own log, where a script that died before its first write still printed why.
pub(crate) async fn host_update_status(paths: &UpdatePaths) -> Value {
    let (mut v, stalled) = status_from_files(paths);
    let launchd_offset = read_status(paths)["launchdLogOffset"].as_u64().unwrap_or(0);
    let job = updater_job(paths).await;
    v["updaterInstalled"] = json!(job.is_some());
    v["launchd"] = if stalled {
        json!({
            "lastExitCode": job.as_deref().and_then(last_exit_code),
            // This run's part only (from where the server or the script found it), so an
            // older run's error isn't blamed on this one.
            "log": log_tail(&paths.launchd_log_file(), launchd_offset, LAUNCHD_LOG_LINES),
        })
    } else {
        Value::Null
    };
    v
}

fn write_status(paths: &UpdatePaths, status: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(&paths.app_dir)?;
    let tmp = paths.app_dir.join(format!(".update-status.json.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(status).unwrap_or_default())?;
    std::fs::rename(&tmp, paths.status_file())
}

async fn run(program: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(20), child).await {
        Ok(out) => out.map_err(|e| AppError::InvalidInput(format!("{}: {e}", program.display()))),
        Err(_) => Err(AppError::InvalidInput(format!("{} timed out", program.display()))),
    }
}

/// `start_host_update` (owner only): kickstart the `com.ganban.updater` job. It refuses while
/// an update runs. The server marks the status as starting first, so a second click (or a
/// poll that comes before the script's first write) already sees it running.
pub(crate) async fn start_host_update(paths: &UpdatePaths) -> Result<Value, AppError> {
    // Check-then-start under one lock, so two clicks can't both pass the check.
    static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_at_a_time = STARTING.lock().await;
    let current = read_status(paths);
    if is_running(&current) {
        return Err(AppError::InvalidInput(format!(
            "an update is already running ({})",
            current["step"].as_str().unwrap_or("starting")
        )));
    }
    let job = format!("gui/{}/{UPDATER_LABEL}", uid().await?);
    if !run(&paths.launchctl, &["print", &job]).await?.status.success() {
        return Err(AppError::InvalidInput(format!(
            "{UPDATER_LABEL} isn't installed on the host: run ops/install.sh there once"
        )));
    }
    let log_offset = std::fs::metadata(paths.log_file()).map(|m| m.len()).unwrap_or(0);
    let launchd_log_offset = std::fs::metadata(paths.launchd_log_file()).map(|m| m.len()).unwrap_or(0);
    let starting = json!({
        "state": "running",
        "step": "starting",
        "startedAt": now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "finishedAt": null,
        "fromBuild": env!("GANBAN_SERVER_BUILD"),
        "toBuild": null,
        "clients": { "desktop": "", "android": "" },
        "logOffset": log_offset,
        "launchdLogOffset": launchd_log_offset,
    });
    write_status(paths, &starting)?;
    // No -k: launchd runs one instance of a job, so a kickstart can't start a second one.
    let out = run(&paths.launchctl, &["kickstart", &job]).await?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        write_status(paths, &json!({ "state": "failed", "step": format!("starting: launchctl kickstart failed: {why}"), "startedAt": starting["startedAt"], "finishedAt": starting["startedAt"], "fromBuild": starting["fromBuild"], "toBuild": null, "clients": starting["clients"], "logOffset": log_offset }))?;
        return Err(AppError::InvalidInput(format!("launchctl kickstart {job} failed: {why}")));
    }
    tracing::info!("host update started ({job})");
    Ok(host_update_status(paths).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.5.975", "0.5.1"));
        assert!(is_newer("0.5.975", "0.5.974"));
        assert!(is_newer("0.5.1000", "0.5.999"), "not as strings");
        assert!(!is_newer("0.5.975", "0.5.975"));
        assert!(!is_newer("0.5.975", "0.5.976"));
        assert!(!is_newer("0.5.975", "0.6.0"));
        assert!(!is_newer("0.5.975", "0.5.975-beta"), "a suffix doesn't make it older");
        assert!(is_newer("0.5.975", "garbage"), "an unreadable client version is offered the build");
        assert!(!is_newer("garbage", "0.5.1"), "an unreadable build is never offered");
    }

    #[test]
    fn names_stay_inside_the_builds_folder() {
        assert!(plain_word("darwin") && plain_word("aarch64") && plain_word("x86_64"));
        for bad in ["", "..", "a/b", "Darwin", "a.b", "a-b"] {
            assert!(!plain_word(bad), "{bad}");
        }
        assert!(plain_file("Ganban.app.tar.gz"));
        for bad in ["", ".hidden", "../x", "a/b", "a\\b"] {
            assert!(!plain_file(bad), "{bad}");
        }
    }

    /// A host's app folder with published builds, and a fake launchctl that logs its calls
    /// (`print` fails when `installed` is false).
    pub(crate) struct Fixture {
        pub(crate) dir: PathBuf,
        pub(crate) paths: UpdatePaths,
    }

    impl Fixture {
        pub(crate) fn new(tag: &str, installed: bool) -> Self {
            let dir = std::env::temp_dir().join(format!("ganban_updates_{}_{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let desk = dir.join("app/client-builds/desktop/darwin-aarch64");
            let droid = dir.join("app/client-builds/android");
            std::fs::create_dir_all(&desk).unwrap();
            std::fs::create_dir_all(&droid).unwrap();
            std::fs::create_dir_all(dir.join("logs")).unwrap();
            std::fs::write(desk.join("Ganban_0.5.975.app.tar.gz"), b"0123456789").unwrap();
            std::fs::write(
                desk.join("manifest.json"),
                json!({ "version": "0.5.975", "target": "darwin", "arch": "aarch64", "pubDate": "2026-11-02T10:00:00Z",
                        "file": "Ganban_0.5.975.app.tar.gz", "signature": "SIG", "commit": "abc1234" })
                .to_string(),
            )
            .unwrap();
            std::fs::write(droid.join("Ganban_0.5.975.apk"), b"APKBYTES").unwrap();
            std::fs::write(
                droid.join("manifest.json"),
                json!({ "version": "0.5.975", "versionCode": 500975, "pubDate": "2026-11-02T10:00:00Z",
                        "file": "Ganban_0.5.975.apk", "sha256": "abc" })
                .to_string(),
            )
            .unwrap();
            let launchctl = dir.join("launchctl");
            let print = if installed { "exit 0" } else { "exit 113" };
            std::fs::write(
                &launchctl,
                format!("#!/bin/bash\nd=\"$(dirname \"$0\")\"\necho \"$*\" >> \"$d/launchctl.log\"\n[ \"$1\" = print ] && {{ cat \"$d/print.txt\" 2>/dev/null; {print}; }}\nexit 0\n"),
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&launchctl, std::fs::Permissions::from_mode(0o755)).unwrap();
            let paths = UpdatePaths { app_dir: dir.join("app"), logs: dir.join("logs"), launchctl };
            Fixture { dir, paths }
        }

        pub(crate) fn launchctl_log(&self) -> String {
            std::fs::read_to_string(self.dir.join("launchctl.log")).unwrap_or_default()
        }
    }

    #[test]
    fn client_builds_reads_the_manifests() {
        let f = Fixture::new("builds", true);
        let v = client_builds(&f.paths, None, None);
        assert_eq!(v["desktop"]["version"], "0.5.975");
        assert_eq!(v["desktop"]["target"], "darwin");
        assert_eq!(v["desktop"]["size"], 10, "the file's size, not the manifest's word");
        assert_eq!(v["android"]["versionCode"], 500975);
        assert_eq!(v["android"]["sha256"], "abc");
        assert_eq!(client_builds(&f.paths, Some("windows"), Some("x86_64"))["desktop"], Value::Null);
        // What signed the builds: unknown on old manifests without a key file.
        assert_eq!(v["desktop"]["pubkey"], Value::Null);
        assert_eq!(v["android"]["certSha256"], Value::Null);
        // A manifest naming a file outside its folder publishes nothing.
        let m = f.paths.builds().join("android/manifest.json");
        std::fs::write(&m, json!({ "version": "1", "versionCode": 1, "pubDate": "", "file": "../../update-status.json", "sha256": "" }).to_string()).unwrap();
        assert_eq!(client_builds(&f.paths, None, None)["android"], Value::Null);
    }

    #[test]
    fn client_builds_say_what_signed_them() {
        let f = Fixture::new("signers", true);
        // An old manifest: the host's key file stands in for the desktop's key.
        std::fs::create_dir_all(f.paths.app_dir.join("keys")).unwrap();
        std::fs::write(f.paths.app_dir.join("keys/updater.key.pub"), "HOSTKEY\n").unwrap();
        assert_eq!(client_builds(&f.paths, None, None)["desktop"]["pubkey"], "HOSTKEY");
        // The manifest's own key wins: it's the one the bundle was signed for.
        let desk = f.paths.builds().join("desktop/darwin-aarch64/manifest.json");
        let mut m: Value = serde_json::from_str(&std::fs::read_to_string(&desk).unwrap()).unwrap();
        m["pubkey"] = json!("SIGNEDWITH");
        std::fs::write(&desk, m.to_string()).unwrap();
        assert_eq!(client_builds(&f.paths, None, None)["desktop"]["pubkey"], "SIGNEDWITH");
        // keytool's colon form becomes plain lowercase hex; anything else is unknown.
        let droid = f.paths.builds().join("android/manifest.json");
        let mut m: Value = serde_json::from_str(&std::fs::read_to_string(&droid).unwrap()).unwrap();
        let colons = (0..32).map(|i| format!("{:02X}", i * 7 % 256)).collect::<Vec<_>>().join(":");
        m["certSha256"] = json!(colons);
        std::fs::write(&droid, m.to_string()).unwrap();
        let hex = client_builds(&f.paths, None, None)["android"]["certSha256"].as_str().unwrap().to_string();
        assert_eq!(hex, colons.replace(':', "").to_lowercase());
        m["certSha256"] = json!("not a fingerprint");
        std::fs::write(&droid, m.to_string()).unwrap();
        assert_eq!(client_builds(&f.paths, None, None)["android"]["certSha256"], Value::Null);
    }

    #[tokio::test]
    async fn host_update_is_the_owners_and_runs_once() {
        use crate::commands::testkit::*;
        let db = test_db("host_update").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "admin")]).await;
        let f = Fixture::new("start", true);
        let as_ = |who| crate::commands::Ctx::http(&db, who).with_update_paths(&f.paths);

        // Members read the builds, but never start or watch an update.
        let builds = crate::commands::run(&as_(mia), "get_client_builds", json!({})).await.unwrap();
        assert_eq!(builds["android"]["versionCode"], 500975);
        assert!(builds["desktop"].get("pubkey").is_some() && builds["android"].get("certSha256").is_some(), "{builds}");
        for cmd in ["start_host_update", "get_host_update_status"] {
            assert!(crate::commands::run(&as_(mia), cmd, json!({})).await.unwrap_err().is_forbidden(), "{cmd}");
        }
        assert!(f.launchctl_log().is_empty(), "a member's refused call runs nothing");

        let idle = crate::commands::run(&as_(owner), "get_host_update_status", json!({})).await.unwrap();
        assert_eq!(idle["state"], "idle");
        let started = crate::commands::run(&as_(owner), "start_host_update", json!({})).await.unwrap();
        assert_eq!(started["state"], "running");
        assert_eq!(started["step"], "starting");
        let log = f.launchctl_log();
        assert!(log.contains("kickstart gui/") && log.contains("/com.ganban.updater"), "{log}");
        assert!(!log.contains("-k"), "never kills a running update: {log}");

        // While it runs (the server's own mark, then the script's live pid), a second start is refused.
        let again = crate::commands::run(&as_(owner), "start_host_update", json!({})).await.unwrap_err();
        assert!(again.is_invalid_input() && again.to_string().contains("already running"), "{again}");
        let mut other = std::process::Command::new("/bin/bash").args(["-c", "sleep 30; true", "update.sh"]).spawn().unwrap();
        let mut s = read_status(&f.paths);
        s["pid"] = json!(other.id());
        s["step"] = json!("checks: tsc");
        write_status(&f.paths, &s).unwrap();
        assert!(crate::commands::run(&as_(owner), "start_host_update", json!({})).await.unwrap_err().to_string().contains("checks: tsc"));

        // A pid that is alive but isn't update.sh (reused after a crash) doesn't hold it.
        other.kill().unwrap();
        let _ = other.wait();
        s["pid"] = json!(std::process::id());
        write_status(&f.paths, &s).unwrap();
        assert_eq!(host_update_status(&f.paths).await["state"], "failed", "a reused pid");
        // A crashed run (its pid gone) reads as failed, and a new one may start.
        s["pid"] = json!(999_999_999);
        write_status(&f.paths, &s).unwrap();
        let st = host_update_status(&f.paths).await;
        assert_eq!(st["state"], "failed");
        assert!(st["step"].as_str().unwrap().contains("stopped without finishing"), "{st}");
        crate::commands::run(&as_(owner), "start_host_update", json!({})).await.unwrap();
    }

    #[tokio::test]
    async fn host_update_says_when_the_updater_is_not_installed() {
        let f = Fixture::new("not_installed", false);
        let e = start_host_update(&f.paths).await.unwrap_err();
        assert!(e.to_string().contains("ops/install.sh"), "{e}");
        assert!(!f.launchctl_log().contains("kickstart"));
        assert_eq!(host_update_status(&f.paths).await["state"], "idle", "nothing marked as running");
    }

    #[tokio::test]
    async fn status_says_whether_the_updater_is_installed() {
        let yes = Fixture::new("installed_yes", true);
        assert_eq!(host_update_status(&yes.paths).await["updaterInstalled"], true);
        let no = Fixture::new("installed_no", false);
        let s = host_update_status(&no.paths).await;
        assert_eq!(s["updaterInstalled"], false);
        assert_eq!(s["launchd"], Value::Null, "nothing stalled, nothing from launchd");
    }

    #[tokio::test]
    async fn status_says_which_clients_the_host_builds() {
        let f = Fixture::new("client_builds", true);
        let env = f.paths.install_env();
        assert_eq!(host_update_status(&f.paths).await["clientBuilds"], Value::Null, "no install.env: unknown");
        std::fs::write(&env, "GANBAN_INSTALL_ADDR='0.0.0.0:8765'\n").unwrap();
        assert_eq!(host_update_status(&f.paths).await["clientBuilds"], "desktop,android", "update.sh's default");
        std::fs::write(&env, "GANBAN_INSTALL_ADDR='0.0.0.0:8765'\nGANBAN_CLIENT_BUILDS='none'\n").unwrap();
        assert_eq!(host_update_status(&f.paths).await["clientBuilds"], "none");
        std::fs::write(&env, "GANBAN_CLIENT_BUILDS='desktop'\nGANBAN_CLIENT_BUILDS=\"android\"\n").unwrap();
        assert_eq!(host_update_status(&f.paths).await["clientBuilds"], "android", "the last line wins, as when sourced");
        std::fs::write(&env, "GANBAN_CLIENT_BUILDS='ios'\n").unwrap();
        assert_eq!(host_update_status(&f.paths).await["clientBuilds"], Value::Null, "a value install.sh refuses");
    }

    #[test]
    fn last_exit_code_is_read_from_launchctl_print() {
        let print = "gui/501/com.ganban.updater = {\n\tactive count = 0\n\tstate = not running\n\truns = 3\n\tlast exit code = 78: EX_CONFIG\n}\n";
        assert_eq!(last_exit_code(print).as_deref(), Some("78: EX_CONFIG"));
        assert_eq!(last_exit_code("\tlast exit code = 1\n").as_deref(), Some("1"));
        assert_eq!(last_exit_code("\tlast exit code = (never exited)\n"), None);
        assert_eq!(last_exit_code("\tstate = waiting\n"), None);
    }

    #[tokio::test]
    async fn a_stalled_start_says_what_launchd_saw() {
        let f = Fixture::new("stalled", true);
        std::fs::write(f.dir.join("print.txt"), "\tstate = not running\n\tlast exit code = 127\n").unwrap();
        let long_ago = (now() - chrono::Duration::seconds(START_GRACE_SECS + 30)).to_rfc3339();
        // start_host_update notes where this run's part of launchd's log begins, so an older
        // run's output isn't shown as this one's.
        std::fs::write(f.paths.launchd_log_file(), "an older run: node: command not found\n").unwrap();
        start_host_update(&f.paths).await.unwrap();
        let mut st = read_status(&f.paths);
        assert_eq!(st["launchdLogOffset"], 38, "{st}");
        st["startedAt"] = json!(long_ago);
        write_status(&f.paths, &st).unwrap();
        assert_eq!(host_update_status(&f.paths).await["launchd"]["log"], "", "an older run's output isn't this run's");

        let early: String = (1..=60).map(|i| format!("noise {i}\n")).collect();
        std::fs::write(f.paths.launchd_log_file(), format!("{early}\u{1b}[1mops/update.sh: line 3: node: command not found\u{1b}[0m\n")).unwrap();
        // The server's "starting" mark, long past its grace, and update.sh never wrote its pid.
        write_status(&f.paths, &json!({ "state": "running", "step": "starting", "startedAt": long_ago, "pid": null })).unwrap();
        let s = host_update_status(&f.paths).await;
        assert_eq!(s["state"], "failed");
        assert!(s["step"].as_str().unwrap().contains("didn't start"), "{s}");
        assert_eq!(s["launchd"]["lastExitCode"], "127");
        let log = s["launchd"]["log"].as_str().unwrap();
        assert_eq!(log.lines().count(), LAUNCHD_LOG_LINES, "{log}");
        assert!(log.ends_with("node: command not found"), "the tail, without escapes: {log}");
        // A run that wrote its pid and then died: stopped without finishing, launchd's view too.
        write_status(&f.paths, &json!({ "state": "running", "step": "npm ci", "pid": 999_999_999 })).unwrap();
        let s = host_update_status(&f.paths).await;
        assert!(s["step"].as_str().unwrap().contains("npm ci (the update stopped without finishing)"), "{s}");
        assert_eq!(s["launchd"]["lastExitCode"], "127");
        // Still within the grace: running, and launchd isn't asked about it.
        write_status(&f.paths, &json!({ "state": "running", "step": "starting", "startedAt": now().to_rfc3339(), "pid": null })).unwrap();
        let s = host_update_status(&f.paths).await;
        assert_eq!((s["state"].as_str(), &s["launchd"]), (Some("running"), &Value::Null));
    }

    #[tokio::test]
    async fn status_tails_this_runs_log() {
        let f = Fixture::new("tail", true);
        let old = "old run\n".repeat(10);
        let new: String = (1..=250).map(|i| format!("line {i}\n")).collect();
        std::fs::write(f.paths.log_file(), format!("{old}{new}")).unwrap();
        write_status(
            &f.paths,
            &json!({ "state": "succeeded", "step": "done", "logOffset": old.len(), "clients": { "desktop": "built 0.5.975", "android": "skipped: no keystore" } }),
        )
        .unwrap();
        let s = host_update_status(&f.paths).await;
        let log = s["log"].as_str().unwrap();
        assert_eq!(log.lines().count(), 200);
        assert!(log.starts_with("line 51\n") && log.ends_with("line 250"), "{log}");
        assert_eq!(strip_ansi("\u{1b}[1m== npm ci\u{1b}[0m\r"), "== npm ci");
        assert_eq!(s["clients"]["android"], "skipped: no keystore");
        // A log rotated under the offset is read from its start.
        std::fs::write(f.paths.log_file(), "fresh\n").unwrap();
        assert_eq!(host_update_status(&f.paths).await["log"], "fresh");
    }

    mod routes {
        use super::*;
        use crate::{events, ollama, rag, router, Shares};
        use axum::http::Request as HttpRequest;
        use axum::extract::ConnectInfo;
        use ganban_core::auth;
        use std::net::SocketAddr;

        struct Host {
            db: ganban_core::Db,
            paths: Arc<UpdatePaths>,
            _f: Fixture,
        }

        impl Host {
            async fn new(tag: &str) -> Self {
                let db = crate::commands::testkit::test_db(&format!("upd_routes_{tag}")).await;
                let f = Fixture::new(&format!("routes_{tag}"), true);
                Host { db, paths: Arc::new(f.paths.clone()), _f: f }
            }

            async fn device(&self) -> String {
                let p = crate::commands::testkit::seed(&self.db, "create_project", json!({ "input": { "name": "P" } })).await["id"].as_i64().unwrap();
                let invite = auth::create_enrollment_token(&self.db, "invite", None, Some(p), Some("member"), Some("Bo"), auth::INVITE_TTL_SECS).await.unwrap();
                auth::enroll(&self.db, &invite, Some("phone"), Some("Bo")).await.unwrap().device_token
            }

            async fn get(&self, uri: &str, token: Option<&str>, range: Option<&str>) -> (StatusCode, HeaderMap, Vec<u8>) {
                let mut req = HttpRequest::get(uri).header(header::HOST, "100.64.0.1:8765");
                if let Some(t) = token {
                    req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
                }
                if let Some(r) = range {
                    req = req.header(header::RANGE, r);
                }
                let mut req = req.body(Body::empty()).unwrap();
                let peer: SocketAddr = ([100, 64, 0, 9], 50_000).into();
                req.extensions_mut().insert(ConnectInfo(peer));
                req.extensions_mut().insert(self.paths.clone());
                let rag: rag::SharedRag = Arc::new(tokio::sync::RwLock::new(None));
                let ollama: ollama::SharedOllama = Arc::new(tokio::sync::RwLock::new(None));
                let app = router(self.db.clone(), Shares::default(), std::env::temp_dir(), rag, ollama, events::EventHub::new());
                let res = app.oneshot(req).await.unwrap();
                let (status, headers) = (res.status(), res.headers().clone());
                let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec();
                (status, headers, body)
            }
        }

        #[tokio::test]
        async fn the_updater_check_answers_200_only_when_newer() {
            let host = Host::new("check").await;
            let t = host.device().await;
            let (st, _, body) = host.get("/updates/desktop/darwin/aarch64/0.5.1", Some(&t), None).await;
            assert_eq!(st, StatusCode::OK);
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["version"], "0.5.975");
            assert_eq!(v["signature"], "SIG");
            assert_eq!(v["pub_date"], "2026-11-02T10:00:00Z");
            assert_eq!(v["url"], "http://100.64.0.1:8765/updates/desktop/darwin/aarch64/bundle");
            for current in ["0.5.975", "0.5.976"] {
                let (st, _, _) = host.get(&format!("/updates/desktop/darwin/aarch64/{current}"), Some(&t), None).await;
                assert_eq!(st, StatusCode::NO_CONTENT, "{current}");
            }
            let (st, _, _) = host.get("/updates/desktop/windows/x86_64/0.5.1", Some(&t), None).await;
            assert_eq!(st, StatusCode::NO_CONTENT, "no build for that platform");
            let (st, _, _) = host.get("/updates/desktop/darwin/..%2F..%2Fx/0.5.1", Some(&t), None).await;
            assert_eq!(st, StatusCode::NO_CONTENT, "no way out of the builds folder");
        }

        #[tokio::test]
        async fn the_update_routes_need_a_device_token() {
            let host = Host::new("auth").await;
            for uri in ["/updates/desktop/darwin/aarch64/0.5.1", "/updates/desktop/darwin/aarch64/bundle", "/updates/android/apk"] {
                let (st, _, _) = host.get(uri, None, None).await;
                assert_eq!(st, StatusCode::UNAUTHORIZED, "{uri}");
                let (st, _, _) = host.get(uri, Some("not-a-token"), None).await;
                assert_eq!(st, StatusCode::UNAUTHORIZED, "{uri}");
            }
            let t = host.device().await;
            let (st, _, body) = host.get(&format!("/updates/android/apk?token={t}"), None, None).await;
            assert_eq!((st, body.as_slice()), (StatusCode::OK, &b"APKBYTES"[..]), "?token= works like the download routes");
        }

        #[tokio::test]
        async fn the_downloads_stream_with_range() {
            let host = Host::new("range").await;
            let t = host.device().await;
            let (st, h, body) = host.get("/updates/desktop/darwin/aarch64/bundle", Some(&t), None).await;
            assert_eq!((st, body.as_slice()), (StatusCode::OK, &b"0123456789"[..]));
            assert!(h[header::CONTENT_DISPOSITION].to_str().unwrap().contains("Ganban_0.5.975.app.tar.gz"));
            let (st, h, body) = host.get("/updates/desktop/darwin/aarch64/bundle", Some(&t), Some("bytes=2-5")).await;
            assert_eq!((st, body.as_slice()), (StatusCode::PARTIAL_CONTENT, &b"2345"[..]));
            assert_eq!(h[header::CONTENT_RANGE], "bytes 2-5/10");
            let (st, h, body) = host.get("/updates/android/apk", Some(&t), Some("bytes=3-")).await;
            assert_eq!((st, body.as_slice()), (StatusCode::PARTIAL_CONTENT, &b"BYTES"[..]));
            assert_eq!(h[header::CONTENT_TYPE], "application/vnd.android.package-archive");
            std::fs::remove_file(host.paths.builds().join("android/manifest.json")).unwrap();
            assert_eq!(host.get("/updates/android/apk", Some(&t), None).await.0, StatusCode::NOT_FOUND);
        }
    }
}
