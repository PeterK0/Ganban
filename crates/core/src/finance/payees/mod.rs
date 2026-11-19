//! Payees (`docs/design/FINANCE.md` § Payees): who a bank line was paid to or came from, as a
//! row with a name, a default category and the spellings (aliases) it goes by.
//!
//! A raw payee or description resolves through its certain key ([`keys::certain_key`]) to an
//! alias, and the alias to its payee; an unknown key makes a new payee. Merging moves the
//! aliases and lines of one payee to another and remembers where each alias came from, so a
//! split can undo it. The raw text stays on the source line as the bank wrote it.
//!
//! A payee's default category files its lines on import, and is set the first time the user
//! categorises one of its lines, unless the payee asks every time.

pub mod keys;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::inbox::{post_ids_in, PostOutcome};
use super::pairing::{bank_view, is_paired, recounter, skippable, sys, Sys};
use super::{audit, get_entry_in, get_ledger_account_in, not_found, now, Conn, Entity, Entry, Split};
use crate::error::{AppError, Result};
use crate::Db;

pub use keys::{certain_key, display_name, loose_key, similar};

/// Entries filed per transaction when a payee's default files its other lines.
const BATCH: usize = 200;

// ============== Resolving ==============

/// The text a payee is read from: the bank's payee, else the description.
pub fn raw_of<'a>(description: &'a str, payee: Option<&'a str>) -> &'a str {
    payee.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(description)
}

/// The payee of a raw text, made with its alias when the key is new. `None` when the text
/// has no letters or digits.
pub(crate) async fn resolve_in(conn: &mut Conn, ent: &Entity, raw: &str) -> Result<Option<(i64, String)>> {
    let key = certain_key(raw);
    if key.is_empty() {
        return Ok(None);
    }
    let known: Option<i64> =
        sqlx::query_scalar("SELECT payee_id FROM fin_payee_aliases WHERE entity_id = ? AND key = ?")
            .bind(ent.id)
            .bind(&key)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(id) = known {
        return Ok(Some((id, key)));
    }
    let id = sqlx::query("INSERT INTO fin_payees (entity_id, name, created_at) VALUES (?, ?, ?)")
        .bind(ent.id)
        .bind(display_name(raw).chars().take(200).collect::<String>())
        .bind(now())
        .execute(&mut *conn)
        .await?
        .last_insert_rowid();
    sqlx::query("INSERT INTO fin_payee_aliases (entity_id, key, payee_id, sample, loose_key) VALUES (?, ?, ?, ?, ?)")
        .bind(ent.id)
        .bind(&key)
        .bind(id)
        .bind(raw.trim().chars().take(200).collect::<String>())
        .bind(loose_key(raw))
        .execute(&mut *conn)
        .await?;
    Ok(Some((id, key)))
}

/// Gives an entry from a bank line its payee, read from the line's payee or description. An
/// exchange leg and a transfer between the user's own accounts have none. Entries that have been looked at keep a `payee_key` (empty when
/// there's no payee), so this runs once per entry. Returns the payee.
pub(crate) async fn attach_in(conn: &mut Conn, ent: &Entity, entry_id: i64) -> Result<Option<i64>> {
    type Row = (Option<i64>, Option<String>, Option<i64>, Option<String>, Option<String>, String);
    let row: Option<Row> = sqlx::query_as(
        "SELECT e.payee_id, e.payee_key, e.source_line_id, s.kind_hint, COALESCE(s.payee, e.payee), \
                COALESCE(s.description, e.description) \
         FROM fin_entries e LEFT JOIN fin_source_lines s ON s.id = e.source_line_id \
         WHERE e.id = ? AND e.entity_id = ?",
    )
    .bind(entry_id)
    .bind(ent.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((payee_id, payee_key, source_line, kind, payee, description)) = row else { return Ok(None) };
    if payee_id.is_some() || payee_key.is_some() {
        return Ok(payee_id);
    }
    // A move between the user's own accounts has no payee.
    let own_move: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM fin_pairs WHERE (entry_a = ?1 OR entry_b = ?1) AND entity_id = ?2 \
         AND status IN ('auto', 'confirmed'))",
    )
    .bind(entry_id)
    .bind(ent.id)
    .fetch_one(&mut *conn)
    .await?;
    let resolved = if own_move || kind.as_deref() == Some("exchange") || (source_line.is_none() && payee.is_none()) {
        None
    } else {
        resolve_in(conn, ent, raw_of(&description, payee.as_deref())).await?
    };
    let (id, key) = match &resolved {
        Some((id, key)) => (Some(*id), key.as_str()),
        None => (None, ""),
    };
    sqlx::query("UPDATE fin_entries SET payee_id = ?, payee_key = ?, group_key = NULL WHERE id = ?")
        .bind(id)
        .bind(key)
        .bind(entry_id)
        .execute(&mut *conn)
        .await?;
    if let Some(sl) = source_line {
        sqlx::query("UPDATE fin_source_lines SET payee_id = ? WHERE id = ?")
            .bind(id)
            .bind(sl)
            .execute(&mut *conn)
            .await?;
    }
    Ok(id)
}

// ============== Reading ==============

