//! Project-level files (host drop zone): store / list / quota / download / delete.

use ganban_core::models::{CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db_role, ops, storage, Role};
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_pf_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[tokio::test]
async fn project_files_round_trip_and_quota() {
    let dir = temp_dir("rt");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;

    // Store a file.
    let f = storage::store_project_file(&db, &root, pid, "spec.md", Some("text/markdown"), Some("docs/spec.md"), Some(1), b"hello world")
        .await
        .unwrap();
    assert_eq!(f.file_name, "spec.md");
    assert_eq!(f.size_bytes, 11);
    assert_eq!(f.rel_path.as_deref(), Some("docs/spec.md"));

    // It's listed, counts toward usage, and the blob exists at the pf path.
    assert_eq!(storage::list_project_files(&db, pid).await.unwrap().len(), 1);
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), 11, "project_files count toward usage");
    assert_eq!(storage::project_file_project(&db, f.id).await.unwrap(), pid);
    assert!(storage::project_blob_path(&root, f.id).exists());

    // Downloadable (name, sniffed mime for Content-Type, blob path).
    let (name, mime, path) = storage::project_file_for_download(&db, &root, f.id).await.unwrap();
    assert_eq!(name, "spec.md");
    assert_eq!(mime.as_deref(), Some("text/markdown"));
    assert_eq!(std::fs::read(&path).unwrap(), b"hello world");

    // Delete: row + blob gone, usage back to 0.
    storage::delete_project_file(&db, &root, f.id).await.unwrap();
    assert!(storage::list_project_files(&db, pid).await.unwrap().is_empty());
    assert!(!storage::project_blob_path(&root, f.id).exists());
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), 0);
}

#[tokio::test]
async fn quota_is_a_dynamic_ceiling() {
    let dir = temp_dir("quota");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;

    // A small project reserves nothing — usage starts at 0 well under the cap.
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), 0);

    // Tighten the cap, then exceed it.
    storage::set_project_quota(&db, pid, 10).await.unwrap();
    storage::store_project_file(&db, &root, pid, "a.txt", None, None, None, b"12345").await.unwrap(); // 5 bytes, ok
    let over = storage::store_project_file(&db, &root, pid, "b.txt", None, None, None, b"1234567890").await; // +10 > 10
    assert!(over.is_err(), "exceeding the cap is rejected");
    // The rejected file left no blob/row behind.
    assert_eq!(storage::list_project_files(&db, pid).await.unwrap().len(), 1);
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), 5);
}

#[tokio::test]
async fn project_attachments_aggregate_with_task_title() {
    let dir = temp_dir("agg");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let task = ops::create_task(
        &db,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "Roof survey".into(),
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
    .unwrap();

    // No shared attachments yet.
    assert!(storage::list_project_attachments(&db, pid).await.unwrap().is_empty());

    // A shared attachment with bytes surfaces in the project view, tagged with
    // its task title, and counts toward usage.
    let att = storage::create_shared_attachment(&db, task.id, "survey.pdf", Some("application/pdf"), Some(1)).await.unwrap();
    storage::set_storage_size(&db, att.id, 2048).await.unwrap();

    let list = storage::list_project_attachments(&db, pid).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].task_title, "Roof survey");
    assert_eq!(list[0].file_name, "survey.pdf");
    assert_eq!(list[0].storage_size, 2048);
    assert_eq!(list[0].task_id, task.id);
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), 2048);
}

