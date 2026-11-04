//! Revolut's account statement export (XLSX, often named `.csv`, or real CSV).
//!
//! Columns: `Type, Product, Started Date, Completed Date, Description, Amount, Fee,
//! Currency, State, Balance`. Only `COMPLETED` rows count; the booked date is
//! Completed and the value date Started. `Product` with the currency picks the
//! account, and pocket moves ("To EUR <pocket>", "From EUR <pocket>") name a savings
//! pocket as the counterpart account.

use super::{
    amount_of, cell, column_date_format, column_style, data_rows, date_of, find_header, norm, push_guess,
    raw_map, wrong_layout,
};
use crate::error::Result;
use crate::finance::import::decode::{self, currency_exponent, is_currency_code, DecimalStyle};
use crate::finance::import::{AccountGuess, Cell, KindHint, ParsedRow, ProfileOutput};

pub const KEY: &str = "revolut";
const INSTITUTION: &str = "Revolut";
const REQUIRED: &[&str] = &["Completed Date", "Description", "Amount", "Currency", "Product", "State"];
const DATE_FORMATS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
];

pub fn detect(rows: &[Vec<Cell>]) -> Option<f64> {
    let h = find_header(rows, REQUIRED)?;
    Some(if h.col("Type").is_some() && h.col("Started Date").is_some() { 0.97 } else { 0.85 })
}

/// A pocket move: "To EUR Holiday" / "From EUR 💸 Monthly Expenses", in the row's
/// currency. Returns the pocket's name.
pub fn pocket_name(description: &str, currency: &str) -> Option<String> {
    let rest = description.strip_prefix("To ").or_else(|| description.strip_prefix("From "))?;
    let (code, name) = rest.split_once(' ')?;
    (is_currency_code(code) && code == currency && !name.trim().is_empty()).then(|| name.trim().to_string())
}

/// The other currency of an exchange leg: "Exchanged to GBP" in a EUR row names GBP.
pub fn fx_currency(description: &str, currency: &str) -> Option<String> {
    let code = description
        .strip_prefix("Exchanged to ")
        .or_else(|| description.strip_prefix("Exchanged from "))?
        .trim();
    (is_currency_code(code) && code != currency).then(|| code.to_string())
}

fn kind_of(typ: &str, description: &str) -> KindHint {
    match norm(typ).as_str() {
        "card payment" => KindHint::Card,
        "card refund" | "refund" => KindHint::Refund,
        "transfer" => KindHint::Transfer,
        "exchange" => KindHint::Exchange,
        "reward" | "interest" | "cashback" => KindHint::Interest,
        "fee" | "charge" => KindHint::Fee,
        "topup" | "top-up" => KindHint::Topup,
        "atm" => KindHint::Atm,
        _ if description.starts_with("Exchanged to ") => KindHint::Exchange,
        _ => KindHint::Other,
    }
}

fn account_key(product: &str, currency: &str) -> String {
    format!("{KEY}:{}:{currency}", norm(product))
}

pub fn pocket_key(name: &str, currency: &str) -> String {
    format!("{KEY}:pocket:{}:{currency}", norm(name))
}

fn product_kind(product: &str) -> &'static str {
    match norm(product).as_str() {
        "savings" | "deposit" | "pocket" | "vault" => "savings",
        _ => "current",
    }
}

