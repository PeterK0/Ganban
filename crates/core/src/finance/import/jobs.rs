//! Imports as background jobs: `fin_import` starts one and answers at once, and
//! `fin_import_status` reports its progress and, when it's done, its result. A large
//! export takes longer than a client waits for an HTTP answer, so the job, not the
//! request, owns the import.
//!
//! One import per user at a time. Jobs live in this process's memory: each user's
//! latest job is kept until their next one starts, so a refreshed page finds the
//! import it started. After a restart the job is gone; its batch stays `running`, and
//! running the same file again finishes it (see [`pipeline::import_file_with`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use super::pipeline::{self, AccountChoice, ImportOptions, ImportResult, Progress, Stage};
use crate::error::{AppError, Result};
use crate::finance::{now, Entity};
use crate::Db;

/// An import job as `fin_import` and `fin_import_status` report it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportJob {
    pub job_id: u64,
    /// `running`, `done` or `failed`.
    pub state: &'static str,
    pub stage: Stage,
    /// Rows done of the total, in the current stage.
    pub done: usize,
    pub total: usize,
    pub file_name: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// When done: what `fin_import` used to answer.
    pub result: Option<ImportResult>,
    /// When failed: why, in words for the user.
    pub error: Option<String>,
}

/// What to import.
#[derive(Debug, Clone)]
pub struct ImportRequest {
    pub file_name: String,
    pub bytes: Vec<u8>,
    pub profile_key: String,
    pub account_map: HashMap<String, AccountChoice>,
    /// Post the lines older than this many days straight away (after pairing and rules).
    pub post_older_than_days: Option<u32>,
}

/// A user on a database: the key of their latest job. The database file is in the
/// key so tests on separate databases don't share users.
type Key = (String, i64);

fn jobs() -> &'static Mutex<HashMap<Key, ImportJob>> {
    static JOBS: OnceLock<Mutex<HashMap<Key, ImportJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(db: &Db, ent: &Entity) -> Key {
    (db.connect_options().get_filename().to_string_lossy().into_owned(), ent.id)
}

fn update(key: &Key, job_id: u64, f: impl FnOnce(&mut ImportJob)) {
    let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = jobs.get_mut(key).filter(|j| j.job_id == job_id) {
        f(job);
    }
}

/// Starts an import in the background and returns its job, running. Refused while the
/// user has one running.
pub fn start(db: &Db, ent: &Entity, req: ImportRequest) -> Result<ImportJob> {
    start_with(db, ent, req, ImportOptions::default())
}

pub fn start_with(db: &Db, ent: &Entity, req: ImportRequest, mut opts: ImportOptions) -> Result<ImportJob> {
    if let Some(days) = req.post_older_than_days {
        let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(days.into());
        opts.post_before = Some(cutoff.format("%Y-%m-%d").to_string());
    }
    // Ids that a restart won't hand out again.
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let next = NEXT.get_or_init(|| AtomicU64::new(chrono::Utc::now().timestamp_millis().max(1) as u64));
    let k = key(db, ent);
    let job = {
        let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
        if jobs.get(&k).is_some_and(|j| j.state == "running") {
            return Err(AppError::InvalidInput("an import is already running: wait for it to finish".into()));
        }
        let job = ImportJob {
            job_id: next.fetch_add(1, Ordering::Relaxed),
            state: "running",
            stage: Stage::Reading,
            done: 0,
            total: 0,
            file_name: req.file_name.trim().chars().take(200).collect(),
            started_at: now(),
            finished_at: None,
            result: None,
            error: None,
        };
        jobs.insert(k.clone(), job.clone());
        job
    };
    let (db, ent, id) = (db.clone(), ent.clone(), job.job_id);
    let work_key = k.clone();
    let work = tokio::spawn(async move {
        let progress = move |p: Progress| {
            update(&work_key, id, |j| {
                j.stage = p.stage;
                j.done = p.done;
                j.total = p.total;
            })
        };
        let progress: Arc<dyn Fn(Progress) + Send + Sync> = Arc::new(progress);
        pipeline::import_file_with(&db, &ent, &req.file_name, &req.bytes, &req.profile_key, req.account_map, &opts, &*progress).await
    });
    // A second task records the outcome, so even a panic in the import ends the job.
    tokio::spawn(async move {
        let outcome = work.await;
        update(&k, id, |j| {
            j.finished_at = Some(now());
            match outcome {
                Ok(Ok(result)) => {
                    j.state = "done";
                    j.stage = Stage::Done;
                    j.result = Some(result);
                }
                Ok(Err(e)) => {
                    if !matches!(e, AppError::InvalidInput(_) | AppError::NotFound(_)) {
                        // A database error carries no finance data.
                        eprintln!("finance import failed: {e}");
                    }
                    j.state = "failed";
                    j.error = Some(user_error(&e));
                }
                Err(_) => {
                    j.state = "failed";
                    j.error = Some("the import stopped unexpectedly: run it again to finish it".into());
                }
            }
        });
    });
    Ok(job)
}

/// The words a failed job shows: validation messages as they are, anything else (a
/// database error) as a hint to run the import again, which finishes what it began.
fn user_error(e: &AppError) -> String {
    match e {
        AppError::InvalidInput(m) | AppError::NotFound(m) | AppError::Forbidden(m) => m.clone(),
        _ => "the import stopped before it finished: run it again to finish it".into(),
    }
}

/// The user's job: the one with this id, else (no id) their latest, running or not.
/// Another user's job id is not found.
pub fn status(db: &Db, ent: &Entity, job_id: Option<u64>) -> Result<Option<ImportJob>> {
    let jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
    let job = jobs.get(&key(db, ent)).cloned();
    match job_id {
        None => Ok(job),
        Some(id) => match job.filter(|j| j.job_id == id) {
            Some(j) => Ok(Some(j)),
            None => Err(AppError::NotFound("import job".into())),
        },
    }
}
