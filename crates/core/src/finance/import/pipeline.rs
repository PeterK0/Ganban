//! The import pipeline on the ledger: profiles, preview, and the import itself.
//!
//! An import parses the file, maps its account guesses to the user's accounts
//! (creating the ones asked for), stores each new line verbatim with its dedupe hash,
//! drafts an entry against `uncategorised_*`, then runs transfer and FX pairing, pocket
//! counterparts, the rules (on what's unpaired) and refund matching, in short
//! transactions ([`import_file_with`]). [`super::jobs`] runs it in the background.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{dedupe, parse, AccountGuess, KindHint, Mapping, ParseResult, ParsedRow, ProfileSpec, PREVIEW_ROWS};
use crate::error::{AppError, Result};
use crate::finance::pairing::{self, Fresh};
use crate::finance::rates;
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
    /// Lines older than the cut-off the user chose, posted straight away.
    pub posted: usize,
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

/// Where an import is, for the progress bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Parsing the file.
    Reading,
    /// Fetching the exchange rates the file needs (before anything is written).
    Rates,
    /// Creating and checking the accounts in the map.
    Accounts,
    /// Storing and drafting the new lines, in batches.
    Rows,
    /// Transfer and FX pairing, pocket counterparts.
    Pairing,
    /// The rules, then refund matching.
    Rules,
    Done,
}

/// Progress as an import reports it: the stage and, in it, rows done of the total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub done: usize,
    pub total: usize,
}

/// How an import is cut into transactions. Tests shrink the batches and stop early
/// to stand for an interrupted import.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// New lines stored per transaction.
    pub chunk: usize,
    /// Pairs, pocket moves, rule or refund checks per transaction in the final pass.
    pub pass_chunk: usize,
    /// Fail after this many row batches have committed (tests: an interruption).
    #[doc(hidden)]
    pub fail_after_chunks: Option<usize>,
    /// The pause after each row batch commits, and after each final-pass one. SQLite
    /// doesn't queue writers: one waiting on the lock wakes on its own schedule (every
    /// 100 ms once it has waited a while), so without a gap at least that long the
    /// import would take the lock straight back and starve every other write.
    pub pause: std::time::Duration,
    pub pass_pause: std::time::Duration,
    /// Post the new lines dated before this day (`YYYY-MM-DD`) once they've been paired
    /// and ruled, instead of leaving them in the inbox. `None`: post nothing.
    pub post_before: Option<String>,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            chunk: 250,
            pass_chunk: 100,
            fail_after_chunks: None,
            pause: std::time::Duration::from_millis(110),
            pass_pause: std::time::Duration::from_millis(25),
            post_before: None,
        }
    }
}

/// The checks an import makes before it starts: the profile exists and each existing
/// account in the map is the user's own and open. The rest is checked as it runs.
pub async fn check_request(db: &Db, ent: &Entity, profile_key: &str, map: &HashMap<String, AccountChoice>) -> Result<()> {
    resolve_profile(db, ent, profile_key).await?;
    let mut conn = db.acquire().await?;
    for choice in map.values() {
        if let AccountChoice::Existing(id) = choice {
            if get_account_in(&mut conn, ent, *id).await?.archived {
                return Err(AppError::InvalidInput("an account in the map is archived".into()));
            }
        }
    }
    Ok(())
}

/// Imports a file into the user's books, reporting no progress. See [`import_file_with`].
pub async fn import_file(
    db: &Db,
    ent: &Entity,
    file_name: &str,
    bytes: &[u8],
    profile_key: &str,
    account_map: HashMap<String, AccountChoice>,
) -> Result<ImportResult> {
    import_file_with(db, ent, file_name, bytes, profile_key, account_map, &ImportOptions::default(), &|_| {}).await
}

/// The stored lines of these accounts between two dates, for the dedupe matcher.
async fn stored_lines(db: &Db, ent: &Entity, accounts: &[i64], from: &str, to: &str) -> Result<Vec<dedupe::Stored>> {
    let mut out = Vec::new();
    for &account in accounts {
        let rows: Vec<(i64, Option<String>, Option<String>, Option<i64>, String)> = sqlx::query_as(
            "SELECT id, dedupe_key, occurred_at, balance_minor, hash FROM fin_source_lines \
             WHERE entity_id = ? AND account_id = ? AND booked_date BETWEEN ? AND ?",
        )
        .bind(ent.id)
        .bind(account)
        .bind(from)
        .bind(to)
        .fetch_all(db)
        .await?;
        for (line_id, group, occurred_at, balance_minor, hash) in rows {
            let Some(group) = group else { continue };
            out.push(dedupe::Stored { line_id, group, occurred_at, balance_minor, hash });
        }
    }
    Ok(out)
}

