//! Delete all finance data and start over (`docs/design/FINANCE.md` § Starting over).
//!
//! `fin_reset` empties the caller's entity: accounts, the journal, imported lines and batches,
//! pairs, budgets, planned and recurring items, schedules, periods and the audit trail, and the
//! rules and saved import layouts unless the user keeps them. The entity row and its settings
//! stay, the global ECB rates stay, and the default chart is created again, as on first use.
//!
//! A reset of a full bank history removes tens of thousands of rows, so it runs as a
//! background job and deletes in short `BEGIN IMMEDIATE` transactions with a pause after each,
//! as an import writes, so the rest of the host keeps writing meanwhile. It's refused while
//! the user's import or a bulk action runs, and those are refused while it runs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use super::import::jobs;
use super::rules::{Action, Conditions};
use super::{audit, chart, now, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

/// The word the caller must send, so a stray call can't wipe anyone's books.
pub const CONFIRM_WORD: &str = "DELETE";

/// A user on a database (the database file is in the key so tests on separate databases
/// don't share users).
type Key = (String, i64);

/// What runs for a user right now, besides imports (`import::jobs` keeps those).
#[derive(Default)]
pub(crate) struct Activity {
    bulk: usize,
    resetting: bool,
}

/// The activity map. Take it before the import jobs' map when both are needed.
pub(crate) fn activity() -> MutexGuard<'static, HashMap<Key, Activity>> {
    static ACTIVITY: OnceLock<Mutex<HashMap<Key, Activity>>> = OnceLock::new();
    ACTIVITY.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn key(db: &Db, ent: &Entity) -> Key {
    (db.connect_options().get_filename().to_string_lossy().into_owned(), ent.id)
}

fn resetting_refusal() -> AppError {
    AppError::InvalidInput("your finance data is being deleted: wait for it to finish".into())
}

pub(crate) fn refuse_in(map: &HashMap<Key, Activity>, k: &Key) -> Result<()> {
    if map.get(k).is_some_and(|a| a.resetting) {
        Err(resetting_refusal())
    } else {
        Ok(())
    }
}

/// Held while a bulk action or the suggestions job runs: a reset is refused meanwhile.
pub struct BulkGuard(Key);

impl Drop for BulkGuard {
    fn drop(&mut self) {
        let mut map = activity();
        if let Some(a) = map.get_mut(&self.0) {
            a.bulk = a.bulk.saturating_sub(1);
        }
    }
}

/// Marks a bulk action running for the user; refused while their reset runs.
pub fn begin_bulk(db: &Db, ent: &Entity) -> Result<BulkGuard> {
    let k = key(db, ent);
    let mut map = activity();
    refuse_in(&map, &k)?;
    map.entry(k.clone()).or_default().bulk += 1;
    Ok(BulkGuard(k))
}

// ============== What goes ==============

/// The counts the confirmation shows (`fin_reset_preview`), and what a reset removed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ResetCounts {
    pub accounts: i64,
    /// Journal entries, drafts included.
    pub entries: i64,
    pub rules: i64,
    /// Saved import layouts (the wizard's profiles).
    pub layouts: i64,
}

async fn count(conn: &mut Conn, sql: &str, entity_id: i64) -> Result<i64> {
    Ok(sqlx::query_scalar(sql).bind(entity_id).fetch_one(&mut *conn).await?)
}

async fn counts_in(conn: &mut Conn, ent: &Entity) -> Result<ResetCounts> {
    Ok(ResetCounts {
        accounts: count(conn, "SELECT COUNT(*) FROM fin_accounts WHERE entity_id = ?", ent.id).await?,
        entries: count(conn, "SELECT COUNT(*) FROM fin_entries WHERE entity_id = ?", ent.id).await?,
        rules: count(conn, "SELECT COUNT(*) FROM fin_rules WHERE entity_id = ?", ent.id).await?,
        layouts: count(conn, "SELECT COUNT(*) FROM fin_profiles WHERE entity_id = ?", ent.id).await?,
    })
}

