//! Client for a host-local **Ollama** engine (the inference backend Ganban
//! manages). Used for assistant chat generation here; ragrat consumes Ollama's
//! OpenAI-compatible `/v1/embeddings` directly for the corpus.
//!
//! Chat uses Ollama's native `POST /api/chat` (NDJSON stream: one JSON object
//! per line, `{"message":{"content":…},"done":bool}`) — simpler + more robust to
//! parse than OpenAI SSE framing, and it exposes Ollama's options cleanly.

use std::time::Duration;

use async_stream::stream;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};

/// Where the host-local Ollama listens. M1 reads an env/default; M2 moves this
/// into DB-backed settings.
#[derive(Clone, Debug)]
pub struct OllamaConfig {
    pub base_url: String,
}

impl OllamaConfig {
    const DEFAULT: &'static str = "http://127.0.0.1:11434";

    pub(crate) fn norm(s: &str) -> Option<String> {
        let s = s.trim().trim_end_matches('/');
        (!s.is_empty()).then(|| s.to_string())
    }

    pub fn from_env_or_default() -> Self {
        let base = std::env::var("GANBAN_OLLAMA_URL").ok().and_then(|s| Self::norm(&s)).unwrap_or_else(|| Self::DEFAULT.to_string());
        Self { base_url: base }
    }

    /// Read the Ollama base URL from DB settings — `ollama_connection` =
    /// `{"base_url":…}` — written from Settings; falls back to env, then the
    /// localhost default. Always yields a config (Ollama is the local default).
    pub async fn from_db(db: &ganban_core::Db) -> Self {
        let from_settings = ganban_core::ops::get_app_setting(db, "ollama_connection")
            .await
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("base_url").and_then(|b| b.as_str()).and_then(Self::norm));
        let base = from_settings
            .or_else(|| std::env::var("GANBAN_OLLAMA_URL").ok().and_then(|s| Self::norm(&s)))
            .unwrap_or_else(|| Self::DEFAULT.to_string());
        Self { base_url: base }
    }
}

/// Per-request generation parameters (from the active model profile).
#[derive(Clone, Debug)]
pub struct ChatParams {
    pub model: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    /// Context window (Ollama `num_ctx`). None = Ollama's default, which is
    /// SMALL (2048-4096) and silently truncates long prompts — agent tasks
    /// with document text must size this to the job.
    pub num_ctx: Option<i64>,
    /// Epoch H: a profile-designated remote engine (e.g. the 4090 box over
    /// the tailnet). None = the host's supervised local engine.
    pub endpoint: Option<String>,
}

/// One tool the model asked to call (name + already-parsed JSON arguments).
#[derive(Clone, Debug)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

/// Token/latency usage of one `/api/chat` call, from Ollama's final frame.
/// This is the raw material of capacity planning — every throughput claim is
/// a guess until these numbers are in the ledger.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub duration_ms: i64,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.duration_ms += other.duration_ms;
    }
    pub fn is_zero(&self) -> bool {
        self.prompt_tokens == 0 && self.completion_tokens == 0 && self.duration_ms == 0
    }
}

fn parse_usage(v: &Value) -> Usage {
    Usage {
        prompt_tokens: v.get("prompt_eval_count").and_then(|x| x.as_i64()).unwrap_or(0),
        completion_tokens: v.get("eval_count").and_then(|x| x.as_i64()).unwrap_or(0),
        // total_duration is nanoseconds.
        duration_ms: v.get("total_duration").and_then(|x| x.as_i64()).unwrap_or(0) / 1_000_000,
    }
}

/// A handle the streaming path fills in when the final frame arrives — read it
/// AFTER draining the stream.
pub type UsageSlot = std::sync::Arc<std::sync::Mutex<Option<Usage>>>;

/// The result of a single non-streamed turn: the assistant's text and any tool
/// calls it requested (empty when it produced a final answer).
#[derive(Clone, Debug, Default)]
pub struct ChatTurn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
}

/// A live, swappable Ollama client, held behind a RwLock so Settings can
/// reconfigure the base URL without a daemon restart.
pub type SharedOllama = std::sync::Arc<tokio::sync::RwLock<Option<OllamaClient>>>;

#[derive(Clone)]
pub struct OllamaClient {
    http: reqwest::Client,
    cfg: OllamaConfig,
}

