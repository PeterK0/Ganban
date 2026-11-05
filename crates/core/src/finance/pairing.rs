//! Transfer, FX and refund matching for bank entries.
//!
//! A transfer between the user's own accounts is two bank entries whose counter lines
//! both sit on `transfers_clearing`, so a matched pair nets to 0 there. An FX pair is
//! the same, but its legs are in different currencies: each translates at the ECB rate,
//! and an adjusting entry moves what's left on clearing to realised FX gains or losses.
//! A refund (money back from a merchant the user paid before) takes the category of
//! that earlier expense.
//!
//! Matches the matcher is sure of are `auto`; uncertain ones are `review`, and their
//! entries stay as they were until the user accepts.

use std::collections::{HashMap, HashSet};

use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde::Serialize;

use super::import::decode::currency_exponent;
use super::rules::merchant_key;
use super::{
    audit, categorise_in, create_bank_draft_in, create_entry_in, get_entry_in, not_found, now, rates,
    system, system_account_in, BankDraft, Conn, Entity, Entry, EntryInput, LineInput, Split,
};
use crate::error::{AppError, Result};
use crate::Db;

/// The note on an entry the import wrote for a pocket's side of a move.
pub const COUNTERPART_NOTE: &str = "Written by the import: the pocket's side of this move wasn't in the file.";

/// How far apart two legs of a transfer may be booked.
pub const TRANSFER_DAYS: i64 = 3;
/// A match scoring this or more, with no close rival, is made without asking.
pub const AUTO_SCORE: f64 = 0.75;
/// How far back a refund looks for the expense it returns.
pub const REFUND_DAYS: i64 = 180;

// ============== The pure matcher ==============

/// A bank entry that might be one leg of a pair.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub entry_id: i64,
    pub account_id: i64,
    pub date: NaiveDate,
    /// The booking time (Revolut's Completed Date), for exchange legs.
    pub at: Option<NaiveDateTime>,
    /// The bank's own timestamp of the line (Revolut's Started Date, to the second).
    pub occurred_at: Option<NaiveDateTime>,
    /// The bank's description of the line.
    pub description: String,
    /// The bank line, signed, excluding the fee.
    pub amount_minor: i64,
    pub currency: String,
    pub kind_hint: Option<String>,
    /// The other currency of an exchange leg, when the bank names it.
    pub fx_currency: Option<String>,
    /// The account the bank says is on the far side (a pocket).
    pub counterpart_account: Option<i64>,
    /// From this import; only pairs with a fresh leg are proposed.
    pub fresh: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairKind {
    Transfer,
    Fx,
}

impl PairKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PairKind::Transfer => "transfer",
            PairKind::Fx => "fx",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub a: i64,
    pub b: i64,
    pub kind: PairKind,
    pub score: f64,
    pub auto: bool,
}

fn is_transferish(k: Option<&str>) -> bool {
    matches!(k, Some("transfer" | "topup"))
}

/// How close the bank's timestamps of two legs must be to call them one move.
pub const SAME_MOMENT_SECS: i64 = 60;

/// A bank description reduced to its pattern: lower case, without a leading "to" or
/// "from" and without words that hold digits (references, dates). "To pocket Rent"
/// and "From pocket Rent" both become "pocket rent".
pub fn description_key(description: &str) -> String {
    let lower = description.trim().to_lowercase();
    let rest = lower.strip_prefix("to ").or_else(|| lower.strip_prefix("from ")).unwrap_or(&lower);
    rest.split_whitespace().filter(|w| !w.chars().any(|c| c.is_ascii_digit())).collect::<Vec<_>>().join(" ")
}

/// Both legs carry the bank's timestamp, within [`SAME_MOMENT_SECS`] of each other.
fn same_moment(a: &Candidate, b: &Candidate) -> bool {
    matches!((a.occurred_at, b.occurred_at), (Some(x), Some(y)) if (x - y).num_seconds().abs() <= SAME_MOMENT_SECS)
}

/// The score of two legs as one transfer, and whether the bank stamped them at the
/// same moment (which settles it: 1.0).
fn transfer_score(a: &Candidate, b: &Candidate) -> Option<(f64, bool)> {
    if a.currency != b.currency || a.amount_minor == 0 || a.amount_minor != -b.amount_minor {
        return None;
    }
    if a.kind_hint.as_deref() == Some("exchange") || b.kind_hint.as_deref() == Some("exchange") {
        return None;
    }
    let days = (a.date - b.date).num_days().abs();
    if days > TRANSFER_DAYS {
        return None;
    }
    if same_moment(a, b) {
        return Some((1.0, true));
    }
    let mut s = 0.5;
    s += match days {
        0 => 0.2,
        1 => 0.1,
        _ => 0.0,
    };
    // One transfer leg lifts the score only when the other side's kind is unknown:
    // a card payment or a refund is someone else's money.
    let unknown = |k: Option<&str>| matches!(k, None | Some("other"));
    let (ka, kb) = (a.kind_hint.as_deref(), b.kind_hint.as_deref());
    s += match (is_transferish(ka), is_transferish(kb)) {
        (true, true) => 0.15,
        (true, false) if unknown(kb) => 0.05,
        (false, true) if unknown(ka) => 0.05,
        _ => 0.0,
    };
    if a.counterpart_account == Some(b.account_id) || b.counterpart_account == Some(a.account_id) {
        s += 0.3;
    }
    // The same words on both legs ("Pocket Withdrawal" twice) are a small hint.
    let (da, db) = (description_key(&a.description), description_key(&b.description));
    if !da.is_empty() && da == db {
        s += 0.05;
    }
    Some((f64::min(s, 1.0), false))
}

/// Units of `to` per unit of `from` the bank applied, from the two legs' amounts.
fn implied_rate(from_minor: i64, from: &str, to_minor: i64, to: &str) -> Option<f64> {
    let f = from_minor.unsigned_abs() as f64 / 10f64.powi(currency_exponent(from) as i32);
    let t = to_minor.unsigned_abs() as f64 / 10f64.powi(currency_exponent(to) as i32);
    (f > 0.0).then(|| t / f)
}

fn fx_score(a: &Candidate, b: &Candidate, ecb: &dyn Fn(&str, &str, NaiveDate) -> Option<f64>) -> Option<f64> {
    if a.kind_hint.as_deref() != Some("exchange") || b.kind_hint.as_deref() != Some("exchange") {
        return None;
    }
    if a.currency == b.currency || a.amount_minor.signum() == b.amount_minor.signum() || a.amount_minor == 0 {
        return None;
    }
    for (x, y) in [(a, b), (b, a)] {
        if x.fx_currency.as_ref().is_some_and(|c| *c != y.currency) {
            return None;
        }
    }
    if (a.date - b.date).num_days().abs() > 1 {
        return None;
    }
    let mut s = 0.5;
    if let (Some(x), Some(y)) = (a.at, b.at) {
        let secs = (x - y).num_seconds().abs();
        if secs > 3600 {
            return None;
        }
        s += if secs <= 120 { 0.25 } else if secs <= 600 { 0.1 } else { 0.0 };
    }
    if a.fx_currency.is_some() || b.fx_currency.is_some() {
        s += 0.1;
    }
    let (out, inn) = if a.amount_minor < 0 { (a, b) } else { (b, a) };
    if let (Some(implied), Some(spot)) =
        (implied_rate(out.amount_minor, &out.currency, inn.amount_minor, &inn.currency), ecb(&out.currency, &inn.currency, out.date))
    {
        let dev = (implied / spot - 1.0).abs();
        if dev > 0.1 {
            return None;
        }
        s += 0.15 * (1.0 - dev / 0.1);
    }
    Some(f64::min(s, 1.0))
}

