//! Optional auto-issued Tailscale device shares (docs/design/TailscaleAutoShare.md).
//!
//! When the owner configures a Tailscale credential (app-setting `tailscale_api`)
//! AND picks which tailnet device is this server (`tailscale_device_id`), minting
//! a Ganban project invite can ALSO mint a one-time Tailscale **device-share**
//! invite for that machine — so a single link folds the network join and the app
//! join together. We use device invites (share ONE machine to an external user;
//! they stay on their own tailnet, see none of the owner's other devices, consume
//! no seat) — never user invites (join-the-whole-tailnet, the wrong primitive).
//!
//! The credential is owner-only and host-side — it NEVER leaves the host (same
//! contract as the GIPHY key / ragrat token). Entirely optional: with no
//! `tailscale_api`, `create_share` returns `None` and invites carry only {u,t},
//! exactly as before. We never call the accept endpoint — acceptance is the
//! recipient's own credentialed action in their browser.

use ganban_core::Db;
use serde_json::{json, Value};
use std::time::Duration;

const API_BASE: &str = "https://api.tailscale.com/api/v2";

/// Owner-configured Tailscale credential, read from app-setting `tailscale_api`
/// (JSON). Either a raw API access token (`tskey-api-…`) used directly as Bearer,
/// or an OAuth client (`client_id`/`client_secret`, scoped `devices:invites`) from
/// which we mint a short-lived access token per call (preferred — no broad,
/// long-lived key at rest). `tailnet` defaults to `-` (the credential's own
/// default tailnet) so the owner needn't know its name.
struct TailscaleConfig {
    access_token: Option<String>,
    oauth: Option<(String, String)>, // (client_id, client_secret)
    tailnet: String,
}

/// Expiry of an API access token, as Tailscale reports it. `None` when the
/// credential is an OAuth client (secrets don't expire) or the lookup failed —
/// which is never an error: expiry is advice, the share is the job.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenExpiry {
    /// RFC 3339, from the API.
    pub expires: String,
    /// Whole days from now (negative = already expired — the API would 401).
    pub days_left: i64,
}

impl TailscaleConfig {
    /// The key id embedded in a raw access token: `tskey-api-<keyId>-<secret>`.
    /// Lets us ask the API about OUR OWN token (`/tailnet/{t}/keys/{id}`).
    fn key_id(&self) -> Option<&str> {
        let t = self.access_token.as_deref()?;
        let rest = t.strip_prefix("tskey-api-")?;
        let id = rest.split('-').next()?;
        (!id.is_empty()).then_some(id)
    }

