//! The share door: the only public surface (ADR 0006). It answers exactly four routes:
//!
//! - `GET /s/:token`: the page (or the password form);
//! - `POST /s/:token/unlock`: check the password, set a cookie scoped to `/s/<token>`;
//! - `GET /s/:token/f/:n`: file `n`, with Range;
//! - `GET /s/:token/zip`: every file as one deterministic zip, with Range.
//!
//! Everything else is a bare 404. The door shares the database and the storage root with
//! the main listener and nothing more: no auth layer, no device tokens, no API.
//!
//! **Rate limits.** Failures are counted per client address (the last `X-Forwarded-For` hop
//! when the peer is loopback, as it is behind `tailscale funnel`, else the peer; IPv6 by /64):
//!
//! - an unknown token counts against the address and a global budget; past either, unknown
//!   tokens get 429 (live links still work: a token carries 256 bits, so telling a live one
//!   from a dead one is no use to a guesser, and the limit only keeps the database quiet);
//! - a password try counts against the address and against the link, *before* it's checked
//!   (refunded when it's right), and at most a few are checked at once; past a limit, tries
//!   get 429 without being checked. The link's own limit caps guessing however many addresses
//!   an attacker has.
//!
//! Downloads run at most [`MAX_DOWNLOADS`] at a time (503 + `Retry-After` beyond).

use std::collections::{HashMap, VecDeque};
use std::io::SeekFrom;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Form, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{middleware, Router};
use chrono::Utc;
use futures_util::StreamExt;
use ganban_core::Db;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::zip::{Entry, Layout, Piece};
use super::{page, LinkRow, LiveFile};

const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'";
/// The unlock cookie's name (scoped to the link's path, so one per link).
const COOKIE: &str = "gs";

// ============== Rate limiting ==============

/// Downloads streaming at once; more get 503 + `Retry-After`.
pub(crate) const MAX_DOWNLOADS: usize = 32;
/// Password checks (argon2) running at once; more get 429.
const MAX_PASSWORD_CHECKS: usize = 4;

/// Failure counters over sliding windows: per client address, per link (passwords), and a
/// global one (unknown tokens).
pub struct Limiter {
    per_ip: usize,
    per_link: usize,
    window: Duration,
    global: usize,
    global_window: Duration,
    state: Mutex<Counts>,
}

#[derive(Default)]
struct Counts {
    ips: HashMap<IpAddr, VecDeque<Instant>>,
    links: HashMap<i64, VecDeque<Instant>>,
    global: VecDeque<Instant>,
}

impl Default for Limiter {
    /// 10 failures per address and 10 wrong passwords per link per 10 minutes; 100 unknown
    /// tokens a minute in all.
    fn default() -> Self {
        Limiter::new(10, 10, Duration::from_secs(600), 100, Duration::from_secs(60))
    }
}

fn prune(q: &mut VecDeque<Instant>, window: Duration, now: Instant) {
    while q.front().is_some_and(|t| now.duration_since(*t) >= window) {
        q.pop_front();
    }
}

/// The bucket an address counts in: itself, or its /64 for IPv6 (one host holds a /64).
fn bucket(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
        v4 => v4,
    }
}

/// Count `q`'s entries in the window, after pruning.
fn live<K: std::hash::Hash + Eq>(map: &mut HashMap<K, VecDeque<Instant>>, key: &K, window: Duration, now: Instant) -> usize {
    match map.get_mut(key) {
        Some(q) => {
            prune(q, window, now);
            q.len()
        }
        None => 0,
    }
}

/// Add a failure to `key`'s queue, keeping the map bounded.
fn push<K: std::hash::Hash + Eq>(map: &mut HashMap<K, VecDeque<Instant>>, key: K, window: Duration, cap: usize, now: Instant) {
    if map.len() > 10_000 {
        map.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < window));
    }
    let q = map.entry(key).or_default();
    q.push_back(now);
    while q.len() > cap.max(1) {
        q.pop_front();
    }
}

