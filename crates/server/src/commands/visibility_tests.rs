//! Task visibility (ADR 0002) through the command table, as signed-in members see it.

use serde_json::{json, Value};

use super::testkit::*;
use crate::AuthUser;

const ANA: i64 = 8; // the project's admin
const MIA: i64 = 7; // member, in the restricted Finance area
const BO: i64 = 9; // member, selected on the offer letter

struct World {
    db: ganban_core::Db,
    project: i64,
    finance: i64,
    ops_area: i64,
    open: i64,
    budget: i64,
    offer: i64,
    secret: i64,
    ana: AuthUser,
    mia: AuthUser,
    bo: AuthUser,
}

fn task_input(project: i64, title: &str, area: Option<i64>) -> Value {
    json!({ "input": { "project_id": project, "area_id": area, "title": title, "status": "To Do", "priority": "Low" } })
}

async fn world(tag: &str) -> World {
    let db = test_db(tag).await;
    owner(&db).await;
    let project = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
    let ana = member(&db, ANA, &[(project, "admin")]).await;
    let mia = member(&db, MIA, &[(project, "member")]).await;
    let bo = member(&db, BO, &[(project, "member")]).await;
    let area = |name: &str| json!({ "input": { "project_id": project, "name": name } });
    let finance = seed(&db, "create_area", area("Finance")).await["id"].as_i64().unwrap();
    let ops_area = seed(&db, "create_area", area("Ops")).await["id"].as_i64().unwrap();
    http(&db, ana, "set_area_restricted", json!({ "areaId": finance, "restricted": true })).await.unwrap();
    http(&db, ana, "set_area_members", json!({ "areaId": finance, "userIds": [MIA] })).await.unwrap();
    let open = seed(&db, "create_task", task_input(project, "Open", None)).await["id"].as_i64().unwrap();
    let budget = seed(&db, "create_task", task_input(project, "Budget", Some(finance))).await["id"].as_i64().unwrap();
    let offer = seed(&db, "create_task", task_input(project, "Offer letter", None)).await["id"].as_i64().unwrap();
    let secret = seed(&db, "create_task", task_input(project, "Reorg", None)).await["id"].as_i64().unwrap();
    http(&db, ana, "set_task_visibility", json!({ "taskId": offer, "visibility": "members", "memberIds": [BO] })).await.unwrap();
    http(&db, ana, "set_task_visibility", json!({ "taskId": secret, "visibility": "admins" })).await.unwrap();
    World { db, project, finance, ops_area, open, budget, offer, secret, ana, mia, bo }
}

fn sorted(mut v: Vec<i64>) -> Vec<i64> {
    v.sort_unstable();
    v
}

#[tokio::test]
async fn each_member_lists_only_the_tasks_in_their_audience() {
    let w = world("vis_lists").await;
    let tasks = |who| http(&w.db, who, "get_tasks", json!({ "projectId": w.project }));
    assert_eq!(sorted(ids(&tasks(w.bo).await.unwrap())), sorted(vec![w.open, w.offer]));
    assert_eq!(sorted(ids(&tasks(w.mia).await.unwrap())), sorted(vec![w.open, w.budget]));
    assert_eq!(ids(&tasks(w.ana).await.unwrap()).len(), 4, "admins see every task");

    let areas = |who| http(&w.db, who, "get_areas", json!({ "projectId": w.project }));
    assert_eq!(ids(&areas(w.bo).await.unwrap()), vec![w.ops_area], "a restricted area is hidden too");
    assert_eq!(sorted(ids(&areas(w.mia).await.unwrap())), sorted(vec![w.finance, w.ops_area]));

    let stats = http(&w.db, w.bo, "get_project_stats", json!({ "projectId": w.project })).await.unwrap();
    assert_eq!(stats["total_tasks"], 2, "counts cover only what Bo sees");
}

