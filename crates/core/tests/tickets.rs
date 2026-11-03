//! In-app tickets: create, owner-vs-member list scoping (the security-relevant
//! bit), submitter-name resolution, status toggle, and input normalization —
//! exercising the real SQL (LEFT JOIN, the is_owner branch) which is only checked
//! at runtime.

use ganban_core::models::CreateUserInput;
use ganban_core::{auth, init_db_role, ops, Db, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_tickets_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn user(db: &Db, username: &str, name: &str) -> i64 {
    ops::create_user(db, CreateUserInput { username: username.into(), full_name: name.into(), email: None })
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn create_list_scope_and_status() {
    let db = init_db_role(&temp_db("t"), Role::Server).await.unwrap();
    let owner = auth::ensure_owner(&db).await.unwrap(); // the real owner (seeded/first user)
    let member = user(&db, "member", "Member Mae").await;

    let _t1 = ops::create_ticket(&db, owner, "bug", "Owner bug", None).await.unwrap();
    let t2 = ops::create_ticket(&db, member, "feature", "Member wish", Some("please")).await.unwrap();
    assert_eq!(t2.kind, "feature");
    assert_eq!(t2.status, "open");

    // Owner sees ALL, with submitter names resolved via the join.
    let all = ops::list_tickets(&db, owner).await.unwrap();
    assert_eq!(all.len(), 2, "owner sees every ticket");
    assert!(all.iter().any(|t| t.submitter_name.as_deref() == Some("Member Mae")), "submitter resolved");

    // Member sees ONLY their own.
    let mine = ops::list_tickets(&db, member).await.unwrap();
    assert_eq!(mine.len(), 1, "member sees only their own");
    assert_eq!(mine[0].title, "Member wish");

    // Status toggle is reflected.
    ops::set_ticket_status(&db, t2.id, "closed").await.unwrap();
    assert_eq!(ops::list_tickets(&db, member).await.unwrap()[0].status, "closed");

    // Normalization: unknown kind → "bug"; blank title rejected; junk status → "open".
    assert_eq!(ops::create_ticket(&db, member, "WeIrD", "typo kind", None).await.unwrap().kind, "bug");
    assert!(ops::create_ticket(&db, member, "bug", "   ", None).await.is_err(), "blank title rejected");
    ops::set_ticket_status(&db, t2.id, "nonsense").await.unwrap();
    assert_eq!(ops::list_tickets(&db, member).await.unwrap()[0].status, "open", "junk status falls back to open");
}
