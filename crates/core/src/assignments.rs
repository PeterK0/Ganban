//! Task assignment (built as the last dependency of
//! docs/design/MEMBER_AGENTS.md): "this task belongs to Alice", as data.
//!
//! A join table — many-to-many, `tasks` untouched. The assignment optionally
//! carries a **work brief** (MEMBER_AGENTS §3): a structured suggestion for
//! how the assignee's own tooling might approach the task. The brief is
//! ADVISORY ON BOTH SIDES and executable authority on neither — the host
//! never runs anything on the member's machine, and a brief referencing a
//! protocol slug injects no capability (the member has it or doesn't).
//! Symmetric hostility: on the assignee's side a brief is untrusted inbound
//! content and is rendered, never executed.
//!
//! Assignment crosses the machine boundary for free: it's a row on the host,
//! and members' clients already see host data over the existing invoke/SSE
//! seam (K2). Nothing here schedules, pushes, or executes.

use crate::db::Db;
use crate::domain_events::{emit, DomainEvent};
use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::Value;

/// One assignee on one task, with attribution and the optional brief.
///
/// An assignee is a MEMBER (`kind: "user"`, `user_id` set) or a CONTACT
/// (`kind: "contact"`, `contact_id` set) — someone responsible who isn't a
/// Ganban user. Contacts carry no brief (a brief addresses the assignee's
/// tooling; a contact has none) and never dispatch or get notified.
#[derive(Debug, Clone, Serialize)]
pub struct Assignee {
    pub kind: &'static str,
    pub user_id: Option<i64>,
    pub contact_id: Option<i64>,
    /// Empty for contacts.
    pub username: String,
    pub display_name: String,
    pub assigned_by: i64,
    pub assigned_at: String,
    /// Advisory work brief (`{protocol?, inputs?, notes?, acceptance?}`), or null.
    pub brief: Value,
}

/// One of "my" assignments, shaped for an assignments surface / rundown:
/// enough to render a card without a second query per row.
#[derive(Debug, Clone, Serialize)]
pub struct Assignment {
    pub task_id: i64,
    pub task_title: String,
    pub task_status: String,
    /// Task priority + deadline + last-edit time: the "assigned to you" wall
    /// was unprioritizable without them (field, 2026-07-24).
    pub task_priority: String,
    pub task_deadline: Option<String>,
    pub task_updated_at: String,
    pub project_id: i64,
    pub project_name: String,
    pub assigned_by: i64,
    pub assigned_at: String,
    pub brief: Value,
}

/// Assign a task to a user (idempotent upsert — re-assigning refreshes the
/// brief and attribution rather than erroring). The target must be a member
/// of the task's project: an assignment to someone who can't even see the
/// task is a data-entry error, refused here rather than discovered later.
pub async fn assign(
    db: &Db,
    task_id: i64,
    user_id: i64,
    assigned_by: i64,
    brief: Option<&Value>,
) -> Result<()> {
    let project_id: i64 = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("task not found".into()))?;
    let is_member: Option<i64> =
        sqlx::query_scalar("SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?")
            .bind(project_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    if is_member.is_none() {
        return Err(AppError::InvalidInput(
            "that user is not a member of this task's project".into(),
        ));
    }
    // Briefs are stored verbatim (rendered client-side as content, never
    // executed) but bounded: a brief is a note, not a payload channel.
    let brief_json = match brief.filter(|b| !b.is_null()) {
        Some(b) => {
            let s = b.to_string();
            if s.len() > 16 * 1024 {
                return Err(AppError::InvalidInput("work brief too large (16KB max)".into()));
            }
            Some(s)
        }
        None => None,
    };
    sqlx::query(
        "INSERT INTO task_assignees (task_id, user_id, assigned_by, brief_json) VALUES (?, ?, ?, ?) \
         ON CONFLICT(task_id, user_id) DO UPDATE SET assigned_by = excluded.assigned_by, \
         brief_json = excluded.brief_json, assigned_at = datetime('now')",
    )
    .bind(task_id)
    .bind(user_id)
    .bind(assigned_by)
    .bind(brief_json)
    .execute(db)
    .await?;
    emit(DomainEvent {
        kind: "task.assigned".into(),
        project_id: Some(project_id),
        entity_id: task_id,
        data: serde_json::json!({ "user_id": user_id, "assigned_by": assigned_by }),
    });
    Ok(())
}

