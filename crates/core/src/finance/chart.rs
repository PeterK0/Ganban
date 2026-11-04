//! The default chart of accounts, by nature (FINANCE.md § Default chart). Every account in
//! it can be renamed; the ones with a `system_key` are the ones the app posts to.

use std::collections::HashMap;

use super::{system, Conn, Entity};
use crate::error::Result;

/// The group a new financial account's ledger account sits under.
pub(crate) const GROUP_CASH: &str = "group_cash";
pub(crate) const GROUP_SAVINGS: &str = "group_savings";
pub(crate) const GROUP_CARDS_LOANS: &str = "group_cards_loans";

/// (code, name, class, parent code, cash-flow class, system key)
type Row = (&'static str, &'static str, &'static str, Option<&'static str>, Option<&'static str>, Option<&'static str>);

const OP: Option<&str> = Some("operating");

const DEFAULT: &[Row] = &[
    ("1000", "Cash and cash equivalents", "asset", None, OP, Some(GROUP_CASH)),
    ("1100", "Savings", "asset", None, Some("investing"), Some(GROUP_SAVINGS)),
    ("1300", "Prepayments", "asset", None, OP, Some(system::PREPAYMENTS)),
    ("1400", "Receivables", "asset", None, OP, Some(system::RECEIVABLES)),
    ("1900", "Transfers in transit", "asset", None, OP, Some(system::TRANSFERS_CLEARING)),
    ("2000", "Cards and loans", "liability", None, Some("financing"), Some(GROUP_CARDS_LOANS)),
    ("2100", "Accrued expenses", "liability", None, OP, Some(system::ACCRUED_EXPENSES)),
    ("3000", "Opening balance equity", "equity", None, None, Some(system::OPENING_EQUITY)),
    ("3100", "Accumulated surplus", "equity", None, None, None),
    ("3200", "OCI reserve", "equity", None, None, Some(system::OCI_RESERVE)),
    ("4000", "Salary", "income", None, OP, None),
    ("4100", "Interest", "income", None, OP, None),
    ("4200", "Other income", "income", None, OP, None),
    ("4300", "Realised FX gains", "income", None, OP, Some(system::FX_REALISED_GAIN)),
    ("4400", "Unrealised FX gains", "income", None, OP, Some(system::FX_UNREALISED_GAIN)),
    ("4900", "Uncategorised income", "income", None, OP, Some(system::UNCATEGORISED_INCOME)),
    ("5000", "Housing", "expense", None, OP, None),
    ("5100", "Utilities", "expense", None, OP, None),
    ("5200", "Groceries", "expense", None, OP, None),
    ("5300", "Eating out", "expense", None, OP, None),
    ("5400", "Transport", "expense", None, OP, None),
    ("5500", "Health", "expense", None, OP, None),
    ("5600", "Shopping", "expense", None, OP, None),
    ("5700", "Entertainment", "expense", None, OP, None),
    ("5800", "Subscriptions", "expense", None, OP, None),
    ("5900", "Travel", "expense", None, OP, None),
    ("6000", "Education", "expense", None, OP, None),
    ("6100", "Gifts", "expense", None, OP, None),
    ("6200", "Bank fees", "expense", None, OP, Some(system::BANK_FEES)),
    ("6300", "Taxes", "expense", None, OP, None),
    ("6400", "Realised FX losses", "expense", None, OP, Some(system::FX_REALISED_LOSS)),
    ("6500", "Unrealised FX losses", "expense", None, OP, Some(system::FX_UNREALISED_LOSS)),
    ("6900", "Uncategorised", "expense", None, OP, Some(system::UNCATEGORISED_EXPENSE)),
];

/// Create the default chart for a new entity.
pub(crate) async fn create_default(conn: &mut Conn, ent: &Entity) -> Result<()> {
    let mut ids: HashMap<&str, i64> = HashMap::new();
    for (position, (code, name, class, parent, cfc, key)) in DEFAULT.iter().enumerate() {
        let parent_id = parent.and_then(|p| ids.get(p).copied());
        let id = sqlx::query(
            "INSERT INTO fin_ledger_accounts (entity_id, code, name, class, parent_id, cash_flow_class, system_key, position) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ent.id)
        .bind(code)
        .bind(name)
        .bind(class)
        .bind(parent_id)
        .bind(cfc)
        .bind(key)
        .bind(position as i64 * 10)
        .execute(&mut *conn)
        .await?
        .last_insert_rowid();
        ids.insert(code, id);
    }
    Ok(())
}
