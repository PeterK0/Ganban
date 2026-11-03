//! Tasks, their time entries and their assignees.

use ganban_core::assignments;
use ganban_core::error::AppError;
use ganban_core::{auth, ops, visibility};
use serde_json::{json, Value};

use super::projects::SEES_AREA;
use super::{
    command, reply, require_role, viewer_of, Access, Args, Author, Command, Ctx, ResultFilter, Target, INPUT_PROJECT,
    PROJECT, TASK,
};
use crate::AuthUser;

/// The time entry named by `entryId`; seen with its task.
const TIME_ENTRY: Target = Target::arg("entryId", |db, id| {
    Box::pin(async move {
        Ok(Some(auth::time_entry_project_id(db, id).await?.ok_or_else(|| AppError::NotFound("time entry".into()))?))
    })
})
.seen_by(|db, v, id| Box::pin(visibility::can_see_time_entry(db, v, id)));

/// The area a task is being filed into, from `input.area_id`, if any.
fn input_area(a: &Args<'_>) -> Option<i64> {
    a.get("input").and_then(|i| i.get("area_id")).and_then(Value::as_i64)
}

/// Filing a task into an area needs sight of the area: a restricted one is its members'.
async fn require_area_seen(cx: &Ctx<'_>, user: &AuthUser, area: Option<i64>) -> Result<(), AppError> {
    match area {
        Some(id) if !SEES_AREA(cx.db, viewer_of(user), id).await? => Err(AppError::NotFound("area".into())),
        _ => Ok(()),
    }
}

