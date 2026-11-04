//! The import pipeline on the ledger: profiles, preview, and the import itself.
//!
//! An import parses the file, maps its account guesses to the user's accounts
//! (creating the ones asked for), stores each new line verbatim with its dedupe hash,
//! drafts an entry against `uncategorised_*`, then runs transfer and FX pairing, pocket
//! counterparts, the rules (on what's unpaired) and refund matching, all in one
//! transaction.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{dedupe, parse, AccountGuess, KindHint, Mapping, ParseResult, ParsedRow, ProfileSpec, PREVIEW_ROWS};
use crate::error::{AppError, Result};
use crate::finance::pairing::{self, Fresh};
use crate::finance::rules::apply_rules_in;
use crate::finance::{
    audit, create_account_in, draft_from_source_line_in, get_account_in, not_found, now, Conn, Entity, FinAccount,
    FinAccountInput,
};
use crate::Db;

// ============== Profiles ==============

/// A profile as listed: the built-in ones (no mapping) and the user's saved mappings.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    pub key: String,
    pub name: String,
    pub built_in: bool,
    pub mapping: Option<Mapping>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub key: String,
    pub name: String,
    pub mapping: Mapping,
}

pub async fn list_profiles(db: &Db, ent: &Entity) -> Result<Vec<Profile>> {
    let mut out: Vec<Profile> = super::builtin_profiles()
        .into_iter()
        .map(|p| Profile { key: p.key.into(), name: p.name.into(), built_in: true, mapping: None })
        .collect();
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT key, name, mapping_json FROM fin_profiles WHERE entity_id = ? ORDER BY name, key")
            .bind(ent.id)
            .fetch_all(db)
            .await?;
    for (key, name, json) in rows {
        out.push(Profile { key, name, built_in: false, mapping: Some(serde_json::from_str(&json)?) });
    }
    Ok(out)
}

/// Saves a wizard mapping under a key (replacing one of the user's own with that key).
pub async fn save_profile(db: &Db, ent: &Entity, input: ProfileInput) -> Result<Profile> {
    let key = input.key.trim().to_string();
    let name = input.name.trim().to_string();
    if key.is_empty() || name.is_empty() || key.len() > 80 || name.len() > 120 {
        return Err(AppError::InvalidInput("a profile needs a key and a name".into()));
    }
    if ProfileSpec::builtin(&key).is_some() {
        return Err(AppError::InvalidInput("that key belongs to a built-in profile".into()));
    }
    input.mapping.validate()?;
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO fin_profiles (entity_id, key, name, mapping_json) VALUES (?, ?, ?, ?) \
         ON CONFLICT(entity_id, key) DO UPDATE SET name = excluded.name, mapping_json = excluded.mapping_json",
    )
    .bind(ent.id)
    .bind(&key)
    .bind(&name)
    .bind(serde_json::to_string(&input.mapping)?)
    .execute(&mut *tx)
    .await?;
    let profile = Profile { key, name, built_in: false, mapping: Some(input.mapping) };
    audit(&mut tx, ent, "save", "profile", None, None, Some(&serde_json::to_value(&profile)?)).await?;
    tx.commit().await?;
    Ok(profile)
}

pub async fn delete_profile(db: &Db, ent: &Entity, key: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    let n = sqlx::query("DELETE FROM fin_profiles WHERE entity_id = ? AND key = ?")
        .bind(ent.id)
        .bind(key)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("profile"));
    }
    audit(&mut tx, ent, "delete", "profile", None, Some(&serde_json::json!({ "key": key })), None).await?;
    tx.commit().await?;
    Ok(())
}

/// The profile a key names: a built-in one, else one of the user's saved mappings.
pub async fn resolve_profile(db: &Db, ent: &Entity, key: &str) -> Result<ProfileSpec> {
    if let Some(p) = ProfileSpec::builtin(key) {
        return Ok(p);
    }
    let json: Option<String> = sqlx::query_scalar("SELECT mapping_json FROM fin_profiles WHERE entity_id = ? AND key = ?")
        .bind(ent.id)
        .bind(key)
        .fetch_optional(db)
        .await?;
    let json = json.ok_or_else(|| not_found("profile"))?;
    Ok(ProfileSpec::Mapping { key: key.to_string(), mapping: serde_json::from_str(&json)? })
}

// ============== Preview ==============

/// The user's existing account a guess most likely is: the same masked IBAN, else the
/// same name, currency and profile (or institution).
fn match_account(g: &AccountGuess, accounts: &[FinAccount], profile_key: &str) -> Option<i64> {
    let live = accounts.iter().filter(|a| !a.archived && a.currency == g.currency);
    let by_iban = g.iban_mask.as_ref().and_then(|m| live.clone().find(|a| a.iban_mask.as_ref() == Some(m)));
    by_iban
        .or_else(|| {
            live.clone().find(|a| {
                a.name.eq_ignore_ascii_case(&g.name)
                    && (a.profile_key.as_deref() == Some(profile_key) || a.institution == g.institution)
            })
        })
        .map(|a| a.id)
}

