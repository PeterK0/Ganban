//! The agent **tool layer** (Phase 1: read-only).
//!
//! A thin registry that exposes a small, project-scoped set of *read* commands to
//! the model as callable tools inside `/chat`, plus the loop that runs them. The
//! doctrine (see the orchestrator guide) holds: the model only ever *requests* a
//! call — our code validates the args, **forces the scope to the chat's project**
//! (a tool can never widen the caller's reach), dispatches into the existing
//! `/invoke` command (`crate::dispatch`, never reimplemented domain logic), caps
//! the rounds, and treats every tool result as untrusted text (capped/collapsed).
//!
//! No write-class tool is registered here. Write tools (create/update/delete) are
//! Phase 2 and are gated (propose → approve → execute); the CRUD round-trip tests
//! at the bottom prove those commands are correct *before* they're ever exposed.

use ganban_core::models::NewRegistryTool;
use ganban_core::visibility::{self, Viewer};
use ganban_core::{ops, Db};
use serde_json::{json, Value};

use crate::ollama::{ChatParams, OllamaClient};
use crate::rag::{self, RagClient};

/// Bound how many tool rounds a single turn may take. Generous because bulk
/// requests ("link ALL the lectures") legitimately need many rounds — small
/// models emit one call per round — while a model that's done answers without
/// tool calls and exits the loop immediately. Runaway repetition is handled by
/// the within-turn duplicate-write dedupe, not by keeping this small.
pub const MAX_TOOL_ROUNDS: usize = 16;
/// Bound each non-streamed tool round so a stalled Ollama can't hang the turn.
const ROUND_TIMEOUT_SECS: u64 = 30;
/// Cap a tool result's size before feeding it back to the model.
const RESULT_CAP: usize = 4000;

/// The Ollama `tools` array for a project chat. Read-only, project-scoped: the
/// scoped tools take NO project argument (we force it server-side), so the model
/// cannot point them at another project. `search_corpus` is offered only when RAG
/// is enabled. Keep this set tiny — it's the biggest lever on tool-use accuracy.
pub fn ollama_tools(rag_enabled: bool, atlas_enabled: bool) -> Vec<Value> {
    let mut tools = vec![
        tool_def(
            "get_tasks",
            "List the tasks in the current project (id, title, status, priority, deadline). Use this for questions about what work exists, its status, or what's due.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool_def(
            "get_project_events",
            "List the events linked to the current project (meetings, deadlines). Use this for scheduling questions.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool_def(
            "get_task_comments",
            "Read the comments/discussion on one task in the current project.",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "integer", "description": "The id of a task in this project." } },
                "required": ["task_id"]
            }),
        ),
        tool_def(
            "get_unlinked_events",
            "List upcoming events not linked to ANY project yet (e.g. imported from a calendar feed) — id, title, date. Use this to find events that belong to the current project before proposing links.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
    ];
    if atlas_enabled {
        tools.push(tool_def(
            "ask_atlas",
            "Ask the workspace's shared Atlas knowledge base (reference collections: countries, vessels, companies…) a question. A librarian model researches across collections and returns a short cited digest. Use for general/world knowledge the project's own corpus won't have.",
            json!({
                "type": "object",
                "properties": { "question": { "type": "string", "description": "The question to research." } },
                "required": ["question"]
            }),
        ));
    }
    if rag_enabled {
        tools.push(tool_def(
            "search_corpus",
            "Semantic search over this project's knowledge base (task text, comments, shared files). Use for fuzzy 'what do we know about X' questions.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to search for." },
                    "filters": { "type": "object", "description": "Optional facet filters as {role: value}, e.g. {\"format\": \"pdf\"}. Omit unless the user asked to narrow by document type." }
                },
                "required": ["query"]
            }),
        ));
    }
    tools
}

fn tool_def(name: &str, description: &str, parameters: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}

/// Execute one tool call, scoped to `project_id`. Returns the result as a string
/// to hand back to the model, or a human-readable error (which the loop also
/// hands back, so the model can recover). Read-only — unknown/write names error.
pub async fn execute_tool(
    db: &Db,
    rag: Option<&RagClient>,
    project_id: i64,
    name: &str,
    args: &Value,
    viewer: Viewer,
) -> Result<String, String> {
    match name {
        // Scope forced server-side: the model gets no say in which project.
        "get_tasks" => {
            let v = dispatch_read(db, viewer, "get_tasks", json!({ "projectId": project_id, "archived": false })).await?;
            Ok(cap(v.to_string()))
        }
        "get_project_events" => {
            let v = dispatch_read(db, viewer, "get_project_events", json!({ "projectId": project_id, "archived": false })).await?;
            Ok(cap(v.to_string()))
        }
        "get_task_comments" => {
            let task_id = args
                .get("task_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| "task_id (integer) is required".to_string())?;
            // Scope check: the task must belong to THIS project (no widening).
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let v = dispatch_read(db, viewer, "get_task_comments", json!({ "taskId": task_id })).await?;
            Ok(cap(v.to_string()))
        }
        "search_corpus" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "query (string) is required".to_string())?;
            // Optional facet filters: keep only the flat {role: "value"} shape
            // ragrat understands; anything else from the model is dropped.
            let filters = args.get("filters").and_then(Value::as_object).map(|m| {
                Value::Object(m.iter().filter(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect())
            });
            let rc = rag.ok_or_else(|| "knowledge-base search is not enabled on this host".to_string())?;
            if !rag::ai_files_enabled(db, project_id).await {
                return Ok("AI access to this project's files is disabled (Project Settings).".into());
            }
            let mut hits = rc.search(&rag::collection_name(project_id), query, 6, filters).await?;
            rag::retain_visible_hits(db, viewer, project_id, &mut hits).await?;
            let text: String = hits
                .iter()
                .filter_map(|h| h.get("text").and_then(|t| t.as_str()))
                .map(|t| {
                    let one_line = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    let capped: String = one_line.chars().take(300).collect();
                    format!("- {capped}\n")
                })
                .collect();
            Ok(if text.is_empty() { "(no relevant results)".to_string() } else { cap(text) })
        }
        "get_unlinked_events" => {
            // Events are host-global by design (the calendar is shared); only
            // the LINKS are project-scoped, and those are gated writes.
            let rows: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT e.id, e.title, e.event_date FROM events e \
                 WHERE e.archived = 0 AND e.done_at IS NULL AND e.event_date >= datetime('now', '-1 day') \
                 AND NOT EXISTS (SELECT 1 FROM event_projects ep WHERE ep.event_id = e.id) \
                 ORDER BY e.event_date LIMIT 100",
            )
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            if rows.is_empty() {
                return Ok("(no unlinked upcoming events)".to_string());
            }
            let v: Vec<Value> =
                rows.into_iter().map(|(id, title, date)| json!({ "id": id, "title": title, "date": date })).collect();
            Ok(cap(Value::Array(v).to_string()))
        }
        // Finance reads run only through `finance_tools::execute`, which checks their gate (the
        // caller's own Personal chat on a local engine). Any other path refuses them.
        other if crate::finance_tools::is_finance_tool(other) => {
            Err("finance tools are only available in your Personal chats on a local model".into())
        }
        // Tab-contributed reads (enablement re-checked inside; capped like ours).
        other if crate::tabs::is_tab_read_tool(other) => {
            crate::tabs::execute_read(db, project_id, other, args).await.map(cap)
        }
        // Declarative registry tools (ops/rag/mcp, scope-forced); None = truly unknown.
        other => match execute_registry_tool(db, rag, project_id, other, args, viewer).await {
            Some(result) => result,
            None => Err(format!("unknown or unavailable tool: {other}")),
        },
    }
}

// --------------------------------------------------------------------------- //
// Phase 2: write tools. The model may PROPOSE these; nothing is ever executed
// here — `prepare_write` only validates + normalizes a call into a runnable
// command. The actual write happens elsewhere, on explicit user approval.
// --------------------------------------------------------------------------- //

/// The write tools the model may propose (kept tight + clearly project-scoped:
/// task management + commenting). Every call is gated behind user approval.
pub fn ollama_write_tools() -> Vec<Value> {
    vec![
        tool_def(
            "create_task",
            "Propose creating a new task in the current project. The user must approve before it is created.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "status": { "type": "string", "description": "To Do | In Progress | Blocked | Done (default To Do)" },
                    "priority": { "type": "string", "description": "Low | Medium | High (default Medium)" },
                    "description": { "type": "string" }
                },
                "required": ["title"]
            }),
        ),
        tool_def(
            "update_task",
            "Propose changing a task in the current project (title/status/priority/description). Requires user approval.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "integer" },
                    "title": { "type": "string" },
                    "status": { "type": "string" },
                    "priority": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["task_id"]
            }),
        ),
        tool_def(
            "delete_task",
            "Propose deleting (archiving) a task in the current project. Requires user approval.",
            json!({ "type": "object", "properties": { "task_id": { "type": "integer" } }, "required": ["task_id"] }),
        ),
        tool_def(
            "link_event_to_project",
            "Propose linking an event (e.g. an imported calendar event from get_unlinked_events) to the current project. Requires user approval.",
            json!({ "type": "object", "properties": { "event_id": { "type": "integer" } }, "required": ["event_id"] }),
        ),
        tool_def(
            "link_event_to_task",
            "Propose linking an event to one of the current project's tasks. Requires user approval.",
            json!({
                "type": "object",
                "properties": { "event_id": { "type": "integer" }, "task_id": { "type": "integer" } },
                "required": ["event_id", "task_id"]
            }),
        ),
        tool_def(
            "delete_event",
            "Propose deleting (archiving) an event — e.g. unneeded imported calendar entries. Only events linked to the current project, or linked to no project at all, can be deleted. Requires user approval.",
            json!({ "type": "object", "properties": { "event_id": { "type": "integer" } }, "required": ["event_id"] }),
        ),
        tool_def(
            "unlink_event_from_project",
            "Propose removing an event's link to the current project (the event itself survives). Requires user approval.",
            json!({ "type": "object", "properties": { "event_id": { "type": "integer" } }, "required": ["event_id"] }),
        ),
        tool_def(
            "create_comment",
            "Propose adding a comment to a task in the current project. Requires user approval.",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "integer" }, "content": { "type": "string" } },
                "required": ["task_id", "content"]
            }),
        ),
        tool_def(
            "assign_task",
            "Propose assigning a task to a project member (user_id from the project's member overview). Requires user approval.",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "integer" }, "user_id": { "type": "integer" } },
                "required": ["task_id", "user_id"]
            }),
        ),
        tool_def(
            "unassign_task",
            "Propose removing a member's assignment from a task. Requires user approval.",
            json!({
                "type": "object",
                "properties": { "task_id": { "type": "integer" }, "user_id": { "type": "integer" } },
                "required": ["task_id", "user_id"]
            }),
        ),
    ]
}

/// Whether `name` is a write-class tool (gated — never auto-executed). Tab
/// bundles' writes count: they ride the same propose → approve → execute gate.
pub fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "create_task"
            | "create_event"
            | "update_task"
            | "delete_task"
            | "create_comment"
            | "assign_task"
            | "unassign_task"
            | "link_event_to_project"
            | "link_event_to_task"
            | "delete_event"
            | "unlink_event_from_project"
    ) || crate::tabs::is_tab_write_tool(name)
}

