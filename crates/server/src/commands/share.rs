//! Share links (ADR 0006): make, list and revoke the public links of a task or of a
//! project's Files, and ask whether the share door is open. The door itself and the records
//! live in `crate::share`.
//!
//! Making, listing and revoking need an admin of the project (or the owner) who can see the
//! task the link is made from, and every task file it takes; anyone signed in may ask about
//! the door. A member who can't see the task is told it isn't there (ADR 0002) before being
//! told they aren't an admin. A project's list leaves out links made from tasks the caller
//! can't see.

use ganban_core::error::AppError;
use ganban_core::{auth, visibility};
use serde_json::{json, Value};

use super::{command, reply, role_on, Access, Args, Author, Command, Ctx, ResultFilter, Target, PROJECT, TASK};
use crate::share;
use crate::AuthUser;

/// An admin of the target's project who can see it: membership, then visibility, then the
/// admin role, so a hidden task stays "not found" for a member.
async fn admin_who_sees(cx: &Ctx<'_>, a: &Args<'_>, user: &AuthUser, target: Target) -> Result<(), AppError> {
    let project = target.project(cx.db, a).await?;
    role_on(cx.db, user, project, auth::ROLE_MEMBER).await?;
    target.seen(cx.db, user, a).await?;
    role_on(cx.db, user, project, auth::ROLE_ADMIN).await
}

/// `taskId` when given (a task's links), else `projectId` (the project's Files).
const ADMIN_OF_TASK_OR_PROJECT: Access = Access::Custom(|cx, a, user| {
    Box::pin(async move {
        let target = if a.opt_id(TASK).is_some() { TASK } else { PROJECT };
        admin_who_sees(cx, a, user, target).await
    })
});
const ADMIN_OF_LINK: Access = Access::Custom(|cx, a, user| Box::pin(admin_who_sees(cx, a, user, LINK)));

/// The link named by `linkId`; seen with the task it was made from, if any.
const LINK: Target = Target::arg("linkId", |db, id| Box::pin(share::link_project(db, id))).seen_by(|db, v, id| {
    Box::pin(async move {
        match share::link_task(db, id).await? {
            Some(task) => visibility::can_see_task(db, v, task).await,
            None => Ok(true),
        }
    })
});

/// An optional list of ids: left out or `null` → `None`.
fn id_list(a: &Args<'_>, key: &str) -> Result<Option<Vec<i64>>, AppError> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(_)) => Ok(Some(a.i64_list(key))),
        Some(_) => Err(AppError::InvalidInput(format!("{key} must be a list of ids"))),
    }
}

/// `expiresInDays`: left out → 7 days; `null` → never; a number → that many days.
fn expires_in_days(v: Option<&Value>) -> Result<Option<i64>, AppError> {
    match v {
        None => Ok(Some(7)),
        Some(Value::Null) => Ok(None),
        Some(n) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| AppError::InvalidInput("expiresInDays must be a whole number of days or null".into())),
    }
}

