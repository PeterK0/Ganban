//! The inbox at scale (`docs/design/FINANCE.md` § The inbox at scale): act on every draft a
//! filter matches, on the host and in short batches, and group the drafts by payee so ten
//! thousand imported lines collapse to a few hundred decisions.
//!
//! Every write runs in short `BEGIN IMMEDIATE` transactions with a pause after each, as the
//! import does, so the rest of the host keeps writing while a big inbox is worked through.

use std::time::Duration;

use serde::Serialize;

use super::entries::{bind_all, filter_sql};
use super::rules::{merchant_key, Action, Conditions, Rule, RuleInput};
use super::{audit, get_ledger_account_in, now, system, system_account_in, Conn, Entity, EntryFilter, Split};
use crate::error::{AppError, Result};
use crate::Db;

/// How a bulk action writes: entries per transaction, and the pause after each commit so a
/// waiting writer gets the lock (see `import::pipeline::ImportOptions`).
#[derive(Debug, Clone)]
pub struct BulkOptions {
    pub batch: usize,
    pub pause: Duration,
}

impl Default for BulkOptions {
    fn default() -> Self {
        BulkOptions { batch: 200, pause: Duration::from_millis(25) }
    }
}

async fn write_tx(db: &Db) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}

// ============== Payee groups ==============

/// A draft's payee group: its direction (`out` for money spent, `in` for money received) and
/// its merchant (the payee, else the description without digits and punctuation), as
/// `out:green market`. Spending and refunds from one merchant are two groups, since they
/// take an expense and an income category.
pub fn group_key(description: &str, payee: Option<&str>, amount_minor: i64) -> String {
    let dir = if amount_minor < 0 { "out" } else { "in" };
    format!("{dir}:{}", merchant_key(description, payee))
}

/// The direction of a group key.
fn direction(key: &str) -> &'static str {
    if key.starts_with("out:") {
        "out"
    } else {
        "in"
    }
}

/// The bank line's amount of an entry (alias `e`), as a scalar subquery.
const BANK_AMOUNT: &str = "(SELECT l.amount_minor FROM fin_lines l JOIN fin_accounts a ON a.ledger_account_id = l.ledger_account_id \
     WHERE l.entry_id = e.id ORDER BY l.id LIMIT 1)";

/// Works out the payee group of every draft that has none yet (new imports, edited text),
/// in short batches. Returns how many it filled.
pub async fn fill_group_keys(db: &Db, ent: &Entity) -> Result<usize> {
    let mut filled = 0;
    loop {
        // Read inside the write transaction, so an edit can't slip in between the read and
        // the write and leave the key of the old text.
        let mut tx = write_tx(db).await?;
        let rows: Vec<(i64, String, Option<String>, Option<i64>)> = sqlx::query_as(&format!(
            "SELECT e.id, e.description, e.payee, {BANK_AMOUNT} FROM fin_entries e \
             WHERE e.entity_id = ? AND e.status = 'draft' AND e.group_key IS NULL LIMIT 1000"
        ))
        .bind(ent.id)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            return Ok(filled);
        }
        for (id, description, payee, amount) in &rows {
            sqlx::query("UPDATE fin_entries SET group_key = ? WHERE id = ?")
                .bind(group_key(description, payee.as_deref(), amount.unwrap_or(0)))
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        filled += rows.len();
    }
}

