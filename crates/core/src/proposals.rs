//! Durable write proposals (MEMBER_AGENTS.md prerequisite 1).
//!
//! Previously an in-memory ProposalStore: "a lost proposal just means ask
//! again" held for a single user on a single desktop, but it cannot hold for
//! member agents — a restart or eviction must not eat a member's pending
//! work, and multi-producer proposals (member machines returning drafts)
//! arrive with that feature. So proposals are rows.
//!
//! Consume-once semantics are preserved exactly: `take` deletes the row and
//! returns it — the deletion IS the double-submit guard (a concurrent second
//! approval finds nothing). A failed apply `reinsert`s under the same id so
//! a transient error stays retryable.
//!
//! Approval policy (prerequisite 3) lives on the project
//! (`projects.approval_policy`): `'proposer'` (default — the assignee reviews
//! their own agent's work before it lands) or `'owner'` (stricter desks: the
//! owner approves everything). Either way BOTH identities land on the ledger
//! row: `user_id` = proposer, `approver_id` = who resolved (prerequisite 2).

use crate::db::Db;
use crate::error::{AppError, Result};
use serde_json::Value;

/// A pending proposal row, as consumed by apply/reject.
#[derive(Debug, Clone)]
pub struct PendingProposal {
    pub id: i64,
    pub project_id: i64,
    /// The proposer — whose agent produced this.
    pub user_id: i64,
    pub profile_id: Option<i64>,
    pub chat_id: i64,
    pub command: String,
    pub args: Value,
    pub summary: String,
    pub details: Value,
    /// NULL = proposed in a host chat turn; `'agent'` = returned from a
    /// member's own machine's agent (MEMBER_AGENTS §2). Attribution only.
    pub origin: Option<String>,
    /// When it was filed — an approval queue without times is unrankable.
    pub created_at: String,
}

/// Proposals older than this are pruned at register time — an abandoned
/// proposal should not outlive anyone's memory of asking for it.
const MAX_AGE_DAYS: i64 = 30;

