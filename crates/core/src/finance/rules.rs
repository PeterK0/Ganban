//! Categorisation rules: conditions on a bank line, and the category (or splits) it
//! gets. Rules run in `position` order on drafts and the first match wins.
//!
//! A rule is learned from corrections: after the second time the user categorises
//! the same merchant the same way, `suggest_rule` drafts a rule for them to accept.

use serde::{Deserialize, Serialize};

use super::import::decode::clean_text;
use super::pairing::{bank_view, is_paired, skippable, sys, Sys};
use super::{audit, get_account_in, get_entry_in, get_ledger_account_in, not_found, now, Conn, Entity};
use crate::error::{AppError, Result};
use crate::Db;

/// What a bank line must look like for a rule to apply. Unset fields match anything;
/// text patterns are case-insensitive substrings, with `*` as a wildcard.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Conditions {
    /// Matches the description or the payee.
    pub text: Option<String>,
    pub description: Option<String>,
    pub payee: Option<String>,
    /// Signed bounds in minor units, inclusive (spending is negative).
    pub min_amount_minor: Option<i64>,
    pub max_amount_minor: Option<i64>,
    pub account_id: Option<i64>,
    pub bank_category: Option<String>,
    pub kind_hint: Option<String>,
    pub currency: Option<String>,
}

/// One share of a split action: a fixed amount (as a positive magnitude) or a
/// percentage; a share with neither takes the remainder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSplit {
    pub ledger_account_id: i64,
    #[serde(default)]
    pub amount_minor: Option<i64>,
    #[serde(default)]
    pub percent: Option<f64>,
}

/// The largest fixed split amount a rule may name (10^13 minor units).
pub const MAX_SPLIT_MINOR: i64 = 10_000_000_000_000;

/// What a matching rule does: one category, or splits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    pub ledger_account_id: Option<i64>,
    pub splits: Vec<RuleSplit>,
}

/// The facts about a bank line that rules look at.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Subject {
    pub description: String,
    pub payee: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub account_id: i64,
    pub bank_category: Option<String>,
    pub kind_hint: Option<String>,
}

/// Case-insensitive match: a substring, or a glob when the pattern has `*`.
pub fn text_matches(pattern: &str, text: &str) -> bool {
    let p = clean_text(pattern).to_lowercase();
    let t = clean_text(text).to_lowercase();
    if p.is_empty() {
        return true;
    }
    if !p.contains('*') {
        return t.contains(&p);
    }
    // Glob: every literal piece in order; anchored where the pattern has no `*`.
    let pieces: Vec<&str> = p.split('*').collect();
    let mut rest = t.as_str();
    for (i, piece) in pieces.iter().enumerate() {
        if piece.is_empty() {
            continue;
        }
        if i == 0 {
            match rest.strip_prefix(piece) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == pieces.len() - 1 {
            return rest.ends_with(piece);
        } else {
            match rest.find(piece) {
                Some(at) => rest = &rest[at + piece.len()..],
                None => return false,
            }
        }
    }
    true
}

impl Conditions {
    /// True when no field is set (a rule like that would match everything).
    pub fn is_empty(&self) -> bool {
        *self == Conditions::default()
    }

    pub fn matches(&self, s: &Subject) -> bool {
        let payee = s.payee.as_deref().unwrap_or("");
        let eq = |want: &Option<String>, have: Option<&str>| {
            want.as_ref().is_none_or(|w| have.is_some_and(|h| clean_text(h).eq_ignore_ascii_case(&clean_text(w))))
        };
        self.text.as_ref().is_none_or(|p| text_matches(p, &s.description) || text_matches(p, payee))
            && self.description.as_ref().is_none_or(|p| text_matches(p, &s.description))
            && self.payee.as_ref().is_none_or(|p| s.payee.is_some() && text_matches(p, payee))
            && self.min_amount_minor.is_none_or(|m| s.amount_minor >= m)
            && self.max_amount_minor.is_none_or(|m| s.amount_minor <= m)
            && self.account_id.is_none_or(|a| a == s.account_id)
            && eq(&self.bank_category, s.bank_category.as_deref())
            && eq(&self.kind_hint, s.kind_hint.as_deref())
            && eq(&self.currency, Some(s.currency.as_str()))
    }
}

impl Action {
    /// Checks the action names a category or well-formed splits.
    pub fn validate(&self) -> std::result::Result<(), &'static str> {
        match (self.ledger_account_id, self.splits.is_empty()) {
            (Some(_), true) => Ok(()),
            (None, false) => {
                let mut remainders = 0;
                let mut pct = 0.0;
                for s in &self.splits {
                    match (s.amount_minor, s.percent) {
                        (Some(a), None) if (0..=MAX_SPLIT_MINOR).contains(&a) => {}
                        (None, Some(p)) if (0.0..=100.0).contains(&p) => pct += p,
                        (None, None) => remainders += 1,
                        _ => return Err("each split takes an amount, a percentage, or the rest"),
                    }
                }
                if remainders > 1 {
                    return Err("only one split can take the rest");
                }
                if pct > 100.0 + 1e-9 {
                    return Err("the percentages add up to more than 100");
                }
                Ok(())
            }
            (Some(_), false) => Err("a rule sets one category or splits, not both"),
            (None, true) => Err("a rule needs a category or splits"),
        }
    }

    /// The category shares for a bank line of `amount_minor` (signed), in the same
    /// sign, summing to it exactly. Percentages round down, and the rest goes to the remainder share, else the
    /// last share. `None` when the fixed amounts exceed the line.
    pub fn shares(&self, amount_minor: i64) -> Option<Vec<(i64, i64)>> {
        if let Some(la) = self.ledger_account_id {
            return Some(vec![(la, amount_minor)]);
        }
        if self.splits.is_empty() {
            return None;
        }
        let sign = if amount_minor < 0 { -1 } else { 1 };
        let total = amount_minor.abs();
        let mut out: Vec<(i64, i64)> = Vec::with_capacity(self.splits.len());
        let mut used = 0i64;
        let mut rest_at = None;
        for (i, s) in self.splits.iter().enumerate() {
            let part = match (s.amount_minor, s.percent) {
                (Some(a), _) => a,
                (None, Some(p)) => ((total as f64) * p / 100.0).floor() as i64,
                (None, None) => {
                    rest_at = Some(i);
                    0
                }
            };
            used = used.checked_add(part)?;
            out.push((s.ledger_account_id, part));
        }
        if used > total {
            return None;
        }
        let idx = rest_at.unwrap_or(out.len() - 1);
        out[idx].1 += total - used;
        Some(out.into_iter().filter(|(_, a)| *a != 0).map(|(la, a)| (la, a * sign)).collect())
    }
}

