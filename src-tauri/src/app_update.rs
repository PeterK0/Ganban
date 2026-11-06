//! Desktop-only: the app updates itself (ADR 0007, ADR 0008, docs/design/UPDATES.md).
//! Tauri's updater plugin does the work; these commands drive it with RUN-TIME
//! endpoints and keys, chosen by the device's update source (Settings → Updates):
//!
//! - **This server**: the host this app is connected to, with the device token.
//!   Plain http is allowed (the tailnet; the signature guards integrity). The key is
//!   the one the device pinned for the host (the frontend pins what the host
//!   advertises, and asks before trusting a change), else the key the build was
//!   made with (a host build's own host).
//! - **GitHub Releases**: the repo's latest release (`latest.json`), https, never the
//!   device token, checked against the project's public key (`updater/github.pub`),
//!   which every build carries, so a host build can switch back to GitHub.
//!
//! The build's channel (`VITE_UPDATE_CHANNEL`, fixed at build time) only sets the
//! default source. A device on the other source accepts any different version, so it
//! can move across (a host build's `1.0.<count>` is no newer or older than a
//! release's number); on its own channel's source only a newer version counts.
//!
//! The flow is check → download (in the background, with progress) → install and
//! restart (on the owner's click). The downloaded bundle stays in memory until the
//! click: the signature is checked at download, the swap happens at install.
//!
//! A dev build (no channel and no key) doesn't register the plugin, and
//! `update_check` says it can't update itself. Neither does a build a distribution
//! package installed (`package_manager`): its package manager updates it.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The project's updater public key (minisign, base64): what GitHub Releases' bundles
/// are signed for. Public; every build carries it.
pub const GITHUB_PUBKEY: &str = include_str!("../updater/github.pub");

/// The updater's state for this run: whether this build can update itself, the
/// update the last check found, and the bundle once it's downloaded.
#[derive(Default)]
pub struct AppUpdate {
    pub enabled: bool,
    /// The package manager that installed this build, if one did (`package_manager`).
    managed_by: Option<String>,
    channel: Option<UpdateChannel>,
    /// The updater key the build was made with (a host build's host), if any.
    build_key: Option<String>,
    /// The GitHub repo this build may update from.
    repo: Option<String>,
    found: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
    busy: Mutex<bool>,
}

impl AppUpdate {
    pub fn new(channel: UpdateChannel, build_key: Option<String>, managed_by: Option<String>) -> Self {
        let enabled = can_update(&channel, build_key.as_deref()) && managed_by.is_none();
        let repo = match &channel {
            UpdateChannel::Github { repo } => Some(repo.clone()),
            _ => build_repo(option_env!("VITE_UPDATE_REPO")),
        };
        Self { enabled, managed_by, channel: Some(channel), build_key, repo, ..Default::default() }
    }

    /// Why this build can't update itself, when it can't.
    fn why_not(&self) -> String {
        match &self.managed_by {
            Some(pm) => managed_reason(pm),
            None => NO_KEY.into(),
        }
    }
}

/// The marker a distribution package installs (the Arch package `ganban-bin` writes
/// `pacman` into it), relative to the install prefix: `<prefix>/bin/gansty` reads
/// `<prefix>/share/ganban/package-manager`. Relative, so an AppImage (its own prefix
/// inside its mount) never sees a package's marker on the same machine.
pub const PACKAGE_MARKER: &str = "share/ganban/package-manager";

/// The package manager that installed this build, from `PACKAGE_MARKER` beside the
/// running executable. Such a build doesn't update itself: Tauri's updater would replace
/// the package's files behind the package manager's back (or run `dpkg` on Arch).
pub fn package_manager() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    package_manager_for(&exe.canonicalize().unwrap_or(exe))
}