pub(super) const COMMANDS: &[Command] = &[
    command("create_share_link").access(ADMIN_OF_TASK_OR_PROJECT).author(Author::Arg("createdBy")).run(|cx, a| {
        Box::pin(async move {
            let task_id = a.opt_id(TASK);
            let new = share::NewLink {
                task_id,
                project_id: match task_id {
                    Some(_) => a.opt_id(PROJECT),
                    None => Some(a.id(PROJECT)?),
                },
                attachment_ids: id_list(a, "attachmentIds")?,
                project_file_ids: id_list(a, "projectFileIds")?,
                viewer: cx.viewer(),
                label: a.opt_str("label"),
                expires_in_days: expires_in_days(a.get("expiresInDays"))?,
                password: a.opt_str("password"),
                created_by: a.opt_author(),
            };
            reply(share::create(cx.db, cx.storage_root()?, new).await?)
        })
    }),
    command("list_share_links").access(ADMIN_OF_TASK_OR_PROJECT).filter(ResultFilter::OfTasks("taskId")).run(|cx, a| {
        Box::pin(async move {
            let of = match a.opt_id(TASK) {
                Some(task) => share::Owner::Task(task),
                None => share::Owner::Project(a.id(PROJECT)?),
            };
            reply(share::list(cx.db, of).await?)
        })
    }),
    command("revoke_share_link")
        .access(ADMIN_OF_LINK)
        .run(|cx, a| Box::pin(async move { reply(share::revoke(cx.db, a.id(LINK)?).await?) })),
    command("get_share_door").access(Access::AnyMember).run(|_, _| {
        Box::pin(async move { Ok(json!({ "enabled": share::door_up(), "publicUrl": share::public_url() })) })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;
    use super::super::{run, Ctx};

    pub(crate) fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ganban_share_cmd_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Project A with a task holding two host-stored files in a folder and one device-only
    /// file. Returns (project, task, [shared ids], local id).
    async fn world(db: &ganban_core::Db, root: &std::path::Path) -> (i64, i64, Vec<i64>, i64) {
        owner(db).await;
        let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let t = seed(db, "create_task", json!({ "input": { "project_id": a, "title": "Roof", "status": "To Do", "priority": "Low" } }))
            .await["id"]
            .as_i64()
            .unwrap();
        let mut shared = Vec::new();
        for (path, body) in [("Survey/plan.pdf", "plan"), ("Survey/photos/1.jpg", "photo")] {
            let name = path.rsplit('/').next().unwrap();
            let att = ganban_core::storage::store_shared_bytes(db, root, t, name, None, None, body.as_bytes()).await.unwrap();
            ganban_core::storage::set_rel_path(db, att.id, Some(path)).await.unwrap();
            shared.push(att.id);
        }
        let local = seed(db, "create_file_attachment", json!({ "input": { "task_id": t, "file_path": "/nowhere/x.pdf", "file_name": "x.pdf" } }))
            .await["id"]
            .as_i64()
            .unwrap();
        (a, t, shared, local)
    }

    #[tokio::test]
    async fn admins_make_list_and_revoke_links() {
        let db = test_db("share_rules").await;
        let root = temp_root("rules");
        let (a, t, shared, local) = world(&db, &root).await;
        let ana = member(&db, 7, &[(a, "admin")]).await;
        let mia = member(&db, 8, &[(a, "member")]).await;
        let bo = member(&db, 9, &[]).await;
        let as_ana = Ctx::http(&db, ana).with_storage_root(&root);
        let as_mia = Ctx::http(&db, mia).with_storage_root(&root);
        let as_bo = Ctx::http(&db, bo).with_storage_root(&root);

        // The default takes every host-stored file; the label is their shared top folder.
        let link = run(&as_ana, "create_share_link", json!({ "taskId": t, "createdBy": 1 })).await.unwrap();
        assert_eq!(link["label"], "Survey");
        assert_eq!(link["fileCount"], 2);
        assert_eq!(link["totalBytes"], 9);
        assert_eq!(link["createdBy"], 7, "the creator is the caller");
        assert_eq!(link["hasPassword"], false);
        assert!(link["path"].as_str().unwrap().starts_with("/s/"));
        assert_eq!(link["path"].as_str().unwrap().len(), 3 + 43);
        assert!(link["expiresAt"].is_string(), "7 days by default");
        assert!(matches!(link["status"].as_str(), Some("preparing" | "active")));

        // A member who isn't an admin, and an outsider, are refused.
        let err = run(&as_mia, "create_share_link", json!({ "taskId": t })).await.unwrap_err();
        assert!(err.is_forbidden(), "{err}");
        assert!(run(&as_mia, "list_share_links", json!({ "taskId": t })).await.unwrap_err().is_forbidden());
        assert!(run(&as_bo, "list_share_links", json!({ "taskId": t })).await.unwrap_err().is_not_found());
        let id = link["id"].as_i64().unwrap();
        assert!(run(&as_mia, "revoke_share_link", json!({ "linkId": id })).await.unwrap_err().is_forbidden());

        // Device-only files are refused by count; the label and expiry are the creator's.
        let err = run(&as_ana, "create_share_link", json!({ "taskId": t, "attachmentIds": [shared[0], local] }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("1 of these files is only on a member's device"), "{err}");
        let second = run(
            &as_ana,
            "create_share_link",
            json!({ "taskId": t, "attachmentIds": [shared[1]], "label": "Photos", "expiresInDays": null, "password": "pw" }),
        )
        .await
        .unwrap();
        assert_eq!((second["fileCount"].as_i64(), second["label"].as_str()), (Some(1), Some("Photos")));
        assert!(second["expiresAt"].is_null());
        assert_eq!(second["hasPassword"], true);

        // Newest first; revoking marks it and keeps it listed.
        let listed = run(&as_ana, "list_share_links", json!({ "taskId": t })).await.unwrap();
        assert_eq!(ids(&listed), vec![second["id"].as_i64().unwrap(), id]);
        let revoked = run(&as_ana, "revoke_share_link", json!({ "linkId": id })).await.unwrap();
        assert_eq!(revoked["status"], "revoked");
        assert!(revoked["revokedAt"].is_string());
        assert_eq!(ids(&run(&as_ana, "list_share_links", json!({ "taskId": t })).await.unwrap()).len(), 2);

        // Anyone signed in may ask about the door.
        let door = run(&as_mia, "get_share_door", json!({})).await.unwrap();
        assert!(door["enabled"].is_boolean() && door.get("publicUrl").is_some());
    }

    #[tokio::test]
    async fn a_hidden_task_and_its_links_are_absent() {
        let db = test_db("share_hidden").await;
        let root = temp_root("hidden");
        let (a, t, _, _) = world(&db, &root).await;
        let mia = member(&db, 8, &[(a, "member")]).await;
        let link = run(&Ctx::in_process(&db), "create_share_link", json!({ "taskId": t }))
            .await
            .unwrap_err();
        assert!(link.is_invalid_input(), "no storage root in-process without one: {link}");
        let link = run(&Ctx::in_process(&db).with_storage_root(&root), "create_share_link", json!({ "taskId": t }))
            .await
            .unwrap();
        let as_mia = Ctx::http(&db, mia).with_storage_root(&root);
        // Mia sees the task: she's refused for not being an admin.
        assert!(run(&as_mia, "list_share_links", json!({ "taskId": t })).await.unwrap_err().is_forbidden());
        // Only the selected members (none) see it now: to her, it and its links aren't there.
        sqlx::query("UPDATE tasks SET visibility = 'members' WHERE id = ?").bind(t).execute(&db).await.unwrap();
        assert!(run(&as_mia, "list_share_links", json!({ "taskId": t })).await.unwrap_err().is_not_found());
        assert!(run(&as_mia, "create_share_link", json!({ "taskId": t })).await.unwrap_err().is_not_found());
        let err = run(&as_mia, "revoke_share_link", json!({ "linkId": link["id"] })).await.unwrap_err();
        assert!(err.is_not_found(), "{err}");
    }

    /// The (kind, folder, name) of a link's files, in order.
    async fn snapshot(db: &ganban_core::Db, link: &serde_json::Value) -> Vec<(String, String, String)> {
        sqlx::query_as("SELECT kind, folder, name FROM share_link_files WHERE link_id = ? ORDER BY n")
            .bind(link["id"].as_i64().unwrap())
            .fetch_all(db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn project_links_take_project_files_and_task_files() {
        let db = test_db("share_project").await;
        let root = temp_root("project");
        let (a, t, shared, local) = world(&db, &root).await;
        let store = |name: &'static str, path: Option<&'static str>, body: &'static [u8]| {
            let (db, root) = (db.clone(), root.clone());
            async move { ganban_core::storage::store_project_file(&db, &root, a, name, None, path, None, body).await.unwrap().id }
        };
        let brief = store("brief.pdf", Some("Docs/brief.pdf"), b"brief").await;
        let logo = store("logo.png", None, b"logo").await;
        let ana = member(&db, 7, &[(a, "admin")]).await;
        let mia = member(&db, 8, &[(a, "member")]).await;
        let as_ana = Ctx::http(&db, ana).with_storage_root(&root);
        let as_mia = Ctx::http(&db, mia).with_storage_root(&root);

        // From the project, by default: its own files. No common top folder: the project's name.
        let own = run(&as_ana, "create_share_link", json!({ "projectId": a })).await.unwrap();
        assert_eq!((own["fileCount"].as_i64(), own["totalBytes"].as_i64(), own["label"].as_str()), (Some(2), Some(9), Some("A")));
        assert!(own["taskId"].is_null());
        assert_eq!(own["projectId"], a);
        assert_eq!(own["createdBy"], 7);

        // One project file: its folder names it.
        let one = run(&as_ana, "create_share_link", json!({ "projectId": a, "projectFileIds": [brief] })).await.unwrap();
        assert_eq!((one["fileCount"].as_i64(), one["label"].as_str()), (Some(1), Some("Docs")));

        // A mix: a task's file sits under its task's folder.
        let mixed = run(
            &as_ana,
            "create_share_link",
            json!({ "projectId": a, "projectFileIds": [brief, logo], "attachmentIds": [shared[0]] }),
        )
        .await
        .unwrap();
        assert_eq!(mixed["fileCount"], 3);
        let files = snapshot(&db, &mixed).await;
        let s = |k: &str, f: &str, n: &str| (k.to_string(), f.to_string(), n.to_string());
        assert_eq!(files, vec![s("project", "", "logo.png"), s("project", "Docs", "brief.pdf"), s("attachment", "Roof/Survey", "plan.pdf")]);

        // The door serves them all from their own blobs.
        let row = crate::share::link_by_id(&db, mixed["id"].as_i64().unwrap()).await.unwrap();
        crate::share::prepare(&db, &root, row.id).await.unwrap();
        let row = crate::share::link_by_id(&db, row.id).await.unwrap();
        let live = crate::share::live_files(&db, &root, &row).await.unwrap();
        assert!(live.ready);
        assert_eq!((live.files.len(), live.gone), (3, 0));
        assert!(live.files.iter().all(|f| f.row.crc32.is_some()));
        // A project file deleted since drops out.
        sqlx::query("DELETE FROM project_files WHERE id = ?").bind(logo).execute(&db).await.unwrap();
        let live = crate::share::live_files(&db, &root, &row).await.unwrap();
        assert_eq!((live.files.len(), live.gone), (2, 1));

        // Device-only task files, and files of another project, are refused.
        let err = run(&as_ana, "create_share_link", json!({ "projectId": a, "attachmentIds": [local] })).await.unwrap_err();
        assert!(err.to_string().contains("only on a member's device"), "{err}");
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let elsewhere = ganban_core::storage::store_project_file(&db, &root, b, "x.txt", None, None, None, b"x").await.unwrap().id;
        let err = run(&as_ana, "create_share_link", json!({ "projectId": a, "projectFileIds": [elsewhere] })).await.unwrap_err();
        assert!(err.is_not_found(), "{err}");

        // A project's list has every link made from it or from its tasks; a task's, its own.
        let from_task = run(&as_ana, "create_share_link", json!({ "taskId": t })).await.unwrap();
        let listed = run(&as_ana, "list_share_links", json!({ "projectId": a })).await.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 4);
        assert_eq!(ids(&listed)[0], from_task["id"].as_i64().unwrap());
        assert_eq!(ids(&run(&as_ana, "list_share_links", json!({ "taskId": t })).await.unwrap()), ids(&json!([from_task])));
        // A project link revokes like a task's.
        assert_eq!(run(&as_ana, "revoke_share_link", json!({ "linkId": own["id"] })).await.unwrap()["status"], "revoked");

        // Members who aren't admins are refused.
        assert!(run(&as_mia, "create_share_link", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
        assert!(run(&as_mia, "list_share_links", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
        assert!(run(&as_mia, "revoke_share_link", json!({ "linkId": one["id"] })).await.unwrap_err().is_forbidden());
    }

    #[tokio::test]
    async fn a_hidden_tasks_file_is_refused() {
        let db = test_db("share_hidden_file").await;
        let root = temp_root("hidden_file");
        let (a, t, shared, _) = world(&db, &root).await;
        let mia = member(&db, 8, &[(a, "member")]).await;
        sqlx::query("UPDATE tasks SET visibility = 'members' WHERE id = ?").bind(t).execute(&db).await.unwrap();
        // Admins see every task (ADR 0002), so the snapshot's own check is what stops a viewer
        // who can't: the file is "not found".
        let new = |attachments: Vec<i64>| crate::share::NewLink {
            task_id: None,
            project_id: Some(a),
            attachment_ids: Some(attachments),
            project_file_ids: None,
            label: None,
            expires_in_days: Some(7),
            password: None,
            created_by: Some(8),
            viewer: Some(super::super::viewer_of(&mia)),
        };
        let err = crate::share::create(&db, &root, new(vec![shared[0]])).await.err().unwrap();
        assert!(err.is_not_found(), "{err}");
        sqlx::query("UPDATE tasks SET visibility = 'area' WHERE id = ?").bind(t).execute(&db).await.unwrap();
        assert!(crate::share::create(&db, &root, new(vec![shared[0]])).await.is_ok());

    }

    #[tokio::test]
    async fn bad_arguments_are_refused() {
        let db = test_db("share_args").await;
        let root = temp_root("args");
        let (_, t, _, _) = world(&db, &root).await;
        let cx = Ctx::in_process(&db).with_storage_root(&root);
        for args in [
            json!({ "taskId": t, "attachmentIds": [] }),
            json!({ "taskId": t, "expiresInDays": 0 }),
            json!({ "taskId": t, "expiresInDays": "7" }),
            json!({ "taskId": t, "attachmentIds": "1" }),
            json!({ "taskId": t, "projectFileIds": "1" }),
            json!({ "taskId": t, "attachmentIds": [], "projectFileIds": [] }),
            json!({}),
            json!({ "taskId": t, "projectId": 999 }),
        ] {
            assert!(run(&cx, "create_share_link", args.clone()).await.unwrap_err().is_invalid_input(), "{args}");
        }
        assert!(run(&cx, "create_share_link", json!({ "taskId": t, "attachmentIds": [999] })).await.unwrap_err().is_not_found());
        // Without a storage root nothing can be shared.
        assert!(run(&Ctx::in_process(&db), "create_share_link", json!({ "taskId": t })).await.unwrap_err().is_invalid_input());
    }
}
