//! Live agent work: which task an assistant is working on right now (the timer's
//! "Agents" section).
//!
//! A chat turn's tool loop, and any delegate it calls, record each task its tool calls
//! name while the turn runs. The record lives only in memory: it is gone when the turn
//! ends, fails or is cancelled, or the host restarts. Each change publishes the coarse
//! `agents` pulse (no payload), and every window of the chat's user reads the list back
//! with `get_agent_work`, trimmed to the tasks the reader can see (ADR 0002).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use ganban_core::visibility::{self, Viewer};
use ganban_core::Db;

use crate::events::EventHub;

/// The pulse kind a change to the board publishes.
pub const PULSE: &str = "agents";

/// One task an agent is working on in one run.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub run: u64,
    /// The user whose chat runs the agent: only they see the entry.
    pub user_id: i64,
    pub task_id: i64,
    /// The personality working on it.
    pub who: String,
    /// When the run first touched the task (RFC 3339).
    pub since: String,
}

/// The board's state: pure, so the rules are testable without a host.
#[derive(Default, Debug)]
pub struct Board {
    entries: Vec<Entry>,
}

impl Board {
    /// Record that `run` touched `task_id`. A task the run already holds keeps its first
    /// time. Returns whether the board changed.
    pub fn touch(&mut self, run: u64, user_id: i64, task_id: i64, who: &str, since: &str) -> bool {
        if self.entries.iter().any(|e| e.run == run && e.task_id == task_id) {
            return false;
        }
        self.entries.push(Entry { run, user_id, task_id, who: who.to_string(), since: since.to_string() });
        true
    }

    /// Drop everything `run` holds. Returns whether the board changed.
    pub fn end(&mut self, run: u64) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.run != run);
        self.entries.len() != before
    }

    /// The entries of one user's runs, oldest first.
    pub fn of_user(&self, user_id: i64) -> Vec<Entry> {
        self.entries.iter().filter(|e| e.user_id == user_id).cloned().collect()
    }
}

/// The host's board, shared by every request (it rides the [`EventHub`]).
#[derive(Clone, Default)]
pub struct AgentBoard {
    board: Arc<Mutex<Board>>,
    next_run: Arc<AtomicU64>,
}

impl AgentBoard {
    fn with<R>(&self, f: impl FnOnce(&mut Board) -> R) -> R {
        // A poisoned lock only means a panic mid-update of a plain Vec: keep going.
        let mut b = self.board.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut b)
    }

    /// The entries of one user's runs.
    pub fn of_user(&self, user_id: i64) -> Vec<Entry> {
        self.with(|b| b.of_user(user_id))
    }
}

/// One agent run (a chat turn, or a delegate inside one). Dropping it ends the run's
/// entries, so a turn that finishes, fails or whose client goes away clears itself.
pub struct Run {
    hub: EventHub,
    id: u64,
    user_id: i64,
    is_owner: bool,
    project_id: i64,
    who: String,
}

impl Run {
    pub fn start(hub: &EventHub, user_id: i64, is_owner: bool, project_id: i64, who: &str) -> Self {
        let id = hub.agents().next_run.fetch_add(1, Ordering::SeqCst) + 1;
        Run { hub: hub.clone(), id, user_id, is_owner, project_id, who: who.to_string() }
    }

    /// A run for another agent working inside this one (a delegate), for the same user
    /// and project. It ends on its own when dropped.
    pub fn child(&self, who: &str) -> Self {
        Run::start(&self.hub, self.user_id, self.is_owner, self.project_id, who)
    }

    /// Record the task a tool call names, if any. Only a task of the run's project that
    /// its user can see counts; anything else is ignored (the tool refuses it anyway).
    pub async fn touch_args(&self, db: &Db, args: &serde_json::Value) {
        if let Some(task_id) = visibility::task_of_args(args) {
            self.touch(db, task_id).await;
        }
    }

    pub async fn touch(&self, db: &Db, task_id: i64) {
        let project = sqlx::query_scalar::<_, i64>("SELECT project_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        if project != Some(self.project_id) {
            return;
        }
        let viewer = Viewer { user_id: self.user_id, is_owner: self.is_owner };
        if !visibility::can_see_task(db, viewer, task_id).await.unwrap_or(false) {
            return;
        }
        let now = Utc::now().to_rfc3339();
        if self.hub.agents().with(|b| b.touch(self.id, self.user_id, task_id, &self.who, &now)) {
            self.hub.publish(PULSE);
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if self.hub.agents().with(|b| b.end(self.id)) {
            self.hub.publish(PULSE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_holds_each_task_once_and_ending_it_clears_only_its_own() {
        let mut b = Board::default();
        assert!(b.touch(1, 7, 10, "Scout", "t1"));
        assert!(!b.touch(1, 7, 10, "Scout", "t2"), "the first time stays");
        assert!(b.touch(1, 7, 11, "Scout", "t3"));
        assert!(b.touch(2, 7, 10, "Critic", "t4"), "another run on the same task is its own entry");
        assert!(b.touch(3, 8, 12, "Scout", "t5"));
        assert_eq!(b.of_user(7).len(), 3);
        assert_eq!(b.of_user(7)[0].since, "t1");
        assert!(b.end(1));
        assert!(!b.end(1), "ending twice changes nothing");
        assert_eq!(b.of_user(7).iter().map(|e| (e.run, e.task_id)).collect::<Vec<_>>(), vec![(2, 10)]);
        assert_eq!(b.of_user(8).len(), 1, "another user's run is untouched");
    }
}
