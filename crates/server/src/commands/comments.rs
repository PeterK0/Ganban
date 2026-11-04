//! Comments: a task's thread, and the project comment board where one comment is tagged on
//! several tasks.

use ganban_core::error::AppError;
use ganban_core::{auth, ops, visibility};

use super::{command, reply, Access, Author, Command, Target, INPUT_TASK, PROJECT, TASK};

/// The comment named by `commentId`, seen with any task it's tagged on. Retagging is scoped
/// by the comment's project; ops then refuses any task outside it.
const COMMENT: Target = Target::arg("commentId", |db, id| {
    Box::pin(async move { Ok(Some(auth::comment_project_id(db, id).await?.ok_or_else(|| AppError::NotFound("comment".into()))?)) })
})
.seen_by(|db, v, id| Box::pin(visibility::can_see_comment(db, v, id)));

pub(super) const COMMANDS: &[Command] = &[
    // A thread's comments may be tagged on tasks the caller can't see: those tags go.
    command("get_task_comments").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move {
            let task = a.id(TASK)?;
            let mut comments = ops::get_task_comments(cx.db, task).await?;
            if let Some(seen) = cx.visible_tasks(auth::task_project_id(cx.db, task).await?).await? {
                visibility::trim_comment_tags(&mut comments, &seen);
            }
            reply(comments)
        })
    }),
    // Its home task is the access rule's; its extra tags, and the comment it replies to,
    // must be visible too (a reply joins its parent's thread, whatever task it names).
    command("create_comment").access(Access::Member(INPUT_TASK)).author(Author::Input("user_id")).run(|cx, a| {
        Box::pin(async move {
            let input: ganban_core::models::CreateCommentInput = a.input()?;
            cx.require_visible(&input.task_ids).await?;
            if let (Some(v), Some(parent)) = (cx.viewer(), input.parent_id) {
                if !visibility::can_see_comment(cx.db, v, parent).await? {
                    return Err(AppError::NotFound("comment".into()));
                }
            }
            reply(ops::create_comment(cx.db, input).await?)
        })
    }),
    command("update_comment")
        .access(Access::Member(COMMENT))
        .run(|cx, a| Box::pin(async move { reply(ops::update_comment(cx.db, a.id(COMMENT)?, a.input()?).await?) })),
    command("delete_comment")
        .access(Access::Member(COMMENT))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_comment(cx.db, a.id(COMMENT)?).await?) })),
    command("set_comment_tags").access(Access::Member(COMMENT)).run(|cx, a| {
        Box::pin(async move {
            let tags = a.i64_list("taskIds");
            cx.require_visible(&tags).await?;
            reply(ops::set_comment_tags(cx.db, a.id(COMMENT)?, tags).await?)
        })
    }),
    // Only updates tagged on a task the caller can see, with the other tags trimmed.
    command("get_project_comment_board").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let pid = a.id(PROJECT)?;
            let task_ids = a.get("taskIds").and_then(|v| v.as_array()).map(|_| a.i64_list("taskIds"));
            let seen = cx.visible_tasks(Some(pid)).await?;
            reply(
                ops::get_project_comment_board_among(cx.db, pid, task_ids, a.opt_i64("limit"), a.opt_str("since"), seen.as_ref())
                    .await?,
            )
        })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    /// The board and retagging are member-scoped like every comment command, and a member
    /// of project A can't tag a comment onto project B's task.
    #[tokio::test]
    async fn board_and_retag_are_project_scoped() {
        let db = test_db("comments_board").await;
        owner(&db).await;
        let pa = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let pb = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let task = |pid: i64, t: &str| json!({ "input": { "project_id": pid, "title": t, "status": "To Do", "priority": "Medium" } });
        let ta = seed(&db, "create_task", task(pa, "a")).await["id"].as_i64().unwrap();
        let ta2 = seed(&db, "create_task", task(pa, "a2")).await["id"].as_i64().unwrap();
        let tb = seed(&db, "create_task", task(pb, "b")).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(pa, "member")]).await;

        // Member of A: posts a two-task update there and reads it on A's board.
        let c = http(&db, mia, "create_comment", json!({ "input": { "task_id": ta, "content": "eod", "task_ids": [ta2] } }))
            .await
            .unwrap();
        assert_eq!(c["task_ids"], json!([ta, ta2]));
        let board = http(&db, mia, "get_project_comment_board", json!({ "projectId": pa, "taskIds": [ta2] })).await.unwrap();
        assert_eq!(board["comments"].as_array().unwrap().len(), 1);

        // Not a member of B: its board is invisible, and her own comment can't reach B's task.
        assert!(http(&db, mia, "get_project_comment_board", json!({ "projectId": pb })).await.unwrap_err().is_not_found());
        let cid = c["id"].as_i64().unwrap();
        assert!(http(&db, mia, "set_comment_tags", json!({ "commentId": cid, "taskIds": [tb] })).await.is_err(), "cross-project tag refused");
        assert!(http(&db, mia, "create_comment", json!({ "input": { "task_id": ta, "content": "x", "task_ids": [tb] } })).await.is_err());
        let bc = seed(&db, "create_comment", json!({ "input": { "task_id": tb, "content": "b's" } })).await;
        let err = http(&db, mia, "set_comment_tags", json!({ "commentId": bc["id"], "taskIds": [tb] })).await.unwrap_err();
        assert!(err.is_not_found(), "{err}");
    }

    #[tokio::test]
    async fn comments_are_authored_by_the_signed_in_member() {
        let db = test_db("comments_author").await;
        owner(&db).await;
        let pa = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let ta = seed(&db, "create_task", json!({ "input": { "project_id": pa, "title": "t", "status": "To Do", "priority": "Low" } }))
            .await["id"]
            .as_i64()
            .unwrap();
        let mia = member(&db, 7, &[(pa, "member")]).await;
        let bo = member(&db, 8, &[]).await;

        let c = http(&db, mia, "create_comment", json!({ "input": { "task_id": ta, "content": "hi", "user_id": 8 } })).await.unwrap();
        assert_eq!(c["user_id"], 7, "a spoofed author is overwritten with the caller");
        // In-process the desktop's acting profile is the author.
        let d = seed(&db, "create_comment", json!({ "input": { "task_id": ta, "content": "yo", "user_id": 8 } })).await;
        assert_eq!(d["user_id"], 8);

        let cid = c["id"].as_i64().unwrap();
        assert!(http(&db, bo, "get_task_comments", json!({ "taskId": ta })).await.unwrap_err().is_not_found());
        assert!(http(&db, bo, "delete_comment", json!({ "commentId": cid })).await.unwrap_err().is_not_found());
        assert!(http(&db, mia, "update_comment", json!({ "commentId": cid, "input": { "content": "edited" } })).await.is_ok());
    }

    /// The tag picker's "Create task" sends create_task for the board's project. Someone who
    /// can read a board snapshot but may not file tasks there (here: removed from the project
    /// while the board was open) is refused, and no task is made; the picker shows the error.
    #[tokio::test]
    async fn the_tag_pickers_create_task_is_refused_without_membership() {
        let db = test_db("comments_create_task").await;
        owner(&db).await;
        let pa = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(pa, "member")]).await;
        // The picker's request: the board's project, the typed title, the app's defaults.
        let picked = |title: &str| json!({ "input": { "project_id": pa, "title": title, "status": "To Do", "priority": "Medium" } });
        assert!(http(&db, mia, "create_task", picked("allowed")).await.is_ok(), "a member may");

        seed(&db, "remove_member", json!({ "projectId": pa, "userId": 7 })).await;
        let err = http(&db, mia, "create_task", picked("refused")).await.unwrap_err();
        assert!(err.is_not_found() || err.is_forbidden(), "{err}");
        let titles: Vec<String> = sqlx::query_scalar("SELECT title FROM tasks WHERE project_id = ?").bind(pa).fetch_all(&db).await.unwrap();
        assert!(!titles.contains(&"refused".to_string()), "{titles:?}");
    }
}
