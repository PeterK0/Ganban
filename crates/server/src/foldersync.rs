//! Folder sync: one-way import from a LOCAL folder into a project's files.
//!
//! The cloud part is deliberately not ours: OneDrive, Nextcloud, Google Drive
//! (and anything else) already ship desktop clients that mirror to a local
//! folder — Ganban just watches that folder. No OAuth, no API keys, no cloud
//! SDKs; the provider's own client owns transport, we own import. Files that
//! pass the mapping's filters land as project files (stable ids: a changed
//! source updates the SAME project file in place, so references and the RAG
//! corpus follow). Deletions are NOT propagated — this is an importer, not a
//! mirror; remove unwanted files from the Files page.
//!
//! Controls live in Settings → Plug-ins; scanning runs on a poller tied to the
//! daemon's lifetime, plus an explicit "Sync now".

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ganban_core::error::AppError;
use ganban_core::models::SyncFolder;
use ganban_core::{ops, storage, Db};
use serde::Serialize;

/// Rescan cadence for enabled mappings.
const POLL_SECS: u64 = 300;
/// Recursion + volume guards: a mapping pointed at $HOME by accident should
/// degrade into a capped scan, not an import of someone's life.
const MAX_DEPTH: usize = 8;
const MAX_FILES_PER_SCAN: usize = 2000;

#[derive(Debug, Default, Serialize)]
pub struct ScanSummary {
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    /// Files skipped by the extension/size filters.
    pub filtered: u64,
    /// file → why (quota, unreadable…). Per-file, never fatal to the scan.
    pub errors: Vec<(String, String)>,
}

impl ScanSummary {
    fn brief(&self) -> String {
        let mut s = format!("{} added, {} updated, {} unchanged, {} filtered", self.added, self.updated, self.unchanged, self.filtered);
        if !self.errors.is_empty() {
            s.push_str(&format!(", {} failed", self.errors.len()));
        }
        s
    }
}

/// Best-effort MIME from the extension (enough for previews + RAG hints).
fn guess_mime(name: &str) -> Option<&'static str> {
    match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("pdf") => Some("application/pdf"),
        Some("md") => Some("text/markdown"),
        Some("txt") => Some("text/plain"),
        Some("csv") => Some("text/csv"),
        Some("json") => Some("application/json"),
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("docx") => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        Some("xlsx") => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        Some("pptx") => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        _ => None,
    }
}

/// Walk `dir` (bounded), collecting files that exist on disk right now.
fn collect_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES_PER_SCAN {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES_PER_SCAN {
            return;
        }
        let name = entry.file_name();
        // Hidden files/dirs (.git, .DS_Store, provider metadata) never sync.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_files(&path, depth + 1, out),
            Ok(t) if t.is_file() => out.push(path),
            _ => {}
        }
    }
}

/// One pass over a mapping: import new files, update changed ones in place.
pub async fn scan(db: &Db, root: &Path, folder: &SyncFolder) -> Result<ScanSummary, AppError> {
    let base = PathBuf::from(&folder.path);
    if !base.is_dir() {
        return Err(AppError::InvalidInput(format!("'{}' is not a folder on this machine", folder.path)));
    }
    let allow: Vec<String> = folder
        .include_ext
        .split(',')
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();

    let mut files = Vec::new();
    collect_files(&base, 0, &mut files);

    let mut summary = ScanSummary::default();
    for path in files {
        let rel = path.strip_prefix(&base).unwrap_or(&path).to_string_lossy().to_string();
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| rel.clone());

        // Filters: extension allowlist + size ceiling.
        if !allow.is_empty() {
            let ext = file_name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default();
            if !allow.contains(&ext) {
                summary.filtered += 1;
                continue;
            }
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            summary.errors.push((rel, "unreadable".into()));
            continue;
        };
        let size = meta.len() as i64;
        if folder.max_bytes > 0 && size > folder.max_bytes {
            summary.filtered += 1;
            continue;
        }
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);

        // Change detection against what this mapping already imported.
        let known: Option<(i64, i64, i64)> = sqlx::query_as(
            "SELECT project_file_id, mtime, size FROM sync_folder_files WHERE folder_id = ? AND rel_path = ?",
        )
        .bind(folder.id)
        .bind(&rel)
        .fetch_optional(db)
        .await
        .map_err(AppError::from)?;
        if let Some((_, m, s)) = known {
            if m == mtime && s == size {
                summary.unchanged += 1;
                continue;
            }
        }

        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                summary.errors.push((rel, e.to_string()));
                continue;
            }
        };
        let mime = guess_mime(&file_name);

        let outcome = match known {
            Some((pfid, _, _)) => {
                // Update the SAME project file so its id (and corpus identity)
                // survives; if the user deleted it meanwhile, re-import fresh.
                match storage::restore_project_file(db, root, pfid, mime, &bytes).await {
                    Ok(_) => Ok((pfid, false)),
                    Err(AppError::NotFound(_)) => {
                        storage::store_project_file(db, root, folder.project_id, &file_name, mime, Some(&rel), None, &bytes)
                            .await
                            .map(|f| (f.id, true))
                    }
                    Err(e) => Err(e),
                }
            }
            None => storage::store_project_file(db, root, folder.project_id, &file_name, mime, Some(&rel), None, &bytes)
                .await
                .map(|f| (f.id, true)),
        };
        match outcome {
            Ok((pfid, is_new)) => {
                sqlx::query(
                    "INSERT INTO sync_folder_files (folder_id, rel_path, mtime, size, project_file_id) VALUES (?, ?, ?, ?, ?) \
                     ON CONFLICT(folder_id, rel_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, project_file_id = excluded.project_file_id",
                )
                .bind(folder.id)
                .bind(&rel)
                .bind(mtime)
                .bind(size)
                .bind(pfid)
                .execute(db)
                .await
                .map_err(AppError::from)?;
                if is_new && known.is_none() {
                    summary.added += 1;
                } else {
                    summary.updated += 1;
                }
            }
            Err(e) => summary.errors.push((rel, e.to_string())),
        }
    }

    let _ = ops::set_sync_folder_result(db, folder.id, &summary.brief()).await;
    Ok(summary)
}