/// `fin_reset_preview`: what a reset would delete.
pub async fn preview(db: &Db, ent: &Entity) -> Result<ResetCounts> {
    let mut conn = db.acquire().await?;
    counts_in(&mut conn, ent).await
}

// ============== The reset ==============

/// How the reset deletes: rows per transaction, and the pause after each commit so a waiting
/// writer gets the lock.
#[derive(Debug, Clone)]
pub struct ResetOptions {
    pub batch: i64,
    pub pause: Duration,
}

impl Default for ResetOptions {
    fn default() -> Self {
        ResetOptions { batch: 500, pause: Duration::from_millis(25) }
    }
}

/// What a finished reset reports.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResetResult {
    pub removed: ResetCounts,
    pub kept_rules: bool,
}

/// One step: a write over the rows a `FROM … WHERE` clause picks (by the entity id), done
/// `LIMIT` rows at a time until none are left: `"{write} (SELECT {pick} {from} LIMIT ?)"`.
struct Step {
    write: &'static str,
    pick: &'static str,
    from: &'static str,
}

const fn step(write: &'static str, pick: &'static str, from: &'static str) -> Step {
    Step { write, pick, from }
}

const STEPS: &[Step] = &[
    step("DELETE FROM fin_group_suggestions WHERE rowid IN", "rowid", "FROM fin_group_suggestions WHERE entity_id = ?"),
    step(
        "DELETE FROM fin_schedule_releases WHERE rowid IN",
        "r.rowid",
        "FROM fin_schedule_releases r JOIN fin_schedules s ON s.id = r.schedule_id WHERE s.entity_id = ?",
    ),
    step("DELETE FROM fin_schedules WHERE id IN", "id", "FROM fin_schedules WHERE entity_id = ?"),
    step("DELETE FROM fin_budgets WHERE id IN", "id", "FROM fin_budgets WHERE entity_id = ?"),
    step("DELETE FROM fin_planned WHERE id IN", "id", "FROM fin_planned WHERE entity_id = ?"),
    step("DELETE FROM fin_recurring WHERE id IN", "id", "FROM fin_recurring WHERE entity_id = ?"),
    step("DELETE FROM fin_pairs WHERE id IN", "id", "FROM fin_pairs WHERE entity_id = ?"),
    step("DELETE FROM fin_periods WHERE rowid IN", "rowid", "FROM fin_periods WHERE entity_id = ?"),
    // A reversal points at the entry it reverses: unlink them first, so deleting an entry
    // never has to look for one.
    step(
        "UPDATE fin_entries SET reverses_id = NULL WHERE id IN",
        "id",
        "FROM fin_entries WHERE entity_id = ? AND reverses_id IS NOT NULL",
    ),
    // Entries take their lines with them (ON DELETE CASCADE).
    step("DELETE FROM fin_entries WHERE id IN", "id", "FROM fin_entries WHERE entity_id = ?"),
    step("DELETE FROM fin_source_lines WHERE id IN", "id", "FROM fin_source_lines WHERE entity_id = ?"),
    step("DELETE FROM fin_import_batches WHERE id IN", "id", "FROM fin_import_batches WHERE entity_id = ?"),
    step("DELETE FROM fin_audit WHERE id IN", "id", "FROM fin_audit WHERE entity_id = ?"),
];

/// The same for rules and layouts, when they go too.
const RULES_AND_LAYOUTS: &[Step] = &[
    step("DELETE FROM fin_rules WHERE id IN", "id", "FROM fin_rules WHERE entity_id = ?"),
    step("DELETE FROM fin_profiles WHERE id IN", "id", "FROM fin_profiles WHERE entity_id = ?"),
];

fn steps(keep_rules: bool) -> impl Iterator<Item = &'static Step> {
    STEPS.iter().chain(if keep_rules { [].iter() } else { RULES_AND_LAYOUTS.iter() })
}

