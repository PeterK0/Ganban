//! Files stay out of the AI overview unless someone includes them: new rows start at 0,
//! rows that were there before the column stay in, and a file over the size guard goes in
//! only when forced.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, storage, Role};
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_ai_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn project_and_task(db: &ganban_core::Db) -> (i64, i64) {
    let pid = ops::create_project(db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let tid = ops::create_task(
        db,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "t".into(),
            description: None,
            status: "To Do".into(),
            priority: "Low".into(),
            prefix: None,
            cost: None,
            currency: None,
            deadline: None,
        },
    )
    .await
    .unwrap()
    .id;
    (pid, tid)
}

async fn flag(db: &ganban_core::Db, table: &str, id: i64) -> i64 {
    sqlx::query_scalar(&format!("SELECT ai_included FROM {table} WHERE id = ?")).bind(id).fetch_one(db).await.unwrap()
}

#[tokio::test]
async fn new_files_start_out_and_files_from_before_stay_in() {
    let dir = temp_dir("migrate");
    let path = dir.join("t.db");
    let db = init_db_role(&path, Role::Server).await.unwrap();
    let root = dir.join("storage");
    let (pid, tid) = project_and_task(&db).await;

    // New rows: out of the AI overview.
    let pf = storage::store_project_file(&db, &root, pid, "a.md", None, None, Some(1), b"aaa").await.unwrap();
    let att = storage::store_shared_bytes(&db, &root, tid, "b.md", None, Some(1), b"bbb").await.unwrap();
    assert!(!pf.ai_included);
    assert!(!att.ai_included);
    assert_eq!(flag(&db, "project_files", pf.id).await, 0);
    assert_eq!(flag(&db, "file_attachments", att.id).await, 0);

    // A database from before the column: the migration adds it and keeps every file in.
    for table in ["file_attachments", "project_files"] {
        sqlx::query(&format!("ALTER TABLE {table} DROP COLUMN ai_included")).execute(&db).await.unwrap();
    }
    db.close().await;
    let db = init_db_role(&path, Role::Server).await.unwrap();
    assert_eq!(flag(&db, "project_files", pf.id).await, 1, "an existing project file stays indexed");
    assert_eq!(flag(&db, "file_attachments", att.id).await, 1, "an existing attachment stays indexed");

    // Running the migrations again changes nothing, and new files still start out.
    storage::set_project_file_ai_included(&db, pf.id, false, false).await.unwrap();
    db.close().await;
    let db = init_db_role(&path, Role::Server).await.unwrap();
    assert_eq!(flag(&db, "project_files", pf.id).await, 0, "the backfill runs once");
    let later = storage::store_project_file(&db, &root, pid, "c.md", None, None, Some(1), b"ccc").await.unwrap();
    assert!(!later.ai_included);
}

#[test]
fn the_size_guard_needs_force_and_names_the_size() {
    let mb = 1024 * 1024;
    assert_eq!(storage::ai_flag(10 * mb, false, false, 50 * mb).unwrap(), storage::AI_EXCLUDED);
    assert_eq!(storage::ai_flag(10 * mb, true, false, 50 * mb).unwrap(), storage::AI_INCLUDED);
    assert_eq!(storage::ai_flag(50 * mb, true, false, 50 * mb).unwrap(), storage::AI_INCLUDED, "the guard itself is fine");
    let err = storage::ai_flag(380 * mb, true, false, 50 * mb).unwrap_err().to_string();
    assert!(err.contains("380 MB") && err.contains("50 MB") && err.contains("force"), "{err}");
    assert_eq!(storage::ai_flag(380 * mb, true, true, 50 * mb).unwrap(), storage::AI_FORCED);
    assert_eq!(storage::ai_flag(380 * mb, false, false, 50 * mb).unwrap(), storage::AI_EXCLUDED, "leaving out never asks");
    assert_eq!(storage::mb_label(3 * mb / 2), "1.5 MB");
}

