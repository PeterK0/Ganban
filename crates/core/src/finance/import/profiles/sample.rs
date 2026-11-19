//! A made-up built-in format for the engine's tests (compiled only for tests, or with
//! the `sample-format` feature): every field a built-in format can produce is a column
//! of its own, so a test says exactly what a bank's export would have said.
//!
//! Columns: `Kind, Account, Time, Booked, Text, Amount, Fee, Currency, Balance, Other,
//! Fx`. `Kind` is a [`KindHint`] in lower case; `Time` is the bank's own timestamp
//! (dedupe's tiebreak) and `Booked` the booking date or date-time; `Other` names the
//! user's account on the far side of a move (a pocket), and `Fx` the other currency of
//! an exchange leg, whose other side is the same account in that currency. Accounts are keyed `sample:<account>:<currency>` and named
//! `<account> (<currency>)`.

use super::{
    amount_of, cell, column_date_format, column_style, data_rows, date_of, find_header, norm, push_guess, raw_map,
    unreadable_warning, wrong_layout, BuiltinFormat,
};
use crate::error::Result;
use crate::finance::import::decode::{self, currency_exponent, is_currency_code, DecimalStyle};
use crate::finance::import::{AccountGuess, Cell, KindHint, ParsedRow, ProfileOutput};

pub const KEY: &str = "sample";
const INSTITUTION: &str = "Sample Bank";
const REQUIRED: &[&str] = &["Kind", "Account", "Booked", "Text", "Amount", "Currency"];
const DATE_FORMATS: &[&str] = &["%Y-%m-%d %H:%M:%S", "%Y-%m-%d"];

pub const FORMAT: BuiltinFormat = BuiltinFormat {
    key: KEY,
    name: "Sample format",
    detect,
    parse,
    occurred_at_column: Some("Time"),
    booked_at_column: Some("Booked"),
};

fn detect(rows: &[Vec<Cell>]) -> Option<f64> {
    find_header(rows, REQUIRED).map(|_| 0.9)
}

fn kind_of(s: &str) -> KindHint {
    match norm(s).as_str() {
        "card" => KindHint::Card,
        "transfer" => KindHint::Transfer,
        "exchange" => KindHint::Exchange,
        "interest" => KindHint::Interest,
        "fee" => KindHint::Fee,
        "refund" => KindHint::Refund,
        "topup" => KindHint::Topup,
        "atm" => KindHint::Atm,
        _ => KindHint::Other,
    }
}

fn key_of(account: &str, currency: &str) -> String {
    format!("{KEY}:{}:{currency}", norm(account))
}

fn guess(key: &str, name: &str, currency: &str, kind: &str) -> AccountGuess {
    AccountGuess {
        guess_key: key.into(),
        name: name.into(),
        institution: Some(INSTITUTION.into()),
        currency: currency.into(),
        kind: kind.into(),
        iban_mask: None,
        matched_account_id: None,
    }
}

fn parse(rows: &[Vec<Cell>]) -> Result<ProfileOutput> {
    let h = find_header(rows, REQUIRED).ok_or_else(|| wrong_layout("sample"))?;
    let [c_kind, c_account, c_time, c_booked, c_text, c_amount, c_fee, c_currency, c_balance, c_other, c_fx] =
        ["Kind", "Account", "Time", "Booked", "Text", "Amount", "Fee", "Currency", "Balance", "Other", "Fx"]
            .map(|n| h.col(n));
    let data = data_rows(rows, h.row);
    let slices: Vec<&[Cell]> = data.iter().map(|(_, r)| *r).collect();
    let style = |c| column_style(&slices, c, DecimalStyle::Auto);
    let (s_amount, s_fee, s_balance) = (style(c_amount), style(c_fee), style(c_balance));
    let time_fmt = column_date_format(&slices, c_time, DATE_FORMATS);
    let booked_fmt = column_date_format(&slices, c_booked, DATE_FORMATS);

    let mut out = ProfileOutput { header: h.names.clone(), ..Default::default() };
    let mut unreadable = Vec::new();
    for (line, row) in data {
        let currency = cell(row, c_currency).clean().unwrap_or_default().to_uppercase();
        let exp = currency_exponent(&currency);
        let booked = date_of(cell(row, c_booked), booked_fmt, DATE_FORMATS);
        let amount = amount_of(cell(row, c_amount), s_amount, exp);
        let (Some(booked), Some(amount), true) = (booked, amount, is_currency_code(&currency)) else {
            unreadable.push(line);
            continue;
        };
        let booked_at = (booked.time() != chrono::NaiveTime::MIN).then_some(booked);
        let time = date_of(cell(row, c_time), time_fmt, DATE_FORMATS);
        let account = cell(row, c_account).clean().unwrap_or_else(|| "Current".into());
        let account_kind =
            if ["savings", "vault", "pocket"].contains(&norm(&account).as_str()) { "savings" } else { "current" };
        let account_guess = key_of(&account, &currency);
        let name = format!("{account} ({currency})");
        push_guess(&mut out.accounts, guess(&account_guess, &name, &currency, account_kind));
        let description = decode::clean_text(&cell(row, c_text).clean().unwrap_or_default());
        let mut kind = kind_of(&cell(row, c_kind).clean().unwrap_or_default());
        let fx = cell(row, c_fx).clean().map(|c| c.to_uppercase()).filter(|c| is_currency_code(c) && *c != currency);
        let mut counterpart_guess = cell(row, c_other).clean().map(|other| {
            kind = KindHint::Transfer;
            let key = key_of(&other, &currency);
            push_guess(&mut out.accounts, guess(&key, &other, &currency, "savings"));
            key
        });
        // An exchange leg moves money to the user's own balance in the other currency: the
        // same account in that currency, made on first sight.
        if let (KindHint::Exchange, None, Some(fx)) = (kind, &counterpart_guess, &fx) {
            let key = key_of(&account, fx);
            push_guess(&mut out.accounts, guess(&key, &format!("{account} ({fx})"), fx, account_kind));
            counterpart_guess = Some(key);
        }
        out.rows.push(ParsedRow {
            line,
            booked_date: booked.date(),
            booked_at,
            occurred_at: time.or(booked_at),
            value_date: time.map(|t| t.date()),
            payee: matches!(kind, KindHint::Card | KindHint::Refund).then(|| description.clone()),
            description,
            amount_minor: amount,
            fee_minor: amount_of(cell(row, c_fee), s_fee, exp).unwrap_or(0).abs(),
            balance_minor: amount_of(cell(row, c_balance), s_balance, exp),
            bank_category: None,
            kind_hint: Some(kind),
            account_guess,
            counterpart_guess,
            fx_currency: fx,
            currency,
            raw: raw_map(&h.names, row),
        });
    }
    if !unreadable.is_empty() {
        out.warnings.push(unreadable_warning(&unreadable));
    }
    Ok(out)
}