/// Rows the steps will touch, for the progress total.
async fn rows_to_go(conn: &mut Conn, ent: &Entity, keep_rules: bool) -> Result<usize> {
    let mut total: i64 = 0;
    for s in steps(keep_rules) {
        total += sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) {}", s.from)).bind(ent.id).fetch_one(&mut *conn).await?;
    }
    Ok(total.max(0) as usize)
}

/// Deletes all of the entity's finance data (see the module doc). `progress` gets rows done
/// of the total after each batch. Running it on an empty entity changes nothing but the chart,
/// which is recreated as it was.
pub async fn reset(
    db: &Db,
    ent: &Entity,
    keep_rules: bool,
    opts: &ResetOptions,
    progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> Result<ResetResult> {
    let (removed, total) = {
        let mut conn = db.acquire().await?;
        (counts_in(&mut conn, ent).await?, rows_to_go(&mut conn, ent, keep_rules).await?)
    };
    let removed = ResetCounts {
        rules: if keep_rules { 0 } else { removed.rules },
        layouts: if keep_rules { 0 } else { removed.layouts },
        ..removed
    };
    let mut done = 0usize;
    progress(done, total);
    for s in steps(keep_rules) {
        let sql = format!("{} (SELECT {} {} LIMIT ?)", s.write, s.pick, s.from);
        loop {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            let n = sqlx::query(&sql).bind(ent.id).bind(opts.batch.max(1)).execute(&mut *tx).await?.rows_affected();
            tx.commit().await?;
            if n == 0 {
                break;
            }
            done = (done + n as usize).min(total);
            progress(done, total);
            tokio::time::sleep(opts.pause).await;
        }
    }
    // The chart last, in one short transaction: the accounts, the ledger, a fresh default
    // chart, and the kept rules pointed at it.
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    // A write that slipped in meanwhile (an entry made in another window) goes too, so no
    // line still points at the old chart.
    for s in steps(keep_rules) {
        sqlx::query(&format!("{} (SELECT {} {})", s.write, s.pick, s.from)).bind(ent.id).execute(&mut *tx).await?;
    }
    let old_chart = if keep_rules { chart_of(&mut tx, ent).await? } else { Vec::new() };
    sqlx::query("DELETE FROM fin_accounts WHERE entity_id = ?").bind(ent.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE fin_ledger_accounts SET parent_id = NULL WHERE entity_id = ? AND parent_id IS NOT NULL")
        .bind(ent.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM fin_ledger_accounts WHERE entity_id = ?").bind(ent.id).execute(&mut *tx).await?;
    chart::create_default(&mut tx, ent).await?;
    if keep_rules {
        repoint_rules(&mut tx, ent, &old_chart).await?;
    }
    let after = json!({ "accounts": removed.accounts, "entries": removed.entries, "rules": removed.rules,
        "layouts": removed.layouts, "kept_rules": keep_rules });
    audit(&mut tx, ent, "reset", "entity", Some(ent.id), None, Some(&after)).await?;
    tx.commit().await?;
    progress(total, total);
    // The host log gets the user and the counts, nothing about the money itself.
    eprintln!(
        "finance reset: user {} removed {} accounts, {} entries, {} rules, {} layouts",
        ent.user_id, removed.accounts, removed.entries, removed.rules, removed.layouts
    );
    Ok(ResetResult { removed, kept_rules: keep_rules })
}

/// A ledger account as a kept rule needs it to find its match in the new chart.
#[derive(sqlx::FromRow)]
struct ChartRow {
    id: i64,
    code: String,
    name: String,
    class: String,
    cash_flow_class: Option<String>,
    system_key: Option<String>,
}

async fn chart_of(conn: &mut Conn, ent: &Entity) -> Result<Vec<ChartRow>> {
    Ok(sqlx::query_as("SELECT id, code, name, class, cash_flow_class, system_key FROM fin_ledger_accounts WHERE entity_id = ?")
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?)
}

/// Points the kept rules at the new chart: a category by its system key, else its code and
/// class; one the default chart lacks (the user's own) is created again with its name. A
/// rule's account condition goes, since the accounts are gone (a rule left with no
/// condition goes too, as it would match everything).
async fn repoint_rules(conn: &mut Conn, ent: &Entity, old: &[ChartRow]) -> Result<()> {
    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, conditions_json, action_json FROM fin_rules WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let old_by_id: HashMap<i64, &ChartRow> = old.iter().map(|r| (r.id, r)).collect();
    let mut new_ids: HashMap<i64, i64> = HashMap::new();
    for (rule_id, cond_json, action_json) in rows {
        let mut cond: Conditions = serde_json::from_str(&cond_json).unwrap_or_default();
        // An action that doesn't read is dropped with its rule, as one left with no condition is.
        let (mut action, readable): (Action, bool) = match serde_json::from_str(&action_json) {
            Ok(a) => (a, true),
            Err(_) => (Action::default(), false),
        };
        cond.account_id = None;
        let mut ok = readable && !cond.is_empty() && action.validate().is_ok();
        let targets = action.ledger_account_id.iter_mut().chain(action.splits.iter_mut().map(|s| &mut s.ledger_account_id));
        for la in targets {
            match new_ids.get(la) {
                Some(&id) => *la = id,
                None => match old_by_id.get(la) {
                    Some(row) => {
                        let id = match_or_create(conn, ent, row).await?;
                        new_ids.insert(*la, id);
                        *la = id;
                    }
                    None => ok = false,
                },
            }
        }
        if ok {
            sqlx::query("UPDATE fin_rules SET conditions_json = ?, action_json = ? WHERE id = ?")
                .bind(serde_json::to_string(&cond)?)
                .bind(serde_json::to_string(&action)?)
                .bind(rule_id)
                .execute(&mut *conn)
                .await?;
        } else {
            sqlx::query("DELETE FROM fin_rules WHERE id = ?").bind(rule_id).execute(&mut *conn).await?;
        }
    }
    Ok(())
}

async fn match_or_create(conn: &mut Conn, ent: &Entity, row: &ChartRow) -> Result<i64> {
    let found: Option<i64> = match &row.system_key {
        Some(k) => sqlx::query_scalar("SELECT id FROM fin_ledger_accounts WHERE entity_id = ? AND system_key = ?")
            .bind(ent.id)
            .bind(k)
            .fetch_optional(&mut *conn)
            .await?,
        None => sqlx::query_scalar(
            "SELECT id FROM fin_ledger_accounts WHERE entity_id = ? AND code = ? AND class = ? AND system_key IS NULL",
        )
        .bind(ent.id)
        .bind(&row.code)
        .bind(&row.class)
        .fetch_optional(&mut *conn)
        .await?,
    };
    if let Some(id) = found {
        return Ok(id);
    }
    // A system account the default chart doesn't make up front (deferred income) is made
    // when first needed, so its key isn't copied.
    let id = sqlx::query(
        "INSERT INTO fin_ledger_accounts (entity_id, code, name, class, cash_flow_class, position) \
         VALUES (?, ?, ?, ?, ?, (SELECT IFNULL(MAX(position), 0) + 10 FROM fin_ledger_accounts WHERE entity_id = ?))",
    )
    .bind(ent.id)
    .bind(&row.code)
    .bind(&row.name)
    .bind(&row.class)
    .bind(&row.cash_flow_class)
    .bind(ent.id)
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    Ok(id)
}

// ============== The job ==============

/// A reset as `fin_reset` and `fin_reset_status` report it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResetJob {
    pub job_id: u64,
    /// `running`, `done` or `failed`.
    pub state: &'static str,
    /// Rows deleted of the total.
    pub done: usize,
    pub total: usize,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub result: Option<ResetResult>,
    pub error: Option<String>,
}

fn reset_jobs() -> MutexGuard<'static, HashMap<Key, ResetJob>> {
    static JOBS: OnceLock<Mutex<HashMap<Key, ResetJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner())
}

