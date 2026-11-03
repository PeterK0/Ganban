//! Process-wide logging setup.
//!
//! The server emits `tracing` events throughout; this wires them to two sinks:
//! a **rolling daily file** in the given directory (so the embedded desktop
//! server — which a bundled `.app` runs with no attached console — keeps a real,
//! leveled diagnostic log) and **stdout** (so the standalone daemon still prints
//! to its terminal). A `std::panic` hook routes crashes into the same log.
//!
//! Both the desktop shell and the standalone `main.rs` call [`init_logging`]
//! once at startup. The returned [`WorkerGuard`] must be kept alive for the
//! lifetime of the process — dropping it stops the background log writer.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

/// The filename prefix our daily-rotated server logs start with. The files are
/// named `ganban-server.YYYY-MM-DD.log` — date in the middle so they keep the
/// `.log` extension (open cleanly as text), rotating once per day.
pub const LOG_FILE_PREFIX: &str = "ganban-server";

/// Where logs are written + when logging started — so the diagnostics bundle can
/// find the files and report uptime without threading the path through state.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// The directory logs are written to (set by [`init_logging`]).
pub fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned()
}

/// Seconds since logging was initialized (process uptime, approximately).
pub fn uptime_secs() -> u64 {
    STARTED_AT.get().map(|t| t.elapsed().as_secs()).unwrap_or(0)
}

/// Initialize logging to a rolling daily file in `dir` plus stdout.
///
/// Returns `Some(guard)` on the first call (keep it alive!), or `None` if a
/// global subscriber was already installed (a second call is a harmless no-op).
/// Honors `RUST_LOG`; defaults to `info` (with our crates at `debug`).
pub fn init_logging(dir: &Path) -> Option<WorkerGuard> {
    let _ = std::fs::create_dir_all(dir);
    let _ = LOG_DIR.set(dir.to_path_buf());
    let _ = STARTED_AT.set(Instant::now());

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("ganban-server")
        .filename_suffix("log")
        .build(dir)
        // Fall back to the convenience form if the builder ever rejects the dir.
        .unwrap_or_else(|_| tracing_appender::rolling::daily(dir, "ganban-server.log"));
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info,ganban_server=debug,ganban_core=debug"))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(non_blocking);
    let stdout_layer = fmt::layer().with_target(false);

    let installed = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stdout_layer)
        .try_init()
        .is_ok();

    if !installed {
        return None;
    }
    install_panic_hook();
    tracing::info!("logging initialized → {}", dir.display());
    Some(guard)
}

/// Route panics through `tracing::error!` (so they land in the log file) while
/// still chaining to the previous hook (default abort/backtrace behavior).
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        tracing::error!(target: "panic", location = %location, "PANIC: {message}");
        previous(info);
    }));
}