/// Remove an assignment. Unassigning someone who wasn't assigned is a no-op
/// (the end state is what was asked for).
pub async fn unassign(db: &Db, task_id: i64, user_id: i64) -> Result<()> {
    let res = sqlx::query("DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?")
        .bind(task_id)
        .bind(user_id)
        .execute(db)
        .await?;
    if res.rows_affected() > 0 {
        let project_id: Option<i64> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(db)
            .await?;
        emit(DomainEvent {
            kind: "task.unassigned".into(),
            project_id,
            entity_id: task_id,
            data: serde_json::json!({ "user_id": user_id }),
        });
    }
    Ok(())
}

/// Assign a task to a CONTACT — a responsible party who isn't a member.
/// Idempotent like `assign`. Refuses archived contacts (assigning to someone
/// you've filed away is a data-entry error) and contacts linked to a user
/// account (assign the user instead — that path notifies and dispatches).
pub async fn assign_contact(db: &Db, task_id: i64, contact_id: i64, assigned_by: i64) -> Result<()> {
    let project_id: i64 = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("task not found".into()))?;
    let contact: Option<(bool, Option<i64>)> =
        sqlx::query_as("SELECT archived, user_id FROM contacts WHERE id = ?")
            .bind(contact_id)
            .fetch_optional(db)
            .await?;
    match contact {
        None => return Err(AppError::NotFound("contact not found".into())),
        Some((true, _)) => return Err(AppError::InvalidInput("that contact is archived".into())),
        Some((_, Some(uid))) => {
            return Err(AppError::InvalidInput(format!(
                "that contact is linked to user #{uid} — assign the member instead"
            )))
        }
        Some((false, None)) => {}
    }
    sqlx::query(
        "INSERT INTO task_contact_assignees (task_id, contact_id, assigned_by) VALUES (?, ?, ?) \
         ON CONFLICT(task_id, contact_id) DO UPDATE SET assigned_by = excluded.assigned_by, \
         assigned_at = datetime('now')",
    )
    .bind(task_id)
    .bind(contact_id)
    .bind(assigned_by)
    .execute(db)
    .await?;
    emit(DomainEvent {
        kind: "task.contact_assigned".into(),
        project_id: Some(project_id),
        entity_id: task_id,
        data: serde_json::json!({ "contact_id": contact_id, "assigned_by": assigned_by }),
    });
    Ok(())
}

/// Remove a contact assignment (no-op if absent — the end state is what was asked for).
pub async fn unassign_contact(db: &Db, task_id: i64, contact_id: i64) -> Result<()> {
    let res = sqlx::query("DELETE FROM task_contact_assignees WHERE task_id = ? AND contact_id = ?")
        .bind(task_id)
        .bind(contact_id)
        .execute(db)
        .await?;
    if res.rows_affected() > 0 {
        let project_id: Option<i64> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(db)
            .await?;
        emit(DomainEvent {
            kind: "task.contact_unassigned".into(),
            project_id,
            entity_id: task_id,
            data: serde_json::json!({ "contact_id": contact_id }),
        });
    }
    Ok(())
}