/// The merchant a correction is about: the payee, else the description with digits
/// and punctuation dropped (card lines carry references and dates).
pub fn merchant_key(description: &str, payee: Option<&str>) -> String {
    let base = payee.filter(|p| !p.trim().is_empty()).unwrap_or(description);
    let kept: String = base
        .chars()
        .map(|c| if c.is_alphabetic() || c.is_whitespace() { c } else { ' ' })
        .collect();
    clean_text(&kept).to_lowercase()
}

// ============== Stored rules ==============

/// A stored rule. `conditions` and `action` keep their input shape (camelCase), so a
/// rule can be edited and sent back as it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rule {
    pub id: i64,
    pub position: i64,
    pub conditions: Conditions,
    pub action: Action,
    pub learned: bool,
    pub hits: i64,
    pub created_at: String,
}

/// `fin_create_rule` / `fin_update_rule` input, and what `fin_suggest_rule` returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    pub conditions: Conditions,
    pub action: Action,
    #[serde(default)]
    pub learned: bool,
}

type RuleRow = (i64, i64, String, String, bool, i64, String);

fn rule_of(r: RuleRow) -> Result<Rule> {
    Ok(Rule {
        id: r.0,
        position: r.1,
        conditions: serde_json::from_str(&r.2)?,
        action: serde_json::from_str(&r.3)?,
        learned: r.4,
        hits: r.5,
        created_at: r.6,
    })
}

const RULE_COLS: &str = "id, position, conditions_json, action_json, learned, hits, created_at";

async fn rules_in(conn: &mut Conn, ent: &Entity) -> Result<Vec<Rule>> {
    let rows: Vec<RuleRow> =
        sqlx::query_as(&format!("SELECT {RULE_COLS} FROM fin_rules WHERE entity_id = ? ORDER BY position, id"))
            .bind(ent.id)
            .fetch_all(&mut *conn)
            .await?;
    rows.into_iter().map(rule_of).collect()
}

async fn get_rule_in(conn: &mut Conn, ent: &Entity, id: i64) -> Result<Rule> {
    let row: RuleRow = sqlx::query_as(&format!("SELECT {RULE_COLS} FROM fin_rules WHERE id = ? AND entity_id = ?"))
        .bind(id)
        .bind(ent.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| not_found("rule"))?;
    rule_of(row)
}

