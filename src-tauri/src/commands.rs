//! Tauri command surface for the desktop app (desktop-only: `#[cfg(desktop)]` in
//! `lib.rs`; the mobile build does no local DB work and reaches the daemon over HTTP).
//!
//! One generic command, `run_command`, runs any command of the host's command table
//! (`ganban_server::run_in_process`, ADR 0001) against this desktop's own database, as the
//! owner. The rest are desktop-only operations on this machine's own files and profiles,
//! which are not commands of the table.

use ganban_core::storage::StorageRoot;
use ganban_core::{ops, Db};
use serde_json::Value;
use tauri::{Manager, State};

use crate::daemon_control::DaemonState;

/// Run a command of the host's command table in-process: the frontend's local path
/// (`invokeLocal` in `src/lib/api.ts`). The desktop is the owner, so no access rule or
/// result filter applies; authorship is the profile id the app sends in `args`.
#[tauri::command]
pub async fn run_command(
    pool: State<'_, Db>,
    root: State<'_, StorageRoot>,
    daemon: State<'_, DaemonState>,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or(Value::Null);
    Ok(ganban_server::run_in_process(pool.inner(), &root.0, daemon.shares(), &command, args).await?)
}

/// Resolve the desktop database location (`<app_data_dir>/gansty.db`, exactly as
/// before) and open it through core. The daemon owns the *shared* DB; this is
/// the desktop app's own local file.
pub async fn init_desktop_db(app: &tauri::AppHandle) -> Result<Db, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let db_path = app_dir.join("gansty.db");
    // The desktop app is the conflict-producing replica: open with change-capture
    // so a `sync_now` can collect what changed locally and reconcile with the host.
    let db = ganban_core::init_db_role(&db_path, ganban_core::Role::Replica).await?;
    // The desktop runs the command table as the owner (`run_command`), so flag one
    // now instead of relying on the embedded daemon's bootstrap: local mode must
    // work when the daemon is down. Best effort — the bootstrap retries and logs.
    let _ = ganban_core::auth::ensure_owner(&db).await;
    Ok(db)
}

/// Where Ganban keeps its data on this machine, for the Settings → Data &
/// Storage "open folder" links. Desktop-only (these dirs are local).
#[derive(serde::Serialize)]
pub struct StoragePaths {
    /// App data root: holds `gansty.db` and the `shared/` file store.
    pub data_dir: String,
    /// Where logs are written (`ganban-server.log*`, `*-engine.log`).
    pub log_dir: String,
    /// The local database file.
    pub db_path: String,
}

#[tauri::command]
pub fn get_storage_paths(app: tauri::AppHandle) -> Result<StoragePaths, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let db_path = data_dir.join("gansty.db");
    Ok(StoragePaths {
        data_dir: data_dir.to_string_lossy().into_owned(),
        log_dir: log_dir.to_string_lossy().into_owned(),
        db_path: db_path.to_string_lossy().into_owned(),
    })
}

/// Replace a user's profile blob. The desktop is the owner, so it may edit any local
/// profile; networked users edit their own through the host's `set_my_profile`.
#[tauri::command]
pub async fn set_user_profile(pool: State<'_, Db>, user_id: i64, profile_json: Option<String>) -> Result<ganban_core::models::User, String> {
    Ok(ops::set_user_profile(pool.inner(), user_id, profile_json.as_deref()).await?)
}

// ============== Database Backup/Restore Commands ==============
//
// Desktop-only file operations: these copy the SQLite file around using the
// Tauri AppHandle + std::fs and pair with native file dialogs on the frontend.
// They do not translate to a remote/mobile client and are not exposed by the
// daemon.

