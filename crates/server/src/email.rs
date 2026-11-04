//! The email tab's engine (feature `tab-email`).
//!
//! Ganban is a CLIENT of the owner's existing mailboxes — IMAP only, and
//! deliberately **no SMTP anywhere in the binary**: an approved agent draft is
//! `APPEND`ed into the mailbox's own Drafts folder, and sending only ever
//! happens in the user's real mail client. That is the human gate made
//! physical.
//!
//! Scale doctrine (selective ingestion, never mirroring): envelope-only sync
//! of the chosen folders within a horizon; full bodies are fetched ONLY for
//! threads the owner explicitly links to a project. Linking is publishing —
//! it makes the thread visible to that project's members and stages it into
//! the RAG corpus. A 100k-message company mailbox costs the same as a small
//! one, because Ganban only ever pays for what gets linked.
//!
//! Email bodies are the canonical hostile input: capped, collapsed, and never
//! able to authorize anything — drafts ride the standard proposal gate.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use ganban_core::error::AppError;
use ganban_core::models::{EmailAccount, EmailMessage};
use ganban_core::{ops, Db};
use futures_util::StreamExt;
use serde_json::{json, Value};

/// Envelope re-sync cadence for enabled accounts.
const POLL_SECS: u64 = 300;
/// Network guards.
const CONNECT_TIMEOUT_SECS: u64 = 20;
/// Per-message body cap once extracted (the RAG/тool layers re-cap anyway).
const BODY_CAP: usize = 20_000;
/// New-envelope headers are fetched in batches of this many UIDs.
const FETCH_BATCH: usize = 200;

type Session = async_imap::Session<async_native_tls::TlsStream<tokio::net::TcpStream>>;

/// XOAUTH2 SASL responder: hands the IMAP server `user=…^Aauth=Bearer …^A^A`
/// (async-imap base64-encodes it for us).
struct XOAuth2 {
    user: String,
    access_token: String,
}
impl async_imap::Authenticator for XOAuth2 {
    type Response = String;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        format!("user={}\x01auth=Bearer {}\x01\x01", self.user, self.access_token)
    }
}

/// Which addresses a mailbox connection may reach. The host owner's own
/// mailboxes may sit on the LAN or on this machine (a local IMAP bridge), but
/// not on a cloud metadata endpoint;
/// anyone else's go through the SSRF guard, so a member can't use a mailbox
/// to make the host probe its network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Any,
    PublicOnly,
}

impl Reach {
    pub fn for_caller(is_owner: bool) -> Self {
        if is_owner {
            Reach::Any
        } else {
            Reach::PublicOnly
        }
    }

    /// A stored mailbox's reach: the owner's (or a legacy unowned one) may go
    /// anywhere, a member's only to public addresses.
    pub async fn for_account(db: &Db, account: &EmailAccount) -> Self {
        let Some(uid) = account.user_id else { return Reach::Any };
        let is_owner: bool = sqlx::query_scalar("SELECT is_owner FROM users WHERE id = ?")
            .bind(uid)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .unwrap_or(false);
        Reach::for_caller(is_owner)
    }
}

/// The addresses to connect to for `host:port`, checked against `reach`.
/// Resolved once here and connected to as-is, so a DNS rebind can't swap them.
pub async fn resolve_mail_host(host: &str, port: i64, reach: Reach) -> Result<Vec<std::net::SocketAddr>, String> {
    let port = u16::try_from(port).map_err(|_| format!("{port} is not a valid port"))?;
    match reach {
        Reach::PublicOnly => crate::net_guard::resolve_public(host, port).await.map_err(|e| format!("{host}:{port}: {e}")),
        Reach::Any => crate::net_guard::resolve(host, port, crate::net_guard::Scope::OwnerNetwork)
            .await
            .map_err(|e| format!("{host}:{port}: {e}")),
    }
}

/// TCP+TLS to the mailbox, no auth yet (shared by both auth paths).
async fn open_tls(account: &EmailAccount, reach: Reach) -> Result<async_imap::Client<async_native_tls::TlsStream<tokio::net::TcpStream>>, String> {
    let addrs = resolve_mail_host(&account.host, account.port, reach).await?;
    let tcp = tokio::time::timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS), tokio::net::TcpStream::connect(&addrs[..]))
        .await
        .map_err(|_| format!("timed out connecting to {}:{}", account.host, account.port))?
        .map_err(|e| format!("could not reach {}:{} — {e}", account.host, account.port))?;
    let tls = async_native_tls::TlsConnector::new()
        .connect(&account.host, tcp)
        .await
        .map_err(|e| format!("TLS to {} failed: {e}", account.host))?;
    Ok(async_imap::Client::new(tls))
}

