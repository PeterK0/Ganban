//! Profiles: the built-in formats in the registry, plus the wizard's column mapping.
//!
//! A profile finds its own header row (a file may start with preamble rows), reads
//! each row into a [`ParsedRow`](super::ParsedRow) and guesses the accounts.
//!
//! The registry is filled at compile time. The public tree ships no built-in bank
//! format, so there it is empty and the mapping wizard is the way in; a private pack
//! (`import/pack`, compiled in under `cfg(finance_pack)`) adds formats and keywords.
//! A key the registry doesn't know (data imported by a build that had it) is simply
//! not built in: its file is offered to the wizard.

pub mod mapping;
#[cfg(any(test, feature = "sample-format"))]
pub mod sample;

use chrono::NaiveDateTime;
use serde::Serialize;

use super::decode::{self, DecimalStyle};
use super::{Cell, KindHint, ProfileOutput};
use crate::error::{AppError, Result};
pub use mapping::{ColRef, Mapping};

/// Rows scanned from the top for a header.
pub const HEADER_SCAN_ROWS: usize = 40;

/// A built-in format: how to recognise and read one bank's export, and what the
/// engine asks of it afterwards.
pub struct BuiltinFormat {
    /// Stored on accounts and import batches as their `profile_key`; never changes.
    pub key: &'static str,
    /// As listed to the user.
    pub name: &'static str,
    /// How sure it is that a grid has this layout, 0 to 1.
    pub detect: fn(&[Vec<Cell>]) -> Option<f64>,
    pub parse: fn(&[Vec<Cell>]) -> Result<ProfileOutput>,
    /// The raw column a stored line keeps the bank's own timestamp in
    /// (`%Y-%m-%d %H:%M:%S`): dedupe's tiebreak, backfilled for old lines.
    pub occurred_at_column: Option<&'static str>,
    /// The raw column a stored line keeps its booking time in (same format): exchange
    /// legs pair on it.
    pub booked_at_column: Option<&'static str>,
}

impl PartialEq for BuiltinFormat {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl std::fmt::Debug for BuiltinFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("BuiltinFormat").field(&self.key).finish()
    }
}

/// Keywords that hint a line's kind.
pub type KindWords = (KindHint, &'static [&'static str]);

#[cfg(finance_pack)]
fn pack() -> (&'static [BuiltinFormat], &'static [KindWords]) {
    (super::pack::FORMATS, super::pack::KIND_WORDS)
}

#[cfg(not(finance_pack))]
fn pack() -> (&'static [BuiltinFormat], &'static [KindWords]) {
    (&[], &[])
}

#[cfg(any(test, feature = "sample-format"))]
fn extra_formats() -> &'static [BuiltinFormat] {
    std::slice::from_ref(&sample::FORMAT)
}

#[cfg(not(any(test, feature = "sample-format")))]
fn extra_formats() -> &'static [BuiltinFormat] {
    &[]
}

/// Every built-in format, in detection order.
pub fn builtin_formats() -> impl Iterator<Item = &'static BuiltinFormat> {
    pack().0.iter().chain(extra_formats())
}

/// A profile to parse with: a built-in format, or a saved column mapping.
#[derive(Debug, Clone, PartialEq)]
pub enum ProfileSpec {
    Builtin(&'static BuiltinFormat),
    Mapping { key: String, mapping: Mapping },
}

/// A built-in profile, as listed to the user.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BuiltinProfile {
    pub key: &'static str,
    pub name: &'static str,
}

pub fn builtin_profiles() -> Vec<BuiltinProfile> {
    builtin_formats().map(|f| BuiltinProfile { key: f.key, name: f.name }).collect()
}

impl ProfileSpec {
    /// The built-in profile with this key.
    pub fn builtin(key: &str) -> Option<ProfileSpec> {
        builtin_formats().find(|f| f.key == key).map(ProfileSpec::Builtin)
    }

    pub fn key(&self) -> &str {
        match self {
            ProfileSpec::Builtin(f) => f.key,
            ProfileSpec::Mapping { key, .. } => key,
        }
    }

