//! Oracle — user-authored automations (the workflow builder's store).
//!
//! An oracle workflow is a small node graph the owner draws in the Assistant's
//! Oracle tab: `{nodes: [{id, type, x, y, params}], wires: [{from, to}]}`.
//! This module stores DEFINITIONS; execution lives in the server's oracle
//! runner, which walks the graph and:
//!
//!  - runs model steps through `dispatch_agent_task` (ledgered, no tools),
//!  - treats fetched web content as UNTRUSTED data (it can flow into a model
//!    step's prompt but never becomes an instruction channel with tools),
//!  - and lands every write as a GATED PROPOSAL — a workflow never bypasses
//!    the approval gate (PROTOCOLS.md §6), it just files the paperwork.
//!
//! Definitions are validated structurally on save (shape, node types, wire
//! endpoints, size) — reject, never coerce. The graph's SEMANTIC catalog
//! (which node types exist, their params) is compiled into the runner; an
//! unknown node type is refused at save time so a stored workflow can always
//! run on the build that saved it.

use crate::db::Db;
use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct OracleWorkflow {
    pub id: i64,
    pub name: String,
    /// 'live' | 'paused'. v1 has no scheduler — the flag is stored so
    /// definitions survive the scheduler landing, but every run is manual.
    pub status: String,
    pub definition_json: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    /// Per-node `{status, preview, note}` of the last run — the Bridge's log.
    #[sqlx(default)]
    pub last_results_json: Option<String>,
}

const MAX_DEFINITION_BYTES: usize = 256 * 1024;
const MAX_NODES: usize = 40;

/// Structural validation: shape, ids, wire endpoints, allowed node types.
/// Returns the parsed definition so callers don't parse twice.
pub fn validate_definition(definition: &str, known_types: &[&str]) -> Result<Value> {
    if definition.len() > MAX_DEFINITION_BYTES {
        return Err(AppError::InvalidInput("workflow definition too large (256KB max)".into()));
    }
    let v: Value = serde_json::from_str(definition)
        .map_err(|e| AppError::InvalidInput(format!("workflow definition is not valid JSON: {e}")))?;
    let nodes = v
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::InvalidInput("definition needs a 'nodes' array".into()))?;
    if nodes.len() > MAX_NODES {
        return Err(AppError::InvalidInput(format!("too many nodes ({} max)", MAX_NODES)));
    }
    let mut ids = std::collections::HashSet::new();
    for n in nodes {
        let id = n
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("every node needs a non-empty string 'id'".into()))?;
        if !ids.insert(id.to_string()) {
            return Err(AppError::InvalidInput(format!("duplicate node id '{id}'")));
        }
        let ty = n
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidInput(format!("node '{id}' needs a 'type'")))?;
        if !known_types.contains(&ty) {
            // Reject, never coerce: a stored workflow must always be runnable
            // on the build that accepted it.
            return Err(AppError::InvalidInput(format!(
                "unknown node type '{ty}' (this build knows: {})",
                known_types.join(", ")
            )));
        }
    }
    let wires = v.get("wires").and_then(Value::as_array).cloned().unwrap_or_default();
    for w in &wires {
        for end in ["from", "to"] {
            let node = w
                .get(end)
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::InvalidInput(format!("every wire needs '{end}'")))?;
            if !ids.contains(node) {
                return Err(AppError::InvalidInput(format!("wire {end} '{node}' is not a node in this workflow")));
            }
        }
    }
    Ok(v)
}

pub async fn list(db: &Db) -> Result<Vec<OracleWorkflow>> {
    Ok(sqlx::query_as::<_, OracleWorkflow>(
        "SELECT id, name, status, definition_json, created_at, updated_at, last_run_at, last_results_json FROM oracle_workflows ORDER BY id",
    )
    .fetch_all(db)
    .await?)
}

pub async fn get(db: &Db, id: i64) -> Result<Option<OracleWorkflow>> {
    Ok(sqlx::query_as::<_, OracleWorkflow>(
        "SELECT id, name, status, definition_json, created_at, updated_at, last_run_at FROM oracle_workflows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?)
}

pub async fn create(db: &Db, name: &str, definition_json: &str) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("a workflow needs a name".into()));
    }
    let res = sqlx::query("INSERT INTO oracle_workflows (name, status, definition_json) VALUES (?, 'paused', ?)")
        .bind(name)
        .bind(definition_json)
        .execute(db)
        .await?;
    Ok(res.last_insert_rowid())
}