/// Store a new pending proposal. Returns its durable id.
pub async fn register(
    db: &Db,
    project_id: i64,
    user_id: i64,
    profile_id: Option<i64>,
    chat_id: i64,
    command: &str,
    args: &Value,
    summary: &str,
    details: &Value,
    origin: Option<&str>,
) -> Result<i64> {
    // Prune abandoned proposals (bounded table, no eviction surprises).
    let _ = sqlx::query("DELETE FROM proposals WHERE created_at < datetime('now', ?)")
        .bind(format!("-{MAX_AGE_DAYS} days"))
        .execute(db)
        .await;
    let res = sqlx::query(
        "INSERT INTO proposals (project_id, user_id, profile_id, chat_id, command, args_json, summary, details_json, origin) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(profile_id)
    .bind(chat_id)
    .bind(command)
    .bind(args.to_string())
    .bind(summary)
    .bind(details.to_string())
    .bind(origin)
    .execute(db)
    .await?;
    Ok(res.last_insert_rowid())
}

#[derive(sqlx::FromRow)]
struct ProposalRow {
    id: i64,
    project_id: i64,
    user_id: i64,
    profile_id: Option<i64>,
    chat_id: i64,
    command: String,
    args_json: String,
    summary: String,
    details_json: String,
    origin: Option<String>,
    created_at: String,
}

impl ProposalRow {
    fn into_pending(self) -> PendingProposal {
        PendingProposal {
            id: self.id,
            project_id: self.project_id,
            user_id: self.user_id,
            profile_id: self.profile_id,
            chat_id: self.chat_id,
            command: self.command,
            args: serde_json::from_str(&self.args_json).unwrap_or(Value::Null),
            summary: self.summary,
            details: serde_json::from_str(&self.details_json).unwrap_or(Value::Null),
            origin: self.origin,
            created_at: self.created_at,
        }
    }
}

/// The proposals a user may SEE, oldest first: always their own; plus, for
/// the owner, every proposal in projects whose policy routes approval to the
/// owner. (Visibility ≠ approval right — `may_resolve` is the check.)
pub async fn list_for_user(db: &Db, user_id: i64, is_owner: bool) -> Result<Vec<PendingProposal>> {
    let rows: Vec<ProposalRow> = if is_owner {
        sqlx::query_as(
            "SELECT p.id, p.project_id, p.user_id, p.profile_id, p.chat_id, p.command, p.args_json, p.summary, p.details_json, p.origin, p.created_at \
             FROM proposals p JOIN projects pr ON pr.id = p.project_id \
             WHERE p.user_id = ? OR pr.approval_policy = 'owner' ORDER BY p.id",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?
    } else {
        // Only in projects they're still a member of: a proposal quotes the
        // project's tasks.
        sqlx::query_as(
            "SELECT p.id, p.project_id, p.user_id, p.profile_id, p.chat_id, p.command, p.args_json, p.summary, p.details_json, p.origin, p.created_at \
             FROM proposals p JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = p.user_id \
             WHERE p.user_id = ? ORDER BY p.id",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?
    };
    let mut pending: Vec<PendingProposal> = rows.into_iter().map(ProposalRow::into_pending).collect();
    // A proposal about a task quotes it: it goes with the task (task visibility).
    let viewer = crate::visibility::Viewer { user_id, is_owner };
    if let Some(seen) = crate::visibility::visible_tasks(db, viewer, None).await? {
        pending.retain(|p| crate::visibility::task_of_args(&p.args).is_none_or(|t| seen.contains(&t)));
    }
    Ok(pending)
}

/// (proposer, project_id) WITHOUT consuming — authorize before removing; a
/// failed/unauthorized approval must never destroy a legitimate proposal.
pub async fn peek_meta(db: &Db, id: i64) -> Result<Option<(i64, i64)>> {
    Ok(sqlx::query_as::<_, (i64, i64)>("SELECT user_id, project_id FROM proposals WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// The approval-right check (prerequisite 3). Policy `'proposer'`: only the
/// proposer resolves their own. Policy `'owner'`: only the owner resolves.
/// Deliberately strict — no cross-approval outside the declared policy.
pub async fn may_resolve(db: &Db, id: i64, actor_id: i64, actor_is_owner: bool) -> Result<bool> {
    let Some((proposer, project_id)) = peek_meta(db, id).await? else {
        return Ok(false);
    };
    let policy: String = sqlx::query_scalar("SELECT approval_policy FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .unwrap_or_else(|| "proposer".into());
    Ok(match policy.as_str() {
        "owner" => actor_is_owner,
        _ => actor_id == proposer,
    })
}

/// Remove and return a proposal — the deletion is the double-submit guard.
pub async fn take(db: &Db, id: i64) -> Result<Option<PendingProposal>> {
    let row: Option<ProposalRow> = sqlx::query_as(
        "DELETE FROM proposals WHERE id = ? \
         RETURNING id, project_id, user_id, profile_id, chat_id, command, args_json, summary, details_json, origin, created_at",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(ProposalRow::into_pending))
}

/// Put a consumed proposal back under its original id (transient apply
/// failure → retryable, same id so the client's card still works).
pub async fn reinsert(db: &Db, p: &PendingProposal) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO proposals (id, project_id, user_id, profile_id, chat_id, command, args_json, summary, details_json, origin, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(p.id)
    .bind(p.project_id)
    .bind(p.user_id)
    .bind(p.profile_id)
    .bind(p.chat_id)
    .bind(&p.command)
    .bind(p.args.to_string())
    .bind(&p.summary)
    .bind(p.details.to_string())
    .bind(&p.origin)
    .bind(&p.created_at)
    .execute(db)
    .await?;
    Ok(())
}

/// Per-project approval policy (prerequisite 3). Rejects unknown values.
pub async fn set_approval_policy(db: &Db, project_id: i64, policy: &str) -> Result<()> {
    if !matches!(policy, "proposer" | "owner") {
        return Err(AppError::InvalidInput(format!(
            "unknown approval policy '{policy}' (proposer|owner)"
        )));
    }
    sqlx::query("UPDATE projects SET approval_policy = ? WHERE id = ?")
        .bind(policy)
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn approval_policy(db: &Db, project_id: i64) -> Result<String> {
    Ok(sqlx::query_scalar("SELECT approval_policy FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .unwrap_or_else(|| "proposer".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_props_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    async fn project(db: &Db, name: &str) -> i64 {
        ops::create_project(db, crate::models::CreateProjectInput { name: name.into(), description: None }).await.unwrap().id
    }

    #[tokio::test]
    async fn proposals_survive_a_restart_and_consume_once() {
        let db = test_db("durable").await;
        let pid = project(&db, "P").await;
        crate::auth::add_project_member(&db, pid, 1, crate::auth::ROLE_MEMBER).await.unwrap(); // a proposer is a member
        let args = serde_json::json!({ "title": "T" });
        let id = register(&db, pid, 1, None, 5, "create_task", &args, "Create T", &Value::Null, None).await.unwrap();

        // "Restart": nothing held in memory — a fresh reader sees the row.
        let listed = list_for_user(&db, 1, false).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].command, "create_task");

        // Consume-once: the first take wins, the second finds nothing.
        let taken = take(&db, id).await.unwrap().expect("first take");
        assert_eq!(taken.args["title"], "T");
        assert!(take(&db, id).await.unwrap().is_none(), "deletion is the double-submit guard");

        // A transient failure reinserts under the SAME id.
        reinsert(&db, &taken).await.unwrap();
        assert_eq!(peek_meta(&db, id).await.unwrap(), Some((1, pid)));
    }

    #[tokio::test]
    async fn approval_policy_gates_who_resolves() {
        let db = test_db("policy").await;
        let pid = project(&db, "P").await;
        let id = register(&db, pid, 2, None, 1, "create_task", &Value::Null, "s", &Value::Null, Some("agent")).await.unwrap();

        // Default 'proposer': the proposer resolves; the owner does NOT.
        assert!(may_resolve(&db, id, 2, false).await.unwrap());
        assert!(!may_resolve(&db, id, 1, true).await.unwrap());
        assert!(!may_resolve(&db, id, 3, false).await.unwrap(), "a third party never resolves");

        // 'owner': the owner resolves; the proposer no longer can.
        set_approval_policy(&db, pid, "owner").await.unwrap();
        assert!(may_resolve(&db, id, 1, true).await.unwrap());
        assert!(!may_resolve(&db, id, 2, false).await.unwrap());

        // The owner SEES the member's proposal under owner policy.
        let owner_view = list_for_user(&db, 1, true).await.unwrap();
        assert_eq!(owner_view.len(), 1);
        // …and unknown policies are refused, never coerced.
        assert!(set_approval_policy(&db, pid, "anarchy").await.is_err());
    }
}
