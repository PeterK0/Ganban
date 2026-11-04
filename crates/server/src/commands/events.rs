//! Calendar events: workspace-wide rows that projects and tasks link to. The owner and the
//! workspace admins manage them; members see the events linked to their projects.

use ganban_core::error::AppError;
use ganban_core::{auth, ops, storage, Db};
use serde_json::json;

use super::{command, reply, Access, Args, Command, Ctx, Fut, ResultFilter, PROJECT, TASK};
use crate::AuthUser;

/// Whether a signed-in caller sees an event: the owner sees every one; a member, the
/// events linked to their projects (as `get_events` filters them).
pub(crate) async fn sees_event(db: &Db, user: &AuthUser, event_id: i64) -> Result<bool, AppError> {
    Ok(user.is_owner || auth::accessible_event_ids(db, user.id).await?.contains(&event_id))
}

/// Who manages an event's files: the owner and the workspace admins (they manage events),
/// on an event they see. Outside it, the event is "not found".
pub(crate) async fn manages_event(db: &Db, user: &AuthUser, event_id: i64) -> Result<(), AppError> {
    if !sees_event(db, user, event_id).await? {
        return Err(AppError::NotFound("event".into()));
    }
    if user.is_owner || auth::is_admin_anywhere(db, user.id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden("only the owner or a project admin can change an event's files".into()))
    }
}

/// The event the file named by `fileId` belongs to.
async fn file_event(db: &Db, a: &Args<'_>) -> Result<i64, AppError> {
    Ok(storage::get_event_file(db, a.req_i64("fileId")?).await?.event_id)
}

fn sees_event_arg<'a>(cx: &'a Ctx<'a>, a: &'a Args<'a>, user: &'a AuthUser) -> Fut<'a, ()> {
    Box::pin(async move {
        if sees_event(cx.db, user, a.req_i64("eventId")?).await? {
            Ok(())
        } else {
            Err(AppError::NotFound("event".into()))
        }
    })
}

fn manages_file_event<'a>(cx: &'a Ctx<'a>, a: &'a Args<'a>, user: &'a AuthUser) -> Fut<'a, ()> {
    Box::pin(async move { manages_event(cx.db, user, file_event(cx.db, a).await?).await })
}

