//! Task visibility (ADR 0002): who among a project's members may see a task.
//!
//! A task's **audience** is the owner, the project's admins (and its
//! owner-member), the task's assignees, and whoever its visibility admits:
//!
//! - [`FOLLOWS_AREA`] (the default): everyone in the project, unless the task's
//!   area is a **restricted area**, then its **area members** only;
//! - [`SELECTED_MEMBERS`]: the members listed for the task;
//! - [`ADMINS_ONLY`]: nobody more.
//!
//! Everyone in the audience is a project member: an assignment or a listing
//! outlives leaving the project on record, but grants nothing. Outside the
//! audience a task is absent. The rule is one SQL predicate ([`visible_to`]), so
//! every reader asks the same question.

use std::collections::HashSet;

use chrono::Utc;

use crate::error::{AppError, Result};
use crate::Db;

/// The task follows its area: everyone, or a restricted area's members.
pub const FOLLOWS_AREA: &str = "area";
/// The task is seen by the members listed for it.
pub const SELECTED_MEMBERS: &str = "members";
/// The task is seen by admins only.
pub const ADMINS_ONLY: &str = "admins";

pub fn default_visibility() -> String {
    FOLLOWS_AREA.to_string()
}

/// Who is asking. The owner sees every task.
#[derive(Debug, Clone, Copy)]
pub struct Viewer {
    pub user_id: i64,
    pub is_owner: bool,
}

/// The rule, as a predicate over a task aliased `t`, for the user the SQL
/// expression `user` names ("?1", "pm.user_id"). Unknown visibility values
/// admit nobody beyond those who always see.
fn visible_to(user: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM project_members vpm WHERE vpm.project_id = t.project_id AND vpm.user_id = {user} \
           AND (vpm.role IN ('admin', 'owner') \
             OR EXISTS (SELECT 1 FROM task_assignees vta WHERE vta.task_id = t.id AND vta.user_id = {user}) \
             OR (t.visibility = '{SELECTED_MEMBERS}' \
                 AND EXISTS (SELECT 1 FROM task_selected_members vsm WHERE vsm.task_id = t.id AND vsm.user_id = {user})) \
             OR (t.visibility = '{FOLLOWS_AREA}' \
                 AND (t.area_id IS NULL \
                   OR NOT EXISTS (SELECT 1 FROM areas va WHERE va.id = t.area_id AND va.restricted = 1) \
                   OR EXISTS (SELECT 1 FROM area_members vam WHERE vam.area_id = t.area_id AND vam.user_id = {user})))))"
    )
}

/// Whether a user may see an area aliased `a`: open areas to every project
/// member, a restricted one to its area members and the admins.
fn area_visible_to(user: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM project_members vpm WHERE vpm.project_id = a.project_id AND vpm.user_id = {user} \
           AND (a.restricted = 0 OR vpm.role IN ('admin', 'owner') \
             OR EXISTS (SELECT 1 FROM area_members vam WHERE vam.area_id = a.id AND vam.user_id = {user})))"
    )
}

/// The tasks `viewer` can see, in one project or all of them. `None` means
/// every task (the owner).
pub async fn visible_tasks(db: &Db, viewer: Viewer, project: Option<i64>) -> Result<Option<HashSet<i64>>> {
    if viewer.is_owner {
        return Ok(None);
    }
    let sql = format!("SELECT t.id FROM tasks t WHERE (?2 IS NULL OR t.project_id = ?2) AND {}", visible_to("?1"));
    let ids: Vec<i64> = sqlx::query_scalar(&sql).bind(viewer.user_id).bind(project).fetch_all(db).await?;
    Ok(Some(ids.into_iter().collect()))
}

/// Whether `viewer` can see the task. A missing task is not seen.
pub async fn can_see_task(db: &Db, viewer: Viewer, task_id: i64) -> Result<bool> {
    if viewer.is_owner {
        return Ok(true);
    }
    let sql = format!("SELECT EXISTS (SELECT 1 FROM tasks t WHERE t.id = ?2 AND {})", visible_to("?1"));
    Ok(sqlx::query_scalar::<_, bool>(&sql).bind(viewer.user_id).bind(task_id).fetch_one(db).await?)
}