// --------------------------------------------------------------------------- //
// Tool catalog (introspection): a read-only mirror of what `chat_handler`
// assembles, so the owner can SEE every agent tool this build offers — name,
// shape, trust class, source — instead of reading Rust. Lists definitions;
// executes nothing.
// --------------------------------------------------------------------------- //

/// One agent tool, as shown in the Tools inspector.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    /// JSON-schema of the call arguments.
    pub parameters: Value,
    /// "read" (auto-executes, scope-forced) or "write" (gated proposal).
    pub class: &'static str,
    /// True for writes — they ride propose → approve → execute, never auto-run.
    pub gated: bool,
    /// Where it comes from: "builtin" or "tab:<id>".
    pub source: String,
    /// What must be enabled for the model to actually see it ("rag", "atlas",
    /// or a tab id); None = always available when tools are on.
    pub requires: Option<String>,
}

fn tool_name(def: &Value) -> Option<String> {
    def.get("function").and_then(|f| f.get("name")).and_then(|n| n.as_str()).map(String::from)
}

fn tool_info(def: &Value, class: &'static str, gated: bool, source: String, requires: Option<String>) -> ToolInfo {
    let f = def.get("function");
    ToolInfo {
        name: f.and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("").to_string(),
        description: f.and_then(|f| f.get("description")).and_then(|d| d.as_str()).unwrap_or("").to_string(),
        parameters: f.and_then(|f| f.get("parameters")).cloned().unwrap_or_else(|| json!({})),
        class,
        gated,
        source,
        requires,
    }
}

/// Every agent tool this build can offer, independent of any one project's
/// enablement. `tab_ids` is every available tab (Tier-2 contribute tools).
pub fn tool_catalog(tab_ids: &[String]) -> Vec<ToolInfo> {
    let mut out = Vec::new();

    // Builtin reads. Derive each tool's `requires` by diffing the conditional
    // sets, so the gating stays truthful even as ollama_tools changes.
    let names = |defs: Vec<Value>| -> Vec<String> { defs.iter().filter_map(tool_name).collect() };
    let base = names(ollama_tools(false, false));
    let with_rag = names(ollama_tools(true, false));
    let with_atlas = names(ollama_tools(false, true));
    for def in ollama_tools(true, true) {
        let Some(name) = tool_name(&def) else { continue };
        let requires = if base.contains(&name) {
            None
        } else if with_rag.contains(&name) {
            Some("rag".to_string())
        } else if with_atlas.contains(&name) {
            Some("atlas".to_string())
        } else {
            None
        };
        out.push(tool_info(&def, "read", false, "builtin".into(), requires));
    }

    // Builtin writes (always gated).
    for def in ollama_write_tools() {
        out.push(tool_info(&def, "write", true, "builtin".into(), None));
    }

    // Teamwork (DELEGATE.md decision 3): `delegate` exists in the catalog so
    // a loadout can grant it, but it is OFF by default — the chat loop only
    // offers it when a personality's loadout names it.
    out.push(tool_info(&crate::delegate::delegate_tool_def(), "read", false, "builtin".into(), Some("loadout".into())));

    // Finance reads: offered only in the caller's own Personal chats on a local model.
    for def in crate::finance_tools::tool_defs() {
        out.push(tool_info(&def, "read", false, "builtin".into(), Some("a Personal chat on a local model".into())));
    }

    // Tab tools, attributed to their tab (Tier-1 tabs contribute none).
    for id in tab_ids {
        for def in crate::tabs::tool_defs_for(std::slice::from_ref(id)) {
            let Some(name) = tool_name(&def) else { continue };
            let write = crate::tabs::is_tab_write_tool(&name);
            out.push(tool_info(
                &def,
                if write { "write" } else { "read" },
                write,
                format!("tab:{id}"),
                Some(id.clone()),
            ));
        }
    }

    out
}

// --------------------------------------------------------------------------- //
// Declarative ("registry") tools: tools defined as DATA, bound to a SAFE
// primitive. v1 = an allowlisted read `ops` command, scope-forced to the chat's
// project exactly like the built-in reads. New binding kinds (mcp/rag/http) and
// new allowlisted commands are a compiled change + review — that's the seam
// that keeps "no dynamic code execution" intact while giving data composition.
// --------------------------------------------------------------------------- //

/// Read `ops`/dispatch commands a registry tool may bind to. Every one takes
/// `projectId`, which we FORCE to the chat's project (the model can't widen
/// scope). Extending this list is a deliberate, reviewed Rust change.
pub const REGISTRY_OPS_READ: &[&str] = &["get_tasks", "get_areas", "get_project_events", "get_project_stats"];

/// Is `name` already a built-in (or tab) tool? Registry names must not shadow.
fn is_builtin_tool_name(name: &str) -> bool {
    ollama_tools(true, true)
        .iter()
        .chain(ollama_write_tools().iter())
        .filter_map(tool_name)
        .any(|n| n == name)
        || crate::tabs::is_tab_read_tool(name)
        || crate::finance_tools::is_finance_tool(name)
        || crate::tabs::is_tab_write_tool(name)
}

/// Validate a proposed registry tool before it's stored. Owner-only callers, but
/// still strict: a bad binding here becomes a tool the model can call.
pub fn validate_new_registry_tool(t: &NewRegistryTool) -> Result<(), String> {
    let name = t.name.trim();
    if name.is_empty() {
        return Err("name is required".into());
    }
    // The model calls it as a function — keep it identifier-shaped.
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("name must be letters, digits or underscore (it becomes a function name)".into());
    }
    if is_builtin_tool_name(name) {
        return Err(format!("'{name}' is already a built-in tool name"));
    }
    if let Some(p) = &t.params_json {
        let v: Value = serde_json::from_str(p).map_err(|_| "params_json is not valid JSON".to_string())?;
        if !v.is_object() {
            return Err("params_json must be a JSON object (a JSON-schema)".into());
        }
    }
    if t.class.as_deref().unwrap_or("read") != "read" {
        return Err("only read tools are supported in this version".into());
    }
    let binding: Value = serde_json::from_str(&t.binding_json).map_err(|_| "binding_json is not valid JSON".to_string())?;
    match t.binding_kind.as_str() {
        // ops: an allowlisted read command, scope-forced to the project.
        "ops" => {
            let command = binding.get("command").and_then(Value::as_str).ok_or("binding needs a string 'command'")?;
            if !REGISTRY_OPS_READ.contains(&command) {
                return Err(format!("command '{command}' is not allowed (allowed: {})", REGISTRY_OPS_READ.join(", ")));
            }
            if let Some(a) = binding.get("args") {
                if !a.is_object() {
                    return Err("binding 'args' must be a JSON object".into());
                }
            }
        }
        // rag: a corpus search over the CHAT'S OWN project (scope-forced), with
        // owner-preset limit/filters. The model only supplies `query`.
        "rag" => {
            if let Some(l) = binding.get("limit") {
                if l.as_u64().filter(|n| (1..=50).contains(n)).is_none() {
                    return Err("binding 'limit' must be an integer 1..50".into());
                }
            }
            if let Some(f) = binding.get("filters") {
                if !f.is_object() {
                    return Err("binding 'filters' must be a JSON object".into());
                }
            }
        }
        // mcp: call a tool on a registered MCP provider (ragrat's mounts).
        // OWNER-ONLY in chat (see registry_tool_defs) — it can reach any mounted
        // collection, so it's gated to the owner, who already has full access.
        "mcp" => {
            let mount = binding.get("mount").and_then(Value::as_str).ok_or("mcp binding needs a 'mount' (e.g. /mcp/)")?;
            if !mount.starts_with("/mcp/") {
                return Err("mcp 'mount' must be an MCP path like /mcp/ or /mcp/<collection>/".into());
            }
            binding.get("tool").and_then(Value::as_str).ok_or("mcp binding needs a 'tool' name")?;
            if let Some(a) = binding.get("args") {
                if !a.is_object() {
                    return Err("binding 'args' must be a JSON object".into());
                }
            }
        }
        // http: an outbound call to a FIXED owner-set https endpoint, with
        // templated query/headers and an optional named secret. OWNER-ONLY in
        // chat; the body is untrusted (capped, never authorizes a write).
        "http" => {
            let url = binding.get("url").and_then(Value::as_str).ok_or("http binding needs a 'url'")?;
            let parsed = reqwest::Url::parse(url).map_err(|_| "http 'url' is not a valid URL".to_string())?;
            if parsed.scheme() != "https" {
                return Err("http 'url' must be https".into());
            }
            if parsed.host_str().is_none() {
                return Err("http 'url' has no host".into());
            }
            for key in ["query", "headers"] {
                if let Some(o) = binding.get(key) {
                    let obj = o.as_object().ok_or(format!("http '{key}' must be a JSON object"))?;
                    if obj.values().any(|v| !v.is_string()) {
                        return Err(format!("http '{key}' values must be strings"));
                    }
                }
            }
            if let Some(s) = binding.get("secret_name") {
                if s.as_str().map(|v| v.trim().is_empty()).unwrap_or(true) {
                    return Err("http 'secret_name' must be a non-empty string".into());
                }
            }
            if let Some(sel) = binding.get("select") {
                if !sel.is_object() {
                    return Err("http 'select' must be a JSON object {path, fields, limit}".into());
                }
            }
            if let Some(m) = binding.get("method") {
                if !matches!(m.as_str().map(|s| s.to_ascii_uppercase()).as_deref(), Some("GET") | Some("POST")) {
                    return Err("http 'method' must be GET or POST".into());
                }
            }
            if binding.get("body").map(|b| !b.is_object()).unwrap_or(false) {
                return Err("http 'body' must be a JSON object".into());
            }
        }
        // fetch: GET a MODEL-supplied URL and return its text. OWNER-ONLY; no
        // secrets (the URL is model-controlled). The "get data in" primitive.
        "fetch" => {
            if let Some(e) = binding.get("extract") {
                if !matches!(e.as_str(), Some("text") | Some("raw")) {
                    return Err("fetch 'extract' must be \"text\" or \"raw\"".into());
                }
            }
        }
        _ => return Err("only the 'ops', 'rag', 'mcp', 'http' and 'fetch' bindings are supported in this version".into()),
    }
    Ok(())
}

/// Ollama tool defs for the enabled registry tools — folded into chat alongside
/// the built-ins. `rag_on` drops corpus-search tools when the engine is down
/// (so the model isn't offered a tool that can only error).
pub async fn registry_tool_defs(db: &Db, rag_on: bool, is_owner: bool) -> Vec<Value> {
    ops::enabled_registry_tools(db)
        .await
        .unwrap_or_default()
        .into_iter()
        // A row saved before the finance tools existed can't shadow one of their names.
        .filter(|t| !crate::finance_tools::is_finance_tool(&t.name))
        // rag/mcp need the engine up; mcp + http are owner-only.
        .filter(|t| match t.binding_kind.as_str() {
            "rag" => rag_on,
            "mcp" => rag_on && is_owner,
            "http" | "fetch" => is_owner,
            _ => true,
        })
        .map(|t| {
            let params = serde_json::from_str(&t.params_json).unwrap_or_else(|_| json!({ "type": "object", "properties": {} }));
            tool_def(&t.name, &t.description, params)
        })
        .collect()
}

