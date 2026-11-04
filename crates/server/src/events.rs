//! Freshness push (Epoch G3): a coarse "something changed" pulse stream.
//!
//! Every successful write — REST mutation, `/invoke` write command, approved
//! agent action — publishes a short string (entity kind or command name,
//! NEVER a payload) onto a process-wide broadcast channel. `GET /events/stream`
//! relays it as SSE; clients debounce pulses into a store-level refetch.
//! No payloads, and `/invoke` command names are mapped to coarse entity kinds
//! before publishing (auth/admin machinery doesn't pulse at all) — so the most
//! a subscriber learns is "some task changed somewhere", and subscribing at
//! all already requires an enrolled device token.
//!
//! Known gap (deliberate): background workers that
//! write on their own clock (rag poller, routine auto-runs, folder sync,
//! email sync) don't pulse yet — those changes surface via the existing
//! focus-refetch / manual ⟳ floor.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

/// Cloneable handle to the pulse channel. Lives in `serve()` (so future
/// background publishers can hold one) and rides the router as an Extension.
///
/// Every pulse is numbered (`epoch:seq`, sent as the SSE event id, and the
/// current value on `hello`). A client that reconnects — the stream ends every
/// ~10 min to re-check the token — compares `hello`'s id with the last one it
/// saw: equal = nothing was missed, so no wholesale refetch (that refetch is
/// what made every view flash every few minutes). `epoch` changes on restart,
/// so a restarted host always counts as "something may have changed".
#[derive(Clone)]
pub struct EventHub {
    tx: Arc<broadcast::Sender<(u64, String)>>,
    seq: Arc<AtomicU64>,
    epoch: Arc<String>,
    /// Live agent work: rides the hub because every change to it pulses.
    agents: crate::agent_work::AgentBoard,
}