#[tokio::test]
async fn audit_finds_missing_blobs_and_restore_or_clear_resolves_them() {
    let dir = temp_dir("audit");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;

    // Two project files + one shared attachment, all healthy.
    let keep = storage::store_project_file(&db, &root, pid, "keep.md", None, None, None, b"fine").await.unwrap();
    let broken = storage::store_project_file(&db, &root, pid, "broken.pdf", None, None, None, b"bytes!").await.unwrap();
    let task = ops::create_task(&db, CreateTaskInput {
        project_id: pid, area_id: None, title: "T".into(), description: None,
        status: "To Do".into(), priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
    }).await.unwrap();
    let att = storage::create_shared_attachment(&db, task.id, "att.txt", Some("text/plain"), None).await.unwrap();
    std::fs::write(storage::blob_path(&root, att.id), b"shared bytes").unwrap();
    storage::set_storage_size(&db, att.id, 12).await.unwrap();

    // Healthy storage audits clean.
    assert!(storage::audit_project_files(&db, &root, pid).await.unwrap().is_empty());

    // Lose two blobs behind the DB's back.
    std::fs::remove_file(storage::project_blob_path(&root, broken.id)).unwrap();
    std::fs::remove_file(storage::blob_path(&root, att.id)).unwrap();

    let missing = storage::audit_project_files(&db, &root, pid).await.unwrap();
    assert_eq!(missing.len(), 2);
    assert!(missing.iter().any(|m| m.id == broken.id && m.kind == "project" && m.file_name == "broken.pdf"));
    assert!(missing.iter().any(|m| m.id == att.id && m.kind == "attachment"));

    // Restore the project file: same id, new bytes, size/type updated.
    let restored = storage::restore_project_file(&db, &root, broken.id, Some("application/pdf"), b"new bytes, longer").await.unwrap();
    assert_eq!(restored.id, broken.id, "the link (id) survives a restore");
    assert_eq!(restored.size_bytes, 17);
    assert_eq!(std::fs::read(storage::project_blob_path(&root, broken.id)).unwrap(), b"new bytes, longer");
    assert_eq!(storage::audit_project_files(&db, &root, pid).await.unwrap().len(), 1, "only the attachment is still missing");

    // Clear the rest: the dead attachment record is deleted outright.
    assert_eq!(storage::clear_missing_files(&db, &root, pid).await.unwrap(), 1);
    assert!(storage::audit_project_files(&db, &root, pid).await.unwrap().is_empty());
    let still_there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attachments WHERE id = ?")
        .bind(att.id).fetch_one(&db).await.unwrap();
    assert_eq!(still_there, 0, "a record pointing at nothing is removed");

    // Clearing a missing PROJECT file deletes its row outright; the restored
    // one (healthy again) survives.
    std::fs::remove_file(storage::project_blob_path(&root, keep.id)).unwrap();
    assert_eq!(storage::clear_missing_files(&db, &root, pid).await.unwrap(), 1);
    let left = storage::list_project_files(&db, pid).await.unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, broken.id);

    // Restore quota math is net of the stale recorded size.
    let big = storage::store_project_file(&db, &root, pid, "big.bin", None, None, None, &vec![0u8; 100]).await.unwrap();
    storage::set_project_quota(&db, pid, 117).await.unwrap(); // exactly current usage (100 + the 17-byte restored file)
    std::fs::remove_file(storage::project_blob_path(&root, big.id)).unwrap();
    assert!(storage::restore_project_file(&db, &root, big.id, None, &vec![0u8; 100]).await.is_ok(),
        "restoring at the same size fits — the stale size is netted out");
    std::fs::remove_file(storage::project_blob_path(&root, big.id)).unwrap();
    assert!(storage::restore_project_file(&db, &root, big.id, None, &vec![0u8; 101]).await.is_err(),
        "but growing past the quota is refused");
}

