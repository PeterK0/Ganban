//! The mapping wizard's profile: the user says which column is which.
//!
//! A mapping is stored as JSON in `fin_profiles.mapping_json`. Columns are named by
//! header text (matched case-insensitively) or by 0-based index.

use serde::{Deserialize, Serialize};

use super::revolut::unreadable_warning;
use super::{
    amount_of, cell, column_date_format, column_style, data_rows, date_of, find_header, norm, push_guess,
    raw_map, Header, HEADER_SCAN_ROWS,
};
use crate::error::{AppError, Result};
use crate::finance::import::decode::{currency_exponent, is_currency_code, DecimalStyle, AUTO_DATE_FORMATS};
use crate::finance::import::{AccountGuess, Cell, KindHint, ParsedRow, ProfileOutput};

/// A column, by header name or 0-based index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColRef {
    Index(usize),
    Name(String),
}

/// Which column holds what, and how to read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mapping {
    /// The 0-based header row. `None` finds the first row holding every named
    /// column (row 0 when all columns are indexes).
    pub header_row: Option<usize>,
    pub booked_date: Option<ColRef>,
    pub value_date: Option<ColRef>,
    /// One or more columns, joined with " — ".
    pub description: Vec<ColRef>,
    pub payee: Option<ColRef>,
    /// A signed amount column…
    pub amount: Option<ColRef>,
    /// …or money out and money in as separate unsigned columns.
    pub debit: Option<ColRef>,
    pub credit: Option<ColRef>,
    pub fee: Option<ColRef>,
    pub currency: Option<ColRef>,
    pub balance: Option<ColRef>,
    pub bank_category: Option<ColRef>,
    /// A `chrono` format for text dates (`%d/%m/%Y`); detected when unset.
    pub date_format: Option<String>,
    pub decimal: DecimalStyle,
    /// Flip every amount (card statements that list spending as positive).
    pub invert_sign: bool,
    /// The currency when there is no currency column (EUR when unset).
    pub currency_default: Option<String>,
    pub account_name: Option<String>,
    /// `current` `savings` `card` `cash` `loan` (`current` when unset).
    pub account_kind: Option<String>,
    pub institution: Option<String>,
}

impl Mapping {
    /// Checks the mapping can produce rows: a date, a description and an amount.
    pub fn validate(&self) -> Result<()> {
        let bad = |m: &str| Err(AppError::InvalidInput(m.into()));
        if self.booked_date.is_none() {
            return bad("the mapping needs a date column");
        }
        if self.description.is_empty() {
            return bad("the mapping needs a description column");
        }
        if self.amount.is_none() && self.debit.is_none() && self.credit.is_none() {
            return bad("the mapping needs an amount column, or debit and credit columns");
        }
        if let Some(c) = &self.currency_default {
            if !is_currency_code(c) {
                return bad("the default currency must be a three-letter code");
            }
        }
        if let Some(k) = &self.account_kind {
            if !["current", "savings", "card", "cash", "loan"].contains(&k.as_str()) {
                return bad("unknown account kind");
            }
        }
        Ok(())
    }

    fn refs(&self) -> Vec<&ColRef> {
        let singles = [
            &self.booked_date,
            &self.value_date,
            &self.payee,
            &self.amount,
            &self.debit,
            &self.credit,
            &self.fee,
            &self.currency,
            &self.balance,
            &self.bank_category,
        ];
        singles.into_iter().flatten().chain(self.description.iter()).collect()
    }

    fn header(&self, rows: &[Vec<Cell>]) -> Option<Header> {
        if let Some(r) = self.header_row {
            return Header::at(rows, r);
        }
        let names: Vec<&str> = self
            .refs()
            .into_iter()
            .filter_map(|r| match r {
                ColRef::Name(n) => Some(n.as_str()),
                ColRef::Index(_) => None,
            })
            .collect();
        if names.is_empty() {
            return Header::at(rows, 0);
        }
        find_header(&rows[..rows.len().min(HEADER_SCAN_ROWS)], &names)
    }
}

fn resolve(h: &Header, r: &Option<ColRef>) -> Option<usize> {
    r.as_ref().and_then(|r| resolve_one(h, r))
}

fn resolve_one(h: &Header, r: &ColRef) -> Option<usize> {
    match r {
        ColRef::Index(i) => Some(*i),
        ColRef::Name(n) => h.col(n),
    }
}

