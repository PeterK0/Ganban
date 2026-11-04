//! Recurring detection and planned items (FINANCE.md § Wave 2): payee, cadence and amount
//! band from posted history, confirmed or dismissed by the user; planned one-offs.
//!
//! Amounts here are cash effects in the functional currency: positive in, negative out.

use std::collections::BTreeMap;

use chrono::{Months, NaiveDate};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::{audit, check_date, get_account_in, get_ledger_account_in, not_found, now, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

pub const CADENCES: &[&str] = &["weekly", "monthly", "quarterly", "yearly"];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Recurring {
    pub id: i64,
    pub key: String,
    pub label: String,
    pub cadence: String,
    pub amount_minor: i64,
    pub amount_low_minor: i64,
    pub amount_high_minor: i64,
    pub ledger_account_id: Option<i64>,
    pub account_id: Option<i64>,
    pub occurrences: i64,
    pub first_date: String,
    pub last_date: String,
    pub next_date: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Planned {
    pub id: i64,
    pub date: String,
    pub description: String,
    pub amount_minor: i64,
    pub ledger_account_id: Option<i64>,
    pub account_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedInput {
    pub date: String,
    pub description: String,
    pub amount_minor: i64,
    pub ledger_account_id: Option<i64>,
    pub account_id: Option<i64>,
}

// ============== Bank history ==============

/// One entry that moved a financial account, outside transfer pairs.
#[derive(Debug, Clone)]
pub(crate) struct BankEntry {
    pub date: String,
    pub label: String,
    /// The normalised payee with the direction, `netflix:out`.
    pub key: String,
    pub account_id: i64,
    /// The cash effect, functional.
    pub cash_minor: i64,
    /// Its income and expense lines, `(ledger account, functional, debit positive)`.
    pub categories: Vec<(i64, i64)>,
}

/// A payee's grouping key: lower case letters only, the words joined by one space.
pub(crate) fn normalise(label: &str) -> String {
    let cleaned: String = label.chars().map(|c| if c.is_alphabetic() { c.to_lowercase().next().unwrap_or(c) } else { ' ' }).collect();
    let mut key = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some((i, _)) = key.char_indices().nth(40) {
        key.truncate(i);
    }
    key
}

/// Bank entries dated from `from` to `to`, oldest first: posted ones, and drafts too when
/// asked (a draft is a real bank line). Reversed entries, reversals, transfer legs and the
/// close's retranslations are left out.
pub(crate) async fn bank_entries(conn: &mut Conn, ent: &Entity, from: &str, to: &str, drafts: bool) -> Result<Vec<BankEntry>> {
    let statuses = if drafts { "('posted', 'draft')" } else { "('posted')" };
    let rows: Vec<(i64, String, String, i64, i64)> = sqlx::query_as(&format!(
        "SELECT e.id, e.date, COALESCE(NULLIF(e.payee, ''), e.description), MIN(fa.id), SUM(l.functional_minor) \
         FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id JOIN fin_accounts fa ON fa.ledger_account_id = l.ledger_account_id \
         WHERE e.entity_id = ?1 AND e.status IN {statuses} AND e.reverses_id IS NULL AND e.date BETWEEN ?2 AND ?3 \
           AND NOT EXISTS (SELECT 1 FROM fin_pairs p WHERE p.status != 'rejected' AND (p.entry_a = e.id OR p.entry_b = e.id)) \
           AND NOT EXISTS (SELECT 1 FROM fin_lines x JOIN fin_ledger_accounts xa ON xa.id = x.ledger_account_id \
                           WHERE x.entry_id = e.id AND xa.system_key IN ('fx_unrealised_gain', 'fx_unrealised_loss')) \
         GROUP BY e.id ORDER BY e.date, e.id"
    ))
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .fetch_all(&mut *conn)
    .await?;
    let lines: Vec<(i64, i64, i64)> = sqlx::query_as(&format!(
        "SELECT l.entry_id, l.ledger_account_id, l.functional_minor FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.status IN {statuses} AND e.date BETWEEN ? AND ? AND la.class IN ('income', 'expense') \
         ORDER BY l.id"
    ))
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_entry: BTreeMap<i64, Vec<(i64, i64)>> = BTreeMap::new();
    for (entry, account, f) in lines {
        by_entry.entry(entry).or_default().push((account, f));
    }
    Ok(rows
        .into_iter()
        .filter(|r| r.4 != 0)
        .map(|(id, date, label, account_id, cash_minor)| BankEntry {
            key: format!("{}:{}", normalise(&label), if cash_minor > 0 { "in" } else { "out" }),
            categories: by_entry.remove(&id).unwrap_or_default(),
            date,
            label,
            account_id,
            cash_minor,
        })
        .collect())
}

// ============== Detection ==============

/// (cadence, nominal days, tolerance, fewest occurrences)
const SHAPES: &[(&str, i64, i64, usize)] =
    &[("weekly", 7, 2, 3), ("monthly", 30, 5, 3), ("quarterly", 91, 12, 3), ("yearly", 365, 20, 2)];

pub(crate) fn step(date: NaiveDate, cadence: &str, n: u32) -> NaiveDate {
    match cadence {
        "weekly" => date + chrono::Duration::days(7 * n as i64),
        "quarterly" => date + Months::new(3 * n),
        "yearly" => date + Months::new(12 * n),
        _ => date + Months::new(n),
    }
}

fn median(v: &mut [i64]) -> i64 {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        // The lower middle keeps it an integer and deterministic.
        v[n / 2 - 1] + (v[n / 2] - v[n / 2 - 1]) / 2
    }
}

pub(crate) fn median_of(values: &[i64]) -> i64 {
    median(&mut values.to_vec())
}

fn parse(d: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
}

/// A detected pattern from one payee's entries (oldest first), if they recur.
struct Found {
    cadence: &'static str,
    amount: i64,
    low: i64,
    high: i64,
    category: Option<i64>,
    account: i64,
}

fn detect(entries: &[&BankEntry], today: NaiveDate) -> Option<Found> {
    // One occurrence per day.
    let mut days: Vec<(NaiveDate, i64)> = Vec::new();
    for e in entries {
        let d = parse(&e.date)?;
        match days.last_mut() {
            Some(last) if last.0 == d => last.1 += e.cash_minor,
            _ => days.push((d, e.cash_minor)),
        }
    }
    let intervals: Vec<i64> = days.windows(2).map(|w| (w[1].0 - w[0].0).num_days()).collect();
    let mut sorted = intervals.clone();
    let mid = median(&mut sorted);
    let (cadence, nominal, tol, _) = *SHAPES.iter().find(|(_, nominal, tol, min)| {
        let fits = intervals.iter().filter(|i| (**i - nominal).abs() <= *tol).count();
        days.len() >= *min && (mid - nominal).abs() <= *tol && fits * 4 >= intervals.len() * 3
    })?;
    let last = days.last()?.0;
    if (today - last).num_days() > 2 * nominal + tol {
        return None;
    }
    let mut amounts: Vec<i64> = days.iter().map(|d| d.1).collect();
    let amount = median(&mut amounts);
    let (low, high) = (amounts[0], amounts[amounts.len() - 1]);
    if high - low > amount.abs() {
        return None;
    }
    // The category seen most often, the latest on a tie.
    let mut counts: BTreeMap<i64, (usize, usize)> = BTreeMap::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(&(account, _)) = e.categories.iter().max_by_key(|c| c.1.abs()) {
            let c = counts.entry(account).or_default();
            c.0 += 1;
            c.1 = i;
        }
    }
    let category = counts.into_iter().max_by_key(|(_, c)| *c).map(|(a, _)| a);
    Some(Found { cadence, amount, low, high, category, account: entries.last()?.account_id })
}

const COLUMNS: &str = "id, key, label, cadence, amount_minor, amount_low_minor, amount_high_minor, ledger_account_id, \
    account_id, occurrences, first_date, last_date, next_date, status, created_at, updated_at";

/// Refresh the suggestions from the last 13 months of posted history. A dismissed pattern
/// stays dismissed; a confirmed one gets fresh figures.
pub async fn detect_recurring(db: &Db, ent: &Entity, today: &str) -> Result<Vec<Recurring>> {
    let today_d = parse(&check_date(today)?).ok_or_else(|| AppError::InvalidInput("bad date".into()))?;
    let from = (today_d - Months::new(13)).format("%Y-%m-%d").to_string();
    let mut tx = db.begin().await?;
    let history = bank_entries(&mut tx, ent, &from, today, false).await?;
    let mut groups: BTreeMap<&str, Vec<&BankEntry>> = BTreeMap::new();
    for e in &history {
        if !e.key.starts_with(':') {
            groups.entry(e.key.as_str()).or_default().push(e);
        }
    }
    let mut refreshed = 0;
    for (key, entries) in groups {
        let Some(f) = detect(&entries, today_d) else { continue };
        refreshed += 1;
        let (first, last) = (&entries[0].date, &entries[entries.len() - 1].date);
        let next = step(parse(last).unwrap_or(today_d), f.cadence, 1).format("%Y-%m-%d").to_string();
        let label = entries[entries.len() - 1].label.clone();
        sqlx::query(
            "INSERT INTO fin_recurring (entity_id, key, label, cadence, amount_minor, amount_low_minor, amount_high_minor, \
             ledger_account_id, account_id, occurrences, first_date, last_date, next_date, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'suggested', ?14, ?14) \
             ON CONFLICT(entity_id, key) DO UPDATE SET label = excluded.label, cadence = excluded.cadence, \
               amount_minor = excluded.amount_minor, amount_low_minor = excluded.amount_low_minor, \
               amount_high_minor = excluded.amount_high_minor, ledger_account_id = excluded.ledger_account_id, \
               account_id = excluded.account_id, occurrences = excluded.occurrences, first_date = excluded.first_date, \
               last_date = excluded.last_date, next_date = excluded.next_date, updated_at = excluded.updated_at \
             WHERE fin_recurring.status != 'dismissed'",
        )
        .bind(ent.id)
        .bind(key)
        .bind(&label)
        .bind(f.cadence)
        .bind(f.amount)
        .bind(f.low)
        .bind(f.high)
        .bind(f.category)
        .bind(f.account)
        .bind(entries.len() as i64)
        .bind(first)
        .bind(last)
        .bind(&next)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    }
    audit(&mut tx, ent, "detect", "recurring", None, None, Some(&serde_json::json!({ "patterns": refreshed }))).await?;
    tx.commit().await?;
    list_recurring(db, ent, None).await
}

pub async fn list_recurring(db: &Db, ent: &Entity, status: Option<&str>) -> Result<Vec<Recurring>> {
    let mut conn = db.acquire().await?;
    list_recurring_in(&mut conn, ent, status).await
}

pub(crate) async fn list_recurring_in(conn: &mut Conn, ent: &Entity, status: Option<&str>) -> Result<Vec<Recurring>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM fin_recurring WHERE entity_id = ? AND (?2 IS NULL OR status = ?2) ORDER BY label, id"
    ))
    .bind(ent.id)
    .bind(status)
    .fetch_all(conn)
    .await?)
}

