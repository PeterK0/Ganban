//! Gmail (and any XOAUTH2 IMAP) sign-in via **bring-your-own OAuth client**.
//!
//! No shared client secret ships in Ganban — that path requires Google's
//! restricted-scope verification + an annual paid CASA audit. Instead each
//! owner creates their own Google Cloud "Desktop app" OAuth client once and
//! pastes its id (+ secret) here; under Google's personal-use exemption that
//! needs no verification. We run the standard installed-app flow: system
//! browser + loopback redirect + PKCE, exchange the code for a refresh token,
//! and mint a short-lived access token at each IMAP connect. The refresh token
//! lives host-side in the account row, never leaves the daemon.
//!
//! Loopback only works where the browser and this listener are the same
//! machine — i.e. the desktop/host. App passwords remain the universal path
//! for remote members.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// The only Gmail IMAP scope Google offers (full mailbox access via XOAUTH2).
const GMAIL_SCOPE: &str = "https://mail.google.com/";
/// Abandon a half-finished browser dance after this long.
const FLOW_TTL_SECS: u64 = 600;

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).expect("OS RNG");
    b64url(&buf)
}

/// The result a browser dance produces, keyed by flow id and polled by the UI.
#[derive(Clone)]
pub enum FlowState {
    Pending,
    /// Got a refresh token; the account can now be created with it. The refresh
    /// token stays server-side — the UI only learns the resolved email + that
    /// it's ready.
    Done { email: String, refresh_token: String },
    Error(String),
}

/// Sign-ins in progress. Each flow belongs to the user who began it: only they
/// can poll it or claim its token, and each user has at most one loopback
/// listener open (a new sign-in cancels their previous one).
#[derive(Default)]
pub struct OAuthFlows {
    inner: Mutex<HashMap<String, (i64, FlowState)>>,
    listeners: Mutex<HashMap<i64, tokio::task::AbortHandle>>,
}

impl OAuthFlows {
    fn set(&self, id: &str, user_id: i64, state: FlowState) {
        self.inner.lock().unwrap().insert(id.to_string(), (user_id, state));
    }
    /// Update a flow's state, keeping its owner (a no-op once it's gone).
    fn update(&self, id: &str, state: FlowState) {
        if let Some(entry) = self.inner.lock().unwrap().get_mut(id) {
            entry.1 = state;
        }
    }
    fn peek(&self, id: &str, user_id: i64) -> Option<FlowState> {
        match self.inner.lock().unwrap().get(id) {
            Some((owner, state)) if *owner == user_id => Some(state.clone()),
            _ => None,
        }
    }
    /// Consume a completed flow's refresh token (one-shot, at account create).
    /// Only the user who began the flow can claim it.
    pub fn take_done(&self, id: &str, user_id: i64) -> Option<(String, String)> {
        let mut map = self.inner.lock().unwrap();
        match map.get(id) {
            Some((owner, FlowState::Done { email, refresh_token })) if *owner == user_id => {
                let out = (email.clone(), refresh_token.clone());
                map.remove(id);
                Some(out)
            }
            _ => None,
        }
    }
    /// Cancel `user_id`'s sign-ins: close the listener and forget their flows,
    /// including a finished one whose token was never claimed (a new sign-in
    /// supersedes it, so it doesn't sit in memory).
    fn cancel_pending(&self, user_id: i64) {
        if let Some(task) = self.listeners.lock().unwrap().remove(&user_id) {
            task.abort();
        }
        self.inner.lock().unwrap().retain(|_, (owner, _)| *owner != user_id);
    }
}

pub type SharedFlows = std::sync::Arc<OAuthFlows>;

/// What `begin` hands back to the UI: open `auth_url`, then poll `flow_id`.
pub struct Begun {
    pub flow_id: String,
    pub auth_url: String,
}

