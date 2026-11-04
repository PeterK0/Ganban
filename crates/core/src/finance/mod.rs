//! Finance: a personal double-entry ledger on IFRS principles (`docs/design/FINANCE.md`,
//! ADR 0009, ADR 0010).
//!
//! Every public function takes the caller's [`Entity`] and reaches only its rows: a row id
//! that belongs to another entity is [`AppError::NotFound`]. There is no owner bypass. Every
//! mutation writes `fin_audit`, and every journal entry balances in the functional currency.
//!
//! Mutations come in two shapes: `x(db, …)` runs in its own transaction, and `x_in(conn, …)`
//! runs inside the caller's (an import batch).
//!
//! Finance data is private: errors and logs never carry amounts, payees or descriptions.

pub(crate) mod schema;

mod accounts;
mod chart;
pub mod close;
pub mod currency;
mod entries;
pub mod import;
pub mod pairing;
pub mod rates;
pub mod rules;
mod reports;
pub mod budgets;
pub mod forecast;
pub mod recurring;
pub mod reminder;
pub mod schedules;
pub mod statements;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_wave2;

pub use accounts::*;
pub use entries::*;
pub use reports::*;

use chrono::{Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

use crate::error::{AppError, Result};
use crate::Db;

/// A connection inside a transaction (`&mut *tx`).
pub type Conn = sqlx::SqliteConnection;

/// The accounts the app posts to, found by their `system_key`.
pub mod system {
    pub const OPENING_EQUITY: &str = "opening_equity";
    pub const TRANSFERS_CLEARING: &str = "transfers_clearing";
    pub const FX_REALISED_GAIN: &str = "fx_realised_gain";
    pub const FX_REALISED_LOSS: &str = "fx_realised_loss";
    pub const FX_UNREALISED_GAIN: &str = "fx_unrealised_gain";
    pub const FX_UNREALISED_LOSS: &str = "fx_unrealised_loss";
    pub const BANK_FEES: &str = "bank_fees";
    pub const UNCATEGORISED_EXPENSE: &str = "uncategorised_expense";
    pub const UNCATEGORISED_INCOME: &str = "uncategorised_income";
    pub const PREPAYMENTS: &str = "prepayments";
    pub const ACCRUED_EXPENSES: &str = "accrued_expenses";
    pub const RECEIVABLES: &str = "receivables";
    pub const DEFERRED_INCOME: &str = "deferred_income";
    pub const OCI_RESERVE: &str = "oci_reserve";
}

/// The personal reporting entity of one user. v1 has one per user, created on first use with
/// the default chart.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Entity {
    pub id: i64,
    pub user_id: i64,
    /// The user's personal container project.
    pub project_id: Option<i64>,
    pub name: String,
    pub functional_currency: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityPatch {
    pub name: Option<String>,
    pub functional_currency: Option<String>,
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn today() -> String {
    Utc::now().date_naive().format("%Y-%m-%d").to_string()
}

/// A `YYYY-MM-DD` date, checked.
pub(crate) fn check_date(s: &str) -> Result<String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::InvalidInput(format!("'{}' is not a date (YYYY-MM-DD)", s.trim())))
}

pub(crate) fn not_found(kind: &str) -> AppError {
    AppError::NotFound(kind.to_string())
}

/// The user's entity, created with its default chart on first use.
pub async fn entity_for_user(db: &Db, user_id: i64) -> Result<Entity> {
    if let Some(e) = find_entity(db, user_id).await? {
        return Ok(e);
    }
    let project_id = crate::ops::ensure_personal_project(db, user_id).await?;
    let mut tx = db.begin().await?;
    let created = sqlx::query(
        "INSERT OR IGNORE INTO fin_entities (user_id, project_id, name, functional_currency, created_at) \
         VALUES (?, ?, 'Personal', 'EUR', ?)",
    )
    .bind(user_id)
    .bind(project_id)
    .bind(now())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    let entity: Entity =
        sqlx::query_as("SELECT * FROM fin_entities WHERE user_id = ?").bind(user_id).fetch_one(&mut *tx).await?;
    if created {
        chart::create_default(&mut tx, &entity).await?;
        audit(&mut tx, &entity, "create", "entity", Some(entity.id), None, Some(&serde_json::to_value(&entity)?)).await?;
        // First use: have the rates routine fetch the full ECB history at its next check.
        sqlx::query("UPDATE routines SET last_run_at = NULL WHERE kind = 'ecb_rates' AND NOT EXISTS (SELECT 1 FROM fin_rates)")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(entity)
}

/// The user's entity if they have one, without creating it (the assistant's finance tools ask
/// this, so a chat never sets up Finance for someone who hasn't used it).
pub async fn find_entity(db: &Db, user_id: i64) -> Result<Option<Entity>> {
    Ok(sqlx::query_as("SELECT * FROM fin_entities WHERE user_id = ?").bind(user_id).fetch_optional(db).await?)
}

/// Rename the entity or change its functional currency. The currency can change only while
/// nothing is posted; drafts are retranslated into the new one.
pub async fn update_entity(db: &Db, ent: &Entity, patch: EntityPatch) -> Result<Entity> {
    let mut tx = db.begin().await?;
    let mut next = ent.clone();
    if let Some(name) = patch.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("the name can't be empty".into()));
        }
        next.name = name.to_string();
    }
    let mut retranslate = false;
    if let Some(cur) = patch.functional_currency {
        let cur = currency::normalise(&cur)?;
        if cur != ent.functional_currency {
            let posted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_entries WHERE entity_id = ? AND status != 'draft'")
                .bind(ent.id)
                .fetch_one(&mut *tx)
                .await?;
            if posted > 0 {
                return Err(AppError::InvalidInput(
                    "the functional currency can change only while nothing is posted".into(),
                ));
            }
            next.functional_currency = cur;
            retranslate = true;
        }
    }
    sqlx::query("UPDATE fin_entities SET name = ?, functional_currency = ? WHERE id = ?")
        .bind(&next.name)
        .bind(&next.functional_currency)
        .bind(ent.id)
        .execute(&mut *tx)
        .await?;
    if retranslate {
        entries::retranslate_drafts(&mut tx, &next).await?;
    }
    audit(&mut tx, ent, "update", "entity", Some(ent.id), Some(&serde_json::to_value(ent)?), Some(&serde_json::to_value(&next)?))
        .await?;
    tx.commit().await?;
    Ok(next)
}