pub fn parse(rows: &[Vec<Cell>]) -> Result<ProfileOutput> {
    let h = find_header(rows, REQUIRED).ok_or_else(|| wrong_layout("Revolut"))?;
    let c_type = h.col("Type");
    let c_product = h.col("Product");
    let c_started = h.col("Started Date");
    let c_completed = h.col("Completed Date");
    let c_desc = h.col("Description");
    let c_amount = h.col("Amount");
    let c_fee = h.col("Fee");
    let c_currency = h.col("Currency");
    let c_state = h.col("State");
    let c_balance = h.col("Balance");

    let data = data_rows(rows, h.row);
    let slices: Vec<&[Cell]> = data.iter().map(|(_, r)| *r).collect();
    let amount_style = column_style(&slices, c_amount, DecimalStyle::Auto);
    let fee_style = column_style(&slices, c_fee, DecimalStyle::Auto);
    let balance_style = column_style(&slices, c_balance, DecimalStyle::Auto);
    let completed_fmt = column_date_format(&slices, c_completed, DATE_FORMATS);
    let started_fmt = column_date_format(&slices, c_started, DATE_FORMATS);

    let mut out = ProfileOutput { header: h.names.clone(), ..Default::default() };
    let mut not_completed = std::collections::BTreeMap::<String, usize>::new();
    let mut unreadable = Vec::new();

    for (line, row) in data {
        let state = cell(row, c_state).clean().unwrap_or_default().to_uppercase();
        if c_state.is_some() && state != "COMPLETED" {
            let label = if state.is_empty() { "no state".to_string() } else { state };
            *not_completed.entry(label).or_default() += 1;
            continue;
        }
        let currency = cell(row, c_currency).clean().unwrap_or_default().to_uppercase();
        let started = date_of(cell(row, c_started), started_fmt, DATE_FORMATS);
        let booked = date_of(cell(row, c_completed), completed_fmt, DATE_FORMATS).or(started);
        let exp = currency_exponent(&currency);
        let amount = amount_of(cell(row, c_amount), amount_style, exp);
        let (Some(booked), Some(amount), true) = (booked, amount, is_currency_code(&currency)) else {
            unreadable.push(line);
            continue;
        };
        let fee = amount_of(cell(row, c_fee), fee_style, exp).unwrap_or(0).abs();
        let balance = amount_of(cell(row, c_balance), balance_style, exp);
        let description = cell(row, c_desc).clean().unwrap_or_default();
        let typ = cell(row, c_type).clean().unwrap_or_default();
        let product = cell(row, c_product).clean().unwrap_or_else(|| "Current".into());

        let mut kind = kind_of(&typ, &description);
        let account_guess = account_key(&product, &currency);
        push_guess(
            &mut out.accounts,
            AccountGuess {
                guess_key: account_guess.clone(),
                name: format!("{INSTITUTION} {product} ({currency})"),
                institution: Some(INSTITUTION.into()),
                currency: currency.clone(),
                kind: product_kind(&product).into(),
                iban_mask: None,
                matched_account_id: None,
            },
        );

        let mut counterpart_guess = None;
        let mut payee = None;
        if let Some(pocket) = pocket_name(&description, &currency) {
            kind = KindHint::Transfer;
            let key = pocket_key(&pocket, &currency);
            push_guess(
                &mut out.accounts,
                AccountGuess {
                    guess_key: key.clone(),
                    name: pocket,
                    institution: Some(INSTITUTION.into()),
                    currency: currency.clone(),
                    kind: "savings".into(),
                    iban_mask: None,
                    matched_account_id: None,
                },
            );
            counterpart_guess = Some(key);
        } else {
            payee = match kind {
                KindHint::Card | KindHint::Refund => Some(description.clone()),
                KindHint::Transfer => ["Transfer to ", "Transfer from ", "Payment from ", "To ", "From "]
                    .iter()
                    .find_map(|p| description.strip_prefix(p))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                _ => None,
            };
        }
        let fx = (kind == KindHint::Exchange).then(|| fx_currency(&description, &currency)).flatten();

        out.rows.push(ParsedRow {
            line,
            booked_date: booked.date(),
            booked_at: Some(booked),
            occurred_at: Some(started.unwrap_or(booked)),
            value_date: started.map(|d| d.date()),
            description: decode::clean_text(&description),
            payee,
            amount_minor: amount,
            fee_minor: fee,
            currency,
            balance_minor: balance,
            bank_category: None,
            kind_hint: Some(kind),
            account_guess,
            counterpart_guess,
            fx_currency: fx,
            raw: raw_map(&h.names, row),
        });
    }

    if !not_completed.is_empty() {
        let total: usize = not_completed.values().sum();
        let parts: Vec<String> = not_completed.iter().map(|(s, n)| format!("{s} {n}")).collect();
        out.warnings.push(format!("{total} rows skipped as not completed ({})", parts.join(", ")));
    }
    if !unreadable.is_empty() {
        out.warnings.push(unreadable_warning(&unreadable));
    }
    Ok(out)
}

/// "rows 4, 9 skipped: no readable date, amount or currency" (line numbers only).
pub(crate) fn unreadable_warning(lines: &[usize]) -> String {
    let shown: Vec<String> = lines.iter().take(10).map(|l| l.to_string()).collect();
    let more = if lines.len() > 10 { format!(" and {} more", lines.len() - 10) } else { String::new() };
    let noun = if lines.len() == 1 { "row" } else { "rows" };
    format!("{noun} {}{more} skipped: no readable date, amount or currency", shown.join(", "))
}
