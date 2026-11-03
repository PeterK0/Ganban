//! Ganban headless daemon (standalone binary).
//!
//! Thin entrypoint over the `ganban_server` library: resolves config, opens the
//! canonical SQLite DB, and serves `ganban_server::router`. The desktop app
//! reuses the same router in-process (see `src-tauri`).
//!
//! Configuration (env):
//!   GANBAN_DB       full path to the SQLite file (default: the desktop app's
//!                   canonical `<data_dir>/com.scs.gansty/gansty.db`)
//!   GANBAN_ADDR     listen address (default: 0.0.0.0:8765)
//!   GANBAN_ANDROID/GANBAN_WINDOWS/GANBAN_MACOS/GANBAN_LINUX
//!                   optional native builds to offer at /download (per platform)

use std::net::SocketAddr;
use std::path::PathBuf;

const DEFAULT_ADDR: &str = "0.0.0.0:8765";

#[tokio::main]
async fn main() {
    let db_path = resolve_db_path();
    let addr: SocketAddr = std::env::var("GANBAN_ADDR")
        .unwrap_or_else(|_| DEFAULT_ADDR.to_string())
        .parse()
        .expect("Invalid GANBAN_ADDR (expected e.g. 0.0.0.0:8765)");

    // Logs to a rolling file (GANBAN_LOG_DIR, else next to the DB in `logs/`)
    // plus stdout. Keep the guard alive for the whole process.
    let log_dir = std::env::var("GANBAN_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            db_path
                .parent()
                .map(|p| p.join("logs"))
                .unwrap_or_else(|| PathBuf::from("logs"))
        });
    let _log_guard = ganban_server::init_logging(&log_dir);

    tracing::info!("Ganban daemon starting");
    tracing::info!("  DB:   {}", db_path.display());

    let db = ganban_core::init_db(&db_path)
        .await
        .expect("Failed to open database");

    let listener = ganban_server::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind {addr}: {e}"));

    tracing::info!(
        "Listening on http://{addr}  (tailnet-only; loopback = owner, remote clients enroll for a device token; CORS permissive)"
    );

    // Optional: a headless server can also offer native builds at /download.
    let slot = |var: &str| {
        std::sync::Arc::new(std::sync::Mutex::new(std::env::var(var).ok().map(PathBuf::from)))
    };
    let shares = ganban_server::Shares {
        android: slot("GANBAN_ANDROID"),
        windows: slot("GANBAN_WINDOWS"),
        macos: slot("GANBAN_MACOS"),
        linux: slot("GANBAN_LINUX"),
        server: slot("GANBAN_SERVER"),
    };
    // Shared files live next to the DB (or GANBAN_STORAGE), so a standalone daemon
    // and the desktop in-process daemon agree on the same folder.
    let storage_root = std::env::var("GANBAN_STORAGE").map(PathBuf::from).unwrap_or_else(|_| {
        db_path.parent().map(|p| p.join("shared")).unwrap_or_else(|| PathBuf::from("ganban-shared"))
    });
    ganban_server::serve(listener, db, shares, storage_root, std::future::pending())
        .await
        .expect("server error");
}

/// Resolve the canonical database path. `GANBAN_DB` wins; otherwise mirror the
/// desktop app's Tauri `app_data_dir` (`<data_dir>/com.scs.gansty/gansty.db`) so
/// `cargo run -p ganban-server` opens the very database the desktop app uses.
fn resolve_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("GANBAN_DB") {
        return PathBuf::from(p);
    }
    let base = dirs::data_dir()
        .expect("could not resolve a platform data directory; set GANBAN_DB explicitly");
    base.join("com.scs.gansty").join("gansty.db")
}