impl Limiter {
    pub fn new(per_ip: usize, per_link: usize, window: Duration, global: usize, global_window: Duration) -> Self {
        Limiter { per_ip, per_link, window, global, global_window, state: Mutex::new(Counts::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Counts> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether an unknown token from `ip` may be answered (else 429); if so, it's counted.
    fn unknown_token(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut s = self.lock();
        prune(&mut s.global, self.global_window, now);
        if live(&mut s.ips, &bucket(ip), self.window, now) >= self.per_ip || s.global.len() >= self.global {
            return false;
        }
        push(&mut s.ips, bucket(ip), self.window, self.per_ip, now);
        s.global.push_back(now);
        while s.global.len() > self.global.max(1) {
            s.global.pop_front();
        }
        true
    }

    /// Whether a password try from `ip` on `link` may be checked (else 429); if so, it's
    /// counted now, before the check: [`Limiter::refund`] takes it back when it's right.
    fn password_try(&self, ip: IpAddr, link: i64) -> bool {
        let now = Instant::now();
        let mut s = self.lock();
        if live(&mut s.ips, &bucket(ip), self.window, now) >= self.per_ip
            || live(&mut s.links, &link, self.window, now) >= self.per_link
        {
            return false;
        }
        push(&mut s.ips, bucket(ip), self.window, self.per_ip, now);
        push(&mut s.links, link, self.window, self.per_link, now);
        true
    }

    /// Take back a password try that turned out right.
    fn refund(&self, ip: IpAddr, link: i64) {
        let mut s = self.lock();
        if let Some(q) = s.ips.get_mut(&bucket(ip)) {
            q.pop_back();
        }
        if let Some(q) = s.links.get_mut(&link) {
            q.pop_back();
        }
    }
}

// ============== The router ==============

#[derive(Clone)]
struct Door {
    db: Db,
    root: Arc<PathBuf>,
    limiter: Arc<Limiter>,
    /// Downloads in flight (a permit lives as long as its response body).
    downloads: Arc<tokio::sync::Semaphore>,
    /// Password checks in flight.
    checks: Arc<tokio::sync::Semaphore>,
}

/// The door's router: the four routes and a bare 404 for everything else.
pub fn router(db: Db, root: PathBuf, limiter: Limiter) -> Router {
    Router::new()
        .route("/s/:token", get(page_handler).fallback(bare_404))
        .route("/s/:token/unlock", post(unlock_handler).fallback(bare_404))
        .route("/s/:token/f/:n", get(file_handler).fallback(bare_404))
        .route("/s/:token/zip", get(zip_handler).fallback(bare_404))
        .fallback(bare_404)
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::map_response(security_headers))
        .with_state(Door {
            db,
            root: Arc::new(root),
            limiter: Arc::new(limiter),
            downloads: Arc::new(tokio::sync::Semaphore::new(MAX_DOWNLOADS)),
            checks: Arc::new(tokio::sync::Semaphore::new(MAX_PASSWORD_CHECKS)),
        })
}

async fn bare_404() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

fn html(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn unavailable() -> Response {
    html(StatusCode::NOT_FOUND, page::unavailable())
}

fn too_many() -> Response {
    let mut r = html(StatusCode::TOO_MANY_REQUESTS, page::too_many());
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("300"));
    r
}

fn oops(e: impl std::fmt::Display) -> Response {
    tracing::error!("share door: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "Something went wrong.")
        .into_response()
}

/// The client's address: behind `tailscale funnel` the peer is loopback and the client is
/// the last `X-Forwarded-For` hop (the one tailscaled added).
fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if peer.ip().is_loopback() {
        let hop = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .last()
            .and_then(|h| h.trim().parse::<IpAddr>().ok());
        if let Some(ip) = hop {
            return ip;
        }
    }
    peer.ip()
}

/// The live link `token` names, or the response refusing it.
async fn open(d: &Door, token: &str, ip: IpAddr) -> Result<LinkRow, Response> {
    let row = if super::token_shaped(token) {
        super::link_by_token(&d.db, token).await.map_err(oops)?
    } else {
        None
    };
    match row {
        Some(link) if link.is_live(Utc::now()) => Ok(link),
        Some(_) => Err(unavailable()),
        None => {
            if !d.limiter.unknown_token(ip) {
                return Err(too_many());
            }
            tracing::info!("share door: unknown link from {ip}");
            Err(unavailable())
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The unlock cookie's value for a password-protected link: it can only be made by
/// someone who knows the stored hash, and it changes with it.
fn unlock_value(link: &LinkRow) -> Option<String> {
    let hash = link.password_hash.as_deref()?;
    let mut h = Sha256::new();
    h.update(b"ganban-share-unlock\0");
    h.update(link.token.as_bytes());
    h.update(b"\0");
    h.update(hash.as_bytes());
    Some(hex(&h.finalize()))
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether the request may see the link: no password, or the right cookie.
fn unlocked(link: &LinkRow, headers: &HeaderMap) -> bool {
    let Some(want) = unlock_value(link) else { return true };
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == COOKIE && ct_eq(v.as_bytes(), want.as_bytes()))
}

fn locked(link: &LinkRow) -> Response {
    html(StatusCode::UNAUTHORIZED, page::password_form(&link.token, &link.label, false))
}

// ============== The page and the password ==============

async fn page_handler(
    State(d): State<Door>,
    Path(token): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(peer, &headers);
    let link = match open(&d, &token, ip).await {
        Ok(l) => l,
        Err(r) => return r,
    };
    if !unlocked(&link, &headers) {
        return html(StatusCode::OK, page::password_form(&link.token, &link.label, false));
    }
    let live = match super::live_files(&d.db, &d.root, &link).await {
        Ok(l) => l,
        Err(e) => return oops(e),
    };
    html(StatusCode::OK, page::link_page(&link.token, &link, &live.files, live.gone, live.ready))
}

#[derive(Deserialize)]
struct UnlockForm {
    #[serde(default)]
    password: String,
}

async fn unlock_handler(
    State(d): State<Door>,
    Path(token): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    form: Result<Form<UnlockForm>, axum::extract::rejection::FormRejection>,
) -> Response {
    let ip = client_ip(peer, &headers);
    let link = match open(&d, &token, ip).await {
        Ok(l) => l,
        Err(r) => return r,
    };
    let page = format!("/s/{}", link.token);
    let Some(stored) = link.password_hash.clone() else {
        return (StatusCode::SEE_OTHER, [(header::LOCATION, page)]).into_response();
    };
    let password = form.map(|Form(f)| f.password).unwrap_or_default();
    if password.is_empty() || password.len() > 1024 {
        return html(StatusCode::UNAUTHORIZED, page::password_form(&link.token, &link.label, true));
    }
    // Counted before it's checked, so a burst of parallel tries can't outrun the limit.
    let Ok(_check) = d.checks.clone().try_acquire_owned() else { return too_many() };
    if !d.limiter.password_try(ip, link.id) {
        tracing::info!("share door: password tries for link {} from {ip} are over the limit", link.id);
        return too_many();
    }
    let ok = tokio::task::spawn_blocking(move || super::password_matches(&stored, &password)).await.unwrap_or(false);
    if !ok {
        tracing::info!("share door: wrong password for link {} from {ip}", link.id);
        return html(StatusCode::UNAUTHORIZED, page::password_form(&link.token, &link.label, true));
    }
    d.limiter.refund(ip, link.id);
    let max_age = match link.expires_at {
        Some(e) => (e - Utc::now()).num_seconds().clamp(1, 30 * 86_400),
        None => 30 * 86_400,
    };
    let cookie = format!(
        "{COOKIE}={}; Path={page}; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax",
        unlock_value(&link).unwrap_or_default()
    );
    (StatusCode::SEE_OTHER, [(header::LOCATION, page), (header::SET_COOKIE, cookie)]).into_response()
}

// ============== Downloads ==============

/// The part of a resource a request asks for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Want {
    Full,
    /// Bytes `start..=end`.
    Part(u64, u64),
    Unsatisfiable,
}

/// Parse a `Range` header against a resource of `len` bytes. One range only; anything
/// else (several ranges, another unit, bad syntax) is ignored, giving the whole resource.
pub(crate) fn parse_range(raw: Option<&str>, len: u64) -> Want {
    let Some(spec) = raw.and_then(|r| r.trim().strip_prefix("bytes=")) else { return Want::Full };
    if spec.contains(',') {
        return Want::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else { return Want::Full };
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| if s.bytes().all(|c| c.is_ascii_digit()) && !s.is_empty() { s.parse::<u64>().ok() } else { None };
    match (a.is_empty(), b.is_empty()) {
        // bytes=-n: the last n bytes.
        (true, false) => match num(b) {
            Some(0) => Want::Unsatisfiable,
            Some(_) if len == 0 => Want::Unsatisfiable,
            Some(n) => Want::Part(len.saturating_sub(n), len - 1),
            None => Want::Full,
        },
        // bytes=a-: from a to the end.
        (false, true) => match num(a) {
            Some(s) if s >= len => Want::Unsatisfiable,
            Some(s) => Want::Part(s, len - 1),
            None => Want::Full,
        },
        (false, false) => match (num(a), num(b)) {
            (Some(s), Some(e)) if s <= e => {
                if s >= len {
                    Want::Unsatisfiable
                } else {
                    Want::Part(s, e.min(len - 1))
                }
            }
            _ => Want::Full,
        },
        (true, true) => Want::Full,
    }
}

/// The range to send, honouring `If-Range`: a range is only served against the same
/// version (the ETag, or the Last-Modified date).
fn wanted(headers: &HeaderMap, len: u64, etag: &str, last_modified: &str) -> Want {
    if let Some(cond) = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()) {
        if cond.trim() != etag && cond.trim() != last_modified {
            return Want::Full;
        }
    }
    parse_range(headers.get(header::RANGE).and_then(|v| v.to_str().ok()), len)
}

fn http_date(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0).unwrap_or_default().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// `attachment; filename="…"; filename*=UTF-8''…` (RFC 6266 / 5987).
fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_graphic() && !"\"\\<>:|?*".contains(c) || c == ' ' { c } else { '_' })
        .collect();
    let mut enc = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            enc.push(b as char);
        } else {
            enc.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}")
}

/// A response for `want` of a `len`-byte resource, with `body(start, end)` making the bytes.
fn ranged(
    want: &Want,
    len: u64,
    etag: &str,
    last_modified: &str,
    content_type: &str,
    filename: &str,
    body: impl FnOnce(u64, u64) -> Body,
) -> Response {
    let (status, start, end) = match *want {
        Want::Unsatisfiable => {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{len}")), (header::ACCEPT_RANGES, "bytes".into())],
            )
                .into_response();
        }
        Want::Full => (StatusCode::OK, 0, len.saturating_sub(1)),
        Want::Part(s, e) => (StatusCode::PARTIAL_CONTENT, s, e),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let body = if count == 0 { Body::empty() } else { body(start, end) };
    let mut res = Response::new(body);
    *res.status_mut() = status;
    let h = res.headers_mut();
    let set = |h: &mut HeaderMap, k: header::HeaderName, v: String| {
        if let Ok(v) = HeaderValue::from_str(&v) {
            h.insert(k, v);
        }
    };
    set(h, header::CONTENT_TYPE, content_type.into());
    set(h, header::CONTENT_LENGTH, count.to_string());
    set(h, header::ACCEPT_RANGES, "bytes".into());
    set(h, header::ETAG, etag.into());
    set(h, header::LAST_MODIFIED, last_modified.into());
    set(h, header::CONTENT_DISPOSITION, disposition(filename));
    set(h, header::CACHE_CONTROL, "private, no-transform".into());
    if status == StatusCode::PARTIAL_CONTENT {
        set(h, header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    res
}

/// Bytes `offset..offset+len` of a file, streamed from disk. A file that's shorter than
/// expected ends the stream with an error (the client sees a broken download and resumes).
fn file_stream(
    path: PathBuf,
    offset: u64,
    len: u64,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> + Send + 'static {
    async_stream::stream! {
        let mut f = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => { yield Err(e); return; }
        };
        if let Err(e) = f.seek(SeekFrom::Start(offset)).await {
            yield Err(e);
            return;
        }
        let mut chunks = tokio_util::io::ReaderStream::with_capacity(f.take(len), 64 * 1024);
        let mut sent = 0u64;
        while let Some(chunk) = chunks.next().await {
            match chunk {
                Ok(b) => { sent += b.len() as u64; yield Ok(b); }
                Err(e) => { yield Err(e); return; }
            }
        }
        if sent < len {
            yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the file got shorter"));
        }
    }
}

/// A download starts at byte 0: a whole response, or a range from the start. A range that
/// continues one doesn't count again, nor does a HEAD.
/// A probe for the first few bytes (`bytes=0-0`) isn't one either.
fn counts(method: &Method, want: &Want, len: u64) -> bool {
    *method == Method::GET
        && match *want {
            Want::Full => true,
            Want::Part(0, end) => end + 1 >= len || end >= 65_535,
            _ => false,
        }
}

fn busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "30"), (header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Too many downloads right now. Try again in a minute.",
    )
        .into_response()
}

