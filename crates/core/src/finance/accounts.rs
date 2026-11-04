//! Ledger accounts (the chart) and financial accounts (what the user holds at a bank).

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::{audit, chart, currency, entries, not_found, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

pub const CLASSES: &[&str] = &["asset", "liability", "equity", "income", "expense"];
pub const CASH_FLOW_CLASSES: &[&str] = &["operating", "investing", "financing"];
pub const ACCOUNT_KINDS: &[&str] = &["current", "savings", "card", "cash", "loan"];

/// An account of the chart. A *category* is an income or expense ledger account.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LedgerAccount {
    pub id: i64,
    pub entity_id: i64,
    pub code: String,
    pub name: String,
    pub class: String,
    pub parent_id: Option<i64>,
    /// Set for monetary accounts: their lines are in this currency.
    pub currency: Option<String>,
    pub cash_flow_class: Option<String>,
    pub system_key: Option<String>,
    pub archived: bool,
    pub position: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAccountInput {
    pub code: String,
    pub name: String,
    pub class: String,
    pub parent_id: Option<i64>,
    pub currency: Option<String>,
    pub cash_flow_class: Option<String>,
    pub position: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAccountPatch {
    pub code: Option<String>,
    pub name: Option<String>,
    pub parent_id: Option<i64>,
    pub cash_flow_class: Option<String>,
    pub position: Option<i64>,
}

/// A bank, vault, card, cash or loan account the user holds, with its balances. `balance_*`
/// counts posted entries (reversed ones too, beside their reversal), `draft_balance_*` the
/// drafts. Amounts are signed as debits: positive is money you hold, negative money you owe.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FinAccount {
    pub id: i64,
    pub entity_id: i64,
    pub ledger_account_id: i64,
    pub kind: String,
    pub name: String,
    pub institution: Option<String>,
    pub currency: String,
    pub iban_mask: Option<String>,
    pub profile_key: Option<String>,
    pub archived: bool,
    pub created_at: String,
    /// In the account's currency.
    pub balance_minor: i64,
    pub draft_balance_minor: i64,
    /// In the entity's functional currency.
    pub balance_functional_minor: i64,
    pub draft_balance_functional_minor: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinAccountInput {
    pub kind: String,
    pub name: String,
    pub institution: Option<String>,
    pub currency: String,
    pub iban_mask: Option<String>,
    pub profile_key: Option<String>,
    /// The balance as the bank shows it (negative = owed), posted against opening equity.
    pub opening_balance_minor: Option<i64>,
    /// Defaults to today.
    pub opening_date: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinAccountPatch {
    pub name: Option<String>,
    pub institution: Option<String>,
    pub iban_mask: Option<String>,
    pub profile_key: Option<String>,
}

fn one_of(value: &str, allowed: &[&str], what: &str) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("'{value}' is not a {what}")))
    }
}

fn non_empty(s: &str, what: &str) -> Result<String> {
    let s = s.trim();
    if s.is_empty() {
        Err(AppError::InvalidInput(format!("the {what} can't be empty")))
    } else {
        Ok(s.to_string())
    }
}

// ============== Ledger accounts ==============

pub async fn list_ledger_accounts(db: &Db, ent: &Entity, include_archived: bool) -> Result<Vec<LedgerAccount>> {
    Ok(sqlx::query_as(
        "SELECT * FROM fin_ledger_accounts WHERE entity_id = ? AND (? OR archived = 0) ORDER BY code, position, id",
    )
    .bind(ent.id)
    .bind(include_archived)
    .fetch_all(db)
    .await?)
}

/// One of the entity's ledger accounts; another entity's is not found.
pub async fn get_ledger_account_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<LedgerAccount> {
    sqlx::query_as("SELECT * FROM fin_ledger_accounts WHERE id = ? AND entity_id = ?")
        .bind(id)
        .bind(ent.id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| not_found("ledger account"))
}