/// Connect + authenticate. App password (`login`) or OAuth (XOAUTH2 with a
/// freshly-minted access token from the stored refresh token).
async fn connect(account: &EmailAccount, reach: Reach) -> Result<Session, String> {
    let client = open_tls(account, reach).await?;
    if account.auth_type == "oauth" {
        let client_id = account.oauth_client_id.as_deref().ok_or("OAuth account is missing its client id")?;
        let refresh = account.oauth_refresh_token.as_deref().ok_or("OAuth account is not signed in — reconnect it")?;
        let token = crate::email_oauth::access_token(client_id, account.oauth_client_secret.as_deref(), refresh).await?;
        let auth = XOAuth2 { user: account.username.clone(), access_token: token };
        client
            .authenticate("XOAUTH2", auth)
            .await
            .map_err(|(e, _)| format!("XOAUTH2 rejected for {}: {e}", account.username))
    } else {
        client
            .login(&account.username, &account.password)
            .await
            .map_err(|(e, _)| format!("login rejected for {}: {e}", account.username))
    }
}

/// Try the account's credentials and list its folders (the Plug-ins "Test").
pub async fn test_account(account: &EmailAccount, reach: Reach) -> Result<Vec<String>, String> {
    let mut session = connect(account, reach).await?;
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| e.to_string())?
        .collect::<Vec<_>>()
        .await;
    let mut folders = Vec::new();
    for n in names.into_iter().flatten() {
        folders.push(n.name().to_string());
    }
    let _ = session.logout().await;
    folders.sort();
    Ok(folders)
}

/// Best-guess Drafts mailbox from the folder list ("[Gmail]/Drafts", "Drafts",
/// "INBOX.Drafts"…). The account card allows a manual override.
fn detect_drafts_folder(folders: &[String]) -> Option<String> {
    folders
        .iter()
        .find(|f| f.to_ascii_lowercase().ends_with("drafts"))
        .or_else(|| folders.iter().find(|f| f.to_ascii_lowercase().contains("draft")))
        .cloned()
}

/// Strip reply/forward prefixes for the subject-fallback thread key.
fn base_subject(subject: &str) -> String {
    let mut s = subject.trim();
    loop {
        let lower = s.to_ascii_lowercase();
        let stripped = ["re:", "fwd:", "fw:", "aw:", "sv:"]
            .iter()
            .find_map(|p| lower.starts_with(p).then(|| s[p.len()..].trim_start()));
        match stripped {
            Some(rest) => s = rest,
            None => break,
        }
    }
    s.to_ascii_lowercase()
}

/// Parsed header fields we thread on.
struct Parsed {
    message_id: String,
    thread_key: String,
    subject: String,
    from_addr: String,
    date: Option<DateTime<Utc>>,
}

/// Thread key from standards headers: the conversation ROOT — first References
/// entry, else In-Reply-To, else the message's own id; last resort, the
/// normalized subject. Clusters straightforward reply chains correctly on
/// every provider without proprietary extensions.
fn parse_headers(raw: &[u8]) -> Parsed {
    let msg = mail_parser::MessageParser::default().parse(raw);
    let (message_id, mut refs, in_reply_to, subject, from_addr, date) = match &msg {
        Some(m) => {
            let refs: Vec<String> = match m.references() {
                mail_parser::HeaderValue::Text(t) => vec![t.to_string()],
                mail_parser::HeaderValue::TextList(l) => l.iter().map(|t| t.to_string()).collect(),
                _ => Vec::new(),
            };
            let irt = match m.in_reply_to() {
                mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
                mail_parser::HeaderValue::TextList(l) => l.first().map(|t| t.to_string()),
                _ => None,
            };
            let from = m
                .from()
                .and_then(|a| a.first())
                .map(|a| {
                    let name = a.name().unwrap_or_default();
                    let addr = a.address().unwrap_or_default();
                    if name.is_empty() { addr.to_string() } else { format!("{name} <{addr}>") }
                })
                .unwrap_or_default();
            (
                m.message_id().unwrap_or_default().to_string(),
                refs,
                irt,
                m.subject().unwrap_or_default().to_string(),
                from,
                m.date().map(|d| d.to_timestamp()).and_then(|t| DateTime::<Utc>::from_timestamp(t, 0)),
            )
        }
        None => (String::new(), Vec::new(), None, String::new(), String::new(), None),
    };
    let thread_key = refs
        .drain(..)
        .next()
        .or(in_reply_to)
        .or_else(|| (!message_id.is_empty()).then(|| message_id.clone()))
        .unwrap_or_else(|| format!("subj:{}", base_subject(&subject)));
    Parsed { message_id, thread_key, subject, from_addr, date }
}

