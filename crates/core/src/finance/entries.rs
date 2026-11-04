//! Journal entries: manual journals, bank drafts, categorising, posting, deleting and
//! reversing (ADR 0010). Every entry balances: its lines' `functional_minor` sum to 0.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::{audit, check_date, currency, get_account_in, get_ledger_account_in, not_found, rates, require_open, system, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

pub const STATUSES: &[&str] = &["draft", "posted", "reversed"];

/// A journal entry with its lines, and its transfer pair if it has one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: i64,
    pub entity_id: i64,
    pub date: String,
    pub description: String,
    pub payee: Option<String>,
    pub status: String,
    pub source_line_id: Option<i64>,
    pub reverses_id: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub lines: Vec<Line>,
    pub pair: Option<PairRef>,
    /// Tied to a recognition schedule (its source, deferral or a release): its lines and date are
    /// fixed and it can't be deleted, so the screens hide those controls.
    pub scheduled: bool,
}

#[derive(Debug, Clone, FromRow)]
struct EntryRow {
    id: i64,
    entity_id: i64,
    date: String,
    description: String,
    payee: Option<String>,
    status: String,
    source_line_id: Option<i64>,
    reverses_id: Option<i64>,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
}

/// One line: positive `amount_minor` is a debit, negative a credit. `rate` is functional
/// units per unit of `currency`.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Line {
    pub id: i64,
    pub entry_id: i64,
    pub ledger_account_id: i64,
    pub amount_minor: i64,
    pub currency: String,
    pub functional_minor: i64,
    pub rate: f64,
    pub memo: Option<String>,
}

/// The entry's live pair (not rejected), seen from the entry.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PairRef {
    pub id: i64,
    pub kind: String,
    pub status: String,
    pub other_entry_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInput {
    pub ledger_account_id: i64,
    pub amount_minor: i64,
    pub currency: String,
    /// The functional amount when known (a bank's own converted amount); else translated
    /// at the ECB spot rate of the entry's date.
    pub functional_minor: Option<i64>,
    pub memo: Option<String>,
}

