//! Workflows (PROTOCOLS.md §6) — the composition layer's DURABLE substrate.
//!
//! A workflow is an ordered list of steps, each `{task_class → protocol,
//! input_mapping, on_reject}`. The one hard design decision, made at design
//! time and enforced here:
//!
//! **A gated write mid-workflow SUSPENDS the run.** The step's proposal parks
//! the run in `waiting_approval`; approval resumes it; rejection takes the
//! step's declared `on_reject` (stop, or continue past). Workflows never
//! bypass the gate — which is exactly why run state MUST be durable (a
//! suspended run has to survive a restart while the human thinks).
//!
//! One `record_agent_action` row per step (the budget meter covers multi-step
//! cost for free — `workflow_step_runs.agent_action_id` links them) plus a
//! summarizing run row here.
//!
//! The **idempotency key** lands with these tables, not with the first
//! external-side-effect consumer (the Epoch J booking case): the moment a
//! step's side effect lives outside our database, re-running a resumed step
//! must be detectable. Unique when present; NULL for pure-internal steps.
//!
//! This module is the schema + state machine. The step RUNNER (dispatching
//! each step through `dispatch_agent_task`) and the builder UI arrive with
//! the first multi-step protocol — v1 proves the artifact on single steps.

use crate::db::Db;
use crate::error::{AppError, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_slug: String,
    /// The protocol/workflow definition version this run pinned at start —
    /// a definition edit mid-run must not change a running run's behavior.
    pub version: i64,
    /// "running" | "waiting_approval" | "done" | "failed"
    pub status: String,
    /// 0-based index of the step currently executing / suspended.
    pub current_step: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Per-node `{status, preview, note}` log stored at run end (previews only).
    #[sqlx(default)]
    #[serde(default)]
    pub results_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkflowStepRun {
    pub id: i64,
    pub run_id: i64,
    pub step: i64,
    /// "running" | "waiting_approval" | "done" | "rejected" | "failed" | "skipped"
    pub status: String,
    /// The ledger row this step's dispatch wrote (cost roll-up = a join).
    pub agent_action_id: Option<i64>,
    /// Mandatory the moment a step's side effect lives outside our DB.
    pub idempotency_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Start a durable run.
pub async fn create_run(db: &Db, workflow_slug: &str, version: i64) -> Result<i64> {
    let res = sqlx::query("INSERT INTO workflow_runs (workflow_slug, version, status, current_step) VALUES (?, ?, 'running', 0)")
        .bind(workflow_slug)
        .bind(version)
        .execute(db)
        .await?;
    Ok(res.last_insert_rowid())
}

/// Begin one step of a run. Refuses a duplicate idempotency key OUTRIGHT —
/// that is the whole point of carrying one.
pub async fn begin_step(db: &Db, run_id: i64, step: i64, idempotency_key: Option<&str>) -> Result<i64> {
    if let Some(key) = idempotency_key {
        let dup: Option<i64> = sqlx::query_scalar("SELECT id FROM workflow_step_runs WHERE idempotency_key = ?")
            .bind(key)
            .fetch_optional(db)
            .await?;
        if let Some(id) = dup {
            return Err(AppError::InvalidInput(format!(
                "idempotency key '{key}' was already used by step run {id} — this step already ran"
            )));
        }
    }
    let res = sqlx::query("INSERT INTO workflow_step_runs (run_id, step, status, idempotency_key) VALUES (?, ?, 'running', ?)")
        .bind(run_id)
        .bind(step)
        .bind(idempotency_key)
        .execute(db)
        .await?;
    sqlx::query("UPDATE workflow_runs SET current_step = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(step)
        .bind(run_id)
        .execute(db)
        .await?;
    Ok(res.last_insert_rowid())
}

/// Link the ledger row a step's dispatch wrote (cost roll-up = a join).
pub async fn attach_step_action(db: &Db, step_run_id: i64, agent_action_id: i64) -> Result<()> {
    sqlx::query("UPDATE workflow_step_runs SET agent_action_id = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(agent_action_id)
        .bind(step_run_id)
        .execute(db)
        .await?;
    Ok(())
}

/// A step proposed a gated write → the RUN parks until the human decides.
/// Never bypassed, never auto-resumed.
pub async fn suspend_for_approval(db: &Db, run_id: i64, step_run_id: i64) -> Result<()> {
    sqlx::query("UPDATE workflow_step_runs SET status = 'waiting_approval', updated_at = datetime('now') WHERE id = ?")
        .bind(step_run_id)
        .execute(db)
        .await?;
    sqlx::query("UPDATE workflow_runs SET status = 'waiting_approval', updated_at = datetime('now') WHERE id = ?")
        .bind(run_id)
        .execute(db)
        .await?;
    Ok(())
}

/// The human decided. `approved` resumes the run; a rejection takes the
/// step's declared `on_reject`: `continue_past = true` skips the step and
/// keeps going, `false` fails the whole run (stop).
pub async fn resolve_approval(db: &Db, run_id: i64, step_run_id: i64, approved: bool, continue_past: bool) -> Result<()> {
    let (step_status, run_status) = match (approved, continue_past) {
        (true, _) => ("done", "running"),
        (false, true) => ("rejected", "running"),
        (false, false) => ("rejected", "failed"),
    };
    sqlx::query("UPDATE workflow_step_runs SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(step_status)
        .bind(step_run_id)
        .execute(db)
        .await?;
    sqlx::query("UPDATE workflow_runs SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(run_status)
        .bind(run_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Terminal transitions for a step + optionally the run.
pub async fn complete_step(db: &Db, step_run_id: i64) -> Result<()> {
    sqlx::query("UPDATE workflow_step_runs SET status = 'done', updated_at = datetime('now') WHERE id = ?")
        .bind(step_run_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Terminal status for a run: "done" | "partial" (finished, but some nodes
/// failed — the outcome still exists, so calling it "failed" was a lie the
/// user rightly objected to) | "failed".
pub async fn finish_run(db: &Db, run_id: i64, status: &str) -> Result<()> {
    sqlx::query("UPDATE workflow_runs SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status)
        .bind(run_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn get_run(db: &Db, run_id: i64) -> Result<Option<WorkflowRun>> {
    Ok(sqlx::query_as("SELECT * FROM workflow_runs WHERE id = ?").bind(run_id).fetch_optional(db).await?)
}

pub async fn run_steps(db: &Db, run_id: i64) -> Result<Vec<WorkflowStepRun>> {
    Ok(sqlx::query_as("SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY step")
        .bind(run_id)
        .fetch_all(db)
        .await?)
}

/// Runs parked on a human decision — the restart-survival read: whatever
/// process comes back up can list what is still waiting.
/// The newest runs across all workflows — the monitoring feed.
/// Store the per-node log on a finished run (previews only, small).
pub async fn save_run_results(db: &Db, run_id: i64, results_json: &str) -> Result<()> {
    sqlx::query("UPDATE workflow_runs SET results_json = ? WHERE id = ?")
        .bind(results_json)
        .bind(run_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Boot-time reconcile: a 'running' row cannot survive a process restart —
/// the run died with the process (zombie "running" rows in the Bridge feed).
/// 'waiting_approval' rows are durable suspensions and are left alone.
pub async fn reconcile_interrupted(db: &Db) -> Result<u64> {
    let r = sqlx::query(
        "UPDATE workflow_runs SET status = 'failed', updated_at = datetime('now') WHERE status = 'running'",
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

pub async fn recent_runs(db: &Db, limit: i64) -> Result<Vec<WorkflowRun>> {
    Ok(sqlx::query_as::<_, WorkflowRun>(
        "SELECT id, workflow_slug, version, status, current_step, created_at, updated_at, results_json \
         FROM workflow_runs ORDER BY id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(db)
    .await?)
}

pub async fn waiting_runs(db: &Db) -> Result<Vec<WorkflowRun>> {
    Ok(sqlx::query_as("SELECT * FROM workflow_runs WHERE status = 'waiting_approval' ORDER BY updated_at")
        .fetch_all(db)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_wf_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn gated_write_suspends_and_survives_a_restart() {
        let db = test_db("suspend").await;
        let run = create_run(&db, "weekly-digest", 1).await.unwrap();
        let s0 = begin_step(&db, run, 0, None).await.unwrap();
        complete_step(&db, s0).await.unwrap();

        // Step 1 proposes a gated write → the run PARKS.
        let s1 = begin_step(&db, run, 1, None).await.unwrap();
        suspend_for_approval(&db, run, s1).await.unwrap();
        assert_eq!(get_run(&db, run).await.unwrap().unwrap().status, "waiting_approval");

        // "Restart": a fresh reader finds the parked run purely from the DB.
        let waiting = waiting_runs(&db).await.unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].id, run);
        assert_eq!(waiting[0].current_step, 1);

        // Approval resumes it.
        resolve_approval(&db, run, s1, true, false).await.unwrap();
        assert_eq!(get_run(&db, run).await.unwrap().unwrap().status, "running");
        finish_run(&db, run, "done").await.unwrap();
        assert_eq!(get_run(&db, run).await.unwrap().unwrap().status, "done");
    }

    #[tokio::test]
    async fn rejection_takes_the_declared_on_reject() {
        let db = test_db("reject").await;
        // stop: rejection fails the whole run.
        let run = create_run(&db, "wf", 1).await.unwrap();
        let s = begin_step(&db, run, 0, None).await.unwrap();
        suspend_for_approval(&db, run, s).await.unwrap();
        resolve_approval(&db, run, s, false, false).await.unwrap();
        assert_eq!(get_run(&db, run).await.unwrap().unwrap().status, "failed");

        // continue: rejection skips the step, the run keeps going.
        let run2 = create_run(&db, "wf", 1).await.unwrap();
        let s2 = begin_step(&db, run2, 0, None).await.unwrap();
        suspend_for_approval(&db, run2, s2).await.unwrap();
        resolve_approval(&db, run2, s2, false, true).await.unwrap();
        assert_eq!(get_run(&db, run2).await.unwrap().unwrap().status, "running");
        let steps = run_steps(&db, run2).await.unwrap();
        assert_eq!(steps[0].status, "rejected");
    }

    #[tokio::test]
    async fn idempotency_key_refuses_a_replay() {
        let db = test_db("idem").await;
        let run = create_run(&db, "booking", 1).await.unwrap();
        begin_step(&db, run, 0, Some("book-flight-2026-07-02-owner")).await.unwrap();
        // The same external side effect must NOT run twice — refused, not deduped silently.
        let err = begin_step(&db, run, 0, Some("book-flight-2026-07-02-owner")).await.unwrap_err().to_string();
        assert!(err.contains("already"), "duplicate key must be refused: {err}");
        // A different key is a different effect.
        begin_step(&db, run, 1, Some("book-hotel-2026-07-02-owner")).await.unwrap();
    }
}
