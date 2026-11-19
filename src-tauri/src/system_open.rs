//! Opening things with the user's own apps: a folder, a file, a link, and "Show in folder".
//!
//! macOS and Windows go through `tauri-plugin-opener`. Linux doesn't, because there the plugin
//! can't be trusted to reach the user's defaults:
//!
//! - It runs `xdg-open` found on `PATH`. In the AppImage, `PATH` starts inside the image, and
//!   Tauri's bundler (CLI before 2.12) put the build machine's `xdg-open` there: xdg-utils 1.1.3,
//!   which opens nothing on Plasma 6 and reports success.
//! - Whatever it starts inherits the AppImage's environment: `LD_LIBRARY_PATH` into the image's
//!   old GLib and friends, `XDG_DATA_DIRS`, `GTK_*`, `GIO_EXTRA_MODULES`, `QT_PLUGIN_PATH`. The
//!   system's file manager or browser can then fail to start, or start with the wrong settings.
//! - "Show in folder" asks D-Bus for any `org.freedesktop.FileManager1`, which is whichever file
//!   manager the bus starts, not necessarily the user's default.
//!
//! So on Linux Ganban runs the system's own opener (never one inside the AppImage) with the
//! environment the user had before the AppImage changed it, shows a file with the user's
//! default file manager, and writes to the log which way each open went. Every other program
//! Ganban starts (the AI engines) gets the same environment. [`prepare_linux_session`] sets what
//! GTK and WebKit need before they start. The decisions are pure functions here, tested on every
//! platform; the platform is chosen at run time with `cfg!`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri_plugin_opener::OpenerExt;

const LOG: &str = "ganban::open";

/// True when the system's openers are used instead of the plugin (Linux).
pub const USE_SYSTEM_OPENERS: bool = cfg!(target_os = "linux");

// ---- The environment a started program gets ------------------------------------------------

/// What to change in Ganban's environment before starting another program.
#[derive(Debug, Default, PartialEq)]
pub struct EnvPlan {
    pub remove: Vec<String>,
    pub set: Vec<(String, String)>,
}

/// Variables the AppImage's runtime and AppRun set outright, with no earlier value to restore.
const APPIMAGE_SET: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "PYTHONDONTWRITEBYTECODE"];

/// The environment a program Ganban starts should get: the user's, from before the AppImage.
///
/// The AppImage's AppRun and its GTK hook prepend paths inside the image (`$APPDIR`) to `PATH`,
/// `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and others, and set some variables wholly to such paths
/// (`GTK_PATH`, `GDK_PIXBUF_MODULE_FILE`, `PYTHONHOME`). Every entry inside `$APPDIR` goes; a
/// variable left empty is removed. The hook also forces `GTK_THEME` to Adwaita, so that value
/// goes too (a user's own `GTK_THEME=Adwaita:dark` can't be told apart, and goes with it). `ours` are the
/// variables Ganban set on itself at start, which no other program should inherit. Outside an
/// AppImage (no `APPDIR`), only `ours` are removed.
pub fn child_env(vars: &[(String, String)], ours: &[&str]) -> EnvPlan {
    let appdir = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.as_str()).filter(|v| v.starts_with('/'));
    let hook_theme = vars.iter().find(|(k, _)| k == "APPIMAGE_GTK_THEME").map(|(_, v)| v.as_str());
    let mut plan = EnvPlan::default();
    for (key, value) in vars {
        if ours.contains(&key.as_str()) {
            plan.remove.push(key.clone());
            continue;
        }
        let Some(appdir) = appdir else { continue };
        if APPIMAGE_SET.contains(&key.as_str()) {
            plan.remove.push(key.clone());
            continue;
        }
        if key == "GTK_THEME"
            && (value == "Adwaita:light" || value == "Adwaita:dark" || Some(value.as_str()) == hook_theme)
        {
            plan.remove.push(key.clone());
            continue;
        }
        let inside = |entry: &str| entry.starts_with('/') && Path::new(entry).starts_with(appdir);
        if !value.split(':').any(inside) {
            continue;
        }
        let mut kept: Vec<&str> = value.split(':').filter(|e| !e.is_empty() && !inside(e)).collect();
        if key == "XDG_DATA_DIRS" {
            // The hook puts `/usr/share` in front of the user's list; keep each folder's last place.
            let mut seen = Vec::new();
            kept = kept
                .into_iter()
                .rev()
                .filter(|e| {
                    !seen.contains(e) && {
                        seen.push(*e);
                        true
                    }
                })
                .collect();
            kept.reverse();
        }
        if kept.is_empty() {
            plan.remove.push(key.clone());
        } else {
            plan.set.push((key.clone(), kept.join(":")));
        }
    }
    plan
}

