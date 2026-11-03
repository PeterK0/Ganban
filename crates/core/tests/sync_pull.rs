//! P2.2b — symmetric pull.
//!
//! `pull` is the dual of `push`: it emits `IncomingChange[]` with FK columns
//! lifted into `fk_refs` (parent sync_uuids), `users` carrying their id, FKs to
//! `users` left as raw ints, and host tombstones as `op:delete`.

use ganban_core::models::{CreateCommentInput, CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use serde_json::Value;
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_pull_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn uuid_of(db: &Db, table: &str, id: i64) -> String {
    sqlx::query_scalar(&format!("SELECT sync_uuid FROM {table} WHERE id=?"))
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

fn find<'a>(changes: &'a [Value], entity: &str, sync_uuid: &str) -> &'a Value {
    changes
        .iter()
        .find(|c| c["entity"] == entity && c["sync_uuid"] == sync_uuid)
        .unwrap_or_else(|| panic!("no {entity} change for {sync_uuid}"))
}

#[tokio::test]
async fn full_pull_is_symmetric_incoming_changes() {
    let path = temp_db("full");
    let db = init_db_role(&path, Role::Server).await.unwrap();

    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None })
        .await
        .unwrap()
        .id;
    let tid = ops::create_task(
        &db,
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
    let cid = ops::create_comment(&db, CreateCommentInput { task_id: tid, content: "hi".into(), user_id: Some(1), parent_id: None, profile_id: None, task_ids: vec![] })
        .await
        .unwrap()
        .id;

    let (p_uuid, t_uuid, c_uuid) =
        (uuid_of(&db, "projects", pid).await, uuid_of(&db, "tasks", tid).await, uuid_of(&db, "comments", cid).await);

    let out = sync::pull(&db, "").await.unwrap();
    let changes = out["changes"].as_array().expect("changes array");

    // Project: no id, no FKs, op upsert.
    let proj = find(changes, "projects", &p_uuid);
    assert_eq!(proj["op"], "upsert");
    assert!(proj["data"].get("id").is_none(), "id stripped from non-users data");
    assert_eq!(proj["data"]["name"], "P");
    assert_eq!(proj["fk_refs"], serde_json::json!({}), "project has no remappable FKs");

    // Task: project_id lifted into fk_refs as the project's sync_uuid; not in data.
    let task = find(changes, "tasks", &t_uuid);
    assert_eq!(task["fk_refs"]["project_id"], Value::String(p_uuid.clone()));
    assert!(task["data"].get("project_id").is_none(), "FK column lifted out of data");
    assert_eq!(task["data"]["title"], "T");

    // Comment: task_id remapped; user_id stays a raw int (users not push-syncable).
    let comment = find(changes, "comments", &c_uuid);
    assert_eq!(comment["fk_refs"]["task_id"], Value::String(t_uuid.clone()));
    assert!(comment["fk_refs"].get("user_id").is_none(), "user_id is NOT remapped");
    assert_eq!(comment["data"]["user_id"], serde_json::json!(1), "raw user id preserved in data");

    // Users: keep id (adopted verbatim by the replica) + carry a sync_uuid.
    let user = changes.iter().find(|c| c["entity"] == "users").expect("user change present");
    assert_eq!(user["data"]["id"], serde_json::json!(1), "users keep their id in data");
    assert!(user["sync_uuid"].as_str().map(|s| !s.is_empty()).unwrap_or(false), "users carry a sync_uuid");

    // Full snapshot carries no deletes.
    assert!(changes.iter().all(|c| c["op"] != "delete"), "no tombstones in a full snapshot");
}

#[tokio::test]
async fn incremental_pull_emits_tombstones_and_only_newer_rows() {
    let path = temp_db("inc");
    let db = init_db_role(&path, Role::Server).await.unwrap();

    let pid = ops::create_project(&db, CreateProjectInput { name: "Keep".into(), description: None })
        .await
        .unwrap()
        .id;
    let tid = ops::create_task(
        &db,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "Doomed".into(),
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
    let t_uuid = uuid_of(&db, "tasks", tid).await;

    // Cursor after seeding; later changes must appear, earlier ones must not.
    let cursor = sync::pull(&db, "").await.unwrap()["cursor"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(10)).await; // unambiguous ordering

    // Bump the project (an update) and delete the task (a host-side hard delete
    // -> tombstone via the Server delete trigger).
    sqlx::query("UPDATE projects SET name='Keep2', updated_at=? WHERE id=?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(pid)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM tasks WHERE id=?").bind(tid).execute(&db).await.unwrap();

    let out = sync::pull(&db, &cursor).await.unwrap();
    let changes = out["changes"].as_array().unwrap();

    // The task delete is reported as op:delete with an LWW reference.
    let del = changes
        .iter()
        .find(|c| c["op"] == "delete" && c["sync_uuid"] == Value::String(t_uuid.clone()))
        .expect("tombstone emitted as op:delete");
    assert_eq!(del["entity"], "tasks");
    assert!(del["base_updated_at"].as_str().map(|s| !s.is_empty()).unwrap_or(false), "delete carries base_updated_at");

    // The bumped project shows up as an upsert.
    assert!(
        changes.iter().any(|c| c["entity"] == "projects" && c["data"]["name"] == "Keep2"),
        "updated project re-pulled"
    );

    // Nothing untouched leaks: only the project upsert + the task delete.
    let upserts: Vec<_> = changes.iter().filter(|c| c["op"] == "upsert").collect();
    assert_eq!(upserts.len(), 1, "only the changed project is re-pulled, got {upserts:?}");
}
