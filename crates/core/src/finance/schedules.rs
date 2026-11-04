//! Recognition schedules (FINANCE.md § Wave 2, Recognition schedules): spread an income or
//! expense line over months through a balance account; close posts each month's release.
//!
//! Creating a schedule posts a deferral on the entry's date that moves the line's amount to
//! the balance account; each month's release moves its share back. A release whose month is
//! still open hasn't posted yet, but profit or loss and budgets count it in its month
//! ([`pending_releases`]).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::entries::{post_system_entry_in, SysLine};
use super::{
    add_months, audit, check_month, ensure_system_account_in, get_entry_in, month_end, not_found, now, require_open,
    system, Conn, Entity,
};
use crate::error::{AppError, Result};
use crate::Db;

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleRow {
    pub month: String,
    pub amount_minor: i64,
    pub released: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub id: i64,
    pub entry_id: i64,
    pub ledger_account_id: i64,
    pub balance_account_id: i64,
    pub kind: String,
    pub start_month: String,
    pub months: i64,
    pub amount_minor: i64,
    pub deferral_entry_id: Option<i64>,
    pub created_at: String,
    pub rows: Vec<ScheduleRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    pub entry_id: i64,
    pub ledger_account_id: Option<i64>,
    pub start_month: String,
    pub months: i64,
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct ScheduleRec {
    pub id: i64,
    pub entry_id: i64,
    pub ledger_account_id: i64,
    pub balance_account_id: i64,
    pub kind: String,
    pub start_month: String,
    pub months: i64,
    pub amount_minor: i64,
    pub deferral_entry_id: Option<i64>,
    pub created_at: String,
}

impl ScheduleRec {
    /// Each month's share, the rounding in the last month.
    pub(crate) fn shares(&self) -> Vec<(String, i64)> {
        let base = self.amount_minor / self.months;
        (0..self.months)
            .map(|i| {
                let amount = if i == self.months - 1 { self.amount_minor - base * (self.months - 1) } else { base };
                (add_months(&self.start_month, i), amount)
            })
            .collect()
    }
}

/// A release not yet posted: `amount_minor` moves onto the income or expense account (debit
/// positive) and off the balance account.
#[derive(Debug, Clone)]
pub(crate) struct PendingRelease {
    pub schedule_id: i64,
    pub month: String,
    pub ledger_account_id: i64,
    pub balance_account_id: i64,
    pub amount_minor: i64,
}

pub const MAX_MONTHS: i64 = 120;

async fn records(conn: &mut Conn, ent: &Entity) -> Result<Vec<ScheduleRec>> {
    Ok(sqlx::query_as(
        "SELECT id, entry_id, ledger_account_id, balance_account_id, kind, start_month, months, amount_minor, \
                deferral_entry_id, created_at FROM fin_schedules WHERE entity_id = ? ORDER BY id",
    )
    .bind(ent.id)
    .fetch_all(conn)
    .await?)
}

async fn released(conn: &mut Conn, ent: &Entity) -> Result<HashSet<(i64, String)>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT r.schedule_id, r.month FROM fin_schedule_releases r JOIN fin_schedules s ON s.id = r.schedule_id \
         WHERE s.entity_id = ?",
    )
    .bind(ent.id)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// The releases from `from` to `to` (months, inclusive) that haven't posted yet.
pub(crate) async fn pending_releases(conn: &mut Conn, ent: &Entity, from: &str, to: &str) -> Result<Vec<PendingRelease>> {
    let done = released(conn, ent).await?;
    let mut out = Vec::new();
    for s in records(conn, ent).await? {
        for (month, amount) in s.shares() {
            if month.as_str() >= from && month.as_str() <= to && !done.contains(&(s.id, month.clone())) {
                out.push(PendingRelease {
                    schedule_id: s.id,
                    month,
                    ledger_account_id: s.ledger_account_id,
                    balance_account_id: s.balance_account_id,
                    amount_minor: amount,
                });
            }
        }
    }
    Ok(out)
}