/// One payee group of the inbox's drafts.
#[derive(Debug, Clone, Serialize)]
pub struct InboxGroup {
    pub key: String,
    /// The payee, else the description, of the group's latest draft.
    pub label: String,
    /// `out` (money spent) or `in` (money received).
    pub direction: &'static str,
    pub count: i64,
    /// The bank lines' total in the functional currency.
    pub total_minor: i64,
    pub first_date: String,
    pub last_date: String,
    /// The category most of its sorted drafts went to.
    pub category_id: Option<i64>,
    /// Drafts still uncategorised.
    pub uncategorised: i64,
    /// Drafts that are transfer or exchange legs (not categories).
    pub paired: i64,
    /// The local model's category for the group, while some of it is uncategorised.
    pub suggested_ledger_account_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupPage {
    pub groups: Vec<InboxGroup>,
    /// Groups and drafts matching the filter, over every page.
    pub total_groups: i64,
    pub total_lines: i64,
}

/// The ids the inbox needs: the entity's bank ledger accounts, as an SQL list, and the
/// uncategorised and fee accounts.
struct Ids {
    unc_expense: i64,
    unc_income: i64,
    fees: i64,
    clearing: i64,
}

async fn ids(conn: &mut Conn, ent: &Entity) -> Result<Ids> {
    Ok(Ids {
        unc_expense: system_account_in(conn, ent, system::UNCATEGORISED_EXPENSE).await?.id,
        unc_income: system_account_in(conn, ent, system::UNCATEGORISED_INCOME).await?.id,
        fees: system_account_in(conn, ent, system::BANK_FEES).await?.id,
        clearing: system_account_in(conn, ent, system::TRANSFERS_CLEARING).await?.id,
    })
}

/// The filter as the inbox reads it: drafts only.
fn drafts(mut filter: EntryFilter) -> EntryFilter {
    filter.status = Some("draft".into());
    filter
}

const LIVE_PAIR: &str = "EXISTS (SELECT 1 FROM fin_pairs p WHERE (p.entry_a = e.id OR p.entry_b = e.id) AND p.status != 'rejected')";

/// The drafts a filter matches, grouped by payee, the largest groups first. The host groups,
/// so the client gets a page of groups, never the drafts.
pub async fn inbox_groups(db: &Db, ent: &Entity, filter: EntryFilter, limit: i64, offset: i64) -> Result<GroupPage> {
    fill_group_keys(db, ent).await?;
    let filter = drafts(filter);
    let mut conn = db.acquire().await?;
    let ids = ids(&mut conn, ent).await?;
    let (sql, binds) = filter_sql(&mut conn, ent, &filter).await?;
    let totals_sql = format!("SELECT COUNT(DISTINCT e.group_key), COUNT(*){sql}");
    let (total_groups, total_lines): (i64, i64) = bind_all!(sqlx::query_as(&totals_sql), &binds).fetch_one(&mut *conn).await?;
    let page_sql = format!(
        "SELECT e.group_key, COUNT(*) AS n, MIN(e.date), MAX(e.date), \
           COALESCE(SUM((SELECT SUM(l.functional_minor) FROM fin_lines l WHERE l.entry_id = e.id \
             AND l.ledger_account_id IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = {ent}))), 0) AS total, \
           SUM(EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id IN ({ue}, {ui}))), \
           SUM({LIVE_PAIR}) \
         {sql} GROUP BY e.group_key ORDER BY n DESC, ABS(total) DESC, e.group_key LIMIT ? OFFSET ?",
        ent = ent.id,
        ue = ids.unc_expense,
        ui = ids.unc_income,
    );
    type Row = (String, i64, String, String, i64, i64, i64);
    let rows: Vec<Row> = bind_all!(sqlx::query_as(&page_sql), &binds)
        .bind(limit.clamp(1, 500))
        .bind(offset.max(0))
        .fetch_all(&mut *conn)
        .await?;
    let mut groups = Vec::with_capacity(rows.len());
    for (key, count, first_date, last_date, total_minor, uncategorised, paired) in rows {
        let one = EntryFilter { group_key: Some(key.clone()), ..filter.clone() };
        let (gsql, gbinds) = filter_sql(&mut conn, ent, &one).await?;
        let label_sql = format!("SELECT COALESCE(NULLIF(e.payee, ''), e.description){gsql} ORDER BY e.date DESC, e.id DESC LIMIT 1");
        let label: Option<String> = bind_all!(sqlx::query_scalar(&label_sql), &gbinds).fetch_optional(&mut *conn).await?;
        let category_sql = format!(
            "SELECT l.ledger_account_id FROM fin_lines l WHERE l.entry_id IN (SELECT e.id{gsql}) \
             AND l.ledger_account_id NOT IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = {}) \
             AND l.ledger_account_id NOT IN ({}, {}, {}, {}) \
             GROUP BY l.ledger_account_id ORDER BY COUNT(*) DESC LIMIT 1",
            ent.id, ids.unc_expense, ids.unc_income, ids.fees, ids.clearing
        );
        let category_id: Option<i64> = bind_all!(sqlx::query_scalar(&category_sql), &gbinds).fetch_optional(&mut *conn).await?;
        let suggested: Option<i64> = if uncategorised > 0 {
            sqlx::query_scalar("SELECT ledger_account_id FROM fin_group_suggestions WHERE entity_id = ? AND group_key = ?")
                .bind(ent.id)
                .bind(&key)
                .fetch_optional(&mut *conn)
                .await?
                .flatten()
        } else {
            None
        };
        groups.push(InboxGroup {
            direction: direction(&key),
            label: label.unwrap_or_default(),
            key,
            count,
            total_minor,
            first_date,
            last_date,
            category_id,
            uncategorised,
            paired,
            suggested_ledger_account_id: suggested,
        });
    }
    Ok(GroupPage { groups, total_groups, total_lines })
}

// ============== Acting on everything a filter matches ==============

#[derive(Debug, Clone, Default, Serialize)]
pub struct PostOutcome {
    pub posted: usize,
    /// Drafts left as they are because their month is closed.
    pub closed: usize,
    /// Drafts left because they wait in a transfer pair to review: the user decides those.
    pub review: usize,
}

/// Posts these drafts, in one transaction: the ones dated in a closed month or waiting in a
/// transfer pair to review are left, and counted. An entry that's already posted is skipped,
/// and so is one dated on or after `before` when that's given.
pub(crate) async fn post_ids_in(conn: &mut Conn, ent: &Entity, ids: &[i64], before: Option<&str>, out: &mut PostOutcome) -> Result<()> {
    let latest: Option<String> = sqlx::query_scalar("SELECT MAX(month) FROM fin_periods WHERE entity_id = ? AND status = 'closed'")
        .bind(ent.id)
        .fetch_one(&mut *conn)
        .await?;
    let at = now();
    for &id in ids {
        let date: Option<String> = sqlx::query_scalar("SELECT date FROM fin_entries WHERE id = ? AND entity_id = ? AND status = 'draft'")
            .bind(id)
            .bind(ent.id)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(date) = date else { continue };
        if before.is_some_and(|b| date.as_str() >= b) {
            continue;
        }
        let in_review: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM fin_pairs WHERE (entry_a = ?1 OR entry_b = ?1) AND status = 'review')")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
        if in_review {
            out.review += 1;
            continue;
        }
        if latest.as_deref().is_some_and(|m| date.get(..7).unwrap_or(&date) <= m) {
            out.closed += 1;
            continue;
        }
        sqlx::query("UPDATE fin_entries SET status = 'posted', updated_at = ? WHERE id = ?").bind(&at).bind(id).execute(&mut *conn).await?;
        audit(conn, ent, "post", "entry", Some(id), Some(&serde_json::json!({"status": "draft"})), Some(&serde_json::json!({"status": "posted"})))
            .await?;
        out.posted += 1;
    }
    Ok(())
}