fn update(k: &Key, job_id: u64, f: impl FnOnce(&mut ResetJob)) {
    if let Some(job) = reset_jobs().get_mut(k).filter(|j| j.job_id == job_id) {
        f(job);
    }
}

/// Starts a reset in the background and returns its job, running. `confirm` must be
/// [`CONFIRM_WORD`]. Refused while the user's import, a bulk action or another reset runs.
pub fn start(db: &Db, ent: &Entity, confirm: &str, keep_rules: bool) -> Result<ResetJob> {
    start_with(db, ent, confirm, keep_rules, ResetOptions::default())
}

pub fn start_with(db: &Db, ent: &Entity, confirm: &str, keep_rules: bool, opts: ResetOptions) -> Result<ResetJob> {
    if confirm != CONFIRM_WORD {
        return Err(AppError::InvalidInput(format!("type {CONFIRM_WORD} to confirm")));
    }
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let next = NEXT.get_or_init(|| AtomicU64::new(chrono::Utc::now().timestamp_millis().max(1) as u64));
    let k = key(db, ent);
    let job = {
        let mut map = activity();
        let a = map.entry(k.clone()).or_default();
        if a.resetting {
            return Err(resetting_refusal());
        }
        if a.bulk > 0 {
            return Err(AppError::InvalidInput("a bulk action or category suggestions are running: wait for them to finish".into()));
        }
        if jobs::is_running(db, ent) {
            return Err(AppError::InvalidInput("an import is running: wait for it to finish".into()));
        }
        a.resetting = true;
        let job = ResetJob {
            job_id: next.fetch_add(1, Ordering::Relaxed),
            state: "running",
            done: 0,
            total: 0,
            started_at: now(),
            finished_at: None,
            result: None,
            error: None,
        };
        reset_jobs().insert(k.clone(), job.clone());
        job
    };
    let (db, ent, id) = (db.clone(), ent.clone(), job.job_id);
    let ent_user = ent.user_id;
    let work_key = k.clone();
    let work = tokio::spawn(async move {
        let progress = move |done: usize, total: usize| {
            update(&work_key, id, |j| {
                j.done = done;
                j.total = total;
            })
        };
        let progress: Arc<dyn Fn(usize, usize) + Send + Sync> = Arc::new(progress);
        reset(&db, &ent, keep_rules, &opts, &*progress).await
    });
    // A second task records the outcome and frees the user, so even a panic ends the job.
    tokio::spawn(async move {
        let outcome = work.await;
        // Free the user first, so an import started the moment the job reads done is let in.
        if let Some(a) = activity().get_mut(&k) {
            a.resetting = false;
        }
        update(&k, id, |j| {
            j.finished_at = Some(now());
            match outcome {
                Ok(Ok(result)) => {
                    j.state = "done";
                    j.done = j.total;
                    j.result = Some(result);
                }
                Ok(Err(e)) => {
                    // The user and the kind of failure, nothing from the books.
                    let kind = match e {
                        AppError::Database(_) => "a database error",
                        AppError::Serialization(_) => "a serialization error",
                        _ => "an error",
                    };
                    eprintln!("finance reset failed for user {}: {kind}", ent_user);
                    j.state = "failed";
                    j.error = Some("the reset stopped before it finished: run it again to finish it".into());
                }
                Err(_) => {
                    j.state = "failed";
                    j.error = Some("the reset stopped unexpectedly: run it again to finish it".into());
                }
            }
        });
    });
    Ok(job)
}

/// The user's reset: the one with this id, else their latest. Another user's id is not found.
pub fn status(db: &Db, ent: &Entity, job_id: Option<u64>) -> Result<Option<ResetJob>> {
    let job = reset_jobs().get(&key(db, ent)).cloned();
    match job_id {
        None => Ok(job),
        Some(id) => match job.filter(|j| j.job_id == id) {
            Some(j) => Ok(Some(j)),
            None => Err(AppError::NotFound("reset job".into())),
        },
    }
}

#[cfg(test)]
#[path = "reset_tests.rs"]
mod tests;
