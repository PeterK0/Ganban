//! Protocols — the repeatability artifact (Epoch R.1, docs/design/PROTOCOLS.md).
//!
//! A protocol has two natures and only one is trusted: the **enforced
//! frontmatter** (task class, trigger, engine, tools, budget, limits —
//! schema-validated, executed by the system) and the **advisory briefing**
//! (prose the model reads). Guarantees come only from the frontmatter.
//!
//! Storage discipline (PROTOCOLS.md §2):
//! - The DATABASE is canonical; the `.md` file is interchange. Import
//!   re-validates through this module — no path where hand-written YAML
//!   skips validation.
//! - Versions are IMMUTABLE. Editing creates version N+1 as a draft;
//!   rollback moves `active_version`; nothing is edited in place.
//! - Every run records provenance (`slug`, `version`, `content_hash`) on the
//!   `agent_actions` ledger — "what exactly produced this result" is
//!   answerable forever.
//!
//! Validation doctrine: **rejects, never coerces** (webhook doctrine).
//! Unknown fields, unknown runners, out-of-range budgets → refused with a
//! reason, not silently dropped.

use crate::db::Db;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Frontmatter v1 — the enforced part, as stored in protocol_versions
// ---------------------------------------------------------------------------

/// Frontmatter schema v1. `deny_unknown_fields` everywhere IS the
/// reject-never-coerce doctrine: a field this schema doesn't know is an
/// error, not a passenger.
///
/// Tool-name validation against the vetted registry is the SERVER's job (core
/// doesn't know tool names); this schema validates shape and ranges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontmatterV1 {
    /// Format version of this schema. Must be 1.
    pub protocol: u32,
    /// Task class this protocol serves. System classes are a Rust-reviewed
    /// allowlist (checked server-side against ROUTING_CLASSES); user classes
    /// are `user.*`-namespaced.
    pub task_class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub trigger: TriggerV1,
    pub engine: EngineV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Declared, typed parameters (PROTOCOLS.md §1) — the gallery's install
    /// wizard IS these declarations rendered as questions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<InputV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<LimitsV1>,
    /// Demonstration protocols (DEMONSTRATION.md §4): frozen replay steps +
    /// the egress allowlist DERIVED from the demo. Enforced — the replay
    /// engine executes these steps; page content can never add to them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<WebV1>,
    /// Locator-miss policy (DEMONSTRATION.md §7): budgeted LLM heal that can
    /// only PROPOSE version N+1, never mutate the active version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heal: Option<HealV1>,
}