    pub fn parse(&self, rows: &[Vec<Cell>]) -> Result<ProfileOutput> {
        match self {
            ProfileSpec::Builtin(f) => (f.parse)(rows),
            ProfileSpec::Mapping { key, mapping } => mapping::parse(key, mapping, rows),
        }
    }
}

/// The built-in profile whose header this file has, with a confidence.
pub fn detect_profile(rows: &[Vec<Cell>]) -> Option<(ProfileSpec, f64)> {
    builtin_formats().find_map(|f| (f.detect)(rows).map(|c| (ProfileSpec::Builtin(f), c)))
}

/// The first of the built-in formats' raw columns (picked by `column`) that a stored
/// line's raw row has, read as a date-time.
pub(crate) fn time_from_raw(
    raw: &serde_json::Value,
    column: fn(&BuiltinFormat) -> Option<&'static str>,
) -> Option<NaiveDateTime> {
    builtin_formats().filter_map(column).find_map(|c| {
        let s = raw.get(c)?.as_str()?;
        NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S").ok()
    })
}

/// The shared keywords for kind hints, checked kind by kind in this order; a pack
/// adds words in other languages. "atm" also counts as a whole word.
const KIND_WORDS: &[KindWords] = &[
    (KindHint::Fee, &["fee", "commission"]),
    (KindHint::Interest, &["interest"]),
    (KindHint::Atm, &["cash withdrawal"]),
    (KindHint::Transfer, &["transfer"]),
    (KindHint::Card, &["card", "purchase"]),
];

/// A kind hint from a bank's category and a line's details, by keyword.
pub fn kind_from_words(category: &str, details: &str) -> Option<KindHint> {
    let c = norm(category);
    let d = norm(details);
    let has = |kind: KindHint| {
        KIND_WORDS
            .iter()
            .chain(pack().1)
            .filter(|(k, _)| *k == kind)
            .flat_map(|(_, words)| words.iter())
            .any(|w| c.contains(w) || d.contains(w))
    };
    let word = |w: &str| {
        c.split(|ch: char| !ch.is_alphanumeric()).chain(d.split(|ch: char| !ch.is_alphanumeric())).any(|t| t == w)
    };
    if has(KindHint::Fee) {
        Some(KindHint::Fee)
    } else if has(KindHint::Interest) {
        Some(KindHint::Interest)
    } else if word("atm") || has(KindHint::Atm) {
        Some(KindHint::Atm)
    } else if has(KindHint::Transfer) {
        Some(KindHint::Transfer)
    } else if has(KindHint::Card) {
        Some(KindHint::Card)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Lower-case, trimmed, single-spaced: how header names compare.
pub(crate) fn norm(s: &str) -> String {
    decode::clean_text(s).to_lowercase()
}

/// A located header row.
#[derive(Debug, Clone)]
pub(crate) struct Header {
    /// 0-based index of the header row in the grid.
    pub row: usize,
    /// The header cells as display text.
    pub names: Vec<String>,
}

impl Header {
    pub fn at(rows: &[Vec<Cell>], row: usize) -> Option<Header> {
        let names = rows.get(row)?.iter().map(|c| c.clean().unwrap_or_default()).collect();
        Some(Header { row, names })
    }

    /// Every column whose name is `name` (case-insensitive), left to right.
    pub fn cols(&self, name: &str) -> Vec<usize> {
        let n = norm(name);
        self.names.iter().enumerate().filter(|(_, h)| norm(h) == n).map(|(i, _)| i).collect()
    }

    pub fn col(&self, name: &str) -> Option<usize> {
        self.cols(name).into_iter().next()
    }

    /// The first column with any of these names.
    #[cfg_attr(not(finance_pack), allow(dead_code))] // only built-in formats use it
    pub fn col_any(&self, names: &[&str]) -> Option<usize> {
        names.iter().find_map(|n| self.col(n))
    }
}

/// The first row within [`HEADER_SCAN_ROWS`] that has every `required` name.
pub(crate) fn find_header(rows: &[Vec<Cell>], required: &[&str]) -> Option<Header> {
    (0..rows.len().min(HEADER_SCAN_ROWS))
        .filter_map(|i| Header::at(rows, i))
        .find(|h| required.iter().all(|r| h.col(r).is_some()))
}

/// The cell at a column, `Empty` past the row's end.
pub(crate) fn cell<'a>(row: &'a [Cell], col: Option<usize>) -> &'a Cell {
    static EMPTY: Cell = Cell::Empty;
    col.and_then(|c| row.get(c)).unwrap_or(&EMPTY)
}