/// Checks a rule's input against the entity: something to match, a valid action, and
/// accounts that are the entity's own.
async fn check_input(conn: &mut Conn, ent: &Entity, input: &RuleInput) -> Result<()> {
    if input.conditions.is_empty() {
        return Err(AppError::InvalidInput("a rule needs at least one condition".into()));
    }
    let c = &input.conditions;
    let blank = |p: &Option<String>| p.as_ref().is_some_and(|p| p.trim_matches(|ch: char| ch == '*' || ch.is_whitespace()).is_empty());
    if blank(&c.text) || blank(&c.description) || blank(&c.payee) {
        return Err(AppError::InvalidInput("a text condition can't be blank or only *".into()));
    }
    input.action.validate().map_err(|m| AppError::InvalidInput(m.into()))?;
    if let Some(a) = input.conditions.account_id {
        get_account_in(conn, ent, a).await?;
    }
    let targets = input.action.ledger_account_id.into_iter().chain(input.action.splits.iter().map(|s| s.ledger_account_id));
    for la in targets.collect::<Vec<_>>() {
        if get_ledger_account_in(conn, ent, la).await?.archived {
            return Err(AppError::InvalidInput("that ledger account is archived".into()));
        }
    }
    Ok(())
}

pub async fn list_rules(db: &Db, ent: &Entity) -> Result<Vec<Rule>> {
    let mut conn = db.acquire().await?;
    rules_in(&mut conn, ent).await
}

pub async fn create_rule(db: &Db, ent: &Entity, input: RuleInput) -> Result<Rule> {
    let mut tx = db.begin().await?;
    check_input(&mut tx, ent, &input).await?;
    let position = match input.position {
        Some(p) => p,
        None => sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(position), 0) + 1 FROM fin_rules WHERE entity_id = ?")
            .bind(ent.id)
            .fetch_one(&mut *tx)
            .await?,
    };
    let id = sqlx::query(
        "INSERT INTO fin_rules (entity_id, position, conditions_json, action_json, learned, hits, created_at) \
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(ent.id)
    .bind(position)
    .bind(serde_json::to_string(&input.conditions)?)
    .bind(serde_json::to_string(&input.action)?)
    .bind(input.learned)
    .bind(now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let rule = get_rule_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "create", "rule", Some(id), None, Some(&serde_json::to_value(&rule)?)).await?;
    tx.commit().await?;
    Ok(rule)
}

pub async fn update_rule(db: &Db, ent: &Entity, id: i64, input: RuleInput) -> Result<Rule> {
    let mut tx = db.begin().await?;
    let before = get_rule_in(&mut tx, ent, id).await?;
    check_input(&mut tx, ent, &input).await?;
    sqlx::query("UPDATE fin_rules SET position = ?, conditions_json = ?, action_json = ?, learned = ? WHERE id = ?")
        .bind(input.position.unwrap_or(before.position))
        .bind(serde_json::to_string(&input.conditions)?)
        .bind(serde_json::to_string(&input.action)?)
        .bind(input.learned)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let after = get_rule_in(&mut tx, ent, id).await?;
    audit(&mut tx, ent, "update", "rule", Some(id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&after)?)).await?;
    tx.commit().await?;
    Ok(after)
}

pub async fn delete_rule(db: &Db, ent: &Entity, id: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    let before = get_rule_in(&mut tx, ent, id).await?;
    sqlx::query("DELETE FROM fin_rules WHERE id = ?").bind(id).execute(&mut *tx).await?;
    audit(&mut tx, ent, "delete", "rule", Some(id), Some(&serde_json::to_value(&before)?), None).await?;
    tx.commit().await?;
    Ok(())
}

