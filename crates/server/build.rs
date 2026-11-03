use std::process::Command;

fn main() {
    // include_dir! doesn't register its source tree with cargo, so without
    // this a vite rebuild wouldn't re-embed the web UI (feature `embed-web`).
    if std::env::var_os("CARGO_FEATURE_EMBED_WEB").is_some() {
        println!("cargo:rerun-if-changed=../../dist");
    }

    // A build stamp the host reports on /health, so "which build is that host
    // actually running?" has an answer (a restart of a stale binary under a
    // newer UI looked exactly like a bug). Explicit rerun triggers — any
    // rerun-if-changed line disables cargo's "any file in the package" default.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../core/src");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");

    // Tabs kept out of the public tree compile in only where their file is
    // (`src/` is watched above, so adding or removing it reruns this).
    println!("cargo:rustc-check-cfg=cfg(extra_tabs)");
    if std::path::Path::new("src/extra_tabs.rs").exists() {
        println!("cargo:rustc-cfg=extra_tabs");
    }

    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let mut hash = git(&["rev-parse", "--short", "HEAD"]).filter(|h| !h.is_empty()).unwrap_or_else(|| "unknown".into());
    if git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty()) {
        hash.push('+'); // built from uncommitted changes
    }
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=GANBAN_SERVER_BUILD={hash}");
    println!("cargo:rustc-env=GANBAN_SERVER_BUILT_AT={built}");
}
