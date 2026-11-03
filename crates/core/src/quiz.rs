//! Quiz domain — the QuizForge adoption (2026-07-13), same playbook as the
//! Model Assembly Assistant → Models tab: port the DOMAIN into Ganban core,
//! rebuild the UI as a project tab, and let the existing sync/scoping/tab
//! machinery do the rest.
//!
//! Shape: Subject → Topic → question bank + quizzes; attempts store graded
//! answers. QuizForge's ten tables collapse to five by carrying the
//! type-specific structure (options / blanks / matches / items…) as
//! `data_json` in the SAME shapes QuizForge's TypeScript used — an export
//! from the standalone app is import-compatible by construction.
//!
//! Grading happens in the runner (client) for v1 — single-user trust; the
//! attempt stores the graded result. The Oracle `quiz.generate` node writes
//! through the gate (proposals), never directly.

use crate::db::Db;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

pub const QUESTION_TYPES: &[&str] = &[
    "SINGLE_CHOICE",
    "MULTIPLE_CHOICE",
    "FILL_BLANK",
    "FILL_BLANK_MULTIPLE",
    "NUMERIC_INPUT",
    "MATCHING",
    "ORDERING",
    "IMAGE_IDENTIFICATION",
    "CALCULATION",
];

const DIFFICULTIES: &[&str] = &["EASY", "MEDIUM", "HARD"];
const MAX_DATA_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QuizSubject {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QuizTopic {
    pub id: i64,
    pub subject_id: i64,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QuizQuestion {
    pub id: i64,
    pub topic_id: i64,
    pub question_type: String,
    pub question_text: String,
    #[serde(default)]
    pub explanation: Option<String>,
    pub difficulty: String,
    pub points: i64,
    #[serde(default)]
    pub source: Option<String>,
    /// Type-specific structure (options/blanks/matches/items…) in QuizForge's
    /// TS shapes, verbatim.
    pub data_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Quiz {
    pub id: i64,
    /// Topic-scoped quiz (exams leave this null and set subject_id).
    #[serde(default)]
    pub topic_id: Option<i64>,
    /// Subject-scoped (draws from every topic under the subject).
    #[serde(default)]
    #[sqlx(default)]
    pub subject_id: Option<i64>,
    /// Multi-topic scope: JSON array of topic ids (1+). Takes precedence over
    /// topic_id when present.
    #[serde(default)]
    #[sqlx(default)]
    pub topic_ids_json: Option<String>,
    /// 'quiz' | 'exam' — presets and runner behavior, independent of scope.
    #[serde(default = "default_quiz_kind")]
    #[sqlx(default)]
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub question_count: i64,
    #[serde(default)]
    pub time_limit_minutes: Option<i64>,
    pub shuffle_questions: bool,
    pub shuffle_options: bool,
    /// 'EACH_QUESTION' | 'END_OF_QUIZ' | 'NEVER'
    pub show_answers_after: String,
    pub passing_score_percent: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_quiz_kind() -> String {
    "quiz".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QuizAttempt {
    pub id: i64,
    pub quiz_id: i64,
    #[serde(default)]
    pub user_id: Option<i64>,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub score: f64,
    pub max_score: f64,
    pub percentage: f64,
    #[serde(default)]
    pub time_taken_seconds: Option<i64>,
    /// `{question_id: {response, is_correct, points_earned}}` — the runner's
    /// graded answers, for the review screen.
    pub answers_json: String,
}

pub async fn ensure_schema(db: &Db) {
    for sql in [
        "CREATE TABLE IF NOT EXISTS quiz_subjects (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            color TEXT, \
            icon TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
        "CREATE TABLE IF NOT EXISTS quiz_topics (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            subject_id INTEGER NOT NULL REFERENCES quiz_subjects(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            description TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
        "CREATE TABLE IF NOT EXISTS quiz_questions (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            topic_id INTEGER NOT NULL REFERENCES quiz_topics(id) ON DELETE CASCADE, \
            question_type TEXT NOT NULL, \
            question_text TEXT NOT NULL, \
            explanation TEXT, \
            difficulty TEXT NOT NULL DEFAULT 'MEDIUM', \
            points INTEGER NOT NULL DEFAULT 1, \
            source TEXT, \
            data_json TEXT NOT NULL DEFAULT '{}', \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
        // topic_id nullable: an EXAM is a quiz scoped to a whole SUBJECT
        // (subject_id set, topic_id null); a quiz is topic-scoped (reverse).
        "CREATE TABLE IF NOT EXISTS quizzes (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            topic_id INTEGER REFERENCES quiz_topics(id) ON DELETE CASCADE, \
            subject_id INTEGER REFERENCES quiz_subjects(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            description TEXT, \
            question_count INTEGER NOT NULL DEFAULT 10, \
            time_limit_minutes INTEGER, \
            shuffle_questions INTEGER NOT NULL DEFAULT 1, \
            shuffle_options INTEGER NOT NULL DEFAULT 1, \
            show_answers_after TEXT NOT NULL DEFAULT 'END_OF_QUIZ', \
            passing_score_percent INTEGER NOT NULL DEFAULT 60, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
        "CREATE TABLE IF NOT EXISTS quiz_attempts (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, \
            user_id INTEGER, \
            started_at TEXT NOT NULL DEFAULT (datetime('now')), \
            completed_at TEXT, \
            score REAL NOT NULL DEFAULT 0, \
            max_score REAL NOT NULL DEFAULT 0, \
            percentage REAL NOT NULL DEFAULT 0, \
            time_taken_seconds INTEGER, \
            answers_json TEXT NOT NULL DEFAULT '{}')",
        "CREATE INDEX IF NOT EXISTS idx_quizzes_subject ON quizzes(subject_id)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_subjects_project ON quiz_subjects(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_topics_subject ON quiz_topics(subject_id)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_questions_topic ON quiz_questions(topic_id)",
        "CREATE INDEX IF NOT EXISTS idx_quizzes_topic ON quizzes(topic_id)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id)",
        // Leaderboard opt-in (2026-07-13): appearing on a project's quiz
        // leaderboard is a CHOICE, never a default.
        "CREATE TABLE IF NOT EXISTS quiz_leaderboard_optin (\
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            user_id INTEGER NOT NULL, \
            PRIMARY KEY (project_id, user_id))",
    ] {
        let _ = sqlx::query(sql).execute(db).await;
    }
    // Multi-topic scope + explicit kind (2026-07-13 evening): a quiz/exam may
    // span 1+ CHOSEN topics (topic_ids_json), and examness becomes a column
    // instead of being inferred from subject-scoping.
    let _ = sqlx::query("ALTER TABLE quizzes ADD COLUMN topic_ids_json TEXT").execute(db).await;
    let _ = sqlx::query("ALTER TABLE quizzes ADD COLUMN kind TEXT NOT NULL DEFAULT 'quiz'").execute(db).await;
    let _ = sqlx::query("UPDATE quizzes SET kind = 'exam' WHERE subject_id IS NOT NULL AND kind = 'quiz'")
        .execute(db)
        .await;

    // Migration (2026-07-13, one day after the table shipped): the original
    // quizzes table had topic_id NOT NULL and no subject_id — rebuild it so
    // exams (subject-scoped) fit. SQLite can't drop NOT NULL in place.
    let old_shape: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='quizzes'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    if old_shape.is_some_and(|sql| sql.contains("topic_id INTEGER NOT NULL")) {
        // ONE connection for the whole rebuild: multi-statement DDL across a
        // POOL interleaves schema views between connections (a DROP commits on
        // conn A while conn B's ALTER still sees the old table) — the CLI
        // never hits this because it is one connection.
        let Ok(mut conn) = db.acquire().await else { return };
        for sql in [
            "ALTER TABLE quizzes RENAME TO quizzes_old",
            "CREATE TABLE quizzes (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                topic_id INTEGER REFERENCES quiz_topics(id) ON DELETE CASCADE, \
                subject_id INTEGER REFERENCES quiz_subjects(id) ON DELETE CASCADE, \
                name TEXT NOT NULL, \
                description TEXT, \
                question_count INTEGER NOT NULL DEFAULT 10, \
                time_limit_minutes INTEGER, \
                shuffle_questions INTEGER NOT NULL DEFAULT 1, \
                shuffle_options INTEGER NOT NULL DEFAULT 1, \
                show_answers_after TEXT NOT NULL DEFAULT 'END_OF_QUIZ', \
                passing_score_percent INTEGER NOT NULL DEFAULT 60, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')), \
                updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
            "INSERT INTO quizzes (id, topic_id, name, description, question_count, time_limit_minutes, shuffle_questions, shuffle_options, show_answers_after, passing_score_percent, created_at, updated_at) \
             SELECT id, topic_id, name, description, question_count, time_limit_minutes, shuffle_questions, shuffle_options, show_answers_after, passing_score_percent, created_at, updated_at FROM quizzes_old",
            "DROP TABLE quizzes_old",
            "CREATE INDEX IF NOT EXISTS idx_quizzes_topic ON quizzes(topic_id)",
            "CREATE INDEX IF NOT EXISTS idx_quizzes_subject ON quizzes(subject_id)",
        ] {
            let _ = sqlx::query(sql).execute(&mut *conn).await;
        }
    }

    // REPAIR (field 2026-07-13): the rebuild's RENAME rewrote quiz_attempts'
    // foreign key to follow it (SQLite >= 3.25 updates referencing FKs on
    // ALTER TABLE RENAME), so after the drop the FK pointed at the nonexistent
    // quizzes_old and EVERY attempt insert failed with "no such table".
    // Rebuild quiz_attempts against the live quizzes table, preserving rows.
    // Runs right after the rebuild above, so one boot ends in a correct state.
    let attempts_sql: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='quiz_attempts'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    if attempts_sql.is_some_and(|sql| sql.contains("quizzes_old")) {
        let Ok(mut conn) = db.acquire().await else { return };
        for sql in [
            "CREATE TABLE quiz_attempts_repair (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, \
                user_id INTEGER, \
                started_at TEXT NOT NULL DEFAULT (datetime('now')), \
                completed_at TEXT, \
                score REAL NOT NULL DEFAULT 0, \
                max_score REAL NOT NULL DEFAULT 0, \
                percentage REAL NOT NULL DEFAULT 0, \
                time_taken_seconds INTEGER, \
                answers_json TEXT NOT NULL DEFAULT '{}')",
            // Only rows whose quiz still exists — an orphan would trip the FK.
            "INSERT INTO quiz_attempts_repair (id, quiz_id, user_id, started_at, completed_at, score, max_score, percentage, time_taken_seconds, answers_json) \
             SELECT id, quiz_id, user_id, started_at, completed_at, score, max_score, percentage, time_taken_seconds, answers_json \
             FROM quiz_attempts WHERE quiz_id IN (SELECT id FROM quizzes)",
            "DROP TABLE quiz_attempts",
            "ALTER TABLE quiz_attempts_repair RENAME TO quiz_attempts",
            "CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id)",
        ] {
            let _ = sqlx::query(sql).execute(&mut *conn).await;
        }
    }
}

// ── validation (rejects, never coerces) ─────────────────────────────────────

fn clean_name(raw: &str, what: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 200 {
        return Err(AppError::InvalidInput(format!("{what} name must be 1–200 characters")));
    }
    Ok(s.to_string())
}

pub fn validate_question(question_type: &str, difficulty: &str, points: i64, data_json: &str) -> Result<()> {
    if !QUESTION_TYPES.contains(&question_type) {
        return Err(AppError::InvalidInput(format!("unknown question type '{question_type}'")));
    }
    if !DIFFICULTIES.contains(&difficulty) {
        return Err(AppError::InvalidInput(format!("difficulty must be EASY | MEDIUM | HARD, not '{difficulty}'")));
    }
    if !(1..=100).contains(&points) {
        return Err(AppError::InvalidInput("points must be 1–100".into()));
    }
    if data_json.len() > MAX_DATA_BYTES {
        return Err(AppError::InvalidInput("question data too large (64 KB cap)".into()));
    }
    let data: serde_json::Value =
        serde_json::from_str(data_json).map_err(|e| AppError::InvalidInput(format!("question data is not valid JSON: {e}")))?;
    // Per-type structural minimums — enough to keep the runner honest.
    match question_type {
        "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "IMAGE_IDENTIFICATION" => {
            let opts = data["options"].as_array().ok_or_else(|| AppError::InvalidInput("choice questions need an options array".into()))?;
            if opts.len() < 2 {
                return Err(AppError::InvalidInput("choice questions need at least 2 options".into()));
            }
            let correct = opts.iter().filter(|o| o["isCorrect"].as_bool().unwrap_or(false)).count();
            if correct == 0 {
                return Err(AppError::InvalidInput("at least one option must be correct".into()));
            }
            if question_type == "SINGLE_CHOICE" && correct != 1 {
                return Err(AppError::InvalidInput("single-choice questions need exactly one correct option".into()));
            }
        }
        "FILL_BLANK" | "FILL_BLANK_MULTIPLE" => {
            if data["blanks"].as_array().map(Vec::len).unwrap_or(0) == 0 {
                return Err(AppError::InvalidInput("fill-blank questions need a blanks array".into()));
            }
        }
        "NUMERIC_INPUT" => {
            if !data["correctAnswer"].is_number() {
                return Err(AppError::InvalidInput("numeric questions need a numeric correctAnswer".into()));
            }
        }
        "MATCHING" => {
            if data["matches"].as_array().map(Vec::len).unwrap_or(0) < 2 {
                return Err(AppError::InvalidInput("matching questions need at least 2 pairs".into()));
            }
        }
        "ORDERING" => {
            if data["items"].as_array().map(Vec::len).unwrap_or(0) < 2 {
                return Err(AppError::InvalidInput("ordering questions need at least 2 items".into()));
            }
        }
        "CALCULATION" => {
            if data["answers"].as_array().map(Vec::len).unwrap_or(0) == 0 {
                return Err(AppError::InvalidInput("calculation questions need an answers array".into()));
            }
        }
        _ => unreachable!("type checked above"),
    }
    Ok(())
}

// ── ownership walks (project scoping) ───────────────────────────────────────

pub async fn subject_project(db: &Db, subject_id: i64) -> Result<i64> {
    sqlx::query_scalar("SELECT project_id FROM quiz_subjects WHERE id = ?")
        .bind(subject_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("quiz subject".into()))
}

pub async fn topic_project(db: &Db, topic_id: i64) -> Result<i64> {
    sqlx::query_scalar(
        "SELECT s.project_id FROM quiz_topics t JOIN quiz_subjects s ON s.id = t.subject_id WHERE t.id = ?",
    )
    .bind(topic_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("quiz topic".into()))
}

pub async fn question_project(db: &Db, question_id: i64) -> Result<i64> {
    sqlx::query_scalar(
        "SELECT s.project_id FROM quiz_questions q \
         JOIN quiz_topics t ON t.id = q.topic_id JOIN quiz_subjects s ON s.id = t.subject_id WHERE q.id = ?",
    )
    .bind(question_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("quiz question".into()))
}

pub async fn quiz_project(db: &Db, quiz_id: i64) -> Result<i64> {
    let row: Option<(Option<i64>, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT topic_id, subject_id, topic_ids_json FROM quizzes WHERE id = ?")
            .bind(quiz_id)
            .fetch_optional(db)
            .await?;
    let (topic_id, subject_id, ids_json) = row.ok_or_else(|| AppError::NotFound("quiz".into()))?;
    if let Some(sj) = subject_id {
        return subject_project(db, sj).await;
    }
    if let Some(t) = topic_id {
        return topic_project(db, t).await;
    }
    let first: Option<i64> = ids_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<i64>>(s).ok())
        .and_then(|v| v.first().copied());
    match first {
        Some(t) => topic_project(db, t).await,
        None => Err(AppError::NotFound("quiz has no scope".into())),
    }
}

/// Every quiz AND exam whose scope touches this subject (legacy single-topic,
/// multi-topic and subject-wide rows alike) — the tab's one list.
pub async fn get_subject_quizzes(db: &Db, subject_id: i64) -> Result<Vec<Quiz>> {
    Ok(sqlx::query_as(
        "SELECT DISTINCT z.* FROM quizzes z \
         LEFT JOIN quiz_topics t ON t.id = z.topic_id \
         WHERE z.subject_id = ?1 OR t.subject_id = ?1 \
            OR EXISTS (SELECT 1 FROM json_each(z.topic_ids_json) je JOIN quiz_topics tt ON tt.id = je.value WHERE tt.subject_id = ?1) \
         ORDER BY z.id",
    )
    .bind(subject_id)
    .fetch_all(db)
    .await?)
}

/// Subject-scoped exams.
pub async fn get_exams(db: &Db, subject_id: i64) -> Result<Vec<Quiz>> {
    Ok(sqlx::query_as("SELECT * FROM quizzes WHERE subject_id = ? ORDER BY id")
        .bind(subject_id)
        .fetch_all(db)
        .await?)
}

/// Every question under a subject (the exam runner's pool).
pub async fn get_subject_questions(db: &Db, subject_id: i64) -> Result<Vec<QuizQuestion>> {
    Ok(sqlx::query_as(
        "SELECT q.* FROM quiz_questions q JOIN quiz_topics t ON t.id = q.topic_id WHERE t.subject_id = ? ORDER BY q.id",
    )
    .bind(subject_id)
    .fetch_all(db)
    .await?)
}

/// Normalized fingerprint for duplicate detection: lowercase, whitespace
/// collapsed. Two extractions of the same question drift in spacing and
/// case, not in words — matching on words is the honest middle ground.
pub fn question_fingerprint(text: &str) -> String {
    text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Fingerprints of every question under a subject — what run-time and
/// apply-time dedup check candidates against.
pub async fn subject_fingerprints(db: &Db, subject_id: i64) -> Result<std::collections::HashSet<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT q.question_text FROM quiz_questions q JOIN quiz_topics t ON t.id = q.topic_id WHERE t.subject_id = ?",
    )
    .bind(subject_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(t,)| question_fingerprint(&t)).collect())
}

/// Move questions into a topic (bulk). Every question must live in the same
/// PROJECT as the target — a stray id is an error, not a skip.
pub async fn move_questions(db: &Db, ids: &[i64], topic_id: i64) -> Result<u64> {
    let target_project = topic_project(db, topic_id).await?;
    let mut moved = 0;
    for &id in ids {
        if question_project(db, id).await? != target_project {
            return Err(AppError::InvalidInput(format!("question {id} is not in the target's project")));
        }
        sqlx::query("UPDATE quiz_questions SET topic_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(topic_id)
            .bind(id)
            .execute(db)
            .await?;
        moved += 1;
    }
    Ok(moved)
}

/// Merge topic `from` into `into`: questions and quizzes re-point, `from` is
/// deleted. Both topics must share a project (the cleanup tool for extract
/// runs that minted near-duplicate topics: "L01" vs "Lecture 01").
pub async fn merge_topics(db: &Db, from: i64, into: i64) -> Result<u64> {
    if from == into {
        return Err(AppError::InvalidInput("cannot merge a topic into itself".into()));
    }
    if topic_project(db, from).await? != topic_project(db, into).await? {
        return Err(AppError::InvalidInput("topics live in different projects".into()));
    }
    let r = sqlx::query("UPDATE quiz_questions SET topic_id = ?, updated_at = datetime('now') WHERE topic_id = ?")
        .bind(into)
        .bind(from)
        .execute(db)
        .await?;
    sqlx::query("UPDATE quizzes SET topic_id = ? WHERE topic_id = ?")
        .bind(into)
        .bind(from)
        .execute(db)
        .await?;
    delete_topic(db, from).await?;
    Ok(r.rows_affected())
}

/// Find a topic by (case-insensitive) name under a subject, or create it —
/// the multi-topic batch import's workhorse.
pub async fn find_or_create_topic(db: &Db, subject_id: i64, name: &str) -> Result<i64> {
    let name = clean_name(name, "topic")?;
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT id FROM quiz_topics WHERE subject_id = ? AND name = ? COLLATE NOCASE")
            .bind(subject_id)
            .bind(&name)
            .fetch_optional(db)
            .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    Ok(create_topic(db, subject_id, &name, None).await?.id)
}

// ── subjects ────────────────────────────────────────────────────────────────

pub async fn get_subjects(db: &Db, project_id: i64) -> Result<Vec<QuizSubject>> {
    Ok(sqlx::query_as("SELECT * FROM quiz_subjects WHERE project_id = ? ORDER BY sort_order, id")
        .bind(project_id)
        .fetch_all(db)
        .await?)
}

pub async fn create_subject(db: &Db, project_id: i64, name: &str, color: Option<&str>, icon: Option<&str>) -> Result<QuizSubject> {
    let name = clean_name(name, "subject")?;
    let r = sqlx::query("INSERT INTO quiz_subjects (project_id, name, color, icon) VALUES (?, ?, ?, ?)")
        .bind(project_id)
        .bind(&name)
        .bind(color)
        .bind(icon)
        .execute(db)
        .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_subjects WHERE id = ?").bind(r.last_insert_rowid()).fetch_one(db).await?)
}

pub async fn update_subject(db: &Db, id: i64, name: Option<&str>, color: Option<&str>, icon: Option<&str>) -> Result<QuizSubject> {
    let cur: QuizSubject = sqlx::query_as("SELECT * FROM quiz_subjects WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("quiz subject".into()))?;
    let name = match name {
        Some(n) => clean_name(n, "subject")?,
        None => cur.name,
    };
    sqlx::query("UPDATE quiz_subjects SET name=?, color=?, icon=?, updated_at=datetime('now') WHERE id=?")
        .bind(&name)
        .bind(color.map(str::to_string).or(cur.color))
        .bind(icon.map(str::to_string).or(cur.icon))
        .bind(id)
        .execute(db)
        .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_subjects WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn delete_subject(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM quiz_subjects WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ── topics ──────────────────────────────────────────────────────────────────

pub async fn get_topics(db: &Db, subject_id: i64) -> Result<Vec<QuizTopic>> {
    Ok(sqlx::query_as("SELECT * FROM quiz_topics WHERE subject_id = ? ORDER BY sort_order, id")
        .bind(subject_id)
        .fetch_all(db)
        .await?)
}

/// Every topic of a project with its subject label — the flat list pickers
/// want (the Oracle node, the generate dialog).
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TopicWithSubject {
    pub id: i64,
    pub subject_id: i64,
    pub name: String,
    pub subject_name: String,
}

pub async fn get_all_topics(db: &Db, project_id: i64) -> Result<Vec<TopicWithSubject>> {
    Ok(sqlx::query_as(
        "SELECT t.id, t.subject_id, t.name, s.name AS subject_name \
         FROM quiz_topics t JOIN quiz_subjects s ON s.id = t.subject_id \
         WHERE s.project_id = ? ORDER BY s.sort_order, s.id, t.sort_order, t.id",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?)
}

pub async fn create_topic(db: &Db, subject_id: i64, name: &str, description: Option<&str>) -> Result<QuizTopic> {
    let name = clean_name(name, "topic")?;
    subject_project(db, subject_id).await?; // must exist
    let r = sqlx::query("INSERT INTO quiz_topics (subject_id, name, description) VALUES (?, ?, ?)")
        .bind(subject_id)
        .bind(&name)
        .bind(description)
        .execute(db)
        .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_topics WHERE id = ?").bind(r.last_insert_rowid()).fetch_one(db).await?)
}

pub async fn update_topic(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> Result<QuizTopic> {
    let cur: QuizTopic = sqlx::query_as("SELECT * FROM quiz_topics WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("quiz topic".into()))?;
    let name = match name {
        Some(n) => clean_name(n, "topic")?,
        None => cur.name,
    };
    sqlx::query("UPDATE quiz_topics SET name=?, description=?, updated_at=datetime('now') WHERE id=?")
        .bind(&name)
        .bind(description.map(str::to_string).or(cur.description))
        .bind(id)
        .execute(db)
        .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_topics WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn delete_topic(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM quiz_topics WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ── questions ───────────────────────────────────────────────────────────────

pub async fn get_questions(db: &Db, topic_id: i64) -> Result<Vec<QuizQuestion>> {
    Ok(sqlx::query_as("SELECT * FROM quiz_questions WHERE topic_id = ? ORDER BY id")
        .bind(topic_id)
        .fetch_all(db)
        .await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_question(
    db: &Db,
    topic_id: i64,
    question_type: &str,
    question_text: &str,
    explanation: Option<&str>,
    difficulty: &str,
    points: i64,
    source: Option<&str>,
    data_json: &str,
) -> Result<QuizQuestion> {
    let text = question_text.trim();
    if text.is_empty() || text.len() > 4000 {
        return Err(AppError::InvalidInput("question text must be 1–4000 characters".into()));
    }
    validate_question(question_type, difficulty, points, data_json)?;
    topic_project(db, topic_id).await?; // must exist
    let r = sqlx::query(
        "INSERT INTO quiz_questions (topic_id, question_type, question_text, explanation, difficulty, points, source, data_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(topic_id)
    .bind(question_type)
    .bind(text)
    .bind(explanation)
    .bind(difficulty)
    .bind(points)
    .bind(source)
    .bind(data_json)
    .execute(db)
    .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_questions WHERE id = ?").bind(r.last_insert_rowid()).fetch_one(db).await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn update_question(
    db: &Db,
    id: i64,
    question_text: Option<&str>,
    explanation: Option<&str>,
    difficulty: Option<&str>,
    points: Option<i64>,
    source: Option<&str>,
    data_json: Option<&str>,
) -> Result<QuizQuestion> {
    let cur: QuizQuestion = sqlx::query_as("SELECT * FROM quiz_questions WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("quiz question".into()))?;
    let text = question_text.map(str::trim).map(str::to_string).unwrap_or(cur.question_text);
    if text.is_empty() || text.len() > 4000 {
        return Err(AppError::InvalidInput("question text must be 1–4000 characters".into()));
    }
    let difficulty = difficulty.map(str::to_string).unwrap_or(cur.difficulty);
    let points = points.unwrap_or(cur.points);
    let data = data_json.map(str::to_string).unwrap_or(cur.data_json);
    validate_question(&cur.question_type, &difficulty, points, &data)?;
    sqlx::query(
        "UPDATE quiz_questions SET question_text=?, explanation=?, difficulty=?, points=?, source=?, data_json=?, updated_at=datetime('now') WHERE id=?",
    )
    .bind(&text)
    .bind(explanation.map(str::to_string).or(cur.explanation))
    .bind(&difficulty)
    .bind(points)
    .bind(source.map(str::to_string).or(cur.source))
    .bind(&data)
    .bind(id)
    .execute(db)
    .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_questions WHERE id = ?").bind(id).fetch_one(db).await?)
}

pub async fn delete_question(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM quiz_questions WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ── quizzes ─────────────────────────────────────────────────────────────────

pub async fn get_quizzes(db: &Db, topic_id: i64) -> Result<Vec<Quiz>> {
    Ok(sqlx::query_as("SELECT * FROM quizzes WHERE topic_id = ? ORDER BY id")
        .bind(topic_id)
        .fetch_all(db)
        .await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_quiz(
    db: &Db,
    kind: &str,
    topic_ids: Option<&[i64]>,
    subject_id: Option<i64>,
    name: &str,
    description: Option<&str>,
    question_count: i64,
    time_limit_minutes: Option<i64>,
    shuffle_questions: bool,
    shuffle_options: bool,
    show_answers_after: &str,
    passing_score_percent: i64,
) -> Result<Quiz> {
    let name = clean_name(name, "quiz")?;
    if !(1..=200).contains(&question_count) {
        return Err(AppError::InvalidInput("question count must be 1–200".into()));
    }
    if !["EACH_QUESTION", "END_OF_QUIZ", "NEVER"].contains(&show_answers_after) {
        return Err(AppError::InvalidInput("show_answers_after must be EACH_QUESTION | END_OF_QUIZ | NEVER".into()));
    }
    if !(0..=100).contains(&passing_score_percent) {
        return Err(AppError::InvalidInput("passing score must be 0–100".into()));
    }
    if !["quiz", "exam"].contains(&kind) {
        return Err(AppError::InvalidInput(format!("kind must be quiz | exam, not '{kind}'")));
    }
    let topic_ids_json: Option<String> = match (topic_ids.filter(|t| !t.is_empty()), subject_id) {
        (Some(ids), None) => {
            // Every chosen topic must exist and share ONE subject.
            let mut subject: Option<i64> = None;
            for &t in ids {
                let sid: Option<i64> = sqlx::query_scalar("SELECT subject_id FROM quiz_topics WHERE id = ?")
                    .bind(t)
                    .fetch_optional(db)
                    .await?;
                let sid = sid.ok_or_else(|| AppError::NotFound(format!("topic #{t}")))?;
                if *subject.get_or_insert(sid) != sid {
                    return Err(AppError::InvalidInput("all chosen topics must belong to one subject".into()));
                }
            }
            Some(serde_json::to_string(ids).expect("i64 slice serializes"))
        }
        (None, Some(sj)) => {
            subject_project(db, sj).await?;
            None
        }
        _ => return Err(AppError::InvalidInput("scope is 1+ topics OR a whole subject — exactly one".into())),
    };
    let r = sqlx::query(
        "INSERT INTO quizzes (kind, topic_ids_json, subject_id, name, description, question_count, time_limit_minutes, shuffle_questions, shuffle_options, show_answers_after, passing_score_percent) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(kind)
    .bind(&topic_ids_json)
    .bind(subject_id)
    .bind(&name)
    .bind(description)
    .bind(question_count)
    .bind(time_limit_minutes)
    .bind(shuffle_questions)
    .bind(shuffle_options)
    .bind(show_answers_after)
    .bind(passing_score_percent)
    .execute(db)
    .await?;
    Ok(sqlx::query_as("SELECT * FROM quizzes WHERE id = ?").bind(r.last_insert_rowid()).fetch_one(db).await?)
}

pub async fn delete_quiz(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM quizzes WHERE id = ?").bind(id).execute(db).await?;
    Ok(())
}

// ── attempts ────────────────────────────────────────────────────────────────

pub async fn get_attempts(db: &Db, quiz_id: i64) -> Result<Vec<QuizAttempt>> {
    Ok(sqlx::query_as("SELECT * FROM quiz_attempts WHERE quiz_id = ? ORDER BY id DESC")
        .bind(quiz_id)
        .fetch_all(db)
        .await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn record_attempt(
    db: &Db,
    quiz_id: i64,
    user_id: Option<i64>,
    score: f64,
    max_score: f64,
    time_taken_seconds: Option<i64>,
    answers_json: &str,
) -> Result<QuizAttempt> {
    quiz_project(db, quiz_id).await?;
    if answers_json.len() > 256 * 1024 {
        return Err(AppError::InvalidInput("attempt answers too large".into()));
    }
    serde_json::from_str::<serde_json::Value>(answers_json)
        .map_err(|e| AppError::InvalidInput(format!("attempt answers are not valid JSON: {e}")))?;
    let percentage = if max_score > 0.0 { (score / max_score) * 100.0 } else { 0.0 };
    let r = sqlx::query(
        "INSERT INTO quiz_attempts (quiz_id, user_id, completed_at, score, max_score, percentage, time_taken_seconds, answers_json) \
         VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)",
    )
    .bind(quiz_id)
    .bind(user_id)
    .bind(score)
    .bind(max_score)
    .bind(percentage)
    .bind(time_taken_seconds)
    .bind(answers_json)
    .execute(db)
    .await?;
    Ok(sqlx::query_as("SELECT * FROM quiz_attempts WHERE id = ?").bind(r.last_insert_rowid()).fetch_one(db).await?)
}

// ── leaderboard (opt-in) ────────────────────────────────────────────────────

pub async fn set_leaderboard_optin(db: &Db, project_id: i64, user_id: i64, opt_in: bool) -> Result<()> {
    if opt_in {
        sqlx::query("INSERT OR IGNORE INTO quiz_leaderboard_optin (project_id, user_id) VALUES (?, ?)")
            .bind(project_id)
            .bind(user_id)
            .execute(db)
            .await?;
    } else {
        sqlx::query("DELETE FROM quiz_leaderboard_optin WHERE project_id = ? AND user_id = ?")
            .bind(project_id)
            .bind(user_id)
            .execute(db)
            .await?;
    }
    Ok(())
}

pub async fn get_leaderboard_optin(db: &Db, project_id: i64, user_id: i64) -> Result<bool> {
    let row: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM quiz_leaderboard_optin WHERE project_id = ? AND user_id = ?")
            .bind(project_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// One leaderboard row — opted-in members only, ranked by best percentage.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct LeaderboardRow {
    pub user_id: i64,
    pub full_name: String,
    pub attempts: i64,
    pub best_pct: f64,
    pub avg_pct: f64,
}

/// The subject's leaderboard: attempts on every quiz/exam under it, for users
/// who opted in on the subject's PROJECT. No opt-in row, no appearance.
pub async fn leaderboard(db: &Db, subject_id: i64) -> Result<Vec<LeaderboardRow>> {
    let project_id = subject_project(db, subject_id).await?;
    Ok(sqlx::query_as(
        "SELECT a.user_id AS user_id, u.full_name AS full_name, COUNT(*) AS attempts, \
                MAX(a.percentage) AS best_pct, AVG(a.percentage) AS avg_pct \
         FROM quiz_attempts a \
         JOIN quizzes z ON z.id = a.quiz_id \
         LEFT JOIN quiz_topics t ON t.id = z.topic_id \
         JOIN users u ON u.id = a.user_id \
         JOIN quiz_leaderboard_optin o ON o.project_id = ?1 AND o.user_id = a.user_id \
         WHERE a.user_id IS NOT NULL AND (z.subject_id = ?2 OR t.subject_id = ?2 \
            OR EXISTS (SELECT 1 FROM json_each(z.topic_ids_json) je JOIN quiz_topics tt ON tt.id = je.value WHERE tt.subject_id = ?2)) \
         GROUP BY a.user_id, u.full_name \
         ORDER BY best_pct DESC, avg_pct DESC",
    )
    .bind(project_id)
    .bind(subject_id)
    .fetch_all(db)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> Db {
        let path = std::env::temp_dir().join(format!("ganban_quiz_{}_{}.db", std::process::id(), rand_tag()));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    fn rand_tag() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64
    }

    /// Field bug (2026-07-13): the quizzes-table rebuild used ALTER TABLE
    /// RENAME, which REWRITES quiz_attempts' foreign key to follow the rename
    /// (SQLite >= 3.25) — the FK then pointed at the dropped quizzes_old and
    /// every attempt insert failed. ensure_schema must repair that state.
    #[tokio::test]
    async fn attempt_fk_survives_the_rebuild_and_repairs_damage() {
        let db = test_db().await;
        let p = crate::ops::create_project(&db, crate::models::CreateProjectInput { name: "R".into(), description: None })
            .await
            .unwrap();
        let s = create_subject(&db, p.id, "S", None, None).await.unwrap();
        let t = create_topic(&db, s.id, "T", None).await.unwrap();
        let z = create_quiz(&db, "quiz", Some(&[t.id]), None, "Q", None, 5, None, true, true, "END_OF_QUIZ", 60).await.unwrap();

        // Inflict the exact damage the buggy migration caused.
        sqlx::query("ALTER TABLE quizzes RENAME TO quizzes_old").execute(&db).await.unwrap();
        let dmg: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name='quiz_attempts'").fetch_one(&db).await.unwrap();
        assert!(dmg.contains("quizzes_old"), "rename rewrote the FK: {dmg}");
        sqlx::query("ALTER TABLE quizzes_old RENAME TO quizzes").execute(&db).await.unwrap();
        // Renaming back ALSO rewrites it back — so recreate the damage the way
        // the field hit it: attempts FK pointing at a table that is gone.
        // PRAGMA foreign_keys is per connection and the pool has five: do the damage on one
        // connection, then drop it from the pool so no later query inherits FKs switched off.
        let mut conn = db.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await.unwrap();
        sqlx::query("ALTER TABLE quiz_attempts RENAME TO qa_tmp").execute(&mut *conn).await.unwrap();
        sqlx::query(
            "CREATE TABLE quiz_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER NOT NULL REFERENCES quizzes_old(id) ON DELETE CASCADE, user_id INTEGER, started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, score REAL NOT NULL DEFAULT 0, max_score REAL NOT NULL DEFAULT 0, percentage REAL NOT NULL DEFAULT 0, time_taken_seconds INTEGER, answers_json TEXT NOT NULL DEFAULT '{}')",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query("DROP TABLE qa_tmp").execute(&mut *conn).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await.unwrap();
        drop(conn.detach());

        // The damaged state refuses inserts (the field symptom).
        assert!(
            record_attempt(&db, z.id, None, 1.0, 1.0, None, "{}").await.is_err(),
            "damaged FK must fail (proves the reproduction)"
        );

        // Boot repair heals it; inserts work; nothing else harmed.
        ensure_schema(&db).await;
        let a = record_attempt(&db, z.id, None, 1.0, 1.0, None, "{}").await.unwrap();
        assert_eq!(a.percentage, 100.0);
        assert_eq!(get_attempts(&db, z.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn full_domain_round_trip() {
        let db = test_db().await;
        let p = crate::ops::create_project(&db, crate::models::CreateProjectInput { name: "Uni".into(), description: None })
            .await
            .unwrap();

        let s = create_subject(&db, p.id, " Shipping Economics ", Some("#A78BFA"), Some("🚢")).await.unwrap();
        assert_eq!(s.name, "Shipping Economics", "names are trimmed");
        let t = create_topic(&db, s.id, "Freight markets", None).await.unwrap();
        assert_eq!(topic_project(&db, t.id).await.unwrap(), p.id, "ownership walks to the project");

        // Validation rejects, never coerces.
        assert!(create_question(&db, t.id, "SINGLE_CHOICE", "Pick one", None, "MEDIUM", 1, None, r#"{"options":[]}"#).await.is_err());
        assert!(create_question(&db, t.id, "SINGLE_CHOICE", "Pick one", None, "SPICY", 1, None, r#"{"options":[{"optionText":"a","isCorrect":true},{"optionText":"b","isCorrect":false}]}"#).await.is_err());
        let q = create_question(
            &db, t.id, "SINGLE_CHOICE", "What drives spot rates?", Some("Supply and demand."), "EASY", 2, Some("lecture 2"),
            r#"{"options":[{"optionText":"Vessel supply vs cargo demand","isCorrect":true},{"optionText":"The phase of the moon","isCorrect":false}]}"#,
        )
        .await
        .unwrap();
        assert_eq!(get_questions(&db, t.id).await.unwrap().len(), 1);

        let z = create_quiz(&db, "quiz", Some(&[t.id]), None, "Weekly check", None, 10, None, true, true, "END_OF_QUIZ", 60).await.unwrap();
        // Exams scope to a subject (or topics); double-scoping is rejected.
        let ex = create_quiz(&db, "exam", None, Some(s.id), "Mock exam", None, 20, None, true, true, "END_OF_QUIZ", 50).await.unwrap();
        assert_eq!(ex.kind, "exam");
        assert_eq!(quiz_project(&db, ex.id).await.unwrap(), p.id);
        assert_eq!(quiz_project(&db, z.id).await.unwrap(), p.id, "multi-topic scope walks to the project");
        assert!(create_quiz(&db, "quiz", Some(&[t.id]), Some(s.id), "Both", None, 5, None, true, true, "NEVER", 60).await.is_err());
        assert!(create_quiz(&db, "party", Some(&[t.id]), None, "Bad kind", None, 5, None, true, true, "NEVER", 60).await.is_err());
        assert_eq!(get_exams(&db, s.id).await.unwrap().len(), 1);
        assert_eq!(get_subject_quizzes(&db, s.id).await.unwrap().len(), 2, "one list finds every scope shape");
        assert_eq!(get_subject_questions(&db, s.id).await.unwrap().len(), 1);
        // find_or_create is idempotent and case-insensitive.
        let t2 = find_or_create_topic(&db, s.id, "Lecture 02").await.unwrap();
        assert_eq!(find_or_create_topic(&db, s.id, "lecture 02").await.unwrap(), t2);

        // Move + merge: the dup-topic cleanup path.
        assert_eq!(move_questions(&db, &[q.id], t2).await.unwrap(), 1);
        assert_eq!(get_questions(&db, t2).await.unwrap().len(), 1);
        let merged = merge_topics(&db, t2, t.id).await.unwrap();
        assert_eq!(merged, 1, "questions re-pointed");
        assert!(topic_project(&db, t2).await.is_err(), "merged-from topic is gone");
        assert_eq!(get_questions(&db, t.id).await.unwrap().len(), 1);
        assert!(merge_topics(&db, t.id, t.id).await.is_err(), "self-merge rejected");

        // Duplicate fingerprints: case + whitespace drift collapse to one.
        assert_eq!(
            question_fingerprint("What  drives\nspot rates?"),
            question_fingerprint("what drives spot rates?")
        );
        let prints = subject_fingerprints(&db, s.id).await.unwrap();
        assert!(prints.contains(&question_fingerprint("What drives spot rates?")));
        let a = record_attempt(&db, z.id, Some(1), 2.0, 2.0, Some(42), &format!(r#"{{"{}":{{"is_correct":true,"points_earned":2}}}}"#, q.id))
            .await
            .unwrap();
        assert_eq!(a.percentage, 100.0);
        assert_eq!(get_attempts(&db, z.id).await.unwrap().len(), 1);

        // Leaderboard: opt-in gates appearance (and the row joins a real user).
        let u = crate::ops::create_user(&db, crate::models::CreateUserInput { username: "peter".into(), full_name: "Peter".into(), email: None })
            .await
            .unwrap();
        // Re-point the attempt at the real user (the literal 1 above may not
        // exist in a fresh test db).
        sqlx::query("UPDATE quiz_attempts SET user_id = ? WHERE id = ?").bind(u.id).bind(a.id).execute(&db).await.unwrap();
        assert!(leaderboard(&db, s.id).await.unwrap().is_empty(), "no opt-in, no rows");
        set_leaderboard_optin(&db, p.id, u.id, true).await.unwrap();
        let lb = leaderboard(&db, s.id).await.unwrap();
        assert_eq!(lb.len(), 1);
        assert_eq!(lb[0].attempts, 1);
        assert_eq!(lb[0].best_pct, 100.0);
        assert_eq!(lb[0].full_name, "Peter");
        set_leaderboard_optin(&db, p.id, u.id, false).await.unwrap();
        assert!(leaderboard(&db, s.id).await.unwrap().is_empty(), "opting out removes the row");
        assert!(!get_leaderboard_optin(&db, p.id, u.id).await.unwrap());

        // Cascade: deleting the subject takes the whole tree with it.
        delete_subject(&db, s.id).await.unwrap();
        assert!(topic_project(&db, t.id).await.is_err());
    }
}