pub(super) const COMMANDS: &[Command] = &[
    // ----- Tasks -----
    command("get_tasks").access(Access::Member(PROJECT)).filter(ResultFilter::Tasks).run(|cx, a| {
        Box::pin(async move { reply(ops::get_tasks(cx.db, a.id(PROJECT)?, a.opt_bool("archived")).await?) })
    }),
    // A member files a task into the project, and into an area they can see.
    command("create_task")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                Access::Member(INPUT_PROJECT).check(cx, user, a).await?;
                require_area_seen(cx, user, input_area(a)).await
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(ops::create_task(cx.db, a.input()?).await?) })),
    // Moving a task into an area you can see is a member's call; taking it out of a
    // restricted area widens who sees it, which is an admin's (ADR 0002).
    command("update_task")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                Access::Member(TASK).check(cx, user, a).await?;
                let Some(area) = input_area(a) else { return Ok(()) };
                require_area_seen(cx, user, Some(area)).await?;
                let task = a.id(TASK)?;
                if visibility::move_widens(cx.db, task, Some(area)).await? {
                    let project = auth::task_project_id(cx.db, task).await?.unwrap_or_default();
                    require_role(cx.db, user, project, auth::ROLE_ADMIN)
                        .await
                        .map_err(|_| AppError::Forbidden("only an admin can move a task out of a restricted area".into()))?;
                }
                Ok(())
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(ops::update_task(cx.db, a.id(TASK)?, a.input()?).await?) })),
    // ----- Visibility (ADR 0002) -----
    // Who may see a task: its area's say (the default), selected members, or admins only.
    command("set_task_visibility").access(Access::Admin(TASK)).run(|cx, a| {
        Box::pin(async move {
            let task = a.id(TASK)?;
            visibility::set_task_visibility(cx.db, task, &a.req_str("visibility")?, &a.i64_list("memberIds")).await?;
            task_audience(cx, task).await
        })
    }),
    // Who can see a task, for its 🔒 badge and the @mention warning.
    command("get_task_audience")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { task_audience(cx, a.id(TASK)?).await })),
    command("update_task_status").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::update_task_status(cx.db, a.id(TASK)?, a.req_str("status")?).await?) })
    }),
    command("delete_task")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_task(cx.db, a.id(TASK)?).await?) })),
    command("restore_task")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::restore_task(cx.db, a.id(TASK)?).await?) })),
    command("permanently_delete_task")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::permanently_delete_task(cx.db, a.id(TASK)?).await?) })),
    command("archive_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::archive_task(cx.db, a.id(TASK)?, a.opt_bool("archived").unwrap_or(false)).await?) })
    }),
    // Human focus vs agent runtime for one project: totals and a 14-day series. Human =
    // time_entries (the task timer); agent = the ledger's duration_ms (every model run is
    // ledgered, so this is complete).
    command("get_time_correlation").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let pid = a.id(PROJECT)?;
            // Human time over the tasks the caller can see (NULL = all).
            let seen = visibility::json_ids(cx.visible_tasks(Some(pid)).await?.as_ref());
            let human: Option<i64> = sqlx::query_scalar(
                "SELECT SUM(te.duration) FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE t.project_id = ? \
                 AND (?2 IS NULL OR t.id IN (SELECT value FROM json_each(?2)))",
            )
            .bind(pid)
            .bind(&seen)
            .fetch_one(cx.db)
            .await?;
            // Agent runs, without those about a task the caller can't see (task visibility):
            // (day, recent, duration, args).
            let runs: Vec<(String, bool, i64, String)> = sqlx::query_as(
                "SELECT date(created_at), created_at >= date('now', '-13 days'), duration_ms, args_json FROM agent_actions \
                 WHERE project_id = ? AND duration_ms IS NOT NULL",
            )
            .bind(pid)
            .fetch_all(cx.db)
            .await?;
            let seen_tasks = cx.visible_tasks(Some(pid)).await?;
            let runs: Vec<(String, bool, i64)> = runs
                .into_iter()
                .filter(|(_, _, _, args)| {
                    let Some(seen) = &seen_tasks else { return true };
                    let args: Value = serde_json::from_str(args).unwrap_or(Value::Null);
                    visibility::task_of_args(&args).is_none_or(|t| seen.contains(&t))
                })
                .map(|(day, recent, ms, _)| (day, recent, ms))
                .collect();
            let agent_ms: Option<i64> = Some(runs.iter().map(|(_, _, ms)| ms).sum());
            let human_days: Vec<(String, i64)> = sqlx::query_as(
                "SELECT date(te.start_time), SUM(te.duration) FROM time_entries te \
                 JOIN tasks t ON t.id = te.task_id \
                 WHERE t.project_id = ? AND te.start_time >= date('now', '-13 days') AND te.duration IS NOT NULL \
                   AND (?2 IS NULL OR t.id IN (SELECT value FROM json_each(?2))) \
                 GROUP BY 1",
            )
            .bind(pid)
            .bind(&seen)
            .fetch_all(cx.db)
            .await?;
            let mut agent_days: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
            for (day, _, ms) in runs.iter().filter(|(_, recent, _)| *recent) {
                *agent_days.entry(day.clone()).or_default() += ms;
            }
            let mut days: std::collections::BTreeMap<String, (i64, i64)> = std::collections::BTreeMap::new();
            for (d, s) in human_days {
                days.entry(d).or_default().0 = s;
            }
            for (d, ms) in agent_days {
                days.entry(d).or_default().1 = ms / 1000;
            }
            Ok(json!({
                "human_seconds": human.unwrap_or(0),
                "agent_seconds": agent_ms.unwrap_or(0) / 1000,
                "days": days.into_iter().map(|(date, (h, ag))| json!({ "date": date, "human_seconds": h, "agent_seconds": ag })).collect::<Vec<_>>(),
            }))
        })
    }),
    // ----- Assignees -----
    // The assigner is the authorship field: stamped from the signed-in caller over HTTP,
    // baked from the proposer by the agent tools' prepare_write, sent by the desktop app.
    command("assign_task").access(Access::Member(TASK)).author(Author::Arg("assignedBy")).run(|cx, a| {
        Box::pin(async move {
            reply(assignments::assign(cx.db, a.id(TASK)?, a.req_i64("userId")?, a.author()?, a.get("brief")).await?)
        })
    }),
    command("unassign_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(assignments::unassign(cx.db, a.id(TASK)?, a.req_i64("userId")?).await?) })
    }),
    command("assign_contact").access(Access::Member(TASK)).author(Author::Arg("assignedBy")).run(|cx, a| {
        Box::pin(async move {
            reply(assignments::assign_contact(cx.db, a.id(TASK)?, a.req_i64("contactId")?, a.author()?).await?)
        })
    }),
    command("unassign_contact").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(assignments::unassign_contact(cx.db, a.id(TASK)?, a.req_i64("contactId")?).await?) })
    }),
    command("get_assignees")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(assignments::assignees_for_task(cx.db, a.id(TASK)?).await?) })),
    command("get_project_assignees")
        .access(Access::Member(PROJECT))
        .filter(ResultFilter::OfTasks("task_id"))
        .run(|cx, a| Box::pin(async move { reply(assignments::assignees_for_project(cx.db, a.id(PROJECT)?).await?) })),
    // "Assigned to me" is exactly that: the user is the authorship field.
    command("get_my_assignments")
        .access(Access::AnyMember)
        .author(Author::Arg("userId"))
        .filter(ResultFilter::OfTasks("task_id"))
        .run(|cx, a| Box::pin(async move { reply(assignments::assignments_for_user(cx.db, a.author()?).await?) })),
    // ----- Time entries -----
    // Tracked time belongs to whoever ran the timer: the authorship field.
    command("start_time_entry").access(Access::Member(TASK)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move { reply(ops::start_time_entry(cx.db, a.id(TASK)?, a.opt_str("notes"), a.opt_author()).await?) })
    }),
    command("stop_time_entry").access(Access::Member(TIME_ENTRY)).run(|cx, a| {
        Box::pin(async move { reply(ops::stop_time_entry(cx.db, a.id(TIME_ENTRY)?, a.opt_str("notes")).await?) })
    }),
    command("delete_time_entry")
        .access(Access::Member(TIME_ENTRY))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_time_entry(cx.db, a.id(TIME_ENTRY)?).await?) })),
    command("get_time_entries")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_time_entries(cx.db, a.id(TASK)?).await?) })),
    command("get_active_time_entry")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_active_time_entry(cx.db, a.id(TASK)?).await?) })),
    command("get_task_total_time")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_task_total_time(cx.db, a.id(TASK)?).await?) })),
    // "My running timer": the authorship field picks whose (stamped over HTTP).
    command("get_global_active_time_entry")
        .access(Access::AnyMember)
        .author(Author::Arg("userId"))
        .filter(ResultFilter::ActiveTimer)
        .run(|cx, a| Box::pin(async move { reply(ops::get_global_active_time_entry(cx.db, a.opt_author()).await?) })),
    // The timer's "Recent": the tasks I tracked time on lately, newest first.
    command("get_recent_time_tasks")
        .access(Access::AnyMember)
        .author(Author::Arg("userId"))
        .filter(ResultFilter::OfTasks("task_id"))
        .run(|cx, a| {
            Box::pin(async move {
                reply(ops::get_recent_time_tasks(cx.db, a.opt_author(), a.opt_i64("limit").unwrap_or(8)).await?)
            })
        }),
];