/// `package_manager` for the executable at `exe`: the marker's first line, or "your
/// package manager" when it's empty.
pub fn package_manager_for(exe: &std::path::Path) -> Option<String> {
    let prefix = exe.parent()?.parent()?;
    let text = std::fs::read_to_string(prefix.join(PACKAGE_MARKER)).ok()?;
    let name = text.lines().next().unwrap_or("").trim();
    Some(if name.is_empty() { "your package manager".into() } else { name.to_string() })
}

/// What Settings → Updates says on a packaged install.
pub fn managed_reason(pm: &str) -> String {
    if pm == "your package manager" {
        "Ganban is updated by your package manager, not by itself.".into()
    } else {
        format!("Ganban is updated by your package manager ({pm}), not by itself.")
    }
}

/// A GitHub build updates itself (it carries the project key); a host build when it was
/// made with its host's key. A dev build has neither.
pub fn can_update(channel: &UpdateChannel, build_key: Option<&str>) -> bool {
    !matches!(channel, UpdateChannel::Host) || build_key.is_some()
}

/// The updater public key in the build's config, if any. The host's build injects
/// `plugins.updater.pubkey` with a `--config` override (the host's key); the release
/// workflow injects the project's. A dev or hand-made build has none.
pub fn build_key(config: &tauri::Config) -> Option<String> {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

/// Where this build updates from by default, fixed at build time (`VITE_UPDATE_CHANNEL`,
/// read by the frontend too, and `VITE_UPDATE_REPO` for `github`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateChannel {
    /// The connected host. Also a build with no channel set (host builds made before
    /// channels existed, and dev builds).
    Host,
    /// GitHub Releases of `owner/repo`.
    Github { repo: String },
    /// `github` without a usable repo: GitHub Releases isn't available to it.
    Broken(String),
}

impl UpdateChannel {
    pub fn from_build(channel: Option<&str>, repo: Option<&str>) -> Self {
        match channel.map(str::trim).unwrap_or("") {
            "github" => match build_repo(repo) {
                Some(r) => UpdateChannel::Github { repo: r },
                None => UpdateChannel::Broken(format!(
                    "This build can't update from GitHub: its GitHub repository ({}) isn't owner/name.",
                    repo.unwrap_or("none")
                )),
            },
            _ => UpdateChannel::Host,
        }
    }

    /// This build's channel.
    pub fn current() -> Self {
        Self::from_build(option_env!("VITE_UPDATE_CHANNEL"), option_env!("VITE_UPDATE_REPO"))
    }

    /// The source a build on this channel updates from when the device hasn't chosen.
    fn own_source(&self) -> Source {
        match self {
            UpdateChannel::Host => Source::Host,
            _ => Source::Github,
        }
    }
}

fn build_repo(repo: Option<&str>) -> Option<String> {
    repo.map(str::trim).filter(|r| valid_repo(r)).map(str::to_string)
}

/// `owner/name`, GitHub's characters only, so it can't steer the URL elsewhere.
fn valid_repo(r: &str) -> bool {
    let mut parts = r.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// Ready the plugin's config for run-time sources: a key it can start with (the build's,
/// else the project's; each check sets its own) and plain http allowed, since a host on
/// the tailnet is http (the bundle's signature guards its integrity, not TLS). The GitHub
/// endpoint is a fixed https URL either way. Only called when the build can update.
pub fn prepare_config(config: &mut tauri::Config) {
    let entry = config.plugins.0.entry("updater".to_string()).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    if let serde_json::Value::Object(u) = entry {
        let has_key = u.get("pubkey").and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty());
        if !has_key {
            u.insert("pubkey".into(), serde_json::Value::String(GITHUB_PUBKEY.trim().to_string()));
        }
        u.insert("dangerousInsecureTransportProtocol".into(), serde_json::Value::Bool(true));
    }
}

/// The GitHub source's endpoint: the repo's latest release's `latest.json`, which the
/// release workflow composes from the signed bundles.
pub fn github_endpoint(repo: &str) -> Result<tauri::Url, String> {
    if !valid_repo(repo) {
        return Err(format!("Bad GitHub repository {repo}"));
    }
    tauri::Url::parse(&format!("https://github.com/{repo}/releases/latest/download/latest.json")).map_err(|e| e.to_string())
}

