//! Reports over the books: the trial balance, and income and spending by category.

use serde::Serialize;
use sqlx::FromRow;

use super::{check_date, Entity};
use crate::error::Result;
use crate::Db;

/// One ledger account's net posted balance in the functional currency, as a debit or a
/// credit. The rows' debits and credits total the same.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TrialBalanceRow {
    pub ledger_account_id: i64,
    pub code: String,
    pub name: String,
    pub class: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

/// The trial balance on `as_of`: posted entries (reversed ones with their reversals) dated
/// on or before it, per account with a non-zero balance.
pub async fn trial_balance(db: &Db, ent: &Entity, as_of: &str) -> Result<Vec<TrialBalanceRow>> {
    let as_of = check_date(as_of)?;
    Ok(sqlx::query_as(
        "SELECT la.id AS ledger_account_id, la.code, la.name, la.class, \
                MAX(SUM(l.functional_minor), 0) AS debit_minor, MAX(-SUM(l.functional_minor), 0) AS credit_minor \
         FROM fin_lines l \
         JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.status != 'draft' AND e.date <= ? \
         GROUP BY la.id HAVING SUM(l.functional_minor) != 0 \
         ORDER BY la.code, la.id",
    )
    .bind(ent.id)
    .bind(&as_of)
    .fetch_all(db)
    .await?)
}

/// One income or expense category's movement over a date range, in the functional currency.
/// `amount_minor` is natural: what was spent for an expense, what came in for income (a refund
/// can make it negative).
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct CategoryTotal {
    pub ledger_account_id: i64,
    pub name: String,
    pub class: String,
    pub amount_minor: i64,
    pub entries: i64,
}

/// Income and spending by category from `from` to `to` (dates, inclusive), by entry date (the
/// cash view). Drafts count, because a draft is a real bank line and rules sort drafts before
/// they're posted; reversed entries count with their reversals, so they net to nothing.
pub async fn category_totals(db: &Db, ent: &Entity, from: &str, to: &str) -> Result<Vec<CategoryTotal>> {
    let (from, to) = (check_date(from)?, check_date(to)?);
    Ok(sqlx::query_as(
        "SELECT la.id AS ledger_account_id, la.name, la.class, \
                CASE la.class WHEN 'expense' THEN SUM(l.functional_minor) ELSE -SUM(l.functional_minor) END AS amount_minor, \
                COUNT(DISTINCT e.id) AS entries \
         FROM fin_lines l \
         JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.date BETWEEN ? AND ? AND la.class IN ('income', 'expense') \
         GROUP BY la.id HAVING SUM(l.functional_minor) != 0 \
         ORDER BY la.class, amount_minor DESC, la.code",
    )
    .bind(ent.id)
    .bind(&from)
    .bind(&to)
    .fetch_all(db)
    .await?)
}
