//! P2.2g — full sync round trip at the core level (what syncNow() drives over
//! HTTP+Tauri): pull -> ingest -> collect -> push -> ack, and convergence.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_rt_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

/// One sync_now run from the replica's perspective. Returns (ingest, push) reports.
async fn sync_run(host: &Db, replica: &Db, cursor: &mut String) -> (Value, Value) {
    // PULL
    let pulled = sync::pull(host, cursor).await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(pulled["changes"].clone()).unwrap();
    // INGEST
    let ingest = sync::ingest(replica, changes).await.unwrap();
    // persist cursor only after ingest
    *cursor = pulled["cursor"].as_str().unwrap().to_string();
    // COLLECT
    let pending = sync::local_pending(replica).await.unwrap();
    // PUSH
    let push = if pending.is_empty() {
        json!({ "applied": [], "conflicts": [], "rejected": [], "id_remap": {} })
    } else {
        let pchanges: Vec<sync::IncomingChange> = serde_json::from_value(Value::Array(pending.clone())).unwrap();
        sync::push(host, pchanges).await.unwrap()
    };
    // ACK confirmed
    let applied: HashSet<String> =
        push["applied"].as_array().unwrap().iter().filter_map(|v| v.as_str().map(String::from)).collect();
    let ack_items: Vec<Value> = pending
        .iter()
        .filter(|c| applied.contains(c["sync_uuid"].as_str().unwrap_or_default()))
        .map(|c| {
            json!({
                "entity": c["entity"], "sync_uuid": c["sync_uuid"],
                "op": c.get("op").cloned().unwrap_or_else(|| json!("upsert")),
                "pushed_updated_at": c["data"].get("updated_at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    sync::ack(replica, serde_json::from_value(Value::Array(ack_items)).unwrap()).await.unwrap();
    // record conflicts from both directions (what the orchestrator persists)
    let mut conflicts: Vec<Value> = ingest["conflicts"].as_array().cloned().unwrap_or_default();
    conflicts.extend(push["conflicts"].as_array().cloned().unwrap_or_default());
    if !conflicts.is_empty() {
        sync::record_conflicts(replica, conflicts).await.unwrap();
    }
    (ingest, push)
}

async fn status_of(db: &Db, table: &str, t_uuid: &str) -> (String, String) {
    sqlx::query_as(&format!("SELECT status, priority FROM {table} WHERE sync_uuid=?"))
        .bind(t_uuid)
        .fetch_one(db)
        .await
        .unwrap()
}

/// Stand up host + replica sharing the same task (replica bootstrapped by an
/// initial full-snapshot ingest), and return the task's sync_uuid + cursor.
async fn paired(tag: &str) -> (Db, Db, String, String) {
    let host = init_db_role(&temp_db(&format!("{tag}_host")), Role::Server).await.unwrap();
    let pid = ops::create_project(&host, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let tid = ops::create_task(
        &host,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "T".into(),
            description: None,
            status: "To Do".into(),
            priority: "Medium".into(),
            prefix: None,
            cost: None,
            currency: None,
            deadline: None,
        },
    )
    .await
    .unwrap()
    .id;
    let t_uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM tasks WHERE id=?").bind(tid).fetch_one(&host).await.unwrap();

    // Bootstrap the replica from a full snapshot.
    let replica = init_db_role(&temp_db(&format!("{tag}_replica")), Role::Replica).await.unwrap();
    let full = sync::pull(&host, "").await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(full["changes"].clone()).unwrap();
    sync::ingest(&replica, changes).await.unwrap();
    let cursor = full["cursor"].as_str().unwrap().to_string();
    (host, replica, t_uuid, cursor)
}

#[tokio::test]
async fn disjoint_edits_converge_in_one_run() {
    let (host, replica, t_uuid, mut cursor) = paired("disjoint").await;

    // Host edits status; replica edits priority (disjoint).
    sqlx::query("UPDATE tasks SET status='Done', updated_at='2099-01-02T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&host)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET priority='High', updated_at='2099-01-01T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&replica)
        .await
        .unwrap();

    let (ingest, push) = sync_run(&host, &replica, &mut cursor).await;
    assert!(ingest["conflicts"].as_array().unwrap().is_empty(), "disjoint => no ingest conflict: {ingest}");
    assert!(push["conflicts"].as_array().unwrap().is_empty(), "disjoint => no push conflict: {push}");

    // Both sides hold the union of the two edits.
    assert_eq!(status_of(&host, "tasks", &t_uuid).await, ("Done".into(), "High".into()), "host converged");
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await, ("Done".into(), "High".into()), "replica converged");

    // A second run is a no-op (nothing left dirty, nothing new to pull).
    let (_, push2) = sync_run(&host, &replica, &mut cursor).await;
    assert!(push2["applied"].as_array().unwrap().is_empty(), "second run pushes nothing");
}

#[tokio::test]
async fn same_field_clash_is_recorded_for_review() {
    let (host, replica, t_uuid, mut cursor) = paired("clash").await;

    sqlx::query("UPDATE tasks SET status='Done', updated_at='2099-01-02T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&host)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET status='In Progress', updated_at='2099-01-01T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&replica)
        .await
        .unwrap();

    let (ingest, _push) = sync_run(&host, &replica, &mut cursor).await;
    assert_eq!(ingest["conflicts"].as_array().unwrap().len(), 1, "same-field edit => conflict");

    let conflicts = sync::get_conflicts(&replica).await.unwrap();
    assert_eq!(conflicts.len(), 1, "conflict persisted for review");
    let c = &conflicts[0];
    assert_eq!(c["clashing_cols"], json!(["status"]));
    assert_eq!(c["local"]["status"], "In Progress");
    assert_eq!(c["server"]["status"], "Done");

    // The local edit is preserved pending the user's decision.
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await.0, "In Progress");
}

#[tokio::test]
async fn host_only_change_lands_on_replica() {
    let (host, replica, t_uuid, mut cursor) = paired("hostonly").await;
    sqlx::query("UPDATE tasks SET status='Done', updated_at='2099-01-02T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&host)
        .await
        .unwrap();

    let (ingest, _) = sync_run(&host, &replica, &mut cursor).await;
    assert!(ingest["conflicts"].as_array().unwrap().is_empty());
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await.0, "Done", "clean host change applied to replica");
}

#[tokio::test]
async fn local_only_change_lands_on_host() {
    let (host, replica, t_uuid, mut cursor) = paired("localonly").await;
    sqlx::query("UPDATE tasks SET status='In Progress', updated_at='2099-01-01T00:00:00.000000Z' WHERE sync_uuid=?")
        .bind(&t_uuid)
        .execute(&replica)
        .await
        .unwrap();

    let (_, push) = sync_run(&host, &replica, &mut cursor).await;
    assert_eq!(push["applied"].as_array().unwrap().len(), 1, "replica change pushed");
    assert_eq!(status_of(&host, "tasks", &t_uuid).await.0, "In Progress", "local change landed on host");
}

async fn count(db: &Db, sql: &str, uuid: &str) -> i64 {
    sqlx::query_scalar(sql).bind(uuid).fetch_one(db).await.unwrap()
}

#[tokio::test]
async fn replica_delete_vs_host_edit_converges_edit_wins() {
    // Regression for the never-clearing-tombstone / resurrection-loop bug.
    let (host, replica, t_uuid, mut cursor) = paired("deldel").await;
    let now = || chrono::Utc::now().to_rfc3339();
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;

    // Replica deletes the task offline; the host edits it.
    sqlx::query("DELETE FROM tasks WHERE sync_uuid=?").bind(&t_uuid).execute(&replica).await.unwrap();
    sqlx::query("UPDATE tasks SET status='Done', updated_at=? WHERE sync_uuid=?")
        .bind(now())
        .bind(&t_uuid)
        .execute(&host)
        .await
        .unwrap();

    let _ = sync_run(&host, &replica, &mut cursor).await;

    // Edit wins: the row is resurrected on the replica, the tombstone is gone,
    // and there is nothing left to push.
    let alive: i64 = count(&replica, "SELECT COUNT(*) FROM tasks WHERE sync_uuid=?", &t_uuid).await;
    assert_eq!(alive, 1, "host edit resurrects the row on the replica");
    let tombs: i64 = count(&replica, "SELECT COUNT(*) FROM tombstones WHERE sync_uuid=?", &t_uuid).await;
    assert_eq!(tombs, 0, "the abandoned delete's tombstone is cleared (no doomed re-push)");
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await.0, "Done");

    let (_, push2) = sync_run(&host, &replica, &mut cursor).await;
    assert!(push2["applied"].as_array().unwrap().is_empty(), "no perpetual delete loop");
    assert_eq!(count(&host, "SELECT COUNT(*) FROM tasks WHERE sync_uuid=?", &t_uuid).await, 1, "host still has it");
}

#[tokio::test]
async fn host_delete_vs_local_edit_converges_edit_wins() {
    let (host, replica, t_uuid, mut cursor) = paired("hostdel").await;
    let now = || chrono::Utc::now().to_rfc3339();
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;

    // Host deletes; replica edits the same task offline.
    sqlx::query("DELETE FROM tasks WHERE sync_uuid=?").bind(&t_uuid).execute(&host).await.unwrap();
    sqlx::query("UPDATE tasks SET status='In Progress', updated_at=? WHERE sync_uuid=?")
        .bind(now())
        .bind(&t_uuid)
        .execute(&replica)
        .await
        .unwrap();

    let (ingest, _) = sync_run(&host, &replica, &mut cursor).await;
    // The host-delete is ignored (local edit wins); the replica keeps its row...
    assert!(ingest["conflicts"].as_array().unwrap().is_empty(), "no stuck delete-conflict");
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await.0, "In Progress", "local edit preserved");
    // ...and the next run re-creates it on the host.
    assert_eq!(count(&host, "SELECT COUNT(*) FROM tasks WHERE sync_uuid=?", &t_uuid).await, 1, "row restored on host");
    assert_eq!(count(&host, "SELECT COUNT(*) FROM tombstones WHERE sync_uuid=?", &t_uuid).await, 0, "host tombstone cleared on re-insert");
}

#[tokio::test]
async fn adopting_a_host_user_keeps_local_user_settings() {
    // Regression: INSERT OR REPLACE would CASCADE-delete user_settings.
    let host = init_db_role(&temp_db("usercasc_host"), Role::Server).await.unwrap();
    let host_uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM users WHERE id=1").fetch_one(&host).await.unwrap();

    let replica = init_db_role(&temp_db("usercasc_replica"), Role::Replica).await.unwrap();
    // A local preference attached to the bootstrapped user 1.
    sqlx::query("INSERT INTO user_settings (user_id, setting_key, setting_value, created_at, updated_at) VALUES (1,'theme','dark',datetime('now'),datetime('now'))")
        .execute(&replica)
        .await
        .unwrap();

    // Ingest the host's user 1 (different sync_uuid, same id).
    let full = sync::pull(&host, "").await.unwrap();
    let users: Vec<sync::IncomingChange> = serde_json::from_value(
        json!(full["changes"].as_array().unwrap().iter().filter(|c| c["entity"] == "users").cloned().collect::<Vec<_>>()),
    )
    .unwrap();
    sync::ingest(&replica, users).await.unwrap();

    let settings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_settings WHERE user_id=1 AND setting_key='theme'")
        .fetch_one(&replica)
        .await
        .unwrap();
    assert_eq!(settings, 1, "adopting the host user must NOT cascade-delete local user_settings");
    let adopted: String = sqlx::query_scalar("SELECT sync_uuid FROM users WHERE id=1").fetch_one(&replica).await.unwrap();
    assert_eq!(adopted, host_uuid, "host user adopted in place at id 1");
}

#[tokio::test]
async fn resolving_a_conflict_pushes_the_decision_to_the_host() {
    // Realistic (monotonic) timestamps: the resolved row must out-rank the row
    // that conflicted, which far-future stamps would defeat.
    let (host, replica, t_uuid, mut cursor) = paired("resolve").await;
    let now = || chrono::Utc::now().to_rfc3339();
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;

    sqlx::query("UPDATE tasks SET status='Done', updated_at=? WHERE sync_uuid=?")
        .bind(now())
        .bind(&t_uuid)
        .execute(&host)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET status='In Progress', updated_at=? WHERE sync_uuid=?")
        .bind(now())
        .bind(&t_uuid)
        .execute(&replica)
        .await
        .unwrap();

    // First run surfaces the clash.
    let (ingest, _) = sync_run(&host, &replica, &mut cursor).await;
    assert_eq!(ingest["conflicts"].as_array().unwrap().len(), 1);

    // User keeps the local value.
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    sync::resolve_conflict(&replica, &t_uuid, serde_json::from_value(json!({ "status": "In Progress" })).unwrap())
        .await
        .unwrap();
    assert!(sync::get_conflicts(&replica).await.unwrap().is_empty(), "conflict cleared on resolve");

    // Next run carries the decision to the host (no re-conflict).
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let (ingest2, _) = sync_run(&host, &replica, &mut cursor).await;
    assert!(ingest2["conflicts"].as_array().unwrap().is_empty(), "resolution does not re-conflict");
    assert_eq!(status_of(&host, "tasks", &t_uuid).await.0, "In Progress", "host adopts the resolved value");
    assert_eq!(status_of(&replica, "tasks", &t_uuid).await.0, "In Progress", "replica keeps the resolved value");
}
