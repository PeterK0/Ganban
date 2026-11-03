//! Share links (ADR 0006): a public link to a fixed set of a project's files (its own files
//! and its tasks' attachments, in any mix), served by the
//! **share door**, a second listener that answers nothing but `/s/…`.
//!
//! This module owns the links' records: creating one (the file snapshot), listing and
//! revoking them, and the background work that computes each file's CRC-32 for the
//! deterministic zip. The door itself is [`door`], the zip's byte layout [`zip`] and the
//! recipient's page [`page`]. The commands that drive it are `commands::share`.
//!
//! **A file that changed since the snapshot** (its blob's size or mtime differs) is
//! re-read: the door notices it, clears that file's CRC and puts the link back to
//! `preparing`, so the zip waits (503 + `Retry-After`) until the new CRC is in. A file whose
//! host copy is gone (deleted, unshared, moved between the project's files and a task's)
//! drops out of the page and the zip.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Duration, Utc};
use ganban_core::error::AppError;
use ganban_core::storage;
use ganban_core::visibility::{self, Viewer};
use ganban_core::Db;
use serde::Serialize;

pub(crate) mod door;
pub(crate) mod page;
pub(crate) mod zip;

type Result<T> = std::result::Result<T, AppError>;

/// The longest label a link keeps.
const LABEL_MAX: usize = 200;

// ============== Configuration ==============

/// Where the share door listens (`GANBAN_SHARE_ADDR`), if it's set and parses.
pub fn door_addr() -> Option<std::net::SocketAddr> {
    let raw = std::env::var("GANBAN_SHARE_ADDR").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.parse() {
        Ok(addr) => Some(addr),
        Err(_) => {
            tracing::error!("GANBAN_SHARE_ADDR '{raw}' is not an IP:PORT address; the share door stays shut");
            None
        }
    }
}

/// The door's public base URL (`GANBAN_SHARE_URL`), without a trailing slash.
pub fn public_url() -> Option<String> {
    let raw = std::env::var("GANBAN_SHARE_URL").ok()?;
    let url = raw.trim().trim_end_matches('/');
    (!url.is_empty()).then(|| url.to_string())
}

/// Whether the door is listening in this process.
static DOOR_UP: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_door_up(up: bool) {
    DOOR_UP.store(up, Ordering::Relaxed);
}

pub(crate) fn door_up() -> bool {
    DOOR_UP.load(Ordering::Relaxed)
}

/// Open the share door on `GANBAN_SHARE_ADDR`, if set, until `stop` resolves; and resume
/// the CRC work of links a restart interrupted. Called by `serve()`.
pub(crate) async fn start(db: Db, root: PathBuf, stop: impl std::future::Future<Output = ()> + Send + 'static) {
    resume_preparing(&db, &root).await;
    let Some(addr) = door_addr() else { return };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("share door: can't listen on {addr}: {e}");
            return;
        }
    };
    tracing::info!("share door listening on {addr} (public URL: {})", public_url().as_deref().unwrap_or("not set"));
    let app = door::router(db, root, door::Limiter::default())
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    set_door_up(true);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(stop).await {
            tracing::error!("share door stopped: {e}");
        }
        set_door_up(false);
    });
}

// ============== Records ==============

/// A link's row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct LinkRow {
    pub id: i64,
    pub token: String,
    /// The task it was made from; `None` for one made from the project's Files.
    pub task_id: Option<i64>,
    pub project_id: i64,
    pub label: String,
    pub password_hash: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub prepared_at: Option<DateTime<Utc>>,
    pub created_by: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub download_count: i64,
    pub last_download_at: Option<DateTime<Utc>>,
}

impl LinkRow {
    /// Whether the door serves it: not revoked and not expired.
    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|e| e > now)
    }

    fn status(&self, now: DateTime<Utc>) -> &'static str {
        if self.revoked_at.is_some() {
            "revoked"
        } else if self.expires_at.is_some_and(|e| e <= now) {
            "expired"
        } else if self.prepared_at.is_none() {
            "preparing"
        } else {
            "active"
        }
    }
}

