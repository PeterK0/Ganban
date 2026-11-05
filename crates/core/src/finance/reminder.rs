//! Finance settings and the weekly bank-import reminder (FINANCE.md § Wave 2, The weekly
//! import reminder). The host's clock check lives in the server; this module keeps the
//! setting and says who is due.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::{audit, Entity};
use crate::error::{AppError, Result};
use crate::Db;

pub const WEEKDAYS: &[&str] = &["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
pub const REMINDER_TITLE: &str = "Time to import your bank statements";
pub const REMINDER_BODY: &str = "Download this week's statements from your banks and import them in Finance.";

#[derive(Debug, Clone, Serialize)]
pub struct Reminder {
    pub enabled: bool,
    pub weekday: String,
    pub time: String,
}

/// The import option: post lines older than `post_older_days` days straight away.
#[derive(Debug, Clone, Serialize)]
pub struct ImportSettings {
    pub post_older: bool,
    pub post_older_days: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Settings {
    pub reminder: Reminder,
    pub import: ImportSettings,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPatch {
    pub post_older: Option<bool>,
    pub post_older_days: Option<u32>,
}

/// The longest cut-off the import option takes, in days (ten years).
pub const MAX_POST_OLDER_DAYS: u32 = 3_650;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderPatch {
    pub enabled: Option<bool>,
    pub weekday: Option<String>,
    pub time: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub reminder: Option<ReminderPatch>,
    pub import: Option<ImportPatch>,
}

/// One user's reminder, for the host's check.
#[derive(Debug, Clone, FromRow)]
pub struct DueCheck {
    pub entity_id: i64,
    pub user_id: i64,
    pub entity_created_at: String,
    pub weekday: String,
    pub time: String,
    pub last_at: Option<String>,
}

pub async fn get_settings(db: &Db, ent: &Entity) -> Result<Settings> {
    let row: Option<(bool, String, String, bool, i64)> = sqlx::query_as(
        "SELECT reminder_enabled, reminder_weekday, reminder_time, import_post_older, import_post_older_days FROM fin_settings WHERE entity_id = ?",
    )
    .bind(ent.id)
    .fetch_optional(db)
    .await?;
    let (enabled, weekday, time, post_older, days) = row.unwrap_or((true, "Mon".into(), "09:00".into(), false, 30));
    Ok(Settings {
        reminder: Reminder { enabled, weekday, time },
        import: ImportSettings { post_older, post_older_days: days.clamp(1, MAX_POST_OLDER_DAYS as i64) as u32 },
    })
}

fn check_weekday(s: &str) -> Result<String> {
    let s = s.trim();
    WEEKDAYS
        .iter()
        .find(|d| d.eq_ignore_ascii_case(s.get(..3).unwrap_or(s)) && s.len() >= 3)
        .map(|d| d.to_string())
        .ok_or_else(|| AppError::InvalidInput("the weekday is one of Mon, Tue, Wed, Thu, Fri, Sat, Sun".into()))
}

fn check_time(s: &str) -> Result<String> {
    let bad = || AppError::InvalidInput("the time is HH:MM".into());
    let (h, m) = s.trim().split_once(':').ok_or_else(bad)?;
    let (h, m): (u32, u32) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok(format!("{h:02}:{m:02}"))
}

pub async fn update_settings(db: &Db, ent: &Entity, patch: SettingsPatch) -> Result<Settings> {
    let before = get_settings(db, ent).await?;
    let mut next = before.clone();
    if let Some(r) = patch.reminder {
        if let Some(e) = r.enabled {
            next.reminder.enabled = e;
        }
        if let Some(w) = r.weekday {
            next.reminder.weekday = check_weekday(&w)?;
        }
        if let Some(t) = r.time {
            next.reminder.time = check_time(&t)?;
        }
    }
    if let Some(i) = patch.import {
        if let Some(on) = i.post_older {
            next.import.post_older = on;
        }
        if let Some(days) = i.post_older_days {
            if !(1..=MAX_POST_OLDER_DAYS).contains(&days) {
                return Err(AppError::InvalidInput(format!("the days are 1 to {MAX_POST_OLDER_DAYS}")));
            }
            next.import.post_older_days = days;
        }
    }
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO fin_settings (entity_id, reminder_enabled, reminder_weekday, reminder_time, import_post_older, import_post_older_days) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(entity_id) DO UPDATE SET reminder_enabled = excluded.reminder_enabled, \
           reminder_weekday = excluded.reminder_weekday, reminder_time = excluded.reminder_time, \
           import_post_older = excluded.import_post_older, import_post_older_days = excluded.import_post_older_days",
    )
    .bind(ent.id)
    .bind(next.reminder.enabled)
    .bind(&next.reminder.weekday)
    .bind(&next.reminder.time)
    .bind(next.import.post_older)
    .bind(next.import.post_older_days as i64)
    .execute(&mut *tx)
    .await?;
    // A new day or time counts from now: moving it to an hour already past this week
    // doesn't fire at once.
    if (next.reminder.weekday != before.reminder.weekday || next.reminder.time != before.reminder.time) || (next.reminder.enabled && !before.reminder.enabled) {
        sqlx::query("UPDATE fin_settings SET reminder_last_at = ? WHERE entity_id = ?").bind(super::now()).bind(ent.id).execute(&mut *tx).await?;
    }
    audit(&mut tx, ent, "update", "settings", Some(ent.id), Some(&serde_json::to_value(&before)?), Some(&serde_json::to_value(&next)?))
        .await?;
    tx.commit().await?;
    Ok(next)
}

/// Every user with a finance entity and the reminder on.
pub async fn reminders_on(db: &Db) -> Result<Vec<DueCheck>> {
    Ok(sqlx::query_as(
        "SELECT e.id AS entity_id, e.user_id, e.created_at AS entity_created_at, \
                IFNULL(s.reminder_weekday, 'Mon') AS weekday, IFNULL(s.reminder_time, '09:00') AS time, \
                s.reminder_last_at AS last_at \
         FROM fin_entities e LEFT JOIN fin_settings s ON s.entity_id = e.id \
         WHERE IFNULL(s.reminder_enabled, 1) = 1 ORDER BY e.id",
    )
    .fetch_all(db)
    .await?)
}

/// Send one user's reminder: the notification (generic, no amounts), stamped at `at` so the
/// host's check sends it once per scheduled instant.
pub async fn send_reminder(db: &Db, check: &DueCheck, at: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO fin_settings (entity_id, reminder_last_at) VALUES (?, ?) \
         ON CONFLICT(entity_id) DO UPDATE SET reminder_last_at = excluded.reminder_last_at",
    )
    .bind(check.entity_id)
    .bind(at)
    .execute(db)
    .await?;
    crate::ops::create_notification(db, check.user_id, "finance", REMINDER_TITLE, Some(REMINDER_BODY), None).await
}
