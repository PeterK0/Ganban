//! Period close (FINANCE.md § Wave 2, Period close): blockers, the IAS 21 retranslation, the
//! schedule releases, then the lock. Months close in order and only after they end.

use std::collections::BTreeMap;

use serde::Serialize;

use super::entries::{post_system_entry_in, SysLine};
use super::{add_months, audit, check_month, is_locked, month_end, now, rates, schedules, system, system_account_in, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

/// One month of the books.
#[derive(Debug, Clone, Serialize)]
pub struct Period {
    pub month: String,
    pub status: String,
    pub closed_at: Option<String>,
    pub entries: i64,
    pub drafts: i64,
}

/// What stops a close unless it's forced.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Blockers {
    pub review_pairs: Vec<i64>,
    pub uncategorised: Vec<i64>,
    pub drafts: Vec<i64>,
}

impl Blockers {
    pub fn is_empty(&self) -> bool {
        self.review_pairs.is_empty() && self.uncategorised.is_empty() && self.drafts.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CloseResult {
    pub closed: bool,
    pub month: String,
    pub blockers: Blockers,
    pub retranslation_entry_id: Option<i64>,
    pub release_entry_ids: Vec<i64>,
}

/// The months from the first one with an entry to the current one (`today`'s).
pub async fn list_periods(db: &Db, ent: &Entity, today: &str) -> Result<Vec<Period>> {
    let mut conn = db.acquire().await?;
    let counts: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT substr(date, 1, 7) AS m, COUNT(*), SUM(status = 'draft') FROM fin_entries WHERE entity_id = ? GROUP BY m",
    )
    .bind(ent.id)
    .fetch_all(&mut *conn)
    .await?;
    let closed: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT month, closed_at FROM fin_periods WHERE entity_id = ? AND status = 'closed'")
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?;
    let current = today.get(..7).unwrap_or(today).to_string();
    let counts: BTreeMap<String, (i64, i64)> = counts.into_iter().map(|(m, n, d)| (m, (n, d))).collect();
    let first = counts.keys().next().cloned().unwrap_or_else(|| current.clone()).min(current.clone());
    let last = counts.keys().next_back().cloned().unwrap_or_default().max(current);
    let latest_closed = closed.iter().map(|c| c.0.clone()).max();
    let mut out = Vec::new();
    let mut m = first;
    while m <= last {
        let (entries, drafts) = counts.get(&m).copied().unwrap_or((0, 0));
        let locked = latest_closed.as_ref().is_some_and(|l| m <= *l);
        out.push(Period {
            status: if locked { "closed" } else { "open" }.into(),
            closed_at: closed.iter().find(|c| c.0 == m).and_then(|c| c.1.clone()),
            month: m.clone(),
            entries,
            drafts,
        });
        m = add_months(&m, 1);
    }
    Ok(out)
}

async fn blockers(conn: &mut Conn, ent: &Entity, from: &str, to: &str) -> Result<Blockers> {
    let review_pairs = sqlx::query_scalar(
        "SELECT p.id FROM fin_pairs p JOIN fin_entries a ON a.id = p.entry_a JOIN fin_entries b ON b.id = p.entry_b \
         WHERE p.entity_id = ?1 AND p.status = 'review' \
           AND ((a.date BETWEEN ?2 AND ?3) OR (b.date BETWEEN ?2 AND ?3)) ORDER BY p.id",
    )
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .fetch_all(&mut *conn)
    .await?;
    let uncategorised = sqlx::query_scalar(
        "SELECT DISTINCT e.id FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ?1 AND e.status = 'posted' AND e.date BETWEEN ?2 AND ?3 \
           AND la.system_key IN (?4, ?5) ORDER BY e.id",
    )
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .bind(system::UNCATEGORISED_EXPENSE)
    .bind(system::UNCATEGORISED_INCOME)
    .fetch_all(&mut *conn)
    .await?;
    let drafts = sqlx::query_scalar(
        "SELECT id FROM fin_entries WHERE entity_id = ? AND status = 'draft' AND date BETWEEN ? AND ? ORDER BY id",
    )
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Blockers { review_pairs, uncategorised, drafts })
}

