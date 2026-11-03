//! **Delegate** (docs/design/DELEGATE.md): subagents under the one gate. Generalizes
//! the librarian executor — the target agent becomes a parameter instead of a
//! constant. A personality (with its loadouts) runs a bounded tool loop on its
//! OWN engine with its OWN clean context and returns a capped digest; the
//! caller never sees the transcript.
//!
//! The load-bearing rule: **delegation narrows capability, never widens it.**
//!
//! ```text
//! effective toolset = target's loadouts ∩ caller's toolset (already
//!                     owner-filtered + protocol/loadout-scoped) − delegate
//! ```
//!
//! - The intersection is enforced at ASSEMBLY (here) and again at EXECUTION
//!   (`execute_tool` re-checks owner-only bindings with the CALLER's
//!   ownership) — the registry's double-enforcement discipline.
//! - Depth 1 by structure: `delegate` is stripped from every delegated
//!   toolset, so a fan-out cannot fan out.
//! - One gate, one inbox: a subagent's writes become proposals like any
//!   other, the summary carrying the chain ("… — via Scout").
//! - Every delegation is its own ledger row with `parent_action_id` linking
//!   to the caller's row where one exists (the ledger becomes a tree).
//!
//! v1 decisions (recorded): fan-out = the model calling `delegate` multiple
//! times in one turn, executed sequentially (a single Ollama box thrashes
//! under real parallelism — the hardware-aware cap arrives with the Model
//! Advisor; the hard ceiling stays 8 handled by MAX_TOOL_ROUNDS bounds).
//! Budget roll-up is deferred to the persona-budgets epoch — the tree +
//! capacity-meter columns already make it a query.

use std::collections::HashSet;

use ganban_core::{ops, Db};
use serde_json::{json, Value};

use crate::ollama::{ChatParams, OllamaClient, Usage};
use crate::rag::RagClient;
use crate::tools::{self, PreparedWrite};

/// Bounds — inherited from the librarian (the proven values).
const MAX_ROUNDS: usize = 6;
const ROUND_TIMEOUT_SECS: u64 = 45;
/// Digest budget in WORDS (DELEGATE.md decision 2).
pub const DIGEST_WORDS_DEFAULT: usize = 250;
pub const DIGEST_WORDS_CEILING: usize = 500;

/// The `delegate` tool definition. Only offered when a personality's loadout
/// grants the tool named "delegate" (the "Teamwork" skill — off by default).
pub fn delegate_tool_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "delegate",
            "description": "Delegate one task to another team personality by name. The personality researches/works with its own tools and model, and returns a short digest (its findings, not its transcript). Its proposed changes go to the user's approval inbox like any other. Call multiple times to fan a job out to several personalities.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "The personality's name (as shown in the roster), e.g. 'Scout' or 'donna'." },
                    "task": { "type": "string", "description": "What to find out or do — one self-contained task." },
                    "digest_words": { "type": "integer", "description": "Optional word budget for the digest (default 250, max 500)." }
                },
                "required": ["agent", "task"]
            }
        }
    })
}

/// Slug form of a personality name ("Donna Paulsen" → "donna-paulsen").
/// Models handle names better than ids, and slugs survive export/import
/// (DELEGATE.md decision 1). Matching is slug-vs-slug so "donna", "Donna"
/// and "donna-paulsen" all resolve predictably.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true; // trim leading dashes
    for c in name.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// ASSEMBLY-side capability intersection (conformance: `delegation_narrows`,
/// `no_recursion`). Pure so it is testable without a database:
/// target's granted names ∩ caller's offered names, minus `delegate` itself.
/// The caller's set is already owner-filtered (a non-owner's defs never
/// contained owner-only bindings) — the intersection inherits that.
pub fn effective_toolset(target_granted: &HashSet<String>, caller_offered: &HashSet<String>) -> HashSet<String> {
    let mut set: HashSet<String> = target_granted.intersection(caller_offered).cloned().collect();
    set.remove("delegate"); // depth 1 by structure — a fan-out cannot fan out
    set
}

/// Cap a digest at a word budget. Citations like `[collection/source]` ride
/// inside the kept prefix — truncation appends a marker, never rewrites.
pub fn cap_words(s: &str, max_words: usize) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() <= max_words {
        return s.trim().to_string();
    }
    format!("{}… (truncated at {max_words} words)", words[..max_words].join(" "))
}

pub struct DelegateOutcome {
    pub digest: String,
    pub proposals: Vec<PreparedWrite>,
    pub usage: Usage,
    /// Resolved personality name (for the breadcrumb / chain attribution).
    pub agent_name: String,
}

