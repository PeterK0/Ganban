//! Business logic / data operations shared by every transport.
//!
//! Each function takes a `&Db` handle and returns `core::Result`. The desktop
//! Tauri commands and the daemon's HTTP handlers are thin adapters over these.
//!
//! NOTE: `verify_file_attachment` checks the *local* filesystem (`Path::exists`).
//! That is correct for the desktop app but semantically wrong when run inside a
//! remote daemon (it would inspect the server's filesystem, not the client's).
//! It is intentionally NOT exposed by the Phase 1 daemon. See SYNC docs.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::db::Db;
use crate::domain_events::{emit, DomainEvent};
use crate::error::{AppError, Result};
use crate::models::*;

// ============== Project Operations ==============

pub async fn get_projects(db: &Db) -> Result<Vec<Project>> {
    // Personal containers never appear in listings — they're surfaced only
    // through Atlas, and no board/bin/settings flow should ever touch one.
    let projects = sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE personal_user_id IS NULL ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;

    Ok(projects)
}

/// The user's personal container project (Atlas Phase 2b) — find or create.
/// It hosts personal tab data (Models first) under the SAME tables, commands
/// and membership scoping as any project, but is hidden from every listing
/// and can't be archived out from under its data.
pub async fn ensure_personal_project(db: &Db, user_id: i64) -> Result<i64> {
    if let Some(id) = sqlx::query_scalar::<_, i64>("SELECT id FROM projects WHERE personal_user_id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?
    {
        return Ok(id);
    }
    let now = Utc::now();
    let res = sqlx::query(
        "INSERT INTO projects (name, description, personal_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("Atlas — personal")
    .bind("Personal container (hidden): hosts your Atlas tabs' data.")
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    // Membership makes every existing project-scoped authorization rule work
    // unchanged; only this user (and the host owner, by global bypass) can
    // reach the container's data.
    sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?) \
         ON CONFLICT(project_id, user_id) DO NOTHING",
    )
    .bind(id)
    .bind(user_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(id)
}

/// Move every model kit from one project into another (the “move my
/// collection to Atlas” migration). Boards/sections/marks ride along free —
/// they key off kit_id. Returns how many kits moved.
pub async fn adopt_model_kits(db: &Db, from_project: i64, to_project: i64) -> Result<i64> {
    let res = sqlx::query("UPDATE model_kits SET project_id = ? WHERE project_id = ?")
        .bind(to_project)
        .bind(from_project)
        .execute(db)
        .await?;
    Ok(res.rows_affected() as i64)
}

/// A global app setting (key/value), e.g. the default per-project storage quota.
pub async fn get_app_setting(db: &Db, key: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await?)
}