/// Catalog entries for the enabled registry tools (source "registry:<kind>").
/// The names in `names` that aren't tools this host has: not a built-in or a
/// compiled-in tab's tool, and not a registry tool (enabled or not). A loadout
/// naming one would silently grant nothing, so saving it is refused.
pub async fn unknown_tool_names(db: &Db, names: &[String]) -> Vec<String> {
    let tab_ids: Vec<String> = crate::tabs::available_tabs().iter().map(|t| t.id.to_string()).collect();
    let mut known: std::collections::HashSet<String> = tool_catalog(&tab_ids).into_iter().map(|t| t.name).collect();
    known.extend(ops::list_registry_tools(db).await.unwrap_or_default().into_iter().map(|t| t.name));
    let mut unknown: Vec<String> = names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty() && !known.contains(*n))
        .map(str::to_string)
        .collect();
    unknown.sort();
    unknown.dedup();
    unknown
}

pub async fn registry_tool_infos(db: &Db, is_owner: bool) -> Vec<ToolInfo> {
    ops::enabled_registry_tools(db)
        .await
        .unwrap_or_default()
        .into_iter()
        // Members don't see owner-only mcp/http tools in their catalog.
        .filter(|t| is_owner || !matches!(t.binding_kind.as_str(), "mcp" | "http" | "fetch"))
        .map(|t| {
            let write = t.class == "write";
            let requires = match t.binding_kind.as_str() {
                "rag" => Some("rag".to_string()),
                "mcp" | "http" | "fetch" => Some("owner".to_string()),
                _ => None,
            };
            ToolInfo {
                name: t.name,
                description: t.description,
                parameters: serde_json::from_str(&t.params_json).unwrap_or_else(|_| json!({})),
                class: if write { "write" } else { "read" },
                gated: write,
                source: format!("registry:{}", t.binding_kind),
                requires,
            }
        })
        .collect()
}

/// Execute a registry tool by name. None = not a registry tool (so the caller
/// can fall through to "unknown tool"). Every binding is scope-forced to the
/// chat's project — identical scope to the built-ins.
async fn execute_registry_tool(
    db: &Db,
    rag: Option<&RagClient>,
    project_id: i64,
    name: &str,
    args: &Value,
    viewer: Viewer,
) -> Option<Result<String, String>> {
    let is_owner = viewer.is_owner;
    let tool = ops::get_registry_tool_by_name(db, name).await.ok().flatten()?;
    if !tool.enabled {
        return None;
    }
    let Ok(binding) = serde_json::from_str::<Value>(&tool.binding_json) else {
        return Some(Err(format!("tool '{name}': invalid binding")));
    };
    match tool.binding_kind.as_str() {
        // ops: dispatch the bound read command with projectId FORCED last, so
        // the model can never override the project scope.
        "ops" => {
            let Some(command) = binding.get("command").and_then(Value::as_str) else {
                return Some(Err(format!("tool '{name}': binding has no command")));
            };
            if !REGISTRY_OPS_READ.contains(&command) {
                return Some(Err(format!("tool '{name}': command not allowed")));
            }
            let mut call = serde_json::Map::new();
            if let Some(preset) = binding.get("args").and_then(Value::as_object) {
                call.extend(preset.clone());
            }
            if let Some(a) = args.as_object() {
                call.extend(a.clone());
            }
            call.insert("projectId".to_string(), json!(project_id));
            Some(dispatch_read(db, viewer, command, Value::Object(call)).await.map(|v| cap(v.to_string())))
        }
        // rag: search the CHAT'S OWN project corpus (collection forced server-
        // side); the owner presets limit/filters, the model supplies `query`.
        "rag" => {
            let Some(rc) = rag else {
                return Some(Err("the knowledge engine is not connected".into()));
            };
            let Some(query) = args.get("query").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                return Some(Err("query (string) is required".into()));
            };
            let limit = binding.get("limit").and_then(Value::as_i64).unwrap_or(8).clamp(1, 50);
            let filters = binding.get("filters").cloned();
            match rc.search(&rag::collection_name(project_id), query, limit, filters).await {
                Ok(mut hits) => {
                    if let Err(e) = rag::retain_visible_hits(db, viewer, project_id, &mut hits).await {
                        return Some(Err(format!("search failed: {e}")));
                    }
                    let out: Vec<Value> = hits
                        .iter()
                        .map(|h| {
                            json!({
                                "source": h.get("source").cloned().unwrap_or(Value::Null),
                                "score": h.get("score").cloned().unwrap_or(Value::Null),
                                "text": h.get("text").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect();
                    Some(Ok(cap(Value::Array(out).to_string())))
                }
                Err(e) => Some(Err(format!("search failed: {e}"))),
            }
        }
        // mcp: brokered call to a ragrat MCP tool. Owner-only (defence in depth
        // — also filtered out of a non-owner's tool set at assembly). Owner
        // presets win over model args, so the owner can pin scope (e.g. a
        // collection).
        "mcp" => {
            if !is_owner {
                return Some(Err("this tool is owner-only".into()));
            }
            let Some(rc) = rag else {
                return Some(Err("the knowledge engine is not connected".into()));
            };
            let Some(mount) = binding.get("mount").and_then(Value::as_str) else {
                return Some(Err(format!("tool '{name}': binding has no mount")));
            };
            let Some(mcp_tool) = binding.get("tool").and_then(Value::as_str) else {
                return Some(Err(format!("tool '{name}': binding has no tool")));
            };
            let mut call = serde_json::Map::new();
            if let Some(a) = args.as_object() {
                call.extend(a.clone());
            }
            if let Some(preset) = binding.get("args").and_then(Value::as_object) {
                call.extend(preset.clone());
            }
            Some(rc.mcp_call(mount, mcp_tool, &Value::Object(call)).await.map(cap))
        }
        // http: outbound call to the owner-fixed endpoint. Owner-only; the body
        // comes back untrusted (capped). Secret (if any) is injected server-side.
        "http" => {
            if !is_owner {
                return Some(Err("this tool is owner-only".into()));
            }
            let secret = match binding.get("secret_name").and_then(Value::as_str) {
                Some(n) => match ops::get_connector_secret(db, n).await.ok().flatten() {
                    Some(v) => Some(v),
                    None => return Some(Err(format!("connector secret '{n}' is not set"))),
                },
                None => None,
            };
            Some(http_connector_fetch(&binding, args, secret.as_deref()).await.map(cap))
        }
        // fetch: GET the model's url, return text (owner-only, SSRF-guarded).
        "fetch" => {
            if !is_owner {
                return Some(Err("this tool is owner-only".into()));
            }
            let Some(url) = args.get("url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                return Some(Err("url (string) is required".into()));
            };
            let as_text = binding.get("extract").and_then(Value::as_str) != Some("raw");
            Some(fetch_url(url, as_text).await.map(cap))
        }
        other => Some(Err(format!("tool '{name}': unsupported binding '{other}'"))),
    }
}

/// Refuse private/internal destinations (SSRF). Shared by the http connector
/// and the page fetcher; their clients re-check at connect time.
async fn ssrf_check(url: &reqwest::Url) -> Result<(), String> {
    crate::net_guard::check_url(url).await
}

/// One UTF-8 char's byte length, from its leading byte.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// A dependency-free HTML → readable-text reduction: drop <script>/<style>
/// bodies, strip tags, decode a few entities, collapse whitespace. Good enough
/// to hand a model a page's text instead of raw markup.
fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n / 2);
    let mut i = 0usize;
    while i < n {
        if bytes[i] == b'<' {
            let after = &lower[i + 1..];
            let close = if after.starts_with("script") {
                Some("</script")
            } else if after.starts_with("style") {
                Some("</style")
            } else {
                None
            };
            if let Some(close) = close {
                if let Some(rel) = lower[i..].find(close) {
                    let at = i + rel;
                    if let Some(gt) = html[at..].find('>') {
                        i = at + gt + 1;
                        out.push(' ');
                        continue;
                    }
                }
                break; // unterminated script/style
            }
            match html[i..].find('>') {
                Some(gt) => {
                    i += gt + 1;
                    out.push(' ');
                }
                None => break,
            }
        } else {
            let end = (i + utf8_len(bytes[i])).min(n);
            out.push_str(&html[i..end]);
            i = end;
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Fetch a MODEL-supplied URL (the Oracle "get data in" primitive). http(s)
/// only, SSRF-guarded on EVERY hop (we follow redirects manually + re-check),
/// size-capped. HTML is reduced to text by default. No secrets — the URL is
/// model-controlled, so a secret could be exfiltrated; never inject one here.
/// Owner-gated upstream. Result is untrusted (capped by the caller).
async fn fetch_url(url_in: &str, as_text: bool) -> Result<String, String> {
    let client = crate::net_guard::client_builder(0)
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Ganban/", env!("CARGO_PKG_VERSION"), " (fetch)"))
        .build()
        .map_err(|e| e.to_string())?;
    let mut url = reqwest::Url::parse(url_in.trim()).map_err(|_| "that doesn't look like a valid URL".to_string())?;
    for _hop in 0..5 {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("only http(s) URLs can be fetched".into());
        }
        ssrf_check(&url).await?;
        let resp = client.get(url.clone()).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without a location")?;
            url = url.join(loc).map_err(|_| "bad redirect location".to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("the page returned HTTP {}", status.as_u16()));
        }
        if let Some(len) = resp.content_length() {
            if len > 8_000_000 {
                return Err("the page is too large to fetch".into());
            }
        }
        let is_html = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|c| c.contains("html"))
            .unwrap_or(false);
        let body = resp.text().await.map_err(|e| e.to_string())?;
        let html_like = is_html || body.trim_start().starts_with('<');
        return Ok(if as_text && html_like { html_to_text(&body) } else { body });
    }
    Err("too many redirects".into())
}

/// Recursively substitute templates in a JSON body: every string LEAF is run
/// through `template_value`; structure is preserved, so a model arg is always a
/// JSON value (never injected markup). For POST connector bodies.
fn template_json(v: &Value, args: &Value, secret: Option<&str>) -> Value {
    match v {
        Value::String(s) => Value::String(template_value(s, args, secret)),
        Value::Array(a) => Value::Array(a.iter().map(|x| template_json(x, args, secret)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), template_json(x, args, secret))).collect()),
        other => other.clone(),
    }
}

/// Substitute `{arg}` / `{secret}` placeholders in a connector template value.
fn template_value(tpl: &str, args: &Value, secret: Option<&str>) -> String {
    let mut out = tpl.to_string();
    if let Some(s) = secret {
        out = out.replace("{secret}", s);
    }
    if let Some(obj) = args.as_object() {
        for (k, v) in obj {
            let val = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
            out = out.replace(&format!("{{{k}}}"), &val);
        }
    }
    out
}