/// Write one row of the audit log.
pub async fn audit(
    conn: &mut Conn,
    ent: &Entity,
    action: &str,
    kind: &str,
    row_id: Option<i64>,
    before: Option<&Value>,
    after: Option<&Value>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO fin_audit (entity_id, at, user_id, action, kind, row_id, before_json, after_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(now())
    .bind(ent.user_id)
    .bind(action)
    .bind(kind)
    .bind(row_id)
    .bind(before.map(Value::to_string))
    .bind(after.map(Value::to_string))
    .execute(conn)
    .await?;
    Ok(())
}

/// Refuse a change dated in a closed period. Months close in order, so a date in or before
/// the latest closed month is locked, even in a month that never had an entry.
pub(crate) async fn require_open(conn: &mut Conn, ent: &Entity, date: &str) -> Result<()> {
    if is_locked(conn, ent, date).await? {
        Err(AppError::InvalidInput("closed period: reverse it instead".into()))
    } else {
        Ok(())
    }
}

/// Whether a date falls in or before the latest closed month.
pub(crate) async fn is_locked(conn: &mut Conn, ent: &Entity, date: &str) -> Result<bool> {
    let month = date.get(..7).unwrap_or(date);
    let latest: Option<String> =
        sqlx::query_scalar("SELECT MAX(month) FROM fin_periods WHERE entity_id = ? AND status = 'closed'")
            .bind(ent.id)
            .fetch_one(conn)
            .await?;
    Ok(latest.is_some_and(|m| month <= m.as_str()))
}

// ============== Months ==============

/// A `YYYY-MM` month, checked.
pub(crate) fn check_month(s: &str) -> Result<String> {
    let s = s.trim();
    NaiveDate::parse_from_str(&format!("{s}-01"), "%Y-%m-%d")
        .map(|d| d.format("%Y-%m").to_string())
        .map_err(|_| AppError::InvalidInput(format!("'{s}' is not a month (YYYY-MM)")))
}

pub(crate) fn month_start(month: &str) -> NaiveDate {
    NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").expect("a checked month")
}

/// The month `n` months after `month` (before, when negative).
pub(crate) fn add_months(month: &str, n: i64) -> String {
    let d = month_start(month);
    let idx = d.year() as i64 * 12 + d.month0() as i64 + n;
    format!("{:04}-{:02}", idx.div_euclid(12), idx.rem_euclid(12) + 1)
}

/// The last day of a month, `YYYY-MM-DD`.
pub(crate) fn month_end(month: &str) -> String {
    (month_start(&add_months(month, 1)) - chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
}

/// A system account the app posts to, adopting an older entity's unkeyed default (by code)
/// or creating it when it's missing.
pub(crate) async fn ensure_system_account_in(conn: &mut Conn, ent: &Entity, key: &str) -> Result<LedgerAccount> {
    if let Ok(la) = system_account_in(conn, ent, key).await {
        return Ok(la);
    }
    let (code, name, class) = match key {
        system::PREPAYMENTS => ("1300", "Prepayments", "asset"),
        system::RECEIVABLES => ("1400", "Receivables", "asset"),
        system::ACCRUED_EXPENSES => ("2100", "Accrued expenses", "liability"),
        system::DEFERRED_INCOME => ("2200", "Deferred income", "liability"),
        _ => return Err(not_found("ledger account")),
    };
    let adopted = sqlx::query(
        "UPDATE fin_ledger_accounts SET system_key = ? WHERE id = (SELECT id FROM fin_ledger_accounts \
         WHERE entity_id = ? AND code = ? AND class = ? AND system_key IS NULL AND archived = 0 ORDER BY id LIMIT 1)",
    )
    .bind(key)
    .bind(ent.id)
    .bind(code)
    .bind(class)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if adopted == 0 {
        sqlx::query(
            "INSERT INTO fin_ledger_accounts (entity_id, code, name, class, cash_flow_class, system_key, position) \
             VALUES (?, ?, ?, ?, 'operating', ?, (SELECT IFNULL(MAX(position), 0) + 10 FROM fin_ledger_accounts WHERE entity_id = ?))",
        )
        .bind(ent.id)
        .bind(code)
        .bind(name)
        .bind(class)
        .bind(key)
        .bind(ent.id)
        .execute(&mut *conn)
        .await?;
    }
    system_account_in(conn, ent, key).await
}