/// The account the app posts to for `key` (see [`super::system`]).
pub async fn system_account(db: &Db, ent: &Entity, key: &str) -> Result<LedgerAccount> {
    let mut conn = db.acquire().await?;
    system_account_in(&mut conn, ent, key).await
}

pub async fn system_account_in(conn: &mut Conn, ent: &Entity, key: &str) -> Result<LedgerAccount> {
    sqlx::query_as("SELECT * FROM fin_ledger_accounts WHERE entity_id = ? AND system_key = ?")
        .bind(ent.id)
        .bind(key)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| not_found("system account"))
}

pub async fn create_ledger_account(db: &Db, ent: &Entity, input: LedgerAccountInput) -> Result<LedgerAccount> {
    let mut tx = db.begin().await?;
    let la = create_ledger_account_in(&mut tx, ent, input, None).await?;
    audit(&mut tx, ent, "create", "ledger_account", Some(la.id), None, Some(&serde_json::to_value(&la)?)).await?;
    tx.commit().await?;
    Ok(la)
}

async fn create_ledger_account_in(
    conn: &mut Conn,
    ent: &Entity,
    input: LedgerAccountInput,
    system_key: Option<&str>,
) -> Result<LedgerAccount> {
    one_of(&input.class, CLASSES, "ledger account class")?;
    if let Some(c) = &input.cash_flow_class {
        one_of(c, CASH_FLOW_CLASSES, "cash-flow class")?;
    }
    if let Some(p) = input.parent_id {
        get_ledger_account_in(conn, ent, p).await?;
    }
    let currency = input.currency.as_deref().map(currency::normalise).transpose()?;
    let id = sqlx::query(
        "INSERT INTO fin_ledger_accounts (entity_id, code, name, class, parent_id, currency, cash_flow_class, system_key, position) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(non_empty(&input.code, "code")?)
    .bind(non_empty(&input.name, "name")?)
    .bind(&input.class)
    .bind(input.parent_id)
    .bind(currency)
    .bind(&input.cash_flow_class)
    .bind(system_key)
    .bind(input.position.unwrap_or(0))
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    get_ledger_account_in(conn, ent, id).await
}

pub async fn update_ledger_account(db: &Db, ent: &Entity, id: i64, patch: LedgerAccountPatch) -> Result<LedgerAccount> {
    let mut tx = db.begin().await?;
    let before = get_ledger_account_in(&mut tx, ent, id).await?;
    let mut next = before.clone();
    if let Some(code) = patch.code {
        next.code = non_empty(&code, "code")?;
    }
    if let Some(name) = patch.name {
        next.name = non_empty(&name, "name")?;
    }
    if let Some(p) = patch.parent_id {
        // Walk up from the new parent: meeting this account would make a cycle.
        let mut at = Some(p);
        while let Some(a) = at {
            if a == id {
                return Err(AppError::InvalidInput("an account can't sit under itself".into()));
            }
            at = get_ledger_account_in(&mut tx, ent, a).await?.parent_id;
        }
        next.parent_id = Some(p);
    }
    if let Some(c) = patch.cash_flow_class {
        one_of(&c, CASH_FLOW_CLASSES, "cash-flow class")?;
        next.cash_flow_class = Some(c);
    }
    if let Some(p) = patch.position {
        next.position = p;
    }
    sqlx::query("UPDATE fin_ledger_accounts SET code = ?, name = ?, parent_id = ?, cash_flow_class = ?, position = ? WHERE id = ?")
        .bind(&next.code)
        .bind(&next.name)
        .bind(next.parent_id)
        .bind(&next.cash_flow_class)
        .bind(next.position)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, ent, "update", "ledger_account", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&next)?))
        .await?;
    tx.commit().await?;
    Ok(next)
}

