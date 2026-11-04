//! Optional RAG integration via a co-located **ragrat** sidecar.
//!
//! ragrat is a separate local-first RAG daemon (Python) that runs alongside the
//! Ganban host on the same machine/tailnet. Ganban is its *only* client: the
//! host materializes each project's text (tasks + comments + areas) into a folder
//! of Markdown, stages the project's shared file attachments next to them, and
//! drives ragrat's control-plane `POST /ingest`; search is proxied through the
//! Ganban daemon's `/search` route (which enforces project membership) to
//! ragrat's `POST /search`. Members never see the ragrat token — it stays
//! host-side, server-to-server over loopback.
//!
//! Entirely optional: if `GANBAN_RAGRAT_URL` is unset, `RagConfig::from_env`
//! returns `None` and the daemon runs exactly as before (no `/search`, no poller).

use std::path::{Path, PathBuf};
use std::time::Duration;

use ganban_core::Db;
use serde_json::{json, Value};

/// One ragrat collection per Ganban project: `ganban-<projectId>`.
pub fn collection_name(project_id: i64) -> String {
    format!("ganban-{project_id}")
}

/// Sidecar configuration, read from the host's environment. `None` disables RAG.
#[derive(Clone, Debug)]
pub struct RagConfig {
    /// ragrat base URL, e.g. `http://127.0.0.1:8780` (a *distinct* port from the
    /// Ganban daemon's 8765).
    pub base_url: String,
    /// ragrat service token (Bearer). RAG search/ingest fail if ragrat requires
    /// one and this is unset.
    pub token: Option<String>,
    /// Where per-project Markdown + staged blobs are written (the ingest source).
    pub staging: PathBuf,
    /// Where ragrat writes each collection's index/manifest (the ingest `out`).
    pub out_root: PathBuf,
    /// Poller interval (seconds) for re-indexing changed projects.
    pub poll_secs: u64,
}

impl RagConfig {
    /// Staging/out/poll are filesystem/operational defaults (env-overridable, not
    /// user-facing) — shared by both the env and DB connection sources.
    fn build(base_url: String, token: Option<String>) -> RagConfig {
        let home = dirs::data_dir().map(|d| d.join("com.scs.gansty").join("rag")).unwrap_or_else(|| PathBuf::from("ganban-rag"));
        RagConfig {
            base_url,
            token,
            staging: std::env::var("GANBAN_RAGRAT_STAGING").map(PathBuf::from).unwrap_or_else(|_| home.join("staging")),
            out_root: std::env::var("GANBAN_RAGRAT_OUT").map(PathBuf::from).unwrap_or_else(|_| home.join("collections")),
            poll_secs: std::env::var("GANBAN_RAGRAT_POLL_SECS").ok().and_then(|s| s.parse().ok()).filter(|n| *n >= 30).unwrap_or(900),
        }
    }

    pub fn from_env() -> Option<RagConfig> {
        let base_url = std::env::var("GANBAN_RAGRAT_URL").ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty())?;
        let token = std::env::var("GANBAN_RAGRAT_TOKEN").ok().filter(|s| !s.is_empty());
        Some(Self::build(base_url, token))
    }

    /// Read the ragrat connection from DB settings — `ragrat_connection` =
    /// `{"url":…,"token":…}` — written by the owner from Settings; falls back to
    /// env (one-time migration). `None` disables RAG. The headless host binary
    /// and the desktop UI share the same DB, so the host reads what the UI wrote.
    pub async fn from_db(db: &Db) -> Option<RagConfig> {
        let raw = ganban_core::ops::get_app_setting(db, "ragrat_connection").await.ok().flatten();
        if let Some(v) = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            let url = v
                .get("url")
                .and_then(|u| u.as_str())
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty());
            if let Some(url) = url {
                let token = v.get("token").and_then(|t| t.as_str()).filter(|s| !s.is_empty()).map(String::from);
                return Some(Self::build(url, token));
            }
        }
        Self::from_env()
    }
}

/// A live, swappable RAG client (None = RAG disabled). Held behind a RwLock so
/// Settings can reconfigure the connection without a daemon restart.
pub type SharedRag = std::sync::Arc<tokio::sync::RwLock<Option<RagClient>>>;

/// Parse a JSON-RPC reply out of an MCP Streamable-HTTP body. The transport
/// frames the reply as Server-Sent Events (`data: {json}` lines); concatenate
/// them. Falls back to plain-JSON for servers that answer `application/json`.
fn sse_json(body: &str) -> Option<Value> {
    let data: String = body.lines().filter_map(|l| l.strip_prefix("data:")).map(|s| s.trim_start()).collect();
    if data.is_empty() {
        serde_json::from_str(body).ok()
    } else {
        serde_json::from_str(&data).ok()
    }
}

/// How long a mount's MCP tool list is reused before asking ragrat again.
const MCP_TOOLS_TTL: Duration = Duration::from_secs(60);

/// MCP tool lists by mount URL, with when they were fetched.
type McpToolsCache = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<Value>)>>>;

/// HTTP client for the ragrat control plane (search + ingest).
#[derive(Clone)]
pub struct RagClient {
    http: reqwest::Client,
    cfg: RagConfig,
    /// Shared by clones, so every request sees the same cache; a new client
    /// (the engine reconfigured) starts empty.
    mcp_tools_cache: McpToolsCache,
}

impl RagClient {
    pub fn new(cfg: RagConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { http, cfg, mcp_tools_cache: Default::default() }
    }

    pub fn config(&self) -> &RagConfig {
        &self.cfg
    }

    /// Read one normalized corpus document from a collection's output dir
    /// (`<out_root>/<collection>/corpus/<source>`). `source` comes from search
    /// hits; canonicalization + a prefix check stop path traversal.
    pub fn corpus_document(&self, collection: &str, source: &str) -> Result<String, String> {
        let corpus_root = self.cfg.out_root.join(collection).join("corpus");
        let root = corpus_root.canonicalize().map_err(|_| "collection has no corpus yet".to_string())?;
        // Search hits cite the ORIGINAL file path ("deck.pdf"); the corpus file
        // is its normalized twin ("deck.pdf.md") — accept either spelling.
        let path = [source.to_string(), format!("{source}.md")]
            .iter()
            .map(|s| corpus_root.join(s))
            .find_map(|p| p.canonicalize().ok())
            .ok_or_else(|| "document not found".to_string())?;
        if !path.starts_with(&root) {
            return Err("document not found".into()); // traversal attempt — same answer as missing
        }
        std::fs::read_to_string(&path).map_err(|e| format!("could not read document: {e}"))
    }

