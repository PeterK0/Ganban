//! P2.2c — ingest (the host->replica direction of the apply engine).
//!
//! A replica feeds `pull`'s output through `ingest` and gets the host's graph
//! mapped into its OWN id-space: FKs remapped via sync_uuid, fresh local ids
//! minted, host `users` adopted by id, and the host's `updated_at` trusted.

use ganban_core::models::{CreateCommentInput, CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_ingest_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn task_in(db: &Db) -> CreateTaskInput {
    let pid = ops::create_project(db, CreateProjectInput { name: "_".into(), description: None }).await.unwrap().id;
    CreateTaskInput {
        project_id: pid,
        area_id: None,
        title: "_".into(),
        description: None,
        status: "To Do".into(),
        priority: "Medium".into(),
        prefix: None,
        cost: None,
        currency: None,
        deadline: None,
    }
}

async fn col<T>(db: &Db, sql: &str, bind: i64) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + Send + Unpin,
{
    sqlx::query_scalar::<_, T>(sql).bind(bind).fetch_one(db).await.unwrap()
}

#[tokio::test]
async fn ingest_maps_host_graph_into_replica_id_space() {
    // ---- Host (authoritative) ----
    let host = init_db_role(&temp_db("host"), Role::Server).await.unwrap();
    let h_pid = ops::create_project(&host, CreateProjectInput { name: "Roof".into(), description: None })
        .await
        .unwrap()
        .id;
    let h_tid = ops::create_task(
        &host,
        CreateTaskInput {
            project_id: h_pid,
            area_id: None,
            title: "Flash chimney".into(),
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
    let h_cid = ops::create_comment(&host, CreateCommentInput { task_id: h_tid, content: "done".into(), user_id: Some(1), parent_id: None, profile_id: None, task_ids: vec![] })
        .await
        .unwrap()
        .id;

    let proj_uuid: String = col(&host, "SELECT sync_uuid FROM projects WHERE id=?", h_pid).await;
    let task_uuid: String = col(&host, "SELECT sync_uuid FROM tasks WHERE id=?", h_tid).await;
    let comment_uuid: String = col(&host, "SELECT sync_uuid FROM comments WHERE id=?", h_cid).await;
    let user_uuid: String = col(&host, "SELECT sync_uuid FROM users WHERE id=?", 1).await;
    let host_task_updated: String = col(&host, "SELECT updated_at FROM tasks WHERE id=?", h_tid).await;

    let pulled = sync::pull(&host, "").await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(pulled["changes"].clone()).unwrap();

    // ---- Replica ----
    let replica = init_db_role(&temp_db("replica"), Role::Replica).await.unwrap();
    // Offset the replica's id counters so a blind id-copy would be wrong and
    // FK remapping is observable.
    for _ in 0..3 {
        let ti = task_in(&replica).await;
        ops::create_task(&replica, ti).await.unwrap();
    }

    // Mimic the orchestrator's echo-guard around the apply.
    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&replica).await.unwrap();
    let report = sync::ingest(&replica, changes).await.unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&replica).await.unwrap();
    assert!(report["rejected"].as_array().unwrap().is_empty(), "nothing rejected: {report}");

    // Project landed with a LOCAL (minted, offset) id, same sync_uuid.
    let (r_pid, r_pname): (i64, String) =
        sqlx::query_as("SELECT id, name FROM projects WHERE sync_uuid=?").bind(&proj_uuid).fetch_one(&replica).await.unwrap();
    assert_eq!(r_pname, "Roof");
    assert_ne!(r_pid, h_pid, "replica minted its own project id (FK remap is real)");

    // Task FK remapped to the replica's project id.
    let (r_tid, r_proj_fk, r_title, r_task_updated): (i64, i64, String, String) =
        sqlx::query_as("SELECT id, project_id, title, updated_at FROM tasks WHERE sync_uuid=?")
            .bind(&task_uuid)
            .fetch_one(&replica)
            .await
            .unwrap();
    assert_eq!(r_proj_fk, r_pid, "task.project_id remapped to the replica's project id");
    assert_eq!(r_title, "Flash chimney");
    assert_eq!(r_task_updated, host_task_updated, "ingest trusts the host's updated_at, not a fresh stamp");

    // Comment: task_id remapped; user_id is the raw adopted id.
    let (c_task_fk, c_user): (i64, i64) = sqlx::query_as("SELECT task_id, user_id FROM comments WHERE sync_uuid=?")
        .bind(&comment_uuid)
        .fetch_one(&replica)
        .await
        .unwrap();
    assert_eq!(c_task_fk, r_tid, "comment.task_id remapped to the replica's task id");
    assert_eq!(c_user, 1, "comment.user_id kept as the raw host id");

    // Host user adopted verbatim at id 1, replacing the replica's bootstrapped one.
    let r_user_uuid: String = col(&replica, "SELECT sync_uuid FROM users WHERE id=?", 1).await;
    assert_eq!(r_user_uuid, user_uuid, "host user adopted by id (host-authoritative)");
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&replica).await.unwrap();
    assert_eq!(user_count, 1, "no duplicate user row created");
}