/// Outcome of one account sync (the Plug-ins card status line).
#[derive(Debug, Default, serde::Serialize)]
pub struct SyncSummary {
    pub new_messages: u64,
    pub folders: u64,
    pub errors: Vec<String>,
}

/// Envelope sync: for each chosen folder, find UIDs within the horizon that we
/// haven't seen (UID-window reconciliation — works on every server; CONDSTORE/
/// QRESYNC fast paths are a later optimization) and store their envelopes.
pub async fn sync_account(db: &Db, account: &EmailAccount) -> Result<SyncSummary, String> {
    let mut session = connect(account, Reach::for_account(db, account).await).await?;
    let mut summary = SyncSummary::default();

    // Detect the Drafts folder once while we're here (manual override wins).
    let drafts = if account.drafts_folder.is_empty() {
        let names: Vec<_> = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| e.to_string())?
            .collect::<Vec<_>>()
            .await;
        let folders: Vec<String> = names.into_iter().flatten().map(|n| n.name().to_string()).collect();
        detect_drafts_folder(&folders)
    } else {
        None
    };

    let since = (Utc::now() - ChronoDuration::days(account.horizon_days.max(1))).format("%d-%b-%Y").to_string();
    for folder in account.folders.split(',').map(str::trim).filter(|f| !f.is_empty()) {
        summary.folders += 1;
        let mailbox = match session.select(folder).await {
            Ok(m) => m,
            Err(e) => {
                summary.errors.push(format!("{folder}: {e}"));
                continue;
            }
        };
        let uid_validity = mailbox.uid_validity.unwrap_or(0) as i64;
        let uids = match session.uid_search(format!("SINCE {since}")).await {
            Ok(u) => u,
            Err(e) => {
                summary.errors.push(format!("{folder}: search failed: {e}"));
                continue;
            }
        };
        // Diff against what we already hold for this folder generation.
        let known: Vec<i64> = sqlx::query_scalar(
            "SELECT uid FROM email_messages WHERE account_id = ? AND folder = ? AND uid_validity = ?",
        )
        .bind(account.id)
        .bind(folder)
        .bind(uid_validity)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
        let known: std::collections::HashSet<i64> = known.into_iter().collect();
        let mut fresh: Vec<u32> = uids.into_iter().filter(|u| !known.contains(&(*u as i64))).collect();
        fresh.sort_unstable();

        for chunk in fresh.chunks(FETCH_BATCH) {
            let set = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
            let fetches: Vec<_> = match session.uid_fetch(&set, "(UID RFC822.HEADER)").await {
                Ok(stream) => stream.collect::<Vec<_>>().await,
                Err(e) => {
                    summary.errors.push(format!("{folder}: fetch failed: {e}"));
                    continue;
                }
            };
            for f in fetches.into_iter().flatten() {
                let Some(uid) = f.uid else { continue };
                let Some(header) = f.header() else { continue };
                let p = parse_headers(header);
                let thread_id = ops::upsert_email_thread(db, account.id, &p.thread_key, &p.subject, p.date)
                    .await
                    .map_err(|e| e.to_string())?;
                let new = ops::upsert_email_message(
                    db,
                    account.id,
                    thread_id,
                    folder,
                    uid as i64,
                    uid_validity,
                    &p.message_id,
                    &p.subject,
                    &p.from_addr,
                    p.date,
                )
                .await
                .map_err(|e| e.to_string())?;
                if new {
                    summary.new_messages += 1;
                    // A new message in an already-linked thread should have its
                    // body too (the thread is published — keep it complete).
                    let linked: Option<i64> =
                        sqlx::query_scalar("SELECT project_id FROM email_threads WHERE id = ?")
                            .bind(thread_id)
                            .fetch_one(db)
                            .await
                            .ok()
                            .flatten();
                    let _ = linked; // bodies for linked threads are fetched below
                }
            }
        }
    }

    // Backfill bodies for any linked thread with body-less messages (covers
    // both fresh links and new replies arriving on linked threads).
    if let Err(e) = fetch_missing_bodies(db, account, &mut session).await {
        summary.errors.push(e);
    }

    let _ = session.logout().await;
    let brief = format!(
        "{} new message{} across {} folder{}{}",
        summary.new_messages,
        if summary.new_messages == 1 { "" } else { "s" },
        summary.folders,
        if summary.folders == 1 { "" } else { "s" },
        if summary.errors.is_empty() { String::new() } else { format!(" — {} error(s)", summary.errors.len()) },
    );
    let _ = ops::set_email_account_result(db, account.id, &brief, drafts.as_deref()).await;
    Ok(summary)
}