    /// A collection's `manifest.json` (run metadata + per-document entries),
    /// read from the shared disk like facets. `{}` when never ingested.
    pub fn read_manifest(&self, collection: &str) -> Value {
        let path = self.cfg.out_root.join(collection).join("manifest.json");
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}))
    }

    /// The last run's human-readable audit report, if any.
    pub fn read_audit_report(&self, collection: &str) -> Option<String> {
        std::fs::read_to_string(self.cfg.out_root.join(collection).join("audit-report.md")).ok()
    }

    /// ragrat's self-reported status (GET /status): version, mounted
    /// collections, MCP mounts, embedder. For the Tools inspector's "knowledge
    /// engine" section — so the MCP surface ragrat creates is visible, not a
    /// black box. None when unreachable.
    pub async fn status(&self) -> Option<Value> {
        self.req(reqwest::Method::GET, "/status")
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()
    }

    /// The tools ragrat publishes on an MCP mount (e.g. "/mcp/"), via a minimal
    /// MCP/Streamable-HTTP handshake: initialize → initialized → tools/list.
    /// Best-effort (None if unreachable or not an MCP build). This is what makes
    /// ragrat a VISIBLE provider in the Tools inspector rather than a side door
    /// — Ganban brokers it; the tools still go through ragrat, not around it.
    ///
    /// A list is reused for [`MCP_TOOLS_TTL`]: the tool catalogue asks on every
    /// open, and a handshake per request is wasted work for a list that changes
    /// only when ragrat's mounts do. Failures aren't cached.
    pub async fn mcp_tools(&self, mount: &str) -> Option<Vec<Value>> {
        let url = format!("{}{}", self.cfg.base_url, mount);
        if let Some((at, tools)) = self.mcp_tools_cache.lock().unwrap().get(&url) {
            if at.elapsed() < MCP_TOOLS_TTL {
                return Some(tools.clone());
            }
        }
        let sid = self.mcp_session(&url).await?;
        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
        let body = self.mcp_post(&url, &list, Some(&sid)).await?.text().await.ok()?;
        let tools = sse_json(&body)?.get("result").and_then(|r| r.get("tools")).and_then(Value::as_array).cloned()?;
        self.mcp_tools_cache.lock().unwrap().insert(url, (std::time::Instant::now(), tools.clone()));
        Some(tools)
    }

    /// Call a tool on an MCP mount and return its text payload. Used by the
    /// registry's `mcp` binding (owner-gated upstream — the call still goes
    /// through ragrat, brokered, never around it). Errors are surfaced, not
    /// swallowed, so the model sees why a call failed.
    pub async fn mcp_call(&self, mount: &str, tool: &str, args: &Value) -> Result<String, String> {
        let url = format!("{}{}", self.cfg.base_url, mount);
        let sid = self.mcp_session(&url).await.ok_or("could not open an MCP session with the engine")?;
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        let body = self
            .mcp_post(&url, &call, Some(&sid))
            .await
            .ok_or("the MCP call did not reach the engine")?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let v = sse_json(&body).ok_or("unreadable MCP response")?;
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("MCP error");
            return Err(msg.to_string());
        }
        let result = v.get("result").ok_or("MCP response had no result")?;
        // Prefer the text content blocks; fall back to the structured result.
        let text: String = result
            .get("content")
            .and_then(Value::as_array)
            .map(|cs| cs.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        if !text.is_empty() {
            return Ok(text);
        }
        Ok(result.get("structuredContent").cloned().unwrap_or_else(|| result.clone()).to_string())
    }

    /// Open an MCP session on a mount: initialize → initialized → session id.
    /// Shared by mcp_tools / mcp_call.
    async fn mcp_session(&self, url: &str) -> Option<String> {
        let init = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": { "name": "ganban", "version": env!("CARGO_PKG_VERSION") } }
        });
        let resp = self.mcp_post(url, &init, None).await?;
        let sid = resp.headers().get("mcp-session-id")?.to_str().ok()?.to_string();
        let _ = resp.text().await; // drain the init result; we only need the session
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} });
        let _ = self.mcp_post(url, &note, Some(&sid)).await;
        Some(sid)
    }

    /// One MCP POST (JSON-RPC), carrying the bearer token and (optionally) the
    /// MCP session id. Short timeout — introspection must never stall the UI.
    async fn mcp_post(&self, url: &str, body: &Value, sid: Option<&str>) -> Option<reqwest::Response> {
        let mut rb = self
            .http
            .post(url)
            .header("Accept", "application/json, text/event-stream")
            .timeout(Duration::from_secs(4))
            .json(body);
        if let Some(tok) = &self.cfg.token {
            rb = rb.bearer_auth(tok);
        }
        if let Some(s) = sid {
            rb = rb.header("mcp-session-id", s);
        }
        rb.send().await.ok()
    }

    /// Cheap reachability probe (GET /health, 3s timeout) — gates the poller
    /// so a stopped engine doesn't generate an error per project per cycle.
    pub async fn healthy(&self) -> bool {
        self.req(reqwest::Method::GET, "/health")
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.http.request(method, format!("{}{}", self.cfg.base_url, path));
        if let Some(tok) = &self.cfg.token {
            rb = rb.bearer_auth(tok);
        }
        rb
    }

    /// Search one collection. Returns the hit dicts, or a human-readable error —
    /// including ragrat's *in-band* `[{"error": …}]` (unknown collection /
    /// embedder down), which arrives as HTTP 200.
    pub async fn search(
        &self,
        collection: &str,
        query: &str,
        limit: i64,
        filters: Option<Value>,
    ) -> Result<Vec<Value>, String> {
        let body = json!({ "query": query, "collection": collection, "limit": limit, "filters": filters });
        let resp = self.req(reqwest::Method::POST, "/search").json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail = val.get("detail").and_then(|d| d.as_str()).unwrap_or("ragrat search failed");
            return Err(format!("ragrat {status}: {detail}"));
        }
        let hits = val.as_array().cloned().unwrap_or_default();
        if let Some(err) = hits.first().and_then(|h| h.get("error")).and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        Ok(hits)
    }

    /// A collection's facets (role → value → count), read from the
    /// `facets.json` ragrat writes next to the index at ingest time. The file is
    /// host-local (the daemon and ragrat share a disk by design), so this is a
    /// read, not an HTTP call. Missing/unreadable (e.g. never ingested) = `{}`.
    pub fn read_facets(&self, collection: &str) -> Value {
        let path = self.cfg.out_root.join(collection).join("facets.json");
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}))
    }

    /// Enqueue an ingest of a staged folder into a collection (async on ragrat;
    /// returns the job id). Provenance `tags` are stamped on every doc.
    pub async fn ingest(&self, folder: &Path, out: &Path, collection: &str, tags: Value) -> Result<String, String> {
        let body = json!({
            "folder": folder.to_string_lossy(),
            "out": out.to_string_lossy(),
            "collection": collection,
            "tags": tags,
        });
        let resp = self.req(reqwest::Method::POST, "/ingest").json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail = val.get("detail").and_then(|d| d.as_str()).unwrap_or("ragrat ingest failed");
            return Err(format!("ragrat {status}: {detail}"));
        }
        Ok(val.get("job_id").and_then(|j| j.as_str()).unwrap_or_default().to_string())
    }

    /// Standalone OCR via ragrat's `POST /ocr` endpoint (reuses the same Docling
    /// + rapidocr pipeline as ingest, but skips embedding/chunking/indexing).
    /// Ganban uses this as the fallback when pdf.js `getTextContent` returns
    /// nothing (a scanned PDF with no text layer). The caller slices the pages
    /// it wants and sends those bytes — ragrat converts whatever it receives.
    /// Returns the extracted markdown text.
    pub async fn ocr(&self, file_name: &str, pdf_bytes: &[u8]) -> Result<String, String> {
        // Basic query-param encoding (file_name is a filename, not arbitrary URL).
        let encoded = file_name.replace(' ', "%20").replace('#', "%23").replace('&', "%26").replace('?', "%3F");
        let url = format!("{}/ocr?file_name={}", self.cfg.base_url, encoded);
        // Docling+rapidocr on CPU is slow (~5-30s/page) — override the client's
        // 30s default with a generous per-request timeout. The caller runs this
        // inside an async job (never holding a client-facing HTTP connection).
        let mut rb = self.http.post(&url).timeout(Duration::from_secs(600)).body(pdf_bytes.to_vec());
        if let Some(tok) = &self.cfg.token {
            rb = rb.bearer_auth(tok);
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail = val.get("detail").and_then(|d| d.as_str()).unwrap_or("ragrat OCR failed");
            return Err(format!("ragrat {status}: {detail}"));
        }
        Ok(val.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string())
    }

    /// The ragrat ingest queue + history. The daemon runs a worker pool that
    /// parallelizes across collections (= projects) while serializing jobs for
    /// the same collection (one LanceDB writer per directory). Each job
    /// carries its params/tags, which is how the caller maps a job back to a
    /// Ganban project.
    pub async fn list_jobs(&self) -> Result<Vec<Value>, String> {
        let resp = self.req(reqwest::Method::GET, "/jobs").send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("ragrat {status}"));
        }
        Ok(val.as_array().cloned().unwrap_or_default())
    }

    /// One job WITH its live log trail (`GET /jobs/:id`; the list stays light).
    pub async fn get_job(&self, job_id: &str) -> Result<Value, String> {
        let resp = self
            .req(reqwest::Method::GET, &format!("/jobs/{job_id}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("ragrat {}: job not found", resp.status()));
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    /// Delete a collection outright (unmount + directory + registry). Returns
    /// ragrat's accounting: freed bytes with corpus/index breakdown.
    pub async fn delete_collection(&self, collection: &str) -> Result<Value, String> {
        let resp = self
            .req(reqwest::Method::DELETE, &format!("/collections/{collection}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let detail = val.get("detail").and_then(|d| d.as_str()).unwrap_or("delete failed");
            return Err(format!("ragrat {status}: {detail}"));
        }
        Ok(val)
    }

    /// A collection's live stats incl. disk accounting (total/corpus/index bytes).
    pub async fn collection_stats(&self, collection: &str) -> Result<Value, String> {
        let resp = self
            .req(reqwest::Method::GET, &format!("/collections/{collection}/stats"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("ragrat {}: no stats", resp.status()));
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    /// Cancel a still-queued ingest job.
    pub async fn cancel_job(&self, job_id: &str) -> Result<Value, String> {
        let resp = self
            .req(reqwest::Method::POST, &format!("/jobs/{job_id}/cancel"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail = val.get("detail").and_then(|d| d.as_str()).unwrap_or("cancel failed");
            return Err(format!("ragrat {status}: {detail}"));
        }
        Ok(val)
    }
}

/// The Ganban project a ragrat job belongs to — read from its `tags.project`
/// (stamped by reindex_project) or the `ganban-<id>` collection name.
pub fn job_project_id(job: &Value) -> Option<i64> {
    let params = job.get("params")?;
    if let Some(p) = params
        .get("tags")
        .and_then(|t| t.get("project"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
    {
        return Some(p);
    }
    params
        .get("collection")
        .and_then(|c| c.as_str())
        .and_then(|c| c.strip_prefix("ganban-"))
        .and_then(|s| s.parse::<i64>().ok())
}

// --------------------------------------------------------------------------- //
// Materialization (DB rows -> Markdown). Pure rendering is unit-tested; the IO
// wrapper writes the per-project staging folder.
// --------------------------------------------------------------------------- //

/// Render a single task (with its comments) to a self-contained Markdown doc.
pub fn task_markdown(
    title: &str,
    description: Option<&str>,
    status: &str,
    priority: &str,
    area: Option<&str>,
    comments: &[(String, String)], // (author, content)
) -> String {
    let mut md = format!("# {title}\n\n");
    md.push_str(&format!("- Status: {status}\n- Priority: {priority}\n"));
    if let Some(a) = area {
        md.push_str(&format!("- Area: {a}\n"));
    }
    md.push('\n');
    if let Some(d) = description.filter(|s| !s.trim().is_empty()) {
        md.push_str("## Description\n\n");
        md.push_str(d.trim());
        md.push_str("\n\n");
    }
    if !comments.is_empty() {
        md.push_str("## Comments\n\n");
        for (author, content) in comments {
            md.push_str(&format!("**{author}:** {}\n\n", content.trim()));
        }
    }
    md
}

/// A staged blob filename that Docling can format-detect: `<id>__<sanitized name>`.
/// The id prefix avoids collisions; the original extension drives format sniffing.
fn staged_blob_name(id: i64, file_name: &str) -> String {
    let safe: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let safe = safe.trim_matches('_');
    format!("{id}__{}", if safe.is_empty() { "file" } else { safe })
}

/// Task visibility for search (ADR 0002): drop the hits a viewer may not see. The
/// project corpus is staged by [`materialize_project`], so a hit's `source` says what
/// it's about: `task-<sync_uuid>.md` (a task with its comments), `<id>__<name>` (a task's
/// attachment), `area-0__<name>.md` (an area), `event-<id>.md`. A task's documents go with
/// the task, a restricted area's with the area, and an event stays if it's linked to the
/// viewer's projects or to a task they can see. The project overview, email threads and
/// project files (`pf-…`) stay. The owner keeps everything.
pub async fn retain_visible_hits(
    db: &Db,
    viewer: ganban_core::visibility::Viewer,
    project_id: i64,
    hits: &mut Vec<Value>,
) -> Result<(), String> {
    use ganban_core::visibility;
    use std::collections::HashSet;
    let err = |e: ganban_core::error::AppError| e.to_string();
    let Some(seen) = visibility::visible_tasks(db, viewer, Some(project_id)).await.map_err(err)? else { return Ok(()) };
    let tasks: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT id, sync_uuid FROM tasks WHERE project_id = ?")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let seen_uuids: HashSet<String> = tasks.into_iter().filter(|(id, _)| seen.contains(id)).filter_map(|(_, u)| u).collect();
    let attachments: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT fa.id, fa.task_id FROM file_attachments fa JOIN tasks t ON t.id = fa.task_id WHERE t.project_id = ?",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let seen_attachments: HashSet<i64> = attachments.into_iter().filter(|(_, t)| seen.contains(t)).map(|(a, _)| a).collect();
    let areas: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM areas WHERE project_id = ?")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let shown_areas = visibility::visible_areas(db, viewer, Some(project_id)).await.map_err(err)?.unwrap_or_default();
    let hidden_area_docs: HashSet<String> = areas
        .into_iter()
        .filter(|(id, _)| !shown_areas.contains(id))
        .map(|(_, name)| format!("area-{}.md", staged_blob_name(0, &name)))
        .collect();
    let mut seen_events: HashSet<i64> = ganban_core::auth::accessible_event_ids(db, viewer.user_id).await.map_err(err)?.into_iter().collect();
    let task_events: Vec<(i64, i64)> = sqlx::query_as("SELECT event_id, task_id FROM event_tasks").fetch_all(db).await.map_err(|e| e.to_string())?;
    seen_events.extend(task_events.into_iter().filter(|(_, t)| seen.contains(t)).map(|(e, _)| e));

    hits.retain(|h| {
        let source = h.get("source").and_then(Value::as_str).unwrap_or("");
        let name = source.rsplit('/').next().unwrap_or(source);
        if let Some(uuid) = name.strip_prefix("task-").and_then(|r| r.strip_suffix(".md")) {
            return seen_uuids.contains(uuid);
        }
        if let Some(id) = name.strip_prefix("event-").and_then(|r| r.strip_suffix(".md")).and_then(|r| r.parse().ok()) {
            return seen_events.contains(&id);
        }
        if name.starts_with("area-") {
            return !hidden_area_docs.contains(name);
        }
        if let Some((id, _)) = name.split_once("__").filter(|_| !name.starts_with("pf-")) {
            if let Ok(id) = id.parse::<i64>() {
                return seen_attachments.contains(&id);
            }
        }
        true
    });
    Ok(())
}

/// Rebuild a project's staging folder from current rows + shared blobs. The
/// folder is recreated from scratch, so deleted entities drop out of the corpus
/// on the next ingest.
pub async fn materialize_project(db: &Db, cfg: &RagConfig, storage_root: &Path, project_id: i64) -> Result<PathBuf, String> {
    materialize_with_guard(db, cfg, storage_root, project_id, ganban_core::storage::ai_max_file_bytes()).await
}

/// Whether an included file goes into the corpus: a file over the size guard goes in only
/// if someone forced it, else it's skipped with a warning in the host log. The flag can be
/// 1 for a big file when its bytes were replaced after it was included, or the guard was
/// lowered since.
fn within_ai_guard(flag: i64, size: i64, max: i64, what: &str) -> bool {
    if flag == ganban_core::storage::AI_FORCED || size <= max {
        return true;
    }
    tracing::warn!(
        "AI overview: skipping {what} ({}), over the {} size guard (GANBAN_AI_MAX_FILE_MB); include it again with force to index it",
        ganban_core::storage::mb_label(size),
        ganban_core::storage::mb_label(max)
    );
    false
}

/// Put a file's bytes into the staging folder: a hard link (instant, no second copy of a
/// big file), or a copy where the staging folder is on another disk. A file that fails is
/// logged and left out; the rest of the project still stages.
fn stage_blob(blob: &Path, dest: &Path, what: &str) {
    if !blob.exists() {
        return;
    }
    if std::fs::hard_link(blob, dest).is_ok() {
        return;
    }
    if let Err(e) = std::fs::copy(blob, dest) {
        tracing::warn!("AI overview: could not stage {what}: {e}");
    }
}

/// [`materialize_project`] with the size guard given, so tests needn't set the env.
async fn materialize_with_guard(
    db: &Db,
    cfg: &RagConfig,
    storage_root: &Path,
    project_id: i64,
    max_bytes: i64,
) -> Result<PathBuf, String> {
    let dir = cfg.staging.join(collection_name(project_id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Project overview.
    if let Ok(Some((name, desc))) = sqlx::query_as::<_, (String, Option<String>)>("SELECT name, description FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await
    {
        let mut md = format!("# Project: {name}\n\n");
        if let Some(d) = desc.filter(|s| !s.trim().is_empty()) {
            md.push_str(d.trim());
            md.push('\n');
        }
        let _ = std::fs::write(dir.join("project.md"), md);
    }

    // Areas of this project, keyed for task lookup.
    let areas: Vec<(i64, String, Option<String>)> =
        sqlx::query_as("SELECT id, name, description FROM areas WHERE project_id = ?")
            .bind(project_id)
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
    for (_, name, desc) in &areas {
        let mut md = format!("# Area: {name}\n\n");
        if let Some(d) = desc.clone().filter(|s| !s.trim().is_empty()) {
            md.push_str(d.trim());
            md.push('\n');
        }
        let _ = std::fs::write(dir.join(format!("area-{}.md", staged_blob_name(0, name))), md);
    }
    let area_name = |id: Option<i64>| -> Option<String> { id.and_then(|i| areas.iter().find(|(aid, _, _)| *aid == i).map(|(_, n, _)| n.clone())) };

    // Tasks (skip binned: tasks soft-delete via `archived`, not deleted_at) + comments.
    let tasks: Vec<(i64, String, String, Option<String>, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, sync_uuid, title, description, status, priority, area_id FROM tasks \
         WHERE project_id = ? AND archived = 0",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    for (tid, sync_uuid, title, desc, status, priority, area_id) in &tasks {
        let comments: Vec<(Option<String>, String)> = sqlx::query_as(
            "SELECT u.full_name, c.content FROM comments c \
             LEFT JOIN users u ON u.id = c.user_id \
             WHERE c.task_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at",
        )
        .bind(tid)
        .fetch_all(db)
        .await
        .unwrap_or_default();
        let comments: Vec<(String, String)> =
            comments.into_iter().map(|(a, c)| (a.unwrap_or_else(|| "Someone".into()), c)).collect();
        let md = task_markdown(title, desc.as_deref(), status, priority, area_name(*area_id).as_deref(), &comments);
        let _ = std::fs::write(dir.join(format!("task-{sync_uuid}.md")), md);
    }

    // Events linked to this project — directly (event_projects) or via its tasks
    // (event_tasks) — so the assistant can reference them too.
    let events: Vec<(i64, String, Option<String>, Option<String>, String, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT DISTINCT e.id, e.title, e.description, e.location, e.event_date, e.start_time, e.end_time \
             FROM events e \
             LEFT JOIN event_projects ep ON ep.event_id = e.id \
             LEFT JOIN event_tasks et ON et.event_id = e.id \
             LEFT JOIN tasks t ON t.id = et.task_id \
             WHERE e.archived = 0 AND (ep.project_id = ?1 OR t.project_id = ?1)",
        )
        .bind(project_id)
        .fetch_all(db)
        .await
        .unwrap_or_default();
    for (id, title, desc, location, date, start, end) in &events {
        let mut md = format!("# Event: {title}\n\n- Date: {date}\n");
        if let Some(s) = start.clone().filter(|s| !s.trim().is_empty()) {
            let span = end.clone().filter(|e| !e.trim().is_empty()).map(|e| format!("–{e}")).unwrap_or_default();
            md.push_str(&format!("- Time: {s}{span}\n"));
        }
        if let Some(l) = location.clone().filter(|s| !s.trim().is_empty()) {
            md.push_str(&format!("- Location: {l}\n"));
        }
        md.push('\n');
        if let Some(d) = desc.clone().filter(|s| !s.trim().is_empty()) {
            md.push_str(d.trim());
            md.push('\n');
        }
        let _ = std::fs::write(dir.join(format!("event-{id}.md")), md);
    }

    // Linked email threads: the owner published these into the project, so the
    // assistant may ground on them. One markdown file per thread, bodies only
    // (envelope-only threads contribute nothing yet).
    let mails: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT th.id, th.subject, m.from_addr || ' on ' || COALESCE(m.date, '?'), COALESCE(m.body_text, '') \
         FROM email_threads th JOIN email_messages m ON m.thread_id = th.id \
         WHERE th.project_id = ?1 AND m.body_text IS NOT NULL ORDER BY th.id, m.date",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    {
        use std::collections::BTreeMap;
        let mut by_thread: BTreeMap<i64, (String, String)> = BTreeMap::new();
        for (tid, subject, who, body) in mails {
            let entry = by_thread.entry(tid).or_insert_with(|| (subject.clone(), String::new()));
            entry.1.push_str(&format!("\n## {who}\n\n{}\n", body.trim()));
        }
        for (tid, (subject, bodies)) in by_thread {
            let md = format!("# Email thread: {subject}\n{bodies}");
            let _ = std::fs::write(dir.join(format!("email-{tid}.md")), md);
        }
    }

    // Files go in only when someone included them (`ai_included`), and a file over the
    // size guard only when it was forced: a 1000-page textbook can tie the indexer up for
    // hours. Shared task attachments first (Docling-friendly names).
    let atts: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT fa.id, fa.file_name, fa.storage_size, fa.ai_included FROM file_attachments fa \
         JOIN tasks t ON t.id = fa.task_id \
         WHERE t.project_id = ? AND fa.is_shared = 1 AND fa.ai_included > 0",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for (id, file_name, size, flag) in &atts {
        let what = format!("'{file_name}' (attachment {id})");
        if within_ai_guard(*flag, *size, max_bytes, &what) {
            let blob = ganban_core::storage::blob_path(storage_root, *id);
            stage_blob(&blob, &dir.join(staged_blob_name(*id, file_name)), &what);
        }
    }

    // Project-level files (the drop zone). Staged under a "pf-" prefix so their
    // ids never collide with task-attachment staged names.
    let pfiles: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT id, file_name, size_bytes, ai_included FROM project_files WHERE project_id = ? AND ai_included > 0",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for (id, file_name, size, flag) in &pfiles {
        let what = format!("'{file_name}' (project file {id})");
        if within_ai_guard(*flag, *size, max_bytes, &what) {
            let blob = ganban_core::storage::project_blob_path(storage_root, *id);
            stage_blob(&blob, &dir.join(format!("pf-{}", staged_blob_name(*id, file_name))), &what);
        }
    }

    // Point ragrat's embedder at our managed Ollama (see write_embedding_toml).
    let _ = write_embedding_toml(db, &dir).await;

    Ok(dir)
}

/// Write the `ragrat.toml` that pins the embedder into a staging dir. Without
/// it ragrat's defaults leave embedding OFF — the ingest then produces chunks
/// + facets but NO vector index, i.e. an unsearchable collection. Returns
/// whether an embedder was configured at all.
pub async fn write_embedding_toml(db: &Db, dir: &Path) -> Result<bool, String> {
    let Some(emb) = ganban_core::ops::get_app_setting(db, "rag_embedding").await.ok().flatten() else {
        return Ok(false);
    };
    let Ok(v) = serde_json::from_str::<Value>(&emb) else { return Ok(false) };
    let (Some(endpoint), Some(model), Some(dims)) = (
        v.get("endpoint").and_then(|e| e.as_str()),
        v.get("model").and_then(|m| m.as_str()),
        v.get("dimensions").and_then(|d| d.as_i64()),
    ) else {
        return Ok(false);
    };
    let mut toml = format!(
        "[embedding]\nenabled = true\nendpoint = \"{endpoint}\"\nmodel = \"{model}\"\ndimensions = {dims}\n"
    );
    // Figure description ([enrichment]): when the owner configured a vision
    // model, every ingest describes in-document charts/maps/diagrams so they
    // index as text instead of `<!-- image -->` dead zones. The endpoint is an
    // Ollama base URL (possibly the remote box); ragrat needs the OpenAI-style
    // chat completions path.
    if let Some(vision) = ganban_core::ops::get_app_setting(db, "rag_vision").await.ok().flatten() {
        if let Ok(v) = serde_json::from_str::<Value>(&vision) {
            if let (Some(base), Some(vmodel)) = (
                v.get("endpoint").and_then(|e| e.as_str()).map(|s| s.trim_end_matches('/')),
                v.get("model").and_then(|m| m.as_str()).filter(|m| !m.trim().is_empty()),
            ) {
                toml.push_str(&format!(
                    "\n[enrichment]\nenabled = true\nendpoint = \"{base}/v1/chat/completions\"\nmodel = \"{vmodel}\"\n"
                ));
            }
        }
    }
    std::fs::write(dir.join("ragrat.toml"), toml).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Stage an Atlas source folder for ingest: copy it into the staging tree and
/// pin the embedder — the user's raw folder can't carry our ragrat.toml (we
/// never write into source folders), and ingesting without one produced
/// exactly the "no usable collection" search 404. Wiped and rebuilt each run,
/// like project staging.
pub async fn stage_atlas(db: &Db, cfg: &RagConfig, slug: &str, source: &Path) -> Result<PathBuf, String> {
    let dir = cfg.staging.join(format!("atlas-{slug}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    copy_tree(source, &dir, 0)?;
    if !write_embedding_toml(db, &dir).await? {
        return Err("no embedding model is configured — set one up under Settings → Models → Embedding model first, then re-ingest".into());
    }
    Ok(dir)
}

/// Recursive copy with sane guards (skip hidden entries, bounded depth).
fn copy_tree(from: &Path, to: &Path, depth: u32) -> Result<(), String> {
    if depth > 8 {
        return Ok(()); // deeper than any sane corpus — silently stop
    }
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
            copy_tree(&src, &dst, depth + 1)?;
        } else if ty.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Re-ingest every non-archived project (e.g. after the embedding model changed,
/// which pins each collection's LanceDB schema and so requires a rebuild). Each
/// rebuild writes the new ragrat.toml, so the new embedder wins; the per-project
/// stamp is advanced so the poller doesn't redo the work.
pub async fn reembed_all(db: &Db, client: &RagClient, storage_root: &Path) -> Result<usize, String> {
    if !embedding_configured(db).await {
        return Err("no embedding model is configured — set one up under Settings → Models (embedding) first, then Save & re-index".into());
    }
    let projects: Vec<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE archived = 0")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let mut n = 0;
    for pid in projects {
        if reindex_project(db, client, storage_root, pid).await.is_ok() {
            if let Ok(stamp) = project_stamp(db, pid).await {
                let _ = ganban_core::ops::set_app_setting(db, &format!("rag_stamp_{pid}"), &stamp).await;
            }
            n += 1;
        }
    }
    Ok(n)
}

/// Materialize a project and enqueue a ragrat ingest. Best-effort: a failure is
/// logged and surfaced as Err, never panics the caller.
/// Per-project "allow AI to read project files" switch (Project Settings).
/// Default OFF (privacy-first): a project's files are only ever indexed/searched
/// once the owner explicitly opts in via Project Settings — the app_setting only
/// exists after someone flips it ("1" on, "0" off). When OFF, nothing in Ganban
/// reads or refreshes this project's corpus — poller, manual reindex, chat
/// grounding, the agent's search tool, the secretary. Disabling also DELETES the
/// project's collection from ragrat (quantified — the route reports freed bytes),
/// so "off" means off on disk too.
pub async fn ai_files_enabled(db: &Db, project_id: i64) -> bool {
    ganban_core::ops::get_app_setting(db, &format!("rag_files_enabled_{project_id}"))
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

/// Whether a usable embedding model is configured in app_settings
/// (`rag_embedding = {endpoint, model, dimensions}`). Without one, `write_embedding_toml`
/// writes no `[embedding]` block, ragrat's defaults leave embedding OFF, and an
/// ingest produces chunks + facets but NO vector index — an unsearchable
/// collection that still reports "succeeded". Mirrors the guard `stage_atlas`
/// already has; `reindex_project` / `reembed_all` / the poller refuse to ingest
/// in that case so the foundation never fills with vectorless collections.
pub async fn embedding_configured(db: &Db) -> bool {
    let Some(raw) = ganban_core::ops::get_app_setting(db, "rag_embedding").await.ok().flatten() else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return false };
    let endpoint = v.get("endpoint").and_then(|e| e.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let model = v.get("model").and_then(|m| m.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let dims = v.get("dimensions").and_then(|d| d.as_i64()).filter(|n| *n > 0);
    endpoint.is_some() && model.is_some() && dims.is_some()
}

pub async fn reindex_project(db: &Db, client: &RagClient, storage_root: &Path, project_id: i64) -> Result<String, String> {
    if !ai_files_enabled(db, project_id).await {
        return Err("AI access to files is disabled for this project (Project Settings)".into());
    }
    if !embedding_configured(db).await {
        return Err(
            "no embedding model is configured — set one up under Settings → Models → Embedding model first, then re-index. \
             Without it ragrat produces an unsearchable collection (chunks + facets, no vector index)."
                .into(),
        );
    }
    let cfg = client.config();
    let folder = materialize_project(db, cfg, storage_root, project_id).await?;
    let out = cfg.out_root.join(collection_name(project_id));
    let tags = json!({ "app": "ganban", "project": project_id.to_string() });
    client.ingest(&folder, &out, &collection_name(project_id), tags).await
}

/// A cheap content stamp for a project: changes whenever a task/comment/area is
/// added, edited, or removed, or a file is shared/unshared or put in or out of the
/// AI overview (or forced past its size guard). Used by the poller to skip
/// unchanged projects.
async fn project_stamp(db: &Db, project_id: i64) -> Result<String, String> {
    sqlx::query_scalar::<_, String>(
        "SELECT \
           (SELECT COUNT(*)||'/'||COALESCE(MAX(updated_at),'') FROM tasks WHERE project_id=?1 AND archived=0) ||'|'|| \
           (SELECT COUNT(*)||'/'||COALESCE(MAX(c.updated_at),'') FROM comments c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=?1 AND c.deleted_at IS NULL) ||'|'|| \
           (SELECT COUNT(*)||'/'||COALESCE(MAX(updated_at),'') FROM areas WHERE project_id=?1) ||'|'|| \
           (SELECT COUNT(*)||'/'||COALESCE(MAX(e.updated_at),'') FROM events e \
              LEFT JOIN event_projects ep ON ep.event_id=e.id \
              LEFT JOIN event_tasks et ON et.event_id=e.id \
              LEFT JOIN tasks t ON t.id=et.task_id \
              WHERE e.archived=0 AND (ep.project_id=?1 OR t.project_id=?1)) ||'|'|| \
           (SELECT COUNT(*)||':'||COALESCE(SUM(storage_size),0)||':'||COALESCE(SUM(fa.id*fa.ai_included),0)||':'||COALESCE(SUM(fa.id*fa.id*fa.ai_included),0) FROM file_attachments fa JOIN tasks t ON t.id=fa.task_id \
              WHERE t.project_id=?1 AND fa.is_shared=1 AND fa.ai_included>0) ||'|'|| \
           (SELECT COUNT(*)||':'||COALESCE(SUM(size_bytes),0)||':'||COALESCE(SUM(id*ai_included),0)||':'||COALESCE(SUM(id*id*ai_included),0) FROM project_files WHERE project_id=?1 AND ai_included>0) ||'|'|| \
           (SELECT COUNT(*)||':'||COALESCE(SUM(LENGTH(COALESCE(m.body_text,''))),0) FROM email_messages m \
              JOIN email_threads th ON th.id=m.thread_id WHERE th.project_id=?1)",
    )
    .bind(project_id)
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())
}

/// Background loop: every `poll_secs`, re-index each non-archived project whose
/// content stamp changed since it was last indexed (stored in app_settings).
/// Host-side only; cheap (ragrat skips unchanged files by hash). Reuses the same
/// updated_at signal as the incremental sync pull.
///
/// `stop` is the owning daemon's lifetime: the loop exits when it fires OR when
/// its sender is dropped (the daemon died hard). Without this, every daemon
/// restart/upgrade (loopback → tailnet) would leak a poller still holding the
/// old config — observed as ingest requests to a long-dead ragrat port.
pub fn spawn_poller(db: Db, rag: SharedRag, storage_root: PathBuf, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        // Small initial delay so startup isn't contended.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = stop.changed() => return,
        }
        let mut engine_was_down = false;
        let mut embedder_unconfigured = false;
        loop {
            // Read the live client each cycle, so a Settings reconfig (or RAG
            // being enabled at runtime) is picked up without a restart.
            let client = rag.read().await.clone();
            let interval = client.as_ref().map(|c| c.config().poll_secs).unwrap_or(900);
            if let Some(c) = client {
                // A dead engine used to spam one connection error per project
                // per cycle — probe once and report only on state CHANGES.
                if !c.healthy().await {
                    if !engine_was_down {
                        tracing::warn!(
                            "ragrat is unreachable at {} — pausing re-indexing until it's back (Settings → AI Engines → Start engines)",
                            c.config().base_url
                        );
                        engine_was_down = true;
                    }
                } else {
                    if engine_was_down {
                        tracing::info!("ragrat is back — resuming re-indexing");
                        engine_was_down = false;
                    }
                    // No embedder configured → every project's reindex would
                    // fail with the same error (ragrat's defaults leave
                    // embedding OFF → unsearchable collections). Probe once and
                    // throttle to one warning per state change instead of
                    // spamming a log line per project per cycle.
                    if !embedding_configured(&db).await {
                        if !embedder_unconfigured {
                            tracing::warn!(
                                "no embedding model is configured — pausing re-indexing until one is set (Settings → Models → Embedding model). ragrat would otherwise produce unsearchable collections."
                            );
                            embedder_unconfigured = true;
                        }
                    } else {
                        if embedder_unconfigured {
                            tracing::info!("embedding model is configured — resuming re-indexing");
                            embedder_unconfigured = false;
                        }
                        if let Err(e) = poll_once(&db, &c, &storage_root).await {
                            tracing::warn!("poll error: {e}");
                        }
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = stop.changed() => return,
            }
        }
    });
}

async fn poll_once(db: &Db, client: &RagClient, storage_root: &Path) -> Result<(), String> {
    let projects: Vec<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE archived = 0")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    for pid in projects {
        if !ai_files_enabled(db, pid).await {
            continue; // owner said: AI keeps out of this project's files
        }
        let stamp = match project_stamp(db, pid).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let key = format!("rag_stamp_{pid}");
        let prev = ganban_core::ops::get_app_setting(db, &key).await.ok().flatten();
        if prev.as_deref() == Some(stamp.as_str()) {
            continue; // unchanged
        }
        match reindex_project(db, client, storage_root, pid).await {
            Ok(job) => {
                let _ = ganban_core::ops::set_app_setting(db, &key, &stamp).await;
                tracing::info!("re-indexed project {pid} (job {job})");
            }
            Err(e) => tracing::error!("re-index project {pid} failed: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Task visibility for search: a member's hits leave out the documents of tasks they
    /// can't see (with their comments and attachments) and of restricted areas.
    #[tokio::test]
    async fn search_hits_leave_out_what_the_member_cannot_see() {
        use ganban_core::{auth, models, ops, visibility};
        let path = std::env::temp_dir().join(format!("ganban_raghits_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        auth::ensure_owner(&db).await.unwrap();
        sqlx::query("INSERT INTO users (id, username, full_name) VALUES (7, 'bo', 'Bo')").execute(&db).await.unwrap();
        let pid = ops::create_project(&db, models::CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
        auth::add_project_member(&db, pid, 7, auth::ROLE_MEMBER).await.unwrap();
        let finance = ops::create_area(&db, models::CreateAreaInput { project_id: pid, name: "Finance plan".into(), description: None }).await.unwrap().id;
        visibility::set_area_restricted(&db, finance, true).await.unwrap();
        let task = |title: &str, area: Option<i64>| models::CreateTaskInput {
            project_id: pid, area_id: area, title: title.into(), description: None, status: "To Do".into(),
            priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
        };
        let open = ops::create_task(&db, task("Open", None)).await.unwrap().id;
        let budget = ops::create_task(&db, task("Budget", Some(finance))).await.unwrap().id;
        let uuid = |t: i64| {
            let db = db.clone();
            async move { sqlx::query_scalar::<_, String>("SELECT sync_uuid FROM tasks WHERE id = ?").bind(t).fetch_one(&db).await.unwrap() }
        };
        let (open_uuid, budget_uuid) = (uuid(open).await, uuid(budget).await);
        let att = |t: i64| {
            let db = db.clone();
            async move {
                sqlx::query("INSERT INTO file_attachments (task_id, file_path, file_name, created_at, is_valid) VALUES (?, '', 'x.pdf', datetime('now'), 1)")
                    .bind(t).execute(&db).await.unwrap().last_insert_rowid()
            }
        };
        let (open_att, budget_att) = (att(open).await, att(budget).await);
        let sources = [
            "project.md".to_string(),
            format!("task-{open_uuid}.md"),
            format!("task-{budget_uuid}.md"),
            format!("area-{}.md", staged_blob_name(0, "Finance plan")),
            staged_blob_name(open_att, "x.pdf"),
            staged_blob_name(budget_att, "x.pdf"),
            "pf-3__deck.pdf".to_string(),
        ];
        let hits = || sources.iter().map(|s| json!({ "source": s, "text": "…" })).collect::<Vec<_>>();

        let mut bo = hits();
        retain_visible_hits(&db, visibility::Viewer { user_id: 7, is_owner: false }, pid, &mut bo).await.unwrap();
        let kept: Vec<&str> = bo.iter().map(|h| h["source"].as_str().unwrap()).collect();
        let open_doc = format!("task-{open_uuid}.md");
        let open_file = staged_blob_name(open_att, "x.pdf");
        assert_eq!(kept, vec!["project.md", open_doc.as_str(), open_file.as_str(), "pf-3__deck.pdf"]);

        let mut owner = hits();
        retain_visible_hits(&db, visibility::Viewer { user_id: 1, is_owner: true }, pid, &mut owner).await.unwrap();
        assert_eq!(owner.len(), sources.len(), "the owner's assistant finds everything");
    }

    /// The corpus takes only the files someone included, and a file over the size guard
    /// only when it was forced. The stamp moves when a file goes in or out, so the poller
    /// re-indexes.
    #[tokio::test]
    async fn materialize_stages_only_included_files_within_the_guard() {
        use ganban_core::{models, ops, storage};
        let base = std::env::temp_dir().join(format!("ganban_ragstage_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = ganban_core::init_db(&base.join("t.db")).await.unwrap();
        let root = base.join("storage");
        let cfg = RagConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: None,
            staging: base.join("staging"),
            out_root: base.join("out"),
            poll_secs: 900,
        };
        let pid = ops::create_project(&db, models::CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
        let tid = ops::create_task(
            &db,
            models::CreateTaskInput {
                project_id: pid, area_id: None, title: "t".into(), description: None, status: "To Do".into(),
                priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
            },
        )
        .await
        .unwrap()
        .id;
        let pf = |name: &'static str, bytes: &'static [u8]| {
            let (db, root) = (db.clone(), root.clone());
            async move { storage::store_project_file(&db, &root, pid, name, None, None, None, bytes).await.unwrap().id }
        };
        let (left_out, notes, book, forced) = (pf("left-out.md", b"x").await, pf("notes.md", b"notes").await, pf("book.pdf", b"0123456789").await, pf("atlas.pdf", b"0123456789").await);
        let att = storage::store_shared_bytes(&db, &root, tid, "brief.md", None, None, b"brief").await.unwrap().id;
        let left_out_att = storage::store_shared_bytes(&db, &root, tid, "left-out.md", None, None, b"x").await.unwrap().id;

        let stamp_before = project_stamp(&db, pid).await.unwrap();
        storage::set_project_file_ai_included(&db, notes, true, false).await.unwrap();
        storage::set_attachment_ai_included(&db, att, true, false).await.unwrap();
        // "book" was included and its bytes later outgrew the guard; "atlas" was forced.
        sqlx::query("UPDATE project_files SET ai_included = 1 WHERE id = ?").bind(book).execute(&db).await.unwrap();
        sqlx::query("UPDATE project_files SET ai_included = 2 WHERE id = ?").bind(forced).execute(&db).await.unwrap();
        let stamp_after = project_stamp(&db, pid).await.unwrap();
        assert_ne!(stamp_before, stamp_after, "including files moves the stamp");

        let dir = materialize_with_guard(&db, &cfg, &root, pid, 8).await.unwrap();
        let mut staged: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with(".md") || n.contains("__"))
            .collect();
        staged.sort();
        let mut want = vec![
            staged_blob_name(att, "brief.md"),
            format!("pf-{}", staged_blob_name(notes, "notes.md")),
            format!("pf-{}", staged_blob_name(forced, "atlas.pdf")),
        ];
        want.sort();
        assert_eq!(staged, want, "left-out files ({left_out}, {left_out_att}) and the unforced big one ({book}) stay out");
        assert_eq!(std::fs::read(dir.join(staged_blob_name(att, "brief.md"))).unwrap(), b"brief");

        // Leaving a file out again moves the stamp back toward the poller.
        storage::set_project_file_ai_included(&db, notes, false, false).await.unwrap();
        assert_ne!(project_stamp(&db, pid).await.unwrap(), stamp_after);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn from_db_reads_ragrat_connection() {
        let path = std::env::temp_dir().join(format!("ganban_ragcfg_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = ganban_core::init_db(&path).await.unwrap();
        ganban_core::ops::set_app_setting(&db, "ragrat_connection", r#"{"url":"http://127.0.0.1:8780/","token":"abc"}"#)
            .await
            .unwrap();
        let cfg = RagConfig::from_db(&db).await.expect("RAG enabled by the setting");
        assert_eq!(cfg.base_url, "http://127.0.0.1:8780", "url read + trimmed");
        assert_eq!(cfg.token.as_deref(), Some("abc"));
    }

    #[tokio::test]
    async fn embedding_configured_reads_rag_embedding_setting() {
        // Guards gap #2: without an embedder, ragrat's defaults leave embedding
        // OFF and an ingest silently produces an unsearchable collection.
        let path = std::env::temp_dir().join(format!("ganban_embcfg_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = ganban_core::init_db(&path).await.unwrap();

        // Unset → not configured.
        assert!(!embedding_configured(&db).await);

        // Present + complete → configured.
        ganban_core::ops::set_app_setting(
            &db,
            "rag_embedding",
            r#"{"endpoint":"http://127.0.0.1:11434/v1/embeddings","model":"nomic-embed-text","dimensions":768}"#,
        )
        .await
        .unwrap();
        assert!(embedding_configured(&db).await);

        // Zero/negative dimensions → not usable (a LanceDB schema pinned to 0d is meaningless).
        ganban_core::ops::set_app_setting(&db, "rag_embedding", r#"{"endpoint":"x","model":"y","dimensions":0}"#)
            .await
            .unwrap();
        assert!(!embedding_configured(&db).await);

        // Missing model → not usable.
        ganban_core::ops::set_app_setting(&db, "rag_embedding", r#"{"endpoint":"x","dimensions":8}"#)
            .await
            .unwrap();
        assert!(!embedding_configured(&db).await);

        // Malformed JSON → not usable (never panics).
        ganban_core::ops::set_app_setting(&db, "rag_embedding", "not json").await.unwrap();
        assert!(!embedding_configured(&db).await);
    }

    #[test]
    fn task_markdown_has_title_fields_and_comments() {
        let md = task_markdown(
            "Flash the chimney",
            Some("Use lead flashing."),
            "In Progress",
            "High",
            Some("Roof"),
            &[("Pete".into(), "started today".into())],
        );
        assert!(md.starts_with("# Flash the chimney\n"));
        assert!(md.contains("Status: In Progress"));
        assert!(md.contains("Priority: High"));
        assert!(md.contains("Area: Roof"));
        assert!(md.contains("## Description"));
        assert!(md.contains("Use lead flashing."));
        assert!(md.contains("**Pete:** started today"));
    }

    #[test]
    fn task_markdown_omits_empty_sections() {
        let md = task_markdown("Bare", None, "To Do", "Low", None, &[]);
        assert!(!md.contains("## Description"));
        assert!(!md.contains("## Comments"));
        assert!(!md.contains("Area:"));
    }

    #[test]
    fn staged_blob_name_keeps_extension_and_sanitizes() {
        assert_eq!(staged_blob_name(7, "Q3 report.pdf"), "7__Q3_report.pdf");
        assert_eq!(staged_blob_name(7, "../../etc/passwd"), "7__.._.._etc_passwd");
        assert_eq!(staged_blob_name(7, ""), "7__file");
    }

    #[test]
    fn collection_name_is_per_project() {
        assert_eq!(collection_name(42), "ganban-42");
    }

    #[test]
    fn sse_json_unwraps_event_stream_and_plain_json() {
        // The MCP transport frames the JSON-RPC reply as an SSE "data:" line.
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"search_corpus\"}]}}\n\n";
        let v = sse_json(body).expect("parses SSE-framed JSON");
        assert_eq!(v["result"]["tools"][0]["name"], "search_corpus");

        // A server that answers application/json (no SSE frame) still parses.
        assert_eq!(sse_json("{\"ok\":true}").unwrap()["ok"], true);

        assert!(sse_json("event: ping\n\n").is_none(), "no data frame, not JSON → None");
    }
}

#[cfg(test)]
mod facets_tests {
    use super::*;

    fn client_with_out(tag: &str) -> (RagClient, PathBuf) {
        let out = std::env::temp_dir().join(format!("ganban_facets_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        let cfg = RagConfig {
            base_url: "http://127.0.0.1:1".into(), // never contacted by read_facets
            token: None,
            staging: out.join("staging"),
            out_root: out.clone(),
            poll_secs: 900,
        };
        (RagClient::new(cfg), out)
    }

    #[test]
    fn read_facets_parses_the_ingest_output_and_degrades_to_empty() {
        let (client, out) = client_with_out("read");
        // Never ingested → empty object, not an error.
        assert_eq!(client.read_facets("ganban-1"), json!({}));

        // The shape ragrat writes: role → value → count.
        std::fs::create_dir_all(out.join("ganban-1")).unwrap();
        std::fs::write(
            out.join("ganban-1").join("facets.json"),
            r#"{"format": {"md": 16, "pdf": 3}, "project": {"1": 19}}"#,
        )
        .unwrap();
        let facets = client.read_facets("ganban-1");
        assert_eq!(facets["format"]["pdf"], 3);
        assert_eq!(facets["project"]["1"], 19);

        // Corrupt file → empty object, not a crash.
        std::fs::write(out.join("ganban-1").join("facets.json"), "not json").unwrap();
        assert_eq!(client.read_facets("ganban-1"), json!({}));
    }

    /// The MCP tool list is fetched once and then served from the cache, by
    /// every clone of the client, until it goes stale.
    #[tokio::test]
    async fn mcp_tool_lists_are_cached_for_a_minute() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let lists = std::sync::Arc::new(AtomicUsize::new(0));
        let lists_srv = lists.clone();
        // A minimal MCP mount: a session id on initialize, one tool on tools/list.
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let lists = lists_srv.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let body = if req.contains("tools/list") {
                        lists.fetch_add(1, Ordering::SeqCst);
                        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search_corpus"}]}}"#
                    } else {
                        r#"{"jsonrpc":"2.0","id":1,"result":{}}"#
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let (mut client, _out) = client_with_out("mcp");
        client.cfg.base_url = base_url;
        let first = client.mcp_tools("/mcp/").await.expect("lists the mount's tools");
        assert_eq!(first[0]["name"], "search_corpus");
        assert_eq!(client.clone().mcp_tools("/mcp/").await, Some(first), "a clone reads the same cache");
        assert_eq!(lists.load(Ordering::SeqCst), 1, "asked ragrat once");
        // Age the entry past the TTL: the next call asks again.
        for entry in client.mcp_tools_cache.lock().unwrap().values_mut() {
            entry.0 = entry.0.checked_sub(MCP_TOOLS_TTL).expect("the clock has run for a minute");
        }
        client.mcp_tools("/mcp/").await.unwrap();
        assert_eq!(lists.load(Ordering::SeqCst), 2, "a stale list is refetched");
    }
}
