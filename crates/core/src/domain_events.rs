//! Domain-event source — the foundation for the native rules engine (Epoch M(a)).
//!
//! Every domain mutation in `ops` that a rule can react to emits a `DomainEvent`
//! here. A process-global sink (registered by the runtime — the daemon's rules
//! engine) consumes them; if no sink is set, `emit` is a no-op, so `core` keeps
//! working standalone (unit tests, the headless binary before the engine wires
//! in). This is the ONE chokepoint both write seams share — the desktop's Tauri
//! commands and the daemon's `dispatch` both call `ops` — so rules fire on the
//! owner's own actions AND on remote-client/agent actions alike.
//!
//! Two write classes must NOT fire rules. Sync reconciliation is covered for
//! free — it writes raw SQL (it does NOT go through these `ops` functions), so
//! it never emits. A rule's own resulting writes DO go through `ops`, so the
//! engine wraps each action in [`suppressed`] (a tokio task-local that [`emit`]
//! honors) — that's the loop guard: a rule can't trip another rule.

use serde_json::Value;
use std::sync::OnceLock;

/// Something a rule can trigger on. `kind` is a coarse, stable string; `data`
/// carries the extra facts conditions match against.
#[derive(Debug, Clone)]
pub struct DomainEvent {
    /// "task.created" | "task.status_changed" | "comment.created" | "event.created"
    pub kind: String,
    pub project_id: Option<i64>,
    pub entity_id: i64,
    /// Matchable facts, e.g. {"status":"Blocked","prev_status":"To Do","priority":"High"}.
    pub data: Value,
}

type Sink = Box<dyn Fn(DomainEvent) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

/// Register the process-wide consumer (the rules engine). First call wins; a
/// second call is ignored (the runtime registers exactly once at startup).
pub fn set_sink<F: Fn(DomainEvent) + Send + Sync + 'static>(f: F) {
    let _ = SINK.set(Box::new(f));
}

tokio::task_local! {
    static SUPPRESSED: bool;
}

/// Run `fut` with domain-event emission suppressed in this async scope. The
/// rules engine wraps each rule action in this so a rule's own writes can't
/// re-trigger rules (loop guard). Available for any future bulk path that calls
/// `ops` and shouldn't fire rules.
///
/// CAVEAT: this is a tokio task-local — it propagates across `.await` within the
/// SAME task but NOT into `tokio::spawn`ed children. Code inside a suppressed
/// scope must therefore `await` its writes directly, never spawn them, or the
/// guard is silently lost.
pub async fn suppressed<F: std::future::Future>(fut: F) -> F::Output {
    SUPPRESSED.scope(true, fut).await
}

fn suppressed_now() -> bool {
    SUPPRESSED.try_with(|s| *s).unwrap_or(false)
}

/// Emit a domain event unless suppressed in the current scope. Cheap and
/// non-blocking — the registered sink only enqueues; matching and actions
/// happen off the write path.
pub fn emit(ev: DomainEvent) {
    if suppressed_now() {
        return;
    }
    if let Some(sink) = SINK.get() {
        sink(ev);
    }
}