pub async fn resolve_recurring(db: &Db, ent: &Entity, id: i64, confirm: bool) -> Result<Recurring> {
    let mut tx = db.begin().await?;
    let get = |id| format!("SELECT {COLUMNS} FROM fin_recurring WHERE id = {id} AND entity_id = {}", ent.id);
    let before: Recurring = sqlx::query_as(&get(id)).fetch_optional(&mut *tx).await?.ok_or_else(|| not_found("recurring item"))?;
    let status = if confirm { "confirmed" } else { "dismissed" };
    sqlx::query("UPDATE fin_recurring SET status = ?, updated_at = ? WHERE id = ?").bind(status).bind(now()).bind(id).execute(&mut *tx).await?;
    let after: Recurring = sqlx::query_as(&get(id)).fetch_one(&mut *tx).await?;
    audit(&mut tx, ent, status, "recurring", Some(id), Some(&serde_json::json!({"status": before.status})), Some(&serde_json::json!({"status": status})))
        .await?;
    tx.commit().await?;
    Ok(after)
}

// ============== Planned items ==============

const PLANNED: &str = "id, date, description, amount_minor, ledger_account_id, account_id, created_at, updated_at";

pub async fn list_planned(db: &Db, ent: &Entity, from: Option<&str>, to: Option<&str>) -> Result<Vec<Planned>> {
    let mut conn = db.acquire().await?;
    let from = from.map(check_date).transpose()?;
    let to = to.map(check_date).transpose()?;
    list_planned_in(&mut conn, ent, from.as_deref(), to.as_deref()).await
}