/// The endpoint the updater asks: the host's
/// `/updates/desktop/{{target}}/{{arch}}/{{current_version}}`. The plugin fills
/// the placeholders in.
pub fn endpoint_url(base_url: &str) -> Result<tauri::Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("No host to update from. Connect to your host first.".into());
    }
    let url = format!("{base}/updates/desktop/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}");
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("Bad host address {base}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Bad host address {base}: not http(s)"));
    }
    Ok(parsed)
}

/// Where a device updates from (Settings → Updates).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Github,
    Host,
}

impl Source {
    /// The device's choice ("github" or "host"), else the channel's default.
    pub fn parse(s: Option<&str>, channel: &UpdateChannel) -> Self {
        match s.map(str::trim) {
            Some("github") => Source::Github,
            Some("host") => Source::Host,
            _ => channel.own_source(),
        }
    }
}

/// One check's endpoint and key.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub endpoint: tauri::Url,
    pub pubkey: String,
    /// Send the device token (the host only, never GitHub).
    pub send_token: bool,
    /// The device is on the other channel's source: any different version counts.
    pub cross: bool,
}

/// Pick the endpoint and the key for `source`. GitHub: the project key, always. The host:
/// the key the device pinned for it, else the build's own (a host build's host).
pub fn plan(
    source: Source,
    channel: &UpdateChannel,
    repo: Option<&str>,
    build_key: Option<&str>,
    host_key: Option<&str>,
    base_url: &str,
) -> Result<Plan, String> {
    let cross = source != channel.own_source();
    match source {
        Source::Github => {
            let repo = repo.ok_or_else(|| match channel {
                UpdateChannel::Broken(why) => why.clone(),
                _ => "This build doesn't know its GitHub repository.".to_string(),
            })?;
            Ok(Plan { endpoint: github_endpoint(repo)?, pubkey: GITHUB_PUBKEY.trim().to_string(), send_token: false, cross })
        }
        Source::Host => {
            let pinned = host_key.map(str::trim).filter(|k| !k.is_empty());
            // A host build trusts the key it was built with; a GitHub build's config key is
            // the project's, which says nothing about the host.
            let own = if matches!(channel, UpdateChannel::Host) { build_key } else { None };
            let pubkey = pinned.or(own).ok_or("No update key for this server yet. Choose This server in Settings → Updates to trust its key.")?;
            Ok(Plan { endpoint: endpoint_url(base_url)?, pubkey: pubkey.to_string(), send_token: true, cross })
        }
    }
}

pub const NO_KEY: &str = "This build can't update itself: it was built without an update key. Install a build from GitHub Releases or your host once.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// False when this build can't update itself (see `NO_KEY`).
    pub can_update: bool,
    /// This app's version.
    pub current: String,
    /// The other version the source offers (newer, or any different one across sources), or none.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// Why this build can't update itself, when it can't.
    pub reason: Option<String>,
}

/// What this build knows about its update sources, for Settings → Updates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSources {
    pub enabled: bool,
    /// "host" or "github": the build's channel, the default source.
    pub channel: &'static str,
    /// The GitHub repo it may update from.
    pub repo: Option<String>,
    /// Why GitHub Releases isn't available, when it isn't.
    pub github_reason: Option<String>,
    /// The project's public key (GitHub Releases).
    pub github_key: String,
    /// The key a host build was made with (its host's), trusted for This server until the
    /// device pins one.
    pub build_key: Option<String>,
}

