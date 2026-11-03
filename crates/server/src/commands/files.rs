//! Task attachments and a project's shared-file storage. Uploads and downloads have their
//! own streaming routes; these commands manage the records and the allocation.

use ganban_core::error::AppError;
use ganban_core::storage;
use ganban_core::{auth, ops, visibility};
use serde_json::{json, Value};

use super::{
    command, reply, require_role, viewer_of, Access, Args, Author, Command, Ctx, Target, INPUT_TASK, PROJECT, TASK,
};
use crate::AuthUser;

/// The attachment named by `attachmentId`; seen with its task.
const ATTACHMENT: Target = Target::arg("attachmentId", |db, id| {
    Box::pin(async move {
        Ok(Some(auth::attachment_project_id(db, id).await?.ok_or_else(|| AppError::NotFound("attachment".into()))?))
    })
})
.seen_by(|db, v, id| Box::pin(visibility::can_see_attachment(db, v, id)));

/// Who may put a file in or out of the AI overview: an admin of its project, or whoever
/// uploaded it. Either must be a member and, for an attachment, see its task (ADR 0002):
/// outside the project or the task's audience the file is "not found".
async fn may_set_ai_included(cx: &Ctx<'_>, a: &Args<'_>, user: &AuthUser) -> Result<(), AppError> {
    let kind = a.req_str("kind")?;
    let id = a.req_i64("id")?;
    let project = match kind.as_str() {
        "attachment" => auth::attachment_project_id(cx.db, id).await?.ok_or_else(|| AppError::NotFound("file".into()))?,
        "project" => storage::project_file_project(cx.db, id).await?,
        _ => return Err(AppError::InvalidInput(format!("kind '{kind}' is not one of attachment | project"))),
    };
    require_role(cx.db, user, project, auth::ROLE_MEMBER).await?;
    if kind == "attachment" && !visibility::can_see_attachment(cx.db, viewer_of(user), id).await? {
        return Err(AppError::NotFound("not found".into()));
    }
    if require_role(cx.db, user, project, auth::ROLE_ADMIN).await.is_ok() {
        return Ok(());
    }
    if storage::file_uploader(cx.db, &kind, id).await? == Some(user.id) {
        Ok(())
    } else {
        Err(AppError::Forbidden("only a project admin or the file's uploader can change whether the AI reads it".into()))
    }
}

/// Who may rename a file: a member of its project who, for an attachment, sees its task — the
/// same as deleting it.
async fn may_touch_file(cx: &Ctx<'_>, a: &Args<'_>, user: &AuthUser) -> Result<(), AppError> {
    let id = a.req_i64("id")?;
    match a.req_str("kind")?.as_str() {
        "attachment" => {
            let project =
                auth::attachment_project_id(cx.db, id).await?.ok_or_else(|| AppError::NotFound("file".into()))?;
            require_role(cx.db, user, project, auth::ROLE_MEMBER).await?;
            if !visibility::can_see_attachment(cx.db, viewer_of(user), id).await? {
                return Err(AppError::NotFound("not found".into()));
            }
            Ok(())
        }
        "project" => require_role(cx.db, user, storage::project_file_project(cx.db, id).await?, auth::ROLE_MEMBER).await,
        other => Err(AppError::InvalidInput(format!("kind '{other}' is not one of attachment | project"))),
    }
}

/// Folder commands name a project and, for a task's own files, the task: a member of the
/// project who sees that task.
async fn may_use_folders(cx: &Ctx<'_>, a: &Args<'_>, user: &AuthUser) -> Result<(), AppError> {
    let project = a.req_i64("projectId")?;
    require_role(cx.db, user, project, auth::ROLE_MEMBER).await?;
    if let Some(task) = a.opt_i64("taskId") {
        if storage::task_project(cx.db, task).await? != project
            || !visibility::can_see_task(cx.db, viewer_of(user), task).await?
        {
            return Err(AppError::NotFound("not found".into()));
        }
    }
    Ok(())
}

/// The files a folder command works on: the task's (with `taskId`) or the project's own.
async fn folder_scope(cx: &Ctx<'_>, a: &Args<'_>) -> Result<storage::FolderScope, AppError> {
    let project = a.req_i64("projectId")?;
    match a.opt_i64("taskId") {
        Some(task) if storage::task_project(cx.db, task).await? != project => {
            Err(AppError::InvalidInput("that task isn't in this project".into()))
        }
        Some(task) => Ok(storage::FolderScope::Task(task)),
        None => Ok(storage::FolderScope::Project(project)),
    }
}

