//! Native build artifacts the daemon can offer at `/download`. Discovery scans
//! the host's standard Tauri output dirs (plus an optional watched folder), so an
//! owner can pick which build to serve — whether they're ON the host (Tauri
//! command) or a remote client driving it over `/invoke`. Nothing is uploaded:
//! the file already lives on the host, so a share is just a path the daemon
//! streams. Single source of truth for both call sites (the desktop crate's
//! `daemon_*` commands delegate here).

use serde::Serialize;
use std::path::{Path, PathBuf};

/// A build artifact found on the host's disk, ready to be made downloadable.
#[derive(Serialize, Clone)]
pub struct DiscoveredBuild {
    /// android | windows | macos | linux | server, or "" when the extension is
    /// ambiguous (a .zip could be the Windows portable build or a zipped server) —
    /// the owner then assigns the platform before making it available.
    pub kind: String,
    pub path: String,
    pub file_name: String,
    pub size: u64,
}

/// Map a file name to a platform key by extension (unambiguous types only).
pub fn ext_kind(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.ends_with(".apk") {
        Some("android")
    } else if n.ends_with(".msi") || n.ends_with(".exe") {
        Some("windows")
    } else if n.ends_with(".dmg") || n.ends_with(".pkg") {
        Some("macos")
    } else if n.ends_with(".appimage") || n.ends_with(".deb") || n.ends_with(".rpm") {
        Some("linux")
    } else {
        None
    }
}

/// Build-ish files whose platform can't be inferred from the extension: a `.zip`
/// (Windows portable build, or a zipped server), a server tarball, or the bare
/// headless `ganban-server` binary. Surfaced with an empty kind so the owner can
/// assign the platform (esp. Windows vs Server).
fn assignable_candidate(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".zip") || n.ends_with(".tar.gz") || n.ends_with(".tgz") || n.starts_with("ganban-server")
}

/// Collect installer-like files directly inside `dir`.
fn collect_dir(dir: &Path, out: &mut Vec<DiscoveredBuild>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        // Known extension → assign the platform; ambiguous build file → empty kind
        // (the owner assigns it). Anything else is ignored.
        let kind = match ext_kind(name) {
            Some(k) => k.to_string(),
            None if assignable_candidate(name) => String::new(),
            None => continue,
        };
        out.push(DiscoveredBuild {
            kind,
            path: p.to_string_lossy().into_owned(),
            file_name: name.to_string(),
            size: e.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
}

/// Walk up from the working directory to the repo root (the dir holding `src-tauri`).
fn project_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("src-tauri").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Scan the standard Tauri build-output locations under the repo root. Desktop
/// bundles can land in the workspace-root `target/` OR `src-tauri/target/`
/// depending on how the build was invoked, so check both.
fn discover_repo(root: &Path, out: &mut Vec<DiscoveredBuild>) {
    for profile in ["release", "debug"] {
        collect_dir(
            &root.join(format!("src-tauri/gen/android/app/build/outputs/apk/universal/{profile}")),
            out,
        );
        for target_base in ["target", "src-tauri/target"] {
            let bundle = root.join(format!("{target_base}/{profile}/bundle"));
            for sub in ["dmg", "msi", "nsis", "appimage", "deb", "rpm"] {
                collect_dir(&bundle.join(sub), out);
            }
        }
    }
}

/// Auto-discover built artifacts: the repo's standard Tauri outputs, plus any
/// loose installers in an optional `base` folder (e.g. a collected-builds dir).
pub fn discover(base: Option<String>) -> Vec<DiscoveredBuild> {
    let mut out = Vec::new();
    if let Some(root) = project_root() {
        discover_repo(&root, &mut out);
    }
    if let Some(b) = base.filter(|s| !s.trim().is_empty()) {
        collect_dir(Path::new(&b), &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}