pub fn parse(key: &str, m: &Mapping, rows: &[Vec<Cell>]) -> Result<ProfileOutput> {
    m.validate()?;
    let h = m
        .header(rows)
        .ok_or_else(|| AppError::InvalidInput("the mapped columns aren't in this file".into()))?;
    let c_date = resolve(&h, &m.booked_date);
    let c_value = resolve(&h, &m.value_date);
    let c_desc: Vec<usize> = m.description.iter().filter_map(|r| resolve_one(&h, r)).collect();
    let c_payee = resolve(&h, &m.payee);
    let c_amount = resolve(&h, &m.amount);
    let c_debit = resolve(&h, &m.debit);
    let c_credit = resolve(&h, &m.credit);
    let c_fee = resolve(&h, &m.fee);
    let c_currency = resolve(&h, &m.currency);
    let c_balance = resolve(&h, &m.balance);
    let c_category = resolve(&h, &m.bank_category);

    let data = data_rows(rows, h.row);
    let slices: Vec<&[Cell]> = data.iter().map(|(_, r)| *r).collect();
    let style_of = |c| column_style(&slices, c, m.decimal);
    let (s_amount, s_debit, s_credit, s_fee, s_balance) =
        (style_of(c_amount), style_of(c_debit), style_of(c_credit), style_of(c_fee), style_of(c_balance));
    let date_fmt: Option<String> = m
        .date_format
        .clone()
        .or_else(|| column_date_format(&slices, c_date, AUTO_DATE_FORMATS).map(String::from));
    let value_fmt: Option<String> = m
        .date_format
        .clone()
        .or_else(|| column_date_format(&slices, c_value, AUTO_DATE_FORMATS).map(String::from));

    let default_currency = m.currency_default.clone().unwrap_or_else(|| "EUR".into());
    let name = m
        .account_name
        .clone()
        .or_else(|| m.institution.clone())
        .unwrap_or_else(|| "Imported account".into());
    let kind = m.account_kind.clone().unwrap_or_else(|| "current".into());

    let mut out = ProfileOutput { header: h.names.clone(), ..Default::default() };
    let mut unreadable = Vec::new();
    for (line, row) in data {
        let currency = cell(row, c_currency)
            .clean()
            .map(|c| c.to_uppercase())
            .filter(|c| is_currency_code(c))
            .unwrap_or_else(|| default_currency.clone());
        let exp = currency_exponent(&currency);
        let amount = if c_amount.is_some() {
            amount_of(cell(row, c_amount), s_amount, exp)
        } else {
            let out_ = amount_of(cell(row, c_debit), s_debit, exp);
            let in_ = amount_of(cell(row, c_credit), s_credit, exp);
            match (out_, in_) {
                (None, None) => None,
                (o, i) => Some(i.unwrap_or(0).abs() - o.unwrap_or(0).abs()),
            }
        };
        let booked = date_of(cell(row, c_date), date_fmt.as_deref(), AUTO_DATE_FORMATS);
        let (Some(booked), Some(amount)) = (booked, amount) else {
            unreadable.push(line);
            continue;
        };
        let amount = if m.invert_sign { -amount } else { amount };
        let parts: Vec<String> = c_desc.iter().filter_map(|c| cell(row, Some(*c)).clean()).collect();
        let category = cell(row, c_category).clean();
        let guess_key = format!("{key}:{}:{currency}", norm(&name));
        push_guess(
            &mut out.accounts,
            AccountGuess {
                guess_key: guess_key.clone(),
                name: name.clone(),
                institution: m.institution.clone(),
                currency: currency.clone(),
                kind: kind.clone(),
                iban_mask: None,
                matched_account_id: None,
            },
        );
        let kind_hint = category.as_deref().and_then(|c| super::piraeus::kind_of(c, "")).or(Some(KindHint::Other));
        out.rows.push(ParsedRow {
            line,
            booked_date: booked.date(),
            booked_at: (booked.time() != chrono::NaiveTime::MIN).then_some(booked),
            value_date: date_of(cell(row, c_value), value_fmt.as_deref(), AUTO_DATE_FORMATS).map(|d| d.date()),
            description: parts.join(" — "),
            payee: cell(row, c_payee).clean(),
            amount_minor: amount,
            fee_minor: amount_of(cell(row, c_fee), s_fee, exp).unwrap_or(0).abs(),
            currency,
            balance_minor: amount_of(cell(row, c_balance), s_balance, exp),
            bank_category: category,
            kind_hint,
            account_guess: guess_key,
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