/// The `web:` section — what a demonstrated protocol is allowed to touch and
/// the exact steps its replay executes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebV1 {
    /// Egress allowlist, derived from the demonstration. Enforced at the
    /// network layer by the replay container (Phase B); validated here.
    pub domains: Vec<String>,
    /// The frozen action list (§3 shapes). Validated structurally: known ops,
    /// locator bundles as objects, navigate URLs inside `domains`.
    pub steps: Vec<serde_json::Value>,
    /// A `web_sessions` NAME (never a value). v1: must be null — the session
    /// registry ships with Phase D1; rejecting now keeps imports honest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Typed extraction outputs the replay must yield.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<WebOutputV1>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebOutputV1 {
    pub name: String,
    /// "string" | "number" | "date"
    pub r#type: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealV1 {
    /// "ask" | "auto" | "never" — forced to "ask" when a session is attached.
    pub allow: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerV1 {
    /// "manual" | "routine" | "rule". Non-manual triggers cannot activate
    /// until they pass a dry-run (PROTOCOLS.md §3) — enforced at activation,
    /// not here.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineV1 {
    /// "ollama" | "pi" | "remote". Frozen v1 contract: model NAMES only,
    /// never API keys (keys live with pi / the engine, not in protocol rows).
    pub runner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputV1 {
    pub name: String,
    /// "string" | "int" | "bool" | "folder_path" | "profile"
    #[serde(rename = "type")]
    pub input_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_run_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_cents: Option<i64>,
    /// "day" | "week" | "month"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<String>,
    /// "downgrade" | "refuse"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_exceeded: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitsV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_clock_s: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<i64>,
}

/// Validate a frontmatter JSON string against schema v1. Rejects, never
/// coerces: unknown fields, unknown enum values, out-of-range budgets/limits
/// are all refusals with a reason.
pub fn validate_frontmatter(json_str: &str) -> Result<FrontmatterV1> {
    let fm: FrontmatterV1 = serde_json::from_str(json_str)
        .map_err(|e| AppError::InvalidInput(format!("frontmatter rejected: {e}")))?;
    if fm.protocol != 1 {
        return Err(AppError::InvalidInput(format!(
            "frontmatter rejected: unsupported protocol format version {} (this build understands 1)",
            fm.protocol
        )));
    }
    if fm.task_class.trim().is_empty() {
        return Err(AppError::InvalidInput("frontmatter rejected: task_class is empty".into()));
    }
    match fm.trigger.kind.as_str() {
        "manual" | "routine" | "rule" => {}
        other => {
            return Err(AppError::InvalidInput(format!(
                "frontmatter rejected: unknown trigger.kind '{other}' (manual|routine|rule)"
            )))
        }
    }
    match fm.engine.runner.as_str() {
        "ollama" | "pi" | "remote" => {}
        other => {
            return Err(AppError::InvalidInput(format!(
                "frontmatter rejected: unknown engine.runner '{other}' (ollama|pi|remote)"
            )))
        }
    }
    if let Some(b) = &fm.budget {
        for (label, v) in [("per_run_cents", b.per_run_cents), ("period_cents", b.period_cents)] {
            if let Some(v) = v {
                if !(0..=1_000_000).contains(&v) {
                    return Err(AppError::InvalidInput(format!(
                        "frontmatter rejected: budget.{label} {v} out of range [0, 1000000]"
                    )));
                }
            }
        }
        if let Some(p) = &b.period {
            if !matches!(p.as_str(), "day" | "week" | "month") {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: unknown budget.period '{p}' (day|week|month)"
                )));
            }
        }
        if let Some(o) = &b.on_exceeded {
            if !matches!(o.as_str(), "downgrade" | "refuse") {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: unknown budget.on_exceeded '{o}' (downgrade|refuse)"
                )));
            }
        }
    }
    if let Some(l) = &fm.limits {
        if let Some(w) = l.wall_clock_s {
            if !(1..=3600).contains(&w) {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: limits.wall_clock_s {w} out of range [1, 3600]"
                )));
            }
        }
        if let Some(r) = l.max_rounds {
            if !(1..=64).contains(&r) {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: limits.max_rounds {r} out of range [1, 64]"
                )));
            }
        }
    }
    if let Some(inputs) = &fm.inputs {
        for i in inputs {
            if i.name.trim().is_empty() {
                return Err(AppError::InvalidInput("frontmatter rejected: an input has an empty name".into()));
            }
            if !matches!(i.input_type.as_str(), "string" | "int" | "bool" | "folder_path" | "profile") {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: unknown input type '{}' for '{}' (string|int|bool|folder_path|profile)",
                    i.input_type, i.name
                )));
            }
        }
    }
    if let Some(web) = &fm.web {
        validate_web(web)?;
    }
    if let Some(heal) = &fm.heal {
        if !matches!(heal.allow.as_str(), "ask" | "auto" | "never") {
            return Err(AppError::InvalidInput(format!(
                "frontmatter rejected: unknown heal.allow '{}' (ask|auto|never)",
                heal.allow
            )));
        }
        if let Some(b) = heal.budget_cents {
            if !(0..=10_000).contains(&b) {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: heal.budget_cents {b} out of range [0, 10000]"
                )));
            }
        }
        // A session forces heal to "ask" — a model never improvises on a
        // logged-in page unattended (DEMONSTRATION.md §7/§8).
        if fm.web.as_ref().and_then(|w| w.session.as_ref()).is_some() && heal.allow != "ask" {
            return Err(AppError::InvalidInput(
                "frontmatter rejected: a protocol with a session must use heal.allow = 'ask'".into(),
            ));
        }
    }
    Ok(fm)
}

/// The replay ops this build can execute. Validation rejects anything else —
/// a stored demonstration is always replayable on the build that accepted it.
pub const WEB_OPS: &[&str] = &["navigate", "wait_for", "click", "input", "extract"];