/// Fetch and extract text bodies for linked-thread messages that lack one.
async fn fetch_missing_bodies(db: &Db, account: &EmailAccount, session: &mut Session) -> Result<(), String> {
    let pending: Vec<EmailMessage> = sqlx::query_as(
        "SELECT m.* FROM email_messages m JOIN email_threads th ON th.id = m.thread_id \
         WHERE m.account_id = ? AND th.project_id IS NOT NULL AND m.body_text IS NULL \
         ORDER BY m.folder LIMIT 200",
    )
    .bind(account.id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if pending.is_empty() {
        return Ok(());
    }
    // Group by folder to minimize SELECTs.
    let mut by_folder: std::collections::BTreeMap<String, Vec<&EmailMessage>> = Default::default();
    for m in &pending {
        by_folder.entry(m.folder.clone()).or_default().push(m);
    }
    for (folder, msgs) in by_folder {
        if session.select(&folder).await.is_err() {
            continue;
        }
        for m in msgs {
            let set = m.uid.to_string();
            let fetches: Vec<_> = match session.uid_fetch(&set, "(UID BODY.PEEK[])").await {
                Ok(stream) => stream.collect::<Vec<_>>().await,
                Err(_) => continue,
            };
            for f in fetches.into_iter().flatten() {
                if f.uid != Some(m.uid as u32) {
                    continue;
                }
                let Some(raw) = f.body() else { continue };
                let text = extract_text(raw);
                let _ = ops::set_email_message_body(db, m.id, &text).await;
            }
        }
    }
    Ok(())
}

/// Plain-text extraction (text parts preferred, HTML converted) with a cap —
/// downstream consumers (RAG, tools) treat this as untrusted and re-cap.
pub fn extract_text(raw: &[u8]) -> String {
    let text = mail_parser::MessageParser::default()
        .parse(raw)
        .map(|m| {
            let mut out = String::new();
            for i in 0..m.text_body_count() {
                if let Some(t) = m.body_text(i) {
                    out.push_str(&t);
                    out.push('\n');
                }
            }
            if out.trim().is_empty() {
                for i in 0..m.html_body_count() {
                    if let Some(t) = m.body_html(i) {
                        out.push_str(&html2text(&t));
                        out.push('\n');
                    }
                }
            }
            out
        })
        .unwrap_or_default();
    let mut text = text.trim().to_string();
    if text.chars().count() > BODY_CAP {
        text = text.chars().take(BODY_CAP).collect::<String>() + "…[truncated]";
    }
    text
}

/// Crude HTML → text (tags stripped, entities left alone): good enough for
/// grounding; we are not rendering email.
fn html2text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build the RFC 5322 draft reply for a thread: addressed to the last
/// message's sender, threading headers set so every mail client files it
/// correctly. Pure — no I/O — so the gate tests can assert on the bytes.
pub fn build_reply(
    from: &str,
    to: &str,
    subject: &str,
    in_reply_to: Option<&str>,
    references: &[String],
    body: &str,
) -> Result<Vec<u8>, String> {
    let subject = if subject.to_ascii_lowercase().starts_with("re:") {
        subject.to_string()
    } else {
        format!("Re: {subject}")
    };
    let mut builder = mail_builder::MessageBuilder::new()
        .from(from.to_string())
        .to(to.to_string())
        .subject(subject)
        .text_body(body.to_string());
    // mail-builder brackets ids itself — feed it BARE ids or they double-wrap.
    if let Some(irt) = in_reply_to.filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(irt.trim_matches(['<', '>']).to_string());
    }
    if !references.is_empty() {
        let refs: Vec<String> = references.iter().map(|r| r.trim_matches(['<', '>']).to_string()).collect();
        builder = builder.references(refs);
    }
    builder.write_to_vec().map_err(|e| e.to_string())
}

