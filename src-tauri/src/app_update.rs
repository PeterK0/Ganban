//! Desktop-only: the app updates itself (ADR 0007, ADR 0008, docs/design/UPDATES.md).
//! Tauri's updater plugin does the work; these commands drive it with RUNTIME
//! endpoints chosen by the build's update channel, fixed at build time:
//!
//! - `host` (built by the host's `ops/build-clients.sh`): the host this app is
//!   connected to, with the device token. Plain http is allowed (the tailnet).
//! - `github` (built by `.github/workflows/release.yml`): the repo's latest GitHub
//!   release (`latest.json`), https only, and never the device token.
//!
//! Each channel's builds carry only that channel's public key, so a bundle signed
//! for one channel never installs on the other.
//!
//! The flow is check → download (in the background, with progress) → install and
//! restart (on the owner's click). The downloaded bundle stays in memory until the
//! click: the signature is checked at download, the swap happens at install.
//!
//! A build made without an updater public key (a dev or hand-made build) doesn't
//! register the plugin at all, and `update_check` says so.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The updater's state for this run: whether this build can update itself, the
/// update the last check found, and the bundle once it's downloaded.
#[derive(Default)]
pub struct AppUpdate {
    pub enabled: bool,
    channel: Option<UpdateChannel>,
    found: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
    busy: Mutex<bool>,
}

impl AppUpdate {
    pub fn new(enabled: bool, channel: UpdateChannel) -> Self {
        Self { enabled, channel: Some(channel), ..Default::default() }
    }
}

/// Whether the build's config carries an updater public key. The host's build
/// injects `plugins.updater.pubkey` with a `--config` override; a dev or
/// hand-made build has none, and the plugin would refuse to start without it.
pub fn configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Where this build updates from, fixed at build time (`VITE_UPDATE_CHANNEL`, read by
/// the frontend too, and `VITE_UPDATE_REPO` for `github`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateChannel {
    /// The connected host. Also a keyed build with no channel set (host builds made
    /// before channels existed).
    Host,
    /// GitHub Releases of `owner/repo`.
    Github { repo: String },
    /// `github` without a usable repo: this build can't update itself.
    Broken(String),
}

impl UpdateChannel {
    pub fn from_build(channel: Option<&str>, repo: Option<&str>) -> Self {
        match channel.map(str::trim).unwrap_or("") {
            "github" => match repo.map(str::trim).filter(|r| valid_repo(r)) {
                Some(r) => UpdateChannel::Github { repo: r.to_string() },
                None => UpdateChannel::Broken(format!(
                    "This build can't update itself: its GitHub repository ({}) isn't owner/name.",
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

/// Turn on the plugin's settings the channel needs. A host on the tailnet is plain
/// http, so the host channel allows insecure transport (the bundle's signature
/// guards its integrity, not TLS); GitHub is https, so its channel doesn't. Only
/// called when `configured` is true.
pub fn prepare_config(config: &mut tauri::Config, channel: &UpdateChannel) {
    if let Some(serde_json::Value::Object(u)) = config.plugins.0.get_mut("updater") {
        let insecure = matches!(channel, UpdateChannel::Host);
        u.insert("dangerousInsecureTransportProtocol".into(), serde_json::Value::Bool(insecure));
    }
}

/// The GitHub channel's endpoint: the repo's latest release's `latest.json`, which the
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

pub const NO_KEY: &str = "This build can't update itself: it was built without the update key. Install a build from your host once.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// False when this build has no updater key (see `NO_KEY`).
    pub can_update: bool,
    /// This app's version.
    pub current: String,
    /// The newer version the host offers, or none.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// Why this build can't update itself, when it can't.
    pub reason: Option<String>,
}

/// Ask whether there's a newer desktop build. On the host channel that's the host at
/// `base_url`, with `token`, this device's token for it (none on loopback, where the
/// caller is the owner). On the GitHub channel both are ignored: the build's own repo
/// is asked, with no token.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppUpdate>,
    base_url: String,
    token: Option<String>,
) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    if !state.enabled {
        return Ok(UpdateCheck { can_update: false, current, version: None, notes: None, reason: Some(NO_KEY.into()) });
    }
    let channel = state.channel.clone().unwrap_or(UpdateChannel::Host);
    let (endpoint, token) = match &channel {
        UpdateChannel::Host => (endpoint_url(&base_url)?, token),
        UpdateChannel::Github { repo } => (github_endpoint(repo)?, None),
        UpdateChannel::Broken(why) => {
            return Ok(UpdateCheck { can_update: false, current, version: None, notes: None, reason: Some(why.clone()) });
        }
    };
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(30));
    if let Some(t) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        builder = builder.header("Authorization", format!("Bearer {t}")).map_err(|e| e.to_string())?;
    }
    let found = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| match (&channel, e) {
        // No latest.json on the latest release (one made before GitHub updates, or a
        // release still building).
        (UpdateChannel::Github { .. }, tauri_plugin_updater::Error::ReleaseNotFound) => {
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
    *lock(&state.found) = found;
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
        return Err(NO_KEY.into());
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
    fn only_a_build_with_a_key_updates_itself() {
        let mut c: tauri::Config = serde_json::from_value(serde_json::json!({ "identifier": "x.y.z" })).unwrap();
        assert!(!configured(&c));
        c.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "" }));
        assert!(!configured(&c));
        c.plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": "dW50cnVzdGVk" }));
        assert!(configured(&c));
        prepare_config(&mut c, &UpdateChannel::Host);
        assert_eq!(c.plugins.0["updater"]["dangerousInsecureTransportProtocol"], serde_json::json!(true));
        prepare_config(&mut c, &UpdateChannel::Github { repo: "a/b".into() });
        assert_eq!(c.plugins.0["updater"]["dangerousInsecureTransportProtocol"], serde_json::json!(false));
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
