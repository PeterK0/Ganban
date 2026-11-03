//! The share door over HTTP, in-process (no socket): `oneshot` against its router.

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use ganban_core::Db;
use serde_json::json;
use tower::ServiceExt;

use super::{client_ip, parse_range, router, Limiter, Want};
use crate::commands::testkit::{owner, seed, test_db};
use crate::commands::{run, Ctx};

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("ganban_share_door_{}_{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// Deterministic bytes that aren't all alike.
fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| ((i * 31 + seed as usize * 7) % 251) as u8).collect()
}

/// A task with three host-stored files, two in folders. Returns (task, [(path, body)]).
async fn world(db: &Db, root: &Path) -> (i64, Vec<(String, Vec<u8>)>) {
    owner(db).await;
    let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
    let t = seed(db, "create_task", json!({ "input": { "project_id": a, "title": "Roof", "status": "To Do", "priority": "Low" } }))
        .await["id"]
        .as_i64()
        .unwrap();
    sqlx::query("UPDATE projects SET storage_quota_bytes = 100000000 WHERE id = ?").bind(a).execute(db).await.unwrap();
    let files = vec![
        ("Survey/plan.pdf".to_string(), bytes(1000, 1)),
        ("Survey/photos/roof é.jpg".to_string(), bytes(300_000, 2)),
        ("notes.txt".to_string(), b"hello".to_vec()),
    ];
    for (path, body) in &files {
        let name = path.rsplit('/').next().unwrap();
        let att = ganban_core::storage::store_shared_bytes(db, root, t, name, None, None, body).await.unwrap();
        if path.contains('/') {
            ganban_core::storage::set_rel_path(db, att.id, Some(path)).await.unwrap();
        }
    }
    (t, files)
}

/// Make a link and wait for its CRCs. Returns (id, token).
async fn link(db: &Db, root: &Path, t: i64, extra: serde_json::Value) -> (i64, String) {
    let mut args = json!({ "taskId": t });
    args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let l = run(&Ctx::in_process(db).with_storage_root(root), "create_share_link", args).await.unwrap();
    let id = l["id"].as_i64().unwrap();
    crate::share::prepare(db, root, id).await.unwrap();
    (id, l["path"].as_str().unwrap().trim_start_matches("/s/").to_string())
}

const CLIENT: [u8; 4] = [203, 0, 113, 9];

async fn send(app: &Router, method: &str, path: &str, from: [u8; 4], headers: &[(&str, &str)], body: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let mut req = req.body(Body::from(body.to_string())).unwrap();
    req.extensions_mut().insert(ConnectInfo(SocketAddr::from((from, 5555))));
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let body = axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec();
    (parts.status, parts.headers, body)
}

async fn get(app: &Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(app, "GET", path, CLIENT, headers, "").await
}

fn h<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers.get(name).map(|v| v.to_str().unwrap()).unwrap_or("")
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[tokio::test]
async fn the_page_lists_the_files_with_the_door_headers() {
    let db = test_db("door_page").await;
    let root = temp_root("page");
    let (t, _) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({ "label": "Roof <survey>" })).await;
    let app = router(db, root, Limiter::default());

    let (status, headers, body) = get(&app, &format!("/s/{token}"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let page = text(&body);
    assert!(page.contains("Roof &lt;survey&gt;"), "the label is escaped");
    assert!(page.contains("plan.pdf") && page.contains("roof é.jpg") && page.contains("Survey/photos/"));
    assert!(page.contains(&format!("/s/{token}/zip")) && page.contains("Download all"));
    assert!(page.contains("3 files"));
    assert_eq!(h(&headers, "referrer-policy"), "no-referrer");
    assert_eq!(h(&headers, "x-content-type-options"), "nosniff");
    assert_eq!(h(&headers, "cache-control"), "no-store");
    assert_eq!(h(&headers, "content-security-policy"), super::CSP);
    assert!(!page.contains("<script") && !page.contains("http://") && !page.contains("https://"), "no external assets");
}

#[tokio::test]
async fn the_door_answers_nothing_but_share_links() {
    let db = test_db("door_only").await;
    let root = temp_root("only");
    let (t, _) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({})).await;
    let app = router(db, root, Limiter::default());
    for (method, path) in [
        ("GET", "/".to_string()),
        ("GET", "/health".into()),
        ("POST", "/invoke".into()),
        ("GET", "/files/1".into()),
        ("GET", "/s/".into()),
        ("GET", "/s".into()),
        ("GET", format!("/s/{token}/")),
        ("GET", format!("/s/{token}/other")),
        ("GET", format!("/s/{token}/f/0/x")),
        ("PUT", format!("/s/{token}")),
        ("DELETE", format!("/s/{token}/zip")),
        ("GET", format!("/s/{token}/unlock")),
        ("POST", format!("/s/{token}/f/0")),
    ] {
        let (status, _, body) = send(&app, method, &path, CLIENT, &[], "").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        assert!(body.is_empty(), "{method} {path}: a bare 404");
    }
}

