//! Server-side storage for *shared* file attachments.
//!
//! A *local* attachment is just a path on the host (free, desktop-only — the
//! original behaviour). A *shared* attachment additionally keeps a copy of its
//! bytes under the storage root: it counts against its project's allocation and
//! is downloadable by any member over the daemon.
//!
//! This module owns the quota arithmetic and the attachment ⇄ blob bookkeeping;
//! the actual byte streaming for uploads lives in the daemon (it has the HTTP
//! body), which calls `create_shared_attachment` + `set_storage_size` around it.

use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::models::{EventAttachment, FileAttachment, ProjectAttachment, ProjectFile};
use crate::{AppError, Db, Result};

/// Default per-project allocation for newly created projects (256 MB).
pub const DEFAULT_QUOTA_BYTES: i64 = 256 * 1024 * 1024;

/// Where the daemon hosts shared file bytes. Cloneable so it can live in axum
/// `Extension` / Tauri managed state.
#[derive(Clone, Debug)]
pub struct StorageRoot(pub PathBuf);

/// Filesystem location of a shared attachment's bytes: `<root>/<attachment_id>`.
pub fn blob_path(root: &Path, attachment_id: i64) -> PathBuf {
    root.join(attachment_id.to_string())
}

/// Which store a file's bytes live in on the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlobKind {
    /// A task attachment: `<root>/<id>`.
    Attachment,
    /// A project file: `<root>/pf/<id>`.
    Project,
}

/// Where "Show in folder" should go for a file, on THIS machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Location {
    /// The file itself: reveal it.
    Found(PathBuf),
    /// A local-only file that isn't at its saved path: the nearest folder of that path
    /// is the best help (it may have moved).
    SavedPathMissing(PathBuf),
    /// Nothing of it here. A file with a host copy is fetched and opened instead.
    Nowhere,
}

/// Where a file can be found on THIS machine, for "Show in folder".
///
/// `saved_path` is what the attacher's machine recorded (`file_path`): empty for files
/// uploaded to the host, and another machine's path for files shared from someone else's
/// desktop. So the saved path wins only when it exists here; otherwise a shared file is
/// found in the blob store, which is only meaningful when this machine is the host
/// (`host_root` is `None` on a client: the same id in a local store would be an unrelated
/// file). A shared file found nowhere is `Nowhere`, never its saved path's folder: the
/// host copy is the file, so the client opens that.
pub fn locate_on_this_machine(
    host_root: Option<&Path>,
    kind: BlobKind,
    id: i64,
    shared: bool,
    saved_path: Option<&Path>,
) -> Location {
    let saved = saved_path.filter(|p| !p.as_os_str().is_empty());
    if let Some(p) = saved.filter(|p| p.is_file()) {
        return Location::Found(p.to_path_buf());
    }
    let has_host_copy = shared || kind == BlobKind::Project;
    if let Some(root) = host_root.filter(|_| has_host_copy) {
        let blob = match kind {
            BlobKind::Attachment => blob_path(root, id),
            BlobKind::Project => project_blob_path(root, id),
        };
        if blob.is_file() {
            return Location::Found(blob);
        }
    }
    match saved {
        Some(p) if !has_host_copy => Location::SavedPathMissing(p.to_path_buf()),
        _ => Location::Nowhere,
    }
}

/// The project a task belongs to.
pub async fn task_project(db: &Db, task_id: i64) -> Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("task".into()))
}

/// The project an attachment belongs to (via its task).
pub async fn attachment_project(db: &Db, attachment_id: i64) -> Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT t.project_id FROM file_attachments fa JOIN tasks t ON t.id = fa.task_id WHERE fa.id = ?",
    )
    .bind(attachment_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("attachment".into()))
}

/// A project's storage quota (bytes).
pub async fn project_quota(db: &Db, project_id: i64) -> Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT storage_quota_bytes FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("project".into()))
}

/// Bytes currently used by a project: shared task attachments + project files.
/// (A dynamic figure — the quota is a ceiling, never a reservation.)
pub async fn project_used(db: &Db, project_id: i64) -> Result<i64> {
    let attachments: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(fa.storage_size), 0)
        FROM file_attachments fa
        JOIN tasks t ON t.id = fa.task_id
        WHERE t.project_id = ? AND fa.is_shared = 1
        "#,
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let project_files: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes), 0) FROM project_files WHERE project_id = ?")
        .bind(project_id)
        .fetch_one(db)
        .await?;
    Ok(attachments + project_files)
}

