//! Dedupe: which of a file's lines are already in the books, so re-importing an
//! overlapping export (or the same one, or the same data as CSV and as XLSX) adds only
//! what's missing.
//!
//! A line's **group** is a hash of (account, booked date, amount, currency,
//! normalised description): lines in one group look identical. Within a group, the
//! matcher pairs the file's lines with the stored ones by the strongest thing both
//! sides have:
//!
//! 1. the bank's timestamp, to the second (Revolut's Started Date), with the balance
//!    agreeing when both have one;
//! 2. else the running balance after the line (Piraeus);
//! 3. else nothing: the lines are interchangeable, so the file adds only as many as
//!    it has beyond what's stored (two €3.20 coffees stay two, and a re-import adds
//!    none).
//!
//! So a day cut at different points by two exports is told apart by the timestamp or
//! the balance, and a file whose balance column is masked or missing still matches
//! the lines an earlier import stored with balances (it falls back to counting).
//!
//! Each stored line also gets a `hash`, unique per account: the group, the
//! tiebreak and an index. It only guards the table against a double insert; the
//! matcher decides what's new. Lines imported before the group existed (hash `v1`)
//! get their group backfilled at startup ([`backfill`]), so they match the same way.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDateTime;
use sha2::{Digest, Sha256};

use super::{decode, ParsedRow};
use crate::error::Result;

/// Lower-case, single-spaced text: how descriptions compare for dedupe.
pub fn normalise_description(s: &str) -> String {
    decode::clean_text(s).to_lowercase()
}

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The group of a line: what makes lines look identical.
pub fn group_key(account_id: i64, booked_date: &str, amount_minor: i64, currency: &str, description: &str) -> String {
    sha(&format!(
        "g2|{account_id}|{booked_date}|{amount_minor}|{}|{}",
        currency.to_uppercase(),
        normalise_description(description)
    ))
}

pub fn group_of(account_id: i64, row: &ParsedRow) -> String {
    group_key(account_id, &row.booked_date.format("%Y-%m-%d").to_string(), row.amount_minor, &row.currency, &row.description)
}

/// A timestamp to the second, rounded (an XLSX serial can land a hair off).
pub fn second(ts: NaiveDateTime) -> String {
    (ts + chrono::Duration::milliseconds(500)).format("%Y-%m-%d %H:%M:%S").to_string()
}

/// A line already stored, as the matcher sees it.
#[derive(Debug, Clone)]
pub struct Stored {
    pub line_id: i64,
    pub group: String,
    /// [`second`]-formatted.
    pub occurred_at: Option<String>,
    pub balance_minor: Option<i64>,
    pub hash: String,
}

/// A file line to match: its group and its tiebreakers.
#[derive(Debug, Clone)]
pub struct Incoming {
    pub group: String,
    pub occurred_at: Option<String>,
    pub balance_minor: Option<i64>,
}

impl Incoming {
    pub fn of(account_id: i64, row: &ParsedRow) -> Self {
        Incoming { group: group_of(account_id, row), occurred_at: row.occurred_at.map(second), balance_minor: row.balance_minor }
    }
}

/// What the matcher decided for a file line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Not in the books: store it under this hash.
    New(String),
    /// Already stored as this source line.
    Known(i64),
}

/// Whether two lines of one group are the same line: `Some(true/false)` when a
/// tiebreaker both have decides, `None` when nothing tells them apart.
fn same(a: &Incoming, b: &Stored) -> Option<bool> {
    let balances_agree = match (a.balance_minor, b.balance_minor) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    };
    if let (Some(x), Some(y)) = (&a.occurred_at, &b.occurred_at) {
        // The same second; a balance both have must agree too (two identical lines
        // stamped the same second).
        return Some(x == y && balances_agree);
    }
    if let (Some(x), Some(y)) = (a.balance_minor, b.balance_minor) {
        return Some(x == y);
    }
    None
}