#[tokio::test]
async fn local_files_batch_push_and_task_allocation_round_trip() {
    let dir = temp_dir("alloc");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    std::fs::create_dir_all(&root).unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let task = ops::create_task(&db, CreateTaskInput {
        project_id: pid, area_id: None, title: "T".into(), description: None,
        status: "To Do".into(), priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
    }).await.unwrap();

    // Two legacy local attachments: one whose file exists, one long gone.
    let alive_path = dir.join("local_alive.txt");
    std::fs::write(&alive_path, b"local bytes").unwrap();
    let alive = ops::create_file_attachment(&db, ganban_core::models::CreateFileAttachmentInput {
        task_id: task.id, file_path: alive_path.to_string_lossy().into_owned(),
        file_name: "local_alive.txt".into(), file_type: Some("text/plain".into()),
        file_size: Some(11), notes: None, uploaded_by: None,
    }).await.unwrap();
    ops::create_file_attachment(&db, ganban_core::models::CreateFileAttachmentInput {
        task_id: task.id, file_path: dir.join("vanished.txt").to_string_lossy().into_owned(),
        file_name: "vanished.txt".into(), file_type: None, file_size: None, notes: None, uploaded_by: None,
    }).await.unwrap();

    // Batch push: the live one lands on the host, the vanished one is reported.
    let summary = storage::share_all_local(&db, &root, pid).await.unwrap();
    assert_eq!(summary.shared, 1);
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].0, "vanished.txt");
    assert!(storage::blob_path(&root, alive.id).exists(), "pushed bytes are on the host");
    assert_eq!(std::fs::read(storage::blob_path(&root, alive.id)).unwrap(), b"local bytes");
    assert!(alive_path.exists(), "the local original is untouched");

    // Allocation round trip: project file → task attachment → back.
    let pf = storage::store_project_file(&db, &root, pid, "doc.md", Some("text/markdown"), None, Some(1), b"doc body").await.unwrap();
    let used_before = storage::project_used(&db, pid).await.unwrap();

    let att = storage::assign_file_to_task(&db, &root, pf.id, task.id).await.unwrap();
    assert_eq!(att.task_id, task.id);
    assert!(att.is_shared && att.storage_size == 8);
    assert!(!storage::project_blob_path(&root, pf.id).exists(), "blob moved out of pf/");
    assert_eq!(std::fs::read(storage::blob_path(&root, att.id)).unwrap(), b"doc body");
    assert!(storage::list_project_files(&db, pid).await.unwrap().iter().all(|f| f.id != pf.id));
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), used_before, "same bytes, same usage");

    let back = storage::unassign_attachment(&db, &root, att.id).await.unwrap();
    assert_eq!(back.file_name, "doc.md");
    assert_eq!(std::fs::read(storage::project_blob_path(&root, back.id)).unwrap(), b"doc body");
    assert!(!storage::blob_path(&root, att.id).exists());
    assert_eq!(storage::project_used(&db, pid).await.unwrap(), used_before);

    // A file in a folder keeps its folder path both ways (a task's folder structure).
    let pf = storage::store_project_file(&db, &root, pid, "a.jpg", None, Some("Photos/2026/a.jpg"), Some(1), b"jpg").await.unwrap();
    let att = storage::assign_file_to_task(&db, &root, pf.id, task.id).await.unwrap();
    assert_eq!(att.rel_path.as_deref(), Some("Photos/2026/a.jpg"));
    let back_in_folder = storage::unassign_attachment(&db, &root, att.id).await.unwrap();
    assert_eq!(back_in_folder.rel_path.as_deref(), Some("Photos/2026/a.jpg"));
    assert!(storage::set_rel_path(&db, back.id, Some("../up")).await.is_err(), "paths are checked");

    // Guards: cross-project tasks refused; local attachments can't unassign.
    let other = ops::create_project(&db, CreateProjectInput { name: "Q".into(), description: None }).await.unwrap();
    let foreign_task = ops::create_task(&db, CreateTaskInput {
        project_id: other.id, area_id: None, title: "X".into(), description: None,
        status: "To Do".into(), priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
    }).await.unwrap();
    assert!(storage::assign_file_to_task(&db, &root, back.id, foreign_task.id).await.is_err());
    let local_again = ops::create_file_attachment(&db, ganban_core::models::CreateFileAttachmentInput {
        task_id: task.id, file_path: "/nowhere".into(), file_name: "x".into(),
        file_type: None, file_size: None, notes: None, uploaded_by: None,
    }).await.unwrap();
    assert!(storage::unassign_attachment(&db, &root, local_again.id).await.is_err());
}

#[tokio::test]
async fn folders_rename_and_move() {
    let dir = temp_dir("browse");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;

    // Sanitizer rejects, never rewrites.
    assert!(storage::clean_rel_path("docs/2026", true).is_ok());
    assert!(storage::clean_rel_path("../up", true).is_err(), "traversal");
    assert!(storage::clean_rel_path(".hidden", true).is_err(), "hidden segment");
    assert!(storage::clean_rel_path("a//b", true).is_err(), "empty segment");
    assert!(storage::clean_rel_path("a\\b", true).is_err(), "backslash");
    assert!(storage::clean_rel_path("dir/name.pdf", false).is_err(), "slash in a bare name");
    assert!(storage::clean_rel_path("", true).is_err());

    // Empty folders are first-class rows; creation is idempotent.
    storage::create_project_folder(&db, pid, "specs/2026").await.unwrap();
    storage::create_project_folder(&db, pid, "specs/2026").await.unwrap();
    assert_eq!(storage::list_project_folders(&db, pid).await.unwrap(), vec!["specs/2026".to_string()]);

    // Rename keeps rel_path's leaf in agreement with file_name.
    let f = storage::store_project_file(&db, &root, pid, "draft.md", None, Some("docs/draft.md"), Some(1), b"x")
        .await
        .unwrap();
    let f = storage::rename_project_file(&db, f.id, "final.md").await.unwrap();
    assert_eq!(f.file_name, "final.md");
    assert_eq!(f.rel_path.as_deref(), Some("docs/final.md"));
    assert!(storage::rename_project_file(&db, f.id, "into/dir.md").await.is_err(), "rename is not a move");

    // Move into a folder, then back to the root (rel_path = None).
    assert_eq!(storage::move_project_files(&db, pid, &[f.id], "specs/2026").await.unwrap(), 1);
    let listed = storage::list_project_files(&db, pid).await.unwrap();
    assert_eq!(listed[0].rel_path.as_deref(), Some("specs/2026/final.md"));
    assert_eq!(storage::move_project_files(&db, pid, &[f.id], "").await.unwrap(), 1);
    assert_eq!(storage::list_project_files(&db, pid).await.unwrap()[0].rel_path, None);

    // A foreign file id is an error, not a skip.
    let pid2 = ops::create_project(&db, CreateProjectInput { name: "Q".into(), description: None }).await.unwrap().id;
    assert!(storage::move_project_files(&db, pid2, &[f.id], "steal").await.is_err());
}