fn validate_web(web: &WebV1) -> Result<()> {
    if web.domains.is_empty() {
        return Err(AppError::InvalidInput(
            "frontmatter rejected: web.domains is empty — the egress allowlist is derived from the demonstration and must name at least one domain".into(),
        ));
    }
    for d in &web.domains {
        let d = d.trim();
        if d.is_empty() || d.contains('/') || d.contains("://") {
            return Err(AppError::InvalidInput(format!(
                "frontmatter rejected: web.domains entry '{d}' is not a bare hostname"
            )));
        }
    }
    if web.session.is_some() {
        // Phase D1 (the web_sessions registry) hasn't shipped — reject, never
        // silently accept a reference that nothing can resolve.
        return Err(AppError::InvalidInput(
            "frontmatter rejected: web.session is not supported yet (the session registry ships with Phase D1)".into(),
        ));
    }
    if web.steps.is_empty() {
        return Err(AppError::InvalidInput("frontmatter rejected: web.steps is empty".into()));
    }
    for (i, s) in web.steps.iter().enumerate() {
        let op = s
            .get("op")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::InvalidInput(format!("frontmatter rejected: web.steps[{i}] has no 'op'")))?;
        if !WEB_OPS.contains(&op) {
            return Err(AppError::InvalidInput(format!(
                "frontmatter rejected: web.steps[{i}] op '{op}' unknown ({})",
                WEB_OPS.join("|")
            )));
        }
        match op {
            "navigate" => {
                let url = s.get("url").and_then(serde_json::Value::as_str).ok_or_else(|| {
                    AppError::InvalidInput(format!("frontmatter rejected: web.steps[{i}] navigate has no url"))
                })?;
                // The allowlist must cover every navigation target — domains
                // are DERIVED from the demo, so a mismatch is a forgery.
                let host = url
                    .strip_prefix("https://")
                    .or_else(|| url.strip_prefix("http://"))
                    .unwrap_or("")
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .split(':')
                    .next()
                    .unwrap_or("");
                let covered = web
                    .domains
                    .iter()
                    .any(|d| host == d || host.ends_with(&format!(".{d}")));
                if !covered {
                    return Err(AppError::InvalidInput(format!(
                        "frontmatter rejected: web.steps[{i}] navigates to '{host}', which is outside web.domains"
                    )));
                }
            }
            "wait_for" | "click" | "input" | "extract" => {
                if !s.get("locator").map(serde_json::Value::is_object).unwrap_or(false) {
                    return Err(AppError::InvalidInput(format!(
                        "frontmatter rejected: web.steps[{i}] ({op}) needs a locator bundle object"
                    )));
                }
                if op == "extract" && s.get("as").and_then(serde_json::Value::as_str).map(str::trim).map_or(true, str::is_empty) {
                    return Err(AppError::InvalidInput(format!(
                        "frontmatter rejected: web.steps[{i}] extract needs 'as' (the output name)"
                    )));
                }
            }
            _ => unreachable!(),
        }
    }
    if let Some(outputs) = &web.outputs {
        for o in outputs {
            if o.name.trim().is_empty() {
                return Err(AppError::InvalidInput("frontmatter rejected: a web.outputs entry has an empty name".into()));
            }
            if !matches!(o.r#type.as_str(), "string" | "number" | "date") {
                return Err(AppError::InvalidInput(format!(
                    "frontmatter rejected: unknown web output type '{}' for '{}' (string|number|date)",
                    o.r#type, o.name
                )));
            }
        }
    }
    Ok(())
}

