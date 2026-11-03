//! Desktop-only: host the Ganban daemon in-process so a phone can pair with this
//! machine over the tailnet. Start/stop the axum server on a background task,
//! serving the desktop app's OWN database pool (one process, one pool — no
//! cross-process SQLite contention), and report status + reachable URLs for the
//! QR code. Can also share a locally-built APK for the phone to download.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ganban_core::storage::StorageRoot;
use ganban_core::Db;
use ganban_server::{SharedApk, Shares};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{oneshot, Mutex};

const DEFAULT_PORT: u16 = 8765;

#[derive(Default)]
pub struct DaemonState {
    inner: Mutex<Option<Running>>,
    next_gen: AtomicU64,
    /// Native builds the daemon offers at /download (APK + desktop installer).
    /// Shared (by Arc clone) with the running server so they survive daemon
    /// restarts and can be set live.
    shares: Shares,
}

impl DaemonState {
    /// The native builds the daemon offers at /download (the same slots whether or
    /// not it's running), for the in-process command table.
    pub fn shares(&self) -> &Shares {
        &self.shares
    }
}

struct Running {
    port: u16,
    /// Bound to 127.0.0.1 only (the launch default: the app's own AI/tab
    /// surface) vs all interfaces (the explicit "Host this device" choice).
    loopback: bool,
    /// Identifies this server instance so a previous instance's task can't clear
    /// the state of a newer one when it finally winds down.
    generation: u64,
    shutdown: oneshot::Sender<()>,
}

#[derive(Serialize)]
pub struct DaemonStatus {
    running: bool,
    port: Option<u16>,
    /// True while serving loopback-only (not reachable from other devices).
    loopback: bool,
    /// Candidate `http://host:port` URLs a phone can connect to, best first
    /// (Tailscale 100.x, then private LAN, then anything else). Empty while
    /// loopback-only — there is nothing for another device to reach.
    urls: Vec<String>,
    /// File name of the build currently shared for each platform, if any.
    android: Option<String>,
    windows: Option<String>,
    macos: Option<String>,
    linux: Option<String>,
    /// The standalone headless server build (self-host), if shared.
    server: Option<String>,
}

/// Full path held in a share slot, if any (a quick std-mutex read). The UI keys
/// build-availability off the path so two same-named builds don't collide.
fn slot_name(slot: &SharedApk) -> Option<String> {
    slot.lock().unwrap().as_ref().map(|p| p.to_string_lossy().into_owned())
}

/// The host's Tailscale MagicDNS FQDN (`host.tailnet.ts.net`), persisted host-side
/// as `tailscale_device_fqdn` when the owner picks the server device in Settings
/// (it's the device's API `name`). Preferred over the raw 100.x in invites: a
/// MagicDNS name survives the host's tailnet IP changing, and a shared device is
/// reachable cross-tailnet ONLY by its full FQDN (so this is also what an accepted
/// device-share resolves). Returns None when sharing isn't configured → raw IP, as
/// before. A fast local SELECT; never blocks on the network.
async fn host_fqdn(db: &Db) -> Option<String> {
    ganban_core::ops::get_app_setting(db, "tailscale_device_fqdn")
        .await
        .ok()
        .flatten()
        .map(|s| s.trim().trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty())
}

/// Build a status snapshot. Share reads are quick std-mutex reads (never held
/// across an await), so this stays a plain sync fn callable while holding locks.
/// `fqdn` is the host's MagicDNS name (if configured) — prepended to the URL list.
fn status_for(snapshot: Option<(u16, bool)>, shares: &Shares, fqdn: Option<String>) -> DaemonStatus {
    let (port, loopback) = match snapshot {
        Some((p, l)) => (Some(p), l),
        None => (None, false),
    };
    DaemonStatus {
        running: port.is_some(),
        port,
        loopback,
        urls: match (port, loopback) {
            (Some(p), false) => candidate_urls(p, fqdn.as_deref()),
            _ => Vec::new(),
        },
        android: slot_name(&shares.android),
        windows: slot_name(&shares.windows),
        macos: slot_name(&shares.macos),
        linux: slot_name(&shares.linux),
        server: slot_name(&shares.server),
    }
}

