//! Host health: live load/space/performance for the machine the server runs
//! on — "is the host struggling?" answered from inside the app instead of a
//! second SSH session.
//!
//! Three parts:
//!   * request counters (atomics, middleware) — traffic + latency since boot,
//!     plus a 5-minute window: requests/min and the busiest calls and devices
//!     (so "the counter is huge" can be answered with WHO is calling);
//!   * a 30s sampler writing `host_metrics` rows (7-day retention) — the
//!     durable log behind the charts;
//!   * the owner-only `/system/stats` payload: a fresh sample + recent history.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Query, State};
use axum::response::Json;
use serde_json::{json, Value};
use sysinfo::{Disks, System};

use crate::{ApiError, AuthOwner};
use ganban_core::storage::StorageRoot;
use ganban_core::Db;

static STARTED: LazyLock<Instant> = LazyLock::new(Instant::now);
static REQ_COUNT: AtomicU64 = AtomicU64::new(0);
static REQ_MS_TOTAL: AtomicU64 = AtomicU64::new(0);
static REQ_SLOW: AtomicU64 = AtomicU64::new(0); // >1s — the "host is gasping" tell

/// Pin the boot instant (call early in serve()).
pub fn mark_started() {
    let _ = *STARTED;
}

/// What an /invoke call ran — the invoke route tags its response with this so
/// the traffic window can name RPC commands, not just "POST /invoke".
#[derive(Clone)]
pub struct InvokeLabel(pub String);

/// The traffic window: one bucket per second, the last `WINDOW_SECS` kept.
const WINDOW_SECS: u64 = 300;

#[derive(Default)]
struct Bucket {
    sec: u64,
    count: u32,
    calls: HashMap<String, u32>,
    clients: HashMap<String, u32>,
}

static TRAFFIC: LazyLock<Mutex<VecDeque<Bucket>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// `GET /tasks/12/reactions` → `GET /tasks/:id/reactions`; hashed asset names
/// and other id-like segments collapse too, so the breakdown stays readable.
fn call_key(method: &str, path: &str) -> String {
    if path.starts_with("/assets/") {
        return "GET /assets/*".into();
    }
    let segs: Vec<String> = path
        .split('/')
        .map(|seg| {
            let digits = seg.chars().filter(|c| c.is_ascii_digit()).count();
            if !seg.is_empty() && (digits == seg.len() || (seg.len() > 16 && digits > 0)) { ":id".to_string() } else { seg.to_string() }
        })
        .collect();
    let mut key = format!("{method} {}", segs.join("/"));
    key.truncate(80);
    key
}

fn record(call: String, client: String) {
    let now = STARTED.elapsed().as_secs();
    let Ok(mut q) = TRAFFIC.lock() else { return };
    while q.front().is_some_and(|b| now.saturating_sub(b.sec) >= WINDOW_SECS) {
        q.pop_front();
    }
    if q.back().map(|b| b.sec) != Some(now) {
        q.push_back(Bucket { sec: now, ..Default::default() });
    }
    let b = q.back_mut().expect("just pushed");
    b.count += 1;
    // Bounded per bucket: a scanner hitting random URLs can't grow memory.
    if b.calls.len() < 200 || b.calls.contains_key(&call) {
        *b.calls.entry(call).or_default() += 1;
    }
    if b.clients.len() < 50 || b.clients.contains_key(&client) {
        *b.clients.entry(client).or_default() += 1;
    }
}

/// Requests in the last minute + the busiest calls/clients over the window.
fn traffic_summary() -> serde_json::Value {
    let now = STARTED.elapsed().as_secs();
    let Ok(q) = TRAFFIC.lock() else { return json!({}) };
    let mut per_min = 0u32;
    let mut window = 0u32;
    let mut calls: HashMap<&str, u32> = HashMap::new();
    let mut clients: HashMap<&str, u32> = HashMap::new();
    for b in q.iter().filter(|b| now.saturating_sub(b.sec) < WINDOW_SECS) {
        window += b.count;
        if now.saturating_sub(b.sec) < 60 {
            per_min += b.count;
        }
        for (k, v) in &b.calls {
            *calls.entry(k).or_default() += v;
        }
        for (k, v) in &b.clients {
            *clients.entry(k).or_default() += v;
        }
    }
    let top = |m: HashMap<&str, u32>, n: usize| {
        let mut v: Vec<_> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        v.into_iter().take(n).map(|(k, c)| json!({ "key": k, "count": c })).collect::<Vec<_>>()
    };
    json!({
        "per_min": per_min,
        "window_secs": WINDOW_SECS.min(now.max(1)),
        "window_count": window,
        "top_calls": top(calls, 8),
        "top_clients": top(clients, 6),
    })
}