/// Which table a link's file comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    /// A task attachment: `file_attachments`, blob `<root>/<id>`.
    Attachment,
    /// A project's own file: `project_files`, blob `<root>/pf/<id>`.
    Project,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Attachment => "attachment",
            Kind::Project => "project",
        }
    }

    fn parse(s: &str) -> Kind {
        if s == "project" { Kind::Project } else { Kind::Attachment }
    }

    /// Where the file's bytes live.
    pub fn blob(self, root: &Path, id: i64) -> PathBuf {
        match self {
            Kind::Attachment => storage::blob_path(root, id),
            Kind::Project => storage::project_blob_path(root, id),
        }
    }
}

/// One file of a link's snapshot.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct FileRow {
    pub n: i64,
    /// `"attachment"` or `"project"`: see [`Kind`].
    pub kind: String,
    pub file_id: i64,
    /// The folder path shown, `""` at the top.
    pub folder: String,
    pub name: String,
    pub size: i64,
    pub mtime: i64,
    pub crc32: Option<i64>,
}

impl FileRow {
    pub fn kind(&self) -> Kind {
        Kind::parse(&self.kind)
    }

    /// Where its bytes live.
    pub fn blob(&self, root: &Path) -> PathBuf {
        self.kind().blob(root, self.file_id)
    }

    /// The path inside the zip: `folder/name`.
    pub fn zip_name(&self) -> String {
        if self.folder.is_empty() {
            self.name.clone()
        } else {
            format!("{}/{}", self.folder, self.name)
        }
    }
}

/// A link as the app sees it (the brief's `ShareLink`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub id: i64,
    pub task_id: Option<i64>,
    pub project_id: i64,
    pub label: String,
    pub url: Option<String>,
    pub path: String,
    pub status: &'static str,
    pub expires_at: Option<DateTime<Utc>>,
    pub has_password: bool,
    pub file_count: i64,
    pub total_bytes: i64,
    pub download_count: i64,
    pub last_download_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_by: Option<i64>,
    pub created_at: DateTime<Utc>,
}

async fn to_share_link(db: &Db, row: LinkRow) -> Result<ShareLink> {
    let (file_count, total_bytes): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM share_link_files WHERE link_id = ?")
            .bind(row.id)
            .fetch_one(db)
            .await?;
    let path = format!("/s/{}", row.token);
    Ok(ShareLink {
        id: row.id,
        task_id: row.task_id,
        project_id: row.project_id,
        label: row.label.clone(),
        url: public_url().map(|base| format!("{base}{path}")),
        path,
        status: row.status(Utc::now()),
        expires_at: row.expires_at,
        has_password: row.password_hash.is_some(),
        file_count,
        total_bytes,
        download_count: row.download_count,
        last_download_at: row.last_download_at,
        revoked_at: row.revoked_at,
        created_by: row.created_by,
        created_at: row.created_at,
    })
}