/// Enumerate this machine's non-loopback IPv4 addresses and build connection
/// URLs, preferring the Tailscale CGNAT range (100.64.0.0/10), then RFC1918.
/// When the host is on the tailnet AND a MagicDNS `fqdn` is known, that name
/// leads (ahead of the raw 100.x) — a stable address that survives IP changes and
/// is the only form a cross-tailnet shared device resolves by.
fn candidate_urls(port: u16, fqdn: Option<&str>) -> Vec<String> {
    let ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .map(|ifaces| {
            ifaces
                .into_iter()
                .filter(|i| !i.is_loopback())
                .filter_map(|i| match i.ip() {
                    std::net::IpAddr::V4(v4) => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    rank_urls(&ips, port, fqdn)
}

/// Pure URL ranking (split out so it's unit-testable without real interfaces):
/// Tailscale 100.64/10 first — led by the MagicDNS `fqdn` when the host is on the
/// tailnet — then RFC1918 LAN, then anything else. The fqdn is only added when a
/// 100.x is present; off-tailnet it wouldn't resolve/route, so listing it would
/// mislead.
fn rank_urls(ips: &[Ipv4Addr], port: u16, fqdn: Option<&str>) -> Vec<String> {
    let mut tailscale = Vec::new();
    let mut lan = Vec::new();
    let mut other = Vec::new();
    for v4 in ips {
        let o = v4.octets();
        let url = format!("http://{v4}:{port}");
        if o[0] == 100 && (64..=127).contains(&o[1]) {
            tailscale.push(url);
        } else if v4.is_private() {
            lan.push(url);
        } else {
            other.push(url);
        }
    }
    if let Some(f) = fqdn {
        if !tailscale.is_empty() {
            tailscale.insert(0, format!("http://{f}:{port}"));
        }
    }
    let mut urls = tailscale;
    urls.extend(lan);
    urls.extend(other);
    urls
}

#[tauri::command]
pub async fn daemon_status(state: State<'_, DaemonState>, pool: State<'_, Db>) -> Result<DaemonStatus, String> {
    let snapshot = state.inner.lock().await.as_ref().map(|r| (r.port, r.loopback));
    Ok(status_for(snapshot, &state.shares, host_fqdn(pool.inner()).await))
}

/// Start (or re-scope) the in-process daemon. `loopback` = serve this machine
/// only; `!loopback` = serve the tailnet/LAN too. Asking for wider reach while
/// running loopback-only upgrades in place (graceful stop + rebind); asking
/// for loopback while already wide is satisfied as-is (never narrows a daemon
/// the owner deliberately exposed).
async fn start_daemon(app: &AppHandle, port: Option<u16>, loopback: bool) -> Result<DaemonStatus, String> {
    let state = app.state::<DaemonState>();
    let pool = app.state::<Db>();
    let storage = app.state::<StorageRoot>();
    let fqdn = host_fqdn(pool.inner()).await;
    let snapshot = {
        let mut guard = state.inner.lock().await;
        if let Some(r) = guard.as_ref() {
            if !r.loopback || loopback {
                // Already running with at least the requested reach (idempotent).
                let snap = (r.port, r.loopback);
                drop(guard);
                return Ok(status_for(Some(snap), &state.shares, fqdn));
            }
            // Loopback-only but the tailnet was requested: upgrade in place. The
            // old task clears state by generation, so it can't clobber ours.
            if let Some(old) = guard.take() {
                let _ = old.shutdown.send(());
            }
        }

        let want = port.unwrap_or(DEFAULT_PORT);
        let ip = if loopback { Ipv4Addr::LOCALHOST } else { Ipv4Addr::UNSPECIFIED };
        let bind_addr: SocketAddr = (ip, want).into();

        // Bind first so "port in use" surfaces before we spawn anything. Retry
        // briefly on AddrInUse to ride out a just-stopped instance still releasing.
        let listener = {
            let mut attempt = 0;
            loop {
                match ganban_server::bind(bind_addr).await {
                    Ok(l) => break l,
                    Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempt < 10 => {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Err(e) => return Err(format!("Could not start daemon on port {want}: {e}")),
                }
            }
        };
        let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();

        let generation = state.next_gen.fetch_add(1, Ordering::SeqCst);
        let db = pool.inner().clone();
        let shares = state.shares.clone();
        let storage_root = storage.0.clone();
        let (tx, rx) = oneshot::channel::<()>();
        let app_handle = app.clone();

        tauri::async_runtime::spawn(async move {
            let _ = ganban_server::serve(listener, db, shares, storage_root, async move {
                let _ = rx.await;
            })
            .await;
            // Serve ended (graceful stop OR a listener error). Clear our state if
            // it is still ours, so the UI never shows a phantom "running" daemon.
            let st = app_handle.state::<DaemonState>();
            let mut g = st.inner.lock().await;
            if g.as_ref().map(|r| r.generation) == Some(generation) {
                *g = None;
            }
        });

        *guard = Some(Running { port: actual_port, loopback, generation, shutdown: tx });
        if loopback {
            println!("Daemon on 127.0.0.1:{actual_port} (this machine only — \"Host this device\" exposes it)");
        } else {
            println!("Daemon hosting on 0.0.0.0:{actual_port}");
        }
        (actual_port, loopback)
    };

    Ok(status_for(Some(snapshot), &state.shares, fqdn))
}

/// Desktop launch: bring the embedded daemon up. Loopback-only by default —
/// but a machine that was HOSTING when it last ran comes back hosting
/// (`daemon_hosting` app-setting; Start remembers, Stop forgets, same
/// contract as the AI engines). First exposure is still the explicit
/// Sync → "Host this device" choice.
pub fn autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let pool = app.state::<Db>();
        let was_hosting = ganban_core::ops::get_app_setting(pool.inner(), "daemon_hosting")
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        if was_hosting {
            println!("Resuming host mode (this machine was hosting last session)");
        }
        if let Err(e) = start_daemon(&app, None, !was_hosting).await {
            eprintln!("daemon autostart failed (Sync → Host this device can start it manually): {e}");
        }
    });
}

/// The in-process daemon's port, if it is currently serving (used by the AI
/// engine autostart to poke /ai/reload once the engines are up).
pub async fn current_port(app: &AppHandle) -> Option<u16> {
    let state = app.state::<DaemonState>();
    let guard = state.inner.lock().await;
    guard.as_ref().map(|r| r.port)
}

#[tauri::command]
pub async fn daemon_start(app: AppHandle, port: Option<u16>, loopback: Option<bool>) -> Result<DaemonStatus, String> {
    let status = start_daemon(&app, port, loopback.unwrap_or(false)).await?;
    // Start remembers, Stop forgets: what the next launch resumes is the
    // ACTUAL resulting reach (start_daemon never narrows a wide daemon, so a
    // loopback request can still end up — and stay — hosting). The autostart
    // path calls start_daemon directly, so it never overwrites this.
    let pool = app.state::<Db>();
    let _ = ganban_core::ops::set_app_setting(pool.inner(), "daemon_hosting", if status.loopback { "0" } else { "1" }).await;
    Ok(status)
}

/// Owner pairs a new device FOR a member (recovery: no signed-in device left).
/// Local mode = the host itself, so the caller IS the owner.
#[tauri::command]
pub async fn pair_member_device(pool: State<'_, Db>, user_id: i64) -> Result<String, String> {
    ganban_core::auth::create_member_device_enrollment(pool.inner(), user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Owner mints a one-time token to enroll their own (owner) phone. Returns the
/// raw enrollment token; the UI embeds it + the daemon URL in a QR.
#[tauri::command]
pub async fn pair_owner_device(pool: State<'_, Db>) -> Result<String, String> {
    let owner_id = ganban_core::auth::ensure_owner(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    ganban_core::auth::create_enrollment_token(
        pool.inner(),
        "new_device",
        Some(owner_id),
        None,
        None,
        None,
        ganban_core::auth::ENROLLMENT_TTL_SECS,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Owner mints a one-time invite to a project (creates/attaches a member on
/// enrollment). Returns the raw token for the QR.
#[tauri::command]
pub async fn create_project_invite(
    pool: State<'_, Db>,
    project_id: i64,
    role: String,
    display_name: Option<String>,
) -> Result<String, String> {
    if !ganban_core::auth::is_grantable_role(&role) {
        return Err("role must be 'admin' or 'member'".into());
    }
    ganban_core::auth::create_enrollment_token(
        pool.inner(),
        "invite",
        None,
        Some(project_id),
        Some(&role),
        display_name.as_deref(),
        ganban_core::auth::INVITE_TTL_SECS,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Tailscale auto-share (owner): list the tailnet's devices for the Settings
/// picker. Local twin of the daemon's `/invoke tailscale_check`, so the owner
/// can configure sharing from the host machine itself.
#[tauri::command]
pub async fn tailscale_check(pool: State<'_, Db>) -> Result<serde_json::Value, String> {
    // Owner-only — matches the daemon's /invoke gate and pair_owner_device. The
    // local invoke path is otherwise ungated, so a non-owner profile must not be
    // able to enumerate the tailnet or touch the credential.
    ganban_core::auth::ensure_owner(pool.inner()).await.map_err(|e| e.to_string())?;
    ganban_server::tailscale::list_devices(pool.inner()).await
}

/// Tailscale auto-share (owner): mint a one-time device-share invite for the
/// configured server device. Returns `{ ts }` (null when sharing isn't fully
/// configured) — best-effort, never blocks the Ganban invite. Local twin of the
/// daemon's `/invoke tailscale_share`.
/// Lifecycle of a just-minted invite/pairing token (pending → joined → expired),
/// so the QR-code diagnostics panel can show whether the recipient has actually
/// joined yet. Owner-only on the local invoke path. Non-sensitive status only.
#[tauri::command]
pub async fn invite_status(pool: State<'_, Db>, token: String) -> Result<serde_json::Value, String> {
    ganban_core::auth::ensure_owner(pool.inner()).await.map_err(|e| e.to_string())?;
    let st = ganban_core::auth::invite_status(pool.inner(), &token).await.map_err(|e| e.to_string())?;
    serde_json::to_value(st).map_err(|e| e.to_string())
}

/// List enrollment tokens (pending/joined/expired) for the "pending invites"
/// review list. Owner-only on the local invoke path; `project_id` None = all.
#[tauri::command]
pub async fn list_invites(pool: State<'_, Db>, project_id: Option<i64>) -> Result<serde_json::Value, String> {
    ganban_core::auth::ensure_owner(pool.inner()).await.map_err(|e| e.to_string())?;
    let list = ganban_core::auth::list_invites(pool.inner(), project_id).await.map_err(|e| e.to_string())?;
    serde_json::to_value(list).map_err(|e| e.to_string())
}

/// Revoke (delete) an enrollment token so a stale invite can't be redeemed.
/// Owner-only on the local invoke path. Joined members keep their access.
#[tauri::command]
pub async fn revoke_invite(pool: State<'_, Db>, id: i64) -> Result<(), String> {
    ganban_core::auth::ensure_owner(pool.inner()).await.map_err(|e| e.to_string())?;
    ganban_core::auth::revoke_invite(pool.inner(), id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tailscale_share(pool: State<'_, Db>) -> Result<serde_json::Value, String> {
    // Owner-only (see tailscale_check) — minting a tailnet share of THIS machine
    // is an owner capability, even on the local invoke path.
    ganban_core::auth::ensure_owner(pool.inner()).await.map_err(|e| e.to_string())?;
    match ganban_server::tailscale::create_share_detailed(pool.inner()).await {
        Ok(Some(s)) => Ok(serde_json::json!({ "ts": s.url, "token_expiry": s.token_expiry })),
        Ok(None) => Ok(serde_json::json!({ "ts": serde_json::Value::Null })),
        Err(e) => Ok(serde_json::json!({ "ts": serde_json::Value::Null, "error": e })),
    }
}

#[tauri::command]
pub async fn daemon_stop(state: State<'_, DaemonState>, pool: State<'_, Db>) -> Result<DaemonStatus, String> {
    {
        let mut guard = state.inner.lock().await;
        if let Some(r) = guard.take() {
            let _ = r.shutdown.send(());
            println!("Daemon stopped");
        }
    }
    let _ = ganban_core::ops::set_app_setting(pool.inner(), "daemon_hosting", "0").await;
    Ok(status_for(None, &state.shares, None)) // stopped → no URLs, fqdn moot
}

/// Point a share slot at `path` (or clear it with `None`), validating existence.
/// Auto-discover built artifacts: the repo's standard Tauri outputs, plus any
/// loose installers in an optional `base` folder (e.g. a collected-builds dir).
/// Delegates to `ganban_server::builds` so the local command and the daemon's
/// `/invoke discover_builds` surface (remote admins) share one implementation.
#[tauri::command]
pub async fn daemon_discover_builds(base: Option<String>) -> Result<Vec<ganban_server::builds::DiscoveredBuild>, String> {
    Ok(ganban_server::builds::discover(base))
}

/// Share (or, with `None`, stop sharing) a native build for one platform
/// (`android` | `windows` | `macos` | `linux`). Takes effect immediately.
#[tauri::command]
pub async fn daemon_set_build(
    state: State<'_, DaemonState>,
    pool: State<'_, Db>,
    kind: String,
    path: Option<String>,
) -> Result<DaemonStatus, String> {
    let slot = state.shares.slot(&kind).ok_or_else(|| format!("unknown build kind: {kind}"))?;
    ganban_server::set_share_slot(slot, path)?;
    let snapshot = state.inner.lock().await.as_ref().map(|r| (r.port, r.loopback));
    Ok(status_for(snapshot, &state.shares, host_fqdn(pool.inner()).await))
}

#[cfg(test)]
mod tests {
    use super::rank_urls;
    use std::net::Ipv4Addr;

    const TS: Ipv4Addr = Ipv4Addr::new(100, 101, 102, 103); // 100.64/10 CGNAT
    const LAN: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 50);
    const PUB: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);

    #[test]
    fn fqdn_leads_when_on_tailnet() {
        let urls = rank_urls(&[LAN, TS], 8765, Some("host.tail1234.ts.net"));
        assert_eq!(urls[0], "http://host.tail1234.ts.net:8765", "MagicDNS name leads");
        assert_eq!(urls[1], "http://100.101.102.103:8765", "raw 100.x kept as fallback");
        assert_eq!(urls[2], "http://192.168.1.50:8765", "LAN after tailnet");
    }

    #[test]
    fn fqdn_omitted_when_no_tailnet_address() {
        // Off-tailnet the MagicDNS name wouldn't resolve/route — don't list it.
        let urls = rank_urls(&[LAN], 8765, Some("host.tail1234.ts.net"));
        assert_eq!(urls, vec!["http://192.168.1.50:8765"]);
    }

    #[test]
    fn no_fqdn_is_unchanged_ranking() {
        let urls = rank_urls(&[PUB, LAN, TS], 8765, None);
        assert_eq!(
            urls,
            vec![
                "http://100.101.102.103:8765",
                "http://192.168.1.50:8765",
                "http://203.0.113.7:8765",
            ]
        );
    }
}