pub async fn update(
    db: &Db,
    id: i64,
    name: Option<&str>,
    status: Option<&str>,
    definition_json: Option<&str>,
) -> Result<()> {
    if let Some(s) = status {
        if !matches!(s, "live" | "paused") {
            return Err(AppError::InvalidInput(format!("unknown status '{s}' (live|paused)")));
        }
    }
    let existing = get(db, id).await?.ok_or_else(|| AppError::NotFound("workflow not found".into()))?;
    let name = name.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&existing.name);
    let status = status.unwrap_or(&existing.status);
    let def = definition_json.unwrap_or(&existing.definition_json);
    sqlx::query("UPDATE oracle_workflows SET name = ?, status = ?, definition_json = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(name)
        .bind(status)
        .bind(def)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM oracle_workflows WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

pub async fn touch_run(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE oracle_workflows SET last_run_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// The FULL node outputs of the last run (`{node_id: output_string}`), or
/// None if it never ran. This is what a partial re-run freezes: nodes
/// upstream of the re-run point replay from here — no re-fetching the world
/// just to debug the tail of a workflow.
pub async fn outputs(db: &Db, id: i64) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT last_outputs_json FROM oracle_workflows WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .flatten())
}

pub async fn save_outputs(db: &Db, id: i64, outputs_json: &str) -> Result<()> {
    sqlx::query("UPDATE oracle_workflows SET last_outputs_json = ? WHERE id = ?")
        .bind(outputs_json)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Persist the last run's per-node results (status/preview/note) — the
/// durable run LOG, as opposed to `save_outputs` (the raw memory for replays).
pub async fn save_results(db: &Db, id: i64, results_json: &str) -> Result<()> {
    sqlx::query("UPDATE oracle_workflows SET last_results_json = ? WHERE id = ?")
        .bind(results_json)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPES: &[&str] = &["trigger.manual", "fetch.http", "llm.transform", "write.comment"];

    #[test]
    fn validation_rejects_never_coerces() {
        // Unknown node type → refused with the allowlist named.
        let bad = r#"{"nodes":[{"id":"a","type":"exec.shell"}],"wires":[]}"#;
        let err = validate_definition(bad, TYPES).unwrap_err().to_string();
        assert!(err.contains("unknown node type 'exec.shell'"), "{err}");

        // Dangling wire → refused.
        let bad = r#"{"nodes":[{"id":"a","type":"trigger.manual"}],"wires":[{"from":"a","to":"ghost"}]}"#;
        assert!(validate_definition(bad, TYPES).is_err());

        // Duplicate ids → refused.
        let bad = r#"{"nodes":[{"id":"a","type":"trigger.manual"},{"id":"a","type":"fetch.http"}]}"#;
        assert!(validate_definition(bad, TYPES).is_err());

        // A well-formed graph parses.
        let ok = r#"{"nodes":[{"id":"t","type":"trigger.manual","x":0,"y":0},{"id":"f","type":"fetch.http","params":{"url":"https://example.com"}}],"wires":[{"from":"t","to":"f"}]}"#;
        assert!(validate_definition(ok, TYPES).is_ok());
    }

    #[tokio::test]
    async fn crud_round_trip() {
        let path = std::env::temp_dir().join(format!("ganban_oracle_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::db::init_db(&path).await.unwrap();

        let def = r#"{"nodes":[{"id":"t","type":"trigger.manual"}],"wires":[]}"#;
        let id = create(&db, "Bunker prices", def).await.unwrap();
        let w = get(&db, id).await.unwrap().unwrap();
        assert_eq!(w.name, "Bunker prices");
        assert_eq!(w.status, "paused");

        update(&db, id, Some("Bunker → DB"), Some("live"), None).await.unwrap();
        let w = get(&db, id).await.unwrap().unwrap();
        assert_eq!(w.name, "Bunker → DB");
        assert_eq!(w.status, "live");
        assert_eq!(w.definition_json, def, "definition untouched by a metadata update");

        assert!(update(&db, id, None, Some("bogus"), None).await.is_err());

        delete(&db, id).await.unwrap();
        assert!(get(&db, id).await.unwrap().is_none());
        assert_eq!(list(&db).await.unwrap().len(), 0);
    }
}
