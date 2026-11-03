//! Desktop-only: launch + supervise the local AI engines (Ollama + the ragrat
//! RAG daemon) so a non-technical user never touches a console. Ganban discovers
//! the binaries, picks a FREE port for ragrat (preempting the 8765 collision
//! with the Ganban daemon), spawns the processes, and writes the connection
//! settings the host daemon reads. Children we start are tracked and killed on
//! Stop.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ganban_core::{ops, Db};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const OLLAMA_PORT: u16 = 11434;

/// Tracks the engine processes Ganban itself started (so Stop only kills ours,
/// never an Ollama the user runs independently).
#[derive(Default)]
pub struct AiEngineState {
    children: Mutex<Vec<(String, Child)>>,
}

#[derive(Serialize)]
pub struct EngineState {
    /// Resolved binary path, if found on this machine.
    found: Option<String>,
    /// Whether its port is currently accepting connections.
    running: bool,
    url: Option<String>,
    /// ragrat only: the running daemon's actual ingest pool size (its GET
    /// /status), so Settings can show when it differs from the saved setting.
    #[serde(skip_serializing_if = "Option::is_none")]
    workers: Option<u64>,
    /// Whether Ganban itself started (and supervises) THIS engine. A running
    /// engine with `managed: false` is external — Stop won't touch it, but the
    /// owner can reclaim its port (see `ai_engine_reclaim_ragrat`).
    managed: bool,
}

/// Ask a running ragrat how many ingest workers it actually has. None =
/// unreachable, or a ragrat build that predates the worker pool.
async fn live_ragrat_workers(url: &str) -> Option<u64> {
    let resp = reqwest::Client::new()
        .get(format!("{}/status", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    let v: Value = resp.json().await.ok()?;
    v.get("ingest_workers").and_then(|w| w.as_u64())
}

#[derive(Serialize)]
pub struct AiEngineStatus {
    ollama: EngineState,
    ragrat: EngineState,
    /// True if Ganban started (and is supervising) any of them.
    managed: bool,
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(400)).is_ok()
}

/// An OS-assigned free TCP port (bind :0, read it back, release).
fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn port_from_url(u: &str) -> Option<u16> {
    u.trim_end_matches('/').rsplit(':').next().and_then(|p| p.parse().ok())
}

/// PID of the process LISTENING on a loopback TCP port (best-effort, per OS).
/// Used only to reclaim a port from an engine Ganban didn't start.
fn pid_on_port(port: u16) -> Option<u32> {
    #[cfg(not(windows))]
    {
        // lsof -t prints just PIDs; restrict to listeners so we never grab a
        // mere client (e.g. our own daemon's outbound connection).
        let out = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).lines().next().and_then(|l| l.trim().parse().ok())
    }
    #[cfg(windows)]
    {
        let out = Command::new("netstat").args(["-ano", "-p", "tcp"]).output().ok()?;
        let needle = format!(":{port}");
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if line.contains(&needle) && line.contains("LISTENING") {
                if let Some(pid) = line.split_whitespace().last().and_then(|p| p.parse().ok()) {
                    return Some(pid);
                }
            }
        }
        None
    }
}

/// A process's command line (for the pre-kill safety check). Empty if unknown.
fn process_command(pid: u32) -> String {
    let out = if cfg!(windows) {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
    } else {
        Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output()
    };
    out.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// Signal a PID: graceful (SIGTERM / taskkill) or forced (SIGKILL / /F).
fn signal_pid(pid: u32, force: bool) -> bool {
    let status = if cfg!(windows) {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string()]);
        if force {
            c.arg("/F");
        }
        c.status()
    } else {
        Command::new("kill").args([if force { "-9" } else { "-15" }, &pid.to_string()]).status()
    };
    status.map(|s| s.success()).unwrap_or(false)
}

fn home() -> String {
    // HOME is unset in Windows GUI processes; USERPROFILE is its equivalent.
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()
}

fn expand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", home(), rest),
        None => p.to_string(),
    }
}

