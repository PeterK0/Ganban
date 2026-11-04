//! Finance in the assistant (`docs/design/FINANCE.md` § Assistant, ADR 0009).
//!
//! Two things live here, both private to their user and both kept on local models:
//!
//! - **Read-only finance tools** for the chat's tool loop. They're offered only when the chat's
//!   project is the caller's own personal container *and* the tool loop runs on Ollama with a
//!   local model, and [`execute`] checks the same gate again before it reads anything. Each
//!   tool calls the finance core with the caller's own entity (found, never created) and
//!   returns compact JSON in major units.
//! - **Category suggestions** for inbox lines, from the host's local Ollama model. The prompt
//!   holds each line's description, payee and amount and the chart's category names, nothing
//!   else; the reply is matched back to the chart, and the user applies a suggestion or not.
//!
//! No finance data goes to the log: errors say what failed, never with what.

use chrono::{Datelike, NaiveDate};
use ganban_core::finance::{self, budgets, forecast, statements, Entity, EntryFilter};
use ganban_core::Db;
use serde_json::{json, Value};

use crate::ollama::{ChatParams, OllamaClient, OllamaConfig};
use crate::Runner;

// --------------------------------------------------------------------------- //
// The gate
// --------------------------------------------------------------------------- //

/// An Ollama model tag that runs on Ollama's cloud rather than on the engine itself
/// (`gpt-oss:120b-cloud`, `…:cloud`). Finance data never goes to one.
pub fn is_cloud_model(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    m.ends_with("-cloud") || m.ends_with(":cloud")
}

/// An engine URL on Ollama's own cloud (`ollama.com`), as opposed to an engine the owner runs.
pub fn is_cloud_endpoint(url: &str) -> bool {
    reqwest::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|h| h == "ollama.com" || h.ends_with(".ollama.com"))
}

/// Whether finance data may reach this engine: the Ollama runner, a local model on it, and the
/// host's engine or an Ollama endpoint the owner configured, neither on Ollama's cloud. A pi
/// (cloud) runner never may. `host_url` is the host's own engine, which a profile without an
/// endpoint runs on.
pub fn engine_is_local(runner: &Runner, params: &ChatParams, host_url: &str) -> bool {
    let url = params.endpoint.as_deref().and_then(OllamaConfig::norm).unwrap_or_else(|| host_url.to_string());
    matches!(runner, Runner::Ollama) && !is_cloud_model(&params.model) && !is_cloud_endpoint(&url)
}

/// Is `project_id` the caller's own personal container? Someone else's (the owner's global
/// project bypass reaches them) is not.
pub async fn is_own_personal(db: &Db, user_id: i64, project_id: i64) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM projects WHERE id = ? AND personal_user_id = ?")
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// The caller's entity when the finance tools may run for this chat, else `None`: their own
/// personal container, a local engine, and Finance already in use (a chat never sets it up).
async fn gate(db: &Db, user_id: i64, project_id: i64, runner: &Runner, params: &ChatParams, host_url: &str) -> Option<Entity> {
    if !engine_is_local(runner, params, host_url) || !is_own_personal(db, user_id, project_id).await {
        return None;
    }
    finance::find_entity(db, user_id).await.ok().flatten()
}

/// The finance tool definitions this chat turn may offer: all of them when the gate passes,
/// none otherwise.
pub async fn offered_defs(db: &Db, user_id: i64, project_id: i64, runner: &Runner, params: &ChatParams, host_url: &str) -> Vec<Value> {
    if gate(db, user_id, project_id, runner, params, host_url).await.is_some() {
        tool_defs()
    } else {
        Vec::new()
    }
}

/// A line for the system prompt when the finance tools are offered: the date the periods are
/// counted from, and how to read the figures.
pub fn prompt_note(today: NaiveDate) -> String {
    format!(
        "\n\nThis is the user's private Personal chat. Today is {today}. The finance_* tools read the user's own \
         finances (read-only): call them for any question about their money, accounts, spending, income, budgets or \
         forecast, and never guess a figure. Amounts are in major units of the currency shown (a negative balance is \
         money owed). Answer briefly with the figures the tools returned."
    )
}

// --------------------------------------------------------------------------- //
// The tools
// --------------------------------------------------------------------------- //

pub const TOOL_NAMES: [&str; 6] = [
    "finance_balances",
    "finance_by_category",
    "finance_transactions",
    "finance_statement",
    "finance_forecast",
    "finance_budgets",
];

pub fn is_finance_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

const PERIOD_HELP: &str =
    "this_month, last_month, this_year, last_year, a month YYYY-MM or a year YYYY. Or give from and to instead.";