/// Apply an approved `draft_email_reply`: build the message and APPEND it to
/// the account's Drafts folder. The ONLY transport Ganban has — no SMTP exists.
pub async fn apply_draft(db: &Db, args: &Value) -> Result<Value, AppError> {
    let thread_id = args.get("threadId").and_then(Value::as_i64).ok_or_else(bad)?;
    let body = args.get("body").and_then(Value::as_str).ok_or_else(bad)?;
    let thread = ops::get_email_thread(db, thread_id)
        .await?
        .ok_or_else(|| AppError::NotFound("email thread".into()))?;
    let account = ops::get_email_account(db, thread.account_id)
        .await?
        .ok_or_else(|| AppError::NotFound("email account".into()))?;
    let messages = ops::list_email_thread_messages(db, thread_id).await?;
    let last = messages.last().ok_or_else(|| AppError::InvalidInput("thread has no messages".into()))?;
    let references: Vec<String> = messages.iter().map(|m| m.message_id.clone()).filter(|s| !s.is_empty()).collect();
    let to = extract_addr(&last.from_addr);
    let bytes = build_reply(
        &account.username,
        &to,
        &thread.subject,
        (!last.message_id.is_empty()).then_some(last.message_id.as_str()),
        &references,
        body,
    )
    .map_err(AppError::InvalidInput)?;

    let folder = if account.drafts_folder.is_empty() { "Drafts".to_string() } else { account.drafts_folder.clone() };
    let mut session = connect(&account, Reach::for_account(db, &account).await).await.map_err(AppError::InvalidInput)?;
    session
        .append(&folder, Some("(\\Draft)"), None, &bytes)
        .await
        .map_err(|e| AppError::InvalidInput(format!("could not save the draft to '{folder}': {e}")))?;
    let _ = session.logout().await;
    Ok(json!({ "drafts_folder": folder, "to": to, "subject": thread.subject, "bytes": bytes.len() }))
}

fn bad() -> AppError {
    AppError::InvalidInput("malformed draft args".into())
}

/// "Name <addr>" → "addr" (mail-builder wants clean addresses for To).
fn extract_addr(from: &str) -> String {
    match (from.find('<'), from.find('>')) {
        (Some(a), Some(b)) if b > a => from[a + 1..b].to_string(),
        _ => from.trim().to_string(),
    }
}

