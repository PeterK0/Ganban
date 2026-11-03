//! Desktop-only: moving shared file bytes the desktop can't send through the
//! command table (a pasted image's bytes, an attachment's bytes to render
//! inline). Sharing, unsharing and quotas are table commands (`commands::files`).
//! Networked members upload/download shared files over the daemon's `/files`
//! routes instead.

use ganban_core::models::FileAttachment;
use ganban_core::storage::{self, StorageRoot};
use ganban_core::Db;
use tauri::State;

/// Store a pasted/clipboard image as a shared attachment and return it (the
/// caller embeds /files/<id> in the comment or description).
#[tauri::command]
pub async fn attach_pasted_image(
    pool: State<'_, Db>,
    root: State<'_, StorageRoot>,
    task_id: i64,
    file_name: String,
    file_type: Option<String>,
    bytes: Vec<u8>,
    uploaded_by: Option<i64>,
) -> Result<FileAttachment, String> {
    storage::store_shared_bytes(pool.inner(), &root.0, task_id, &file_name, file_type.as_deref(), uploaded_by, &bytes)
        .await
        .map_err(|e| e.to_string())
}

/// Read a shared attachment's (mime, bytes) so the desktop can render it inline
/// without going over HTTP.
#[tauri::command]
pub async fn read_attachment_bytes(
    pool: State<'_, Db>,
    root: State<'_, StorageRoot>,
    attachment_id: i64,
) -> Result<(String, Vec<u8>), String> {
    storage::read_attachment(pool.inner(), &root.0, attachment_id)
        .await
        .map_err(|e| e.to_string())
}