pub(crate) async fn list_planned_in(conn: &mut Conn, ent: &Entity, from: Option<&str>, to: Option<&str>) -> Result<Vec<Planned>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {PLANNED} FROM fin_planned WHERE entity_id = ? AND (?2 IS NULL OR date >= ?2) AND (?3 IS NULL OR date <= ?3) \
         ORDER BY date, id"
    ))
    .bind(ent.id)
    .bind(from)
    .bind(to)
    .fetch_all(conn)
    .await?)
}

async fn get_planned_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Planned> {
    sqlx::query_as(&format!("SELECT {PLANNED} FROM fin_planned WHERE id = ? AND entity_id = ?"))
        .bind(id)
        .bind(ent.id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| not_found("planned item"))
}

async fn check_planned(conn: &mut Conn, ent: &Entity, input: &PlannedInput) -> Result<(String, String)> {
    let date = check_date(&input.date)?;
    let description = input.description.trim().to_string();
    if description.is_empty() {
        return Err(AppError::InvalidInput("a planned item needs a description".into()));
    }
    if let Some(id) = input.ledger_account_id {
        let la = get_ledger_account_in(conn, ent, id).await?;
        if la.class != "income" && la.class != "expense" {
            return Err(AppError::InvalidInput("a planned item's category is an income or expense account".into()));
        }
    }
    if let Some(id) = input.account_id {
        get_account_in(conn, ent, id).await?;
    }
    Ok((date, description))
}