/// Run one delegation: resolve the personality by name/slug, assemble the
/// intersected toolset, run a bounded loop on the TARGET's engine, ledger the
/// call, and return a capped digest + any write proposals (chain-attributed).
///
/// Errors are folded INTO the digest — the calling agent should keep going,
/// not crash (librarian doctrine).
#[allow(clippy::too_many_arguments)]
pub async fn run_delegate(
    db: &Db,
    rag: Option<&RagClient>,
    base_client: &OllamaClient,
    caller_defs: &[Value],
    project_id: i64,
    user_id: i64,
    is_owner: bool,
    parent_action_id: Option<i64>,
    args: &Value,
) -> DelegateOutcome {
    let mut usage = Usage::default();
    let fail = |msg: String| DelegateOutcome { digest: json!({ "error": msg }).to_string(), proposals: Vec::new(), usage: Usage::default(), agent_name: String::new() };

    let Some(agent) = args.get("agent").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
        return fail("agent (string) is required".into());
    };
    let Some(task) = args.get("task").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
        return fail("task (string) is required".into());
    };
    let digest_words = args
        .get("digest_words")
        .and_then(Value::as_u64)
        .map(|w| (w as usize).clamp(50, DIGEST_WORDS_CEILING))
        .unwrap_or(DIGEST_WORDS_DEFAULT);

    // Resolve the personality by slug(name).
    let profiles = ops::list_model_profiles(db).await.unwrap_or_default();
    let want = slugify(agent);
    let Some(profile) = profiles.into_iter().find(|p| slugify(&p.name) == want) else {
        return fail(format!("no personality named '{agent}' — use a roster name"));
    };

    // Target's granted tool names: the union over its loadouts. No loadout =
    // no tools (narrowing: nothing granted) — the agent still reasons and
    // answers with its model, it just cannot look anything up.
    let mut granted: HashSet<String> = HashSet::new();
    for l in ops::profile_loadouts(db, profile.id).await.unwrap_or_default() {
        for t in ops::loadout_tool_names(db, l.id).await.unwrap_or_default() {
            granted.insert(t);
        }
    }
    let caller_offered: HashSet<String> = caller_defs
        .iter()
        .filter_map(|d| d.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).map(String::from))
        .collect();
    let effective = effective_toolset(&granted, &caller_offered);
    let defs: Vec<Value> = caller_defs
        .iter()
        .filter(|d| {
            d.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(|n| effective.contains(n))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    // The target's OWN engine (its model + endpoint — Epoch H remote boxes).
    let params = ChatParams {
        model: profile.model.clone(),
        temperature: profile.temperature,
        max_tokens: profile.max_tokens,
        num_ctx: None,
        endpoint: profile.endpoint.clone(),
    };
    let client = OllamaClient::for_params(base_client, &params);
    let persona = profile.system_prompt.as_deref().unwrap_or("You are a capable assistant.");
    let system = format!(
        "{persona}\n\nYou were delegated ONE task by a teammate. Work it with your tools (reads run \
         immediately; proposed changes await the user's approval — say so, never claim they are done). \
         Then reply with a compact digest of at most ~{digest_words} words: findings first, cite sources \
         as [source] where you used tools, and state clearly what you could NOT determine. Never invent sources."
    );
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": task }),
    ];

    let timeout = std::time::Duration::from_secs(ROUND_TIMEOUT_SECS);
    let mut last_content = String::new();
    let mut proposals: Vec<PreparedWrite> = Vec::new();
    let started = std::time::Instant::now();
    for _ in 0..MAX_ROUNDS {
        let turn = match tokio::time::timeout(timeout, client.chat_once(&params, &messages, &defs)).await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) if e.contains("unreachable") => {
                let note = profile.fallback_note.clone().unwrap_or_else(|| format!("{}'s engine is unreachable right now", profile.name));
                return DelegateOutcome { digest: format!("(delegation unavailable: {note})"), proposals, usage, agent_name: profile.name };
            }
            _ => break, // timeout / transport error → digest what we have
        };
        usage.add(turn.usage);
        if turn.tool_calls.is_empty() {
            last_content = turn.content;
            break;
        }
        let raw_calls: Vec<Value> = turn
            .tool_calls
            .iter()
            .map(|tc| json!({ "function": { "name": tc.name, "arguments": tc.arguments } }))
            .collect();
        messages.push(json!({ "role": "assistant", "content": turn.content, "tool_calls": raw_calls }));
        for tc in &turn.tool_calls {
            // EXECUTION-side enforcement: even if a def slipped through,
            // effective-set membership is re-checked here, and execute_tool
            // gets the CALLER's ownership (owner-only bindings re-checked).
            let note = if !effective.contains(&tc.name) {
                json!({ "error": format!("tool '{}' is not available in this delegation", tc.name) }).to_string()
            } else if tools::is_write_tool(&tc.name) {
                match tools::prepare_write(db, user_id, project_id, &tc.name, &tc.arguments).await {
                    Ok(mut pw) => {
                        // One gate, one inbox — the proposal card carries the chain.
                        pw.summary = format!("{} — via {}", pw.summary, profile.name);
                        let n = format!("(proposed: {} — awaiting the user's approval; NOT yet done)", pw.summary);
                        proposals.push(pw);
                        n
                    }
                    Err(e) => json!({ "error": e }).to_string(),
                }
            } else {
                tools::execute_tool(db, rag, project_id, &tc.name, &tc.arguments, ganban_core::visibility::Viewer { user_id, is_owner })
                    .await
                    .unwrap_or_else(|e| json!({ "error": e }).to_string())
            };
            messages.push(json!({ "role": "tool", "content": note, "name": tc.name }));
        }
    }

    let digest = if last_content.trim().is_empty() {
        format!("({} could not produce a digest in time — try a more specific task)", profile.name)
    } else {
        cap_words(&last_content, digest_words)
    };

    // Every delegation is its own ledger row, linked to the caller's row
    // where one exists (conformance: `tree_ledgered`). Cost roll-up = a
    // query over parent_action_id + the capacity-meter columns.
    if let Err(e) = ops::record_agent_action(db, ops::NewAgentAction {
        status: "applied",
        user_id,
        profile_id: Some(profile.id),
        project_id: Some(project_id),
        chat_id: None,
        routine_id: None,
        tool: "delegate",
        summary: &format!("Delegated to {}: {}", profile.name, task.chars().take(120).collect::<String>()),
        args_json: &json!({ "agent": agent, "task": task }).to_string(),
        result_json: Some(&json!({ "digest_chars": digest.len(), "proposals": proposals.len() }).to_string()),
        model: Some(&params.model),
        prompt_tokens: Some(usage.prompt_tokens),
        completion_tokens: Some(usage.completion_tokens),
        duration_ms: Some(started.elapsed().as_millis() as i64),
        protocol_slug: None,
        protocol_version: None,
        content_hash: None,
        parent_action_id,
        approver_id: None,
    })
    .await
    {
        tracing::warn!("delegation to '{}' completed but could not ledger it: {e}", profile.name);
    }

    DelegateOutcome { digest, proposals, usage, agent_name: profile.name }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_recursion_delegate_stripped_structurally() {
        // Even when BOTH sides grant `delegate`, the effective set never
        // contains it — a fan-out cannot fan out (DELEGATE.md §4).
        let eff = effective_toolset(&set(&["delegate", "get_tasks"]), &set(&["delegate", "get_tasks"]));
        assert!(!eff.contains("delegate"));
        assert!(eff.contains("get_tasks"));
    }

    #[test]
    fn delegation_narrows_never_widens() {
        // The target's loadout grants owner-tooled + exotic tools; the caller
        // (a member) offers only the member set. Intersection = member set ∩
        // granted — owner-only bindings the caller never had CANNOT appear.
        let target = set(&["get_tasks", "mcp_admin", "http_fetch", "search_corpus"]);
        let caller_member = set(&["get_tasks", "search_corpus", "get_events"]);
        let eff = effective_toolset(&target, &caller_member);
        assert_eq!(eff, set(&["get_tasks", "search_corpus"]));
        assert!(!eff.contains("mcp_admin"), "delegation must not reach tools the caller lacks");

        // And a target with NO loadouts gets nothing (narrowing: no grant, no tool).
        assert!(effective_toolset(&set(&[]), &caller_member).is_empty());
    }

    #[test]
    fn digest_capped_citations_survive() {
        let long = format!("Finding one [atlas/report.pdf]. {}", "word ".repeat(600));
        let capped = cap_words(&long, 250);
        assert!(capped.contains("[atlas/report.pdf]"), "citations in the kept prefix survive");
        assert!(capped.split_whitespace().count() <= 250 + 5, "hard word budget (+truncation marker)");
        assert!(capped.ends_with("words)"));
        // Under budget → untouched.
        assert_eq!(cap_words("short answer", 250), "short answer");
    }

    #[test]
    fn slugify_matches_roster_names() {
        assert_eq!(slugify("Donna Paulsen"), "donna-paulsen");
        assert_eq!(slugify("  Scout  "), "scout");
        assert_eq!(slugify("Ératosthène!"), "ératosthène");
        assert_eq!(slugify("A--B"), "a-b");
    }

    #[tokio::test]
    async fn tree_ledgered_parent_link_and_rollup() {
        let path = std::env::temp_dir().join(format!("ganban_deleg_{}.db", std::process::id()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        let db = ganban_core::init_db(&path).await.unwrap();
        let base = |tool: &'static str, parent: Option<i64>, tokens: i64| ops::NewAgentAction {
            status: "applied", user_id: 1, profile_id: None, project_id: Some(1), chat_id: None,
            routine_id: None, tool, summary: "s", args_json: "{}", result_json: None,
            model: Some("m"), prompt_tokens: Some(tokens), completion_tokens: Some(tokens),
            duration_ms: Some(10), protocol_slug: None, protocol_version: None, content_hash: None,
            parent_action_id: parent, approver_id: None,
        };
        let parent_id = ops::record_agent_action(&db, base("structure_toc", None, 100)).await.unwrap();
        ops::record_agent_action(&db, base("delegate", Some(parent_id), 40)).await.unwrap();
        ops::record_agent_action(&db, base("delegate", Some(parent_id), 60)).await.unwrap();

        // Roll-up is a query (DELEGATE.md §3): the tree's cost sums over the
        // existing capacity-meter columns.
        let (children, tokens): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM agent_actions WHERE parent_action_id = ?",
        )
        .bind(parent_id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(children, 2);
        assert_eq!(tokens, 200);
    }
}