/// The ids of the drafts a filter matches, oldest first, with `extra` SQL appended to the
/// filter's `WHERE` (binds after the filter's).
async fn matching(db: &Db, ent: &Entity, filter: &EntryFilter, extra: &str, extra_binds: &[i64]) -> Result<Vec<i64>> {
    if filter.group_key.is_some() {
        fill_group_keys(db, ent).await?;
    }
    let mut conn = db.acquire().await?;
    let (sql, binds) = filter_sql(&mut conn, ent, filter).await?;
    let ids_sql = format!("SELECT e.id{sql}{extra} ORDER BY e.date, e.id");
    let mut q = bind_all!(sqlx::query_scalar::<_, i64>(&ids_sql), &binds);
    for b in extra_binds {
        q = q.bind(*b);
    }
    Ok(q.fetch_all(&mut *conn).await?)
}

/// `fin_post_matching`: posts every draft the filter matches (not just the page shown), in
/// short batches. A posted entry stays editable until its month is closed, so this can be
/// undone entry by entry.
pub async fn post_matching(db: &Db, ent: &Entity, filter: EntryFilter, opts: &BulkOptions) -> Result<PostOutcome> {
    // A reset is refused while this runs, and this while a reset runs.
    let _busy = super::reset::begin_bulk(db, ent)?;
    let ids = matching(db, ent, &drafts(filter), "", &[]).await?;
    let mut out = PostOutcome::default();
    for chunk in ids.chunks(opts.batch.max(1)) {
        let mut tx = write_tx(db).await?;
        post_ids_in(&mut tx, ent, chunk, None, &mut out).await?;
        tx.commit().await?;
        tokio::time::sleep(opts.pause).await;
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CategoriseOutcome {
    pub categorised: usize,
    /// Matching drafts that couldn't take the category (a closed month, a line that
    /// changed meanwhile).
    pub skipped: usize,
    /// The rule created with it, when asked.
    pub rule: Option<Rule>,
    /// A rule for the same lines, in `fin_create_rule`'s input shape, when one can be made and
    /// wasn't asked for: the interface offers "and remember as a rule".
    pub rule_input: Option<RuleInput>,
}

/// A rule that files future lines like the ones a filter matches: a payee group's merchant
/// and direction, else the search text (and the account). Dates can't be a rule, so a filter
/// with neither gives none.
async fn rule_for(conn: &mut Conn, ent: &Entity, filter: &EntryFilter, ledger_account_id: i64) -> Result<Option<RuleInput>> {
    let mut conditions = Conditions { account_id: filter.account_id, ..Default::default() };
    if let Some(key) = &filter.group_key {
        let merchant = key.split_once(':').map(|(_, m)| m).unwrap_or("").trim();
        if merchant.is_empty() {
            return Ok(None);
        }
        let pattern = format!("*{}*", merchant.split_whitespace().collect::<Vec<_>>().join("*"));
        // Match on the payee when the group's lines have one (the key came from it).
        let with_payee: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM fin_entries WHERE entity_id = ? AND group_key = ? AND COALESCE(payee, '') != ''",
        )
        .bind(ent.id)
        .bind(key)
        .fetch_one(&mut *conn)
        .await?;
        if with_payee {
            conditions.payee = Some(pattern);
        } else {
            conditions.description = Some(pattern);
        }
        if direction(key) == "out" {
            conditions.max_amount_minor = Some(-1);
        } else {
            conditions.min_amount_minor = Some(0);
        }
    } else if let Some(q) = filter.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        conditions.text = Some(q.to_string());
    } else {
        return Ok(None);
    }
    Ok(Some(RuleInput { position: None, conditions, action: Action { ledger_account_id: Some(ledger_account_id), splits: vec![] }, learned: false }))
}