#[derive(Debug, Clone, Serialize)]
pub struct Alias {
    /// The certain key every spelling of this alias shares.
    pub key: String,
    /// The first spelling seen, as the bank wrote it.
    pub sample: String,
    /// The payee this alias belonged to before a merge; a split gives it back.
    pub origin_payee_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Payee {
    pub id: i64,
    pub name: String,
    pub default_ledger_account_id: Option<i64>,
    pub ask_every_time: bool,
    pub aliases: Vec<Alias>,
    /// Entries (not reversed) from this payee.
    pub lines: i64,
    /// Their bank lines' total in the functional currency (money out is negative).
    pub total_minor: i64,
    pub last_date: Option<String>,
    /// Lines posted as unsorted history, and their total.
    pub unsorted: i64,
    pub unsorted_total_minor: i64,
    /// A default that is a move to one of the user's own accounts instead of a category.
    pub default_account_id: Option<i64>,
    /// The date of its latest unsorted line.
    pub unsorted_last_date: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PayeeFilter {
    /// Matches the name or any spelling.
    pub search: Option<String>,
    /// Only payees with unsorted history, largest first.
    pub unsorted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayeePage {
    pub payees: Vec<Payee>,
    pub total: i64,
}

type PayeeRow = (i64, String, Option<i64>, bool, i64, i64, Option<String>, i64, i64, Option<i64>, Option<String>);

fn payee_select(ent: i64) -> String {
    format!(
        "SELECT p.id, p.name, p.default_ledger_account_id, p.ask_every_time, \
           (SELECT COUNT(*) FROM fin_entries e WHERE e.payee_id = p.id AND e.status != 'reversed') AS lines, \
           (SELECT COALESCE(SUM(l.functional_minor), 0) FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id \
              WHERE e.payee_id = p.id AND e.status != 'reversed' \
                AND l.ledger_account_id IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = {ent})) AS total, \
           (SELECT MAX(e.date) FROM fin_entries e WHERE e.payee_id = p.id AND e.status != 'reversed'), \
           (SELECT COUNT(*) FROM fin_entries e WHERE e.payee_id = p.id AND e.unsorted = 1) AS unsorted, \
           (SELECT COALESCE(SUM(l.functional_minor), 0) FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id \
              WHERE e.payee_id = p.id AND e.unsorted = 1 \
                AND l.ledger_account_id IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = {ent})) AS unsorted_total, \
           p.default_account_id, \
           (SELECT MAX(e.date) FROM fin_entries e WHERE e.payee_id = p.id AND e.unsorted = 1) AS unsorted_last \
         FROM fin_payees p"
    )
}

async fn with_aliases(conn: &mut Conn, ent: &Entity, rows: Vec<PayeeRow>) -> Result<Vec<Payee>> {
    let mut aliases: HashMap<i64, Vec<Alias>> = HashMap::new();
    for chunk in rows.chunks(400) {
        let ids = chunk.iter().map(|r| r.0.to_string()).collect::<Vec<_>>().join(",");
        let found: Vec<(i64, String, String, Option<i64>)> = sqlx::query_as(&format!(
            "SELECT payee_id, key, sample, origin_payee_id FROM fin_payee_aliases \
             WHERE entity_id = ? AND payee_id IN ({ids}) ORDER BY key"
        ))
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?;
        for (p, key, sample, origin_payee_id) in found {
            aliases.entry(p).or_default().push(Alias { key, sample, origin_payee_id });
        }
    }
    Ok(rows
        .into_iter()
        .map(|r| Payee {
            id: r.0,
            name: r.1,
            default_ledger_account_id: r.2,
            ask_every_time: r.3,
            aliases: aliases.remove(&r.0).unwrap_or_default(),
            lines: r.4,
            total_minor: r.5,
            last_date: r.6,
            unsorted: r.7,
            unsorted_total_minor: r.8,
            default_account_id: r.9,
            unsorted_last_date: r.10,
        })
        .collect())
}

/// `fin_list_payees`: the entity's payees (not merged away), the most lines first, or with
/// `unsorted` the ones with unsorted history, the largest total first.
pub async fn list_payees(db: &Db, ent: &Entity, filter: PayeeFilter, limit: i64, offset: i64) -> Result<PayeePage> {
    let mut conn = db.acquire().await?;
    let mut cond = String::from(" WHERE p.entity_id = ? AND p.merged_into IS NULL");
    let pat = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|q| format!("%{}%", q.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    if pat.is_some() {
        cond.push_str(
            " AND (LOWER(p.name) LIKE ?2 ESCAPE '\\' OR EXISTS (SELECT 1 FROM fin_payee_aliases a \
               WHERE a.payee_id = p.id AND (LOWER(a.sample) LIKE ?2 ESCAPE '\\' OR a.key LIKE ?2 ESCAPE '\\')))",
        );
    }
    if filter.unsorted {
        cond.push_str(" AND EXISTS (SELECT 1 FROM fin_entries e WHERE e.payee_id = p.id AND e.unsorted = 1)");
    }
    let cond = cond.replace("p.entity_id = ?", "p.entity_id = ?1");
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM fin_payees p{cond}"))
        .bind(ent.id)
        .bind(pat.clone())
        .fetch_one(&mut *conn)
        .await?;
    let order = if filter.unsorted { "ABS(unsorted_total) DESC, unsorted DESC" } else { "lines DESC, ABS(total) DESC" };
    let rows: Vec<PayeeRow> =
        sqlx::query_as(&format!("{}{cond} ORDER BY {order}, p.name, p.id LIMIT ?3 OFFSET ?4", payee_select(ent.id)))
            .bind(ent.id)
            .bind(pat)
            .bind(limit.clamp(1, 500))
            .bind(offset.max(0))
            .fetch_all(&mut *conn)
            .await?;
    let mut payees = with_aliases(&mut conn, ent, rows).await?;
    // Listing unsorted history, "last" is the last unsorted line, never one of the recent lines
    // the heading leaves out.
    if filter.unsorted {
        for p in &mut payees {
            p.last_date = p.unsorted_last_date.clone();
        }
    }
    Ok(PayeePage { payees, total })
}

async fn get_payee_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Payee> {
    let row: PayeeRow = sqlx::query_as(&format!("{} WHERE p.id = ? AND p.entity_id = ?", payee_select(ent.id)))
        .bind(id)
        .bind(ent.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| not_found("payee"))?;
    Ok(with_aliases(conn, ent, vec![row]).await?.remove(0))
}

pub async fn get_payee(db: &Db, ent: &Entity, id: i64) -> Result<Payee> {
    let mut conn = db.acquire().await?;
    get_payee_in(&mut conn, ent, id).await
}

/// A payee that is the entity's own and hasn't been merged into another.
async fn live_payee(conn: &mut Conn, ent: &Entity, id: i64) -> Result<(Option<i64>, bool)> {
    let row: Option<(Option<i64>, bool, Option<i64>)> = sqlx::query_as(
        "SELECT default_ledger_account_id, ask_every_time, merged_into FROM fin_payees WHERE id = ? AND entity_id = ?",
    )
    .bind(id)
    .bind(ent.id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some((d, ask, None)) => Ok((d, ask)),
        Some(_) => Err(AppError::InvalidInput("that payee was merged into another".into())),
        None => Err(not_found("payee")),
    }
}

// ============== Defaults and filing ==============

/// A category a payee can default to: an open income or expense account that isn't a system
/// account (bank fees aside).
async fn check_category(conn: &mut Conn, ent: &Entity, la: i64) -> Result<()> {
    let a = get_ledger_account_in(conn, ent, la).await?;
    let system_ok = a.system_key.as_deref().is_none_or(|k| k == super::system::BANK_FEES);
    if a.archived || !matches!(a.class.as_str(), "income" | "expense") || a.currency.is_some() || !system_ok {
        return Err(AppError::InvalidInput("pick an income or expense category".into()));
    }
    Ok(())
}

/// The SQL test (alias `e`) for an entry whose whole counter side is uncategorised, beside
/// the bank's fee.
pub(crate) fn uncategorised_sql(s: &Sys, ent: &Entity) -> String {
    format!(
        "EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id IN ({ue}, {ui})) \
         AND NOT EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id \
           AND l.ledger_account_id NOT IN ({ue}, {ui}, {fees}) \
           AND l.ledger_account_id NOT IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = {ent}))",
        ue = s.unc_expense,
        ui = s.unc_income,
        fees = s.fees,
        ent = ent.id
    )
}

const LIVE_PAIR: &str =
    "EXISTS (SELECT 1 FROM fin_pairs p WHERE (p.entry_a = e.id OR p.entry_b = e.id) AND p.status != 'rejected')";

/// Files one entry under a category: its counter side goes to `la`, it leaves unsorted
/// history, and a draft posts (one waiting in a pair to review aside). Returns false when the
/// entry can't take it (a closed month, a line that changed).
pub(crate) async fn file_in(conn: &mut Conn, ent: &Entity, s: &Sys, id: i64, la: i64) -> Result<bool> {
    let v = match bank_view(conn, ent, s, id).await {
        Ok(v) => v,
        Err(e) if skippable(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    if !v.is_uncategorised(s) {
        return Ok(false);
    }
    match recounter(conn, ent, &v, la).await {
        Ok(()) => {}
        Err(e) if skippable(&e) => return Ok(false),
        Err(e) => return Err(e),
    }
    sqlx::query("UPDATE fin_entries SET unsorted = 0 WHERE id = ?").bind(id).execute(&mut *conn).await?;
    post_ids_in(conn, ent, &[id], None, &mut PostOutcome::default()).await?;
    Ok(true)
}

/// What setting a payee's default did: the lines it filed, so Undo can put them back.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DefaultChange {
    pub payee_id: i64,
    pub name: String,
    pub ledger_account_id: Option<i64>,
    pub previous_ledger_account_id: Option<i64>,
    /// A default that moves the lines to one of the user's own accounts.
    pub account_id: Option<i64>,
    pub previous_account_id: Option<i64>,
    /// Drafts filed and posted with the new default (they were in the inbox).
    pub filed_drafts: Vec<i64>,
    /// Unsorted history filed with it.
    pub filed_history: Vec<i64>,
}

/// The payee's lines a new default files: uncategorised drafts that aren't transfer legs, and
/// its unsorted history.
async fn lines_to_file(conn: &mut Conn, ent: &Entity, s: &Sys, payee: i64) -> Result<(Vec<i64>, Vec<i64>)> {
    let unc = uncategorised_sql(s, ent);
    let drafts: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT e.id FROM fin_entries e WHERE e.entity_id = ? AND e.payee_id = ? AND e.status = 'draft' \
         AND {unc} AND NOT {LIVE_PAIR} ORDER BY e.date, e.id"
    ))
    .bind(ent.id)
    .bind(payee)
    .fetch_all(&mut *conn)
    .await?;
    let history: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT e.id FROM fin_entries e WHERE e.entity_id = ? AND e.payee_id = ? AND e.unsorted = 1 AND {unc} \
         ORDER BY e.date, e.id"
    ))
    .bind(ent.id)
    .bind(payee)
    .fetch_all(&mut *conn)
    .await?;
    Ok((drafts, history))
}

/// Sets (or clears) a payee's default category. With `file`, the payee's uncategorised drafts
/// and unsorted history are filed under it, in short transactions.
pub async fn set_default(db: &Db, ent: &Entity, id: i64, la: Option<i64>, file: bool) -> Result<DefaultChange> {
    set_default_to(db, ent, id, la, None, file).await
}

/// The payee's default move, if its default is one: an account of the user's.
async fn default_account(conn: &mut Conn, id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT default_account_id FROM fin_payees WHERE id = ?").bind(id).fetch_one(conn).await?)
}

/// Sets a payee's default: a category (`la`), a move to one of the user's accounts
/// (`account`), or neither (cleared). With `file`, its waiting lines are filed by it.
pub async fn set_default_to(
    db: &Db,
    ent: &Entity,
    id: i64,
    la: Option<i64>,
    account: Option<i64>,
    file: bool,
) -> Result<DefaultChange> {
    if la.is_some() && account.is_some() {
        return Err(AppError::InvalidInput("a default is a category or an account, not both".into()));
    }
    let mut tx = crate::db::begin_write(db).await?;
    let (previous, _) = live_payee(&mut tx, ent, id).await?;
    let previous_account = default_account(&mut tx, id).await?;
    if let Some(la) = la {
        check_category(&mut tx, ent, la).await?;
    }
    if let Some(a) = account {
        if super::get_account_in(&mut tx, ent, a).await?.archived {
            return Err(AppError::InvalidInput("that account is archived".into()));
        }
    }
    sqlx::query("UPDATE fin_payees SET default_ledger_account_id = ?, default_account_id = ? WHERE id = ?")
        .bind(la)
        .bind(account)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        ent,
        "update",
        "payee",
        Some(id),
        Some(&serde_json::json!({ "default_ledger_account_id": previous, "default_account_id": previous_account })),
        Some(&serde_json::json!({ "default_ledger_account_id": la, "default_account_id": account })),
    )
    .await?;
    let name: String =
        sqlx::query_scalar("SELECT name FROM fin_payees WHERE id = ?").bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let mut out = DefaultChange {
        payee_id: id,
        name,
        ledger_account_id: la,
        previous_ledger_account_id: previous,
        account_id: account,
        previous_account_id: previous_account,
        ..Default::default()
    };
    let target = match (la, account) {
        (Some(la), _) => Some(Target::Category(la)),
        (_, Some(a)) => Some(Target::Account(a)),
        _ => None,
    };
    if let (Some(target), true) = (target, file) {
        file_payee(db, ent, id, target, &mut out).await?;
    }
    Ok(out)
}