/// Fetch an http-connector binding: the owner's FIXED https URL (SSRF-guarded,
/// no redirects), templated query/headers, untrusted body (capped by caller).
async fn http_connector_fetch(binding: &Value, args: &Value, secret: Option<&str>) -> Result<String, String> {
    let url_s = binding.get("url").and_then(Value::as_str).ok_or("binding has no url")?;
    let mut url = reqwest::Url::parse(url_s).map_err(|_| "invalid url".to_string())?;
    if url.scheme() != "https" {
        return Err("connector url must be https".into());
    }
    // SSRF: resolve the host and refuse private/internal addresses.
    ssrf_check(&url).await?;
    // Templated query params (scope the mutable borrow before moving `url`).
    if let Some(q) = binding.get("query").and_then(Value::as_object) {
        let mut qp = url.query_pairs_mut();
        for (k, v) in q {
            if let Some(vs) = v.as_str() {
                qp.append_pair(k, &template_value(vs, args, secret));
            }
        }
    }
    let client = crate::net_guard::client_builder(0)
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none()) // close redirect-SSRF
        .user_agent(concat!("Ganban/", env!("CARGO_PKG_VERSION"), " (connector)"))
        .build()
        .map_err(|e| e.to_string())?;
    // GET (default) or POST with a JSON body (e.g. Firecrawl /scrape). The body
    // is the owner's template; its string LEAVES are substituted after parsing,
    // so a model arg can never inject JSON structure.
    let method = binding.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
    let mut req = if method == "POST" {
        let mut r = client.post(url);
        if let Some(b) = binding.get("body") {
            r = r.json(&template_json(b, args, secret));
        }
        r
    } else {
        client.get(url)
    };
    if let Some(h) = binding.get("headers").and_then(Value::as_object) {
        for (k, v) in h {
            if let Some(vs) = v.as_str() {
                req = req.header(k, template_value(vs, args, secret));
            }
        }
    }
    // The URL can carry the connector's secret ({secret} in a query param), and
    // this error goes back to the model: never quote it.
    let resp = req.send().await.map_err(crate::net_guard::error_text)?;
    if let Some(len) = resp.content_length() {
        if len > 5_000_000 {
            return Err("connector response too large".into());
        }
    }
    if !resp.status().is_success() {
        return Err(format!("connector returned HTTP {}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(crate::net_guard::error_text)?;
    // Optional response shaping: pull an array out of the JSON and keep only the
    // useful fields, so the model gets tidy rows instead of a huge payload.
    // Falls back to the raw body if the response isn't JSON or the path misses.
    match binding.get("select") {
        Some(sel) => match serde_json::from_str::<Value>(&body) {
            Ok(json) => Ok(apply_select(&json, sel)),
            Err(_) => Ok(body),
        },
        None => Ok(body),
    }
}

/// Reshape a JSON response: `{ "path": "a.b", "fields": [..], "limit": n }`.
/// `path` dot-navigates to an array (or value); `fields` projects each item;
/// `limit` caps the count. A missing path returns the raw JSON (so the model
/// still gets something).
fn apply_select(json: &Value, sel: &Value) -> String {
    let path = sel.get("path").and_then(Value::as_str).unwrap_or("");
    let limit = sel.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
    let fields: Vec<&str> = sel
        .get("fields")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let project = |item: &Value| -> Value {
        if fields.is_empty() {
            return item.clone();
        }
        let mut m = serde_json::Map::new();
        for f in &fields {
            if let Some(v) = item.get(*f) {
                m.insert((*f).to_string(), v.clone());
            }
        }
        Value::Object(m)
    };
    let mut node = json;
    for seg in path.split('.').filter(|s| !s.is_empty()) {
        match node.get(seg) {
            Some(n) => node = n,
            None => return json.to_string(),
        }
    }
    match node {
        Value::Array(arr) => Value::Array(arr.iter().take(limit).map(project).collect()).to_string(),
        // A single string (e.g. Firecrawl's data.markdown) comes back as clean
        // text, not a JSON-quoted/escaped blob.
        Value::String(s) if fields.is_empty() => s.clone(),
        other => project(other).to_string(),
    }
}

/// A validated, ready-to-run write derived from a model tool call. Holds the
/// exact `/invoke` command + args it WILL run on approval, a human summary for
/// the approval card, and a before/after snapshot for the inbox diff.
/// Constructing one never mutates the database (reads for the snapshot only).
pub struct PreparedWrite {
    pub command: &'static str,
    pub args: Value,
    pub summary: String,
    /// `{"before": {...}?, "after": {...}?}` — what the write would change, in
    /// the user's terms, so an approval surface can render a real diff.
    pub details: Value,
}

/// Validate + normalize a write tool call into a runnable command, enforcing the
/// project scope server-side (project_id is forced; task_id must be in-project).
/// Returns a human-readable error (fed back to the model) if the call is invalid.
pub async fn prepare_write(
    db: &Db,
    user_id: i64,
    project_id: i64,
    name: &str,
    args: &Value,
) -> Result<PreparedWrite, String> {
    // Tab bundle writes validate in their own module (enablement re-checked
    // there) but return the same PreparedWrite the gate executes.
    if crate::tabs::is_tab_write_tool(name) {
        return crate::tabs::prepare_write(db, user_id, project_id, name, args).await;
    }
    // The proposer can only touch tasks they can see (task visibility).
    let viewer = viewer_for(db, user_id).await;
    match name {
        "create_quiz_questions_batch" => {
            // The quiz.generate node's write: a batch of AI-drafted questions
            // into one topic. Every question re-validates HERE (the gate's
            // validator is the authority, not the node that filed the paper).
            // Anchor: topic_id files strays into that topic; subject_id
            // (✨ Automatic) trusts each question's own "topic" name instead.
            let topic_id = arg_i64(args, "topic_id").ok();
            let subject_id = arg_i64(args, "subject_id").ok();
            let owner = match (topic_id, subject_id) {
                (Some(t), _) => ganban_core::quiz::topic_project(db, t).await.map_err(|e| e.to_string())?,
                (None, Some(sub)) => ganban_core::quiz::subject_project(db, sub).await.map_err(|e| e.to_string())?,
                (None, None) => return Err("batch needs a topic_id or subject_id anchor".into()),
            };
            if owner != project_id {
                return Err("that topic is not in this project".into());
            }
            let questions = args["questions"].as_array().ok_or("questions must be an array")?;
            if questions.is_empty() || questions.len() > 25 {
                return Err("a batch is 1–25 questions".into());
            }
            for q in questions {
                let ty = q["questionType"].as_str().ok_or("question missing questionType")?;
                let diff = q["difficulty"].as_str().unwrap_or("MEDIUM");
                let points = q["points"].as_i64().unwrap_or(1);
                if q["questionText"].as_str().map(str::trim).filter(|t| !t.is_empty()).is_none() {
                    return Err("question missing questionText".into());
                }
                ganban_core::quiz::validate_question(ty, diff, points, &q["data"].to_string()).map_err(|e| e.to_string())?;
            }
            let place = if let Some(t) = topic_id {
                let label: Option<(String, String)> = sqlx::query_as(
                    "SELECT s.name, t.name FROM quiz_topics t JOIN quiz_subjects s ON s.id = t.subject_id WHERE t.id = ?",
                )
                .bind(t)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?;
                label.map(|(s, t)| format!("{s} / {t}")).unwrap_or_else(|| format!("topic #{t}"))
            } else {
                let sub = subject_id.expect("anchor checked above");
                let name: Option<(String,)> = sqlx::query_as("SELECT name FROM quiz_subjects WHERE id = ?")
                    .bind(sub)
                    .fetch_optional(db)
                    .await
                    .map_err(|e| e.to_string())?;
                format!("{} (✨ automatic topics)", name.map(|(n,)| n).unwrap_or_else(|| format!("subject #{sub}")))
            };
            // Per-question topics (multi-topic import) surface in the summary
            // so the approver sees the whole shape before saying yes.
            let named: std::collections::BTreeSet<&str> = questions
                .iter()
                .filter_map(|q| q["topic"].as_str().map(str::trim).filter(|t| !t.is_empty()))
                .collect();
            let spread = if named.is_empty() {
                String::new()
            } else {
                format!(" (across topics: {})", named.into_iter().collect::<Vec<_>>().join(", "))
            };
            let details = json!({ "after": args });
            Ok(PreparedWrite {
                command: "create_quiz_questions_batch",
                args: args.clone(),
                summary: format!("Add {} AI-drafted quiz question{} to {place}{spread}", questions.len(), if questions.len() == 1 { "" } else { "s" }),
                details,
            })
        }
        "create_task" => {
            let title = arg_str(args, "title")?;
            let status = arg_opt_str(args, "status").unwrap_or_else(|| "To Do".to_string());
            let priority = arg_opt_str(args, "priority").unwrap_or_else(|| "Medium".to_string());
            let mut input = json!({ "project_id": project_id, "title": title, "status": status, "priority": priority });
            if let Some(d) = arg_opt_str(args, "description") {
                input["description"] = json!(d);
            }
            let details = json!({ "after": input });
            Ok(PreparedWrite { command: "create_task", args: json!({ "input": input }), summary: format!("Create task “{title}” ({status})"), details })
        }
        "update_task" => {
            let task_id = arg_i64(args, "task_id")?;
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let mut input = serde_json::Map::new();
            for key in ["title", "status", "priority", "description"] {
                if let Some(v) = arg_opt_str(args, key) {
                    input.insert(key.to_string(), json!(v));
                }
            }
            if input.is_empty() {
                return Err("nothing to update — provide a title, status, priority, or description".to_string());
            }
            let fields = input.keys().cloned().collect::<Vec<_>>().join(", ");
            // Snapshot only the fields the write would touch, so the diff is signal.
            let before = task_snapshot(db, task_id).await.map(|snap| {
                Value::Object(input.keys().filter_map(|k| snap.get(k.as_str()).map(|v| (k.clone(), v.clone()))).collect())
            });
            let details = json!({ "before": before, "after": Value::Object(input.clone()) });
            let label = task_label(db, task_id).await;
            Ok(PreparedWrite {
                command: "update_task",
                args: json!({ "taskId": task_id, "input": Value::Object(input) }),
                summary: format!("Update task {label} ({fields})"),
                details,
            })
        }
        "delete_task" => {
            let task_id = arg_i64(args, "task_id")?;
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let details = json!({ "before": task_snapshot(db, task_id).await });
            let label = task_label(db, task_id).await;
            Ok(PreparedWrite { command: "delete_task", args: json!({ "taskId": task_id }), summary: format!("Delete (archive) task {label}"), details })
        }
        "link_event_to_project" => {
            let event_id = arg_i64(args, "event_id")?;
            let title = event_title(db, event_id).await.ok_or("that event does not exist")?;
            Ok(PreparedWrite {
                command: "link_event_to_project",
                args: json!({ "eventId": event_id, "projectId": project_id }),
                summary: format!("Link event “{title}” to this project"),
                details: json!({ "after": { "event": title, "linked_to": "this project" } }),
            })
        }
        "link_event_to_task" => {
            let event_id = arg_i64(args, "event_id")?;
            let task_id = arg_i64(args, "task_id")?;
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let title = event_title(db, event_id).await.ok_or("that event does not exist")?;
            Ok(PreparedWrite {
                command: "link_event_to_task",
                args: json!({ "eventId": event_id, "taskId": task_id }),
                summary: format!("Link event “{title}” to task {}", task_label(db, task_id).await),
                details: json!({ "after": { "event": title, "linked_to_task": task_id } }),
            })
        }
        "delete_event" => {
            let event_id = arg_i64(args, "event_id")?;
            let title = event_title(db, event_id).await.ok_or("that event does not exist")?;
            // Scope: this project's events, or orphans (e.g. imported feed
            // clutter). An event another project relies on is out of reach.
            let links = event_project_links(db, event_id).await;
            if !links.is_empty() && !links.contains(&project_id) {
                return Err("that event is linked to another project".to_string());
            }
            Ok(PreparedWrite {
                command: "delete_event",
                args: json!({ "eventId": event_id }),
                summary: format!("Delete (archive) event “{title}”"),
                details: json!({ "before": { "event": title } }),
            })
        }
        "unlink_event_from_project" => {
            let event_id = arg_i64(args, "event_id")?;
            let title = event_title(db, event_id).await.ok_or("that event does not exist")?;
            if !event_project_links(db, event_id).await.contains(&project_id) {
                return Err("that event is not linked to this project".to_string());
            }
            Ok(PreparedWrite {
                command: "unlink_event_from_project",
                args: json!({ "eventId": event_id, "projectId": project_id }),
                summary: format!("Unlink event “{title}” from this project"),
                details: json!({ "before": { "event": title, "linked_to": "this project" } }),
            })
        }
        "create_comment" => {
            let task_id = arg_i64(args, "task_id")?;
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let content = arg_str(args, "content")?;
            // Stamp the author here: the approval path runs the command in-process,
            // where nothing stamps the authorship field, so we set user_id explicitly.
            let input = json!({ "task_id": task_id, "content": content, "user_id": user_id });
            let details = json!({ "after": { "content": content } });
            let label = task_label(db, task_id).await;
            Ok(PreparedWrite { command: "create_comment", args: json!({ "input": input }), summary: format!("Comment on task {label}"), details })
        }
        "assign_task" | "unassign_task" => {
            let task_id = arg_i64(args, "task_id")?;
            ensure_task_in_project(db, task_id, project_id, viewer).await?;
            let target = arg_i64(args, "user_id")?;
            // Resolve the target's name here so the approval card reads like a
            // sentence, and refuse non-members at proposal time (not apply time).
            let target_name: Option<String> =
                sqlx::query_scalar("SELECT full_name FROM users u JOIN project_members pm ON pm.user_id = u.id WHERE u.id = ? AND pm.project_id = ?")
                    .bind(target)
                    .bind(project_id)
                    .fetch_optional(db)
                    .await
                    .map_err(|e| e.to_string())?;
            let target_name = target_name.ok_or("that user is not a member of this project")?;
            // assigned_by is baked in HERE from the authenticated proposer —
            // the gate's executor is context-free and must not trust args.
            let label = task_label(db, task_id).await;
            if name == "assign_task" {
                Ok(PreparedWrite {
                    command: "assign_task",
                    args: json!({ "taskId": task_id, "userId": target, "assignedBy": user_id }),
                    summary: format!("Assign task {label} to {target_name}"),
                    details: json!({ "after": { "assignee": target_name } }),
                })
            } else {
                Ok(PreparedWrite {
                    command: "unassign_task",
                    args: json!({ "taskId": task_id, "userId": target }),
                    summary: format!("Unassign {target_name} from task {label}"),
                    details: json!({ "before": { "assignee": target_name } }),
                })
            }
        }
        other => Err(format!("not a write tool: {other}")),
    }
}

/// “#42” is meaningless to a human — every task-touching summary names the
/// task. Falls back to the bare id if the row vanished mid-flight.
async fn task_label(db: &Db, task_id: i64) -> String {
    let title: Option<String> = sqlx::query_scalar("SELECT title FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    match title {
        Some(t) => format!("“{t}” (#{task_id})"),
        None => format!("#{task_id}"),
    }
}

/// The user-facing fields of a task, for proposal diffs. None if it vanished.
async fn task_snapshot(db: &Db, task_id: i64) -> Option<Value> {
    sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "SELECT title, status, priority, description FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|(title, status, priority, description)| {
        json!({ "title": title, "status": status, "priority": priority, "description": description })
    })
}