/// `fin_categorise_matching`: gives every draft the filter matches whose counter side is still
/// uncategorised (and that isn't a transfer leg) this category, in short batches. With
/// `create_rule`, also saves a rule for such lines (see [`rule_for`]); without, the rule is
/// returned as a proposal.
pub async fn categorise_matching(
    db: &Db,
    ent: &Entity,
    filter: EntryFilter,
    ledger_account_id: i64,
    create_rule: bool,
    opts: &BulkOptions,
) -> Result<CategoriseOutcome> {
    let _busy = super::reset::begin_bulk(db, ent)?;
    let filter = EntryFilter { uncategorised: Some(true), ..drafts(filter) };
    let (ids, proposal) = {
        let mut conn = db.acquire().await?;
        let la = get_ledger_account_in(&mut conn, ent, ledger_account_id).await?;
        if la.archived {
            return Err(AppError::InvalidInput("that ledger account is archived".into()));
        }
        if !matches!(la.class.as_str(), "income" | "expense")
            || la.currency.is_some()
            || la.system_key.as_deref().is_some_and(|k| k.starts_with("uncategorised"))
        {
            return Err(AppError::InvalidInput("pick an income or expense category".into()));
        }
        let ids = ids(&mut conn, ent).await?;
        let proposal = rule_for(&mut conn, ent, &filter, ledger_account_id).await?;
        if create_rule && proposal.is_none() {
            return Err(AppError::InvalidInput("a rule needs a payee group or a search to match on".into()));
        }
        (ids, proposal)
    };
    // Only drafts whose whole counter side is uncategorised (beside the bank's fee), and no
    // transfer or exchange legs. The split takes the uncategorised lines' amount.
    let extra = format!(
        " AND NOT EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id NOT IN ({}, {}, {}) \
           AND l.ledger_account_id NOT IN (SELECT ledger_account_id FROM fin_accounts WHERE entity_id = ?)) \
         AND NOT {LIVE_PAIR}",
        ids.unc_expense, ids.unc_income, ids.fees
    );
    let rows = matching(db, ent, &filter, &extra, &[ent.id]).await?;
    let mut out = CategoriseOutcome::default();
    // The rule first: if it's refused, nothing has been written.
    if create_rule {
        out.rule = Some(super::rules::create_rule(db, ent, proposal.clone().expect("checked above")).await?);
    }
    for chunk in rows.chunks(opts.batch.max(1)) {
        let mut tx = write_tx(db).await?;
        for &id in chunk {
            let amount: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(amount_minor), 0) FROM fin_lines WHERE entry_id = ? AND ledger_account_id IN (?, ?)",
            )
            .bind(id)
            .bind(ids.unc_expense)
            .bind(ids.unc_income)
            .fetch_one(&mut *tx)
            .await?;
            if amount == 0 {
                out.skipped += 1; // sorted meanwhile
                continue;
            }
            let split = Split { ledger_account_id, amount_minor: amount, memo: None };
            // `categorise_in` checks everything before its first write, so a refused line
            // leaves nothing behind in the batch.
            match super::categorise_in(&mut tx, ent, id, vec![split]).await {
                Ok(_) => out.categorised += 1,
                Err(AppError::InvalidInput(_)) => out.skipped += 1,
                Err(e) => return Err(e),
            }
        }
        tx.commit().await?;
        tokio::time::sleep(opts.pause).await;
    }
    // The user chose for the group: its suggestion has served.
    if let Some(key) = &filter.group_key {
        sqlx::query("DELETE FROM fin_group_suggestions WHERE entity_id = ? AND group_key = ?").bind(ent.id).bind(key).execute(db).await?;
    }
    if !create_rule {
        out.rule_input = proposal;
    }
    Ok(out)
}