/// Background loop: rescan every enabled mapping each `POLL_SECS`. Tied to the
/// owning daemon's lifetime exactly like the RAG poller and routine runner.
pub fn spawn_poller(db: Db, root: PathBuf, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(20)) => {}
            _ = stop.changed() => return,
        }
        loop {
            let folders = ops::list_sync_folders(&db).await.unwrap_or_default();
            for f in folders.iter().filter(|f| f.enabled) {
                if let Err(e) = scan(&db, &root, f).await {
                    tracing::warn!("'{}' scan failed: {e}", f.path);
                    let _ = ops::set_sync_folder_result(&db, f.id, &format!("scan failed: {e}")).await;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)) => {}
                _ = stop.changed() => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json as j;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_fsync_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    fn temp_tree(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ganban_fsync_tree_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("nested")).unwrap();
        p
    }

    #[tokio::test]
    async fn imports_filters_updates_in_place_and_repairs_deleted_targets() {
        let db = test_db("scan").await;
        let src = temp_tree("scan");
        let root = std::env::temp_dir().join(format!("ganban_fsync_root_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        let pid = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Uni" } })).await.unwrap()["id"].as_i64().unwrap();

        std::fs::write(src.join("week1.pdf"), b"pdf bytes").unwrap();
        std::fs::write(src.join("nested/notes.md"), b"# notes").unwrap();
        std::fs::write(src.join("skip.tmp"), b"tmp").unwrap();
        std::fs::write(src.join("huge.pdf"), vec![0u8; 5000]).unwrap();
        std::fs::write(src.join(".hidden.pdf"), b"never").unwrap();

        let folder =
            ops::create_sync_folder(&db, pid, &src.to_string_lossy(), "pdf, md", 4096).await.unwrap();

        // First pass: matching files import (with rel paths); filters hold.
        let s = scan(&db, &root, &folder).await.unwrap();
        assert_eq!((s.added, s.updated, s.unchanged), (2, 0, 0));
        assert_eq!(s.filtered, 2, "wrong extension + oversize are filtered");
        assert!(s.errors.is_empty());
        let files = storage::list_project_files(&db, pid).await.unwrap();
        assert_eq!(files.len(), 2);
        let notes = files.iter().find(|f| f.file_name == "notes.md").unwrap();
        assert_eq!(notes.rel_path.as_deref(), Some("nested/notes.md"), "folder structure preserved");

        // Second pass: nothing changed → nothing re-imported.
        let s = scan(&db, &root, &folder).await.unwrap();
        assert_eq!((s.added, s.updated, s.unchanged), (0, 0, 2));

        // Source edit → the SAME project file updates in place (stable id).
        let week1_id = files.iter().find(|f| f.file_name == "week1.pdf").unwrap().id;
        std::fs::write(src.join("week1.pdf"), b"pdf bytes, revised edition").unwrap();
        let s = scan(&db, &root, &folder).await.unwrap();
        assert_eq!((s.added, s.updated), (0, 1));
        let after = storage::list_project_files(&db, pid).await.unwrap();
        let week1 = after.iter().find(|f| f.file_name == "week1.pdf").unwrap();
        assert_eq!(week1.id, week1_id, "references and corpus identity survive source edits");
        assert_eq!(std::fs::read(storage::project_blob_path(&root, week1_id)).unwrap(), b"pdf bytes, revised edition");

        // User deletes the imported file → next scan re-imports and repairs the mapping.
        storage::delete_project_file(&db, &root, week1_id).await.unwrap();
        std::fs::write(src.join("week1.pdf"), b"third edition").unwrap();
        let s = scan(&db, &root, &folder).await.unwrap();
        assert_eq!(s.updated, 1, "deleted target re-imported under a fresh id");
        let repaired = storage::list_project_files(&db, pid).await.unwrap();
        assert!(repaired.iter().any(|f| f.file_name == "week1.pdf" && f.id != week1_id));

        // Quota pressure: per-file failure is reported, the scan survives.
        storage::set_project_quota(&db, pid, storage::project_used(&db, pid).await.unwrap()).await.unwrap();
        std::fs::write(src.join("extra.pdf"), b"does not fit at all").unwrap();
        let s = scan(&db, &root, &folder).await.unwrap();
        assert_eq!(s.errors.len(), 1);
        assert!(s.errors[0].0.contains("extra.pdf"));

        // The mapping records its outcome for the Plug-ins card.
        let f = ops::get_sync_folder(&db, folder.id).await.unwrap().unwrap();
        assert!(f.last_result.as_deref().unwrap_or("").contains("failed"));
        assert!(f.last_scan_at.is_some());
    }
}
