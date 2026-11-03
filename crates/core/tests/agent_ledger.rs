//! The agent_actions migration: its first cut had project_id NOT NULL; routine
//! runs are cross-project, so the migration rebuilds that shape once. The
//! rebuild must preserve every existing ledger row (it's an audit trail).

use ganban_core::{init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_ledger_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

#[tokio::test]
async fn relaxing_project_id_preserves_existing_ledger_rows() {
    let path = temp_db("rebuild");
    {
        // Recreate the v1 shape (project_id NOT NULL) with a row in it.
        let db = init_db(&path).await.unwrap();
        sqlx::query("DROP TABLE agent_actions").execute(&db).await.unwrap();
        sqlx::query(
            "CREATE TABLE agent_actions (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                status TEXT NOT NULL, \
                user_id INTEGER NOT NULL, \
                profile_id INTEGER, \
                project_id INTEGER NOT NULL, \
                chat_id INTEGER, \
                routine_id INTEGER, \
                tool TEXT NOT NULL, \
                summary TEXT NOT NULL, \
                args_json TEXT NOT NULL, \
                result_json TEXT, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_actions (status, user_id, project_id, tool, summary, args_json) \
             VALUES ('applied', 1, 7, 'create_task', 'old row', '{}')",
        )
        .execute(&db)
        .await
        .unwrap();
        db.close().await;
    }

    // Re-opening runs migrations: the old shape is detected and rebuilt.
    let db = init_db(&path).await.unwrap();
    let rows = ops::list_agent_actions(&db, None, 10).await.unwrap();
    assert_eq!(rows.len(), 1, "the rebuild must carry every audit row across");
    assert_eq!(rows[0].summary, "old row");
    assert_eq!(rows[0].project_id, Some(7));

    // And the relaxed column now accepts cross-project (NULL) entries.
    ops::record_agent_action(&db, ops::NewAgentAction {
        status: "applied",
        user_id: 1,
        profile_id: None,
        project_id: None,
        chat_id: None,
        routine_id: Some(1),
        model: None,
        prompt_tokens: None,
        completion_tokens: None,
        duration_ms: None,
        protocol_slug: None,
        protocol_version: None,
        content_hash: None,
        parent_action_id: None,
        approver_id: None,
        tool: "rundown",
        summary: "routine run",
        args_json: "{}",
        result_json: None,
    })
    .await
    .unwrap();
    assert_eq!(ops::list_agent_actions(&db, None, 10).await.unwrap().len(), 2);
}