/// `vars` with `plan` applied.
pub fn apply_env(vars: &[(String, String)], plan: &EnvPlan) -> Vec<(String, String)> {
    vars.iter()
        .filter(|(k, _)| !plan.remove.contains(k))
        .map(|(k, v)| {
            (k.clone(), plan.set.iter().find(|(sk, _)| sk == k).map_or_else(|| v.clone(), |(_, sv)| sv.clone()))
        })
        .collect()
}

fn lookup<'a>(vars: &'a [(String, String)], key: &str) -> Option<&'a str> {
    vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

/// A program by name in a `PATH` value: an executable file in one of its absolute folders.
pub fn find_program(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| d.starts_with('/')).map(|d| Path::new(d).join(name)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

// ---- Which program opens what ----------------------------------------------------------------

/// The system's openers, in the order to try them: each opens a file, folder or link with the
/// user's default app for it.
pub fn open_commands(target: &str) -> Vec<(&'static str, Vec<String>)> {
    vec![
        ("xdg-open", vec![target.to_string()]),
        ("gio", vec!["open".to_string(), target.to_string()]),
        ("kde-open", vec![target.to_string()]),
        ("kde-open5", vec![target.to_string()]),
    ]
}

/// The desktop's own file manager, for when the user hasn't chosen one (`XDG_CURRENT_DESKTOP`).
pub fn desktop_file_manager(current_desktop: &str) -> Option<&'static str> {
    current_desktop.split(':').find_map(|d| match d.to_ascii_uppercase().as_str() {
        "KDE" => Some("org.kde.dolphin.desktop"),
        "GNOME" | "UNITY" => Some("org.gnome.Nautilus.desktop"),
        _ => None,
    })
}

/// How a file manager shows a file selected in its folder, for the ones that can.
pub fn select_command(desktop_id: &str, file: &Path) -> Option<(&'static str, Vec<String>)> {
    let file = file.to_string_lossy().into_owned();
    match desktop_id {
        "org.kde.dolphin.desktop" | "dolphin.desktop" => Some(("dolphin", vec!["--select".into(), file])),
        "org.gnome.Nautilus.desktop" | "nautilus.desktop" => Some(("nautilus", vec!["--select".into(), file])),
        _ => None,
    }
}

