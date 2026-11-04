//! The statements (FINANCE.md § Wave 2, Statements): financial position, profit or loss with
//! OCI, cash flows (IAS 7, direct) and changes in net worth, as rows the UI renders.
//!
//! Profit or loss and the balances go by recognition period (releases not yet posted count
//! in their month); cash flow goes by cash date. Amounts are natural: assets, liabilities,
//! net worth, income and expenses positive.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::{json, Value};

use super::{add_months, chart, check_month, currency, month_end, schedules, system, Conn, Entity, LedgerAccount};
use crate::error::{AppError, Result};
use crate::Db;

pub const KINDS: &[&str] = &["position", "profit_loss", "cash_flow", "equity"];

#[derive(Debug, Clone, Serialize)]
pub struct Range {
    pub period: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub key: String,
    pub label: String,
    pub level: i64,
    /// `header` `line` `subtotal` `total`
    pub style: String,
    pub ledger_account_id: Option<i64>,
    pub amount_minor: i64,
    pub comparative_minor: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Statement {
    pub kind: String,
    pub period: String,
    pub from: String,
    pub to: String,
    pub currency: String,
    pub comparative: Option<Range>,
    pub rows: Vec<Row>,
    pub checks: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementCsv {
    pub file_name: String,
    pub content: String,
}

/// A month (`YYYY-MM`) or a year (`YYYY`), and the period before it.
fn range(period: &str) -> Result<(Range, Range)> {
    let p = period.trim();
    if p.len() == 4 && p.chars().all(|c| c.is_ascii_digit()) {
        let y: i32 = p.parse().unwrap_or(0);
        if y < 1901 {
            return Err(AppError::InvalidInput("the period is a month (YYYY-MM) or a year (YYYY)".into()));
        }
        let r = |y: i32| Range { period: y.to_string(), from: format!("{y:04}-01-01"), to: format!("{y:04}-12-31") };
        return Ok((r(y), r(y - 1)));
    }
    let m = check_month(p).map_err(|_| AppError::InvalidInput("the period is a month (YYYY-MM) or a year (YYYY)".into()))?;
    let r = |m: String| Range { from: format!("{m}-01"), to: month_end(&m), period: m };
    Ok((r(m.clone()), r(add_months(&m, -1))))
}

fn before(date: &str) -> String {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("a checked date");
    (d - chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
}

struct Books {
    chart: Vec<LedgerAccount>,
    by_id: HashMap<i64, LedgerAccount>,
}

impl Books {
    fn key_id(&self, key: &str) -> Option<i64> {
        self.chart.iter().find(|a| a.system_key.as_deref() == Some(key)).map(|a| a.id)
    }
    /// The OCI reserve: its system key, or an older entity's default by code.
    fn oci(&self) -> Option<i64> {
        self.key_id(system::OCI_RESERVE)
            .or_else(|| self.chart.iter().find(|a| a.code == "3200" && a.class == "equity" && a.system_key.is_none()).map(|a| a.id))
    }
    fn class_of(&self, id: i64) -> &str {
        self.by_id.get(&id).map_or("", |a| a.class.as_str())
    }
    fn cash_flow_class(&self, id: i64) -> String {
        let Some(a) = self.by_id.get(&id) else { return "operating".into() };
        a.cash_flow_class
            .clone()
            .or_else(|| a.parent_id.and_then(|p| self.by_id.get(&p)).and_then(|p| p.cash_flow_class.clone()))
            .unwrap_or_else(|| "operating".into())
    }
    /// Cash and cash equivalents: the group and the accounts under it.
    fn is_cash(&self, id: i64) -> bool {
        let group = self.key_id(chart::GROUP_CASH);
        self.by_id.get(&id).is_some_and(|a| group.is_some() && (Some(a.id) == group || a.parent_id == group))
    }
}

async fn books(conn: &mut Conn, ent: &Entity) -> Result<Books> {
    let chart: Vec<LedgerAccount> = sqlx::query_as("SELECT * FROM fin_ledger_accounts WHERE entity_id = ? ORDER BY code, id")
        .bind(ent.id)
        .fetch_all(conn)
        .await?;
    let by_id = chart.iter().map(|a| (a.id, a.clone())).collect();
    Ok(Books { chart, by_id })
}

/// Posted movements per account, debit positive, dated from `from` (or the start) to `to`,
/// plus the releases in those months not yet posted.
async fn movements(conn: &mut Conn, ent: &Entity, from: Option<&str>, to: &str) -> Result<HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT l.ledger_account_id, SUM(l.functional_minor) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         WHERE e.entity_id = ? AND e.status != 'draft' AND e.date >= ? AND e.date <= ? GROUP BY l.ledger_account_id",
    )
    .bind(ent.id)
    .bind(from.unwrap_or(""))
    .bind(to)
    .fetch_all(&mut *conn)
    .await?;
    let mut out: HashMap<i64, i64> = rows.into_iter().collect();
    let first = from.map_or("0000-01".to_string(), |f| f[..7].to_string());
    for r in schedules::pending_releases(conn, ent, &first, &to[..7]).await? {
        *out.entry(r.ledger_account_id).or_default() += r.amount_minor;
        *out.entry(r.balance_account_id).or_default() -= r.amount_minor;
    }
    Ok(out)
}

/// A row before the comparative is merged in.
struct R {
    key: String,
    label: String,
    level: i64,
    style: &'static str,
    la: Option<i64>,
    amount: i64,
}

fn r(key: impl Into<String>, label: impl Into<String>, level: i64, style: &'static str, amount: i64) -> R {
    R { key: key.into(), label: label.into(), level, style, la: None, amount }
}

/// The account lines of one class, natural sign, non-zero only. Returns their total.
fn account_lines(out: &mut Vec<R>, b: &Books, bal: &HashMap<i64, i64>, class: &str, sign: i64, prefix: &str) -> i64 {
    let mut total = 0;
    for a in b.chart.iter().filter(|a| a.class == class) {
        let v = sign * bal.get(&a.id).copied().unwrap_or(0);
        if v != 0 {
            out.push(R { la: Some(a.id), ..r(format!("{prefix}:{}", a.id), a.name.clone(), 1, "line", v) });
            total += v;
        }
    }
    total
}

fn sum_class(b: &Books, bal: &HashMap<i64, i64>, classes: &[&str]) -> i64 {
    bal.iter().filter(|(id, _)| classes.contains(&b.class_of(**id))).map(|(_, v)| v).sum()
}

async fn position(conn: &mut Conn, ent: &Entity, b: &Books, rg: &Range) -> Result<(Vec<R>, Value)> {
    let bal = movements(conn, ent, None, &rg.to).await?;
    let mut out = vec![r("assets", "Assets", 0, "header", 0)];
    let assets = account_lines(&mut out, b, &bal, "asset", 1, "asset");
    out.push(r("assets_total", "Total assets", 0, "subtotal", assets));
    out.push(r("liabilities", "Liabilities", 0, "header", 0));
    let liabilities = account_lines(&mut out, b, &bal, "liability", -1, "liability");
    out.push(r("liabilities_total", "Total liabilities", 0, "subtotal", liabilities));
    out.push(r("net_worth", "Net worth", 0, "header", 0));
    let equity = account_lines(&mut out, b, &bal, "equity", -1, "equity");
    let surplus = -sum_class(b, &bal, &["income", "expense"]);
    out.push(r("surplus_to_date", "Surplus to date", 1, "line", surplus));
    let net_worth = equity + surplus;
    out.push(r("net_worth_total", "Total net worth", 0, "subtotal", net_worth));
    out.push(r("liabilities_net_worth", "Total liabilities and net worth", 0, "total", liabilities + net_worth));
    let checks = json!({ "balanced": assets == liabilities + net_worth, "assets_minor": assets,
        "liabilities_minor": liabilities, "net_worth_minor": net_worth });
    Ok((out, checks))
}

async fn profit_loss(conn: &mut Conn, ent: &Entity, b: &Books, rg: &Range) -> Result<(Vec<R>, Value)> {
    let bal = movements(conn, ent, Some(&rg.from), &rg.to).await?;
    let mut out = vec![r("income", "Income", 0, "header", 0)];
    let income = account_lines(&mut out, b, &bal, "income", -1, "income");
    out.push(r("income_total", "Total income", 0, "subtotal", income));
    out.push(r("expenses", "Expenses", 0, "header", 0));
    let expenses = account_lines(&mut out, b, &bal, "expense", 1, "expense");
    out.push(r("expenses_total", "Total expenses", 0, "subtotal", expenses));
    let surplus = income - expenses;
    out.push(r("surplus", "Surplus or deficit", 0, "total", surplus));
    out.push(r("oci", "Other comprehensive income", 0, "header", 0));
    let oci = b.oci().map_or(0, |id| -bal.get(&id).copied().unwrap_or(0));
    out.push(r("oci_reserve", "Movements in the OCI reserve", 1, "line", oci));
    out.push(r("comprehensive", "Total comprehensive income", 0, "total", surplus + oci));
    let checks = json!({ "surplus_minor": surplus, "oci_minor": oci });
    Ok((out, checks))
}

const FLOW_CLASSES: &[(&str, &str, &str)] = &[
    ("operating", "Operating activities", "Net cash from operating activities"),
    ("investing", "Investing activities", "Net cash from investing activities"),
    ("financing", "Financing activities", "Net cash from financing activities"),
];

async fn cash_flow(conn: &mut Conn, ent: &Entity, b: &Books, rg: &Range) -> Result<(Vec<R>, Value)> {
    let lines: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT l.entry_id, l.ledger_account_id, l.functional_minor FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         WHERE e.entity_id = ? AND e.status != 'draft' AND e.date BETWEEN ? AND ? ORDER BY l.entry_id, l.id",
    )
    .bind(ent.id)
    .bind(&rg.from)
    .bind(&rg.to)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_entry: BTreeMap<i64, Vec<(i64, i64)>> = BTreeMap::new();
    for (e, a, f) in lines {
        by_entry.entry(e).or_default().push((a, f));
    }
    by_entry.retain(|_, ls| ls.iter().any(|(a, _)| b.is_cash(*a)));
    let clearing = b.key_id(system::TRANSFERS_CLEARING);
    let fx_keys = [b.key_id(system::FX_UNREALISED_GAIN), b.key_id(system::FX_UNREALISED_LOSS)];
    // A transfer's other side: the account on the paired entry.
    let pairs: Vec<(i64, i64)> = sqlx::query_as("SELECT entry_a, entry_b FROM fin_pairs WHERE entity_id = ? AND status != 'rejected'")
        .bind(ent.id)
        .fetch_all(&mut *conn)
        .await?;
    let mut other: HashMap<i64, i64> = HashMap::new();
    for (a, c) in pairs {
        other.insert(a, c);
        other.insert(c, a);
    }
    let mut flows: BTreeMap<(usize, String), (String, Option<i64>, i64)> = BTreeMap::new();
    let opening_equity = b.key_id(system::OPENING_EQUITY);
    let (mut fx, mut recorded) = (0i64, 0i64);
    for (entry, ls) in &by_entry {
        // A retranslation moves no cash: all of its effect on cash is the FX line.
        let retranslation = ls.iter().any(|(a, _)| fx_keys.contains(&Some(*a)));
        for &(account, f) in ls.iter().filter(|(a, _)| !b.is_cash(*a)) {
            let flow = -f;
            if retranslation {
                fx += flow;
                continue;
            }
            if Some(account) == opening_equity {
                recorded += flow;
                continue;
            }
            let mut through = account;
            if Some(account) == clearing {
                if let Some(o) = other.get(entry) {
                    let side: Vec<(i64, i64)> = sqlx::query_as("SELECT ledger_account_id, functional_minor FROM fin_lines WHERE entry_id = ? ORDER BY id")
                        .bind(o)
                        .fetch_all(&mut *conn)
                        .await?;
                    if let Some(&(x, _)) = side.iter().filter(|(x, _)| Some(*x) != clearing).max_by_key(|(_, f)| f.abs()) {
                        through = x;
                    }
                }
            }
            let (class, key, label, la) = if through != account && b.is_cash(through) {
                ("operating".to_string(), "transfers_cash".to_string(), "Transfers between cash accounts".to_string(), None)
            } else {
                let name = b.by_id.get(&through).map_or(String::new(), |a| a.name.clone());
                (b.cash_flow_class(through), format!("{}", through), name, Some(through))
            };
            let order = FLOW_CLASSES.iter().position(|c| c.0 == class).unwrap_or(0);
            let code = la.and_then(|id| b.by_id.get(&id)).map_or("~".to_string(), |a| a.code.clone());
            let slot = flows.entry((order, format!("{code}:{key}"))).or_insert((label, la, 0));
            slot.2 += flow;
        }
    }
    let cash_ids: Vec<i64> = b.chart.iter().filter(|a| b.is_cash(a.id)).map(|a| a.id).collect();
    let cash_at = |bal: &HashMap<i64, i64>| cash_ids.iter().map(|id| bal.get(id).copied().unwrap_or(0)).sum::<i64>();
    let opening = cash_at(&movements(conn, ent, None, &before(&rg.from)).await?);
    let closing = cash_at(&movements(conn, ent, None, &rg.to).await?);
    let mut out = Vec::new();
    let mut net = 0;
    for (i, (class, title, total)) in FLOW_CLASSES.iter().enumerate() {
        out.push(r(*class, *title, 0, "header", 0));
        let mut sub = 0;
        for ((_, key), (label, la, amount)) in flows.range((i, String::new())..(i + 1, String::new())) {
            if *amount != 0 {
                out.push(R { la: *la, ..r(format!("{class}:{key}"), label.clone(), 1, "line", *amount) });
                sub += amount;
            }
        }
        out.push(r(format!("{class}_total"), *total, 0, "subtotal", sub));
        net += sub;
    }
    out.push(r("net_change", "Net change in cash", 0, "total", net));
    out.push(r("fx_effect", "Effect of exchange rate changes on cash", 0, "line", fx));
    out.push(r("opening_balances", "Opening balances recorded", 0, "line", recorded));
    out.push(r("cash_opening", "Cash at the beginning of the period", 0, "line", opening));
    out.push(r("cash_closing", "Cash at the end of the period", 0, "total", closing));
    let checks = json!({ "reconciles": opening + net + fx + recorded == closing, "opening_minor": opening,
        "net_change_minor": net, "fx_effect_minor": fx, "opening_balances_minor": recorded, "closing_minor": closing });
    Ok((out, checks))
}