/// Whether `viewer` can see any of the tasks `tasks_sql` lists, a subquery over
/// the row id `?2` (a comment's tags, an attachment's task). A missing row isn't
/// seen.
async fn sees_any_task_of(db: &Db, viewer: Viewer, tasks_sql: &str, id: i64) -> Result<bool> {
    if viewer.is_owner {
        return Ok(true);
    }
    let sql = format!("SELECT EXISTS (SELECT 1 FROM tasks t WHERE t.id IN ({tasks_sql}) AND {})", visible_to("?1"));
    Ok(sqlx::query_scalar::<_, bool>(&sql).bind(viewer.user_id).bind(id).fetch_one(db).await?)
}

/// A comment is seen with any task it, or a comment above it in its thread, is tagged on:
/// a reply lives on its thread's home task, which may be hidden while the thread shows
/// through another tag.
pub async fn can_see_comment(db: &Db, viewer: Viewer, comment_id: i64) -> Result<bool> {
    let tags = "WITH RECURSIVE up(id) AS ( \
                  SELECT ?2 UNION SELECT c.parent_id FROM comments c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL) \
                SELECT task_id FROM comments WHERE id IN (SELECT id FROM up) \
                UNION SELECT task_id FROM comment_tasks WHERE comment_id IN (SELECT id FROM up)";
    sees_any_task_of(db, viewer, tags, comment_id).await
}

/// The comments of a project `viewer` can see (see [`can_see_comment`]). `None` means
/// all (the owner).
pub async fn visible_comments(db: &Db, viewer: Viewer, project: i64) -> Result<Option<HashSet<i64>>> {
    let Some(seen) = visible_tasks(db, viewer, Some(project)).await? else { return Ok(None) };
    let sql = "WITH RECURSIVE shown(id) AS ( \
                 SELECT c.id FROM comments c WHERE c.task_id IN (SELECT value FROM json_each(?1)) \
                   OR EXISTS (SELECT 1 FROM comment_tasks ct WHERE ct.comment_id = c.id \
                              AND ct.task_id IN (SELECT value FROM json_each(?1))) \
                 UNION SELECT c.id FROM comments c JOIN shown s ON c.parent_id = s.id) \
               SELECT id FROM shown";
    let ids: Vec<i64> = sqlx::query_scalar(sql).bind(json_ids(Some(&seen))).fetch_all(db).await?;
    Ok(Some(ids.into_iter().collect()))
}

/// An attachment is seen with its task.
pub async fn can_see_attachment(db: &Db, viewer: Viewer, attachment_id: i64) -> Result<bool> {
    sees_any_task_of(db, viewer, "SELECT task_id FROM file_attachments WHERE id = ?2", attachment_id).await
}

/// A time entry is seen with its task.
pub async fn can_see_time_entry(db: &Db, viewer: Viewer, entry_id: i64) -> Result<bool> {
    sees_any_task_of(db, viewer, "SELECT task_id FROM time_entries WHERE id = ?2", entry_id).await
}

/// The areas `viewer` can see, in one project or all of them. `None` means
/// all (the owner).
pub async fn visible_areas(db: &Db, viewer: Viewer, project: Option<i64>) -> Result<Option<HashSet<i64>>> {
    if viewer.is_owner {
        return Ok(None);
    }
    let sql = format!("SELECT a.id FROM areas a WHERE (?2 IS NULL OR a.project_id = ?2) AND {}", area_visible_to("?1"));
    let ids: Vec<i64> = sqlx::query_scalar(&sql).bind(viewer.user_id).bind(project).fetch_all(db).await?;
    Ok(Some(ids.into_iter().collect()))
}

/// Whether `viewer` can see the area. A missing area is not seen.
pub async fn can_see_area(db: &Db, viewer: Viewer, area_id: i64) -> Result<bool> {
    if viewer.is_owner {
        return Ok(true);
    }
    let sql = format!("SELECT EXISTS (SELECT 1 FROM areas a WHERE a.id = ?2 AND {})", area_visible_to("?1"));
    Ok(sqlx::query_scalar::<_, bool>(&sql).bind(viewer.user_id).bind(area_id).fetch_one(db).await?)
}

