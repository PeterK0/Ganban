//! P2.2e — local_pending (collect) + ack (compare-and-clear) round trip.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_collect_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn mk_project(db: &Db, name: &str) -> i64 {
    ops::create_project(db, CreateProjectInput { name: name.into(), description: None }).await.unwrap().id
}
async fn mk_task(db: &Db, project_id: i64, title: &str) -> i64 {
    ops::create_task(
        db,
        CreateTaskInput {
            project_id,
            area_id: None,
            title: title.into(),
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
    .id
}

async fn updated_at(db: &Db, table: &str, id: i64) -> String {
    sqlx::query_scalar(&format!("SELECT updated_at FROM {table} WHERE id=?")).bind(id).fetch_one(db).await.unwrap()
}
async fn uuid_of(db: &Db, table: &str, id: i64) -> String {
    sqlx::query_scalar(&format!("SELECT sync_uuid FROM {table} WHERE id=?")).bind(id).fetch_one(db).await.unwrap()
}
async fn dirty(db: &Db, table: &str, id: i64) -> Option<i64> {
    sqlx::query_scalar("SELECT dirty FROM sync_state WHERE entity_type=? AND row_id=?")
        .bind(table)
        .bind(id)
        .fetch_optional(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn collect_builds_pushable_changes_then_ack_clears() {
    let db = init_db_role(&temp_db("rt"), Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "T").await;
    let (p_uuid, t_uuid) = (uuid_of(&db, "projects", pid).await, uuid_of(&db, "tasks", tid).await);

    let pending = sync::local_pending(&db).await.unwrap();
    assert_eq!(pending.len(), 2, "both locally-born rows are pending: {pending:?}");

    let task = pending.iter().find(|c| c["sync_uuid"] == t_uuid).unwrap();
    assert_eq!(task["op"], "upsert");
    assert_eq!(task["fk_refs"]["project_id"], p_uuid, "task FK lifted to the project's sync_uuid");
    assert!(task["data"].get("project_id").is_none(), "FK not duplicated in data");
    assert!(task["base"].is_null(), "locally-born row has no ancestor");

    // Simulate a successful host push, then ack.
    let items = json!([
        { "entity": "projects", "sync_uuid": p_uuid, "op": "upsert", "pushed_updated_at": updated_at(&db, "projects", pid).await },
        { "entity": "tasks", "sync_uuid": t_uuid, "op": "upsert", "pushed_updated_at": updated_at(&db, "tasks", tid).await },
    ]);
    sync::ack(&db, serde_json::from_value(items).unwrap()).await.unwrap();

    assert_eq!(dirty(&db, "projects", pid).await, Some(0), "project cleared after ack");
    assert_eq!(dirty(&db, "tasks", tid).await, Some(0), "task cleared after ack");
    assert!(sync::local_pending(&db).await.unwrap().is_empty(), "nothing left to push");

    // After ack, the ancestor is refreshed to the now-agreed row.
    let base: Option<String> =
        sqlx::query_scalar("SELECT base_snapshot FROM sync_state WHERE entity_type='tasks' AND row_id=?")
            .bind(tid)
            .fetch_one(&db)
            .await
            .unwrap();
    let base: Value = serde_json::from_str(&base.unwrap()).unwrap();
    assert_eq!(base["title"], "T", "ack snapshots the agreed row as the new ancestor");
}

#[tokio::test]
async fn ack_does_not_clear_a_row_edited_since_collect() {
    let db = init_db_role(&temp_db("race"), Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "before").await;
    let t_uuid = uuid_of(&db, "tasks", tid).await;
    let collected_ts = updated_at(&db, "tasks", tid).await;

    // A local edit slips in between collect and ack (bumps updated_at).
    sqlx::query("UPDATE tasks SET title='after', updated_at=? WHERE id=?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(tid)
        .execute(&db)
        .await
        .unwrap();

    // ack carries the STALE (collect-time) updated_at.
    sync::ack(
        &db,
        serde_json::from_value(json!([
            { "entity": "tasks", "sync_uuid": t_uuid, "op": "upsert", "pushed_updated_at": collected_ts }
        ]))
        .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(dirty(&db, "tasks", tid).await, Some(1), "compare-and-clear keeps the just-edited row dirty");
    let pending = sync::local_pending(&db).await.unwrap();
    assert!(
        pending.iter().any(|c| c["sync_uuid"] == t_uuid && c["data"]["title"] == "after"),
        "the new edit will re-sync with its current value"
    );
}

#[tokio::test]
async fn local_delete_is_collected_then_acked() {
    let db = init_db_role(&temp_db("del"), Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "doomed").await;
    let t_uuid = uuid_of(&db, "tasks", tid).await;

    sqlx::query("DELETE FROM tasks WHERE id=?").bind(tid).execute(&db).await.unwrap();

    let pending = sync::local_pending(&db).await.unwrap();
    let del = pending.iter().find(|c| c["op"] == "delete" && c["sync_uuid"] == t_uuid).expect("delete collected");
    assert_eq!(del["entity"], "tasks");

    sync::ack(
        &db,
        serde_json::from_value(json!([{ "entity": "tasks", "sync_uuid": t_uuid, "op": "delete" }])).unwrap(),
    )
    .await
    .unwrap();

    let tombs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones WHERE sync_uuid=?")
        .bind(&t_uuid)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(tombs, 0, "tombstone dropped after ack");
}

#[tokio::test]
async fn collect_carries_ancestor_for_a_previously_synced_row() {
    let db = init_db_role(&temp_db("anc"), Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "orig").await;
    // Mark clean (as if synced), then edit -> ancestor captured.
    sqlx::query("UPDATE sync_state SET dirty=0, base_snapshot=NULL WHERE entity_type='tasks' AND row_id=?")
        .bind(tid)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET title='edited' WHERE id=?").bind(tid).execute(&db).await.unwrap();

    let pending = sync::local_pending(&db).await.unwrap();
    let task = pending.iter().find(|c| c["entity"] == "tasks").unwrap();
    assert_eq!(task["data"]["title"], "edited", "data is the current row");
    assert_eq!(task["base"]["title"], "orig", "base is the captured ancestor");
    assert!(task["base_updated_at"].is_string(), "base_updated_at extracted from the ancestor");
}