async fn equity(conn: &mut Conn, ent: &Entity, b: &Books, rg: &Range) -> Result<(Vec<R>, Value)> {
    let net_worth = |bal: &HashMap<i64, i64>| -sum_class(b, bal, &["equity", "income", "expense"]);
    let opening = net_worth(&movements(conn, ent, None, &before(&rg.from)).await?);
    let closing = net_worth(&movements(conn, ent, None, &rg.to).await?);
    let bal = movements(conn, ent, Some(&rg.from), &rg.to).await?;
    let get = |id: Option<i64>| id.map_or(0, |id| -bal.get(&id).copied().unwrap_or(0));
    let surplus = -sum_class(b, &bal, &["income", "expense"]);
    let (oci_id, opening_id) = (b.oci(), b.key_id(system::OPENING_EQUITY));
    let (oci, recorded) = (get(oci_id), get(opening_id));
    let other = -sum_class(b, &bal, &["equity"]) - oci - recorded;
    let out = vec![
        r("opening", "Net worth at the beginning of the period", 0, "line", opening),
        r("surplus", "Surplus or deficit", 1, "line", surplus),
        r("oci", "Other comprehensive income", 1, "line", oci),
        r("opening_balances", "Opening balances recorded", 1, "line", recorded),
        r("other", "Other movements in net worth", 1, "line", other),
        r("closing", "Net worth at the end of the period", 0, "total", closing),
    ];
    let checks = json!({ "reconciles": opening + surplus + oci + recorded + other == closing });
    Ok((out, checks))
}