impl OllamaClient {
    /// The client a request should use: the profile's remote endpoint when
    /// designated, else the shared local one. Remote engines are reached, not
    /// supervised — a sleeping gaming PC is an expected state, surfaced as a
    /// reachability error by the call itself.
    pub fn for_params(global: &OllamaClient, params: &ChatParams) -> OllamaClient {
        match params.endpoint.as_deref().and_then(OllamaConfig::norm) {
            Some(base_url) => OllamaClient::new(OllamaConfig { base_url }),
            None => global.clone(),
        }
    }

    pub fn new(cfg: OllamaConfig) -> Self {
        // No overall timeout: chat streams can run for minutes. A connect timeout
        // still bounds "Ollama isn't there".
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self { http, cfg }
    }

    pub fn config(&self) -> &OllamaConfig {
        &self.cfg
    }

    /// Names of locally-available models (`GET /api/tags`). Doubles as a reachability probe.
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/api/tags", self.cfg.base_url);
        let resp = self.http.get(&url).send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama {}", resp.status()));
        }
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(val
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| arr.iter().filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
            .unwrap_or_default())
    }

    /// A compact snapshot of a model's capabilities (`POST /api/show`): context
    /// window, family, parameter size, quantization and capabilities ("tools",
    /// "vision", "thinking", …). Best-effort — fields the engine doesn't report
    /// are simply omitted. Powers a profile's "vCard".
    pub async fn model_info(&self, model: &str) -> Result<Value, String> {
        let url = format!("{}/api/show", self.cfg.base_url);
        // Older Ollama keys this "name", newer "model"; send both (extras ignored).
        let resp = self
            .http
            .post(&url)
            .json(&json!({ "model": model, "name": model }))
            .send()
            .await
            .map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama {}", resp.status()));
        }
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(compact_model_info(&val))
    }

    /// Stream a chat completion as a sequence of content deltas. `messages` is the
    /// OpenAI/Ollama shape `[{ "role": …, "content": … }]`. Each `Ok(String)` is a
    /// chunk of assistant text; the caller accumulates + forwards them.
    /// Returns the token stream plus a `UsageSlot` the final frame fills in —
    /// read it after the stream is drained (None = stream died early).
    pub async fn chat_stream(
        &self,
        params: &ChatParams,
        messages: Vec<Value>,
    ) -> Result<(impl Stream<Item = Result<String, String>>, UsageSlot), String> {
        let mut options = serde_json::Map::new();
        if let Some(t) = params.temperature {
            options.insert("temperature".into(), json!(t));
        }
        if let Some(n) = params.max_tokens {
            options.insert("num_predict".into(), json!(n));
        }
        if let Some(c) = params.num_ctx {
            options.insert("num_ctx".into(), json!(c));
        }
        let body = json!({
            "model": params.model,
            "messages": messages,
            "stream": true,
            "options": Value::Object(options),
        });

        let url = format!("{}/api/chat", self.cfg.base_url);
        let resp = self.http.post(&url).json(&body).send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama {status}: {}", detail.trim()));
        }

        let mut bytes = resp.bytes_stream();
        let usage: UsageSlot = Default::default();
        let usage_w = usage.clone();
        let stream = stream! {
            // Ollama emits newline-delimited JSON; reassemble across chunk boundaries.
            let mut buf = String::new();
            while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => { yield Err(format!("stream error: {e}")); return; }
                };
                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(nl) = buf.find('\n') {
                    let line: String = buf.drain(..=nl).collect();
                    match parse_chat_line(line.trim()) {
                        LineResult::Delta(s) if !s.is_empty() => yield Ok(s),
                        LineResult::Done(s, u) => {
                            *usage_w.lock().unwrap() = Some(u);
                            if !s.is_empty() { yield Ok(s); }
                        }
                        LineResult::Error(e) => { yield Err(e); return; }
                        LineResult::Delta(_) | LineResult::Skip => {}
                    }
                }
            }
            // Flush any trailing partial line.
            match parse_chat_line(buf.trim()) {
                LineResult::Delta(s) if !s.is_empty() => yield Ok(s),
                LineResult::Done(s, u) => {
                    *usage_w.lock().unwrap() = Some(u);
                    if !s.is_empty() { yield Ok(s); }
                }
                _ => {}
            }
        };
        Ok((stream, usage))
    }

    /// A single non-streaming chat turn that may request tools (`POST /api/chat`,
    /// `stream:false`). Returns the assistant's text and any `tool_calls`. The
    /// agentic tool loop uses this; the final user-visible answer still streams
    /// via `chat_stream`.
    pub async fn chat_once(&self, params: &ChatParams, messages: &[Value], tools: &[Value]) -> Result<ChatTurn, String> {
        let mut options = serde_json::Map::new();
        if let Some(t) = params.temperature {
            options.insert("temperature".into(), json!(t));
        }
        if let Some(n) = params.max_tokens {
            options.insert("num_predict".into(), json!(n));
        }
        if let Some(c) = params.num_ctx {
            options.insert("num_ctx".into(), json!(c));
        }
        let mut body = json!({
            "model": params.model,
            "messages": messages,
            "stream": false,
            "options": Value::Object(options),
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
        }
        let url = format!("{}/api/chat", self.cfg.base_url);
        let resp = self.http.post(&url).json(&body).send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(format!("Ollama {status}: {}", resp.text().await.unwrap_or_default().trim()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        let msg = v.get("message");
        let content = msg.and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("").to_string();
        let tool_calls = msg
            .and_then(|m| m.get("tool_calls"))
            .and_then(|tc| tc.as_array())
            .map(|arr| arr.iter().filter_map(parse_tool_call).collect())
            .unwrap_or_default();
        Ok(ChatTurn { content, tool_calls, usage: parse_usage(&v) })
    }

    /// Pull a model (`POST /api/pull`), streaming Ollama's NDJSON progress
    /// objects (`{status, completed?, total?, digest?}` … `{status:"success"}`)
    /// as `Ok(Value)`; an `{error}` frame becomes `Err`.
    pub async fn pull_stream(&self, model: &str) -> Result<impl Stream<Item = Result<Value, String>>, String> {
        let body = json!({ "model": model, "stream": true });
        let url = format!("{}/api/pull", self.cfg.base_url);
        let resp = self.http.post(&url).json(&body).send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(format!("Ollama {status}: {}", resp.text().await.unwrap_or_default().trim()));
        }
        let mut bytes = resp.bytes_stream();
        Ok(stream! {
            let mut buf = String::new();
            while let Some(chunk) = bytes.next().await {
                let chunk = match chunk { Ok(c) => c, Err(e) => { yield Err(format!("stream error: {e}")); return; } };
                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(nl) = buf.find('\n') {
                    let line: String = buf.drain(..=nl).collect();
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    match serde_json::from_str::<Value>(line) {
                        Ok(v) => {
                            if let Some(err) = v.get("error").and_then(|e| e.as_str()) { yield Err(err.to_string()); return; }
                            yield Ok(v);
                        }
                        Err(_) => {} // tolerate a partial line
                    }
                }
            }
        })
    }

    /// Test-embed a string and return the embedding width. Used to derive/validate
    /// the embedding `dimensions` (which pins each ragrat collection's LanceDB
    /// schema) before storing them.
    pub async fn embed_dimensions(&self, model: &str) -> Result<usize, String> {
        let body = json!({ "model": model, "input": "dimension probe" });
        let url = format!("{}/v1/embeddings", self.cfg.base_url);
        let resp = self.http.post(&url).json(&body).send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(format!("Ollama {status}: {}", resp.text().await.unwrap_or_default().trim()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        v.get("data")
            .and_then(|d| d.get(0))
            .and_then(|e| e.get("embedding"))
            .and_then(|e| e.as_array())
            .map(|a| a.len())
            .filter(|n| *n > 0)
            .ok_or_else(|| "no embedding in response (is this an embedding model?)".to_string())
    }
}

#[derive(Debug)]
enum LineResult {
    Delta(String),
    /// Final frame: optional trailing content delta + token/latency usage.
    Done(String, Usage),
    Error(String),
    Skip,
}

/// Distil a raw `/api/show` response into the handful of fields a profile vCard
/// shows. `model_info` is keyed by architecture (e.g. `llama.context_length`),
/// so we scan for the `*.context_length` entry rather than guess the prefix.
fn compact_model_info(raw: &Value) -> Value {
    let context_length = raw
        .get("model_info")
        .and_then(|m| m.as_object())
        .and_then(|m| m.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, v)| v.as_u64()));
    let details = raw.get("details");
    let family = details.and_then(|d| d.get("family")).and_then(|v| v.as_str());
    let parameter_size = details.and_then(|d| d.get("parameter_size")).and_then(|v| v.as_str());
    let quantization = details.and_then(|d| d.get("quantization_level")).and_then(|v| v.as_str());
    let capabilities = raw.get("capabilities").cloned().unwrap_or(Value::Null);
    json!({
        "context_length": context_length,
        "family": family,
        "parameter_size": parameter_size,
        "quantization": quantization,
        "capabilities": capabilities,
    })
}

/// Parse one NDJSON line from `/api/chat`. Pure (unit-tested).
fn parse_chat_line(line: &str) -> LineResult {
    if line.is_empty() {
        return LineResult::Skip;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return LineResult::Skip, // tolerate a partial/garbage line
    };
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return LineResult::Error(err.to_string());
    }
    let content = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
        // Final frame: may carry a last content delta, and carries the usage
        // counters (prompt_eval_count / eval_count / total_duration).
        return LineResult::Done(content.to_string(), parse_usage(&v));
    }
    LineResult::Delta(content.to_string())
}

