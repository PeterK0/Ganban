//! The **librarian** (Epoch I): `ask_atlas(question)` as seen by project
//! agents is one read tool; under it, THIS executor runs its own bounded
//! multi-search loop over the Atlas collections with a designated model (the
//! `"librarian"` routing class — typically a strong profile on a remote box,
//! Epoch H) and returns a bounded, cited digest.
//!
//! Doctrine: the calling model's context stays clean (it sees one digest, not
//! N search dumps); ragrat stays a dumb, excellent index; the librarian holds
//! ONLY atlas read tools — no project data, no writes, and never `ask_atlas`
//! itself (no recursion). An unreachable remote engine is an expected state:
//! the digest becomes the profile's declared fallback note, never a turn-
//! killing error.

use ganban_core::{ops, Db};
use serde_json::{json, Value};

use crate::ollama::{ChatParams, OllamaClient, Usage};
use crate::rag::RagClient;

/// Bound the librarian's internal research loop.
const MAX_ROUNDS: usize = 6;
/// Per-round timeout — generous because the engine may be a remote box.
const ROUND_TIMEOUT_SECS: u64 = 45;
/// Cap each tool result fed back to the librarian.
const RESULT_CAP: usize = 4000;
/// Cap the digest returned to the calling agent.
const DIGEST_CAP: usize = 2400;

const LIBRARIAN_SYSTEM: &str = "You are the librarian for a shared knowledge base (the Atlas). \
Research the user's question using ONLY your tools: list the collections, search them \
(multiple searches are fine), and read full documents when a hit looks central. Then answer \
with a compact digest — at most ~250 words — citing every claim as [collection/source]. \
Answer only from what the tools returned; if the Atlas has nothing relevant, say exactly that. \
Never invent sources.";

pub struct LibrarianAnswer {
    pub digest: String,
    pub usage: Usage,
}

fn cap(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}… (truncated)")
    }
}

fn tool_def(name: &str, description: &str, parameters: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}

fn librarian_tools() -> Vec<Value> {
    vec![
        tool_def(
            "list_atlas_collections",
            "List the Atlas knowledge collections available (slug + name). Start here.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool_def(
            "search_atlas",
            "Hybrid search one Atlas collection. Returns hits as [slug/source] + excerpt.",
            json!({
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "Collection slug from list_atlas_collections." },
                    "query": { "type": "string", "description": "What to search for." }
                },
                "required": ["slug", "query"]
            }),
        ),
        tool_def(
            "read_atlas_document",
            "Read one full document by the source path a search hit cited (one entity = one document).",
            json!({
                "type": "object",
                "properties": {
                    "slug": { "type": "string" },
                    "source": { "type": "string", "description": "The source path from a search hit." }
                },
                "required": ["slug", "source"]
            }),
        ),
    ]
}

async fn run_librarian_tool(db: &Db, rag: &RagClient, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "list_atlas_collections" => {
            let cols = ops::list_atlas_collections(db).await.map_err(|e| e.to_string())?;
            if cols.is_empty() {
                return Ok("(no Atlas collections are registered)".into());
            }
            Ok(cols.iter().map(|c| format!("- {} — {}\n", c.slug, c.name)).collect())
        }
        "search_atlas" => {
            let slug = args.get("slug").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
                .ok_or_else(|| "slug (string) is required".to_string())?;
            let query = args.get("query").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
                .ok_or_else(|| "query (string) is required".to_string())?;
            // Resolve through the registry — the librarian can never name a
            // project corpus, same rule as the member HTTP routes.
            let col = ops::get_atlas_collection_by_slug(db, slug)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no Atlas collection '{slug}'"))?;
            let hits = rag.search(&format!("atlas-{}", col.slug), query, 6, None).await?;
            if hits.is_empty() {
                return Ok("(no hits)".into());
            }
            let text: String = hits
                .iter()
                .filter_map(|h| {
                    let src = h.get("source").and_then(|s| s.as_str()).unwrap_or("?");
                    h.get("text").and_then(|t| t.as_str()).map(|t| {
                        let one_line = t.split_whitespace().collect::<Vec<_>>().join(" ");
                        let excerpt: String = one_line.chars().take(300).collect();
                        format!("[{}/{}] {}\n", col.slug, src, excerpt)
                    })
                })
                .collect();
            Ok(cap(text, RESULT_CAP))
        }
        "read_atlas_document" => {
            let slug = args.get("slug").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
                .ok_or_else(|| "slug (string) is required".to_string())?;
            let source = args.get("source").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
                .ok_or_else(|| "source (string) is required".to_string())?;
            let col = ops::get_atlas_collection_by_slug(db, slug)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no Atlas collection '{slug}'"))?;
            let content = rag.corpus_document(&format!("atlas-{}", col.slug), source)?;
            Ok(cap(content, RESULT_CAP + 2000))
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

/// The librarian's declared fallback message (its routed profile's
/// `fallback_note`, else a sensible default).
async fn fallback_message(db: &Db) -> String {
    let note = match crate::routed_profile_id(db, "librarian").await {
        Some(pid) => ops::get_model_profile(db, pid).await.ok().flatten().and_then(|p| p.fallback_note),
        None => None,
    };
    note.unwrap_or_else(|| "the librarian's engine is unreachable right now — answering from the project corpus only".into())
}

/// Research `question` over the Atlas and return a cited digest. Errors are
/// folded INTO the digest (the calling agent should keep going, not crash).
pub async fn ask_atlas(
    db: &Db,
    rag: &RagClient,
    base_client: &OllamaClient,
    fallback_params: &ChatParams,
    question: &str,
) -> LibrarianAnswer {
    let mut usage = Usage::default();
    let params = crate::resolve_task_params(db, "librarian", fallback_params).await;
    let client = OllamaClient::for_params(base_client, &params);
    let tools = librarian_tools();
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": LIBRARIAN_SYSTEM }),
        json!({ "role": "user", "content": question }),
    ];

    let timeout = std::time::Duration::from_secs(ROUND_TIMEOUT_SECS);
    let mut last_content = String::new();
    for _ in 0..MAX_ROUNDS {
        let turn = match tokio::time::timeout(timeout, client.chat_once(&params, &messages, &tools)).await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) if e.contains("unreachable") => {
                // The remote box is asleep — an expected state, not an error.
                return LibrarianAnswer { digest: format!("(librarian unavailable: {})", fallback_message(db).await), usage };
            }
            _ => break, // timeout / other transport error → answer with what we have
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
            let result = run_librarian_tool(db, rag, &tc.name, &tc.arguments)
                .await
                .unwrap_or_else(|e| json!({ "error": e }).to_string());
            messages.push(json!({ "role": "tool", "content": result, "name": tc.name }));
        }
    }

    let digest = if last_content.trim().is_empty() {
        "(the librarian could not produce an answer in time — try a more specific question)".to_string()
    } else {
        cap(last_content, DIGEST_CAP)
    };
    LibrarianAnswer { digest, usage }
}