async fn build(conn: &mut Conn, ent: &Entity, b: &Books, kind: &str, rg: &Range) -> Result<(Vec<R>, Value)> {
    match kind {
        "position" => position(conn, ent, b, rg).await,
        "profit_loss" => profit_loss(conn, ent, b, rg).await,
        "cash_flow" => cash_flow(conn, ent, b, rg).await,
        "equity" => equity(conn, ent, b, rg).await,
        _ => Err(AppError::InvalidInput(format!("a statement is one of: {}", KINDS.join(", ")))),
    }
}

/// Merge the comparative's rows into the current ones by key, keeping each row's place.
fn merge(current: Vec<R>, comparative: Option<Vec<R>>) -> Vec<Row> {
    let row = |x: R, cmp: Option<i64>| Row {
        key: x.key,
        label: x.label,
        level: x.level,
        style: x.style.into(),
        ledger_account_id: x.la,
        amount_minor: x.amount,
        comparative_minor: cmp,
    };
    let Some(comparative) = comparative else { return current.into_iter().map(|x| row(x, None)).collect() };
    let values: HashMap<String, i64> = comparative.iter().map(|c| (c.key.clone(), c.amount)).collect();
    let mut out: Vec<Row> = current.into_iter().map(|x| {
        let v = values.get(&x.key).copied().unwrap_or(0);
        row(x, Some(v))
    }).collect();
    let mut at = 0;
    for c in comparative {
        if let Some(i) = out.iter().position(|o| o.key == c.key) {
            at = i + 1;
        } else {
            out.insert(at, row(R { amount: 0, ..c }, None));
            out[at].comparative_minor = Some(values[&out[at].key]);
            at += 1;
        }
    }
    out
}