/// Platform binary name ("ragrat" → "ragrat.exe" on Windows).
fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// First existing path among the explicit candidates, then PATH lookup
/// (`which` everywhere but Windows, where only `where` exists).
fn discover(bin: &str, candidates: &[String]) -> Option<String> {
    for c in candidates {
        let p = expand_home(c);
        if std::path::Path::new(&p).is_file() {
            return Some(p);
        }
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(finder).arg(exe(bin)).output() {
        if out.status.success() {
            // `where` can print several matches, one per line — take the first.
            let p = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    None
}

fn discover_ollama() -> Option<String> {
    let mut candidates = vec![
        "/opt/homebrew/bin/ollama".to_string(),
        "/usr/local/bin/ollama".to_string(),
        "/Applications/Ollama.app/Contents/Resources/ollama".to_string(),
    ];
    if cfg!(windows) {
        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{lad}\\Programs\\Ollama\\ollama.exe"));
        }
    }
    discover("ollama", &candidates)
}

/// The user-set `ragrat_binary_path` (Settings), validated to an existing file.
/// This is the STRONGEST override — it beats even a bundled engine, because
/// it's the only way to run a NEWER engine than the one baked into the .app
/// (e.g. testing a freshly built dist bundle on a host without rebuilding the
/// whole app).
async fn explicit_ragrat(db: &Db) -> Option<String> {
    if let Ok(Some(p)) = ops::get_app_setting(db, "ragrat_binary_path").await {
        let p = expand_home(p.trim());
        if !p.is_empty() && std::path::Path::new(&p).is_file() {
            return Some(p);
        }
    }
    None
}

/// ragrat is a Python venv binary with no standard location, so a user-set
/// `ragrat_binary_path` wins; otherwise try PATH / ~/.local/bin.
async fn discover_ragrat(db: &Db) -> Option<String> {
    if let Some(p) = explicit_ragrat(db).await {
        return Some(p);
    }
    discover("ragrat", &[format!("~/.local/bin/{}", exe("ragrat"))])
}

/// A ragrat shipped INSIDE this .app via Tauri `bundle.resources` (the
/// PyInstaller onedir) — so a downloaded .dmg needs no Python/dependency
/// setup. Returns (engine binary, pre-bundled Docling models dir if present).
/// The build/packaging recipe lives in docs/host/BUNDLING.md. None in dev or when
/// no engine was bundled (then discovery falls back to a system ragrat).
fn bundled_ragrat(app: &AppHandle) -> Option<(String, Option<String>)> {
    let res = app.path().resource_dir().ok()?;
    // Probe the documented layouts (Tauri's resource path handling varies by
    // how the glob was declared).
    let bin_name = exe("ragrat");
    let bin = ["ragrat-engine", "resources/ragrat-engine", "_up_/resources/ragrat-engine"]
        .iter()
        .map(|rel| res.join(rel).join(&bin_name))
        .find(|p| p.is_file())?;
    let models = ["docling-models", "resources/docling-models", "_up_/resources/docling-models"]
        .iter()
        .map(|rel| res.join(rel))
        .find(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned());
    Some((bin.to_string_lossy().into_owned(), models))
}

fn configured_ragrat_port(url: &Option<String>) -> Option<u16> {
    url.as_deref().and_then(port_from_url)
}

async fn ragrat_url_setting(db: &Db) -> Option<String> {
    ops::get_app_setting(db, "ragrat_connection")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(String::from))
}

/// Status of both engines (binary found? port up?) for the Settings panel.
#[tauri::command]
pub async fn ai_engine_status(app: AppHandle, pool: State<'_, Db>, state: State<'_, AiEngineState>) -> Result<AiEngineStatus, String> {
    let db = pool.inner();
    let ragrat_url = ragrat_url_setting(db).await;
    let ragrat_running = configured_ragrat_port(&ragrat_url).map(port_open).unwrap_or(false);
    let ragrat_workers = match (&ragrat_url, ragrat_running) {
        (Some(u), true) => live_ragrat_workers(u).await,
        _ => None,
    };
    let (ollama_managed, ragrat_managed, any_managed) = {
        let kids = state.children.lock().await;
        (
            kids.iter().any(|(l, _)| l == "ollama"),
            kids.iter().any(|(l, _)| l == "ragrat"),
            !kids.is_empty(),
        )
    };
    Ok(AiEngineStatus {
        ollama: EngineState {
            found: discover_ollama(),
            running: port_open(OLLAMA_PORT),
            url: Some(format!("http://127.0.0.1:{OLLAMA_PORT}")),
            workers: None,
            managed: ollama_managed,
        },
        ragrat: EngineState {
            found: explicit_ragrat(db).await.or(bundled_ragrat(&app).map(|(b, _)| b)).or(discover_ragrat(db).await),
            running: ragrat_running,
            url: ragrat_url,
            workers: ragrat_workers,
            managed: ragrat_managed,
        },
        managed: any_managed,
    })
}

/// Where an engine child's stdout/stderr goes. Every startup failure mode
/// (missing dylib, Python ImportError, Gatekeeper kill) prints there and
/// nowhere else — a desktop app has no console — so the error messages point
/// the user at this file.
fn engine_log(app: &AppHandle, label: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{label}-engine.log")))
}

/// The last few log lines, for inlining into an error message.
fn log_tail(path: &std::path::Path) -> String {
    let Ok(s) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let mut lines: Vec<&str> = s.lines().rev().take(10).collect();
    lines.reverse();
    if lines.is_empty() {
        String::new()
    } else {
        format!("\n{}", lines.join("\n"))
    }
}

async fn spawn(
    app: &AppHandle,
    state: &AiEngineState,
    label: &str,
    path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<(), String> {
    let mut cmd = Command::new(path);
    cmd.args(args).stdin(Stdio::null());
    match engine_log(app, label).and_then(|p| std::fs::File::create(p).ok()) {
        Some(f) => {
            match f.try_clone() {
                Ok(out) => cmd.stdout(Stdio::from(out)).stderr(Stdio::from(f)),
                Err(_) => cmd.stdout(Stdio::null()).stderr(Stdio::from(f)),
            };
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let child = cmd.spawn().map_err(|e| format!("failed to start {label}: {e}"))?;
    state.children.lock().await.push((label.to_string(), child));
    Ok(())
}

/// Wait for the engine's port, failing fast (with the log tail) if the child
/// we just spawned exits first — otherwise a crashed engine and a slow one
/// produce the same opaque timeout.
async fn wait_for_engine(app: &AppHandle, state: &AiEngineState, label: &str, port: u16, secs: u64) -> Result<(), String> {
    let log = engine_log(app, label);
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if port_open(port) {
            return Ok(());
        }
        {
            let mut kids = state.children.lock().await;
            if let Some(i) = kids.iter().position(|(l, _)| l == label) {
                if let Ok(Some(status)) = kids[i].1.try_wait() {
                    kids.remove(i);
                    let detail = log
                        .as_deref()
                        .map(|p| format!(" Log: {}{}", p.display(), log_tail(p)))
                        .unwrap_or_default();
                    return Err(format!("{label} exited during startup ({status}).{detail}"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let detail = log.as_deref().map(|p| format!(" Check the log: {}", p.display())).unwrap_or_default();
    Err(format!("{label} was started but didn't become reachable.{detail}"))
}

/// Start the engines that aren't already up: Ollama on its default port, ragrat
/// on a freshly-allocated free port (so it never collides with Ganban's 8765).
/// Writes ollama_connection + ragrat_connection so the daemon can pick them up
/// (the caller then reloads the daemon). Returns the resolved URLs.
#[tauri::command]
pub async fn ai_engine_start(app: AppHandle, pool: State<'_, Db>, state: State<'_, AiEngineState>) -> Result<Value, String> {
    let out = start_engines(&app, pool.inner(), &state).await?;
    // Remember the intent: the host brings the engines back on every launch
    // until the user explicitly stops them.
    let _ = ops::set_app_setting(pool.inner(), "ai_engines_autostart", "1").await;
    Ok(out)
}

/// The actual engine bring-up, shared by the Settings button and launch
/// autostart.
pub async fn start_engines(app: &AppHandle, db: &Db, state: &AiEngineState) -> Result<Value, String> {

    // --- Ollama (fixed port; start if down) ---
    // Epoch H: a configured REMOTE engine is the user's explicit choice —
    // never clobber it with the loopback default, and don't spawn a local
    // Ollama over it. Remote engines are reached, not supervised.
    let configured = ops::get_app_setting(db, "ollama_connection")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("base_url").and_then(|b| b.as_str()).map(String::from));
    let is_remote = configured
        .as_deref()
        .map(|u| !u.contains("127.0.0.1") && !u.contains("localhost"))
        .unwrap_or(false);
    let ollama_url = if is_remote {
        configured.unwrap()
    } else {
        let url = format!("http://127.0.0.1:{OLLAMA_PORT}");
        if !port_open(OLLAMA_PORT) {
            let path = discover_ollama().ok_or("Ollama not found — install it (https://ollama.com/download).")?;
            spawn(&app, &state, "ollama", &path, &["serve"], &[]).await?;
            wait_for_engine(&app, &state, "ollama", OLLAMA_PORT, 15).await?;
        }
        ops::set_app_setting(db, "ollama_connection", &json!({ "base_url": url }).to_string())
            .await
            .map_err(|e| e.to_string())?;
        url
    };

    // --- ragrat (reuse if its configured port is up; else free port) ---
    // Parallel ingestion: ragrat serializes per collection internally, so
    // extra workers only ever help across projects. Owner-set in Settings.
    let workers = ganban_core::ops::get_app_setting(db, "ragrat_workers")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .map(|n| n.clamp(1, 16))
        .unwrap_or(1)
        .to_string();
    let existing = ragrat_url_setting(db).await;
    // A live port is only reusable if it still matches the Settings: when WE
    // are supervising the running ragrat and the workers value changed,
    // restart it — otherwise a Settings change silently never applies (the
    // old daemon keeps its old --workers forever).
    let spawned_with = ops::get_app_setting(db, "ragrat_spawn_workers").await.ok().flatten();
    let ours = state.children.lock().await.iter().any(|(l, _)| l == "ragrat");
    let stale_workers = ours && spawned_with.as_deref() != Some(workers.as_str());
    if stale_workers {
        kill_child(&state, "ragrat").await;
    }
    let live = configured_ragrat_port(&existing).filter(|p| port_open(*p));
    // A running ragrat we did NOT start can't be restarted from here — if its
    // actual pool size differs from the setting, say so instead of silently
    // reusing it (the classic "set workers to 4, still ingesting 1-by-1").
    let mut warning: Option<String> = None;
    let ragrat_url = if let (Some(p), false) = (live, stale_workers) {
        let url = format!("http://127.0.0.1:{p}");
        if !ours {
            let live_workers = live_ragrat_workers(&url).await;
            if live_workers != workers.parse::<u64>().ok() {
                warning = Some(format!(
                    "ragrat on port {p} runs {} ingest worker(s), but the setting is {workers}. It wasn't started by Ganban — stop that process and Start engines again to apply.",
                    live_workers.map(|w| w.to_string()).unwrap_or_else(|| "an unknown number of".into()),
                ));
            }
        }
        url
    } else {
        // Engine priority: explicit user setting > bundled > PATH discovery.
        // A bundled engine (shipped in the .app) wins over a system install, so
        // a downloaded .dmg works with zero setup — but an EXPLICIT
        // `ragrat_binary_path` setting beats even the bundle (it's the only
        // way to pin a newer engine than the baked-in one). When the chosen
        // engine ships with a sibling docling-models dir (the dist layout:
        // …/ragrat-engine/ragrat + …/docling-models), pin Docling to those
        // models and forbid network fetches, so ingest works fully offline.
        let explicit = explicit_ragrat(db).await;
        let bundled = match &explicit {
            Some(p) => {
                let models = std::path::Path::new(p)
                    .parent()
                    .and_then(|d| d.parent())
                    .map(|r| r.join("docling-models"))
                    .filter(|m| m.is_dir())
                    .map(|m| m.to_string_lossy().into_owned());
                // Only treat an explicit engine as "bundled" (offline-pinned)
                // when its models actually ship beside it — a venv ragrat
                // without a sibling models dir must stay free to use its cache.
                models.map(|m| (p.clone(), Some(m)))
            }
            None => bundled_ragrat(&app),
        };
        let path = match (&explicit, &bundled) {
            (Some(p), _) => p.clone(),
            (None, Some((b, _))) => b.clone(),
            (None, None) => discover_ragrat(db)
                .await
                .ok_or(if cfg!(windows) {
                    // uv/pip put venv entry points in Scripts\ on Windows —
                    // the old Unix-only hint sent people hunting a bin\ folder
                    // that never exists there (field, 2026-08-01).
                    "ragrat not found — install it (`uv sync` in the ragrat clone) and set its path below (the .venv\\Scripts\\ragrat.exe binary)."
                } else {
                    "ragrat not found — install it (`uv sync` in the ragrat clone) and set its path below (the .venv/bin/ragrat binary)."
                })?,
        };
        let port = free_port().map_err(|e| e.to_string())?;
        // DOCLING_DEVICE=cpu is required on Apple Silicon for ingest.
        let mut envs: Vec<(&str, &str)> = vec![("DOCLING_DEVICE", "cpu")];
        if bundled.is_some() {
            // A bundled engine must never download models: if docling-models
            // was left out of the bundle (a packaging error), ingest fails
            // loudly in the engine log instead of silently pulling gigabytes.
            envs.push(("HF_HUB_OFFLINE", "1"));
            envs.push(("TRANSFORMERS_OFFLINE", "1"));
        }
        if let Some((_, Some(models))) = &bundled {
            envs.push(("DOCLING_ARTIFACTS_PATH", models));
            envs.push(("RAGRAT_DOCLING_MODELS", models));
            envs.push(("HF_HOME", models));
        }
        spawn(
            &app,
            &state,
            "ragrat",
            &path,
            &["daemon", "--host", "127.0.0.1", "--port", &port.to_string(), "--workers", &workers],
            &envs,
        )
        .await?;
        wait_for_engine(&app, &state, "ragrat", port, 25).await?;
        let url = format!("http://127.0.0.1:{port}");
        ops::set_app_setting(db, "ragrat_connection", &json!({ "url": url, "token": "" }).to_string())
            .await
            .map_err(|e| e.to_string())?;
        // Remember what this instance was started with, so the next Start can
        // tell whether the Settings have drifted and a restart is due.
        ops::set_app_setting(db, "ragrat_spawn_workers", &workers).await.map_err(|e| e.to_string())?;
        url
    };

    Ok(json!({ "ollama_url": ollama_url, "ragrat_url": ragrat_url, "warning": warning }))
}

/// Reclaim the configured ragrat port from an EXTERNAL daemon — one Ganban
/// didn't start (so Stop leaves it alone) yet which blocks a Settings change
/// (e.g. ingest workers) from ever applying. This is the in-app equivalent of
/// the warning's "stop that process and Start engines again".
///
/// Guard-railed three ways: we refuse if WE supervise the ragrat (use Stop),
/// we only ever signal the process actually LISTENING on that port, and only
/// if its command line looks like ragrat — never an unrelated process that
/// happens to have inherited the port. Graceful SIGTERM first; force only if
/// it's still bound after a grace period.
#[tauri::command]
pub async fn ai_engine_reclaim_ragrat(pool: State<'_, Db>, state: State<'_, AiEngineState>) -> Result<String, String> {
    if state.children.lock().await.iter().any(|(l, _)| l == "ragrat") {
        return Err("Ganban started this ragrat — use Stop, which shuts it down cleanly.".into());
    }
    let url = ragrat_url_setting(pool.inner())
        .await
        .ok_or("No ragrat connection is configured, so there's no port to reclaim.")?;
    let port = port_from_url(&url).ok_or("The saved ragrat connection has no port.")?;
    if !port_open(port) {
        return Err(format!("Nothing is listening on port {port} — it's already free. Click Start engines."));
    }
    let pid = pid_on_port(port).ok_or_else(|| {
        format!("Couldn't identify the process on port {port}. Stop it from a terminal, then Start engines.")
    })?;
    let cmd = process_command(pid);
    if !cmd.to_lowercase().contains("ragrat") {
        return Err(format!(
            "The process on port {port} (PID {pid}) doesn't look like ragrat, so Ganban won't stop it:\n{cmd}"
        ));
    }
    // Graceful, then escalate. Poll the port (not the PID) — "free" is the
    // outcome we actually care about.
    signal_pid(pid, false);
    for _ in 0..16 {
        if !port_open(port) {
            return Ok(format!("Stopped the external ragrat (PID {pid}). Click Start engines to launch a managed one."));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    signal_pid(pid, true);
    for _ in 0..16 {
        if !port_open(port) {
            return Ok(format!("Force-stopped the external ragrat (PID {pid}). Click Start engines to launch a managed one."));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(format!("Signalled PID {pid} but port {port} is still in use — it may need to be stopped by hand."))
}

/// Kill one engine we started (by label), if we're supervising it.
async fn kill_child(state: &AiEngineState, label: &str) {
    let mut kids = state.children.lock().await;
    if let Some(i) = kids.iter().position(|(l, _)| l == label) {
        let (_, mut child) = kids.remove(i);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Stop the engines Ganban started (leaves an externally-run Ollama alone),
/// and turn launch autostart off — stopping IS the opt-out.
#[tauri::command]
pub async fn ai_engine_stop(pool: State<'_, Db>, state: State<'_, AiEngineState>) -> Result<(), String> {
    let mut kids = state.children.lock().await;
    for (_, mut child) in kids.drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(kids);
    let _ = ops::set_app_setting(pool.inner(), "ai_engines_autostart", "0").await;
    Ok(())
}

/// Launch autostart: bring the engines back when they were running the last
/// time this host shut down (set on Start, cleared on Stop). Best-effort and
/// quiet — a failure shows up in Settings → AI Engines, never blocks launch.
pub fn autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let db = app.state::<Db>().inner().clone();
        let on = ops::get_app_setting(&db, "ai_engines_autostart")
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        if !on {
            return;
        }
        let state = app.state::<AiEngineState>();
        match start_engines(&app, &db, &state).await {
            Ok(_) => {
                // The in-process daemon caches its AI connections — poke its
                // reload route (loopback = owner) so chat/RAG see the fresh
                // ports without a manual Settings visit. The daemon autostarts
                // in parallel with us; give it a few beats to bind.
                for _ in 0..20 {
                    if let Some(port) = crate::daemon_control::current_port(&app).await {
                        let _ = reqwest::Client::new()
                            .post(format!("http://127.0.0.1:{port}/ai/reload"))
                            .send()
                            .await;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            Err(e) => eprintln!("AI engine autostart failed (use Settings → AI Engines → Start engines): {e}"),
        }
    });
}

/// Exit-time cleanup: quitting Ganban must not orphan a bundled ragrat or an
/// `ollama serve` we launched. Sync because it runs in the (non-async) Tauri
/// run-loop exit handler.
pub fn shutdown_sync(state: &AiEngineState) {
    let mut kids = state.children.blocking_lock();
    for (_, mut child) in kids.drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_is_usable_and_distinct() {
        let p = free_port().unwrap();
        assert!(p > 1024);
        // Nothing is listening on the just-released port.
        assert!(!port_open(p));
    }

    #[test]
    fn port_from_url_parses() {
        assert_eq!(port_from_url("http://127.0.0.1:8780"), Some(8780));
        assert_eq!(port_from_url("http://127.0.0.1:8780/"), Some(8780));
        assert_eq!(port_from_url("http://host"), None);
    }

    #[test]
    fn expand_home_handles_tilde() {
        std::env::set_var("HOME", "/Users/x");
        assert_eq!(expand_home("~/.local/bin/ragrat"), "/Users/x/.local/bin/ragrat");
        assert_eq!(expand_home("/opt/bin/ragrat"), "/opt/bin/ragrat");
    }
}