/// The `mimeapps.list` files in the order the XDG MIME Applications spec reads them.
pub fn mimeapps_files(vars: &[(String, String)]) -> Vec<PathBuf> {
    let home = lookup(vars, "HOME").unwrap_or("/nonexistent");
    let desktops: Vec<String> = lookup(vars, "XDG_CURRENT_DESKTOP")
        .unwrap_or("")
        .split(':')
        .filter(|d| !d.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let config_home = lookup(vars, "XDG_CONFIG_HOME").map_or_else(|| format!("{home}/.config"), str::to_string);
    let data_home = lookup(vars, "XDG_DATA_HOME").map_or_else(|| format!("{home}/.local/share"), str::to_string);
    let mut dirs = vec![PathBuf::from(config_home)];
    dirs.extend(lookup(vars, "XDG_CONFIG_DIRS").unwrap_or("/etc/xdg").split(':').map(PathBuf::from));
    dirs.push(Path::new(&data_home).join("applications"));
    dirs.extend(
        lookup(vars, "XDG_DATA_DIRS")
            .unwrap_or("/usr/local/share:/usr/share")
            .split(':')
            .map(|d| Path::new(d).join("applications")),
    );
    let mut files = Vec::new();
    for dir in dirs.iter().filter(|d| d.is_absolute()) {
        files.extend(desktops.iter().map(|d| dir.join(format!("{d}-mimeapps.list"))));
        files.push(dir.join("mimeapps.list"));
    }
    files
}

/// The first app a `mimeapps.list` names as the default for `mime`.
pub fn default_app(mimeapps: &str, mime: &str) -> Option<String> {
    let mut in_defaults = false;
    for line in mimeapps.lines().map(str::trim) {
        if line.starts_with('[') {
            in_defaults = line == "[Default Applications]";
        } else if in_defaults {
            if let Some((key, apps)) = line.split_once('=') {
                if key.trim() == mime {
                    return apps.split(';').map(str::trim).find(|a| !a.is_empty()).map(str::to_string);
                }
            }
        }
    }
    None
}

/// The user's default file manager and where it came from: their choice in a `mimeapps.list`,
/// else their desktop's own.
pub fn default_file_manager(vars: &[(String, String)]) -> Option<(String, String)> {
    for file in mimeapps_files(vars) {
        if let Some(app) = std::fs::read_to_string(&file).ok().and_then(|s| default_app(&s, "inode/directory")) {
            return Some((app, file.display().to_string()));
        }
    }
    let desktop = lookup(vars, "XDG_CURRENT_DESKTOP")?;
    desktop_file_manager(desktop).map(|app| (app.to_string(), format!("the {desktop} desktop's own")))
}

/// What an opener's exit code means (xdg-utils' codes).
fn exit_meaning(code: Option<i32>) -> &'static str {
    match code {
        Some(1) => "bad arguments",
        Some(2) => "the file doesn't exist",
        Some(3) => "a tool it needs is missing",
        Some(4) => "the open failed",
        None => "killed by a signal",
        _ => "an error",
    }
}

// ---- Running them (Linux) --------------------------------------------------------------------

/// Set when Ganban asked GTK for the desktop's own file dialogs; see [`prepare_linux_session`].
static SET_GTK_USE_PORTAL: AtomicBool = AtomicBool::new(false);
/// Set when Ganban turned WebKit's DMA-BUF renderer off for NVIDIA's driver.
static SET_DMABUF_OFF: AtomicBool = AtomicBool::new(false);

/// Whether to ask GTK for the desktop's own file dialogs through the XDG portal: on KDE, unless
/// the user already set `GTK_USE_PORTAL`. Plasma always ships its portal, and GTK falls back to
/// its own dialog when the portal isn't there.
pub fn wants_portal_file_dialogs(current_desktop: Option<&str>, gtk_use_portal: Option<&str>) -> bool {
    gtk_use_portal.is_none() && current_desktop.is_some_and(|d| d.split(':').any(|d| d.eq_ignore_ascii_case("KDE")))
}

/// Whether to turn WebKitGTK's DMA-BUF renderer off: with NVIDIA's driver it can leave the window
/// blank or crash it. Not when the user already chose.
pub fn wants_dmabuf_off(nvidia_driver: bool, user_set: bool) -> bool {
    nvidia_driver && !user_set
}