pub async fn statement(db: &Db, ent: &Entity, kind: &str, period: &str, comparatives: bool) -> Result<Statement> {
    if !KINDS.contains(&kind) {
        return Err(AppError::InvalidInput(format!("a statement is one of: {}", KINDS.join(", "))));
    }
    let (rg, prev) = range(period)?;
    let mut conn = db.acquire().await?;
    let b = books(&mut conn, ent).await?;
    let (rows, checks) = build(&mut conn, ent, &b, kind, &rg).await?;
    let comparative = if comparatives { Some(build(&mut conn, ent, &b, kind, &prev).await?.0) } else { None };
    Ok(Statement {
        kind: kind.into(),
        period: rg.period.clone(),
        from: rg.from.clone(),
        to: rg.to.clone(),
        currency: ent.functional_currency.clone(),
        comparative: comparatives.then_some(prev),
        rows: merge(rows, comparative),
        checks,
    })
}

/// Minor units as a plain decimal in major units, `-1234.50`.
pub fn major(minor: i64, cur: &str) -> String {
    let exp = currency::exponent(cur);
    if exp == 0 {
        return minor.to_string();
    }
    let div = 10i64.pow(exp);
    let sign = if minor < 0 { "-" } else { "" };
    format!("{sign}{}.{:0width$}", minor.unsigned_abs() / div as u64, minor.unsigned_abs() % div as u64, width = exp as usize)
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub async fn statement_csv(db: &Db, ent: &Entity, kind: &str, period: &str, comparatives: bool) -> Result<StatementCsv> {
    let s = statement(db, ent, kind, period, comparatives).await?;
    let mut content = format!("Line,{} ({})", csv_field(&s.period), s.currency);
    if let Some(c) = &s.comparative {
        content.push_str(&format!(",{} ({})", csv_field(&c.period), s.currency));
    }
    content.push_str("\r\n");
    for row in &s.rows {
        let amount = if row.style == "header" { String::new() } else { major(row.amount_minor, &s.currency) };
        content.push_str(&format!("{},{}", csv_field(&format!("{}{}", "  ".repeat(row.level as usize), row.label)), amount));
        if s.comparative.is_some() {
            let cmp = match (row.style.as_str(), row.comparative_minor) {
                ("header", _) | (_, None) => String::new(),
                (_, Some(v)) => major(v, &s.currency),
            };
            content.push_str(&format!(",{cmp}"));
        }
        content.push_str("\r\n");
    }
    Ok(StatementCsv { file_name: format!("{}-{}.csv", s.kind.replace('_', "-"), s.period), content })
}