/// The read-only finance tools, in Ollama's `tools` shape.
pub fn tool_defs() -> Vec<Value> {
    let date = |what: &str| json!({ "type": "string", "description": format!("{what} date, YYYY-MM-DD.") });
    let period = json!({ "type": "string", "description": format!("The period: {PERIOD_HELP}") });
    vec![
        def(
            "finance_balances",
            "The user's own bank, savings, card, cash and loan accounts with their current balances, and the total in their main currency.",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        def(
            "finance_by_category",
            "The user's own spending and income by category over a period (e.g. how much went on Groceries last month).",
            json!({ "type": "object", "properties": {
                "period": period,
                "from": date("First"),
                "to": date("Last"),
                "category": { "type": "string", "description": "Optional: only categories whose name contains this, e.g. groceries." }
            }, "required": [] }),
        ),
        def(
            "finance_transactions",
            "The user's own transactions matching a search over description and payee, newest first, optionally within a period or category.",
            json!({ "type": "object", "properties": {
                "search": { "type": "string", "description": "Words in the description or payee." },
                "period": period,
                "from": date("First"),
                "to": date("Last"),
                "category": { "type": "string", "description": "Optional: a category name." },
                "limit": { "type": "integer", "description": "How many to return, at most 30 (default 15)." }
            }, "required": [] }),
        ),
        def(
            "finance_statement",
            "One of the user's financial statements for a month or a year: position (assets, liabilities, net worth), profit_loss (income and expenses), cash_flow, or equity (changes in net worth). Includes the previous period for comparison.",
            json!({ "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["position", "profit_loss", "cash_flow", "equity"] },
                "period": { "type": "string", "description": "this_month, last_month, this_year, last_year, YYYY-MM or YYYY." }
            }, "required": ["kind"] }),
        ),
        def(
            "finance_forecast",
            "The projected cash balance at the end of a month (this month by default), with a low-high range, what drives it, and the categories heading over budget.",
            json!({ "type": "object", "properties": {
                "month": { "type": "string", "description": "YYYY-MM; default this month." }
            }, "required": [] }),
        ),
        def(
            "finance_budgets",
            "The user's budgets for a month (this month by default): each category's target, what has been spent and what is left.",
            json!({ "type": "object", "properties": {
                "month": { "type": "string", "description": "YYYY-MM; default this month." }
            }, "required": [] }),
        ),
    ]
}

fn def(name: &str, description: &str, parameters: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}

/// Run one finance tool for the caller. The gate is checked again here, so a call the model
/// makes for a tool this chat wasn't offered (or a delegation on another engine) reads nothing.
pub async fn execute(
    db: &Db,
    user_id: i64,
    project_id: i64,
    runner: &Runner,
    params: &ChatParams,
    host_url: &str,
    name: &str,
    args: &Value,
    today: NaiveDate,
) -> Result<String, String> {
    let Some(ent) = gate(db, user_id, project_id, runner, params, host_url).await else {
        return Err("finance tools are only available in your Personal chats on a local model".into());
    };
    let v = run(db, &ent, name, args, today).await.map_err(|e| e.to_string())?;
    Ok(crate::tools::cap(v.to_string()))
}