impl EventHub {
    pub fn new() -> Self {
        // 256 pulses of headroom: a lagging subscriber just gets a "lagged"
        // marker and refetches — losing pulses is harmless by design.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Self {
            tx: Arc::new(broadcast::channel(256).0),
            seq: Arc::new(AtomicU64::new(0)),
            epoch: Arc::new(format!("{:x}", nanos ^ u128::from(std::process::id()))),
            agents: Default::default(),
        }
    }

    /// Fire-and-forget; no subscribers is the normal idle case.
    pub fn publish(&self, what: &str) {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send((n, what.to_string()));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(u64, String)> {
        self.tx.subscribe()
    }

    /// The SSE id for pulse `n` of this boot.
    pub fn id_of(&self, n: u64) -> String {
        format!("{}:{n}", self.epoch)
    }

    /// The board of live agent work (`crate::agent_work`).
    pub fn agents(&self) -> &crate::agent_work::AgentBoard {
        &self.agents
    }

    /// The id of the latest pulse (what `hello` reports).
    pub fn current_id(&self) -> String {
        self.id_of(self.seq.load(Ordering::SeqCst))
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Which mutating REST paths count as data changes, by first path segment.
/// `/invoke` is absent on purpose — read and write commands share that route,
/// so its pulse fires inside the handler where the command name is known.
/// Returning `None` (auth, AI config, searches, chat streams) means no pulse.
pub fn pulse_kind(path: &str) -> Option<&'static str> {
    // Per-user stash-tab state (game saves) is private — nobody else's view
    // changes when it does, so it never pulses.
    if path.contains("/tabs/") && path.ends_with("/state") {
        return None;
    }
    let seg = path.strip_prefix('/')?.split('/').next()?;
    match seg {
        "projects" => Some("projects"),
        "files" => Some("files"),
        "chats" => Some("chats"),
        "comments" => Some("comments"),
        "calendar" | "event-files" => Some("events"),
        "sync" => Some("sync"), // POST /sync/push — replica edits landing on the host
        "sync-folders" => Some("files"),
        "tools" if path == "/tools/execute" => Some("entities"), // approved agent writes
        "routines" if path.ends_with("/run") => Some("entities"),
        "atlas" if path.starts_with("/atlas/collections") => Some("atlas"),
        _ => None,
    }
}

/// Map an `/invoke` (or local desktop) command name to the coarse kind that
/// gets published — or `None`. Reads never pulse; neither does auth/admin
/// machinery (tokens, invites, devices, roles, pins, settings, build sharing):
/// broadcasting even those NAMES would narrate the owner's administrative
/// activity to every enrolled member. Unknown write commands pulse as "entities" — a
/// spurious pulse costs one debounced refetch, a missed one costs staleness.
pub fn invoke_pulse_kind(cmd: &str) -> Option<&'static str> {
    if matches!(cmd.split('_').next().unwrap_or(""), "get" | "list" | "verify") {
        return None;
    }
    // Finance is private to its user (ADR 0009), and the stream goes to every member: even a
    // coarse pulse would tell them when someone touches their money. The finance views
    // refetch after their own writes.
    if cmd.starts_with("fin_") {
        return None;
    }
    // Build sharing (owner machinery; two of the three are reads named off-convention).
    if matches!(cmd, "discover_builds" | "set_build" | "shared_builds") {
        return None;
    }
    for quiet in ["token", "invite", "device", "member", "role", "pin", "setting", "enrollment"] {
        if cmd.contains(quiet) {
            return None;
        }
    }
    Some(if cmd.contains("task") {
        "tasks"
    } else if cmd.contains("event") {
        "events"
    } else if cmd.contains("project") {
        "projects"
    } else if cmd.contains("comment") {
        "comments"
    } else if cmd.contains("contact") {
        "contacts"
    } else if cmd.contains("area") {
        "areas"
    } else if cmd.contains("time") {
        "time"
    } else if cmd.contains("file") || cmd.contains("attachment") {
        "files"
    } else if cmd.contains("model") {
        "models"
    } else if cmd.contains("quiz") {
        "quiz"
    } else if cmd.contains("user") {
        "users"
    } else {
        "entities"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invoke_commands_map_coarse_and_admin_stays_quiet() {
        assert_eq!(invoke_pulse_kind("create_task"), Some("tasks"));
        assert_eq!(invoke_pulse_kind("update_event"), Some("events"));
        assert_eq!(invoke_pulse_kind("start_time_entry"), Some("time"));
        assert_eq!(invoke_pulse_kind("delete_file_attachment"), Some("files"));
        assert_eq!(invoke_pulse_kind("create_quiz_question"), Some("quiz"));
        assert_eq!(invoke_pulse_kind("get_quiz_subjects"), None, "reads never pulse");
        assert_eq!(invoke_pulse_kind("frobnicate_widget"), Some("entities")); // unknown write
        // Reads and auth/admin machinery never pulse — names alone would
        // narrate owner activity to every member.
        assert_eq!(invoke_pulse_kind("get_tasks"), None);
        assert_eq!(invoke_pulse_kind("list_members"), None);
        // Reads MUST be named get_/list_/verify_ — an off-convention read
        // command pulses, and any pulse-triggered view that CALLS it while
        // refetching becomes a perpetual refresh loop (the my_assignments
        // incident: pulse → refetch → invoke → pulse → …, forever).
        assert_eq!(invoke_pulse_kind("get_my_assignments"), None);
        assert_eq!(invoke_pulse_kind("get_project_assignees"), None);
        assert_eq!(invoke_pulse_kind("get_assignees"), None);
        // …while the assignment WRITES pulse like any task write.
        assert_eq!(invoke_pulse_kind("assign_task"), Some("tasks"));
        assert_eq!(invoke_pulse_kind("unassign_task"), Some("tasks"));
        assert_eq!(invoke_pulse_kind("verify_pin"), None);
        assert_eq!(invoke_pulse_kind("create_invite"), None);
        assert_eq!(invoke_pulse_kind("revoke_device"), None);
        assert_eq!(invoke_pulse_kind("set_member_role"), None);
        assert_eq!(invoke_pulse_kind("set_app_setting"), None);
        assert_eq!(invoke_pulse_kind("set_user_pin"), None);
        assert_eq!(invoke_pulse_kind("set_build"), None);
        assert_eq!(invoke_pulse_kind("discover_builds"), None);
        assert_eq!(invoke_pulse_kind("shared_builds"), None);
        // …but only those: a write that merely mentions builds still pulses.
        assert_eq!(invoke_pulse_kind("create_model_build_step"), Some("models"));
        // Finance writes are private to their user: no pulse at all.
        assert_eq!(invoke_pulse_kind("fin_create_entry"), None);
        assert_eq!(invoke_pulse_kind("fin_update_account"), None);
        assert_eq!(invoke_pulse_kind("fin_import"), None);
    }

    #[test]
    fn rest_writes_pulse_and_streams_dont() {
        assert_eq!(pulse_kind("/projects/7/files/upload"), Some("projects"));
        assert_eq!(pulse_kind("/sync/push"), Some("sync"));
        assert_eq!(pulse_kind("/tools/execute"), Some("entities"));
        assert_eq!(pulse_kind("/atlas/collections/3/reingest"), Some("atlas"));
        // Never: /invoke (commands pulse in its handler, task writes included),
        // chat streams, searches, auth, AI config.
        assert_eq!(pulse_kind("/invoke"), None);
        assert_eq!(pulse_kind("/tasks/12/reactions"), None);
        assert_eq!(pulse_kind("/chat"), None);
        assert_eq!(pulse_kind("/secretary/chat"), None);
        assert_eq!(pulse_kind("/search"), None);
        assert_eq!(pulse_kind("/atlas/search"), None);
        assert_eq!(pulse_kind("/enroll"), None);
        assert_eq!(pulse_kind("/ai/profiles"), None);
        assert_eq!(pulse_kind("/tools/reject"), None);
        // Private per-user game state: no pulse (PUT /projects/:id/tabs/:tab/state)
        assert_eq!(pulse_kind("/projects/7/tabs/quiz/state"), None);
        // …but the shared tab CONFIG (admin lens) still pulses as project data.
        assert_eq!(pulse_kind("/projects/7/tabs/atlas/config"), Some("projects"));
    }
}


#[cfg(test)]
mod hub_tests {
    use super::*;

    #[tokio::test]
    async fn pulses_are_numbered_and_hello_reports_the_latest() {
        let hub = EventHub::new();
        let start = hub.current_id();
        let mut rx = hub.subscribe();
        hub.publish("tasks");
        hub.publish("comments");
        let (a, wa) = rx.recv().await.unwrap();
        let (b, wb) = rx.recv().await.unwrap();
        assert_eq!((wa.as_str(), wb.as_str()), ("tasks", "comments"));
        assert_eq!(b, a + 1);
        assert_eq!(hub.current_id(), hub.id_of(b), "hello = the last pulse");
        assert_ne!(start, hub.current_id(), "a pulse moves the id");
        assert_ne!(EventHub::new().current_id(), hub.id_of(0), "a new boot has a new epoch");
    }
}