/// IAS 21: retranslate every foreign-currency monetary account's posted balance at the
/// closing rate, the difference to unrealised FX. Returns the entry, if anything moved.
async fn retranslate(conn: &mut Conn, ent: &Entity, month: &str) -> Result<Option<i64>> {
    let end = month_end(month);
    let balances: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT la.id, la.currency, SUM(l.amount_minor), SUM(l.functional_minor) FROM fin_lines l \
         JOIN fin_entries e ON e.id = l.entry_id JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.status != 'draft' AND e.date <= ? AND la.currency IS NOT NULL \
           AND la.currency != ? AND la.class IN ('asset', 'liability') \
         GROUP BY la.id ORDER BY la.code, la.id",
    )
    .bind(ent.id)
    .bind(&end)
    .bind(&ent.functional_currency)
    .fetch_all(&mut *conn)
    .await?;
    let mut lines = Vec::new();
    let (mut gain, mut loss) = (0i64, 0i64);
    for (account, cur, balance, carrying) in balances {
        let (target, _) = rates::translate_in(conn, balance, &cur, &ent.functional_currency, &end).await?;
        let diff = target - carrying;
        if diff == 0 {
            continue;
        }
        if diff > 0 {
            gain += diff;
        } else {
            loss -= diff;
        }
        lines.push(SysLine { ledger_account_id: account, amount_minor: 0, currency: cur, functional_minor: diff, memo: Some("Retranslation".into()) });
    }
    if lines.is_empty() {
        return Ok(None);
    }
    if gain > 0 {
        let la = system_account_in(conn, ent, system::FX_UNREALISED_GAIN).await?;
        lines.push(SysLine::functional(ent, la.id, -gain, Some("Unrealised FX gain")));
    }
    if loss > 0 {
        let la = system_account_in(conn, ent, system::FX_UNREALISED_LOSS).await?;
        lines.push(SysLine::functional(ent, la.id, loss, Some("Unrealised FX loss")));
    }
    let entry = post_system_entry_in(conn, ent, &end, format!("FX retranslation {month}"), lines).await?;
    Ok(Some(entry.id))
}

/// Close a month: report blockers (and stop, unless `force`; drafts stop it even then), then
/// post the retranslation and the releases due up to it, and lock it.
pub async fn close_period(db: &Db, ent: &Entity, month: &str, force: bool, today: &str) -> Result<CloseResult> {
    let month = check_month(month)?;
    let (from, to) = (format!("{month}-01"), month_end(&month));
    if to.as_str() >= today {
        return Err(AppError::InvalidInput("a month closes after it ends".into()));
    }
    let mut tx = db.begin().await?;
    if is_locked(&mut tx, ent, &from).await? {
        return Err(AppError::InvalidInput("that month is already closed".into()));
    }
    let latest: Option<String> =
        sqlx::query_scalar("SELECT MAX(month) FROM fin_periods WHERE entity_id = ? AND status = 'closed'")
            .bind(ent.id)
            .fetch_one(&mut *tx)
            .await?;
    let earlier: Option<String> = sqlx::query_scalar(
        "SELECT MIN(substr(date, 1, 7)) FROM fin_entries WHERE entity_id = ? AND date < ? AND substr(date, 1, 7) > ?",
    )
    .bind(ent.id)
    .bind(&from)
    .bind(latest.unwrap_or_default())
    .fetch_one(&mut *tx)
    .await?;
    if let Some(m) = earlier {
        return Err(AppError::InvalidInput(format!("close {m} first: months close in order")));
    }
    let blockers = blockers(&mut tx, ent, &from, &to).await?;
    // Drafts would be stuck in a locked month, so even a forced close waits for them.
    if !blockers.is_empty() && (!force || !blockers.drafts.is_empty()) {
        return Ok(CloseResult { closed: false, month, blockers, retranslation_entry_id: None, release_entry_ids: vec![] });
    }
    let retranslation_entry_id = retranslate(&mut tx, ent, &month).await?;
    let release_entry_ids = schedules::post_releases_in(&mut tx, ent, &month).await?;
    let at = now();
    sqlx::query(
        "INSERT INTO fin_periods (entity_id, month, status, closed_at) VALUES (?, ?, 'closed', ?) \
         ON CONFLICT(entity_id, month) DO UPDATE SET status = 'closed', closed_at = excluded.closed_at",
    )
    .bind(ent.id)
    .bind(&month)
    .bind(&at)
    .execute(&mut *tx)
    .await?;
    let after = serde_json::json!({ "month": month, "status": "closed", "forced": force && !blockers.is_empty(),
        "retranslation_entry_id": retranslation_entry_id, "release_entry_ids": release_entry_ids });
    audit(&mut tx, ent, "close", "period", None, None, Some(&after)).await?;
    tx.commit().await?;
    Ok(CloseResult { closed: true, month, blockers, retranslation_entry_id, release_entry_ids })
}
