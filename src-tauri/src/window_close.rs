// Closing a window and quitting the app without losing an open edit, and
// without a hung page keeping a window open.
//
// A window's page saves its open editors when asked to close
// (src/lib/restartFlush.ts, installUnloadFlush): the close waits for the saves,
// then the page destroys the window. Two gaps on the Rust side:
// - If the page's JavaScript hangs, nothing destroys the window, so it can't be
//   closed. Every close request arms a fallback here that destroys the window
//   CLOSE_GRACE later if it's still open. A page can't veto a close for longer
//   than that: none does today (the unload flush always lets the close go on),
//   and a future "unsaved changes?" prompt would need to disarm this.
// - macOS's stock Quit (Cmd+Q) terminates the app without asking any window to
//   close, so the saves never run. The app menu's Quit is replaced with one that
//   closes every window the ordinary way (saves first), then exits.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

/// How long a window may take to close after a close request. The page gives
/// its saves 3 s (restartFlush.ts, CLOSE_WAIT_MS), so this is past it.
pub const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// The app menu's Quit item, ours instead of the stock one.
pub const QUIT_MENU_ID: &str = "ganban-quit";

/// Each window label's lifetime count, bumped when a window is destroyed, so a
/// fallback armed for one window never destroys a later one with the same label.
#[derive(Default)]
pub struct WindowGenerations(Mutex<HashMap<String, u64>>);

impl WindowGenerations {
    fn current(&self, label: &str) -> u64 {
        self.0.lock().map(|m| m.get(label).copied().unwrap_or(0)).unwrap_or(0)
    }
    fn bump(&self, label: &str) {
        if let Ok(mut m) = self.0.lock() {
            *m.entry(label.to_string()).or_insert(0) += 1;
        }
    }
}

/// Hook for `Builder::on_window_event`.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let Some(gens) = window.try_state::<WindowGenerations>() else { return };
    match event {
        WindowEvent::CloseRequested { .. } => {
            let label = window.label().to_string();
            let armed = gens.current(&label);
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(CLOSE_GRACE);
                let gens = app.state::<WindowGenerations>();
                if gens.current(&label) != armed {
                    return; // closed (and maybe reopened) meanwhile
                }
                if let Some(w) = app.get_webview_window(&label) {
                    eprintln!("window {label} didn't close within {CLOSE_GRACE:?} of a close request; destroying it");
                    let _ = w.destroy();
                }
            });
        }
        WindowEvent::Destroyed => gens.bump(window.label()),
        _ => {}
    }
}

/// Quit the way closing every window would: each page runs its saves and closes
/// (or the fallback destroys it), then the app exits. Exiting happens by itself
/// once the last window is gone; the exit here is the backstop.
pub fn quit_gracefully<R: Runtime>(app: &AppHandle<R>) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for w in windows.values() {
        let _ = w.close();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + CLOSE_GRACE + Duration::from_secs(1);
        while Instant::now() < deadline && !app.webview_windows().is_empty() {
            std::thread::sleep(Duration::from_millis(100));
        }
        app.exit(0);
    });
}

/// macOS: the default menu with its Quit item swapped for ours (same title and
/// Cmd+Q), so quitting runs the windows' saves.
#[cfg(target_os = "macos")]
pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        if let Some(MenuItemKind::Predefined(quit)) = app_menu.items()?.into_iter().last() {
            app_menu.remove(&quit)?;
            let title = format!("Quit {}", app.package_info().name);
            app_menu.append(&MenuItem::with_id(app, QUIT_MENU_ID, title, true, Some("CmdOrCtrl+Q"))?)?;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}
