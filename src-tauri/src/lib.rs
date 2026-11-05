// The local SQLite stack and the Tauri command surface are desktop-only. On
// mobile (Android/iOS) the app is just the webview shell — all data goes over
// HTTP to the daemon — so `commands` (which depends on `ganban-core`/sqlx) is
// not compiled there. See `commands.rs` and `src-tauri/Cargo.toml`.
#[cfg(desktop)]
mod ai_engine;
#[cfg(desktop)]
mod app_update;
#[cfg(desktop)]
mod commands;
#[cfg(desktop)]
mod daemon_control;
#[cfg(desktop)]
mod demo;
#[cfg(desktop)]
mod file_sync;
#[cfg(desktop)]
mod members;
#[cfg(desktop)]
mod storage_cmds;
#[cfg(desktop)]
mod sync_cmds;
mod text_substitution;
#[cfg(desktop)]
mod window_close;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any webview exists: no smart dashes, quotes or text replacement in
    // the app's fields, so markdown stays as typed (macOS only).
    text_substitution::disable();
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    // Native camera scanning is mobile-only (the plugin exposes `init` only on
    // mobile); the desktop displays the QR instead.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    // The phone updates itself from the host (ADR 0007). Android only: iOS
    // has no sideloading, and the desktop uses Tauri's updater.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_apk_updater::init());

    // Desktop: the app updates itself from its host or from GitHub Releases, chosen per
    // device at run time (ADR 0007, ADR 0008, docs/design/UPDATES.md). Every build with
    // a channel carries the project's key; a host build also its host's. A dev build has
    // neither: the plugin isn't registered and Settings says this build can't update itself.
    #[cfg(desktop)]
    let update_channel = app_update::UpdateChannel::current();
    #[cfg(desktop)]
    let update_build_key = app_update::build_key(context.config());
    #[cfg(desktop)]
    let builder = if app_update::can_update(&update_channel, update_build_key.as_deref()) {
        app_update::prepare_config(context.config_mut());
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };

    // Desktop: open the local database and register the full command surface.
    #[cfg(desktop)]
    let builder = {
        use tauri::Manager;
        builder
            .setup(move |app| {
                app.manage(app_update::AppUpdate::new(update_channel.clone(), update_build_key.clone()));
                // Logging first, so the embedded server's tracing events (and any
                // panic) land in a rolling file under the app's log dir — a
                // bundled .app has no console, so without this they're lost.
                // The guard must outlive the process; leak it deliberately.
                if let Ok(log_dir) = app.path().app_log_dir() {
                    if let Some(guard) = ganban_server::init_logging(&log_dir) {
                        std::mem::forget(guard);
                    }
                }
                // Initialize database (local desktop copy at app_data_dir/gansty.db)
                let pool = tauri::async_runtime::block_on(async {
                    commands::init_desktop_db(&app.handle()).await
                })
                .expect("Failed to initialize database");

                // Store pool in app state
                app.manage(pool);
                // State for the in-process daemon the desktop can host (QR pairing)
                app.manage(daemon_control::DaemonState::default());
                // Supervises locally-launched AI engines (Ollama + ragrat).
                app.manage(ai_engine::AiEngineState::default());
                // Chunked streaming uploads to a remote host (file_sync::daemon_upload_*).
                app.manage(file_sync::UploadSessions::default());
                // Uploads streamed from disk (file_sync::daemon_upload_from_disk).
                app.manage(file_sync::DiskUploads::default());
                // Where shared files live: alongside the DB (<app_data_dir>/shared).
                let storage_root = app
                    .path()
                    .app_data_dir()
                    .map(|d| d.join("shared"))
                    .unwrap_or_else(|_| std::path::PathBuf::from("shared"));
                app.manage(ganban_core::storage::StorageRoot(storage_root));

                // The embedded daemon is part of the app, not an optional mode:
                // bring it up at launch (loopback-only) so the AI/tab surface
                // never depends on visiting Sync → "Host this device" first.
                daemon_control::autostart(app.handle().clone());
                // And the AI engines come back if they were running at last
                // shutdown (Start remembers, Stop forgets) — no more manual
                // Settings → Start engines after every host restart.
                ai_engine::autostart(app.handle().clone());

                // Closing a window or quitting runs the pages' saves, and a hung
                // page can't keep a window open (window_close.rs).
                app.manage(window_close::WindowGenerations::default());
                #[cfg(target_os = "macos")]
                if let Err(e) = window_close::install_menu(app.handle()) {
                    eprintln!("couldn't install the app menu's Quit (Cmd+Q won't save open editors first): {e}");
                }

                Ok(())
            })
            .on_window_event(window_close::on_window_event)
            .on_menu_event(|app, event| {
                if event.id() == window_close::QUIT_MENU_ID {
                    window_close::quit_gracefully(app);
                }
            })
            .invoke_handler(tauri::generate_handler![
                // The host's command table, in-process (ADR 0001).
                commands::run_command,
                demo::demo_start,
                demo::demo_stop,
                demo::demo_replay,
                demo::page_capture_start,
                demo::page_capture_stop,
                commands::get_storage_paths,
                file_sync::sync_project_files,
                file_sync::open_remote_file,
                file_sync::daemon_http,
                file_sync::daemon_http_stream,
                file_sync::daemon_upload_start,
                file_sync::daemon_upload_chunk,
                file_sync::daemon_upload_finish,
                file_sync::daemon_upload_cancel,
                file_sync::list_upload_files,
                file_sync::daemon_upload_from_disk,
                file_sync::daemon_upload_from_disk_cancel,
                file_sync::reveal_local_path,
                file_sync::reveal_file,
                commands::set_user_profile,
                commands::read_local_file,
                commands::export_database,
                commands::import_database,
                daemon_control::daemon_start,
                daemon_control::daemon_stop,
                daemon_control::daemon_status,
                daemon_control::daemon_set_build,
                daemon_control::daemon_discover_builds,
                daemon_control::pair_owner_device,
                daemon_control::pair_member_device,
                daemon_control::create_project_invite,
                daemon_control::invite_status,
                daemon_control::list_invites,
                daemon_control::revoke_invite,
                daemon_control::tailscale_check,
                daemon_control::tailscale_share,
                members::member_list,
                members::member_set_role,
                members::member_remove,
                members::device_list,
                members::device_revoke,
                members::contact_invite,
                members::contact_add_to_project,
                storage_cmds::attach_pasted_image,
                storage_cmds::read_attachment_bytes,
                sync_cmds::sync_collect,
                sync_cmds::sync_ingest,
                sync_cmds::sync_ack,
                sync_cmds::get_sync_conflicts,
                sync_cmds::resolve_sync_conflict,
                sync_cmds::sync_status,
                ai_engine::ai_engine_status,
                ai_engine::ai_engine_start,
                ai_engine::ai_engine_stop,
                ai_engine::ai_engine_reclaim_ragrat,
                app_update::update_check,
                app_update::update_sources,
                app_update::update_download,
                app_update::update_install_and_restart,
            ])
    };

    builder
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quitting must not orphan the engines we spawned (a bundled
            // ragrat / an `ollama serve` Ganban started).
            #[cfg(desktop)]
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                ai_engine::shutdown_sync(&app.state::<ai_engine::AiEngineState>());
            }
            #[cfg(mobile)]
            let _ = (app, event);
        });
}