pub(crate) async fn link_by_id(db: &Db, id: i64) -> Result<LinkRow> {
    sqlx::query_as::<_, LinkRow>("SELECT * FROM share_links WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("share link".into()))
}

/// The link a token names, whatever its state. The task it was made from, if any, must still
/// exist.
pub(crate) async fn link_by_token(db: &Db, token: &str) -> Result<Option<LinkRow>> {
    Ok(sqlx::query_as::<_, LinkRow>(
        "SELECT l.* FROM share_links l LEFT JOIN tasks t ON t.id = l.task_id \
         WHERE l.token = ? AND (l.task_id IS NULL OR t.id IS NOT NULL)",
    )
    .bind(token)
    .fetch_optional(db)
    .await?)
}

pub(crate) async fn files_of(db: &Db, link_id: i64) -> Result<Vec<FileRow>> {
    Ok(sqlx::query_as::<_, FileRow>(
        "SELECT n, kind, file_id, folder, name, size, mtime, crc32 FROM share_link_files WHERE link_id = ? ORDER BY n",
    )
    .bind(link_id)
    .fetch_all(db)
    .await?)
}

/// The project a link belongs to, for access rules.
pub(crate) async fn link_project(db: &Db, id: i64) -> Result<Option<i64>> {
    Ok(Some(link_by_id(db, id).await?.project_id))
}

/// The task a link was made from (`None` for one made from the project), for visibility.
pub(crate) async fn link_task(db: &Db, id: i64) -> Result<Option<i64>> {
    Ok(link_by_id(db, id).await?.task_id)
}

// ============== Creating, listing, revoking ==============

/// What `create_share_link` asks for.
pub(crate) struct NewLink {
    /// The task it's made from; `None`: from the project's Files.
    pub task_id: Option<i64>,
    /// The project it's made from. With a task it may be left out, and must be the task's.
    pub project_id: Option<i64>,
    /// Task attachments. From a task: that task's only. From the project: any of its tasks'.
    pub attachment_ids: Option<Vec<i64>>,
    /// The project's own files.
    pub project_file_ids: Option<Vec<i64>>,
    pub label: Option<String>,
    /// `None`: never expires.
    pub expires_in_days: Option<i64>,
    pub password: Option<String>,
    pub created_by: Option<i64>,
    /// Who makes it, for task visibility (ADR 0002); `None` sees every task.
    pub viewer: Option<Viewer>,
}

/// A file the snapshot may take.
struct Candidate {
    kind: Kind,
    id: i64,
    file_name: String,
    rel_path: Option<String>,
    /// On the host (a project file always is).
    is_shared: bool,
    /// For a task attachment in a link made from the project: the task's folder.
    task_folder: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AttachmentRow {
    id: i64,
    file_name: String,
    rel_path: Option<String>,
    is_shared: bool,
    task_id: i64,
    title: String,
}

#[derive(sqlx::FromRow)]
struct ProjectFileRow {
    id: i64,
    file_name: String,
    rel_path: Option<String>,
}

fn project_candidate(f: ProjectFileRow) -> Candidate {
    Candidate { kind: Kind::Project, id: f.id, file_name: f.file_name, rel_path: f.rel_path, is_shared: true, task_folder: None }
}

/// A file or folder name made safe for a zip entry and a download: no slashes, no control or
/// invisible characters, at most 255 bytes, not `.`/`..`.
pub(crate) fn clean_segment(raw: &str) -> String {
    // Bidi overrides and zero-width characters can disguise a name ("gpj.exe").
    let invisible = ganban_core::storage::is_invisible;
    let s: String = raw
        .chars()
        .filter(|c| !invisible(*c))
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c })
        .collect();
    let mut s = s.trim().to_string();
    // At most 255 bytes, cut on a character boundary.
    while s.len() > 255 {
        s.pop();
    }
    if s.is_empty() || s == "." || s == ".." {
        "file".to_string()
    } else {
        s
    }
}

/// `(folder, name)` for a file: from its folder path, else its bare name; a task's file in a
/// link made from the project sits under its task's folder.
fn place(c: &Candidate) -> (String, String) {
    let path = c.rel_path.as_deref().filter(|p| !p.trim().is_empty());
    let (folder, name) = match path.and_then(|p| p.rsplit_once('/')) {
        Some((dir, leaf)) => (dir.to_string(), leaf.to_string()),
        None => (String::new(), path.unwrap_or(&c.file_name).to_string()),
    };
    let folder = c
        .task_folder
        .iter()
        .map(String::as_str)
        .chain(folder.split('/'))
        .filter(|s| !s.is_empty())
        .map(clean_segment)
        .collect::<Vec<_>>()
        .join("/");
    (folder, clean_segment(&name))
}

/// `name` made unique among `taken`: "a.pdf", then "a (2).pdf".
fn unique_name(taken: &mut std::collections::HashSet<String>, folder: &str, name: String) -> String {
    let key = |n: &str| format!("{}/{}", folder, n).to_lowercase();
    if taken.insert(key(&name)) {
        return name;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    (2..)
        .map(|i| format!("{stem} ({i}){ext}"))
        .find(|candidate| taken.insert(key(candidate)))
        .expect("an unused name")
}

/// A blob's size and mtime (unix seconds).
pub(crate) fn stat(path: &Path) -> Option<(i64, i64)> {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    Some((meta.len() as i64, mtime))
}

/// A fresh link token: 32 random bytes, base64url without padding (43 characters).
fn new_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS RNG unavailable");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Whether `s` looks like a token [`new_token`] makes.
pub(crate) fn token_shaped(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An argon2id PHC string for a link's password.
fn hash_password(password: &str) -> Result<String> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).expect("OS RNG unavailable");
    let salt = SaltString::encode_b64(&salt).map_err(|e| AppError::InvalidInput(format!("salt: {e}")))?;
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::InvalidInput(format!("password: {e}")))
}