#[tauri::command]
pub fn update_sources(state: State<'_, AppUpdate>) -> UpdateSources {
    let channel = state.channel.clone().unwrap_or(UpdateChannel::Host);
    let github_reason = match (&channel, &state.repo) {
        (_, Some(_)) => None,
        (UpdateChannel::Broken(why), None) => Some(why.clone()),
        _ => Some("This build doesn't know its GitHub repository.".into()),
    };
    UpdateSources {
        enabled: state.enabled,
        channel: if matches!(channel, UpdateChannel::Host) { "host" } else { "github" },
        repo: state.repo.clone(),
        github_reason,
        github_key: GITHUB_PUBKEY.trim().to_string(),
        build_key: if matches!(channel, UpdateChannel::Host) { state.build_key.clone() } else { None },
    }
}

/// Ask `source` ("github" or "host"; the build's channel when absent) whether there's
/// another desktop build. The host is the one at `base_url`, asked with `token` (this
/// device's token for it; none on loopback, where the caller is the owner) and checked
/// against `host_key`, the key the device pinned for it. GitHub ignores all three.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppUpdate>,
    base_url: String,
    token: Option<String>,
    source: Option<String>,
    host_key: Option<String>,
) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    if !state.enabled {
        return Ok(UpdateCheck { can_update: false, current, version: None, notes: None, reason: Some(state.why_not()) });
    }
    let channel = state.channel.clone().unwrap_or(UpdateChannel::Host);
    let source = Source::parse(source.as_deref(), &channel);
    // A source that can't be asked is a failed check (retried later), not a build that can't update.
    let plan = plan(source, &channel, state.repo.as_deref(), state.build_key.as_deref(), host_key.as_deref(), &base_url)?;
    let mut builder = app
        .updater_builder()
        .pubkey(plan.pubkey.clone())
        .endpoints(vec![plan.endpoint.clone()])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(30));
    if plan.cross {
        // Moving across sources: their numbers don't compare, so any other version counts.
        builder = builder.version_comparator(|current, release| release.version != current);
    }
    if plan.send_token {
        if let Some(t) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            builder = builder.header("Authorization", format!("Bearer {t}")).map_err(|e| e.to_string())?;
        }
    }
    let found = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| match (source, e) {
        // No latest.json on the latest release (one made before GitHub updates, or a
        // release still building).
        (Source::Github, tauri_plugin_updater::Error::ReleaseNotFound) => {
            "GitHub has no update information for the latest release yet.".to_string()
        }
        (_, e) => e.to_string(),
    })?;
    let out = UpdateCheck {
        can_update: true,
        current,
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        reason: None,
    };
    // A new check replaces what an earlier one (perhaps from the other source) found.
    *lock(&state.found) = found;
    *lock(&state.downloaded) = None;
    Ok(out)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum DownloadEvent {
    Progress { received: u64, total: Option<u64> },
    Finished,
}

/// Download the update the last check found, verifying its signature. Progress
/// goes out on `on_event`. The bundle waits in memory for `update_install_and_restart`.
#[tauri::command]
pub async fn update_download(state: State<'_, AppUpdate>, on_event: Channel<DownloadEvent>) -> Result<String, String> {
    if !state.enabled {
        return Err(state.why_not());
    }
    let _busy = Busy::take(&state.busy).ok_or("An update is already downloading.")?;
    let update = lock(&state.found).clone().ok_or("No update to download. Check for updates first.")?;
    let mut received: u64 = 0;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let _ = on_event.send(DownloadEvent::Progress { received, total });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await;
    let bytes = result.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    *lock(&state.downloaded) = Some((update, bytes));
    Ok(version)
}

/// Swap the downloaded build in and relaunch. The webview saves what's open first
/// (`src/lib/restartFlush.ts`); `request_restart` lets the app's exit handler stop
/// the AI engines it started.
#[tauri::command]
pub async fn update_install_and_restart(app: AppHandle, state: State<'_, AppUpdate>) -> Result<(), String> {
    let (update, bytes) = lock(&state.downloaded).take().ok_or("No downloaded update to install.")?;
    if let Err(e) = update.install(&bytes) {
        // Keep it, so a second click can retry.
        *lock(&state.downloaded) = Some((update, bytes));
        return Err(e.to_string());
    }
    app.request_restart();
    Ok(())
}