/// Run an approved write. Called only after the user confirms (and after the
/// caller re-checks role/scope). Domain commands go through the shared `/invoke`
/// dispatcher; tab commands go through the tab executor (which needs the
/// storage root — tab outputs are project files). Propagates the real AppError
/// so the HTTP layer can map it to the right status (not a blanket 500).
pub async fn apply_write(
    db: &Db,
    root: &std::path::Path,
    command: &str,
    args: &Value,
) -> Result<Value, ganban_core::error::AppError> {
    if crate::tabs::is_tab_write_tool(command) {
        return crate::tabs::apply(db, root, command, args).await;
    }
    crate::dispatch(db, command, args).await
}

/// Re-check a proposal's scope at approval time, against the stored command
/// and args. Scope was checked when the proposal was made, but the write lands
/// later: the task may have moved to another project or out of the proposer's
/// audience, an event may have been linked elsewhere, or the proposer may have
/// left the project. Any of those refuses the write. Mirrors the checks in
/// [`prepare_write`]; tab commands carry their own checks in their executors.
pub async fn recheck_scope(db: &Db, command: &str, args: &Value, project_id: i64, proposer: i64) -> Result<(), String> {
    let viewer = viewer_for(db, proposer).await;
    if !viewer.is_owner {
        let member: Option<i64> = sqlx::query_scalar("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
            .bind(project_id)
            .bind(proposer)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
        if member.is_none() {
            return Err("the proposer is no longer a member of this project".into());
        }
    }
    let task_id = args.get("taskId").and_then(Value::as_i64).or_else(|| args.pointer("/input/task_id").and_then(Value::as_i64));
    if let Some(task_id) = task_id {
        ensure_task_in_project(db, task_id, project_id, viewer).await?;
    }
    if let Some(p) = args.get("projectId").and_then(Value::as_i64).or_else(|| args.pointer("/input/project_id").and_then(Value::as_i64)) {
        if p != project_id {
            return Err("that write targets another project".into());
        }
    }
    match command {
        "delete_event" => {
            let event_id = args.get("eventId").and_then(Value::as_i64).ok_or("malformed proposal")?;
            let links = event_project_links(db, event_id).await;
            if !links.is_empty() && !links.contains(&project_id) {
                return Err("that event is linked to another project".into());
            }
        }
        "unlink_event_from_project" => {
            let event_id = args.get("eventId").and_then(Value::as_i64).ok_or("malformed proposal")?;
            if !event_project_links(db, event_id).await.contains(&project_id) {
                return Err("that event is not linked to this project".into());
            }
        }
        "assign_task" => {
            let target = args.get("userId").and_then(Value::as_i64).ok_or("malformed proposal")?;
            let member: Option<i64> = sqlx::query_scalar("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
                .bind(project_id)
                .bind(target)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?;
            if member.is_none() {
                return Err("that user is not a member of this project".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// A required string arg from a model tool call (trimmed, non-empty).
fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} (non-empty string) is required"))
}
fn arg_opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}
fn arg_i64(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key).and_then(Value::as_i64).ok_or_else(|| format!("{key} (integer) is required"))
}

/// Ok only if `task_id` exists and belongs to `project_id` (scope guard).
/// The task must be in this project and in the viewer's audience (task visibility): a
/// hidden task gets the same answer as another project's.
async fn ensure_task_in_project(db: &Db, task_id: i64, project_id: i64, viewer: Viewer) -> Result<(), String> {
    let in_project = task_project(db, task_id).await == Some(project_id);
    if in_project && visibility::can_see_task(db, viewer, task_id).await.map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err("that task is not in this project".to_string())
    }
}

/// The viewer a user id is (the owner sees every task).
async fn viewer_for(db: &Db, user_id: i64) -> Viewer {
    let is_owner = sqlx::query_scalar::<_, bool>("SELECT is_owner FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or(false);
    Viewer { user_id, is_owner }
}

/// Run the capped agentic tool loop before the final (streamed) answer. Mutates
/// `messages` in place — appending the model's tool-call turns and each tool
/// result — and returns the names of the tools actually executed (for a UI
/// breadcrumb). Best-effort: a failed/timed-out round just ends the loop and lets
/// the model answer with whatever it has gathered.
pub async fn run_tool_loop(
    db: &Db,
    rag: Option<&RagClient>,
    ollama: &OllamaClient,
    params: &ChatParams,
    messages: &mut Vec<Value>,
    tools: &[Value],
    project_id: i64,
    user_id: i64,
    is_owner: bool,
    agent_run: &crate::agent_work::Run,
    runner: &crate::Runner,
) -> (Vec<String>, Vec<PreparedWrite>, crate::ollama::Usage) {
    let mut used = Vec::new();
    let mut proposals: Vec<PreparedWrite> = Vec::new();
    let mut usage = crate::ollama::Usage::default();
    // The turn's own cost (without its delegations') and its delegation rows,
    // for the ledger tree written after the loop.
    let mut own_usage = crate::ollama::Usage::default();
    let mut delegations: Vec<i64> = Vec::new();
    let mut delegated_to: Vec<String> = Vec::new();
    // The same write proposed twice in one turn (small models retry when told
    // "not yet done") must not produce duplicate approval cards.
    let mut seen_writes: std::collections::HashSet<String> = std::collections::HashSet::new();
    let timeout = std::time::Duration::from_secs(ROUND_TIMEOUT_SECS);
    for _ in 0..MAX_TOOL_ROUNDS {
        let turn = match tokio::time::timeout(timeout, ollama.chat_once(params, messages, tools)).await {
            Ok(Ok(t)) => t,
            _ => break, // timeout or transport error → answer with what we have
        };
        usage.add(turn.usage);
        own_usage.add(turn.usage);
        if turn.tool_calls.is_empty() {
            break; // the model is ready to answer
        }
        // Replay the assistant's tool-call turn so the tool results have context.
        let raw_calls: Vec<Value> = turn
            .tool_calls
            .iter()
            .map(|tc| json!({ "function": { "name": tc.name, "arguments": tc.arguments } }))
            .collect();
        messages.push(json!({ "role": "assistant", "content": turn.content, "tool_calls": raw_calls }));
        for tc in &turn.tool_calls {
            // A call naming a task puts it on the live agent-work board.
            agent_run.touch_args(db, &tc.arguments).await;
            if is_write_tool(&tc.name) {
                // Writes are NEVER executed here — validate + surface as a proposal.
                // The loop keeps going afterwards so a bulk request can propose
                // every item in one turn; the notes make clear nothing ran yet.
                let key = format!("{}:{}", tc.name, tc.arguments);
                let note = if !seen_writes.insert(key) {
                    "(this exact change is already proposed in this turn — do not repeat it; continue with the next item or give your final answer)".to_string()
                } else {
                    match prepare_write(db, user_id, project_id, &tc.name, &tc.arguments).await {
                        Ok(pw) => {
                            let n = format!("(proposed: {} — awaiting the user's approval; NOT yet done)", pw.summary);
                            proposals.push(pw);
                            n
                        }
                        Err(e) => json!({ "error": e }).to_string(),
                    }
                };
                messages.push(json!({ "role": "tool", "content": note, "name": tc.name }));
            } else if tc.name == "ask_atlas" {
                // The librarian: a bounded sub-loop on its own (possibly
                // remote) model — the caller sees one cited digest, and the
                // librarian's tokens count into this turn's usage.
                if !used.contains(&tc.name) {
                    used.push(tc.name.clone());
                }
                let result = match (rag, tc.arguments.get("question").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())) {
                    (Some(rc), Some(question)) => {
                        let answer = crate::librarian::ask_atlas(db, rc, ollama, params, question).await;
                        usage.add(answer.usage);
                        own_usage.add(answer.usage);
                        answer.digest
                    }
                    (None, _) => json!({ "error": "the knowledge engine is not connected" }).to_string(),
                    (_, None) => json!({ "error": "question (string) is required" }).to_string(),
                };
                messages.push(json!({ "role": "tool", "content": cap(result), "name": tc.name }));
            } else if tc.name == "delegate" {
                // Teamwork (DELEGATE.md): a bounded sub-loop on the NAMED
                // personality's own engine + intersected toolset. The caller
                // sees one capped digest; the subagent's writes join THIS
                // turn's proposals (one gate, one inbox, chain-attributed);
                // its tokens bill into this turn's usage.
                let outcome = crate::delegate::run_delegate(
                    db, rag, ollama, tools, project_id, user_id, is_owner, None, &tc.arguments, agent_run,
                )
                .await;
                usage.add(outcome.usage);
                if let Some(id) = outcome.action_id {
                    delegations.push(id);
                    if !delegated_to.contains(&outcome.agent_name) {
                        delegated_to.push(outcome.agent_name.clone());
                    }
                }
                // The "🔧 Looked up" breadcrumb gains the chain (§8).
                let crumb = if outcome.agent_name.is_empty() {
                    tc.name.clone()
                } else {
                    format!("delegate → {}", outcome.agent_name)
                };
                if !used.contains(&crumb) {
                    used.push(crumb);
                }
                for pw in outcome.proposals {
                    let key = format!("{}:{}", pw.command, pw.args);
                    if seen_writes.insert(key) {
                        proposals.push(pw);
                    }
                }
                messages.push(json!({ "role": "tool", "content": cap(outcome.digest), "name": tc.name }));
            } else {
                if !used.contains(&tc.name) {
                    used.push(tc.name.clone()); // distinct tools, first-seen order (UI breadcrumb)
                }
                let result = if crate::finance_tools::is_finance_tool(&tc.name) {
                    // Only a finance tool this turn offered (a loadout may have left it out), and
                    // the finance gate again, on this loop's own engine.
                    if tools.iter().any(|d| tool_name(d).as_deref() == Some(tc.name.as_str())) {
                        let today = chrono::Local::now().date_naive();
                        crate::finance_tools::execute(
                            db, user_id, project_id, runner, params, &ollama.config().base_url, &tc.name, &tc.arguments, today,
                        )
                        .await
                    } else {
                        Err(format!("tool '{}' is not available in this conversation", tc.name))
                    }
                } else {
                    execute_tool(db, rag, project_id, &tc.name, &tc.arguments, Viewer { user_id, is_owner }).await
                }
                .unwrap_or_else(|e| json!({ "error": e }).to_string());
                messages.push(json!({ "role": "tool", "content": result, "name": tc.name }));
            }
        }
    }
    crate::delegate::ledger_delegating_turn(db, user_id, project_id, &params.model, own_usage, &delegated_to, &delegations).await;
    (used, proposals, usage)
}

/// Dispatch a read command through the shared `/invoke` executor.
/// Run a read command with the chatting user's sight: through the command table as that
/// user, so its access rules and result filters (task visibility included) apply. The
/// owner sees everything.
async fn dispatch_read(db: &Db, viewer: Viewer, command: &str, args: Value) -> Result<Value, String> {
    let user = crate::AuthUser { id: viewer.user_id, is_owner: viewer.is_owner, device_id: None };
    crate::commands::run(&crate::commands::Ctx::http(db, user), command, args).await.map_err(|e| e.to_string())
}

/// An active event's title (validation + approval-card copy), or None.
async fn event_title(db: &Db, event_id: i64) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT title FROM events WHERE id = ? AND archived = 0")
        .bind(event_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

/// Which projects an event is linked to (scope checks for event writes).
async fn event_project_links(db: &Db, event_id: i64) -> Vec<i64> {
    sqlx::query_scalar::<_, i64>("SELECT project_id FROM event_projects WHERE event_id = ?")
        .bind(event_id)
        .fetch_all(db)
        .await
        .unwrap_or_default()
}

/// The project a task belongs to (for scope checks), or None if it doesn't exist.
async fn task_project(db: &Db, task_id: i64) -> Option<i64> {
    sqlx::query_scalar::<_, i64>("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

pub(crate) fn cap(s: String) -> String {
    if s.chars().count() <= RESULT_CAP {
        s
    } else {
        let head: String = s.chars().take(RESULT_CAP).collect();
        format!("{head}…[truncated]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ganban_core::models::{CreateProjectInput, CreateTaskInput};
    use ganban_core::{init_db, ops};
    use serde_json::json as j;

    /// The chat user in tests about scoping, not about who's asking.
    const OWNER: Viewer = Viewer { user_id: 1, is_owner: true };

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_tools_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        init_db(&path).await.unwrap()
    }

    /// Loadouts name real tools: built-ins, tab tools and registry tools pass,
    /// a typo or a stale name doesn't.
    #[tokio::test]
    async fn unknown_loadout_tool_names_are_caught() {
        let db = test_db("loadout_names").await;
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(unknown_tool_names(&db, &names(&["get_tasks", "create_task", "delegate", " "])).await.is_empty());
        assert_eq!(unknown_tool_names(&db, &names(&["get_taks", "get_tasks", "nope", "nope"])).await, names(&["get_taks", "nope"]));
    }

    // ---- registry ----------------------------------------------------------

    #[test]
    fn renders_valid_ollama_tool_schemas() {
        let with_rag = ollama_tools(true, false);
        let without = ollama_tools(false, false);
        assert_eq!(without.len(), 4, "search_corpus only when RAG is enabled");
        assert_eq!(with_rag.len(), 5);
        for t in &with_rag {
            assert_eq!(t.get("type").and_then(Value::as_str), Some("function"));
            let f = t.get("function").unwrap();
            assert!(f.get("name").and_then(Value::as_str).is_some());
            assert!(f.get("description").and_then(Value::as_str).is_some());
            assert_eq!(f.get("parameters").and_then(|p| p.get("type")).and_then(Value::as_str), Some("object"));
        }
        // The project-scoped reads expose NO project argument (scope is forced).
        let get_tasks = with_rag.iter().find(|t| t["function"]["name"] == "get_tasks").unwrap();
        assert_eq!(get_tasks["function"]["parameters"]["properties"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn tool_catalog_classifies_and_attributes_every_tool() {
        let cat = tool_catalog(&[]);

        // Builtin writes are gated + class=write; reads are not.
        let create = cat.iter().find(|t| t.name == "create_task").expect("write tool listed");
        assert_eq!(create.class, "write");
        assert!(create.gated, "writes ride the gate");
        assert_eq!(create.source, "builtin");

        let get_tasks = cat.iter().find(|t| t.name == "get_tasks").expect("read tool listed");
        assert_eq!(get_tasks.class, "read");
        assert!(!get_tasks.gated);
        assert_eq!(get_tasks.requires, None, "always-on read has no requirement");

        // Conditional reads advertise what they need, derived (not hardcoded).
        assert_eq!(cat.iter().find(|t| t.name == "search_corpus").unwrap().requires.as_deref(), Some("rag"));
        assert_eq!(cat.iter().find(|t| t.name == "ask_atlas").unwrap().requires.as_deref(), Some("atlas"));

        // The catalog is exactly every builtin read + write, plus `delegate`
        // (the Teamwork skill — in the catalog so a loadout can grant it,
        // offered to the model only when one does) and the finance reads.
        let reads = cat.iter().filter(|t| t.class == "read").count();
        let writes = cat.iter().filter(|t| t.class == "write").count();
        assert_eq!(reads, ollama_tools(true, true).len() + 1 + crate::finance_tools::TOOL_NAMES.len());
        let balances = cat.iter().find(|t| t.name == "finance_balances").expect("finance reads listed");
        assert_eq!(balances.requires.as_deref(), Some("a Personal chat on a local model"));
        assert_eq!(writes, ollama_write_tools().len());
        let delegate = cat.iter().find(|t| t.name == "delegate").expect("delegate listed");
        assert_eq!(delegate.requires.as_deref(), Some("loadout"), "off by default — a loadout is its gate");
    }

    // ---- registry tools (declarative) --------------------------------------

    #[test]
    fn registry_validation_rejects_unsafe_definitions() {
        use ganban_core::models::NewRegistryTool;
        let ok = NewRegistryTool {
            name: "open_tasks".into(),
            description: "List the project's tasks.".into(),
            params_json: None,
            class: None,
            binding_kind: "ops".into(),
            binding_json: r#"{"command":"get_tasks"}"#.into(),
            enabled: true,
        };
        assert!(validate_new_registry_tool(&ok).is_ok());

        // Shadowing a built-in name is refused.
        let mut shadow = ok.clone();
        shadow.name = "get_tasks".into();
        assert!(validate_new_registry_tool(&shadow).is_err());

        // A command outside the allowlist is refused (no arbitrary dispatch).
        let mut bad_cmd = ok.clone();
        bad_cmd.binding_json = r#"{"command":"delete_task"}"#.into();
        assert!(validate_new_registry_tool(&bad_cmd).is_err());

        // Non-identifier names + unsupported bindings are refused.
        let mut bad_name = ok.clone();
        bad_name.name = "drop tables".into();
        assert!(validate_new_registry_tool(&bad_name).is_err());
        let mut bad_kind = ok.clone();
        bad_kind.binding_kind = "http".into();
        assert!(validate_new_registry_tool(&bad_kind).is_err());

        // A rag binding (corpus search) is accepted; its limit/filters are checked.
        let rag = NewRegistryTool {
            name: "search_pdfs".into(),
            description: "Search the project's PDFs.".into(),
            params_json: Some(r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#.into()),
            class: None,
            binding_kind: "rag".into(),
            binding_json: r#"{"limit":5,"filters":{"format":"pdf"}}"#.into(),
            enabled: true,
        };
        assert!(validate_new_registry_tool(&rag).is_ok());
        let mut bad_limit = rag.clone();
        bad_limit.binding_json = r#"{"limit":999}"#.into();
        assert!(validate_new_registry_tool(&bad_limit).is_err());
        let mut bad_filters = rag.clone();
        bad_filters.binding_json = r#"{"filters":"pdf"}"#.into();
        assert!(validate_new_registry_tool(&bad_filters).is_err());

        // An mcp binding needs a /mcp/ mount + a tool name.
        let mcp = NewRegistryTool {
            name: "ask_msc".into(),
            description: "Search the msc-stf corpus via ragrat.".into(),
            params_json: Some(r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#.into()),
            class: None,
            binding_kind: "mcp".into(),
            binding_json: r#"{"mount":"/mcp/msc-stf/","tool":"search_corpus"}"#.into(),
            enabled: true,
        };
        assert!(validate_new_registry_tool(&mcp).is_ok());
        let mut bad_mount = mcp.clone();
        bad_mount.binding_json = r#"{"mount":"/evil/","tool":"x"}"#.into();
        assert!(validate_new_registry_tool(&bad_mount).is_err());
        let mut no_tool = mcp.clone();
        no_tool.binding_json = r#"{"mount":"/mcp/"}"#.into();
        assert!(validate_new_registry_tool(&no_tool).is_err());

        // An http connector needs a valid https url; http:// is refused.
        let http = NewRegistryTool {
            name: "weather".into(),
            description: "Look up the weather.".into(),
            params_json: Some(r#"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}"#.into()),
            class: None,
            binding_kind: "http".into(),
            binding_json: r#"{"url":"https://api.example.com/w","query":{"q":"{city}","key":"{secret}"},"secret_name":"weather"}"#.into(),
            enabled: true,
        };
        assert!(validate_new_registry_tool(&http).is_ok());
        let mut insecure = http.clone();
        insecure.binding_json = r#"{"url":"http://api.example.com/w"}"#.into();
        assert!(validate_new_registry_tool(&insecure).is_err(), "http:// refused");
    }

    #[test]
    fn connector_template_substitutes_args_and_secret() {
        let args = json!({ "city": "Lagos" });
        assert_eq!(template_value("{city}", &args, Some("KEY")), "Lagos");
        assert_eq!(template_value("Bearer {secret}", &args, Some("KEY")), "Bearer KEY");
        // An unknown placeholder is left as-is (no secret leak via stray braces).
        assert_eq!(template_value("{other}", &args, Some("KEY")), "{other}");
    }

    #[test]
    fn connector_select_shapes_a_brave_style_response() {
        let body = json!({
            "query": { "original": "bunkers" },
            "web": { "results": [
                { "title": "A", "url": "https://a", "description": "da", "extra": 1 },
                { "title": "B", "url": "https://b", "description": "db", "extra": 2 },
                { "title": "C", "url": "https://c", "description": "dc", "extra": 3 }
            ]}
        });
        let sel = json!({ "path": "web.results", "fields": ["title", "url"], "limit": 2 });
        let out: Value = serde_json::from_str(&apply_select(&body, &sel)).unwrap();
        assert_eq!(out.as_array().unwrap().len(), 2, "limit applied");
        assert_eq!(out[0]["title"], "A");
        assert!(out[0].get("extra").is_none(), "only requested fields kept");
        assert!(out[0].get("description").is_none());

        // A path that misses falls back to the raw JSON, not an error.
        let miss = json!({ "path": "nope.here" });
        assert_eq!(apply_select(&body, &miss), body.to_string());

        // A single string field (e.g. Firecrawl data.markdown) returns clean text.
        let fc = json!({ "success": true, "data": { "markdown": "# Title\nbody" } });
        assert_eq!(apply_select(&fc, &json!({ "path": "data.markdown" })), "# Title\nbody");
    }

    #[test]
    fn template_json_substitutes_leaves_without_injection() {
        let args = json!({ "query": "https://x.test\" ,\"evil\":1" });
        let body = json!({ "url": "{query}", "formats": ["markdown"], "n": 5 });
        let out = template_json(&body, &args, Some("KEY"));
        // The model arg lands as a STRING value (structure preserved, no injection).
        assert_eq!(out["url"], json!("https://x.test\" ,\"evil\":1"));
        assert_eq!(out["formats"], json!(["markdown"]));
        assert_eq!(out["n"], json!(5));
        assert!(out.get("evil").is_none(), "no structural injection");
    }

    #[test]
    fn html_to_text_strips_markup_scripts_and_entities() {
        let html = "<html><head><style>.x{color:red}</style></head><body>\n  <h1>Bunker Prices</h1>\n  <script>var p = 612.5;</script>\n  <p>Singapore VLSFO &amp; MGO — café résumé</p>\n</body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Bunker Prices"));
        assert!(text.contains("Singapore VLSFO & MGO"), "entities decoded: {text}");
        assert!(text.contains("café résumé"), "utf-8 preserved: {text}");
        assert!(!text.contains("color:red"), "style body dropped");
        assert!(!text.contains("var p"), "script body dropped");
        assert!(!text.contains('<'), "tags stripped");
    }

    #[tokio::test]
    async fn registry_ops_tool_executes_scope_forced() {
        use ganban_core::models::{CreateProjectInput, CreateTaskInput, NewRegistryTool};
        let db = test_db("registry_exec").await;
        let a = ops::create_project(&db, CreateProjectInput { name: "A".into(), description: None }).await.unwrap();
        let b = ops::create_project(&db, CreateProjectInput { name: "B".into(), description: None }).await.unwrap();
        let mk = |pid: i64, title: &str| CreateTaskInput {
            project_id: pid, area_id: None, title: title.into(), description: None,
            status: "todo".into(), priority: "normal".into(), prefix: None, cost: None, currency: None, deadline: None,
        };
        ops::create_task(&db, mk(a.id, "in-A")).await.unwrap();
        ops::create_task(&db, mk(b.id, "in-B")).await.unwrap();

        ops::create_registry_tool(&db, NewRegistryTool {
            name: "open_tasks".into(), description: "tasks".into(), params_json: None, class: None,
            binding_kind: "ops".into(), binding_json: r#"{"command":"get_tasks"}"#.into(), enabled: true,
        }).await.unwrap();

        // The tool appears in the assembled defs...
        assert!(registry_tool_defs(&db, true, true).await.iter().any(|d| d["function"]["name"] == "open_tasks"));

        // ...and executing it for project A returns A's task even if the model
        // tries to point it at B — projectId is forced server-side.
        let out = execute_tool(&db, None, a.id, "open_tasks", &json!({ "projectId": b.id }), OWNER).await.unwrap();
        assert!(out.contains("in-A"), "scope forced to the chat's project: {out}");
        assert!(!out.contains("in-B"), "the model's projectId override is ignored: {out}");
    }

    // ---- read-tool dispatch + scope enforcement ----------------------------

    #[tokio::test]
    async fn get_tasks_tool_reflects_live_data_for_its_project() {
        let db = test_db("reads").await;
        let proj = ops::create_project(&db, CreateProjectInput { name: "Alpha".into(), description: None }).await.unwrap();
        ops::create_task(&db, CreateTaskInput {
            project_id: proj.id, area_id: None, title: "Wire the tool layer".into(), description: None,
            status: "To Do".into(), priority: "High".into(), prefix: None, cost: None, currency: None, deadline: None,
        }).await.unwrap();

        let out = execute_tool(&db, None, proj.id, "get_tasks", &j!({}), OWNER).await.unwrap();
        assert!(out.contains("Wire the tool layer"), "tool result should reflect live data: {out}");
    }

    #[tokio::test]
    async fn get_task_comments_rejects_cross_project_task() {
        let db = test_db("scope").await;
        let a = ops::create_project(&db, CreateProjectInput { name: "A".into(), description: None }).await.unwrap();
        let b = ops::create_project(&db, CreateProjectInput { name: "B".into(), description: None }).await.unwrap();
        let task_b = ops::create_task(&db, CreateTaskInput {
            project_id: b.id, area_id: None, title: "B task".into(), description: None,
            status: "To Do".into(), priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
        }).await.unwrap();

        // A chat scoped to project A must not read project B's task comments.
        let err = execute_tool(&db, None, a.id, "get_task_comments", &j!({ "task_id": task_b.id }), OWNER).await.unwrap_err();
        assert!(err.contains("not in this project"), "expected scope rejection, got: {err}");
    }

    #[tokio::test]
    async fn rejects_missing_args_and_unknown_tools() {
        let db = test_db("validate").await;
        let p = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap();
        assert!(execute_tool(&db, None, p.id, "get_task_comments", &j!({}), OWNER).await.is_err(), "missing task_id");
        assert!(execute_tool(&db, None, p.id, "search_corpus", &j!({ "query": "  " }), OWNER).await.is_err(), "blank query");
        assert!(execute_tool(&db, None, p.id, "delete_task", &j!({ "task_id": 1 }), OWNER).await.is_err(), "write tool not callable");
        assert!(execute_tool(&db, None, p.id, "search_corpus", &j!({ "query": "x" }), OWNER).await.is_err(), "RAG disabled");
    }

    // ---- CRUD round-trips at the /invoke command level (the Phase 2 gate) ----
    // These never touch a model: they prove create/read/update/delete are correct
    // before any write tool is exposed.

    #[tokio::test]
    async fn crud_roundtrip_project() {
        let db = test_db("crud_project").await;
        let created = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Roundtrip" } })).await.unwrap();
        let id = created["id"].as_i64().unwrap();
        let list = crate::dispatch(&db, "get_projects", &j!({})).await.unwrap();
        assert!(list.as_array().unwrap().iter().any(|p| p["id"] == id && p["name"] == "Roundtrip"));

        crate::dispatch(&db, "update_project", &j!({ "projectId": id, "input": { "name": "Renamed" } })).await.unwrap();
        let after = crate::dispatch(&db, "get_projects", &j!({})).await.unwrap();
        assert!(after.as_array().unwrap().iter().any(|p| p["id"] == id && p["name"] == "Renamed"));

        crate::dispatch(&db, "delete_project", &j!({ "projectId": id })).await.unwrap(); // hard delete
        let gone = crate::dispatch(&db, "get_projects", &j!({})).await.unwrap();
        assert!(!gone.as_array().unwrap().iter().any(|p| p["id"] == id));
    }

    #[tokio::test]
    async fn crud_roundtrip_area() {
        let db = test_db("crud_area").await;
        let proj = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Has areas" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        let area = crate::dispatch(&db, "create_area", &j!({ "input": { "project_id": pid, "name": "Backend" } })).await.unwrap();
        let aid = area["id"].as_i64().unwrap();
        let listed = crate::dispatch(&db, "get_areas", &j!({ "projectId": pid })).await.unwrap();
        assert!(listed.as_array().unwrap().iter().any(|x| x["id"] == aid && x["name"] == "Backend"));

        crate::dispatch(&db, "update_area", &j!({ "areaId": aid, "input": { "name": "Server" } })).await.unwrap();
        let after = crate::dispatch(&db, "get_areas", &j!({ "projectId": pid })).await.unwrap();
        assert!(after.as_array().unwrap().iter().any(|x| x["id"] == aid && x["name"] == "Server"));

        crate::dispatch(&db, "delete_area", &j!({ "areaId": aid })).await.unwrap(); // hard delete
        let gone = crate::dispatch(&db, "get_areas", &j!({ "projectId": pid })).await.unwrap();
        assert!(!gone.as_array().unwrap().iter().any(|x| x["id"] == aid));
    }

    #[tokio::test]
    async fn crud_roundtrip_task() {
        let db = test_db("crud_task").await;
        let proj = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Tasks" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        let task = crate::dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "First", "status": "To Do", "priority": "Medium" }
        })).await.unwrap();
        let tid = task["id"].as_i64().unwrap();
        let listed = crate::dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(listed.as_array().unwrap().iter().any(|t| t["id"] == tid && t["title"] == "First"));

        crate::dispatch(&db, "update_task", &j!({ "taskId": tid, "input": { "title": "First (edited)" } })).await.unwrap();
        let after = crate::dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(after.as_array().unwrap().iter().any(|t| t["id"] == tid && t["title"] == "First (edited)"));

        crate::dispatch(&db, "delete_task", &j!({ "taskId": tid })).await.unwrap(); // soft delete (archived)
        let gone = crate::dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(!gone.as_array().unwrap().iter().any(|t| t["id"] == tid), "archived task should leave the active list");
    }

    #[tokio::test]
    async fn crud_roundtrip_event() {
        let db = test_db("crud_event").await;
        let created = crate::dispatch(&db, "create_event", &j!({
            "input": { "title": "Kickoff", "event_date": "2026-06-10T12:00:00Z", "all_day": false, "notification_enabled": false }
        })).await.unwrap();
        let eid = created["id"].as_i64().unwrap();
        let read = crate::dispatch(&db, "get_event", &j!({ "eventId": eid })).await.unwrap();
        assert_eq!(read["title"], "Kickoff");

        crate::dispatch(&db, "update_event", &j!({ "eventId": eid, "input": { "title": "Kickoff (moved)" } })).await.unwrap();
        let after = crate::dispatch(&db, "get_event", &j!({ "eventId": eid })).await.unwrap();
        assert_eq!(after["title"], "Kickoff (moved)");

        crate::dispatch(&db, "delete_event", &j!({ "eventId": eid })).await.unwrap(); // soft delete (archived)
        let active = crate::dispatch(&db, "get_events", &j!({ "archived": false })).await.unwrap();
        assert!(!active.as_array().unwrap().iter().any(|e| e["id"] == eid), "archived event should leave the active list");
    }

    // ---- Phase 2: write proposals are validated but NEVER auto-executed -------

    #[tokio::test]
    async fn write_tool_is_not_executed_by_the_read_executor() {
        // The read path must refuse write names outright — the gate's first line.
        let db = test_db("no_autoexec").await;
        let p = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap();
        for name in ["create_task", "update_task", "delete_task", "create_comment"] {
            assert!(execute_tool(&db, None, p.id, name, &j!({ "title": "x", "task_id": 1, "content": "x" }), OWNER).await.is_err(),
                "read executor must never run write tool {name}");
        }
    }

    #[tokio::test]
    async fn prepare_write_validates_and_scopes_without_executing() {
        let db = test_db("prepare").await;
        let a = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "A" } })).await.unwrap();
        let b = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "B" } })).await.unwrap();
        let (aid, bid) = (a["id"].as_i64().unwrap(), b["id"].as_i64().unwrap());
        let task_b = crate::dispatch(&db, "create_task", &j!({
            "input": { "project_id": bid, "title": "B task", "status": "To Do", "priority": "Low" }
        })).await.unwrap();
        let tb = task_b["id"].as_i64().unwrap();

        // Valid create_task → a runnable command, project forced, NOT executed.
        let pw = prepare_write(&db, 1, aid, "create_task", &j!({ "title": "New" })).await.unwrap();
        assert_eq!(pw.command, "create_task");
        assert_eq!(pw.args["input"]["project_id"].as_i64(), Some(aid), "project is forced server-side");
        // Nothing was created by preparing it.
        let list = crate::dispatch(&db, "get_tasks", &j!({ "projectId": aid, "archived": false })).await.unwrap();
        assert!(list.as_array().unwrap().is_empty(), "prepare_write must not create anything");

        // Missing required arg → rejected.
        assert!(prepare_write(&db, 1, aid, "create_task", &j!({})).await.is_err());
        // Cross-project task → rejected (no scope widening) for every task-bearing write.
        for name in ["update_task", "delete_task"] {
            assert!(prepare_write(&db, 1, aid, name, &j!({ "task_id": tb, "title": "x" })).await.is_err(), "{name} cross-project");
        }
        assert!(prepare_write(&db, 1, aid, "create_comment", &j!({ "task_id": tb, "content": "hi" })).await.is_err());
    }

    #[tokio::test]
    async fn apply_write_lands_the_change_on_approval() {
        let db = test_db("apply").await;
        let proj = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Apply" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();

        let pw = prepare_write(&db, 1, pid, "create_task", &j!({ "title": "Approved task", "status": "In Progress" })).await.unwrap();
        let res = apply_write(&db, &std::env::temp_dir(), pw.command, &pw.args).await.unwrap();
        assert_eq!(res["title"], "Approved task");
        let list = crate::dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(list.as_array().unwrap().iter().any(|t| t["title"] == "Approved task" && t["status"] == "In Progress"));
    }
}

