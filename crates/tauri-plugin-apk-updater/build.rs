// The commands live in Kotlin (android/), not Rust: Tauri forwards
// `plugin:apk-updater|<command>` to the registered Android plugin. Listing them
// here generates their `allow-*` permissions.
const COMMANDS: &[&str] = &["apk_version", "apk_download", "apk_install"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