/// The lockfile property: a stable content hash over frontmatter + briefing.
/// Ledger rows carry it so "what exactly produced this result" survives even
/// a (hypothetical) database surgery on the version rows.
pub fn content_hash(frontmatter_json: &str, briefing_md: &str) -> String {
    let mut h = Sha256::new();
    h.update(frontmatter_json.as_bytes());
    h.update([0u8]); // domain separator
    h.update(briefing_md.as_bytes());
    format!("sha256:{:x}", h.finalize())
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ProtocolRecord {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub task_class: String,
    /// The version number (protocol-scoped, not row id) currently active.
    /// NULL = no active version (the task class falls back to defaults).
    pub active_version: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ProtocolVersion {
    pub id: i64,
    pub protocol_id: i64,
    pub version: i64,
    pub frontmatter_json: String,
    pub briefing_md: String,
    pub content_hash: String,
    /// "draft" | "dryrun" | "approved" | "retired"
    pub status: String,
    pub created_by: Option<i64>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/// Create a new version of a protocol (creating the protocol row if the slug
/// is new). Versions are immutable — this is the ONLY way to change a
/// protocol's content. Returns (protocol_id, version, content_hash).
///
/// `activate`: manual-trigger protocols may activate directly (the human is
/// the trigger and the reviewer, PROTOCOLS.md §3). Non-manual triggers are
/// REFUSED activation here until the R.2 dry-run harness exists — they can
/// be stored as drafts only.
pub async fn upsert_protocol_version(
    db: &Db,
    slug: &str,
    name: &str,
    frontmatter_json: &str,
    briefing_md: &str,
    created_by: Option<i64>,
    activate: bool,
) -> Result<(i64, i64, String)> {
    let fm = validate_frontmatter(frontmatter_json)?;
    if activate && fm.trigger.kind != "manual" {
        return Err(AppError::InvalidInput(format!(
            "a '{}'-triggered protocol cannot activate without a passed dry-run (the dry-run harness is not built yet); save it as a draft",
            fm.trigger.kind
        )));
    }
    let slug = slug.trim();
    if slug.is_empty() {
        return Err(AppError::InvalidInput("protocol slug is empty".into()));
    }

    // Protocol row (slug is the stable identity).
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM protocols WHERE slug = ?")
        .bind(slug)
        .fetch_optional(db)
        .await?;
    let protocol_id = match existing {
        Some(id) => {
            sqlx::query("UPDATE protocols SET name = ?, task_class = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(name)
                .bind(&fm.task_class)
                .bind(id)
                .execute(db)
                .await?;
            id
        }
        None => sqlx::query("INSERT INTO protocols (slug, name, task_class) VALUES (?, ?, ?)")
            .bind(slug)
            .bind(name)
            .bind(&fm.task_class)
            .execute(db)
            .await?
            .last_insert_rowid(),
    };

    // Next immutable version.
    let next: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(version) FROM protocol_versions WHERE protocol_id = ?",
    )
    .bind(protocol_id)
    .fetch_one(db)
    .await?
    .unwrap_or(0)
        + 1;
    let hash = content_hash(frontmatter_json, briefing_md);
    let status = if activate { "approved" } else { "draft" };
    sqlx::query(
        "INSERT INTO protocol_versions (protocol_id, version, frontmatter_json, briefing_md, content_hash, status, created_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(protocol_id)
    .bind(next)
    .bind(frontmatter_json)
    .bind(briefing_md)
    .bind(&hash)
    .bind(status)
    .bind(created_by)
    .execute(db)
    .await?;

    if activate {
        sqlx::query("UPDATE protocols SET active_version = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(next)
            .bind(protocol_id)
            .execute(db)
            .await?;
    }
    Ok((protocol_id, next, hash))
}

/// Deactivate a protocol (active_version → NULL). The versions remain — a
/// rollback is `set active_version` to an approved one, never a delete.
pub async fn deactivate_protocol(db: &Db, slug: &str) -> Result<()> {
    sqlx::query("UPDATE protocols SET active_version = NULL, updated_at = datetime('now') WHERE slug = ?")
        .bind(slug)
        .execute(db)
        .await?;
    Ok(())
}

/// The active (approved) protocol + version for a task class, if one exists.
/// This is dispatch's read path: `resolve_protocol` calls this FIRST, before
/// the legacy `ai_routing` fallback.
pub async fn active_protocol_for_task_class(
    db: &Db,
    task_class: &str,
) -> Result<Option<(ProtocolRecord, ProtocolVersion)>> {
    let rec: Option<ProtocolRecord> = sqlx::query_as(
        "SELECT * FROM protocols WHERE task_class = ? AND active_version IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(task_class)
    .fetch_optional(db)
    .await?;
    let Some(rec) = rec else { return Ok(None) };
    let ver: Option<ProtocolVersion> = sqlx::query_as(
        "SELECT * FROM protocol_versions WHERE protocol_id = ? AND version = ? AND status = 'approved'",
    )
    .bind(rec.id)
    .bind(rec.active_version)
    .fetch_optional(db)
    .await?;
    Ok(ver.map(|v| (rec, v)))
}

/// All protocols with their active versions (for the settings/list surface).
pub async fn list_protocols(db: &Db) -> Result<Vec<(ProtocolRecord, Option<ProtocolVersion>)>> {
    let recs: Vec<ProtocolRecord> = sqlx::query_as("SELECT * FROM protocols ORDER BY slug").fetch_all(db).await?;
    let mut out = Vec::with_capacity(recs.len());
    for rec in recs {
        let ver: Option<ProtocolVersion> = match rec.active_version {
            Some(v) => {
                sqlx::query_as("SELECT * FROM protocol_versions WHERE protocol_id = ? AND version = ?")
                    .bind(rec.id)
                    .bind(v)
                    .fetch_optional(db)
                    .await?
            }
            None => None,
        };
        out.push((rec, ver));
    }
    Ok(out)
}

/// One protocol by slug.
pub async fn get_protocol(db: &Db, slug: &str) -> Result<Option<ProtocolRecord>> {
    Ok(sqlx::query_as("SELECT * FROM protocols WHERE slug = ?").bind(slug).fetch_optional(db).await?)
}

/// A protocol's full version history, newest first.
pub async fn list_versions(db: &Db, protocol_id: i64) -> Result<Vec<ProtocolVersion>> {
    Ok(sqlx::query_as("SELECT * FROM protocol_versions WHERE protocol_id = ? ORDER BY version DESC")
        .bind(protocol_id)
        .fetch_all(db)
        .await?)
}

/// One specific version.
pub async fn get_version(db: &Db, protocol_id: i64, version: i64) -> Result<Option<ProtocolVersion>> {
    Ok(sqlx::query_as("SELECT * FROM protocol_versions WHERE protocol_id = ? AND version = ?")
        .bind(protocol_id)
        .bind(version)
        .fetch_optional(db)
        .await?)
}

/// The R.2 lifecycle gate, one legal transition at a time (PROTOCOLS.md §3):
/// `draft ─(dry-run passes)─► dryrun ─(owner approves)─► approved/active`.
/// A passed dry-run marks the version `dryrun`; only a `draft` may be marked.
pub async fn mark_version_dryrun(db: &Db, protocol_id: i64, version: i64) -> Result<()> {
    let v = get_version(db, protocol_id, version)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("version {version} not found")))?;
    if v.status != "draft" {
        // Re-running a dry-run on a dryrun/approved version is fine — it just
        // doesn't change the status (no downgrade, no sideways move).
        return Ok(());
    }
    sqlx::query("UPDATE protocol_versions SET status = 'dryrun' WHERE protocol_id = ? AND version = ?")
        .bind(protocol_id)
        .bind(version)
        .execute(db)
        .await?;
    Ok(())
}

/// Owner approval: set a version approved + active. Eligibility (§3):
/// a MANUAL-trigger version may activate from any non-retired status (the
/// human is the trigger and the reviewer); a routine/rule version must have
/// PASSED a dry-run (status `dryrun`) first. The previously-active version
/// stays `approved` in history — rollback is re-activating it.
pub async fn approve_and_activate(db: &Db, slug: &str, version: i64) -> Result<()> {
    let rec = get_protocol(db, slug).await?.ok_or_else(|| AppError::NotFound(format!("protocol '{slug}' not found")))?;
    let ver = get_version(db, rec.id, version)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("version {version} not found")))?;
    if ver.status == "retired" {
        return Err(AppError::InvalidInput(format!("version {version} is retired — create a new version instead")));
    }
    let fm = validate_frontmatter(&ver.frontmatter_json)?;
    if fm.trigger.kind != "manual" && !matches!(ver.status.as_str(), "dryrun" | "approved") {
        return Err(AppError::InvalidInput(format!(
            "a '{}'-triggered version must pass a dry-run before activation (status is '{}')",
            fm.trigger.kind, ver.status
        )));
    }
    sqlx::query("UPDATE protocol_versions SET status = 'approved' WHERE protocol_id = ? AND version = ?")
        .bind(rec.id)
        .bind(version)
        .execute(db)
        .await?;
    sqlx::query("UPDATE protocols SET active_version = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(version)
        .bind(rec.id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm(task_class: &str, runner: &str) -> String {
        serde_json::json!({
            "protocol": 1,
            "task_class": task_class,
            "trigger": { "kind": "manual" },
            "engine": { "runner": runner }
        })
        .to_string()
    }

    #[test]
    fn validation_rejects_unknown_fields_never_coerces() {
        let bad = r#"{"protocol":1,"task_class":"x","trigger":{"kind":"manual"},"engine":{"runner":"ollama"},"surprise":true}"#;
        let err = validate_frontmatter(bad).unwrap_err().to_string();
        assert!(err.contains("rejected"), "unknown top-level field must be refused: {err}");

        let bad_nested = r#"{"protocol":1,"task_class":"x","trigger":{"kind":"manual","cron":"* *"},"engine":{"runner":"ollama"}}"#;
        assert!(validate_frontmatter(bad_nested).is_err(), "unknown nested field must be refused");
    }

    #[test]
    fn validation_rejects_bad_enums_and_ranges() {
        let bad_runner = r#"{"protocol":1,"task_class":"x","trigger":{"kind":"manual"},"engine":{"runner":"cloud"}}"#;
        assert!(validate_frontmatter(bad_runner).is_err());

        let bad_trigger = r#"{"protocol":1,"task_class":"x","trigger":{"kind":"cron"},"engine":{"runner":"pi"}}"#;
        assert!(validate_frontmatter(bad_trigger).is_err());

        let bad_budget = r#"{"protocol":1,"task_class":"x","trigger":{"kind":"manual"},"engine":{"runner":"pi"},"budget":{"per_run_cents":-5}}"#;
        assert!(validate_frontmatter(bad_budget).is_err());

        let bad_version = r#"{"protocol":2,"task_class":"x","trigger":{"kind":"manual"},"engine":{"runner":"pi"}}"#;
        assert!(validate_frontmatter(bad_version).is_err());

        assert!(validate_frontmatter(&fm("structure_toc", "ollama")).is_ok());
    }

    #[test]
    fn content_hash_is_stable_and_input_sensitive() {
        let a = content_hash("{}", "brief");
        assert_eq!(a, content_hash("{}", "brief"), "same content, same hash");
        assert_ne!(a, content_hash("{}", "brief2"));
        assert_ne!(a, content_hash("{} ", "brief"));
        assert!(a.starts_with("sha256:"));
    }

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_proto_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn versions_are_immutable_and_activation_is_a_gate() {
        let db = test_db("gate").await;

        // v1: manual → may activate directly.
        let (pid, v1, h1) = upsert_protocol_version(&db, "structure_toc", "Auto ToC", &fm("structure_toc", "ollama"), "read the contents page", None, true)
            .await
            .unwrap();
        assert_eq!(v1, 1);

        // Editing NEVER mutates v1 — it creates v2.
        let (pid2, v2, h2) = upsert_protocol_version(&db, "structure_toc", "Auto ToC", &fm("structure_toc", "pi"), "read the contents page", None, true)
            .await
            .unwrap();
        assert_eq!(pid, pid2);
        assert_eq!(v2, 2);
        assert_ne!(h1, h2, "different engine, different content hash");

        // The active version resolves; v1 is still stored, untouched.
        let (rec, ver) = active_protocol_for_task_class(&db, "structure_toc").await.unwrap().unwrap();
        assert_eq!(rec.active_version, Some(2));
        assert_eq!(ver.version, 2);
        let v1_row: ProtocolVersion = sqlx::query_as("SELECT * FROM protocol_versions WHERE protocol_id = ? AND version = 1")
            .bind(pid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(v1_row.content_hash, h1);

        // A non-manual trigger cannot activate without the dry-run harness.
        let routine_fm = serde_json::json!({
            "protocol": 1, "task_class": "structure_toc",
            "trigger": { "kind": "routine" }, "engine": { "runner": "ollama" }
        })
        .to_string();
        let err = upsert_protocol_version(&db, "structure_toc", "Auto ToC", &routine_fm, "", None, true)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("dry-run"), "non-manual activation must be refused: {err}");
        // …but it may be stored as a draft.
        let (_, v3, _) = upsert_protocol_version(&db, "structure_toc", "Auto ToC", &routine_fm, "", None, false)
            .await
            .unwrap();
        assert_eq!(v3, 3);
        let (rec, _) = active_protocol_for_task_class(&db, "structure_toc").await.unwrap().unwrap();
        assert_eq!(rec.active_version, Some(2), "draft must not steal activation");

        // Deactivate: versions remain, resolution falls through.
        deactivate_protocol(&db, "structure_toc").await.unwrap();
        assert!(active_protocol_for_task_class(&db, "structure_toc").await.unwrap().is_none());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM protocol_versions WHERE protocol_id = ?")
            .bind(pid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 3, "deactivation never deletes versions");
    }

    #[tokio::test]
    async fn lifecycle_draft_dryrun_approved() {
        let db = test_db("lifecycle").await;
        let routine_fm = serde_json::json!({
            "protocol": 1, "task_class": "summarize",
            "trigger": { "kind": "routine" }, "engine": { "runner": "ollama" }
        })
        .to_string();
        // A routine-trigger draft cannot activate directly…
        let (pid, v, _) = upsert_protocol_version(&db, "summarize", "Sum", &routine_fm, "", None, false).await.unwrap();
        let err = approve_and_activate(&db, "summarize", v).await.unwrap_err().to_string();
        assert!(err.contains("dry-run"), "non-manual draft must be refused: {err}");
        // …until it passes a dry-run.
        mark_version_dryrun(&db, pid, v).await.unwrap();
        approve_and_activate(&db, "summarize", v).await.unwrap();
        let (rec, ver) = active_protocol_for_task_class(&db, "summarize").await.unwrap().unwrap();
        assert_eq!(rec.active_version, Some(v));
        assert_eq!(ver.status, "approved");
        // Re-running a dry-run on an approved version never downgrades it.
        mark_version_dryrun(&db, pid, v).await.unwrap();
        assert_eq!(get_version(&db, pid, v).await.unwrap().unwrap().status, "approved");
    }

    /// DEMONSTRATION.md §4: the `web:` section is ENFORCED — validation
    /// rejects forged domains, unknown ops, session references (pre-D1),
    /// and heal-with-session that isn't 'ask'. Never coerces.
    #[test]
    fn web_frontmatter_rejects_never_coerces() {
        let base = |web: serde_json::Value, heal: Option<serde_json::Value>| {
            let mut fm = serde_json::json!({
                "protocol": 1, "task_class": "user.web-bdi",
                "trigger": { "kind": "manual" }, "engine": { "runner": "ollama" },
                "web": web
            });
            if let Some(h) = heal { fm["heal"] = h; }
            fm.to_string()
        };
        let loc = serde_json::json!({ "css": "td.v", "text": "BDI" });

        // A well-formed demonstration validates.
        let ok = base(serde_json::json!({
            "domains": ["balticexchange.com"],
            "steps": [
                { "op": "navigate", "url": "https://www.balticexchange.com/indices" },
                { "op": "wait_for", "locator": loc, "timeout_ms": 8000 },
                { "op": "extract", "locator": loc, "as": "index_value", "type": "number" }
            ],
            "outputs": [{ "name": "index_value", "type": "number", "required": true }]
        }), Some(serde_json::json!({ "allow": "auto", "budget_cents": 20 })));
        validate_frontmatter(&ok).unwrap();

        // Navigating outside the derived allowlist is a forgery — rejected.
        let bad = base(serde_json::json!({
            "domains": ["balticexchange.com"],
            "steps": [{ "op": "navigate", "url": "https://pastebin.com/x" }]
        }), None);
        let err = validate_frontmatter(&bad).unwrap_err().to_string();
        assert!(err.contains("outside web.domains"), "{err}");

        // Unknown op — rejected with the allowlist named.
        let bad = base(serde_json::json!({
            "domains": ["a.com"],
            "steps": [{ "op": "exec_js", "locator": loc }]
        }), None);
        assert!(validate_frontmatter(&bad).unwrap_err().to_string().contains("unknown"));

        // Session references are refused until the registry exists (D1).
        let bad = base(serde_json::json!({
            "domains": ["a.com"],
            "steps": [{ "op": "navigate", "url": "https://a.com/" }],
            "session": "my-login"
        }), None);
        assert!(validate_frontmatter(&bad).unwrap_err().to_string().contains("Phase D1"));

        // Unknown keys inside web are rejected (deny_unknown_fields).
        let bad = base(serde_json::json!({
            "domains": ["a.com"], "steps": [{ "op": "navigate", "url": "https://a.com/" }],
            "allow_everything": true
        }), None);
        assert!(validate_frontmatter(&bad).is_err());
    }
}
