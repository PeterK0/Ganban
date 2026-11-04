//! The forecast (FINANCE.md § Wave 2, Forecast): the end-of-month cash balance from confirmed
//! recurring items, planned items and category medians, line by line, with a band. Every
//! figure comes from the books and `today`, so the same inputs give the same forecast.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::NaiveDate;
use serde::Serialize;

use super::budgets::{recognised_in, targets_in};
use super::recurring::{bank_entries, list_planned_in, list_recurring_in, median_of, step};
use super::{add_months, check_date, check_month, month_end, Conn, Entity, LedgerAccount};
use crate::error::Result;
use crate::Db;

#[derive(Debug, Clone, Serialize)]
pub struct ForecastLine {
    /// `opening` `actual` `recurring` `planned` `category`
    pub kind: String,
    pub label: String,
    pub date: Option<String>,
    pub amount_minor: i64,
    pub low_minor: i64,
    pub high_minor: i64,
    pub ledger_account_id: Option<i64>,
    pub ref_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryProjection {
    pub ledger_account_id: i64,
    pub name: String,
    pub class: String,
    pub actual_minor: i64,
    pub projected_minor: i64,
    pub median_minor: i64,
    pub history_months: i64,
    pub budget_minor: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Overshoot {
    pub ledger_account_id: i64,
    pub name: String,
    pub budget_minor: i64,
    pub projected_minor: i64,
    pub over_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Forecast {
    pub month: String,
    pub as_of: String,
    pub opening_minor: i64,
    pub end_minor: i64,
    pub low_minor: i64,
    pub high_minor: i64,
    pub lines: Vec<ForecastLine>,
    pub categories: Vec<CategoryProjection>,
    pub warnings: Vec<Overshoot>,
}

/// The fewest and most complete months of history a category median uses.
const MIN_HISTORY: usize = 3;
const MAX_HISTORY: i64 = 6;

/// The cash balance (every account but loans, drafts included) at the end of `date`.
async fn cash_at(conn: &mut Conn, ent: &Entity, date: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT IFNULL(SUM(l.functional_minor), 0) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_accounts fa ON fa.ledger_account_id = l.ledger_account_id \
         WHERE e.entity_id = ? AND fa.kind != 'loan' AND e.date <= ?",
    )
    .bind(ent.id)
    .bind(date)
    .fetch_one(conn)
    .await?)
}

/// A category's history: the median and range of its monthly cash effect.
struct Stats {
    median: i64,
    low: i64,
    high: i64,
}

fn line(kind: &str, label: String, date: Option<String>, amount: i64, low: i64, high: i64) -> ForecastLine {
    ForecastLine { kind: kind.into(), label, date, amount_minor: amount, low_minor: low, high_minor: high, ledger_account_id: None, ref_id: None }
}

/// Keep a projection on its side of zero: an outflow category can't project an inflow.
fn clip(value: i64, outflow: bool) -> i64 {
    if outflow {
        value.min(0)
    } else {
        value.max(0)
    }
}

/// A cash effect in a category's natural sign (spent or received, positive).
fn natural(cash: i64, class: &str) -> i64 {
    if class == "expense" {
        -cash
    } else {
        cash
    }
}

pub async fn forecast(db: &Db, ent: &Entity, month: &str, today: &str) -> Result<Forecast> {
    let month = check_month(month)?;
    let today = check_date(today)?;
    let current = today[..7].to_string();
    let mut conn = db.acquire().await?;
    let chart: Vec<LedgerAccount> =
        sqlx::query_as("SELECT * FROM fin_ledger_accounts WHERE entity_id = ?").bind(ent.id).fetch_all(&mut *conn).await?;
    let chart: HashMap<i64, LedgerAccount> = chart.into_iter().map(|a| (a.id, a)).collect();
    let budgets = targets_in(&mut conn, ent, &month).await?;

    // A month that's over: what happened.
    if month < current {
        let start = (super::month_start(&month) - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let (opening, end) = (cash_at(&mut conn, ent, &start).await?, cash_at(&mut conn, ent, &month_end(&month)).await?);
        let recognised = recognised_in(&mut conn, ent, &month, &month).await?;
        let mut categories = Vec::new();
        for (&id, &f) in &recognised {
            let Some(la) = chart.get(&id) else { continue };
            let actual = natural(-f, &la.class);
            categories.push(CategoryProjection {
                ledger_account_id: id,
                name: la.name.clone(),
                class: la.class.clone(),
                actual_minor: actual,
                projected_minor: actual,
                median_minor: 0,
                history_months: 0,
                budget_minor: budgets.get(&id).map(|b| b.amount_minor),
            });
        }
        let lines = vec![
            line("opening", "Balance at the start".into(), None, opening, opening, opening),
            line("actual", "What happened".into(), None, end - opening, end - opening, end - opening),
        ];
        return Ok(finish(month, today, opening, (end, end, end), lines, categories, &chart));
    }

    // History: up to six complete months before this one, from the first with bank lines.
    let first: Option<String> = sqlx::query_scalar(
        "SELECT MIN(e.date) FROM fin_entries e JOIN fin_lines l ON l.entry_id = e.id \
         JOIN fin_accounts fa ON fa.ledger_account_id = l.ledger_account_id WHERE e.entity_id = ?",
    )
    .bind(ent.id)
    .fetch_one(&mut *conn)
    .await?;
    let hist_from = add_months(&current, -MAX_HISTORY).max(first.as_deref().map(|d| d[..7].to_string()).unwrap_or_else(|| current.clone()));
    let mut months = Vec::new();
    let mut m = hist_from.clone();
    while m < current {
        months.push(m.clone());
        m = add_months(&m, 1);
    }
    let confirmed = list_recurring_in(&mut conn, ent, Some("confirmed")).await?;
    let covered: HashSet<&str> = confirmed.iter().map(|r| r.key.as_str()).collect();
    let bank = bank_entries(&mut conn, ent, &format!("{hist_from}-01"), &today, true).await?;
    let mut per_month: BTreeMap<i64, HashMap<String, i64>> = BTreeMap::new();
    let mut so_far: BTreeMap<i64, i64> = BTreeMap::new();
    for e in bank.iter().filter(|e| !covered.contains(e.key.as_str())) {
        let m = &e.date[..7];
        for &(account, f) in &e.categories {
            if m == current {
                *so_far.entry(account).or_default() -= f;
            } else {
                *per_month.entry(account).or_default().entry(m.to_string()).or_default() -= f;
            }
        }
    }
    let mut stats: BTreeMap<i64, Stats> = BTreeMap::new();
    if months.len() >= MIN_HISTORY {
        for (account, by_month) in &per_month {
            let values: Vec<i64> = months.iter().map(|m| by_month.get(m).copied().unwrap_or(0)).collect();
            stats.insert(*account, Stats {
                median: median_of(&values),
                low: values.iter().copied().min().unwrap_or(0),
                high: values.iter().copied().max().unwrap_or(0),
            });
        }
    }

    // Walk from today to the month's end, one month at a time.
    let opening_now = cash_at(&mut conn, ent, &today).await?;
    let (mut opening, mut lo, mut hi) = (opening_now, opening_now, opening_now);
    let planned = list_planned_in(&mut conn, ent, None, None).await?;
    let mut m = current.clone();
    loop {
        let after = if m == current { today.clone() } else { (super::month_start(&m) - chrono::Duration::days(1)).format("%Y-%m-%d").to_string() };
        let end = month_end(&m);
        let mut lines = vec![if m == current {
            line("opening", "Balance today".into(), Some(today.clone()), opening, lo, hi)
        } else {
            line("opening", "Projected balance at the start".into(), None, opening, lo, hi)
        }];
        let mut by_category: BTreeMap<i64, i64> = BTreeMap::new();
        for r in &confirmed {
            let Ok(last) = NaiveDate::parse_from_str(&r.last_date, "%Y-%m-%d") else { continue };
            for n in 1..=600u32 {
                let d = step(last, &r.cadence, n).format("%Y-%m-%d").to_string();
                if d > end {
                    break;
                }
                if d > after {
                    let mut l = line("recurring", r.label.clone(), Some(d), r.amount_minor, r.amount_low_minor, r.amount_high_minor);
                    l.ledger_account_id = r.ledger_account_id;
                    l.ref_id = Some(r.id);
                    if let Some(c) = r.ledger_account_id {
                        *by_category.entry(c).or_default() += r.amount_minor;
                    }
                    lines.push(l);
                }
            }
        }
        for p in planned.iter().filter(|p| p.date > after && p.date <= end) {
            let mut l = line("planned", p.description.clone(), Some(p.date.clone()), p.amount_minor, p.amount_minor, p.amount_minor);
            l.ledger_account_id = p.ledger_account_id;
            l.ref_id = Some(p.id);
            if let Some(c) = p.ledger_account_id {
                *by_category.entry(c).or_default() += p.amount_minor;
            }
            lines.push(l);
        }
        for (&account, s) in &stats {
            let Some(la) = chart.get(&account) else { continue };
            let outflow = s.median <= 0;
            let done = if m == current { so_far.get(&account).copied().unwrap_or(0) } else { 0 };
            let (amount, low, high) = (clip(s.median - done, outflow), clip(s.low - done, outflow), clip(s.high - done, outflow));
            if amount == 0 && low == 0 && high == 0 {
                continue;
            }
            *by_category.entry(account).or_default() += amount;
            let mut l = line("category", la.name.clone(), None, amount, low, high);
            l.ledger_account_id = Some(account);
            lines.push(l);
        }
        let sum = |f: fn(&ForecastLine) -> i64| lines.iter().skip(1).map(f).sum::<i64>();
        let (end_mid, end_lo, end_hi) = (opening + sum(|l| l.amount_minor), lo + sum(|l| l.low_minor), hi + sum(|l| l.high_minor));
        if m == month {
            let recognised = if m == current { recognised_in(&mut conn, ent, &m, &m).await? } else { HashMap::new() };
            let mut ids: Vec<i64> = stats.keys().chain(by_category.keys()).chain(budgets.keys()).chain(recognised.keys()).copied().collect();
            ids.sort_unstable();
            ids.dedup();
            let mut categories = Vec::new();
            for id in ids {
                let Some(la) = chart.get(&id) else { continue };
                if la.class != "income" && la.class != "expense" {
                    continue;
                }
                let actual = natural(-recognised.get(&id).copied().unwrap_or(0), &la.class);
                let ahead = natural(by_category.get(&id).copied().unwrap_or(0), &la.class);
                categories.push(CategoryProjection {
                    ledger_account_id: id,
                    name: la.name.clone(),
                    class: la.class.clone(),
                    actual_minor: actual,
                    projected_minor: actual + ahead,
                    median_minor: stats.get(&id).map_or(0, |s| natural(s.median, &la.class)),
                    history_months: if stats.contains_key(&id) { months.len() as i64 } else { 0 },
                    budget_minor: budgets.get(&id).map(|b| b.amount_minor),
                });
            }
            let first_opening = lines[0].amount_minor;
            return Ok(finish(month, today, first_opening, (end_mid, end_lo, end_hi), lines, categories, &chart));
        }
        (opening, lo, hi) = (end_mid, end_lo, end_hi);
        m = add_months(&m, 1);
    }
}

fn finish(
    month: String,
    today: String,
    opening: i64,
    (end, low, high): (i64, i64, i64),
    lines: Vec<ForecastLine>,
    mut categories: Vec<CategoryProjection>,
    chart: &HashMap<i64, LedgerAccount>,
) -> Forecast {
    categories.sort_by(|a, b| {
        let code = |id: i64| chart.get(&id).map(|l| l.code.clone()).unwrap_or_default();
        code(a.ledger_account_id).cmp(&code(b.ledger_account_id)).then(a.ledger_account_id.cmp(&b.ledger_account_id))
    });
    let warnings = categories
        .iter()
        .filter_map(|c| {
            let budget = c.budget_minor?;
            (c.class == "expense" && c.projected_minor > budget).then(|| Overshoot {
                ledger_account_id: c.ledger_account_id,
                name: c.name.clone(),
                budget_minor: budget,
                projected_minor: c.projected_minor,
                over_minor: c.projected_minor - budget,
            })
        })
        .collect();
    Forecast { month, as_of: today, opening_minor: opening, end_minor: end, low_minor: low.min(end), high_minor: high.max(end), lines, categories, warnings }
}