#[tokio::test]
async fn unknown_expired_and_revoked_links_look_the_same() {
    let db = test_db("door_gone").await;
    let root = temp_root("gone");
    let (t, _) = world(&db, &root).await;
    let (expired, expired_token) = link(&db, &root, t, json!({ "expiresInDays": 1 })).await;
    let (revoked, revoked_token) = link(&db, &root, t, json!({})).await;
    sqlx::query("UPDATE share_links SET expires_at = ? WHERE id = ?")
        .bind(chrono::Utc::now() - chrono::Duration::minutes(1))
        .bind(expired)
        .execute(&db)
        .await
        .unwrap();
    crate::share::revoke(&db, revoked).await.unwrap();
    let app = router(db, root, Limiter::default());
    let unknown = "A".repeat(43);
    let mut pages = Vec::new();
    for token in [unknown.as_str(), "short", &expired_token, &revoked_token] {
        for path in [format!("/s/{token}"), format!("/s/{token}/zip"), format!("/s/{token}/f/0")] {
            let (status, _, body) = get(&app, &path, &[]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
            pages.push(body);
        }
    }
    assert!(text(&pages[0]).contains("This link isn't available"));
    assert!(pages.iter().all(|p| *p == pages[0]), "one page for all of them");
}

#[tokio::test]
async fn a_password_guards_the_page_and_the_files() {
    let db = test_db("door_pw").await;
    let root = temp_root("pw");
    let (t, _) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({ "password": "open sesame" })).await;
    let app = router(db.clone(), root, Limiter::default());

    let (status, _, body) = get(&app, &format!("/s/{token}"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text(&body).contains("type=\"password\"") && !text(&body).contains("plan.pdf"));
    for path in [format!("/s/{token}/zip"), format!("/s/{token}/f/0")] {
        assert_eq!(get(&app, &path, &[]).await.0, StatusCode::UNAUTHORIZED, "{path}");
    }

    let form = [("content-type", "application/x-www-form-urlencoded")];
    let (status, headers, body) = send(&app, "POST", &format!("/s/{token}/unlock"), CLIENT, &form, "password=nope").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(text(&body).contains("isn't right") && headers.get(header::SET_COOKIE).is_none());

    let (status, headers, _) = send(&app, "POST", &format!("/s/{token}/unlock"), CLIENT, &form, "password=open+sesame").await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(h(&headers, "location"), format!("/s/{token}"));
    let cookie = h(&headers, "set-cookie").to_string();
    for part in [format!("Path=/s/{token};"), "HttpOnly".into(), "Secure".into(), "SameSite=Lax".into()] {
        assert!(cookie.contains(&part), "{cookie} lacks {part}");
    }
    let pair = cookie.split(';').next().unwrap().to_string();
    let with = [("cookie", pair.as_str())];
    let (status, _, body) = get(&app, &format!("/s/{token}"), &with).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text(&body).contains("plan.pdf"));
    assert_eq!(get(&app, &format!("/s/{token}/f/0"), &with).await.0, StatusCode::OK);
    // A forged cookie gets nowhere.
    let forged = [("cookie", "gs=0000")];
    assert_eq!(get(&app, &format!("/s/{token}/f/0"), &forged).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn files_serve_ranges() {
    let db = test_db("door_range").await;
    let root = temp_root("range");
    let (t, files) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({})).await;
    let app = router(db, root, Limiter::default());
    // Sorted by folder: notes.txt (top), Survey/plan.pdf, Survey/photos/roof é.jpg.
    let plan = &files[0].1;
    let url = format!("/s/{token}/f/1");

    let (status, headers, body) = get(&app, &url, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, *plan);
    assert_eq!(h(&headers, "content-length"), "1000");
    assert_eq!(h(&headers, "accept-ranges"), "bytes");
    assert!(h(&headers, "etag").starts_with("\"f-"));
    assert!(h(&headers, "last-modified").ends_with(" GMT"));
    assert_eq!(h(&headers, "content-disposition"), "attachment; filename=\"plan.pdf\"; filename*=UTF-8''plan.pdf");

    let (status, headers, body) = get(&app, &url, &[("range", "bytes=10-19")]).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, plan[10..20]);
    assert_eq!(h(&headers, "content-range"), "bytes 10-19/1000");
    assert_eq!(h(&headers, "content-length"), "10");

    let (status, headers, body) = get(&app, &url, &[("range", "bytes=-5")]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::PARTIAL_CONTENT, &plan[995..]));
    assert_eq!(h(&headers, "content-range"), "bytes 995-999/1000");

    let (status, headers, body) = get(&app, &url, &[("range", "bytes=900-")]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::PARTIAL_CONTENT, &plan[900..]));
    assert_eq!(h(&headers, "content-range"), "bytes 900-999/1000");

    let (status, headers, _) = get(&app, &url, &[("range", "bytes=1000-")]).await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(h(&headers, "content-range"), "bytes */1000");

    // A stale If-Range gets the whole file.
    let (status, _, body) = get(&app, &url, &[("range", "bytes=10-19"), ("if-range", "\"old\"")]).await;
    assert_eq!((status, body.len()), (StatusCode::OK, 1000));

    // The non-ASCII name goes in filename*.
    let (_, headers, _) = get(&app, &format!("/s/{token}/f/2"), &[("range", "bytes=0-0")]).await;
    assert_eq!(h(&headers, "content-disposition"), "attachment; filename=\"roof _.jpg\"; filename*=UTF-8''roof%20%C3%A9.jpg");
    assert_eq!(get(&app, &format!("/s/{token}/f/9"), &[]).await.0, StatusCode::NOT_FOUND);
    assert_eq!(get(&app, &format!("/s/{token}/f/x"), &[]).await.0, StatusCode::NOT_FOUND);
}