pub async fn set_app_setting(db: &Db, key: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn create_project(db: &Db, input: CreateProjectInput) -> Result<Project> {
    let now = Utc::now();

    // New projects inherit the configurable default storage allocation.
    let quota = get_app_setting(db, "default_storage_quota_bytes")
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(crate::storage::DEFAULT_QUOTA_BYTES);

    let result = sqlx::query(
        "INSERT INTO projects (name, description, storage_quota_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&input.name)
    .bind(&input.description)
    .bind(quota)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let project_id = result.last_insert_rowid();

    let project = sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(db)
        .await?;

    Ok(project)
}

pub async fn delete_project(db: &Db, project_id: i64) -> Result<()> {
    println!("delete_project called with project_id: {}", project_id);

    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(project_id)
        .execute(db)
        .await?;

    println!("delete_project affected {} rows", result.rows_affected());
    Ok(())
}

pub async fn archive_project(db: &Db, project_id: i64, archived: bool) -> Result<Project> {
    let now = Utc::now();

    sqlx::query("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?")
        .bind(archived as i32)
        .bind(now)
        .bind(project_id)
        .execute(db)
        .await?;

    let project = sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(db)
        .await?;

    Ok(project)
}

pub async fn update_project(db: &Db, project_id: i64, input: UpdateProjectInput) -> Result<Project> {
    let now = Utc::now();

    // Get current project
    let current_project = sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(db)
        .await?;

    // Update with provided values or keep existing ones
    sqlx::query(
        r#"
        UPDATE projects
        SET name = ?,
            description = ?,
            pinned = ?,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(input.name.unwrap_or(current_project.name))
    .bind(input.description.or(current_project.description))
    .bind(input.pinned.unwrap_or(current_project.pinned) as i32)
    .bind(now)
    .bind(project_id)
    .execute(db)
    .await?;

    let project = sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(db)
        .await?;

    Ok(project)
}

/// The project's default assistant profile id, if set.
pub async fn get_project_model_profile(db: &Db, project_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, Option<i64>>("SELECT model_profile_id FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .flatten())
}

/// Set (or clear, with None) the project's default assistant profile.
pub async fn set_project_model_profile(db: &Db, project_id: i64, profile_id: Option<i64>) -> Result<()> {
    sqlx::query("UPDATE projects SET model_profile_id = ?, updated_at = ? WHERE id = ?")
        .bind(profile_id)
        .bind(Utc::now())
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn get_project_stats(db: &Db, project_id: i64) -> Result<ProjectStats> {
    get_project_stats_among(db, project_id, None).await
}

/// A project's stats over its live tasks, or only those in `only` (the ones a member
/// can see: task visibility).
pub async fn get_project_stats_among(
    db: &Db,
    project_id: i64,
    only: Option<&std::collections::HashSet<i64>>,
) -> Result<ProjectStats> {
    let ids = crate::visibility::json_ids(only);
    // The live tasks counted: `?1` the project, `?2` the visible ids (NULL = all).
    const LIVE: &str = "SELECT id FROM tasks WHERE project_id = ?1 AND archived = 0 \
                        AND (?2 IS NULL OR id IN (SELECT value FROM json_each(?2)))";
    let count = |status: Option<&'static str>| {
        let ids = ids.clone();
        async move {
            let sql = format!("SELECT COUNT(*) FROM tasks WHERE id IN ({LIVE}) AND (?3 IS NULL OR status = ?3)");
            sqlx::query_scalar::<_, i64>(&sql).bind(project_id).bind(ids).bind(status).fetch_one(db).await
        }
    };
    let total_tasks = count(None).await?;
    let todo = count(Some("To Do")).await?;
    let in_progress = count(Some("In Progress")).await?;
    let done = count(Some("Done")).await?;
    let blocked = count(Some("Blocked")).await?;

    let total_time_seconds: Option<i64> =
        sqlx::query_scalar(&format!("SELECT COALESCE(SUM(duration), 0) FROM time_entries WHERE task_id IN ({LIVE})"))
            .bind(project_id)
            .bind(&ids)
            .fetch_one(db)
            .await?;
    let total_files: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM file_attachments WHERE task_id IN ({LIVE})"))
        .bind(project_id)
        .bind(&ids)
        .fetch_one(db)
        .await?;
    let total_cost: Option<f64> =
        sqlx::query_scalar(&format!("SELECT COALESCE(SUM(cost), 0.0) FROM tasks WHERE id IN ({LIVE})"))
            .bind(project_id)
            .bind(&ids)
            .fetch_one(db)
            .await?;

    Ok(ProjectStats {
        total_tasks,
        tasks_by_status: TasksByStatus { todo, in_progress, done, blocked },
        total_time_seconds: total_time_seconds.unwrap_or(0),
        total_files,
        total_cost: total_cost.unwrap_or(0.0),
    })
}

// ============== Area Operations ==============

pub async fn get_areas(db: &Db, project_id: i64) -> Result<Vec<Area>> {
    let areas =
        sqlx::query_as::<_, Area>("SELECT * FROM areas WHERE project_id = ? ORDER BY created_at ASC")
            .bind(project_id)
            .fetch_all(db)
            .await?;

    Ok(areas)
}

pub async fn create_area(db: &Db, input: CreateAreaInput) -> Result<Area> {
    let now = Utc::now();

    let result = sqlx::query(
        "INSERT INTO areas (project_id, name, description, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(input.project_id)
    .bind(&input.name)
    .bind(&input.description)
    .bind(now)
    .execute(db)
    .await?;

    let area_id = result.last_insert_rowid();

    let area = sqlx::query_as::<_, Area>("SELECT * FROM areas WHERE id = ?")
        .bind(area_id)
        .fetch_one(db)
        .await?;

    Ok(area)
}

pub async fn update_area(db: &Db, area_id: i64, input: UpdateAreaInput) -> Result<Area> {
    // Get current area
    let current_area = sqlx::query_as::<_, Area>("SELECT * FROM areas WHERE id = ?")
        .bind(area_id)
        .fetch_one(db)
        .await?;

    // Update with provided values or keep existing ones
    sqlx::query("UPDATE areas SET name = ?, description = ? WHERE id = ?")
        .bind(input.name.unwrap_or(current_area.name))
        .bind(input.description.or(current_area.description))
        .bind(area_id)
        .execute(db)
        .await?;

    let area = sqlx::query_as::<_, Area>("SELECT * FROM areas WHERE id = ?")
        .bind(area_id)
        .fetch_one(db)
        .await?;

    Ok(area)
}

pub async fn delete_area(db: &Db, area_id: i64) -> Result<()> {
    println!("delete_area called with area_id: {}", area_id);

    // A restricted area's tasks keep their audience (ADR 0002).
    crate::visibility::keep_audience_of_area(db, area_id).await?;

    // First, unset area_id for all tasks in this area (set to NULL)
    sqlx::query("UPDATE tasks SET area_id = NULL WHERE area_id = ?")
        .bind(area_id)
        .execute(db)
        .await?;

    // Then delete the area
    let result = sqlx::query("DELETE FROM areas WHERE id = ?")
        .bind(area_id)
        .execute(db)
        .await?;

    println!("delete_area affected {} rows", result.rows_affected());
    Ok(())
}

// ============== Task Operations ==============

pub async fn get_tasks(db: &Db, project_id: i64, archived: Option<bool>) -> Result<Vec<Task>> {
    let archived_filter = archived.unwrap_or(false);

    let tasks = sqlx::query_as::<_, Task>(
        "SELECT * FROM tasks WHERE project_id = ? AND archived = ? ORDER BY created_at DESC",
    )
    .bind(project_id)
    .bind(archived_filter as i32)
    .fetch_all(db)
    .await?;

    Ok(tasks)
}

/// List tasks across all projects (used by the daemon's `/snapshot`).
pub async fn get_all_tasks(db: &Db, archived: Option<bool>) -> Result<Vec<Task>> {
    let tasks = match archived {
        Some(value) => {
            sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE archived = ? ORDER BY created_at DESC")
                .bind(value as i32)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query_as::<_, Task>("SELECT * FROM tasks ORDER BY created_at DESC")
                .fetch_all(db)
                .await?
        }
    };

    Ok(tasks)
}

pub async fn create_task(db: &Db, input: CreateTaskInput) -> Result<Task> {
    let now = Utc::now();

    let result = sqlx::query(
        r#"
        INSERT INTO tasks (
            project_id, area_id, title, description, status, priority, prefix, cost, currency, deadline, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(input.project_id)
    .bind(input.area_id)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.status)
    .bind(&input.priority)
    .bind(&input.prefix)
    .bind(input.cost)
    .bind(&input.currency)
    .bind(input.deadline)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let task_id = result.last_insert_rowid();

    let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;

    emit(DomainEvent {
        kind: "task.created".into(),
        project_id: Some(task.project_id),
        entity_id: task.id,
        data: serde_json::json!({ "status": task.status, "priority": task.priority }),
    });
    Ok(task)
}

pub async fn update_task(db: &Db, task_id: i64, input: UpdateTaskInput) -> Result<Task> {
    let now = Utc::now();

    // Get current task
    let current_task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;
    let prev_status = current_task.status.clone();

    // Prepare completed_at timestamp if status is being changed to "Done"
    let completed_at = if let Some(ref status) = input.status {
        if status == "Done" && current_task.status != "Done" {
            Some(now)
        } else if status != "Done" {
            None
        } else {
            current_task.completed_at
        }
    } else {
        current_task.completed_at
    };

    // Update with provided values or keep existing ones
    sqlx::query(
        r#"
        UPDATE tasks
        SET title = ?,
            description = ?,
            status = ?,
            priority = ?,
            prefix = ?,
            cost = ?,
            currency = ?,
            area_id = ?,
            deadline = ?,
            pinned = ?,
            updated_at = ?,
            completed_at = ?
        WHERE id = ?
        "#,
    )
    .bind(input.title.unwrap_or(current_task.title))
    .bind(input.description.or(current_task.description))
    .bind(input.status.unwrap_or(current_task.status))
    .bind(input.priority.unwrap_or(current_task.priority))
    .bind(input.prefix.or(current_task.prefix))
    .bind(input.cost.or(current_task.cost))
    .bind(input.currency.or(current_task.currency))
    .bind(input.area_id.or(current_task.area_id))
    .bind(input.deadline.or(current_task.deadline))
    .bind(input.pinned.unwrap_or(current_task.pinned) as i32)
    .bind(now)
    .bind(completed_at)
    .bind(task_id)
    .execute(db)
    .await?;

    let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;

    if task.status != prev_status {
        emit(DomainEvent {
            kind: "task.status_changed".into(),
            project_id: Some(task.project_id),
            entity_id: task.id,
            data: serde_json::json!({ "status": task.status, "prev_status": prev_status, "priority": task.priority }),
        });
    }
    Ok(task)
}

pub async fn update_task_status(db: &Db, task_id: i64, status: String) -> Result<Task> {
    let now = Utc::now();
    let prev_status: Option<String> = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?;

    // Check if status is "Done" to set completed_at
    let completed_at = if status == "Done" { Some(now) } else { None };

    sqlx::query("UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .bind(&status)
        .bind(now)
        .bind(completed_at)
        .bind(task_id)
        .execute(db)
        .await?;

    let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;

    if prev_status.as_deref() != Some(task.status.as_str()) {
        emit(DomainEvent {
            kind: "task.status_changed".into(),
            project_id: Some(task.project_id),
            entity_id: task.id,
            data: serde_json::json!({ "status": task.status, "prev_status": prev_status, "priority": task.priority }),
        });
    }
    Ok(task)
}

pub async fn delete_task(db: &Db, task_id: i64) -> Result<()> {
    println!(
        "delete_task called with task_id: {} (soft delete - archiving)",
        task_id
    );

    let now = Utc::now();

    // Soft delete: set archived = 1 instead of deleting
    let result = sqlx::query("UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(task_id)
        .execute(db)
        .await?;

    println!("delete_task (archived) affected {} rows", result.rows_affected());
    Ok(())
}

pub async fn restore_task(db: &Db, task_id: i64) -> Result<Task> {
    println!("restore_task called with task_id: {}", task_id);

    let now = Utc::now();

    sqlx::query("UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(task_id)
        .execute(db)
        .await?;

    let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;

    Ok(task)
}

pub async fn permanently_delete_task(db: &Db, task_id: i64) -> Result<()> {
    println!("permanently_delete_task called with task_id: {}", task_id);

    // Comments living on this task but tagged on others survive: their first
    // other tag becomes home (replies move along) before the cascade runs.
    let movable: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT ct.comment_id, ct.task_id FROM comment_tasks ct JOIN comments c ON c.id = ct.comment_id \
         WHERE c.task_id = ?1 AND ct.task_id != ?1 ORDER BY ct.id",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;
    let mut moved: Vec<i64> = Vec::new();
    for (cid, to) in movable {
        if !moved.contains(&cid) {
            rehome_thread(db, cid, to).await?;
            moved.push(cid);
        }
    }

    let result = sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(task_id)
        .execute(db)
        .await?;

    println!(
        "permanently_delete_task affected {} rows",
        result.rows_affected()
    );
    Ok(())
}

pub async fn archive_task(db: &Db, task_id: i64, archived: bool) -> Result<Task> {
    let now = Utc::now();

    sqlx::query("UPDATE tasks SET archived = ?, updated_at = ? WHERE id = ?")
        .bind(archived as i32)
        .bind(now)
        .bind(task_id)
        .execute(db)
        .await?;

    let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(db)
        .await?;

    Ok(task)
}

// ============== Time Tracking Operations ==============

pub async fn start_time_entry(db: &Db, task_id: i64, notes: Option<String>, user_id: Option<i64>) -> Result<TimeEntry> {
    let now = Utc::now();

    // Check if there's an active timer for this task: this user's (a teammate
    // may time the same task), or an unattributed one.
    let active = sqlx::query_as::<_, TimeEntry>(
        "SELECT * FROM time_entries WHERE task_id = ?1 AND end_time IS NULL AND (?2 IS NULL OR user_id = ?2 OR user_id IS NULL)",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    if active.is_some() {
        return Err(crate::error::AppError::InvalidInput(
            "Timer already running for this task".to_string(),
        ));
    }

    let result = sqlx::query(
        "INSERT INTO time_entries (task_id, start_time, notes, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(task_id)
    .bind(now)
    .bind(&notes)
    .bind(user_id)
    .bind(now)
    .execute(db)
    .await?;

    let entry_id = result.last_insert_rowid();

    let entry = sqlx::query_as::<_, TimeEntry>("SELECT * FROM time_entries WHERE id = ?")
        .bind(entry_id)
        .fetch_one(db)
        .await?;

    Ok(entry)
}

pub async fn stop_time_entry(db: &Db, entry_id: i64, notes: Option<String>) -> Result<TimeEntry> {
    let now = Utc::now();

    // Get the entry
    let entry = sqlx::query_as::<_, TimeEntry>("SELECT * FROM time_entries WHERE id = ?")
        .bind(entry_id)
        .fetch_one(db)
        .await?;

    if entry.end_time.is_some() {
        return Err(crate::error::AppError::InvalidInput(
            "Timer already stopped".to_string(),
        ));
    }

    // Calculate duration in seconds
    let duration = (now - entry.start_time).num_seconds();

    // Update the entry
    sqlx::query("UPDATE time_entries SET end_time = ?, duration = ?, notes = ? WHERE id = ?")
        .bind(now)
        .bind(duration)
        .bind(notes.or(entry.notes))
        .bind(entry_id)
        .execute(db)
        .await?;

    let updated_entry = sqlx::query_as::<_, TimeEntry>("SELECT * FROM time_entries WHERE id = ?")
        .bind(entry_id)
        .fetch_one(db)
        .await?;

    Ok(updated_entry)
}

pub async fn get_time_entries(db: &Db, task_id: i64) -> Result<Vec<TimeEntry>> {
    let entries = sqlx::query_as::<_, TimeEntry>(
        "SELECT * FROM time_entries WHERE task_id = ? ORDER BY start_time DESC",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;

    Ok(entries)
}

pub async fn get_active_time_entry(db: &Db, task_id: i64) -> Result<Option<TimeEntry>> {
    let entry = sqlx::query_as::<_, TimeEntry>(
        "SELECT * FROM time_entries WHERE task_id = ? AND end_time IS NULL",
    )
    .bind(task_id)
    .fetch_optional(db)
    .await?;

    Ok(entry)
}

pub async fn delete_time_entry(db: &Db, entry_id: i64) -> Result<()> {
    println!("delete_time_entry called with entry_id: {}", entry_id);

    let result = sqlx::query("DELETE FROM time_entries WHERE id = ?")
        .bind(entry_id)
        .execute(db)
        .await?;

    println!("delete_time_entry affected {} rows", result.rows_affected());
    Ok(())
}

pub async fn get_task_total_time(db: &Db, task_id: i64) -> Result<i64> {
    let result: (Option<i64>,) = sqlx::query_as(
        "SELECT SUM(duration) FROM time_entries WHERE task_id = ? AND duration IS NOT NULL",
    )
    .bind(task_id)
    .fetch_one(db)
    .await?;

    Ok(result.0.unwrap_or(0))
}

/// The running timer. With `user_id`, that user's (or an unattributed one, from before
/// attribution existed): on a shared host a teammate's timer isn't yours. The newest wins
/// when more than one runs.
pub async fn get_global_active_time_entry(db: &Db, user_id: Option<i64>) -> Result<Option<(TimeEntry, Task)>> {
    let entry_opt = sqlx::query_as::<_, TimeEntry>(
        "SELECT * FROM time_entries WHERE end_time IS NULL AND (?1 IS NULL OR user_id = ?1 OR user_id IS NULL) \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    if let Some(entry) = entry_opt {
        // Get the associated task
        let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
            .bind(entry.task_id)
            .fetch_one(db)
            .await?;

        Ok(Some((entry, task)))
    } else {
        Ok(None)
    }
}

/// A task someone tracked time on, for the timer's "Recent" list.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentTimeTask {
    pub task_id: i64,
    pub task: Task,
    /// Every tracked second on the task (everyone's, finished entries).
    pub total_seconds: i64,
    /// When the user's latest entry on it started.
    pub last_tracked_at: DateTime<Utc>,
}

/// The last `limit` distinct live tasks `user_id` tracked time on, newest first (all users'
/// when `None`; unattributed entries count as the user's, as for the running timer).
pub async fn get_recent_time_tasks(db: &Db, user_id: Option<i64>, limit: i64) -> Result<Vec<RecentTimeTask>> {
    let rows: Vec<(i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT te.task_id, MAX(te.start_time) FROM time_entries te JOIN tasks t ON t.id = te.task_id \
         WHERE t.archived = 0 AND (?1 IS NULL OR te.user_id = ?1 OR te.user_id IS NULL) \
         GROUP BY te.task_id ORDER BY MAX(te.id) DESC LIMIT ?2",
    )
    .bind(user_id)
    .bind(limit.clamp(1, 50))
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (task_id, last_tracked_at) in rows {
        let task = sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?").bind(task_id).fetch_one(db).await?;
        let total_seconds = get_task_total_time(db, task_id).await?;
        out.push(RecentTimeTask { task_id, task, total_seconds, last_tracked_at });
    }
    Ok(out)
}

// ============== File Attachment Operations ==============

pub async fn get_file_attachments(db: &Db, task_id: i64) -> Result<Vec<FileAttachment>> {
    let attachments = sqlx::query_as::<_, FileAttachment>(
        "SELECT * FROM file_attachments WHERE task_id = ? ORDER BY created_at DESC",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;

    Ok(attachments)
}

pub async fn create_file_attachment(
    db: &Db,
    input: CreateFileAttachmentInput,
) -> Result<FileAttachment> {
    let now = Utc::now();

    let result = sqlx::query(
        r#"
        INSERT INTO file_attachments (
            task_id, file_path, file_name, file_type, file_size, notes, uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(input.task_id)
    .bind(&input.file_path)
    .bind(&input.file_name)
    .bind(&input.file_type)
    .bind(input.file_size)
    .bind(&input.notes)
    .bind(input.uploaded_by)
    .bind(now)
    .execute(db)
    .await?;

    let attachment_id = result.last_insert_rowid();

    let attachment =
        sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_one(db)
            .await?;

    Ok(attachment)
}

pub async fn update_file_attachment(
    db: &Db,
    attachment_id: i64,
    input: UpdateFileAttachmentInput,
) -> Result<FileAttachment> {
    // Get current attachment
    let current =
        sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_one(db)
            .await?;

    // Update with provided values or keep existing ones
    sqlx::query("UPDATE file_attachments SET file_path = ?, notes = ? WHERE id = ?")
        .bind(input.file_path.unwrap_or(current.file_path))
        .bind(input.notes.or(current.notes))
        .bind(attachment_id)
        .execute(db)
        .await?;

    let attachment =
        sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_one(db)
            .await?;

    Ok(attachment)
}

pub async fn delete_file_attachment(db: &Db, attachment_id: i64) -> Result<()> {
    println!(
        "delete_file_attachment called with attachment_id: {}",
        attachment_id
    );

    let result = sqlx::query("DELETE FROM file_attachments WHERE id = ?")
        .bind(attachment_id)
        .execute(db)
        .await?;

    println!(
        "delete_file_attachment affected {} rows",
        result.rows_affected()
    );
    Ok(())
}

/// Re-check whether the attachment's file still exists on the LOCAL filesystem.
/// Desktop-only semantics — see the module docs.
pub async fn verify_file_attachment(db: &Db, attachment_id: i64) -> Result<FileAttachment> {
    use std::path::Path;
    let now = Utc::now();

    // Get current attachment
    let attachment =
        sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_one(db)
            .await?;

    // Check if file exists
    let is_valid = Path::new(&attachment.file_path).exists();

    // Update verification status
    sqlx::query("UPDATE file_attachments SET is_valid = ?, last_verified_at = ? WHERE id = ?")
        .bind(is_valid as i32)
        .bind(now)
        .bind(attachment_id)
        .execute(db)
        .await?;

    let updated_attachment =
        sqlx::query_as::<_, FileAttachment>("SELECT * FROM file_attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_one(db)
            .await?;

    Ok(updated_attachment)
}

// ============== Comment Operations ==============

pub async fn get_task_comments(db: &Db, task_id: i64) -> Result<Vec<Comment>> {
    // A task's thread: comments whose home is this task, comments TAGGED with
    // it (the project board's multi-task updates), and every reply under those
    // — a reply lives on its thread's home task, which may be another task.
    // LEFT JOIN the agent's card so a comment authored by a personality shows
    // its face without a second (owner-only) profiles call from the client.
    let mut comments = sqlx::query_as::<_, Comment>(
        "WITH RECURSIVE thread(id) AS ( \
           SELECT id FROM comments WHERE task_id = ?1 \
             OR id IN (SELECT comment_id FROM comment_tasks WHERE task_id = ?1) \
           UNION SELECT c.id FROM comments c JOIN thread t ON c.parent_id = t.id \
         ) \
         SELECT c.*, mp.name AS profile_name, mp.avatar AS profile_avatar \
         FROM comments c LEFT JOIN model_profiles mp ON mp.id = c.profile_id \
         WHERE c.id IN (SELECT id FROM thread) ORDER BY c.created_at DESC",
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;
    fill_comment_tags(db, &mut comments).await?;
    Ok(comments)
}

/// Fill `task_ids` (home task first, then extra tags in tagging order).
async fn fill_comment_tags(db: &Db, comments: &mut [Comment]) -> Result<()> {
    let mut extra: HashMap<i64, Vec<i64>> = HashMap::new();
    for chunk in comments.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT comment_id, task_id FROM comment_tasks WHERE comment_id IN ({marks}) ORDER BY id");
        let mut q = sqlx::query_as::<_, (i64, i64)>(&sql);
        for c in chunk {
            q = q.bind(c.id);
        }
        for (cid, tid) in q.fetch_all(db).await? {
            extra.entry(cid).or_default().push(tid);
        }
    }
    for c in comments.iter_mut() {
        let mut ids = vec![c.task_id];
        for t in extra.remove(&c.id).unwrap_or_default() {
            if !ids.contains(&t) {
                ids.push(t);
            }
        }
        c.task_ids = ids;
    }
    Ok(())
}

async fn comment_with_tags(db: &Db, comment_id: i64) -> Result<Comment> {
    let mut c = vec![sqlx::query_as::<_, Comment>(
        "SELECT c.*, mp.name AS profile_name, mp.avatar AS profile_avatar \
         FROM comments c LEFT JOIN model_profiles mp ON mp.id = c.profile_id WHERE c.id = ?",
    )
    .bind(comment_id)
    .fetch_one(db)
    .await?];
    fill_comment_tags(db, &mut c).await?;
    Ok(c.remove(0))
}

/// Check every task belongs to `project_id`; returns them deduped, in order.
async fn same_project_tasks(db: &Db, project_id: i64, task_ids: &[i64]) -> Result<Vec<i64>> {
    let mut out: Vec<i64> = Vec::new();
    for &t in task_ids {
        if out.contains(&t) {
            continue;
        }
        let pid: Option<i64> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
            .bind(t)
            .fetch_optional(db)
            .await?;
        if pid != Some(project_id) {
            return Err(AppError::InvalidInput(format!("task {t} is not in this project")));
        }
        out.push(t);
    }
    if out.len() > 50 {
        return Err(AppError::InvalidInput("a comment can be tagged with at most 50 tasks".into()));
    }
    Ok(out)
}

/// Move a thread to another home task: the comment and every reply under it.
/// Bumps updated_at so replicas pull the move.
async fn rehome_thread(db: &Db, comment_id: i64, new_task: i64) -> Result<()> {
    sqlx::query(
        "WITH RECURSIVE thread(id) AS ( \
           SELECT ?1 UNION SELECT c.id FROM comments c JOIN thread t ON c.parent_id = t.id \
         ) \
         UPDATE comments SET task_id = ?2, updated_at = ?3 WHERE id IN (SELECT id FROM thread)",
    )
    .bind(comment_id)
    .bind(new_task)
    .bind(Utc::now())
    .execute(db)
    .await?;
    sqlx::query("DELETE FROM comment_tasks WHERE comment_id = ? AND task_id = ?")
        .bind(comment_id)
        .bind(new_task)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn create_comment(db: &Db, mut input: CreateCommentInput) -> Result<Comment> {
    let now = Utc::now();

    let home_project: Option<i64> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
        .bind(input.task_id)
        .fetch_optional(db)
        .await?;
    let home_project = home_project.ok_or_else(|| AppError::NotFound(format!("task {}", input.task_id)))?;
    // A reply lives on its thread's home task. Clients viewing a TAGGED task
    // may send that task instead — accept it within the same project (the
    // caller was authorized there), refuse a cross-project parent.
    if let Some(parent_id) = input.parent_id {
        let parent_task: Option<(i64, i64)> = sqlx::query_as(
            "SELECT c.task_id, t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?",
        )
        .bind(parent_id)
        .fetch_optional(db)
        .await?;
        match parent_task {
            Some((ptask, pproj)) if pproj == home_project => input.task_id = ptask,
            Some(_) => return Err(AppError::InvalidInput("reply target is in another project".into())),
            None => input.parent_id = None, // parent deleted meanwhile: post top-level
        }
    }
    let extra: Vec<i64> = if input.parent_id.is_some() {
        Vec::new()
    } else {
        same_project_tasks(db, home_project, &input.task_ids)
            .await?
            .into_iter()
            .filter(|t| *t != input.task_id)
            .collect()
    };

    let result = sqlx::query(
        "INSERT INTO comments (task_id, content, user_id, parent_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(input.task_id)
    .bind(&input.content)
    .bind(input.user_id)
    .bind(input.parent_id)
    .bind(input.profile_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let comment_id = result.last_insert_rowid();
    for t in &extra {
        sqlx::query("INSERT OR IGNORE INTO comment_tasks (comment_id, task_id, created_at) VALUES (?, ?, ?)")
            .bind(comment_id)
            .bind(t)
            .bind(now)
            .execute(db)
            .await?;
    }

    let comment = comment_with_tags(db, comment_id).await?;

    // The project, so project-scoped rules can match on a comment.
    let project_id = Some(home_project);
    emit(DomainEvent {
        kind: "comment.created".into(),
        project_id,
        entity_id: comment.id,
        data: serde_json::json!({ "task_id": comment.task_id, "task_ids": comment.task_ids, "user_id": comment.user_id }),
    });
    // @mention pings (best-effort — never fail a comment over a notification).
    notify_mentions(db, &comment.content, comment.task_id, project_id, comment.user_id).await;
    Ok(comment)
}

pub async fn update_comment(db: &Db, comment_id: i64, input: UpdateCommentInput) -> Result<Comment> {
    let now = Utc::now();

    sqlx::query("UPDATE comments SET content = ?, updated_at = ? WHERE id = ?")
        .bind(&input.content)
        .bind(now)
        .bind(comment_id)
        .execute(db)
        .await?;

    comment_with_tags(db, comment_id).await
}

/// Retag a top-level comment: `task_ids` becomes its full tag set (non-empty,
/// all in the comment's project). The home task stays if still tagged; if it
/// was removed, the first remaining task becomes home (replies move with it).
pub async fn set_comment_tags(db: &Db, comment_id: i64, task_ids: Vec<i64>) -> Result<Comment> {
    let (home, parent, project_id): (i64, Option<i64>, i64) = sqlx::query_as(
        "SELECT c.task_id, c.parent_id, t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?",
    )
    .bind(comment_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("comment {comment_id}")))?;
    if parent.is_some() {
        return Err(AppError::InvalidInput("replies follow their thread — tag the top-level comment".into()));
    }
    let wanted = same_project_tasks(db, project_id, &task_ids).await?;
    let Some(&first) = wanted.first() else {
        return Err(AppError::InvalidInput("tag at least one task".into()));
    };
    let new_home = if wanted.contains(&home) { home } else { first };
    if new_home != home {
        rehome_thread(db, comment_id, new_home).await?;
    }
    let extras: Vec<i64> = wanted.into_iter().filter(|t| *t != new_home).collect();
    let existing: Vec<i64> = sqlx::query_scalar("SELECT task_id FROM comment_tasks WHERE comment_id = ?")
        .bind(comment_id)
        .fetch_all(db)
        .await?;
    // Row-level diff (not delete-all + reinsert): untouched tags keep their
    // sync identity, so replicas see only the real change.
    for t in existing.iter().filter(|t| !extras.contains(t)) {
        sqlx::query("DELETE FROM comment_tasks WHERE comment_id = ? AND task_id = ?")
            .bind(comment_id)
            .bind(t)
            .execute(db)
            .await?;
    }
    let now = Utc::now();
    for t in extras.iter().filter(|t| !existing.contains(t)) {
        sqlx::query("INSERT OR IGNORE INTO comment_tasks (comment_id, task_id, created_at) VALUES (?, ?, ?)")
            .bind(comment_id)
            .bind(t)
            .bind(now)
            .execute(db)
            .await?;
    }
    comment_with_tags(db, comment_id).await
}

/// The project comment board. Top-level comments newest first (at most
/// `limit`, optionally only those tagged with ANY of `task_ids`), each with
/// its replies; a comment shows while at least one of its tasks is out of the
/// Bin. `since` (RFC 3339, the client's local midnight) adds per-task tracked
/// seconds from then — the composer's "worked on today" suggestions.
pub async fn get_project_comment_board(
    db: &Db,
    project_id: i64,
    task_ids: Option<Vec<i64>>,
    limit: Option<i64>,
    since: Option<String>,
) -> Result<CommentBoard> {
    get_project_comment_board_among(db, project_id, task_ids, limit, since, None).await
}

/// The board as a member sees it: only updates tagged on a task in `only` (the ones
/// they can see), with hidden tags trimmed, and counts and time over visible tasks.
/// `None` shows everything.
pub async fn get_project_comment_board_among(
    db: &Db,
    project_id: i64,
    task_ids: Option<Vec<i64>>,
    limit: Option<i64>,
    since: Option<String>,
    only: Option<&std::collections::HashSet<i64>>,
) -> Result<CommentBoard> {
    let limit = limit.unwrap_or(50).clamp(1, 1000);
    let seen = crate::visibility::json_ids(only);
    let filter: Vec<i64> = task_ids.unwrap_or_default().into_iter().take(200).collect();
    let mut sql = String::from(
        "SELECT c.*, mp.name AS profile_name, mp.avatar AS profile_avatar \
         FROM comments c JOIN tasks t ON t.id = c.task_id \
         LEFT JOIN model_profiles mp ON mp.id = c.profile_id \
         WHERE t.project_id = ? AND c.parent_id IS NULL \
           AND (t.archived = 0 OR EXISTS (SELECT 1 FROM comment_tasks ct JOIN tasks t2 ON t2.id = ct.task_id \
                                          WHERE ct.comment_id = c.id AND t2.archived = 0))",
    );
    if !filter.is_empty() {
        let marks = vec!["?"; filter.len()].join(",");
        sql.push_str(&format!(
            " AND (c.task_id IN ({marks}) OR EXISTS (SELECT 1 FROM comment_tasks ct WHERE ct.comment_id = c.id AND ct.task_id IN ({marks})))"
        ));
    }
    if seen.is_some() {
        sql.push_str(
            " AND (c.task_id IN (SELECT value FROM json_each(?)) \
                   OR EXISTS (SELECT 1 FROM comment_tasks ct WHERE ct.comment_id = c.id \
                              AND ct.task_id IN (SELECT value FROM json_each(?))))",
        );
    }
    // julianday: rows written by different paths/replicas mix timestamp
    // spellings ('T' vs ' '), which a plain text sort would misorder.
    sql.push_str(" ORDER BY julianday(c.created_at) DESC, c.id DESC LIMIT ?");
    let mut q = sqlx::query_as::<_, Comment>(&sql).bind(project_id);
    for _ in 0..2 {
        if !filter.is_empty() {
            for t in &filter {
                q = q.bind(t);
            }
        }
    }
    if let Some(seen) = &seen {
        q = q.bind(seen).bind(seen);
    }
    let mut roots = q.bind(limit + 1).fetch_all(db).await?;
    let has_more = roots.len() as i64 > limit;
    roots.truncate(limit as usize);

    // Every reply under the listed roots (any depth).
    let mut replies: Vec<Comment> = Vec::new();
    for chunk in roots.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "WITH RECURSIVE thread(id) AS ( \
               SELECT id FROM comments WHERE parent_id IN ({marks}) \
               UNION SELECT c.id FROM comments c JOIN thread t ON c.parent_id = t.id \
             ) \
             SELECT c.*, mp.name AS profile_name, mp.avatar AS profile_avatar \
             FROM comments c LEFT JOIN model_profiles mp ON mp.id = c.profile_id \
             WHERE c.id IN (SELECT id FROM thread) ORDER BY julianday(c.created_at), c.id"
        );
        let mut q = sqlx::query_as::<_, Comment>(&sql);
        for c in chunk {
            q = q.bind(c.id);
        }
        replies.extend(q.fetch_all(db).await?);
    }
    let mut comments = roots;
    comments.extend(replies);
    fill_comment_tags(db, &mut comments).await?;
    if let Some(only) = only {
        crate::visibility::trim_comment_tags(&mut comments, only);
    }

    let task_counts = sqlx::query_as::<_, TaskCount>(
        "SELECT task_id, COUNT(*) AS count FROM ( \
           SELECT c.id, c.task_id FROM comments c JOIN tasks t ON t.id = c.task_id \
             WHERE t.project_id = ? AND c.parent_id IS NULL \
           UNION SELECT ct.comment_id, ct.task_id FROM comment_tasks ct \
             JOIN comments c ON c.id = ct.comment_id JOIN tasks t ON t.id = ct.task_id \
             WHERE t.project_id = ? AND c.parent_id IS NULL \
         ) GROUP BY task_id",
    )
    .bind(project_id)
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let time_since = match since.filter(|s| !s.is_empty() && s.len() <= 40) {
        Some(since) => {
            sqlx::query_as::<_, TaskSeconds>(
                "SELECT te.task_id AS task_id, \
                   CAST(SUM(COALESCE(te.duration, (julianday('now') - julianday(te.start_time)) * 86400)) AS INTEGER) AS seconds \
                 FROM time_entries te JOIN tasks t ON t.id = te.task_id \
                 WHERE t.project_id = ? AND julianday(te.start_time) >= julianday(?) \
                 GROUP BY te.task_id HAVING seconds > 0 ORDER BY seconds DESC",
            )
            .bind(project_id)
            .bind(since)
            .fetch_all(db)
            .await?
        }
        None => Vec::new(),
    };

    let (mut task_counts, mut time_since) = (task_counts, time_since);
    if let Some(only) = only {
        task_counts.retain(|c| only.contains(&c.task_id));
        time_since.retain(|t| only.contains(&t.task_id));
    }
    Ok(CommentBoard { comments, task_counts, has_more, time_since })
}

pub async fn delete_comment(db: &Db, comment_id: i64) -> Result<()> {
    println!("delete_comment called with comment_id: {}", comment_id);

    let result = sqlx::query("DELETE FROM comments WHERE id = ?")
        .bind(comment_id)
        .execute(db)
        .await?;

    println!("delete_comment affected {} rows", result.rows_affected());
    Ok(())
}

// ============== Comment Reactions ==============

/// Toggle a user's emoji reaction on a comment. Returns true if it's now set,
/// false if it was removed (re-reacting the same emoji un-reacts).
pub async fn toggle_comment_reaction(db: &Db, comment_id: i64, user_id: i64, emoji: &str) -> Result<bool> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?",
    )
    .bind(comment_id)
    .bind(user_id)
    .bind(emoji)
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        sqlx::query("DELETE FROM comment_reactions WHERE id = ?").bind(id).execute(db).await?;
        Ok(false)
    } else {
        // OR IGNORE: a concurrent identical reaction (rapid double-tap / two
        // devices) is a no-op rather than a UNIQUE-constraint error.
        sqlx::query("INSERT OR IGNORE INTO comment_reactions (comment_id, user_id, emoji) VALUES (?, ?, ?)")
            .bind(comment_id)
            .bind(user_id)
            .bind(emoji)
            .execute(db)
            .await?;
        Ok(true)
    }
}

/// Reaction tallies for every comment under a task, with `mine` flagged for `user_id`.
pub async fn task_reaction_summary(db: &Db, task_id: i64, user_id: i64) -> Result<Vec<ReactionSummary>> {
    Ok(sqlx::query_as::<_, ReactionSummary>(
        r#"
        SELECT r.comment_id AS comment_id, r.emoji AS emoji, COUNT(*) AS count,
               MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS mine
        FROM comment_reactions r
        WHERE r.comment_id IN (
          WITH RECURSIVE thread(id) AS (
            SELECT id FROM comments WHERE task_id = ?2
              OR id IN (SELECT comment_id FROM comment_tasks WHERE task_id = ?2)
            UNION SELECT c.id FROM comments c JOIN thread t ON c.parent_id = t.id
          ) SELECT id FROM thread)
        GROUP BY r.comment_id, r.emoji
        ORDER BY r.comment_id, MIN(r.created_at)
        "#,
    )
    .bind(user_id)
    .bind(task_id)
    .fetch_all(db)
    .await?)
}

/// Reaction tallies for every comment in a project (the comment board).
pub async fn project_reaction_summary(db: &Db, project_id: i64, user_id: i64) -> Result<Vec<ReactionSummary>> {
    Ok(sqlx::query_as::<_, ReactionSummary>(
        r#"
        SELECT r.comment_id AS comment_id, r.emoji AS emoji, COUNT(*) AS count,
               MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS mine
        FROM comment_reactions r
        JOIN comments c ON c.id = r.comment_id
        JOIN tasks t ON t.id = c.task_id
        WHERE t.project_id = ?
        GROUP BY r.comment_id, r.emoji
        ORDER BY r.comment_id, MIN(r.created_at)
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_all(db)
    .await?)
}

// ============== Notifications ==============

pub async fn create_notification(
    db: &Db,
    user_id: i64,
    category: &str,
    title: &str,
    body: Option<&str>,
    link_task_id: Option<i64>,
) -> Result<()> {
    sqlx::query("INSERT INTO notifications (user_id, category, title, body, link_task_id) VALUES (?, ?, ?, ?, ?)")
        .bind(user_id)
        .bind(category)
        .bind(title)
        .bind(body)
        .bind(link_task_id)
        .execute(db)
        .await?;
    Ok(())
}

/// A user's latest notifications. One about a task stays only while the user is
/// a member of that task's project: it can quote the task's comments.
pub async fn list_notifications(db: &Db, user_id: i64) -> Result<Vec<Notification>> {
    Ok(sqlx::query_as::<_, Notification>(
        "SELECT n.* FROM notifications n WHERE n.user_id = ?1 \
         AND (n.link_task_id IS NULL \
              OR EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND u.is_owner = 1) \
              OR EXISTS (SELECT 1 FROM tasks t JOIN project_members pm ON pm.project_id = t.project_id \
                         WHERE t.id = n.link_task_id AND pm.user_id = ?1)) \
         ORDER BY n.created_at DESC LIMIT 50",
    )
        .bind(user_id)
        .fetch_all(db)
        .await?)
}

pub async fn mark_notifications_read(db: &Db, user_id: i64) -> Result<()> {
    sqlx::query("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

// ---- In-app tickets (bug reports / feature requests) ----

/// File a ticket for `user_id`. `kind` is normalized to "feature" or "bug".
pub async fn create_ticket(db: &Db, user_id: i64, kind: &str, title: &str, body: Option<&str>) -> Result<crate::models::Ticket> {
    let kind = if kind.eq_ignore_ascii_case("feature") { "feature" } else { "bug" };
    let title = title.trim();
    if title.is_empty() {
        return Err(crate::error::AppError::InvalidInput("a ticket needs a title".into()));
    }
    let id = sqlx::query("INSERT INTO tickets (user_id, kind, title, body) VALUES (?, ?, ?, ?)")
        .bind(user_id)
        .bind(kind)
        .bind(title)
        .bind(body.map(str::trim).filter(|s| !s.is_empty()))
        .execute(db)
        .await?
        .last_insert_rowid();
    Ok(sqlx::query_as::<_, crate::models::Ticket>("SELECT * FROM tickets WHERE id = ?")
        .bind(id)
        .fetch_one(db)
        .await?)
}

/// List tickets for a viewer: the owner sees ALL; everyone else sees only their
/// own. The owner-vs-member decision lives here so both the local command and
/// the daemon's /invoke arm scope identically. Newest first, with submitter name.
pub async fn list_tickets(db: &Db, viewer_user_id: i64) -> Result<Vec<crate::models::Ticket>> {
    let is_owner = sqlx::query_scalar::<_, i64>("SELECT is_owner FROM users WHERE id = ?")
        .bind(viewer_user_id)
        .fetch_optional(db)
        .await?
        .unwrap_or(0)
        != 0;
    let base = "SELECT t.*, u.full_name AS submitter_name FROM tickets t LEFT JOIN users u ON u.id = t.user_id";
    let rows = if is_owner {
        sqlx::query_as::<_, crate::models::Ticket>(&format!("{base} ORDER BY t.created_at DESC LIMIT 500"))
            .fetch_all(db)
            .await?
    } else {
        sqlx::query_as::<_, crate::models::Ticket>(&format!("{base} WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 500"))
            .bind(viewer_user_id)
            .fetch_all(db)
            .await?
    };
    Ok(rows)
}

/// Set a ticket's status ("open"/"closed"). Owner-gated at the call sites.
pub async fn set_ticket_status(db: &Db, id: i64, status: &str) -> Result<()> {
    let status = if status.eq_ignore_ascii_case("closed") { "closed" } else { "open" };
    sqlx::query("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Parse `@name` mentions (a-z, 0-9, '_'), lowercased + deduped.
fn parse_mentions(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // A mention's '@' must start a token (start-of-text or after a non-word
        // char), so an email's `foo@bar` doesn't read `bar` as a mention.
        if b[i] == b'@' && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_')) {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if j > start {
                let name = text[start..j].to_lowercase();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            i = j.max(start);
        } else {
            i += 1;
        }
    }
    out
}

/// Notify each @mentioned project member (never the author) about a new comment.
async fn notify_mentions(db: &Db, content: &str, task_id: i64, _project_id: Option<i64>, author: Option<i64>) {
    let mentions = parse_mentions(content);
    if mentions.is_empty() {
        return;
    }
    let who = match author {
        Some(a) => sqlx::query_scalar::<_, String>("SELECT COALESCE(NULLIF(full_name, ''), username) FROM users WHERE id = ?")
            .bind(a)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "Someone".into()),
        None => "Someone".into(),
    };
    let snippet: String = content.chars().take(140).collect();
    for name in mentions {
        let row: Option<(i64, i64)> = sqlx::query_as("SELECT id, is_owner FROM users WHERE lower(username) = ?")
            .bind(&name)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        let Some((uid, is_owner)) = row else { continue };
        if Some(uid) == author {
            continue;
        }
        // Notify only people who can see the task (task visibility; the owner sees all).
        let viewer = crate::visibility::Viewer { user_id: uid, is_owner: is_owner == 1 };
        if crate::visibility::can_see_task(db, viewer, task_id).await.unwrap_or(false) {
            let _ = create_notification(db, uid, "comment", &format!("{who} mentioned you"), Some(&snippet), Some(task_id)).await;
        }
    }
}

// ============== Custom Emojis ==============

pub async fn list_custom_emojis(db: &Db) -> Result<Vec<CustomEmoji>> {
    Ok(sqlx::query_as::<_, CustomEmoji>("SELECT * FROM custom_emojis ORDER BY name ASC")
        .fetch_all(db)
        .await?)
}

/// Register a custom emoji. `name` is the `:name:` shortcode (a-z, 0-9, '_'),
/// `image` a (small, resized) data-URL. The author is recorded for delete authz.
pub async fn create_custom_emoji(db: &Db, name: &str, image: &str, user_id: Option<i64>) -> Result<CustomEmoji> {
    let name = name.trim();
    let ok_name = (1..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !ok_name {
        return Err(crate::error::AppError::InvalidInput(
            "emoji name must be 1-32 chars of a-z, 0-9, '_' (used as :name:)".into(),
        ));
    }
    if !image.starts_with("data:image/") || image.len() > 256_000 {
        return Err(crate::error::AppError::InvalidInput("image must be a small data-URL (≤256 KB)".into()));
    }
    let res = sqlx::query("INSERT INTO custom_emojis (name, image, user_id) VALUES (?, ?, ?)")
        .bind(name)
        .bind(image)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(sqlx::query_as::<_, CustomEmoji>("SELECT * FROM custom_emojis WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(db)
        .await?)
}

/// The author of a custom emoji (for delete authz: owner OR author).
pub async fn custom_emoji_author(db: &Db, id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, Option<i64>>("SELECT user_id FROM custom_emojis WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .flatten())
}

pub async fn delete_custom_emoji(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM custom_emojis WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ============== Event Operations ==============

/// The start of every event read: the row plus its file count (`Event::file_count`).
/// Callers append a `WHERE` on the bare `events` table.
macro_rules! event_select {
    () => {
        "SELECT events.*, (SELECT COUNT(*) FROM event_attachments x WHERE x.event_id = events.id) AS file_count FROM events"
    };
}

pub async fn get_events(
    db: &Db,
    start_date: Option<String>,
    end_date: Option<String>,
    archived: Option<bool>,
) -> Result<Vec<Event>> {
    // Build query based on parameters
    let has_date_range = start_date.is_some() && end_date.is_some();
    let filter_archived = archived.unwrap_or(false); // Default to non-archived

    // Recurring masters (rrule IS NOT NULL) are returned regardless of the date
    // window: their DTSTART may predate it while occurrences fall inside — the
    // client expands them. Non-recurring events keep the date filter.
    //
    // The window bounds are date-only strings ("2026-06-17") while event_date is
    // a full ISO timestamp ("2026-06-17T15:00:00Z"). Comparing the raw strings
    // makes `event_date <= end` exclude anything with a time-of-day on the end
    // day (a longer string with the same prefix sorts greater) — which silently
    // emptied the Day view, where start == end. Compare the date portion of
    // both sides so the end day is inclusive.
    let query = match (has_date_range, archived.is_some()) {
        (true, true) => concat!(event_select!(), " WHERE ((substr(event_date, 1, 10) >= substr(?, 1, 10) AND substr(event_date, 1, 10) <= substr(?, 1, 10)) OR rrule IS NOT NULL) AND archived = ? ORDER BY event_date ASC, start_time ASC"),
        (true, false) => concat!(event_select!(), " WHERE ((substr(event_date, 1, 10) >= substr(?, 1, 10) AND substr(event_date, 1, 10) <= substr(?, 1, 10)) OR rrule IS NOT NULL) AND archived = 0 ORDER BY event_date ASC, start_time ASC"),
        (false, true) => concat!(event_select!(), " WHERE archived = ? ORDER BY event_date ASC, start_time ASC"),
        (false, false) => concat!(event_select!(), " WHERE archived = 0 ORDER BY event_date ASC, start_time ASC"),
    };

    let mut query_builder = sqlx::query_as::<_, Event>(query);

    if let (Some(start), Some(end)) = (start_date, end_date) {
        query_builder = query_builder.bind(start).bind(end);
    }

    if archived.is_some() {
        query_builder = query_builder.bind(filter_archived as i32);
    }

    let events = query_builder.fetch_all(db).await?;

    Ok(events)
}

pub async fn get_event(db: &Db, event_id: i64) -> Result<Event> {
    let event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    Ok(event)
}

pub async fn create_event(db: &Db, input: CreateEventInput) -> Result<Event> {
    let now = Utc::now();

    let result = sqlx::query(
        r#"
        INSERT INTO events (
            title, description, location, event_date, start_time, end_time,
            all_day, reminder_minutes, notification_enabled, rrule, exdates, series_id,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.location)
    .bind(input.event_date)
    .bind(&input.start_time)
    .bind(&input.end_time)
    .bind(input.all_day as i32)
    .bind(input.reminder_minutes)
    .bind(input.notification_enabled as i32)
    .bind(&input.rrule)
    .bind(clean_exdates(input.exdates))
    .bind(input.series_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let event_id = result.last_insert_rowid();

    let event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    emit(DomainEvent {
        kind: "event.created".into(),
        project_id: None, // events link to projects separately (event_projects)
        entity_id: event.id,
        data: serde_json::json!({ "event_date": event.event_date, "all_day": event.all_day }),
    });
    Ok(event)
}

/// A repeating event's skipped days as stored: the valid ISO dates ("YYYY-MM-DD"),
/// sorted and without repeats, comma-separated; none at all is NULL.
pub fn clean_exdates(raw: Option<String>) -> Option<String> {
    let mut days: Vec<&str> = raw
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
        .collect();
    days.sort_unstable();
    days.dedup();
    (!days.is_empty()).then(|| days.join(","))
}

pub async fn update_event(db: &Db, event_id: i64, input: UpdateEventInput) -> Result<Event> {
    let now = Utc::now();

    // Get current event
    let current_event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    // Update with provided values or keep existing ones
    sqlx::query(
        r#"
        UPDATE events
        SET title = ?,
            description = ?,
            location = ?,
            event_date = ?,
            start_time = ?,
            end_time = ?,
            all_day = ?,
            reminder_minutes = ?,
            notification_enabled = ?,
            rrule = ?,
            exdates = ?,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(input.title.unwrap_or(current_event.title))
    .bind(input.description.or(current_event.description))
    .bind(input.location.or(current_event.location))
    .bind(input.event_date.unwrap_or(current_event.event_date))
    .bind(input.start_time.or(current_event.start_time))
    .bind(input.end_time.or(current_event.end_time))
    .bind(input.all_day.unwrap_or(current_event.all_day) as i32)
    .bind(input.reminder_minutes.or(current_event.reminder_minutes))
    .bind(input.notification_enabled.unwrap_or(current_event.notification_enabled) as i32)
    .bind(input.rrule.unwrap_or(current_event.rrule))
    .bind(match input.exdates {
        Some(v) => clean_exdates(v),
        None => current_event.exdates,
    })
    .bind(now)
    .bind(event_id)
    .execute(db)
    .await?;

    let event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    Ok(event)
}

pub async fn delete_event(db: &Db, event_id: i64) -> Result<()> {
    println!("delete_event called with event_id: {} (archiving)", event_id);

    let now = Utc::now();

    // Soft delete by setting archived = true
    let result = sqlx::query("UPDATE events SET archived = 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(event_id)
        .execute(db)
        .await?;

    println!("delete_event affected {} rows", result.rows_affected());
    Ok(())
}

pub async fn archive_event(db: &Db, event_id: i64, archived: bool) -> Result<Event> {
    let now = Utc::now();

    sqlx::query("UPDATE events SET archived = ?, updated_at = ? WHERE id = ?")
        .bind(archived as i32)
        .bind(now)
        .bind(event_id)
        .execute(db)
        .await?;

    let event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    Ok(event)
}

pub async fn restore_event(db: &Db, event_id: i64) -> Result<Event> {
    let now = Utc::now();

    sqlx::query("UPDATE events SET archived = 0, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(event_id)
        .execute(db)
        .await?;

    let event = sqlx::query_as::<_, Event>(concat!(event_select!(), " WHERE id = ?"))
        .bind(event_id)
        .fetch_one(db)
        .await?;

    Ok(event)
}

/// Mark an event past by hand (`done`), or upcoming again. For a recurring event it
/// covers the whole series. Marking an event that's already marked keeps the first time.
pub async fn set_event_done(db: &Db, event_id: i64, done: bool) -> Result<Event> {
    let now = Utc::now();
    let sql = if done {
        "UPDATE events SET done_at = COALESCE(done_at, ?), updated_at = ? WHERE id = ?"
    } else {
        "UPDATE events SET done_at = NULL, updated_at = ? WHERE id = ?"
    };
    let mut q = sqlx::query(sql);
    if done {
        q = q.bind(now);
    }
    let res = q.bind(now).bind(event_id).execute(db).await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("event {event_id}")));
    }
    get_event(db, event_id).await
}

pub async fn permanently_delete_event(db: &Db, event_id: i64) -> Result<()> {
    println!("permanently_delete_event called with event_id: {}", event_id);

    let result = sqlx::query("DELETE FROM events WHERE id = ?")
        .bind(event_id)
        .execute(db)
        .await?;

    println!(
        "permanently_delete_event affected {} rows",
        result.rows_affected()
    );
    Ok(())
}

pub async fn link_event_to_task(db: &Db, event_id: i64, task_id: i64) -> Result<EventTask> {
    let now = Utc::now();

    let result =
        sqlx::query("INSERT INTO event_tasks (event_id, task_id, created_at) VALUES (?, ?, ?)")
            .bind(event_id)
            .bind(task_id)
            .bind(now)
            .execute(db)
            .await?;

    let link_id = result.last_insert_rowid();

    let event_task = sqlx::query_as::<_, EventTask>("SELECT * FROM event_tasks WHERE id = ?")
        .bind(link_id)
        .fetch_one(db)
        .await?;

    Ok(event_task)
}

pub async fn unlink_event_from_task(db: &Db, event_id: i64, task_id: i64) -> Result<()> {
    println!(
        "unlink_event_from_task called with event_id: {}, task_id: {}",
        event_id, task_id
    );

    let result = sqlx::query("DELETE FROM event_tasks WHERE event_id = ? AND task_id = ?")
        .bind(event_id)
        .bind(task_id)
        .execute(db)
        .await?;

    println!(
        "unlink_event_from_task affected {} rows",
        result.rows_affected()
    );
    Ok(())
}

pub async fn get_event_tasks(db: &Db, event_id: i64) -> Result<Vec<Task>> {
    let tasks = sqlx::query_as::<_, Task>(
        r#"
        SELECT t.* FROM tasks t
        INNER JOIN event_tasks et ON t.id = et.task_id
        WHERE et.event_id = ?
        ORDER BY t.created_at DESC
        "#,
    )
    .bind(event_id)
    .fetch_all(db)
    .await?;

    Ok(tasks)
}

pub async fn get_task_events(db: &Db, task_id: i64) -> Result<Vec<Event>> {
    let events = sqlx::query_as::<_, Event>(
        r#"
        SELECT e.*, (SELECT COUNT(*) FROM event_attachments x WHERE x.event_id = e.id) AS file_count FROM events e
        INNER JOIN event_tasks et ON e.id = et.event_id
        WHERE et.task_id = ? AND e.archived = 0
        ORDER BY e.event_date ASC
        "#,
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;

    Ok(events)
}

/// Distinct IDs of every event linked to at least one still-present task. The
/// agenda's "hide events connected to tasks" filter masks against this; the
/// INNER JOIN mirrors get_event_tasks so a link to a deleted task doesn't count
/// (unlinks hard-delete the junction row, so no deleted_at filter is needed).
pub async fn get_task_linked_event_ids(db: &Db) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT et.event_id FROM event_tasks et
        INNER JOIN tasks t ON t.id = et.task_id
        "#,
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn link_event_to_project(db: &Db, event_id: i64, project_id: i64) -> Result<EventProject> {
    let now = Utc::now();

    let result = sqlx::query(
        "INSERT INTO event_projects (event_id, project_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(event_id)
    .bind(project_id)
    .bind(now)
    .execute(db)
    .await?;

    let link_id = result.last_insert_rowid();

    let event_project =
        sqlx::query_as::<_, EventProject>("SELECT * FROM event_projects WHERE id = ?")
            .bind(link_id)
            .fetch_one(db)
            .await?;

    Ok(event_project)
}

pub async fn unlink_event_from_project(db: &Db, event_id: i64, project_id: i64) -> Result<()> {
    println!(
        "unlink_event_from_project called with event_id: {}, project_id: {}",
        event_id, project_id
    );

    let result =
        sqlx::query("DELETE FROM event_projects WHERE event_id = ? AND project_id = ?")
            .bind(event_id)
            .bind(project_id)
            .execute(db)
            .await?;

    println!(
        "unlink_event_from_project affected {} rows",
        result.rows_affected()
    );
    Ok(())
}

pub async fn get_event_projects(db: &Db, event_id: i64) -> Result<Vec<Project>> {
    let projects = sqlx::query_as::<_, Project>(
        r#"
        SELECT p.* FROM projects p
        INNER JOIN event_projects ep ON p.id = ep.project_id
        WHERE ep.event_id = ?
        ORDER BY p.name ASC
        "#,
    )
    .bind(event_id)
    .fetch_all(db)
    .await?;

    Ok(projects)
}

pub async fn get_project_events(
    db: &Db,
    project_id: i64,
    archived: Option<bool>,
) -> Result<Vec<Event>> {
    let query = match archived {
        Some(true) => {
            r#"
            SELECT e.*, (SELECT COUNT(*) FROM event_attachments x WHERE x.event_id = e.id) AS file_count FROM events e
            INNER JOIN event_projects ep ON e.id = ep.event_id
            WHERE ep.project_id = ? AND e.archived = 1
            ORDER BY e.event_date ASC, e.start_time ASC
            "#
        }
        Some(false) => {
            r#"
            SELECT e.*, (SELECT COUNT(*) FROM event_attachments x WHERE x.event_id = e.id) AS file_count FROM events e
            INNER JOIN event_projects ep ON e.id = ep.event_id
            WHERE ep.project_id = ? AND e.archived = 0
            ORDER BY e.event_date ASC, e.start_time ASC
            "#
        }
        None => {
            // Unspecified = active only (matches get_tasks's archived.unwrap_or(false)),
            // so a binned event never leaks into a project's event list.
            r#"
            SELECT e.*, (SELECT COUNT(*) FROM event_attachments x WHERE x.event_id = e.id) AS file_count FROM events e
            INNER JOIN event_projects ep ON e.id = ep.event_id
            WHERE ep.project_id = ? AND e.archived = 0
            ORDER BY e.event_date ASC, e.start_time ASC
            "#
        }
    };

    let events = sqlx::query_as::<_, Event>(query)
        .bind(project_id)
        .fetch_all(db)
        .await?;

    Ok(events)
}

/// Names of the projects an event is linked to (for the secretary's daily brief,
/// so it can attribute "your 1pm is for Project X"). Empty for unallocated events.
pub async fn event_project_names(db: &Db, event_id: i64) -> Result<Vec<String>> {
    let names = sqlx::query_scalar::<_, String>(
        "SELECT p.name FROM event_projects ep JOIN projects p ON p.id = ep.project_id WHERE ep.event_id = ? ORDER BY p.name",
    )
    .bind(event_id)
    .fetch_all(db)
    .await?;
    Ok(names)
}

// ============== Project Members Overview ==============

/// Per-member rollup for a project's Members tab: role + join date, presence
/// (latest device last-seen), and tracked time broken down by task. Time is
/// only attributed for entries logged after the user_id column was added.
pub async fn get_project_member_overview(db: &Db, project_id: i64) -> Result<Vec<ProjectMemberOverview>> {
    get_project_member_overview_among(db, project_id, None).await
}

/// The members' overview, with each one's time only on the tasks in `only` (the ones
/// the asking member can see: task visibility). `None` counts every task.
pub async fn get_project_member_overview_among(
    db: &Db,
    project_id: i64,
    only: Option<&std::collections::HashSet<i64>>,
) -> Result<Vec<ProjectMemberOverview>> {
    let ids = crate::visibility::json_ids(only);
    let rows = sqlx::query_as::<_, (i64, String, String, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        SELECT u.id, u.username, u.full_name, pm.role, pm.created_at,
               (SELECT MAX(dt.last_seen_at) FROM device_tokens dt WHERE dt.user_id = u.id) AS last_seen
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.full_name ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (user_id, username, display_name, role, joined_at, last_seen_at) in rows {
        let task_rows = sqlx::query_as::<_, (i64, String, i64)>(
            r#"
            SELECT te.task_id, t.title, SUM(COALESCE(te.duration, 0)) AS secs
            FROM time_entries te
            JOIN tasks t ON t.id = te.task_id
            WHERE t.project_id = ? AND te.user_id = ?
              AND (?3 IS NULL OR t.id IN (SELECT value FROM json_each(?3)))
            GROUP BY te.task_id, t.title
            HAVING secs > 0
            ORDER BY secs DESC
            "#,
        )
        .bind(project_id)
        .bind(user_id)
        .bind(&ids)
        .fetch_all(db)
        .await?;

        let by_task: Vec<MemberTaskTime> = task_rows
            .into_iter()
            .map(|(task_id, task_title, seconds)| MemberTaskTime { task_id, task_title, seconds })
            .collect();
        let total_seconds = by_task.iter().map(|t| t.seconds).sum();

        out.push(ProjectMemberOverview {
            user_id,
            username,
            display_name,
            role,
            joined_at,
            last_seen_at,
            total_seconds,
            by_task,
        });
    }
    Ok(out)
}

// ============== Calendar Subscription Operations ==============
// Owner-managed external ICS/webcal feeds. Host-only (not synced); the events
// they import flow through the normal (synced) events table tagged by calendar_id.

pub async fn get_calendar_subscriptions(db: &Db) -> Result<Vec<CalendarSubscription>> {
    let subs = sqlx::query_as::<_, CalendarSubscription>(
        "SELECT * FROM calendar_subscriptions ORDER BY created_at ASC",
    )
    .fetch_all(db)
    .await?;
    Ok(subs)
}

pub async fn get_calendar_subscription(db: &Db, id: i64) -> Result<Option<CalendarSubscription>> {
    let sub = sqlx::query_as::<_, CalendarSubscription>("SELECT * FROM calendar_subscriptions WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(sub)
}

pub async fn create_calendar_subscription(
    db: &Db,
    input: CreateCalendarSubscriptionInput,
) -> Result<CalendarSubscription> {
    let name = input.name.trim();
    let url = input.url.trim();
    if name.is_empty() || url.is_empty() {
        return Err(crate::AppError::InvalidInput("name and url are required".into()));
    }
    let result = sqlx::query(
        "INSERT INTO calendar_subscriptions (name, url, color) VALUES (?, ?, ?)",
    )
    .bind(name)
    .bind(url)
    .bind(&input.color)
    .execute(db)
    .await?;
    get_calendar_subscription(db, result.last_insert_rowid())
        .await?
        .ok_or_else(|| crate::AppError::NotFound("calendar subscription".into()))
}

/// Delete a subscription and orphan its imported events (clear calendar_id /
/// external_uid) so anything the user already allocated to projects/tasks is
/// preserved as a normal event rather than silently deleted.
pub async fn delete_calendar_subscription(db: &Db, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE events SET calendar_id = NULL, external_uid = NULL WHERE calendar_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM calendar_subscriptions WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Record the outcome of a sync run on the subscription row.
pub async fn set_calendar_sync_result(db: &Db, id: i64, status: &str, event_count: i64) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE calendar_subscriptions SET last_synced_at = ?, last_status = ?, last_event_count = ?, updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(status)
    .bind(event_count)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// Upsert one parsed VEVENT into the events table, keyed by (calendar_id,
/// external_uid). Returns true when a new event row was inserted. Re-sync only
/// overwrites the imported fields — project/task allocations and the archived
/// flag are intentionally preserved.
pub async fn upsert_imported_event(db: &Db, calendar_id: i64, ev: &ParsedIcsEvent) -> Result<bool> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM events WHERE calendar_id = ? AND external_uid = ?",
    )
    .bind(calendar_id)
    .bind(&ev.uid)
    .fetch_optional(db)
    .await?;

    let now = Utc::now();
    if let Some(id) = existing {
        sqlx::query(
            "UPDATE events SET title = ?, description = ?, location = ?, event_date = ?, start_time = ?, end_time = ?, all_day = ?, rrule = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&ev.title)
        .bind(&ev.description)
        .bind(&ev.location)
        .bind(ev.event_date)
        .bind(&ev.start_time)
        .bind(&ev.end_time)
        .bind(ev.all_day as i32)
        .bind(&ev.rrule)
        .bind(now)
        .bind(id)
        .execute(db)
        .await?;
        Ok(false)
    } else {
        sqlx::query(
            "INSERT INTO events (title, description, location, event_date, start_time, end_time, all_day, notification_enabled, calendar_id, external_uid, rrule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        )
        .bind(&ev.title)
        .bind(&ev.description)
        .bind(&ev.location)
        .bind(ev.event_date)
        .bind(&ev.start_time)
        .bind(&ev.end_time)
        .bind(ev.all_day as i32)
        .bind(calendar_id)
        .bind(&ev.uid)
        .bind(&ev.rrule)
        .bind(now)
        .bind(now)
        .execute(db)
        .await?;
        Ok(true)
    }
}

// ============== Contact Operations ==============

pub async fn get_contacts(db: &Db, archived: Option<bool>) -> Result<Vec<Contact>> {
    let query = match archived {
        Some(true) => "SELECT * FROM contacts WHERE archived = 1 ORDER BY full_name ASC",
        Some(false) => "SELECT * FROM contacts WHERE archived = 0 ORDER BY full_name ASC",
        None => "SELECT * FROM contacts ORDER BY full_name ASC",
    };

    let contacts = sqlx::query_as::<_, Contact>(query).fetch_all(db).await?;

    Ok(contacts)
}

pub async fn get_contact(db: &Db, contact_id: i64) -> Result<Contact> {
    let contact = sqlx::query_as::<_, Contact>("SELECT * FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_one(db)
        .await?;

    Ok(contact)
}

pub async fn create_contact(db: &Db, input: CreateContactInput) -> Result<Contact> {
    let now = Utc::now();

    let result = sqlx::query(
        r#"
        INSERT INTO contacts (
            full_name, occupation, phone_numbers, emails, birthday, notes,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&input.full_name)
    .bind(&input.occupation)
    .bind(&input.phone_numbers)
    .bind(&input.emails)
    .bind(&input.birthday)
    .bind(&input.notes)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let contact_id = result.last_insert_rowid();

    let contact = sqlx::query_as::<_, Contact>("SELECT * FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_one(db)
        .await?;

    Ok(contact)
}

pub async fn update_contact(db: &Db, contact_id: i64, input: UpdateContactInput) -> Result<Contact> {
    let now = Utc::now();

    // Build update query dynamically based on provided fields
    let mut query = String::from("UPDATE contacts SET updated_at = ?");

    if input.full_name.is_some() {
        query.push_str(", full_name = ?");
    }
    if input.occupation.is_some() {
        query.push_str(", occupation = ?");
    }
    if input.phone_numbers.is_some() {
        query.push_str(", phone_numbers = ?");
    }
    if input.emails.is_some() {
        query.push_str(", emails = ?");
    }
    if input.birthday.is_some() {
        query.push_str(", birthday = ?");
    }
    if input.notes.is_some() {
        query.push_str(", notes = ?");
    }

    query.push_str(" WHERE id = ?");

    let mut query_builder = sqlx::query(&query).bind(now);

    if let Some(full_name) = &input.full_name {
        query_builder = query_builder.bind(full_name);
    }
    if let Some(occupation) = &input.occupation {
        query_builder = query_builder.bind(occupation);
    }
    if let Some(phone_numbers) = &input.phone_numbers {
        query_builder = query_builder.bind(phone_numbers);
    }
    if let Some(emails) = &input.emails {
        query_builder = query_builder.bind(emails);
    }
    if let Some(birthday) = &input.birthday {
        query_builder = query_builder.bind(birthday);
    }
    if let Some(notes) = &input.notes {
        query_builder = query_builder.bind(notes);
    }

    query_builder.bind(contact_id).execute(db).await?;

    let contact = sqlx::query_as::<_, Contact>("SELECT * FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_one(db)
        .await?;

    Ok(contact)
}

pub async fn delete_contact(db: &Db, contact_id: i64) -> Result<()> {
    let now = Utc::now();

    // Soft delete - archive the contact
    sqlx::query("UPDATE contacts SET archived = 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(contact_id)
        .execute(db)
        .await?;

    Ok(())
}

pub async fn restore_contact(db: &Db, contact_id: i64) -> Result<Contact> {
    let now = Utc::now();

    sqlx::query("UPDATE contacts SET archived = 0, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(contact_id)
        .execute(db)
        .await?;

    let contact = sqlx::query_as::<_, Contact>("SELECT * FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_one(db)
        .await?;

    Ok(contact)
}

pub async fn permanently_delete_contact(db: &Db, contact_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM contacts WHERE id = ?")
        .bind(contact_id)
        .execute(db)
        .await?;

    Ok(())
}

pub async fn link_contact_to_task(db: &Db, task_id: i64, contact_id: i64) -> Result<TaskContact> {
    let now = Utc::now();

    let result =
        sqlx::query("INSERT INTO task_contacts (task_id, contact_id, created_at) VALUES (?, ?, ?)")
            .bind(task_id)
            .bind(contact_id)
            .bind(now)
            .execute(db)
            .await?;

    let link_id = result.last_insert_rowid();

    let task_contact = sqlx::query_as::<_, TaskContact>("SELECT * FROM task_contacts WHERE id = ?")
        .bind(link_id)
        .fetch_one(db)
        .await?;

    Ok(task_contact)
}

pub async fn unlink_contact_from_task(db: &Db, task_id: i64, contact_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM task_contacts WHERE task_id = ? AND contact_id = ?")
        .bind(task_id)
        .bind(contact_id)
        .execute(db)
        .await?;

    Ok(())
}

pub async fn get_task_contacts(db: &Db, task_id: i64) -> Result<Vec<Contact>> {
    let contacts = sqlx::query_as::<_, Contact>(
        r#"
        SELECT c.* FROM contacts c
        INNER JOIN task_contacts tc ON c.id = tc.contact_id
        WHERE tc.task_id = ?
        ORDER BY c.full_name ASC
        "#,
    )
    .bind(task_id)
    .fetch_all(db)
    .await?;

    Ok(contacts)
}

pub async fn get_contact_tasks(db: &Db, contact_id: i64) -> Result<Vec<Task>> {
    let tasks = sqlx::query_as::<_, Task>(
        r#"
        SELECT t.* FROM tasks t
        INNER JOIN task_contacts tc ON t.id = tc.task_id
        WHERE tc.contact_id = ?
        ORDER BY t.created_at DESC
        "#,
    )
    .bind(contact_id)
    .fetch_all(db)
    .await?;

    Ok(tasks)
}

// ============== User Operations ==============

pub async fn get_users(db: &Db) -> Result<Vec<User>> {
    let users = sqlx::query_as::<_, User>(
        "SELECT *, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;

    Ok(users)
}

pub async fn get_active_users(db: &Db) -> Result<Vec<User>> {
    let users = sqlx::query_as::<_, User>(
        "SELECT *, pin_hash IS NOT NULL AS has_pin FROM users WHERE is_active = 1 ORDER BY full_name ASC",
    )
    .fetch_all(db)
    .await?;

    Ok(users)
}

pub async fn get_user(db: &Db, user_id: i64) -> Result<User> {
    let user = sqlx::query_as::<_, User>("SELECT *, pin_hash IS NOT NULL AS has_pin FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    Ok(user)
}

/// Set, change, or clear a user's profile PIN. The PIN gates profile switching
/// in the UI — a courtesy lock on shared machines, not cryptographic security.
pub async fn set_user_pin(db: &Db, user_id: i64, pin: Option<&str>) -> Result<User> {
    let hash = match pin {
        Some(p) => {
            let ok_len = (4..=8).contains(&p.len());
            if !ok_len || !p.chars().all(|c| c.is_ascii_digit()) {
                return Err(crate::error::AppError::InvalidInput("PIN must be 4–8 digits".into()));
            }
            Some(crate::auth::hash_pin(p))
        }
        None => None,
    };
    sqlx::query("UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?")
        .bind(hash)
        .bind(Utc::now())
        .bind(user_id)
        .execute(db)
        .await?;
    get_user(db, user_id).await
}

/// Check a PIN attempt. A user with NO pin verifies trivially (open profile).
pub async fn verify_user_pin(db: &Db, user_id: i64, pin: &str) -> Result<bool> {
    let stored: Option<Option<String>> = sqlx::query_scalar("SELECT pin_hash FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    match stored {
        None => Err(crate::error::AppError::NotFound(format!("User {user_id} not found"))),
        Some(None) => Ok(true),
        Some(Some(hash)) => Ok(crate::auth::pin_matches(&hash, pin)),
    }
}

/// Replace a user's profile blob (theme, avatar, vCard, flavor fields). The
/// frontend owns the JSON shape; we store it verbatim.
pub async fn set_user_profile(db: &Db, user_id: i64, profile_json: Option<&str>) -> Result<User> {
    sqlx::query("UPDATE users SET profile_json = ?, updated_at = ? WHERE id = ?")
        .bind(profile_json)
        .bind(Utc::now())
        .bind(user_id)
        .execute(db)
        .await?;
    get_user(db, user_id).await
}

pub async fn create_user(db: &Db, input: CreateUserInput) -> Result<User> {
    let now = Utc::now();

    let result = sqlx::query(
        r#"
        INSERT INTO users (
            username, full_name, email, is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(&input.username)
    .bind(&input.full_name)
    .bind(&input.email)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    let user_id = result.last_insert_rowid();

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    Ok(user)
}

pub async fn update_user(db: &Db, user_id: i64, input: UpdateUserInput) -> Result<User> {
    let now = Utc::now();

    let mut query = String::from("UPDATE users SET updated_at = ?");

    if input.full_name.is_some() {
        query.push_str(", full_name = ?");
    }
    if input.email.is_some() {
        query.push_str(", email = ?");
    }
    if input.is_active.is_some() {
        query.push_str(", is_active = ?");
    }

    query.push_str(" WHERE id = ?");

    let mut final_query = sqlx::query(&query).bind(now);
    if let Some(full_name) = &input.full_name {
        final_query = final_query.bind(full_name);
    }
    if let Some(email) = &input.email {
        final_query = final_query.bind(email);
    }
    if let Some(is_active) = &input.is_active {
        final_query = final_query.bind(is_active);
    }
    final_query = final_query.bind(user_id);

    final_query.execute(db).await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    Ok(user)
}

pub async fn delete_user(db: &Db, user_id: i64) -> Result<()> {
    // Don't allow deleting the last user
    let user_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await?;

    if user_count.0 <= 1 {
        return Err(crate::error::AppError::InvalidInput(
            "Cannot delete the last user".to_string(),
        ));
    }

    // Never delete the global owner: ensure_owner would otherwise silently
    // promote the next user, an escalation path.
    let is_owner: Option<bool> = sqlx::query_scalar("SELECT is_owner FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    if is_owner == Some(true) {
        return Err(crate::error::AppError::InvalidInput("Cannot delete the owner".to_string()));
    }

    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user_id)
        .execute(db)
        .await?;

    Ok(())
}

pub async fn get_user_setting(
    db: &Db,
    user_id: i64,
    setting_key: String,
) -> Result<Option<String>> {
    let setting: Option<UserSetting> = sqlx::query_as::<_, UserSetting>(
        "SELECT * FROM user_settings WHERE user_id = ? AND setting_key = ?",
    )
    .bind(user_id)
    .bind(&setting_key)
    .fetch_optional(db)
    .await?;

    Ok(setting.and_then(|s| s.setting_value))
}

pub async fn set_user_setting(
    db: &Db,
    user_id: i64,
    setting_key: String,
    setting_value: String,
) -> Result<()> {
    let now = Utc::now();

    sqlx::query(
        r#"
        INSERT INTO user_settings (user_id, setting_key, setting_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(user_id)
    .bind(&setting_key)
    .bind(&setting_value)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    Ok(())
}

// --------------------------------------------------------------------------- //
// AI assistant chat (host-only). Per-project threads + messages; scope is
// enforced at the daemon edge (project membership), not here.
// --------------------------------------------------------------------------- //

/// Create a chat thread in a project (optionally authored by a user / a profile).
pub async fn create_chat(
    db: &Db,
    project_id: i64,
    user_id: Option<i64>,
    profile_id: Option<i64>,
    title: Option<&str>,
) -> Result<Chat> {
    let now = Utc::now();
    let res = sqlx::query(
        "INSERT INTO chats (project_id, user_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(profile_id)
    .bind(title)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    Ok(sqlx::query_as::<_, Chat>("SELECT * FROM chats WHERE id = ?").bind(id).fetch_one(db).await?)
}

/// Append a message to a chat and bump the thread's updated_at.
#[allow(clippy::too_many_arguments)] // internal write API; the tail is the capacity-meter block
pub async fn append_message(
    db: &Db,
    chat_id: i64,
    role: &str,
    content: &str,
    sources_json: Option<&str>,
    tools_json: Option<&str>,
    model: Option<&str>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    duration_ms: Option<i64>,
) -> Result<ChatMessage> {
    let res = sqlx::query(
        "INSERT INTO chat_messages (chat_id, role, content, sources_json, tools_json, model, prompt_tokens, completion_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(chat_id)
    .bind(role)
    .bind(content)
    .bind(sources_json)
    .bind(tools_json)
    .bind(model)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(duration_ms)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    sqlx::query("UPDATE chats SET updated_at = ? WHERE id = ?").bind(Utc::now()).bind(chat_id).execute(db).await?;
    Ok(sqlx::query_as::<_, ChatMessage>("SELECT * FROM chat_messages WHERE id = ?").bind(id).fetch_one(db).await?)
}

/// One entry for the agent action ledger (`agent_actions`): a gated write the
/// user resolved. `status` is "applied" or "rejected"; `result_json` is the
/// invoke result (applied only); `routine_id` is reserved for scheduled routines.
pub struct NewAgentAction<'a> {
    pub status: &'a str,
    pub user_id: i64,
    pub profile_id: Option<i64>,
    /// None for cross-project work (e.g. a routine run).
    pub project_id: Option<i64>,
    pub chat_id: Option<i64>,
    pub routine_id: Option<i64>,
    pub tool: &'a str,
    pub summary: &'a str,
    pub args_json: &'a str,
    pub result_json: Option<&'a str>,
    /// Capacity-meter fields: the model that did the work and what it cost.
    /// None where no model ran (interactive approvals of proposed writes).
    pub model: Option<&'a str>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
    /// Protocol provenance (PROTOCOLS.md §2): which protocol version produced
    /// this run. None for interactive approvals and legacy-routed runs.
    pub protocol_slug: Option<&'a str>,
    pub protocol_version: Option<i64>,
    pub content_hash: Option<&'a str>,
    /// The calling turn's ledger row (DELEGATE.md §3): a delegation links to
    /// its caller, making the ledger a tree. None for top-level actions.
    pub parent_action_id: Option<i64>,
    /// Who RESOLVED the proposal (MEMBER_AGENTS.md prerequisite 2) — may
    /// differ from `user_id` (the proposer) under an 'owner' approval policy.
    /// None where nothing was resolved (model runs, routine rows).
    pub approver_id: Option<i64>,
}

/// Append one row to the agent action ledger. Append-only by design — there is
/// deliberately no update or delete counterpart.
pub async fn record_agent_action(db: &Db, a: NewAgentAction<'_>) -> Result<i64> {
    let res = sqlx::query(
        "INSERT INTO agent_actions (status, user_id, profile_id, project_id, chat_id, routine_id, tool, summary, args_json, result_json, model, prompt_tokens, completion_tokens, duration_ms, protocol_slug, protocol_version, content_hash, parent_action_id, approver_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(a.status)
    .bind(a.user_id)
    .bind(a.profile_id)
    .bind(a.project_id)
    .bind(a.chat_id)
    .bind(a.routine_id)
    .bind(a.tool)
    .bind(a.summary)
    .bind(a.args_json)
    .bind(a.result_json)
    .bind(a.model)
    .bind(a.prompt_tokens)
    .bind(a.completion_tokens)
    .bind(a.duration_ms)
    .bind(a.protocol_slug)
    .bind(a.protocol_version)
    .bind(a.content_hash)
    .bind(a.parent_action_id)
    .bind(a.approver_id)
    .execute(db)
    .await?;
    Ok(res.last_insert_rowid())
}

/// The ledger, newest first: one project's trail, or (project_id = None) the
/// global trail across all projects. `limit` caps the page.
pub async fn list_agent_actions(db: &Db, project_id: Option<i64>, limit: i64) -> Result<Vec<AgentAction>> {
    let limit = limit.clamp(1, 500);
    let rows = match project_id {
        Some(pid) => {
            sqlx::query_as::<_, AgentAction>(
                "SELECT * FROM agent_actions WHERE project_id = ? ORDER BY id DESC LIMIT ?",
            )
            .bind(pid)
            .bind(limit)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as::<_, AgentAction>("SELECT * FROM agent_actions ORDER BY id DESC LIMIT ?")
                .bind(limit)
                .fetch_all(db)
                .await?
        }
    };
    Ok(rows)
}

/// The tab ids enabled for a project (presence in `project_tabs` = enabled).
pub async fn enabled_project_tabs(db: &Db, project_id: i64) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT tab_id FROM project_tabs WHERE project_id = ? ORDER BY tab_id")
        .bind(project_id)
        .fetch_all(db)
        .await?)
}

/// Whether one tab is enabled for a project (the tool layer's per-call check).
pub async fn project_tab_enabled(db: &Db, project_id: i64, tab_id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT 1 FROM project_tabs WHERE project_id = ? AND tab_id = ?")
        .bind(project_id)
        .bind(tab_id)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// Enable (insert/keep) or disable (delete) a tab for a project.
pub async fn set_project_tab(db: &Db, project_id: i64, tab_id: &str, enabled: bool) -> Result<()> {
    if enabled {
        sqlx::query("INSERT OR IGNORE INTO project_tabs (project_id, tab_id) VALUES (?, ?)")
            .bind(project_id)
            .bind(tab_id)
            .execute(db)
            .await?;
    } else {
        sqlx::query("DELETE FROM project_tabs WHERE project_id = ? AND tab_id = ?")
            .bind(project_id)
            .bind(tab_id)
            .execute(db)
            .await?;
        // A tab that's gone takes everyone's pins to it, quietly.
        sqlx::query("DELETE FROM tab_pins WHERE project_id = ? AND tab_id = ?")
            .bind(project_id)
            .bind(tab_id)
            .execute(db)
            .await?;
    }
    Ok(())
}

// ---- Pinned tabs (the global top bar) ------------------------------------- //

/// How many tabs one user may pin on one host.
pub const MAX_TAB_PINS: i64 = 50;

/// A tab id or sub-view as the shell names them: short kebab/snake-case.
fn pin_ident(s: &str, what: &str) -> Result<()> {
    let ok = !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("bad {what} '{s}'")))
    }
}

/// A user's pinned tabs on this host, in their order.
pub async fn list_tab_pins(db: &Db, user_id: i64) -> Result<Vec<TabPin>> {
    Ok(sqlx::query_as::<_, TabPin>(
        "SELECT project_id, tab_id, sub_view, position FROM tab_pins \
         WHERE user_id = ? ORDER BY position, created_at, project_id, tab_id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

/// Pin a tab (or re-place / re-target an existing pin): one pin per (user,
/// project, tab). The client picks `position` from the order it shows.
pub async fn set_tab_pin(
    db: &Db,
    user_id: i64,
    project_id: i64,
    tab_id: &str,
    sub_view: Option<&str>,
    position: f64,
) -> Result<TabPin> {
    pin_ident(tab_id, "tab id")?;
    if let Some(s) = sub_view {
        pin_ident(s, "sub-view")?;
    }
    if !position.is_finite() {
        return Err(AppError::InvalidInput("bad pin position".into()));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM tab_pins WHERE user_id = ? AND project_id = ? AND tab_id = ?")
        .bind(user_id)
        .bind(project_id)
        .bind(tab_id)
        .fetch_optional(db)
        .await?;
    if exists.is_none() {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tab_pins WHERE user_id = ?").bind(user_id).fetch_one(db).await?;
        if n >= MAX_TAB_PINS {
            return Err(AppError::InvalidInput(format!("at most {MAX_TAB_PINS} pinned tabs")));
        }
    }
    sqlx::query(
        "INSERT INTO tab_pins (user_id, project_id, tab_id, sub_view, position) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, project_id, tab_id) DO UPDATE SET \
           sub_view = excluded.sub_view, position = excluded.position",
    )
    .bind(user_id)
    .bind(project_id)
    .bind(tab_id)
    .bind(sub_view)
    .bind(position)
    .execute(db)
    .await?;
    Ok(TabPin { project_id, tab_id: tab_id.to_string(), sub_view: sub_view.map(str::to_string), position })
}

/// Unpin one of the user's tabs (no-op if it isn't pinned).
pub async fn unpin_tab(db: &Db, user_id: i64, project_id: i64, tab_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM tab_pins WHERE user_id = ? AND project_id = ? AND tab_id = ?")
        .bind(user_id)
        .bind(project_id)
        .bind(tab_id)
        .execute(db)
        .await?;
    Ok(())
}

// ---- Atlas (Epoch I) ------------------------------------------------------ //

pub async fn list_atlas_collections(db: &Db) -> Result<Vec<AtlasCollection>> {
    Ok(sqlx::query_as::<_, AtlasCollection>("SELECT * FROM atlas_collections ORDER BY name ASC")
        .fetch_all(db)
        .await?)
}

/// Library indexing control (see AtlasCollection::auto_index).
pub async fn set_atlas_auto_index(db: &Db, id: i64, enabled: bool) -> Result<()> {
    sqlx::query("UPDATE atlas_collections SET auto_index = ? WHERE id = ?")
        .bind(enabled)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// The folder changed after the last ingest — stamps the debounce clock.
pub async fn mark_atlas_dirty(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE atlas_collections SET dirty_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn clear_atlas_dirty(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE atlas_collections SET dirty_at = NULL WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn create_atlas_collection(
    db: &Db,
    slug: &str,
    name: &str,
    source_dir: &str,
    owner_only: bool,
) -> Result<AtlasCollection> {
    let ok_slug = !slug.is_empty()
        && slug.len() <= 40
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok_slug {
        return Err(crate::error::AppError::InvalidInput(
            "slug must be 1-40 chars of a-z, 0-9, '-' (it names the collection: atlas-<slug>)".into(),
        ));
    }
    if name.trim().is_empty() || source_dir.trim().is_empty() {
        return Err(crate::error::AppError::InvalidInput("name and source folder are required".into()));
    }
    let res = sqlx::query("INSERT INTO atlas_collections (slug, name, source_dir, owner_only) VALUES (?, ?, ?, ?)")
        .bind(slug)
        .bind(name.trim())
        .bind(source_dir.trim())
        .bind(owner_only as i64)
        .execute(db)
        .await?;
    let id = res.last_insert_rowid();
    Ok(sqlx::query_as::<_, AtlasCollection>("SELECT * FROM atlas_collections WHERE id = ?")
        .bind(id)
        .fetch_one(db)
        .await?)
}

/// Flip a collection's owner-private flag (owner-managed).
pub async fn set_atlas_visibility(db: &Db, id: i64, owner_only: bool) -> Result<()> {
    sqlx::query("UPDATE atlas_collections SET owner_only = ? WHERE id = ?")
        .bind(owner_only as i64)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn get_atlas_collection_by_slug(db: &Db, slug: &str) -> Result<Option<AtlasCollection>> {
    Ok(sqlx::query_as::<_, AtlasCollection>("SELECT * FROM atlas_collections WHERE slug = ?")
        .bind(slug)
        .fetch_optional(db)
        .await?)
}

pub async fn get_atlas_collection(db: &Db, id: i64) -> Result<Option<AtlasCollection>> {
    Ok(sqlx::query_as::<_, AtlasCollection>("SELECT * FROM atlas_collections WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// Unregister an Atlas collection. The corpus directory on disk is left in
/// place (it may be re-registered; deleting indexed knowledge is a manual act).
pub async fn delete_atlas_collection(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM atlas_collections WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

pub async fn touch_atlas_ingest(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE atlas_collections SET last_ingest_at = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// A project tab's saved configuration blob (e.g. the Atlas tab's facet
/// filters). '{}' when unset or the tab isn't enabled.
pub async fn project_tab_config(db: &Db, project_id: i64, tab_id: &str) -> Result<String> {
    Ok(sqlx::query_scalar::<_, String>("SELECT config_json FROM project_tabs WHERE project_id = ? AND tab_id = ?")
        .bind(project_id)
        .bind(tab_id)
        .fetch_optional(db)
        .await?
        .unwrap_or_else(|| "{}".into()))
}

/// Save a project tab's configuration (the tab must be enabled — the row is
/// the enablement, so this updates rather than inserts).
pub async fn set_project_tab_config(db: &Db, project_id: i64, tab_id: &str, config_json: &str) -> Result<()> {
    let n = sqlx::query("UPDATE project_tabs SET config_json = ? WHERE project_id = ? AND tab_id = ?")
        .bind(config_json)
        .bind(project_id)
        .bind(tab_id)
        .execute(db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(crate::error::AppError::InvalidInput("enable the tab on this project first".into()));
    }
    Ok(())
}

/// One user's saved state for a stash tab on a project ('{}' when none).
/// Per-user (unlike project_tab_config, which is shared + admin-gated).
pub async fn tab_user_state(db: &Db, project_id: i64, tab_id: &str, user_id: i64) -> Result<String> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT state_json FROM tab_user_state WHERE project_id = ? AND tab_id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(tab_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .unwrap_or_else(|| "{}".into()))
}

/// Upsert one user's stash-tab state. No enablement requirement: the panel
/// can only write while the tab is enabled, and rows deliberately survive a
/// disable so re-enabling restores the user's saves.
pub async fn set_tab_user_state(db: &Db, project_id: i64, tab_id: &str, user_id: i64, state_json: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO tab_user_state (project_id, tab_id, user_id, state_json, updated_at) \
         VALUES (?, ?, ?, ?, datetime('now')) \
         ON CONFLICT(project_id, tab_id, user_id) DO UPDATE SET \
           state_json = excluded.state_json, updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(tab_id)
    .bind(user_id)
    .bind(state_json)
    .execute(db)
    .await?;
    Ok(())
}

/// Record a score for the leaderboard, pruning to the newest 500 rows per
/// (project, tab) so a busy game can't grow the table without bound.
pub async fn add_tab_score(
    db: &Db,
    project_id: i64,
    tab_id: &str,
    user_id: i64,
    kind: &str,
    score: f64,
    meta_json: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO tab_scores (project_id, tab_id, user_id, kind, score, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(tab_id)
    .bind(user_id)
    .bind(kind)
    .bind(score)
    .bind(meta_json)
    .execute(db)
    .await?;
    sqlx::query(
        "DELETE FROM tab_scores WHERE project_id = ? AND tab_id = ? AND id NOT IN \
         (SELECT id FROM tab_scores WHERE project_id = ? AND tab_id = ? ORDER BY id DESC LIMIT 500)",
    )
    .bind(project_id)
    .bind(tab_id)
    .bind(project_id)
    .bind(tab_id)
    .execute(db)
    .await?;
    Ok(())
}

/// The leaderboard feed, newest first, with player names resolved.
pub async fn list_tab_scores(db: &Db, project_id: i64, tab_id: &str, limit: i64) -> Result<Vec<TabScore>> {
    Ok(sqlx::query_as::<_, TabScore>(
        "SELECT s.user_id, COALESCE(NULLIF(u.full_name, ''), u.username) AS display_name, \
                s.kind, s.score, s.meta_json, s.created_at \
         FROM tab_scores s JOIN users u ON u.id = s.user_id \
         WHERE s.project_id = ? AND s.tab_id = ? ORDER BY s.id DESC LIMIT ?",
    )
    .bind(project_id)
    .bind(tab_id)
    .bind(limit)
    .fetch_all(db)
    .await?)
}

// ---- Email tab ------------------------------------------------------------ //

pub async fn list_email_accounts(db: &Db) -> Result<Vec<EmailAccount>> {
    Ok(sqlx::query_as::<_, EmailAccount>("SELECT * FROM email_accounts ORDER BY id").fetch_all(db).await?)
}

/// One user's mailboxes (members manage their own; the host owner sees all
/// via `list_email_accounts` where genuinely needed, e.g. the sync worker).
pub async fn list_email_accounts_for(db: &Db, user_id: i64) -> Result<Vec<EmailAccount>> {
    Ok(sqlx::query_as::<_, EmailAccount>("SELECT * FROM email_accounts WHERE user_id = ? ORDER BY id")
        .bind(user_id)
        .fetch_all(db)
        .await?)
}

/// Recent unlinked threads from ONE USER's accounts only — nobody browses
/// anyone else's inbox.
pub async fn list_unlinked_email_threads_for(db: &Db, user_id: i64, limit: i64) -> Result<Vec<EmailThread>> {
    Ok(sqlx::query_as::<_, EmailThread>(
        "SELECT th.* FROM email_threads th JOIN email_accounts a ON a.id = th.account_id          WHERE th.project_id IS NULL AND a.user_id = ? ORDER BY th.last_date DESC, th.id DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await?)
}

pub async fn get_email_account(db: &Db, id: i64) -> Result<Option<EmailAccount>> {
    Ok(sqlx::query_as::<_, EmailAccount>("SELECT * FROM email_accounts WHERE id = ?").bind(id).fetch_optional(db).await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_email_account(
    db: &Db,
    user_id: i64,
    label: &str,
    host: &str,
    port: i64,
    username: &str,
    password: &str,
    folders: &str,
    horizon_days: i64,
) -> Result<EmailAccount> {
    let res = sqlx::query(
        "INSERT INTO email_accounts (user_id, label, host, port, username, password, folders, horizon_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(label)
    .bind(host)
    .bind(port)
    .bind(username)
    .bind(password)
    .bind(folders)
    .bind(horizon_days.clamp(1, 3650))
    .execute(db)
    .await?;
    Ok(get_email_account(db, res.last_insert_rowid()).await?.expect("just inserted"))
}

/// Create an OAuth (XOAUTH2) account — no password; auth rides the stored
/// refresh token minted by the browser sign-in.
#[allow(clippy::too_many_arguments)]
pub async fn create_oauth_email_account(
    db: &Db,
    user_id: i64,
    label: &str,
    host: &str,
    port: i64,
    username: &str,
    folders: &str,
    horizon_days: i64,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<EmailAccount> {
    let res = sqlx::query(
        "INSERT INTO email_accounts (user_id, label, host, port, username, password, folders, horizon_days,          auth_type, oauth_client_id, oauth_client_secret, oauth_refresh_token)          VALUES (?, ?, ?, ?, ?, '', ?, ?, 'oauth', ?, ?, ?)",
    )
    .bind(user_id)
    .bind(label)
    .bind(host)
    .bind(port)
    .bind(username)
    .bind(folders)
    .bind(horizon_days.clamp(1, 3650))
    .bind(client_id)
    .bind(client_secret)
    .bind(refresh_token)
    .execute(db)
    .await?;
    Ok(get_email_account(db, res.last_insert_rowid()).await?.expect("just inserted"))
}

pub async fn delete_email_account(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM email_accounts WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

pub async fn set_email_account_enabled(db: &Db, id: i64, enabled: bool) -> Result<()> {
    sqlx::query("UPDATE email_accounts SET enabled = ? WHERE id = ?").bind(enabled).bind(id).execute(db).await?;
    Ok(())
}

pub async fn set_email_account_result(db: &Db, id: i64, summary: &str, drafts_folder: Option<&str>) -> Result<()> {
    sqlx::query(
        "UPDATE email_accounts SET last_sync_at = ?, last_result = ?, drafts_folder = COALESCE(?, drafts_folder) WHERE id = ?",
    )
    .bind(Utc::now())
    .bind(summary)
    .bind(drafts_folder)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// Get-or-create the thread row for a key, refreshing subject/last_date.
pub async fn upsert_email_thread(
    db: &Db,
    account_id: i64,
    thread_key: &str,
    subject: &str,
    date: Option<DateTime<Utc>>,
) -> Result<i64> {
    sqlx::query(
        "INSERT INTO email_threads (account_id, thread_key, subject, last_date) VALUES (?, ?, ?, ?)          ON CONFLICT(account_id, thread_key) DO UPDATE SET            subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE email_threads.subject END,            last_date = MAX(COALESCE(email_threads.last_date, ''), COALESCE(excluded.last_date, ''))",
    )
    .bind(account_id)
    .bind(thread_key)
    .bind(subject)
    .bind(date)
    .execute(db)
    .await?;
    let id: i64 = sqlx::query_scalar("SELECT id FROM email_threads WHERE account_id = ? AND thread_key = ?")
        .bind(account_id)
        .bind(thread_key)
        .fetch_one(db)
        .await?;
    Ok(id)
}

/// Insert an envelope if unseen (account/folder/uidvalidity/uid is the key).
/// Returns true if it was new. Recounts the thread's messages.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_email_message(
    db: &Db,
    account_id: i64,
    thread_id: i64,
    folder: &str,
    uid: i64,
    uid_validity: i64,
    message_id: &str,
    subject: &str,
    from_addr: &str,
    date: Option<DateTime<Utc>>,
) -> Result<bool> {
    let res = sqlx::query(
        "INSERT OR IGNORE INTO email_messages (account_id, thread_id, folder, uid, uid_validity, message_id, subject, from_addr, date)          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(account_id)
    .bind(thread_id)
    .bind(folder)
    .bind(uid)
    .bind(uid_validity)
    .bind(message_id)
    .bind(subject)
    .bind(from_addr)
    .bind(date)
    .execute(db)
    .await?;
    let new = res.rows_affected() > 0;
    if new {
        sqlx::query("UPDATE email_threads SET message_count = (SELECT COUNT(*) FROM email_messages WHERE thread_id = ?) WHERE id = ?")
            .bind(thread_id)
            .bind(thread_id)
            .execute(db)
            .await?;
    }
    Ok(new)
}

/// Link a thread to a project (None = unlink). Linking publishes the thread to
/// the project's members and queues its bodies for fetch + RAG staging.
pub async fn set_email_thread_project(db: &Db, thread_id: i64, project_id: Option<i64>) -> Result<()> {
    sqlx::query("UPDATE email_threads SET project_id = ? WHERE id = ?").bind(project_id).bind(thread_id).execute(db).await?;
    Ok(())
}

pub async fn get_email_thread(db: &Db, id: i64) -> Result<Option<EmailThread>> {
    Ok(sqlx::query_as::<_, EmailThread>("SELECT * FROM email_threads WHERE id = ?").bind(id).fetch_optional(db).await?)
}

/// A project's linked threads, most recent first.
pub async fn list_project_email_threads(db: &Db, project_id: i64) -> Result<Vec<EmailThread>> {
    Ok(sqlx::query_as::<_, EmailThread>(
        "SELECT * FROM email_threads WHERE project_id = ? ORDER BY last_date DESC, id DESC",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?)
}

/// Recent unlinked threads across accounts (the owner's link-it browser).
pub async fn list_unlinked_email_threads(db: &Db, limit: i64) -> Result<Vec<EmailThread>> {
    Ok(sqlx::query_as::<_, EmailThread>(
        "SELECT * FROM email_threads WHERE project_id IS NULL ORDER BY last_date DESC, id DESC LIMIT ?",
    )
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await?)
}

/// A thread's messages, oldest first.
pub async fn list_email_thread_messages(db: &Db, thread_id: i64) -> Result<Vec<EmailMessage>> {
    Ok(sqlx::query_as::<_, EmailMessage>(
        "SELECT * FROM email_messages WHERE thread_id = ? ORDER BY date ASC, uid ASC",
    )
    .bind(thread_id)
    .fetch_all(db)
    .await?)
}

pub async fn set_email_message_body(db: &Db, message_id: i64, body_text: &str) -> Result<()> {
    sqlx::query("UPDATE email_messages SET body_text = ? WHERE id = ?").bind(body_text).bind(message_id).execute(db).await?;
    Ok(())
}

pub async fn list_sync_folders(db: &Db) -> Result<Vec<SyncFolder>> {
    Ok(sqlx::query_as::<_, SyncFolder>("SELECT * FROM sync_folders ORDER BY id").fetch_all(db).await?)
}

pub async fn get_sync_folder(db: &Db, id: i64) -> Result<Option<SyncFolder>> {
    Ok(sqlx::query_as::<_, SyncFolder>("SELECT * FROM sync_folders WHERE id = ?").bind(id).fetch_optional(db).await?)
}

pub async fn create_sync_folder(
    db: &Db,
    project_id: i64,
    path: &str,
    include_ext: &str,
    max_bytes: i64,
) -> Result<SyncFolder> {
    let res = sqlx::query("INSERT INTO sync_folders (project_id, path, include_ext, max_bytes) VALUES (?, ?, ?, ?)")
        .bind(project_id)
        .bind(path)
        .bind(include_ext)
        .bind(max_bytes.max(0))
        .execute(db)
        .await?;
    Ok(get_sync_folder(db, res.last_insert_rowid()).await?.expect("just inserted"))
}

/// Patch a mapping's mutable knobs (None = leave unchanged).
pub async fn update_sync_folder(
    db: &Db,
    id: i64,
    enabled: Option<bool>,
    include_ext: Option<&str>,
    max_bytes: Option<i64>,
) -> Result<Option<SyncFolder>> {
    sqlx::query(
        "UPDATE sync_folders SET          enabled = COALESCE(?, enabled),          include_ext = COALESCE(?, include_ext),          max_bytes = COALESCE(?, max_bytes) WHERE id = ?",
    )
    .bind(enabled)
    .bind(include_ext)
    .bind(max_bytes.map(|b| b.max(0)))
    .bind(id)
    .execute(db)
    .await?;
    get_sync_folder(db, id).await
}

pub async fn delete_sync_folder(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM sync_folder_files WHERE folder_id = ?").bind(id).execute(db).await?;
    sqlx::query("DELETE FROM sync_folders WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

/// Stamp a scan's outcome (shown in the Plug-ins card).
pub async fn set_sync_folder_result(db: &Db, id: i64, summary: &str) -> Result<()> {
    sqlx::query("UPDATE sync_folders SET last_scan_at = ?, last_result = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(summary)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// All routines, stable order. The list is small (seeded + hand-added).
pub async fn list_routines(db: &Db) -> Result<Vec<Routine>> {
    Ok(sqlx::query_as::<_, Routine>("SELECT * FROM routines ORDER BY id").fetch_all(db).await?)
}

pub async fn get_routine(db: &Db, id: i64) -> Result<Option<Routine>> {
    Ok(sqlx::query_as::<_, Routine>("SELECT * FROM routines WHERE id = ?").bind(id).fetch_optional(db).await?)
}

/// The routine for a runner dispatch key (kinds are unique by convention).
pub async fn routine_by_kind(db: &Db, kind: &str) -> Result<Option<Routine>> {
    Ok(sqlx::query_as::<_, Routine>("SELECT * FROM routines WHERE kind = ? LIMIT 1")
        .bind(kind)
        .fetch_optional(db)
        .await?)
}

/// Stamp a routine's last run (the catch-up-on-launch trigger reads this).
pub async fn set_routine_last_run(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE routines SET last_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(Utc::now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// A user's chat threads in a project, most-recently-updated first.
pub async fn list_chats(db: &Db, project_id: i64, user_id: Option<i64>) -> Result<Vec<Chat>> {
    let chats = match user_id {
        Some(uid) => {
            // The caller's own threads, plus any a teammate published to the project.
            sqlx::query_as::<_, Chat>(
                "SELECT * FROM chats WHERE project_id = ? AND deleted_at IS NULL AND (user_id = ? OR is_public = 1) ORDER BY pinned DESC, updated_at DESC",
            )
            .bind(project_id)
            .bind(uid)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as::<_, Chat>(
                "SELECT * FROM chats WHERE project_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC",
            )
            .bind(project_id)
            .fetch_all(db)
            .await?
        }
    };
    Ok(chats)
}

/// The caller's own binned threads in a project (the bin shows only yours —
/// a binned chat is withdrawn from the team even if it was published).
pub async fn list_binned_chats(db: &Db, project_id: i64, user_id: i64) -> Result<Vec<Chat>> {
    Ok(sqlx::query_as::<_, Chat>(
        "SELECT * FROM chats WHERE project_id = ? AND user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

/// Move a chat to the bin (stage 1 of deletion — restorable).
pub async fn bin_chat(db: &Db, chat_id: i64) -> Result<()> {
    sqlx::query("UPDATE chats SET deleted_at = datetime('now') WHERE id = ?")
        .bind(chat_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Bring a binned chat back.
pub async fn restore_chat(db: &Db, chat_id: i64) -> Result<()> {
    sqlx::query("UPDATE chats SET deleted_at = NULL WHERE id = ?")
        .bind(chat_id)
        .execute(db)
        .await?;
    Ok(())
}

/// The project a chat belongs to (for membership scope checks at the edge).
pub async fn chat_project(db: &Db, chat_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT project_id FROM chats WHERE id = ?")
        .bind(chat_id)
        .fetch_optional(db)
        .await?)
}

/// A single chat thread by id (used to check authorship before publishing).
pub async fn get_chat(db: &Db, chat_id: i64) -> Result<Option<Chat>> {
    Ok(sqlx::query_as::<_, Chat>("SELECT * FROM chats WHERE id = ?")
        .bind(chat_id)
        .fetch_optional(db)
        .await?)
}

/// Publish (or unpublish) a chat to the whole project team. Returns the row.
pub async fn set_chat_public(db: &Db, chat_id: i64, is_public: bool) -> Result<Chat> {
    sqlx::query("UPDATE chats SET is_public = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(is_public as i64)
        .bind(chat_id)
        .execute(db)
        .await?;
    get_chat(db, chat_id)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound("chat".into()))
}

/// Pin (or unpin) a chat — pinned threads float to the top of the list. Note:
/// pinning does NOT bump updated_at, so it never reorders the recency sort.
pub async fn set_chat_pinned(db: &Db, chat_id: i64, pinned: bool) -> Result<Chat> {
    sqlx::query("UPDATE chats SET pinned = ? WHERE id = ?")
        .bind(pinned as i64)
        .bind(chat_id)
        .execute(db)
        .await?;
    get_chat(db, chat_id)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound("chat".into()))
}

/// All messages in a chat, oldest first (the order the model needs as history).
pub async fn get_chat_messages(db: &Db, chat_id: i64) -> Result<Vec<ChatMessage>> {
    Ok(sqlx::query_as::<_, ChatMessage>(
        "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?)
}

/// Permanently delete a chat thread (cascades to its messages). The server
/// edge only allows this for chats already in the bin (two-stage deletion).
pub async fn delete_chat(db: &Db, chat_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM chats WHERE id = ?").bind(chat_id).execute(db).await?;
    Ok(())
}

// --------------------------------------------------------------------------- //
// AI model profiles (host-only config). The active profile is selected via the
// 'ai_active_profile_id' app_setting.
// --------------------------------------------------------------------------- //

pub async fn list_model_profiles(db: &Db) -> Result<Vec<ModelProfile>> {
    Ok(sqlx::query_as::<_, ModelProfile>("SELECT * FROM model_profiles ORDER BY created_at ASC, id ASC")
        .fetch_all(db)
        .await?)
}

pub async fn get_model_profile(db: &Db, id: i64) -> Result<Option<ModelProfile>> {
    Ok(sqlx::query_as::<_, ModelProfile>("SELECT * FROM model_profiles WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// Insert (id None/0) or update a profile; returns the saved row.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)] // settings row; the tail is the Epoch H remote block
pub async fn upsert_model_profile(
    db: &Db,
    id: Option<i64>,
    name: &str,
    model: &str,
    system_prompt: Option<&str>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
    role: Option<&str>,
    avatar: Option<&str>,
    model_meta: Option<&str>,
    endpoint: Option<&str>,
    fallback_note: Option<&str>,
) -> Result<ModelProfile> {
    let now = Utc::now();
    let saved_id = match id.filter(|i| *i > 0) {
        Some(id) => {
            // COALESCE on model_meta so a failed /api/show probe doesn't wipe the
            // cached snapshot; avatar is set directly (the client owns it).
            sqlx::query(
                "UPDATE model_profiles SET name=?, model=?, system_prompt=?, temperature=?, max_tokens=?, role=?, avatar=?, model_meta=COALESCE(?, model_meta), endpoint=?, fallback_note=?, updated_at=? WHERE id=?",
            )
            .bind(name)
            .bind(model)
            .bind(system_prompt)
            .bind(temperature)
            .bind(max_tokens)
            .bind(role)
            .bind(avatar)
            .bind(model_meta)
            .bind(endpoint)
            .bind(fallback_note)
            .bind(now)
            .bind(id)
            .execute(db)
            .await?;
            id
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO model_profiles (name, model, system_prompt, temperature, max_tokens, role, avatar, model_meta, endpoint, fallback_note, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(name)
            .bind(model)
            .bind(system_prompt)
            .bind(temperature)
            .bind(max_tokens)
            .bind(role)
            .bind(avatar)
            .bind(model_meta)
            .bind(endpoint)
            .bind(fallback_note)
            .bind(now)
            .bind(now)
            .execute(db)
            .await?;
            res.last_insert_rowid()
        }
    };
    Ok(sqlx::query_as::<_, ModelProfile>("SELECT * FROM model_profiles WHERE id = ?")
        .bind(saved_id)
        .fetch_one(db)
        .await?)
}

pub async fn delete_model_profile(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM model_profiles WHERE id = ?").bind(id).execute(db).await?;
    // Clear any app-level pointers that referenced this profile, so nothing is
    // left dangling (the active answerer + the Home secretary).
    let gone = id.to_string();
    for key in ["ai_active_profile_id", "secretary_profile_id"] {
        if get_app_setting(db, key).await?.as_deref() == Some(gone.as_str()) {
            set_app_setting(db, key, "").await?;
        }
    }
    Ok(())
}

/// The active profile (by 'ai_active_profile_id'), if set and still present.
pub async fn active_model_profile(db: &Db) -> Result<Option<ModelProfile>> {
    let id = get_app_setting(db, "ai_active_profile_id")
        .await?
        .and_then(|s| s.trim().parse::<i64>().ok());
    match id {
        Some(id) => get_model_profile(db, id).await,
        None => Ok(None),
    }
}

// ============== Automations — rules CRUD (Epoch M(a)) ==============
// These manage rule CONFIG (not domain data), so they deliberately do NOT emit
// domain events — a rule edit must never trip the engine.

pub async fn list_rules(db: &Db) -> Result<Vec<Rule>> {
    Ok(sqlx::query_as::<_, Rule>("SELECT * FROM rules ORDER BY id DESC").fetch_all(db).await?)
}

pub async fn create_rule(db: &Db, input: NewRule) -> Result<Rule> {
    let res = sqlx::query(
        "INSERT INTO rules (name, enabled, trigger_json, action_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(&input.name)
    .bind(input.enabled as i32)
    .bind(&input.trigger_json)
    .bind(&input.action_json)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    Ok(sqlx::query_as::<_, Rule>("SELECT * FROM rules WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn update_rule(db: &Db, id: i64, input: UpdateRule) -> Result<Rule> {
    let cur = sqlx::query_as::<_, Rule>("SELECT * FROM rules WHERE id = ?").bind(id).fetch_one(db).await?;
    sqlx::query("UPDATE rules SET name = ?, enabled = ?, trigger_json = ?, action_json = ? WHERE id = ?")
        .bind(input.name.unwrap_or(cur.name))
        .bind(input.enabled.unwrap_or(cur.enabled) as i32)
        .bind(input.trigger_json.unwrap_or(cur.trigger_json))
        .bind(input.action_json.unwrap_or(cur.action_json))
        .bind(id)
        .execute(db)
        .await?;
    Ok(sqlx::query_as::<_, Rule>("SELECT * FROM rules WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn delete_rule(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM rules WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ---- registry tools (declarative agent tools) ----------------------------- //

pub async fn list_registry_tools(db: &Db) -> Result<Vec<RegistryTool>> {
    Ok(sqlx::query_as::<_, RegistryTool>("SELECT * FROM registry_tools ORDER BY name ASC").fetch_all(db).await?)
}

/// Enabled tools only — what chat assembles and offers the model.
pub async fn enabled_registry_tools(db: &Db) -> Result<Vec<RegistryTool>> {
    Ok(sqlx::query_as::<_, RegistryTool>("SELECT * FROM registry_tools WHERE enabled = 1 ORDER BY name ASC")
        .fetch_all(db)
        .await?)
}

pub async fn get_registry_tool_by_name(db: &Db, name: &str) -> Result<Option<RegistryTool>> {
    Ok(sqlx::query_as::<_, RegistryTool>("SELECT * FROM registry_tools WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?)
}

pub async fn create_registry_tool(db: &Db, input: NewRegistryTool) -> Result<RegistryTool> {
    let params = input.params_json.unwrap_or_else(|| "{\"type\":\"object\",\"properties\":{}}".to_string());
    let class = input.class.unwrap_or_else(|| "read".to_string());
    let res = sqlx::query(
        "INSERT INTO registry_tools (name, description, params_json, class, binding_kind, binding_json, enabled, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&input.name)
    .bind(&input.description)
    .bind(&params)
    .bind(&class)
    .bind(&input.binding_kind)
    .bind(&input.binding_json)
    .bind(input.enabled as i32)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    Ok(sqlx::query_as::<_, RegistryTool>("SELECT * FROM registry_tools WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn set_registry_tool_enabled(db: &Db, id: i64, enabled: bool) -> Result<()> {
    sqlx::query("UPDATE registry_tools SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(enabled as i32)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_registry_tool(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM registry_tools WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ---- connector secrets (host-only; for the http binding) ------------------- //

/// Secret NAMES only — values are never returned by the API.
pub async fn list_connector_secret_names(db: &Db) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT name FROM connector_secrets ORDER BY name").fetch_all(db).await?)
}

pub async fn set_connector_secret(db: &Db, name: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO connector_secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
        .bind(name)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_connector_secret(db: &Db, name: &str) -> Result<()> {
    sqlx::query("DELETE FROM connector_secrets WHERE name = ?").bind(name).execute(db).await?;
    Ok(())
}

/// The secret value for execution only (server-side). Never expose this.
pub async fn get_connector_secret(db: &Db, name: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT value FROM connector_secrets WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?)
}

// ---- loadouts (composition: tools + prompt + routed sub-model) ------------- //

pub async fn list_loadouts(db: &Db) -> Result<Vec<Loadout>> {
    Ok(sqlx::query_as::<_, Loadout>("SELECT * FROM loadouts ORDER BY name ASC").fetch_all(db).await?)
}

pub async fn get_loadout(db: &Db, id: i64) -> Result<Option<Loadout>> {
    Ok(sqlx::query_as::<_, Loadout>("SELECT * FROM loadouts WHERE id = ?").bind(id).fetch_optional(db).await?)
}

pub async fn loadout_tool_names(db: &Db, loadout_id: i64) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT tool_name FROM loadout_tools WHERE loadout_id = ? ORDER BY tool_name")
        .bind(loadout_id)
        .fetch_all(db)
        .await?)
}

async fn replace_loadout_tools(db: &Db, loadout_id: i64, tools: &[String]) -> Result<()> {
    sqlx::query("DELETE FROM loadout_tools WHERE loadout_id = ?").bind(loadout_id).execute(db).await?;
    for t in tools {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        sqlx::query("INSERT OR IGNORE INTO loadout_tools (loadout_id, tool_name) VALUES (?, ?)")
            .bind(loadout_id)
            .bind(t)
            .execute(db)
            .await?;
    }
    Ok(())
}

pub async fn create_loadout(db: &Db, input: NewLoadout) -> Result<Loadout> {
    let res = sqlx::query(
        "INSERT INTO loadouts (name, description, prompt_fragment, routing_profile_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.prompt_fragment)
    .bind(input.routing_profile_id)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    replace_loadout_tools(db, id, &input.tools).await?;
    Ok(get_loadout(db, id).await?.expect("just inserted"))
}

pub async fn update_loadout(db: &Db, id: i64, input: UpdateLoadout) -> Result<Loadout> {
    let cur = get_loadout(db, id).await?.ok_or_else(|| crate::error::AppError::NotFound("loadout".into()))?;
    sqlx::query(
        "UPDATE loadouts SET name = ?, description = ?, prompt_fragment = ?, routing_profile_id = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(input.name.unwrap_or(cur.name))
    .bind(input.description.unwrap_or(cur.description))
    // prompt_fragment / routing_profile_id: a present value sets it; absent keeps current.
    .bind(input.prompt_fragment.or(cur.prompt_fragment))
    .bind(input.routing_profile_id.or(cur.routing_profile_id))
    .bind(id)
    .execute(db)
    .await?;
    if let Some(tools) = input.tools {
        replace_loadout_tools(db, id, &tools).await?;
    }
    Ok(get_loadout(db, id).await?.expect("updated"))
}

pub async fn delete_loadout(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM loadout_tools WHERE loadout_id = ?").bind(id).execute(db).await?;
    sqlx::query("DELETE FROM profile_loadouts WHERE loadout_id = ?").bind(id).execute(db).await?;
    sqlx::query("DELETE FROM loadouts WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

/// The loadout ids assigned to a personality.
pub async fn profile_loadout_ids(db: &Db, profile_id: i64) -> Result<Vec<i64>> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT loadout_id FROM profile_loadouts WHERE profile_id = ? ORDER BY loadout_id")
        .bind(profile_id)
        .fetch_all(db)
        .await?)
}

/// Replace a personality's loadout assignment.
pub async fn set_profile_loadouts(db: &Db, profile_id: i64, loadout_ids: &[i64]) -> Result<()> {
    sqlx::query("DELETE FROM profile_loadouts WHERE profile_id = ?").bind(profile_id).execute(db).await?;
    for lid in loadout_ids {
        sqlx::query("INSERT OR IGNORE INTO profile_loadouts (profile_id, loadout_id) VALUES (?, ?)")
            .bind(profile_id)
            .bind(lid)
            .execute(db)
            .await?;
    }
    Ok(())
}

/// The loadouts assigned to a personality (rows), for chat resolution.
pub async fn profile_loadouts(db: &Db, profile_id: i64) -> Result<Vec<Loadout>> {
    Ok(sqlx::query_as::<_, Loadout>(
        "SELECT l.* FROM loadouts l JOIN profile_loadouts pl ON pl.loadout_id = l.id WHERE pl.profile_id = ? ORDER BY l.id",
    )
    .bind(profile_id)
    .fetch_all(db)
    .await?)
}

/// Bump the fire bookkeeping after the engine runs a rule's action.
pub async fn record_rule_fired(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE rules SET fire_count = fire_count + 1, last_fired_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

// --------------------------------------------------------------------------- //
// Model Assembly domain (Gundam kits + Warhammer 40K / Age of Sigmar armies).
// Ops mirror the verified TUI semantics (boards pre-create parts 1..max_parts;
// marking a part auto-creates a missing number up to 999; freeing a part clears
// is_used + its UsedPart row) but add: a status lifecycle, image links via
// project_files, a one-shot nested detail fetch, and a build log. Every write
// emits a `model.*` domain event so the live pulse + rules engine can react.
// --------------------------------------------------------------------------- //

/// Highest part number auto-created when marking a part that isn't on the
/// board yet (the TUI's MAX_AUTO_PART_NUMBER). Caps obvious typos (9999 for 99).
const MAX_AUTO_PART_NUMBER: i64 = 999;

fn model_kit_project(db: &Db, kit_id: i64) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<i64>>> + Send + '_>> {
    Box::pin(async move {
        let pid: Option<i64> = sqlx::query_scalar("SELECT project_id FROM model_kits WHERE id = ?")
            .bind(kit_id)
            .fetch_optional(db)
            .await?;
        Ok(pid)
    })
}

fn touch_kit(db: &Db, kit_id: i64) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
    Box::pin(async move {
        sqlx::query("UPDATE model_kits SET updated_at = datetime('now') WHERE id = ?")
            .bind(kit_id)
            .execute(db)
            .await?;
        Ok(())
    })
}

fn normalize_kind(k: &str) -> String {
    if MODEL_KINDS.contains(&k) { k.to_string() } else { "other".to_string() }
}

fn normalize_status(s: Option<&str>) -> String {
    match s {
        Some(v) if MODEL_STATUSES.contains(&v) => v.to_string(),
        _ => "Backlog".to_string(),
    }
}

pub async fn list_model_kits(db: &Db, project_id: i64) -> Result<Vec<ModelKit>> {
    let kits = sqlx::query_as::<_, ModelKit>(
        "SELECT * FROM model_kits WHERE project_id = ? ORDER BY sort_order, id",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(kits)
}

pub async fn create_model_kit(db: &Db, input: CreateModelKitInput) -> Result<ModelKit> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::InvalidInput("kit name is required".into()));
    }
    let now = Utc::now();
    let kind = normalize_kind(&input.kind);
    let status = normalize_status(input.status.as_deref());
    let res = sqlx::query(
        "INSERT INTO model_kits (project_id, name, kind, grade, scale, faction, points, status, notes, sort_order, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(input.project_id)
    .bind(name)
    .bind(&kind)
    .bind(input.grade.as_deref())
    .bind(input.scale.as_deref())
    .bind(input.faction.as_deref())
    .bind(input.points)
    .bind(&status)
    .bind(input.notes.as_deref())
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    let id = res.last_insert_rowid();
    let kit = sqlx::query_as::<_, ModelKit>("SELECT * FROM model_kits WHERE id = ?")
        .bind(id)
        .fetch_one(db)
        .await?;
    emit(DomainEvent { kind: "model.kit_created".into(), project_id: Some(input.project_id), entity_id: id, data: serde_json::json!({ "kind": kind, "status": status }) });
    Ok(kit)
}

pub async fn update_model_kit(db: &Db, kit_id: i64, input: UpdateModelKitInput) -> Result<ModelKit> {
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let cur = sqlx::query_as::<_, ModelKit>("SELECT * FROM model_kits WHERE id = ?").bind(kit_id).fetch_one(db).await?;
    let name = input.name.unwrap_or(cur.name);
    let kind = normalize_kind(&input.kind.unwrap_or(cur.kind.clone()));
    let status = normalize_status(input.status.as_deref().or(Some(cur.status.as_str())));
    let prev_status = cur.status.clone();
    sqlx::query(
        "UPDATE model_kits SET name=?, kind=?, grade=?, scale=?, faction=?, points=?, status=?, notes=?, sort_order=?, cover_focus=?, task_id=?, updated_at=datetime('now') WHERE id=?",
    )
    .bind(&name)
    .bind(&kind)
    .bind(input.grade.or(cur.grade))
    .bind(input.scale.or(cur.scale))
    .bind(input.faction.or(cur.faction))
    .bind(input.points.or(cur.points))
    .bind(&status)
    .bind(input.notes.or(cur.notes))
    .bind(input.sort_order.unwrap_or(cur.sort_order))
    .bind(input.cover_focus.unwrap_or(cur.cover_focus).clamp(0, 100))
    .bind(input.task_id.or(cur.task_id))
    .bind(kit_id)
    .execute(db)
    .await?;
    let kit = sqlx::query_as::<_, ModelKit>("SELECT * FROM model_kits WHERE id = ?").bind(kit_id).fetch_one(db).await?;
    emit(DomainEvent { kind: "model.kit_updated".into(), project_id: Some(pid), entity_id: kit_id, data: serde_json::json!({ "status": status, "prev_status": prev_status }) });
    Ok(kit)
}

pub async fn delete_model_kit(db: &Db, kit_id: i64) -> Result<()> {
    let pid = model_kit_project(db, kit_id).await?;
    sqlx::query("DELETE FROM model_kits WHERE id = ?").bind(kit_id).execute(db).await?;
    if let Some(pid) = pid {
        emit(DomainEvent { kind: "model.kit_deleted".into(), project_id: Some(pid), entity_id: kit_id, data: serde_json::json!({}) });
    }
    Ok(())
}

/// Add a board (runner) and pre-create parts 1..max_parts, honouring duplicate
/// counts (a runner with two of #7 → `{7: 2}`). Mirrors the TUI.
pub async fn create_model_board(db: &Db, input: CreateModelBoardInput) -> Result<ModelBoard> {
    let kit_id = input.kit_id;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::InvalidInput("board name is required".into()));
    }
    if input.max_parts < 0 {
        return Err(crate::error::AppError::InvalidInput("max_parts cannot be negative".into()));
    }
    let next_order: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sort_order),-1)+1 FROM model_boards WHERE kit_id = ?")
        .bind(kit_id).fetch_one(db).await?;
    let res = sqlx::query("INSERT INTO model_boards (kit_id, name, max_parts, color, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(kit_id).bind(name).bind(input.max_parts).bind(input.color.as_deref()).bind(next_order)
        .execute(db).await?;
    let board_id = res.last_insert_rowid();

    // Build the part-number list: 1..max_parts, with extra copies for duplicates.
    let mut numbers: Vec<i64> = Vec::new();
    for n in 1..=input.max_parts {
        let copies = input.duplicates.as_ref().and_then(|d| d.get(&n)).copied().unwrap_or(0);
        let count = if copies > 0 { copies } else { 1 };
        numbers.extend(std::iter::repeat(n).take(count as usize));
    }
    if !numbers.is_empty() {
        let mut sql = String::from("INSERT INTO model_parts (board_id, number, is_used) VALUES ");
        for (i, _n) in numbers.iter().enumerate() {
            if i > 0 { sql.push(','); }
            sql.push_str("(?, ?, 0)");
        }
        let mut q = sqlx::query(&sql);
        for n in &numbers { q = q.bind(board_id).bind(n); }
        q.execute(db).await?;
    }
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.board_created".into(), project_id: Some(pid), entity_id: board_id, data: serde_json::json!({ "kit_id": kit_id }) });
    let board = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE id = ?").bind(board_id).fetch_one(db).await?;
    Ok(board)
}

pub async fn update_model_board(db: &Db, board_id: i64, input: UpdateModelBoardInput) -> Result<ModelBoard> {
    let kit_id: i64 = sqlx::query_scalar("SELECT kit_id FROM model_boards WHERE id = ?").bind(board_id).fetch_one(db).await?;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let cur = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE id = ?").bind(board_id).fetch_one(db).await?;
    // Growing max_parts creates the new part rows; shrinking never deletes
    // existing parts (you may have already used #30) — it only changes the
    // declared grid extent.
    let new_max = input.max_parts.unwrap_or(cur.max_parts);
    if new_max > cur.max_parts {
        let mut sql = String::from("INSERT INTO model_parts (board_id, number, is_used) VALUES ");
        let new_numbers: Vec<i64> = ((cur.max_parts + 1)..=new_max).collect();
        for (i, _n) in new_numbers.iter().enumerate() {
            if i > 0 { sql.push(','); }
            sql.push_str("(?, ?, 0)");
        }
        let mut q = sqlx::query(&sql);
        for n in &new_numbers { q = q.bind(board_id).bind(n); }
        q.execute(db).await?;
    }
    sqlx::query("UPDATE model_boards SET name=?, max_parts=?, color=?, sort_order=? WHERE id=?")
        .bind(input.name.unwrap_or(cur.name))
        .bind(new_max)
        .bind(input.color.or(cur.color))
        .bind(input.sort_order.unwrap_or(cur.sort_order))
        .bind(board_id)
        .execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.board_updated".into(), project_id: Some(pid), entity_id: board_id, data: serde_json::json!({ "kit_id": kit_id }) });
    let board = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE id = ?").bind(board_id).fetch_one(db).await?;
    Ok(board)
}

pub async fn delete_model_board(db: &Db, board_id: i64) -> Result<()> {
    let kit_id: i64 = sqlx::query_scalar("SELECT kit_id FROM model_boards WHERE id = ?").bind(board_id).fetch_one(db).await?;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    sqlx::query("DELETE FROM model_boards WHERE id = ?").bind(board_id).execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.board_deleted".into(), project_id: Some(pid), entity_id: board_id, data: serde_json::json!({ "kit_id": kit_id }) });
    Ok(())
}

pub async fn list_model_sections(db: &Db, kit_id: i64) -> Result<Vec<ModelSection>> {
    let sections = sqlx::query_as::<_, ModelSection>("SELECT * FROM model_sections WHERE kit_id = ? ORDER BY sort_order, id")
        .bind(kit_id).fetch_all(db).await?;
    Ok(sections)
}

pub async fn create_model_section(db: &Db, input: CreateModelSectionInput) -> Result<ModelSection> {
    let kit_id = input.kit_id;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::InvalidInput("section name is required".into()));
    }
    let next_order: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sort_order),-1)+1 FROM model_sections WHERE kit_id = ?")
        .bind(kit_id).fetch_one(db).await?;
    let res = sqlx::query("INSERT INTO model_sections (kit_id, name, start_step, end_step, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(kit_id).bind(name).bind(input.start_step.as_deref()).bind(input.end_step.as_deref()).bind(next_order)
        .execute(db).await?;
    let id = res.last_insert_rowid();
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.section_created".into(), project_id: Some(pid), entity_id: id, data: serde_json::json!({ "kit_id": kit_id }) });
    let s = sqlx::query_as::<_, ModelSection>("SELECT * FROM model_sections WHERE id = ?").bind(id).fetch_one(db).await?;
    Ok(s)
}

pub async fn update_model_section(db: &Db, section_id: i64, input: UpdateModelSectionInput) -> Result<ModelSection> {
    let kit_id: i64 = sqlx::query_scalar("SELECT kit_id FROM model_sections WHERE id = ?").bind(section_id).fetch_one(db).await?;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let cur = sqlx::query_as::<_, ModelSection>("SELECT * FROM model_sections WHERE id = ?").bind(section_id).fetch_one(db).await?;
    sqlx::query("UPDATE model_sections SET name=?, start_step=?, end_step=?, sort_order=? WHERE id=?")
        .bind(input.name.unwrap_or(cur.name))
        .bind(input.start_step.or(cur.start_step))
        .bind(input.end_step.or(cur.end_step))
        .bind(input.sort_order.unwrap_or(cur.sort_order))
        .bind(section_id)
        .execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.section_updated".into(), project_id: Some(pid), entity_id: section_id, data: serde_json::json!({ "kit_id": kit_id }) });
    let s = sqlx::query_as::<_, ModelSection>("SELECT * FROM model_sections WHERE id = ?").bind(section_id).fetch_one(db).await?;
    Ok(s)
}

pub async fn delete_model_section(db: &Db, section_id: i64) -> Result<()> {
    let kit_id: i64 = sqlx::query_scalar("SELECT kit_id FROM model_sections WHERE id = ?").bind(section_id).fetch_one(db).await?;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    // Free the parts this section held before cascade-delete (the TUI does this).
    sqlx::query("UPDATE model_parts SET is_used=0 WHERE id IN (SELECT part_id FROM model_used_parts WHERE section_id=?)")
        .bind(section_id).execute(db).await?;
    sqlx::query("DELETE FROM model_sections WHERE id = ?").bind(section_id).execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.section_deleted".into(), project_id: Some(pid), entity_id: section_id, data: serde_json::json!({ "kit_id": kit_id }) });
    Ok(())
}

/// Mark a part used in a section. If no unused copy exists, auto-create a new
/// copy (and grow max_parts if the number exceeds it) — covering both
/// forgotten duplicates and brand-new numbers recorded as the manual shows
/// them. Numbers above MAX_AUTO_PART_NUMBER are rejected as typos. Returns the
/// `(marked, auto_duplicated)` tuple the TUI exposes.
pub async fn mark_model_part(db: &Db, input: MarkModelPartInput) -> Result<(bool, bool)> {
    let kit_id = input.kit_id;
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let board: Option<ModelBoard> = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE kit_id=? AND name=?")
        .bind(kit_id).bind(input.board_name.as_str()).fetch_optional(db).await?;
    let board = match board { Some(b) => b, None => return Ok((false, false)) };
    // An unused copy first.
    let part: Option<ModelPart> = sqlx::query_as::<_, ModelPart>("SELECT * FROM model_parts WHERE board_id=? AND number=? AND is_used=0 LIMIT 1")
        .bind(board.id).bind(input.part_number).fetch_optional(db).await?;
    if let Some(p) = part {
        let now = Utc::now();
        sqlx::query("UPDATE model_parts SET is_used=1 WHERE id=?").bind(p.id).execute(db).await?;
        sqlx::query("INSERT INTO model_used_parts (part_id, section_id, used_at) VALUES (?, ?, ?)")
            .bind(p.id).bind(input.section_id).bind(now).execute(db).await?;
        touch_kit(db, kit_id).await?;
        emit(DomainEvent { kind: "model.part_marked".into(), project_id: Some(pid), entity_id: p.id, data: serde_json::json!({ "kit_id": kit_id, "section_id": input.section_id }) });
        return Ok((true, false));
    }
    // No unused copy — auto-create, capped at MAX_AUTO_PART_NUMBER.
    if input.part_number < 1 || input.part_number > MAX_AUTO_PART_NUMBER {
        return Ok((false, false));
    }
    if input.part_number > board.max_parts {
        sqlx::query("UPDATE model_boards SET max_parts=? WHERE id=?").bind(input.part_number).bind(board.id).execute(db).await?;
    }
    let res = sqlx::query("INSERT INTO model_parts (board_id, number, is_used) VALUES (?, ?, 1)")
        .bind(board.id).bind(input.part_number).execute(db).await?;
    let new_id = res.last_insert_rowid();
    let now = Utc::now();
    sqlx::query("INSERT INTO model_used_parts (part_id, section_id, used_at) VALUES (?, ?, ?)")
        .bind(new_id).bind(input.section_id).bind(now).execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.part_marked".into(), project_id: Some(pid), entity_id: new_id, data: serde_json::json!({ "kit_id": kit_id, "section_id": input.section_id, "auto_duplicated": true }) });
    Ok((true, true))
}

/// Free one used copy of a board's part (clears is_used + deletes its UsedPart).
pub async fn unmark_model_part(db: &Db, kit_id: i64, board_name: &str, part_number: i64) -> Result<bool> {
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT p.id, u.id FROM model_parts p \
        JOIN model_boards b ON p.board_id=b.id \
        LEFT JOIN model_used_parts u ON u.part_id=p.id \
        WHERE b.kit_id=? AND b.name=? AND p.number=? AND p.is_used=1 \
        ORDER BY u.used_at DESC LIMIT 1")
        .bind(kit_id).bind(board_name).bind(part_number).fetch_optional(db).await?;
    let Some((part_id, used_id)) = row else { return Ok(false) };
    sqlx::query("DELETE FROM model_used_parts WHERE id=?").bind(used_id).execute(db).await?;
    sqlx::query("UPDATE model_parts SET is_used=0 WHERE id=?").bind(part_id).execute(db).await?;
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.part_unmarked".into(), project_id: Some(pid), entity_id: part_id, data: serde_json::json!({ "kit_id": kit_id }) });
    Ok(true)
}

/// Link a project_file to a kit under a category. Returns the link row.
pub async fn link_model_kit_file(db: &Db, kit_id: i64, file_id: i64, kind: &str, caption: Option<&str>) -> Result<ModelKitFile> {
    let pid = model_kit_project(db, kit_id).await?.ok_or_else(|| crate::error::AppError::NotFound("model kit".into()))?;
    // The file must belong to the same project (no cross-project borrowing).
    let file_pid: i64 = sqlx::query_scalar("SELECT project_id FROM project_files WHERE id = ?").bind(file_id).fetch_one(db).await?;
    if file_pid != pid {
        return Err(crate::error::AppError::InvalidInput("that file is not in this project".into()));
    }
    let k = match kind { "manual" | "paint" => kind, _ => "photo" };
    let next_order: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sort_order),-1)+1 FROM model_kit_files WHERE kit_id=? AND kind=?")
        .bind(kit_id).bind(k).fetch_one(db).await?;
    let res = sqlx::query("INSERT INTO model_kit_files (kit_id, file_id, kind, caption, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(kit_id).bind(file_id).bind(k).bind(caption).bind(next_order).execute(db).await?;
    let id = res.last_insert_rowid();
    touch_kit(db, kit_id).await?;
    emit(DomainEvent { kind: "model.file_linked".into(), project_id: Some(pid), entity_id: id, data: serde_json::json!({ "kit_id": kit_id, "file_id": file_id, "kind": k }) });
    let f = sqlx::query_as::<_, ModelKitFile>("SELECT * FROM model_kit_files WHERE id = ?").bind(id).fetch_one(db).await?;
    Ok(f)
}

pub async fn unlink_model_kit_file(db: &Db, link_id: i64) -> Result<()> {
    let kit_id: Option<i64> = sqlx::query_scalar("SELECT kit_id FROM model_kit_files WHERE id = ?").bind(link_id).fetch_optional(db).await?;
    sqlx::query("DELETE FROM model_kit_files WHERE id = ?").bind(link_id).execute(db).await?;
    if let Some(kid) = kit_id {
        if let Some(pid) = model_kit_project(db, kid).await? {
            touch_kit(db, kid).await?;
            emit(DomainEvent { kind: "model.file_unlinked".into(), project_id: Some(pid), entity_id: link_id, data: serde_json::json!({ "kit_id": kid }) });
        }
    }
    Ok(())
}

/// The full nested shape of one kit for the detail view — boards, their parts,
/// sections with the part-numbers they consumed, image links, and roll-up
/// progress. One round trip, no N+1 on the frontend.
pub async fn get_model_kit_detail(db: &Db, kit_id: i64) -> Result<ModelKitDetail> {
    let kit = sqlx::query_as::<_, ModelKit>("SELECT * FROM model_kits WHERE id = ?").bind(kit_id).fetch_one(db).await?;
    let boards = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE kit_id=? ORDER BY sort_order, id").bind(kit_id).fetch_all(db).await?;
    let board_ids: Vec<i64> = boards.iter().map(|b| b.id).collect();
    let mut parts_by_board: std::collections::BTreeMap<i64, Vec<ModelPart>> = std::collections::BTreeMap::new();
    let mut total_parts: i64 = 0;
    let mut used_parts: i64 = 0;
    if !board_ids.is_empty() {
        // fetch all parts for these boards in one query, then group in memory.
        let all_parts: Vec<(i64, ModelPart)> = sqlx::query_as::<_, ModelPart>(
            "SELECT * FROM model_parts WHERE board_id IN (SELECT id FROM model_boards WHERE kit_id = ?) ORDER BY number")
            .bind(kit_id).fetch_all(db).await?
            .into_iter().map(|p| { total_parts += 1; if p.is_used { used_parts += 1; } (p.board_id, p) }).collect();
        for (bid, p) in all_parts { parts_by_board.entry(bid).or_default().push(p); }
    }
    let sections = sqlx::query_as::<_, ModelSection>("SELECT * FROM model_sections WHERE kit_id=? ORDER BY sort_order, id").bind(kit_id).fetch_all(db).await?;
    // used_by_section: section_id → board_id → sorted part numbers.
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT u.section_id, b.id, p.number FROM model_used_parts u \
         JOIN model_parts p ON u.part_id=p.id \
         JOIN model_boards b ON p.board_id=b.id \
         WHERE b.kit_id=? ORDER BY u.used_at")
        .bind(kit_id).fetch_all(db).await?;
    let mut used_by_section: std::collections::BTreeMap<i64, std::collections::BTreeMap<i64, Vec<i64>>> = std::collections::BTreeMap::new();
    for (sid, bid, num) in rows {
        used_by_section.entry(sid).or_default().entry(bid).or_default().push(num);
    }
    for m in used_by_section.values_mut() { for v in m.values_mut() { v.sort(); } }
    let files = sqlx::query_as::<_, ModelKitFile>("SELECT * FROM model_kit_files WHERE kit_id=? ORDER BY kind, sort_order, id").bind(kit_id).fetch_all(db).await?;
    let percent = if total_parts > 0 { (used_parts as f64 / total_parts as f64 * 100.0 * 10.0).round() / 10.0 } else { 0.0 };
    Ok(ModelKitDetail { kit, boards, parts_by_board, sections, used_by_section, files, total_parts, used_parts, percent })
}

/// Newest-first build log for a kit (the UsedPart audit trail).
pub async fn get_model_build_log(db: &Db, kit_id: i64) -> Result<Vec<ModelBuildLogEntry>> {
    let entries = sqlx::query_as::<_, ModelBuildLogEntry>(
        "SELECT u.id, u.used_at, s.id AS section_id, s.name AS section_name, \
                b.id AS board_id, b.name AS board_name, p.number AS part_number \
         FROM model_used_parts u \
         JOIN model_parts p ON u.part_id=p.id \
         JOIN model_boards b ON p.board_id=b.id \
         JOIN model_sections s ON u.section_id=s.id \
         WHERE b.kit_id=? ORDER BY u.used_at DESC")
        .bind(kit_id).fetch_all(db).await?;
    Ok(entries)
}

#[cfg(test)]
mod model_tests {
    use super::*;

    /// Atlas Phase 2b: the personal container is idempotent, hidden from
    /// every listing, and adopting kits moves the whole collection.
    #[tokio::test]
    async fn personal_container_is_hidden_and_adopts_kits() {
        let db = db().await;
        // ensure_personal_project writes a membership row — FK wants real users.
        for id in [7i64, 8] {
            sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
                .bind(id).bind(format!("u{id}")).bind(format!("User {id}"))
                .execute(&db).await.unwrap();
        }
        let visible = create_project(&db, CreateProjectInput { name: "Gunpla".into(), description: None }).await.unwrap();

        let p1 = ensure_personal_project(&db, 7).await.unwrap();
        let p2 = ensure_personal_project(&db, 7).await.unwrap();
        assert_eq!(p1, p2, "one container per user, ever");
        let other = ensure_personal_project(&db, 8).await.unwrap();
        assert_ne!(p1, other, "containers are per-user");

        // Hidden: listings show only real projects.
        let listed = get_projects(&db).await.unwrap();
        assert!(listed.iter().any(|p| p.id == visible.id));
        assert!(!listed.iter().any(|p| p.id == p1 || p.id == other), "personal containers never list");

        // Adoption moves the collection wholesale; children ride on kit_id.
        let kit = create_model_kit(&db, CreateModelKitInput {
            project_id: visible.id, name: "RX-78-2".into(), kind: "gundam".into(), grade: Some("MG".into()),
            scale: None, faction: None, points: None, status: None, notes: None,
        }).await.unwrap();
        let moved = adopt_model_kits(&db, visible.id, p1).await.unwrap();
        assert_eq!(moved, 1);
        assert!(list_model_kits(&db, visible.id).await.unwrap().is_empty(), "source emptied");
        let mine = list_model_kits(&db, p1).await.unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id, kit.id, "same kit rows — boards/sections untouched");
    }

    async fn db() -> Db {
        let path = std::env::temp_dir().join(format!("ganban_models_{}_{}.db", std::process::id(), std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        for ext in ["db", "db-wal", "db-shm"] { let _ = std::fs::remove_file(path.with_extension(ext)); }
        let pool = crate::init_db(&path).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn kit_lifecycle_boards_sections_and_marking_round_trip() {
        let db = db().await;
        let proj = create_project(&db, CreateProjectInput { name: "Bench".into(), description: None }).await.unwrap();

        // A Gundam kit with a board of 30 parts (two of #7) and one section.
        let kit = create_model_kit(&db, CreateModelKitInput { project_id: proj.id, name: "RX-78-2".into(), kind: "gundam".into(), grade: Some("RG".into()), scale: Some("1/144".into()), ..Default::default() }).await.unwrap();
        assert_eq!(kit.status, "Backlog");

        let board = create_model_board(&db, CreateModelBoardInput { kit_id: kit.id, name: "A".into(), max_parts: 30, color: Some("#3b6fb0".into()), duplicates: Some({ let mut m = std::collections::BTreeMap::new(); m.insert(7, 2); m }) }).await.unwrap();
        let section = create_model_section(&db, CreateModelSectionInput { kit_id: kit.id, name: "Chest".into(), start_step: Some("02-1".into()), end_step: Some("02-5".into()) }).await.unwrap();

        // Duplicates: board has 31 parts (1..30 plus an extra #7).
        let detail = get_model_kit_detail(&db, kit.id).await.unwrap();
        assert_eq!(detail.total_parts, 31);
        assert_eq!(detail.used_parts, 0);
        let a_parts = detail.parts_by_board.get(&board.id).unwrap();
        assert_eq!(a_parts.iter().filter(|p| p.number == 7).count(), 2, "two copies of #7");

        // Mark #7 twice (both copies) — second is NOT auto-dup since a copy exists.
        let r1 = mark_model_part(&db, MarkModelPartInput { kit_id: kit.id, board_name: "A".into(), part_number: 7, section_id: section.id }).await.unwrap();
        let r2 = mark_model_part(&db, MarkModelPartInput { kit_id: kit.id, board_name: "A".into(), part_number: 7, section_id: section.id }).await.unwrap();
        assert_eq!(r1, (true, false));
        assert_eq!(r2, (true, false));
        // A third #7 has no unused copy → auto-duplicate.
        let r3 = mark_model_part(&db, MarkModelPartInput { kit_id: kit.id, board_name: "A".into(), part_number: 7, section_id: section.id }).await.unwrap();
        assert_eq!(r3, (true, true));

        // A brand-new number (not on the board) is auto-created, growing max_parts.
        let r4 = mark_model_part(&db, MarkModelPartInput { kit_id: kit.id, board_name: "A".into(), part_number: 42, section_id: section.id }).await.unwrap();
        assert_eq!(r4, (true, true));
        let board2 = sqlx::query_as::<_, ModelBoard>("SELECT * FROM model_boards WHERE id = ?").bind(board.id).fetch_one(&db).await.unwrap();
        assert_eq!(board2.max_parts, 42, "max_parts grew to cover the new number");

        // A typo-sized number is rejected.
        let r5 = mark_model_part(&db, MarkModelPartInput { kit_id: kit.id, board_name: "A".into(), part_number: 9999, section_id: section.id }).await.unwrap();
        assert_eq!(r5, (false, false));

        // Progress + build log reflect 4 marks.
        let detail = get_model_kit_detail(&db, kit.id).await.unwrap();
        assert_eq!(detail.used_parts, 4);
        let log = get_model_build_log(&db, kit.id).await.unwrap();
        assert_eq!(log.len(), 4);
        assert!(log[0].used_at >= log[3].used_at, "newest-first");

        // Unmark frees one copy of #7.
        assert!(unmark_model_part(&db, kit.id, "A", 7).await.unwrap());
        let detail = get_model_kit_detail(&db, kit.id).await.unwrap();
        assert_eq!(detail.used_parts, 3);

        // Deleting a section frees its parts (the TUI semantics).
        delete_model_section(&db, section.id).await.unwrap();
        let detail = get_model_kit_detail(&db, kit.id).await.unwrap();
        assert_eq!(detail.used_parts, 0, "section delete frees every part it held");
        assert!(get_model_build_log(&db, kit.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn warhammer_kit_uses_faction_and_points() {
        let db = db().await;
        let proj = create_project(&db, CreateProjectInput { name: "Bench".into(), description: None }).await.unwrap();
        let kit = create_model_kit(&db, CreateModelKitInput {
            project_id: proj.id, name: "Combat Patrol".into(), kind: "40k".into(),
            faction: Some("Tyranids".into()), points: Some(500), ..Default::default()
        }).await.unwrap();
        assert_eq!(kit.kind, "40k");
        assert_eq!(kit.faction.as_deref(), Some("Tyranids"));
        assert_eq!(kit.points, Some(500));
        // Unknown kind normalizes to "other".
        let k2 = create_model_kit(&db, CreateModelKitInput { project_id: proj.id, name: "X".into(), kind: "ponies".into(), ..Default::default() }).await.unwrap();
        assert_eq!(k2.kind, "other");
        // Status lifecycle: update + a bogus status falls back to Backlog.
        let moved = update_model_kit(&db, kit.id, UpdateModelKitInput { status: Some("Painted".into()), ..Default::default() }).await.unwrap();
        assert_eq!(moved.status, "Painted");
        let bogus = update_model_kit(&db, kit.id, UpdateModelKitInput { status: Some("Teleported".into()), ..Default::default() }).await.unwrap();
        assert_eq!(bogus.status, "Backlog", "unknown status normalizes to Backlog");
    }
}

#[cfg(test)]
mod mention_tests {
    use super::parse_mentions;

    #[test]
    fn parses_dedupes_and_lowercases() {
        assert_eq!(parse_mentions("hey @Alice and @bob_1, also @alice again"), vec!["alice", "bob_1"]);
    }

    #[test]
    fn ignores_emails_and_bare_at() {
        // An email's '@' follows a word char, so it's not a mention.
        assert_eq!(parse_mentions("email foo@bar.com"), Vec::<String>::new());
        assert_eq!(parse_mentions("just @ here"), Vec::<String>::new());
        assert_eq!(parse_mentions("no mentions here"), Vec::<String>::new());
    }

    #[test]
    fn handles_punctuation_boundaries() {
        assert_eq!(parse_mentions("(@kim) said @lee."), vec!["kim", "lee"]);
    }
}

#[cfg(test)]
mod exdates_tests {
    use super::clean_exdates;

    #[test]
    fn keeps_valid_days_sorted_once() {
        assert_eq!(clean_exdates(Some(" 2026-11-10,2026-11-03,,2026-11-10,nope,2026-02-30".into())), Some("2026-11-03,2026-11-10".into()));
        assert_eq!(clean_exdates(Some("".into())), None);
        assert_eq!(clean_exdates(None), None);
    }
}
