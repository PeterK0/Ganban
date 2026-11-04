//! Deny-read sandbox for pi runs (`pi_rpc`).
//!
//! A pi run sends data to a cloud model, so it has the network. The sandbox
//! cuts the other leg: the run can read only what it needs to start, and
//! nothing private. Reads are denied by default and allowed for:
//!
//! - the run's own folder (its working directory), which also holds a staged
//!   pi config (`.ganban-pi/agent`) and the run's temp folder;
//! - pi's install and its node runtime, found from the pi binary;
//! - system libraries, certificates and time zones.
//!
//! The owner's `~/.pi/agent` is never mounted: it holds session transcripts and
//! every provider's key. Ganban copies only what the run needs (model settings,
//! the chosen provider's entry from `models.json` and `auth.json`) into the
//! staged config, which also keeps the run hermetic (no extensions, skills or
//! packages) and leaves nothing writable in the owner's config.
//!
//! On macOS the profile is Seatbelt (`sandbox-exec`): file reads and writes are
//! denied outside the allowlist, and outbound network is limited to TLS (port
//! 443), DNS and the explicit ports of the chosen provider or proxy. On Linux it
//! is Bubblewrap: an empty root with only the allowlist bound in, and the host
//! network shared (bwrap has no port filter). A Linux host without bwrap
//! refuses pi runs unless the owner sets `GANBAN_PI_UNSANDBOXED=1`.

// Only macOS and Linux have a sandbox; elsewhere pi runs are refused.
#![cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use ganban_core::error::{AppError, Result};

/// Owner override: run pi without a sandbox where none is available (Linux
/// without bwrap). Off unless set to `1`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const UNSANDBOXED_ENV: &str = "GANBAN_PI_UNSANDBOXED";

/// The run folder's private corner: staged pi config and the run's temp.
const STAGE: &str = ".ganban-pi";

/// The settings keys a run inherits from the owner's `settings.json`: model
/// choice and transport only. Everything else (packages, extensions, themes,
/// session folders, shell paths) stays out, so a run can't install or load
/// anything.
const SETTINGS_KEYS: &[&str] = &[
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "modelThinkingLevels",
    "thinkingBudgets",
    "enabledModels",
    "transport",
    "httpProxy",
    "httpIdleTimeoutMs",
    "websocketConnectTimeoutMs",
    "retry",
];

/// Parent environment variables a run keeps (besides the provider's API key).
const ENV_KEEP: &[&str] = &[
    "PATH", "LANG", "LC_ALL", "LC_CTYPE",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];

/// macOS read allowlist: system libraries, certificates (`/private/etc`), time
/// zones, devices. No user folder, no `/Library/Application Support`, no temp.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAC_SYSTEM_DIRS: &[&str] = &[
    "/System", "/usr/lib", "/usr/libexec", "/usr/share", "/usr/bin", "/bin",
    "/private/etc/ssl", "/private/var/db/timezone", "/private/var/select", "/dev/fd",
];
/// Single system files a run may read: name resolution, time zone, devices.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAC_SYSTEM_FILES: &[&str] = &[
    "/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime", "/private/etc/protocols",
    "/private/etc/services", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty",
    "/dev/dtracehelper",
];
/// Symlinks at the root that path resolution walks through.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAC_ROOT_LINKS: &[&str] = &["/etc", "/var", "/tmp"];

/// Linux read allowlist, bound read-only (missing ones are skipped).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LINUX_SYSTEM_DIRS: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32",
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/host.conf", "/etc/gai.conf",
    "/etc/ssl", "/etc/pki", "/etc/ca-certificates", "/etc/crypto-policies", "/etc/localtime",
    "/etc/passwd", "/etc/group", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
    "/etc/alternatives", "/run/systemd/resolve",
];

/// An outbound endpoint beyond TLS on 443. (bwrap has no port filter, so
/// only the macOS profile reads the ports.)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Endpoint {
    /// A port on this machine (a local model server or proxy).
    Loopback(u16),
    /// A port on any host (a provider or proxy on a non-standard port).
    AnyHost(u16),
}

/// Where pi and its runtime live: read-only in the sandbox.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Runtime {
    pub dirs: Vec<PathBuf>,
    pub files: Vec<PathBuf>,
}

/// Everything a sandboxed run's profile is built from.
#[derive(Debug, Clone)]
pub(crate) struct Plan {
    /// The run's working directory, canonical. Readable and writable.
    pub run_dir: PathBuf,
    pub runtime: Runtime,
    pub endpoints: Vec<Endpoint>,
}

impl Plan {
    pub fn stage_dir(&self) -> PathBuf { self.run_dir.join(STAGE) }
    pub fn agent_dir(&self) -> PathBuf { self.stage_dir().join("agent") }
    pub fn tmp_dir(&self) -> PathBuf { self.stage_dir().join("tmp") }
}

/// Quote a path for a Seatbelt string literal.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sb(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{s}\"")
}

