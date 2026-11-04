//! Budgets (FINANCE.md § Wave 2): a monthly target per expense account, with progress by
//! recognition period. A target with no month stands for every month; one with a month
//! overrides it. No carry-over.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::{audit, check_month, get_ledger_account_in, month_end, not_found, now, schedules, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Budget {
    pub id: i64,
    pub ledger_account_id: i64,
    /// `None`: the standing target for every month.
    pub month: Option<String>,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetInput {
    pub ledger_account_id: i64,
    pub month: Option<String>,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPatch {
    pub amount_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetProgress {
    pub ledger_account_id: i64,
    pub name: String,
    pub budget_id: i64,
    pub target_minor: i64,
    pub actual_minor: i64,
    pub remaining_minor: i64,
}

const COLUMNS: &str = "id, ledger_account_id, month, amount_minor";

fn check_amount(amount: i64) -> Result<()> {
    if amount < 0 {
        return Err(AppError::InvalidInput("a budget can't be negative".into()));
    }
    Ok(())
}

pub async fn list_budgets(db: &Db, ent: &Entity) -> Result<Vec<Budget>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM fin_budgets WHERE entity_id = ? ORDER BY ledger_account_id, IFNULL(month, '')"
    ))
    .bind(ent.id)
    .fetch_all(db)
    .await?)
}

async fn get_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Budget> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM fin_budgets WHERE id = ? AND entity_id = ?"))
        .bind(id)
        .bind(ent.id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| not_found("budget"))
}

pub async fn create_budget(db: &Db, ent: &Entity, input: BudgetInput) -> Result<Budget> {
    let mut tx = db.begin().await?;
    let la = get_ledger_account_in(&mut tx, ent, input.ledger_account_id).await?;
    if la.class != "expense" {
        return Err(AppError::InvalidInput("a budget is for an expense category".into()));
    }
    check_amount(input.amount_minor)?;
    let month = input.month.as_deref().map(check_month).transpose()?;
    let id = sqlx::query(
        "INSERT INTO fin_budgets (entity_id, ledger_account_id, month, amount_minor, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(la.id)
    .bind(&month)
    .bind(input.amount_minor)
    .bind(now())
    .bind(now())
    .execute(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::InvalidInput("that category already has a budget for this month".into())
        }
        e => e.into(),
    })?
    .last_insert_rowid();
    let budget = get_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "create", "budget", Some(id), None, Some(&serde_json::to_value(&budget)?)).await?;
    tx.commit().await?;
    Ok(budget)
}

pub async fn update_budget(db: &Db, ent: &Entity, id: i64, patch: BudgetPatch) -> Result<Budget> {
    let mut tx = db.begin().await?;
    let before = get_in(&mut tx, ent, id).await?;
    check_amount(patch.amount_minor)?;
    sqlx::query("UPDATE fin_budgets SET amount_minor = ?, updated_at = ? WHERE id = ?")
        .bind(patch.amount_minor)
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let after = get_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "update", "budget", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?)).await?;
    tx.commit().await?;
    Ok(after)
}

pub async fn delete_budget(db: &Db, ent: &Entity, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    let before = get_in(&mut tx, ent, id).await?;
    sqlx::query("DELETE FROM fin_budgets WHERE id = ?").bind(id).execute(&mut *tx).await?;
    audit(&mut tx, ent, "delete", "budget", Some(id), Some(&serde_json::to_value(&before)?), None).await?;
    tx.commit().await?;
    Ok(())
}

/// The targets that apply in a month: a month's own row, else the standing one.
pub(crate) async fn targets_in(conn: &mut Conn, ent: &Entity, month: &str) -> Result<HashMap<i64, Budget>> {
    let rows: Vec<Budget> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM fin_budgets WHERE entity_id = ? AND (month IS NULL OR month = ?) ORDER BY month IS NOT NULL"
    ))
    .bind(ent.id)
    .bind(month)
    .fetch_all(conn)
    .await?;
    // The month's own row comes last and wins.
    Ok(rows.into_iter().map(|b| (b.ledger_account_id, b)).collect())
}

/// Income and expense movements by recognition period, debit positive: posted lines from
/// `from` to `to` (months, inclusive), plus the releases in that range not yet posted.
pub(crate) async fn recognised_in(conn: &mut Conn, ent: &Entity, from: &str, to: &str) -> Result<HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT l.ledger_account_id, SUM(l.functional_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.status != 'draft' AND e.date BETWEEN ? AND ? AND la.class IN ('income', 'expense') \
         GROUP BY l.ledger_account_id",
    )
    .bind(ent.id)
    .bind(format!("{from}-01"))
    .bind(month_end(to))
    .fetch_all(&mut *conn)
    .await?;
    let mut out: HashMap<i64, i64> = rows.into_iter().collect();
    for r in schedules::pending_releases(conn, ent, from, to).await? {
        *out.entry(r.ledger_account_id).or_default() += r.amount_minor;
    }
    Ok(out)
}

/// Each budgeted category's spending in a month, by recognition period.
pub async fn budget_progress(db: &Db, ent: &Entity, month: &str) -> Result<Vec<BudgetProgress>> {
    let month = check_month(month)?;
    let mut conn = db.acquire().await?;
    let targets = targets_in(&mut conn, ent, &month).await?;
    let actual = recognised_in(&mut conn, ent, &month, &month).await?;
    let mut out = Vec::new();
    for (account, b) in targets {
        let la = get_ledger_account_in(&mut conn, ent, account).await?;
        let spent = actual.get(&account).copied().unwrap_or(0);
        out.push((la.code.clone(), BudgetProgress {
            ledger_account_id: account,
            name: la.name,
            budget_id: b.id,
            target_minor: b.amount_minor,
            actual_minor: spent,
            remaining_minor: b.amount_minor - spent,
        }));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out.into_iter().map(|(_, p)| p).collect())
}