/// What a typed name may be: no slash in a file name, no control or invisible characters.
#[test]
fn names_refuse_slashes_controls_and_bidi() {
    assert_eq!(storage::check_name(" plan.pdf ", false).unwrap(), "plan.pdf");
    assert!(storage::check_name("a/b.pdf", false).is_err(), "slash in a file name");
    assert!(storage::check_name("a/b", true).is_ok(), "a folder path may nest");
    assert!(storage::check_name("bad\u{0007}.pdf", false).is_err(), "control character");
    assert!(storage::check_name("inv\u{202E}fdp.exe", false).is_err(), "bidi override");
    assert!(storage::check_name("zero\u{200B}width", true).is_err(), "zero-width");
}

/// A rename stays in its folder and refuses a name already there; a move refuses one too.
#[tokio::test]
async fn renames_and_moves_refuse_clashes() {
    let dir = temp_dir("clash");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let a = storage::store_project_file(&db, &root, pid, "a.md", None, Some("docs/a.md"), None, b"a").await.unwrap();
    let b = storage::store_project_file(&db, &root, pid, "b.md", None, Some("docs/b.md"), None, b"b").await.unwrap();
    let c = storage::store_project_file(&db, &root, pid, "a.md", None, None, None, b"c").await.unwrap();

    let err = storage::rename_project_file(&db, b.id, "a.md").await.unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err}");
    assert_eq!(storage::rename_project_file(&db, b.id, "b2.md").await.unwrap().rel_path.as_deref(), Some("docs/b2.md"));
    assert_eq!(storage::rename_project_file(&db, c.id, "c.md").await.unwrap().rel_path, None, "a loose file stays loose");
    storage::rename_project_file(&db, c.id, "a.md").await.unwrap();
    assert!(storage::move_project_files(&db, pid, &[c.id], "docs").await.is_err(), "docs/a.md is taken");
    assert_eq!(storage::move_project_files(&db, pid, &[a.id, b.id], "").await.unwrap_err().to_string().contains("already exists"), true);
    // A name that's a folder is taken too.
    storage::create_project_folder(&db, pid, "notes").await.unwrap();
    assert!(storage::rename_project_file(&db, c.id, "notes").await.is_err());
    // A file can't be a folder: not as a new folder, a move target or a folder's new home.
    assert!(storage::create_project_folder(&db, pid, "a.md").await.is_err(), "a.md is a file");
    assert!(storage::create_project_folder(&db, pid, "a.md/inner").await.is_err(), "below a file");
    assert!(storage::move_project_files(&db, pid, &[b.id], "a.md").await.is_err());
    let scope = storage::FolderScope::Project(pid);
    assert!(storage::rename_folder(&db, scope, "notes", "a.md/notes").await.is_err());
    assert!(storage::rename_folder(&db, scope, "a.md", "renamed").await.is_err(), "a loose file is no folder");
    // The same id twice is one move.
    assert_eq!(storage::move_project_files(&db, pid, &[b.id, b.id], "notes").await.unwrap(), 1);
}