/// Background envelope sync for enabled accounts, tied to the daemon lifetime
/// like every other worker.
pub fn spawn_sync(db: Db, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
            _ = stop.changed() => return,
        }
        loop {
            let accounts = ops::list_email_accounts(&db).await.unwrap_or_default();
            for a in accounts.iter().filter(|a| a.enabled) {
                if let Err(e) = sync_account(&db, a).await {
                    tracing::warn!("sync '{}' failed: {e}", a.label);
                    let _ = ops::set_email_account_result(&db, a.id, &format!("sync failed: {e}"), None).await;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)) => {}
                _ = stop.changed() => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(user_id: Option<i64>, host: &str, port: i64) -> EmailAccount {
        EmailAccount {
            id: 0,
            user_id,
            auth_type: "password".into(),
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_refresh_token: None,
            label: String::new(),
            host: host.into(),
            port,
            username: "u".into(),
            password: "p".into(),
            folders: String::new(),
            drafts_folder: String::new(),
            horizon_days: 90,
            enabled: true,
            last_sync_at: None,
            last_result: None,
            created_at: Utc::now(),
        }
    }

    /// A member's mailbox can't make the host connect inside its network: the
    /// probe is refused before any socket opens, even with a listener there.
    #[tokio::test]
    async fn a_members_mailbox_cannot_reach_internal_addresses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port() as i64;
        for host in ["127.0.0.1", "localhost", "10.1.2.3", "100.64.0.7", "[::1]"] {
            let err = test_account(&probe(Some(2), host, port), Reach::PublicOnly).await.unwrap_err();
            assert!(err.contains("not allowed"), "{host}: {err}");
        }
        assert!(resolve_mail_host("1.1.1.1", 993, Reach::PublicOnly).await.is_ok());
        assert!(resolve_mail_host("127.0.0.1", 70000, Reach::Any).await.is_err(), "port out of range");
        // The owner may reach a mailbox on this machine (a local IMAP bridge).
        let addrs = resolve_mail_host("127.0.0.1", port, Reach::Any).await.unwrap();
        assert_eq!(addrs[0].port() as i64, port);
        assert!(resolve_mail_host("169.254.169.254", 993, Reach::Any).await.is_err(), "never a metadata endpoint");
    }

    #[tokio::test]
    async fn a_stored_mailbox_reaches_by_its_users_role() {
        let path = std::env::temp_dir().join(format!("ganban_email_reach_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        let owner = ganban_core::auth::ensure_owner(&db).await.unwrap();
        let member = ops::create_user(
            &db,
            ganban_core::models::CreateUserInput { username: "mia".into(), full_name: "Mia".into(), email: None },
        )
        .await
        .unwrap()
        .id;
        assert_eq!(Reach::for_account(&db, &probe(Some(owner), "h", 993)).await, Reach::Any);
        assert_eq!(Reach::for_account(&db, &probe(None, "h", 993)).await, Reach::Any, "legacy rows were the owner's");
        assert_eq!(Reach::for_account(&db, &probe(Some(member), "h", 993)).await, Reach::PublicOnly);
        assert_eq!(Reach::for_account(&db, &probe(Some(9999), "h", 993)).await, Reach::PublicOnly, "unknown user");
    }

    #[test]
    fn thread_keys_cluster_reply_chains_and_fall_back_to_subject() {
        let root = parse_headers(
            b"Message-ID: <root@x>\r\nSubject: Budget\r\nFrom: Ann <ann@x.com>\r\nDate: Tue, 9 Jun 2026 10:00:00 +0000\r\n\r\n",
        );
        assert_eq!(root.thread_key, "root@x", "a fresh message roots its own thread (mail-parser strips brackets)");
        assert_eq!(root.from_addr, "Ann <ann@x.com>");

        let reply = parse_headers(
            b"Message-ID: <r1@x>\r\nIn-Reply-To: <root@x>\r\nReferences: <root@x>\r\nSubject: Re: Budget\r\nFrom: bob@x.com\r\n\r\n",
        );
        assert_eq!(reply.thread_key, "root@x", "replies key on the conversation root");

        let deep = parse_headers(
            b"Message-ID: <r2@x>\r\nIn-Reply-To: <r1@x>\r\nReferences: <root@x> <r1@x>\r\nSubject: Re: Budget\r\n\r\n",
        );
        assert_eq!(deep.thread_key, "root@x", "deep replies still key on the FIRST reference");

        let bare = parse_headers(b"Subject: FW: Re:  Budget \r\n\r\n");
        assert_eq!(bare.thread_key, "subj:budget", "no ids at all -> normalized subject");
    }

    #[test]
    fn draft_bytes_carry_threading_headers_and_re_subject() {
        let bytes = build_reply(
            "me@gmail.com",
            "ann@x.com",
            "Budget",
            Some("<r1@x>"),
            &["<root@x>".into(), "<r1@x>".into()],
            "Sounds good — approved.",
        )
        .unwrap();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("Subject: Re: Budget"));
        assert!(s.contains("To: <ann@x.com>") || s.contains("To: ann@x.com"));
        assert!(s.contains("In-Reply-To: <r1@x>"));
        assert!(s.contains("<root@x>"), "references chain present");
        assert!(s.contains("Sounds good"));
        // The builder produces a complete RFC822 message — and nothing in this
        // crate can ever SEND it; APPEND-to-Drafts is the only transport.
    }

    #[test]
    fn drafts_folder_detection_and_address_extraction() {
        assert_eq!(
            detect_drafts_folder(&["INBOX".into(), "[Gmail]/Drafts".into(), "[Gmail]/Spam".into()]),
            Some("[Gmail]/Drafts".to_string())
        );
        assert_eq!(detect_drafts_folder(&["INBOX".into()]), None);
        assert_eq!(extract_addr("Ann Smith <ann@x.com>"), "ann@x.com");
        assert_eq!(extract_addr("ann@x.com"), "ann@x.com");
    }

    #[test]
    fn body_extraction_prefers_text_and_strips_html() {
        let raw = b"Message-ID: <m@x>\r\nSubject: t\r\nContent-Type: text/html\r\n\r\n<div>Hello <b>world</b></div>";
        let text = extract_text(raw);
        assert!(text.contains("Hello") && text.contains("world") && !text.contains('<'));
    }
}