async fn run(db: &Db, ent: &Entity, name: &str, args: &Value, today: NaiveDate) -> ganban_core::Result<Value> {
    let cur = ent.functional_currency.as_str();
    match name {
        "finance_balances" => {
            let accounts = finance::list_accounts(db, ent, false).await?;
            let total: i64 = accounts.iter().map(|a| a.balance_functional_minor + a.draft_balance_functional_minor).sum();
            let rows: Vec<Value> = accounts
                .iter()
                .map(|a| {
                    let mut r = json!({
                        "account": a.name,
                        "kind": a.kind,
                        "currency": a.currency,
                        "balance": amount(a.balance_minor + a.draft_balance_minor, &a.currency),
                    });
                    if let Some(i) = a.institution.as_deref().filter(|s| !s.is_empty()) {
                        r["institution"] = json!(i);
                    }
                    if a.draft_balance_minor != 0 {
                        r["of_which_not_yet_posted"] = amount(a.draft_balance_minor, &a.currency);
                    }
                    r
                })
                .collect();
            Ok(json!({ "currency": cur, "total": amount(total, cur), "accounts": rows }))
        }
        "finance_by_category" => {
            let (from, to) = range(args, today)?;
            let wanted = opt_str(args, "category").map(|s| s.to_lowercase());
            let rows = finance::category_totals(db, ent, &from, &to).await?;
            let matches = |n: &str| wanted.as_deref().is_none_or(|w| n.to_lowercase().contains(w));
            let side = |class: &str| -> Vec<Value> {
                rows.iter()
                    .filter(|r| r.class == class && matches(&r.name))
                    .map(|r| json!({ "category": r.name, "amount": amount(r.amount_minor, cur), "transactions": r.entries }))
                    .collect()
            };
            let total = |class: &str| rows.iter().filter(|r| r.class == class && matches(&r.name)).map(|r| r.amount_minor).sum::<i64>();
            let mut out = json!({
                "from": from, "to": to, "currency": cur,
                "spending": side("expense"), "total_spent": amount(total("expense"), cur),
                "income": side("income"), "total_income": amount(total("income"), cur),
            });
            if let Some(w) = &wanted {
                if !rows.iter().any(|r| matches(&r.name)) {
                    out["note"] = json!(format!("nothing in a category matching '{w}' in this period"));
                    out["categories"] = json!(category_names(db, ent).await?);
                }
            }
            Ok(out)
        }
        "finance_transactions" => {
            let (from, to) = match (opt_str(args, "period"), opt_str(args, "from"), opt_str(args, "to")) {
                (None, None, None) => (None, None),
                _ => {
                    let (f, t) = range(args, today)?;
                    (Some(f), Some(t))
                }
            };
            let ledger = finance::list_ledger_accounts(db, ent, true).await?;
            let category = match opt_str(args, "category") {
                Some(c) => match ledger.iter().find(|l| matches!(l.class.as_str(), "income" | "expense") && l.name.eq_ignore_ascii_case(c.trim())) {
                    Some(l) => Some(l.id),
                    None => return Ok(json!({ "note": format!("no category named '{c}'"), "categories": category_names(db, ent).await? })),
                },
                None => None,
            };
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(15).clamp(1, 30);
            let filter = EntryFilter {
                from,
                to,
                ledger_account_id: category,
                search: opt_str(args, "search").map(str::to_string),
                ..Default::default()
            };
            let page = finance::list_entries(db, ent, filter, limit, 0).await?;
            let accounts = finance::list_accounts(db, ent, true).await?;
            let names: std::collections::HashMap<i64, &finance::LedgerAccount> = ledger.iter().map(|l| (l.id, l)).collect();
            let rows: Vec<Value> = page
                .entries
                .iter()
                .map(|e| {
                    let bank = e.lines.iter().find_map(|l| accounts.iter().find(|a| a.ledger_account_id == l.ledger_account_id).map(|a| (l, a)));
                    let categories: Vec<&str> = e
                        .lines
                        .iter()
                        .filter_map(|l| names.get(&l.ledger_account_id))
                        .filter(|l| matches!(l.class.as_str(), "income" | "expense"))
                        .map(|l| l.name.as_str())
                        .collect();
                    let mut r = json!({ "date": e.date, "description": e.description });
                    if let Some(p) = e.payee.as_deref().filter(|p| *p != e.description) {
                        r["payee"] = json!(p);
                    }
                    match bank {
                        Some((l, a)) => {
                            r["amount"] = amount(l.amount_minor, &l.currency);
                            r["currency"] = json!(l.currency);
                            r["account"] = json!(a.name);
                        }
                        None => {
                            let size: i64 = e.lines.iter().map(|l| l.functional_minor.max(0)).sum();
                            r["amount"] = amount(size, cur);
                            r["currency"] = json!(cur);
                        }
                    }
                    r["category"] = json!(categories.join(", "));
                    if e.status != "posted" {
                        r["status"] = json!(if e.status == "draft" { "in the inbox" } else { "reversed" });
                    }
                    r
                })
                .collect();
            Ok(json!({ "total_matching": page.total, "shown": rows.len(), "transactions": rows }))
        }
        "finance_statement" => {
            let kind = opt_str(args, "kind").unwrap_or("profit_loss");
            let period = statement_period(opt_str(args, "period").unwrap_or("this_month"), today)?;
            let st = statements::statement(db, ent, kind, &period, true).await?;
            let rows: Vec<Value> = st
                .rows
                .iter()
                .filter(|r| r.style != "line" || r.amount_minor != 0 || r.comparative_minor.unwrap_or(0) != 0)
                .map(|r| {
                    let mut v = json!({ "label": format!("{}{}", "  ".repeat(r.level.clamp(0, 4) as usize), r.label), "amount": amount(r.amount_minor, &st.currency) });
                    if let Some(c) = r.comparative_minor {
                        v["previous"] = amount(c, &st.currency);
                    }
                    v
                })
                .collect();
            Ok(json!({
                "kind": st.kind, "period": st.period, "from": st.from, "to": st.to, "currency": st.currency,
                "previous_period": st.comparative.as_ref().map(|c| c.period.clone()),
                "rows": rows,
            }))
        }
        "finance_forecast" => {
            let month = month_arg(args, today);
            let f = forecast::forecast(db, ent, &month, &today.format("%Y-%m-%d").to_string()).await?;
            let lines: Vec<Value> = f
                .lines
                .iter()
                .take(40)
                .map(|l| {
                    let mut v = json!({ "kind": l.kind, "label": l.label, "amount": amount(l.amount_minor, cur) });
                    if let Some(d) = &l.date {
                        v["date"] = json!(d);
                    }
                    v
                })
                .collect();
            let over: Vec<Value> = f
                .warnings
                .iter()
                .map(|w| json!({ "category": w.name, "budget": amount(w.budget_minor, cur), "projected": amount(w.projected_minor, cur), "over_by": amount(w.over_minor, cur) }))
                .collect();
            Ok(json!({
                "month": f.month, "as_of": f.as_of, "currency": cur,
                "cash_at_start": amount(f.opening_minor, cur), "projected_end": amount(f.end_minor, cur),
                "low": amount(f.low_minor, cur), "high": amount(f.high_minor, cur),
                "drivers": lines, "over_budget": over,
            }))
        }
        "finance_budgets" => {
            let month = month_arg(args, today);
            let rows: Vec<Value> = budgets::budget_progress(db, ent, &month)
                .await?
                .iter()
                .map(|b| json!({ "category": b.name, "budget": amount(b.target_minor, cur), "spent": amount(b.actual_minor, cur), "left": amount(b.remaining_minor, cur) }))
                .collect();
            let empty = rows.is_empty();
            let mut out = json!({ "month": month, "currency": cur, "budgets": rows });
            if empty {
                out["note"] = json!("no budgets are set for this month");
            }
            Ok(out)
        }
        other => Err(ganban_core::error::AppError::InvalidInput(format!("unknown finance tool: {other}"))),
    }
}