#[cfg(test)]
mod event_link_tests {
    use super::*;
    use serde_json::json as j;

    const OWNER: Viewer = Viewer { user_id: 1, is_owner: true };

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_evlink_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn imported_events_can_be_found_then_linked_through_the_gate() {
        let db = test_db("link").await;
        ganban_core::auth::ensure_owner(&db).await.unwrap(); // the proposer, user 1, is the owner
        let pid = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "SMM283" } })).await.unwrap()["id"].as_i64().unwrap();
        let tid = crate::dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "Week 2 prep", "status": "To Do", "priority": "Medium" }
        })).await.unwrap()["id"].as_i64().unwrap();
        // Dynamic future date — get_unlinked_events filters on
        // event_date >= now-1day, so a hardcoded fixture date rots into a
        // false failure once the calendar passes it (it did: 2026-06-20).
        let future = (chrono::Utc::now() + chrono::Duration::days(7)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let eid = crate::dispatch(&db, "create_event", &j!({
            "input": { "title": "SMM283 Lecture W2", "event_date": future, "all_day": false, "notification_enabled": false }
        })).await.unwrap()["id"].as_i64().unwrap();

        // The imported (unlinked) event is discoverable by the read tool…
        let listing = execute_tool(&db, None, pid, "get_unlinked_events", &j!({}), OWNER).await.unwrap();
        assert!(listing.contains("SMM283 Lecture W2"));

        // …a link is proposed (validated, not executed) and applied through the gate.
        let pw = prepare_write(&db, 1, pid, "link_event_to_project", &j!({ "event_id": eid })).await.unwrap();
        assert_eq!(pw.args["projectId"].as_i64(), Some(pid), "project is forced server-side");
        assert!(pw.summary.contains("SMM283 Lecture W2"));
        apply_write(&db, &std::env::temp_dir(), pw.command, &pw.args).await.unwrap();
        let linked = crate::dispatch(&db, "get_event_projects", &j!({ "eventId": eid })).await.unwrap();
        assert!(linked.as_array().unwrap().iter().any(|p| p["id"] == pid));

        // Once linked, it leaves the unlinked listing.
        let listing = execute_tool(&db, None, pid, "get_unlinked_events", &j!({}), OWNER).await.unwrap();
        assert!(!listing.contains("SMM283 Lecture W2"));

        // Task links: validated against THIS project; cross-project refused.
        let pw = prepare_write(&db, 1, pid, "link_event_to_task", &j!({ "event_id": eid, "task_id": tid })).await.unwrap();
        apply_write(&db, &std::env::temp_dir(), pw.command, &pw.args).await.unwrap();
        let tasks = crate::dispatch(&db, "get_event_tasks", &j!({ "eventId": eid })).await.unwrap();
        assert!(tasks.as_array().unwrap().iter().any(|t| t["id"] == tid));

        let other = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Other" } })).await.unwrap()["id"].as_i64().unwrap();
        let foreign = crate::dispatch(&db, "create_task", &j!({
            "input": { "project_id": other, "title": "X", "status": "To Do", "priority": "Low" }
        })).await.unwrap()["id"].as_i64().unwrap();
        assert!(prepare_write(&db, 1, pid, "link_event_to_task", &j!({ "event_id": eid, "task_id": foreign })).await.is_err());
        assert!(prepare_write(&db, 1, pid, "link_event_to_project", &j!({ "event_id": 9999 })).await.is_err(), "nonexistent event refused");
    }
}