/// On Linux, before GTK and WebKit start (while Ganban is one thread): make the file pickers
/// (choose a file, choose a folder, the page's file inputs) KDE's own dialogs on KDE, and keep
/// WebKit off its DMA-BUF renderer on NVIDIA's driver. Programs Ganban starts don't inherit either.
pub fn prepare_linux_session() {
    if !USE_SYSTEM_OPENERS {
        return;
    }
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    let set = std::env::var("GTK_USE_PORTAL").ok();
    if wants_portal_file_dialogs(desktop.as_deref(), set.as_deref()) {
        std::env::set_var("GTK_USE_PORTAL", "1");
        SET_GTK_USE_PORTAL.store(true, Ordering::Relaxed);
    }
    let nvidia = Path::new("/proc/driver/nvidia/version").exists();
    if wants_dmabuf_off(nvidia, std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        SET_DMABUF_OFF.store(true, Ordering::Relaxed);
    }
}

/// Ganban's environment as a started program should get it, and a note for the log.
fn clean_env() -> (Vec<(String, String)>, EnvPlan) {
    let vars: Vec<(String, String)> =
        std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let mut ours = Vec::new();
    if SET_GTK_USE_PORTAL.load(Ordering::Relaxed) {
        ours.push("GTK_USE_PORTAL");
    }
    if SET_DMABUF_OFF.load(Ordering::Relaxed) {
        ours.push("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
    let plan = child_env(&vars, &ours);
    (apply_env(&vars, &plan), plan)
}

/// Give `cmd` the user's environment: what every program Ganban starts should get (on macOS
/// and Windows, and outside an AppImage, it changes nothing).
pub fn give_user_env(cmd: &mut Command) {
    let (_, plan) = clean_env();
    apply_plan(cmd, &plan);
}

fn apply_plan(cmd: &mut Command, plan: &EnvPlan) {
    for key in &plan.remove {
        cmd.env_remove(key);
    }
    for (key, value) in &plan.set {
        cmd.env(key, value);
    }
}

/// A program on the user's `PATH` (never one inside the AppImage).
pub fn find_on_user_path(name: &str) -> Option<PathBuf> {
    let (env, _) = clean_env();
    find_program(name, lookup(&env, "PATH")?)
}

fn env_note(plan: &EnvPlan) -> String {
    if plan.set.is_empty() && plan.remove.is_empty() {
        return "Ganban's environment as is".into();
    }
    let set: Vec<&str> = plan.set.iter().map(|(k, _)| k.as_str()).collect();
    format!("the user's environment (restored {}; removed {})", set.join(" "), plan.remove.join(" "))
}

/// Start `program` with Ganban's environment changed by `plan` (the user's). Ok when it's still
/// running after a moment or exited 0; Err with the reason when it couldn't start or failed.
fn start(program: &Path, args: &[String], plan: &EnvPlan) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    apply_plan(&mut cmd, plan);
    let mut tries = 0;
    let mut child = loop {
        match cmd.spawn() {
            // ETXTBSY: the file was just written and another thread's fork still holds it open.
            Err(e) if e.raw_os_error() == Some(26) && tries < 5 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            other => break other.map_err(|e| format!("couldn't start: {e}"))?,
        }
    };
    // Openers hand over and exit; a failing one exits at once with a reason. One still running
    // after a moment is the app itself (some openers run it in the foreground): reap it later.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "exited {} ({})",
                    status.code().map_or("-".into(), |c| c.to_string()),
                    exit_meaning(status.code())
                ))
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                // Still running: log how it ends, so a late failure shows in the log too.
                let program = program.display().to_string();
                std::thread::spawn(move || match child.wait() {
                    Ok(status) if !status.success() => tracing::warn!(
                        target: LOG,
                        "{program} exited {} ({}) after the open was taken as done",
                        status.code().map_or("-".into(), |c| c.to_string()),
                        exit_meaning(status.code())
                    ),
                    _ => {}
                });
                return Ok(());
            }
            Err(e) => return Err(format!("couldn't wait for it: {e}")),
        }
    }
}

/// Open `target` (a path or a link) with the user's default app for it, trying the system's
/// openers in turn. `what` names the action in the log.
fn open_linux(target: &str, what: &str) -> Result<(), String> {
    let (env, plan) = clean_env();
    open_in(target, what, &env, &plan)
}