/// Every task attachment across a project, newest first, each tagged with its
/// task title and whether a host copy exists. Powers the project's central
/// file view.
pub async fn list_project_attachments(db: &Db, project_id: i64) -> Result<Vec<ProjectAttachment>> {
    // ALL task attachments, not just host-stored ones: legacy local-path
    // attachments (pre-Files-page) would otherwise be invisible here, forcing
    // task-by-task cleanup. Local rows report their original file size.
    let rows = sqlx::query_as::<_, ProjectAttachment>(
        r#"
        SELECT fa.id, fa.task_id, t.title AS task_title, fa.file_name, fa.file_type,
               CASE WHEN fa.is_shared = 1 THEN fa.storage_size ELSE COALESCE(fa.file_size, 0) END AS storage_size,
               fa.is_shared, fa.file_path, fa.created_at, fa.ai_included, fa.rel_path, fa.uploaded_by
        FROM file_attachments fa
        JOIN tasks t ON t.id = fa.task_id
        WHERE t.project_id = ?
        ORDER BY fa.created_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Set a project's allocation. Refuses to drop below current usage.
pub async fn set_project_quota(db: &Db, project_id: i64, bytes: i64) -> Result<()> {
    if bytes < 0 {
        return Err(AppError::InvalidInput("quota must be >= 0".into()));
    }
    let used = project_used(db, project_id).await?;
    if bytes < used {
        return Err(AppError::InvalidInput(format!(
            "quota ({bytes} bytes) is below current usage ({used} bytes) — remove shared files first"
        )));
    }
    sqlx::query("UPDATE projects SET storage_quota_bytes = ?, updated_at = ? WHERE id = ?")
        .bind(bytes)
        .bind(Utc::now())
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Reject if storing `additional` more bytes would overflow the project's quota.
pub async fn check_quota(db: &Db, project_id: i64, additional: i64) -> Result<()> {
    let quota = project_quota(db, project_id).await?;
    let used = project_used(db, project_id).await?;
    if used + additional > quota {
        return Err(AppError::InvalidInput(format!(
            "storage quota exceeded: {used} + {additional} > {quota} bytes for this project"
        )));
    }
    Ok(())
}

async fn get_attachment(db: &Db, id: i64) -> Result<FileAttachment> {
    sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("attachment".into()))
}

/// Create a placeholder shared attachment (size 0) so the caller has an id to
/// stream bytes into; finalize with `set_storage_size`.
pub async fn create_shared_attachment(
    db: &Db,
    task_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    uploaded_by: Option<i64>,
) -> Result<FileAttachment> {
    let res = sqlx::query(
        r#"
        INSERT INTO file_attachments
            (task_id, file_path, file_name, file_type, file_size, notes, uploaded_by, created_at, is_valid, is_shared, storage_size)
        VALUES (?, '', ?, ?, NULL, NULL, ?, ?, 1, 1, 0)
        "#,
    )
    .bind(task_id)
    .bind(file_name)
    .bind(file_type)
    .bind(uploaded_by)
    .bind(Utc::now())
    .execute(db)
    .await?;
    get_attachment(db, res.last_insert_rowid()).await
}

/// Finalize an uploaded shared attachment with the bytes actually stored.
pub async fn set_storage_size(db: &Db, attachment_id: i64, size: i64) -> Result<FileAttachment> {
    sqlx::query("UPDATE file_attachments SET storage_size = ?, file_size = ?, is_shared = 1 WHERE id = ?")
        .bind(size)
        .bind(size)
        .bind(attachment_id)
        .execute(db)
        .await?;
    get_attachment(db, attachment_id).await
}

/// Set where an attachment sits in its task's folder structure (file name included), or
/// clear it with `None`. The path is checked like a project file's.
pub async fn set_rel_path(db: &Db, attachment_id: i64, rel_path: Option<&str>) -> Result<FileAttachment> {
    let rel_path = rel_path.map(|p| clean_rel_path(p, true)).transpose()?;
    sqlx::query("UPDATE file_attachments SET rel_path = ? WHERE id = ?")
        .bind(rel_path)
        .bind(attachment_id)
        .execute(db)
        .await?;
    get_attachment(db, attachment_id).await
}

/// Promote a *local* attachment to shared: copy its host file into the project
/// allocation (quota-checked). Desktop-only — needs the local path to read.
pub async fn share_local_file(db: &Db, root: &Path, attachment_id: i64) -> Result<FileAttachment> {
    let att = get_attachment(db, attachment_id).await?;
    if att.is_shared {
        return Ok(att);
    }
    let src = PathBuf::from(&att.file_path);
    let meta = std::fs::metadata(&src)
        .map_err(|_| AppError::InvalidInput("the local file no longer exists on this machine".into()))?;
    let size = meta.len() as i64;
    let project_id = task_project(db, att.task_id).await?;
    check_quota(db, project_id, size).await?;
    std::fs::create_dir_all(root)?;
    std::fs::copy(&src, blob_path(root, attachment_id))?;
    set_storage_size(db, attachment_id, size).await
}

/// Summary of a batch push of local attachments to the host.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShareLocalSummary {
    pub shared: u64,
    pub skipped_shared: u64,
    /// file name → why it couldn't be pushed (missing on disk, over quota…).
    pub failures: Vec<(String, String)>,
}

/// Push every local-path attachment of a project to the host in one sweep —
/// the batch follow-up to the Files audit. Per-file failures (vanished local
/// file, quota) are collected, not fatal; everything pushable is pushed.
pub async fn share_all_local(db: &Db, root: &Path, project_id: i64) -> Result<ShareLocalSummary> {
    let locals: Vec<(i64, String)> = sqlx::query_as(
        "SELECT fa.id, fa.file_name FROM file_attachments fa JOIN tasks t ON t.id = fa.task_id \
         WHERE t.project_id = ? AND fa.is_shared = 0",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let mut out = ShareLocalSummary { shared: 0, skipped_shared: 0, failures: Vec::new() };
    for (id, name) in locals {
        match share_local_file(db, root, id).await {
            Ok(_) => out.shared += 1,
            Err(e) => out.failures.push((name, e.to_string())),
        }
    }
    Ok(out)
}

/// Allocate a project file to a task: the row converts into a SHARED task
/// attachment and the blob moves with it. Same project, same bytes, same
/// quota usage — only the file's home changes. Returns the new attachment.
pub async fn assign_file_to_task(db: &Db, root: &Path, project_file_id: i64, task_id: i64) -> Result<FileAttachment> {
    let f = get_project_file(db, project_file_id).await?;
    if task_project(db, task_id).await? != f.project_id {
        return Err(AppError::InvalidInput("that task is not in this project".into()));
    }
    let src = project_blob_path(root, project_file_id);
    if !src.exists() {
        return Err(AppError::InvalidInput("this file's bytes are missing — run the Files audit".into()));
    }
    let att = create_shared_attachment(db, task_id, &f.file_name, f.file_type.as_deref(), f.uploaded_by).await?;
    std::fs::create_dir_all(root)?;
    if let Err(e) = std::fs::rename(&src, blob_path(root, att.id)) {
        // Cross-device fallback (and roll back the placeholder row on failure).
        if std::fs::copy(&src, blob_path(root, att.id)).is_err() {
            let _ = sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(att.id).execute(db).await;
            return Err(AppError::from(e));
        }
        let _ = std::fs::remove_file(&src);
    }
    set_storage_size(db, att.id, f.size_bytes).await?;
    // The file keeps its place in or out of the AI overview.
    sqlx::query("UPDATE file_attachments SET ai_included = (SELECT ai_included FROM project_files WHERE id = ?) WHERE id = ?")
        .bind(project_file_id)
        .bind(att.id)
        .execute(db)
        .await?;
    let att = set_rel_path(db, att.id, f.rel_path.as_deref()).await?;
    sqlx::query("DELETE FROM project_files WHERE id = ?").bind(project_file_id).execute(db).await?;
    Ok(att)
}

/// The reverse: detach a SHARED attachment from its task into a plain project
/// file (blob moves back to pf/). Local-only attachments can't convert — they
/// have no host bytes to move.
pub async fn unassign_attachment(db: &Db, root: &Path, attachment_id: i64) -> Result<ProjectFile> {
    let att = get_attachment(db, attachment_id).await?;
    if !att.is_shared {
        return Err(AppError::InvalidInput("this attachment has no host copy — push it to the host first".into()));
    }
    let project_id = task_project(db, att.task_id).await?;
    let src = blob_path(root, attachment_id);
    if !src.exists() {
        return Err(AppError::InvalidInput("this file's bytes are missing — run the Files audit".into()));
    }
    let res = sqlx::query(
        "INSERT INTO project_files (project_id, file_name, file_type, rel_path, size_bytes, uploaded_by, created_at, ai_included) \
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT ai_included FROM file_attachments WHERE id = ?))",
    )
    .bind(project_id)
    .bind(&att.file_name)
    .bind(&att.file_type)
    .bind(&att.rel_path)
    .bind(att.storage_size)
    .bind(att.uploaded_by)
    .bind(Utc::now())
    .bind(attachment_id)
    .execute(db)
    .await?;
    let new_id = res.last_insert_rowid();
    let dir = root.join("pf");
    std::fs::create_dir_all(&dir)?;
    if let Err(e) = std::fs::rename(&src, project_blob_path(root, new_id)) {
        if std::fs::copy(&src, project_blob_path(root, new_id)).is_err() {
            let _ = sqlx::query("DELETE FROM project_files WHERE id = ?").bind(new_id).execute(db).await;
            return Err(AppError::from(e));
        }
        let _ = std::fs::remove_file(&src);
    }
    sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(attachment_id).execute(db).await?;
    get_project_file(db, new_id).await
}

/// Stop sharing: delete the stored copy and free the quota. Any local file is
/// untouched, so a desktop attachment simply reverts to local-only.
pub async fn unshare_file(db: &Db, root: &Path, attachment_id: i64) -> Result<FileAttachment> {
    let _ = std::fs::remove_file(blob_path(root, attachment_id));
    sqlx::query("UPDATE file_attachments SET is_shared = 0, storage_size = 0 WHERE id = ?")
        .bind(attachment_id)
        .execute(db)
        .await?;
    get_attachment(db, attachment_id).await
}

/// Resolve a shared attachment for download: (file_name, blob path) if it is
/// shared and the blob is present.
pub async fn shared_for_download(db: &Db, root: &Path, attachment_id: i64) -> Result<(String, Option<String>, PathBuf)> {
    let att = get_attachment(db, attachment_id).await?;
    if !att.is_shared {
        return Err(AppError::NotFound("attachment is not shared".into()));
    }
    let path = blob_path(root, attachment_id);
    if !path.exists() {
        return Err(AppError::NotFound("shared file is missing".into()));
    }
    Ok((att.file_name, att.file_type, path))
}

/// Best-effort removal of a stored blob — call when an attachment is deleted.
pub fn remove_blob(root: &Path, attachment_id: i64) {
    let _ = std::fs::remove_file(blob_path(root, attachment_id));
}

/// Store `bytes` as a new shared attachment on `task_id` (quota-checked). Used by
/// the desktop's paste-image path; the daemon's streaming upload has its own.
pub async fn store_shared_bytes(
    db: &Db,
    root: &Path,
    task_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    uploaded_by: Option<i64>,
    bytes: &[u8],
) -> Result<FileAttachment> {
    let project_id = task_project(db, task_id).await?;
    check_quota(db, project_id, bytes.len() as i64).await?;
    let att = create_shared_attachment(db, task_id, file_name, file_type, uploaded_by).await?;
    std::fs::create_dir_all(root)?;
    if let Err(e) = std::fs::write(blob_path(root, att.id), bytes) {
        let _ = sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(att.id).execute(db).await;
        return Err(AppError::from(e));
    }
    let updated = set_storage_size(db, att.id, bytes.len() as i64).await?;
    // Close the same TOCTOU window the daemon upload guards against.
    if project_used(db, project_id).await? > project_quota(db, project_id).await? {
        remove_blob(root, att.id);
        let _ = sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(att.id).execute(db).await;
        return Err(AppError::InvalidInput("storage quota exceeded for this project".into()));
    }
    Ok(updated)
}

/// Move a finished upload into place. The daemon spools uploads under the
/// storage root, so this is normally a rename (instant, no copy); across
/// devices it falls back to copy + remove.
pub async fn move_into_place(src: &Path, dest: &Path) -> std::io::Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if tokio::fs::rename(src, dest).await.is_ok() {
        return Ok(());
    }
    tokio::fs::copy(src, dest).await?;
    let _ = tokio::fs::remove_file(src).await;
    Ok(())
}

/// Store an upload the daemon streamed to `src` (its spool file) as a new
/// shared attachment on `task_id` — quota-checked, moved (not copied, not
/// held in memory) into place, with the same TOCTOU re-check as the byte path.
pub async fn store_shared_from_path(
    db: &Db,
    root: &Path,
    task_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    uploaded_by: Option<i64>,
    src: &Path,
    size: i64,
) -> Result<FileAttachment> {
    let project_id = task_project(db, task_id).await?;
    check_quota(db, project_id, size).await?;
    let att = create_shared_attachment(db, task_id, file_name, file_type, uploaded_by).await?;
    if let Err(e) = move_into_place(src, &blob_path(root, att.id)).await {
        let _ = sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(att.id).execute(db).await;
        return Err(AppError::from(e));
    }
    let updated = set_storage_size(db, att.id, size).await?;
    if project_used(db, project_id).await? > project_quota(db, project_id).await? {
        remove_blob(root, att.id);
        let _ = sqlx::query("DELETE FROM file_attachments WHERE id = ?").bind(att.id).execute(db).await;
        return Err(AppError::InvalidInput(
            "storage quota exceeded — another upload filled the allocation".into(),
        ));
    }
    Ok(updated)
}

/// Read a shared attachment's mime + bytes (for rendering it locally on desktop).
pub async fn read_attachment(db: &Db, root: &Path, attachment_id: i64) -> Result<(String, Vec<u8>)> {
    let att = get_attachment(db, attachment_id).await?;
    let mime = att
        .file_type
        .filter(|t| t.contains('/'))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = std::fs::read(blob_path(root, attachment_id)).map_err(|_| AppError::NotFound("file".into()))?;
    Ok((mime, bytes))
}

// --------------------------------------------------------------------------- //
// Project-level files (a project "drop zone"). Stored on the host under
// <root>/pf/<id> (a distinct path so ids never collide with task-attachment
// blobs). Counts against the same per-project quota.
// --------------------------------------------------------------------------- //

/// Filesystem location of a project file's bytes: `<root>/pf/<id>`.
pub fn project_blob_path(root: &Path, file_id: i64) -> PathBuf {
    root.join("pf").join(file_id.to_string())
}

async fn get_project_file(db: &Db, id: i64) -> Result<ProjectFile> {
    sqlx::query_as::<_, ProjectFile>("SELECT * FROM project_files WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("project file".into()))
}

/// The project a file belongs to (for membership scope checks at the edge).
pub async fn project_file_project(db: &Db, id: i64) -> Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT project_id FROM project_files WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("project file".into()))
}

