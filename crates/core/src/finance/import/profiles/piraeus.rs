//! Piraeus Bank's account transactions export (XLSX).
//!
//! Preamble rows come first: the bank, the title, the account line with its IBAN,
//! the selected period. Then the header: `Category, Transaction Details,
//! Transaction Date, Transaction Comments / Reference Code, Amount, Currency,
//! Progressive Ledger Balance, Currency`. Dates are `DD/MM/YYYY` text. Greek text is
//! kept as it is, and the bank's Category becomes a rule hint.

use super::revolut::unreadable_warning;
use super::{
    amount_of, cell, column_date_format, column_style, data_rows, date_of, find_header, find_iban, mask_iban,
    norm, raw_map, wrong_layout, Header,
};
use crate::error::Result;
use crate::finance::import::decode::{currency_exponent, is_currency_code, DecimalStyle};
use crate::finance::import::{AccountGuess, Cell, KindHint, ParsedRow, ProfileOutput};

pub const KEY: &str = "piraeus";
const INSTITUTION: &str = "Piraeus Bank";
const REQUIRED: &[&str] = &["Transaction Date", "Amount", "Transaction Details"];
const DATE_FORMATS: &[&str] = &["%d/%m/%Y", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d.%m.%Y", "%Y-%m-%d"];

pub fn detect(rows: &[Vec<Cell>]) -> Option<f64> {
    let h = find_header(rows, REQUIRED)?;
    let named = preamble_text(rows, &h).iter().any(|t| norm(t).contains("piraeus"));
    let ledger = h.col("Progressive Ledger Balance").is_some();
    Some(match (named, ledger) {
        (true, _) => 0.98,
        (false, true) => 0.9,
        (false, false) => 0.7,
    })
}

fn preamble_text(rows: &[Vec<Cell>], h: &Header) -> Vec<String> {
    rows[..h.row].iter().flat_map(|r| r.iter().filter_map(Cell::clean)).collect()
}

/// The account from the preamble: its name, IBAN and kind.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountLine {
    pub name: String,
    pub iban: Option<String>,
    pub kind: &'static str,
}

pub fn account_line(preamble: &[String]) -> AccountLine {
    for t in preamble {
        if let Some((iban, before)) = find_iban(t) {
            let name = before.trim().trim_end_matches(':').trim();
            // "BASIC SAVINGS ACC R:" — drop a trailing one-letter label.
            let name = match name.rsplit_once(' ') {
                Some((head, tail)) if tail.chars().count() == 1 => head.trim(),
                _ => name,
            };
            let name = if name.is_empty() { INSTITUTION.to_string() } else { name.to_string() };
            return AccountLine { kind: kind_of_account(&name), name, iban: Some(iban) };
        }
    }
    AccountLine { name: INSTITUTION.into(), iban: None, kind: "current" }
}

fn kind_of_account(name: &str) -> &'static str {
    let n = norm(name);
    if n.contains("saving") || n.contains("ταμιευτ") {
        "savings"
    } else if n.contains("card") || n.contains("κάρτα") || n.contains("καρτα") {
        "card"
    } else if n.contains("loan") || n.contains("δάνει") {
        "loan"
    } else {
        "current"
    }
}

/// A kind hint from the bank's category and the transaction details.
pub fn kind_of(category: &str, details: &str) -> Option<KindHint> {
    let c = norm(category);
    let d = norm(details);
    let has = |words: &[&str]| words.iter().any(|w| c.contains(w) || d.contains(w));
    let word = |w: &str| c.split(|ch: char| !ch.is_alphanumeric()).chain(d.split(|ch: char| !ch.is_alphanumeric())).any(|t| t == w);
    if has(&["fee", "commission", "προμήθει", "προμηθει", "έξοδα"]) {
        Some(KindHint::Fee)
    } else if has(&["interest", "τόκ", "τοκ"]) {
        Some(KindHint::Interest)
    } else if word("atm") || has(&["ανάληψη", "αναληψη", "cash withdrawal"]) {
        Some(KindHint::Atm)
    } else if has(&["transfer", "μεταφορ", "έμβασμα", "εμβασμα"]) {
        Some(KindHint::Transfer)
    } else if has(&["card", "κάρτ", "καρτ", "purchase", "αγορ"]) {
        Some(KindHint::Card)
    } else {
        None
    }
}