/// [`open_linux`] in a given environment (`env`, already cleaned by `plan`).
fn open_in(target: &str, what: &str, env: &[(String, String)], plan: &EnvPlan) -> Result<(), String> {
    let path = lookup(env, "PATH").unwrap_or("/usr/local/bin:/usr/bin:/bin").to_string();
    let desktop = lookup(env, "XDG_CURRENT_DESKTOP").unwrap_or("unknown").to_string();
    let mut tried = Vec::new();
    for (name, args) in open_commands(target) {
        let Some(program) = find_program(name, &path) else { continue };
        match start(&program, &args, plan) {
            Ok(()) => {
                tracing::info!(target: LOG, "{what} {target}: {} on {desktop}, with {}", program.display(), env_note(plan));
                return Ok(());
            }
            Err(e) => {
                tracing::warn!(target: LOG, "{what} {target}: {} {e}", program.display());
                tried.push(format!("{} {e}", program.display()));
            }
        }
    }
    let why =
        if tried.is_empty() { format!("no xdg-open, gio or kde-open on PATH ({path})") } else { tried.join("; ") };
    tracing::error!(target: LOG, "{what} {target}: nothing opened it: {why}");
    Err(format!("Couldn't open it: {why}"))
}

/// Show `file` in the user's default file manager, selected where that file manager can do it,
/// else its folder.
fn reveal_linux(file: &Path) -> Result<(), String> {
    let (env, plan) = clean_env();
    let path = lookup(&env, "PATH").unwrap_or("/usr/local/bin:/usr/bin:/bin").to_string();
    let default = default_file_manager(&env);
    if let Some((app, from)) = &default {
        if let Some((name, args)) = select_command(app, file) {
            if let Some(program) = find_program(name, &path) {
                match start(&program, &args, &plan) {
                    Ok(()) => {
                        tracing::info!(target: LOG, "show {}: {} --select (default file manager {app}, from {from}), with {}", file.display(), program.display(), env_note(&plan));
                        return Ok(());
                    }
                    Err(e) => tracing::warn!(target: LOG, "show {}: {} {e}", file.display(), program.display()),
                }
            }
        }
    }
    let manager = default.map_or_else(|| "none found".to_string(), |(app, from)| format!("{app}, from {from}"));
    tracing::info!(target: LOG, "show {}: opening its folder instead (default file manager: {manager})", file.display());
    let dir = file.parent().unwrap_or(file);
    open_linux(&dir.to_string_lossy(), "show (folder)")
}

// ---- The four actions ------------------------------------------------------------------------

/// Open a folder or a file with the user's default app for it.
pub fn open_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> Result<(), String> {
    if !USE_SYSTEM_OPENERS {
        return app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
    }
    if !path.is_absolute() {
        return Err(format!("{} isn't a full path", path.display()));
    }
    std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    open_linux(&path.to_string_lossy(), if path.is_dir() { "open folder" } else { "open file" })
}

/// Show a file selected in its folder.
pub fn reveal<R: tauri::Runtime>(app: &tauri::AppHandle<R>, file: &Path) -> Result<(), String> {
    if !USE_SYSTEM_OPENERS {
        return app.opener().reveal_item_in_dir(file).map_err(|e| e.to_string());
    }
    reveal_linux(file)
}

/// The links Ganban opens outside: the web, mail and phone numbers (the plugin's default scope).
pub fn is_openable_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    ["http://", "https://", "mailto:", "tel:"].iter().any(|s| lower.starts_with(s))
}

/// Open a link in the user's default browser (or mail app, or phone app).
pub fn open_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Result<(), String> {
    if !is_openable_url(url) {
        return Err(format!("Ganban only opens web, mail and phone links, not {url}"));
    }
    if !USE_SYSTEM_OPENERS {
        return app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
    }
    open_linux(url, "open link")
}