/// The task a command's arguments name, if any: `task_id`, `taskId` or `input.task_id`.
/// A proposal or an agent action about a task goes with the task: its summary and
/// snapshot quote it.
pub fn task_of_args(args: &serde_json::Value) -> Option<i64> {
    ["task_id", "taskId"]
        .iter()
        .find_map(|k| args.get(*k).and_then(serde_json::Value::as_i64))
        .or_else(|| args.get("input").and_then(|i| i.get("task_id")).and_then(serde_json::Value::as_i64))
}

/// A set of task ids as a JSON array, for `t.id IN (SELECT value FROM json_each(?))` in
/// queries that aggregate over a project's tasks. `None` (no filter) stays `None`.
pub fn json_ids(only: Option<&HashSet<i64>>) -> Option<String> {
    only.map(|ids| serde_json::to_string(&ids.iter().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into()))
}

/// Trim comments to the tasks a viewer sees: hidden tags go. A comment whose home
/// task is hidden moves to its first visible tag. A reply whose tags are all hidden
/// takes its thread's, so a reply to it never targets a hidden task. A comment left
/// with no visible task at all is dropped.
pub fn trim_comment_tags(comments: &mut Vec<crate::models::Comment>, seen: &HashSet<i64>) {
    for c in comments.iter_mut() {
        let tags = if c.task_ids.is_empty() { vec![c.task_id] } else { std::mem::take(&mut c.task_ids) };
        c.task_ids = tags.into_iter().filter(|t| seen.contains(t)).collect();
        if let Some(&first) = c.task_ids.first() {
            c.task_id = first;
        }
    }
    let parent: std::collections::HashMap<i64, Option<i64>> = comments.iter().map(|c| (c.id, c.parent_id)).collect();
    let tags: std::collections::HashMap<i64, Vec<i64>> = comments.iter().map(|c| (c.id, c.task_ids.clone())).collect();
    for c in comments.iter_mut().filter(|c| c.task_ids.is_empty()) {
        let mut up = c.parent_id;
        for _ in 0..50 {
            let Some(p) = up else { break };
            if let Some(&first) = tags.get(&p).and_then(|t| t.first()) {
                c.task_id = first;
                c.task_ids = vec![first];
                break;
            }
            up = parent.get(&p).copied().flatten();
        }
    }
    comments.retain(|c| !c.task_ids.is_empty());
}

/// Everyone who can see the task: the owner and the project members its rule
/// admits, by user id.
pub async fn audience(db: &Db, task_id: i64) -> Result<Vec<i64>> {
    let sql = format!(
        "SELECT id FROM users WHERE is_owner = 1 \
         UNION \
         SELECT pm.user_id FROM project_members pm JOIN tasks t ON t.project_id = pm.project_id \
         WHERE t.id = ?1 AND {} \
         ORDER BY 1",
        visible_to("pm.user_id")
    );
    Ok(sqlx::query_scalar(&sql).bind(task_id).fetch_all(db).await?)
}

/// The members listed for a task (meaningful while it's [`SELECTED_MEMBERS`]).
pub async fn selected_member_ids(db: &Db, task_id: i64) -> Result<Vec<i64>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM task_selected_members WHERE task_id = ? ORDER BY user_id")
        .bind(task_id)
        .fetch_all(db)
        .await?)
}

/// The area members of an area.
pub async fn area_member_ids(db: &Db, area_id: i64) -> Result<Vec<i64>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM area_members WHERE area_id = ? ORDER BY user_id")
        .bind(area_id)
        .fetch_all(db)
        .await?)
}

/// Refuse users who aren't members of the project.
async fn require_members(db: &Db, project_id: i64, users: &[i64]) -> Result<()> {
    for &u in users {
        let member: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)")
                .bind(project_id)
                .bind(u)
                .fetch_one(db)
                .await?;
        if !member {
            return Err(AppError::InvalidInput(format!("user {u} is not a member of this project")));
        }
    }
    Ok(())
}

