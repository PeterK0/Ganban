//! The pending-invites list + revoke: exercises the real SQL (LEFT JOINs to
//! resolve project/joiner names, the optional project scoping, and DELETE) which
//! is only validated at runtime, plus invite_status, end to end.

use ganban_core::models::CreateProjectInput;
use ganban_core::{auth, init_db_role, ops, Db, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_pendinv_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn project(db: &Db, name: &str) -> i64 {
    ops::create_project(db, CreateProjectInput { name: name.into(), description: None })
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn list_scope_and_revoke() {
    let db = init_db_role(&temp_db("list"), Role::Server).await.unwrap();
    let pid = project(&db, "Apollo").await;
    let other = project(&db, "Zephyr").await;

    let raw = auth::create_enrollment_token(&db, "invite", None, Some(pid), Some("member"), Some("Alice"), auth::INVITE_TTL_SECS)
        .await
        .unwrap();

    // Global list resolves the project name and shows the inviter's label, pending.
    let all = auth::list_invites(&db, None).await.unwrap();
    assert_eq!(all.len(), 1, "one token globally");
    let inv = &all[0];
    assert_eq!(inv.state, "pending");
    assert_eq!(inv.project_name.as_deref(), Some("Apollo"));
    assert_eq!(inv.display_name.as_deref(), Some("Alice"));
    assert!(inv.joined_name.is_none(), "no joiner until redeemed");

    // Project scoping: matches its own project, excludes others.
    assert_eq!(auth::list_invites(&db, Some(pid)).await.unwrap().len(), 1);
    assert_eq!(auth::list_invites(&db, Some(other)).await.unwrap().len(), 0);

    // invite_status by raw token agrees it's live.
    assert_eq!(auth::invite_status(&db, &raw).await.unwrap().state, "pending");

    // Revoke removes it AND neutralizes the token (enroll now fails).
    auth::revoke_invite(&db, inv.id).await.unwrap();
    assert_eq!(auth::list_invites(&db, None).await.unwrap().len(), 0, "gone after revoke");
    assert_eq!(auth::invite_status(&db, &raw).await.unwrap().state, "unknown");
    assert!(auth::enroll(&db, &raw, None, None).await.is_err(), "revoked token can't be redeemed");
}

#[tokio::test]
async fn joined_name_resolves_after_enroll() {
    let db = init_db_role(&temp_db("joined"), Role::Server).await.unwrap();
    let pid = project(&db, "Apollo").await;
    let raw = auth::create_enrollment_token(&db, "invite", None, Some(pid), Some("member"), Some("Bequest"), auth::INVITE_TTL_SECS)
        .await
        .unwrap();

    // The joiner's chosen name wins and is recorded against the token.
    auth::enroll(&db, &raw, Some("phone"), Some("Real Name")).await.unwrap();

    let all = auth::list_invites(&db, None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].state, "joined");
    assert_eq!(all[0].joined_name.as_deref(), Some("Real Name"), "resolves the freshly-created account");
}