/// A write transaction that takes the write lock at its start (`BEGIN IMMEDIATE`),
/// waiting its turn behind other writers. A deferred one that reads first would
/// fail outright, not wait, when another writer commits before its first write (WAL's
/// stale snapshot), and an import's batches read first.
async fn write_tx(db: &Db) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}

/// Imports a file into the user's books, in short transactions, so the rest of the
/// host keeps writing while a years-long export goes in:
///
/// 1. Parse the file, dedupe it against the stored lines, and fetch the exchange rates
///    the new lines need, all before any write.
/// 2. One transaction: resolve the accounts (creating the ones asked for) and open the
///    batch, marked `running`.
/// 3. Store and draft the new lines in batches of [`ImportOptions::chunk`], one
///    transaction each.
/// 4. The final pass, in short transactions: transfer and FX pairing, pocket
///    counterparts, the rules (on what's unpaired), refund matching; then the batch is
///    marked done.
///
/// An interrupted import is safe to run again: dedupe skips the lines it stored, and
/// the lines of every unfinished batch go through this import's final pass (each step
/// skips what's already paired or categorised).
#[allow(clippy::too_many_arguments)]
pub async fn import_file_with(
    db: &Db,
    ent: &Entity,
    file_name: &str,
    bytes: &[u8],
    profile_key: &str,
    account_map: HashMap<String, AccountChoice>,
    opts: &ImportOptions,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<ImportResult> {
    let report = |stage, done, total| progress(Progress { stage, done, total });
    report(Stage::Reading, 0, 0);
    let spec = resolve_profile(db, ent, profile_key).await?;
    let parsed = parse(bytes, Some(&spec))?;

    let owned: Vec<ParsedRow> = parsed.rows.iter().filter(|r| account_map.contains_key(&r.account_guess)).cloned().collect();
    let mut warnings = parsed.warnings.clone();
    let unmapped = parsed.rows.len() - owned.len();
    if unmapped > 0 {
        warnings.push(format!("{unmapped} lines skipped: their account isn't in the map"));
    }

    // Dedupe, before any write: match the lines of existing accounts with what's
    // stored. A new account has nothing stored, so its lines are all new.
    let existing: HashMap<&str, i64> = account_map
        .iter()
        .filter_map(|(k, c)| match c {
            AccountChoice::Existing(id) => Some((k.as_str(), *id)),
            AccountChoice::Create { .. } => None,
        })
        .collect();
    let on_existing: Vec<usize> = (0..owned.len()).filter(|&i| existing.contains_key(owned[i].account_guess.as_str())).collect();
    let incoming: Vec<dedupe::Incoming> =
        on_existing.iter().map(|&i| dedupe::Incoming::of(existing[owned[i].account_guess.as_str()], &owned[i])).collect();
    let dates = || on_existing.iter().map(|&i| owned[i].booked_date);
    let stored = match (dates().min(), dates().max()) {
        (Some(from), Some(to)) => {
            let mut ids: Vec<i64> = existing.values().copied().collect();
            ids.sort_unstable();
            ids.dedup();
            stored_lines(db, ent, &ids, &from.format("%Y-%m-%d").to_string(), &to.format("%Y-%m-%d").to_string()).await?
        }
        _ => Vec::new(),
    };
    let mut verdicts: Vec<Option<dedupe::Verdict>> = vec![None; owned.len()];
    for (&i, v) in on_existing.iter().zip(dedupe::plan(&incoming, &stored)) {
        verdicts[i] = Some(v);
    }

    // Rates for the new lines, before any write: no network wait inside a transaction.
    report(Stage::Rates, 0, 0);
    let new_lines: Vec<&ParsedRow> =
        owned.iter().zip(&verdicts).filter(|(_, v)| !matches!(v, Some(dedupe::Verdict::Known(_)))).map(|(r, _)| r).collect();
    let (need, like) = rates_needed(&new_lines, &ent.functional_currency);
    rates::ensure_rates(db, &need).await?;
    let _ = rates::ensure_rates(db, &like).await;

    report(Stage::Accounts, 0, 0);
    let mut tx = write_tx(db).await?;
    let accounts = resolve_accounts(&mut tx, ent, &parsed, profile_key, &account_map).await?;
    let s = pairing::sys(&mut tx, ent).await?;
    let file_name: String = file_name.trim().chars().take(200).collect();
    let batch_id = sqlx::query(
        "INSERT INTO fin_import_batches (entity_id, file_name, profile_key, imported_at, status) VALUES (?, ?, ?, ?, 'running')",
    )
    .bind(ent.id)
    .bind(if file_name.is_empty() { "import" } else { &file_name })
    .bind(profile_key)
    .bind(now())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    tx.commit().await?;
    let mut result = ImportResult { batch_id, warnings, ..Default::default() };

    // The lines of the accounts just created: new, each with its hash.
    let created: Vec<usize> = (0..owned.len()).filter(|&i| verdicts[i].is_none()).collect();
    let incoming: Vec<dedupe::Incoming> = created.iter().map(|&i| dedupe::Incoming::of(accounts[&owned[i].account_guess], &owned[i])).collect();
    for (&i, v) in created.iter().zip(dedupe::plan(&incoming, &[])) {
        verdicts[i] = Some(v);
    }

    let mut fresh: Vec<Fresh> = Vec::new();
    let mut pockets: Vec<(i64, i64)> = Vec::new();
    let to_fresh = |row: &ParsedRow, entry_id: i64, fresh: &mut Vec<Fresh>, pockets: &mut Vec<(i64, i64)>| {
        let counterpart_account = row.counterpart_guess.as_ref().and_then(|g| accounts.get(g)).copied();
        if let Some(pocket) = counterpart_account {
            pockets.push((entry_id, pocket));
        }
        fresh.push(Fresh { entry_id, at: row.booked_at, fx_currency: row.fx_currency.clone(), counterpart_account });
    };

    // An interrupted import's lines never had the final pass: they get this one. The
    // ones in this file come with what the file says about them (a pocket move's
    // pocket); the rest are paired, ruled and refund-matched on what's stored.
    let unfinished: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT s.id, e.id, b.id FROM fin_source_lines s JOIN fin_import_batches b ON b.id = s.batch_id \
         JOIN fin_entries e ON e.source_line_id = s.id \
         WHERE s.entity_id = ? AND b.status = 'running' AND b.id != ? AND e.status != 'reversed'",
    )
    .bind(ent.id)
    .bind(batch_id)
    .fetch_all(db)
    .await?;
    let unfinished_entry: HashMap<i64, i64> = unfinished.iter().map(|&(line, entry, _)| (line, entry)).collect();
    let mut resumed_batches: Vec<i64> = unfinished.iter().map(|u| u.2).collect();
    resumed_batches.sort_unstable();
    resumed_batches.dedup();

    let mut new_rows: Vec<(&ParsedRow, String)> = Vec::new();
    for (row, verdict) in owned.iter().zip(verdicts) {
        match verdict {
            Some(dedupe::Verdict::New(hash)) => new_rows.push((row, hash)),
            Some(dedupe::Verdict::Known(line_id)) => {
                result.duplicates += 1;
                if let Some(&entry_id) = unfinished_entry.get(&line_id) {
                    to_fresh(row, entry_id, &mut fresh, &mut pockets);
                }
            }
            None => unreachable!("every line has a verdict"),
        }
    }
    let seen: std::collections::HashSet<i64> = fresh.iter().map(|f| f.entry_id).collect();
    for &(_, entry_id, _) in &unfinished {
        if !seen.contains(&entry_id) {
            fresh.push(Fresh { entry_id, at: None, fx_currency: None, counterpart_account: None });
        }
    }

    // The new lines, a batch per transaction.
    let total = owned.len();
    let mut done = total - new_rows.len();
    report(Stage::Rows, done, total);
    let mut locked = 0;
    let mut month_locked: HashMap<String, bool> = HashMap::new();
    for (n, chunk) in new_rows.chunks(opts.chunk.max(1)).enumerate() {
        if opts.fail_after_chunks == Some(n) {
            return Err(AppError::InvalidInput("import interrupted (test)".into()));
        }
        let mut tx = write_tx(db).await?;
        for (row, hash) in chunk {
            let account_id = accounts[&row.account_guess];
            let date = row.booked_date.format("%Y-%m-%d").to_string();
            // A closed month takes no new lines; the user corrects it in an open one.
            let month = date[..7].to_string();
            let is_locked = match month_locked.get(&month) {
                Some(l) => *l,
                None => {
                    let l = crate::finance::is_locked(&mut tx, ent, &date).await?;
                    month_locked.insert(month, l);
                    l
                }
            };
            if is_locked {
                locked += 1;
                continue;
            }
            let inserted = sqlx::query(
                "INSERT INTO fin_source_lines (entity_id, account_id, batch_id, hash, dedupe_key, occurred_at, booked_date, value_date, \
                 description, payee, amount_minor, currency, fee_minor, balance_minor, bank_category, kind_hint, raw_json, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(entity_id, account_id, hash) DO NOTHING",
            )
            .bind(ent.id)
            .bind(account_id)
            .bind(batch_id)
            .bind(hash)
            .bind(dedupe::group_of(account_id, row))
            .bind(row.occurred_at.map(dedupe::second))
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
            to_fresh(row, entry.id, &mut fresh, &mut pockets);
        }
        tx.commit().await?;
        done += chunk.len();
        report(Stage::Rows, done, total);
        tokio::time::sleep(opts.pause).await;
    }
    if locked > 0 {
        result.warnings.push(format!("{locked} lines skipped: they fall in a closed month"));
    }

    // The final pass. Pairing first, so a rule can't take a transfer leg for a
    // category; then the rules on what's left unpaired, then refunds. The pairs are
    // worked out on a plain connection, then booked in short transactions.
    let ids: Vec<i64> = fresh.iter().map(|f| f.entry_id).collect();
    let step = opts.pass_chunk.max(1);
    report(Stage::Pairing, 0, ids.len());
    let proposals = {
        let mut conn = db.acquire().await?;
        pairing::plan_pairs(&mut conn, ent, &s, &fresh).await?
    };
    for chunk in proposals.chunks(step) {
        let mut tx = write_tx(db).await?;
        let outcome = pairing::book_pairs(&mut tx, ent, &s, chunk).await?;
        tx.commit().await?;
        tokio::time::sleep(opts.pass_pause).await;
        result.paired += outcome.paired;
        result.review += outcome.review;
    }
    for chunk in pockets.chunks(step) {
        let mut tx = write_tx(db).await?;
        for &(entry, pocket) in chunk {
            if pairing::write_counterpart(&mut tx, ent, &s, entry, pocket).await? {
                result.paired += 1;
            }
        }
        tx.commit().await?;
        tokio::time::sleep(opts.pass_pause).await;
    }
    report(Stage::Rules, 0, ids.len());
    for (n, chunk) in ids.chunks(step).enumerate() {
        let mut tx = write_tx(db).await?;
        result.categorised_by_rules += apply_rules_in(&mut tx, ent, &s, chunk).await?;
        result.refunds += pairing::match_refunds(&mut tx, ent, &s, chunk).await?;
        tx.commit().await?;
        tokio::time::sleep(opts.pass_pause).await;
        report(Stage::Rules, ((n + 1) * step).min(ids.len()), ids.len());
    }

    // History the bank settled long ago skips the inbox when the user asks: posted after
    // pairing and the rules, so it goes in as well sorted as it can be.
    if let Some(before) = opts.post_before.as_deref() {
        let mut out = crate::finance::inbox::PostOutcome::default();
        for chunk in ids.chunks(step) {
            let mut tx = write_tx(db).await?;
            crate::finance::inbox::post_ids_in(&mut tx, ent, chunk, Some(before), &mut out).await?;
            tx.commit().await?;
            tokio::time::sleep(opts.pass_pause).await;
        }
        result.posted = out.posted;
    }

    let mut tx = write_tx(db).await?;
    sqlx::query("UPDATE fin_import_batches SET rows_total = ?, rows_new = ?, rows_duplicate = ?, status = 'done' WHERE id = ?")
        .bind(owned.len() as i64)
        .bind(result.created as i64)
        .bind(result.duplicates as i64)
        .bind(batch_id)
        .execute(&mut *tx)
        .await?;
    for b in &resumed_batches {
        sqlx::query("UPDATE fin_import_batches SET status = 'done' WHERE id = ? AND entity_id = ?")
            .bind(b)
            .bind(ent.id)
            .execute(&mut *tx)
            .await?;
    }
    let summary = serde_json::json!({
        "profile_key": profile_key, "created": result.created, "duplicates": result.duplicates,
        "paired": result.paired, "review": result.review,
    });
    audit(&mut tx, ent, "import", "batch", Some(batch_id), None, Some(&summary)).await?;
    tx.commit().await?;
    report(Stage::Done, total, total);
    Ok(result)
}

