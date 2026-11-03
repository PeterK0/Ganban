//! Per-user stash-tab state (game saves, quiz history): keyed by
//! (project, tab, user), upsert semantics, survives independent of the tab's
//! enablement row.

use ganban_core::models::{CreateProjectInput, CreateUserInput};
use ganban_core::{init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_tabstate_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

#[tokio::test]
async fn state_roundtrip_is_per_user_and_survives_disable() {
    let db = init_db(&temp_db("roundtrip")).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None })
        .await
        .unwrap()
        .id;
    let alice = ops::create_user(
        &db,
        CreateUserInput { username: "alice".into(), full_name: "Alice".into(), email: None },
    )
    .await
    .unwrap()
    .id;
    let bob = ops::create_user(
        &db,
        CreateUserInput { username: "bob".into(), full_name: "Bob".into(), email: None },
    )
    .await
    .unwrap()
    .id;

    // Unset → '{}', never an error.
    assert_eq!(ops::tab_user_state(&db, pid, "quiz", alice).await.unwrap(), "{}");

    // Upsert + per-user isolation.
    ops::set_tab_user_state(&db, pid, "quiz", alice, r#"{"v":1,"best":9}"#).await.unwrap();
    ops::set_tab_user_state(&db, pid, "quiz", bob, r#"{"v":1,"best":3}"#).await.unwrap();
    ops::set_tab_user_state(&db, pid, "quiz", alice, r#"{"v":1,"best":10}"#).await.unwrap();
    assert_eq!(
        ops::tab_user_state(&db, pid, "quiz", alice).await.unwrap(),
        r#"{"v":1,"best":10}"#
    );
    assert_eq!(ops::tab_user_state(&db, pid, "quiz", bob).await.unwrap(), r#"{"v":1,"best":3}"#);

    // Different tab id = different row.
    assert_eq!(ops::tab_user_state(&db, pid, "chess", alice).await.unwrap(), "{}");

    // State exists independently of project_tabs enablement: toggling the tab
    // off and on must not touch the saves.
    ops::set_project_tab(&db, pid, "quiz", true).await.unwrap();
    ops::set_project_tab(&db, pid, "quiz", false).await.unwrap();
    assert_eq!(
        ops::tab_user_state(&db, pid, "quiz", alice).await.unwrap(),
        r#"{"v":1,"best":10}"#
    );
}
