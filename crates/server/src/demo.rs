//! Demonstration synthesis (DEMONSTRATION.md §5, Epoch R.4 Phase A).
//!
//! Turns a recorded demonstration `(steps, narration)` into a protocol
//! **draft** — deterministic steps land in the ENFORCED frontmatter, the
//! narration becomes the advisory briefing. Deliberately mostly-mechanical:
//!
//!  - **Steps → `web.steps` verbatim** (the human's clicks ARE the ground
//!    truth; nothing here re-interprets them).
//!  - **Domains DERIVED from the demo's navigations** — the egress allowlist
//!    is a fact of the recording, not an author's claim.
//!  - **Typed values → `inputs:`** — text typed during the demo is lifted to
//!    declared inputs (`{input:name}` placeholders), so one demonstration
//!    becomes a parameterized protocol, not a macro.
//!  - **Narration → briefing** (advisory; the synthesizer proposes nothing
//!    into the frontmatter that wasn't demonstrated).
//!
//! Output goes through `upsert_protocol_version` as a DRAFT — the entire
//! existing lifecycle (review in the builder, dry-run, the one activation
//! gate, immutable versions) applies unchanged. Demonstration is the fourth
//! authoring door into the same artifact, never a second artifact type.

use ganban_core::error::{AppError, Result};
use ganban_core::protocols;
use ganban_core::Db;
use serde_json::{json, Value};

/// What synthesis produced, returned to the client for immediate review.
#[derive(Debug, serde::Serialize)]
pub struct SynthesizedDraft {
    pub slug: String,
    pub version: i64,
    pub content_hash: String,
    pub frontmatter: Value,
    pub briefing: String,
}

