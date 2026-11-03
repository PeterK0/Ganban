//! The native rules engine (Epoch M(a)).
//!
//! Consumes domain events emitted by `core::ops`, matches them against the
//! owner's enabled rules, and runs each matching rule's action via `ops` — under
//! existing scoping, with the action's own writes SUPPRESSED so a rule can't
//! trip another rule (one-hop only). Every firing is appended to the
//! agent-action ledger, so it shows up in the Activity view.

use std::sync::OnceLock;

use std::time::{Duration, Instant};

use ganban_core::domain_events::{self, DomainEvent};
use ganban_core::models::{CreateCommentInput, Rule, UpdateTaskInput};
use ganban_core::{auth, ops, Db};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast;

/// Broadcast of domain events: created once (the core sink forwards into it).
static EVENT_TX: OnceLock<broadcast::Sender<DomainEvent>> = OnceLock::new();

/// Re-read the (tiny) rule set at most this often — so a bulk write burst can't
/// fan out into one SELECT per event. Up to this much staleness on a rule edit
/// is fine for automations.
const RULE_CACHE_TTL: Duration = Duration::from_secs(2);

/// A rule's trigger spec (parsed from `trigger_json`). Absent filters match anything.
#[derive(Debug, Deserialize)]
struct Trigger {
    kind: String,
    #[serde(default)]
    project_id: Option<i64>,
    /// For task.status_changed: the NEW status (e.g. "Blocked").
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    prev_status: Option<String>,
    /// For kind "schedule": the cadence ("30 min" / "2 hours" / "07:00" daily
    /// — same strict grammar as Oracle schedules, same parser).
    #[serde(default)]
    every: Option<String>,
}

/// A rule's action spec (parsed from `action_json`).
#[derive(Debug, Deserialize)]
struct Action {
    /// "comment" | "set_task_field" | "notify"
    kind: String,
    #[serde(default)]
    text: Option<String>,
    /// For set_task_field: "priority" | "status".
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    value: Option<String>,
}

impl Trigger {
    fn matches(&self, ev: &DomainEvent) -> bool {
        if self.kind != ev.kind {
            return false;
        }
        if let Some(p) = self.project_id {
            if ev.project_id != Some(p) {
                return false;
            }
        }
        if let Some(s) = &self.status {
            if ev.data.get("status").and_then(Value::as_str) != Some(s.as_str()) {
                return false;
            }
        }
        if let Some(s) = &self.prev_status {
            if ev.data.get("prev_status").and_then(Value::as_str) != Some(s.as_str()) {
                return false;
            }
        }
        true
    }
}

/// The task an action targets, where one applies: task.* events carry it in
/// `entity_id`; comment.created carries it in `data.task_id`.
fn target_task(ev: &DomainEvent) -> Option<i64> {
    match ev.kind.as_str() {
        "task.created" | "task.status_changed" => Some(ev.entity_id),
        "comment.created" => ev.data.get("task_id").and_then(Value::as_i64),
        _ => None,
    }
}