/// A poisoned lock still holds good data here (plain values, no invariants).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One download at a time; the flag clears however the download ends.
struct Busy<'a>(&'a Mutex<bool>);
impl<'a> Busy<'a> {
    fn take(flag: &'a Mutex<bool>) -> Option<Self> {
        let mut b = lock(flag);
        if *b {
            return None;
        }
        *b = true;
        Some(Busy(flag))
    }
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        *lock(self.0) = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_keeps_the_updater_placeholders_after_the_host() {
        let u = endpoint_url("http://100.64.0.7:8787/").unwrap();
        // url encodes the braces; the plugin replaces the encoded form too.
        let s = u.to_string();
        assert!(s.starts_with("http://100.64.0.7:8787/updates/desktop/"), "{s}");
        let decoded = s.replace("%7B", "{").replace("%7D", "}");
        assert_eq!(decoded, "http://100.64.0.7:8787/updates/desktop/{{target}}/{{arch}}/{{current_version}}");
    }

    #[test]
    fn a_missing_or_odd_host_is_refused() {
        assert!(endpoint_url("  ").is_err());
        assert!(endpoint_url("not a url").is_err());
        assert!(endpoint_url("file:///etc").is_err());
    }

    #[test]
    fn one_download_at_a_time_and_the_flag_clears() {
        let flag = Mutex::new(false);
        let first = Busy::take(&flag).expect("free");
        assert!(Busy::take(&flag).is_none());
        drop(first);
        assert!(Busy::take(&flag).is_some());
    }

    #[test]
    fn a_packaged_install_is_updated_by_its_package_manager() {
        let dir = std::env::temp_dir().join(format!("ganban-pkg-marker-{}", std::process::id()));
        let exe = dir.join("usr/bin/gansty");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        // No marker: the AppImage, the .deb from apt, a dev build.
        assert_eq!(package_manager_for(&exe), None);
        let marker = dir.join("usr").join(PACKAGE_MARKER);
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, "pacman\n").unwrap();
        assert_eq!(package_manager_for(&exe).as_deref(), Some("pacman"));
        std::fs::write(&marker, "").unwrap();
        assert_eq!(package_manager_for(&exe).as_deref(), Some("your package manager"));
        std::fs::remove_dir_all(&dir).unwrap();