/// `s`, holding a download slot until it ends (or the client goes away).
fn holding<S>(permit: tokio::sync::OwnedSemaphorePermit, s: S) -> impl futures_util::Stream<Item = S::Item> + Send + 'static
where
    S: futures_util::Stream + Send + 'static,
    S::Item: Send,
{
    async_stream::stream! {
        let _slot = permit;
        let mut s = Box::pin(s);
        while let Some(item) = s.next().await {
            yield item;
        }
    }
}

fn describe(want: &Want) -> String {
    match want {
        Want::Full => "whole".into(),
        Want::Part(s, e) => format!("bytes {s}-{e}"),
        Want::Unsatisfiable => "unsatisfiable range".into(),
    }
}

/// The link's live files, or the refusal.
async fn files_for(d: &Door, link: &LinkRow) -> Result<super::Live, Response> {
    super::live_files(&d.db, &d.root, link).await.map_err(oops)
}

async fn file_handler(
    State(d): State<Door>,
    Path((token, n)): Path<(String, String)>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(peer, &headers);
    let link = match open(&d, &token, ip).await {
        Ok(l) => l,
        Err(r) => return r,
    };
    if !unlocked(&link, &headers) {
        return locked(&link);
    }
    let Ok(n) = n.parse::<i64>() else { return unavailable() };
    let files = match files_for(&d, &link).await {
        Ok(f) => f,
        Err(r) => return r,
    };
    let Some(f) = files.files.into_iter().find(|f| f.row.n == n) else { return unavailable() };
    let Ok(slot) = d.downloads.clone().try_acquire_owned() else { return busy() };
    let len = f.row.size.max(0) as u64;
    // A project file's id may equal an attachment's: its tag says which it is.
    let tag = if f.row.kind() == super::Kind::Project { "p" } else { "f" };
    let etag = format!("\"{tag}-{:x}-{:x}-{:x}\"", f.row.file_id, len, f.row.mtime);
    let last_modified = http_date(f.row.mtime);
    let want = wanted(&headers, len, &etag, &last_modified);
    if counts(&method, &want, len) {
        if let Err(e) = super::count_download(&d.db, link.id).await {
            tracing::warn!("share door: counting a download: {e}");
        }
    }
    if method == Method::GET {
        tracing::info!(
            "share door: link {} '{}': file {} '{}' ({}, {}) to {ip}",
            link.id, link.label, n, f.row.zip_name(), page::fmt_bytes(len), describe(&want)
        );
    }
    let path = f.path.clone();
    ranged(&want, len, &etag, &last_modified, "application/octet-stream", &f.row.name, |start, end| {
        Body::from_stream(holding(slot, file_stream(path, start, end - start + 1)))
    })
}