/// Minor units as a JSON number in major units (`-4200`, EUR → `-42.0`).
fn amount(minor: i64, cur: &str) -> Value {
    statements::major(minor, cur).parse::<f64>().map(|f| json!(f)).unwrap_or_else(|_| json!(minor))
}

fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

async fn category_names(db: &Db, ent: &Entity) -> ganban_core::Result<Vec<String>> {
    Ok(finance::list_ledger_accounts(db, ent, false)
        .await?
        .into_iter()
        .filter(|l| matches!(l.class.as_str(), "income" | "expense"))
        .map(|l| l.name)
        .collect())
}

fn month_arg(args: &Value, today: NaiveDate) -> String {
    opt_str(args, "month").map(str::to_string).unwrap_or_else(|| today.format("%Y-%m").to_string())
}

fn bad(msg: String) -> ganban_core::error::AppError {
    ganban_core::error::AppError::InvalidInput(msg)
}

/// The date range a tool's `period`, or its `from` and `to`, names (inclusive).
pub fn range(args: &Value, today: NaiveDate) -> ganban_core::Result<(String, String)> {
    if let Some(p) = opt_str(args, "period") {
        return period_range(p, today);
    }
    let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| bad(format!("'{s}' is not a date (YYYY-MM-DD)")));
    let from = opt_str(args, "from").map(day).transpose()?;
    let to = opt_str(args, "to").map(day).transpose()?;
    match (from, to) {
        (None, None) => period_range("this_month", today),
        (f, t) => {
            let to = t.unwrap_or(today);
            let from = f.unwrap_or_else(|| to.with_day(1).unwrap_or(to));
            if from > to {
                return Err(bad(format!("from ({from}) is after to ({to})")));
            }
            Ok((from.to_string(), to.to_string()))
        }
    }
}

/// `this_month`, `last_month`, `this_year`, `last_year`, `YYYY-MM` or `YYYY` as a date range.
pub fn period_range(period: &str, today: NaiveDate) -> ganban_core::Result<(String, String)> {
    let p = period.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    let month = |y: i32, m: u32| -> ganban_core::Result<(String, String)> {
        let first = NaiveDate::from_ymd_opt(y, m, 1).ok_or_else(|| bad(format!("'{period}' is not a month")))?;
        let next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) };
        let last = next.and_then(|n| n.pred_opt()).ok_or_else(|| bad(format!("'{period}' is not a month")))?;
        Ok((first.to_string(), last.to_string()))
    };
    let year = |y: i32| Ok((format!("{y}-01-01"), format!("{y}-12-31")));
    match p.as_str() {
        "this_month" => month(today.year(), today.month()),
        "last_month" | "previous_month" => {
            if today.month() == 1 {
                month(today.year() - 1, 12)
            } else {
                month(today.year(), today.month() - 1)
            }
        }
        "this_year" => year(today.year()),
        "last_year" | "previous_year" => year(today.year() - 1),
        _ => {
            let raw = period.trim();
            if let Ok(d) = NaiveDate::parse_from_str(&format!("{raw}-01"), "%Y-%m-%d") {
                return month(d.year(), d.month());
            }
            match raw.parse::<i32>() {
                Ok(y) if (1900..=2200).contains(&y) => year(y),
                _ => Err(bad(format!("'{raw}' is not a period: use {PERIOD_HELP}"))),
            }
        }
    }
}