/// Request middleware: count + time every request, and feed the traffic
/// window. Never touches bodies, so SSE/chat streams pass through untouched
/// (same rule as pulse_mw).
pub async fn track_mw(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let t = Instant::now();
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let client = req
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|c| if c.0.ip().is_loopback() { "this host".to_string() } else { c.0.ip().to_string() })
        .unwrap_or_else(|| "unknown".into());
    let res = next.run(req).await;
    let ms = t.elapsed().as_millis() as u64;
    REQ_COUNT.fetch_add(1, Ordering::Relaxed);
    REQ_MS_TOTAL.fetch_add(ms, Ordering::Relaxed);
    if ms > 1_000 {
        REQ_SLOW.fetch_add(1, Ordering::Relaxed);
    }
    let call = match res.extensions().get::<InvokeLabel>() {
        Some(l) => format!("invoke {}", l.0),
        None => call_key(&method, &path),
    };
    record(call, client);
    res
}

async fn ensure_schema(db: &Db) {
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS host_metrics (\
            ts TEXT NOT NULL DEFAULT (datetime('now')), \
            cpu_pct REAL NOT NULL, \
            gpu_pct REAL, \
            mem_used INTEGER NOT NULL, \
            mem_total INTEGER NOT NULL, \
            disk_free INTEGER NOT NULL, \
            disk_total INTEGER NOT NULL, \
            db_bytes INTEGER NOT NULL)",
    )
    .execute(db)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_host_metrics_ts ON host_metrics(ts)")
        .execute(db)
        .await;
    // Hosts that sampled before GPU landed (best-effort; fails = exists).
    let _ = sqlx::query("ALTER TABLE host_metrics ADD COLUMN gpu_pct REAL").execute(db).await;
}

#[derive(Clone)]
struct Sample {
    cpu_pct: f32,
    /// None = no readable GPU on this host (never fabricated).
    gpu_pct: Option<f32>,
    mem_used: u64,
    mem_total: u64,
    disk_free: u64,
    disk_total: u64,
    db_bytes: i64,
}

/// GPU utilization, honestly sourced or absent. macOS: the IOAccelerator
/// registry's "Device Utilization %" (what the menu-bar monitors read; no
/// root needed — Apple Silicon included). Elsewhere: nvidia-smi if present
/// (the Linux host path). Anything else reports None, never a made-up 0.
async fn gpu_pct() -> Option<f32> {
    let run = |cmd: &str, args: &[&str]| {
        let cmd = cmd.to_string();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        async move {
            let out = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                tokio::process::Command::new(cmd).args(args).output(),
            )
            .await
            .ok()?
            .ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
        }
    };
    if cfg!(target_os = "macos") {
        let text = run("ioreg", &["-r", "-d", "1", "-c", "IOAccelerator"]).await?;
        // `"Device Utilization %"=NN` — take the busiest accelerator.
        return text
            .lines()
            .filter_map(|l| {
                let (_, rest) = l.split_once("\"Device Utilization %\"=")?;
                rest.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse::<f32>().ok()
            })
            .fold(None, |acc: Option<f32>, v| Some(acc.map_or(v, |a| a.max(v))));
    }
    let text = run("nvidia-smi", &["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]).await?;
    text.lines().next()?.trim().parse::<f32>().ok()
}

/// One host sample. `sys` is reused so CPU deltas have a prior observation;
/// the disk chosen is the one holding the data dir (longest mount prefix).
async fn sample(db: &Db, sys: &mut System, data_dir: &std::path::Path) -> Sample {
    sys.refresh_cpu_usage();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64, u64)> = None; // (prefix_len, free, total)
    for d in disks.list() {
        let mp = d.mount_point();
        if data_dir.starts_with(mp) {
            let len = mp.as_os_str().len();
            if best.is_none_or(|(l, _, _)| len > l) {
                best = Some((len, d.available_space(), d.total_space()));
            }
        }
    }
    let (disk_free, disk_total) = best
        .map(|(_, f, t)| (f, t))
        .or_else(|| disks.list().first().map(|d| (d.available_space(), d.total_space())))
        .unwrap_or((0, 0));
    // DB size without knowing the file path: the database reports itself.
    let db_bytes: i64 = sqlx::query_scalar(
        "SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size)",
    )
    .fetch_one(db)
    .await
    .unwrap_or(0);
    Sample {
        cpu_pct: sys.global_cpu_usage(),
        gpu_pct: gpu_pct().await,
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        disk_free,
        disk_total,
        db_bytes,
    }
}