#[tokio::test]
async fn a_hidden_task_and_everything_on_it_is_not_found() {
    let w = world("vis_rows").await;
    let entry = seed(&w.db, "start_time_entry", json!({ "taskId": w.budget, "userId": MIA })).await["id"].as_i64().unwrap();
    let local = std::env::temp_dir().join("ganban_vis_attachment.txt");
    std::fs::write(&local, b"x").unwrap();
    let file = json!({ "input": { "task_id": w.budget, "file_path": local.to_string_lossy(), "file_name": "f.txt" } });
    let attachment = seed(&w.db, "create_file_attachment", file).await["id"].as_i64().unwrap();
    let on_budget = json!({ "input": { "task_id": w.budget, "user_id": MIA, "content": "numbers" } });
    let comment = seed(&w.db, "create_comment", on_budget).await["id"].as_i64().unwrap();

    let reads: Vec<(&str, Value)> = vec![
        ("get_task_comments", json!({ "taskId": w.budget })),
        ("get_time_entries", json!({ "taskId": w.budget })),
        ("get_file_attachments", json!({ "taskId": w.budget })),
        ("get_assignees", json!({ "taskId": w.budget })),
        ("update_task", json!({ "taskId": w.budget, "input": { "title": "Mine now" } })),
        ("update_comment", json!({ "commentId": comment, "input": { "content": "edited" } })),
        ("update_file_attachment", json!({ "attachmentId": attachment, "input": { "notes": "n" } })),
        ("stop_time_entry", json!({ "entryId": entry })),
        ("create_comment", json!({ "input": { "task_id": w.budget, "content": "hi" } })),
        ("get_area_members", json!({ "areaId": w.finance })),
    ];
    for (cmd, args) in reads {
        let err = http(&w.db, w.bo, cmd, args.clone()).await.unwrap_err();
        assert!(err.is_not_found(), "{cmd} on a task Bo can't see looks absent: {err}");
        assert!(http(&w.db, w.mia, cmd, args).await.is_ok(), "{cmd} works for Mia, who's in Finance");
    }
    assert!(http(&w.db, w.mia, "get_task_comments", json!({ "taskId": w.secret })).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn the_board_trims_updates_to_the_tasks_a_member_sees() {
    let w = world("vis_board").await;
    let both = json!({ "input": { "task_id": w.budget, "task_ids": [w.open], "user_id": MIA, "content": "Budget + open" } });
    let shared = seed(&w.db, "create_comment", both).await["id"].as_i64().unwrap();
    let only_budget = json!({ "input": { "task_id": w.budget, "user_id": MIA, "content": "Budget only" } });
    let hidden = seed(&w.db, "create_comment", only_budget).await["id"].as_i64().unwrap();

    let board = http(&w.db, w.bo, "get_project_comment_board", json!({ "projectId": w.project })).await.unwrap();
    let comments = board["comments"].as_array().unwrap();
    assert_eq!(ids(&board["comments"]), vec![shared], "the budget-only update is hidden");
    assert_eq!(comments[0]["task_ids"], json!([w.open]), "the budget tag is trimmed");
    assert_eq!(comments[0]["task_id"], w.open, "a reply goes to a task Bo can see");
    assert!(board["task_counts"].as_array().unwrap().iter().all(|c| c["task_id"] != w.budget));

    // A reply lives on its thread's home task (the hidden budget), but Bo sees the thread
    // through the open tag, so he can see, edit and answer the reply too.
    let reply = json!({ "input": { "task_id": w.budget, "parent_id": shared, "user_id": MIA, "content": "re" } });
    let reply = seed(&w.db, "create_comment", reply).await["id"].as_i64().unwrap();
    let edit = json!({ "commentId": reply, "input": { "content": "re (edited)" } });
    assert!(http(&w.db, w.bo, "update_comment", edit).await.is_ok(), "the reply is in a thread Bo sees");

    let threads = http(&w.db, w.bo, "get_task_comments", json!({ "taskId": w.open })).await.unwrap();
    assert!(threads.as_array().unwrap().iter().all(|c| c["task_ids"] == json!([w.open])), "{threads}");
    let mia_board = http(&w.db, w.mia, "get_project_comment_board", json!({ "projectId": w.project })).await.unwrap();
    assert_eq!(sorted(ids(&mia_board["comments"])), sorted(vec![shared, hidden, reply]));

    let into_hidden = json!({ "input": { "task_id": w.open, "parent_id": hidden, "content": "sneaky" } });
    assert!(http(&w.db, w.bo, "create_comment", into_hidden).await.unwrap_err().is_not_found(), "no replying into a hidden thread");

    let retag = json!({ "commentId": shared, "taskIds": [w.open, w.secret] });
    assert!(http(&w.db, w.mia, "set_comment_tags", retag).await.unwrap_err().is_not_found(), "no tagging a task you can't see");
    let tagged_hidden = json!({ "input": { "task_id": w.open, "task_ids": [w.secret], "content": "x" } });
    assert!(http(&w.db, w.mia, "create_comment", tagged_hidden).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn only_admins_widen_who_sees_a_task() {
    let w = world("vis_admin").await;
    let set = |task: i64| json!({ "taskId": task, "visibility": "area" });
    assert!(http(&w.db, w.mia, "set_task_visibility", set(w.budget)).await.unwrap_err().is_forbidden());
    let restrict = json!({ "areaId": w.ops_area, "restricted": true });
    assert!(http(&w.db, w.mia, "set_area_restricted", restrict).await.unwrap_err().is_forbidden());
    let members = json!({ "areaId": w.ops_area, "userIds": [MIA] });
    assert!(http(&w.db, w.mia, "set_area_members", members).await.unwrap_err().is_forbidden());

    // Filing into an area you can see is fine; taking a task out of a restricted area isn't.
    let move_to = |task: i64, area: i64| json!({ "taskId": task, "input": { "area_id": area } });
    assert!(http(&w.db, w.mia, "update_task", move_to(w.open, w.finance)).await.is_ok(), "Mia files into Finance");
    assert!(http(&w.db, w.mia, "update_task", move_to(w.budget, w.ops_area)).await.unwrap_err().is_forbidden());
    // Clearing the area (null) takes it out too.
    let clear_area = |task: i64| json!({ "taskId": task, "input": { "area_id": null } });
    assert!(http(&w.db, w.mia, "update_task", clear_area(w.budget)).await.unwrap_err().is_forbidden());
    assert!(http(&w.db, w.ana, "update_task", clear_area(w.open)).await.is_ok(), "an admin may");
    assert!(http(&w.db, w.ana, "update_task", move_to(w.budget, w.ops_area)).await.is_ok());
    let into_finance = task_input(w.project, "Mine", Some(w.finance));
    assert!(http(&w.db, w.bo, "create_task", into_finance).await.unwrap_err().is_not_found(), "Bo can't see Finance");
    assert!(http(&w.db, w.bo, "update_task", move_to(w.offer, w.finance)).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn assigning_lets_someone_in_and_the_audience_says_who() {
    let w = world("vis_assign").await;
    let audience = http(&w.db, w.mia, "get_task_audience", json!({ "taskId": w.budget })).await.unwrap();
    assert_eq!(audience["visibility"], "area");
    assert_eq!(audience["area"]["name"], "Finance");
    assert_eq!(audience["area"]["restricted"], true);
    assert_eq!(audience["audience"], json!([1, MIA, ANA]));

    http(&w.db, w.mia, "assign_task", json!({ "taskId": w.budget, "userId": BO })).await.unwrap();
    assert!(http(&w.db, w.bo, "get_task_comments", json!({ "taskId": w.budget })).await.is_ok(), "Bo is in now");
    let bo_sees = http(&w.db, w.bo, "get_task_audience", json!({ "taskId": w.budget })).await.unwrap();
    assert_eq!(bo_sees["area"], Value::Null, "the task, but not the restricted area's name");
    let mine = http(&w.db, w.bo, "get_my_assignments", json!({})).await.unwrap();
    assert_eq!(mine.as_array().unwrap().len(), 1);

    let offer = http(&w.db, w.ana, "get_task_audience", json!({ "taskId": w.offer })).await.unwrap();
    assert_eq!((offer["visibility"].clone(), offer["selected"].clone()), (json!("members"), json!([BO])));
}

#[tokio::test]
async fn a_mention_reaches_only_those_who_can_see_the_task() {
    let w = world("vis_mention").await;
    let mention = json!({ "input": { "task_id": w.budget, "user_id": MIA, "content": "@user9 @user8 have a look" } });
    seed(&w.db, "create_comment", mention).await;
    let count = |v: Value| v.as_array().unwrap().len();
    let bo = http(&w.db, w.bo, "get_notifications", json!({})).await.unwrap();
    assert_eq!(count(bo), 0, "Bo can't see the budget, so he isn't told");
    assert_eq!(count(http(&w.db, w.ana, "get_notifications", json!({})).await.unwrap()), 1);
}

#[tokio::test]
async fn proposals_and_agent_time_go_with_their_task() {
    let w = world("vis_agents").await;
    let draft = json!({ "projectId": w.project, "tool": "update_task", "args": { "task_id": w.open, "title": "Renamed" }, "userId": MIA });
    http(&w.db, w.mia, "submit_proposal", draft).await.unwrap();
    assert_eq!(ganban_core::proposals::list_for_user(&w.db, MIA, false).await.unwrap().len(), 1);
    // The task is narrowed away from Mia: her pending proposal quotes it, so it goes too.
    http(&w.db, w.ana, "set_task_visibility", json!({ "taskId": w.open, "visibility": "admins" })).await.unwrap();
    assert!(ganban_core::proposals::list_for_user(&w.db, MIA, false).await.unwrap().is_empty());

    for (task, ms) in [(w.offer, 60_000), (w.secret, 600_000)] {
        sqlx::query("INSERT INTO agent_actions (status, user_id, project_id, tool, summary, args_json, duration_ms) VALUES ('applied', 1, ?, 'update_task', 's', ?, ?)")
            .bind(w.project)
            .bind(json!({ "task_id": task }).to_string())
            .bind(ms)
            .execute(&w.db)
            .await
            .unwrap();
    }
    let bo = http(&w.db, w.bo, "get_time_correlation", json!({ "projectId": w.project })).await.unwrap();
    assert_eq!(bo["agent_seconds"], 60, "agent time on the reorg is hidden from Bo");
    let ana = http(&w.db, w.ana, "get_time_correlation", json!({ "projectId": w.project })).await.unwrap();
    assert_eq!(ana["agent_seconds"], 660);
}