/// Register the core sink and spawn the drain task — EXACTLY ONCE for the
/// process, inside the OnceLock init. Calling it again (e.g. a daemon restart in
/// the desktop app) is a no-op: no second drainer, no re-subscribe race. The
/// single task lives for the process and drains the global broadcast; it holds
/// the first `db` (a stable SQLite pool for the life of the app).
pub fn spawn_engine(db: Db) {
    EVENT_TX.get_or_init(move || {
        let (tx, _rx0) = broadcast::channel(1024);
        let fwd = tx.clone();
        domain_events::set_sink(move |ev| {
            let _ = fwd.send(ev);
        });
        let mut rx = tx.subscribe();
        tokio::spawn(async move {
            // Tiny TTL cache so a write burst doesn't SELECT the rule set per event.
            let mut cache: Option<(Instant, Vec<Rule>)> = None;
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let fresh = cache.as_ref().is_some_and(|(at, _)| at.elapsed() < RULE_CACHE_TTL);
                        if !fresh {
                            match ops::list_rules(&db).await {
                                Ok(r) => cache = Some((Instant::now(), r)),
                                Err(e) => {
                                    tracing::error!("rules: list failed: {e}");
                                    continue;
                                }
                            }
                        }
                        if let Some((_, rules)) = cache.as_ref() {
                            run_for_event(&db, &ev, rules).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Best-effort, like the SSE pulse — but surface the drop.
                        tracing::warn!("rules: event stream lagged — {n} events dropped (rules may not have fired)");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        tx
    });
}

async fn run_for_event(db: &Db, ev: &DomainEvent, rules: &[Rule]) {
    let owner = auth::ensure_owner(db).await.unwrap_or(0);
    for rule in rules.iter().filter(|r| r.enabled) {
        let Ok(trigger) = serde_json::from_str::<Trigger>(&rule.trigger_json) else {
            continue; // malformed rule — skip, never crash the engine
        };
        if !trigger.matches(ev) {
            continue;
        }
        let Ok(action) = serde_json::from_str::<Action>(&rule.action_json) else {
            continue;
        };
        // Suppress emission for the action's own writes — a rule can't trip a
        // rule. NOTE: suppression is a task-local; it does NOT cross tokio::spawn.
        // `execute` must stay on this task (await, never spawn) for the guard to
        // hold.
        let outcome = domain_events::suppressed(execute(db, &action, ev, owner)).await;
        let summary = match &outcome {
            Ok(s) => format!("{}: {s}", rule.name),
            Err(e) => format!("{}: action failed — {e}", rule.name),
        };
        let _ = ops::record_agent_action(
            db,
            ops::NewAgentAction {
                status: if outcome.is_ok() { "applied" } else { "rejected" },
                user_id: owner,
                profile_id: None,
                project_id: ev.project_id,
                chat_id: None,
                routine_id: None,
                tool: "rule",
                summary: &summary,
                args_json: &rule.action_json,
                result_json: None,
                model: None,
                prompt_tokens: None,
                completion_tokens: None,
                duration_ms: None,
                protocol_slug: None,
                protocol_version: None,
                content_hash: None,
                parent_action_id: None,
                approver_id: None,
            },
        )
        .await;
        let _ = ops::record_rule_fired(db, rule.id).await;
    }
}

/// Run one action; returns a short human description of what it did.
async fn execute(db: &Db, action: &Action, ev: &DomainEvent, owner: i64) -> Result<String, String> {
    match action.kind.as_str() {
        "notify" => {
            let text = action.text.clone().unwrap_or_else(|| "notified".into());
            // Durable: lands in the notification popover, not just the ledger.
            let _ = ops::create_notification(db, owner, "system", &text, None, None).await;
            Ok(text)
        }
        "comment" => {
            let task_id = target_task(ev).ok_or("no task to comment on")?;
            let content = action.text.clone().unwrap_or_default();
            ops::create_comment(db, CreateCommentInput { task_id, content, user_id: Some(owner), parent_id: None, profile_id: None, task_ids: vec![] })
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("commented on task {task_id}"))
        }
        "set_task_field" => {
            let task_id = target_task(ev).ok_or("no task to update")?;
            let field = action.field.as_deref().ok_or("missing field")?;
            let value = action.value.clone().ok_or("missing value")?;
            let mut input = UpdateTaskInput::default();
            match field {
                "priority" => input.priority = Some(value.clone()),
                "status" => input.status = Some(value.clone()),
                other => return Err(format!("unsupported field '{other}'")),
            }
            ops::update_task(db, task_id, input).await.map_err(|e| e.to_string())?;
            Ok(format!("set {field} = {value} on task {task_id}"))
        }
        other => Err(format!("unknown action '{other}'")),
    }
}

/// Schedule-triggered rules (Settings › Automations, "on a schedule"): a 60s
/// host loop fires enabled rules whose cadence is due — same strict parser and
/// due-math as Oracle schedules. Scheduled rules have NO domain event behind
/// them, so only context-free actions run (v1: notify); a rule wired to a
/// task-shaped action fails loudly into the ledger instead of guessing a task.
pub fn spawn_schedule_runner(db: Db, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            _ = stop.changed() => return,
        }
        loop {
            if let (Ok(rules), Ok(owner)) = (ops::list_rules(&db).await, auth::ensure_owner(&db).await) {
                for rule in rules.iter().filter(|r| r.enabled) {
                    let Ok(trigger) = serde_json::from_str::<Trigger>(&rule.trigger_json) else { continue };
                    if trigger.kind != "schedule" {
                        continue;
                    }
                    let Some(spec) = trigger.every.as_deref().and_then(crate::oracle_run::parse_schedule) else { continue };
                    let last = rule.last_fired_at.as_deref().and_then(|t| {
                        chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S")
                            .ok()
                            .map(|n| n.and_utc())
                    });
                    if !crate::oracle_run::is_due(spec, last, chrono::Utc::now()) {
                        continue;
                    }
                    let action: Action = match serde_json::from_str(&rule.action_json) {
                        Ok(a) => a,
                        Err(_) => continue,
                    };
                    let outcome = if action.kind == "notify" {
                        let text = action.text.clone().unwrap_or_else(|| rule.name.clone());
                        ops::create_notification(&db, owner, "system", &text, None, None)
                            .await
                            .map(|_| text)
                            .map_err(|e| e.to_string())
                    } else {
                        Err(format!("scheduled rules can only 'notify' (no task/event context for '{}')", action.kind))
                    };
                    let summary = match &outcome {
                        Ok(t) => format!("{} (scheduled): {t}", rule.name),
                        Err(e) => format!("{} (scheduled): {e}", rule.name),
                    };
                    let _ = ops::record_agent_action(&db, ops::NewAgentAction {
                        status: if outcome.is_ok() { "applied" } else { "rejected" },
                        user_id: owner,
                        profile_id: None,
                        project_id: None,
                        chat_id: None,
                        routine_id: None,
                        tool: "rule",
                        summary: &summary,
                        args_json: &rule.action_json,
                        result_json: None,
                        model: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        duration_ms: None,
                        protocol_slug: None,
                        protocol_version: None,
                        content_hash: None,
                        parent_action_id: None,
                        approver_id: None,
                    }).await;
                    // Stamp even on failure — a misconfigured rule must not
                    // retry every 60 seconds.
                    let _ = ops::record_rule_fired(&db, rule.id).await;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                _ = stop.changed() => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(kind: &str, project_id: Option<i64>, data: Value) -> DomainEvent {
        DomainEvent { kind: kind.into(), project_id, entity_id: 1, data }
    }

    #[test]
    fn trigger_matches_kind_and_filters() {
        let t: Trigger = serde_json::from_str(r#"{"kind":"task.status_changed","status":"Blocked"}"#).unwrap();
        assert!(t.matches(&ev("task.status_changed", Some(5), json!({"status":"Blocked"}))));
        assert!(!t.matches(&ev("task.status_changed", Some(5), json!({"status":"Done"}))), "status filter");
        assert!(!t.matches(&ev("task.created", Some(5), json!({"status":"Blocked"}))), "kind filter");
    }

    #[test]
    fn trigger_project_scope() {
        let t: Trigger = serde_json::from_str(r#"{"kind":"task.created","project_id":7}"#).unwrap();
        assert!(t.matches(&ev("task.created", Some(7), json!({}))));
        assert!(!t.matches(&ev("task.created", Some(8), json!({}))), "wrong project");
        assert!(!t.matches(&ev("task.created", None, json!({}))), "no project");
    }

    #[test]
    fn target_task_resolution() {
        assert_eq!(target_task(&ev("task.created", None, json!({}))), Some(1));
        assert_eq!(target_task(&ev("comment.created", None, json!({"task_id":42}))), Some(42));
        assert_eq!(target_task(&ev("event.created", None, json!({}))), None);
    }

    #[tokio::test]
    async fn engine_fires_action_logs_it_and_ignores_non_matches() {
        let path = std::env::temp_dir().join(format!("ganban_rules_engine_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = ganban_core::init_db(&path).await.unwrap();
        let _owner = auth::ensure_owner(&db).await.unwrap();

        let proj = ops::create_project(&db, serde_json::from_value(json!({ "name": "P" })).unwrap()).await.unwrap();
        let task = ops::create_task(
            &db,
            serde_json::from_value(json!({ "project_id": proj.id, "title": "T", "status": "To Do", "priority": "Low" })).unwrap(),
        )
        .await
        .unwrap();

        ops::create_rule(
            &db,
            ganban_core::models::NewRule {
                name: "blocked-note".into(),
                trigger_json: json!({ "kind": "task.status_changed", "status": "Blocked" }).to_string(),
                action_json: json!({ "kind": "comment", "text": "Auto: blocked" }).to_string(),
                enabled: true,
            },
        )
        .await
        .unwrap();

        let on_task = |status: &str, prev: Option<&str>| {
            let mut data = json!({ "status": status });
            if let Some(p) = prev {
                data["prev_status"] = json!(p);
            }
            DomainEvent { kind: "task.status_changed".into(), project_id: Some(proj.id), entity_id: task.id, data }
        };

        let rules = ops::list_rules(&db).await.unwrap();

        // A matching event → the comment is posted and a firing is logged.
        run_for_event(&db, &on_task("Blocked", Some("To Do")), &rules).await;
        let comments = ops::get_task_comments(&db, task.id).await.unwrap();
        assert!(comments.iter().any(|c| c.content == "Auto: blocked"), "rule posted the comment");
        let acts = ops::list_agent_actions(&db, Some(proj.id), 100).await.unwrap();
        assert!(acts.iter().any(|a| a.tool == "rule" && a.status == "applied"), "firing logged to the ledger");

        // A non-matching status change → nothing new happens.
        run_for_event(&db, &on_task("Done", None), &rules).await;
        let after = ops::get_task_comments(&db, task.id).await.unwrap();
        assert_eq!(after.len(), comments.len(), "non-matching event did not fire");

        let _ = std::fs::remove_file(&path);
    }
}