/// 30s sampler → `host_metrics`, pruned to 7 days. Stops with the server.
pub fn spawn_sampler(db: Db, data_dir: std::path::PathBuf, mut stop_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        ensure_schema(&db).await;
        let mut sys = System::new();
        loop {
            let s = sample(&db, &mut sys, &data_dir).await;
            let _ = sqlx::query(
                "INSERT INTO host_metrics (cpu_pct, gpu_pct, mem_used, mem_total, disk_free, disk_total, db_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(s.cpu_pct)
            .bind(s.gpu_pct)
            .bind(s.mem_used as i64)
            .bind(s.mem_total as i64)
            .bind(s.disk_free as i64)
            .bind(s.disk_total as i64)
            .bind(s.db_bytes)
            .execute(&db)
            .await;
            let _ = sqlx::query("DELETE FROM host_metrics WHERE ts < datetime('now', '-7 days')")
                .execute(&db)
                .await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() { break; }
                }
            }
        }
    });
}

/// The live sample, shared for a few seconds. Every client used to get its
/// own — a ~200 ms CPU measurement plus an `ioreg` process for the GPU — on
/// every poll (the Bridge every 5 s, the header chip every 15 s, per client).
/// Single-flight: concurrent callers wait for one sample and share it.
static LIVE: LazyLock<tokio::sync::Mutex<Option<(Instant, Sample)>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));
const LIVE_TTL: Duration = Duration::from_secs(5);

async fn live_sample(db: &Db, data_dir: &std::path::Path) -> Sample {
    let mut g = LIVE.lock().await;
    if let Some((at, s)) = g.as_ref() {
        if at.elapsed() < LIVE_TTL {
            return s.clone();
        }
    }
    let mut sys = System::new();
    let s = sample(db, &mut sys, data_dir).await;
    *g = Some((Instant::now(), s.clone()));
    s
}

#[derive(serde::Deserialize)]
pub struct StatsQuery {
    /// `history=0` skips the 8-hour series (the header chip needs only `now`).
    history: Option<u8>,
}

/// GET /system/stats (owner): live sample + request counters/traffic + (unless
/// `history=0`) the recent history.
pub async fn stats_handler(
    State(db): State<Db>,
    axum::Extension(root): axum::Extension<StorageRoot>,
    Query(q): Query<StatsQuery>,
    _owner: AuthOwner,
) -> Result<Json<Value>, ApiError> {
    let s = live_sample(&db, &root.0).await;
    let count = REQ_COUNT.load(Ordering::Relaxed);
    let total_ms = REQ_MS_TOTAL.load(Ordering::Relaxed);
    #[allow(clippy::type_complexity)]
    let history: Vec<(String, f64, Option<f64>, i64, i64, i64, i64, i64)> = if q.history == Some(0) {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT ts, cpu_pct, gpu_pct, mem_used, mem_total, disk_free, disk_total, db_bytes \
             FROM host_metrics WHERE ts >= datetime('now', '-8 hours') ORDER BY ts",
        )
        .fetch_all(&db)
        .await
        .unwrap_or_default()
    };
    Ok(Json(json!({
        "now": {
            "cpu_pct": s.cpu_pct,
            "gpu_pct": s.gpu_pct,
            "mem_used": s.mem_used,
            "mem_total": s.mem_total,
            "disk_free": s.disk_free,
            "disk_total": s.disk_total,
            "db_bytes": s.db_bytes,
        },
        "uptime_seconds": STARTED.elapsed().as_secs(),
        "requests": {
            "count": count,
            "avg_ms": if count > 0 { total_ms / count } else { 0 },
            "slow_1s": REQ_SLOW.load(Ordering::Relaxed),
            "traffic": traffic_summary(),
        },
        "history": history.into_iter().map(|(ts, cpu, gpu, mu, mt, df, dt, dbb)| json!({
            "ts": ts, "cpu_pct": cpu, "gpu_pct": gpu, "mem_used": mu, "mem_total": mt,
            "disk_free": df, "disk_total": dt, "db_bytes": dbb,
        })).collect::<Vec<_>>(),
    })))
}


#[cfg(test)]
mod traffic_tests {
    use super::*;

    #[test]
    fn call_keys_collapse_ids_and_assets() {
        assert_eq!(call_key("GET", "/tasks/12/reactions"), "GET /tasks/:id/reactions");
        assert_eq!(call_key("GET", "/tiles/satellite/5/17/11"), "GET /tiles/satellite/:id/:id/:id");
        assert_eq!(call_key("GET", "/assets/index-Bx81kq.js"), "GET /assets/*");
        assert_eq!(call_key("GET", "/ai/oracle/active"), "GET /ai/oracle/active");
    }

    #[test]
    fn the_window_counts_and_ranks() {
        for _ in 0..5 {
            record("GET /ai/oracle/active".into(), "100.1.2.3".into());
        }
        record("invoke get_tasks".into(), "this host".into());
        let t = traffic_summary();
        assert!(t["per_min"].as_u64().unwrap() >= 6);
        assert_eq!(t["top_calls"][0]["key"], "GET /ai/oracle/active");
        assert_eq!(t["top_clients"][0]["key"], "100.1.2.3");
    }
}