/// The proper ancestors of `p` ("/" excluded): path resolution stats each.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ancestors(p: &Path) -> impl Iterator<Item = &Path> {
    p.ancestors().skip(1).filter(|a| a.parent().is_some())
}

/// The macOS Seatbelt profile for `plan`. Pure, so it is unit-tested.
///
/// `(allow default)` stays because node needs many syscall classes; the
/// restriction is on files, network and two Mach services, each denied by
/// default and re-allowed narrowly. Later rules win in Seatbelt.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn seatbelt_profile(plan: &Plan) -> String {
    use std::collections::BTreeSet;
    let run = &plan.run_dir;
    let mut reads: Vec<String> = MAC_SYSTEM_DIRS.iter().map(|d| format!("(subpath {})", sb(Path::new(d)))).collect();
    reads.extend(MAC_SYSTEM_FILES.iter().map(|f| format!("(literal {})", sb(Path::new(f)))));
    reads.extend(plan.runtime.dirs.iter().map(|d| format!("(subpath {})", sb(d))));
    reads.extend(plan.runtime.files.iter().map(|f| format!("(literal {})", sb(f))));

    let mut meta: BTreeSet<String> = MAC_ROOT_LINKS.iter().map(|l| format!("(literal {})", sb(Path::new(l)))).collect();
    let system: Vec<PathBuf> = MAC_SYSTEM_DIRS.iter().chain(MAC_SYSTEM_FILES).map(PathBuf::from).collect();
    let roots = plan.runtime.dirs.iter().chain(plan.runtime.files.iter()).chain(&system).chain(std::iter::once(run));
    for r in roots {
        for a in ancestors(r) {
            meta.insert(format!("(literal {})", sb(a)));
        }
    }

    let mut net = vec![
        "(remote tcp \"*:443\")".to_string(),
        "(literal \"/private/var/run/mDNSResponder\")".to_string(),
    ];
    for e in &plan.endpoints {
        net.push(match e {
            Endpoint::Loopback(p) => format!("(remote tcp \"localhost:{p}\")"),
            Endpoint::AnyHost(p) => format!("(remote tcp \"*:{p}\")"),
        });
    }

    format!(
        r#"(version 1)
(allow default)
; Files: deny every read and write, then allow the run's folder, pi's runtime
; and the system. User folders, the Ganban data folder, ~/.pi, ~/.ssh,
; keychains and the shared temp folders stay unreadable.
(deny file-read* file-write*)
(allow file-read* (literal "/"))
(allow file-read-metadata
  {meta})
(allow file-read*
  {reads})
(allow file-read* file-write* (subpath {run}))
; The data volume's firmlinks lead back to /Users and /private: keep them shut
; even if a future macOS stops translating them.
(deny file-read* file-write* (subpath "/System/Volumes/Data"))
(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
; No keychain or clipboard through their services.
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.pasteboard.1"))
; Network: TLS (the model API), DNS, and the chosen provider's explicit ports.
(deny network-outbound)
(allow network-outbound
  {net})
"#,
        meta = meta.into_iter().collect::<Vec<_>>().join("\n  "),
        reads = reads.join("\n  "),
        run = sb(run),
        net = net.join("\n  "),
    )
}

/// The Bubblewrap arguments for `plan` (Linux). Pure, so it is unit-tested.
///
/// The root is empty: only the system allowlist, pi's runtime and the run's
/// folder are bound in, and `/tmp` is a fresh tmpfs. bwrap can't filter ports,
/// so the network is shared; the cut is on reads.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn bwrap_args(plan: &Plan) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "--die-with-parent".into(),
        "--new-session".into(),
        "--unshare-all".into(),
        "--share-net".into(),
    ];
    for d in LINUX_SYSTEM_DIRS {
        v.extend(["--ro-bind-try".into(), (*d).into(), (*d).into()]);
    }
    v.extend(["--dev".into(), "/dev".into(), "--proc".into(), "/proc".into(), "--tmpfs".into(), "/tmp".into()]);
    for p in plan.runtime.dirs.iter().chain(plan.runtime.files.iter()) {
        let s = p.to_string_lossy().into_owned();
        v.extend(["--ro-bind-try".into(), s.clone(), s]);
    }
    // Last, so it sits on top of /tmp when the run folder lives there.
    let run = plan.run_dir.to_string_lossy().into_owned();
    v.extend(["--bind".into(), run.clone(), run.clone(), "--chdir".into(), run]);
    v
}

