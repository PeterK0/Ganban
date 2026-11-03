//! M1a — AI chat data model + ops (host-only, never synced).

use ganban_core::models::CreateProjectInput;
use ganban_core::{init_db_role, ops, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_chat_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

#[tokio::test]
async fn chat_threads_and_messages_round_trip() {
    let db = init_db_role(&temp_db("rt"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "Roof".into(), description: None }).await.unwrap().id;

    let chat = ops::create_chat(&db, pid, Some(1), None, Some("Chimney")).await.unwrap();
    assert_eq!(chat.project_id, pid);
    assert_eq!(chat.title.as_deref(), Some("Chimney"));

    ops::append_message(&db, chat.id, "user", "how do I flash a chimney?", None, None, None, None, None, None).await.unwrap();
    let assistant = ops::append_message(
        &db,
        chat.id,
        "assistant",
        "Use lead flashing.",
        Some(r#"[{"source":"task-abc.md","score":0.1}]"#),
        Some(r#"["get_tasks"]"#),
        Some("gemma4:e4b"),
        Some(120),
        Some(45),
        Some(900),
    )
    .await
    .unwrap();
    assert_eq!(assistant.role, "assistant");
    // Capacity meter round-trips with the turn.
    assert_eq!(assistant.model.as_deref(), Some("gemma4:e4b"));
    assert_eq!(assistant.prompt_tokens, Some(120));
    assert_eq!(assistant.completion_tokens, Some(45));
    assert_eq!(assistant.duration_ms, Some(900));
    assert!(assistant.sources_json.unwrap().contains("task-abc.md"));
    assert!(assistant.tools_json.unwrap().contains("get_tasks"), "tool breadcrumbs persist with the turn");

    let msgs = ops::get_chat_messages(&db, chat.id).await.unwrap();
    assert_eq!(msgs.len(), 2, "both turns persisted");
    assert_eq!(msgs[0].role, "user", "history is oldest-first");
    assert_eq!(msgs[1].role, "assistant");

    assert_eq!(ops::chat_project(&db, chat.id).await.unwrap(), Some(pid));
}

#[tokio::test]
async fn chats_are_private_per_member() {
    let db = init_db_role(&temp_db("priv"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    ops::create_chat(&db, pid, Some(1), None, Some("mine")).await.unwrap();

    assert_eq!(ops::list_chats(&db, pid, Some(1)).await.unwrap().len(), 1, "owner sees their chat");
    assert_eq!(ops::list_chats(&db, pid, Some(2)).await.unwrap().len(), 0, "another member doesn't");
    assert_eq!(ops::list_chats(&db, pid, None).await.unwrap().len(), 1, "None = all (owner cross-view)");
}

#[tokio::test]
async fn deleting_a_chat_cascades_its_messages() {
    let db = init_db_role(&temp_db("casc"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let chat = ops::create_chat(&db, pid, Some(1), None, None).await.unwrap();
    ops::append_message(&db, chat.id, "user", "hi", None, None, None, None, None, None).await.unwrap();

    ops::delete_chat(&db, chat.id).await.unwrap();
    let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE chat_id = ?")
        .bind(chat.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(orphans, 0, "messages cascade-deleted with the chat");
}

#[tokio::test]
async fn chat_tables_are_not_sync_tracked() {
    // A replica must NOT install change-capture triggers on chat tables (they're
    // host-only), or it would try to push transcripts to the host.
    let db = init_db_role(&temp_db("sync"), Role::Replica).await.unwrap();
    let triggers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND (name LIKE 'trg_chats_%' OR name LIKE 'trg_chat_messages_%')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(triggers, 0, "chats are host-only, never sync-captured");
}
