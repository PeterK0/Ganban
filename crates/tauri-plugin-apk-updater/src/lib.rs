//! The phone updates itself from the host (ADR 0007, docs/design/UPDATES.md).
//!
//! Android only: the commands (`apk_version`, `apk_download`, `apk_install`) are
//! Kotlin (`android/src/main/java/ApkUpdaterPlugin.kt`); Tauri forwards
//! `plugin:apk-updater|…` calls to it. On every other target the crate is
//! empty and the app doesn't register it.
#![cfg(target_os = "android")]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

const PLUGIN_IDENTIFIER: &str = "app.ganban.apkupdater";

/// Initializes the plugin (register it on Android only).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .setup(|_app, api| {
            api.register_android_plugin(PLUGIN_IDENTIFIER, "ApkUpdaterPlugin")?;
            Ok(())
        })
        .build()
}