/// Find pi's install and its interpreter from the pi binary and `PATH`.
pub(crate) fn discover_runtime(pi_binary: &Path, path_env: Option<&OsStr>) -> Runtime {
    let mut rt = Runtime::default();
    rt.files.push(pi_binary.to_path_buf());
    let real = std::fs::canonicalize(pi_binary).unwrap_or_else(|_| pi_binary.to_path_buf());
    if real != pi_binary {
        rt.files.push(real.clone());
    }
    // A node package: allow the global node_modules it sits in. A native
    // binary: allow its folder.
    let pkg = real
        .ancestors()
        .filter(|a| a.file_name() == Some(OsStr::new("node_modules")))
        .last()
        .map(Path::to_path_buf)
        .or_else(|| real.parent().map(Path::to_path_buf));
    rt.dirs.extend(pkg);
    if let Some(interp) = interpreter(&real, path_env) {
        let ireal = std::fs::canonicalize(&interp).unwrap_or_else(|_| interp.clone());
        rt.files.push(interp);
        add_prefix(&mut rt, &ireal);
    }
    rt.dirs.sort();
    rt.dirs.dedup();
    rt.files.sort();
    rt.files.dedup();
    rt
}

/// Allow an interpreter's install prefix. A Homebrew keg links against other
/// kegs and reads OpenSSL's config, so a Homebrew node gets the Cellar, `opt`
/// and the certificate folders (never `var`, where Homebrew services keep
/// data). Anything else gets `<prefix>/bin` and `<prefix>/lib`.
fn add_prefix(rt: &mut Runtime, bin: &Path) {
    let brew = bin
        .ancestors()
        .find(|a| a.file_name() == Some(OsStr::new("Cellar")))
        .and_then(Path::parent);
    if let Some(brew) = brew {
        for sub in ["Cellar", "opt", "lib", "etc/openssl@3", "etc/ca-certificates"] {
            rt.dirs.push(brew.join(sub));
        }
    } else if let Some(prefix) = bin.parent().and_then(Path::parent) {
        rt.dirs.push(prefix.join("bin"));
        rt.dirs.push(prefix.join("lib"));
    }
}

/// The interpreter a script's shebang names (`#!/usr/bin/env node` is looked
/// up on `PATH`). None for a native binary.
fn interpreter(script: &Path, path_env: Option<&OsStr>) -> Option<PathBuf> {
    use std::io::Read;
    let mut buf = [0u8; 256];
    let n = std::fs::File::open(script).ok()?.read(&mut buf).ok()?;
    let head = std::str::from_utf8(&buf[..n]).ok()?;
    let line = head.strip_prefix("#!")?.lines().next()?.trim();
    let mut parts = line.split_whitespace();
    let first = parts.next()?;
    if Path::new(first).file_name() == Some(OsStr::new("env")) {
        let name = parts.find(|p| !p.starts_with('-'))?;
        find_in_path(name, path_env)
    } else {
        Some(PathBuf::from(first))
    }
}

/// `which`, without a subprocess.
pub(crate) fn find_in_path(name: &str, path_env: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path_env?).map(|d| d.join(name)).find(|p| p.is_file())
}

/// The provider a run talks to: the model pattern's prefix, or pi's default
/// provider when no model is named. None when the pattern names no provider
/// (pi may then pick any provider, so every configured one is staged).
fn provider_of(model: Option<&str>, settings: &Map<String, Value>) -> Option<String> {
    match model {
        Some(m) => m.split_once('/').map(|(p, _)| p.trim().to_string()).filter(|p| !p.is_empty()),
        None => settings.get("defaultProvider").and_then(Value::as_str).map(String::from),
    }
}

/// An outbound endpoint for a URL, if it needs one beyond TLS on 443.
fn endpoint_of(url: &str) -> Option<Endpoint> {
    let u = reqwest::Url::parse(url.trim()).ok()?;
    let port = u.port_or_known_default()?;
    if port == 443 {
        return None;
    }
    let host = u.host_str()?.trim_matches(|c| c == '[' || c == ']');
    Some(if matches!(host, "localhost" | "127.0.0.1" | "::1") { Endpoint::Loopback(port) } else { Endpoint::AnyHost(port) })
}

fn read_json(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v { Value::Object(m) => Some(m), _ => None })
        .unwrap_or_default()
}

/// Write JSON; a private file is created owner-only (0600), never widened later.
fn write_json(path: &Path, v: &Value, private: bool) -> Result<()> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    opts.open(path)?.write_all(&bytes)?;
    Ok(())
}

/// What staging the config produced.
#[derive(Debug, Default)]
pub(crate) struct Staged {
    pub provider: Option<String>,
    pub endpoints: Vec<Endpoint>,
    /// Credential strings the run holds. A result that repeats one is refused.
    pub secrets: Vec<String>,
    auth_before: Map<String, Value>,
}