/// A scored match, with what the rival check needs.
struct Scored {
    p: Proposal,
    /// Stamped by the bank at the same moment.
    timed: bool,
    /// Indexes into the candidates: the money-out and the money-in leg.
    out: usize,
    inn: usize,
}

/// Proposes pairs among the candidates, best first. Each entry joins at most one
/// pair, and one with a rival within 0.1 of its score goes to review, except:
///
/// - a pair the bank stamped at the same moment isn't held up by rivals without that;
/// - a rival that only swaps one leg for an identical one (the same account, amount,
///   currency and day) gives the same books, so it doesn't count. Such legs pair in
///   time order: by the bank's timestamp, else by line order. (A leg whose description
///   matches scores 0.05 more, so it goes first.)
pub fn propose_pairs(c: &[Candidate], ecb: &dyn Fn(&str, &str, NaiveDate) -> Option<f64>) -> Vec<Proposal> {
    // Time order of the legs: the bank's timestamp, else the order the lines came in.
    let mut order: Vec<usize> = (0..c.len()).collect();
    order.sort_by(|&x, &y| c[x].occurred_at.cmp(&c[y].occurred_at).then(c[x].entry_id.cmp(&c[y].entry_id)));
    let mut rank = vec![0usize; c.len()];
    for (r, &i) in order.iter().enumerate() {
        rank[i] = r;
    }
    let mut all: Vec<Scored> = Vec::new();
    for i in 0..c.len() {
        for j in i + 1..c.len() {
            let (a, b) = (&c[i], &c[j]);
            if a.account_id == b.account_id || !(a.fresh || b.fresh) {
                continue;
            }
            let (out, inn) = if a.amount_minor < 0 { (i, j) } else { (j, i) };
            let (kind, score, timed) = if let Some((score, timed)) = transfer_score(a, b) {
                (PairKind::Transfer, score, timed)
            } else if let Some(score) = fx_score(a, b, ecb) {
                (PairKind::Fx, score, false)
            } else {
                continue;
            };
            all.push(Scored { p: Proposal { a: a.entry_id, b: b.entry_id, kind, score, auto: false }, timed, out, inn });
        }
    }
    all.sort_by(|x, y| {
        y.p.score
            .total_cmp(&x.p.score)
            .then(y.timed.cmp(&x.timed))
            .then(rank[x.out].cmp(&rank[y.out]))
            .then(rank[x.inn].cmp(&rank[y.inn]))
    });
    // The same books either way: `q` swaps one of `p`'s legs for one on the same
    // account and day (the amount and currency already agree).
    let interchangeable = |p: &Scored, q: &Scored| {
        let swap = |x: usize, y: usize| c[x].account_id == c[y].account_id && c[x].date == c[y].date;
        p.p.kind == PairKind::Transfer
            && q.p.kind == PairKind::Transfer
            && ((p.out == q.out && swap(p.inn, q.inn)) || (p.inn == q.inn && swap(p.out, q.out)))
    };
    // The matches each leg is in, so the rival check looks only at those.
    let mut by_leg: HashMap<usize, Vec<usize>> = HashMap::new();
    for (n, p) in all.iter().enumerate() {
        by_leg.entry(p.out).or_default().push(n);
        by_leg.entry(p.inn).or_default().push(n);
    }
    let mut taken: HashSet<i64> = HashSet::new();
    let mut out = Vec::new();
    for (n, p) in all.iter().enumerate() {
        if taken.contains(&p.p.a) || taken.contains(&p.p.b) {
            continue;
        }
        let rival = by_leg[&p.out].iter().chain(&by_leg[&p.inn]).map(|&m| (m, &all[m])).any(|(m, q)| {
            m != n
                && !taken.contains(&q.p.a)
                && !taken.contains(&q.p.b)
                && q.p.score + 1e-9 >= p.p.score - 0.1
                && !(p.timed && !q.timed)
                && !interchangeable(p, q)
        });
        taken.insert(p.p.a);
        taken.insert(p.p.b);
        out.push(Proposal { auto: p.p.score >= AUTO_SCORE && !rival, ..p.p.clone() });
    }
    out
}

/// The booking time stored in a source line's raw row (Revolut's "Completed Date").
pub fn at_from_raw(raw_json: &str) -> Option<NaiveDateTime> {
    let v: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    let s = v.get("Completed Date")?.as_str()?;
    NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S").ok()
}

// ============== Bank entries in the ledger ==============

/// The accounts the matcher posts to.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Sys {
    pub unc_expense: i64,
    pub unc_income: i64,
    pub clearing: i64,
    pub fx_gain: i64,
    pub fx_loss: i64,
    pub fees: i64,
}

pub(crate) async fn sys(conn: &mut Conn, ent: &Entity) -> Result<Sys> {
    Ok(Sys {
        unc_expense: system_account_in(conn, ent, system::UNCATEGORISED_EXPENSE).await?.id,
        unc_income: system_account_in(conn, ent, system::UNCATEGORISED_INCOME).await?.id,
        clearing: system_account_in(conn, ent, system::TRANSFERS_CLEARING).await?.id,
        fx_gain: system_account_in(conn, ent, system::FX_REALISED_GAIN).await?.id,
        fx_loss: system_account_in(conn, ent, system::FX_REALISED_LOSS).await?.id,
        fees: system_account_in(conn, ent, system::BANK_FEES).await?.id,
    })
}

impl Sys {
    pub fn uncategorised_for(&self, amount_minor: i64) -> i64 {
        if amount_minor < 0 { self.unc_expense } else { self.unc_income }
    }
}

/// A bank entry seen from its bank account: the account, its currency, the bank line
/// (signed, excluding the fee) and the counter lines.
#[derive(Debug, Clone)]
pub(crate) struct BankView {
    pub entry: Entry,
    pub account_id: i64,
    pub currency: String,
    pub amount_minor: i64,
    /// (ledger account, amount) of each line off the bank account and the fee.
    pub counters: Vec<(i64, i64)>,
}

impl BankView {
    pub fn is_uncategorised(&self, s: &Sys) -> bool {
        !self.counters.is_empty() && self.counters.iter().all(|(la, _)| *la == s.unc_expense || *la == s.unc_income)
    }
    pub fn is_clearing(&self, s: &Sys) -> bool {
        !self.counters.is_empty() && self.counters.iter().all(|(la, _)| *la == s.clearing)
    }
    /// The category the entry mostly went to, unless it's uncategorised or a transfer.
    pub fn main_category(&self, s: &Sys) -> Option<i64> {
        self.counters
            .iter()
            .filter(|(la, _)| ![s.unc_expense, s.unc_income, s.clearing].contains(la))
            .max_by_key(|(_, a)| a.abs())
            .map(|(la, _)| *la)
    }
}