pub async fn create_planned(db: &Db, ent: &Entity, input: PlannedInput) -> Result<Planned> {
    let mut tx = db.begin().await?;
    let (date, description) = check_planned(&mut tx, ent, &input).await?;
    let id = sqlx::query(
        "INSERT INTO fin_planned (entity_id, date, description, amount_minor, ledger_account_id, account_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(&date)
    .bind(&description)
    .bind(input.amount_minor)
    .bind(input.ledger_account_id)
    .bind(input.account_id)
    .bind(now())
    .bind(now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let p = get_planned_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "create", "planned", Some(id), None, Some(&serde_json::to_value(&p)?)).await?;
    tx.commit().await?;
    Ok(p)
}

pub async fn update_planned(db: &Db, ent: &Entity, id: i64, input: PlannedInput) -> Result<Planned> {
    let mut tx = db.begin().await?;
    let before = get_planned_in(&mut tx, ent, id).await?;
    let (date, description) = check_planned(&mut tx, ent, &input).await?;
    sqlx::query(
        "UPDATE fin_planned SET date = ?, description = ?, amount_minor = ?, ledger_account_id = ?, account_id = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(&date)
    .bind(&description)
    .bind(input.amount_minor)
    .bind(input.ledger_account_id)
    .bind(input.account_id)
    .bind(now())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let after = get_planned_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "update", "planned", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?)).await?;
    tx.commit().await?;
    Ok(after)
}

pub async fn delete_planned(db: &Db, ent: &Entity, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    let before = get_planned_in(&mut tx, ent, id).await?;
    sqlx::query("DELETE FROM fin_planned WHERE id = ?").bind(id).execute(&mut *tx).await?;
    audit(&mut tx, ent, "delete", "planned", Some(id), Some(&serde_json::to_value(&before)?), None).await?;
    tx.commit().await?;
    Ok(())
}