#[test]
fn range_headers_parse() {
    assert_eq!(parse_range(None, 100), Want::Full);
    assert_eq!(parse_range(Some("bytes=0-0"), 100), Want::Part(0, 0));
    assert_eq!(parse_range(Some("bytes=50-500"), 100), Want::Part(50, 99));
    assert_eq!(parse_range(Some("bytes=-500"), 100), Want::Part(0, 99));
    assert_eq!(parse_range(Some("bytes=-0"), 100), Want::Unsatisfiable);
    assert_eq!(parse_range(Some("bytes=100-"), 100), Want::Unsatisfiable);
    assert_eq!(parse_range(Some("bytes=0-"), 0), Want::Unsatisfiable);
    assert_eq!(parse_range(Some("bytes=5-1"), 100), Want::Full);
    assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Want::Full);
    assert_eq!(parse_range(Some("items=0-1"), 100), Want::Full);
    assert_eq!(parse_range(Some("bytes=+1-2"), 100), Want::Full);
}

fn read_zip(body: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(body.to_vec())).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            (f.name().to_string(), data)
        })
        .collect()
}

#[tokio::test]
async fn the_zip_reads_back_and_its_ranges_match() {
    let db = test_db("door_zip").await;
    let root = temp_root("zip");
    let (t, files) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({ "label": "Roof survey" })).await;
    let app = router(db, root, Limiter::default());
    let url = format!("/s/{token}/zip");

    let (status, headers, full) = get(&app, &url, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h(&headers, "content-type"), "application/zip");
    assert_eq!(h(&headers, "content-length"), full.len().to_string());
    assert!(h(&headers, "content-disposition").contains("filename=\"Roof survey.zip\""));
    let etag = h(&headers, "etag").to_string();
    let got = read_zip(&full);
    // Sorted by folder, then name.
    assert_eq!(got, vec![files[2].clone(), files[0].clone(), files[1].clone()]);

    // The same bytes again, and any range is the same slice of them.
    assert_eq!(get(&app, &url, &[]).await.2, full, "deterministic");
    let near_end = full.len() - 50;
    for (from, to) in [(100, 5000), (0, 0), (1100, near_end)] {
        let range = format!("bytes={from}-{to}");
        let (status, headers, part) = get(&app, &url, &[("range", &range), ("if-range", &etag)]).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(part, full[from..=to], "{range}");
        assert_eq!(h(&headers, "content-range"), format!("bytes {from}-{to}/{}", full.len()));
    }
    let (status, _, tail) = get(&app, &url, &[("range", "bytes=-30")]).await;
    assert_eq!((status, tail.as_slice()), (StatusCode::PARTIAL_CONTENT, &full[full.len() - 30..]));
    let (status, _, rest) = get(&app, &url, &[("range", &format!("bytes={}-", full.len() - 100))]).await;
    assert_eq!((status, rest.as_slice()), (StatusCode::PARTIAL_CONTENT, &full[full.len() - 100..]));
    assert_eq!(get(&app, &url, &[("range", &format!("bytes={}-", full.len()))]).await.0, StatusCode::RANGE_NOT_SATISFIABLE);
}