/// The source row as header → text. Repeated header names get " 2", " 3"…
pub(crate) fn raw_map(header: &[String], row: &[Cell]) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    let width = header.len().max(row.len());
    for i in 0..width {
        let base = header.get(i).filter(|h| !h.is_empty()).cloned().unwrap_or_else(|| format!("#{}", i + 1));
        let mut key = base.clone();
        let mut n = 2;
        while map.contains_key(&key) {
            key = format!("{base} {n}");
            n += 1;
        }
        let v = row.get(i).map(Cell::as_text).unwrap_or_default();
        if !v.is_empty() || header.get(i).is_some_and(|h| !h.is_empty()) {
            map.insert(key, serde_json::Value::String(v));
        }
    }
    map
}

/// The decimal style of a column's text cells, unless the profile fixes it.
pub(crate) fn column_style(rows: &[&[Cell]], col: Option<usize>, preset: DecimalStyle) -> DecimalStyle {
    if preset != DecimalStyle::Auto {
        return preset;
    }
    let texts: Vec<String> = rows
        .iter()
        .filter_map(|r| match cell(r, col) {
            Cell::Text(t) => Some(t.clone()),
            _ => None,
        })
        .collect();
    decode::detect_decimal_style(texts.iter().map(String::as_str))
}

/// A cell as minor units: numbers are rounded, text is parsed with `style`.
pub(crate) fn amount_of(c: &Cell, style: DecimalStyle, exponent: u32) -> Option<i64> {
    match c {
        Cell::Number(n) => decode::float_to_minor(*n, exponent),
        Cell::Text(t) => decode::parse_amount_minor(t, style, exponent),
        _ => None,
    }
}

/// The text date format that reads every text cell of a column.
pub(crate) fn column_date_format(
    rows: &[&[Cell]],
    col: Option<usize>,
    formats: &[&'static str],
) -> Option<&'static str> {
    let texts: Vec<String> = rows
        .iter()
        .filter_map(|r| match cell(r, col) {
            Cell::Text(t) => Some(t.trim().to_string()),
            _ => None,
        })
        .collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    decode::detect_date_format(&refs, formats)
}

/// A cell as a date-time: a date cell, a serial number, or text in `fmt` (else
/// the first of `fallback` that reads it).
pub(crate) fn date_of(c: &Cell, fmt: Option<&str>, fallback: &[&str]) -> Option<NaiveDateTime> {
    match c {
        Cell::Date(d) => Some(*d),
        Cell::Number(n) if decode::looks_like_serial_date(*n) => decode::excel_serial_to_datetime(*n),
        Cell::Text(t) => match fmt {
            Some(f) => decode::parse_date_with(t, f),
            None => fallback.iter().find_map(|f| decode::parse_date_with(t, f)),
        },
        _ => None,
    }
}

/// An IBAN in a line of text ("SAVINGS ACC R: DE89 3704 …"), spaces removed, with
/// the text before it. Masked exports ("DEXX XXXX …") count too.
#[cfg_attr(not(finance_pack), allow(dead_code))] // only built-in formats use it
pub(crate) fn find_iban(text: &str) -> Option<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len().saturating_sub(3) {
        let starts = chars[i].is_ascii_uppercase()
            && chars[i + 1].is_ascii_uppercase()
            && (chars[i + 2].is_ascii_digit() || chars[i + 2] == 'X')
            && (chars[i + 3].is_ascii_digit() || chars[i + 3] == 'X')
            && (i == 0 || !chars[i - 1].is_alphanumeric());
        if !starts {
            continue;
        }
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == ' ') {
            j += 1;
        }
        let iban: String = chars[i..j].iter().filter(|c| **c != ' ').collect();
        if (15..=34).contains(&iban.len()) {
            let before: String = chars[..i].iter().collect();
            return Some((iban, before));
        }
    }
    None
}