/// The (currency, date) pairs an import needs a rate for: each foreign line's date, in
/// its currency and in the functional currency. The second list is what pairing would
/// like (the other currency an exchange leg names, for its plausibility check): fetched
/// too, but an import goes ahead without it.
pub fn rates_needed(rows: &[&ParsedRow], functional: &str) -> (Vec<(String, String)>, Vec<(String, String)>) {
    let (mut need, mut like) = (Vec::new(), Vec::new());
    let (mut seen_need, mut seen_like) = (std::collections::HashSet::new(), std::collections::HashSet::new());
    for r in rows {
        let date = r.booked_date.format("%Y-%m-%d").to_string();
        let foreign = !r.currency.eq_ignore_ascii_case(functional);
        let wanted = [(foreign, Some(r.currency.as_str())), (foreign, Some(functional)), (false, r.fx_currency.as_deref())];
        for (required, cur) in wanted {
            let Some(cur) = cur.map(str::to_uppercase) else { continue };
            if cur == "EUR" || (!required && cur == functional.to_uppercase()) {
                continue;
            }
            let (seen, list) = if required { (&mut seen_need, &mut need) } else { (&mut seen_like, &mut like) };
            if seen.insert((cur.clone(), date.clone())) {
                list.push((cur, date.clone()));
            }
        }
    }
    (need, like)
}
