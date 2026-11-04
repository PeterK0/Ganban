//! Dedupe: a stable hash per bank line, so re-importing an overlapping export adds
//! nothing.
//!
//! The hash covers the account, booked date, amount, currency and normalised
//! description, plus what tells identical lines on one day apart: the running
//! balance after the line when the file has one (the balance chain), else the
//! line's occurrence index among identical lines that day. The balance is exact
//! even when two exports cut a day at different points; the index is the fallback.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::{decode, ParsedRow};

/// Lower-case, single-spaced text: how descriptions compare for dedupe.
pub fn normalise_description(s: &str) -> String {
    decode::clean_text(s).to_lowercase()
}

/// The hash of one line in one account, given what tells it apart that day.
pub fn line_hash(account_id: i64, row: &ParsedRow, tiebreak: &str) -> String {
    let key = format!(
        "v1|{account_id}|{}|{}|{}|{}|{tiebreak}",
        row.booked_date.format("%Y-%m-%d"),
        row.amount_minor,
        row.currency,
        normalise_description(&row.description),
    );
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hashes for a file's rows, in order. `account_of` maps a row to the user's account
/// id; the occurrence index counts identical lines (same account, day, amount,
/// currency and description) in file order.
pub fn hash_rows(rows: &[ParsedRow], account_of: impl Fn(&ParsedRow) -> i64) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    rows.iter()
        .map(|r| {
            let account = account_of(r);
            let tiebreak = match r.balance_minor {
                // A repeat of the same balance too (zero-amount lines) adds its index.
                Some(b) => {
                    let n = seen.entry(line_hash(account, r, &format!("b{b}"))).or_default();
                    let t = if *n == 0 { format!("b{b}") } else { format!("b{b}#{n}") };
                    *n += 1;
                    t
                }
                None => {
                    let n = seen.entry(line_hash(account, r, "")).or_default();
                    let t = format!("n{n}");
                    *n += 1;
                    t
                }
            };
            line_hash(account, r, &tiebreak)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn row(date: &str, amount: i64, desc: &str, balance: Option<i64>) -> ParsedRow {
        ParsedRow {
            line: 1,
            booked_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            booked_at: None,
            value_date: None,
            description: desc.into(),
            payee: None,
            amount_minor: amount,
            fee_minor: 0,
            currency: "EUR".into(),
            balance_minor: balance,
            bank_category: None,
            kind_hint: None,
            account_guess: "a".into(),
            counterpart_guess: None,
            fx_currency: None,
            raw: Default::default(),
        }
    }

    #[test]
    fn identical_lines_on_a_day_get_distinct_hashes() {
        let rows = vec![row("2026-10-01", -300, "Coffee", None), row("2026-10-01", -300, "coffee ", None)];
        let h = hash_rows(&rows, |_| 1);
        assert_ne!(h[0], h[1]);
        // Same file again: same hashes.
        assert_eq!(h, hash_rows(&rows, |_| 1));
        // Another account: different hashes.
        assert_ne!(h[0], hash_rows(&rows, |_| 2)[0]);
    }

    #[test]
    fn overlapping_exports_share_hashes() {
        let a = vec![row("2026-10-01", -300, "Coffee", None), row("2026-10-02", -500, "Lunch", None)];
        let b = vec![row("2026-10-02", -500, "Lunch", None), row("2026-10-03", -100, "Bus", None)];
        let (ha, hb) = (hash_rows(&a, |_| 1), hash_rows(&b, |_| 1));
        assert_eq!(ha[1], hb[0]);
        assert_ne!(ha[0], hb[1]);
    }

    #[test]
    fn the_balance_chain_tells_a_cut_day_apart() {
        // The first export starts mid-day with the second coffee; the next has both.
        let first = vec![row("2026-10-01", -300, "Coffee", Some(9_400))];
        let next = vec![row("2026-10-01", -300, "Coffee", Some(9_700)), row("2026-10-01", -300, "Coffee", Some(9_400))];
        let (h1, h2) = (hash_rows(&first, |_| 1), hash_rows(&next, |_| 1));
        assert_eq!(h1[0], h2[1]);
        assert_ne!(h1[0], h2[0]);
        // Identical zero-amount lines with the same balance stay apart.
        let zeros = vec![row("2026-10-01", 0, "Card check", Some(100)), row("2026-10-01", 0, "Card check", Some(100))];
        let h = hash_rows(&zeros, |_| 1);
        assert_ne!(h[0], h[1]);
    }
}
