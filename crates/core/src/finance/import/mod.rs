//! Bank statement import: the pure parsing layer.
//!
//! A file goes through [`parse`]: [`sniff`] decides CSV or XLSX from the content,
//! the reader turns it into a grid of [`Cell`]s ([`decode`] repairs mojibake and
//! reads serial dates and amounts), and a profile ([`profiles`]) finds its header
//! row and maps each row to a [`ParsedRow`]. Nothing here touches the database;
//! dedupe, drafting and pairing build on the result.
//!
//! Warnings name row numbers and counts only, never amounts, payees or text from
//! the file: finance data stays out of logs and bug reports.

pub mod decode;
pub mod dedupe;
pub mod jobs;
pub mod pipeline;
pub mod profiles;
pub mod sniff;
mod xlsx;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
pub use decode::DecimalStyle;
pub use profiles::{builtin_profiles, detect_profile, BuiltinProfile, ColRef, Mapping, ProfileSpec};

/// Largest file the import accepts (1.5 MB): a year of a bank's export is a few hundred
/// KB, and the upload rides the command table's JSON body as base64.
pub const MAX_FILE_BYTES: usize = 1536 * 1024;

/// The refusal for a larger file.
pub const TOO_LARGE: &str = "file too large: export a shorter period";

/// How many parsed rows a preview returns.
pub const PREVIEW_ROWS: usize = 50;

/// How many raw grid rows a result carries for the mapping wizard.
pub const SAMPLE_ROWS: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Xlsx,
}

/// One spreadsheet cell after decoding.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    /// Text, mojibake already repaired, otherwise as it came.
    Text(String),
    Number(f64),
    /// A date-formatted spreadsheet cell.
    Date(NaiveDateTime),
}

impl Cell {
    /// A text cell, repaired; blank text is [`Cell::Empty`].
    pub fn text(s: &str) -> Cell {
        if s.trim().is_empty() {
            Cell::Empty
        } else {
            Cell::Text(decode::repair_mojibake(s))
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, Cell::Empty)
    }

    /// The cell as display text: dates as `YYYY-MM-DD[ HH:MM:SS]`, numbers in their
    /// shortest form.
    pub fn as_text(&self) -> String {
        match self {
            Cell::Empty => String::new(),
            Cell::Text(s) => s.clone(),
            Cell::Number(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{n}")
                }
            }
            Cell::Date(d) if d.time() == NaiveTime::MIN => d.format("%Y-%m-%d").to_string(),
            Cell::Date(d) => d.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }

    /// Cleaned text (trimmed, single spaces), or `None` when blank.
    pub fn clean(&self) -> Option<String> {
        let t = decode::clean_text(&self.as_text());
        (!t.is_empty()).then_some(t)
    }
}

/// What kind of bank line a row looks like, from the bank's own type or category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KindHint {
    Card,
    Transfer,
    Exchange,
    Interest,
    Fee,
    Refund,
    Topup,
    Atm,
    Other,
}

impl KindHint {
    pub fn as_str(self) -> &'static str {
        match self {
            KindHint::Card => "card",
            KindHint::Transfer => "transfer",
            KindHint::Exchange => "exchange",
            KindHint::Interest => "interest",
            KindHint::Fee => "fee",
            KindHint::Refund => "refund",
            KindHint::Topup => "topup",
            KindHint::Atm => "atm",
            KindHint::Other => "other",
        }
    }
}