/// Store `bytes` as a project-level file (quota-checked). `rel_path` preserves
/// folder structure for folder uploads (else None / the bare name).
async fn insert_project_file_row(
    db: &Db,
    project_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    rel_path: Option<&str>,
    uploaded_by: Option<i64>,
    size: i64,
) -> Result<i64> {
    let res = sqlx::query(
        "INSERT INTO project_files (project_id, file_name, file_type, rel_path, size_bytes, uploaded_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(file_name)
    .bind(file_type)
    .bind(rel_path)
    .bind(size)
    .bind(uploaded_by)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Store an upload the daemon streamed to `src` (its spool file) as a project
/// file — quota-checked, moved into place, TOCTOU re-checked.
pub async fn store_project_file_from_path(
    db: &Db,
    root: &Path,
    project_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    rel_path: Option<&str>,
    uploaded_by: Option<i64>,
    src: &Path,
    size: i64,
) -> Result<ProjectFile> {
    check_quota(db, project_id, size).await?;
    let id = insert_project_file_row(db, project_id, file_name, file_type, rel_path, uploaded_by, size).await?;
    if let Err(e) = move_into_place(src, &project_blob_path(root, id)).await {
        let _ = sqlx::query("DELETE FROM project_files WHERE id = ?").bind(id).execute(db).await;
        return Err(AppError::from(e));
    }
    if project_used(db, project_id).await? > project_quota(db, project_id).await? {
        let _ = tokio::fs::remove_file(project_blob_path(root, id)).await;
        let _ = sqlx::query("DELETE FROM project_files WHERE id = ?").bind(id).execute(db).await;
        return Err(AppError::InvalidInput("storage quota exceeded for this project".into()));
    }
    get_project_file(db, id).await
}

pub async fn store_project_file(
    db: &Db,
    root: &Path,
    project_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    rel_path: Option<&str>,
    uploaded_by: Option<i64>,
    bytes: &[u8],
) -> Result<ProjectFile> {
    check_quota(db, project_id, bytes.len() as i64).await?;
    let res = sqlx::query(
        "INSERT INTO project_files (project_id, file_name, file_type, rel_path, size_bytes, uploaded_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(file_name)
    .bind(file_type)
    .bind(rel_path)
    .bind(bytes.len() as i64)
    .bind(uploaded_by)
    .bind(Utc::now())
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    let dir = root.join("pf");
    std::fs::create_dir_all(&dir)?;
    if let Err(e) = std::fs::write(project_blob_path(root, id), bytes) {
        let _ = sqlx::query("DELETE FROM project_files WHERE id = ?").bind(id).execute(db).await;
        return Err(AppError::from(e));
    }
    // Close the TOCTOU window: roll back if the write tipped us over the cap.
    if project_used(db, project_id).await? > project_quota(db, project_id).await? {
        let _ = std::fs::remove_file(project_blob_path(root, id));
        let _ = sqlx::query("DELETE FROM project_files WHERE id = ?").bind(id).execute(db).await;
        return Err(AppError::InvalidInput("storage quota exceeded for this project".into()));
    }
    get_project_file(db, id).await
}

/// One row whose bytes are gone from disk — the DB says the file exists, the
/// filesystem disagrees (moved storage, hand-deleted blob, failed write…).
/// Found by the Files-tab audit.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MissingFile {
    pub id: i64,
    /// "project" (a project_files row) | "attachment" (a shared task attachment).
    pub kind: &'static str,
    pub file_name: String,
    pub size_bytes: i64,
}

/// Integrity audit: every host-stored file of a project whose blob is missing
/// on disk — both project files (`pf/<id>`) and shared task attachments
/// (`<root>/<id>`). Local-path-only attachments are not host-stored and are
/// not audited.
pub async fn audit_project_files(db: &Db, root: &Path, project_id: i64) -> Result<Vec<MissingFile>> {
    let mut missing = Vec::new();
    let pf: Vec<(i64, String, i64)> =
        sqlx::query_as("SELECT id, file_name, size_bytes FROM project_files WHERE project_id = ?")
            .bind(project_id)
            .fetch_all(db)
            .await?;
    for (id, file_name, size_bytes) in pf {
        if !project_blob_path(root, id).exists() {
            missing.push(MissingFile { id, kind: "project", file_name, size_bytes });
        }
    }
    let at: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT fa.id, fa.file_name, fa.storage_size FROM file_attachments fa \
         JOIN tasks t ON t.id = fa.task_id WHERE t.project_id = ? AND fa.is_shared = 1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    for (id, file_name, size_bytes) in at {
        if !blob_path(root, id).exists() {
            missing.push(MissingFile { id, kind: "attachment", file_name, size_bytes });
        }
    }
    Ok(missing)
}

/// Re-attach bytes to an EXISTING project-file row: the id — and therefore
/// every reference to the file — is preserved; only the blob (+ recorded size
/// and type) changes. Quota-checked net of the row's stale recorded size.
pub async fn restore_project_file(
    db: &Db,
    root: &Path,
    id: i64,
    file_type: Option<&str>,
    bytes: &[u8],
) -> Result<ProjectFile> {
    let f = get_project_file(db, id).await?;
    let used = project_used(db, f.project_id).await?;
    if used - f.size_bytes + bytes.len() as i64 > project_quota(db, f.project_id).await? {
        return Err(AppError::InvalidInput("storage quota exceeded for this project".into()));
    }
    std::fs::create_dir_all(root.join("pf"))?;
    std::fs::write(project_blob_path(root, id), bytes)?;
    sqlx::query("UPDATE project_files SET size_bytes = ?, file_type = COALESCE(?, file_type) WHERE id = ?")
        .bind(bytes.len() as i64)
        .bind(file_type)
        .bind(id)
        .execute(db)
        .await?;
    get_project_file(db, id).await
}

/// Re-attach bytes to an existing shared task attachment (same id, same task
/// link). Quota-checked net of the stale recorded size.
pub async fn restore_attachment(db: &Db, root: &Path, id: i64, bytes: &[u8]) -> Result<FileAttachment> {
    let project_id = attachment_project(db, id).await?;
    let stale: i64 = sqlx::query_scalar("SELECT storage_size FROM file_attachments WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("attachment".into()))?;
    let used = project_used(db, project_id).await?;
    if used - stale + bytes.len() as i64 > project_quota(db, project_id).await? {
        return Err(AppError::InvalidInput("storage quota exceeded for this project".into()));
    }
    std::fs::create_dir_all(root)?;
    std::fs::write(blob_path(root, id), bytes)?;
    set_storage_size(db, id, bytes.len() as i64).await
}

/// Delete a task attachment record (and its host blob, if any). The uploader's
/// original local file — if one exists — is untouched; only the record and the
/// host copy go.
pub async fn delete_attachment(db: &Db, root: &Path, attachment_id: i64) -> Result<()> {
    let _ = std::fs::remove_file(blob_path(root, attachment_id));
    sqlx::query("DELETE FROM file_attachments WHERE id = ?")
        .bind(attachment_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Drop every missing file the audit finds: the records are deleted outright —
/// for both kinds — since they point at bytes that no longer exist. (An
/// uploader's local original, if any, is a file on their disk and survives;
/// only the dead record goes.) Returns how many entries were cleared.
pub async fn clear_missing_files(db: &Db, root: &Path, project_id: i64) -> Result<u64> {
    let missing = audit_project_files(db, root, project_id).await?;
    let mut cleared = 0;
    for m in missing {
        match m.kind {
            "project" => delete_project_file(db, root, m.id).await?,
            _ => delete_attachment(db, root, m.id).await?,
        }
        cleared += 1;
    }
    Ok(cleared)
}

/// Project files, most-recent first.
pub async fn list_project_files(db: &Db, project_id: i64) -> Result<Vec<ProjectFile>> {
    Ok(sqlx::query_as::<_, ProjectFile>("SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC, id DESC")
        .bind(project_id)
        .fetch_all(db)
        .await?)
}

// ── Folders (file-browser metadata) ─────────────────────────────────────────
// Blobs are stored flat (pf/<id>); folder structure is rel_path metadata.
// project_folders rows exist so EMPTY folders survive — folders with files in
// them are derived from rel_paths client-side either way.

/// Validate a folder path ("a/b/c") or a bare file name (`allow_slash =
/// false`). Rejects, never rewrites: traversal, hidden segments, backslashes
/// and oversized names are errors, not silent fixes.
pub fn clean_rel_path(raw: &str, allow_slash: bool) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 512 || raw.contains('\\') {
        return Err(AppError::InvalidInput("bad path".into()));
    }
    if !allow_slash && raw.contains('/') {
        return Err(AppError::InvalidInput("name cannot contain '/'".into()));
    }
    for seg in raw.split('/') {
        if seg.is_empty() || seg.starts_with('.') || seg.len() > 255 {
            return Err(AppError::InvalidInput(format!("path segment '{seg}' is not allowed")));
        }
    }
    Ok(raw.to_string())
}

/// Bidi overrides and zero-width characters: they can disguise a name ("gpj.exe" shown
/// as "exe.jpg"). The share door strips them from download names; renames refuse them.
pub fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// A name someone typed for a file or folder (`allow_slash` for a folder path): the
/// [`clean_rel_path`] rules plus no control or invisible characters. Rejects, never
/// rewrites. Uploads keep the looser [`clean_rel_path`]; renames and new folders use this.
pub fn check_name(raw: &str, allow_slash: bool) -> Result<String> {
    if raw.chars().any(|c| c.is_control() || is_invisible(c)) {
        return Err(AppError::InvalidInput("names cannot contain control or invisible characters".into()));
    }
    clean_rel_path(raw, allow_slash)
}

/// The folder part of a stored path ("a/b/x.pdf" → "a/b"; a loose file → "").
fn dir_of(rel_path: Option<&str>) -> &str {
    rel_path.and_then(|r| r.rsplit_once('/')).map(|(d, _)| d).unwrap_or("")
}

/// `dir/name`, or `name` at the root.
fn join_dir(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// `path` with its leading `from` folder swapped for `to`, if it lies under `from`.
fn reprefix(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        Some(to.to_string())
    } else {
        path.strip_prefix(from).and_then(|rest| rest.strip_prefix('/')).map(|rest| format!("{to}/{rest}"))
    }
}

/// Create an explicit (possibly empty) folder. Idempotent.
pub async fn create_project_folder(db: &Db, project_id: i64, rel_path: &str) -> Result<String> {
    let path = check_name(rel_path, true)?;
    let (files, _) = project_paths(db, project_id).await?;
    refuse_folder_over_file(&files, &path)?;
    sqlx::query("INSERT OR IGNORE INTO project_folders (project_id, rel_path) VALUES (?, ?)")
        .bind(project_id)
        .bind(&path)
        .execute(db)
        .await?;
    Ok(path)
}

/// Explicit folders of a project (derived-from-files folders are the client's job).
pub async fn list_project_folders(db: &Db, project_id: i64) -> Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT rel_path FROM project_folders WHERE project_id = ? ORDER BY rel_path")
            .bind(project_id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Two paths name the same place, ignoring case: "Report.pdf" and "report.pdf" can't sit
/// side by side (a case-insensitive disk, macOS's or Windows', couldn't hold both).
fn same_path(a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase()
}

/// `path` lies inside the folder `dir`, ignoring case.
fn inside(path: &str, dir: &str) -> bool {
    path.to_lowercase().starts_with(&format!("{}/", dir.to_lowercase()))
}

/// A new folder can't sit where a file is, or below one.
fn refuse_folder_over_file(files: &[(i64, String)], path: &str) -> Result<()> {
    if files.iter().any(|(_, p)| same_path(p, path)) {
        let leaf = path.rsplit('/').next().unwrap_or(path);
        return Err(AppError::InvalidInput(format!("'{leaf}' is already a file there")));
    }
    refuse_file_above(files, path, &[])
}

/// Every path in a project's file tree (files by their stored path, explicit folders) — what a
/// new name must not clash with.
async fn project_paths(db: &Db, project_id: i64) -> Result<(Vec<(i64, String)>, Vec<String>)> {
    let files: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, COALESCE(NULLIF(rel_path, ''), file_name) FROM project_files WHERE project_id = ?")
            .bind(project_id)
            .fetch_all(db)
            .await?;
    Ok((files, list_project_folders(db, project_id).await?))
}

/// Every path in a task's file tree: its attachments and its explicit folders.
async fn task_paths(db: &Db, task_id: i64) -> Result<(Vec<(i64, String)>, Vec<String>)> {
    let files: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, COALESCE(NULLIF(rel_path, ''), file_name) FROM file_attachments WHERE task_id = ?")
            .bind(task_id)
            .fetch_all(db)
            .await?;
    Ok((files, list_task_folders(db, task_id).await?))
}

/// Refuse a folder path that runs through a file ("deck.pdf/x" when deck.pdf is a file).
fn refuse_file_above(files: &[(i64, String)], path: &str, except: &[i64]) -> Result<()> {
    let mut at = path;
    while let Some((up, _)) = at.rsplit_once('/') {
        if files.iter().any(|(id, p)| same_path(p, up) && !except.contains(id)) {
            return Err(AppError::InvalidInput(format!("'{up}' is a file, not a folder")));
        }
        at = up;
    }
    Ok(())
}

/// Refuse `path` when another file (not `except`) or a folder already sits there, or a file
/// sits where one of its folders would be.
fn refuse_clash(files: &[(i64, String)], folders: &[String], path: &str, except: &[i64]) -> Result<()> {
    refuse_file_above(files, path, except)?;
    let taken_by_file = files.iter().any(|(id, p)| same_path(p, path) && !except.contains(id));
    let taken_by_folder = folders.iter().any(|f| same_path(f, path))
        || files.iter().any(|(id, p)| !except.contains(id) && inside(p, path));
    if taken_by_file || taken_by_folder {
        let leaf = path.rsplit('/').next().unwrap_or(path);
        let dir = dir_of(Some(path));
        let place = if dir.is_empty() { "this folder".to_string() } else { format!("'{dir}'") };
        return Err(AppError::InvalidInput(format!("'{leaf}' already exists in {place}")));
    }
    Ok(())
}

/// Rename a project file. Updates file_name AND the rel_path leaf (they must
/// agree — rel_path is "dir/sub/<file_name>"). A name already taken in the same
/// folder is refused.
pub async fn rename_project_file(db: &Db, id: i64, new_name: &str) -> Result<ProjectFile> {
    let name = check_name(new_name, false)?;
    let f = get_project_file(db, id).await?;
    if name == f.file_name {
        return Ok(f);
    }
    let dir = dir_of(f.rel_path.as_deref());
    let (files, folders) = project_paths(db, f.project_id).await?;
    refuse_clash(&files, &folders, &join_dir(dir, &name), &[id])?;
    let rel = f.rel_path.as_ref().map(|_| join_dir(dir, &name));
    sqlx::query("UPDATE project_files SET file_name = ?, rel_path = ? WHERE id = ?")
        .bind(&name)
        .bind(&rel)
        .bind(id)
        .execute(db)
        .await?;
    get_project_file(db, id).await
}

/// Rename a task attachment: its name and the leaf of its folder path. A name already taken
/// among the task's files in the same folder is refused. The bytes (`<root>/<id>`) stay put.
pub async fn rename_attachment(db: &Db, id: i64, new_name: &str) -> Result<FileAttachment> {
    let name = check_name(new_name, false)?;
    let a = get_attachment(db, id).await?;
    if name == a.file_name {
        return Ok(a);
    }
    let dir = dir_of(a.rel_path.as_deref());
    let (files, folders) = task_paths(db, a.task_id).await?;
    refuse_clash(&files, &folders, &join_dir(dir, &name), &[id])?;
    let rel = a.rel_path.as_ref().map(|_| join_dir(dir, &name));
    sqlx::query("UPDATE file_attachments SET file_name = ?, rel_path = ? WHERE id = ?")
        .bind(&name)
        .bind(&rel)
        .bind(id)
        .execute(db)
        .await?;
    get_attachment(db, id).await
}

/// Move project files into a folder (`dir` = "" for the root). Every id must
/// belong to `project_id` — a stray id is an error, not a skip — and no name may
/// clash with what the folder already holds.
pub async fn move_project_files(db: &Db, project_id: i64, ids: &[i64], dir: &str) -> Result<u64> {
    let ids = &dedupe(ids);
    let dir = if dir.is_empty() { String::new() } else { check_name(dir, true)? };
    let (files, folders) = project_paths(db, project_id).await?;
    let mut moves = Vec::new();
    for &id in ids {
        let f = get_project_file(db, id).await?;
        if f.project_id != project_id {
            return Err(AppError::InvalidInput(format!("file {id} is not in this project")));
        }
        let to = join_dir(&dir, &f.file_name);
        refuse_clash(&files, &folders, &to, ids)?;
        moves.push((id, to));
    }
    refuse_duplicates(&moves)?;
    let mut tx = db.begin().await?;
    for (id, to) in &moves {
        let rel = if dir.is_empty() { None } else { Some(to.clone()) };
        sqlx::query("UPDATE project_files SET rel_path = ? WHERE id = ?").bind(&rel).bind(id).execute(&mut *tx).await?;
    }
    if !dir.is_empty() {
        // The target now demonstrably exists — record it so it lists when emptied.
        sqlx::query("INSERT OR IGNORE INTO project_folders (project_id, rel_path) VALUES (?, ?)")
            .bind(project_id)
            .bind(&dir)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(moves.len() as u64)
}

/// Move a task's attachments into one of its folders (`dir` = "" for the root). Every id must
/// belong to `task_id`, and no name may clash with what the folder already holds.
pub async fn move_attachments(db: &Db, task_id: i64, ids: &[i64], dir: &str) -> Result<u64> {
    let ids = &dedupe(ids);
    let dir = if dir.is_empty() { String::new() } else { check_name(dir, true)? };
    let (files, folders) = task_paths(db, task_id).await?;
    let mut moves = Vec::new();
    for &id in ids {
        let a = get_attachment(db, id).await?;
        if a.task_id != task_id {
            return Err(AppError::InvalidInput(format!("file {id} is not on this task")));
        }
        let to = join_dir(&dir, &a.file_name);
        refuse_clash(&files, &folders, &to, ids)?;
        moves.push((id, to));
    }
    refuse_duplicates(&moves)?;
    let mut tx = db.begin().await?;
    for (id, to) in &moves {
        let rel = if dir.is_empty() { None } else { Some(to.clone()) };
        sqlx::query("UPDATE file_attachments SET rel_path = ? WHERE id = ?").bind(&rel).bind(id).execute(&mut *tx).await?;
    }
    if !dir.is_empty() {
        sqlx::query("INSERT OR IGNORE INTO task_folders (task_id, rel_path) VALUES (?, ?)")
            .bind(task_id)
            .bind(&dir)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(moves.len() as u64)
}

/// The ids once each, in order.
fn dedupe(ids: &[i64]) -> Vec<i64> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

/// Two moved files with the same name (in any case) can't land in one folder.
fn refuse_duplicates(moves: &[(i64, String)]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for (_, to) in moves {
        if !seen.insert(to.to_lowercase()) {
            let leaf = to.rsplit('/').next().unwrap_or(to);
            return Err(AppError::InvalidInput(format!("two of the files are called '{leaf}'")));
        }
    }
    Ok(())
}

/// Which files a folder rename touches.
#[derive(Clone, Copy, Debug)]
pub enum FolderScope {
    /// A project's own files (`project_files`, `project_folders`).
    Project(i64),
    /// One task's attachments (`file_attachments`, `task_folders`).
    Task(i64),
}

/// Rename or move a folder: every file under `from` (and every explicit folder) gets the
/// `to` prefix instead. `to` must be free and not inside `from`. Returns how many files moved.
pub async fn rename_folder(db: &Db, scope: FolderScope, from: &str, to: &str) -> Result<u64> {
    let from = check_name(from, true)?;
    let to = check_name(to, true)?;
    if to == from {
        return Ok(0);
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(AppError::InvalidInput("a folder can't move into itself".into()));
    }
    let (files, folders) = match scope {
        FolderScope::Project(pid) => project_paths(db, pid).await?,
        FolderScope::Task(tid) => task_paths(db, tid).await?,
    };
    // Files strictly under `from/` (a file that IS `from` is a file, not this folder).
    let under: Vec<(i64, String)> = files
        .iter()
        .filter(|(_, p)| p.starts_with(&format!("{from}/")))
        .filter_map(|(id, p)| reprefix(p, &from, &to).map(|np| (*id, np)))
        .collect();
    let sub_folders: Vec<(String, String)> =
        folders.iter().filter_map(|f| reprefix(f, &from, &to).map(|nf| (f.clone(), nf))).collect();
    if under.is_empty() && sub_folders.is_empty() {
        return Err(AppError::NotFound(format!("folder '{from}'")));
    }
    let moving: Vec<i64> = under.iter().map(|(id, _)| *id).collect();
    // The folders that move are no obstacle: "Docs" may become "docs".
    let staying: Vec<String> = folders.iter().filter(|f| reprefix(f, &from, &to).is_none()).cloned().collect();
    refuse_clash(&files, &staying, &to, &moving)?;
    let (file_table, folder_table, owner_col, owner) = match scope {
        FolderScope::Project(pid) => ("project_files", "project_folders", "project_id", pid),
        FolderScope::Task(tid) => ("file_attachments", "task_folders", "task_id", tid),
    };
    let mut tx = db.begin().await?;
    for (id, np) in &under {
        sqlx::query(&format!("UPDATE {file_table} SET rel_path = ? WHERE id = ?")).bind(np).bind(id).execute(&mut *tx).await?;
    }
    for (old, new) in &sub_folders {
        sqlx::query(&format!("DELETE FROM {folder_table} WHERE {owner_col} = ? AND rel_path = ?"))
            .bind(owner)
            .bind(old)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&format!("INSERT OR IGNORE INTO {folder_table} ({owner_col}, rel_path) VALUES (?, ?)"))
            .bind(owner)
            .bind(new)
            .execute(&mut *tx)
            .await?;
    }
    // Keep the renamed folder listed even if it held only sub-folders' files.
    sqlx::query(&format!("INSERT OR IGNORE INTO {folder_table} ({owner_col}, rel_path) VALUES (?, ?)"))
        .bind(owner)
        .bind(&to)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(under.len() as u64)
}

/// Remove an explicit folder that holds no files (its empty sub-folders go with it). A
/// folder with files in it is refused: move or delete them first.
pub async fn delete_empty_folder(db: &Db, scope: FolderScope, path: &str) -> Result<()> {
    let path = check_name(path, true)?;
    let (files, _) = match scope {
        FolderScope::Project(pid) => project_paths(db, pid).await?,
        FolderScope::Task(tid) => task_paths(db, tid).await?,
    };
    if files.iter().any(|(_, p)| p.starts_with(&format!("{path}/"))) {
        return Err(AppError::InvalidInput(format!("'{path}' still holds files")));
    }
    let (folder_table, owner_col, owner) = match scope {
        FolderScope::Project(pid) => ("project_folders", "project_id", pid),
        FolderScope::Task(tid) => ("task_folders", "task_id", tid),
    };
    sqlx::query(&format!(
        "DELETE FROM {folder_table} WHERE {owner_col} = ? AND (rel_path = ? OR substr(rel_path, 1, length(?) + 1) = ? || '/')"
    ))
    .bind(owner)
    .bind(&path)
    .bind(&path)
    .bind(&path)
    .execute(db)
    .await?;
    Ok(())
}

/// Create an explicit (possibly empty) folder among a task's files. Idempotent.
pub async fn create_task_folder(db: &Db, task_id: i64, rel_path: &str) -> Result<String> {
    let path = check_name(rel_path, true)?;
    let (files, _) = task_paths(db, task_id).await?;
    refuse_folder_over_file(&files, &path)?;
    sqlx::query("INSERT OR IGNORE INTO task_folders (task_id, rel_path) VALUES (?, ?)")
        .bind(task_id)
        .bind(&path)
        .execute(db)
        .await?;
    Ok(path)
}

/// A task's explicit folders (folders holding files also come from the files' paths).
pub async fn list_task_folders(db: &Db, task_id: i64) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT rel_path FROM task_folders WHERE task_id = ? ORDER BY rel_path")
        .bind(task_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Delete a project file (row + blob).
pub async fn delete_project_file(db: &Db, root: &Path, id: i64) -> Result<()> {
    let _ = std::fs::remove_file(project_blob_path(root, id));
    sqlx::query("DELETE FROM project_files WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

/// (file_name, blob path) for download, if the blob is present.
pub async fn project_file_for_download(db: &Db, root: &Path, id: i64) -> Result<(String, Option<String>, PathBuf)> {
    let f = get_project_file(db, id).await?;
    let path = project_blob_path(root, id);
    if !path.exists() {
        return Err(AppError::NotFound("file is missing on the host".into()));
    }
    Ok((f.file_name, f.file_type, path))
}

// --------------------------------------------------------------------------- //
// The AI overview: which files the project's knowledge base may index. New files
// are left out; someone includes them one by one. A file over the size guard goes
// in only when they say so on purpose (`force`), so a 1000-page textbook can't
// stall the indexer by accident.
// --------------------------------------------------------------------------- //

/// `ai_included` values: left out, included, included past the size guard on purpose.
pub const AI_EXCLUDED: i64 = 0;
pub const AI_INCLUDED: i64 = 1;
pub const AI_FORCED: i64 = 2;

/// The size guard for the AI overview, in bytes: `GANBAN_AI_MAX_FILE_MB` (default 50).
pub fn ai_max_file_bytes() -> i64 {
    let mb = std::env::var("GANBAN_AI_MAX_FILE_MB")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|mb| mb.is_finite() && *mb > 0.0)
        .unwrap_or(50.0);
    (mb * 1024.0 * 1024.0) as i64
}

/// Bytes in MB for a message, counted in 1024s like the app: "380 MB", "1.5 MB".
pub fn mb_label(bytes: i64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 10.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{mb:.1} MB")
    }
}

/// The `ai_included` value for a file of `size` bytes, or why it can't be included yet.
/// Over the guard, including needs `force`, and the error names the size so the UI can
/// ask "This file is 380 MB; index it anyway?".
pub fn ai_flag(size: i64, included: bool, force: bool, max: i64) -> Result<i64> {
    if !included {
        return Ok(AI_EXCLUDED);
    }
    if size <= max {
        return Ok(AI_INCLUDED);
    }
    if force {
        return Ok(AI_FORCED);
    }
    Err(AppError::Refused {
        code: crate::error::codes::AI_FILE_TOO_LARGE,
        message: format!(
            "This file is {}, over the {} limit for the AI overview. Indexing it can take hours; pass force to index it anyway.",
            mb_label(size),
            mb_label(max)
        ),
    })
}

/// Put a task attachment in or out of the AI overview. A host-stored copy counts by its
/// stored size, a local one by its recorded size. `updated_at` moves so replicas pull it.
pub async fn set_attachment_ai_included(db: &Db, attachment_id: i64, included: bool, force: bool) -> Result<FileAttachment> {
    let att = get_attachment(db, attachment_id).await?;
    let size = if att.is_shared { att.storage_size } else { att.file_size.unwrap_or(0) };
    let flag = ai_flag(size, included, force, ai_max_file_bytes())?;
    sqlx::query("UPDATE file_attachments SET ai_included = ?, updated_at = ? WHERE id = ?")
        .bind(flag)
        .bind(Utc::now())
        .bind(attachment_id)
        .execute(db)
        .await?;
    get_attachment(db, attachment_id).await
}

/// Put a project file in or out of the AI overview.
pub async fn set_project_file_ai_included(db: &Db, file_id: i64, included: bool, force: bool) -> Result<ProjectFile> {
    let f = get_project_file(db, file_id).await?;
    let flag = ai_flag(f.size_bytes, included, force, ai_max_file_bytes())?;
    sqlx::query("UPDATE project_files SET ai_included = ? WHERE id = ?").bind(flag).bind(file_id).execute(db).await?;
    get_project_file(db, file_id).await
}

/// Who uploaded a file, by kind ("attachment" | "project"). A missing row is "not found".
pub async fn file_uploader(db: &Db, kind: &str, id: i64) -> Result<Option<i64>> {
    let sql = match kind {
        "attachment" => "SELECT uploaded_by FROM file_attachments WHERE id = ?",
        "project" => "SELECT uploaded_by FROM project_files WHERE id = ?",
        _ => return Err(AppError::InvalidInput(format!("kind '{kind}' is not one of attachment | project"))),
    };
    sqlx::query_scalar::<_, Option<i64>>(sql)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("file".into()))
}

// --------------------------------------------------------------------------- //
// Event files. Stored on the host under <root>/ev/<id>. Events belong to no
// project, so these count against no project's quota.
// --------------------------------------------------------------------------- //

/// Filesystem location of an event file's bytes: `<root>/ev/<id>`.
pub fn event_blob_path(root: &Path, file_id: i64) -> PathBuf {
    root.join("ev").join(file_id.to_string())
}

/// One event file.
pub async fn get_event_file(db: &Db, id: i64) -> Result<EventAttachment> {
    sqlx::query_as::<_, EventAttachment>("SELECT * FROM event_attachments WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("event file".into()))
}

/// An event's files, by folder path then name.
pub async fn list_event_files(db: &Db, event_id: i64) -> Result<Vec<EventAttachment>> {
    Ok(sqlx::query_as::<_, EventAttachment>(
        "SELECT * FROM event_attachments WHERE event_id = ? ORDER BY COALESCE(rel_path, file_name) COLLATE NOCASE, id",
    )
    .bind(event_id)
    .fetch_all(db)
    .await?)
}

/// Store an upload the daemon streamed to `src` (its spool file) as a file on
/// `event_id`, moved (not copied) into place.
#[allow(clippy::too_many_arguments)]
pub async fn store_event_file_from_path(
    db: &Db,
    root: &Path,
    event_id: i64,
    file_name: &str,
    file_type: Option<&str>,
    rel_path: Option<&str>,
    uploaded_by: Option<i64>,
    src: &Path,
    size: i64,
) -> Result<EventAttachment> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM events WHERE id = ?").bind(event_id).fetch_optional(db).await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("event {event_id}")));
    }
    let id = sqlx::query(
        "INSERT INTO event_attachments (event_id, file_name, file_type, rel_path, size_bytes, uploaded_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event_id)
    .bind(file_name)
    .bind(file_type)
    .bind(rel_path)
    .bind(size)
    .bind(uploaded_by)
    .bind(Utc::now())
    .execute(db)
    .await?
    .last_insert_rowid();
    if let Err(e) = move_into_place(src, &event_blob_path(root, id)).await {
        let _ = sqlx::query("DELETE FROM event_attachments WHERE id = ?").bind(id).execute(db).await;
        return Err(AppError::from(e));
    }
    get_event_file(db, id).await
}

/// (file name, type, blob path) for download, if the blob is present.
pub async fn event_file_for_download(db: &Db, root: &Path, id: i64) -> Result<(String, Option<String>, PathBuf)> {
    let f = get_event_file(db, id).await?;
    let path = event_blob_path(root, id);
    if !path.exists() {
        return Err(AppError::NotFound("file is missing on the host".into()));
    }
    Ok((f.file_name, f.file_type, path))
}

/// Delete an event file (row + blob).
pub async fn delete_event_file(db: &Db, root: &Path, id: i64) -> Result<()> {
    let _ = std::fs::remove_file(event_blob_path(root, id));
    sqlx::query("DELETE FROM event_attachments WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

/// Delete every file of an event (rows + blobs), when the event itself goes.
pub async fn delete_event_files(db: &Db, root: &Path, event_id: i64) -> Result<()> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM event_attachments WHERE event_id = ?").bind(event_id).fetch_all(db).await?;
    for id in ids {
        delete_event_file(db, root, id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod locate_tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ganban_locate_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("pf")).unwrap();
        d
    }

    #[test]
    fn a_file_uploaded_to_the_host_is_found_in_the_blob_store_on_the_host() {
        let root = tmp("upload");
        std::fs::write(blob_path(&root, 7), b"x").unwrap();
        // `create_shared_attachment` stores file_path = ''.
        let got = locate_on_this_machine(Some(&root), BlobKind::Attachment, 7, true, Some(Path::new("")));
        assert_eq!(got, Location::Found(blob_path(&root, 7)));
        // A client has no host store: nothing to reveal (it downloads instead).
        assert_eq!(locate_on_this_machine(None, BlobKind::Attachment, 7, true, Some(Path::new(""))), Location::Nowhere);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_shared_from_another_desktop_is_found_in_the_blob_store() {
        let root = tmp("shared");
        std::fs::write(blob_path(&root, 8), b"x").unwrap();
        let theirs = Path::new("/Users/someone-else-xyz/Documents/report.pdf");
        assert_eq!(locate_on_this_machine(Some(&root), BlobKind::Attachment, 8, true, Some(theirs)), Location::Found(blob_path(&root, 8)));
        assert_eq!(locate_on_this_machine(None, BlobKind::Attachment, 8, true, Some(theirs)), Location::Nowhere);
        // Its folder exists here but the file does not: still the host copy, not a folder.
        let near = root.join("gone.pdf");
        assert_eq!(locate_on_this_machine(None, BlobKind::Attachment, 8, true, Some(&near)), Location::Nowhere);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_saved_path_that_exists_here_wins_and_local_files_keep_theirs() {
        let root = tmp("mine");
        std::fs::write(blob_path(&root, 9), b"x").unwrap();
        let mine = root.join("mine.pdf");
        std::fs::write(&mine, b"x").unwrap();
        // Shared by this machine's own desktop: its original folder is the useful one.
        assert_eq!(locate_on_this_machine(Some(&root), BlobKind::Attachment, 9, true, Some(&mine)), Location::Found(mine.clone()));
        // Local-only: its path, on host or client alike.
        assert_eq!(locate_on_this_machine(None, BlobKind::Attachment, 10, false, Some(&mine)), Location::Found(mine.clone()));
        // Local-only and missing here: never falls into the blob store (no host copy);
        // the nearest folder of its saved path is the help.
        std::fs::write(blob_path(&root, 11), b"stale").unwrap();
        let gone = root.join("gone.pdf");
        assert_eq!(locate_on_this_machine(Some(&root), BlobKind::Attachment, 11, false, Some(&gone)), Location::SavedPathMissing(gone.clone()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_files_live_under_pf() {
        let root = tmp("pf");
        std::fs::write(project_blob_path(&root, 3), b"x").unwrap();
        assert_eq!(locate_on_this_machine(Some(&root), BlobKind::Project, 3, true, None), Location::Found(project_blob_path(&root, 3)));
        // A missing blob is not found.
        assert_eq!(locate_on_this_machine(Some(&root), BlobKind::Project, 4, true, None), Location::Nowhere);
        let _ = std::fs::remove_dir_all(&root);
    }
}
