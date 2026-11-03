//! The project comment board: comments tagged with several tasks of a project
//! (an end-of-day update covering two tasks), task threads that include tagged
//! comments, retagging (home moves, replies follow), the Bin, permanent
//! delete, the board query, and the comment_tasks table syncing both ways.

use ganban_core::models::{CreateCommentInput, CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_cb_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

async fn project(db: &Db, name: &str) -> i64 {
    ops::create_project(db, CreateProjectInput { name: name.into(), description: None }).await.unwrap().id
}

async fn task(db: &Db, project_id: i64, title: &str) -> i64 {
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

fn input(task_id: i64, content: &str, tags: Vec<i64>, parent_id: Option<i64>) -> CreateCommentInput {
    CreateCommentInput { task_id, content: content.into(), user_id: Some(1), parent_id, profile_id: None, task_ids: tags }
}

async fn board_ids(db: &Db, pid: i64, filter: Option<Vec<i64>>) -> Vec<i64> {
    let b = ops::get_project_comment_board(db, pid, filter, None, None).await.unwrap();
    b.comments.iter().filter(|c| c.parent_id.is_none()).map(|c| c.id).collect()
}

async fn thread_ids(db: &Db, task_id: i64) -> HashSet<i64> {
    ops::get_task_comments(db, task_id).await.unwrap().iter().map(|c| c.id).collect()
}

#[tokio::test]
async fn one_update_tagged_on_two_tasks() {
    let db = init_db_role(&temp_db("tags"), Role::Server).await.unwrap();
    let p = project(&db, "Studies").await;
    let vessels = task(&db, p, "Learn vessels topic").await;
    let answers = task(&db, p, "Answer the questions").await;
    let other = task(&db, p, "Something else").await;
    let elsewhere = task(&db, project(&db, "Other project").await, "Not here").await;

    let eod = ops::create_comment(&db, input(vessels, "Ch16–19 done", vec![answers, answers, vessels], None)).await.unwrap();
    assert_eq!(eod.task_ids, vec![vessels, answers], "home first, extras deduped (home not repeated)");

    // Both task threads show it; an untagged task's doesn't.
    assert!(thread_ids(&db, vessels).await.contains(&eod.id));
    assert!(thread_ids(&db, answers).await.contains(&eod.id));
    assert!(!thread_ids(&db, other).await.contains(&eod.id));
    let in_answers = ops::get_task_comments(&db, answers).await.unwrap();
    assert_eq!(in_answers[0].task_ids, vec![vessels, answers], "a task thread carries the tags too");

    // A tag from another project is refused (and nothing half-written).
    let before = board_ids(&db, p, None).await.len();
    assert!(ops::create_comment(&db, input(vessels, "x", vec![elsewhere], None)).await.is_err());
    assert_eq!(board_ids(&db, p, None).await.len(), before);

    // A reply sent from the TAGGED task's thread lands on the thread's home
    // task — and shows in both threads.
    let reply = ops::create_comment(&db, input(answers, "nice", vec![], Some(eod.id))).await.unwrap();
    assert_eq!(reply.task_id, vessels, "a reply lives on its thread's home task");
    assert_eq!(reply.task_ids, vec![vessels], "replies carry no extra tags");
    assert!(thread_ids(&db, answers).await.contains(&reply.id), "reply visible from the tagged task");
    // …but a reply into another project's thread is refused.
    let foreign = ops::create_comment(&db, input(elsewhere, "far", vec![], None)).await.unwrap();
    assert!(ops::create_comment(&db, input(vessels, "sneaky", vec![], Some(foreign.id))).await.is_err());

    // Reactions on a tagged comment show from the tagged task.
    ops::toggle_comment_reaction(&db, eod.id, 1, "👍").await.unwrap();
    let r = ops::task_reaction_summary(&db, answers, 1).await.unwrap();
    assert!(r.iter().any(|x| x.comment_id == eod.id), "reactions follow the tag");
    let r = ops::project_reaction_summary(&db, p, 1).await.unwrap();
    assert_eq!(r.len(), 1);
}

#[tokio::test]
async fn retagging_moves_home_and_replies_follow() {
    let db = init_db_role(&temp_db("retag"), Role::Server).await.unwrap();
    let p = project(&db, "P").await;
    let (a, b, c) = (task(&db, p, "A").await, task(&db, p, "B").await, task(&db, p, "C").await);
    let root = ops::create_comment(&db, input(a, "root", vec![b], None)).await.unwrap();
    let reply = ops::create_comment(&db, input(a, "r1", vec![], Some(root.id))).await.unwrap();
    let deep = ops::create_comment(&db, input(a, "r2", vec![], Some(reply.id))).await.unwrap();

    // Drop A (the home): B becomes home, C is added; the whole thread moves.
    let re = ops::set_comment_tags(&db, root.id, vec![b, c]).await.unwrap();
    assert_eq!(re.task_ids, vec![b, c]);
    assert_eq!(re.task_id, b);
    let a_thread = thread_ids(&db, a).await;
    assert!(a_thread.is_empty(), "nothing left on A: {a_thread:?}");
    let c_thread = thread_ids(&db, c).await;
    for id in [root.id, reply.id, deep.id] {
        assert!(c_thread.contains(&id), "the whole thread is visible from C");
    }
    let homes: Vec<i64> = sqlx::query_scalar("SELECT task_id FROM comments WHERE id IN (?, ?) ORDER BY id")
        .bind(reply.id)
        .bind(deep.id)
        .fetch_all(&db)
        .await
        .unwrap();
    assert_eq!(homes, vec![b, b], "replies moved with their thread");
    let extra_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comment_tasks WHERE comment_id = ?")
        .bind(root.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(extra_rows, 1, "the home is never duplicated in comment_tasks");

    // Unchanged tags keep their row (sync identity).
    let uuid_before: String = sqlx::query_scalar("SELECT sync_uuid FROM comment_tasks WHERE comment_id = ?")
        .bind(root.id)
        .fetch_one(&db)
        .await
        .unwrap();
    ops::set_comment_tags(&db, root.id, vec![b, c]).await.unwrap();
    let uuid_after: String = sqlx::query_scalar("SELECT sync_uuid FROM comment_tasks WHERE comment_id = ?")
        .bind(root.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(uuid_before, uuid_after, "a no-op retag rewrites nothing");

    assert!(ops::set_comment_tags(&db, root.id, vec![]).await.is_err(), "at least one task");
    assert!(ops::set_comment_tags(&db, reply.id, vec![c]).await.is_err(), "replies follow their thread");
}

#[tokio::test]
async fn board_filters_counts_bin_and_permanent_delete() {
    let db = init_db_role(&temp_db("board"), Role::Server).await.unwrap();
    let p = project(&db, "P").await;
    let (a, b, c) = (task(&db, p, "A").await, task(&db, p, "B").await, task(&db, p, "C").await);
    let only_a = ops::create_comment(&db, input(a, "a", vec![], None)).await.unwrap();
    let a_and_b = ops::create_comment(&db, input(a, "ab", vec![b], None)).await.unwrap();
    let only_c = ops::create_comment(&db, input(c, "c", vec![], None)).await.unwrap();
    let reply = ops::create_comment(&db, input(a, "re", vec![], Some(a_and_b.id))).await.unwrap();

    // Newest first; replies ride along but aren't roots.
    assert_eq!(board_ids(&db, p, None).await, vec![only_c.id, a_and_b.id, only_a.id]);
    let full = ops::get_project_comment_board(&db, p, None, None, None).await.unwrap();
    assert!(full.comments.iter().any(|x| x.id == reply.id), "replies included");
    assert!(!full.has_more);

    // Filter = ANY of the picked tasks.
    assert_eq!(board_ids(&db, p, Some(vec![b])).await, vec![a_and_b.id]);
    assert_eq!(board_ids(&db, p, Some(vec![b, c])).await, vec![only_c.id, a_and_b.id]);
    let filtered = ops::get_project_comment_board(&db, p, Some(vec![b]), None, None).await.unwrap();
    assert!(filtered.comments.iter().any(|x| x.id == reply.id), "a filtered root keeps its replies");

    // Counts per task (top-level only), whole project regardless of filter.
    let count = |id: i64| filtered.task_counts.iter().find(|t| t.task_id == id).map(|t| t.count).unwrap_or(0);
    assert_eq!((count(a), count(b), count(c)), (2, 1, 1));

    // Limit + has_more.
    let page = ops::get_project_comment_board(&db, p, None, Some(2), None).await.unwrap();
    assert!(page.has_more);
    assert_eq!(page.comments.iter().filter(|x| x.parent_id.is_none()).count(), 2);

    // In the Bin: hidden once ALL its tasks are binned.
    ops::delete_task(&db, a).await.unwrap();
    let ids = board_ids(&db, p, None).await;
    assert!(!ids.contains(&only_a.id), "only-A is hidden with A in the Bin");
    assert!(ids.contains(&a_and_b.id), "still tagged on a live task (B)");
    ops::restore_task(&db, a).await.unwrap();

    // Permanently deleting the HOME task keeps a comment tagged elsewhere.
    ops::permanently_delete_task(&db, a).await.unwrap();
    let ids = board_ids(&db, p, None).await;
    assert!(!ids.contains(&only_a.id), "only-A goes with its task");
    assert!(ids.contains(&a_and_b.id), "the A+B update survives on B");
    assert!(thread_ids(&db, b).await.contains(&reply.id), "…with its reply");
    let survivor = ops::get_task_comments(&db, b).await.unwrap().into_iter().find(|x| x.id == a_and_b.id).unwrap();
    assert_eq!(survivor.task_ids, vec![b]);
}

#[tokio::test]
async fn time_since_feeds_worked_on_today() {
    let db = init_db_role(&temp_db("today"), Role::Server).await.unwrap();
    let p = project(&db, "P").await;
    let (a, b) = (task(&db, p, "A").await, task(&db, p, "B").await);
    for (t, start, dur) in [
        (a, "2026-10-12T08:00:00.000+00:00", 3600),
        (a, "2026-10-12 13:00:00", 1800),
        (b, "2026-10-11T08:00:00Z", 999), // yesterday
    ] {
        sqlx::query("INSERT INTO time_entries (task_id, start_time, end_time, duration) VALUES (?, ?, ?, ?)")
            .bind(t)
            .bind(start)
            .bind(start)
            .bind(dur)
            .execute(&db)
            .await
            .unwrap();
    }
    let b0 = ops::get_project_comment_board(&db, p, None, None, Some("2026-10-12T00:00:00Z".into())).await.unwrap();
    assert_eq!(b0.time_since.len(), 1, "only today's task: {:?}", b0.time_since);
    assert_eq!((b0.time_since[0].task_id, b0.time_since[0].seconds), (a, 5400), "both timestamp spellings counted");
    let none = ops::get_project_comment_board(&db, p, None, None, None).await.unwrap();
    assert!(none.time_since.is_empty());
}

// ---- sync: comment_tasks travels both ways with remapped ids ----

async fn sync_run(host: &Db, replica: &Db, cursor: &mut String) -> Value {
    let pulled = sync::pull(host, cursor).await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(pulled["changes"].clone()).unwrap();
    sync::ingest(replica, changes).await.unwrap();
    *cursor = pulled["cursor"].as_str().unwrap().to_string();
    let pending = sync::local_pending(replica).await.unwrap();
    if pending.is_empty() {
        return json!({ "applied": [] });
    }
    let pchanges: Vec<sync::IncomingChange> = serde_json::from_value(Value::Array(pending.clone())).unwrap();
    let push = sync::push(host, pchanges).await.unwrap();
    let applied: HashSet<String> =
        push["applied"].as_array().unwrap().iter().filter_map(|v| v.as_str().map(String::from)).collect();
    let acks: Vec<Value> = pending
        .iter()
        .filter(|c| applied.contains(c["sync_uuid"].as_str().unwrap_or_default()))
        .map(|c| {
            json!({ "entity": c["entity"], "sync_uuid": c["sync_uuid"],
                    "op": c.get("op").cloned().unwrap_or_else(|| json!("upsert")),
                    "pushed_updated_at": c["data"].get("updated_at").cloned().unwrap_or(Value::Null) })
        })
        .collect();
    sync::ack(replica, serde_json::from_value(Value::Array(acks)).unwrap()).await.unwrap();
    push
}

async fn local_id(db: &Db, table: &str, uuid: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT id FROM {table} WHERE sync_uuid = ?")).bind(uuid).fetch_one(db).await.unwrap()
}
async fn uuid_of(db: &Db, table: &str, id: i64) -> String {
    sqlx::query_scalar(&format!("SELECT sync_uuid FROM {table} WHERE id = ?")).bind(id).fetch_one(db).await.unwrap()
}

#[tokio::test]
async fn comment_tags_sync_both_ways() {
    let host = init_db_role(&temp_db("sync_host"), Role::Server).await.unwrap();
    let p = project(&host, "P").await;
    // Offset the replica's id space so a missing FK remap would show.
    let _pad = task(&host, p, "pad").await;
    let (a, b, c) = (task(&host, p, "A").await, task(&host, p, "B").await, task(&host, p, "C").await);
    let cm = ops::create_comment(&host, input(a, "eod", vec![b], None)).await.unwrap();

    let replica = init_db_role(&temp_db("sync_replica"), Role::Replica).await.unwrap();
    // Local-only rows first, so the replica's ids for host rows are shifted.
    let lp = project(&replica, "Local").await;
    for i in 0..3 {
        task(&replica, lp, &format!("local {i}")).await;
    }
    let mut cursor = String::new();
    sync_run(&host, &replica, &mut cursor).await;

    // Host → replica: the tag arrived, pointing at the replica's own ids.
    let (ra, rb, rc) = (
        local_id(&replica, "tasks", &uuid_of(&host, "tasks", a).await).await,
        local_id(&replica, "tasks", &uuid_of(&host, "tasks", b).await).await,
        local_id(&replica, "tasks", &uuid_of(&host, "tasks", c).await).await,
    );
    let rcm = local_id(&replica, "comments", &uuid_of(&host, "comments", cm.id).await).await;
    assert_ne!((ra, rb), (a, b), "id spaces really differ (else this test proves nothing)");
    let in_rb = ops::get_task_comments(&replica, rb).await.unwrap();
    assert_eq!(in_rb.iter().find(|x| x.id == rcm).map(|x| x.task_ids.clone()), Some(vec![ra, rb]), "tag pulled + remapped");

    // Replica (offline) retags B → C; the push lands on the host's ids.
    ops::set_comment_tags(&replica, rcm, vec![ra, rc]).await.unwrap();
    let push = sync_run(&host, &replica, &mut cursor).await;
    assert!(!push["applied"].as_array().unwrap().is_empty(), "retag pushed: {push}");
    let on_host = ops::get_task_comments(&host, c).await.unwrap();
    assert_eq!(on_host.iter().find(|x| x.id == cm.id).map(|x| x.task_ids.clone()), Some(vec![a, c]), "host converged");
    assert!(!thread_ids(&host, b).await.contains(&cm.id), "the removed tag is gone on the host too");
}