/// Renaming a folder moves every file and sub-folder under it; it can't land on a taken
/// name or inside itself.
#[tokio::test]
async fn folder_renames_carry_their_files() {
    let dir = temp_dir("rf");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let root = dir.join("storage");
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let x = storage::store_project_file(&db, &root, pid, "x.md", None, Some("specs/x.md"), None, b"x").await.unwrap();
    let y = storage::store_project_file(&db, &root, pid, "y.md", None, Some("specs/2026/y.md"), None, b"y").await.unwrap();
    let z = storage::store_project_file(&db, &root, pid, "z.md", None, Some("specsheet/z.md"), None, b"z").await.unwrap();
    storage::create_project_folder(&db, pid, "specs/empty").await.unwrap();
    storage::create_project_folder(&db, pid, "taken").await.unwrap();
    let scope = storage::FolderScope::Project(pid);

    assert!(storage::rename_folder(&db, scope, "specs", "taken").await.is_err(), "taken");
    assert!(storage::rename_folder(&db, scope, "specs", "specs/inner").await.is_err(), "into itself");
    assert!(storage::rename_folder(&db, scope, "nope", "other").await.is_err(), "no such folder");
    assert_eq!(storage::rename_folder(&db, scope, "specs", "plans/specs").await.unwrap(), 2);

    let path = |id: i64, files: &[ganban_core::models::ProjectFile]| {
        files.iter().find(|f| f.id == id).unwrap().rel_path.clone().unwrap()
    };
    let files = storage::list_project_files(&db, pid).await.unwrap();
    assert_eq!(path(x.id, &files), "plans/specs/x.md");
    assert_eq!(path(y.id, &files), "plans/specs/2026/y.md");
    assert_eq!(path(z.id, &files), "specsheet/z.md", "a sibling with the same prefix stays put");
    let folders = storage::list_project_folders(&db, pid).await.unwrap();
    assert!(folders.contains(&"plans/specs/empty".to_string()), "{folders:?}");
    assert!(!folders.iter().any(|f| f.starts_with("specs")), "{folders:?}");

    // Only an empty folder can be removed; its empty sub-folders go with it.
    assert!(storage::delete_empty_folder(&db, scope, "plans/specs").await.is_err());
    storage::delete_empty_folder(&db, scope, "plans/specs/empty").await.unwrap();
    assert!(!storage::list_project_folders(&db, pid).await.unwrap().contains(&"plans/specs/empty".to_string()));
}

/// A task's attachments rename, move and fold into folders of their own, empty ones included.
#[tokio::test]
async fn task_files_have_names_and_folders() {
    let dir = temp_dir("tf");
    let db = init_db_role(&dir.join("t.db"), Role::Server).await.unwrap();
    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
    let task = |title: &str| {
        let db = db.clone();
        let title = title.to_string();
        async move {
            ops::create_task(&db, CreateTaskInput {
                project_id: pid, area_id: None, title, description: None,
                status: "To Do".into(), priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
            }).await.unwrap().id
        }
    };
    let (t, other) = (task("T").await, task("U").await);
    let a = storage::create_shared_attachment(&db, t, "a.jpg", None, None).await.unwrap();
    let b = storage::create_shared_attachment(&db, t, "b.jpg", None, None).await.unwrap();
    let elsewhere = storage::create_shared_attachment(&db, other, "c.jpg", None, None).await.unwrap();

    assert!(storage::rename_attachment(&db, b.id, "a.jpg").await.is_err(), "clash on the task");
    assert_eq!(storage::rename_attachment(&db, b.id, "c.jpg").await.unwrap().file_name, "c.jpg", "another task's name is free");

    storage::create_task_folder(&db, t, "Photos").await.unwrap();
    assert_eq!(storage::list_task_folders(&db, t).await.unwrap(), vec!["Photos".to_string()]);
    assert!(storage::list_task_folders(&db, other).await.unwrap().is_empty());
    assert_eq!(storage::move_attachments(&db, t, &[a.id, b.id], "Photos").await.unwrap(), 2);
    assert!(storage::move_attachments(&db, t, &[elsewhere.id], "Photos").await.is_err(), "not this task's");

    assert_eq!(storage::rename_folder(&db, storage::FolderScope::Task(t), "Photos", "Site/Photos").await.unwrap(), 2);
    let renamed = storage::rename_attachment(&db, a.id, "front.jpg").await.unwrap();
    assert_eq!(renamed.rel_path.as_deref(), Some("Site/Photos/front.jpg"));
    let listed = storage::list_project_attachments(&db, pid).await.unwrap();
    assert_eq!(listed.iter().find(|x| x.id == a.id).unwrap().rel_path.as_deref(), Some("Site/Photos/front.jpg"));
}