async fn area_seen(cx: &Ctx<'_>, area: i64) -> Result<bool, AppError> {
    match cx.viewer() {
        Some(v) => SEES_AREA(cx.db, v, area).await,
        None => Ok(true),
    }
}

/// Who can see a task: its setting, its area (if any), the selected members, and the
/// whole audience by user id.
async fn task_audience(cx: &Ctx<'_>, task: i64) -> Result<Value, AppError> {
    let (setting, area): (String, Option<i64>) = sqlx::query_as("SELECT visibility, area_id FROM tasks WHERE id = ?")
        .bind(task)
        .fetch_optional(cx.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("task {task}")))?;
    // A restricted area's name is only for those who can see the area (an assignee may
    // see the task without it).
    let area = match area {
        Some(id) if !area_seen(cx, id).await? => None,
        Some(id) => sqlx::query_as::<_, (String, bool)>("SELECT name, restricted FROM areas WHERE id = ?")
            .bind(id)
            .fetch_optional(cx.db)
            .await?
            .map(|(name, restricted)| json!({ "id": id, "name": name, "restricted": restricted })),
        None => None,
    };
    Ok(json!({
        "visibility": setting,
        "area": area,
        "selected": visibility::selected_member_ids(cx.db, task).await?,
        "audience": visibility::audience(cx.db, task).await?,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::testkit::*;

    /// Projects A and B with one task each; returns (a, b, task in a, task in b).
    async fn world(db: &ganban_core::Db) -> (i64, i64, i64, i64) {
        owner(db).await;
        let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let task = |pid: i64| json!({ "input": { "project_id": pid, "title": "T", "status": "To Do", "priority": "Low" } });
        let ta = seed(db, "create_task", task(a)).await["id"].as_i64().unwrap();
        let tb = seed(db, "create_task", task(b)).await["id"].as_i64().unwrap();
        (a, b, ta, tb)
    }

    #[tokio::test]
    async fn a_removed_member_keeps_no_view_of_the_project() {
        let db = test_db("tasks_removed").await;
        let (a, _, ta, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        seed(&db, "assign_task", json!({ "taskId": ta, "userId": 7, "assignedBy": 1 })).await;
        seed(&db, "create_comment", json!({ "input": { "task_id": ta, "user_id": 1, "content": "@user7 the budget is in" } })).await;
        let draft = json!({ "projectId": a, "tool": "create_task", "args": { "title": "Draft" }, "userId": 7 });
        http(&db, mia, "submit_proposal", draft).await.unwrap();
        let mine = |db: &ganban_core::Db| {
            let db = db.clone();
            async move {
                (
                    http(&db, mia, "get_my_assignments", json!({})).await.unwrap().as_array().unwrap().len(),
                    http(&db, mia, "get_notifications", json!({})).await.unwrap().as_array().unwrap().len(),
                    ganban_core::proposals::list_for_user(&db, 7, false).await.unwrap().len(),
                )
            }
        };
        assert_eq!(mine(&db).await, (1, 1, 1), "while she's a member");

        seed(&db, "remove_member", json!({ "projectId": a, "userId": 7 })).await;
        assert_eq!(mine(&db).await, (0, 0, 0), "her assignment, the mention and her proposal went with the project");
    }

    #[tokio::test]
    async fn task_commands_need_membership_of_the_tasks_project() {
        let db = test_db("tasks_rules").await;
        let (a, b, ta, tb) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;

        assert_eq!(ids(&http(&db, mia, "get_tasks", json!({ "projectId": a })).await.unwrap()), vec![ta]);
        assert!(http(&db, mia, "get_tasks", json!({ "projectId": b })).await.unwrap_err().is_not_found());
        let new = |pid: i64| json!({ "input": { "project_id": pid, "title": "N", "status": "To Do", "priority": "Low" } });
        assert!(http(&db, mia, "create_task", new(a)).await.is_ok());
        assert!(http(&db, mia, "create_task", new(b)).await.unwrap_err().is_not_found());

        let status = |t: i64| json!({ "taskId": t, "status": "Done" });
        assert_eq!(http(&db, mia, "update_task_status", status(ta)).await.unwrap()["status"], "Done");
        assert!(http(&db, mia, "update_task_status", status(tb)).await.unwrap_err().is_not_found());
        assert!(http(&db, mia, "get_time_entries", json!({ "taskId": tb })).await.unwrap_err().is_not_found());
        assert!(http(&db, mia, "update_task_status", status(999)).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn timers_are_attributed_to_the_signed_in_member() {
        let db = test_db("tasks_timer").await;
        let (a, b, ta, tb) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let bo = member(&db, 8, &[(b, "member")]).await;

        // A spoofed userId is overwritten with the caller.
        let entry = http(&db, mia, "start_time_entry", json!({ "taskId": ta, "userId": 8 })).await.unwrap();
        assert_eq!(entry["user_id"], 7);
        let eid = entry["id"].as_i64().unwrap();
        assert!(http(&db, bo, "stop_time_entry", json!({ "entryId": eid })).await.unwrap_err().is_not_found());
        assert!(http(&db, bo, "delete_time_entry", json!({ "entryId": eid })).await.unwrap_err().is_not_found());

        // The running timer is visible only to members of its task's project.
        assert_eq!(http(&db, mia, "get_global_active_time_entry", json!({})).await.unwrap()[1]["id"], ta);
        assert_eq!(http(&db, bo, "get_global_active_time_entry", json!({})).await.unwrap(), Value::Null);
        http(&db, mia, "stop_time_entry", json!({ "entryId": eid })).await.unwrap();
        assert!(http(&db, bo, "start_time_entry", json!({ "taskId": tb })).await.is_ok());
    }

    #[tokio::test]
    async fn my_running_timer_and_recent_tasks_are_mine() {
        let db = test_db("tasks_timer_mine").await;
        let (a, _, ta, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let bo = member(&db, 8, &[(a, "member")]).await;
        let ta2 = seed(&db, "create_task", json!({ "input": { "project_id": a, "title": "T2", "status": "To Do", "priority": "Low" } }))
            .await["id"]
            .as_i64()
            .unwrap();

        // Mia tracks ta, then ta2; Bo's timer on ta runs later. Mia's timer is still hers.
        let e1 = http(&db, mia, "start_time_entry", json!({ "taskId": ta })).await.unwrap()["id"].as_i64().unwrap();
        http(&db, mia, "stop_time_entry", json!({ "entryId": e1 })).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        http(&db, mia, "start_time_entry", json!({ "taskId": ta2 })).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        http(&db, bo, "start_time_entry", json!({ "taskId": ta })).await.unwrap();

        assert_eq!(http(&db, mia, "get_global_active_time_entry", json!({})).await.unwrap()[1]["id"], ta2);
        assert_eq!(http(&db, bo, "get_global_active_time_entry", json!({})).await.unwrap()[1]["id"], ta);

        let recent = http(&db, mia, "get_recent_time_tasks", json!({})).await.unwrap();
        let ids: Vec<i64> = recent.as_array().unwrap().iter().map(|r| r["task_id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![ta2, ta], "distinct, newest first");
        assert_eq!(recent[0]["task"]["title"], "T2");
        let bos = http(&db, bo, "get_recent_time_tasks", json!({ "limit": 8 })).await.unwrap();
        assert_eq!(bos.as_array().unwrap().len(), 1, "only the tasks Bo tracked");

        // Bo's timer on ta doesn't stop Mia timing it too; hers is the newest she runs.
        http(&db, mia, "start_time_entry", json!({ "taskId": ta })).await.unwrap();
        assert_eq!(http(&db, mia, "get_global_active_time_entry", json!({})).await.unwrap()[1]["id"], ta);

        // A task in the trash leaves Recent.
        seed(&db, "archive_task", json!({ "taskId": ta2, "archived": true })).await;
        let recent = http(&db, mia, "get_recent_time_tasks", json!({})).await.unwrap();
        assert_eq!(recent.as_array().unwrap().len(), 1);
        assert_eq!(recent[0]["task_id"], ta);
    }

    #[tokio::test]
    async fn assignments_stamp_the_assigner_and_my_assignments_are_mine() {
        let db = test_db("tasks_assign").await;
        let (a, _, ta, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;

        // Over HTTP the assigner is the caller, whatever the client claims.
        http(&db, ana, "assign_task", json!({ "taskId": ta, "userId": 7, "assignedBy": 7 })).await.unwrap();
        let assignees = http(&db, mia, "get_assignees", json!({ "taskId": ta })).await.unwrap();
        assert_eq!(assignees[0]["assigned_by"], 8);

        // "Assigned to me" is the caller's, even when asking for someone else's.
        let mine = http(&db, ana, "get_my_assignments", json!({ "userId": 7 })).await.unwrap();
        assert_eq!(mine, json!([]), "Ana has no assignments, and can't read Mia's");
        assert_eq!(http(&db, mia, "get_my_assignments", json!({})).await.unwrap()[0]["task_id"], ta);

        // In-process (desktop) the app's acting profile is the assigner.
        seed(&db, "unassign_task", json!({ "taskId": ta, "userId": 7 })).await;
        seed(&db, "assign_task", json!({ "taskId": ta, "userId": 7, "assignedBy": 7 })).await;
        assert_eq!(seed(&db, "get_assignees", json!({ "taskId": ta })).await[0]["assigned_by"], 7);
    }
}