/// Parse one Ollama `tool_calls[]` entry: `{"function":{"name","arguments":{…}}}`.
/// `arguments` is normally a JSON object, though some models emit it as a string.
fn parse_tool_call(v: &Value) -> Option<ToolCall> {
    let f = v.get("function")?;
    let name = f.get("name").and_then(|n| n.as_str())?.to_string();
    let arguments = match f.get("arguments") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Some(other) => other.clone(),
        None => json!({}),
    };
    Some(ToolCall { name, arguments })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_tool_call_with_object_args() {
        let v = json!({"function": {"name": "get_task_comments", "arguments": {"task_id": 7}}});
        let tc = parse_tool_call(&v).unwrap();
        assert_eq!(tc.name, "get_task_comments");
        assert_eq!(tc.arguments.get("task_id").and_then(Value::as_i64), Some(7));
    }

    #[test]
    fn parses_a_tool_call_with_stringified_args() {
        let v = json!({"function": {"name": "search_corpus", "arguments": "{\"query\":\"roof\"}"}});
        let tc = parse_tool_call(&v).unwrap();
        assert_eq!(tc.arguments.get("query").and_then(Value::as_str), Some("roof"));
    }

    fn delta(line: &str) -> Option<String> {
        match parse_chat_line(line) {
            LineResult::Delta(s) => Some(s),
            // Final frames carry their trailing delta alongside the usage.
            LineResult::Done(s, _) if !s.is_empty() => Some(s),
            _ => None,
        }
    }

    #[test]
    fn parses_a_content_delta() {
        assert_eq!(delta(r#"{"message":{"role":"assistant","content":"Hel"},"done":false}"#), Some("Hel".into()));
    }

    #[test]
    fn final_frame_with_no_content_is_done() {
        assert!(matches!(parse_chat_line(r#"{"message":{"content":""},"done":true}"#), LineResult::Done(..)));
    }

    #[test]
    fn final_frame_carries_usage() {
        let line = r#"{"message":{"content":""},"done":true,"prompt_eval_count":120,"eval_count":45,"total_duration":2500000000}"#;
        match parse_chat_line(line) {
            LineResult::Done(_, u) => {
                assert_eq!(u.prompt_tokens, 120);
                assert_eq!(u.completion_tokens, 45);
                assert_eq!(u.duration_ms, 2500);
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn final_frame_can_still_carry_a_delta() {
        assert_eq!(delta(r#"{"message":{"content":"!"},"done":true}"#), Some("!".into()));
    }

    #[test]
    fn surfaces_an_error_frame() {
        assert!(matches!(parse_chat_line(r#"{"error":"model not found"}"#), LineResult::Error(_)));
    }

    #[test]
    fn tolerates_blank_and_partial_lines() {
        assert!(matches!(parse_chat_line(""), LineResult::Skip));
        assert!(matches!(parse_chat_line(r#"{"message":{"content""#), LineResult::Skip));
    }

    #[tokio::test]
    async fn from_db_reads_setting_else_defaults() {
        let path = std::env::temp_dir().join(format!("ganban_ollamacfg_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = ganban_core::init_db(&path).await.unwrap();
        assert_eq!(OllamaConfig::from_db(&db).await.base_url, "http://127.0.0.1:11434", "default when unset");
        ganban_core::ops::set_app_setting(&db, "ollama_connection", r#"{"base_url":"http://10.0.0.5:11434/"}"#).await.unwrap();
        assert_eq!(OllamaConfig::from_db(&db).await.base_url, "http://10.0.0.5:11434", "reads + trims the setting");
    }
}