pub(crate) async fn bank_view(conn: &mut Conn, ent: &Entity, s: &Sys, entry_id: i64) -> Result<BankView> {
    let entry = get_entry_in(conn, ent, entry_id).await?;
    let banks: Vec<(i64, i64, String)> =
        sqlx::query_as("SELECT id, ledger_account_id, currency FROM fin_accounts WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?;
    let fee: i64 = match entry.source_line_id {
        Some(sl) => sqlx::query_scalar("SELECT fee_minor FROM fin_source_lines WHERE id = ? AND entity_id = ?")
            .bind(sl)
            .bind(ent.id)
            .fetch_one(&mut *conn)
            .await?,
        None => 0,
    };
    let mut account = None;
    let mut fee_seen = fee == 0;
    let mut counters = Vec::new();
    for l in &entry.lines {
        if let Some(b) = banks.iter().find(|b| b.1 == l.ledger_account_id) {
            account.get_or_insert((b.0, b.2.clone()));
        } else if !fee_seen && l.ledger_account_id == s.fees && l.amount_minor == fee {
            fee_seen = true;
        } else {
            counters.push((l.ledger_account_id, l.amount_minor));
        }
    }
    let Some((account_id, currency)) = account else {
        return Err(AppError::InvalidInput("not a bank entry".into()));
    };
    let amount_minor = -counters.iter().map(|c| c.1).sum::<i64>();
    Ok(BankView { entry, account_id, currency, amount_minor, counters })
}

/// A validation refusal (archived or mismatched category, closed period) that an
/// automatic step skips; anything else, like a database error, aborts the import.
pub(crate) fn skippable(e: &AppError) -> bool {
    e.is_invalid_input() || e.is_not_found()
}

/// True when the entry is one side of a live (not rejected) pair.
pub(crate) async fn is_paired(conn: &mut Conn, entry_id: i64) -> Result<bool> {
    has_live_pair(conn, entry_id).await
}

/// Points the whole counter side of a bank entry at one ledger account.
pub(crate) async fn recounter(conn: &mut Conn, ent: &Entity, v: &BankView, la: i64) -> Result<()> {
    let split = Split { ledger_account_id: la, amount_minor: v.amount_minor, memo: None };
    categorise_in(conn, ent, v.entry.id, vec![split]).await?;
    Ok(())
}

async fn has_live_pair(conn: &mut Conn, entry_id: i64) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS (SELECT 1 FROM fin_pairs WHERE (entry_a = ?1 OR entry_b = ?1) AND status != 'rejected')",
    )
    .bind(entry_id)
    .fetch_one(conn)
    .await?
        == 1)
}

/// Books a pair: both counters to clearing, and for FX the adjusting entry for what's
/// left on clearing. Returns the adjusting entry's id.
async fn book(conn: &mut Conn, ent: &Entity, s: &Sys, a: &BankView, b: &BankView, kind: PairKind) -> Result<Option<i64>> {
    recounter(conn, ent, a, s.clearing).await?;
    recounter(conn, ent, b, s.clearing).await?;
    if kind != PairKind::Fx {
        return Ok(None);
    }
    let residual: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(functional_minor), 0) FROM fin_lines WHERE entry_id IN (?, ?) AND ledger_account_id = ?",
    )
    .bind(a.entry.id)
    .bind(b.entry.id)
    .bind(s.clearing)
    .fetch_one(&mut *conn)
    .await?;
    if residual == 0 {
        return Ok(None);
    }
    let cur = ent.functional_currency.as_str();
    let pnl = if residual > 0 { s.fx_loss } else { s.fx_gain };
    let line = |la: i64, amount: i64| LineInput {
        ledger_account_id: la,
        amount_minor: amount,
        currency: cur.to_string(),
        functional_minor: Some(amount),
        memo: None,
    };
    let date = std::cmp::max(&a.entry.date, &b.entry.date).clone();
    let adjust = create_entry_in(
        conn,
        ent,
        EntryInput {
            date,
            description: "Realised FX difference".into(),
            payee: None,
            notes: None,
            lines: vec![line(s.clearing, -residual), line(pnl, residual)],
        },
    )
    .await?;
    Ok(Some(adjust.id))
}

async fn insert_pair(
    conn: &mut Conn,
    ent: &Entity,
    kind: PairKind,
    a: i64,
    b: i64,
    adjust: Option<i64>,
    status: &str,
    score: f64,
) -> Result<i64> {
    let id = sqlx::query(
        "INSERT INTO fin_pairs (entity_id, kind, entry_a, entry_b, adjust_entry_id, status, score, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(kind.as_str())
    .bind(a)
    .bind(b)
    .bind(adjust)
    .bind(status)
    .bind(score)
    .bind(now())
    .execute(&mut *conn)
    .await?
    .last_insert_rowid();
    let after = serde_json::json!({ "kind": kind.as_str(), "entry_a": a, "entry_b": b, "status": status });
    audit(conn, ent, "create", "pair", Some(id), None, Some(&after)).await?;
    Ok(id)
}

/// What a pairing run did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PairingOutcome {
    pub paired: usize,
    pub review: usize,
}

/// A fresh entry for the pairing run, with what the file said about it.
#[derive(Debug, Clone)]
pub(crate) struct Fresh {
    pub entry_id: i64,
    pub at: Option<NaiveDateTime>,
    pub fx_currency: Option<String>,
    pub counterpart_account: Option<i64>,
}

/// The pairs for fresh entries, with each other and with the entity's unpaired bank
/// entries that are still uncategorised (or on clearing) within the window. Writes
/// nothing: an import reads these on a plain connection, then books them in short
/// transactions ([`book_pairs`]).
pub(crate) async fn plan_pairs(conn: &mut Conn, ent: &Entity, s: &Sys, fresh: &[Fresh]) -> Result<Vec<Proposal>> {
    if fresh.is_empty() {
        return Ok(Vec::new());
    }
    let by_id: HashMap<i64, &Fresh> = fresh.iter().map(|f| (f.entry_id, f)).collect();
    let mut dates = Vec::new();
    for f in fresh {
        dates.push(get_entry_in(conn, ent, f.entry_id).await?.date);
    }
    let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    let (Some(min), Some(max)) = (dates.iter().filter_map(|d| parse(d)).min(), dates.iter().filter_map(|d| parse(d)).max()) else {
        return Ok(Vec::new());
    };
    let mut cands = candidates_in(conn, ent, s, min - Duration::days(TRANSFER_DAYS), max + Duration::days(TRANSFER_DAYS), false, &|_| true).await?;
    for c in &mut cands {
        if let Some(f) = by_id.get(&c.entry_id) {
            c.fresh = true;
            c.at = f.at.or(c.at);
            c.fx_currency = f.fx_currency.clone();
            c.counterpart_account = f.counterpart_account;
        }
    }
    propose_with_rates(conn, &cands).await
}