#[tauri::command]
pub async fn export_database(app: tauri::AppHandle, export_path: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("gansty.db");

    if !db_path.exists() {
        return Err("Database file not found".to_string());
    }

    std::fs::copy(&db_path, &export_path)
        .map_err(|e| format!("Failed to export database: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn import_database(app: tauri::AppHandle, import_path: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("gansty.db");

    if !std::path::Path::new(&import_path).exists() {
        return Err("Import file not found".to_string());
    }

    // Create backup of current database before importing
    let backup_path = app_dir.join("gansty.db.backup");
    if db_path.exists() {
        std::fs::copy(&db_path, &backup_path)
            .map_err(|e| format!("Failed to create backup: {}", e))?;
    }

    // Copy import file to database location
    std::fs::copy(&import_path, &db_path).map_err(|e| {
        // If import fails, try to restore from backup
        if backup_path.exists() {
            let _ = std::fs::copy(&backup_path, &db_path);
        }
        format!("Failed to import database: {}", e)
    })?;

    // Remove backup after successful import
    if backup_path.exists() {
        let _ = std::fs::remove_file(&backup_path);
    }

    Ok(())
}

/// Read a local file's raw bytes (binary IPC). Powers "push local files to
/// host" when this desktop is a CLIENT of a remote host: the legacy
/// attachment's bytes live on THIS machine, so this machine must read and
/// upload them — the host can't reach our disk.
#[tauri::command]
pub fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        path.clone()
    };
    let bytes = std::fs::read(&expanded).map_err(|e| format!("could not read {expanded}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    //! The desktop adapter over the host's command table: `run_command` through
    //! Tauri's IPC (mock runtime), as the webview's `invokeLocal` sends it.
    use super::*;
    use serde_json::json;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};

    fn invoke_local(webview: &tauri::WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
        let request = tauri::webview::InvokeRequest {
            cmd: "run_command".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: json!({ "command": command, "args": args }).into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(webview, request).map(|body| body.deserialize::<Value>().unwrap())
    }

    #[test]
    fn run_command_runs_the_table_in_process_as_the_owner() {
        let dir = std::env::temp_dir().join(format!("gansty_run_command_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("shared")).unwrap();
        let db = tauri::async_runtime::block_on(ganban_core::init_db(&dir.join("gansty.db"))).unwrap();
        let app = mock_builder()
            .manage(db)
            .manage(StorageRoot(dir.join("shared")))
            .manage(DaemonState::default())
            .invoke_handler(tauri::generate_handler![run_command])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

        // The owner: an owner-only command runs, with no signed-in user behind it.
        let project = invoke_local(&webview, "create_project", json!({ "input": { "name": "Local" } })).unwrap();
        let pid = project["id"].as_i64().unwrap();
        let user = invoke_local(&webview, "create_user", json!({ "input": { "username": "mia", "full_name": "Mia" } })).unwrap();
        let task = invoke_local(
            &webview,
            "create_task",
            json!({ "input": { "project_id": pid, "title": "T", "status": "To Do", "priority": "Low" } }),
        )
        .unwrap();

        // Authorship is the profile id the app sends — not stamped, as over HTTP.
        let comment = invoke_local(
            &webview,
            "create_comment",
            json!({ "input": { "task_id": task["id"], "content": "hi", "user_id": user["id"] } }),
        )
        .unwrap();
        assert_eq!(comment["user_id"], user["id"]);

        // The storage root and the build shares reach the table.
        let local = dir.join("original.txt");
        std::fs::write(&local, b"bytes").unwrap();
        let attachment = invoke_local(
            &webview,
            "create_file_attachment",
            json!({ "input": { "task_id": task["id"], "file_path": local.to_string_lossy(), "file_name": "original.txt" } }),
        )
        .unwrap();
        let shared = invoke_local(&webview, "share_file_attachment", json!({ "attachmentId": attachment["id"] })).unwrap();
        assert_eq!(shared["is_shared"], true);
        assert_eq!(invoke_local(&webview, "shared_builds", json!({})).unwrap()["android"], Value::Null);

        // Errors come back as the table's message.
        let err = invoke_local(&webview, "frobnicate", json!({})).unwrap_err();
        assert!(err.as_str().unwrap_or_default().contains("unknown command 'frobnicate'"), "{err}");
    }
}
