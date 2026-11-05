//! "Suggest categories for all uncategorised" (`docs/design/FINANCE.md` § The inbox at scale):
//! a background job that asks the host's local model about every payee group of the inbox
//! with uncategorised drafts, a batch of groups per prompt, and stores one suggestion per
//! group. The user accepts them group by group; the host never applies one.
//!
//! The same rules as the per-line suggestions hold (`crate::finance_tools`): a local Ollama
//! model only, and the prompt holds a group's description, payee and amount and the chart's
//! category names, nothing else. One job per user at a time, kept in this process's memory.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use ganban_core::error::AppError;
use ganban_core::finance::{inbox, Entity};
use ganban_core::Db;
use serde::Serialize;

use crate::finance_tools::{ask_batch, local_engine, suggestable_categories, SuggestItem, BATCH};

/// A suggestion job as `fin_suggest_groups` and `fin_suggest_groups_status` report it.
#[derive(Debug, Clone, Serialize)]
pub struct SuggestJob {
    pub job_id: u64,
    /// `running`, `done` or `failed`.
    pub state: &'static str,
    /// Groups asked about, of the total.
    pub done: usize,
    pub total: usize,
    /// Groups the model found a category for.
    pub suggested: usize,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

type Key = (String, i64);

fn jobs() -> &'static Mutex<HashMap<Key, SuggestJob>> {
    static JOBS: OnceLock<Mutex<HashMap<Key, SuggestJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(db: &Db, ent: &Entity) -> Key {
    (db.connect_options().get_filename().to_string_lossy().into_owned(), ent.id)
}

fn update(key: &Key, job_id: u64, f: impl FnOnce(&mut SuggestJob)) {
    let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = jobs.get_mut(key).filter(|j| j.job_id == job_id) {
        f(job);
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Starts the job and returns it, running. Refused while one runs, and when the host has no
/// local model (the button is hidden then).
pub async fn start(db: &Db, ent: &Entity) -> Result<SuggestJob, AppError> {
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let next = NEXT.get_or_init(|| AtomicU64::new(chrono::Utc::now().timestamp_millis().max(1) as u64));
    let k = key(db, ent);
    if jobs().lock().unwrap_or_else(|e| e.into_inner()).get(&k).is_some_and(|j| j.state == "running") {
        return Err(AppError::InvalidInput("suggestions are already running: wait for them to finish".into()));
    }
    let Some((client, params)) = local_engine(db).await else {
        return Err(AppError::InvalidInput("no local model is available for suggestions".into()));
    };
    let job = SuggestJob {
        job_id: next.fetch_add(1, Ordering::Relaxed),
        state: "running",
        done: 0,
        total: 0,
        suggested: 0,
        started_at: now(),
        finished_at: None,
        error: None,
    };
    {
        let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
        if jobs.get(&k).is_some_and(|j| j.state == "running") {
            return Err(AppError::InvalidInput("suggestions are already running: wait for them to finish".into()));
        }
        jobs.insert(k.clone(), job.clone());
    }
    let (db, ent, id) = (db.clone(), ent.clone(), job.job_id);
    let work_key = k.clone();
    let work = tokio::spawn(async move {
        let (expense, income) = suggestable_categories(&db, &ent).await?;
        let groups = inbox::groups_to_suggest(&db, &ent).await?;
        update(&work_key, id, |j| j.total = groups.len());
        let mut done = 0;
        for batch in groups.chunks(BATCH) {
            let items: Vec<SuggestItem> = batch
                .iter()
                .map(|g| SuggestItem { description: g.description.clone(), payee: g.payee.clone(), amount_minor: g.amount_minor, currency: g.currency.clone() })
                .collect();
            let picked = ask_batch(&client, &params, &items, &expense, &income).await?;
            let found = picked.iter().filter(|p| p.is_some()).count();
            let picks: Vec<(String, Option<i64>)> = batch.iter().map(|g| g.key.clone()).zip(picked).collect();
            inbox::save_group_suggestions(&db, &ent, &picks).await?;
            done += batch.len();
            update(&work_key, id, |j| {
                j.done = done;
                j.suggested += found;
            });
        }
        Ok::<(), AppError>(())
    });
    // A second task records the outcome, so even a panic ends the job.
    tokio::spawn(async move {
        let outcome = work.await;
        update(&k, id, |j| {
            j.finished_at = Some(now());
            match outcome {
                Ok(Ok(())) => j.state = "done",
                Ok(Err(e)) => {
                    j.state = "failed";
                    j.error = Some(match e {
                        AppError::InvalidInput(m) | AppError::NotFound(m) => m,
                        _ => "the suggestions stopped: run them again to finish".into(),
                    });
                }
                Err(_) => {
                    j.state = "failed";
                    j.error = Some("the suggestions stopped: run them again to finish".into());
                }
            }
        });
    });
    Ok(job)
}

/// The caller's latest suggestion job, or `None`.
pub fn status(db: &Db, ent: &Entity) -> Option<SuggestJob> {
    jobs().lock().unwrap_or_else(|e| e.into_inner()).get(&key(db, ent)).cloned()
}
