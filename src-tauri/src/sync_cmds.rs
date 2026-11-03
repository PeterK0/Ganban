//! Desktop-only: offline-sync local-DB commands. HTTP (GET /sync/pull, POST
//! /sync/push) is orchestrated in TypeScript via the existing `daemonFetch`
//! (timeout / 401 handling already there); these wrap `ganban_core::sync` so all
//! SQL stays in core. The desktop pool is opened as `Role::Replica`, so its
//! change-capture triggers + bookkeeping tables back these calls.

use ganban_core::{sync, Db};
use serde_json::Value;
use tauri::State;

/// Collect the replica's pending changes (dirty upserts + local deletes) to POST
/// to the host's /sync/push.
#[tauri::command]
pub async fn sync_collect(pool: State<'_, Db>) -> Result<Vec<Value>, String> {
    sync::local_pending(pool.inner()).await.map_err(|e| e.to_string())
}

/// Apply the host's pulled changes locally (echo-guarded inside the engine) and
/// persist any field-level conflicts for review. Returns the apply report
/// ({ applied, conflicts, rejected, id_remap }).
#[tauri::command]
pub async fn sync_ingest(pool: State<'_, Db>, changes: Vec<Value>) -> Result<Value, String> {
    let parsed: Vec<sync::IncomingChange> =
        serde_json::from_value(Value::Array(changes)).map_err(|e| e.to_string())?;
    let report = sync::ingest(pool.inner(), parsed).await.map_err(|e| e.to_string())?;
    if let Some(conflicts) = report.get("conflicts").and_then(|c| c.as_array()) {
        if !conflicts.is_empty() {
            sync::record_conflicts(pool.inner(), conflicts.clone()).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(report)
}

/// Settle local bookkeeping after a successful push (clear dirty / drop
/// tombstones via compare-and-clear) and persist any conflicts the host
/// reported back.
#[tauri::command]
pub async fn sync_ack(pool: State<'_, Db>, acked: Vec<Value>, conflicts: Vec<Value>) -> Result<(), String> {
    let items: Vec<sync::AckItem> =
        serde_json::from_value(Value::Array(acked)).map_err(|e| e.to_string())?;
    sync::ack(pool.inner(), items).await.map_err(|e| e.to_string())?;
    if !conflicts.is_empty() {
        sync::record_conflicts(pool.inner(), conflicts).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The pending field-level conflicts for the review UI.
#[tauri::command]
pub async fn get_sync_conflicts(pool: State<'_, Db>) -> Result<Vec<Value>, String> {
    sync::get_conflicts(pool.inner()).await.map_err(|e| e.to_string())
}

/// Apply the user's chosen resolution (a map of field -> value) and clear the
/// conflict; the decision re-syncs to the host on the next run.
#[tauri::command]
pub async fn resolve_sync_conflict(
    pool: State<'_, Db>,
    sync_uuid: String,
    resolved: serde_json::Map<String, Value>,
) -> Result<(), String> {
    sync::resolve_conflict(pool.inner(), &sync_uuid, resolved).await.map_err(|e| e.to_string())
}

/// At-a-glance counts (dirty rows, pending tombstones, unresolved conflicts).
#[tauri::command]
pub async fn sync_status(pool: State<'_, Db>) -> Result<Value, String> {
    sync::status(pool.inner()).await.map_err(|e| e.to_string())
}