/// Start a sign-in: bind a loopback listener on an ephemeral port, build the
/// PKCE auth URL pointing back at it, and spawn the catcher. Returns
/// immediately; the browser dance completes in the background.
pub async fn begin(flows: SharedFlows, user_id: i64, client_id: String, client_secret: Option<String>) -> Result<Begun, String> {
    flows.cancel_pending(user_id);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a loopback port for sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_b64(48);
    let challenge = b64url(Sha256::digest(verifier.as_bytes()).as_slice());
    let state = random_b64(16);
    let flow_id = random_b64(16);

    let auth_url = format!(
        "{AUTH_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(GMAIL_SCOPE),
        challenge,
        state,
    );

    flows.set(&flow_id, user_id, FlowState::Pending);
    let flow_id_bg = flow_id.clone();
    let flows_bg = flows.clone();
    let task = tokio::spawn(async move {
        let outcome = run_callback(listener, &redirect_uri, &client_id, client_secret.as_deref(), &verifier, &state).await;
        flows_bg.update(
            &flow_id_bg,
            match outcome {
                Ok((email, refresh_token)) => FlowState::Done { email, refresh_token },
                Err(e) => FlowState::Error(e),
            },
        );
    });
    flows.listeners.lock().unwrap().insert(user_id, task.abort_handle());

    Ok(Begun { flow_id, auth_url })
}

/// Await the single browser redirect, extract the code, exchange it for tokens.
async fn run_callback(
    listener: tokio::net::TcpListener,
    redirect_uri: &str,
    client_id: &str,
    client_secret: Option<&str>,
    verifier: &str,
    expected_state: &str,
) -> Result<(String, String), String> {
    let accept = async {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
        let req = String::from_utf8_lossy(&buf[..n]);
        // First line: "GET /?code=...&state=... HTTP/1.1"
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let params = query_params(target);
        let body = "<html><body style='font-family:sans-serif;padding:3rem;text-align:center'><h2>Ganban is signed in.</h2><p>You can close this tab and return to the app.</p></body></html>";
        let _ = sock
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
        let _ = sock.flush().await;
        if let Some(err) = params.get("error") {
            return Err(format!("Google denied the sign-in: {err}"));
        }
        if params.get("state").map(String::as_str) != Some(expected_state) {
            return Err("sign-in state mismatch (possible CSRF) — try again".to_string());
        }
        params.get("code").cloned().ok_or_else(|| "no authorization code in the redirect".to_string())
    };

    let code = tokio::time::timeout(Duration::from_secs(FLOW_TTL_SECS), accept)
        .await
        .map_err(|_| "sign-in timed out — the browser window wasn't completed".to_string())??;

    exchange_code(redirect_uri, client_id, client_secret, &code, verifier).await
}

/// Authorization code → (email, refresh_token).
async fn exchange_code(
    redirect_uri: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
) -> Result<(String, String), String> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let client = reqwest::Client::new();
    let resp = client.post(TOKEN_ENDPOINT).form(&form).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = v.get("error_description").or_else(|| v.get("error")).and_then(|e| e.as_str()).unwrap_or("token exchange failed");
        return Err(format!("Google: {detail}"));
    }
    let refresh_token = v
        .get("refresh_token")
        .and_then(|t| t.as_str())
        .ok_or("Google returned no refresh token — make sure the consent screen is set to offline access and you approved it")?
        .to_string();
    let access_token = v.get("access_token").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let email = fetch_email(&access_token).await.unwrap_or_default();
    Ok((email, refresh_token))
}

/// Look up the signed-in address from the access token (so the account
/// username is correct even before any IMAP traffic).
async fn fetch_email(access_token: &str) -> Option<String> {
    let resp = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?;
    let v: serde_json::Value = resp.json().await.ok()?;
    v.get("email").and_then(|e| e.as_str()).map(String::from)
}

/// Mint a fresh access token from a stored refresh token (called at each IMAP
/// connect — Google access tokens last ~1h; refresh tokens don't expire for a
/// published client).
pub async fn access_token(client_id: &str, client_secret: Option<&str>, refresh_token: &str) -> Result<String, String> {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let resp = reqwest::Client::new().post(TOKEN_ENDPOINT).form(&form).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = v.get("error_description").or_else(|| v.get("error")).and_then(|e| e.as_str()).unwrap_or("token refresh failed");
        return Err(format!("Google: {detail} (the account may need to be reconnected)"));
    }
    v.get("access_token").and_then(|t| t.as_str()).map(String::from).ok_or_else(|| "no access token in refresh response".to_string())
}