/// Archive a ledger account. The app's system accounts can't be, and a financial account's
/// ledger account goes with it (`archive_account`).
pub async fn archive_ledger_account(db: &Db, ent: &Entity, id: i64) -> Result<LedgerAccount> {
    let mut tx = db.begin().await?;
    let before = get_ledger_account_in(&mut tx, ent, id).await?;
    if before.system_key.is_some() {
        return Err(AppError::InvalidInput("the app posts to this account, so it can't be archived".into()));
    }
    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_accounts WHERE ledger_account_id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if held > 0 {
        return Err(AppError::InvalidInput("archive the financial account instead".into()));
    }
    sqlx::query("UPDATE fin_ledger_accounts SET archived = 1 WHERE id = ?").bind(id).execute(&mut *tx).await?;
    let after = get_ledger_account_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "archive", "ledger_account", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?))
        .await?;
    tx.commit().await?;
    Ok(after)
}

// ============== Financial accounts ==============

/// The account row with its balances.
const ACCOUNT_SELECT: &str = "SELECT a.*, \
    COALESCE((SELECT SUM(l.amount_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
              WHERE l.ledger_account_id = a.ledger_account_id AND e.status != 'draft'), 0) AS balance_minor, \
    COALESCE((SELECT SUM(l.amount_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
              WHERE l.ledger_account_id = a.ledger_account_id AND e.status = 'draft'), 0) AS draft_balance_minor, \
    COALESCE((SELECT SUM(l.functional_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
              WHERE l.ledger_account_id = a.ledger_account_id AND e.status != 'draft'), 0) AS balance_functional_minor, \
    COALESCE((SELECT SUM(l.functional_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
              WHERE l.ledger_account_id = a.ledger_account_id AND e.status = 'draft'), 0) AS draft_balance_functional_minor \
    FROM fin_accounts a";

pub async fn list_accounts(db: &Db, ent: &Entity, include_archived: bool) -> Result<Vec<FinAccount>> {
    Ok(sqlx::query_as(&format!("{ACCOUNT_SELECT} WHERE a.entity_id = ? AND (? OR a.archived = 0) ORDER BY a.archived, a.name, a.id"))
        .bind(ent.id)
        .bind(include_archived)
        .fetch_all(db)
        .await?)
}

/// One of the entity's financial accounts; another entity's is not found.
pub async fn get_account_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<FinAccount> {
    sqlx::query_as(&format!("{ACCOUNT_SELECT} WHERE a.id = ? AND a.entity_id = ?"))
        .bind(id)
        .bind(ent.id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| not_found("account"))
}

pub async fn get_account(db: &Db, ent: &Entity, id: i64) -> Result<FinAccount> {
    let mut conn = db.acquire().await?;
    get_account_in(&mut conn, ent, id).await
}

/// Create a financial account: its ledger account (an asset, or a liability for a card or a
/// loan, in its currency), and its opening balance against opening equity.
pub async fn create_account(db: &Db, ent: &Entity, input: FinAccountInput) -> Result<FinAccount> {
    let mut tx = db.begin().await?;
    let account = create_account_in(&mut tx, ent, input).await?;
    tx.commit().await?;
    Ok(account)
}

pub async fn create_account_in(conn: &mut Conn, ent: &Entity, input: FinAccountInput) -> Result<FinAccount> {
    one_of(&input.kind, ACCOUNT_KINDS, "account kind")?;
    let name = non_empty(&input.name, "name")?;
    let cur = currency::normalise(&input.currency)?;
    let opening_date = input.opening_date.as_deref().map(super::check_date).transpose()?.unwrap_or_else(super::today);
    let (class, group, cash_flow) = match input.kind.as_str() {
        "savings" => ("asset", chart::GROUP_SAVINGS, "investing"),
        "card" => ("liability", chart::GROUP_CARDS_LOANS, "operating"),
        "loan" => ("liability", chart::GROUP_CARDS_LOANS, "financing"),
        _ => ("asset", chart::GROUP_CASH, "operating"),
    };
    let parent = system_account_in(conn, ent, group).await.ok();
    let code = next_code(conn, ent, parent.as_ref()).await?;
    let la = create_ledger_account_in(
        conn,
        ent,
        LedgerAccountInput {
            code,
            name: name.clone(),
            class: class.into(),
            parent_id: parent.map(|p| p.id),
            currency: Some(cur.clone()),
            cash_flow_class: Some(cash_flow.into()),
            position: None,
        },
        None,
    )
    .await?;
    let id = sqlx::query(
        "INSERT INTO fin_accounts (entity_id, ledger_account_id, kind, name, institution, currency, iban_mask, profile_key, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(la.id)
    .bind(&input.kind)
    .bind(&name)
    .bind(input.institution.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(&cur)
    .bind(&input.iban_mask)
    .bind(&input.profile_key)
    .bind(super::now())
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    let created = get_account_in(conn, ent, id).await?;
    audit(conn, ent, "create", "account", Some(id), None, Some(&serde_json::to_value(&created)?)).await?;
    if let Some(amount) = input.opening_balance_minor.filter(|a| *a != 0) {
        let equity = system_account_in(conn, ent, super::system::OPENING_EQUITY).await?;
        entries::create_entry_in(
            conn,
            ent,
            entries::EntryInput {
                date: opening_date,
                description: "Opening balance".into(),
                payee: None,
                notes: None,
                lines: vec![
                    entries::LineInput::new(la.id, amount, &cur),
                    entries::LineInput::new(equity.id, -amount, &cur),
                ],
            },
        )
        .await?;
    }
    get_account_in(conn, ent, id).await
}

/// The next free numeric code under `parent` (its code + 1, + 2, …).
async fn next_code(conn: &mut Conn, ent: &Entity, parent: Option<&LedgerAccount>) -> Result<String> {
    let Some(parent) = parent else {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_ledger_accounts WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_one(conn)
            .await?;
        return Ok(format!("A{}", n + 1));
    };
    let base: i64 = parent.code.parse().unwrap_or(0);
    let codes: Vec<String> = sqlx::query_scalar("SELECT code FROM fin_ledger_accounts WHERE entity_id = ? AND parent_id = ?")
        .bind(ent.id)
        .bind(parent.id)
        .fetch_all(conn)
        .await?;
    let max = codes.iter().filter_map(|c| c.parse::<i64>().ok()).max().unwrap_or(base);
    Ok((max + 1).to_string())
}

pub async fn update_account(db: &Db, ent: &Entity, id: i64, patch: FinAccountPatch) -> Result<FinAccount> {
    let mut tx = db.begin().await?;
    let before = get_account_in(&mut tx, ent, id).await?;
    let name = patch.name.as_deref().map(|n| non_empty(n, "name")).transpose()?.unwrap_or(before.name.clone());
    let institution = match patch.institution {
        Some(i) => Some(i.trim().to_string()).filter(|s| !s.is_empty()),
        None => before.institution.clone(),
    };
    let iban_mask = patch.iban_mask.or(before.iban_mask.clone());
    let profile_key = patch.profile_key.or(before.profile_key.clone());
    sqlx::query("UPDATE fin_accounts SET name = ?, institution = ?, iban_mask = ?, profile_key = ? WHERE id = ?")
        .bind(&name)
        .bind(&institution)
        .bind(&iban_mask)
        .bind(&profile_key)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE fin_ledger_accounts SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(before.ledger_account_id)
        .execute(&mut *tx)
        .await?;
    let after = get_account_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "update", "account", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?))
        .await?;
    tx.commit().await?;
    Ok(after)
}

/// Archive a financial account and its ledger account. Its history stays.
pub async fn archive_account(db: &Db, ent: &Entity, id: i64) -> Result<FinAccount> {
    let mut tx = db.begin().await?;
    let before = get_account_in(&mut tx, ent, id).await?;
    sqlx::query("UPDATE fin_accounts SET archived = 1 WHERE id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE fin_ledger_accounts SET archived = 1 WHERE id = ?")
        .bind(before.ledger_account_id)
        .execute(&mut *tx)
        .await?;
    let after = get_account_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "archive", "account", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?))
        .await?;
    tx.commit().await?;
    Ok(after)
}