#[tokio::test]
async fn the_zip_waits_while_preparing_and_a_changed_file_is_read_again() {
    let db = test_db("door_prep").await;
    let root = temp_root("prep");
    let (t, _) = world(&db, &root).await;
    let (id, token) = link(&db, &root, t, json!({})).await;
    let app = router(db.clone(), root.clone(), Limiter::default());
    let url = format!("/s/{token}/zip");
    assert_eq!(get(&app, &url, &[]).await.0, StatusCode::OK);

    // A blob rewritten since the snapshot: its CRC is cleared and the zip waits for it.
    let att: i64 = sqlx::query_scalar("SELECT file_id FROM share_link_files WHERE link_id = ? AND n = 0")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    // Hold the preparer so the re-read can't finish before we look.
    let hold = crate::share::PREPARING.acquire().await.unwrap();
    std::fs::write(ganban_core::storage::blob_path(&root, att), b"hello, changed").unwrap();
    let (status, headers, _) = get(&app, &url, &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(h(&headers, "retry-after"), "5");
    let (_, _, page) = get(&app, &format!("/s/{token}"), &[]).await;
    assert!(text(&page).contains("Preparing the zip"));
    let listed = run(&Ctx::in_process(&db), "list_share_links", json!({ "taskId": t })).await.unwrap();
    assert_eq!(listed[0]["status"], "preparing");

    drop(hold);
    crate::share::prepare(&db, &root, id).await.unwrap();
    let (status, _, full) = get(&app, &url, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read_zip(&full)[0], ("notes.txt".to_string(), b"hello, changed".to_vec()));
    let listed = run(&Ctx::in_process(&db), "list_share_links", json!({ "taskId": t })).await.unwrap();
    assert_eq!(listed[0]["status"], "active");

    // A file whose host copy is gone drops out.
    std::fs::remove_file(ganban_core::storage::blob_path(&root, att)).unwrap();
    let (_, _, page) = get(&app, &format!("/s/{token}"), &[]).await;
    assert!(text(&page).contains("1 file is no longer available") && text(&page).contains("2 files"));
    let (status, _, full) = get(&app, &url, &[]).await;
    assert_eq!((status, read_zip(&full).len()), (StatusCode::OK, 2));
}

#[tokio::test]
async fn each_download_counts_once() {
    let db = test_db("door_count").await;
    let root = temp_root("count");
    let (t, _) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({})).await;
    let app = router(db.clone(), root, Limiter::default());
    let count = || async {
        let l = run(&Ctx::in_process(&db), "list_share_links", json!({ "taskId": t })).await.unwrap();
        (l[0]["downloadCount"].as_i64().unwrap(), l[0]["lastDownloadAt"].is_string())
    };
    assert_eq!(count().await, (0, false));
    get(&app, &format!("/s/{token}/f/1"), &[]).await;
    assert_eq!(count().await, (1, true));
    get(&app, &format!("/s/{token}/zip"), &[("range", "bytes=0-0")]).await;
    assert_eq!(count().await.0, 1, "a probe isn't a download");
    get(&app, &format!("/s/{token}/zip"), &[("range", "bytes=0-99999")]).await;
    assert_eq!(count().await.0, 2, "a range from the start is a new download");
    get(&app, &format!("/s/{token}/zip"), &[("range", "bytes=100-")]).await;
    assert_eq!(count().await.0, 2, "a range that continues one isn't");
    send(&app, "HEAD", &format!("/s/{token}/zip"), CLIENT, &[], "").await;
    get(&app, &format!("/s/{token}"), &[]).await;
    assert_eq!(count().await.0, 2, "HEAD and the page don't count");
}