#[cfg(test)]
mod event_delete_tests {
    use super::*;
    use serde_json::json as j;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_evdel_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn event_deletion_respects_project_scope() {
        let db = test_db("scope").await;
        let mine = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Mine" } })).await.unwrap()["id"].as_i64().unwrap();
        let theirs = crate::dispatch(&db, "create_project", &j!({ "input": { "name": "Theirs" } })).await.unwrap()["id"].as_i64().unwrap();
        let make_event = |title: &str| j!({ "input": { "title": title, "event_date": "2026-06-20T13:00:00Z", "all_day": false, "notification_enabled": false } });
        let orphan = crate::dispatch(&db, "create_event", &make_event("Imported 13:00")).await.unwrap()["id"].as_i64().unwrap();
        let ours = crate::dispatch(&db, "create_event", &make_event("Our lab")).await.unwrap()["id"].as_i64().unwrap();
        let foreign = crate::dispatch(&db, "create_event", &make_event("Their kickoff")).await.unwrap()["id"].as_i64().unwrap();
        crate::dispatch(&db, "link_event_to_project", &j!({ "eventId": ours, "projectId": mine })).await.unwrap();
        crate::dispatch(&db, "link_event_to_project", &j!({ "eventId": foreign, "projectId": theirs })).await.unwrap();

        // Orphans (imported clutter) and this project's events are deletable…
        let pw = prepare_write(&db, 1, mine, "delete_event", &j!({ "event_id": orphan })).await.unwrap();
        apply_write(&db, &std::env::temp_dir(), pw.command, &pw.args).await.unwrap();
        assert!(prepare_write(&db, 1, mine, "delete_event", &j!({ "event_id": ours })).await.is_ok());
        // …another project's event is out of reach.
        assert!(prepare_write(&db, 1, mine, "delete_event", &j!({ "event_id": foreign })).await.is_err());

        // The archived orphan left the active list (soft delete).
        let active = crate::dispatch(&db, "get_events", &j!({ "archived": false })).await.unwrap();
        assert!(!active.as_array().unwrap().iter().any(|e| e["id"] == orphan));

        // Unlink: only events actually linked to this project.
        let pw = prepare_write(&db, 1, mine, "unlink_event_from_project", &j!({ "event_id": ours })).await.unwrap();
        apply_write(&db, &std::env::temp_dir(), pw.command, &pw.args).await.unwrap();
        let links = crate::dispatch(&db, "get_event_projects", &j!({ "eventId": ours })).await.unwrap();
        assert!(links.as_array().unwrap().is_empty());
        assert!(prepare_write(&db, 1, mine, "unlink_event_from_project", &j!({ "event_id": foreign })).await.is_err());
    }
}