/// Parses a file without storing anything: the first rows, the account guesses (with
/// the user's matching accounts), and warnings.
pub async fn preview(db: &Db, ent: &Entity, bytes: &[u8], profile_key: Option<&str>) -> Result<ParseResult> {
    let spec = match profile_key {
        Some(k) => Some(resolve_profile(db, ent, k).await?),
        None => None,
    };
    let mut r = parse(bytes, spec.as_ref())?;
    r.rows.truncate(PREVIEW_ROWS);
    if let Some(key) = r.profile_key.clone() {
        let accounts = crate::finance::list_accounts(db, ent, false).await?;
        for g in &mut r.accounts {
            g.matched_account_id = match_account(g, &accounts, &key);
        }
    }
    Ok(r)
}

// ============== Import ==============

/// Where a guessed account's lines go: an existing account, or a new one.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AccountChoice {
    Existing(i64),
    Create { create: NewAccount },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    pub kind: String,
    pub name: String,
    pub institution: Option<String>,
    pub currency: String,
}

/// What an import did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ImportResult {
    pub batch_id: i64,
    /// New lines, each drafted as an entry.
    pub created: usize,
    /// Lines already imported (or the real side of a pocket move written earlier).
    pub duplicates: usize,
    /// Pairs made without asking (transfers, FX, pocket moves).
    pub paired: usize,
    /// Pairs waiting for the user.
    pub review: usize,
    pub categorised_by_rules: usize,
    /// Refunds given the category of the expense they return.
    pub refunds: usize,
    /// Rows skipped while parsing, and lines of accounts left out of the map.
    pub warnings: Vec<String>,
}

/// The opening balance of a new account from the file's running balance: the balance
/// before its earliest line, when that line is unambiguous.
fn opening_from_rows(rows: &[&ParsedRow]) -> Option<(i64, String)> {
    let instant = |r: &ParsedRow| r.booked_at.unwrap_or_else(|| r.booked_date.and_time(chrono::NaiveTime::MIN));
    let first = rows.iter().min_by_key(|r| instant(r))?;
    let ties = rows.iter().filter(|r| instant(r) == instant(first)).count();
    let balance = first.balance_minor?;
    (ties == 1).then(|| (balance - (first.amount_minor - first.fee_minor), first.booked_date.format("%Y-%m-%d").to_string()))
}

async fn resolve_accounts(
    conn: &mut Conn,
    ent: &Entity,
    parsed: &ParseResult,
    profile_key: &str,
    map: &HashMap<String, AccountChoice>,
) -> Result<HashMap<String, i64>> {
    let mut out = HashMap::new();
    for g in &parsed.accounts {
        let Some(choice) = map.get(&g.guess_key) else { continue };
        let account = match choice {
            AccountChoice::Existing(id) => get_account_in(conn, ent, *id).await?,
            AccountChoice::Create { create } => {
                let rows: Vec<&ParsedRow> = parsed.rows.iter().filter(|r| r.account_guess == g.guess_key).collect();
                let opening = opening_from_rows(&rows);
                create_account_in(
                    conn,
                    ent,
                    FinAccountInput {
                        kind: create.kind.clone(),
                        name: create.name.clone(),
                        institution: create.institution.clone().or_else(|| g.institution.clone()),
                        currency: create.currency.clone(),
                        iban_mask: g.iban_mask.clone(),
                        profile_key: Some(profile_key.to_string()),
                        opening_balance_minor: opening.as_ref().map(|o| o.0),
                        opening_date: opening.map(|o| o.1),
                    },
                )
                .await?
            }
        };
        if account.archived {
            return Err(AppError::InvalidInput("an account in the map is archived".into()));
        }
        if !account.currency.eq_ignore_ascii_case(&g.currency) {
            return Err(AppError::InvalidInput(format!(
                "an account in the map is in {}, but its lines are in {}",
                account.currency, g.currency
            )));
        }
        out.insert(g.guess_key.clone(), account.id);
    }
    Ok(out)
}