#[tokio::test]
async fn bad_tokens_and_wrong_passwords_are_rate_limited() {
    let db = test_db("door_limit").await;
    let root = temp_root("limit");
    let (t, _) = world(&db, &root).await;
    let (_, token) = link(&db, &root, t, json!({})).await;
    let (_, locked) = link(&db, &root, t, json!({ "password": "pw" })).await;
    let (_, locked2) = link(&db, &root, t, json!({ "password": "pw" })).await;
    let unknown = format!("/s/{}", "B".repeat(43));
    let form = [("content-type", "application/x-www-form-urlencoded")];
    let min = Duration::from_secs(60);

    // Per address: 3 unknown tokens, then 429 for unknown tokens and passwords from it (and
    // its /64); live links still work, and other addresses are unaffected.
    let app = router(db.clone(), root.clone(), Limiter::new(3, 100, min, 1000, min));
    for _ in 0..3 {
        assert_eq!(get(&app, &unknown, &[]).await.0, StatusCode::NOT_FOUND);
    }
    let (status, headers, _) = get(&app, &unknown, &[]).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key("retry-after"));
    let (status, _, _) = send(&app, "POST", &format!("/s/{locked}/unlock"), CLIENT, &form, "password=pw").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "a blocked address can't try passwords");
    assert_eq!(get(&app, &format!("/s/{token}"), &[]).await.0, StatusCode::OK);
    assert_eq!(send(&app, "GET", &unknown, [198, 51, 100, 1], &[], "").await.0, StatusCode::NOT_FOUND);

    // Per link: 3 wrong passwords from 3 addresses lock the link's form, even for a 4th
    // address with the right password; another link's form still works.
    let app = router(db.clone(), root.clone(), Limiter::new(100, 3, min, 1000, min));
    for i in 1..=3 {
        let (status, _, _) = send(&app, "POST", &format!("/s/{locked}/unlock"), [198, 51, 100, i], &form, "password=x").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, headers, _) = send(&app, "POST", &format!("/s/{locked}/unlock"), [198, 51, 100, 9], &form, "password=pw").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the password isn't even checked");
    assert!(headers.get(header::SET_COOKIE).is_none());
    let (status, _, _) = send(&app, "POST", &format!("/s/{locked2}/unlock"), [198, 51, 100, 9], &form, "password=pw").await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    // A right password is refunded: it doesn't use up the address's tries.
    for _ in 0..5 {
        let (status, _, _) = send(&app, "POST", &format!("/s/{locked2}/unlock"), [198, 51, 100, 10], &form, "password=pw").await;
        assert_eq!(status, StatusCode::SEE_OTHER);
    }

    // Globally: past the limit, unknown tokens get 429; live links and passwords still work.
    let app = router(db, root, Limiter::new(100, 100, min, 2, min));
    assert_eq!(send(&app, "GET", &unknown, [192, 0, 2, 1], &[], "").await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, "GET", &unknown, [192, 0, 2, 2], &[], "").await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, "GET", &unknown, [192, 0, 2, 3], &[], "").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(send(&app, "GET", &format!("/s/{token}"), [192, 0, 2, 5], &[], "").await.0, StatusCode::OK);
    let (status, _, _) = send(&app, "POST", &format!("/s/{locked}/unlock"), [192, 0, 2, 4], &form, "password=pw").await;
    assert_eq!(status, StatusCode::SEE_OTHER);
}

#[test]
fn ipv6_addresses_count_by_their_64() {
    let l = Limiter::new(2, 100, Duration::from_secs(60), 1000, Duration::from_secs(60));
    let a: std::net::IpAddr = "2001:db8:1:2::1".parse().unwrap();
    let b: std::net::IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
    let c: std::net::IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert!(l.unknown_token(a) && l.unknown_token(b));
    assert!(!l.unknown_token(a), "same /64");
    assert!(l.unknown_token(c), "another /64");
}

#[test]
fn the_client_is_the_last_forwarded_hop_behind_loopback_only() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "10.0.0.1, 198.51.100.7".parse().unwrap());
    let loopback = SocketAddr::from(([127, 0, 0, 1], 1));
    let remote = SocketAddr::from(([192, 0, 2, 9], 1));
    assert_eq!(client_ip(loopback, &headers).to_string(), "198.51.100.7");
    assert_eq!(client_ip(remote, &headers).to_string(), "192.0.2.9", "a remote peer can't claim an address");
    assert_eq!(client_ip(loopback, &HeaderMap::new()).to_string(), "127.0.0.1");
}