/// Post the releases due up to and including `month` (at its close), each dated at its
/// own month's end: an earlier month with no entries never closes on its own, and its
/// release mustn't be left behind once the lock passes it. Returns the release entries.
pub(crate) async fn post_releases_in(conn: &mut Conn, ent: &Entity, month: &str) -> Result<Vec<i64>> {
    let mut ids = Vec::new();
    for r in pending_releases(conn, ent, "0000-01", month).await? {
        let month = r.month.as_str();
        let lines = vec![
            SysLine::functional(ent, r.ledger_account_id, r.amount_minor, Some("Release")),
            SysLine::functional(ent, r.balance_account_id, -r.amount_minor, Some("Release")),
        ];
        let entry = post_system_entry_in(conn, ent, &month_end(month), format!("Recognition release {month}"), lines).await?;
        sqlx::query("INSERT INTO fin_schedule_releases (schedule_id, month, entry_id) VALUES (?, ?, ?)")
            .bind(r.schedule_id)
            .bind(month)
            .bind(entry.id)
            .execute(&mut *conn)
            .await?;
        ids.push(entry.id);
    }
    Ok(ids)
}

fn view(s: ScheduleRec, done: &HashSet<(i64, String)>) -> Schedule {
    let rows = s
        .shares()
        .into_iter()
        .map(|(month, amount_minor)| ScheduleRow { released: done.contains(&(s.id, month.clone())), month, amount_minor })
        .collect();
    Schedule {
        id: s.id,
        entry_id: s.entry_id,
        ledger_account_id: s.ledger_account_id,
        balance_account_id: s.balance_account_id,
        kind: s.kind,
        start_month: s.start_month,
        months: s.months,
        amount_minor: s.amount_minor,
        deferral_entry_id: s.deferral_entry_id,
        created_at: s.created_at,
        rows,
    }
}

pub async fn list_schedules(db: &Db, ent: &Entity, entry_id: Option<i64>) -> Result<Vec<Schedule>> {
    let mut conn = db.acquire().await?;
    let done = released(&mut conn, ent).await?;
    Ok(records(&mut conn, ent)
        .await?
        .into_iter()
        .filter(|s| entry_id.is_none_or(|e| s.entry_id == e))
        .map(|s| view(s, &done))
        .collect())
}

async fn get_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Schedule> {
    let done = released(conn, ent).await?;
    records(conn, ent).await?.into_iter().find(|s| s.id == id).map(|s| view(s, &done)).ok_or_else(|| not_found("schedule"))
}

/// Whether an entry carries a schedule, or is one's deferral or release (its lines are then
/// fixed).
pub(crate) async fn has_schedule(conn: &mut Conn, entry_id: i64) -> Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM fin_schedules WHERE entry_id = ?1 OR deferral_entry_id = ?1) \
              + (SELECT COUNT(*) FROM fin_schedule_releases WHERE entry_id = ?1)",
    )
    .bind(entry_id)
    .fetch_one(conn)
    .await?;
    Ok(n > 0)
}