async fn zip_handler(
    State(d): State<Door>,
    Path(token): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(peer, &headers);
    let link = match open(&d, &token, ip).await {
        Ok(l) => l,
        Err(r) => return r,
    };
    if !unlocked(&link, &headers) {
        return locked(&link);
    }
    let files = match files_for(&d, &link).await {
        Ok(f) => f,
        Err(r) => return r,
    };
    if files.files.is_empty() {
        return unavailable();
    }
    if !files.ready {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "5"), (header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "The zip is being prepared. Try again in a few seconds.",
        )
            .into_response();
    }
    // A file whose CRC couldn't be computed (it kept changing) is left out of the zip.
    let files: Vec<LiveFile> = files.files.into_iter().filter(|f| f.row.crc32.is_some()).collect();
    if files.is_empty() {
        return unavailable();
    }
    let Ok(slot) = d.downloads.clone().try_acquire_owned() else { return busy() };
    let entries: Vec<Entry> = files
        .iter()
        .map(|f| Entry {
            name: f.row.zip_name(),
            size: f.row.size.max(0) as u64,
            crc: f.row.crc32.unwrap_or(0) as u32,
            mtime: f.row.mtime,
        })
        .collect();
    let layout = Arc::new(Layout::new(entries));
    let paths: Arc<Vec<PathBuf>> = Arc::new(files.iter().map(|f| f.path.clone()).collect());
    let len = layout.len();
    let etag = layout.etag().to_string();
    let last_modified = http_date(files.iter().map(|f| f.row.mtime).max().unwrap_or(0));
    let want = wanted(&headers, len, &etag, &last_modified);
    if counts(&method, &want, len) {
        if let Err(e) = super::count_download(&d.db, link.id).await {
            tracing::warn!("share door: counting a download: {e}");
        }
    }
    if method == Method::GET {
        tracing::info!(
            "share door: link {} '{}': zip of {} files ({}, {}) to {ip}",
            link.id, link.label, files.len(), page::fmt_bytes(len), describe(&want)
        );
    }
    let name = format!("{}.zip", super::clean_segment(&link.label));
    ranged(&want, len, &etag, &last_modified, "application/zip", &name, move |start, end| {
        Body::from_stream(holding(slot, zip_stream(layout, paths, start, end)))
    })
}

/// Bytes `start..=end` of the zip: header slices from memory, file slices from disk.
fn zip_stream(
    layout: Arc<Layout>,
    paths: Arc<Vec<PathBuf>>,
    start: u64,
    end: u64,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> + Send + 'static {
    async_stream::stream! {
        for piece in layout.pieces(start, end) {
            match piece {
                Piece::Bytes(b) => yield Ok(Bytes::from(b)),
                Piece::File { entry, offset, len } => {
                    let mut s = Box::pin(file_stream(paths[entry].clone(), offset, len));
                    while let Some(chunk) = s.next().await {
                        let failed = chunk.is_err();
                        yield chunk;
                        if failed {
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