#[tokio::test]
async fn including_a_big_file_needs_force_and_the_choice_moves_with_the_file() {
    let dir = temp_dir("force");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let (pid, tid) = project_and_task(&db).await;
    let pf = storage::store_project_file(&db, &root, pid, "book.pdf", None, None, Some(1), b"pages").await.unwrap();
    let small = storage::store_shared_bytes(&db, &root, tid, "note.md", None, Some(1), b"note").await.unwrap();
    // Pretend it's a 380 MB textbook (the guard reads the recorded size).
    sqlx::query("UPDATE project_files SET size_bytes = ? WHERE id = ?").bind(380_i64 * 1024 * 1024).bind(pf.id).execute(&db).await.unwrap();

    let err = storage::set_project_file_ai_included(&db, pf.id, true, false).await.unwrap_err().to_string();
    assert!(err.contains("380 MB"), "{err}");
    assert_eq!(flag(&db, "project_files", pf.id).await, 0, "a refused include changes nothing");
    assert!(storage::set_project_file_ai_included(&db, pf.id, true, true).await.unwrap().ai_included);
    assert_eq!(flag(&db, "project_files", pf.id).await, storage::AI_FORCED);

    // Assigned to a task and back, the file keeps its forced place in the AI overview.
    let att = storage::assign_file_to_task(&db, &root, pf.id, tid).await.unwrap();
    assert_eq!(flag(&db, "file_attachments", att.id).await, storage::AI_FORCED);
    let back = storage::unassign_attachment(&db, &root, att.id).await.unwrap();
    assert_eq!(flag(&db, "project_files", back.id).await, storage::AI_FORCED);

    // An attachment counts by its stored size and moves its updated_at, so replicas pull it.
    let before: String =
        sqlx::query_scalar("SELECT updated_at FROM file_attachments WHERE id = ?").bind(small.id).fetch_one(&db).await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    assert!(storage::set_attachment_ai_included(&db, small.id, true, false).await.unwrap().ai_included);
    let after: String =
        sqlx::query_scalar("SELECT updated_at FROM file_attachments WHERE id = ?").bind(small.id).fetch_one(&db).await.unwrap();
    assert_ne!(before, after);
    assert!(!storage::set_attachment_ai_included(&db, small.id, false, false).await.unwrap().ai_included);
}

/// On a desktop replica the backfill marks nothing dirty (the host backfills its own rows),
/// and the capture trigger is rebuilt so its base snapshot carries the new column.
#[tokio::test]
async fn the_replica_backfill_marks_nothing_dirty() {
    let dir = temp_dir("replica");
    let path = dir.join("t.db");
    let db = init_db_role(&path, Role::Replica).await.unwrap();
    let (_, tid) = project_and_task(&db).await;
    let att = sqlx::query("INSERT INTO file_attachments (task_id, file_path, file_name, created_at, is_valid) VALUES (?, '/x', 'x.pdf', datetime('now'), 1)")
        .bind(tid)
        .execute(&db)
        .await
        .unwrap()
        .last_insert_rowid();
    // Back to a database from before the column, with everything already pushed.
    sqlx::query("DROP TRIGGER trg_file_attachments_cap_upd").execute(&db).await.unwrap();
    for table in ["file_attachments", "project_files"] {
        sqlx::query(&format!("ALTER TABLE {table} DROP COLUMN ai_included")).execute(&db).await.unwrap();
    }
    sqlx::query("DELETE FROM sync_state").execute(&db).await.unwrap();
    // An old-style capture trigger (its snapshot predates the column) watches the backfill.
    sqlx::query(
        "CREATE TRIGGER trg_file_attachments_cap_upd AFTER UPDATE ON file_attachments \
         WHEN (SELECT value FROM _sync_ctl WHERE key='applying')='0' \
         BEGIN INSERT INTO sync_state(entity_type,row_id,dirty) VALUES('file_attachments', NEW.rowid, 1) \
         ON CONFLICT(entity_type,row_id) DO UPDATE SET dirty=1; END",
    )
    .execute(&db)
    .await
    .unwrap();
    db.close().await;

    let db = init_db_role(&path, Role::Replica).await.unwrap();
    assert_eq!(flag(&db, "file_attachments", att).await, 1);
    let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_state WHERE dirty = 1").fetch_one(&db).await.unwrap();
    assert_eq!(dirty, 0, "the backfill isn't a local edit");
    let trigger: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'trg_file_attachments_cap_upd'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(trigger.contains("ai_included"), "the capture trigger snapshots the new column");
}