/// A statement's period (`YYYY-MM` or `YYYY`) from a tool's period word.
fn statement_period(period: &str, today: NaiveDate) -> ganban_core::Result<String> {
    let (from, to) = period_range(period, today)?;
    Ok(if from.ends_with("-01-01") && to.ends_with("-12-31") { from[..4].to_string() } else { from[..7].to_string() })
}

// --------------------------------------------------------------------------- //
// Local category suggestions
// --------------------------------------------------------------------------- //

/// At most this many lines per suggestion request (one prompt per batch of [`BATCH`]).
pub const MAX_SUGGEST: usize = 60;
const BATCH: usize = 15;
const SUGGEST_TIMEOUT_SECS: u64 = 120;

/// What the local model sees of one bank line: its description, payee and amount.
#[derive(Debug, Clone)]
pub struct SuggestItem {
    pub description: String,
    pub payee: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
}

/// The host's engine and the local model category suggestions use, or `None` (the button is
/// hidden). The model is the active personality's, else the chat default, and must be
/// installed on the host's engine and not a cloud tag. A personality on a remote endpoint
/// doesn't count: suggestions ask the host's own engine.
pub async fn local_engine(db: &Db) -> Option<(OllamaClient, ChatParams)> {
    let cfg = OllamaConfig::from_db(db).await;
    if is_cloud_endpoint(&cfg.base_url) {
        return None;
    }
    let client = OllamaClient::new(cfg);
    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = ganban_core::ops::active_model_profile(db).await.ok().flatten() {
        if p.endpoint.as_deref().map(str::trim).unwrap_or("").is_empty() {
            candidates.push(p.model);
        }
    }
    candidates.push(crate::chat_profile_fallback(db).await.0.model);
    let installed = tokio::time::timeout(std::time::Duration::from_secs(5), client.list_models()).await.ok()?.ok()?;
    let model = pick_model(&candidates, &installed)?;
    let params = ChatParams { model, temperature: Some(0.0), max_tokens: Some(400), num_ctx: Some(4096), endpoint: None };
    Some((client, params))
}

/// The first candidate that's installed (`name` or `name:latest`) and not a cloud tag.
pub fn pick_model(candidates: &[String], installed: &[String]) -> Option<String> {
    let base = |s: &str| s.trim().trim_end_matches(":latest").to_string();
    candidates
        .iter()
        .filter(|c| !c.trim().is_empty() && !is_cloud_model(c))
        .find_map(|c| installed.iter().find(|i| base(i) == base(c) && !is_cloud_model(i)).cloned())
}

/// The prompt for one batch: the chart's category names and each line's description, payee
/// and amount. Nothing else of the user's finances goes in.
pub fn build_prompt(items: &[SuggestItem], expense: &[String], income: &[String]) -> String {
    let mut s = String::from(
        "Sort each bank transaction into one category from the lists below. A payment (spent) takes an expense \
         category, money received takes an income category. Reply with JSON only, one entry per transaction number, \
         using a category name exactly as written, or null when none fits: {\"1\": \"Category\", \"2\": null}\n\n",
    );
    s.push_str(&format!("Expense categories: {}\n", expense.join(", ")));
    s.push_str(&format!("Income categories: {}\n\nTransactions:\n", income.join(", ")));
    for (i, it) in items.iter().enumerate() {
        let verb = if it.amount_minor < 0 { "spent" } else { "received" };
        let money = statements::major(it.amount_minor.abs(), &it.currency);
        let text: String = it.description.chars().take(160).collect();
        s.push_str(&format!("{}. {verb} {money} {} | {}", i + 1, it.currency, text.replace('\n', " ")));
        if let Some(p) = it.payee.as_deref().map(str::trim).filter(|p| !p.is_empty() && *p != it.description.trim()) {
            let p: String = p.chars().take(80).collect();
            s.push_str(&format!(" | payee: {p}"));
        }
        s.push('\n');
    }
    s
}

/// The category the model picked for each item, as an index into `expense` or `income` by the
/// item's sign. Anything that isn't one of the user's names, or is on the wrong side, is `None`.
pub fn parse_reply<'a>(reply: &str, items: &[SuggestItem], expense: &'a [String], income: &'a [String]) -> Vec<Option<&'a str>> {
    let obj = match (reply.find('{'), reply.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str::<Value>(&reply[a..=b]).ok(),
        _ => None,
    };
    items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            let said = obj.as_ref()?.get((i + 1).to_string())?.as_str()?.trim().to_lowercase();
            let side = if it.amount_minor < 0 { expense } else { income };
            side.iter().find(|n| n.to_lowercase() == said).map(String::as_str)
        })
        .collect()
}

