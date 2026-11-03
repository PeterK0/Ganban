//! P2.2d — 3-way field merge + conflict reporting (both directions).

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_merge_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn seed_task(db: &Db, status: &str) -> (i64, String, String) {
    let pid = ops::create_project(db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let tid = ops::create_task(
        db,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "T".into(),
            description: None,
            status: status.into(),
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
    let p_uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM projects WHERE id=?").bind(pid).fetch_one(db).await.unwrap();
    let t_uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM tasks WHERE id=?").bind(tid).fetch_one(db).await.unwrap();
    (tid, t_uuid, p_uuid)
}

fn changes(v: Value) -> Vec<sync::IncomingChange> {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn push_disjoint_fields_auto_merge() {
    let host = init_db_role(&temp_db("merge"), Role::Server).await.unwrap();
    let (tid, t_uuid, p_uuid) = seed_task(&host, "To Do").await;
    let base_ts: String = sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id=?").bind(tid).fetch_one(&host).await.unwrap();

    // Host changes priority (disjoint from the replica's pending status edit).
    sqlx::query("UPDATE tasks SET priority='High', updated_at=? WHERE id=?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(tid)
        .execute(&host)
        .await
        .unwrap();

    let report = sync::push(
        &host,
        changes(json!([{
            "entity": "tasks", "sync_uuid": t_uuid, "base_updated_at": base_ts,
            "base": { "status": "To Do", "priority": "Medium" },
            "data": { "status": "In Progress", "priority": "Medium" },
            "fk_refs": { "project_id": p_uuid }
        }])),
    )
    .await
    .unwrap();

    assert!(report["conflicts"].as_array().unwrap().is_empty(), "disjoint edits should not conflict: {report}");
    assert_eq!(report["applied"].as_array().unwrap().len(), 1);

    let (status, priority): (String, String) =
        sqlx::query_as("SELECT status, priority FROM tasks WHERE id=?").bind(tid).fetch_one(&host).await.unwrap();
    assert_eq!(status, "In Progress", "replica's status change applied");
    assert_eq!(priority, "High", "host's priority change preserved (auto-merged)");
}

#[tokio::test]
async fn push_same_field_clash_is_reported() {
    let host = init_db_role(&temp_db("clash"), Role::Server).await.unwrap();
    let (tid, t_uuid, p_uuid) = seed_task(&host, "To Do").await;
    // Anchor the common ancestor strictly in the past so the host edit below is
    // unambiguously newer at julianday precision (avoids a same-instant flake).
    sqlx::query("UPDATE tasks SET updated_at='2020-01-01T00:00:00Z' WHERE id=?").bind(tid).execute(&host).await.unwrap();
    let base_ts: String = sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id=?").bind(tid).fetch_one(&host).await.unwrap();

    sqlx::query("UPDATE tasks SET status='Done', updated_at=? WHERE id=?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(tid)
        .execute(&host)
        .await
        .unwrap();

    let report = sync::push(
        &host,
        changes(json!([{
            "entity": "tasks", "sync_uuid": t_uuid, "base_updated_at": base_ts,
            "base": { "status": "To Do" },
            "data": { "status": "In Progress" },
            "fk_refs": { "project_id": p_uuid }
        }])),
    )
    .await
    .unwrap();

    assert!(report["applied"].as_array().unwrap().is_empty(), "clashing row not applied");
    let conflicts = report["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1);
    let c = &conflicts[0];
    assert_eq!(c["clashing_cols"], json!(["status"]));
    assert_eq!(c["base"]["status"], "To Do");
    assert_eq!(c["local"]["status"], "In Progress", "push: local = the replica's incoming value");
    assert_eq!(c["server"]["status"], "Done", "push: server = the host's current value");

    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=?").bind(tid).fetch_one(&host).await.unwrap();
    assert_eq!(status, "Done", "host row untouched on clash");
}

#[tokio::test]
async fn ingest_detects_conflict_from_local_dirty_state() {
    let replica = init_db_role(&temp_db("ingest"), Role::Replica).await.unwrap();
    let (tid, t_uuid, p_uuid) = seed_task(&replica, "To Do").await;

    // Simulate a clean (synced) row, then a local edit -> dirty + ancestor captured.
    sqlx::query("UPDATE sync_state SET dirty=0, base_snapshot=NULL WHERE entity_type='tasks' AND row_id=?")
        .bind(tid)
        .execute(&replica)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET status='In Progress', updated_at=? WHERE id=?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(tid)
        .execute(&replica)
        .await
        .unwrap();

    // Host's pulled change to the SAME field (no base on the wire — ingest
    // synthesizes it from the replica's sync_state).
    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&replica).await.unwrap();
    let report = sync::ingest(
        &replica,
        changes(json!([{
            "entity": "tasks", "sync_uuid": t_uuid, "op": "upsert",
            "data": { "status": "Done" },
            "fk_refs": { "project_id": p_uuid }
        }])),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&replica).await.unwrap();

    let conflicts = report["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1, "dirty local row + host change = conflict: {report}");
    let c = &conflicts[0];
    assert_eq!(c["clashing_cols"], json!(["status"]));
    assert_eq!(c["local"]["status"], "In Progress", "ingest: local = the replica's current value");
    assert_eq!(c["server"]["status"], "Done", "ingest: server = the host's incoming value");

    // The local row is left intact for review (not clobbered).
    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=?").bind(tid).fetch_one(&replica).await.unwrap();
    assert_eq!(status, "In Progress", "local edit preserved pending review");
}

#[tokio::test]
async fn ingest_clean_row_takes_host_value_without_conflict() {
    let replica = init_db_role(&temp_db("clean"), Role::Replica).await.unwrap();
    let (tid, t_uuid, p_uuid) = seed_task(&replica, "To Do").await;
    // Mark the row clean (synced, no pending local edit).
    sqlx::query("UPDATE sync_state SET dirty=0, base_snapshot=NULL WHERE entity_type='tasks' AND row_id=?")
        .bind(tid)
        .execute(&replica)
        .await
        .unwrap();

    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&replica).await.unwrap();
    let report = sync::ingest(
        &replica,
        changes(json!([{
            "entity": "tasks", "sync_uuid": t_uuid, "op": "upsert",
            "data": { "status": "Done" },
            "fk_refs": { "project_id": p_uuid }
        }])),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&replica).await.unwrap();

    assert!(report["conflicts"].as_array().unwrap().is_empty(), "clean row: host wins, no conflict");
    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=?").bind(tid).fetch_one(&replica).await.unwrap();
    assert_eq!(status, "Done", "clean local row overwritten by host");
}