        // A GitHub build that a package installed can't update itself, and says why.
        let s = AppUpdate::new(UpdateChannel::Github { repo: "a/b".into() }, None, Some("pacman".into()));
        assert!(!s.enabled);
        assert_eq!(s.why_not(), "Ganban is updated by your package manager (pacman), not by itself.");
        let s = AppUpdate::new(UpdateChannel::Github { repo: "a/b".into() }, None, None);
        assert!(s.enabled);
        assert_eq!(managed_reason("your package manager"), "Ganban is updated by your package manager, not by itself.");
    }

    #[test]
    fn which_builds_update_themselves() {
        let mut c: tauri::Config = serde_json::from_value(serde_json::json!({ "identifier": "x.y.z" })).unwrap();
        assert_eq!(build_key(&c), None);
        c.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "" }));
        assert_eq!(build_key(&c), None);
        // A dev build (no channel, no key) can't; a GitHub build always can (it carries the project key).
        assert!(!can_update(&UpdateChannel::Host, None));
        assert!(can_update(&UpdateChannel::Host, Some("HOSTKEY")));
        assert!(can_update(&UpdateChannel::Github { repo: "a/b".into() }, None));
        // The plugin always gets a key to start with and allows the tailnet's http.
        prepare_config(&mut c);
        assert_eq!(c.plugins.0["updater"]["pubkey"], serde_json::json!(GITHUB_PUBKEY.trim()));
        assert_eq!(c.plugins.0["updater"]["dangerousInsecureTransportProtocol"], serde_json::json!(true));
        c.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "HOSTKEY" }));
        prepare_config(&mut c);
        assert_eq!(build_key(&c).as_deref(), Some("HOSTKEY"), "the build's own key stays");
    }

    #[test]
    fn the_project_key_is_embedded() {
        use base64::Engine;
        let text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(GITHUB_PUBKEY.trim()).unwrap()).unwrap();
        assert!(text.contains("minisign public key"), "{text}");
    }

    #[test]
    fn each_source_has_its_own_key() {
        let host = UpdateChannel::Host;
        let gh = UpdateChannel::Github { repo: "PeterK0/Ganban".into() };
        let url = "http://100.64.0.7:8787";
        // The default source is the build's channel.
        assert_eq!(Source::parse(None, &host), Source::Host);
        assert_eq!(Source::parse(Some("bogus"), &gh), Source::Github);
        assert_eq!(Source::parse(Some("host"), &gh), Source::Host);

        // GitHub: the project key, no token, whichever build asks.
        for (ch, cross) in [(&gh, false), (&host, true)] {
            let p = plan(Source::Github, ch, Some("PeterK0/Ganban"), Some("HOSTKEY"), Some("PINNED"), url).unwrap();
            assert_eq!(p.pubkey, GITHUB_PUBKEY.trim());
            assert!(!p.send_token);
            assert_eq!(p.cross, cross);
            assert!(p.endpoint.as_str().starts_with("https://github.com/PeterK0/Ganban/"));
        }
        assert!(plan(Source::Github, &host, None, None, None, url).unwrap_err().contains("GitHub repository"));

        // The host: the pinned key first, else a host build's own key; never the project key
        // a GitHub build's config holds.
        let p = plan(Source::Host, &host, None, Some("HOSTKEY"), Some("PINNED"), url).unwrap();
        assert_eq!((p.pubkey.as_str(), p.send_token, p.cross), ("PINNED", true, false));
        assert_eq!(plan(Source::Host, &host, None, Some("HOSTKEY"), None, url).unwrap().pubkey, "HOSTKEY");
        assert_eq!(plan(Source::Host, &host, None, Some("HOSTKEY"), Some("  "), url).unwrap().pubkey, "HOSTKEY");
        let p = plan(Source::Host, &gh, Some("PeterK0/Ganban"), Some(GITHUB_PUBKEY), Some("PINNED"), url).unwrap();
        assert_eq!((p.pubkey.as_str(), p.cross), ("PINNED", true));
        assert!(plan(Source::Host, &gh, Some("PeterK0/Ganban"), Some(GITHUB_PUBKEY), None, url).unwrap_err().contains("trust its key"));
        assert!(plan(Source::Host, &host, None, Some("HOSTKEY"), None, "").is_err(), "no host connected");
    }

    #[test]
    fn the_channel_is_the_builds() {
        assert_eq!(UpdateChannel::from_build(None, None), UpdateChannel::Host);
        assert_eq!(UpdateChannel::from_build(Some("host"), Some("a/b")), UpdateChannel::Host);
        assert_eq!(
            UpdateChannel::from_build(Some("github"), Some("PeterK0/Ganban")),
            UpdateChannel::Github { repo: "PeterK0/Ganban".into() }
        );
        for bad in [None, Some(""), Some("PeterK0"), Some("a/b/c"), Some("../x"), Some("a/b?x"), Some("evil.com/a b")] {
            assert!(matches!(UpdateChannel::from_build(Some("github"), bad), UpdateChannel::Broken(_)), "{bad:?}");
        }
    }

    #[test]
    fn the_github_endpoint_is_the_repos_latest_release() {
        assert_eq!(
            github_endpoint("PeterK0/Ganban").unwrap().as_str(),
            "https://github.com/PeterK0/Ganban/releases/latest/download/latest.json"
        );
        assert!(github_endpoint("a/b/../../c").is_err());
    }
}