pub async fn create_schedule(db: &Db, ent: &Entity, input: ScheduleInput) -> Result<Schedule> {
    let mut tx = db.begin().await?;
    let entry = get_entry_in(&mut tx, ent, input.entry_id).await?;
    if entry.status != "posted" || entry.reverses_id.is_some() {
        return Err(AppError::InvalidInput("only a posted entry can be spread".into()));
    }
    if has_schedule(&mut tx, entry.id).await? {
        return Err(AppError::InvalidInput("this entry already has a schedule".into()));
    }
    let start = check_month(&input.start_month)?;
    if !(1..=MAX_MONTHS).contains(&input.months) {
        return Err(AppError::InvalidInput(format!("a schedule runs 1 to {MAX_MONTHS} months")));
    }
    // The income or expense line to spread.
    let mut candidates: Vec<(i64, String, i64)> = Vec::new();
    for l in &entry.lines {
        let la = super::get_ledger_account_in(&mut tx, ent, l.ledger_account_id).await?;
        if la.class != "income" && la.class != "expense" {
            continue;
        }
        if input.ledger_account_id.is_some_and(|id| id != la.id) {
            continue;
        }
        match candidates.iter_mut().find(|c| c.0 == la.id) {
            Some(c) => c.2 += l.functional_minor,
            None => candidates.push((la.id, la.class.clone(), l.functional_minor)),
        }
    }
    let (account, class, amount) = match candidates.as_slice() {
        [one] => one.clone(),
        [] => return Err(AppError::InvalidInput("the entry has no income or expense line to spread".into())),
        _ => return Err(AppError::InvalidInput("pick which income or expense line to spread".into())),
    };
    if amount == 0 {
        return Err(AppError::InvalidInput("that line is zero".into()));
    }
    let entry_month = entry.date[..7].to_string();
    let kind = if start >= entry_month { "prepaid" } else { "accrued" };
    let first = start.clone().min(entry_month);
    require_open(&mut tx, ent, &format!("{first}-01")).await?;
    let key = match (class.as_str(), kind) {
        ("expense", "prepaid") => system::PREPAYMENTS,
        ("expense", _) => system::ACCRUED_EXPENSES,
        (_, "prepaid") => system::DEFERRED_INCOME,
        _ => system::RECEIVABLES,
    };
    let balance = ensure_system_account_in(&mut tx, ent, key).await?;
    let lines = vec![
        SysLine::functional(ent, account, -amount, Some("Deferral")),
        SysLine::functional(ent, balance.id, amount, Some("Deferral")),
    ];
    let deferral = post_system_entry_in(&mut tx, ent, &entry.date, format!("Deferral: {}", entry.description), lines).await?;
    let id = sqlx::query(
        "INSERT INTO fin_schedules (entity_id, entry_id, ledger_account_id, balance_account_id, kind, start_month, months, \
         amount_minor, deferral_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(entry.id)
    .bind(account)
    .bind(balance.id)
    .bind(kind)
    .bind(&start)
    .bind(input.months)
    .bind(amount)
    .bind(deferral.id)
    .bind(now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let schedule = get_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "create", "schedule", Some(id), None, Some(&serde_json::to_value(&schedule)?)).await?;
    tx.commit().await?;
    Ok(schedule)
}

/// Delete a schedule while none of its releases has posted; its deferral goes with it.
pub async fn delete_schedule(db: &Db, ent: &Entity, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    let schedule = get_in(&mut tx, ent, id).await?;
    if schedule.rows.iter().any(|r| r.released) {
        return Err(AppError::InvalidInput("some of its months are closed: reverse its entries instead".into()));
    }
    if let Some(d) = schedule.deferral_entry_id {
        let deferral = get_entry_in(&mut tx, ent, d).await?;
        require_open(&mut tx, ent, &deferral.date).await?;
        sqlx::query("DELETE FROM fin_entries WHERE id = ?").bind(d).execute(&mut *tx).await?;
        audit(&mut tx, ent, "delete", "entry", Some(d), Some(&serde_json::to_value(&deferral)?), None).await?;
    }
    sqlx::query("DELETE FROM fin_schedules WHERE id = ?").bind(id).execute(&mut *tx).await?;
    audit(&mut tx, ent, "delete", "schedule", Some(id), Some(&serde_json::to_value(&schedule)?), None).await?;
    tx.commit().await?;
    Ok(())
}

/// The schedule an entry carries, with its deferral and posted release entries.
pub(crate) async fn schedule_entries(conn: &mut Conn, entry_id: i64) -> Result<Option<(i64, Vec<i64>)>> {
    let Some((id, deferral)): Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT id, deferral_entry_id FROM fin_schedules WHERE entry_id = ?").bind(entry_id).fetch_optional(&mut *conn).await?
    else {
        return Ok(None);
    };
    let releases: Vec<i64> =
        sqlx::query_scalar("SELECT entry_id FROM fin_schedule_releases WHERE schedule_id = ? AND entry_id IS NOT NULL ORDER BY month")
            .bind(id)
            .fetch_all(conn)
            .await?;
    Ok(Some((id, deferral.into_iter().chain(releases).collect())))
}