    /// Best-effort: when does this access token expire? (See `TokenExpiry`.)
    async fn token_expiry(&self, client: &reqwest::Client, bearer: &str) -> Option<TokenExpiry> {
        let id = self.key_id()?;
        let resp = client
            .get(format!("{API_BASE}/tailnet/{}/keys/{id}", self.tailnet))
            .bearer_auth(bearer)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: Value = resp.json().await.ok()?;
        let expires = v.get("expires")?.as_str()?.to_string();
        let at = chrono::DateTime::parse_from_rfc3339(&expires).ok()?;
        let days_left = (at.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
        Some(TokenExpiry { expires, days_left })
    }

    async fn from_db(db: &Db) -> Option<TailscaleConfig> {
        let raw = ganban_core::ops::get_app_setting(db, "tailscale_api").await.ok().flatten()?;
        Self::parse(&raw)
    }

    /// Parse the stored JSON. Split out for unit testing (no DB/network).
    fn parse(raw: &str) -> Option<TailscaleConfig> {
        let v: Value = serde_json::from_str(raw).ok()?;
        let access_token = v
            .get("access_token")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let oauth = match (
            v.get("oauth").and_then(|o| o.get("client_id")).and_then(|s| s.as_str()).map(str::trim),
            v.get("oauth").and_then(|o| o.get("client_secret")).and_then(|s| s.as_str()).map(str::trim),
        ) {
            (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Some((id.to_string(), secret.to_string())),
            _ => None,
        };
        // Neither a usable access token nor an OAuth client → not configured.
        if access_token.is_none() && oauth.is_none() {
            return None;
        }
        let tailnet = v
            .get("tailnet")
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("-")
            .to_string();
        Some(TailscaleConfig { access_token, oauth, tailnet })
    }

    /// Whether this credential can MINT a device share (the write path), and a
    /// reason when it can't. Tailscale scopes a device share to a USER, so only a
    /// personal API access token (`tskey-api-…`, tied to your account) can create
    /// one — an OAuth client can LIST devices (so the credential validates and the
    /// Settings "Check" passes) but every share request 400s. Reporting this at
    /// Check time is what stops the silent "lists fine, never shares" misconfig
    /// from looking healthy. (A personal token has full account scope, so once
    /// present it can always share — there's no narrower failure mode to probe.)
    fn share_capability(&self) -> (bool, Option<String>) {
        if self.access_token.is_some() {
            (true, None)
        } else {
            (
                false,
                Some(
                    "This credential is an OAuth client — it can list devices, but Tailscale won't let it create a device share (a share is scoped to a user). Cross-tailnet invites will go out with no one-click share. Use a personal API access token (tskey-api-…) instead."
                        .to_string(),
                ),
            )
        }
    }

    /// Bearer token for an API call: the raw access token if given, else minted
    /// fresh from the OAuth client (client-credentials grant — short-lived).
    async fn bearer(&self, client: &reqwest::Client) -> Result<String, String> {
        if let Some(tok) = &self.access_token {
            return Ok(tok.clone());
        }
        let (id, secret) = self.oauth.as_ref().ok_or("no Tailscale credential configured")?;
        let form = [
            ("grant_type", "client_credentials"),
            ("client_id", id.as_str()),
            ("client_secret", secret.as_str()),
        ];
        let resp = client
            .post(format!("{API_BASE}/oauth/token"))
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("Tailscale OAuth: {e}"))?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| format!("Tailscale OAuth: {e}"))?;
        if !status.is_success() {
            let d = v.get("error_description").or_else(|| v.get("error")).and_then(|e| e.as_str()).unwrap_or("token request failed");
            return Err(format!("Tailscale OAuth {}: {d}", status.as_u16()));
        }
        v.get("access_token").and_then(|t| t.as_str()).map(String::from).ok_or_else(|| "Tailscale OAuth returned no access token".into())
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Ganban/0.5 (tailscale-share)")
        .build()
        .map_err(|e| e.to_string())
}

/// A rejected credential (401/403) → owner-actionable guidance, not a raw code.
fn explain(status: u16, action: &str, body: &Value) -> String {
    // Tailscale returns the real reason in the body ({"message": "..."}); always
    // surface it — a 400 means the request was rejected (bad device id/body), not
    // an auth problem, and the message says exactly why.
    let detail = body
        .get("message")
        .and_then(|m| m.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!(" — {s}"))
        .unwrap_or_default();
    if status == 401 {
        // Tailscale caps personal API access tokens at 90 days. A 401 on a
        // credential that worked before is that cliff, not a scope problem.
        format!("Tailscale rejected the credential (401){detail}. API access tokens expire after at most 90 days — generate a new one at login.tailscale.com → Settings → Keys and paste it in Settings → Sync → Tailscale (Check there shows the expiry date)")
    } else if status == 403 {
        format!("the Tailscale credential lacks permission (403){detail} — a device share needs a personal API access token tied to your account; set it in Settings → Sync → Tailscale")
    } else {
        format!("Tailscale error {status} {action}{detail}")
    }
}

/// List the credential's tailnet devices — backs the Settings "Check" button.
/// Confirms the credential + scope and lets the owner pick which device is THIS
/// server. Returns `{ tailnet, devices: [{id,name,hostname,os,addresses}],
/// share_capable, share_detail }` — `share_capable` is the WRITE-path verdict
/// (can this credential mint device shares?) so the UI can warn that an
/// OAuth client lists fine but can never share, instead of letting that misconfig
/// pass Check silently and only fail later at invite time.
pub async fn list_devices(db: &Db) -> Result<Value, String> {
    let cfg = TailscaleConfig::from_db(db).await.ok_or("Tailscale sharing is not configured on this host")?;
    let client = http()?;
    let token = cfg.bearer(&client).await?;
    let resp = client
        .get(format!("{API_BASE}/tailnet/{}/devices", cfg.tailnet))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Tailscale: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("Tailscale: {e}"))?;
    if !status.is_success() {
        return Err(explain(status.as_u16(), "listing devices", &v));
    }
    let devices: Vec<Value> = v
        .get("devices")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .map(|d| {
                    json!({
                        "id": d.get("id").cloned().unwrap_or(Value::Null),
                        "name": d.get("name").cloned().unwrap_or(Value::Null),
                        "hostname": d.get("hostname").cloned().unwrap_or(Value::Null),
                        "os": d.get("os").cloned().unwrap_or(Value::Null),
                        "addresses": d.get("addresses").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let (share_capable, share_detail) = cfg.share_capability();
    let token_expiry = cfg.token_expiry(&client, &token).await;
    Ok(json!({
        "tailnet": cfg.tailnet,
        "devices": devices,
        "share_capable": share_capable,
        "share_detail": share_detail,
        // When the fuse runs out — the June design's silent 90-day cliff.
        "token_expiry": token_expiry,
    }))
}

/// Auto-issue a single-use device-share invite for the configured server device.
/// Returns the `inviteUrl`, or `None` when sharing isn't fully configured (no
/// credential, or the owner hasn't picked the server device yet) — that's NOT an
/// error, because the Ganban invite must still issue regardless. Errors only on a
/// configured-but-broken credential, surfaced as owner-actionable text.
pub async fn create_share(db: &Db) -> Result<Option<String>, String> {
    Ok(create_share_detailed(db).await?.map(|s| s.url))
}

/// A minted share plus what the panel showing it should know.
#[derive(Debug, serde::Serialize)]
pub struct Share {
    pub url: String,
    /// Set when the credential is a raw token and the API told us its expiry.
    pub token_expiry: Option<TokenExpiry>,
}

/// `create_share`, with the token's expiry attached (best-effort) so the invite
/// UI can say "renew in N days" BEFORE the next invite dead-ends on a 401.
pub async fn create_share_detailed(db: &Db) -> Result<Option<Share>, String> {
    let cfg = match TailscaleConfig::from_db(db).await {
        Some(c) => c,
        None => return Ok(None),
    };
    let device_id = match ganban_core::ops::get_app_setting(db, "tailscale_device_id")
        .await
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(id) => id,
        None => return Ok(None), // configured, but the server device isn't picked yet
    };
    let client = http()?;
    let token = cfg.bearer(&client).await?;
    // One default single-use invite; the response is an array of DeviceInvite.
    let resp = client
        .post(format!("{API_BASE}/device/{device_id}/device-invites"))
        .bearer_auth(&token)
        .json(&json!([{ "multiUse": false }]))
        .send()
        .await
        .map_err(|e| format!("Tailscale: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("Tailscale: {e}"))?;
    if !status.is_success() {
        let mut msg = explain(status.as_u16(), "creating the device share", &v);
        // Tailscale's API: a device share is scoped to a USER, so it CANNOT be
        // minted by an OAuth-client token (lists devices fine, can't share).
        // This is the usual cause of a 400 here — point at the real fix.
        if cfg.access_token.is_none() && cfg.oauth.is_some() {
            msg.push_str(". Device invites can't be created by an OAuth client (a share is scoped to a user) — use a personal API access token (tskey-api-…) instead, in Settings → Sync → Tailscale");
        }
        return Err(msg);
    }
    let Some(url) = extract_invite_url(&v) else { return Ok(None) };
    let token_expiry = cfg.token_expiry(&client, &token).await;
    Ok(Some(Share { url, token_expiry }))
}

/// Pull the first `inviteUrl` out of a device-invites response. The documented
/// shape is a bare array of DeviceInvite; we also tolerate a `{deviceInvites:[…]}`
/// envelope defensively. Split out so it's unit-testable without the network.
fn extract_invite_url(v: &Value) -> Option<String> {
    let arr = v.as_array().or_else(|| v.get("deviceInvites").and_then(|d| d.as_array()))?;
    arr.first().and_then(|i| i.get("inviteUrl")).and_then(|u| u.as_str()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_none_when_unconfigured() {
        assert!(TailscaleConfig::parse("{}").is_none());
        assert!(TailscaleConfig::parse(r#"{"tailnet":"x.com"}"#).is_none());
        assert!(TailscaleConfig::parse(r#"{"access_token":"  "}"#).is_none(), "blank token is not configured");
        assert!(TailscaleConfig::parse("not json").is_none());
    }

    #[test]
    fn parse_raw_access_token() {
        let c = TailscaleConfig::parse(r#"{"access_token":"tskey-api-abc"}"#).expect("configured");
        assert_eq!(c.access_token.as_deref(), Some("tskey-api-abc"));
        assert!(c.oauth.is_none());
        assert_eq!(c.tailnet, "-", "tailnet defaults to the credential's own");
    }

    #[test]
    fn parse_oauth_client_and_tailnet() {
        let c = TailscaleConfig::parse(r#"{"oauth":{"client_id":"k","client_secret":"s"},"tailnet":"example.com"}"#).expect("configured");
        assert!(c.access_token.is_none());
        assert_eq!(c.oauth, Some(("k".into(), "s".into())));
        assert_eq!(c.tailnet, "example.com");
    }

    #[test]
    fn key_id_comes_out_of_the_token() {
        let c = TailscaleConfig::parse(r#"{"access_token":"tskey-api-kJvQ4M1CNTRL-s3cr3tp4rt"}"#).unwrap();
        assert_eq!(c.key_id(), Some("kJvQ4M1CNTRL"));
        let oauth = TailscaleConfig::parse(r#"{"oauth":{"client_id":"k","client_secret":"s"}}"#).unwrap();
        assert_eq!(oauth.key_id(), None, "OAuth clients have no expiring key");
        let odd = TailscaleConfig::parse(r#"{"access_token":"not-a-tailscale-token"}"#).unwrap();
        assert_eq!(odd.key_id(), None);
    }

    #[test]
    fn a_401_is_explained_as_the_expiry_cliff() {
        let msg = explain(401, "creating the device share", &json!({"message": "invalid key"}));
        assert!(msg.contains("90 days"), "{msg}");
        assert!(msg.contains("Settings → Sync → Tailscale"), "{msg}");
        assert!(msg.contains("invalid key"), "keeps Tailscale's own reason: {msg}");
        let msg = explain(403, "creating the device share", &json!({}));
        assert!(msg.contains("permission"), "{msg}");
    }

    #[test]
    fn parse_ignores_partial_oauth() {
        // Only a client_id (no secret) is not a usable OAuth client.
        assert!(TailscaleConfig::parse(r#"{"oauth":{"client_id":"k"}}"#).is_none());
    }

    #[test]
    fn share_capability_distinguishes_token_from_oauth() {
        // A personal API access token can mint shares.
        let tok = TailscaleConfig::parse(r#"{"access_token":"tskey-api-abc"}"#).unwrap();
        assert_eq!(tok.share_capability(), (true, None));
        // An OAuth client lists devices (Check passes) but cannot share — this is
        // the misconfiguration the preflight surfaces.
        let oauth = TailscaleConfig::parse(r#"{"oauth":{"client_id":"k","client_secret":"s"}}"#).unwrap();
        let (capable, detail) = oauth.share_capability();
        assert!(!capable, "OAuth client cannot mint device shares");
        assert!(detail.unwrap().contains("personal API access token"), "explains the fix");
    }

    #[test]
    fn extract_invite_url_handles_both_shapes() {
        // Documented shape: a bare array of DeviceInvite.
        let arr = json!([{ "id": "1", "inviteUrl": "https://login.tailscale.com/admin/invite/AAA" }]);
        assert_eq!(extract_invite_url(&arr).as_deref(), Some("https://login.tailscale.com/admin/invite/AAA"));
        // Tolerated envelope shape.
        let env = json!({ "deviceInvites": [{ "inviteUrl": "https://login.tailscale.com/admin/invite/BBB" }] });
        assert_eq!(extract_invite_url(&env).as_deref(), Some("https://login.tailscale.com/admin/invite/BBB"));
        // No invites / wrong shape → None (not an error; caller treats as "no share").
        assert_eq!(extract_invite_url(&json!([])), None);
        assert_eq!(extract_invite_url(&json!({})), None);
        assert_eq!(extract_invite_url(&json!([{ "id": "1" }])), None);
    }
}
