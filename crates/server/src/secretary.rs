//! The "secretary": a grounded, cross-project daily assistant.
//!
//! Two surfaces share one deterministic grounding layer:
//!   * the **daily brief** — the current date/time + the owner's upcoming events,
//!     computed here from the DB (never left to the model; LLMs are bad at dates),
//!     injected into the secretary chat's system prompt AND shown verbatim on Home.
//!   * the **daily rundown** — a per-project, neutral 1–2 sentence status summary.
//!     Code does the fetching and the final assembly; the model only summarizes
//!     one bounded, structured project context at a time, returning JSON. If the
//!     LLM is down/slow, each project degrades to a deterministic count summary
//!     rather than failing the run.
//!
//! The rundown is stored idempotently in `app_settings` (one key, overwritten per
//! run) — re-running the same day updates in place. No new table, no sync surface.

use chrono::{Duration, Local, NaiveDate, TimeZone, Utc};
use futures_util::StreamExt;
use ganban_core::error::Result;
use ganban_core::models::Project;
use ganban_core::{ops, Db};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ollama::{ChatParams, OllamaClient, Usage};
use crate::rag::{self, RagClient};

/// How far ahead the brief/rundown look for "upcoming" events and due tasks.
const HORIZON_DAYS: i64 = 7;
/// Cap the rundown's project count so a big workspace can't fan out into dozens
/// of LLM calls per run. Omitted count is surfaced (no silent truncation).
const MAX_RUNDOWN_PROJECTS: usize = 12;
/// The single app_settings key the latest rundown lives under.
const RUNDOWN_KEY: &str = "secretary_rundown";
/// Hard ceiling on each project's summarization. A hung/slow model degrades that
/// one project to its deterministic fallback rather than stalling the whole run.
const PER_PROJECT_TIMEOUT_SECS: u64 = 25;
/// Best-effort RAG grounding must not stall the loop — bound it tightly and skip
/// on timeout. (The LLM call has its own [`PER_PROJECT_TIMEOUT_SECS`] bound.)
const RAG_TIMEOUT_SECS: u64 = 8;

/// A retrieval probe for grounding a project's summary in its own knowledge base.
const RAG_QUERY: &str = "Current status: what is in progress, due soon, blocked, or needs attention?";

const SUMMARIZER_SYSTEM: &str = "You are a neutral project-status summarizer. Given a project's current state, reply with ONLY a JSON object of the form {\"summary\": \"<1-2 sentence factual summary of what is open, due, or needs attention>\", \"flags\": [\"due_soon\"|\"blocked\"|\"stalled\"|\"on_track\"]}. Use only the facts provided — never invent tasks, dates, or events. Output the JSON object and nothing else.";

// --------------------------------------------------------------------------- //
// The daily brief (deterministic grounding — no LLM).
// --------------------------------------------------------------------------- //

/// One upcoming event, pre-bucketed and pre-formatted. Times are the stored
/// wall-clock strings; the date is bucketed in the host's local timezone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventBrief {
    pub id: i64,
    pub title: String,
    pub date: String,    // YYYY-MM-DD (host local)
    pub weekday: String, // e.g. "Mon"
    pub all_day: bool,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub location: Option<String>,
    pub projects: Vec<String>,
    pub bucket: String, // "today" | "tomorrow" | "upcoming"
}

/// The authoritative "what's going on" block: current date/time (host local) plus
/// the next [`HORIZON_DAYS`] of events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyBrief {
    pub today: String,   // YYYY-MM-DD (host local)
    pub now: String,     // HH:MM (host local)
    pub weekday: String, // full weekday name
    pub events: Vec<EventBrief>,
    pub today_count: usize,
    pub tomorrow_count: usize,
}

impl DailyBrief {
    /// A compact, model-facing grounding block. Facts only — the persona/voice is
    /// applied separately (in the system prompt that precedes this).
    pub fn render(&self) -> String {
        let mut s = format!(
            "Current date: {} ({})\nCurrent time: {}\n\n",
            self.today, self.weekday, self.now
        );
        if self.events.is_empty() {
            s.push_str("No events scheduled in the next 7 days.\n");
            return s;
        }
        s.push_str("Upcoming events (this list is authoritative — do not invent any others):\n");
        for e in &self.events {
            let when = if e.all_day {
                "all day".to_string()
            } else {
                match (&e.start_time, &e.end_time) {
                    (Some(a), Some(b)) => format!("{a}–{b}"),
                    (Some(a), None) => a.clone(),
                    _ => "time TBD".to_string(),
                }
            };
            let loc = e
                .location
                .as_deref()
                .filter(|l| !l.trim().is_empty())
                .map(|l| format!(" @ {l}"))
                .unwrap_or_default();
            let proj = if e.projects.is_empty() {
                String::new()
            } else {
                format!(" [project: {}]", e.projects.join(", "))
            };
            let tag = match e.bucket.as_str() {
                "today" => "TODAY",
                "tomorrow" => "TOMORROW",
                _ => e.weekday.as_str(),
            };
            s.push_str(&format!("- {} {} ({}): {}{}{}\n", tag, e.date, when, e.title, loc, proj));
        }
        s
    }
}