// ============== Suggestions per group ==============

/// What the local model sees of a payee group: its latest draft's description, payee and
/// amount, and how many drafts it holds.
#[derive(Debug, Clone, Serialize)]
pub struct GroupSample {
    pub key: String,
    pub count: i64,
    pub description: String,
    pub payee: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
}

/// The payee groups with uncategorised drafts (no transfer legs) that the model hasn't been
/// asked about yet (a dismissed or empty answer stays), the largest first.
pub async fn groups_to_suggest(db: &Db, ent: &Entity) -> Result<Vec<GroupSample>> {
    fill_group_keys(db, ent).await?;
    let mut conn = db.acquire().await?;
    let ids = ids(&mut conn, ent).await?;
    let keys: Vec<(String, i64)> = sqlx::query_as(&format!(
        "SELECT e.group_key, COUNT(*) AS n FROM fin_entries e \
         WHERE e.entity_id = ? AND e.status = 'draft' AND e.group_key IS NOT NULL AND e.group_key NOT IN ('in:', 'out:') \
           AND EXISTS (SELECT 1 FROM fin_lines l WHERE l.entry_id = e.id AND l.ledger_account_id IN ({}, {})) \
           AND NOT {LIVE_PAIR} \
           AND NOT EXISTS (SELECT 1 FROM fin_group_suggestions g WHERE g.entity_id = e.entity_id AND g.group_key = e.group_key) \
         GROUP BY e.group_key ORDER BY n DESC, e.group_key",
        ids.unc_expense, ids.unc_income
    ))
    .bind(ent.id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(keys.len());
    for (key, count) in keys {
        let row: Option<(String, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(&format!(
            "SELECT e.description, e.payee, {BANK_AMOUNT}, \
               (SELECT l.currency FROM fin_lines l JOIN fin_accounts a ON a.ledger_account_id = l.ledger_account_id WHERE l.entry_id = e.id LIMIT 1) \
             FROM fin_entries e WHERE e.entity_id = ? AND e.status = 'draft' AND e.group_key = ? ORDER BY e.date DESC, e.id DESC LIMIT 1"
        ))
        .bind(ent.id)
        .bind(&key)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some((description, payee, Some(amount_minor), Some(currency))) = row {
            out.push(GroupSample { key, count, description, payee, amount_minor, currency });
        }
    }
    Ok(out)
}

/// Stores the local model's category for some groups (`None`: nothing fits). The category
/// must be the entity's own. The user takes a suggestion or not; the host never applies one.
pub async fn save_group_suggestions(db: &Db, ent: &Entity, picks: &[(String, Option<i64>)]) -> Result<()> {
    let mut tx = write_tx(db).await?;
    for (key, la) in picks {
        if let Some(la) = la {
            get_ledger_account_in(&mut tx, ent, *la).await?;
        }
        sqlx::query(
            "INSERT INTO fin_group_suggestions (entity_id, group_key, ledger_account_id, created_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(entity_id, group_key) DO UPDATE SET ledger_account_id = excluded.ledger_account_id, created_at = excluded.created_at",
        )
        .bind(ent.id)
        .bind(key)
        .bind(la)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Forgets a group's suggestion (the user dismissed it).
pub async fn dismiss_group_suggestion(db: &Db, ent: &Entity, key: &str) -> Result<()> {
    sqlx::query("UPDATE fin_group_suggestions SET ledger_account_id = NULL WHERE entity_id = ? AND group_key = ?")
        .bind(ent.id)
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_keys_split_by_direction_and_drop_references() {
        assert_eq!(group_key("Card payment 1234 Green Market", None, -2_000), "out:card payment green market");
        assert_eq!(group_key("x", Some("Green Market"), -2_000), "out:green market");
        assert_eq!(group_key("x", Some("Green Market"), 500), "in:green market");
        assert_eq!(group_key("0042", None, -1), "out:");
        assert_eq!(direction("out:a"), "out");
        assert_eq!(direction("in:a"), "in");
    }
}