/// Whether `password` matches a stored PHC string.
pub(crate) fn password_matches(stored: &str, password: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(stored)
        .map(|h| argon2::Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Make a link: snapshot the files, store the link as `preparing`, and start computing the
/// CRC-32s in the background.
pub(crate) async fn create(db: &Db, root: &Path, new: NewLink) -> Result<ShareLink> {
    let (project_id, title) = match (new.task_id, new.project_id) {
        (Some(task), project) => {
            let (of, title) = sqlx::query_as::<_, (i64, String)>("SELECT project_id, title FROM tasks WHERE id = ?")
                .bind(task)
                .fetch_optional(db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("task {task}")))?;
            if project.is_some_and(|p| p != of) {
                return Err(AppError::InvalidInput(format!("task {task} isn't in project {}", project.unwrap_or_default())));
            }
            (of, title)
        }
        (None, Some(project)) => {
            let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
                .bind(project)
                .fetch_optional(db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("project {project}")))?;
            (project, name)
        }
        (None, None) => return Err(AppError::InvalidInput("a share link needs a taskId or a projectId".into())),
    };

    let device_only = |n: usize| {
        AppError::InvalidInput(format!(
            "{n} of these files {} only on a member's device; upload {} to the host first",
            if n == 1 { "is" } else { "are" },
            if n == 1 { "it" } else { "them" },
        ))
    };
    let mut chosen: Vec<Candidate> = Vec::new();
    if new.attachment_ids.is_none() && new.project_file_ids.is_none() {
        // The default: every host-stored file of the task, or the project's own files.
        match new.task_id {
            Some(task) => {
                let all: Vec<(String, Option<String>, i64, bool)> = sqlx::query_as(
                    "SELECT file_name, rel_path, id, is_shared FROM file_attachments WHERE task_id = ? AND deleted_at IS NULL",
                )
                .bind(task)
                .fetch_all(db)
                .await?;
                let local = all.iter().filter(|a| !a.3).count();
                for (file_name, rel_path, id, is_shared) in all {
                    if is_shared {
                        chosen.push(Candidate { kind: Kind::Attachment, id, file_name, rel_path, is_shared, task_folder: None });
                    }
                }
                if chosen.is_empty() {
                    return Err(if local > 0 { device_only(local) } else { AppError::InvalidInput("this task has no files to share".into()) });
                }
            }
            None => {
                let all: Vec<ProjectFileRow> =
                    sqlx::query_as("SELECT id, file_name, rel_path FROM project_files WHERE project_id = ?")
                        .bind(project_id)
                        .fetch_all(db)
                        .await?;
                if all.is_empty() {
                    return Err(AppError::InvalidInput("this project has no files of its own to share".into()));
                }
                chosen.extend(all.into_iter().map(project_candidate));
            }
        }
    } else {
        let mut seen = std::collections::HashSet::new();
        // Whether the creator sees a task, asked once per task (a folder may hold hundreds of files).
        let mut sees: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
        for id in new.attachment_ids.iter().flatten() {
            if !seen.insert((Kind::Attachment, *id)) {
                continue;
            }
            // A task's link takes that task's files; a project's, any of its tasks' the creator sees.
            let row: Option<AttachmentRow> = sqlx::query_as(
                "SELECT a.id, a.file_name, a.rel_path, a.is_shared, a.task_id, t.title FROM file_attachments a \
                 JOIN tasks t ON t.id = a.task_id \
                 WHERE a.id = ? AND a.deleted_at IS NULL AND t.project_id = ? AND (? IS NULL OR a.task_id = ?)",
            )
            .bind(id)
            .bind(project_id)
            .bind(new.task_id)
            .bind(new.task_id)
            .fetch_optional(db)
            .await?;
            let not_found = || AppError::NotFound(format!("attachment {id}"));
            let row = row.ok_or_else(not_found)?;
            if let Some(v) = new.viewer {
                let ok = match sees.get(&row.task_id) {
                    Some(ok) => *ok,
                    None => *sees.entry(row.task_id).or_insert(visibility::can_see_task(db, v, row.task_id).await?),
                };
                if !ok {
                    return Err(not_found());
                }
            }
            let task_folder = new.task_id.is_none().then(|| {
                let t = row.title.trim();
                if t.is_empty() { "Untitled task".to_string() } else { t.to_string() }
            });
            chosen.push(Candidate {
                kind: Kind::Attachment,
                id: row.id,
                file_name: row.file_name,
                rel_path: row.rel_path,
                is_shared: row.is_shared,
                task_folder,
            });
        }
        for id in new.project_file_ids.iter().flatten() {
            if !seen.insert((Kind::Project, *id)) {
                continue;
            }
            let row: ProjectFileRow =
                sqlx::query_as("SELECT id, file_name, rel_path FROM project_files WHERE id = ? AND project_id = ?")
                    .bind(id)
                    .bind(project_id)
                    .fetch_optional(db)
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("project file {id}")))?;
            chosen.push(project_candidate(row));
        }
        if chosen.is_empty() {
            return Err(AppError::InvalidInput("choose at least one file to share".into()));
        }
        let local = chosen.iter().filter(|c| !c.is_shared).count();
        if local > 0 {
            return Err(device_only(local));
        }
    }

    // The snapshot: folder, name, size and mtime now. Files sorted by path.
    let mut placed: Vec<(&Candidate, String, String)> = chosen.iter().map(|c| {
        let (folder, name) = place(c);
        (c, folder, name)
    }).collect();
    placed.sort_by(|a, b| {
        (a.1.to_lowercase(), a.2.to_lowercase(), a.0.kind.as_str(), a.0.id)
            .cmp(&(b.1.to_lowercase(), b.2.to_lowercase(), b.0.kind.as_str(), b.0.id))
    });
    let mut missing = 0;
    let mut taken = std::collections::HashSet::new();
    let mut files = Vec::new();
    for (c, folder, name) in placed {
        let Some((size, mtime)) = stat(&c.kind.blob(root, c.id)) else {
            missing += 1;
            continue;
        };
        let name = unique_name(&mut taken, &folder, name);
        files.push((c.kind, c.id, folder, name, size, mtime));
    }
    if missing > 0 {
        return Err(AppError::InvalidInput(format!(
            "{missing} of these files {} missing from the host's storage (the Files audit lists them)",
            if missing == 1 { "is" } else { "are" }
        )));
    }

    let label = match new.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => l.to_string(),
        None => {
            let top: Vec<&str> = files.iter().map(|f| f.2.split('/').next().unwrap_or("")).collect();
            match top.first() {
                Some(first) if !first.is_empty() && top.iter().all(|t| t == first) => first.to_string(),
                _ => title.trim().to_string(),
            }
        }
    };
    let label: String = label.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect();
    let label = if label.trim().is_empty() { "Shared files".to_string() } else { label };

    let expires_at = match new.expires_in_days {
        None => None,
        Some(d) if (1..=3650).contains(&d) => Some(Utc::now() + Duration::days(d)),
        Some(d) => return Err(AppError::InvalidInput(format!("expiresInDays must be 1 to 3650 days or null (got {d})"))),
    };
    let password_hash = match new.password.as_deref().filter(|p| !p.is_empty()) {
        Some(p) if p.len() > 1024 => return Err(AppError::InvalidInput("that password is too long".into())),
        Some(p) => {
            let p = p.to_string();
            Some(tokio::task::spawn_blocking(move || hash_password(&p)).await.map_err(|e| AppError::InvalidInput(e.to_string()))??)
        }
        None => None,
    };

    let mut tx = db.begin().await?;
    let id = sqlx::query(
        "INSERT INTO share_links (token, task_id, project_id, label, password_hash, expires_at, created_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(new_token())
    .bind(new.task_id)
    .bind(project_id)
    .bind(&label)
    .bind(&password_hash)
    .bind(expires_at)
    .bind(new.created_by)
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    for (n, (kind, file_id, folder, name, size, mtime)) in files.iter().enumerate() {
        sqlx::query(
            "INSERT INTO share_link_files (link_id, n, kind, file_id, folder, name, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(n as i64)
        .bind(kind.as_str())
        .bind(file_id)
        .bind(folder)
        .bind(name)
        .bind(size)
        .bind(mtime)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    match new.task_id {
        Some(task) => tracing::info!("share link {id} made for task {task} ({} files)", files.len()),
        None => tracing::info!("share link {id} made for project {project_id} ({} files)", files.len()),
    }
    spawn_prepare(db.clone(), root.to_path_buf(), id);
    to_share_link(db, link_by_id(db, id).await?).await
}

/// Whose links [`list`] lists.
pub(crate) enum Owner {
    /// The links made from a task.
    Task(i64),
    /// Every link of a project: made from its Files or from any of its tasks.
    Project(i64),
}

/// A task's or a project's links, newest first, revoked and expired included.
pub(crate) async fn list(db: &Db, of: Owner) -> Result<Vec<ShareLink>> {
    let (sql, id) = match of {
        Owner::Task(t) => ("SELECT * FROM share_links WHERE task_id = ? ORDER BY created_at DESC, id DESC", t),
        Owner::Project(p) => ("SELECT * FROM share_links WHERE project_id = ? ORDER BY created_at DESC, id DESC", p),
    };
    let rows = sqlx::query_as::<_, LinkRow>(sql).bind(id).fetch_all(db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(to_share_link(db, row).await?);
    }
    Ok(out)
}

/// Revoke a link (idempotent: the first revocation's time stays).
pub(crate) async fn revoke(db: &Db, id: i64) -> Result<ShareLink> {
    sqlx::query("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(Utc::now())
        .bind(id)
        .execute(db)
        .await?;
    tracing::info!("share link {id} revoked");
    to_share_link(db, link_by_id(db, id).await?).await
}

/// Count one download.
pub(crate) async fn count_download(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE share_links SET download_count = download_count + 1, last_download_at = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

// ============== Preparing: the CRC-32s ==============

/// One preparation at a time, so two big links don't fight over the disk.
static PREPARING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// Compute a link's missing CRC-32s in the background.
pub(crate) fn spawn_prepare(db: Db, root: PathBuf, link_id: i64) {
    tokio::spawn(async move {
        if let Err(e) = prepare(&db, &root, link_id).await {
            tracing::warn!("share link {link_id}: preparing failed: {e}");
        }
    });
}

/// Restart the preparation of every live link a restart interrupted.
async fn resume_preparing(db: &Db, root: &Path) {
    let ids: Vec<i64> =
        match sqlx::query_scalar("SELECT id FROM share_links WHERE prepared_at IS NULL AND revoked_at IS NULL").fetch_all(db).await {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("share links: can't list the ones still preparing: {e}");
                return;
            }
        };
    for id in ids {
        spawn_prepare(db.clone(), root.to_path_buf(), id);
    }
}

/// CRC-32, size and mtime of a file, read in one pass. The size and mtime are taken
/// before and after; a file that changed while being read is read again.
fn crc_of(path: &Path) -> std::io::Result<(u32, i64, i64)> {
    use std::io::Read;
    for _ in 0..3 {
        let before = stat(path).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "blob missing"))?;
        let mut f = std::fs::File::open(path)?;
        let mut h = crc32fast::Hasher::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut read = 0i64;
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            read += n as i64;
            h.update(&buf[..n]);
        }
        if stat(path) == Some(before) && read == before.0 {
            return Ok((h.finalize(), before.0, before.1));
        }
    }
    Err(std::io::Error::other("the file kept changing while it was read"))
}