/// Set who may see a task. `members` is the list for [`SELECTED_MEMBERS`] and
/// must be project members; other settings clear it.
pub async fn set_task_visibility(db: &Db, task_id: i64, visibility: &str, members: &[i64]) -> Result<()> {
    if ![FOLLOWS_AREA, SELECTED_MEMBERS, ADMINS_ONLY].contains(&visibility) {
        return Err(AppError::InvalidInput(format!(
            "visibility must be '{FOLLOWS_AREA}', '{SELECTED_MEMBERS}' or '{ADMINS_ONLY}'"
        )));
    }
    let project: i64 = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("task {task_id}")))?;
    let listed: &[i64] = if visibility == SELECTED_MEMBERS { members } else { &[] };
    require_members(db, project, listed).await?;
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE tasks SET visibility = ?, updated_at = ? WHERE id = ?")
        .bind(visibility)
        .bind(Utc::now())
        .bind(task_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM task_selected_members WHERE task_id = ?").bind(task_id).execute(&mut *tx).await?;
    for &u in listed {
        sqlx::query("INSERT OR IGNORE INTO task_selected_members (task_id, user_id) VALUES (?, ?)")
            .bind(task_id)
            .bind(u)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn area_project(db: &Db, area_id: i64) -> Result<i64> {
    sqlx::query_scalar("SELECT project_id FROM areas WHERE id = ?")
        .bind(area_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("area {area_id}")))
}

/// Restrict an area to its area members, or open it to the project.
pub async fn set_area_restricted(db: &Db, area_id: i64, restricted: bool) -> Result<()> {
    area_project(db, area_id).await?;
    sqlx::query("UPDATE areas SET restricted = ? WHERE id = ?").bind(restricted).bind(area_id).execute(db).await?;
    Ok(())
}

/// Replace an area's members; they must be project members.
pub async fn set_area_members(db: &Db, area_id: i64, users: &[i64]) -> Result<()> {
    let project = area_project(db, area_id).await?;
    require_members(db, project, users).await?;
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM area_members WHERE area_id = ?").bind(area_id).execute(&mut *tx).await?;
    for &u in users {
        sqlx::query("INSERT OR IGNORE INTO area_members (area_id, user_id) VALUES (?, ?)")
            .bind(area_id)
            .bind(u)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Whether moving the task to `new_area` would widen who sees it: it follows a
/// restricted area and would leave it. Only admins may do that.
pub async fn move_widens(db: &Db, task_id: i64, new_area: Option<i64>) -> Result<bool> {
    let sql = "SELECT t.area_id FROM tasks t JOIN areas a ON a.id = t.area_id \
               WHERE t.id = ? AND t.visibility = ? AND a.restricted = 1";
    let current: Option<i64> =
        sqlx::query_scalar(sql).bind(task_id).bind(FOLLOWS_AREA).fetch_optional(db).await?.flatten();
    Ok(current.is_some_and(|area| new_area != Some(area)))
}

/// Before a restricted area is deleted: the tasks that follow it become
/// [`SELECTED_MEMBERS`] with its area members, so nothing becomes visible by
/// accident. An open area's tasks stay as they are.
pub async fn keep_audience_of_area(db: &Db, area_id: i64) -> Result<()> {
    let restricted: Option<bool> =
        sqlx::query_scalar("SELECT restricted FROM areas WHERE id = ?").bind(area_id).fetch_optional(db).await?;
    if restricted != Some(true) {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT OR IGNORE INTO task_selected_members (task_id, user_id) \
         SELECT t.id, am.user_id FROM tasks t JOIN area_members am ON am.area_id = t.area_id \
         WHERE t.area_id = ?1 AND t.visibility = ?2",
    )
    .bind(area_id)
    .bind(FOLLOWS_AREA)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE tasks SET visibility = ?1, updated_at = ?2 WHERE area_id = ?3 AND visibility = ?4")
        .bind(SELECTED_MEMBERS)
        .bind(Utc::now())
        .bind(area_id)
        .bind(FOLLOWS_AREA)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Someone left the project: drop them from its areas and its tasks' lists.
pub async fn forget_project_member(db: &Db, project_id: i64, user_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM area_members WHERE user_id = ? AND area_id IN (SELECT id FROM areas WHERE project_id = ?)")
        .bind(user_id)
        .bind(project_id)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM task_selected_members WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)")
        .bind(user_id)
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assignments, auth, ops};

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_visibility_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    const OWNER: Viewer = Viewer { user_id: 1, is_owner: true };
    const ADA: i64 = 2; // project admin
    const MIA: i64 = 3; // member
    const BO: i64 = 4; // member
    const ZED: i64 = 5; // not in the project
    fn as_member(id: i64) -> Viewer {
        Viewer { user_id: id, is_owner: false }
    }

    struct World {
        db: Db,
        project: i64,
        finance: i64, // a restricted area, Mia's
        open_area: i64,
    }

    /// A project with an admin, two members and a stranger; a restricted area
    /// (Mia's) and an open one.
    async fn world(tag: &str) -> World {
        let db = test_db(tag).await;
        auth::ensure_owner(&db).await.unwrap();
        for (id, name) in [(ADA, "ada"), (MIA, "mia"), (BO, "bo"), (ZED, "zed")] {
            sqlx::query("INSERT INTO users (id, username, full_name) VALUES (?, ?, ?)").bind(id).bind(name).bind(name).execute(&db).await.unwrap();
        }
        let project = ops::create_project(&db, crate::models::CreateProjectInput { name: "P".into(), description: None }).await.unwrap().id;
        auth::add_project_member(&db, project, ADA, auth::ROLE_ADMIN).await.unwrap();
        auth::add_project_member(&db, project, MIA, auth::ROLE_MEMBER).await.unwrap();
        auth::add_project_member(&db, project, BO, auth::ROLE_MEMBER).await.unwrap();
        let area = |name: &str| crate::models::CreateAreaInput { project_id: project, name: name.into(), description: None };
        let finance = ops::create_area(&db, area("Finance")).await.unwrap().id;
        let open_area = ops::create_area(&db, area("Ops")).await.unwrap().id;
        set_area_restricted(&db, finance, true).await.unwrap();
        set_area_members(&db, finance, &[MIA]).await.unwrap();
        World { db, project, finance, open_area }
    }

    async fn task(w: &World, title: &str, area: Option<i64>) -> i64 {
        let input = crate::models::CreateTaskInput {
            project_id: w.project,
            area_id: area,
            title: title.into(),
            description: None,
            status: "To Do".into(),
            priority: "Low".into(),
            prefix: None,
            cost: None,
            currency: None,
            deadline: None,
        };
        ops::create_task(&w.db, input).await.unwrap().id
    }

    async fn sees(w: &World, who: i64, task: i64) -> bool {
        can_see_task(&w.db, as_member(who), task).await.unwrap()
    }

    #[tokio::test]
    async fn a_task_follows_its_area_by_default() {
        let w = world("follows").await;
        let loose = task(&w, "Loose", None).await;
        let ops_task = task(&w, "Ops", Some(w.open_area)).await;
        let budget = task(&w, "Budget", Some(w.finance)).await;

        for t in [loose, ops_task] {
            assert!(sees(&w, MIA, t).await && sees(&w, BO, t).await, "an open task is everyone's");
        }
        assert!(sees(&w, MIA, budget).await, "Mia is in Finance");
        assert!(!sees(&w, BO, budget).await, "Bo is not");
        assert!(sees(&w, ADA, budget).await, "admins always see");
        assert!(can_see_task(&w.db, OWNER, budget).await.unwrap(), "so does the owner");
        assert!(!sees(&w, ZED, loose).await, "outside the project, nothing");

        let bo_sees = visible_tasks(&w.db, as_member(BO), Some(w.project)).await.unwrap().unwrap();
        assert_eq!(bo_sees, HashSet::from([loose, ops_task]));
        assert_eq!(visible_tasks(&w.db, OWNER, None).await.unwrap(), None, "the owner sees all");
    }

    #[tokio::test]
    async fn a_restricted_area_is_hidden_with_its_tasks() {
        let w = world("areas").await;
        let mine = |who| visible_areas(&w.db, as_member(who), Some(w.project));
        assert_eq!(mine(MIA).await.unwrap().unwrap(), HashSet::from([w.finance, w.open_area]));
        assert_eq!(mine(BO).await.unwrap().unwrap(), HashSet::from([w.open_area]));
        assert_eq!(mine(ADA).await.unwrap().unwrap(), HashSet::from([w.finance, w.open_area]));
        assert!(!can_see_area(&w.db, as_member(BO), w.finance).await.unwrap());
        assert!(!can_see_area(&w.db, as_member(ZED), w.open_area).await.unwrap());
    }

    #[tokio::test]
    async fn a_task_narrows_to_selected_members_or_admins() {
        let w = world("narrow").await;
        let t = task(&w, "Offer letter", None).await;
        set_task_visibility(&w.db, t, SELECTED_MEMBERS, &[BO]).await.unwrap();
        assert!(sees(&w, BO, t).await && !sees(&w, MIA, t).await && sees(&w, ADA, t).await);
        assert_eq!(selected_member_ids(&w.db, t).await.unwrap(), vec![BO]);

        set_task_visibility(&w.db, t, ADMINS_ONLY, &[BO]).await.unwrap();
        assert!(!sees(&w, BO, t).await && sees(&w, ADA, t).await);
        assert!(selected_member_ids(&w.db, t).await.unwrap().is_empty(), "only selected members keeps a list");

        assert!(set_task_visibility(&w.db, t, SELECTED_MEMBERS, &[ZED]).await.unwrap_err().is_invalid_input());
        assert!(set_task_visibility(&w.db, t, "everyone", &[]).await.unwrap_err().is_invalid_input());
    }

    #[tokio::test]
    async fn assignees_always_see_but_only_while_members() {
        let w = world("assignees").await;
        let t = task(&w, "Audit", Some(w.finance)).await;
        assignments::assign(&w.db, t, BO, 1, None).await.unwrap();
        assert!(sees(&w, BO, t).await, "assigning lets Bo in");

        // Stale rows for someone outside the project (left behind when they
        // left) grant nothing.
        sqlx::query("INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (?, ?, 1)").bind(t).bind(ZED).execute(&w.db).await.unwrap();
        sqlx::query("INSERT INTO task_selected_members (task_id, user_id) VALUES (?, ?)").bind(t).bind(ZED).execute(&w.db).await.unwrap();
        assert!(!sees(&w, ZED, t).await);
    }

    #[tokio::test]
    async fn the_audience_is_everyone_who_can_see() {
        let w = world("audience").await;
        let budget = task(&w, "Budget", Some(w.finance)).await;
        assert_eq!(audience(&w.db, budget).await.unwrap(), vec![1, ADA, MIA]);
        let loose = task(&w, "Loose", None).await;
        assert_eq!(audience(&w.db, loose).await.unwrap(), vec![1, ADA, MIA, BO]);
    }

    #[tokio::test]
    async fn leaving_a_restricted_area_widens_the_audience() {
        let w = world("move").await;
        let budget = task(&w, "Budget", Some(w.finance)).await;
        let loose = task(&w, "Loose", None).await;
        assert!(move_widens(&w.db, budget, Some(w.open_area)).await.unwrap());
        assert!(move_widens(&w.db, budget, None).await.unwrap());
        assert!(!move_widens(&w.db, budget, Some(w.finance)).await.unwrap(), "staying put");
        assert!(!move_widens(&w.db, loose, Some(w.finance)).await.unwrap(), "moving in only narrows");
        set_task_visibility(&w.db, budget, SELECTED_MEMBERS, &[MIA]).await.unwrap();
        assert!(!move_widens(&w.db, budget, None).await.unwrap(), "a task with its own setting ignores its area");
    }

    #[tokio::test]
    async fn deleting_a_restricted_area_keeps_its_tasks_audience() {
        let w = world("delete_area").await;
        let budget = task(&w, "Budget", Some(w.finance)).await;
        let ops_task = task(&w, "Ops", Some(w.open_area)).await;
        ops::delete_area(&w.db, w.finance).await.unwrap();
        ops::delete_area(&w.db, w.open_area).await.unwrap();
        assert!(sees(&w, MIA, budget).await && !sees(&w, BO, budget).await, "still Mia's");
        assert_eq!(selected_member_ids(&w.db, budget).await.unwrap(), vec![MIA]);
        assert!(sees(&w, BO, ops_task).await, "an open area's tasks stay open");
    }

    #[tokio::test]
    async fn leaving_the_project_drops_area_and_task_listings() {
        let w = world("leave").await;
        let t = task(&w, "Offer", None).await;
        set_task_visibility(&w.db, t, SELECTED_MEMBERS, &[MIA]).await.unwrap();
        auth::remove_project_member(&w.db, w.project, MIA).await.unwrap();
        assert!(area_member_ids(&w.db, w.finance).await.unwrap().is_empty());
        assert!(selected_member_ids(&w.db, t).await.unwrap().is_empty());
        auth::add_project_member(&w.db, w.project, MIA, auth::ROLE_MEMBER).await.unwrap();
        assert!(!sees(&w, MIA, t).await, "coming back doesn't restore the old listings");
    }
}