/// One bank line, as a profile read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedRow {
    /// 1-based row number in the file.
    pub line: usize,
    /// The booking (completed) date: the date the line posts on.
    pub booked_date: NaiveDate,
    /// The booking time, when the file has one (FX legs pair on it).
    pub booked_at: Option<NaiveDateTime>,
    /// When the transaction happened, to the second, when the file says (Revolut's
    /// Started Date). Dedupe tells identical lines on one day apart by it.
    pub occurred_at: Option<NaiveDateTime>,
    pub value_date: Option<NaiveDate>,
    pub description: String,
    pub payee: Option<String>,
    /// Signed, in minor units of `currency`: positive is money in. Excludes the fee.
    pub amount_minor: i64,
    /// The fee the bank charged on this line, positive, in minor units; the
    /// account moves by `amount_minor - fee_minor`.
    pub fee_minor: i64,
    pub currency: String,
    /// The account balance after this line, when the file has it.
    pub balance_minor: Option<i64>,
    pub bank_category: Option<String>,
    pub kind_hint: Option<KindHint>,
    /// The `guess_key` of the account this line belongs to.
    pub account_guess: String,
    /// The `guess_key` of the user's other account on the far side (a pocket move).
    pub counterpart_guess: Option<String>,
    /// The other currency of an exchange leg, when the file names it.
    pub fx_currency: Option<String>,
    /// The source row, header → display text, stored verbatim.
    pub raw: serde_json::Map<String, serde_json::Value>,
}

/// An account the file's lines belong to, as the profile guessed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountGuess {
    pub guess_key: String,
    pub name: String,
    pub institution: Option<String>,
    pub currency: String,
    /// `current` `savings` `card` `cash` `loan`
    pub kind: String,
    pub iban_mask: Option<String>,
    /// The user's existing account this matches; filled in by the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_account_id: Option<i64>,
}

/// What a profile produced from a file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProfileOutput {
    pub header: Vec<String>,
    pub rows: Vec<ParsedRow>,
    pub accounts: Vec<AccountGuess>,
    pub warnings: Vec<String>,
}

/// The parse of a whole file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParseResult {
    pub format: Format,
    /// The profile used, or `None` when none was given or recognised.
    pub profile_key: Option<String>,
    /// How sure the detection is, 0 to 1 (1 when the profile was chosen).
    pub confidence: f64,
    pub header: Vec<String>,
    pub rows: Vec<ParsedRow>,
    pub accounts: Vec<AccountGuess>,
    pub warnings: Vec<String>,
    /// The file's first rows as text, for the mapping wizard.
    pub sample: Vec<Vec<String>>,
}

/// A decoded file: its format and its first sheet as a grid.
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    pub format: Format,
    pub rows: Vec<Vec<Cell>>,
}

/// Reads a file into a grid, sniffing the format from the content.
pub fn read_grid(bytes: &[u8]) -> Result<Grid> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(TOO_LARGE.into()));
    }
    let format = sniff::sniff_format(bytes);
    let rows = match format {
        Format::Xlsx => xlsx::read_xlsx(bytes)?,
        Format::Csv => sniff::read_csv(bytes).0,
    };
    Ok(Grid { format, rows })
}

/// Parses a file with the given profile, or detects a built-in one when `None`.
/// With no profile recognised, the result has no rows and carries the sample for
/// the mapping wizard.
pub fn parse(bytes: &[u8], profile: Option<&ProfileSpec>) -> Result<ParseResult> {
    let grid = read_grid(bytes)?;
    let sample = grid
        .rows
        .iter()
        .filter(|r| r.iter().any(|c| !c.is_empty()))
        .take(SAMPLE_ROWS)
        .map(|r| r.iter().map(Cell::as_text).collect())
        .collect();
    let (spec, confidence) = match profile {
        Some(p) => (Some(p.clone()), 1.0),
        None => match detect_profile(&grid.rows) {
            Some((p, c)) => (Some(p), c),
            None => (None, 0.0),
        },
    };
    let Some(spec) = spec else {
        return Ok(ParseResult {
            format: grid.format,
            profile_key: None,
            confidence: 0.0,
            header: Vec::new(),
            rows: Vec::new(),
            accounts: Vec::new(),
            warnings: vec!["no known bank layout recognised: map the columns".into()],
            sample,
        });
    };
    let out = spec.parse(&grid.rows)?;
    Ok(ParseResult {
        format: grid.format,
        profile_key: Some(spec.key().to_string()),
        confidence,
        header: out.header,
        rows: out.rows,
        accounts: out.accounts,
        warnings: out.warnings,
        sample,
    })
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod pipeline_tests;
#[cfg(test)]
mod dedupe_tests;