/// Fill in a link's missing CRC-32s, then mark it prepared. A file whose blob is gone is
/// left without one (the door leaves it out).
pub(crate) async fn prepare(db: &Db, root: &Path, link_id: i64) -> Result<()> {
    let _turn = PREPARING.acquire().await.map_err(|e| AppError::InvalidInput(e.to_string()))?;
    loop {
        let todo: Vec<(i64, String, i64)> =
            sqlx::query_as("SELECT n, kind, file_id FROM share_link_files WHERE link_id = ? AND crc32 IS NULL ORDER BY n")
                .bind(link_id)
                .fetch_all(db)
                .await?;
        let mut progressed = false;
        let mut failed: Vec<i64> = Vec::new();
        for (n, kind, id) in todo {
            let kind = Kind::parse(&kind);
            let path = kind.blob(root, id);
            match tokio::task::spawn_blocking(move || crc_of(&path)).await {
                Ok(Ok((crc, size, mtime))) => {
                    sqlx::query("UPDATE share_link_files SET crc32 = ?, size = ?, mtime = ? WHERE link_id = ? AND n = ?")
                        .bind(crc as i64)
                        .bind(size)
                        .bind(mtime)
                        .bind(link_id)
                        .bind(n)
                        .execute(db)
                        .await?;
                    progressed = true;
                }
                Ok(Err(e)) => {
                    tracing::warn!("share link {link_id}: file {n} ({} {id}): {e}", kind.as_str());
                    failed.push(n);
                }
                Err(e) => {
                    tracing::warn!("share link {link_id}: file {n}: {e}");
                    failed.push(n);
                }
            }
        }
        // Mark it prepared unless a file was reset meanwhile (the door may clear a CRC). A file
        // that failed (gone, or kept changing) stays without one: the zip leaves it out.
        let done = sqlx::query(
            "UPDATE share_links SET prepared_at = ? WHERE id = ? AND NOT EXISTS ( \
               SELECT 1 FROM share_link_files f WHERE f.link_id = ? AND f.crc32 IS NULL AND f.n NOT IN \
               (SELECT value FROM json_each(?)))",
        )
        .bind(Utc::now())
        .bind(link_id)
        .bind(link_id)
        .bind(serde_json::to_string(&failed).unwrap_or_else(|_| "[]".into()))
        .execute(db)
        .await?
        .rows_affected();
        if done > 0 || !progressed {
            if done > 0 {
                tracing::info!("share link {link_id} is ready");
            }
            return Ok(());
        }
    }
}

