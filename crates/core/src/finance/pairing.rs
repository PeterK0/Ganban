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

use std::collections::HashSet;

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
    pub at: Option<NaiveDateTime>,
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

fn transfer_score(a: &Candidate, b: &Candidate) -> Option<f64> {
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
    Some(f64::min(s, 1.0))
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

/// Proposes pairs among the candidates, best first. Each entry joins at most one
/// pair, and one with a rival within 0.1 of its score goes to review.
pub fn propose_pairs(c: &[Candidate], ecb: &dyn Fn(&str, &str, NaiveDate) -> Option<f64>) -> Vec<Proposal> {
    let mut all: Vec<Proposal> = Vec::new();
    for i in 0..c.len() {
        for j in i + 1..c.len() {
            let (a, b) = (&c[i], &c[j]);
            if a.account_id == b.account_id || !(a.fresh || b.fresh) {
                continue;
            }
            if let Some(score) = transfer_score(a, b) {
                all.push(Proposal { a: a.entry_id, b: b.entry_id, kind: PairKind::Transfer, score, auto: false });
            } else if let Some(score) = fx_score(a, b, ecb) {
                all.push(Proposal { a: a.entry_id, b: b.entry_id, kind: PairKind::Fx, score, auto: false });
            }
        }
    }
    all.sort_by(|x, y| y.score.total_cmp(&x.score).then(x.a.cmp(&y.a)).then(x.b.cmp(&y.b)));
    let mut taken: HashSet<i64> = HashSet::new();
    let mut out = Vec::new();
    for p in &all {
        if taken.contains(&p.a) || taken.contains(&p.b) {
            continue;
        }
        let rival = all.iter().any(|q| {
            !std::ptr::eq(p, q)
                && (q.a == p.a || q.b == p.b || q.a == p.b || q.b == p.a)
                && !taken.contains(&q.a)
                && !taken.contains(&q.b)
                && q.score >= p.score - 0.1
        });
        taken.insert(p.a);
        taken.insert(p.b);
        out.push(Proposal { auto: p.score >= AUTO_SCORE && !rival, ..p.clone() });
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

/// Pairs fresh entries with each other and with the entity's unpaired bank entries
/// that are still uncategorised (or on clearing) within the window.
pub(crate) async fn pair_fresh(conn: &mut Conn, ent: &Entity, s: &Sys, fresh: &[Fresh]) -> Result<PairingOutcome> {
    let mut out = PairingOutcome::default();
    if fresh.is_empty() {
        return Ok(out);
    }
    let fresh_ids: HashSet<i64> = fresh.iter().map(|f| f.entry_id).collect();
    let dates: Vec<String> = {
        let mut v = Vec::new();
        for f in fresh {
            v.push(get_entry_in(conn, ent, f.entry_id).await?.date);
        }
        v
    };
    let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    let (Some(min), Some(max)) = (dates.iter().filter_map(|d| parse(d)).min(), dates.iter().filter_map(|d| parse(d)).max()) else {
        return Ok(out);
    };
    let from = (min - Duration::days(TRANSFER_DAYS)).format("%Y-%m-%d").to_string();
    let to = (max + Duration::days(TRANSFER_DAYS)).format("%Y-%m-%d").to_string();
    type Row = (i64, String, i64, i64, String, Option<String>, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT e.id, e.date, s.account_id, s.amount_minor, s.currency, s.kind_hint, s.raw_json \
         FROM fin_entries e JOIN fin_source_lines s ON s.id = e.source_line_id \
         WHERE e.entity_id = ? AND e.status != 'reversed' AND e.date BETWEEN ? AND ? \
           AND NOT EXISTS (SELECT 1 FROM fin_pairs p WHERE (p.entry_a = e.id OR p.entry_b = e.id) AND p.status != 'rejected')",
    )
    .bind(ent.id)
    .bind(&from)
    .bind(&to)
    .fetch_all(&mut *conn)
    .await?;
    let mut cands = Vec::new();
    for (id, date, account_id, amount, currency, kind, raw) in rows {
        let v = bank_view(conn, ent, s, id).await?;
        if !(v.is_uncategorised(s) || v.is_clearing(s)) {
            continue;
        }
        let f = fresh.iter().find(|f| f.entry_id == id);
        cands.push(Candidate {
            entry_id: id,
            account_id,
            date: parse(&date).unwrap_or(min),
            at: f.and_then(|f| f.at).or_else(|| at_from_raw(&raw)),
            amount_minor: amount,
            currency,
            kind_hint: kind,
            fx_currency: f.and_then(|f| f.fx_currency.clone()),
            counterpart_account: f.and_then(|f| f.counterpart_account),
            fresh: fresh_ids.contains(&id),
        });
    }
    // ECB rates for the FX plausibility check, read up front (the matcher is pure).
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
    for p in propose_pairs(&cands, &ecb) {
        let a = bank_view(conn, ent, s, p.a).await?;
        let b = bank_view(conn, ent, s, p.b).await?;
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
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(get_pair_in(&mut conn, ent, id).await?);
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: i64, account: i64, date: &str, amount: i64, cur: &str, kind: Option<&str>) -> Candidate {
        Candidate {
            entry_id: id,
            account_id: account,
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            at: None,
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

    #[test]
    fn booking_time_from_the_raw_row() {
        assert_eq!(
            at_from_raw(r#"{"Completed Date":"2026-10-01 12:00:00"}"#),
            NaiveDateTime::parse_from_str("2026-10-01 12:00:00", "%Y-%m-%d %H:%M:%S").ok()
        );
        assert_eq!(at_from_raw(r#"{"Transaction Date":"01/10/2026"}"#), None);
    }
}