pub fn parse(rows: &[Vec<Cell>]) -> Result<ProfileOutput> {
    let h = find_header(rows, REQUIRED).ok_or_else(|| wrong_layout("Piraeus"))?;
    let c_category = h.col("Category");
    let c_details = h.col("Transaction Details");
    let c_date = h.col("Transaction Date");
    let c_value = h.col_any(&["Value Date", "Valeur"]);
    let c_comments = h.col_any(&["Transaction Comments / Reference Code", "Transaction Comments"]);
    let c_amount = h.col("Amount");
    let c_balance = h.col_any(&["Progressive Ledger Balance", "Balance"]);
    // Two "Currency" columns: the one after Amount, and the one after the balance.
    let currencies = h.cols("Currency");
    let c_currency = currencies.iter().copied().find(|c| Some(*c) > c_amount).or(currencies.first().copied());

    let account = account_line(&preamble_text(rows, &h));
    let account_id = account
        .iban
        .as_deref()
        .map(|i| i.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>())
        .unwrap_or_else(|| norm(&account.name));

    let data = data_rows(rows, h.row);
    let slices: Vec<&[Cell]> = data.iter().map(|(_, r)| *r).collect();
    let amount_style = column_style(&slices, c_amount, DecimalStyle::Auto);
    let balance_style = column_style(&slices, c_balance, DecimalStyle::Auto);
    let date_fmt = column_date_format(&slices, c_date, DATE_FORMATS);
    let value_fmt = column_date_format(&slices, c_value, DATE_FORMATS);

    let mut out = ProfileOutput { header: h.names.clone(), ..Default::default() };
    let mut unreadable = Vec::new();
    for (line, row) in data {
        let amount_cell = cell(row, c_amount);
        let date_cell = cell(row, c_date);
        // Footer lines ("Update Date: …") have neither a date nor an amount.
        if amount_cell.is_empty() && date_of(date_cell, date_fmt, DATE_FORMATS).is_none() {
            continue;
        }
        let currency = cell(row, c_currency)
            .clean()
            .map(|c| c.to_uppercase())
            .filter(|c| is_currency_code(c))
            .unwrap_or_else(|| "EUR".into());
        let exp = currency_exponent(&currency);
        let (Some(booked), Some(amount)) =
            (date_of(date_cell, date_fmt, DATE_FORMATS), amount_of(amount_cell, amount_style, exp))
        else {
            unreadable.push(line);
            continue;
        };
        let details = cell(row, c_details).clean().unwrap_or_default();
        let comment = match cell(row, c_comments) {
            Cell::Text(t) => t.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| super::super::decode::clean_text(l)),
            other => other.clean(),
        };
        let description = match &comment {
            Some(c) if !details.is_empty() => format!("{details} — {c}"),
            Some(c) => c.clone(),
            None => details.clone(),
        };
        let category = cell(row, c_category).clean();
        let account_guess = format!("{KEY}:{account_id}:{currency}");
        super::push_guess(
            &mut out.accounts,
            AccountGuess {
                guess_key: account_guess.clone(),
                name: account.name.clone(),
                institution: Some(INSTITUTION.into()),
                currency: currency.clone(),
                kind: account.kind.into(),
                iban_mask: account.iban.as_deref().map(mask_iban),
                matched_account_id: None,
            },
        );
        out.rows.push(ParsedRow {
            line,
            booked_date: booked.date(),
            booked_at: None,
            value_date: date_of(cell(row, c_value), value_fmt, DATE_FORMATS).map(|d| d.date()),
            description,
            payee: None,
            amount_minor: amount,
            fee_minor: 0,
            balance_minor: amount_of(cell(row, c_balance), balance_style, exp),
            kind_hint: kind_of(category.as_deref().unwrap_or(""), &details),
            bank_category: category,
            currency,
            account_guess,
            counterpart_guess: None,
            fx_currency: None,
            raw: raw_map(&h.names, row),
        });
    }
    if !unreadable.is_empty() {
        out.warnings.push(unreadable_warning(&unreadable));
    }
    Ok(out)
}