/// Suggest a category for each of the caller's entries, from the host's local model. Returns
/// `[{entry_id, ledger_account_id}]`, `null` where the model had nothing that fits. Entries
/// that aren't the caller's are "not found", as everywhere in Finance.
pub async fn suggest_categories(db: &Db, ent: &Entity, entry_ids: &[i64]) -> ganban_core::Result<Value> {
    if entry_ids.len() > MAX_SUGGEST {
        return Err(bad(format!("at most {MAX_SUGGEST} lines at a time")));
    }
    let chart = finance::list_ledger_accounts(db, ent, false).await?;
    let usable = |class: &str| -> Vec<(i64, String)> {
        chart
            .iter()
            .filter(|l| l.class == class)
            .filter(|l| !l.system_key.as_deref().is_some_and(|k| k.starts_with("uncategorised") || k.starts_with("fx_")))
            .map(|l| (l.id, l.name.clone()))
            .collect()
    };
    let (expense, income) = (usable("expense"), usable("income"));
    let names = |v: &[(i64, String)]| v.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>();
    let (expense_names, income_names) = (names(&expense), names(&income));
    let accounts = finance::list_accounts(db, ent, true).await?;

    let mut items: Vec<(i64, SuggestItem)> = Vec::new();
    for id in entry_ids {
        let e = finance::get_entry(db, ent, *id).await?;
        let Some(bank) = e.lines.iter().find(|l| accounts.iter().any(|a| a.ledger_account_id == l.ledger_account_id)) else {
            continue; // a manual journal has no bank line to sort
        };
        items.push((e.id, SuggestItem { description: e.description.clone(), payee: e.payee.clone(), amount_minor: bank.amount_minor, currency: bank.currency.clone() }));
    }

    if items.is_empty() {
        return Ok(json!([]));
    }
    // The engine is asked only after every entry proved the caller's own.
    let Some((client, params)) = local_engine(db).await else {
        return Err(bad("no local model is available for suggestions".into()));
    };
    let mut out: Vec<Value> = Vec::new();
    for batch in items.chunks(BATCH) {
        let only: Vec<SuggestItem> = batch.iter().map(|(_, it)| it.clone()).collect();
        let prompt = build_prompt(&only, &expense_names, &income_names);
        let messages = [json!({ "role": "user", "content": prompt })];
        let reply = tokio::time::timeout(std::time::Duration::from_secs(SUGGEST_TIMEOUT_SECS), client.chat_json(&params, &messages))
            .await
            .map_err(|_| bad("the local model took too long to answer".into()))?
            // Ollama's error text is the engine's, not the user's data, but keep it out anyway.
            .map_err(|_| bad("the local model didn't answer; check the engine in Settings → AI".into()))?;
        let picked = parse_reply(&reply, &only, &expense_names, &income_names);
        for ((entry_id, it), name) in batch.iter().zip(picked) {
            let side = if it.amount_minor < 0 { &expense } else { &income };
            let id = name.and_then(|n| side.iter().find(|(_, m)| m == n).map(|(id, _)| *id));
            out.push(json!({ "entry_id": entry_id, "ledger_account_id": id }));
        }
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testkit::{member, owner, test_db};

    const LOCAL: &str = "http://127.0.0.1:11434";

    fn params(model: &str, endpoint: Option<&str>) -> ChatParams {
        ChatParams { model: model.into(), temperature: None, max_tokens: None, num_ctx: None, endpoint: endpoint.map(String::from) }
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn only_local_ollama_engines_count() {
        assert!(engine_is_local(&Runner::Ollama, &params("qwen2.5:7b", None), "http://127.0.0.1:11434"));
        assert!(engine_is_local(&Runner::Ollama, &params("qwen2.5:7b", Some("http://100.70.1.2:11434")), LOCAL), "an engine the owner runs");
        assert!(!engine_is_local(&Runner::Pi, &params("qwen2.5:7b", None), "http://127.0.0.1:11434"), "a pi runner never");
        assert!(!engine_is_local(&Runner::Ollama, &params("gpt-oss:120b-cloud", None), "http://127.0.0.1:11434"), "an Ollama cloud tag");
        assert!(!engine_is_local(&Runner::Ollama, &params("kimi-k2:cloud", None), "http://127.0.0.1:11434"));
        assert!(!engine_is_local(&Runner::Ollama, &params("llama3", Some("https://ollama.com")), LOCAL), "Ollama's cloud endpoint");
        assert!(!engine_is_local(&Runner::Ollama, &params("llama3", None), "https://ollama.com"), "the host engine on Ollama's cloud");
    }

    #[test]
    fn periods_name_whole_months_and_years() {
        let t = day("2026-03-15");
        let r = |p: &str| period_range(p, t).unwrap();
        assert_eq!(r("last_month"), ("2026-02-01".into(), "2026-02-28".into()));
        assert_eq!(r("this month"), ("2026-03-01".into(), "2026-03-31".into()));
        assert_eq!(period_range("last_month", day("2026-01-10")).unwrap(), ("2025-12-01".into(), "2025-12-31".into()));
        assert_eq!(r("2024-02"), ("2024-02-01".into(), "2024-02-29".into()));
        assert_eq!(r("last_year"), ("2025-01-01".into(), "2025-12-31".into()));
        assert!(period_range("soon", t).is_err());
        assert_eq!(range(&json!({ "from": "2026-03-02" }), t).unwrap(), ("2026-03-02".into(), "2026-03-15".into()));
        assert!(range(&json!({ "from": "2026-03-20", "to": "2026-03-02" }), t).is_err());
        assert_eq!(statement_period("last_year", t).unwrap(), "2025");
        assert_eq!(statement_period("last_month", t).unwrap(), "2026-02");
    }

    #[test]
    fn the_prompt_holds_only_description_payee_amount_and_the_chart() {
        let items = vec![SuggestItem { description: "CORNER SHOP 123".into(), payee: Some("Corner Shop".into()), amount_minor: -4_250, currency: "EUR".into() }];
        let p = build_prompt(&items, &["Groceries".into(), "Transport".into()], &["Salary".into()]);
        assert!(p.contains("1. spent 42.50 EUR | CORNER SHOP 123 | payee: Corner Shop"), "{p}");
        assert!(p.contains("Expense categories: Groceries, Transport") && p.contains("Income categories: Salary"));
    }

    #[test]
    fn replies_match_the_users_own_names_on_the_right_side() {
        let it = |amount: i64| SuggestItem { description: "x".into(), payee: None, amount_minor: amount, currency: "EUR".into() };
        let items = vec![it(-100), it(-100), it(500), it(-100), it(-100)];
        let (exp, inc) = (vec!["Groceries".to_string(), "Eating out".to_string()], vec!["Salary".to_string()]);
        let reply = "Sure! ```json\n{\"1\": \"groceries\", \"2\": \"Salary\", \"3\": \"Salary\", \"4\": null, \"5\": \"Crypto\"}\n```";
        assert_eq!(parse_reply(reply, &items, &exp, &inc), vec![Some("Groceries"), None, Some("Salary"), None, None]);
        assert_eq!(parse_reply("no idea", &items, &exp, &inc), vec![None; 5]);
    }

    #[test]
    fn suggestions_use_an_installed_local_model() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(pick_model(&s(&["qwen2.5"]), &s(&["nomic-embed-text:latest", "qwen2.5:latest"])), Some("qwen2.5:latest".into()));
        assert_eq!(pick_model(&s(&["gpt-oss:120b-cloud", "llama3.1:8b"]), &s(&["gpt-oss:120b-cloud", "llama3.1:8b"])), Some("llama3.1:8b".into()));
        assert_eq!(pick_model(&s(&["mistral"]), &s(&["llama3.1:8b"])), None);
    }

    /// A user with Finance in use: one account with a categorised grocery payment last month.
    async fn with_finance(db: &Db, user_id: i64, account: &str, spent: i64) -> i64 {
        let ent = finance::entity_for_user(db, user_id).await.unwrap();
        let input = finance::FinAccountInput {
            kind: "current".into(), name: account.into(), institution: None, currency: "EUR".into(), iban_mask: None,
            profile_key: None, opening_balance_minor: Some(100_000), opening_date: Some("2026-01-01".into()),
        };
        let a = finance::create_account(db, &ent, input).await.unwrap();
        let ledger = finance::list_ledger_accounts(db, &ent, false).await.unwrap();
        let id = |n: &str| ledger.iter().find(|l| l.name == n).unwrap().id;
        let draft = finance::BankDraft {
            account_id: a.id, date: "2026-02-10".into(), description: "Corner shop".into(), payee: None,
            amount_minor: -spent, fee_minor: 0, counter_ledger_account_id: id("Groceries"), source_line_id: None, functional_minor: None,
        };
        finance::create_bank_draft(db, &ent, draft).await.unwrap();
        ganban_core::ops::ensure_personal_project(db, user_id).await.unwrap()
    }

    #[tokio::test]
    async fn finance_tools_are_offered_only_in_the_callers_personal_chat_on_a_local_engine() {
        let db = test_db("fin_tools_gate").await;
        let owner = owner(&db).await;
        let project = ganban_core::ops::create_project(&db, ganban_core::models::CreateProjectInput { name: "Work".into(), description: None })
            .await
            .unwrap()
            .id;
        let mia = member(&db, 7, &[(project, "member")]).await;
        let personal = with_finance(&db, mia.id, "Everyday", 4_200).await;
        let local = params("qwen2.5:7b", None);
        let names = |defs: Vec<Value>| defs.iter().filter_map(|d| d["function"]["name"].as_str().map(String::from)).collect::<Vec<_>>();

        assert_eq!(names(offered_defs(&db, mia.id, personal, &Runner::Ollama, &local, LOCAL).await), TOOL_NAMES.to_vec());
        assert!(offered_defs(&db, mia.id, project, &Runner::Ollama, &local, LOCAL).await.is_empty(), "absent in a project chat");
        assert!(offered_defs(&db, mia.id, personal, &Runner::Pi, &local, LOCAL).await.is_empty(), "absent on a pi runner");
        assert!(offered_defs(&db, mia.id, personal, &Runner::Ollama, &params("gpt-oss:20b-cloud", None), LOCAL).await.is_empty(), "absent on a cloud model");
        // The owner reaches Mia's container through the project bypass, but it isn't theirs.
        assert!(offered_defs(&db, owner.id, personal, &Runner::Ollama, &local, LOCAL).await.is_empty(), "absent in someone else's container");
        // The owner's own container, with no Finance in use: nothing offered, nothing created.
        let mine = ganban_core::ops::ensure_personal_project(&db, owner.id).await.unwrap();
        assert!(offered_defs(&db, owner.id, mine, &Runner::Ollama, &local, LOCAL).await.is_empty());
        assert!(finance::find_entity(&db, owner.id).await.unwrap().is_none(), "a chat never sets Finance up");
    }

    #[tokio::test]
    async fn finance_tools_read_only_the_callers_own_books_and_recheck_the_gate() {
        let db = test_db("fin_tools_run").await;
        let owner = owner(&db).await;
        let _ = member(&db, 7, &[]).await;
        let mia_personal = with_finance(&db, 7, "Mia's current", 4_200).await;
        let owner_personal = with_finance(&db, owner.id, "Owner's current", 9_900).await;
        let local = params("qwen2.5:7b", None);
        let today = day("2026-03-15");
        let run = |user: i64, project: i64, runner: Runner, name: &'static str, args: Value| {
            let (db, local) = (db.clone(), local.clone());
            async move { execute(&db, user, project, &runner, &local, LOCAL, name, &args, today).await }
        };

        let spent = run(7, mia_personal, Runner::Ollama, "finance_by_category", json!({ "period": "last_month", "category": "groceries" })).await.unwrap();
        let v: Value = serde_json::from_str(&spent).unwrap();
        assert_eq!((v["total_spent"].as_f64(), v["from"].as_str()), (Some(42.0), Some("2026-02-01")), "{v}");
        let balances = run(7, mia_personal, Runner::Ollama, "finance_balances", json!({})).await.unwrap();
        assert!(balances.contains("Mia's current") && !balances.contains("Owner's current"), "{balances}");
        let found = run(7, mia_personal, Runner::Ollama, "finance_transactions", json!({ "search": "corner" })).await.unwrap();
        assert!(found.contains("-42.0") && found.contains("Groceries"), "{found}");
        for name in ["finance_statement", "finance_forecast", "finance_budgets"] {
            let args = if name == "finance_statement" { json!({ "kind": "profit_loss", "period": "2026-02" }) } else { json!({}) };
            assert!(run(7, mia_personal, Runner::Ollama, name, args).await.is_ok(), "{name}");
        }

        // The gate again at execution: the owner in Mia's container, a pi runner, a project chat.
        assert!(run(owner.id, mia_personal, Runner::Ollama, "finance_balances", json!({})).await.is_err());
        assert!(run(7, mia_personal, Runner::Pi, "finance_balances", json!({})).await.is_err());
        assert!(run(7, owner_personal, Runner::Ollama, "finance_balances", json!({})).await.is_err());
        // The owner's own chat shows the owner's books, never Mia's.
        let own = run(owner.id, owner_personal, Runner::Ollama, "finance_balances", json!({})).await.unwrap();
        assert!(own.contains("Owner's current") && !own.contains("Mia's"), "{own}");
    }

    #[tokio::test]
    async fn the_built_in_tool_executor_refuses_finance_tools() {
        let db = test_db("fin_tools_builtin").await;
        let _ = member(&db, 7, &[]).await;
        let personal = with_finance(&db, 7, "Everyday", 100).await;
        let viewer = ganban_core::visibility::Viewer { user_id: 7, is_owner: false };
        let err = crate::tools::execute_tool(&db, None, personal, "finance_balances", &json!({}), viewer).await.unwrap_err();
        assert!(err.contains("Personal"), "{err}");
    }
}