/// The UI's poll view of a flow.
pub fn poll(flows: &OAuthFlows, flow_id: &str, user_id: i64) -> serde_json::Value {
    match flows.peek(flow_id, user_id) {
        Some(FlowState::Pending) => serde_json::json!({ "status": "pending" }),
        None => serde_json::json!({ "status": "error", "error": "no sign-in in progress — start again" }),
        Some(FlowState::Done { email, .. }) => serde_json::json!({ "status": "done", "email": email }),
        Some(FlowState::Error(e)) => serde_json::json!({ "status": "error", "error": e }),
    }
}

/// Minimal percent-encoding for query values (alnum + unreserved pass through).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse a request target's query string into a map (values percent-decoded).
fn query_params(target: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(q) = target.split('?').nth(1) {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(k.to_string(), percent_decode(v));
            }
        }
    }
    map
}

fn percent_decode(s: &str) -> String {
    let bytes = s.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_b64url_sha256_of_verifier() {
        // RFC 7636 reference vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = b64url(Sha256::digest(verifier.as_bytes()).as_slice());
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn auth_url_carries_the_offline_gmail_request() {
        // Build the URL the way begin() does and check the load-bearing params.
        let url = format!(
            "{AUTH_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge=X&code_challenge_method=S256&state=Y&access_type=offline&prompt=consent",
            urlencode("123.apps.googleusercontent.com"),
            urlencode("http://127.0.0.1:54321"),
            urlencode(GMAIL_SCOPE),
        );
        assert!(url.contains("scope=https%3A%2F%2Fmail.google.com%2F"), "the full IMAP scope, percent-encoded");
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321"), "loopback redirect");
        assert!(url.contains("access_type=offline") && url.contains("prompt=consent"), "forces a refresh token");
        assert!(url.contains("code_challenge_method=S256"), "PKCE");
    }

    #[test]
    fn redirect_query_is_parsed_and_decoded() {
        let p = query_params("/?code=4%2F0Ab_xYz&state=abc123&scope=https%3A%2F%2Fmail.google.com%2F");
        assert_eq!(p.get("code").unwrap(), "4/0Ab_xYz");
        assert_eq!(p.get("state").unwrap(), "abc123");
        let err = query_params("/?error=access_denied&state=abc");
        assert_eq!(err.get("error").unwrap(), "access_denied");
    }

    #[test]
    fn flow_store_take_done_is_one_shot() {
        let flows = OAuthFlows::default();
        flows.set("f1", 7, FlowState::Pending);
        assert!(flows.take_done("f1", 7).is_none(), "a pending flow yields nothing");
        flows.update("f1", FlowState::Done { email: "me@gmail.com".into(), refresh_token: "RT".into() });
        assert_eq!(flows.take_done("f1", 7), Some(("me@gmail.com".to_string(), "RT".to_string())));
        assert!(flows.take_done("f1", 7).is_none(), "consumed — second take is empty");
    }

    /// A sign-in is its starter's own: another member can neither poll it nor
    /// claim the refresh token, even knowing the flow id.
    #[test]
    fn a_flow_belongs_to_the_user_who_began_it() {
        let flows = OAuthFlows::default();
        flows.set("f1", 7, FlowState::Done { email: "me@gmail.com".into(), refresh_token: "RT".into() });
        assert_eq!(poll(&flows, "f1", 8)["status"], "error", "someone else's flow is invisible");
        assert!(flows.take_done("f1", 8).is_none(), "someone else can't claim it");
        assert_eq!(poll(&flows, "f1", 7)["status"], "done");
        assert!(flows.take_done("f1", 7).is_some(), "the starter still can");
    }

    /// Beginning again cancels the user's unfinished sign-in (one listener
    /// each), and leaves other users' flows alone.
    #[tokio::test]
    async fn a_new_sign_in_cancels_the_users_previous_one() {
        let flows: SharedFlows = std::sync::Arc::new(OAuthFlows::default());
        let first = begin(flows.clone(), 7, "client".into(), None).await.unwrap();
        let other = begin(flows.clone(), 8, "client".into(), None).await.unwrap();
        let second = begin(flows.clone(), 7, "client".into(), None).await.unwrap();
        assert_eq!(poll(&flows, &first.flow_id, 7)["status"], "error", "the first flow is gone");
        assert_eq!(poll(&flows, &second.flow_id, 7)["status"], "pending");
        assert_eq!(poll(&flows, &other.flow_id, 8)["status"], "pending", "user 8's flow is untouched");
        assert_eq!(flows.listeners.lock().unwrap().len(), 2, "one listener per user");
    }
}
