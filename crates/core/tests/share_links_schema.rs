//! Share links made before project files could be shared (`task_id` NOT NULL, files named by
//! `attachment_id`) survive the rebuild into the wider tables, files and all.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, Role};

#[tokio::test]
async fn old_links_keep_their_files_through_the_rebuild() {
    let dir = std::env::temp_dir().join(format!("ganban_share_schema_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let tid = ops::create_task(
        &db,
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

    // The first shape, with a link and a file in it.
    for sql in [
        "DROP TABLE share_link_files",
        "DROP TABLE share_links",
        "CREATE TABLE share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, \
           task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, \
           project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label TEXT NOT NULL, \
           password_hash TEXT, expires_at TEXT, revoked_at TEXT, prepared_at TEXT, created_by INTEGER, \
           created_at TEXT NOT NULL, download_count INTEGER NOT NULL DEFAULT 0, last_download_at TEXT)",
        "CREATE TABLE share_link_files (link_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE, \
           n INTEGER NOT NULL, attachment_id INTEGER NOT NULL, folder TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, \
           size INTEGER NOT NULL, mtime INTEGER NOT NULL, crc32 INTEGER, PRIMARY KEY (link_id, n))",
    ] {
        sqlx::query(sql).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO share_links (id, token, task_id, project_id, label, created_at, download_count) VALUES (5, 'tok', ?, ?, 'L', '2026-11-02T00:00:00Z', 3)")
        .bind(tid)
        .bind(pid)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO share_link_files (link_id, n, attachment_id, folder, name, size, mtime, crc32) VALUES (5, 0, 42, 'A', 'x.pdf', 9, 1, 7)")
        .execute(&db)
        .await
        .unwrap();

    // Reopening runs the migrations: the rebuild happens once, and again is a no-op.
    db.close().await;
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    db.close().await;
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();

    let link: (i64, Option<i64>, i64, i64) =
        sqlx::query_as("SELECT id, task_id, project_id, download_count FROM share_links").fetch_one(&db).await.unwrap();
    assert_eq!(link, (5, Some(tid), pid, 3));
    let file: (String, i64, String, Option<i64>) =
        sqlx::query_as("SELECT kind, file_id, name, crc32 FROM share_link_files WHERE link_id = 5").fetch_one(&db).await.unwrap();
    assert_eq!(file, ("attachment".into(), 42, "x.pdf".into(), Some(7)));

    // A link made from the project has no task, and deleting the link still takes its files.
    sqlx::query("INSERT INTO share_links (token, task_id, project_id, label, created_at) VALUES ('p', NULL, ?, 'P', '2026-11-03T00:00:00Z')")
        .bind(pid)
        .execute(&db)
        .await
        .unwrap();
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&db).await.unwrap();
    assert_eq!(fk, 1, "foreign keys are back on");
    sqlx::query("DELETE FROM share_links WHERE id = 5").execute(&db).await.unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_link_files").fetch_one(&db).await.unwrap();
    assert_eq!(left, 0);
    // The project's link stays.
    let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_links").fetch_one(&db).await.unwrap();
    assert_eq!(links, 1);
}