/// Decides, for each file line in order, whether it's new or already stored.
pub fn plan(rows: &[Incoming], stored: &[Stored]) -> Vec<Verdict> {
    let mut by_group: HashMap<&str, Vec<&Stored>> = HashMap::new();
    for s in stored {
        by_group.entry(s.group.as_str()).or_default().push(s);
    }
    let mut verdict: Vec<Option<Verdict>> = vec![None; rows.len()];
    let mut taken: HashSet<i64> = HashSet::new();
    // Pass 1: lines a shared tiebreaker says are the same.
    for (i, r) in rows.iter().enumerate() {
        let cands = by_group.get(r.group.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if let Some(s) = cands.iter().find(|s| !taken.contains(&s.line_id) && same(r, s) == Some(true)) {
            taken.insert(s.line_id);
            verdict[i] = Some(Verdict::Known(s.line_id));
        }
    }
    // Pass 2: lines nothing tells apart match by count.
    for (i, r) in rows.iter().enumerate() {
        if verdict[i].is_some() {
            continue;
        }
        let cands = by_group.get(r.group.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if let Some(s) = cands.iter().find(|s| !taken.contains(&s.line_id) && same(r, s).is_none()) {
            taken.insert(s.line_id);
            verdict[i] = Some(Verdict::Known(s.line_id));
        }
    }
    // The rest are new: give each a hash no stored or new line of its group has.
    let mut used: HashSet<String> = stored.iter().map(|s| s.hash.clone()).collect();
    rows.iter()
        .zip(verdict)
        .map(|(r, v)| {
            v.unwrap_or_else(|| {
                let tiebreak = match (&r.occurred_at, r.balance_minor) {
                    (Some(t), _) => format!("t{t}"),
                    (None, Some(b)) => format!("b{b}"),
                    (None, None) => "n".into(),
                };
                let hash = (0..)
                    .map(|k| sha(&format!("v2|{}|{tiebreak}|{k}", r.group)))
                    .find(|h| !used.contains(h))
                    .expect("an unused hash");
                used.insert(hash.clone());
                Verdict::New(hash)
            })
        })
        .collect()
}

/// The raw column a stored Revolut line keeps its timestamp in (`profiles::revolut`).
const REVOLUT_STARTED: &str = "Started Date";

/// Fills in the group (and Revolut's timestamp) of lines stored before dedupe had
/// groups, so they match like new ones. Idempotent; runs at startup.
pub(crate) async fn backfill(pool: &crate::Db) -> Result<()> {
    type Row = (i64, i64, String, i64, String, String, String);
    loop {
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, account_id, booked_date, amount_minor, currency, description, raw_json FROM fin_source_lines \
             WHERE dedupe_key IS NULL LIMIT 500",
        )
        .fetch_all(pool)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut tx = pool.begin().await?;
        for (id, account, date, amount, currency, description, raw) in rows {
            let occurred = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| v.get(REVOLUT_STARTED).and_then(|s| s.as_str()).map(str::to_string))
                .and_then(|s| NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S").ok())
                .map(second);
            sqlx::query("UPDATE fin_source_lines SET dedupe_key = ?, occurred_at = COALESCE(occurred_at, ?) WHERE id = ?")
                .bind(group_key(account, &date, amount, &currency, &description))
                .bind(occurred)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inc(group: &str, at: Option<&str>, balance: Option<i64>) -> Incoming {
        Incoming { group: group.into(), occurred_at: at.map(str::to_string), balance_minor: balance }
    }

    fn st(id: i64, group: &str, at: Option<&str>, balance: Option<i64>) -> Stored {
        Stored { line_id: id, group: group.into(), occurred_at: at.map(str::to_string), balance_minor: balance, hash: format!("h{id}") }
    }

    fn new_count(v: &[Verdict]) -> usize {
        v.iter().filter(|v| matches!(v, Verdict::New(_))).count()
    }

    #[test]
    fn the_group_ignores_case_and_spacing_of_the_description() {
        assert_eq!(group_key(1, "2026-10-01", -320, "eur", "Cafe  Nero "), group_key(1, "2026-10-01", -320, "EUR", "cafe nero"));
        assert_ne!(group_key(1, "2026-10-01", -320, "EUR", "Cafe"), group_key(2, "2026-10-01", -320, "EUR", "Cafe"));
    }

    #[test]
    fn identical_lines_are_kept_and_not_doubled() {
        let file = [inc("c", None, None), inc("c", None, None)];
        let first = plan(&file, &[]);
        assert_eq!(new_count(&first), 2);
        let hashes: Vec<&Verdict> = first.iter().collect();
        assert_ne!(hashes[0], hashes[1]);
        // Stored now: the same file adds nothing; one more in the file adds one.
        let stored = [st(1, "c", None, None), st(2, "c", None, None)];
        assert_eq!(new_count(&plan(&file, &stored)), 0);
        assert_eq!(new_count(&plan(&[inc("c", None, None), inc("c", None, None), inc("c", None, None)], &stored)), 1);
    }

    #[test]
    fn a_cut_day_is_told_apart_by_timestamp_or_balance() {
        // The first export holds the morning coffee, the next the afternoon one.
        let stored = [st(1, "c", Some("2026-10-01 08:05:00"), Some(9_700))];
        assert_eq!(new_count(&plan(&[inc("c", Some("2026-10-01 15:00:00"), Some(9_400))], &stored)), 1);
        assert_eq!(plan(&[inc("c", Some("2026-10-01 08:05:00"), Some(9_700))], &stored), vec![Verdict::Known(1)]);
        // By balance alone (Piraeus).
        let stored = [st(1, "c", None, Some(9_700))];
        assert_eq!(new_count(&plan(&[inc("c", None, Some(9_400)), inc("c", None, Some(9_700))], &stored)), 1);
    }

    #[test]
    fn a_masked_balance_falls_back_to_counting() {
        let stored = [st(1, "c", None, Some(9_700)), st(2, "c", None, Some(9_400))];
        assert_eq!(new_count(&plan(&[inc("c", None, None), inc("c", None, None)], &stored)), 0);
        // Two identical lines in the same second: the balance still tells them apart.
        let stored = [st(1, "c", Some("2026-10-01 08:00:00"), Some(9_700))];
        assert_eq!(new_count(&plan(&[inc("c", Some("2026-10-01 08:00:00"), Some(9_400))], &stored)), 1);
        assert_eq!(new_count(&plan(&[inc("c", Some("2026-10-01 08:00:00"), None)], &stored)), 0);
        // But a timestamp both sides have still decides.
        let stored = [st(1, "c", Some("2026-10-01 08:00:00"), Some(9_700))];
        assert_eq!(new_count(&plan(&[inc("c", Some("2026-10-01 09:00:00"), None)], &stored)), 1);
    }
}
