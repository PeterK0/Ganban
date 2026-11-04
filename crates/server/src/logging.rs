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

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::prelude::*;
use tracing_subscriber::fmt::MakeWriter;
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
        .with_writer(Scrubbed(non_blocking));
    let stdout_layer = fmt::layer().with_target(false).with_writer(Scrubbed(io::stdout));

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

/// Query parameters whose value is a credential. Matched only right after a
/// `?` or `&`, i.e. inside a URL, so "exit code=1" in prose stays.
const SECRET_PARAMS: &[&str] = &[
    "api_key", "apikey", "api-key", "key", "token", "access_token", "refresh_token", "id_token", "client_secret",
    "secret", "password", "passwd", "pass", "sig", "signature", "code", "code_verifier", "auth",
];
/// Names that mean a credential even outside a URL ("password=hunter2" in a
/// formatted error). Ambiguous words ("code", "key") are left to URLs.
const SECRET_WORDS: &[&str] = &[
    "api_key", "apikey", "token", "access_token", "refresh_token", "client_secret", "secret", "password", "passwd",
];
const REDACTED: &str = "\u{2039}redacted\u{203a}";

/// Blank credentials in a log line: secret-named URL query values (an API key
/// riding in a request URL that an error message quotes), `name=value` pairs
/// with an unambiguous secret name, the password in a URL's `user:pass@`, and
/// `Bearer`/`Basic` credentials. Every log line passes through this on its way
/// to the file and stdout. It's a backstop for a caller that formats a raw
/// error, not a licence to log secrets: JSON bodies and headers in other
/// shapes aren't recognised.
pub fn scrub_secrets(line: &str) -> Cow<'_, str> {
    let lower = line.to_ascii_lowercase();
    if !line.contains('=') && !line.contains('@') && !lower.contains("bearer") && !lower.contains("basic") {
        return Cow::Borrowed(line);
    }
    let bytes = line.as_bytes();
    let ends_value = |b: u8| b.is_ascii_whitespace() || matches!(b, b'&' | b'"' | b'\'' | b')' | b'>' | b'<' | b',' | b'#' | 0x01);
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let is_name = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-';
    while i < line.len() {
        // `name=value` after `?`/`&` (a URL) or at a word start (prose).
        let in_url = bytes[i] == b'?' || bytes[i] == b'&';
        let word_start = (i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'(' | b'"' | b'\'' | b',')) && is_name(&bytes[i]);
        if in_url || word_start {
            let name_at = if in_url { i + 1 } else { i };
            let rest = &lower[name_at..];
            let name_len = rest.bytes().take_while(is_name).count();
            let name = &rest[..name_len];
            let secret = if in_url { SECRET_PARAMS.contains(&name) } else { SECRET_WORDS.contains(&name) };
            if rest.as_bytes().get(name_len) == Some(&b'=') && secret {
                let value_at = name_at + name_len + 1;
                out.push_str(&line[i..value_at]);
                let mut j = value_at;
                while j < line.len() && !ends_value(bytes[j]) {
                    j += 1;
                }
                if j > value_at {
                    out.push_str(REDACTED);
                }
                i = j;
                continue;
            }
        }
        // The password in `scheme://user:pass@host`.
        if lower[i..].starts_with("://") {
            let auth_at = i + 3;
            let end = line[auth_at..].find(|c: char| c == '/' || c.is_whitespace()).map_or(line.len(), |e| auth_at + e);
            if let Some(at) = line[auth_at..end].rfind('@').map(|a| auth_at + a) {
                if let Some(colon) = line[auth_at..at].find(':').map(|c| auth_at + c) {
                    out.push_str(&line[i..=colon]);
                    out.push_str(REDACTED);
                    i = at;
                    continue;
                }
            }
        }
        // Bearer anywhere; Basic only as an Authorization header's value, as
        // "basic" is an ordinary word.
        let scheme = ["bearer ", "basic "]
            .into_iter()
            .find(|p| lower[i..].starts_with(p) && (*p == "bearer " || lower[..i].trim_end().ends_with("authorization:")));
        if let Some(scheme) = scheme {
            let token_at = i + scheme.len();
            out.push_str(&line[i..token_at]);
            let mut j = token_at;
            while j < line.len() && !ends_value(bytes[j]) {
                j += 1;
            }
            if j > token_at {
                out.push_str(REDACTED);
            }
            i = j;
            continue;
        }
        let ch = line[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8().max(1);
    }
    Cow::Owned(out)
}

/// A log writer that runs every formatted event through [`scrub_secrets`].
/// `tracing_subscriber::fmt` formats an event into one buffer and writes it in
/// one call, so each `write` here sees whole lines.
struct Scrubbed<M>(M);

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for Scrubbed<M> {
    type Writer = ScrubWriter<M::Writer>;
    fn make_writer(&'a self) -> Self::Writer {
        ScrubWriter(self.0.make_writer())
    }
}

struct ScrubWriter<W>(W);

impl<W: io::Write> io::Write for ScrubWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.0.write_all(scrub_secrets(&text).as_bytes())?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scrubs_keys_in_urls_and_bearer_tokens() {
        let line = "giphy: error sending request for url (https://api.giphy.com/v1/gifs/search?api_key=SeCrEt123&limit=24&q=cat)";
        let out = scrub_secrets(line);
        assert!(!out.contains("SeCrEt123"), "{out}");
        assert!(out.contains("api_key=\u{2039}redacted\u{203a}&limit=24&q=cat)"), "other params stay: {out}");
        let out = scrub_secrets("GET /x?token=abc.def-ghi HTTP/1.1 Authorization: Bearer ya29.A0ARrdaM");
        assert!(!out.contains("abc.def") && !out.contains("ya29"), "{out}");
        let out = scrub_secrets("user=me@x.com\x01auth=Bearer tok_123\x01\x01");
        assert!(!out.contains("tok_123"), "{out}");
        let out = scrub_secrets("login failed: password=hunter2 token=abc (refresh_token=rt1)");
        assert!(!out.contains("hunter2") && !out.contains("abc") && !out.contains("rt1"), "{out}");
        let out = scrub_secrets("could not reach https://ann:s3cret@mail.example.com/x and Authorization: Basic YW5uOnMzY3JldA==");
        assert!(!out.contains("s3cret") && !out.contains("YW5u"), "{out}");
        assert!(out.contains("https://ann:") && out.contains("@mail.example.com/x"), "the rest of the URL stays: {out}");
    }

    #[test]
    fn leaves_ordinary_lines_alone() {
        for line in [
            "routine ecb_rates ran: 31 rates",
            "process exited with code=1",
            "listening on 0.0.0.0:8765 — ok ✓",
            "synced me@example.com: 4 new",
            "basic plan, key=value pairs ok",
        ] {
            assert_eq!(scrub_secrets(line), line);
        }
    }

    #[test]
    fn the_log_writer_scrubs_what_it_writes() {
        let mut sink = Vec::new();
        {
            let mut w = ScrubWriter(&mut sink);
            let line = b"fetch failed: https://h.example/a?key=K3Y&x=1\n";
            assert_eq!(w.write(line).unwrap(), line.len(), "reports the caller's length");
        }
        let written = String::from_utf8(sink).unwrap();
        assert!(!written.contains("K3Y") && written.ends_with("&x=1\n"), "{written}");
    }
}