/// An IBAN shown without its middle: the country and the last four ("DE•• … 1234").
pub fn mask_iban(iban: &str) -> String {
    let compact: String = iban.chars().filter(|c| !c.is_whitespace()).collect();
    let n = compact.chars().count();
    let country: String = compact.chars().take(2).collect();
    let last: String = compact.chars().skip(n.saturating_sub(4)).collect();
    format!("{country}•• … {last}")
}

/// Adds a guess to the list unless its key is already there.
pub(crate) fn push_guess(list: &mut Vec<super::AccountGuess>, g: super::AccountGuess) {
    if !list.iter().any(|x| x.guess_key == g.guess_key) {
        list.push(g);
    }
}

/// The data rows under a header, with their 1-based line numbers, skipping blank rows.
pub(crate) fn data_rows(rows: &[Vec<Cell>], header_row: usize) -> Vec<(usize, &[Cell])> {
    rows.iter()
        .enumerate()
        .skip(header_row + 1)
        .filter(|(_, r)| r.iter().any(|c| !c.is_empty()))
        .map(|(i, r)| (i + 1, r.as_slice()))
        .collect()
}

/// "rows 4, 9 skipped: no readable date, amount or currency" (line numbers only).
pub(crate) fn unreadable_warning(lines: &[usize]) -> String {
    let shown: Vec<String> = lines.iter().take(10).map(|l| l.to_string()).collect();
    let more = if lines.len() > 10 { format!(" and {} more", lines.len() - 10) } else { String::new() };
    let noun = if lines.len() == 1 { "row" } else { "rows" };
    format!("{noun} {}{more} skipped: no readable date, amount or currency", shown.join(", "))
}

pub(crate) fn wrong_layout(name: &str) -> AppError {
    AppError::InvalidInput(format!("this file doesn't have the {name} layout"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iban_found_and_masked() {
        let (iban, before) = find_iban("BASIC SAVINGS ACC R:  DE89 3704 0044 0532 0130 00").unwrap();
        assert_eq!(iban, "DE89370400440532013000");
        assert_eq!(before.trim(), "BASIC SAVINGS ACC R:");
        assert_eq!(mask_iban(&iban), "DE•• … 3000");
        // A masked export still yields an account line.
        let (iban, _) = find_iban("ACC: DEXX XXXX XXXX XXXX XXXX XX").unwrap();
        assert_eq!(iban.len(), 22);
        assert!(find_iban("Selected Period: 01/11/2026 - 04/11/2026").is_none());
        assert!(find_iban("Example Bank").is_none());
    }

    #[test]
    fn kind_words_go_kind_by_kind() {
        assert_eq!(kind_from_words("Bank fees", "CARD RENEWAL"), Some(KindHint::Fee));
        assert_eq!(kind_from_words("", "ATM withdrawal"), Some(KindHint::Atm));
        assert_eq!(kind_from_words("", "batman"), None);
        assert_eq!(kind_from_words("Transfers", ""), Some(KindHint::Transfer));
        assert_eq!(kind_from_words("Online purchase", ""), Some(KindHint::Card));
    }

    #[test]
    fn raw_map_names_repeated_headers() {
        let header = vec!["Amount".to_string(), "Currency".into(), "Balance".into(), "Currency".into()];
        let row = vec![Cell::Number(-6.0), Cell::text("EUR"), Cell::Empty, Cell::text("EUR")];
        let m = raw_map(&header, &row);
        assert_eq!(m["Amount"], "-6");
        assert_eq!(m["Currency 2"], "EUR");
        assert_eq!(m["Balance"], "");
    }
}