/// A task's assignees — members AND contacts — with names for rendering,
/// oldest assignment first.
pub async fn assignees_for_task(db: &Db, task_id: i64) -> Result<Vec<Assignee>> {
    let users: Vec<(i64, String, String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT ta.user_id, u.username, u.full_name, ta.assigned_by, ta.assigned_at, ta.brief_json \
         FROM task_assignees ta JOIN users u ON u.id = ta.user_id \
         WHERE ta.task_id = ?",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;
    let contacts: Vec<(i64, String, i64, String)> = sqlx::query_as(
        "SELECT tc.contact_id, c.full_name, tc.assigned_by, tc.assigned_at \
         FROM task_contact_assignees tc JOIN contacts c ON c.id = tc.contact_id \
         WHERE tc.task_id = ?",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;
    let mut all: Vec<Assignee> = users
        .into_iter()
        .map(|(user_id, username, display_name, assigned_by, assigned_at, brief_json)| Assignee {
            kind: "user",
            user_id: Some(user_id),
            contact_id: None,
            username,
            display_name,
            assigned_by,
            assigned_at,
            brief: brief_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null),
        })
        .chain(contacts.into_iter().map(|(contact_id, display_name, assigned_by, assigned_at)| Assignee {
            kind: "contact",
            user_id: None,
            contact_id: Some(contact_id),
            username: String::new(),
            display_name,
            assigned_by,
            assigned_at,
            brief: Value::Null,
        }))
        .collect();
    all.sort_by(|a, b| a.assigned_at.cmp(&b.assigned_at));
    Ok(all)
}

/// Every assignment in one project on live tasks, one query — the batched
/// shape a board needs to chip its cards (never N+1 from the client).
#[derive(Debug, Clone, Serialize)]
pub struct ProjectAssignee {
    pub task_id: i64,
    pub kind: &'static str,
    pub user_id: Option<i64>,
    pub contact_id: Option<i64>,
    /// Empty for contacts.
    pub username: String,
    pub display_name: String,
}

pub async fn assignees_for_project(db: &Db, project_id: i64) -> Result<Vec<ProjectAssignee>> {
    // One UNION, ordered like the task view: by task, then assignment time.
    let rows: Vec<(i64, String, Option<i64>, Option<i64>, String, String, String)> = sqlx::query_as(
        "SELECT ta.task_id, 'user' AS kind, ta.user_id, NULL AS contact_id, u.username, u.full_name, ta.assigned_at \
         FROM task_assignees ta \
         JOIN tasks t ON t.id = ta.task_id AND t.archived = 0 AND t.project_id = ?1 \
         JOIN users u ON u.id = ta.user_id \
         UNION ALL \
         SELECT tc.task_id, 'contact' AS kind, NULL, tc.contact_id, '', c.full_name, tc.assigned_at \
         FROM task_contact_assignees tc \
         JOIN tasks t ON t.id = tc.task_id AND t.archived = 0 AND t.project_id = ?1 \
         JOIN contacts c ON c.id = tc.contact_id \
         ORDER BY 1, 7",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(task_id, kind, user_id, contact_id, username, display_name, _at)| ProjectAssignee {
            task_id,
            kind: if kind == "user" { "user" } else { "contact" },
            user_id,
            contact_id,
            username,
            display_name,
        })
        .collect())
}

