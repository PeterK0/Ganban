//! P2.2a — replica change-capture triggers.
//!
//! Verifies that opening a DB with `Role::Replica` installs triggers that keep
//! `sync_state`/`tombstones` current on every local mutation (including updates
//! that don't bump `updated_at` and cascade-deletes), that capture is suppressed
//! under the `_sync_ctl.applying` echo-guard, and that `Role::Server` installs
//! none of it.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, Db, Role};
use sqlx::Row;
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_capture_{}_{}.db", std::process::id(), tag));
    let _ = std::fs::remove_file(&p);
    let _ = std::fs::remove_file(p.with_extension("db-wal"));
    let _ = std::fs::remove_file(p.with_extension("db-shm"));
    p
}

async fn mk_project(db: &Db, name: &str) -> i64 {
    ops::create_project(db, CreateProjectInput { name: name.into(), description: None })
        .await
        .unwrap()
        .id
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

async fn state_row(db: &Db, entity: &str, row_id: i64) -> Option<(i64, Option<String>, Option<String>)> {
    sqlx::query("SELECT dirty, base_snapshot, sync_uuid FROM sync_state WHERE entity_type=? AND row_id=?")
        .bind(entity)
        .bind(row_id)
        .fetch_optional(db)
        .await
        .unwrap()
        .map(|r| (r.get::<i64, _>(0), r.get::<Option<String>, _>(1), r.get::<Option<String>, _>(2)))
}

#[tokio::test]
async fn insert_marks_dirty_with_no_base() {
    let path = temp_db("ins");
    let db = init_db_role(&path, Role::Replica).await.unwrap();
    let pid = mk_project(&db, "Seed").await;

    let (dirty, base, _uuid) = state_row(&db, "projects", pid).await.expect("sync_state row exists");
    assert_eq!(dirty, 1, "newly inserted row is dirty");
    assert!(base.is_none(), "locally-born row has no common ancestor");

    // sync_uuid is resolved live from the table by row_id (the stable local key),
    // independent of AFTER-INSERT trigger fire order.
    let uuid: String = sqlx::query_scalar(
        "SELECT p.sync_uuid FROM sync_state s JOIN projects p ON p.rowid=s.row_id \
         WHERE s.entity_type='projects' AND s.row_id=?",
    )
    .bind(pid)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!uuid.is_empty(), "sync_uuid resolvable from the live row");
}

#[tokio::test]
async fn update_without_bumping_updated_at_is_still_captured() {
    // The disqualifier for a cursor approach: storage.rs-style updates that don't
    // touch updated_at. Triggers must catch them anyway.
    let path = temp_db("noupdated");
    let db = init_db_role(&path, Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "T").await;

    // Simulate a clean (already-synced) row so we also exercise base capture.
    sqlx::query("UPDATE sync_state SET dirty=0, base_snapshot=NULL WHERE entity_type='tasks' AND row_id=?")
        .bind(tid)
        .execute(&db)
        .await
        .unwrap();
    let before: String = sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id=?")
        .bind(tid)
        .fetch_one(&db)
        .await
        .unwrap();

    // A raw update that deliberately does NOT touch updated_at.
    sqlx::query("UPDATE tasks SET archived=1 WHERE id=?").bind(tid).execute(&db).await.unwrap();

    let after: String = sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id=?")
        .bind(tid)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(before, after, "updated_at was NOT bumped — a cursor would miss this change");

    let (dirty, base, _) = state_row(&db, "tasks", tid).await.expect("state row");
    assert_eq!(dirty, 1, "trigger caught the update despite no updated_at change");
    let base = base.expect("base captured on clean->dirty edge");
    let base: serde_json::Value = serde_json::from_str(&base).unwrap();
    assert_eq!(base["archived"], serde_json::json!(0), "base snapshot holds the OLD (pre-update) image");
    assert_eq!(base["title"], serde_json::json!("T"));
}

#[tokio::test]
async fn base_snapshot_frozen_after_first_dirtying() {
    let path = temp_db("base");
    let db = init_db_role(&path, Role::Replica).await.unwrap();
    let pid = mk_project(&db, "P").await;
    let tid = mk_task(&db, pid, "orig").await;
    sqlx::query("UPDATE sync_state SET dirty=0, base_snapshot=NULL WHERE entity_type='tasks' AND row_id=?")
        .bind(tid)
        .execute(&db)
        .await
        .unwrap();

    sqlx::query("UPDATE tasks SET title='first' WHERE id=?").bind(tid).execute(&db).await.unwrap();
    sqlx::query("UPDATE tasks SET title='second' WHERE id=?").bind(tid).execute(&db).await.unwrap();

    let (_, base, _) = state_row(&db, "tasks", tid).await.unwrap();
    let base: serde_json::Value = serde_json::from_str(&base.unwrap()).unwrap();
    assert_eq!(base["title"], serde_json::json!("orig"), "ancestor frozen at the pre-edit value, not the intermediate one");
}

#[tokio::test]
async fn applying_guard_suppresses_capture() {
    let path = temp_db("guard");
    let db = init_db_role(&path, Role::Replica).await.unwrap();

    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&db).await.unwrap();
    let pid = mk_project(&db, "Ingested").await;
    assert!(state_row(&db, "projects", pid).await.is_none(), "capture suppressed while applying='1'");

    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&db).await.unwrap();
    let pid2 = mk_project(&db, "Local").await;
    assert!(state_row(&db, "projects", pid2).await.is_some(), "capture resumes once applying='0'");
}

#[tokio::test]
async fn delete_tombstones_row_and_cascaded_children() {
    let path = temp_db("del");
    let db = init_db_role(&path, Role::Replica).await.unwrap();
    let pid = mk_project(&db, "Doomed").await;
    let tid = mk_task(&db, pid, "child").await;

    let task_uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM tasks WHERE id=?")
        .bind(tid)
        .fetch_one(&db)
        .await
        .unwrap();

    // Deleting the project cascades to its tasks (FK ON DELETE CASCADE).
    sqlx::query("DELETE FROM projects WHERE id=?").bind(pid).execute(&db).await.unwrap();

    let proj_tomb: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones WHERE entity_type='projects'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(proj_tomb, 1, "deleted project is tombstoned");

    let (cnt, base): (i64, Option<String>) =
        sqlx::query_as("SELECT COUNT(*), MAX(base_updated_at) FROM tombstones WHERE entity_type='tasks' AND sync_uuid=?")
            .bind(&task_uuid)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(cnt, 1, "cascade-deleted child is tombstoned (recursive_triggers ON)");
    assert!(base.is_some(), "tombstone carries the pre-delete updated_at for LWW");

    // sync_state for the deleted rows is gone.
    assert!(state_row(&db, "tasks", tid).await.is_none(), "dirty state cleared on delete");
}

#[tokio::test]
async fn server_role_has_no_capture() {
    let path = temp_db("server");
    let db = init_db_role(&path, Role::Server).await.unwrap();

    let triggers: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%_cap_%'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(triggers, 0, "Server role installs no capture triggers");

    let ctl: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sync_ctl'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(ctl, 0, "Server role has no echo-guard table");

    // ...but a mutation on the authoritative host is never dirty-tracked.
    let pid = mk_project(&db, "HostRow").await;
    let has_state: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_state WHERE entity_type='projects' AND row_id=?")
        .bind(pid)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(has_state, 0, "host writes leave sync_state empty");
}