/// What a payee's default files its lines by.
#[derive(Debug, Clone, Copy)]
enum Target {
    Category(i64),
    Account(i64),
}

async fn file_target_in(conn: &mut Conn, ent: &Entity, s: &Sys, id: i64, target: Target) -> Result<bool> {
    match target {
        Target::Category(la) => file_in(conn, ent, s, id, la).await,
        Target::Account(a) => move_in(conn, ent, s, id, a).await,
    }
}

/// Books a line as a move to one of the user's own accounts: its other side is written on
/// that account and the two pair as a transfer (an FX estimate in another currency), posted.
/// A line filed under a category first goes back to uncategorised. False when it can't (a
/// transfer leg already, its own account, a closed month).
pub(crate) async fn move_in(conn: &mut Conn, ent: &Entity, s: &Sys, id: i64, account: i64) -> Result<bool> {
    if is_paired(conn, id).await? {
        return Ok(false);
    }
    let v = match bank_view(conn, ent, s, id).await {
        Ok(v) => v,
        Err(e) if skippable(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    if v.account_id == account {
        return Ok(false);
    }
    if !v.is_uncategorised(s) {
        match recounter(conn, ent, &v, s.uncategorised_for(v.amount_minor)).await {
            Ok(()) => {}
            Err(e) if skippable(&e) => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    match super::pairing::write_counterpart(conn, ent, s, id, account).await {
        Ok(true) => {}
        Ok(false) => return Ok(false),
        Err(e) if skippable(&e) => return Ok(false),
        Err(e) => return Err(e),
    }
    sqlx::query("UPDATE fin_entries SET unsorted = 0 WHERE id = ?").bind(id).execute(&mut *conn).await?;
    Ok(true)
}

async fn file_payee(db: &Db, ent: &Entity, payee: i64, target: Target, out: &mut DefaultChange) -> Result<()> {
    let (drafts, history) = {
        let mut conn = db.acquire().await?;
        let s = sys(&mut conn, ent).await?;
        lines_to_file(&mut conn, ent, &s, payee).await?
    };
    for (ids, filed) in [(drafts, &mut out.filed_drafts), (history, &mut out.filed_history)] {
        for chunk in ids.chunks(BATCH) {
            let mut tx = crate::db::begin_write(db).await?;
            let s = sys(&mut tx, ent).await?;
            for &id in chunk {
                if file_target_in(&mut tx, ent, &s, id, target).await? {
                    filed.push(id);
                }
            }
            tx.commit().await?;
        }
    }
    Ok(())
}

/// Undoes a [`DefaultChange`]: the payee's default goes back to `previous`, and the lines it
/// filed that still carry the category go back where they were (drafts to the inbox, history
/// to unsorted).
pub async fn undo_default(
    db: &Db,
    ent: &Entity,
    id: i64,
    previous: Option<i64>,
    previous_account: Option<i64>,
    filed_drafts: &[i64],
    filed_history: &[i64],
) -> Result<Payee> {
    let mut tx = crate::db::begin_write(db).await?;
    let (current, _) = live_payee(&mut tx, ent, id).await?;
    let current_account = default_account(&mut tx, id).await?;
    if let Some(p) = previous {
        get_ledger_account_in(&mut tx, ent, p).await?;
    }
    if let Some(a) = previous_account {
        super::get_account_in(&mut tx, ent, a).await?;
    }
    sqlx::query("UPDATE fin_payees SET default_ledger_account_id = ?, default_account_id = ? WHERE id = ?")
        .bind(previous)
        .bind(previous_account)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        ent,
        "undo",
        "payee",
        Some(id),
        Some(&serde_json::json!({ "default_ledger_account_id": current })),
        Some(&serde_json::json!({ "default_ledger_account_id": previous })),
    )
    .await?;
    tx.commit().await?;
    if current_account.is_some() {
        // Lines the default moved: "Not a transfer" for each, then history goes back to unsorted.
        for (ids, history) in [(filed_drafts, false), (filed_history, true)] {
            for &entry in ids {
                let pair: Option<i64> = sqlx::query_scalar(
                    "SELECT p.id FROM fin_pairs p JOIN fin_entries e ON e.id = ?1 AND e.payee_id = ?3 \
                     WHERE (p.entry_a = ?1 OR p.entry_b = ?1) AND p.entity_id = ?2 AND p.status IN ('auto', 'confirmed')",
                )
                .bind(entry)
                .bind(ent.id)
                .bind(id)
                .fetch_optional(db)
                .await?;
                let Some(pair) = pair else { continue };
                if super::pairing::resolve_pair(db, ent, pair, false).await.is_err() {
                    continue;
                }
                if history {
                    let mut tx = crate::db::begin_write(db).await?;
                    post_as_history_in(&mut tx, ent, &[entry]).await?;
                    tx.commit().await?;
                }
            }
        }
        return get_payee(db, ent, id).await;
    }
    let Some(category) = current else { return get_payee(db, ent, id).await };
    for (ids, history) in [(filed_drafts, false), (filed_history, true)] {
        for chunk in ids.chunks(BATCH) {
            let mut tx = crate::db::begin_write(db).await?;
            let s = sys(&mut tx, ent).await?;
            for &entry in chunk {
                unfile_in(&mut tx, ent, &s, entry, id, category, history).await?;
            }
            tx.commit().await?;
        }
    }
    get_payee(db, ent, id).await
}

/// Puts one filed line back: uncategorised, and a draft again or unsorted history. Left alone
/// when it's another payee's, has been categorised otherwise since, or sits in a closed month.
async fn unfile_in(
    conn: &mut Conn,
    ent: &Entity,
    s: &Sys,
    id: i64,
    payee: i64,
    category: i64,
    history: bool,
) -> Result<()> {
    let ok: Option<i64> =
        sqlx::query_scalar("SELECT id FROM fin_entries WHERE id = ? AND entity_id = ? AND payee_id = ?")
            .bind(id)
            .bind(ent.id)
            .bind(payee)
            .fetch_optional(&mut *conn)
            .await?;
    if ok.is_none() {
        return Ok(());
    }
    let date = get_entry_in(conn, ent, id).await?.date;
    if super::is_locked(conn, ent, &date).await? {
        return Ok(());
    }
    let v = bank_view(conn, ent, s, id).await?;
    if v.counters.len() != 1 || v.counters[0].0 != category {
        return Ok(());
    }
    recounter(conn, ent, &v, s.uncategorised_for(v.amount_minor)).await?;
    if history {
        sqlx::query("UPDATE fin_entries SET unsorted = 1 WHERE id = ?").bind(id).execute(&mut *conn).await?;
    } else {
        sqlx::query("UPDATE fin_entries SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'posted'")
            .bind(now())
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// How the user answers "just this one, or change the default?" when a line is filed
/// differently from its payee's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DefaultChoice {
    /// Just this line (also what a missing answer means).
    #[default]
    Once,
    /// The payee files under this category from now on.
    Change,
}

/// `fin_categorise`'s answer: the entry, and what it taught the payee.
#[derive(Debug, Clone, Serialize)]
pub struct Categorised {
    #[serde(flatten)]
    pub entry: Entry,
    /// Set when this was the payee's first category (or the user changed it): the Undo
    /// toast's data.
    pub payee_default: Option<DefaultChange>,
}

/// The user categorises a line: its counter side becomes the splits, and a draft posts
/// (categorised means done). The first single category a payee gets becomes its default
/// and files its other uncategorised lines, unless it asks every time; a different category
/// later changes the default only with [`DefaultChoice::Change`].
pub async fn categorise(
    db: &Db,
    ent: &Entity,
    id: i64,
    splits: Vec<Split>,
    choice: DefaultChoice,
) -> Result<Categorised> {
    let mut tx = crate::db::begin_write(db).await?;
    let single = (splits.len() == 1).then(|| splits[0].ledger_account_id);
    super::categorise_in(&mut tx, ent, id, splits).await?;
    let s = sys(&mut tx, ent).await?;
    let v = bank_view(&mut tx, ent, &s, id).await.ok();
    let uncategorised = v.as_ref().is_none_or(|v| v.is_uncategorised(&s));
    if !uncategorised {
        sqlx::query("UPDATE fin_entries SET unsorted = 0 WHERE id = ?").bind(id).execute(&mut *tx).await?;
        post_ids_in(&mut tx, ent, &[id], None, &mut PostOutcome::default()).await?;
    }
    let payee = attach_in(&mut tx, ent, id).await?;
    let mut learn = None;
    if let (Some(payee), Some(la), false) = (payee, single, uncategorised) {
        let (current, ask) = live_payee(&mut tx, ent, payee).await?;
        let has_default = current.is_some() || default_account(&mut tx, payee).await?.is_some();
        let paired = is_paired(&mut tx, id).await?;
        let category = check_category(&mut tx, ent, la).await.is_ok();
        if !ask && !paired && category && current != Some(la) && (!has_default || choice == DefaultChoice::Change) {
            learn = Some((payee, la));
        }
    }
    tx.commit().await?;
    let payee_default = match learn {
        Some((payee, la)) => Some(set_default(db, ent, payee, Some(la), true).await?),
        None => None,
    };
    let entry = super::get_entry(db, ent, id).await?;
    Ok(Categorised { entry, payee_default })
}

/// Where the user moves a line instead of a category: one of their accounts, or a new one.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum TransferTo {
    #[serde(rename_all = "camelCase")]
    Existing {
        account_id: i64,
    },
    New {
        create: NewMoveAccount,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMoveAccount {
    pub name: String,
    pub kind: Option<String>,
    pub institution: Option<String>,
}

/// The user says a line is a move to one of their own accounts (by their say-so, when the
/// bank's text doesn't show it): it books as a transfer, shows under Transfers, and "Not a
/// transfer" undoes it. A new account takes the line's currency and is unconfirmed until its
/// own statement comes in, whose line then takes over the written side. The payee learns it
/// as its default the way it learns a category.
pub async fn categorise_move(
    db: &Db,
    ent: &Entity,
    id: i64,
    to: TransferTo,
    choice: DefaultChoice,
) -> Result<Categorised> {
    let mut tx = crate::db::begin_write(db).await?;
    let s = sys(&mut tx, ent).await?;
    let v = bank_view(&mut tx, ent, &s, id).await?;
    let account = match to {
        TransferTo::Existing { account_id } => {
            if super::get_account_in(&mut tx, ent, account_id).await?.archived {
                return Err(AppError::InvalidInput("that account is archived".into()));
            }
            account_id
        }
        TransferTo::New { create } => {
            let a = super::create_account_in(
                &mut tx,
                ent,
                super::FinAccountInput {
                    kind: create.kind.unwrap_or_else(|| "savings".into()),
                    name: create.name,
                    institution: create.institution,
                    currency: v.currency.clone(),
                    iban_mask: None,
                    profile_key: None,
                    opening_balance_minor: None,
                    opening_date: None,
                },
            )
            .await?;
            sqlx::query("UPDATE fin_accounts SET unconfirmed = 1 WHERE id = ?").bind(a.id).execute(&mut *tx).await?;
            a.id
        }
    };
    if is_paired(&mut tx, id).await? {
        return Err(AppError::InvalidInput("this line is a transfer already: undo that first".into()));
    }
    if account == v.account_id {
        return Err(AppError::InvalidInput(
            "this line is already in that account: pick another account, or a category".into(),
        ));
    }
    if !move_in(&mut tx, ent, &s, id, account).await? {
        return Err(AppError::InvalidInput("this line can't be a move to that account".into()));
    }
    let payee = sqlx::query_scalar::<_, Option<i64>>("SELECT payee_id FROM fin_entries WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let mut learn = None;
    if let Some(payee) = payee {
        let (current, ask) = live_payee(&mut tx, ent, payee).await?;
        let current_account = default_account(&mut tx, payee).await?;
        let has_default = current.is_some() || current_account.is_some();
        if !ask && current_account != Some(account) && (!has_default || choice == DefaultChoice::Change) {
            learn = Some(payee);
        }
    }
    tx.commit().await?;
    let payee_default = match learn {
        Some(payee) => Some(set_default_to(db, ent, payee, None, Some(account), true).await?),
        None => None,
    };
    let entry = super::get_entry(db, ent, id).await?;
    Ok(Categorised { entry, payee_default })
}

/// Import step: files each fresh draft whose payee has a default (and doesn't ask every
/// time) under it. Transfer legs and lines already sorted are left. Returns how many.
pub(crate) async fn apply_defaults_in(conn: &mut Conn, ent: &Entity, s: &Sys, ids: &[i64]) -> Result<usize> {
    let mut done = 0;
    for &id in ids {
        let row: Option<(String, Option<i64>, Option<i64>, bool)> = sqlx::query_as(
            "SELECT e.status, p.default_ledger_account_id, p.default_account_id, p.ask_every_time FROM fin_entries e \
             JOIN fin_payees p ON p.id = e.payee_id WHERE e.id = ? AND e.entity_id = ?",
        )
        .bind(id)
        .bind(ent.id)
        .fetch_optional(&mut *conn)
        .await?;
        let target = match row {
            Some((status, la, account, false)) if status == "draft" => match (la, account) {
                (Some(la), _) => Target::Category(la),
                (_, Some(a)) => Target::Account(a),
                _ => continue,
            },
            _ => continue,
        };
        if is_paired(conn, id).await? {
            continue;
        }
        let v = match bank_view(conn, ent, s, id).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !v.is_uncategorised(s) {
            continue;
        }
        if file_target_in(conn, ent, s, id, target).await? {
            done += 1;
        }
    }
    Ok(done)
}

// ============== Rename, merge, split ==============

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayeePatch {
    pub name: Option<String>,
    pub ask_every_time: Option<bool>,
}

/// Renames a payee or sets "ask every time". The default category is [`set_default`]'s.
pub async fn update_payee(db: &Db, ent: &Entity, id: i64, patch: PayeePatch) -> Result<Payee> {
    let mut tx = crate::db::begin_write(db).await?;
    live_payee(&mut tx, ent, id).await?;
    let before = get_payee_in(&mut tx, ent, id).await?;
    if let Some(name) = &patch.name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 200 {
            return Err(AppError::InvalidInput("a payee's name is 1 to 200 characters".into()));
        }
        // A name the user gave is never retitled.
        sqlx::query("UPDATE fin_payees SET name = ?, renamed = 1 WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ask) = patch.ask_every_time {
        sqlx::query("UPDATE fin_payees SET ask_every_time = ? WHERE id = ?")
            .bind(ask)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let after = get_payee_in(&mut tx, ent, id).await?;
    audit(
        &mut tx,
        ent,
        "update",
        "payee",
        Some(id),
        Some(&serde_json::json!({ "name": before.name, "ask_every_time": before.ask_every_time })),
        Some(&serde_json::json!({ "name": after.name, "ask_every_time": after.ask_every_time })),
    )
    .await?;
    tx.commit().await?;
    Ok(after)
}

/// Merges payees into `target`: their aliases and lines move to it, each alias remembering
/// the payee it came from. The target keeps its name and default; without a default it takes
/// the first merged payee's.
pub async fn merge_payees(db: &Db, ent: &Entity, target: i64, sources: &[i64]) -> Result<Payee> {
    let mut tx = crate::db::begin_write(db).await?;
    let (mut default, _) = live_payee(&mut tx, ent, target).await?;
    let mut merged = Vec::new();
    for &source in sources {
        if source == target || merged.contains(&source) {
            continue;
        }
        let (source_default, _) = live_payee(&mut tx, ent, source).await?;
        sqlx::query(
            "UPDATE fin_payee_aliases SET payee_id = ?, origin_payee_id = COALESCE(origin_payee_id, ?) \
             WHERE entity_id = ? AND payee_id = ?",
        )
        .bind(target)
        .bind(source)
        .bind(ent.id)
        .bind(source)
        .execute(&mut *tx)
        .await?;
        for table in ["fin_entries", "fin_source_lines"] {
            let regroup = if table == "fin_entries" { ", group_key = NULL" } else { "" };
            sqlx::query(&format!("UPDATE {table} SET payee_id = ?{regroup} WHERE entity_id = ? AND payee_id = ?"))
                .bind(target)
                .bind(ent.id)
                .bind(source)
                .execute(&mut *tx)
                .await?;
        }
        // Payees merged into this one earlier now point at the target.
        sqlx::query("UPDATE fin_payees SET merged_into = ? WHERE entity_id = ? AND (id = ? OR merged_into = ?)")
            .bind(target)
            .bind(ent.id)
            .bind(source)
            .bind(source)
            .execute(&mut *tx)
            .await?;
        // A payee that asked every time keeps asking; dismissed suggestions about it are moot.
        sqlx::query(
            "UPDATE fin_payees SET ask_every_time = 1 WHERE id = ? AND EXISTS \
             (SELECT 1 FROM fin_payees WHERE id = ? AND ask_every_time = 1)",
        )
        .bind(target)
        .bind(source)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM fin_payee_dismissed WHERE entity_id = ? AND (payee_a = ? OR payee_b = ?)")
            .bind(ent.id)
            .bind(source)
            .bind(source)
            .execute(&mut *tx)
            .await?;
        if default.is_none() && source_default.is_some() {
            default = source_default;
            sqlx::query("UPDATE fin_payees SET default_ledger_account_id = ? WHERE id = ?")
                .bind(default)
                .bind(target)
                .execute(&mut *tx)
                .await?;
        }
        merged.push(source);
    }
    if merged.is_empty() {
        return Err(AppError::InvalidInput("name at least one other payee to merge".into()));
    }
    audit(&mut tx, ent, "merge", "payee", Some(target), Some(&serde_json::json!({ "merged": merged })), None).await?;
    let out = get_payee_in(&mut tx, ent, target).await?;
    tx.commit().await?;
    Ok(out)
}

/// Splits aliases off a payee, with their lines: an alias that came in by a merge goes back to
/// the payee it came from, and any other gets a payee of its own. At least one alias stays.
/// Returns the payees the aliases went to.
pub async fn split_payee(db: &Db, ent: &Entity, id: i64, alias_keys: &[String]) -> Result<Vec<Payee>> {
    let mut tx = crate::db::begin_write(db).await?;
    live_payee(&mut tx, ent, id).await?;
    let aliases: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT key, sample, origin_payee_id FROM fin_payee_aliases WHERE entity_id = ? AND payee_id = ?",
    )
    .bind(ent.id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let wanted: HashSet<&str> = alias_keys.iter().map(String::as_str).collect();
    let moving: Vec<&(String, String, Option<i64>)> =
        aliases.iter().filter(|a| wanted.contains(a.0.as_str())).collect();
    if moving.is_empty() || moving.len() != wanted.len() {
        return Err(AppError::InvalidInput("name aliases of this payee to split off".into()));
    }
    if moving.len() == aliases.len() {
        return Err(AppError::InvalidInput("a payee keeps at least one alias".into()));
    }
    let mut to: Vec<i64> = Vec::new();
    for (key, sample, origin) in moving {
        let back: Option<i64> = match origin {
            Some(o) => {
                sqlx::query_scalar("SELECT id FROM fin_payees WHERE id = ? AND entity_id = ? AND merged_into = ?")
                    .bind(o)
                    .bind(ent.id)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
            }
            None => None,
        };
        let dest = match back {
            Some(o) => {
                // Back as itself: named from its own spelling, unless the user named it.
                sqlx::query(
                    "UPDATE fin_payees SET merged_into = NULL, name = CASE WHEN renamed = 1 THEN name ELSE ? END WHERE id = ?",
                )
                .bind(display_name(sample))
                .bind(o)
                .execute(&mut *tx)
                .await?;
                o
            }
            None => sqlx::query("INSERT INTO fin_payees (entity_id, name, created_at) VALUES (?, ?, ?)")
                .bind(ent.id)
                .bind(display_name(sample))
                .bind(now())
                .execute(&mut *tx)
                .await?
                .last_insert_rowid(),
        };
        sqlx::query(
            "UPDATE fin_payee_aliases SET payee_id = ?, origin_payee_id = NULL WHERE entity_id = ? AND key = ?",
        )
        .bind(dest)
        .bind(ent.id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE fin_entries SET payee_id = ?, group_key = NULL WHERE entity_id = ? AND payee_id = ? AND payee_key = ?",
        )
            .bind(dest)
            .bind(ent.id)
            .bind(id)
            .bind(key)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE fin_source_lines SET payee_id = ? WHERE entity_id = ? AND id IN \
             (SELECT source_line_id FROM fin_entries WHERE entity_id = ? AND payee_id = ? AND payee_key = ?)",
        )
        .bind(dest)
        .bind(ent.id)
        .bind(ent.id)
        .bind(dest)
        .bind(key)
        .execute(&mut *tx)
        .await?;
        if !to.contains(&dest) {
            to.push(dest);
        }
    }
    audit(&mut tx, ent, "split", "payee", Some(id), Some(&serde_json::json!({ "keys": alias_keys, "to": to })), None)
        .await?;
    let mut out = Vec::new();
    for p in to {
        out.push(get_payee_in(&mut tx, ent, p).await?);
    }
    tx.commit().await?;
    Ok(out)
}

// ============== Merge suggestions ==============

#[derive(Debug, Clone, Serialize)]
pub struct PayeeRef {
    pub id: i64,
    pub name: String,
    pub lines: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Suggestion {
    pub a: PayeeRef,
    pub b: PayeeRef,
    /// `same name`, `spelled alike` or `another branch`.
    pub reason: &'static str,
}

/// Payees that look like one, by their loose keys ([`similar`]), the most lines first. A
/// dismissed pair isn't offered again.
pub async fn suggestions(db: &Db, ent: &Entity, limit: usize) -> Result<Vec<Suggestion>> {
    let mut conn = db.acquire().await?;
    let payees: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, (SELECT COUNT(*) FROM fin_entries e WHERE e.payee_id = p.id AND e.status != 'reversed') \
         FROM fin_payees p WHERE p.entity_id = ? AND p.merged_into IS NULL",
    )
    .bind(ent.id)
    .fetch_all(&mut *conn)
    .await?;
    let aliases: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.payee_id, a.loose_key FROM fin_payee_aliases a JOIN fin_payees p ON p.id = a.payee_id \
         WHERE a.entity_id = ? AND p.merged_into IS NULL",
    )
    .bind(ent.id)
    .fetch_all(&mut *conn)
    .await?;
    let dismissed: HashSet<(i64, i64)> =
        sqlx::query_as::<_, (i64, i64)>("SELECT payee_a, payee_b FROM fin_payee_dismissed WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let mut keys: Vec<(String, i64)> = Vec::new();
    for (p, k) in aliases {
        keys.push((k, p));
    }
    for (id, name, _) in &payees {
        keys.push((loose_key(name), *id));
    }
    keys.sort();
    keys.dedup();
    // Compare within the same first letter: an edit distance of 2 at most rarely changes it.
    let mut found: HashMap<(i64, i64), &'static str> = HashMap::new();
    let mut start = 0;
    while start < keys.len() {
        let first = keys[start].0.chars().next();
        let end = keys[start..].iter().position(|k| k.0.chars().next() != first).map_or(keys.len(), |n| start + n);
        let bucket = &keys[start..end];
        for i in 0..bucket.len() {
            for j in i + 1..bucket.len() {
                let (a, b) = (&bucket[i], &bucket[j]);
                if a.1 == b.1 {
                    continue;
                }
                let pair = (a.1.min(b.1), a.1.max(b.1));
                if dismissed.contains(&pair) || found.contains_key(&pair) {
                    continue;
                }
                if let Some(reason) = similar(&a.0, &b.0) {
                    found.insert(pair, reason);
                }
            }
        }
        start = end;
    }
    let by_id: HashMap<i64, (String, i64)> = payees.into_iter().map(|(id, n, l)| (id, (n, l))).collect();
    let r = |id: i64| by_id.get(&id).map(|(name, lines)| PayeeRef { id, name: name.clone(), lines: *lines });
    let mut out: Vec<Suggestion> =
        found.into_iter().filter_map(|((a, b), reason)| Some(Suggestion { a: r(a)?, b: r(b)?, reason })).collect();
    out.sort_by_key(|s| (std::cmp::Reverse(s.a.lines + s.b.lines), s.a.id, s.b.id));
    out.truncate(limit);
    Ok(out)
}

/// Remembers that two payees aren't one, so the pair isn't suggested again.
pub async fn dismiss_suggestion(db: &Db, ent: &Entity, a: i64, b: i64) -> Result<()> {
    let mut tx = crate::db::begin_write(db).await?;
    for id in [a, b] {
        sqlx::query_scalar::<_, i64>("SELECT id FROM fin_payees WHERE id = ? AND entity_id = ?")
            .bind(id)
            .bind(ent.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| not_found("payee"))?;
    }
    sqlx::query(
        "INSERT OR IGNORE INTO fin_payee_dismissed (entity_id, payee_a, payee_b, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(a.min(b))
    .bind(a.max(b))
    .bind(now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

// ============== Building payees from existing books ==============

/// How the startup backfill writes: entries per transaction, the pause after each commit,
/// and (tests) a stop after so many transactions, standing for a host killed halfway.
#[derive(Debug, Clone)]
pub struct BackfillOptions {
    pub batch: usize,
    pub pause: std::time::Duration,
    #[doc(hidden)]
    pub stop_after: Option<usize>,
}

impl Default for BackfillOptions {
    fn default() -> Self {
        BackfillOptions { batch: 250, pause: std::time::Duration::from_millis(50), stop_after: None }
    }
}

/// The entries the backfill gives a payee: from a bank line or with a payee, not yet looked at.
const UNSEEN: &str = "e.payee_key IS NULL AND (e.source_line_id IS NOT NULL OR COALESCE(e.payee, '') != '')";

/// While an entity's books from before payees are being worked through ([`backfill`]): how
/// far, as (entries looked at, entries in all). `None` once it's done (and for a new entity).
pub async fn preparing(db: &Db, ent: &Entity) -> Result<Option<(i64, i64)>> {
    let learned: bool =
        sqlx::query_scalar("SELECT payees_learned FROM fin_entities WHERE id = ?").bind(ent.id).fetch_one(db).await?;
    if learned {
        return Ok(None);
    }
    let (left, all): (i64, i64) = sqlx::query_as(&format!(
        "SELECT COALESCE(SUM({UNSEEN}), 0), \
                COALESCE(SUM(e.source_line_id IS NOT NULL OR COALESCE(e.payee, '') != ''), 0) \
         FROM fin_entries e WHERE e.entity_id = ?"
    ))
    .bind(ent.id)
    .fetch_one(db)
    .await?;
    Ok(Some((all - left, all)))
}

/// The host's background job after a start (never inside the migration, so `/health` answers
/// at once): every entity whose books are from before payees gets them. Each stored line is
/// given its payee, in short write transactions with a pause after each; then the books'
/// categories are learned as defaults ([`learn_from_books`]), and only then is the entity
/// marked done. Every step is idempotent, so a restart halfway goes on where it stopped.
pub async fn backfill(pool: &Db, opts: &BackfillOptions) -> Result<()> {
    let entities: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM fin_entities WHERE payees_learned = 0 ORDER BY id").fetch_all(pool).await?;
    let mut writes = 0usize;
    for id in entities {
        let ent: Entity = sqlx::query_as("SELECT * FROM fin_entities WHERE id = ?").bind(id).fetch_one(pool).await?;
        loop {
            if opts.stop_after.is_some_and(|n| writes >= n) {
                return Ok(());
            }
            let ids: Vec<i64> = sqlx::query_scalar(&format!(
                "SELECT e.id FROM fin_entries e WHERE e.entity_id = ? AND {UNSEEN} ORDER BY e.id LIMIT ?"
            ))
            .bind(ent.id)
            .bind(opts.batch.max(1) as i64)
            .fetch_all(pool)
            .await?;
            if ids.is_empty() {
                break;
            }
            let mut tx = crate::db::begin_write(pool).await?;
            for &e in &ids {
                attach_in(&mut tx, &ent, e).await?;
            }
            tx.commit().await?;
            writes += 1;
            tokio::time::sleep(opts.pause).await;
        }
        learn_from_books(pool, &ent, opts).await?;
    }
    Ok(())
}

/// Once per entity, when payees arrive: a payee without a default whose categorised lines
/// mostly (two in three) went to one category takes it; a rule that matches one payee only (by
/// text, with one category) gives that payee its category as the default (the rule stays); and
/// drafts already categorised are posted, since categorised now means done.
pub(crate) async fn learn_from_books(pool: &Db, ent: &Entity, opts: &BackfillOptions) -> Result<()> {
    let mut tx = crate::db::begin_write(pool).await?;
    let s = sys(&mut tx, ent).await?;
    // The categories of each payee's lines (single-category entries only).
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(&format!(
        "SELECT e.payee_id, l.ledger_account_id, COUNT(*) FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id \
         JOIN fin_ledger_accounts la ON la.id = l.ledger_account_id \
         WHERE e.entity_id = ? AND e.payee_id IS NOT NULL AND e.status != 'reversed' \
           AND la.class IN ('income', 'expense') AND la.currency IS NULL \
           AND (la.system_key IS NULL OR la.system_key = 'bank_fees') AND l.ledger_account_id != {fees} \
         GROUP BY e.payee_id, l.ledger_account_id",
        fees = s.fees
    ))
    .bind(ent.id)
    .fetch_all(&mut *tx)
    .await?;
    let mut by_payee: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for (p, la, n) in rows {
        by_payee.entry(p).or_default().push((la, n));
    }
    for (p, cats) in by_payee {
        let total: i64 = cats.iter().map(|c| c.1).sum();
        let Some(&(la, n)) = cats.iter().max_by_key(|c| (c.1, std::cmp::Reverse(c.0))) else { continue };
        if n * 3 >= total * 2 {
            sqlx::query(
                "UPDATE fin_payees SET default_ledger_account_id = ? WHERE id = ? AND default_ledger_account_id IS NULL",
            )
            .bind(la)
            .bind(p)
            .execute(&mut *tx)
            .await?;
        }
    }
    // Rules that file one payee only.
    let aliases: Vec<(i64, String)> =
        sqlx::query_as("SELECT payee_id, sample FROM fin_payee_aliases WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_all(&mut *tx)
            .await?;
    let rules: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, conditions_json, action_json FROM fin_rules WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_all(&mut *tx)
            .await?;
    for (rule_id, conditions, action) in rules {
        let (Ok(c), Ok(a)) = (
            serde_json::from_str::<super::rules::Conditions>(&conditions),
            serde_json::from_str::<super::rules::Action>(&action),
        ) else {
            continue;
        };
        let (Some(la), true) = (a.ledger_account_id, a.splits.is_empty()) else { continue };
        // Text only (a sign bound aside): a rule on amounts, accounts or kinds stays a rule.
        let sign_only = |m: Option<i64>, ok: &[i64]| m.is_none_or(|m| ok.contains(&m));
        let text_only = c.account_id.is_none()
            && c.bank_category.is_none()
            && c.kind_hint.is_none()
            && c.currency.is_none()
            && sign_only(c.max_amount_minor, &[-1, 0])
            && sign_only(c.min_amount_minor, &[0, 1])
            && (c.text.is_some() || c.payee.is_some() || c.description.is_some());
        if !text_only || check_category(&mut tx, ent, la).await.is_err() {
            continue;
        }
        let mut hit: HashSet<i64> = HashSet::new();
        for (p, sample) in &aliases {
            let subject = super::rules::Subject {
                description: sample.clone(),
                payee: Some(sample.clone()),
                amount_minor: c.max_amount_minor.unwrap_or(c.min_amount_minor.unwrap_or(-1)),
                ..Default::default()
            };
            let probe = super::rules::Conditions { min_amount_minor: None, max_amount_minor: None, ..c.clone() };
            if probe.matches(&subject) {
                hit.insert(*p);
            }
        }
        let [payee] = hit.into_iter().collect::<Vec<_>>()[..] else { continue };
        let target: i64 = sqlx::query_scalar("SELECT COALESCE(merged_into, id) FROM fin_payees WHERE id = ?")
            .bind(payee)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE fin_payees SET default_ledger_account_id = ? WHERE id = ? AND default_ledger_account_id IS NULL",
        )
        .bind(la)
        .bind(target)
        .execute(&mut *tx)
        .await?;
        // The rule stays: it files the same lines the same way, and an older build (after a
        // rollback) still has it. The Payees & rules screen can retire it.
        let before = serde_json::json!({ "conditions": conditions, "action": action });
        audit(&mut tx, ent, "to_payee_default", "rule", Some(rule_id), Some(&before), None).await?;
    }
    tx.commit().await?;

    // Categorised drafts post (a closed month or a pair to review aside).
    let unc = uncategorised_sql(&s, ent);
    let ids: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT e.id FROM fin_entries e WHERE e.entity_id = ? AND e.status = 'draft' AND NOT ({unc}) ORDER BY e.id"
    ))
    .bind(ent.id)
    .fetch_all(pool)
    .await?;
    for chunk in ids.chunks(opts.batch.max(1)) {
        let mut tx = crate::db::begin_write(pool).await?;
        post_ids_in(&mut tx, ent, chunk, None, &mut PostOutcome::default()).await?;
        tx.commit().await?;
        tokio::time::sleep(opts.pause).await;
    }
    // Done last, so a restart before here does the learning again (it changes nothing twice).
    sqlx::query("UPDATE fin_entities SET payees_learned = 1 WHERE id = ?").bind(ent.id).execute(pool).await?;
    Ok(())
}

// ============== Tidying an inbox from before payees ==============

/// What [`tidy_inbox`] did, or would do.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TidyOutcome {
    /// Drafts filed under their payee's default.
    pub filed: usize,
    /// Uncategorised drafts older than the cut-off, posted as unsorted history.
    pub history: usize,
    /// Drafts left: the decisions.
    pub left: i64,
}

/// `fin_tidy_inbox`: brings an inbox from before payees in line with how imports file now.
/// Drafts whose payee has a default are filed under it, and uncategorised drafts dated before
/// `history_before` post as unsorted history. With `dry_run`, only counts.
pub async fn tidy_inbox(db: &Db, ent: &Entity, history_before: Option<&str>, dry_run: bool) -> Result<TidyOutcome> {
    let _busy = super::reset::begin_bulk(db, ent)?;
    let (s, by_default, old) = {
        let mut conn = db.acquire().await?;
        let s = sys(&mut conn, ent).await?;
        let unc = uncategorised_sql(&s, ent);
        let by_default: Vec<(i64, i64)> = sqlx::query_as(&format!(
            "SELECT e.id, p.default_ledger_account_id FROM fin_entries e JOIN fin_payees p ON p.id = e.payee_id \
             WHERE e.entity_id = ? AND e.status = 'draft' AND p.default_ledger_account_id IS NOT NULL \
               AND p.ask_every_time = 0 AND {unc} AND NOT {LIVE_PAIR} ORDER BY e.id"
        ))
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?;
        let old: Vec<i64> = match history_before {
            Some(before) => {
                sqlx::query_scalar(&format!(
                    "SELECT e.id FROM fin_entries e WHERE e.entity_id = ? AND e.status = 'draft' AND e.date < ? \
                 AND e.source_line_id IS NOT NULL AND {unc} AND NOT {LIVE_PAIR} \
                 AND NOT EXISTS (SELECT 1 FROM fin_payees p WHERE p.id = e.payee_id \
                                 AND p.default_ledger_account_id IS NOT NULL AND p.ask_every_time = 0) ORDER BY e.id"
                ))
                .bind(ent.id)
                .bind(super::check_date(before)?)
                .fetch_all(&mut *conn)
                .await?
            }
            None => Vec::new(),
        };
        (s, by_default, old)
    };
    let mut out = TidyOutcome::default();
    if dry_run {
        out.filed = by_default.len();
        out.history = old.len();
    } else {
        for chunk in by_default.chunks(BATCH) {
            let mut tx = crate::db::begin_write(db).await?;
            for &(id, la) in chunk {
                if file_in(&mut tx, ent, &s, id, la).await? {
                    out.filed += 1;
                }
            }
            tx.commit().await?;
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        for chunk in old.chunks(BATCH) {
            let mut tx = crate::db::begin_write(db).await?;
            out.history += post_as_history_in(&mut tx, ent, chunk).await?;
            tx.commit().await?;
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
    out.left = sqlx::query_scalar("SELECT COUNT(*) FROM fin_entries WHERE entity_id = ? AND status = 'draft'")
        .bind(ent.id)
        .fetch_one(db)
        .await?;
    if dry_run {
        out.left -= (out.filed + out.history) as i64;
    }
    Ok(out)
}

/// Posts uncategorised drafts as unsorted history: out of the inbox, still uncategorised.
/// Returns how many it posted.
pub(crate) async fn post_as_history_in(conn: &mut Conn, ent: &Entity, ids: &[i64]) -> Result<usize> {
    let mut out = PostOutcome::default();
    for &id in ids {
        let before = out.posted;
        post_ids_in(conn, ent, &[id], None, &mut out).await?;
        if out.posted > before {
            sqlx::query("UPDATE fin_entries SET unsorted = 1 WHERE id = ?").bind(id).execute(&mut *conn).await?;
        }
    }
    Ok(out.posted)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "scale_tests.rs"]
mod scale_tests;

#[cfg(test)]
#[path = "startup_tests.rs"]
mod startup_tests;