/// Build the daily brief from the events table, bucketed by the host's local date.
pub async fn build_brief(db: &Db) -> Result<DailyBrief> {
    let now = Local::now();
    let today = now.date_naive();
    let tomorrow = today.succ_opt().unwrap_or(today);
    let horizon = today + Duration::days(HORIZON_DAYS);

    // The events table is a personal calendar (small); fetch active events and
    // bucket precisely by local date here rather than fight RFC3339/noon-UTC
    // boundary cases in a SQL range.
    let all = ops::get_events(db, None, None, Some(false)).await?;
    let mut events = Vec::new();
    let (mut today_count, mut tomorrow_count) = (0usize, 0usize);
    for e in all {
        let d = e.event_date.with_timezone(&Local).date_naive();
        // Marked past by hand: not on the agenda any more.
        if e.done_at.is_some() || d < today || d > horizon {
            continue;
        }
        let bucket = if d == today {
            today_count += 1;
            "today"
        } else if d == tomorrow {
            tomorrow_count += 1;
            "tomorrow"
        } else {
            "upcoming"
        };
        let projects = ops::event_project_names(db, e.id).await.unwrap_or_default();
        events.push(EventBrief {
            id: e.id,
            title: e.title,
            date: d.format("%Y-%m-%d").to_string(),
            weekday: d.format("%a").to_string(),
            all_day: e.all_day,
            start_time: e.start_time,
            end_time: e.end_time,
            location: e.location,
            projects,
            bucket: bucket.to_string(),
        });
    }

    Ok(DailyBrief {
        today: today.format("%Y-%m-%d").to_string(),
        now: now.format("%H:%M").to_string(),
        weekday: now.format("%A").to_string(),
        events,
        today_count,
        tomorrow_count,
    })
}

