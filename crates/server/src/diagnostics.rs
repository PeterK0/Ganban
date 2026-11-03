//! Diagnostics bundle (owner-only) for the bug reporter.
//!
//! Assembles a **redacted, local-first** snapshot of the host's recent state:
//! versions, platform, uptime, the tail of the server + AI-engine logs, and a
//! slim view of the action ledger. It reads only — it executes nothing — and is
//! gated to the owner at the route. The user reviews it before sharing; nothing
//! is uploaded from here.

use std::path::{Path, PathBuf};

use ganban_core::{ops, Db};
use serde_json::{json, Value};

use crate::logging;

/// How many trailing lines of each log file to include.
const LOG_TAIL_LINES: usize = 200;
const ENGINE_TAIL_LINES: usize = 80;
/// How many recent ledger entries to summarize.
const LEDGER_LIMIT: i64 = 50;

/// Collect the full diagnostics bundle. Best-effort: a missing log file or an
/// unreadable ledger degrades to an empty section, never an error.
pub async fn collect(db: &Db) -> Value {
    let dir = logging::log_dir();

    let server_log = dir
        .as_ref()
        .and_then(|d| latest_with_prefix(d, logging::LOG_FILE_PREFIX))
        .map(|p| redact(&tail_file(&p, LOG_TAIL_LINES)))
        .unwrap_or_default();

    let engine_logs = dir.as_ref().map(|d| engine_logs(d)).unwrap_or_default();

    let ledger = ops::list_agent_actions(db, None, LEDGER_LIMIT)
        .await
        .map(|rows| rows.iter().map(slim_action).collect::<Vec<_>>())
        .unwrap_or_default();

    json!({
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "app": { "server_version": env!("CARGO_PKG_VERSION") },
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
        "uptime_secs": logging::uptime_secs(),
        "log_dir": dir.map(|d| d.display().to_string()),
        "server_log_tail": server_log,
        "engine_logs": engine_logs,
        "ledger_recent": ledger,
        "note": "Redacted, read-only snapshot. Review before sharing.",
    })
}

/// A safe, slim ledger row: omits `args_json`/`result_json` (which may carry
/// project content) — only the shape of what the agent did and what it cost.
fn slim_action(a: &ganban_core::models::AgentAction) -> Value {
    json!({
        "id": a.id,
        "at": a.created_at.to_rfc3339(),
        "status": a.status,
        "tool": a.tool,
        "summary": redact(&a.summary),
        "project_id": a.project_id,
        "routine_id": a.routine_id,
        "model": a.model,
        "prompt_tokens": a.prompt_tokens,
        "completion_tokens": a.completion_tokens,
        "duration_ms": a.duration_ms,
    })
}

/// Tails of every `*-engine.log` file in the log dir (ragrat, ollama, …).
fn engine_logs(dir: &Path) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with("-engine.log") {
            out.push(json!({
                "name": name,
                "tail": redact(&tail_file(&entry.path(), ENGINE_TAIL_LINES)),
            }));
        }
    }
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// Read a full log file for download. `requested` is a bare filename (basename
/// only — no path traversal); defaults to the newest server log. Returns
/// `(filename, redacted contents)`, or `None` if it doesn't exist / isn't a log.
pub fn read_log_file(requested: Option<&str>) -> Option<(String, String)> {
    let dir = logging::log_dir()?;
    let path = match requested {
        Some(name) => {
            // Strip any directory components, then require a .log in OUR dir.
            let base = Path::new(name).file_name()?.to_string_lossy().to_string();
            if !base.ends_with(".log") {
                return None;
            }
            dir.join(base)
        }
        None => latest_with_prefix(&dir, logging::LOG_FILE_PREFIX)?,
    };
    let content = std::fs::read_to_string(&path).ok()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    Some((name, redact(&content)))
}

/// The newest file in `dir` whose name starts with `prefix` (handles the daily
/// rotation suffix on the server log).
fn latest_with_prefix(dir: &Path, prefix: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

/// Last `n` lines of a (possibly large) text file, best-effort.
fn tail_file(path: &Path, n: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Dependency-free redaction. Our logs shouldn't contain secrets (tokens stay
/// out of the log by design), but this is defense-in-depth before anything is
/// shown for sharing: it blanks high-entropy token-like words and the value
/// after any secret-ish key.
pub fn redact(input: &str) -> String {
    input
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

const SECRET_KEYS: &[&str] = &[
    "authorization", "bearer", "token", "secret", "password", "passwd",
    "api_key", "apikey", "api-key", "x-api-key", "client_secret", "cookie",
];

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if SECRET_KEYS.iter().any(|k| lower.contains(k)) {
        // Redact the value after the first ':' or '=' (keep the key as a hint).
        if let Some(i) = line.find([':', '=']) {
            let (key, _) = line.split_at(i + 1);
            return format!("{key} \u{2039}redacted\u{203a}");
        }
    }
    // Otherwise blank any individual high-entropy token-like word.
    line.split(' ')
        .map(|w| if looks_secret(w) { "\u{2039}redacted\u{203a}" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Heuristic: a long, mixed alphanumeric run with no path/URL separators — i.e.
/// an API key or bearer token, not a normal word or file path.
fn looks_secret(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if w.len() < 28 {
        return false;
    }
    let mut has_alpha = false;
    let mut has_digit = false;
    for c in w.chars() {
        match c {
            'a'..='z' | 'A'..='Z' => has_alpha = true,
            '0'..='9' => has_digit = true,
            '_' | '-' | '.' => {}
            _ => return false, // spaces/slashes/etc → not a bare token
        }
    }
    has_alpha && has_digit && !w.contains("..") && w.matches('.').count() <= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_keys() {
        let s = "Authorization: Bearer abc123def\napikey=BSAcxDag_uEnGwBC7X0TR-mYd-IeCaa";
        let out = redact(s);
        assert!(out.contains("\u{2039}redacted\u{203a}"));
        assert!(!out.contains("BSAcxDag"));
    }

    #[test]
    fn keeps_normal_log_lines() {
        let s = "re-indexed project 3 (job 12)";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn blanks_loose_high_entropy_token() {
        let s = "value was sk9aZ1xQ77LmNoPq22RsTuVwXy00Bc";
        let out = redact(s);
        assert!(out.contains("\u{2039}redacted\u{203a}"), "got: {out}");
    }
}