/// The bank entries between two dates that could still pair: not reversed, on no live
/// pair (or, with `with_review`, on a pair waiting for review), uncategorised or on
/// clearing, and kept by `keep` (on the date). None is fresh yet.
async fn candidates_in(
    conn: &mut Conn,
    ent: &Entity,
    s: &Sys,
    from: NaiveDate,
    to: NaiveDate,
    with_review: bool,
    keep: &(dyn Fn(NaiveDate) -> bool + Sync),
) -> Result<Vec<Candidate>> {
    type Row = (i64, String, i64, i64, String, Option<String>, String, Option<String>, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT e.id, e.date, s.account_id, s.amount_minor, s.currency, s.kind_hint, s.raw_json, s.occurred_at, s.description \
         FROM fin_entries e JOIN fin_source_lines s ON s.id = e.source_line_id \
         WHERE e.entity_id = ? AND e.status != 'reversed' AND e.date BETWEEN ? AND ? \
           AND NOT EXISTS (SELECT 1 FROM fin_pairs p WHERE (p.entry_a = e.id OR p.entry_b = e.id) \
                           AND p.status != 'rejected' AND NOT (? AND p.status = 'review'))",
    )
    .bind(ent.id)
    .bind(from.format("%Y-%m-%d").to_string())
    .bind(to.format("%Y-%m-%d").to_string())
    .bind(with_review)
    .fetch_all(&mut *conn)
    .await?;
    let mut cands = Vec::new();
    for (id, date, account_id, amount, currency, kind, raw, occurred, description) in rows {
        let Ok(date) = NaiveDate::parse_from_str(&date, "%Y-%m-%d") else { continue };
        if !keep(date) {
            continue;
        }
        let v = bank_view(conn, ent, s, id).await?;
        if !(v.is_uncategorised(s) || v.is_clearing(s)) {
            continue;
        }
        cands.push(Candidate {
            entry_id: id,
            account_id,
            date,
            at: at_from_raw(&raw),
            occurred_at: occurred.and_then(|t| NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M:%S").ok()),
            description,
            amount_minor: amount,
            currency,
            kind_hint: kind,
            fx_currency: None,
            counterpart_account: None,
            fresh: false,
        });
    }
    Ok(cands)
}

/// [`propose_pairs`], with the ECB rates for the FX plausibility check read up front
/// (the matcher is pure).
async fn propose_with_rates(conn: &mut Conn, cands: &[Candidate]) -> Result<Vec<Proposal>> {
    let mut spot: Vec<((String, String, NaiveDate), f64)> = Vec::new();
    for a in cands.iter().filter(|c| c.kind_hint.as_deref() == Some("exchange")) {
        for b in cands.iter().filter(|c| c.kind_hint.as_deref() == Some("exchange") && c.currency != a.currency) {
            let key = (a.currency.clone(), b.currency.clone(), a.date);
            if spot.iter().any(|(k, _)| *k == key) {
                continue;
            }
            let date = a.date.format("%Y-%m-%d").to_string();
            if let Ok((_, rate)) = rates::translate_in(conn, 0, &a.currency, &b.currency, &date).await {
                spot.push((key, rate));
            }
        }
    }
    let ecb = |f: &str, t: &str, d: NaiveDate| {
        spot.iter().find(|((a, b, dd), _)| a == f && b == t && *dd == d).map(|(_, r)| *r)
    };
    Ok(propose_pairs(cands, &ecb))
}

/// Books proposed pairs. A side that got paired or categorised since the proposal was
/// made (the user working while an import runs) is skipped.
pub(crate) async fn book_pairs(conn: &mut Conn, ent: &Entity, s: &Sys, proposals: &[Proposal]) -> Result<PairingOutcome> {
    let mut out = PairingOutcome::default();
    for p in proposals {
        if has_live_pair(conn, p.a).await? || has_live_pair(conn, p.b).await? {
            continue;
        }
        let a = bank_view(conn, ent, s, p.a).await?;
        let b = bank_view(conn, ent, s, p.b).await?;
        if ![&a, &b].iter().all(|v| v.is_uncategorised(s) || v.is_clearing(s)) {
            continue;
        }
        if p.auto {
            let adjust = book(conn, ent, s, &a, &b, p.kind).await?;
            insert_pair(conn, ent, p.kind, p.a, p.b, adjust, "auto", p.score).await?;
            out.paired += 1;
        } else {
            insert_pair(conn, ent, p.kind, p.a, p.b, None, "review", p.score).await?;
            out.review += 1;
        }
    }
    Ok(out)
}

/// For a pocket move whose pocket side wasn't in the file, writes that side on the
/// pocket's account and pairs the two. Returns whether it did.
pub(crate) async fn write_counterpart(conn: &mut Conn, ent: &Entity, s: &Sys, entry_id: i64, pocket_account: i64) -> Result<bool> {
    if has_live_pair(conn, entry_id).await? {
        return Ok(false);
    }
    let v = bank_view(conn, ent, s, entry_id).await?;
    if v.account_id == pocket_account || !v.is_uncategorised(s) {
        return Ok(false);
    }
    let draft = BankDraft {
        account_id: pocket_account,
        date: v.entry.date.clone(),
        description: v.entry.description.clone(),
        payee: None,
        amount_minor: -v.amount_minor,
        fee_minor: 0,
        counter_ledger_account_id: s.clearing,
        source_line_id: None,
        functional_minor: None,
    };
    let other = create_bank_draft_in(conn, ent, draft).await?;
    sqlx::query("UPDATE fin_entries SET notes = ? WHERE id = ?").bind(COUNTERPART_NOTE).bind(other.id).execute(&mut *conn).await?;
    recounter(conn, ent, &v, s.clearing).await?;
    insert_pair(conn, ent, PairKind::Transfer, entry_id, other.id, None, "auto", 1.0).await?;
    Ok(true)
}

/// A counterpart the import wrote earlier that this new source line is the real
/// version of: same account, amount and nearby date, with no source line yet.
pub(crate) async fn find_written_counterpart(
    conn: &mut Conn,
    ent: &Entity,
    s: &Sys,
    account_id: i64,
    date: &str,
    amount_minor: i64,
) -> Result<Option<i64>> {
    let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else { return Ok(None) };
    let from = (d - Duration::days(TRANSFER_DAYS)).format("%Y-%m-%d").to_string();
    let to = (d + Duration::days(TRANSFER_DAYS)).format("%Y-%m-%d").to_string();
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM fin_entries WHERE entity_id = ? AND source_line_id IS NULL AND notes = ? \
         AND date BETWEEN ? AND ? ORDER BY ABS(julianday(date) - julianday(?)), id",
    )
    .bind(ent.id)
    .bind(COUNTERPART_NOTE)
    .bind(&from)
    .bind(&to)
    .bind(date)
    .fetch_all(&mut *conn)
    .await?;
    for id in ids {
        let v = bank_view(conn, ent, s, id).await?;
        if v.account_id == account_id && v.amount_minor == amount_minor {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Gives each fresh, uncategorised money-in entry the category of the earlier expense
/// it refunds: the same merchant within [`REFUND_DAYS`], when the bank calls it a refund
/// or it's no larger than that expense. Returns how many it categorised.
pub(crate) async fn match_refunds(conn: &mut Conn, ent: &Entity, s: &Sys, fresh: &[i64]) -> Result<usize> {
    let mut done = 0;
    for &id in fresh {
        if has_live_pair(conn, id).await? {
            continue;
        }
        let v = bank_view(conn, ent, s, id).await?;
        if v.amount_minor <= 0 || !v.is_uncategorised(s) {
            continue;
        }
        let Some(sl) = v.entry.source_line_id else { continue };
        let (description, payee, kind): (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT description, payee, kind_hint FROM fin_source_lines WHERE id = ?").bind(sl).fetch_one(&mut *conn).await?;
        let key = merchant_key(&description, payee.as_deref());
        if key.is_empty() {
            continue;
        }
        let from = NaiveDate::parse_from_str(&v.entry.date, "%Y-%m-%d")
            .map(|d| (d - Duration::days(REFUND_DAYS)).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let earlier: Vec<(i64, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT e.id, s.description, s.payee, s.amount_minor FROM fin_entries e \
             JOIN fin_source_lines s ON s.id = e.source_line_id \
             WHERE e.entity_id = ? AND e.id != ? AND s.amount_minor < 0 AND s.currency = ? \
               AND e.date BETWEEN ? AND ? AND e.status != 'reversed' \
             ORDER BY e.date DESC, e.id DESC",
        )
        .bind(ent.id)
        .bind(id)
        .bind(&v.currency)
        .bind(&from)
        .bind(&v.entry.date)
        .fetch_all(&mut *conn)
        .await?;
        let refund_kind = kind.as_deref() == Some("refund");
        for (eid, d, p, amount) in earlier {
            if merchant_key(&d, p.as_deref()) != key || !(refund_kind || v.amount_minor <= -amount) {
                continue;
            }
            let orig = bank_view(conn, ent, s, eid).await?;
            let Some(category) = orig.main_category(s) else { continue };
            match recounter(conn, ent, &v, category).await {
                Ok(()) => done += 1,
                Err(e) if skippable(&e) => {}
                Err(e) => return Err(e),
            }
            break;
        }
    }
    Ok(done)
}

/// Deletes an entry the matcher wrote (an adjusting entry or a pocket's side) when its
/// pair is rejected. These have no source line to dismiss.
async fn delete_written_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<()> {
    let before = get_entry_in(conn, ent, id).await?;
    super::require_open(conn, ent, &before.date).await?;
    sqlx::query("DELETE FROM fin_lines WHERE entry_id = ?").bind(id).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM fin_entries WHERE id = ? AND entity_id = ?").bind(id).bind(ent.id).execute(&mut *conn).await?;
    audit(conn, ent, "delete", "entry", Some(id), Some(&serde_json::to_value(&before)?), None).await?;
    Ok(())
}

// ============== Pair commands ==============

/// A pair with both of its entries.
#[derive(Debug, Clone, Serialize)]
pub struct Pair {
    pub id: i64,
    pub kind: String,
    pub status: String,
    pub score: f64,
    pub adjust_entry_id: Option<i64>,
    pub created_at: String,
    pub entry_a: Entry,
    pub entry_b: Entry,
    /// What "all like this" groups by: the kind, both bank accounts and the pattern of
    /// each side's description ([`description_key`]). Filled in by [`list_pairs`].
    pub like_key: String,
}

type PairRow = (i64, String, i64, i64, Option<i64>, String, f64, String);

async fn get_pair_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Pair> {
    let r: PairRow = sqlx::query_as(
        "SELECT id, kind, entry_a, entry_b, adjust_entry_id, status, score, created_at FROM fin_pairs WHERE id = ? AND entity_id = ?",
    )
    .bind(id)
    .bind(ent.id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| not_found("pair"))?;
    Ok(Pair {
        id: r.0,
        kind: r.1,
        entry_a: get_entry_in(conn, ent, r.2).await?,
        entry_b: get_entry_in(conn, ent, r.3).await?,
        adjust_entry_id: r.4,
        status: r.5,
        score: r.6,
        created_at: r.7,
        like_key: String::new(),
    })
}

/// The entity's pairs, newest first, optionally by status.
pub async fn list_pairs(db: &Db, ent: &Entity, status: Option<&str>) -> Result<Vec<Pair>> {
    if let Some(st) = status {
        if !["auto", "review", "confirmed", "rejected"].contains(&st) {
            return Err(AppError::InvalidInput("unknown pair status".into()));
        }
    }
    let mut conn = db.acquire().await?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM fin_pairs WHERE entity_id = ? AND (?2 IS NULL OR status = ?2) ORDER BY id DESC LIMIT 500",
    )
    .bind(ent.id)
    .bind(status)
    .fetch_all(&mut *conn)
    .await?;
    let banks: HashMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>("SELECT ledger_account_id, id FROM fin_accounts WHERE entity_id = ?")
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let mut p = get_pair_in(&mut conn, ent, id).await?;
        p.like_key = like_key(&p, &banks);
        out.push(p);
    }
    Ok(out)
}

/// [`Pair::like_key`]: the sides ordered by bank account, so either order matches.
fn like_key(p: &Pair, banks: &HashMap<i64, i64>) -> String {
    let side = |e: &Entry| {
        let account = e.lines.iter().find_map(|l| banks.get(&l.ledger_account_id)).copied().unwrap_or(0);
        (account, description_key(&e.description))
    };
    let mut sides = [side(&p.entry_a), side(&p.entry_b)];
    sides.sort();
    format!("{}:{}:{}|{}:{}", p.kind, sides[0].0, sides[0].1, sides[1].0, sides[1].1)
}

/// Accept or reject a pair. Accepting books it (both to clearing, FX adjusted) unless it
/// already is; rejecting undoes the booking: the entries go back to uncategorised, the
/// adjusting entry and any side the import wrote are deleted.
pub async fn resolve_pair(db: &Db, ent: &Entity, id: i64, accept: bool) -> Result<Pair> {
    let mut tx = db.begin().await?;
    let pair = get_pair_in(&mut tx, ent, id).await?;
    let s = sys(&mut tx, ent).await?;
    let kind = if pair.kind == "fx" { PairKind::Fx } else { PairKind::Transfer };
    let booked = matches!(pair.status.as_str(), "auto" | "confirmed");
    if accept {
        if pair.status == "rejected" {
            return Err(AppError::InvalidInput("that pair was rejected: pair the entries again".into()));
        }
        let mut adjust = pair.adjust_entry_id;
        if !booked {
            let a = bank_view(&mut tx, ent, &s, pair.entry_a.id).await?;
            let b = bank_view(&mut tx, ent, &s, pair.entry_b.id).await?;
            // Categorised since the match was proposed: the user's choice stands.
            if [&a, &b].iter().any(|v| !(v.is_uncategorised(&s) || v.is_clearing(&s))) {
                return Err(AppError::InvalidInput("one of the entries has been categorised since: pair them by hand".into()));
            }
            adjust = book(&mut tx, ent, &s, &a, &b, kind).await?;
        }
        sqlx::query("UPDATE fin_pairs SET status = 'confirmed', adjust_entry_id = ? WHERE id = ?")
            .bind(adjust)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    } else {
        // Mark it first: deleting a side the import wrote takes the pair row with it.
        sqlx::query("UPDATE fin_pairs SET status = 'rejected', adjust_entry_id = NULL WHERE id = ?").bind(id).execute(&mut *tx).await?;
        if booked {
            if let Some(adj) = pair.adjust_entry_id {
                delete_written_in(&mut tx, ent, adj).await?;
            }
            for e in [&pair.entry_a, &pair.entry_b] {
                if e.source_line_id.is_none() && e.notes.as_deref() == Some(COUNTERPART_NOTE) {
                    delete_written_in(&mut tx, ent, e.id).await?;
                } else {
                    let v = bank_view(&mut tx, ent, &s, e.id).await?;
                    recounter(&mut tx, ent, &v, s.uncategorised_for(v.amount_minor)).await?;
                }
            }
        }
    }
    let after = serde_json::json!({ "status": if accept { "confirmed" } else { "rejected" } });
    audit(&mut tx, ent, if accept { "confirm" } else { "reject" }, "pair", Some(id), Some(&serde_json::json!({ "status": pair.status })), Some(&after))
        .await?;
    // A pair whose written side was deleted is gone: answer with what it was.
    let out = match get_pair_in(&mut tx, ent, id).await {
        Ok(p) => p,
        Err(e) if e.is_not_found() => Pair { status: "rejected".into(), adjust_entry_id: None, ..pair },
        Err(e) => return Err(e),
    };
    tx.commit().await?;
    Ok(out)
}

/// Pair two bank entries by hand. Same-currency legs must cancel exactly; legs in two
/// currencies make an FX pair with its adjusting entry.
pub async fn pair_entries(db: &Db, ent: &Entity, entry_a: i64, entry_b: i64) -> Result<Pair> {
    if entry_a == entry_b {
        return Err(AppError::InvalidInput("pick two different entries".into()));
    }
    let mut tx = db.begin().await?;
    let s = sys(&mut tx, ent).await?;
    let a = bank_view(&mut tx, ent, &s, entry_a).await?;
    let b = bank_view(&mut tx, ent, &s, entry_b).await?;
    for v in [&a, &b] {
        if has_live_pair(&mut tx, v.entry.id).await? {
            return Err(AppError::InvalidInput("one of the entries is already paired".into()));
        }
        if v.entry.status == "reversed" || v.entry.reverses_id.is_some() {
            return Err(AppError::InvalidInput("a reversed entry or a reversal can't be paired".into()));
        }
    }
    if a.account_id == b.account_id {
        return Err(AppError::InvalidInput("a transfer moves money between two accounts".into()));
    }
    if a.amount_minor.signum() == b.amount_minor.signum() {
        return Err(AppError::InvalidInput("one entry must be money out and the other money in".into()));
    }
    let kind = if a.currency == b.currency {
        if a.amount_minor != -b.amount_minor {
            return Err(AppError::InvalidInput("the amounts don't match".into()));
        }
        PairKind::Transfer
    } else {
        PairKind::Fx
    };
    let adjust = book(&mut tx, ent, &s, &a, &b, kind).await?;
    let id = insert_pair(&mut tx, ent, kind, entry_a, entry_b, adjust, "confirmed", 1.0).await?;
    let out = get_pair_in(&mut tx, ent, id).await?;
    tx.commit().await?;
    Ok(out)
}

/// What a bulk resolve did: pairs resolved, and pairs skipped (gone, not the user's,
/// or with an entry categorised since).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct BulkOutcome {
    pub resolved: usize,
    pub skipped: usize,
}

/// The most pairs one bulk resolve takes.
pub const BULK_MAX: usize = 1000;

/// Accept or reject many pairs at once, each as [`resolve_pair`] does, in its own short
/// transaction. A pair that can't be resolved is skipped, not fatal.
pub async fn resolve_pairs(db: &Db, ent: &Entity, ids: &[i64], accept: bool) -> Result<BulkOutcome> {
    if ids.len() > BULK_MAX {
        return Err(AppError::InvalidInput(format!("at most {BULK_MAX} pairs at once")));
    }
    let mut seen = HashSet::new();
    let mut out = BulkOutcome::default();
    for &id in ids.iter().filter(|id| seen.insert(**id)) {
        match resolve_pair(db, ent, id, accept).await {
            Ok(_) => out.resolved += 1,
            Err(e) if skippable(&e) => out.skipped += 1,
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// What a re-score did: pairs it booked, and how many still wait for review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RescoreOutcome {
    pub confirmed: usize,
    pub review: usize,
}

/// Re-scores the pairs waiting for review with the current rules, and books the ones
/// that now qualify. A better match for a waiting leg replaces its pair; a leg freed
/// that way pairs again if it can. Runs passes until nothing changes, so running it
/// again does nothing.
pub async fn rescore_pairs(db: &Db, ent: &Entity) -> Result<RescoreOutcome> {
    let mut out = RescoreOutcome::default();
    let mut loose: HashSet<i64> = HashSet::new();
    // Each pass that changes something books a pair or pairs a freed leg, so this ends;
    // the cap is only a guard.
    for _ in 0..100 {
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let (changed, confirmed) = rescore_pass(&mut tx, ent, &mut loose).await?;
        tx.commit().await?;
        out.confirmed += confirmed;
        if !changed {
            break;
        }
    }
    out.review = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM fin_pairs WHERE entity_id = ? AND status = 'review'")
        .bind(ent.id)
        .fetch_one(db)
        .await? as usize;
    Ok(out)
}

/// Books a proposal inside a savepoint. `None` when a side can't take it (a closed
/// month), with nothing written.
async fn try_book(conn: &mut Conn, ent: &Entity, s: &Sys, p: &Proposal) -> Result<Option<Option<i64>>> {
    use sqlx::Connection;
    let mut sp = conn.begin().await?;
    let booked = async {
        let a = bank_view(&mut sp, ent, s, p.a).await?;
        let b = bank_view(&mut sp, ent, s, p.b).await?;
        book(&mut sp, ent, s, &a, &b, p.kind).await
    }
    .await;
    match booked {
        Ok(adjust) => {
            sp.commit().await?;
            Ok(Some(adjust))
        }
        Err(e) if skippable(&e) => {
            sp.rollback().await?;
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// One re-score pass. Returns whether it changed which pairs exist or their status,
/// and how many it booked.
async fn rescore_pass(conn: &mut Conn, ent: &Entity, loose: &mut HashSet<i64>) -> Result<(bool, usize)> {
    let review: Vec<(i64, i64, i64, f64)> =
        sqlx::query_as("SELECT id, entry_a, entry_b, score FROM fin_pairs WHERE entity_id = ? AND status = 'review'")
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?;
    if review.is_empty() && loose.is_empty() {
        return Ok((false, 0));
    }
    let s = sys(conn, ent).await?;
    let mut by_leg: HashMap<i64, (i64, i64, i64, f64)> = HashMap::new();
    for r in &review {
        by_leg.insert(r.1, *r);
        by_leg.insert(r.2, *r);
    }
    let legs: HashSet<i64> = by_leg.keys().chain(loose.iter()).copied().collect();
    // Look around each waiting leg far enough to see its rivals' other legs too.
    let mut window: HashSet<NaiveDate> = HashSet::new();
    for &leg in &legs {
        let date: Option<String> = sqlx::query_scalar("SELECT date FROM fin_entries WHERE id = ? AND entity_id = ?")
            .bind(leg)
            .bind(ent.id)
            .fetch_optional(&mut *conn)
            .await?;
        if let Some(d) = date.and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()) {
            for k in -2 * TRANSFER_DAYS..=2 * TRANSFER_DAYS {
                window.insert(d + Duration::days(k));
            }
        }
    }
    let (Some(&from), Some(&to)) = (window.iter().min(), window.iter().max()) else {
        return Ok((false, 0));
    };
    let mut cands = candidates_in(conn, ent, &s, from, to, true, &|d| window.contains(&d)).await?;
    for c in &mut cands {
        c.fresh = true;
    }
    let proposals = propose_with_rates(conn, &cands).await?;
    let (mut changed, mut confirmed) = (false, 0);
    let mut gone: HashSet<i64> = HashSet::new();
    for p in proposals {
        if !(legs.contains(&p.a) || legs.contains(&p.b)) {
            continue;
        }
        let mut existing: Vec<(i64, i64, i64, f64)> = Vec::new();
        for leg in [p.a, p.b] {
            if let Some(r) = by_leg.get(&leg).filter(|r| !gone.contains(&r.0)) {
                if !existing.iter().any(|e| e.0 == r.0) {
                    existing.push(*r);
                }
            }
        }
        let exact = matches!(existing.as_slice(), [e] if (e.1 == p.a && e.2 == p.b) || (e.1 == p.b && e.2 == p.a));
        if exact {
            let (id, _, _, score) = existing[0];
            if p.auto {
                let Some(adjust) = try_book(conn, ent, &s, &p).await? else { continue };
                sqlx::query("UPDATE fin_pairs SET status = 'auto', score = ?, adjust_entry_id = ? WHERE id = ?")
                    .bind(p.score)
                    .bind(adjust)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                let before = serde_json::json!({ "status": "review", "score": score });
                let after = serde_json::json!({ "status": "auto", "score": p.score });
                audit(conn, ent, "rescore", "pair", Some(id), Some(&before), Some(&after)).await?;
                changed = true;
                confirmed += 1;
            } else if (score - p.score).abs() > 1e-9 {
                sqlx::query("UPDATE fin_pairs SET score = ? WHERE id = ?").bind(p.score).bind(id).execute(&mut *conn).await?;
            }
        } else if p.auto {
            let Some(adjust) = try_book(conn, ent, &s, &p).await? else { continue };
            for (id, a, b, _) in &existing {
                sqlx::query("DELETE FROM fin_pairs WHERE id = ? AND entity_id = ?").bind(id).bind(ent.id).execute(&mut *conn).await?;
                let before = serde_json::json!({ "status": "review", "entry_a": a, "entry_b": b });
                audit(conn, ent, "delete", "pair", Some(*id), Some(&before), None).await?;
                gone.insert(*id);
                loose.extend([*a, *b].into_iter().filter(|e| *e != p.a && *e != p.b));
            }
            insert_pair(conn, ent, p.kind, p.a, p.b, adjust, "auto", p.score).await?;
            loose.remove(&p.a);
            loose.remove(&p.b);
            changed = true;
            confirmed += 1;
        } else if existing.is_empty() {
            insert_pair(conn, ent, p.kind, p.a, p.b, None, "review", p.score).await?;
            loose.remove(&p.a);
            loose.remove(&p.b);
            changed = true;
        }
    }
    Ok((changed, confirmed))
}

/// The version of the pairing rules the waiting pairs were last re-scored with.
const RULES_KEY: &str = "fin_pairing_rules";
const RULES_VERSION: &str = "2";

/// Re-scores every entity's waiting pairs once after the pairing rules change.
/// Idempotent; runs at startup. A failure leaves the marker unset, so the next start
/// tries again, and never stops the host from starting.
pub(crate) async fn rescore_at_startup(pool: &Db) {
    let done: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(RULES_KEY)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if done.as_deref() == Some(RULES_VERSION) {
        return;
    }
    let ids: Vec<i64> = match sqlx::query_scalar("SELECT DISTINCT entity_id FROM fin_pairs WHERE status = 'review'").fetch_all(pool).await {
        Ok(ids) => ids,
        Err(_) => return,
    };
    let mut all_done = true;
    for id in ids {
        let ent: Option<Entity> = sqlx::query_as("SELECT * FROM fin_entities WHERE id = ?").bind(id).fetch_optional(pool).await.ok().flatten();
        let Some(ent) = ent else { continue };
        // One entity's failure doesn't hold up the others.
        all_done &= rescore_pairs(pool, &ent).await.is_ok();
    }
    if !all_done {
        return;
    }
    let _ = sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(RULES_KEY)
        .bind(RULES_VERSION)
        .execute(pool)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: i64, account: i64, date: &str, amount: i64, cur: &str, kind: Option<&str>) -> Candidate {
        Candidate {
            entry_id: id,
            account_id: account,
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            at: None,
            occurred_at: None,
            description: String::new(),
            amount_minor: amount,
            currency: cur.into(),
            kind_hint: kind.map(String::from),
            fx_currency: None,
            counterpart_account: None,
            fresh: true,
        }
    }

    fn none(_: &str, _: &str, _: NaiveDate) -> Option<f64> {
        None
    }

    #[test]
    fn transfers_pair_on_amount_currency_and_date() {
        let cands = vec![
            c(1, 10, "2026-10-01", -5_000, "EUR", Some("transfer")),
            c(2, 20, "2026-10-02", 5_000, "EUR", Some("transfer")),
            c(3, 30, "2026-10-01", 5_000, "GBP", Some("transfer")),
            c(4, 40, "2026-10-09", 5_000, "EUR", Some("transfer")),
        ];
        let p = propose_pairs(&cands, &none);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].a, p[0].b, p[0].kind), (1, 2, PairKind::Transfer));
        assert!(p[0].auto, "score {}", p[0].score);
    }

    #[test]
    fn a_rival_sends_the_match_to_review() {
        let cands = vec![
            c(1, 10, "2026-10-01", -5_000, "EUR", Some("transfer")),
            c(2, 20, "2026-10-01", 5_000, "EUR", Some("transfer")),
            c(3, 30, "2026-10-01", 5_000, "EUR", Some("transfer")),
        ];
        let p = propose_pairs(&cands, &none);
        assert_eq!(p.len(), 1);
        assert!(!p[0].auto);
    }

    #[test]
    fn plain_card_lines_only_go_to_review() {
        let cands = vec![c(1, 10, "2026-10-01", -2_000, "EUR", Some("card")), c(2, 20, "2026-10-01", 2_000, "EUR", None)];
        let p = propose_pairs(&cands, &none);
        assert_eq!(p.len(), 1);
        assert!(!p[0].auto);
    }

    #[test]
    fn same_account_and_stale_legs_never_pair() {
        let mut a = c(1, 10, "2026-10-01", -100, "EUR", Some("transfer"));
        let mut b = c(2, 10, "2026-10-01", 100, "EUR", Some("transfer"));
        assert!(propose_pairs(&[a.clone(), b.clone()], &none).is_empty());
        b.account_id = 20;
        a.fresh = false;
        b.fresh = false;
        assert!(propose_pairs(&[a, b], &none).is_empty());
    }

    #[test]
    fn fx_legs_pair_by_time_and_rate() {
        let t = |s: &str| Some(NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap());
        let mut eur = c(1, 10, "2026-10-01", -1_000, "EUR", Some("exchange"));
        eur.fx_currency = Some("GBP".into());
        eur.at = t("2026-10-01 10:00:00");
        let mut gbp = c(2, 20, "2026-10-01", 861, "GBP", Some("exchange"));
        gbp.at = t("2026-10-01 10:00:01");
        let mut later = gbp.clone();
        later.entry_id = 3;
        later.at = t("2026-10-01 18:00:00");
        let ecb = |f: &str, t: &str, _: NaiveDate| (f == "EUR" && t == "GBP").then_some(0.85);
        let p = propose_pairs(&[eur.clone(), gbp.clone(), later], &ecb);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].a, p[0].b, p[0].kind), (1, 2, PairKind::Fx));
        assert!(p[0].auto);
        // A rate far from the ECB's is no FX pair.
        let ecb_far = |_: &str, _: &str, _: NaiveDate| Some(1.5);
        assert!(propose_pairs(&[eur, gbp], &ecb_far).is_empty());
    }

    #[test]
    fn pocket_counterpart_lifts_the_score() {
        let mut a = c(1, 10, "2026-10-03", -100, "EUR", Some("card"));
        let b = c(2, 20, "2026-10-01", 100, "EUR", None);
        let low = propose_pairs(&[a.clone(), b.clone()], &none)[0].score;
        a.counterpart_account = Some(20);
        let high = propose_pairs(&[a, b], &none)[0].score;
        assert!(high > low + 0.25);
    }

    fn ts(s: &str) -> Option<NaiveDateTime> {
        Some(NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap())
    }

    fn timed(mut x: Candidate, at: &str) -> Candidate {
        x.occurred_at = ts(at);
        x
    }

    fn pairs_of(p: &[Proposal]) -> Vec<(i64, i64, bool)> {
        let mut v: Vec<_> = p.iter().map(|p| (p.a.min(p.b), p.a.max(p.b), p.auto)).collect();
        v.sort();
        v
    }

    #[test]
    fn the_same_moment_settles_it_over_rivals() {
        let cands = vec![
            timed(c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer")), "2026-10-01 10:00:00"),
            timed(c(2, 20, "2026-10-01", 3_000, "EUR", Some("transfer")), "2026-10-01 10:00:30"),
            timed(c(3, 30, "2026-10-01", 3_000, "EUR", Some("transfer")), "2026-10-01 16:00:00"),
        ];
        let p = propose_pairs(&cands, &none);
        assert_eq!(pairs_of(&p), vec![(1, 2, true)]);
        assert_eq!(p[0].score, 1.0);
    }

    #[test]
    fn the_same_moment_counts_across_midnight() {
        let cands = vec![
            timed(c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer")), "2026-10-01 23:59:50"),
            timed(c(2, 20, "2026-10-02", 3_000, "EUR", Some("transfer")), "2026-10-02 00:00:10"),
            timed(c(3, 20, "2026-10-01", 3_000, "EUR", Some("transfer")), "2026-10-01 08:00:00"),
        ];
        assert_eq!(pairs_of(&propose_pairs(&cands, &none)), vec![(1, 2, true)]);
    }

    #[test]
    fn identical_legs_pair_in_line_order_without_asking() {
        // Two moves of the same amount between the same accounts on one day.
        let cands = vec![
            c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer")),
            c(2, 10, "2026-10-01", -3_000, "EUR", Some("transfer")),
            c(3, 20, "2026-10-01", 3_000, "EUR", Some("transfer")),
            c(4, 20, "2026-10-01", 3_000, "EUR", Some("transfer")),
        ];
        assert_eq!(pairs_of(&propose_pairs(&cands, &none)), vec![(1, 3, true), (2, 4, true)]);
    }

    #[test]
    fn identical_legs_pair_by_the_banks_time() {
        let cands = vec![
            timed(c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer")), "2026-10-01 09:00:00"),
            timed(c(2, 10, "2026-10-01", -3_000, "EUR", Some("transfer")), "2026-10-01 18:00:00"),
            timed(c(3, 20, "2026-10-01", 3_000, "EUR", Some("transfer")), "2026-10-01 18:00:00"),
            timed(c(4, 20, "2026-10-01", 3_000, "EUR", Some("transfer")), "2026-10-01 09:00:00"),
        ];
        assert_eq!(pairs_of(&propose_pairs(&cands, &none)), vec![(1, 4, true), (2, 3, true)]);
    }

    #[test]
    fn the_same_amount_to_two_accounts_still_asks() {
        let out = c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer"));
        let to_b = c(2, 20, "2026-10-01", 3_000, "EUR", Some("transfer"));
        let to_c = c(3, 30, "2026-10-01", 3_000, "EUR", Some("transfer"));
        let p = propose_pairs(&[out.clone(), to_b.clone(), to_c.clone()], &none);
        assert!(!p[0].auto);
        // Stamped at the same moment, too: still two candidates.
        let at = "2026-10-01 10:00:00";
        let p = propose_pairs(&[timed(out, at), timed(to_b, at), timed(to_c, at)], &none);
        assert!(!p[0].auto);
    }

    #[test]
    fn a_rival_on_another_day_still_asks() {
        let cands = vec![
            c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer")),
            c(2, 20, "2026-10-01", 3_000, "EUR", Some("transfer")),
            c(3, 20, "2026-10-02", 3_000, "EUR", Some("transfer")),
        ];
        let p = propose_pairs(&cands, &none);
        assert_eq!(pairs_of(&p), vec![(1, 2, false)]);
    }

    #[test]
    fn matching_descriptions_lift_the_score_a_little() {
        let mut a = c(1, 10, "2026-10-01", -3_000, "EUR", Some("transfer"));
        let mut b = c(2, 20, "2026-10-02", 3_000, "EUR", Some("transfer"));
        let low = propose_pairs(&[a.clone(), b.clone()], &none)[0].score;
        a.description = "To pocket Rent".into();
        b.description = "From pocket Rent".into();
        let high = propose_pairs(&[a, b], &none)[0].score;
        assert!((high - low - 0.05).abs() < 1e-9, "{low} {high}");
        assert_eq!(description_key("Pocket Withdrawal"), description_key("pocket  withdrawal"));
        assert_eq!(description_key("Transfer 12345 Rent"), "transfer rent");
    }

    #[test]
    fn booking_time_from_the_raw_row() {
        assert_eq!(
            at_from_raw(r#"{"Completed Date":"2026-10-01 12:00:00"}"#),
            NaiveDateTime::parse_from_str("2026-10-01 12:00:00", "%Y-%m-%d %H:%M:%S").ok()
        );
        assert_eq!(at_from_raw(r#"{"Transaction Date":"01/10/2026"}"#), None);
    }
}