/// Run a blocking open off the async runtime: an opener can take a moment to hand over.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Open a folder or file on this machine (the Files tab, attachments, the storage folder).
#[tauri::command]
pub async fn system_open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    blocking(move || open_path(&app, Path::new(&path))).await
}

/// Open a link outside Ganban.
#[tauri::command]
pub async fn system_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    blocking(move || open_url(&app, &url)).await
}

/// On Linux, links the page opens in a new window (`target="_blank"`, or Ctrl/Shift-click) go
/// through [`system_open_url`]; the plugin's own handler is off there. The same rules as the
/// plugin's script.
const LINKS_SCRIPT: &str = r#"window.addEventListener("click", function (e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey) return;
  var a = e.composedPath().find(function (n) { return n instanceof Node && n.nodeName.toUpperCase() === "A"; });
  if (!a || !a.href || (a.target !== "_blank" && !e.ctrlKey && !e.shiftKey)) return;
  var url = new URL(a.href);
  if (["http:", "https:", "mailto:", "tel:"].indexOf(url.protocol) < 0) return;
  e.preventDefault();
  window.__TAURI_INTERNALS__.invoke("system_open_url", { url: url.href }).catch(function (err) { console.error(err); });
});"#;

/// The plugin that installs [`LINKS_SCRIPT`] in every window.
pub fn links_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ganban-links").js_init_script(LINKS_SCRIPT).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    const APPDIR: &str = "/tmp/.mount_GanbanX1";

    /// The environment the 1.0.11 AppImage gives Ganban: its AppRun and GTK hook over a user's.
    fn appimage_env() -> Vec<(String, String)> {
        vars(&[
            ("APPDIR", APPDIR),
            ("APPIMAGE", "/home/me/Apps/Ganban_1.0.11_amd64.AppImage"),
            ("ARGV0", "./Ganban.AppImage"),
            ("OWD", "/home/me"),
            ("HOME", "/home/me"),
            ("PATH", "/tmp/.mount_GanbanX1/usr/bin/:/tmp/.mount_GanbanX1/usr/sbin/:/tmp/.mount_GanbanX1/usr/games/:/tmp/.mount_GanbanX1/bin/:/tmp/.mount_GanbanX1/sbin/:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_GanbanX1/usr/lib/:/tmp/.mount_GanbanX1/lib/x86_64-linux-gnu/:"),
            ("XDG_DATA_DIRS", "/tmp/.mount_GanbanX1/usr/share/:/tmp/.mount_GanbanX1/usr/share:/usr/share:/home/me/.local/share/flatpak/exports/share:/usr/local/share:/usr/share"),
            ("PYTHONHOME", "/tmp/.mount_GanbanX1/usr/"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("GTK_PATH", "/tmp/.mount_GanbanX1//usr/lib/gtk-3.0"),
            ("GTK_THEME", "Adwaita:dark"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_GanbanX1//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ("QT_PLUGIN_PATH", "/tmp/.mount_GanbanX1/usr/lib/qt5/plugins/:/usr/lib/qt6/plugins"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
            ("KDE_SESSION_VERSION", "6"),
            ("BROWSER_URL", "https://example.com/a:b"),
        ])
    }

    #[test]
    fn the_appimage_environment_is_undone() {
        let env = apply_env(&appimage_env(), &child_env(&appimage_env(), &[]));
        let get = |k: &str| lookup(&env, k);
        assert_eq!(get("PATH"), Some("/usr/local/bin:/usr/bin"));
        assert_eq!(get("LD_LIBRARY_PATH"), None);
        assert_eq!(
            get("XDG_DATA_DIRS"),
            Some("/home/me/.local/share/flatpak/exports/share:/usr/local/share:/usr/share")
        );
        assert_eq!(get("QT_PLUGIN_PATH"), Some("/usr/lib/qt6/plugins"));
        for gone in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "PYTHONHOME",
            "PYTHONDONTWRITEBYTECODE",
            "GTK_PATH",
            "GTK_THEME",
            "GDK_PIXBUF_MODULE_FILE",
        ] {
            assert_eq!(get(gone), None, "{gone}");
        }
        for kept in ["HOME", "XDG_CURRENT_DESKTOP", "KDE_SESSION_VERSION", "BROWSER_URL"] {
            assert_eq!(get(kept), lookup(&appimage_env(), kept), "{kept}");
        }
    }

    #[test]
    fn outside_an_appimage_only_ganbans_own_variables_go() {
        let user = vars(&[("PATH", "/usr/bin"), ("GTK_THEME", "Adwaita:dark"), ("GTK_USE_PORTAL", "1")]);
        assert_eq!(child_env(&user, &[]), EnvPlan::default());
        assert_eq!(child_env(&user, &["GTK_USE_PORTAL"]).remove, vec!["GTK_USE_PORTAL".to_string()]);
    }

    #[test]
    fn a_user_theme_survives_inside_the_appimage() {
        let env = vars(&[("APPDIR", APPDIR), ("GTK_THEME", "Breeze:dark")]);
        assert_eq!(child_env(&env, &[]).remove, vec!["APPDIR".to_string()]);
    }

    /// A fake opener that records its arguments and environment, then exits with `code`.
    fn fake_opener(dir: &Path, name: &str, code: i32) {
        std::fs::create_dir_all(dir).unwrap();
        let out = dir.join(format!("{name}.out"));
        let script = format!("#!/bin/sh\n{{ echo \"$@\"; /usr/bin/env; }} > '{}'\nexit {code}\n", out.display());
        std::fs::write(dir.join(name), script).unwrap();
        Command::new("chmod").arg("+x").arg(dir.join(name)).status().unwrap();
    }

    #[test]
    fn the_system_opener_runs_with_the_users_environment_never_the_bundled_one() {
        let root = std::env::temp_dir().join(format!("ganban_open_run_{}", std::process::id()));
        let appdir = root.join("mount");
        let system = root.join("system");
        fake_opener(&appdir.join("usr/bin"), "xdg-open", 0);
        fake_opener(&system, "xdg-open", 4); // fails: the next opener is tried
        fake_opener(&system, "gio", 0);
        let (a, s) = (appdir.display().to_string(), system.display().to_string());
        let ganban = vars(&[
            ("APPDIR", &a),
            ("PATH", &format!("{a}/usr/bin/:{s}")),
            ("LD_LIBRARY_PATH", &format!("{a}/usr/lib/:")),
            ("XDG_CURRENT_DESKTOP", "KDE"),
        ]);
        let plan = child_env(&ganban, &[]);
        open_in("/home/me/Documents", "open folder", &apply_env(&ganban, &plan), &plan).unwrap();

        assert!(!appdir.join("usr/bin/xdg-open.out").exists(), "the bundled xdg-open never runs");
        assert!(system.join("xdg-open.out").exists(), "the system's xdg-open ran first");
        let seen = std::fs::read_to_string(system.join("gio.out")).unwrap();
        assert!(seen.starts_with("open /home/me/Documents\n"), "{seen}");
        assert!(seen.contains(&format!("PATH={s}\n")), "{seen}");
        // The rest of Ganban's environment is inherited as is.
        assert!(seen.contains(&format!("HOME={}\n", std::env::var("HOME").unwrap())), "{seen}");
        assert!(!seen.contains("LD_LIBRARY_PATH") && !seen.contains("APPDIR"), "{seen}");

        // Every opener failing is an error that says why.
        fake_opener(&system, "gio", 3);
        let err = open_in("/x", "open folder", &apply_env(&ganban, &plan), &plan).unwrap_err();
        assert!(
            err.contains("exited 4 (the open failed)") && err.contains("exited 3 (a tool it needs is missing)"),
            "{err}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn programs_are_found_only_where_path_says() {
        let dir = std::env::temp_dir().join(format!("ganban_open_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin/xdg-open"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("bin/not-executable"), "").unwrap();
        Command::new("chmod").arg("+x").arg(dir.join("bin/xdg-open")).status().unwrap();
        let bin = dir.join("bin").to_string_lossy().into_owned();
        assert_eq!(find_program("xdg-open", &format!("/nonexistent:{bin}")), Some(dir.join("bin/xdg-open")));
        assert_eq!(find_program("xdg-open", "/nonexistent"), None);
        assert_eq!(find_program("xdg-open", "relative/bin"), None);
        assert_eq!(find_program("not-executable", &bin), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_default_file_manager_is_read_like_the_spec() {
        let list = "[Added Associations]\ninode/directory=nemo.desktop;\n\n[Default Applications]\ntext/plain=kate.desktop\ninode/directory = org.kde.dolphin.desktop;nemo.desktop;\n";
        assert_eq!(default_app(list, "inode/directory").as_deref(), Some("org.kde.dolphin.desktop"));
        assert_eq!(default_app("[Added Associations]\ninode/directory=nemo.desktop;\n", "inode/directory"), None);

        let env = vars(&[("HOME", "/home/me"), ("XDG_CURRENT_DESKTOP", "KDE"), ("XDG_DATA_DIRS", "/usr/share")]);
        let files: Vec<String> = mimeapps_files(&env).iter().map(|p| p.display().to_string()).collect();
        assert_eq!(
            files,
            [
                "/home/me/.config/kde-mimeapps.list",
                "/home/me/.config/mimeapps.list",
                "/etc/xdg/kde-mimeapps.list",
                "/etc/xdg/mimeapps.list",
                "/home/me/.local/share/applications/kde-mimeapps.list",
                "/home/me/.local/share/applications/mimeapps.list",
                "/usr/share/applications/kde-mimeapps.list",
                "/usr/share/applications/mimeapps.list",
            ]
        );
        // No list names one (this HOME doesn't exist): the desktop's own.
        let none = vars(&[
            ("HOME", "/nonexistent-ganban"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
            ("XDG_CONFIG_DIRS", "/nonexistent-ganban"),
            ("XDG_DATA_DIRS", "/nonexistent-ganban"),
        ]);
        assert_eq!(default_file_manager(&none).map(|(app, _)| app).as_deref(), Some("org.kde.dolphin.desktop"));
    }

    #[test]
    fn file_managers_that_can_select_do() {
        let f = Path::new("/home/me/a b.pdf");
        assert_eq!(
            select_command("org.kde.dolphin.desktop", f),
            Some(("dolphin", vec!["--select".into(), "/home/me/a b.pdf".into()]))
        );
        assert_eq!(select_command("org.gnome.Nautilus.desktop", f).map(|c| c.0), Some("nautilus"));
        assert_eq!(select_command("thunar.desktop", f), None);
        assert_eq!(desktop_file_manager("ubuntu:GNOME"), Some("org.gnome.Nautilus.desktop"));
        assert_eq!(desktop_file_manager("Hyprland"), None);
    }

    #[test]
    fn the_portal_file_dialogs_are_asked_for_on_kde_only() {
        assert!(wants_portal_file_dialogs(Some("KDE"), None));
        assert!(!wants_portal_file_dialogs(Some("KDE"), Some("0")));
        assert!(!wants_portal_file_dialogs(Some("GNOME"), None));
        assert!(!wants_portal_file_dialogs(None, None));
        assert!(wants_dmabuf_off(true, false));
        assert!(!wants_dmabuf_off(true, true));
        assert!(!wants_dmabuf_off(false, false));
    }

    #[test]
    fn only_web_mail_and_phone_links_open() {
        assert!(is_openable_url("https://ganban.app"));
        assert!(is_openable_url("mailto:a@b.c"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert_eq!(open_commands("x")[0], ("xdg-open", vec!["x".to_string()]));
    }
}