/// The rule facts of an entry's source line, or `None` for an entry without one.
async fn subject_of(conn: &mut Conn, ent: &Entity, source_line_id: Option<i64>) -> Result<Option<Subject>> {
    let Some(sl) = source_line_id else { return Ok(None) };
    type Row = (String, Option<String>, i64, String, i64, Option<String>, Option<String>);
    let r: Option<Row> = sqlx::query_as(
        "SELECT description, payee, amount_minor, currency, account_id, bank_category, kind_hint \
         FROM fin_source_lines WHERE id = ? AND entity_id = ?",
    )
    .bind(sl)
    .bind(ent.id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(r.map(|r| Subject {
        description: r.0,
        payee: r.1,
        amount_minor: r.2,
        currency: r.3,
        account_id: r.4,
        bank_category: r.5,
        kind_hint: r.6,
    }))
}

/// Runs the rules over drafts that are still uncategorised: the given entries, or every
/// draft. The first matching rule categorises the entry. Returns how many it did.
pub async fn apply_rules(db: &Db, ent: &Entity, entry_ids: Option<Vec<i64>>) -> Result<usize> {
    let mut tx = db.begin().await?;
    let s = sys(&mut tx, ent).await?;
    let ids = match entry_ids {
        Some(ids) => ids,
        None => sqlx::query_scalar("SELECT id FROM fin_entries WHERE entity_id = ? AND status = 'draft' AND source_line_id IS NOT NULL")
            .bind(ent.id)
            .fetch_all(&mut *tx)
            .await?,
    };
    let n = apply_rules_in(&mut tx, ent, &s, &ids).await?;
    tx.commit().await?;
    Ok(n)
}

pub(crate) async fn apply_rules_in(conn: &mut Conn, ent: &Entity, s: &Sys, ids: &[i64]) -> Result<usize> {
    let rules = rules_in(conn, ent).await?;
    let mut done = 0;
    for &id in ids {
        let entry = get_entry_in(conn, ent, id).await?;
        // Paired entries (transfers, FX legs, pairs in review) are not categories.
        if rules.is_empty() || entry.status != "draft" || is_paired(conn, id).await? {
            continue;
        }
        let Some(subject) = subject_of(conn, ent, entry.source_line_id).await? else { continue };
        let v = bank_view(conn, ent, s, id).await?;
        if !v.is_uncategorised(s) {
            continue;
        }
        let Some(rule) = rules.iter().find(|r| r.conditions.matches(&subject)) else { continue };
        let Some(shares) = rule.action.shares(v.amount_minor) else { continue };
        let splits = shares
            .into_iter()
            .map(|(la, amount)| super::Split { ledger_account_id: la, amount_minor: amount, memo: None })
            .collect();
        // A rule whose category no longer fits (archived, wrong currency) is skipped.
        match super::categorise_in(conn, ent, id, splits).await {
            Ok(_) => {
                sqlx::query("UPDATE fin_rules SET hits = hits + 1 WHERE id = ?").bind(rule.id).execute(&mut *conn).await?;
                done += 1;
            }
            Err(e) if skippable(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(done)
}

/// After the user categorises an entry: a rule for its merchant, when this is the
/// second entry from that merchant given the same single category and no rule covers
/// it yet. Shaped as `fin_create_rule`'s input, for the user to accept.
pub async fn suggest_rule(db: &Db, ent: &Entity, entry_id: i64) -> Result<Option<RuleInput>> {
    let mut conn = db.acquire().await?;
    let s = sys(&mut conn, ent).await?;
    let v = bank_view(&mut conn, ent, &s, entry_id).await?;
    let Some(subject) = subject_of(&mut conn, ent, v.entry.source_line_id).await? else { return Ok(None) };
    let categories: Vec<i64> = v.counters.iter().map(|c| c.0).collect();
    let [category] = categories.as_slice() else { return Ok(None) };
    if [s.unc_expense, s.unc_income, s.clearing].contains(category) {
        return Ok(None);
    }
    let key = merchant_key(&subject.description, subject.payee.as_deref());
    if key.is_empty() {
        return Ok(None);
    }
    // Other entries with a line on that category (an indexed lookup), from the same merchant
    // and in the same direction: a refund netted against its expense isn't a second fix.
    let others: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT s.description, s.payee FROM fin_lines l \
         JOIN fin_entries e ON e.id = l.entry_id \
         JOIN fin_source_lines s ON s.id = e.source_line_id \
         WHERE l.ledger_account_id = ? AND e.entity_id = ? AND e.id != ? AND e.status != 'reversed' \
           AND (s.amount_minor > 0) = (? > 0) \
         ORDER BY e.date DESC LIMIT 500",
    )
    .bind(category)
    .bind(ent.id)
    .bind(entry_id)
    .bind(subject.amount_minor)
    .fetch_all(&mut *conn)
    .await?;
    if !others.iter().any(|(d, p)| merchant_key(d, p.as_deref()) == key) {
        return Ok(None);
    }
    if rules_in(&mut conn, ent).await?.iter().any(|r| r.conditions.matches(&subject)) {
        return Ok(None);
    }
    let pattern = format!("*{}*", key.replace(' ', "*"));
    let conditions = if subject.payee.as_deref().is_some_and(|p| !p.trim().is_empty()) {
        Conditions { payee: Some(pattern), ..Default::default() }
    } else {
        Conditions { description: Some(pattern), ..Default::default() }
    };
    Ok(Some(RuleInput { position: None, conditions, action: Action { ledger_account_id: Some(*category), splits: vec![] }, learned: true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(desc: &str, payee: Option<&str>, amount: i64) -> Subject {
        Subject {
            description: desc.into(),
            payee: payee.map(String::from),
            amount_minor: amount,
            currency: "EUR".into(),
            account_id: 7,
            bank_category: Some("Groceries".into()),
            kind_hint: Some("card".into()),
        }
    }

    #[test]
    fn text_patterns() {
        assert!(text_matches("market", "Green MARKET 42"));
        assert!(text_matches("green*42", "Green Market 42"));
        assert!(!text_matches("green*41", "Green Market 42"));
        assert!(text_matches("*market*", "Green Market 42"));
        assert!(!text_matches("market*", "Green Market"));
        assert!(text_matches("ΑΓΟΡΑ", "αγορα σουπερ μαρκετ"));
    }

    #[test]
    fn conditions_match_all_set_fields() {
        let s = subject("Card payment Green Market", Some("Green Market"), -2_500);
        assert!(Conditions::default().matches(&s));
        assert!(Conditions { text: Some("green".into()), ..Default::default() }.matches(&s));
        assert!(Conditions { payee: Some("market".into()), ..Default::default() }.matches(&s));
        let c = Conditions {
            text: Some("green".into()),
            min_amount_minor: Some(-5_000),
            max_amount_minor: Some(0),
            account_id: Some(7),
            bank_category: Some("groceries".into()),
            kind_hint: Some("card".into()),
            currency: Some("EUR".into()),
            ..Default::default()
        };
        assert!(c.matches(&s));
        assert!(!Conditions { account_id: Some(8), ..c.clone() }.matches(&s));
        assert!(!Conditions { max_amount_minor: Some(-3_000), ..c.clone() }.matches(&s));
        assert!(!Conditions { kind_hint: Some("transfer".into()), ..c.clone() }.matches(&s));
        assert!(!Conditions { payee: Some("x".into()), ..Default::default() }.matches(&subject("x", None, 1)));
    }

    #[test]
    fn shares_sum_to_the_line() {
        let one = Action { ledger_account_id: Some(3), splits: vec![] };
        assert_eq!(one.shares(-1_000), Some(vec![(3, -1_000)]));
        let split = Action {
            ledger_account_id: None,
            splits: vec![
                RuleSplit { ledger_account_id: 1, amount_minor: Some(300), percent: None },
                RuleSplit { ledger_account_id: 2, amount_minor: None, percent: Some(33.0) },
                RuleSplit { ledger_account_id: 3, amount_minor: None, percent: None },
            ],
        };
        assert!(split.validate().is_ok());
        let s = split.shares(-1_000).unwrap();
        assert_eq!(s, vec![(1, -300), (2, -330), (3, -370)]);
        assert_eq!(s.iter().map(|x| x.1).sum::<i64>(), -1_000);
        assert_eq!(split.shares(200), None, "fixed amounts larger than the line");
        // Percentages only: rounding lands on the last share.
        let pct = Action {
            ledger_account_id: None,
            splits: vec![
                RuleSplit { ledger_account_id: 1, amount_minor: None, percent: Some(50.0) },
                RuleSplit { ledger_account_id: 2, amount_minor: None, percent: Some(50.0) },
            ],
        };
        assert_eq!(pct.shares(101), Some(vec![(1, 50), (2, 51)]));
    }

    #[test]
    fn action_validation() {
        assert!(Action::default().validate().is_err());
        assert!(Action { ledger_account_id: Some(1), splits: vec![RuleSplit { ledger_account_id: 2, amount_minor: None, percent: None }] }
            .validate()
            .is_err());
        let two_rests = Action {
            ledger_account_id: None,
            splits: vec![
                RuleSplit { ledger_account_id: 1, amount_minor: None, percent: None },
                RuleSplit { ledger_account_id: 2, amount_minor: None, percent: None },
            ],
        };
        assert!(two_rests.validate().is_err());
        let over = Action {
            ledger_account_id: None,
            splits: vec![RuleSplit { ledger_account_id: 1, amount_minor: None, percent: Some(120.0) }],
        };
        assert!(over.validate().is_err());
        let huge = Action {
            ledger_account_id: None,
            splits: vec![
                RuleSplit { ledger_account_id: 1, amount_minor: Some(i64::MAX), percent: None },
                RuleSplit { ledger_account_id: 2, amount_minor: Some(i64::MAX), percent: None },
            ],
        };
        assert!(huge.validate().is_err());
        assert_eq!(huge.shares(-100), None, "no overflow");
    }

    #[test]
    fn merchant_keys_ignore_references() {
        assert_eq!(merchant_key("GREEN MARKET 0412 *1234", None), "green market");
        assert_eq!(merchant_key("whatever", Some("Wolt")), "wolt");
        assert_eq!(merchant_key("ΑΓΟΡΑ 12/10", None), "αγορα");
    }
}