// --------------------------------------------------------------------------- //
// The daily rundown (deterministic fetch + assembly; narrow LLM summarize step).
// --------------------------------------------------------------------------- //

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRundown {
    pub project_id: i64,
    pub project_name: String,
    pub summary: String,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rundown {
    pub run_date: String,     // host-local YYYY-MM-DD
    pub generated_at: String, // RFC3339 (host local)
    pub projects: Vec<ProjectRundown>,
    /// Active projects beyond the per-run cap that were not summarized (0 normally).
    #[serde(default)]
    pub omitted: usize,
    /// Capacity meter: token/latency totals across every project summary in
    /// this run — the routine ledger row stores these.
    #[serde(default)]
    pub usage: Usage,
}

/// The most recent stored rundown, if any (`null` until first generated).
pub async fn latest_rundown(db: &Db) -> Result<Option<Rundown>> {
    let raw = ops::get_app_setting(db, RUNDOWN_KEY).await?;
    Ok(raw.and_then(|s| serde_json::from_str::<Rundown>(&s).ok()))
}

/// Generate today's rundown. Per active project: gather a bounded structured
/// context (code), optionally ground it in the project's own RAG knowledge base,
/// summarize with that project's configured model (its personality), assemble
/// deterministically, and persist (idempotent per run). `default_model` is used
/// for projects with no configured profile. Summaries stay factual (neutral voice);
/// the project's personality shows through its model + knowledge, not its tone.
pub async fn generate_rundown(
    db: &Db,
    client: &OllamaClient,
    rag: Option<&RagClient>,
    default_model: &str,
) -> Result<Rundown> {
    let now = Local::now();
    let today = now.date_naive();

    let mut projects = ops::get_projects(db).await?;
    projects.retain(|p| !p.archived);
    let omitted = projects.len().saturating_sub(MAX_RUNDOWN_PROJECTS);
    projects.truncate(MAX_RUNDOWN_PROJECTS);

    let mut out = Vec::with_capacity(projects.len());
    let mut usage = Usage::default();
    for p in &projects {
        let ctx = build_project_context(db, p, today).await;
        // Each project speaks through its own configured model (low temperature
        // for a stable, factual digest regardless of the profile's settings).
        let model = resolve_project_model(db, p, default_model).await;
        // Per-project profiles may designate a remote engine (Epoch H); the
        // rundown follows the profile like chat does.
        let endpoint = resolve_project_endpoint(db, p).await;
        let params = ChatParams { model, temperature: Some(0.2), max_tokens: Some(220), num_ctx: None, endpoint };
        let client = &OllamaClient::for_params(client, &params);
        // Ground in the project's own knowledge base when RAG is available
        // (best-effort — the summary still works from the structured facts alone).
        let mut prompt = ctx.text.clone();
        let ai_ok = rag::ai_files_enabled(db, p.id).await;
        if let Some(rc) = rag.filter(|_| ai_ok) {
            let collection = rag::collection_name(p.id);
            let search = rc.search(&collection, RAG_QUERY, 4, None);
            // Time-bound the (remote) search so a stalled ragrat can't hang the run.
            if let Ok(Ok(hits)) = tokio::time::timeout(std::time::Duration::from_secs(RAG_TIMEOUT_SECS), search).await {
                let kb: String = hits
                    .iter()
                    .filter_map(|h| h.get("text").and_then(|t| t.as_str()))
                    // Hits come from member-writable tasks/comments. Collapse to a
                    // single capped line so injected multi-line structure can't
                    // reshape the prompt (the strict JSON contract is the real guard).
                    .map(|t| {
                        let one_line = t.split_whitespace().collect::<Vec<_>>().join(" ");
                        let capped: String = one_line.chars().take(200).collect();
                        format!("- {capped}\n")
                    })
                    .filter(|l| l.trim() != "-")
                    .collect();
                if !kb.is_empty() {
                    prompt.push_str("\nFrom the project's knowledge base:\n");
                    prompt.push_str(&kb);
                }
            }
        }
        let (summary, flags, project_usage) = summarize_project(client, &params, &prompt, &ctx).await;
        usage.add(project_usage);
        out.push(ProjectRundown {
            project_id: p.id,
            project_name: p.name.clone(),
            summary,
            flags,
        });
    }

    let rundown = Rundown {
        run_date: today.format("%Y-%m-%d").to_string(),
        generated_at: now.to_rfc3339(),
        projects: out,
        omitted,
        usage,
    };
    let json = serde_json::to_string(&rundown).unwrap_or_default();
    ops::set_app_setting(db, RUNDOWN_KEY, &json).await?;
    Ok(rundown)
}

/// A project profile's designated remote endpoint, if any (Epoch H).
async fn resolve_project_endpoint(db: &Db, p: &Project) -> Option<String> {
    let pid = p.model_profile_id?;
    ops::get_model_profile(db, pid).await.ok().flatten().and_then(|mp| mp.endpoint)
}

/// The model a project's summary should be generated with: its configured
/// profile's model, else the workspace default.
async fn resolve_project_model(db: &Db, p: &Project, default_model: &str) -> String {
    if let Some(pid) = p.model_profile_id {
        if let Ok(Some(mp)) = ops::get_model_profile(db, pid).await {
            return mp.model;
        }
    }
    default_model.to_string()
}

/// A bounded, neutral snapshot of one project's state — the facts the summarizer
/// (or the deterministic fallback) works from.
struct ProjectContext {
    text: String,
    open: usize,
    due_soon: usize,
    blocked: usize,
    next_event: Option<String>,
}

async fn build_project_context(db: &Db, p: &Project, today: NaiveDate) -> ProjectContext {
    let horizon = today + Duration::days(HORIZON_DAYS);
    let mut tasks = ops::get_tasks(db, p.id, Some(false)).await.unwrap_or_default();
    // Most-recently-touched first, so the bounded slices below favor live work.
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    let (mut open, mut due_soon, mut blocked) = (0usize, 0usize, 0usize);
    let (mut open_lines, mut due_lines, mut done_lines) = (Vec::new(), Vec::new(), Vec::new());
    for t in &tasks {
        let is_done = t.status.eq_ignore_ascii_case("done");
        if t.status.eq_ignore_ascii_case("blocked") {
            blocked += 1;
        }
        if !is_done {
            open += 1;
            if let Some(dl) = t.deadline {
                let dld = dl.with_timezone(&Local).date_naive();
                if dld <= horizon {
                    due_soon += 1;
                    if due_lines.len() < 8 {
                        due_lines.push(format!("- DUE {}: {} [{}]", dld.format("%Y-%m-%d"), t.title, t.status));
                    }
                }
            }
            if open_lines.len() < 10 {
                open_lines.push(format!("- {} [{}, {}]", t.title, t.status, t.priority));
            }
        } else if let Some(c) = t.completed_at {
            let cd = c.with_timezone(&Local).date_naive();
            if (today - cd).num_days() <= 3 && done_lines.len() < 6 {
                done_lines.push(format!("- DONE: {}", t.title));
            }
        }
    }

    // Project events within the horizon.
    let evs = ops::get_project_events(db, p.id, Some(false)).await.unwrap_or_default();
    let mut event_lines = Vec::new();
    let mut next_event = None;
    for e in &evs {
        let d = e.event_date.with_timezone(&Local).date_naive();
        if e.done_at.is_some() || d < today || d > horizon {
            continue;
        }
        let when = if e.all_day {
            "all day".to_string()
        } else {
            e.start_time.clone().unwrap_or_default()
        };
        event_lines.push(format!("- {} {}: {}", d.format("%Y-%m-%d"), when, e.title));
        if next_event.is_none() {
            next_event = Some(format!("{} {}", d.format("%Y-%m-%d"), e.title));
        }
    }

    // A few recent comments off the most-recently-touched tasks (bounded N+1).
    let mut comment_lines: Vec<String> = Vec::new();
    for t in tasks.iter().take(6) {
        if comment_lines.len() >= 4 {
            break;
        }
        if let Ok(cs) = ops::get_task_comments(db, t.id).await {
            if let Some(last) = cs.last() {
                let snippet: String = last.content.chars().take(160).collect();
                comment_lines.push(format!("- on \"{}\": {}", t.title, snippet));
            }
        }
    }

    let mut text = format!("Project: {}\n", p.name);
    if let Some(desc) = p.description.as_deref().filter(|d| !d.trim().is_empty()) {
        let snippet: String = desc.chars().take(200).collect();
        text.push_str(&format!("Description: {snippet}\n"));
    }
    text.push_str(&format!(
        "Open tasks: {open} (due within {HORIZON_DAYS} days: {due_soon}, blocked: {blocked})\n"
    ));
    let section = |title: &str, lines: &[String]| {
        if lines.is_empty() {
            String::new()
        } else {
            format!("\n{title}:\n{}\n", lines.join("\n"))
        }
    };
    text.push_str(&section("Due soon", &due_lines));
    text.push_str(&section("Open tasks", &open_lines));
    text.push_str(&section("Recently completed", &done_lines));
    text.push_str(&section("Upcoming events", &event_lines));
    text.push_str(&section("Recent comments", &comment_lines));

    ProjectContext { text, open, due_soon, blocked, next_event }
}

/// Summarize one project. Returns the model's JSON-parsed summary+flags, or a
/// deterministic count-based summary if the model is unavailable or misbehaves.
async fn summarize_project(
    client: &OllamaClient,
    params: &ChatParams,
    prompt: &str,
    ctx: &ProjectContext,
) -> (String, Vec<String>, Usage) {
    let messages = vec![
        json!({ "role": "system", "content": SUMMARIZER_SYSTEM }),
        json!({ "role": "user", "content": format!("Summarize this project's status:\n\n{prompt}") }),
    ];
    let timeout = std::time::Duration::from_secs(PER_PROJECT_TIMEOUT_SECS);
    // A hang, an error, or a parse failure all fall back to the deterministic
    // count summary, so one bad project never stalls or breaks the whole run.
    match tokio::time::timeout(timeout, collect_chat(client, params, messages)).await {
        Ok(Ok((raw, usage))) => {
            let (summary, flags) = parse_summary(&raw).unwrap_or_else(|| (fallback_summary(ctx), default_flags(ctx)));
            (summary, flags, usage)
        }
        _ => (fallback_summary(ctx), default_flags(ctx), Usage::default()),
    }
}

/// Drain a (non-streamed-to-client) chat completion into its full text + usage.
async fn collect_chat(
    client: &OllamaClient,
    params: &ChatParams,
    messages: Vec<Value>,
) -> std::result::Result<(String, Usage), String> {
    let (stream, usage) = client.chat_stream(params, messages).await?;
    futures_util::pin_mut!(stream);
    let mut full = String::new();
    while let Some(item) = stream.next().await {
        full.push_str(&item?);
    }
    let usage = usage.lock().unwrap().unwrap_or_default();
    Ok((full, usage))
}

/// Pull the `{summary, flags}` object out of the model's reply, tolerant of
/// surrounding prose (some models wrap JSON in commentary or code fences).
fn parse_summary(raw: &str) -> Option<(String, Vec<String>)> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end < start {
        return None;
    }
    let v: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let summary = v
        .get("summary")
        .and_then(|s| s.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let flags = v
        .get("flags")
        .and_then(|f| f.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Some((summary, flags))
}

fn fallback_summary(ctx: &ProjectContext) -> String {
    let mut parts = vec![format!("{} open task{}", ctx.open, if ctx.open == 1 { "" } else { "s" })];
    if ctx.due_soon > 0 {
        parts.push(format!("{} due within {HORIZON_DAYS} days", ctx.due_soon));
    }
    if ctx.blocked > 0 {
        parts.push(format!("{} blocked", ctx.blocked));
    }
    let mut s = parts.join(", ");
    if let Some(ne) = &ctx.next_event {
        s.push_str(&format!(". Next event: {ne}"));
    }
    s.push('.');
    s
}

fn default_flags(ctx: &ProjectContext) -> Vec<String> {
    let mut f = Vec::new();
    if ctx.due_soon > 0 {
        f.push("due_soon".to_string());
    }
    if ctx.blocked > 0 {
        f.push("blocked".to_string());
    }
    if f.is_empty() {
        f.push("on_track".to_string());
    }
    f
}

// --------------------------------------------------------------------------- //
// Secretary tools: a SMALL, hand-picked set so "add an event for task X"
// takes one sentence instead of five minutes of clicking. The seam is
// non-negotiable (field, 2026-07-25): the machine does the LEGWORK — finding
// the task, parsing the date, drafting the event — and the user DECIDES.
// create_event therefore files a PROPOSAL through the same gate as every
// other agent write; nothing lands until Approve in the notifications.
// --------------------------------------------------------------------------- //

/// Ollama function-calling definitions for the secretary's loop.
pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({ "type": "function", "function": {
            "name": "find_tasks",
            "description": "Search the user's live tasks by keywords (any word can match; best matches first). ALWAYS use this before create_event when the user's request relates to work they track, to get the task_id. Returns id, title, status and project for up to 10 matches.",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "keywords from the user's request, e.g. 'washing machine'" }
            }, "required": ["query"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "find_projects",
            "description": "List the user's active projects (id + name). Use this to resolve a project the user names (e.g. 'Moving Out of London') before create_task.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }}),
        json!({ "type": "function", "function": {
            "name": "create_task",
            "description": "PROPOSE a new task in a project — NOT created until the user approves it in their notifications. Resolve the project with find_projects first. Put any drafted content (an email draft, notes) in description.",
            "parameters": { "type": "object", "properties": {
                "project_id": { "type": "integer", "description": "from find_projects" },
                "title": { "type": "string" },
                "description": { "type": "string", "description": "full details; drafted text goes here — ONLY parameter content is saved, text in your reply is not" },
                "priority": { "type": "string", "enum": ["Low", "Medium", "High", "Urgent"] }
            }, "required": ["project_id", "title"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "update_task",
            "description": "PROPOSE changes to an EXISTING task (find it with find_tasks first) — not applied until the user approves. Use this to add drafted content to a task's description. description REPLACES the whole text: include everything that should remain. ONLY parameter content is saved — drafted text in your chat reply is NOT saved anywhere; if the user asked for a draft, it MUST be inside the description parameter of this call.",
            "parameters": { "type": "object", "properties": {
                "task_id": { "type": "integer", "description": "from find_tasks" },
                "title": { "type": "string" },
                "description": { "type": "string", "description": "the COMPLETE new description (drafts included)" },
                "status": { "type": "string", "enum": ["To Do", "In Progress", "Blocked", "Done"] },
                "priority": { "type": "string", "enum": ["Low", "Medium", "High", "Urgent"] }
            }, "required": ["task_id"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "create_event",
            "description": "PROPOSE a calendar event — it is NOT created until the user approves it in their notifications. Pass task_id (from find_tasks) to associate it with a task; the proposal then belongs to that task's project. Dates/times are the user's local time; include the time of day whenever the user gave one.",
            "parameters": { "type": "object", "properties": {
                "title": { "type": "string" },
                "event_date": { "type": "string", "description": "local datetime 'YYYY-MM-DDTHH:MM:SS' (or 'YYYY-MM-DD' for all-day)" },
                "all_day": { "type": "boolean" },
                "description": { "type": "string" },
                "task_id": { "type": "integer", "description": "the task this event belongs to (from find_tasks)" }
            }, "required": ["title", "event_date"] }
        }}),
    ]
}

/// Parse the model's local-time string into UTC (lenient: RFC3339, seconds
/// optional, bare date). Rejecting instead of guessing wrong is the rule.
fn parse_event_date(raw: &str) -> Option<chrono::DateTime<Utc>> {
    let s = raw.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
        .ok()
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(9, 0, 0)))?;
    Local.from_local_datetime(&naive).single().map(|dt| dt.with_timezone(&Utc))
}

/// Execute one secretary tool call. Always returns a string for the tool
/// message — errors are reported to the model so it can tell the user.
pub async fn execute_tool(db: &Db, user_id: i64, name: &str, args: &Value) -> String {
    match name {
        "find_tasks" => {
            let q = args["query"].as_str().unwrap_or("").trim().to_lowercase();
            if q.is_empty() {
                return json!({ "error": "query is required" }).to_string();
            }
            // Word-based: "washing machine" must find "Move Washing Machine"
            // even when other words differ. Any word matches; rank by hits.
            let words: Vec<String> = q.split_whitespace().map(str::to_string).collect();
            let clause = words.iter().map(|_| "lower(t.title) LIKE ?").collect::<Vec<_>>().join(" OR ");
            let sql = format!(
                "SELECT t.id, t.title, t.status, p.name FROM tasks t JOIN projects p ON p.id = t.project_id \
                 WHERE t.archived = 0 AND ({clause}) ORDER BY t.updated_at DESC LIMIT 30"
            );
            let mut query = sqlx::query_as::<_, (i64, String, String, String)>(&sql);
            for w in &words {
                query = query.bind(format!("%{w}%"));
            }
            let mut rows = query.fetch_all(db).await.unwrap_or_default();
            rows.sort_by_key(|(_, title, _, _)| {
                let t = title.to_lowercase();
                std::cmp::Reverse(words.iter().filter(|w| t.contains(w.as_str())).count())
            });
            rows.truncate(10);
            if rows.is_empty() {
                return json!({ "matches": [], "note": "no live tasks match — ask the user to clarify or propose the event without a task" }).to_string();
            }
            json!({ "matches": rows.into_iter().map(|(id, title, status, project)| json!({
                "task_id": id, "title": title, "status": status, "project": project
            })).collect::<Vec<_>>() }).to_string()
        }
        "find_projects" => {
            let rows: Vec<(i64, String)> = sqlx::query_as(
                "SELECT id, name FROM projects WHERE archived = 0 ORDER BY updated_at DESC",
            )
            .fetch_all(db)
            .await
            .unwrap_or_default();
            json!({ "projects": rows.into_iter().map(|(id, name)| json!({ "project_id": id, "name": name })).collect::<Vec<_>>() }).to_string()
        }
        "create_task" => {
            let Some(project_id) = args["project_id"].as_i64() else {
                return json!({ "error": "project_id is required — call find_projects first" }).to_string();
            };
            let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ? AND archived = 0")
                .bind(project_id)
                .fetch_optional(db)
                .await
                .ok()
                .flatten();
            if exists.is_none() {
                return json!({ "error": format!("project {project_id} does not exist — call find_projects first") }).to_string();
            }
            // Same gate as everyone: prepare_write validates and shapes it,
            // then it parks as a proposal until the user approves.
            let mut pw_args = json!({ "title": args["title"] });
            if let Some(d) = args["description"].as_str().filter(|d| !d.trim().is_empty()) {
                pw_args["description"] = json!(d);
            }
            if let Some(p) = args["priority"].as_str().filter(|p| !p.trim().is_empty()) {
                pw_args["priority"] = json!(p);
            }
            let pw = match crate::tools::prepare_write(db, user_id, project_id, "create_task", &pw_args).await {
                Ok(pw) => pw,
                Err(e) => return json!({ "error": e }).to_string(),
            };
            match ganban_core::proposals::register(db, project_id, user_id, None, 0, pw.command, &pw.args, &pw.summary, &pw.details, Some("agent")).await {
                Ok(id) => json!({
                    "proposed": true,
                    "proposal_id": id,
                    "summary": pw.summary,
                    "note": "NOT created yet — awaiting the user's Approve/Decline in their notifications. Relay the task title and project, and where to approve."
                }).to_string(),
                Err(e) => json!({ "error": format!("could not file the proposal: {e}") }).to_string(),
            }
        }
        "update_task" => {
            let Some(task_id) = args["task_id"].as_i64() else {
                return json!({ "error": "task_id is required — call find_tasks first" }).to_string();
            };
            let project_id: Option<i64> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ? AND archived = 0")
                .bind(task_id)
                .fetch_optional(db)
                .await
                .ok()
                .flatten();
            let Some(project_id) = project_id else {
                return json!({ "error": format!("task {task_id} does not exist (or is archived) — use find_tasks first") }).to_string();
            };
            // prepare_write does the diffing (before/after per touched field)
            // and the validation — the proposal card shows exactly what
            // changes, which is the whole point of the seam.
            let mut pw_args = json!({ "task_id": task_id });
            for key in ["title", "description", "status", "priority"] {
                if let Some(v) = args[key].as_str().filter(|v| !v.trim().is_empty()) {
                    pw_args[key] = json!(v);
                }
            }
            let fields: Vec<&str> = ["title", "description", "status", "priority"]
                .into_iter()
                .filter(|k| pw_args.get(*k).is_some())
                .collect();
            let pw = match crate::tools::prepare_write(db, user_id, project_id, "update_task", &pw_args).await {
                Ok(pw) => pw,
                Err(e) => return json!({ "error": e }).to_string(),
            };
            match ganban_core::proposals::register(db, project_id, user_id, None, 0, pw.command, &pw.args, &pw.summary, &pw.details, Some("agent")).await {
                Ok(id) => json!({
                    "proposed": true,
                    "proposal_id": id,
                    "summary": pw.summary,
                    // The model verifies its own call here: a draft the user
                    // asked for that is NOT in this list never left its reply
                    // text (field: approved update, empty description).
                    "fields_in_proposal": fields,
                    "note": "NOT applied yet — awaiting the user's Approve/Decline. Check fields_in_proposal: if the user asked for content (a draft) and 'description' is missing, you FORGOT to pass it — call update_task again with the description parameter filled."
                }).to_string(),
                Err(e) => json!({ "error": format!("could not file the proposal: {e}") }).to_string(),
            }
        }
        "create_event" => {
            let Some(title) = args["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) else {
                return json!({ "error": "title is required" }).to_string();
            };
            let Some(raw_date) = args["event_date"].as_str() else {
                return json!({ "error": "event_date is required" }).to_string();
            };
            let Some(event_date) = parse_event_date(raw_date) else {
                return json!({ "error": format!("could not parse event_date '{raw_date}' — use YYYY-MM-DDTHH:MM:SS local time") }).to_string();
            };
            let all_day = args["all_day"].as_bool().unwrap_or(false);
            // Verify the task anchor BEFORE filing anything — a proposal that
            // can't apply is a lie with a delay.
            let task_id = args["task_id"].as_i64();
            let anchor: Option<(String, i64, String)> = match task_id {
                Some(tid) => {
                    let row: Option<(String, i64, String)> = sqlx::query_as(
                        "SELECT t.title, p.id, p.name FROM tasks t JOIN projects p ON p.id = t.project_id \
                         WHERE t.id = ? AND t.archived = 0",
                    )
                    .bind(tid)
                    .fetch_optional(db)
                    .await
                    .ok()
                    .flatten();
                    match row {
                        Some(r) => Some(r),
                        None => return json!({ "error": format!("task {tid} does not exist (or is archived) — use find_tasks first") }).to_string(),
                    }
                }
                None => None,
            };
            // Proposals are project-scoped: a task anchor supplies the
            // project; without one, fall back to the most recently active
            // project so the gate still has a home for the card.
            let project_id: i64 = match &anchor {
                Some((_, pid, _)) => *pid,
                None => {
                    match sqlx::query_scalar::<_, i64>("SELECT id FROM projects WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1")
                        .fetch_optional(db)
                        .await
                        .ok()
                        .flatten()
                    {
                        Some(pid) => pid,
                        None => return json!({ "error": "no projects exist yet — the user must create one first" }).to_string(),
                    }
                }
            };
            // The UI reads the time of day from start_time — an event without
            // it renders timeless (the field bug this rework fixes).
            let local = event_date.with_timezone(&Local);
            let start_time = (!all_day).then(|| local.format("%H:%M").to_string());
            let input = json!({
                "title": title,
                "description": args["description"].as_str(),
                "location": null,
                "event_date": event_date.to_rfc3339(),
                "start_time": start_time,
                "end_time": null,
                "all_day": all_day,
                "reminder_minutes": null,
                "notification_enabled": true,
            });
            let when = if all_day {
                local.format("%a %d %b %Y (all day)").to_string()
            } else {
                local.format("%a %d %b %Y, %H:%M").to_string()
            };
            let summary = match &anchor {
                Some((task_title, _, project_name)) => {
                    format!("Create event “{title}” — {when} · linked to task “{task_title}” ({project_name})")
                }
                None => format!("Create event “{title}” — {when} (no task link)"),
            };
            let mut prop_args = json!({ "input": input });
            if let Some(tid) = task_id {
                prop_args["taskId"] = json!(tid);
                // The task's parent project rides along — approval links the
                // event to BOTH, so calendar project filters see it (field:
                // "it didn't link the parent project of the task").
                prop_args["projectId"] = json!(project_id);
            }
            let details = json!({ "after": prop_args });
            match ganban_core::proposals::register(db, project_id, user_id, None, 0, "create_event", &prop_args, &summary, &details, Some("agent")).await {
                Ok(id) => json!({
                    "proposed": true,
                    "proposal_id": id,
                    "summary": summary,
                    "note": "NOT created yet — awaiting the user's Approve/Decline in their notifications. Relay the exact details (task, project, name, date, time) and where to approve."
                }).to_string(),
                Err(e) => json!({ "error": format!("could not file the proposal: {e}") }).to_string(),
            }
        }
        other => json!({ "error": format!("unknown tool '{other}'") }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The secretary's hands honor THE SEAM: it does the legwork (find the
    /// task, parse the date, draft the event) but only FILES A PROPOSAL —
    /// nothing exists until approval applies it. Approval lands event + task
    /// link + a display time in one go.
    #[tokio::test]
    async fn secretary_tools_create_linked_event() {
        let path = std::env::temp_dir().join(format!("ganban_sec_tools_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        ganban_core::auth::ensure_owner(&db).await.unwrap(); // the Secretary is the owner's
        let p = ops::create_project(&db, ganban_core::models::CreateProjectInput { name: "Visa".into(), description: None })
            .await
            .unwrap();
        let t = ops::create_task(&db, ganban_core::models::CreateTaskInput {
            project_id: p.id,
            area_id: None,
            title: "Book biometrics appointment".into(),
            description: None,
            status: "To Do".into(),
            priority: "Medium".into(),
            prefix: None,
            cost: None,
            currency: None,
            deadline: None,
        })
        .await
        .unwrap();

        // find_tasks: word-based — "washing biometrics" still ranks it first.
        let found = execute_tool(&db, 1, "find_tasks", &json!({ "query": "biometrics appointment" })).await;
        assert!(found.contains("Book biometrics appointment") && found.contains(&t.id.to_string()), "{found}");

        // Bogus task id: refused, nothing filed.
        let bad = execute_tool(&db, 1, "create_event", &json!({ "title": "X", "event_date": "2027-01-05T10:00:00", "task_id": 99999 })).await;
        assert!(bad.contains("does not exist"), "{bad}");

        // Real request: a PROPOSAL is filed; the calendar stays untouched.
        let ok = execute_tool(&db, 1, "create_event", &json!({
            "title": "Biometrics", "event_date": "2027-01-05T09:00:00", "task_id": t.id
        })).await;
        assert!(ok.contains("proposal_id") && ok.contains("NOT created yet"), "{ok}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events").fetch_one(&db).await.unwrap();
        assert_eq!(n, 0, "the seam: nothing exists before approval");
        let summary: String = sqlx::query_scalar("SELECT summary FROM proposals ORDER BY id DESC LIMIT 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(summary.contains("Biometrics") && summary.contains("09:00") && summary.contains("Book biometrics appointment"), "preview must carry name, time and task: {summary}");

        // Approval applies event + task link + display time in ONE go.
        let pid: i64 = sqlx::query_scalar("SELECT id FROM proposals ORDER BY id DESC LIMIT 1").fetch_one(&db).await.unwrap();
        let pending = ganban_core::proposals::take(&db, pid).await.unwrap().unwrap();
        let root = std::env::temp_dir();
        crate::tools::apply_write(&db, &root, &pending.command, &pending.args).await.unwrap();
        let (linked, start_time): (i64, Option<String>) = (
            sqlx::query_scalar("SELECT COUNT(*) FROM event_tasks WHERE task_id = ?").bind(t.id).fetch_one(&db).await.unwrap(),
            sqlx::query_scalar("SELECT start_time FROM events ORDER BY id DESC LIMIT 1").fetch_one(&db).await.unwrap(),
        );
        assert_eq!(linked, 1, "approval must land the task link too");
        assert_eq!(start_time.as_deref(), Some("09:00"), "the UI reads time-of-day from start_time");
        let proj_linked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_projects WHERE project_id = ?")
            .bind(p.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(proj_linked, 1, "the task's parent project must be linked too");

        // Date parsing rejects garbage rather than guessing.
        let garbage = execute_tool(&db, 1, "create_event", &json!({ "title": "X", "event_date": "next tuesday" })).await;
        assert!(garbage.contains("could not parse"), "{garbage}");

        // create_task: resolve the project, file the proposal (drafted email
        // in the description), NOTHING created until approval — then approval
        // lands it (the "create a task in Moving Out of London" field ask).
        let projects = execute_tool(&db, 1, "find_projects", &json!({})).await;
        assert!(projects.contains("\"name\":\"Visa\""), "{projects}");
        let bogus = execute_tool(&db, 1, "create_task", &json!({ "project_id": 9999, "title": "X" })).await;
        assert!(bogus.contains("does not exist"), "{bogus}");
        let proposed = execute_tool(&db, 1, "create_task", &json!({
            "project_id": p.id, "title": "Email Strength Room about remote workouts",
            "description": "Draft: Dear team, I am moving abroad on 17 August…", "priority": "High"
        })).await;
        assert!(proposed.contains("proposal_id") && proposed.contains("NOT created yet"), "{proposed}");
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE title LIKE 'Email Strength Room%'").fetch_one(&db).await.unwrap();
        assert_eq!(before, 0, "the seam holds for tasks too");
        let pid2: i64 = sqlx::query_scalar("SELECT id FROM proposals ORDER BY id DESC LIMIT 1").fetch_one(&db).await.unwrap();
        let pending2 = ganban_core::proposals::take(&db, pid2).await.unwrap().unwrap();
        crate::tools::apply_write(&db, &root, &pending2.command, &pending2.args).await.unwrap();
        let desc: Option<String> = sqlx::query_scalar("SELECT description FROM tasks WHERE title LIKE 'Email Strength Room%'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(desc.unwrap_or_default().contains("Draft: Dear team"), "the drafted email must land in the description");

        // update_task: the second-turn field ask ("have a draft of the email
        // in the description") — amend the EXISTING task through the gate.
        let tid2: i64 = sqlx::query_scalar("SELECT id FROM tasks WHERE title LIKE 'Email Strength Room%'").fetch_one(&db).await.unwrap();
        let upd = execute_tool(&db, 1, "update_task", &json!({
            "task_id": tid2, "description": "Dear Strength Room team, I'm moving abroad on 17 August — full draft v2…"
        })).await;
        assert!(upd.contains("proposal_id") && upd.contains("NOT applied yet"), "{upd}");
        let unchanged: Option<String> = sqlx::query_scalar("SELECT description FROM tasks WHERE id = ?").bind(tid2).fetch_one(&db).await.unwrap();
        assert!(unchanged.unwrap_or_default().contains("Draft: Dear team"), "the seam: unchanged until approval");
        let pid3: i64 = sqlx::query_scalar("SELECT id FROM proposals ORDER BY id DESC LIMIT 1").fetch_one(&db).await.unwrap();
        let pending3 = ganban_core::proposals::take(&db, pid3).await.unwrap().unwrap();
        crate::tools::apply_write(&db, &root, &pending3.command, &pending3.args).await.unwrap();
        let after: Option<String> = sqlx::query_scalar("SELECT description FROM tasks WHERE id = ?").bind(tid2).fetch_one(&db).await.unwrap();
        assert!(after.unwrap_or_default().contains("full draft v2"), "approval applies the amendment");

        // Missing task refused before anything is filed.
        let ghost = execute_tool(&db, 1, "update_task", &json!({ "task_id": 424242, "description": "x" })).await;
        assert!(ghost.contains("does not exist"), "{ghost}");
    }

    #[test]
    fn parses_clean_json() {
        let (s, f) = parse_summary(r#"{"summary":"Two tasks open.","flags":["due_soon"]}"#).unwrap();
        assert_eq!(s, "Two tasks open.");
        assert_eq!(f, vec!["due_soon".to_string()]);
    }

    #[test]
    fn parses_json_wrapped_in_prose() {
        let raw = "Sure! Here is the summary:\n```json\n{\"summary\": \"On track.\", \"flags\": [\"on_track\"]}\n```\nHope that helps.";
        let (s, f) = parse_summary(raw).unwrap();
        assert_eq!(s, "On track.");
        assert_eq!(f, vec!["on_track".to_string()]);
    }

    #[test]
    fn rejects_summaryless_or_empty() {
        assert!(parse_summary("no json here").is_none());
        assert!(parse_summary(r#"{"flags":[]}"#).is_none());
        assert!(parse_summary(r#"{"summary":"   "}"#).is_none());
    }

    #[test]
    fn fallback_reads_the_counts() {
        let ctx = ProjectContext {
            text: String::new(),
            open: 3,
            due_soon: 1,
            blocked: 2,
            next_event: Some("2026-06-11 Standup".into()),
        };
        let s = fallback_summary(&ctx);
        assert!(s.contains("3 open tasks"));
        assert!(s.contains("1 due"));
        assert!(s.contains("2 blocked"));
        assert!(s.contains("Next event: 2026-06-11 Standup"));
        let flags = default_flags(&ctx);
        assert!(flags.contains(&"due_soon".to_string()));
        assert!(flags.contains(&"blocked".to_string()));
    }

    #[test]
    fn on_track_when_no_pressure() {
        let ctx = ProjectContext { text: String::new(), open: 1, due_soon: 0, blocked: 0, next_event: None };
        assert_eq!(default_flags(&ctx), vec!["on_track".to_string()]);
        assert_eq!(fallback_summary(&ctx), "1 open task.");
    }
    /// An event marked past by hand leaves the daily brief, even when it's tomorrow.
    #[tokio::test]
    async fn the_brief_leaves_out_events_marked_past() {
        let path = std::env::temp_dir().join(format!("ganban_sec_done_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        let tomorrow = (Local::now() + Duration::days(1)).with_timezone(&chrono::Utc);
        let make = |title: &str| ganban_core::models::CreateEventInput {
            title: title.into(),
            description: None,
            location: None,
            event_date: tomorrow,
            start_time: None,
            end_time: None,
            all_day: true,
            reminder_minutes: None,
            notification_enabled: false,
            rrule: None,
            exdates: None,
            series_id: None,
        };
        ops::create_event(&db, make("Kept")).await.unwrap();
        let done = ops::create_event(&db, make("Done early")).await.unwrap();
        ops::set_event_done(&db, done.id, true).await.unwrap();
        let titles: Vec<String> = build_brief(&db).await.unwrap().events.into_iter().map(|e| e.title).collect();
        assert_eq!(titles, vec!["Kept".to_string()]);
    }
}