#[tokio::test]
async fn ingest_remaps_reply_parent_id() {
    // A threaded reply's self-referencing parent_id must remap to the replica's
    // own parent-comment id — proving the generic FK machinery carries it, no
    // hardcoded column.
    use ganban_core::models::CreateCommentInput;
    let host = init_db_role(&temp_db("replyhost"), Role::Server).await.unwrap();
    let tid = ops::create_task(&host, task_in(&host).await).await.unwrap().id;
    let parent = ops::create_comment(&host, CreateCommentInput { task_id: tid, content: "q".into(), user_id: Some(1), parent_id: None, profile_id: None, task_ids: vec![] })
        .await
        .unwrap();
    let reply = ops::create_comment(&host, CreateCommentInput { task_id: tid, content: "a".into(), user_id: Some(1), parent_id: Some(parent.id), profile_id: None, task_ids: vec![] })
        .await
        .unwrap();
    let parent_uuid: String = col(&host, "SELECT sync_uuid FROM comments WHERE id=?", parent.id).await;
    let reply_uuid: String = col(&host, "SELECT sync_uuid FROM comments WHERE id=?", reply.id).await;

    let pulled = sync::pull(&host, "").await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(pulled["changes"].clone()).unwrap();

    let replica = init_db_role(&temp_db("replyreplica"), Role::Replica).await.unwrap();
    // Offset the replica's comment id space so a blind id-copy would be wrong.
    let rt = ops::create_task(&replica, task_in(&replica).await).await.unwrap().id;
    ops::create_comment(&replica, CreateCommentInput { task_id: rt, content: "local".into(), user_id: None, parent_id: None, profile_id: None, task_ids: vec![] })
        .await
        .unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&replica).await.unwrap();
    sync::ingest(&replica, changes).await.unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&replica).await.unwrap();

    let r_parent_id: i64 = sqlx::query_scalar("SELECT id FROM comments WHERE sync_uuid=?")
        .bind(&parent_uuid)
        .fetch_one(&replica)
        .await
        .unwrap();
    let r_reply_parent: Option<i64> = sqlx::query_scalar("SELECT parent_id FROM comments WHERE sync_uuid=?")
        .bind(&reply_uuid)
        .fetch_one(&replica)
        .await
        .unwrap();
    assert_eq!(r_reply_parent, Some(r_parent_id), "reply.parent_id remapped to the replica's parent comment id");
    assert_ne!(r_parent_id, parent.id, "replica minted its own comment ids (remap is real)");
}

#[tokio::test]
async fn push_still_rejects_users() {
    // The Mode refactor must not loosen the host's security policy.
    let host = init_db_role(&temp_db("pushusers"), Role::Server).await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(serde_json::json!([
        { "entity": "users", "sync_uuid": "evil", "data": { "username": "hacker", "is_owner": 1 } }
    ]))
    .unwrap();
    let report = sync::push(&host, changes).await.unwrap();
    assert!(report["id_remap"].as_object().unwrap().is_empty(), "users push mints nothing");
    let rejected = report["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1, "users push rejected");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username='hacker'").fetch_one(&host).await.unwrap();
    assert_eq!(n, 0, "no hacker user created");
}