impl LineInput {
    pub fn new(ledger_account_id: i64, amount_minor: i64, currency: &str) -> Self {
        LineInput { ledger_account_id, amount_minor, currency: currency.into(), functional_minor: None, memo: None }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub date: String,
    pub description: String,
    pub payee: Option<String>,
    pub notes: Option<String>,
    pub lines: Vec<LineInput>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPatch {
    pub date: Option<String>,
    pub description: Option<String>,
    pub payee: Option<String>,
    pub notes: Option<String>,
    pub lines: Option<Vec<LineInput>>,
}

/// One category share of a bank entry, in the bank line's currency.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub ledger_account_id: i64,
    pub amount_minor: i64,
    pub memo: Option<String>,
}

/// A bank line to book as a draft: the account's ledger account against `counter`.
#[derive(Debug, Clone)]
pub struct BankDraft {
    pub account_id: i64,
    /// The booking (completed) date.
    pub date: String,
    pub description: String,
    pub payee: Option<String>,
    /// Signed as the bank shows it: negative is money out.
    pub amount_minor: i64,
    /// The bank's fee, positive, taken on top of the amount (a `bank_fees` line).
    pub fee_minor: i64,
    /// The ledger account on the other side (an `uncategorised_*` account, a category, or
    /// `transfers_clearing`).
    pub counter_ledger_account_id: i64,
    pub source_line_id: Option<i64>,
    /// The bank's own functional amount for `amount_minor`, which wins over the ECB rate.
    pub functional_minor: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryFilter {
    pub from: Option<String>,
    pub to: Option<String>,
    pub account_id: Option<i64>,
    pub ledger_account_id: Option<i64>,
    pub status: Option<String>,
    pub uncategorised: Option<bool>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryPage {
    pub entries: Vec<Entry>,
    pub total: i64,
}

/// A line ready to insert.
#[derive(Debug, Clone)]
struct NewLine {
    ledger_account_id: i64,
    amount_minor: i64,
    currency: String,
    functional_minor: i64,
    rate: f64,
    memo: Option<String>,
}

/// A known functional amount must carry the line's sign (zero for a zero line).
fn check_functional(functional_minor: i64, amount_minor: i64) -> Result<()> {
    if functional_minor.signum() == amount_minor.signum() {
        Ok(())
    } else {
        Err(AppError::InvalidInput("a functional amount has the sign of its line".into()))
    }
}

fn scheduled() -> AppError {
    AppError::InvalidInput("this entry has a recognition schedule: delete the schedule first".into())
}

fn unbalanced() -> AppError {
    AppError::InvalidInput("the entry doesn't balance".into())
}

fn trimmed(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ============== Reading ==============

pub async fn get_entry(db: &Db, ent: &Entity, id: i64) -> Result<Entry> {
    let mut conn = db.acquire().await?;
    get_entry_in(&mut conn, ent, id).await
}

/// One of the entity's entries; another entity's is not found.
pub async fn get_entry_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Entry> {
    let row: EntryRow = sqlx::query_as("SELECT * FROM fin_entries WHERE id = ? AND entity_id = ?")
        .bind(id)
        .bind(ent.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| not_found("entry"))?;
    assemble(conn, row).await
}

async fn assemble(conn: &mut Conn, r: EntryRow) -> Result<Entry> {
    let lines: Vec<Line> = sqlx::query_as("SELECT * FROM fin_lines WHERE entry_id = ? ORDER BY id")
        .bind(r.id)
        .fetch_all(&mut *conn)
        .await?;
    let pair: Option<PairRef> = sqlx::query_as(
        "SELECT id, kind, status, CASE WHEN entry_a = ?1 THEN entry_b ELSE entry_a END AS other_entry_id \
         FROM fin_pairs WHERE (entry_a = ?1 OR entry_b = ?1) AND entity_id = ?2 AND status != 'rejected' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(r.id)
    .bind(r.entity_id)
    .fetch_optional(&mut *conn)
    .await?;
    let scheduled = super::schedules::has_schedule(&mut *conn, r.id).await?;
    Ok(Entry {
        id: r.id,
        entity_id: r.entity_id,
        date: r.date,
        description: r.description,
        payee: r.payee,
        status: r.status,
        source_line_id: r.source_line_id,
        reverses_id: r.reverses_id,
        notes: r.notes,
        created_at: r.created_at,
        updated_at: r.updated_at,
        lines,
        pair,
        scheduled,
    })
}

/// The entity's entries, newest first, filtered.
pub async fn list_entries(db: &Db, ent: &Entity, filter: EntryFilter, limit: i64, offset: i64) -> Result<EntryPage> {
    let mut conn = db.acquire().await?;
    let mut sql = String::from(" FROM fin_entries e WHERE e.entity_id = ?");
    let mut binds: Vec<Bind> = vec![Bind::I(ent.id)];
    if let Some(from) = &filter.from {
        sql.push_str(" AND e.date >= ?");
        binds.push(Bind::S(check_date(from)?));
    }
    if let Some(to) = &filter.to {
        sql.push_str(" AND e.date <= ?");
        binds.push(Bind::S(check_date(to)?));
    }
    if let Some(account) = filter.account_id {
        let la = get_account_in(&mut conn, ent, account).await?.ledger_account_id;
        sql.push_str(" AND EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id = ?)");
        binds.push(Bind::I(la));
    }
    if let Some(la) = filter.ledger_account_id {
        get_ledger_account_in(&mut conn, ent, la).await?;
        sql.push_str(" AND EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id = ?)");
        binds.push(Bind::I(la));
    }
    if let Some(status) = &filter.status {
        if !STATUSES.contains(&status.as_str()) {
            return Err(AppError::InvalidInput(format!("'{status}' is not an entry status")));
        }
        sql.push_str(" AND e.status = ?");
        binds.push(Bind::S(status.clone()));
    }
    if filter.uncategorised == Some(true) {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM fin_lines l JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
              WHERE l.entry_id = e.id AND la.system_key IN ('uncategorised_expense', 'uncategorised_income'))",
        );
    }
    if let Some(q) = trimmed(filter.search.clone()) {
        sql.push_str(" AND (e.description LIKE ? ESCAPE '\\' OR COALESCE(e.payee, '') LIKE ? ESCAPE '\\' OR COALESCE(e.notes, '') LIKE ? ESCAPE '\\')");
        let pat = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        binds.extend([Bind::S(pat.clone()), Bind::S(pat.clone()), Bind::S(pat)]);
    }
    let count_sql = format!("SELECT COUNT(*){sql}");
    let mut count = sqlx::query_scalar::<_, i64>(&count_sql);
    for b in &binds {
        count = match b {
            Bind::I(i) => count.bind(*i),
            Bind::S(s) => count.bind(s.clone()),
        };
    }
    let total = count.fetch_one(&mut *conn).await?;
    let rows_sql = format!("SELECT e.*{sql} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?");
    let mut rows = sqlx::query_as::<_, EntryRow>(&rows_sql);
    for b in &binds {
        rows = match b {
            Bind::I(i) => rows.bind(*i),
            Bind::S(s) => rows.bind(s.clone()),
        };
    }
    let rows = rows.bind(limit.clamp(1, 1000)).bind(offset.max(0)).fetch_all(&mut *conn).await?;
    let mut entries = Vec::with_capacity(rows.len());
    for r in rows {
        entries.push(assemble(&mut conn, r).await?);
    }
    Ok(EntryPage { entries, total })
}

enum Bind {
    I(i64),
    S(String),
}

// ============== Building lines ==============

/// Check and translate lines: each account is the entity's and open, a monetary account's
/// lines are in its currency, and the lines balance in the functional currency. Rounding
/// left by translation (a minor unit per translated line at most) goes to the largest
/// translated line; anything more is refused, unless `fx_residual` (a manual journal) and the
/// lines mix currencies, when it posts to realised FX.
async fn prepare_lines(conn: &mut Conn, ent: &Entity, date: &str, inputs: Vec<LineInput>, fx_residual: bool) -> Result<Vec<NewLine>> {
    if inputs.len() < 2 {
        return Err(AppError::InvalidInput("an entry needs at least two lines".into()));
    }
    let mut lines = Vec::with_capacity(inputs.len());
    let mut translated = Vec::new();
    for input in inputs {
        let la = get_ledger_account_in(conn, ent, input.ledger_account_id).await?;
        if la.archived {
            return Err(AppError::InvalidInput("that ledger account is archived".into()));
        }
        let cur = currency::normalise(&input.currency)?;
        if la.currency.as_deref().is_some_and(|c| c != cur) {
            return Err(AppError::InvalidInput(format!("lines on '{}' must be in {}", la.name, la.currency.unwrap_or_default())));
        }
        let (functional_minor, rate) = match input.functional_minor {
            Some(f) if cur == ent.functional_currency && f != input.amount_minor => {
                return Err(AppError::InvalidInput("a line in the functional currency translates to itself".into()))
            }
            Some(f) => {
                check_functional(f, input.amount_minor)?;
                (f, if input.amount_minor == 0 { 1.0 } else { rate_of(f, input.amount_minor, &cur, &ent.functional_currency) })
            }
            None => {
                let t = rates::translate_in(conn, input.amount_minor, &cur, &ent.functional_currency, date).await?;
                if cur != ent.functional_currency {
                    translated.push(lines.len());
                }
                t
            }
        };
        lines.push(NewLine {
            ledger_account_id: la.id,
            amount_minor: input.amount_minor,
            currency: cur,
            functional_minor,
            rate,
            memo: trimmed(input.memo),
        });
    }
    let diff: i64 = lines.iter().map(|l| l.functional_minor).sum();
    let mixed = lines.iter().any(|l| l.currency != lines[0].currency);
    if diff != 0 && fx_residual && mixed && !translated.is_empty() && diff.unsigned_abs() > translated.len() as u64 {
        // A journal across currencies: each line is at its spot rate, and what's left is a
        // realised exchange difference (a surplus of debits is a gain).
        let key = if diff > 0 { system::FX_REALISED_GAIN } else { system::FX_REALISED_LOSS };
        let la = super::system_account_in(conn, ent, key).await?;
        lines.push(NewLine {
            ledger_account_id: la.id,
            amount_minor: -diff,
            currency: ent.functional_currency.clone(),
            functional_minor: -diff,
            rate: 1.0,
            memo: Some("Exchange difference".into()),
        });
        return Ok(lines);
    }
    if diff != 0 {
        if diff.unsigned_abs() > translated.len() as u64 {
            return Err(unbalanced());
        }
        let largest = translated.iter().copied().max_by_key(|&i| lines[i].functional_minor.abs()).ok_or_else(unbalanced)?;
        lines[largest].functional_minor -= diff;
    }
    Ok(lines)
}

/// The rate implied by a functional amount: functional units per unit of `cur`.
fn rate_of(functional_minor: i64, amount_minor: i64, cur: &str, functional: &str) -> f64 {
    let shift = currency::exponent(cur) as i32 - currency::exponent(functional) as i32;
    functional_minor as f64 / amount_minor as f64 * 10f64.powi(shift)
}

async fn insert_lines(conn: &mut Conn, entry_id: i64, lines: &[NewLine]) -> Result<()> {
    debug_assert_eq!(lines.iter().map(|l| l.functional_minor).sum::<i64>(), 0);
    for l in lines {
        sqlx::query(
            "INSERT INTO fin_lines (entry_id, ledger_account_id, amount_minor, currency, functional_minor, rate, memo) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(entry_id)
        .bind(l.ledger_account_id)
        .bind(l.amount_minor)
        .bind(&l.currency)
        .bind(l.functional_minor)
        .bind(l.rate)
        .bind(&l.memo)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

async fn replace_lines(conn: &mut Conn, entry_id: i64, lines: &[NewLine]) -> Result<()> {
    sqlx::query("DELETE FROM fin_lines WHERE entry_id = ?").bind(entry_id).execute(&mut *conn).await?;
    insert_lines(conn, entry_id, lines).await
}

struct Header<'a> {
    date: &'a str,
    description: String,
    payee: Option<String>,
    notes: Option<String>,
    status: &'a str,
    source_line_id: Option<i64>,
    reverses_id: Option<i64>,
}

async fn insert_entry(conn: &mut Conn, ent: &Entity, h: Header<'_>, lines: &[NewLine]) -> Result<Entry> {
    let now = super::now();
    let id = sqlx::query(
        "INSERT INTO fin_entries (entity_id, date, description, payee, status, source_line_id, reverses_id, notes, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(h.date)
    .bind(h.description.trim())
    .bind(trimmed(h.payee))
    .bind(h.status)
    .bind(h.source_line_id)
    .bind(h.reverses_id)
    .bind(trimmed(h.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    insert_lines(conn, id, lines).await?;
    let entry = get_entry_in(conn, ent, id).await?;
    audit(conn, ent, "create", "entry", Some(id), None, Some(&serde_json::to_value(&entry)?)).await?;
    Ok(entry)
}

async fn touch(conn: &mut Conn, id: i64) -> Result<()> {
    sqlx::query("UPDATE fin_entries SET updated_at = ? WHERE id = ?").bind(super::now()).bind(id).execute(conn).await?;
    Ok(())
}

// ============== Writing ==============

/// A manual journal, posted. It must balance.
pub async fn create_entry(db: &Db, ent: &Entity, input: EntryInput) -> Result<Entry> {
    let mut tx = db.begin().await?;
    let entry = create_entry_in(&mut tx, ent, input).await?;
    tx.commit().await?;
    Ok(entry)
}

pub async fn create_entry_in(conn: &mut Conn, ent: &Entity, input: EntryInput) -> Result<Entry> {
    let date = check_date(&input.date)?;
    require_open(conn, ent, &date).await?;
    let lines = prepare_lines(conn, ent, &date, input.lines, true).await?;
    let header = Header {
        date: &date,
        description: input.description,
        payee: input.payee,
        notes: input.notes,
        status: "posted",
        source_line_id: None,
        reverses_id: None,
    };
    insert_entry(conn, ent, header, &lines).await
}

/// A draft from a bank line: the bank account's ledger account moves by the amount less the
/// fee, the fee goes to `bank_fees`, and the counter account takes the amount.
pub async fn create_bank_draft(db: &Db, ent: &Entity, draft: BankDraft) -> Result<Entry> {
    let mut tx = db.begin().await?;
    let entry = create_bank_draft_in(&mut tx, ent, draft).await?;
    tx.commit().await?;
    Ok(entry)
}

pub async fn create_bank_draft_in(conn: &mut Conn, ent: &Entity, d: BankDraft) -> Result<Entry> {
    let date = check_date(&d.date)?;
    require_open(conn, ent, &date).await?;
    let account = super::accounts::get_account_bare_in(conn, ent, d.account_id).await?;
    let counter = get_ledger_account_in(conn, ent, d.counter_ledger_account_id).await?;
    if counter.archived || account.archived {
        return Err(AppError::InvalidInput("that account is archived".into()));
    }
    if counter.currency.as_deref().is_some_and(|c| c != account.currency) {
        return Err(AppError::InvalidInput(format!("lines on '{}' must be in {}", counter.name, counter.currency.unwrap_or_default())));
    }
    if let Some(sl) = d.source_line_id {
        let owner: Option<i64> = sqlx::query_scalar("SELECT account_id FROM fin_source_lines WHERE id = ? AND entity_id = ?")
            .bind(sl)
            .bind(ent.id)
            .fetch_optional(&mut *conn)
            .await?;
        if owner != Some(account.id) {
            return Err(not_found("source line"));
        }
    }
    if d.fee_minor < 0 {
        return Err(AppError::InvalidInput("a fee is positive".into()));
    }
    let cur = account.currency.clone();
    let fun = ent.functional_currency.clone();
    let (f_amount, rate) = match d.functional_minor {
        Some(f) if cur == fun && f != d.amount_minor => {
            return Err(AppError::InvalidInput("a line in the functional currency translates to itself".into()))
        }
        Some(f) => {
            check_functional(f, d.amount_minor)?;
            (f, if d.amount_minor == 0 { 1.0 } else { rate_of(f, d.amount_minor, &cur, &fun) })
        }
        None => rates::translate_in(conn, d.amount_minor, &cur, &fun, &date).await?,
    };
    let f_fee = if d.fee_minor == 0 { 0 } else { rates::convert(d.fee_minor, &cur, &fun, rate) };
    let line = |la: i64, amount: i64, functional: i64| NewLine {
        ledger_account_id: la,
        amount_minor: amount,
        currency: cur.clone(),
        functional_minor: functional,
        rate,
        memo: None,
    };
    let mut lines = vec![line(account.ledger_account_id, d.amount_minor - d.fee_minor, f_amount - f_fee)];
    if d.fee_minor != 0 {
        let fees = super::system_account_in(conn, ent, system::BANK_FEES).await?;
        lines.push(line(fees.id, d.fee_minor, f_fee));
    }
    lines.push(line(counter.id, -d.amount_minor, -f_amount));
    let header = Header {
        date: &date,
        description: d.description,
        payee: d.payee,
        notes: None,
        status: "draft",
        source_line_id: d.source_line_id,
        reverses_id: None,
    };
    insert_entry(conn, ent, header, &lines).await
}

/// A draft from a stored source line, against `counter`: [`create_bank_draft_in`] with the
/// line's own date, text, amount and fee.
pub async fn draft_from_source_line_in(
    conn: &mut Conn,
    ent: &Entity,
    source_line_id: i64,
    counter_ledger_account_id: i64,
    functional_minor: Option<i64>,
) -> Result<Entry> {
    type Src = (i64, String, String, Option<String>, i64, i64);
    let (account_id, booked_date, description, payee, amount_minor, fee_minor): Src = sqlx::query_as(
        "SELECT account_id, booked_date, description, payee, amount_minor, fee_minor FROM fin_source_lines \
         WHERE id = ? AND entity_id = ?",
    )
    .bind(source_line_id)
    .bind(ent.id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| not_found("source line"))?;
    let draft = BankDraft {
        account_id,
        date: booked_date,
        description,
        payee,
        amount_minor,
        fee_minor,
        counter_ledger_account_id,
        source_line_id: Some(source_line_id),
        functional_minor,
    };
    create_bank_draft_in(conn, ent, draft).await
}

/// Edit an entry in an open period. New lines must balance; a new date retranslates the
/// lines in other currencies at that date's rate.
pub async fn update_entry(db: &Db, ent: &Entity, id: i64, patch: EntryPatch) -> Result<Entry> {
    let mut tx = db.begin().await?;
    let before = get_entry_in(&mut tx, ent, id).await?;
    if before.status == "reversed" || before.reverses_id.is_some() {
        return Err(AppError::InvalidInput("a reversed entry or a reversal can't be edited".into()));
    }
    require_open(&mut tx, ent, &before.date).await?;
    if (patch.lines.is_some() || patch.date.is_some()) && super::schedules::has_schedule(&mut tx, id).await? {
        return Err(scheduled());
    }
    let date = patch.date.as_deref().map(check_date).transpose()?.unwrap_or(before.date.clone());
    require_open(&mut tx, ent, &date).await?;
    let lines = match patch.lines {
        Some(lines) => Some(lines),
        None if date != before.date && before.lines.iter().any(|l| l.currency != ent.functional_currency) => {
            Some(before.lines.iter().map(|l| LineInput { memo: l.memo.clone(), ..LineInput::new(l.ledger_account_id, l.amount_minor, &l.currency) }).collect())
        }
        None => None,
    };
    if let Some(lines) = lines {
        let lines = prepare_lines(&mut tx, ent, &date, lines, before.source_line_id.is_none()).await?;
        replace_lines(&mut tx, id, &lines).await?;
    }
    sqlx::query("UPDATE fin_entries SET date = ?, description = ?, payee = ?, notes = ? WHERE id = ?")
        .bind(&date)
        .bind(patch.description.as_deref().map(str::trim).unwrap_or(&before.description))
        .bind(match patch.payee { Some(p) => trimmed(Some(p)), None => before.payee.clone() })
        .bind(match patch.notes { Some(n) => trimmed(Some(n)), None => before.notes.clone() })
        .bind(id)
        .execute(&mut *tx)
        .await?;
    touch(&mut tx, id).await?;
    let after = get_entry_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "update", "entry", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?)).await?;
    tx.commit().await?;
    Ok(after)
}

/// Replace the non-bank side of a bank entry with category splits. The bank side is the
/// lines on the entity's financial accounts, and the fee line of its source line. The
/// splits are in the bank line's currency and add up to the bank side's amount (signed as
/// the bank line, or as debits that offset it).
pub async fn categorise(db: &Db, ent: &Entity, id: i64, splits: Vec<Split>) -> Result<Entry> {
    let mut tx = db.begin().await?;
    let entry = categorise_in(&mut tx, ent, id, splits).await?;
    tx.commit().await?;
    Ok(entry)
}

pub async fn categorise_in(conn: &mut Conn, ent: &Entity, id: i64, splits: Vec<Split>) -> Result<Entry> {
    let before = get_entry_in(conn, ent, id).await?;
    if before.status == "reversed" || before.reverses_id.is_some() {
        return Err(AppError::InvalidInput("a reversed entry or a reversal can't be edited".into()));
    }
    require_open(conn, ent, &before.date).await?;
    if super::schedules::has_schedule(conn, id).await? {
        return Err(scheduled());
    }
    if splits.is_empty() {
        return Err(AppError::InvalidInput("give at least one category".into()));
    }
    let bank_accounts: Vec<i64> = sqlx::query_scalar("SELECT ledger_account_id FROM fin_accounts WHERE entity_id = ?")
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?;
    let fee: i64 = match before.source_line_id {
        Some(sl) => sqlx::query_scalar("SELECT fee_minor FROM fin_source_lines WHERE id = ? AND entity_id = ?")
            .bind(sl)
            .bind(ent.id)
            .fetch_one(&mut *conn)
            .await?,
        None => 0,
    };
    let fees_account = super::system_account_in(conn, ent, system::BANK_FEES).await?.id;
    let mut fee_kept = fee == 0;
    let mut kept: Vec<&Line> = Vec::new();
    for l in &before.lines {
        if bank_accounts.contains(&l.ledger_account_id) {
            kept.push(l);
        } else if !fee_kept && l.ledger_account_id == fees_account && l.amount_minor == fee {
            fee_kept = true;
            kept.push(l);
        }
    }
    let Some(bank) = kept.iter().find(|l| bank_accounts.contains(&l.ledger_account_id)).copied() else {
        return Err(AppError::InvalidInput("not a bank entry".into()));
    };
    if kept.iter().any(|l| l.currency != bank.currency) {
        return Err(AppError::InvalidInput("the bank side mixes currencies".into()));
    }
    let target_amount: i64 = -kept.iter().map(|l| l.amount_minor).sum::<i64>();
    let target_functional: i64 = -kept.iter().map(|l| l.functional_minor).sum::<i64>();
    // Splits may come in the bank line's sign (they add up to it) or as debits (they
    // offset it).
    let mut splits = splits;
    let given: i64 = splits.iter().map(|s| s.amount_minor).sum();
    if given == -target_amount && given != 0 {
        splits.iter_mut().for_each(|s| s.amount_minor = -s.amount_minor);
    } else if given != target_amount {
        return Err(AppError::InvalidInput("the splits must add up to the bank line".into()));
    }
    // Share the functional amount by the splits' amounts; the last takes the remainder.
    let mut lines: Vec<NewLine> = kept
        .iter()
        .map(|l| NewLine {
            ledger_account_id: l.ledger_account_id,
            amount_minor: l.amount_minor,
            currency: l.currency.clone(),
            functional_minor: l.functional_minor,
            rate: l.rate,
            memo: l.memo.clone(),
        })
        .collect();
    let mut left = target_functional;
    let n = splits.len();
    for (i, s) in splits.into_iter().enumerate() {
        let la = get_ledger_account_in(conn, ent, s.ledger_account_id).await?;
        if la.archived {
            return Err(AppError::InvalidInput("that ledger account is archived".into()));
        }
        if la.currency.as_deref().is_some_and(|c| c != bank.currency) {
            return Err(AppError::InvalidInput(format!("lines on '{}' must be in {}", la.name, la.currency.unwrap_or_default())));
        }
        let functional = if i + 1 == n {
            left
        } else if target_amount == 0 {
            0
        } else {
            (target_functional as i128 * s.amount_minor as i128 / target_amount as i128) as i64
        };
        left -= functional;
        lines.push(NewLine {
            ledger_account_id: la.id,
            amount_minor: s.amount_minor,
            currency: bank.currency.clone(),
            functional_minor: functional,
            rate: bank.rate,
            memo: trimmed(s.memo),
        });
    }
    replace_lines(conn, id, &lines).await?;
    touch(conn, id).await?;
    let after = get_entry_in(conn, ent, id).await?;
    audit(conn, ent, "categorise", "entry", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?)).await?;
    Ok(after)
}

/// Post drafts. Entries already posted are left as they are. Returns how many were posted.
pub async fn post_entries(db: &Db, ent: &Entity, ids: &[i64]) -> Result<usize> {
    let mut tx = db.begin().await?;
    let n = post_entries_in(&mut tx, ent, ids).await?;
    tx.commit().await?;
    Ok(n)
}

pub async fn post_entries_in(conn: &mut Conn, ent: &Entity, ids: &[i64]) -> Result<usize> {
    let mut posted = 0;
    for &id in ids {
        let before = get_entry_in(conn, ent, id).await?;
        if before.status != "draft" {
            continue;
        }
        require_open(conn, ent, &before.date).await?;
        sqlx::query("UPDATE fin_entries SET status = 'posted', updated_at = ? WHERE id = ?")
            .bind(super::now())
            .bind(id)
            .execute(&mut *conn)
            .await?;
        audit(conn, ent, "post", "entry", Some(id), Some(&serde_json::json!({"status": "draft"})), Some(&serde_json::json!({"status": "posted"})))
            .await?;
        posted += 1;
    }
    Ok(posted)
}

/// Delete a draft, or a posted entry in an open period. Its source line stays, marked
/// dismissed, so a re-import doesn't bring it back. Deleting a reversal restores the
/// entry it reversed.
pub async fn delete_entry(db: &Db, ent: &Entity, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    let before = get_entry_in(&mut tx, ent, id).await?;
    if before.status == "reversed" {
        return Err(AppError::InvalidInput("delete its reversal first".into()));
    }
    if super::schedules::has_schedule(&mut tx, id).await? {
        return Err(scheduled());
    }
    require_open(&mut tx, ent, &before.date).await?;
    if let Some(original) = before.reverses_id {
        let o = get_entry_in(&mut tx, ent, original).await?;
        require_open(&mut tx, ent, &o.date).await?;
        sqlx::query("UPDATE fin_entries SET status = 'posted', updated_at = ? WHERE id = ?")
            .bind(super::now())
            .bind(original)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(sl) = before.source_line_id {
        sqlx::query("UPDATE fin_source_lines SET dismissed_at = ? WHERE id = ?").bind(super::now()).bind(sl).execute(&mut *tx).await?;
    }
    // Its pairs go with it (the cascade); the audit log records each.
    let pairs: Vec<(i64, String, i64, i64, String)> = sqlx::query_as(
        "SELECT id, kind, entry_a, entry_b, status FROM fin_pairs WHERE entity_id = ?1 AND (entry_a = ?2 OR entry_b = ?2)",
    )
    .bind(ent.id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for (pair, kind, a, b, status) in pairs {
        let before = serde_json::json!({ "kind": kind, "entry_a": a, "entry_b": b, "status": status });
        audit(&mut tx, ent, "delete", "pair", Some(pair), Some(&before), None).await?;
    }
    sqlx::query("DELETE FROM fin_entries WHERE id = ?").bind(id).execute(&mut *tx).await?;
    audit(&mut tx, ent, "delete", "entry", Some(id), Some(&serde_json::to_value(&before)?), None).await?;
    tx.commit().await?;
    Ok(())
}

/// Reverse a posted entry with a dated entry of opposite lines; the original is marked
/// reversed. This is how a closed period is corrected. Reversing an entry that carries a
/// recognition schedule reverses its deferral and posted releases on the same date, and
/// ends the schedule.
pub async fn reverse_entry(db: &Db, ent: &Entity, id: i64, date: &str) -> Result<Entry> {
    let mut tx = db.begin().await?;
    let date = check_date(date)?;
    let schedule = super::schedules::schedule_entries(&mut tx, id).await?;
    if schedule.is_none() && super::schedules::has_schedule(&mut tx, id).await? {
        return Err(scheduled());
    }
    let reversal = reverse_in(&mut tx, ent, id, &date).await?;
    if let Some((schedule_id, entries)) = schedule {
        for e in entries {
            reverse_in(&mut tx, ent, e, &date).await?;
        }
        sqlx::query("DELETE FROM fin_schedules WHERE id = ?").bind(schedule_id).execute(&mut *tx).await?;
        audit(&mut tx, ent, "end", "schedule", Some(schedule_id), None, Some(&serde_json::json!({ "reversal_id": reversal.id }))).await?;
    }
    tx.commit().await?;
    Ok(reversal)
}

async fn reverse_in(conn: &mut Conn, ent: &Entity, id: i64, date: &str) -> Result<Entry> {
    let original = get_entry_in(conn, ent, id).await?;
    match original.status.as_str() {
        "posted" => {}
        "draft" => return Err(AppError::InvalidInput("a draft isn't in the books: delete it instead".into())),
        _ => return Err(AppError::InvalidInput("this entry is already reversed".into())),
    }
    if original.reverses_id.is_some() {
        return Err(AppError::InvalidInput("a reversal can't be reversed: delete it instead".into()));
    }
    require_open(conn, ent, date).await?;
    let lines: Vec<NewLine> = original
        .lines
        .iter()
        .map(|l| NewLine {
            ledger_account_id: l.ledger_account_id,
            amount_minor: -l.amount_minor,
            currency: l.currency.clone(),
            functional_minor: -l.functional_minor,
            rate: l.rate,
            memo: l.memo.clone(),
        })
        .collect();
    let header = Header {
        date,
        description: format!("Reversal: {}", original.description),
        payee: original.payee.clone(),
        notes: None,
        status: "posted",
        source_line_id: None,
        reverses_id: Some(id),
    };
    let reversal = insert_entry(conn, ent, header, &lines).await?;
    sqlx::query("UPDATE fin_entries SET status = 'reversed', updated_at = ? WHERE id = ?")
        .bind(super::now())
        .bind(id)
        .execute(&mut *conn)
        .await?;
    audit(conn, ent, "reverse", "entry", Some(id), Some(&serde_json::json!({"status": "posted"})), Some(&serde_json::json!({"status": "reversed", "reversal_id": reversal.id})))
        .await?;
    Ok(reversal)
}

/// A line of an entry the app posts itself (a retranslation, a deferral, a release), with its
/// functional amount given.
#[derive(Debug, Clone)]
pub(crate) struct SysLine {
    pub ledger_account_id: i64,
    pub amount_minor: i64,
    pub currency: String,
    pub functional_minor: i64,
    pub memo: Option<String>,
}

impl SysLine {
    /// A line in the functional currency.
    pub(crate) fn functional(ent: &Entity, ledger_account_id: i64, amount_minor: i64, memo: Option<&str>) -> Self {
        SysLine {
            ledger_account_id,
            amount_minor,
            currency: ent.functional_currency.clone(),
            functional_minor: amount_minor,
            memo: memo.map(str::to_string),
        }
    }
}

/// Post an entry the app writes itself. The caller has checked the period and the lines,
/// which must balance in the functional currency.
pub(crate) async fn post_system_entry_in(conn: &mut Conn, ent: &Entity, date: &str, description: String, lines: Vec<SysLine>) -> Result<Entry> {
    if lines.iter().map(|l| l.functional_minor).sum::<i64>() != 0 {
        return Err(unbalanced());
    }
    let lines: Vec<NewLine> = lines
        .into_iter()
        .map(|l| NewLine {
            rate: if l.amount_minor == 0 { 0.0 } else { rate_of(l.functional_minor, l.amount_minor, &l.currency, &ent.functional_currency) },
            ledger_account_id: l.ledger_account_id,
            amount_minor: l.amount_minor,
            currency: l.currency,
            functional_minor: l.functional_minor,
            memo: l.memo,
        })
        .collect();
    let header = Header { date, description, payee: None, notes: None, status: "posted", source_line_id: None, reverses_id: None };
    insert_entry(conn, ent, header, &lines).await
}

/// Retranslate every draft into the entity's (new) functional currency.
pub(crate) async fn retranslate_drafts(conn: &mut Conn, ent: &Entity) -> Result<()> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM fin_entries WHERE entity_id = ? AND status = 'draft'")
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?;
    for id in ids {
        let e = get_entry_in(conn, ent, id).await?;
        let inputs = e.lines.iter().map(|l| LineInput { memo: l.memo.clone(), ..LineInput::new(l.ledger_account_id, l.amount_minor, &l.currency) }).collect();
        let lines = prepare_lines(conn, ent, &e.date, inputs, false).await?;
        replace_lines(conn, id, &lines).await?;
        let after = get_entry_in(conn, ent, id).await?;
        audit(conn, ent, "retranslate", "entry", Some(id), Some(&serde_json::to_value(&e)?), Some(&serde_json::to_value(&after)?)).await?;
    }
    Ok(())
}