pub(super) const COMMANDS: &[Command] = &[
    command("get_events").access(Access::AnyMember).filter(ResultFilter::Events).run(|cx, a| {
        Box::pin(async move {
            reply(ops::get_events(cx.db, a.opt_str("startDate"), a.opt_str("endDate"), a.opt_bool("archived")).await?)
        })
    }),
    command("get_event")
        .access(Access::AnyMember)
        .filter(ResultFilter::Event)
        .run(|cx, a| Box::pin(async move { reply(ops::get_event(cx.db, a.req_i64("eventId")?).await?) })),
    // A proposal-born event may carry its task and project links: they're made in the
    // same apply, so approving lands the whole promise. Each link follows its link
    // command's rule (`link_event_to_task`, `link_event_to_project`).
    command("create_event")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                Access::AdminAnywhere.check(cx, user, a).await?;
                if a.opt_id(TASK).is_some() {
                    Access::Member(TASK).check(cx, user, a).await?;
                }
                if a.opt_id(PROJECT).is_some() {
                    Access::Admin(PROJECT).check(cx, user, a).await?;
                }
                Ok(())
            })
        }))
        .run(|cx, a| {
            Box::pin(async move {
                let event = ops::create_event(cx.db, a.input()?).await?;
                if let Some(task) = a.opt_id(TASK) {
                    ops::link_event_to_task(cx.db, event.id, task).await?;
                }
                if let Some(project) = a.opt_id(PROJECT) {
                    ops::link_event_to_project(cx.db, event.id, project).await?;
                }
                reply(event)
            })
        }),
    command("update_event").access(Access::AdminAnywhere).run(|cx, a| {
        Box::pin(async move { reply(ops::update_event(cx.db, a.req_i64("eventId")?, a.input()?).await?) })
    }),
    // Mark an event past by hand, or upcoming again (`done`); a series as a whole.
    command("set_event_done").access(Access::AdminAnywhere).run(|cx, a| {
        Box::pin(async move {
            reply(ops::set_event_done(cx.db, a.req_i64("eventId")?, a.opt_bool("done").unwrap_or(true)).await?)
        })
    }),
    command("delete_event")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::delete_event(cx.db, a.req_i64("eventId")?).await?) })),
    command("archive_event").access(Access::AdminAnywhere).run(|cx, a| {
        Box::pin(async move {
            reply(ops::archive_event(cx.db, a.req_i64("eventId")?, a.opt_bool("archived").unwrap_or(false)).await?)
        })
    }),
    command("restore_event")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::restore_event(cx.db, a.req_i64("eventId")?).await?) })),
    // Its files go with it (rows and bytes). Moving it to the Bin keeps them.
    command("permanently_delete_event").access(Access::AdminAnywhere).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("eventId")?;
            let root = cx.storage_root()?;
            storage::delete_event_files(cx.db, root, id).await?;
            reply(ops::permanently_delete_event(cx.db, id).await?)
        })
    }),
    // ----- Files -----
    // Uploads and downloads have their own streaming routes (`/event-files/…`).
    // `canManage`: whether the caller may upload and delete them.
    command("get_event_files").access(Access::Custom(sees_event_arg)).run(|cx, a| {
        Box::pin(async move {
            let files = storage::list_event_files(cx.db, a.req_i64("eventId")?).await?;
            let can_manage = match cx.caller {
                super::Caller::InProcess => true,
                super::Caller::Http(user) => user.is_owner || auth::is_admin_anywhere(cx.db, user.id).await?,
            };
            Ok(json!({ "files": files, "canManage": can_manage }))
        })
    }),
    command("delete_event_file").access(Access::Custom(manages_file_event)).run(|cx, a| {
        Box::pin(async move { reply(storage::delete_event_file(cx.db, cx.storage_root()?, a.req_i64("fileId")?).await?) })
    }),
    // ----- Links to tasks -----
    command("link_event_to_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::link_event_to_task(cx.db, a.req_i64("eventId")?, a.id(TASK)?).await?) })
    }),
    command("unlink_event_from_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::unlink_event_from_task(cx.db, a.req_i64("eventId")?, a.id(TASK)?).await?) })
    }),
    command("get_task_events")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_task_events(cx.db, a.id(TASK)?).await?) })),
    command("get_event_tasks")
        .access(Access::AnyMember)
        .filter(ResultFilter::Tasks)
        .run(|cx, a| Box::pin(async move { reply(ops::get_event_tasks(cx.db, a.req_i64("eventId")?).await?) })),
    // A filter mask (which events have a task); trimmed so it never reveals other projects'.
    command("get_task_linked_event_ids")
        .access(Access::AnyMember)
        .filter(ResultFilter::EventIds)
        .run(|cx, _| {
            Box::pin(async move {
                // "Has a task" means a task the caller can see.
                let Some(seen) = cx.visible_tasks(None).await? else {
                    return reply(ops::get_task_linked_event_ids(cx.db).await?);
                };
                let links: Vec<(i64, i64)> = sqlx::query_as("SELECT event_id, task_id FROM event_tasks").fetch_all(cx.db).await?;
                let mut ids: Vec<i64> = links.into_iter().filter(|(_, t)| seen.contains(t)).map(|(e, _)| e).collect();
                ids.sort_unstable();
                ids.dedup();
                reply(ids)
            })
        }),
    // ----- Links to projects -----
    command("link_event_to_project").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move { reply(ops::link_event_to_project(cx.db, a.req_i64("eventId")?, a.id(PROJECT)?).await?) })
    }),
    command("unlink_event_from_project").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move { reply(ops::unlink_event_from_project(cx.db, a.req_i64("eventId")?, a.id(PROJECT)?).await?) })
    }),
    command("get_event_projects")
        .access(Access::AnyMember)
        .filter(ResultFilter::Projects)
        .run(|cx, a| Box::pin(async move { reply(ops::get_event_projects(cx.db, a.req_i64("eventId")?).await?) })),
    command("get_project_events").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move { reply(ops::get_project_events(cx.db, a.id(PROJECT)?, a.opt_bool("archived")).await?) })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::testkit::*;
    use super::super::{run, Ctx};

    fn event(title: &str) -> Value {
        json!({ "input": { "title": title, "event_date": "2026-10-13T09:00:00Z", "all_day": false, "notification_enabled": false } })
    }

    /// Projects A and B, a task in each, and three events: one linked to A (and A's task),
    /// one to B (and B's task), one to no project. Returns (a, task a, event a, event b, loose).
    async fn world(db: &ganban_core::Db) -> (i64, i64, i64, i64, i64) {
        owner(db).await;
        let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let task = |pid: i64| json!({ "input": { "project_id": pid, "title": "t", "status": "To Do", "priority": "Low" } });
        let ta = seed(db, "create_task", task(a)).await["id"].as_i64().unwrap();
        let tb = seed(db, "create_task", task(b)).await["id"].as_i64().unwrap();
        let linked = |pid: i64, tid: i64, title: &'static str| {
            let mut args = event(title);
            args["projectId"] = json!(pid);
            args["taskId"] = json!(tid);
            args
        };
        let ea = seed(db, "create_event", linked(a, ta, "A's")).await["id"].as_i64().unwrap();
        let eb = seed(db, "create_event", linked(b, tb, "B's")).await["id"].as_i64().unwrap();
        let loose = seed(db, "create_event", event("Imported")).await["id"].as_i64().unwrap();
        (a, ta, ea, eb, loose)
    }

    #[tokio::test]
    async fn members_see_only_the_events_of_their_projects() {
        let db = test_db("events_filter").await;
        let (a, ta, ea, eb, loose) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;

        assert_eq!(ids(&http(&db, mia, "get_events", json!({})).await.unwrap()), vec![ea]);
        assert_eq!(http(&db, mia, "get_event", json!({ "eventId": ea })).await.unwrap()["id"], ea);
        assert_eq!(http(&db, mia, "get_event", json!({ "eventId": eb })).await.unwrap(), Value::Null);
        assert_eq!(http(&db, mia, "get_event", json!({ "eventId": loose })).await.unwrap(), Value::Null);
        assert_eq!(http(&db, mia, "get_task_linked_event_ids", json!({})).await.unwrap(), json!([ea]));
        assert_eq!(ids(&http(&db, mia, "get_event_projects", json!({ "eventId": eb })).await.unwrap()), Vec::<i64>::new());
        assert_eq!(ids(&http(&db, mia, "get_event_tasks", json!({ "eventId": ea })).await.unwrap()), vec![ta]);
        assert_eq!(ids(&http(&db, mia, "get_event_tasks", json!({ "eventId": eb })).await.unwrap()), Vec::<i64>::new());

        let owner = owner(&db).await;
        assert_eq!(ids(&http(&db, owner, "get_events", json!({})).await.unwrap()).len(), 3);
    }

    #[tokio::test]
    async fn the_owner_and_workspace_admins_manage_events() {
        let db = test_db("events_manage").await;
        let (a, ta, ea, _, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;

        assert!(http(&db, mia, "create_event", event("Mine")).await.unwrap_err().is_forbidden());
        assert!(http(&db, mia, "delete_event", json!({ "eventId": ea })).await.unwrap_err().is_forbidden());
        let e = http(&db, ana, "create_event", event("Ana's")).await.unwrap()["id"].as_i64().unwrap();
        assert!(http(&db, ana, "update_event", json!({ "eventId": e, "input": { "title": "Moved" } })).await.is_ok());

        // Linking to a task is a member's job on that task's project; to the project, an admin's.
        assert!(http(&db, mia, "link_event_to_task", json!({ "eventId": e, "taskId": ta })).await.is_ok());
        let to_project = json!({ "eventId": e, "projectId": a });
        assert!(http(&db, mia, "link_event_to_project", to_project.clone()).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "link_event_to_project", to_project).await.is_ok());
        assert!(http(&db, mia, "get_project_events", json!({ "projectId": a })).await.is_ok());
    }

    #[tokio::test]
    async fn a_new_events_links_follow_the_link_commands_rules() {
        let db = test_db("events_create_links").await;
        let (a, ta, _, _, _) = world(&db).await;
        let b = seed(&db, "get_projects", json!({})).await.as_array().unwrap().iter().find(|p| p["name"] == "B").unwrap()["id"].as_i64().unwrap();
        let tb = seed(&db, "get_tasks", json!({ "projectId": b })).await[0]["id"].as_i64().unwrap();
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let linked = |key: &str, id: i64| {
            let mut args = event("Linked");
            args[key] = json!(id);
            args
        };
        assert!(http(&db, ana, "create_event", linked("taskId", ta)).await.is_ok());
        assert!(http(&db, ana, "create_event", linked("projectId", a)).await.is_ok());
        assert!(http(&db, ana, "create_event", linked("taskId", tb)).await.unwrap_err().is_not_found());
        assert!(http(&db, ana, "create_event", linked("projectId", b)).await.unwrap_err().is_not_found());
        let events = seed(&db, "get_events", json!({})).await;
        assert_eq!(events.as_array().unwrap().len(), 5, "the refused events were never created");
    }
    #[tokio::test]
    async fn marking_an_event_past_is_for_those_who_edit_events() {
        let db = test_db("events_done").await;
        let (a, _, ea, _, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;

        let done = json!({ "eventId": ea, "done": true });
        assert!(http(&db, mia, "set_event_done", done.clone()).await.unwrap_err().is_forbidden());
        let marked = http(&db, ana, "set_event_done", done.clone()).await.unwrap();
        assert!(marked["done_at"].is_string(), "{marked}");
        let again = http(&db, ana, "set_event_done", done).await.unwrap();
        assert_eq!(again["done_at"], marked["done_at"], "marking twice keeps the first time");
        assert!(http(&db, mia, "get_event", json!({ "eventId": ea })).await.unwrap()["done_at"].is_string());

        let undone = http(&db, ana, "set_event_done", json!({ "eventId": ea, "done": false })).await.unwrap();
        assert!(undone["done_at"].is_null());
        assert!(http(&db, ana, "set_event_done", json!({ "eventId": 9999, "done": true })).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn a_series_keeps_its_skipped_days_and_its_one_off_copies() {
        let db = test_db("events_exdates").await;
        let (_, _, ea, _, _) = world(&db).await;
        let cx = Ctx::in_process(&db);
        let update = |input: Value| json!({ "eventId": ea, "input": input });

        let e = run(&cx, "update_event", update(json!({ "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "exdates": "2026-10-20,bad,2026-10-14,2026-10-20" }))).await.unwrap();
        assert_eq!(e["exdates"], "2026-10-14,2026-10-20", "stored sorted, valid and once each");
        // A field left out keeps them; a title change doesn't touch the rule.
        let e = run(&cx, "update_event", update(json!({ "title": "Work" }))).await.unwrap();
        assert_eq!(e["exdates"], "2026-10-14,2026-10-20");
        assert_eq!(e["rrule"], "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
        // `null` clears: the rule ("Remove repeat") and the skipped days.
        let e = run(&cx, "update_event", update(json!({ "rrule": null, "exdates": null }))).await.unwrap();
        assert!(e["rrule"].is_null() && e["exdates"].is_null(), "{e}");
        let e = run(&cx, "update_event", update(json!({ "exdates": "" }))).await.unwrap();
        assert!(e["exdates"].is_null());

        // A one-off copy of one day points at its series.
        let mut copy = event("Work (moved)");
        copy["input"]["series_id"] = json!(ea);
        let c = run(&cx, "create_event", copy).await.unwrap();
        assert_eq!(c["series_id"], ea);
        assert!(run(&cx, "get_event", json!({ "eventId": ea })).await.unwrap()["series_id"].is_null());
    }

    #[tokio::test]
    async fn deleting_a_series_bins_its_one_off_copies_and_restoring_brings_them_back() {
        let db = test_db("events_series_bin").await;
        let (_, _, ea, _, _) = world(&db).await;
        let cx = Ctx::in_process(&db);
        run(&cx, "update_event", json!({ "eventId": ea, "input": { "rrule": "FREQ=DAILY", "exdates": "2026-10-14,2026-10-15" } })).await.unwrap();
        let copy = |title: &str| {
            let mut c = event(title);
            c["input"]["series_id"] = json!(ea);
            c
        };
        let kept = run(&cx, "create_event", copy("Moved day")).await.unwrap()["id"].as_i64().unwrap();
        let alone = run(&cx, "create_event", copy("Binned on its own")).await.unwrap()["id"].as_i64().unwrap();
        let other = run(&cx, "create_event", event("Unrelated")).await.unwrap()["id"].as_i64().unwrap();
        let archived = |id: i64| {
            let db = db.clone();
            async move { sqlx::query_scalar::<_, bool>("SELECT archived FROM events WHERE id = ?").bind(id).fetch_one(&db).await.unwrap() }
        };

        run(&cx, "delete_event", json!({ "eventId": alone })).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        run(&cx, "delete_event", json!({ "eventId": ea })).await.unwrap();
        assert!(archived(ea).await && archived(kept).await, "the copy goes to the Bin with its series");
        assert!(!archived(other).await, "an unrelated event stays");

        run(&cx, "restore_event", json!({ "eventId": ea })).await.unwrap();
        assert!(!archived(ea).await && !archived(kept).await, "restoring the series brings its copy back");
        assert!(archived(alone).await, "a copy binned on its own stays in the Bin");
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ganban_event_files_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Put a file on an event as the upload route does; returns its id.
    async fn attach(db: &ganban_core::Db, root: &std::path::Path, event: i64, name: &str) -> i64 {
        let src = root.join(format!("spool-{name}"));
        std::fs::write(&src, b"hello").unwrap();
        ganban_core::storage::store_event_file_from_path(db, root, event, name, Some("text/plain"), None, None, &src, 5)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn event_files_are_read_by_who_sees_the_event_and_changed_by_admins() {
        let db = test_db("events_files").await;
        let (a, _, ea, eb, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let root = temp_root("rules");
        let f = attach(&db, &root, ea, "agenda.txt").await;
        let fb = attach(&db, &root, eb, "other.txt").await;

        let listed = http(&db, mia, "get_event_files", json!({ "eventId": ea })).await.unwrap();
        assert_eq!(ids(&listed["files"]), vec![f]);
        assert_eq!(listed["canManage"], false);
        assert_eq!(http(&db, ana, "get_event_files", json!({ "eventId": ea })).await.unwrap()["canManage"], true);
        assert!(http(&db, mia, "get_event_files", json!({ "eventId": eb })).await.unwrap_err().is_not_found());
        assert_eq!(http(&db, mia, "get_event", json!({ "eventId": ea })).await.unwrap()["file_count"], 1);

        let as_ = |user| Ctx::http(&db, user).with_storage_root(&root);
        assert!(run(&as_(mia), "delete_event_file", json!({ "fileId": f })).await.unwrap_err().is_forbidden());
        assert!(run(&as_(ana), "delete_event_file", json!({ "fileId": fb })).await.unwrap_err().is_not_found(), "B's event is out of Ana's sight");
        run(&as_(ana), "delete_event_file", json!({ "fileId": f })).await.unwrap();
        assert!(!ganban_core::storage::event_blob_path(&root, f).exists());
        assert!(ganban_core::storage::event_blob_path(&root, fb).exists());
    }

    #[tokio::test]
    async fn deleting_an_event_for_good_deletes_its_files() {
        let db = test_db("events_files_gone").await;
        let (_, _, ea, _, _) = world(&db).await;
        let root = temp_root("gone");
        let f = attach(&db, &root, ea, "agenda.txt").await;
        let cx = Ctx::in_process(&db).with_storage_root(&root);

        run(&cx, "delete_event", json!({ "eventId": ea })).await.unwrap();
        assert!(ganban_core::storage::event_blob_path(&root, f).exists(), "the Bin keeps an event's files");
        run(&cx, "permanently_delete_event", json!({ "eventId": ea })).await.unwrap();
        assert!(!ganban_core::storage::event_blob_path(&root, f).exists());
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_attachments").fetch_one(&db).await.unwrap();
        assert_eq!(left, 0);
    }
}