/// A file of a live link, as it stands on disk now.
#[derive(Debug, Clone)]
pub(crate) struct LiveFile {
    pub row: FileRow,
    pub path: PathBuf,
}

/// What a link can serve now.
pub(crate) struct Live {
    /// The files whose host copy still exists.
    pub files: Vec<LiveFile>,
    /// How many dropped out.
    pub gone: usize,
    /// Whether the CRCs are in, so the zip can be served.
    pub ready: bool,
}

/// The files a link can serve now: those whose host copy still exists. A file whose size or
/// mtime moved since its CRC was computed has the CRC cleared and the link goes back to
/// preparing (see the module docs).
pub(crate) async fn live_files(db: &Db, root: &Path, link: &LinkRow) -> Result<Live> {
    let rows = files_of(db, link.id).await?;
    // Still there: an attachment still on the host, a project file still the project's.
    let present: std::collections::HashSet<i64> = sqlx::query_scalar(
        "SELECT f.n FROM share_link_files f JOIN file_attachments a ON a.id = f.file_id \
         WHERE f.link_id = ? AND f.kind = 'attachment' AND a.is_shared = 1 AND a.deleted_at IS NULL \
         UNION ALL \
         SELECT f.n FROM share_link_files f JOIN project_files p ON p.id = f.file_id \
         WHERE f.link_id = ? AND f.kind = 'project' AND p.project_id = ?",
    )
    .bind(link.id)
    .bind(link.id)
    .bind(link.project_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut out = Vec::with_capacity(rows.len());
    let mut gone = 0;
    let mut changed = false;
    for mut row in rows {
        let path = row.blob(root);
        let now = if present.contains(&row.n) { stat(&path) } else { None };
        let Some((size, mtime)) = now else {
            gone += 1;
            continue;
        };
        if (size, mtime) != (row.size, row.mtime) {
            tracing::info!("share link {}: file {} changed on disk; re-reading it", link.id, row.n);
            sqlx::query(
                "UPDATE share_link_files SET crc32 = NULL, size = ?, mtime = ? WHERE link_id = ? AND n = ?",
            )
            .bind(size)
            .bind(mtime)
            .bind(link.id)
            .bind(row.n)
            .execute(db)
            .await?;
            (row.size, row.mtime, row.crc32) = (size, mtime, None);
            changed = true;
        }
        out.push(LiveFile { row, path });
    }
    if changed {
        sqlx::query("UPDATE share_links SET prepared_at = NULL WHERE id = ?").bind(link.id).execute(db).await?;
        spawn_prepare(db.clone(), root.to_path_buf(), link.id);
    }
    Ok(Live { files: out, gone, ready: !changed && link.prepared_at.is_some() })
}
