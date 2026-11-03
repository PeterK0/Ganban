//! Routines v1: scheduled agent work as stored records, not code paths.
//!
//! A routine row (see `ganban_core::models::Routine`) is the spec; this module
//! is the runner. Triggers are **catch-up-on-launch** shaped — the desktop app
//! starts and stops, so "daily at 7am" is meaningless. Instead: "run on launch
//! if the last run is older than N hours", re-checked periodically so a session
//! left open overnight still catches up. Every run is stamped on the routine
//! and appended to the `agent_actions` ledger (routine_id set), so the activity
//! view shows what ran unattended.

use chrono::Utc;
use ganban_core::error::AppError;
use ganban_core::models::Routine;
use ganban_core::{ops, Db};
use serde_json::{json, Value};

use crate::ollama::OllamaClient;
use crate::rag::RagClient;
use crate::secretary;

/// Give the supervised engines (Ollama/ragrat) time to come up after launch
/// before the first catch-up check.
const LAUNCH_DELAY_SECS: u64 = 90;
/// Re-check cadence for sessions that stay open across a trigger boundary.
const RECHECK_SECS: u64 = 30 * 60;

/// Whether a routine's catch-up trigger fires now: enabled, an
/// `on_launch_after_hours` trigger configured, and never run or run too long
/// ago. No trigger key = manual-only.
pub fn is_due(routine: &Routine, now: chrono::DateTime<Utc>) -> bool {
    if !routine.enabled {
        return false;
    }
    let trigger: Value = serde_json::from_str(&routine.trigger_json).unwrap_or(Value::Null);
    let Some(hours) = trigger.get("on_launch_after_hours").and_then(Value::as_i64).filter(|h| *h > 0) else {
        return false;
    };
    match routine.last_run_at {
        None => true,
        Some(last) => now - last >= chrono::Duration::hours(hours),
    }
}

/// Run one routine now (manual or catch-up): dispatch on `kind`, stamp
/// `last_run_at`, and ledger the run. Returns the kind's result payload.
pub async fn run_routine(
    db: &Db,
    ollama: &OllamaClient,
    rag: Option<&RagClient>,
    routine: &Routine,
) -> Result<Value, AppError> {
    let (result, run_model, run_usage) = match routine.kind.as_str() {
        "rundown" => {
            // Summarize with the active profile's model (projects with their own
            // profile use that — see secretary::generate_rundown).
            let (params, _system) = crate::resolve_profile(db, None).await;
            let rundown = secretary::generate_rundown(db, ollama, rag, &params.model).await?;
            (
                json!({ "projects": rundown.projects.len(), "omitted": rundown.omitted, "run_date": rundown.run_date }),
                Some(params.model),
                rundown.usage,
            )
        }
        other => return Err(AppError::InvalidInput(format!("unknown routine kind '{other}'"))),
    };
    ops::set_routine_last_run(db, routine.id).await?;
    // Routines run as the owner (they're the owner's standing instructions).
    let owner = ganban_core::auth::ensure_owner(db).await?;
    if let Err(e) = ops::record_agent_action(db, ops::NewAgentAction {
        status: "applied",
        user_id: owner,
        profile_id: None,
        project_id: None, // cross-project work
        chat_id: None,
        routine_id: Some(routine.id),
        tool: routine.kind.as_str(),
        summary: &format!("Routine “{}” ran", routine.name),
        args_json: &routine.trigger_json,
        result_json: Some(&result.to_string()),
        // Capacity meter: what the run cost (zeroes = deterministic fallbacks).
        model: run_model.as_deref(),
        prompt_tokens: Some(run_usage.prompt_tokens),
        completion_tokens: Some(run_usage.completion_tokens),
        duration_ms: Some(run_usage.duration_ms),
        protocol_slug: None,
        protocol_version: None,
        content_hash: None,
        parent_action_id: None,
        approver_id: None,
    })
    .await
    {
        tracing::warn!("ran '{}' but could not ledger it: {e}", routine.name);
    }
    Ok(result)
}

/// Background catch-up loop: shortly after launch (and every `RECHECK_SECS`
/// thereafter), run every routine whose trigger is due. Best-effort — a failed
/// run logs and is retried on the next check rather than aborting the loop.
///
/// `stop` is the owning daemon's lifetime: exit when it fires or its sender is
/// dropped. Without it, a daemon restart/upgrade leaks a second runner — and
/// two runners race the due-check before either stamps `last_run_at`, running
/// the rundown twice.
pub fn spawn_runner(
    db: Db,
    rag: crate::rag::SharedRag,
    ollama: crate::ollama::SharedOllama,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(LAUNCH_DELAY_SECS)) => {}
            _ = stop.changed() => return,
        }
        loop {
            let routines = ops::list_routines(&db).await.unwrap_or_default();
            let due: Vec<Routine> = routines.into_iter().filter(|r| is_due(r, Utc::now())).collect();
            if !due.is_empty() {
                let client = ollama.read().await.clone();
                let rag_client = rag.read().await.clone();
                if let Some(client) = client {
                    for r in &due {
                        match run_routine(&db, &client, rag_client.as_ref(), r).await {
                            Ok(_) => tracing::info!("catch-up ran '{}'", r.name),
                            Err(e) => tracing::warn!("'{}' failed (will retry next check): {e}", r.name),
                        }
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(RECHECK_SECS)) => {}
                _ = stop.changed() => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::{OllamaClient, OllamaConfig};

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_routines_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn the_daily_rundown_routine_is_seeded() {
        let db = test_db("seed").await;
        let r = ops::routine_by_kind(&db, "rundown").await.unwrap().expect("seeded by migration");
        assert_eq!(r.name, "Daily rundown");
        assert!(r.enabled);
        assert!(r.trigger_json.contains("on_launch_after_hours"));
        assert!(r.last_run_at.is_none(), "never run on a fresh DB");
    }

    #[tokio::test]
    async fn catch_up_trigger_fires_only_when_stale() {
        let db = test_db("due").await;
        let mut r = ops::routine_by_kind(&db, "rundown").await.unwrap().unwrap();
        let now = Utc::now();

        assert!(is_due(&r, now), "never run → due");
        r.last_run_at = Some(now - chrono::Duration::hours(1));
        assert!(!is_due(&r, now), "ran an hour ago (trigger: 12h) → not due");
        r.last_run_at = Some(now - chrono::Duration::hours(13));
        assert!(is_due(&r, now), "ran yesterday → due");
        r.enabled = false;
        assert!(!is_due(&r, now), "disabled → never due");
        r.enabled = true;
        r.trigger_json = "{}".into();
        assert!(!is_due(&r, now), "no trigger key → manual-only");
    }

    #[tokio::test]
    async fn running_the_rundown_routine_stamps_and_ledgers_the_run() {
        // No active projects → generate_rundown makes no model calls, so a
        // never-contacted OllamaClient is safe here.
        let db = test_db("run").await;
        let routine = ops::routine_by_kind(&db, "rundown").await.unwrap().unwrap();
        let client = OllamaClient::new(OllamaConfig::from_db(&db).await);

        let out = run_routine(&db, &client, None, &routine).await.unwrap();
        assert_eq!(out["projects"], 0);

        let after = ops::get_routine(&db, routine.id).await.unwrap().unwrap();
        assert!(after.last_run_at.is_some(), "last run stamped");
        assert!(!is_due(&after, Utc::now()), "a fresh run is not due again");

        let trail = ops::list_agent_actions(&db, None, 10).await.unwrap();
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0].routine_id, Some(routine.id));
        assert_eq!(trail[0].project_id, None, "cross-project run");
        assert_eq!(trail[0].status, "applied");
    }
}