/// The optional project of `get_storage_location`: admins of it may ask; without one, the owner.
const OPT_PROJECT: Target = Target::optional("projectId", |_, id| Box::pin(async move { Ok(Some(id)) }));

/// An `ids` argument: a list of numbers.
fn id_list(v: Option<&Value>) -> Result<Vec<i64>, AppError> {
    let bad = || AppError::InvalidInput("'ids' must be a list of numbers".into());
    v.and_then(Value::as_array).ok_or_else(bad)?.iter().map(|x| x.as_i64().ok_or_else(bad)).collect()
}

/// This machine's name, for "the files are on <host>".
fn host_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "the host".into())
}

pub(super) const COMMANDS: &[Command] = &[
    // ----- Attachments -----
    command("get_file_attachments")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_file_attachments(cx.db, a.id(TASK)?).await?) })),
    command("create_file_attachment")
        .access(Access::Member(INPUT_TASK))
        .author(Author::Input("uploaded_by"))
        .run(|cx, a| Box::pin(async move { reply(ops::create_file_attachment(cx.db, a.input()?).await?) })),
    command("update_file_attachment").access(Access::Member(ATTACHMENT)).run(|cx, a| {
        Box::pin(async move { reply(ops::update_file_attachment(cx.db, a.id(ATTACHMENT)?, a.input()?).await?) })
    }),
    command("verify_file_attachment")
        .access(Access::Member(ATTACHMENT))
        .run(|cx, a| Box::pin(async move { reply(ops::verify_file_attachment(cx.db, a.id(ATTACHMENT)?).await?) })),
    // Deleting an attachment also drops its shared copy, which frees the quota.
    command("delete_file_attachment").access(Access::Member(ATTACHMENT)).run(|cx, a| {
        Box::pin(async move {
            let id = a.id(ATTACHMENT)?;
            ops::delete_file_attachment(cx.db, id).await?;
            if let Some(root) = cx.storage_root {
                storage::remove_blob(root, id);
            }
            Ok(Value::Null)
        })
    }),
    // Promote a local attachment to shared (its bytes are copied into the project's
    // allocation) or demote it back. Runs where the storage root is: the host, or the
    // desktop in-process.
    command("share_file_attachment").access(Access::Member(ATTACHMENT)).run(|cx, a| {
        Box::pin(async move { reply(storage::share_local_file(cx.db, cx.storage_root()?, a.id(ATTACHMENT)?).await?) })
    }),
    command("unshare_file_attachment").access(Access::Member(ATTACHMENT)).run(|cx, a| {
        Box::pin(async move { reply(storage::unshare_file(cx.db, cx.storage_root()?, a.id(ATTACHMENT)?).await?) })
    }),
    // ----- The AI overview -----
    // Put a task attachment or a project file in or out of the project's knowledge base.
    // Over the size guard (GANBAN_AI_MAX_FILE_MB) including needs `force`. Returns the row.
    command("set_file_ai_included").access(Access::Custom(|cx, a, user| Box::pin(may_set_ai_included(cx, a, user)))).run(
        |cx, a| {
            Box::pin(async move {
                let id = a.req_i64("id")?;
                let included = a.opt_bool("included").ok_or_else(|| AppError::InvalidInput("missing argument 'included'".into()))?;
                let force = a.opt_bool("force").unwrap_or(false);
                match a.req_str("kind")?.as_str() {
                    "attachment" => reply(storage::set_attachment_ai_included(cx.db, id, included, force).await?),
                    "project" => reply(storage::set_project_file_ai_included(cx.db, id, included, force).await?),
                    other => Err(AppError::InvalidInput(format!("kind '{other}' is not one of attachment | project"))),
                }
            })
        },
    ),
    // ----- Names and folders -----
    // Rename a task attachment or a project file in place: same folder, a name not already
    // taken there. Returns the row.
    command("rename_file").access(Access::Custom(|cx, a, user| Box::pin(may_touch_file(cx, a, user)))).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("id")?;
            let name = a.req_str("name")?;
            match a.req_str("kind")?.as_str() {
                "attachment" => reply(storage::rename_attachment(cx.db, id, &name).await?),
                "project" => reply(storage::rename_project_file(cx.db, id, &name).await?),
                other => Err(AppError::InvalidInput(format!("kind '{other}' is not one of attachment | project"))),
            }
        })
    }),
    // A project's (or, with `taskId`, a task's) explicit folders: empty ones live only here.
    command("list_file_folders").access(Access::Custom(|cx, a, user| Box::pin(may_use_folders(cx, a, user)))).run(
        |cx, a| {
            Box::pin(async move {
                match folder_scope(cx, a).await? {
                    storage::FolderScope::Project(p) => reply(storage::list_project_folders(cx.db, p).await?),
                    storage::FolderScope::Task(t) => reply(storage::list_task_folders(cx.db, t).await?),
                }
            })
        },
    ),
    command("create_file_folder").access(Access::Custom(|cx, a, user| Box::pin(may_use_folders(cx, a, user)))).run(
        |cx, a| {
            Box::pin(async move {
                let path = a.req_str("path")?;
                match folder_scope(cx, a).await? {
                    storage::FolderScope::Project(p) => reply(storage::create_project_folder(cx.db, p, &path).await?),
                    storage::FolderScope::Task(t) => reply(storage::create_task_folder(cx.db, t, &path).await?),
                }
            })
        },
    ),
    // Remove a folder that holds no files.
    command("delete_file_folder").access(Access::Custom(|cx, a, user| Box::pin(may_use_folders(cx, a, user)))).run(
        |cx, a| {
            Box::pin(async move {
                storage::delete_empty_folder(cx.db, folder_scope(cx, a).await?, &a.req_str("path")?).await?;
                Ok(Value::Null)
            })
        },
    ),
    // Rename (or move) a folder: every file under `from` takes the `to` prefix.
    command("rename_folder").access(Access::Custom(|cx, a, user| Box::pin(may_use_folders(cx, a, user)))).run(|cx, a| {
        Box::pin(async move {
            let moved = storage::rename_folder(cx.db, folder_scope(cx, a).await?, &a.req_str("from")?, &a.req_str("to")?).await?;
            Ok(json!({ "moved": moved }))
        })
    }),
    // Move files into a folder (`dir: ""` is the root): the project's own files, or with
    // `taskId` the task's attachments.
    command("move_files").access(Access::Custom(|cx, a, user| Box::pin(may_use_folders(cx, a, user)))).run(|cx, a| {
        Box::pin(async move {
            let ids = id_list(a.get("ids"))?;
            let dir = a.opt_str("dir").unwrap_or_default();
            let moved = match folder_scope(cx, a).await? {
                storage::FolderScope::Project(p) => storage::move_project_files(cx.db, p, &ids, &dir).await?,
                storage::FolderScope::Task(t) => storage::move_attachments(cx.db, t, &ids, &dir).await?,
            };
            Ok(json!({ "moved": moved }))
        })
    }),
    // ----- Where the bytes are -----
    // The folder on the host that holds the file bytes: attachments as `<root>/<id>`, a
    // project's own files as `<root>/pf/<id>` (flat, shared by every project). For the
    // owner, or an admin of `projectId`. `isThisMachine` is true when the caller runs in
    // the same process (the desktop app); a loopback client works that out itself.
    command("get_storage_location").access(Access::Admin(OPT_PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let root = cx.storage_root()?;
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            let project_dir = a.opt_i64("projectId").map(|_| root.join("pf").to_string_lossy().into_owned());
            Ok(json!({
                "root": root.to_string_lossy(),
                "projectDir": project_dir,
                "hostName": host_name(),
                "isThisMachine": matches!(cx.caller, super::Caller::InProcess),
            }))
        })
    }),
    // ----- Storage allocation -----
    command("get_project_storage").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let pid = a.id(PROJECT)?;
            Ok(json!({
                "used": storage::project_used(cx.db, pid).await?,
                "quota": storage::project_quota(cx.db, pid).await?,
            }))
        })
    }),
    command("set_project_quota").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move { reply(storage::set_project_quota(cx.db, a.id(PROJECT)?, a.req_i64("bytes")?).await?) })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;
    use super::super::{run, Ctx};

    /// Project A with one task; returns (a, task).
    async fn world(db: &ganban_core::Db) -> (i64, i64) {
        owner(db).await;
        let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let t = seed(db, "create_task", json!({ "input": { "project_id": a, "title": "t", "status": "To Do", "priority": "Low" } }))
            .await["id"]
            .as_i64()
            .unwrap();
        (a, t)
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ganban_commands_root_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn attachments_need_membership_and_are_uploaded_by_the_caller() {
        let db = test_db("files_rules").await;
        let (a, t) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let bo = member(&db, 8, &[]).await;

        let new = json!({ "input": { "task_id": t, "file_path": "/tmp/x.pdf", "file_name": "x.pdf", "uploaded_by": 8 } });
        assert!(http(&db, bo, "create_file_attachment", new.clone()).await.unwrap_err().is_not_found());
        let att = http(&db, mia, "create_file_attachment", new).await.unwrap();
        assert_eq!(att["uploaded_by"], 7, "a spoofed uploader is overwritten with the caller");

        let id = att["id"].as_i64().unwrap();
        for cmd in ["verify_file_attachment", "delete_file_attachment", "share_file_attachment"] {
            assert!(http(&db, bo, cmd, json!({ "attachmentId": id })).await.unwrap_err().is_not_found(), "{cmd}");
        }
        assert!(http(&db, bo, "get_file_attachments", json!({ "taskId": t })).await.unwrap_err().is_not_found());
        assert_eq!(ids(&http(&db, mia, "get_file_attachments", json!({ "taskId": t })).await.unwrap()), vec![id]);
    }

    #[tokio::test]
    async fn storage_reads_need_membership_and_the_quota_needs_an_admin() {
        let db = test_db("files_quota").await;
        let (a, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let bo = member(&db, 9, &[]).await;

        assert_eq!(http(&db, mia, "get_project_storage", json!({ "projectId": a })).await.unwrap()["used"], 0);
        assert!(http(&db, bo, "get_project_storage", json!({ "projectId": a })).await.unwrap_err().is_not_found());
        let quota = json!({ "projectId": a, "bytes": 1024 });
        assert!(http(&db, mia, "set_project_quota", quota.clone()).await.unwrap_err().is_forbidden());
        http(&db, ana, "set_project_quota", quota).await.unwrap();
        assert_eq!(http(&db, mia, "get_project_storage", json!({ "projectId": a })).await.unwrap()["quota"], 1024);
    }

    /// Who may put a file in or out of the AI overview: the owner, a project admin, or the
    /// file's uploader, who must see the task when it's an attachment.
    #[tokio::test]
    async fn ai_inclusion_is_for_admins_and_the_uploader_who_sees_the_task() {
        let db = test_db("files_ai_access").await;
        let (a, t) = world(&db).await;
        let boss = owner(&db).await;
        let ana = member(&db, 6, &[(a, "admin")]).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let lu = member(&db, 8, &[(a, "member")]).await;
        let bo = member(&db, 9, &[]).await;

        let new = json!({ "input": { "task_id": t, "file_path": "/tmp/x.pdf", "file_name": "x.pdf" } });
        let att = http(&db, mia, "create_file_attachment", new).await.unwrap();
        assert_eq!(att["ai_included"], false, "a new attachment starts out of the AI overview");
        let att = att["id"].as_i64().unwrap();
        let pf = sqlx::query("INSERT INTO project_files (project_id, file_name, size_bytes, uploaded_by) VALUES (?, 'deck.pdf', 10, 7)")
            .bind(a)
            .execute(&db)
            .await
            .unwrap()
            .last_insert_rowid();

        for (kind, id) in [("attachment", att), ("project", pf)] {
            let set = |included: bool| json!({ "kind": kind, "id": id, "included": included });
            assert!(http(&db, bo, "set_file_ai_included", set(true)).await.unwrap_err().is_not_found(), "{kind}: outsider");
            assert!(http(&db, lu, "set_file_ai_included", set(true)).await.unwrap_err().is_forbidden(), "{kind}: other member");
            assert_eq!(http(&db, mia, "set_file_ai_included", set(true)).await.unwrap()["ai_included"], true, "{kind}: uploader");
            assert_eq!(http(&db, ana, "set_file_ai_included", set(false)).await.unwrap()["ai_included"], false, "{kind}: admin");
            assert_eq!(http(&db, boss, "set_file_ai_included", set(true)).await.unwrap()["ai_included"], true, "{kind}: owner");
        }

        // The uploader must still see the task: hidden from her, the attachment isn't there.
        seed(&db, "set_task_visibility", json!({ "taskId": t, "visibility": "admins" })).await;
        let off = json!({ "kind": "attachment", "id": att, "included": false });
        assert!(http(&db, mia, "set_file_ai_included", off.clone()).await.unwrap_err().is_not_found());
        http(&db, ana, "set_file_ai_included", off).await.unwrap();

        let bad = json!({ "kind": "folder", "id": pf, "included": true });
        assert!(http(&db, mia, "set_file_ai_included", bad.clone()).await.unwrap_err().is_invalid_input());
        assert!(seed_err(&db, "set_file_ai_included", bad).await.is_invalid_input());
    }

    /// A file over the size guard goes in only with `force`; the refusal names its size.
    #[tokio::test]
    async fn including_a_file_over_the_size_guard_needs_force() {
        let db = test_db("files_ai_force").await;
        let (a, _) = world(&db).await;
        let ana = member(&db, 6, &[(a, "admin")]).await;
        let big = 380_i64 * 1024 * 1024;
        let pf = sqlx::query("INSERT INTO project_files (project_id, file_name, size_bytes) VALUES (?, 'textbook.pdf', ?)")
            .bind(a)
            .bind(big)
            .execute(&db)
            .await
            .unwrap()
            .last_insert_rowid();
        let set = |force: Option<bool>| {
            let mut v = json!({ "kind": "project", "id": pf, "included": true });
            if let Some(f) = force {
                v["force"] = json!(f);
            }
            v
        };
        let err = http(&db, ana, "set_file_ai_included", set(None)).await.unwrap_err();
        assert!(err.is_invalid_input() && err.to_string().contains("380 MB"), "{err}");
        assert!(http(&db, ana, "set_file_ai_included", set(Some(false))).await.is_err());
        let row = http(&db, ana, "set_file_ai_included", set(Some(true))).await.unwrap();
        assert_eq!(row["ai_included"], true);
        let stored: i64 = sqlx::query_scalar("SELECT ai_included FROM project_files WHERE id = ?").bind(pf).fetch_one(&db).await.unwrap();
        assert_eq!(stored, ganban_core::storage::AI_FORCED, "the forced choice is kept");
    }

    /// Renames and folders: members of the project, who must see the task for its files.
    #[tokio::test]
    async fn names_and_folders_need_membership_and_the_task_in_sight() {
        let db = test_db("files_names").await;
        let (a, t) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let bo = member(&db, 9, &[]).await;
        let att = http(&db, mia, "create_file_attachment", json!({ "input": { "task_id": t, "file_path": "/tmp/x.pdf", "file_name": "x.pdf" } }))
            .await
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let pf = sqlx::query("INSERT INTO project_files (project_id, file_name, size_bytes) VALUES (?, 'deck.pdf', 10)")
            .bind(a)
            .execute(&db)
            .await
            .unwrap()
            .last_insert_rowid();

        let rename = |kind: &str, id: i64, name: &str| json!({ "kind": kind, "id": id, "name": name });
        assert!(http(&db, bo, "rename_file", rename("project", pf, "y.pdf")).await.unwrap_err().is_not_found());
        assert_eq!(http(&db, mia, "rename_file", rename("project", pf, "pitch.pdf")).await.unwrap()["file_name"], "pitch.pdf");
        assert_eq!(http(&db, mia, "rename_file", rename("attachment", att, "plan.pdf")).await.unwrap()["file_name"], "plan.pdf");
        assert!(http(&db, mia, "rename_file", rename("attachment", att, "a/b.pdf")).await.unwrap_err().is_invalid_input());

        let task_scope = json!({ "projectId": a, "taskId": t, "path": "Photos" });
        assert!(http(&db, bo, "create_file_folder", task_scope.clone()).await.unwrap_err().is_not_found());
        http(&db, mia, "create_file_folder", task_scope.clone()).await.unwrap();
        http(&db, mia, "create_file_folder", json!({ "projectId": a, "path": "Specs" })).await.unwrap();
        assert_eq!(http(&db, mia, "list_file_folders", json!({ "projectId": a, "taskId": t })).await.unwrap(), json!(["Photos"]));
        assert_eq!(http(&db, mia, "list_file_folders", json!({ "projectId": a })).await.unwrap(), json!(["Specs"]));
        let moved = http(&db, mia, "move_files", json!({ "projectId": a, "taskId": t, "ids": [att], "dir": "Photos" })).await.unwrap();
        assert_eq!(moved["moved"], 1);
        let to = json!({ "projectId": a, "taskId": t, "from": "Photos", "to": "Site" });
        assert_eq!(http(&db, mia, "rename_folder", to).await.unwrap()["moved"], 1);
        http(&db, mia, "move_files", json!({ "projectId": a, "ids": [pf], "dir": "Specs" })).await.unwrap();
        let err = http(&db, mia, "delete_file_folder", json!({ "projectId": a, "path": "Specs" })).await.unwrap_err();
        assert!(err.is_invalid_input(), "a folder with files stays: {err}");

        // A task from another project, or one hidden from her, isn't there.
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        assert!(http(&db, mia, "list_file_folders", json!({ "projectId": b })).await.unwrap_err().is_not_found());
        seed(&db, "set_task_visibility", json!({ "taskId": t, "visibility": "admins" })).await;
        for (cmd, args) in [
            ("list_file_folders", json!({ "projectId": a, "taskId": t })),
            ("rename_file", rename("attachment", att, "z.pdf")),
            ("rename_folder", json!({ "projectId": a, "taskId": t, "from": "Site", "to": "X" })),
        ] {
            assert!(http(&db, mia, cmd, args).await.unwrap_err().is_not_found(), "{cmd}");
        }
    }

    /// The storage folder: admins of the project, or the owner without one.
    #[tokio::test]
    async fn the_storage_folder_is_for_admins() {
        let db = test_db("files_where").await;
        let (a, _) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let boss = owner(&db).await;
        let root = temp_root("where");
        let run_as = |u| Ctx::http(&db, u).with_storage_root(&root);

        assert!(run(&run_as(mia), "get_storage_location", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
        assert!(run(&run_as(ana), "get_storage_location", json!({})).await.unwrap_err().is_forbidden(), "no project: owner only");
        let at = run(&run_as(ana), "get_storage_location", json!({ "projectId": a })).await.unwrap();
        let real = std::fs::canonicalize(&root).unwrap();
        assert_eq!(at["root"], real.to_string_lossy().as_ref());
        assert_eq!(at["projectDir"], real.join("pf").to_string_lossy().as_ref());
        assert_eq!(at["isThisMachine"], false);
        assert!(at["hostName"].as_str().is_some_and(|h| !h.is_empty()));
        assert_eq!(run(&run_as(boss), "get_storage_location", json!({})).await.unwrap()["projectDir"], json!(null));
        let here = run(&Ctx::in_process(&db).with_storage_root(&root), "get_storage_location", json!({})).await.unwrap();
        assert_eq!(here["isThisMachine"], true);
    }

    async fn seed_err(db: &ganban_core::Db, name: &str, args: serde_json::Value) -> ganban_core::error::AppError {
        run(&Ctx::in_process(db), name, args).await.unwrap_err()
    }

    #[tokio::test]
    async fn sharing_and_deleting_move_the_shared_copy() {
        let db = test_db("files_blobs").await;
        let (a, t) = world(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let root = temp_root("blobs");
        let cx = Ctx::http(&db, mia).with_storage_root(&root);

        let local = root.join("local-original.txt");
        std::fs::write(&local, b"hello").unwrap();
        let new = json!({ "input": { "task_id": t, "file_path": local.to_string_lossy(), "file_name": "hello.txt" } });
        let id = run(&cx, "create_file_attachment", new).await.unwrap()["id"].as_i64().unwrap();
        let blob = ganban_core::storage::blob_path(&root, id);

        assert_eq!(run(&cx, "share_file_attachment", json!({ "attachmentId": id })).await.unwrap()["is_shared"], true);
        assert!(blob.exists(), "sharing copies the bytes into the allocation");
        assert_eq!(run(&cx, "unshare_file_attachment", json!({ "attachmentId": id })).await.unwrap()["is_shared"], false);
        assert!(!blob.exists());

        // Without a storage root (the agent tools' executor) nothing can be shared.
        let err = http(&db, mia, "share_file_attachment", json!({ "attachmentId": id })).await.unwrap_err();
        assert!(err.is_invalid_input(), "{err}");

        run(&cx, "share_file_attachment", json!({ "attachmentId": id })).await.unwrap();
        run(&cx, "delete_file_attachment", json!({ "attachmentId": id })).await.unwrap();
        assert!(!blob.exists(), "deleting the attachment frees its shared copy");
        assert!(local.exists(), "the uploader's local original is untouched");
    }
}