/// Everything assigned to `user_id` on live (unarchived) tasks, newest
/// assignment first — the "assigned to you" surface and the rundown line.
/// A user's assignments in projects they're (still) a member of: an assignment
/// outlives leaving the project on record, but grants nothing.
pub async fn assignments_for_user(db: &Db, user_id: i64) -> Result<Vec<Assignment>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i64, String, String, String, Option<String>, String, i64, String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT t.id, t.title, t.status, t.priority, t.deadline, t.updated_at, p.id, p.name, ta.assigned_by, ta.assigned_at, ta.brief_json \
         FROM task_assignees ta \
         JOIN tasks t ON t.id = ta.task_id AND t.archived = 0 \
         JOIN projects p ON p.id = t.project_id \
         WHERE ta.user_id = ? \
           AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = ta.user_id) \
                OR EXISTS (SELECT 1 FROM users u WHERE u.id = ta.user_id AND u.is_owner = 1)) \
         ORDER BY ta.assigned_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(task_id, task_title, task_status, task_priority, task_deadline, task_updated_at, project_id, project_name, assigned_by, assigned_at, brief_json)| {
                Assignment {
                    task_id,
                    task_title,
                    task_status,
                    task_priority,
                    task_deadline,
                    task_updated_at,
                    project_id,
                    project_name,
                    assigned_by,
                    assigned_at,
                    brief: brief_json
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(Value::Null),
                }
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, ops};
    use serde_json::json;

    async fn test_db(name: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_assign_{name}_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        db::init_db(&path).await.unwrap()
    }

    async fn seed(db: &Db) -> (i64, i64, i64) {
        let pid = ops::create_project(db, crate::models::CreateProjectInput { name: "P".into(), description: None })
            .await
            .unwrap()
            .id;
        for (id, name) in [(1, "owner"), (2, "alice")] {
            sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
                .bind(id)
                .bind(name)
                .bind(name)
                .execute(db)
                .await
                .unwrap();
            sqlx::query("INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')")
                .bind(pid)
                .bind(id)
                .execute(db)
                .await
                .unwrap();
        }
        let tid = sqlx::query("INSERT INTO tasks (project_id, title) VALUES (?, 'T')")
            .bind(pid)
            .execute(db)
            .await
            .unwrap()
            .last_insert_rowid();
        (pid, tid, 2)
    }

    #[tokio::test]
    async fn assign_carries_a_brief_and_requires_membership() {
        let db = test_db("brief").await;
        let (_pid, tid, alice) = seed(&db).await;

        let brief = json!({ "protocol": "user.summarize", "notes": "compare vs last week" });
        assign(&db, tid, alice, 1, Some(&brief)).await.unwrap();

        let a = assignees_for_task(&db, tid).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].user_id, Some(alice));
        assert_eq!(a[0].kind, "user");
        assert_eq!(a[0].brief["notes"], "compare vs last week");

        // Idempotent re-assign refreshes the brief instead of erroring.
        assign(&db, tid, alice, 1, None).await.unwrap();
        let a = assignees_for_task(&db, tid).await.unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0].brief.is_null());

        // A non-member can't be assigned: refused at the data edge.
        assert!(assign(&db, tid, 99, 1, None).await.is_err());
    }

    #[tokio::test]
    async fn contacts_can_be_assigned_and_list_beside_members() {
        let db = test_db("contact").await;
        let (pid, tid, alice) = seed(&db).await;
        // A plain contact, an archived one, and one linked to a member.
        for (id, name, archived, uid) in [(10, "Nikolai", 0, None), (11, "Old Bob", 1, None), (12, "Alice (contact)", 0, Some(alice))] {
            sqlx::query("INSERT INTO contacts (id, full_name, archived, user_id) VALUES (?, ?, ?, ?)")
                .bind(id).bind(name).bind(archived).bind(uid)
                .execute(&db).await.unwrap();
        }
        assign(&db, tid, alice, 1, None).await.unwrap();
        assign_contact(&db, tid, 10, 1).await.unwrap();
        assign_contact(&db, tid, 10, 1).await.unwrap(); // idempotent
        assert!(assign_contact(&db, tid, 11, 1).await.is_err(), "archived contact refused");
        assert!(assign_contact(&db, tid, 12, 1).await.is_err(), "user-linked contact → assign the member");
        assert!(assign_contact(&db, tid, 999, 1).await.is_err(), "unknown contact");

        let a = assignees_for_task(&db, tid).await.unwrap();
        assert_eq!(a.len(), 2);
        assert!(a.iter().any(|x| x.kind == "user" && x.user_id == Some(alice)));
        let nik = a.iter().find(|x| x.kind == "contact").unwrap();
        assert_eq!(nik.contact_id, Some(10));
        assert_eq!(nik.display_name, "Nikolai");
        assert!(nik.brief.is_null());

        let p = assignees_for_project(&db, pid).await.unwrap();
        assert_eq!(p.len(), 2);
        assert!(p.iter().any(|x| x.kind == "contact" && x.display_name == "Nikolai" && x.task_id == tid));

        // Contacts never appear in a USER's assignment wall.
        assert_eq!(assignments_for_user(&db, alice).await.unwrap().len(), 1);

        unassign_contact(&db, tid, 10).await.unwrap();
        unassign_contact(&db, tid, 10).await.unwrap(); // no-op
        assert_eq!(assignees_for_task(&db, tid).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn my_assignments_lists_live_tasks_and_unassign_removes() {
        let db = test_db("mine").await;
        let (pid, tid, alice) = seed(&db).await;
        assign(&db, tid, alice, 1, None).await.unwrap();

        let mine = assignments_for_user(&db, alice).await.unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].task_id, tid);
        assert_eq!(mine[0].project_id, pid);

        // Archived tasks drop off the surface (the work is no longer live)…
        sqlx::query("UPDATE tasks SET archived = 1 WHERE id = ?").bind(tid).execute(&db).await.unwrap();
        assert!(assignments_for_user(&db, alice).await.unwrap().is_empty());
        sqlx::query("UPDATE tasks SET archived = 0 WHERE id = ?").bind(tid).execute(&db).await.unwrap();

        // …and unassign is a clean, idempotent removal.
        unassign(&db, tid, alice).await.unwrap();
        unassign(&db, tid, alice).await.unwrap();
        assert!(assignments_for_user(&db, alice).await.unwrap().is_empty());
    }
}