/// Build + store a protocol draft from a recording. `steps` arrive in the
/// recorder's §3 shape; invalid recordings are REJECTED by the same
/// frontmatter validation every other authoring door goes through.
pub async fn synthesize(
    db: &Db,
    name: &str,
    steps: Vec<Value>,
    narration: &str,
    created_by: Option<i64>,
) -> Result<SynthesizedDraft> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("the demonstration needs a name".into()));
    }
    if steps.is_empty() {
        return Err(AppError::InvalidInput("the recording has no steps — nothing was demonstrated".into()));
    }

    // Domains: derived from what the demo actually visited.
    let mut domains: Vec<String> = Vec::new();
    for s in &steps {
        if s.get("op").and_then(Value::as_str) == Some("navigate") {
            if let Some(url) = s.get("url").and_then(Value::as_str) {
                let host = url
                    .strip_prefix("https://")
                    .or_else(|| url.strip_prefix("http://"))
                    .unwrap_or("")
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches("www.")
                    .to_string();
                if !host.is_empty() && !domains.contains(&host) {
                    domains.push(host);
                }
            }
        }
    }

    // Lift typed values to declared inputs: each distinct input-step value
    // becomes `{input:name}`, named from the field's own locator fingerprint.
    let mut inputs: Vec<Value> = Vec::new();
    let steps: Vec<Value> = steps
        .into_iter()
        .map(|mut s| {
            if s.get("op").and_then(Value::as_str) == Some("input") {
                let val = s.get("value").and_then(Value::as_str).unwrap_or("").to_string();
                if !val.is_empty() && !(val.starts_with("{input:") && val.ends_with('}')) {
                    let label = s
                        .get("locator")
                        .map(|l| {
                            l.get("neighbor")
                                .or_else(|| l.get("text"))
                                .and_then(Value::as_str)
                                .unwrap_or("value")
                                .to_string()
                        })
                        .unwrap_or_else(|| "value".into());
                    let mut pname = crate::delegate::slugify(&label);
                    if pname.is_empty() {
                        pname = format!("value_{}", inputs.len() + 1);
                    }
                    // Distinct fields get distinct names.
                    while inputs.iter().any(|i| i["name"] == pname.as_str()) {
                        pname.push('2');
                    }
                    inputs.push(json!({
                        "name": pname, "type": "string", "required": true,
                        "default": val, "label": format!("Demonstrated as “{val}”")
                    }));
                    s["value"] = json!(format!("{{input:{pname}}}"));
                }
            }
            s
        })
        .collect();

    // Outputs: every extract step's declared name + type.
    let outputs: Vec<Value> = steps
        .iter()
        .filter(|s| s.get("op").and_then(Value::as_str) == Some("extract"))
        .filter_map(|s| {
            let name = s.get("as").and_then(Value::as_str)?;
            let ty = s.get("type").and_then(Value::as_str).unwrap_or("string");
            let ty = if matches!(ty, "string" | "number" | "date") { ty } else { "string" };
            Some(json!({ "name": name, "type": ty, "required": true }))
        })
        .collect();

    let slug = {
        let s = crate::delegate::slugify(name);
        if s.is_empty() { "demonstration".to_string() } else { s }
    };
    let task_class = format!("user.web-{slug}");

    let mut fm = json!({
        "protocol": 1,
        "task_class": task_class,
        "name": name,
        "trigger": { "kind": "manual" },
        // The replay engine executes the steps; the engine block routes only
        // the HEAL fallback (free tier by default — model on miss, not per run).
        "engine": { "runner": "ollama" },
        "web": { "domains": domains, "steps": steps },
        "heal": { "allow": "auto", "budget_cents": 20 }
    });
    if !inputs.is_empty() {
        fm["inputs"] = json!(inputs);
    }
    if !outputs.is_empty() {
        fm["web"]["outputs"] = json!(outputs);
    }
    let fm_str = fm.to_string();

    let briefing = if narration.trim().is_empty() {
        "## Briefing\n\n(no narration recorded)\n".to_string()
    } else {
        format!(
            "## Briefing\n\n{}\n\n## Acceptance\n\n_Review: does the narration above state what a successful run must yield? Edit before activating._\n",
            narration.trim()
        )
    };

    // The same door as every other author: validated, stored as a DRAFT.
    let (_pid, version, content_hash) =
        protocols::upsert_protocol_version(db, &slug, name, &fm_str, &briefing, created_by, false).await?;
    Ok(SynthesizedDraft {
        slug,
        version,
        content_hash,
        frontmatter: fm,
        briefing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_demo_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    fn loc(text: &str) -> Value {
        json!({ "css": "td.v", "text": text, "neighbor": text })
    }

    /// The R.4 loop's mechanical half: a recording becomes a validated DRAFT —
    /// domains derived, typed values lifted to inputs, extracts to outputs,
    /// narration in the briefing — and enters the normal gate (status draft,
    /// nothing active).
    #[tokio::test]
    async fn a_recording_synthesizes_into_a_parameterized_draft() {
        let db = test_db("synth").await;
        let steps = vec![
            json!({ "op": "navigate", "url": "https://www.balticexchange.com/en/data/indices.html" }),
            json!({ "op": "wait_for", "locator": loc("BDI"), "timeout_ms": 8000 }),
            json!({ "op": "input", "locator": loc("Vessel class"), "value": "capesize" }),
            json!({ "op": "click", "locator": loc("Search") }),
            json!({ "op": "extract", "locator": loc("BDI"), "as": "index_value", "type": "number" }),
        ];
        let d = synthesize(&db, "Baltic index pull", steps, "Grab the BDI after filtering to capesize.", Some(1))
            .await
            .unwrap();

        assert_eq!(d.slug, "baltic-index-pull");
        assert_eq!(d.version, 1);
        // Domains derived from the demo (www. stripped), never author-claimed.
        assert_eq!(d.frontmatter["web"]["domains"], json!(["balticexchange.com"]));
        // The typed value was lifted: a parameterized protocol, not a macro.
        assert_eq!(d.frontmatter["inputs"][0]["name"], "vessel-class");
        assert_eq!(d.frontmatter["web"]["steps"][2]["value"], "{input:vessel-class}");
        // Extraction became a typed output.
        assert_eq!(d.frontmatter["web"]["outputs"][0]["name"], "index_value");
        assert!(d.briefing.contains("Grab the BDI"));

        // It is a DRAFT in the normal lifecycle — present, not active.
        let (rec, ver) = {
            let rec = ganban_core::protocols::get_protocol(&db, "baltic-index-pull").await.unwrap().unwrap();
            let ver = ganban_core::protocols::get_version(&db, rec.id, 1).await.unwrap().unwrap();
            (rec, ver)
        };
        assert_eq!(rec.active_version, None, "demonstration authors drafts, never active protocols");
        assert_eq!(ver.status, "draft");
        assert_eq!(ver.content_hash, d.content_hash);
    }

    /// A recording that navigated somewhere its own steps don't cover, or
    /// with garbage ops, is rejected by the SAME validation as every other
    /// authoring door — synthesis grants no bypass.
    #[tokio::test]
    async fn synthesis_rejects_what_validation_rejects() {
        let db = test_db("reject").await;
        let bad = vec![
            json!({ "op": "navigate", "url": "https://a.com/" }),
            json!({ "op": "exec_shell", "cmd": "rm -rf /" }),
        ];
        let err = synthesize(&db, "Evil", bad, "", None).await.unwrap_err().to_string();
        assert!(err.contains("unknown"), "{err}");

        // A recording that never navigated anywhere derives NO domains — and
        // an empty egress allowlist is refused, not defaulted.
        let nowhere = vec![json!({ "op": "click", "locator": json!({ "css": "a" }) })];
        let err = synthesize(&db, "Nowhere", nowhere, "", None).await.unwrap_err().to_string();
        assert!(err.contains("web.domains is empty"), "{err}");

        assert!(synthesize(&db, "Empty", vec![], "", None).await.is_err());
    }
}