/// Copy the run's slice of the owner's pi config (`real_agent`, normally
/// `~/.pi/agent`) into `agent_dir`: model settings, and the chosen provider's
/// `models.json` and `auth.json` entries. Ganban reads the owner's config here,
/// outside the sandbox; the run never sees the rest of it.
pub(crate) fn stage_config(real_agent: &Path, agent_dir: &Path, model: Option<&str>) -> Result<Staged> {
    std::fs::create_dir_all(agent_dir)?;
    let settings = read_json(&real_agent.join("settings.json"));
    let provider = provider_of(model, &settings);
    let keep = |k: &String| provider.as_deref().map_or(true, |p| k == p);

    let mut s: Map<String, Value> =
        settings.iter().filter(|(k, _)| SETTINGS_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    s.insert("enableInstallTelemetry".into(), Value::Bool(false));
    write_json(&agent_dir.join("settings.json"), &Value::Object(s), false)?;

    let mut endpoints = Vec::new();
    if let Some(u) = settings.get("httpProxy").and_then(Value::as_str) {
        endpoints.extend(endpoint_of(u));
    }

    let mut secrets = Vec::new();
    let mut models = read_json(&real_agent.join("models.json"));
    if let Some(Value::Object(providers)) = models.get_mut("providers") {
        providers.retain(|k, _| keep(k));
        for p in providers.values() {
            if let Some(u) = p.get("baseUrl").and_then(Value::as_str) {
                endpoints.extend(endpoint_of(u));
            }
            // Literal keys and auth headers (not `!command` or env names).
            let headers = p.get("headers").and_then(Value::as_object).into_iter().flat_map(|h| h.values());
            for v in p.get("apiKey").into_iter().chain(headers) {
                if let Some(v) = v.as_str().filter(|v| v.len() >= 16 && !v.starts_with('!')) {
                    secrets.push(v.to_string());
                }
            }
        }
    }
    if !models.is_empty() {
        write_json(&agent_dir.join("models.json"), &Value::Object(models), true)?;
    }

    let mut auth = read_json(&real_agent.join("auth.json"));
    auth.retain(|k, _| keep(k));
    for entry in auth.values() {
        if let Value::Object(fields) = entry {
            secrets.extend(fields.values().filter_map(Value::as_str).filter(|s| s.len() >= 16).map(String::from));
        }
    }
    write_json(&agent_dir.join("auth.json"), &Value::Object(auth.clone()), true)?;

    endpoints.sort();
    endpoints.dedup();
    Ok(Staged { provider, endpoints, secrets, auth_before: auth })
}

/// pi refreshes OAuth logins in place. A refresh inside a run lands in the
/// staged copy; carry it back so the owner's login keeps working.
///
/// The staged file is writable by the run, so it is untrusted: only an entry
/// Ganban staged, still OAuth, and newer (`expires`) than the one on disk is
/// carried back. The owner's file is updated under pi's own lock
/// (`auth.json.lock`), and left alone if it can't be read as JSON.
pub(crate) fn write_back_auth(real_agent: &Path, agent_dir: &Path, staged: &Staged) -> Result<()> {
    let after = read_json(&agent_dir.join("auth.json"));
    let expires = |v: &Value| v.get("expires").and_then(Value::as_i64).unwrap_or(0);
    let is_oauth = |v: &Value| v.get("type").and_then(Value::as_str) == Some("oauth");
    let changed: Vec<(&String, &Value)> = after
        .iter()
        .filter(|(k, v)| {
            staged.auth_before.get(*k).map_or(false, |before| is_oauth(before) && is_oauth(v) && before != *v)
        })
        .collect();
    if changed.is_empty() {
        return Ok(());
    }
    let link = real_agent.join("auth.json");
    // Write through a symlinked auth.json to its target, keeping the link.
    let path = std::fs::canonicalize(&link).unwrap_or(link);
    let lock = path.with_file_name(format!(
        "{}.lock",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let _guard = AuthLock::acquire(&lock)?;
    let mut real: Map<String, Value> = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => m,
            _ => return Err(AppError::InvalidInput("pi's auth file isn't valid JSON; left it alone".into())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(e.into()),
    };
    let mut wrote = false;
    for (k, v) in changed {
        if real.get(k).map_or(true, |cur| expires(v) > expires(cur)) {
            real.insert(k.clone(), v.clone());
            wrote = true;
        }
    }
    if !wrote {
        return Ok(());
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!("auth.json.ganban-{}-{n}", std::process::id()));
    write_json(&tmp, &Value::Object(real), true)?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// pi's lock on its auth file: a `<file>.lock` folder (proper-lockfile). A
/// lock older than pi's 30 s stale limit is taken over.
struct AuthLock(PathBuf);

impl AuthLock {
    fn acquire(lock: &Path) -> Result<Self> {
        for _ in 0..25 {
            match std::fs::create_dir(lock) {
                Ok(()) => return Ok(Self(lock.to_path_buf())),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(lock)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .map_or(false, |age| age.as_secs() > 30);
                    if stale {
                        let _ = std::fs::remove_dir(lock);
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        Err(AppError::InvalidInput("pi's auth file stayed locked".into()))
    }
}

impl Drop for AuthLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// The run's environment: a clean slate with `PATH`, locale, proxy and
/// certificate settings, the chosen provider's API key variables, and the
/// staged config. `HOME` points at the run folder, so nothing reaches for the
/// owner's home.
pub(crate) fn sandbox_env(
    plan: &Plan,
    provider: Option<&str>,
    parent: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = parent
        .into_iter()
        .filter(|(k, _)| ENV_KEEP.contains(&k.as_str()) || provider.map_or(false, |p| is_provider_key(p, k)))
        .collect();
    let path = |p: PathBuf| p.to_string_lossy().into_owned();
    env.push(("HOME".into(), path(plan.run_dir.clone())));
    env.push(("TMPDIR".into(), path(plan.tmp_dir())));
    env.push(("PI_CODING_AGENT_DIR".into(), path(plan.agent_dir())));
    env.push(("PI_SKIP_VERSION_CHECK".into(), "1".into()));
    env.push(("PI_TELEMETRY".into(), "0".into()));
    env
}

/// Whether an environment variable holds `provider`'s credential:
/// `<PROVIDER>_…_API_KEY` or `<PROVIDER>_…_TOKEN`, plus the few providers whose
/// variable doesn't start with their name. With no provider named, a run gets
/// no key from the environment (only the staged `auth.json`).
fn is_provider_key(provider: &str, var: &str) -> bool {
    let p = provider.to_uppercase().replace('-', "_");
    let own = var.starts_with(&format!("{p}_")) && (var.ends_with("_API_KEY") || var.ends_with("_TOKEN"));
    let alias = matches!(
        (provider, var),
        ("google", "GEMINI_API_KEY")
            | ("github-copilot", "COPILOT_GITHUB_TOKEN")
            | ("huggingface", "HF_TOKEN")
            | ("vercel-ai-gateway", "AI_GATEWAY_API_KEY")
    );
    own || alias
}

/// Files and ports the kept environment needs: CA bundles must be readable,
/// proxies reachable.
pub(crate) fn env_needs(env: &[(String, String)], rt: &mut Runtime, endpoints: &mut Vec<Endpoint>) {
    for (k, v) in env {
        match k.as_str() {
            "SSL_CERT_FILE" | "NODE_EXTRA_CA_CERTS" => rt.files.push(PathBuf::from(v)),
            k if k.to_ascii_uppercase().ends_with("_PROXY") && k.to_ascii_uppercase() != "NO_PROXY" => {
                endpoints.extend(endpoint_of(v))
            }
            _ => {}
        }
    }
    endpoints.sort();
    endpoints.dedup();
}

/// True when the result repeats a credential the run held.
pub(crate) fn leaks_secret(text: &str, secrets: &[String]) -> bool {
    secrets.iter().any(|s| !s.is_empty() && text.contains(s.as_str()))
}

/// The owner's override for running without a sandbox (see `UNSANDBOXED_ENV`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn unsandboxed_allowed(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan() -> Plan {
        Plan {
            run_dir: PathBuf::from("/private/var/folders/xy/T/ganban-pi-task-x"),
            runtime: Runtime {
                dirs: vec![PathBuf::from("/opt/homebrew/lib/node_modules"), PathBuf::from("/opt/homebrew/Cellar")],
                files: vec![PathBuf::from("/opt/homebrew/bin/pi"), PathBuf::from("/opt/homebrew/bin/node")],
            },
            endpoints: vec![Endpoint::Loopback(11434)],
        }
    }

    #[test]
    fn seatbelt_denies_reads_by_default_and_allows_the_list() {
        let p = seatbelt_profile(&plan());
        assert!(p.contains("(deny file-read* file-write*)"), "{p}");
        assert!(!p.contains("(allow file-read* (subpath \"/Users"), "no user folder may be readable: {p}");
        assert!(!p.contains("(subpath \"/private/tmp\")") && !p.contains("(subpath \"/private/var/folders\")"),
            "shared temp must not be readable: {p}");
        assert!(p.contains("(allow file-read* file-write* (subpath \"/private/var/folders/xy/T/ganban-pi-task-x\"))"));
        assert!(p.contains("(subpath \"/opt/homebrew/lib/node_modules\")"));
        assert!(p.contains("(literal \"/opt/homebrew/bin/pi\")"));
        // Ancestors get metadata only, so path resolution works but listing doesn't.
        assert!(p.contains("(literal \"/opt/homebrew\")") && p.contains("(literal \"/private/var/folders/xy\")"));
        assert!(p.contains("(deny mach-lookup (global-name \"com.apple.SecurityServer\")"));
        // /etc and /dev are listed file by file, not whole.
        assert!(!p.contains("(subpath \"/private/etc\")") && !p.contains("(subpath \"/dev\")"), "{p}");
        assert!(p.contains("(literal \"/private/etc/hosts\")") && p.contains("(literal \"/dev/urandom\")"));
        // The data volume's firmlinks are denied after every allow.
        let deny = p.find("(deny file-read* file-write* (subpath \"/System/Volumes/Data\"))").expect("firmlink deny");
        assert!(deny > p.find("(allow file-read* file-write* (subpath").unwrap());
    }

    #[test]
    fn seatbelt_limits_the_network_to_tls_dns_and_named_ports() {
        let p = seatbelt_profile(&plan());
        assert!(p.contains("(deny network-outbound)"));
        assert!(p.contains("(remote tcp \"*:443\")"));
        assert!(p.contains("(remote tcp \"localhost:11434\")"));
        assert!(!p.contains("*:80\""));
    }

    #[test]
    fn seatbelt_escapes_quotes_in_paths() {
        let mut pl = plan();
        pl.run_dir = PathBuf::from("/tmp/a\"b");
        let p = seatbelt_profile(&pl);
        assert!(p.contains("(subpath \"/tmp/a\\\"b\")"), "{p}");
    }

    #[test]
    fn bwrap_binds_only_the_allowlist() {
        let mut pl = plan();
        pl.run_dir = PathBuf::from("/tmp/ganban-pi-task-x");
        let a = bwrap_args(&pl).join(" ");
        assert!(!a.contains("--ro-bind / /") && !a.contains("--bind / /"), "the whole disk must not be bound: {a}");
        assert!(!a.contains(" /home") && !a.contains(" /root"), "{a}");
        assert!(a.contains("--ro-bind-try /usr /usr"));
        assert!(a.contains("--ro-bind-try /opt/homebrew/lib/node_modules /opt/homebrew/lib/node_modules"));
        assert!(a.contains("--unshare-all --share-net"));
        assert!(a.contains("--die-with-parent"));
        // The run folder is bound after the /tmp tmpfs, so it isn't hidden by it.
        let tmpfs = a.find("--tmpfs /tmp").unwrap();
        let run = a.find("--bind /tmp/ganban-pi-task-x /tmp/ganban-pi-task-x").unwrap();
        assert!(run > tmpfs, "{a}");
        assert!(a.ends_with("--chdir /tmp/ganban-pi-task-x"));
    }

    #[test]
    fn unsandboxed_needs_an_explicit_one() {
        assert!(unsandboxed_allowed(Some("1")));
        assert!(!unsandboxed_allowed(None));
        assert!(!unsandboxed_allowed(Some("true")));
        assert!(!unsandboxed_allowed(Some("")));
    }

    #[test]
    fn runtime_follows_the_shebang_into_a_homebrew_keg() {
        let root = std::env::temp_dir().join(format!("ganban-pisb-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let pkg = root.join("brew/lib/node_modules/@x/pi/dist");
        let keg = root.join("brew/Cellar/node/1.0/bin");
        let bin = root.join("brew/bin");
        for d in [&pkg, &keg, &bin] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(pkg.join("cli.js"), "#!/usr/bin/env node\n").unwrap();
        std::fs::write(keg.join("node"), "").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(pkg.join("cli.js"), bin.join("pi")).unwrap();
            std::os::unix::fs::symlink(keg.join("node"), bin.join("node")).unwrap();
            let rt = discover_runtime(&bin.join("pi"), Some(bin.as_os_str()));
            let brew = std::fs::canonicalize(root.join("brew")).unwrap();
            assert!(rt.dirs.contains(&brew.join("lib/node_modules")), "{rt:?}");
            assert!(rt.dirs.contains(&brew.join("Cellar")) && rt.dirs.contains(&brew.join("opt")), "{rt:?}");
            assert!(!rt.dirs.iter().any(|d| d.ends_with("var")), "{rt:?}");
            assert!(rt.files.contains(&bin.join("pi")) && rt.files.contains(&bin.join("node")), "{rt:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_keeps_only_the_chosen_provider_and_model_settings() {
        let root = std::env::temp_dir().join(format!("ganban-pisb-stage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        let agent = root.join("run/.ganban-pi/agent");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("settings.json"), json!({
            "defaultProvider": "anthropic", "defaultModel": "m", "packages": ["git:x"], "theme": "t"
        }).to_string()).unwrap();
        std::fs::write(real.join("auth.json"), json!({
            "anthropic": {"type": "api_key", "key": "sk-ant-aaaaaaaaaaaaaaaa"},
            "openai": {"type": "api_key", "key": "sk-oai-bbbbbbbbbbbbbbbb"}
        }).to_string()).unwrap();
        std::fs::write(real.join("models.json"), json!({"providers": {
            "anthropic": {}, "ollama": {"baseUrl": "http://localhost:11434/v1"}
        }}).to_string()).unwrap();

        let st = stage_config(&real, &agent, Some("anthropic/claude-x")).unwrap();
        assert_eq!(st.provider.as_deref(), Some("anthropic"));
        let auth = read_json(&agent.join("auth.json"));
        assert!(auth.contains_key("anthropic") && !auth.contains_key("openai"), "{auth:?}");
        assert_eq!(st.secrets, vec!["sk-ant-aaaaaaaaaaaaaaaa".to_string()]);
        let settings = read_json(&agent.join("settings.json"));
        assert!(!settings.contains_key("packages") && !settings.contains_key("theme"), "{settings:?}");
        assert_eq!(settings.get("defaultModel"), Some(&json!("m")));
        assert!(st.endpoints.is_empty(), "the other provider's port stays closed: {:?}", st.endpoints);

        // No model: pi's default provider. A local provider opens its port.
        let st = stage_config(&real, &agent, Some("ollama/llama")).unwrap();
        assert_eq!(st.endpoints, vec![Endpoint::Loopback(11434)]);
        assert!(read_json(&agent.join("auth.json")).is_empty());
        let st = stage_config(&real, &agent, None).unwrap();
        assert_eq!(st.provider.as_deref(), Some("anthropic"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oauth_refreshes_carry_back_and_api_keys_do_not() {
        let root = std::env::temp_dir().join(format!("ganban-pisb-oauth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        let agent = root.join("agent");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("auth.json"), json!({
            "anthropic": {"type": "oauth", "refresh": "r1-0000000000000000", "access": "a1", "expires": 1},
            "zai": {"type": "api_key", "key": "k"}
        }).to_string()).unwrap();
        let st = stage_config(&real, &agent, Some("anthropic/x")).unwrap();
        std::fs::write(agent.join("auth.json"), json!({
            "anthropic": {"type": "oauth", "refresh": "r2-0000000000000000", "access": "a2", "expires": 2}
        }).to_string()).unwrap();
        write_back_auth(&real, &agent, &st).unwrap();
        let after = read_json(&real.join("auth.json"));
        assert_eq!(after["anthropic"]["refresh"], json!("r2-0000000000000000"));
        assert_eq!(after["zai"]["key"], json!("k"), "other entries are untouched");
        assert!(!real.join("auth.json.lock").exists(), "the lock is released");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(real.join("auth.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // The staged file is the run's to write: a planted entry, an older
        // token, or an API key change never reach the owner's file.
        std::fs::write(agent.join("auth.json"), json!({
            "anthropic": {"type": "oauth", "refresh": "r0-0000000000000000", "access": "a0", "expires": 0},
            "github-copilot": {"type": "oauth", "refresh": "planted-000000000000", "access": "x", "expires": 9},
            "zai": {"type": "api_key", "key": "evil"}
        }).to_string()).unwrap();
        write_back_auth(&real, &agent, &st).unwrap();
        let after = read_json(&real.join("auth.json"));
        assert_eq!(after["anthropic"]["refresh"], json!("r2-0000000000000000"));
        assert!(!after.contains_key("github-copilot"));
        assert_eq!(after["zai"]["key"], json!("k"));

        // An owner's file that isn't JSON is left alone, not overwritten.
        std::fs::write(real.join("auth.json"), "{ broken").unwrap();
        std::fs::write(agent.join("auth.json"), json!({
            "anthropic": {"type": "oauth", "refresh": "r3-0000000000000000", "access": "a3", "expires": 3}
        }).to_string()).unwrap();
        assert!(write_back_auth(&real, &agent, &st).is_err());
        assert_eq!(std::fs::read_to_string(real.join("auth.json")).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn env_is_a_clean_slate_with_the_providers_key() {
        let pl = plan();
        let parent = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "a".to_string()),
            ("OPENAI_API_KEY".to_string(), "o".to_string()),
            ("GANBAN_DB".to_string(), "/x/gansty.db".to_string()),
            ("HOME".to_string(), "/Users/me".to_string()),
        ];
        let env = sandbox_env(&pl, Some("anthropic"), parent);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some("/usr/bin"));
        assert_eq!(get("ANTHROPIC_API_KEY"), Some("a"));
        assert_eq!(get("OPENAI_API_KEY"), None);
        assert_eq!(get("GANBAN_DB"), None);
        assert_eq!(get("HOME"), Some("/private/var/folders/xy/T/ganban-pi-task-x"));
        assert_eq!(get("PI_CODING_AGENT_DIR"), Some("/private/var/folders/xy/T/ganban-pi-task-x/.ganban-pi/agent"));

        // No provider named: no key from the environment at all.
        let env = sandbox_env(&pl, None, vec![("ANTHROPIC_API_KEY".to_string(), "a".to_string())]);
        assert!(!env.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"));
        assert!(is_provider_key("google", "GEMINI_API_KEY"));
        assert!(is_provider_key("anthropic", "ANTHROPIC_OAUTH_TOKEN"));
        assert!(!is_provider_key("anthropic", "STRIPE_API_KEY"));
    }

    #[test]
    fn proxies_and_ca_files_widen_the_plan() {
        let mut rt = Runtime::default();
        let mut eps = Vec::new();
        env_needs(&[
            ("HTTPS_PROXY".into(), "http://127.0.0.1:3128".into()),
            ("NODE_EXTRA_CA_CERTS".into(), "/etc/corp.pem".into()),
            ("NO_PROXY".into(), "http://example.com:81".into()),
        ], &mut rt, &mut eps);
        assert_eq!(eps, vec![Endpoint::Loopback(3128)]);
        assert_eq!(rt.files, vec![PathBuf::from("/etc/corp.pem")]);
    }

    #[test]
    fn a_result_repeating_a_credential_is_caught() {
        let s = vec!["sk-ant-aaaaaaaaaaaaaaaa".to_string()];
        assert!(leaks_secret("here: sk-ant-aaaaaaaaaaaaaaaa", &s));
        assert!(!leaks_secret("a summary", &s));
    }
}

/// The sandbox itself, run for real (no pi, no model, no cost): a shell inside
/// the macOS profile tries the paths a prompt-injected run would go for.
/// `cargo test -p ganban-server --lib pi_sandbox::live -- --ignored`
#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;
    use std::process::Command;

    fn sandboxed_sh(plan: &Plan, script: &str) -> std::process::Output {
        let profile = seatbelt_profile(plan);
        Command::new("/usr/bin/sandbox-exec")
            .arg("-p").arg(&profile).arg("/bin/sh").arg("-c").arg(script)
            .env_clear()
            .envs(sandbox_env(plan, None, [("PATH".to_string(), "/usr/bin:/bin".to_string())]))
            .current_dir(&plan.run_dir)
            .output()
            .unwrap()
    }

    #[test]
    #[ignore = "runs sandbox-exec against this machine's real home folder"]
    fn private_paths_are_unreadable_from_a_run() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap()
            .join(format!("ganban-pisb-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let run = base.join("run");
        // A stand-in Ganban database beside the run (temp is not shared).
        let other = base.join("other-data");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(run.join("note.txt"), "inside").unwrap();
        std::fs::write(other.join("gansty.db"), "CANARY").unwrap();
        let plan = Plan { run_dir: run.clone(), runtime: Runtime::default(), endpoints: vec![] };
        std::fs::create_dir_all(plan.tmp_dir()).unwrap();

        // Positive control: the run's own folder is readable and writable.
        let ok = sandboxed_sh(&plan, "cat note.txt && echo w > written.txt && cat written.txt");
        assert_eq!(String::from_utf8_lossy(&ok.stdout), "insidew\n", "{ok:?}");
        // And TLS on 443 (the model API's door) is open.
        let tls = sandboxed_sh(&plan, "curl -sS -m 10 -o /dev/null https://example.com");
        assert!(tls.status.success(), "TLS on 443 must stay reachable: {tls:?}");

        // Every probe sends its output to /dev/null: a probe that wrongly
        // succeeds proves the gap without showing private data.
        let data_dir = home.join("Library/Application Support/com.scs.gansty");
        let probes: Vec<(String, String)> = vec![
            ("stand-in gansty.db".into(), format!("cat '{}'", other.join("gansty.db").display())),
            ("Ganban data folder".into(), format!("ls '{}'", data_dir.display())),
            ("~/.ssh".into(), format!("ls '{}'", home.join(".ssh").display())),
            ("~/.ssh key".into(), format!("cat '{}'", home.join(".ssh/id_ed25519").display())),
            ("~/.pi/agent/auth.json".into(), format!("cat '{}'", home.join(".pi/agent/auth.json").display())),
            ("~/.pi/agent/sessions".into(), format!("ls '{}'", home.join(".pi/agent/sessions").display())),
            ("~/Documents".into(), format!("ls '{}'", home.join("Documents").display())),
            ("~/Dev".into(), format!("ls '{}'", home.join("Dev").display())),
            ("keychains".into(), format!("ls '{}'", home.join("Library/Keychains").display())),
            ("shared /tmp".into(), "ls /private/tmp".into()),
            ("~/.ssh via the data volume".into(), format!("ls '/System/Volumes/Data{}'", home.join(".ssh").display())),
            ("/Users/Shared".into(), "ls /Users/Shared".into()),
            ("/Library/Application Support".into(), "ls '/Library/Application Support'".into()),
            ("/private/etc".into(), "ls /private/etc".into()),
            ("Homebrew var".into(), "ls /opt/homebrew/var /usr/local/var".into()),
            ("plain HTTP".into(), "curl -sS -m 5 -o /dev/null http://example.com".into()),
        ];
        let mut report = Vec::new();
        for (name, cmd) in &probes {
            let out = sandboxed_sh(&plan, &format!("{cmd} >/dev/null"));
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            report.push(format!("{name}: {}", if out.status.success() { "READABLE".to_string() } else { format!("denied ({err})") }));
        }
        println!("{}", report.join("\n"));
        let _ = std::fs::remove_dir_all(&base);
        let open: Vec<&String> = report.iter().filter(|l| l.ends_with("READABLE")).collect();
        assert!(open.is_empty(), "SANDBOX GAP: {open:?}");
    }
}