/// Imports a file into the user's books. See the module docs for the steps.
pub async fn import_file(
    db: &Db,
    ent: &Entity,
    file_name: &str,
    bytes: &[u8],
    profile_key: &str,
    account_map: HashMap<String, AccountChoice>,
) -> Result<ImportResult> {
    let spec = resolve_profile(db, ent, profile_key).await?;
    let parsed = parse(bytes, Some(&spec))?;
    let mut tx = db.begin().await?;
    let accounts = resolve_accounts(&mut tx, ent, &parsed, profile_key, &account_map).await?;
    let s = pairing::sys(&mut tx, ent).await?;

    let file_name: String = file_name.trim().chars().take(200).collect();
    let batch_id = sqlx::query(
        "INSERT INTO fin_import_batches (entity_id, file_name, profile_key, imported_at) VALUES (?, ?, ?, ?)",
    )
    .bind(ent.id)
    .bind(if file_name.is_empty() { "import" } else { &file_name })
    .bind(profile_key)
    .bind(now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();

    let mut result = ImportResult { batch_id, warnings: parsed.warnings.clone(), ..Default::default() };
    let rows: Vec<&ParsedRow> = parsed.rows.iter().filter(|r| accounts.contains_key(&r.account_guess)).collect();
    let unmapped = parsed.rows.len() - rows.len();
    if unmapped > 0 {
        result.warnings.push(format!("{unmapped} lines skipped: their account isn't in the map"));
    }
    let owned: Vec<ParsedRow> = rows.iter().map(|r| (*r).clone()).collect();
    let hashes = dedupe::hash_rows(&owned, |r| accounts[&r.account_guess]);

    let mut fresh: Vec<Fresh> = Vec::new();
    let mut pockets: Vec<(i64, i64)> = Vec::new();
    let mut locked = 0;
    for (row, hash) in owned.iter().zip(hashes) {
        let account_id = accounts[&row.account_guess];
        let date = row.booked_date.format("%Y-%m-%d").to_string();
        // A closed month takes no new lines; the user corrects it in an open one.
        if crate::finance::is_locked(&mut tx, ent, &date).await? {
            locked += 1;
            continue;
        }
        let inserted = sqlx::query(
            "INSERT INTO fin_source_lines (entity_id, account_id, batch_id, hash, booked_date, value_date, \
             description, payee, amount_minor, currency, fee_minor, balance_minor, bank_category, kind_hint, raw_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(entity_id, account_id, hash) DO NOTHING",
        )
        .bind(ent.id)
        .bind(account_id)
        .bind(batch_id)
        .bind(&hash)
        .bind(&date)
        .bind(row.value_date.map(|d| d.format("%Y-%m-%d").to_string()))
        .bind(&row.description)
        .bind(&row.payee)
        .bind(row.amount_minor)
        .bind(&row.currency)
        .bind(row.fee_minor)
        .bind(row.balance_minor)
        .bind(&row.bank_category)
        .bind(row.kind_hint.map(|k| k.as_str()))
        .bind(serde_json::Value::Object(row.raw.clone()).to_string())
        .bind(now())
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 0 {
            result.duplicates += 1;
            continue;
        }
        let line_id = inserted.last_insert_rowid();
        // The real side of a pocket move the import wrote earlier: attach it.
        if let Some(entry) = pairing::find_written_counterpart(&mut tx, ent, &s, account_id, &date, row.amount_minor).await? {
            sqlx::query("UPDATE fin_entries SET source_line_id = ?, notes = NULL, updated_at = ? WHERE id = ?")
                .bind(line_id)
                .bind(now())
                .bind(entry)
                .execute(&mut *tx)
                .await?;
            result.duplicates += 1;
            continue;
        }
        // A fee line (Revolut's "Plan fee") is a bank fee from the start.
        let counter = if row.kind_hint == Some(KindHint::Fee) { s.fees } else { s.uncategorised_for(row.amount_minor) };
        let entry = draft_from_source_line_in(&mut tx, ent, line_id, counter, None).await?;
        result.created += 1;
        let counterpart_account = row.counterpart_guess.as_ref().and_then(|g| accounts.get(g)).copied();
        if let Some(pocket) = counterpart_account {
            pockets.push((entry.id, pocket));
        }
        fresh.push(Fresh { entry_id: entry.id, at: row.booked_at, fx_currency: row.fx_currency.clone(), counterpart_account });
    }

    if locked > 0 {
        result.warnings.push(format!("{locked} lines skipped: they fall in a closed month"));
    }

    // Pairing first, so a rule can't take a transfer leg for a category; then the rules
    // on what's left unpaired, then refunds.
    let ids: Vec<i64> = fresh.iter().map(|f| f.entry_id).collect();
    let outcome = pairing::pair_fresh(&mut tx, ent, &s, &fresh).await?;
    result.paired = outcome.paired;
    result.review = outcome.review;
    for (entry, pocket) in pockets {
        if pairing::write_counterpart(&mut tx, ent, &s, entry, pocket).await? {
            result.paired += 1;
        }
    }
    result.categorised_by_rules = apply_rules_in(&mut tx, ent, &s, &ids).await?;
    result.refunds = pairing::match_refunds(&mut tx, ent, &s, &ids).await?;

    sqlx::query("UPDATE fin_import_batches SET rows_total = ?, rows_new = ?, rows_duplicate = ? WHERE id = ?")
        .bind(owned.len() as i64)
        .bind(result.created as i64)
        .bind(result.duplicates as i64)
        .bind(batch_id)
        .execute(&mut *tx)
        .await?;
    let summary = serde_json::json!({
        "profile_key": profile_key, "created": result.created, "duplicates": result.duplicates,
        "paired": result.paired, "review": result.review,
    });
    audit(&mut tx, ent, "import", "batch", Some(batch_id), None, Some(&summary)).await?;
    tx.commit().await?;
    Ok(result)
}