#[cfg(test)]
mod visibility_tests {
    //! The assistant acts with the chatting member's sight (task visibility, ADR 0002).
    use super::*;
    use ganban_core::models::{CreateProjectInput, CreateTaskInput};
    use ganban_core::{auth, ops, visibility};
    use serde_json::json as j;

    #[tokio::test]
    async fn a_members_assistant_sees_and_proposes_only_within_their_audience() {
        let path = std::env::temp_dir().join(format!("ganban_tools_vis_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        auth::ensure_owner(&db).await.unwrap();
        sqlx::query("INSERT INTO users (id, username, full_name) VALUES (7, 'bo', 'Bo')").execute(&db).await.unwrap();
        let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
        auth::add_project_member(&db, pid, 7, auth::ROLE_MEMBER).await.unwrap();
        let task = |title: &str| CreateTaskInput {
            project_id: pid, area_id: None, title: title.into(), description: None, status: "To Do".into(),
            priority: "Low".into(), prefix: None, cost: None, currency: None, deadline: None,
        };
        let open = ops::create_task(&db, task("Open")).await.unwrap().id;
        let secret = ops::create_task(&db, task("Reorg")).await.unwrap().id;
        visibility::set_task_visibility(&db, secret, visibility::ADMINS_ONLY, &[]).await.unwrap();

        let bo = Viewer { user_id: 7, is_owner: false };
        let tasks = execute_tool(&db, None, pid, "get_tasks", &j!({}), bo).await.unwrap();
        assert!(tasks.contains("Open") && !tasks.contains("Reorg"), "{tasks}");
        let comments = execute_tool(&db, None, pid, "get_task_comments", &j!({ "task_id": secret }), bo).await;
        assert_eq!(comments.unwrap_err(), "that task is not in this project");
        let rename = prepare_write(&db, 7, pid, "update_task", &j!({ "task_id": secret, "title": "Mine" })).await;
        assert_eq!(rename.err().as_deref(), Some("that task is not in this project"));
        assert!(prepare_write(&db, 7, pid, "update_task", &j!({ "task_id": open, "title": "Fine" })).await.is_ok());

        let owners = execute_tool(&db, None, pid, "get_tasks", &j!({}), Viewer { user_id: 1, is_owner: true }).await.unwrap();
        assert!(owners.contains("Reorg"), "the owner's assistant sees everything");
    }
}
