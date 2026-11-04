//! The weekly bank-import reminder for Finance (FINANCE.md § Wave 2, The weekly import
//! reminder). Every minute the host looks for users whose reminder instant ("Mon 09:00",
//! host-local, through the schedule parser) has passed since their last one, and leaves
//! them one notification. The text is generic: no amounts, no payees.

use chrono::{DateTime, Utc};
use ganban_core::error::AppError;
use ganban_core::finance::reminder;
use ganban_core::Db;

use crate::oracle_run::{last_instant, parse_schedule};

fn parse(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

/// Send every reminder due at `now`. Returns how many were sent.
pub async fn check(db: &Db, now: DateTime<Utc>) -> Result<usize, AppError> {
    let mut sent = 0;
    for c in reminder::reminders_on(db).await? {
        let Some(due) = parse_schedule(&format!("{} {}", c.weekday, c.time)).and_then(|s| last_instant(s, now)) else {
            continue;
        };
        // Once per instant, and never for an instant before the user started Finance.
        let floor = [c.last_at.as_deref().and_then(parse), parse(&c.entity_created_at)].into_iter().flatten().max();
        if floor.is_some_and(|f| f >= due) {
            continue;
        }
        reminder::send_reminder(db, &c, &now.to_rfc3339()).await?;
        sent += 1;
    }
    Ok(sent)
}

/// The host's minute clock for the reminder.
pub fn spawn(db: Db, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
                _ = stop.changed() => return,
            }
            if let Err(e) = check(&db, Utc::now()).await {
                tracing::warn!("finance reminder check failed: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Local, TimeZone};
    use ganban_core::finance;

    async fn count(db: &Db, user: i64) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND category = 'finance'")
            .bind(user)
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_reminder_fires_once_a_week_per_user() {
        let db = crate::commands::testkit::test_db("finance_reminder").await;
        let mia = crate::commands::testkit::member(&db, 7, &[]).await;
        let ana = crate::commands::testkit::member(&db, 8, &[]).await;
        let _nobody = crate::commands::testkit::member(&db, 9, &[]).await;
        let (e_mia, e_ana) = (finance::entity_for_user(&db, mia.id).await.unwrap(), finance::entity_for_user(&db, ana.id).await.unwrap());
        // Both started Finance well before the week in question.
        sqlx::query("UPDATE fin_entities SET created_at = '2026-01-01T00:00:00+00:00'").execute(&db).await.unwrap();
        finance::reminder::update_settings(&db, &e_ana, finance::reminder::SettingsPatch {
            reminder: Some(finance::reminder::ReminderPatch { weekday: Some("Thu".into()), ..Default::default() }),
        })
        .await
        .unwrap();
        // The change counts from the real clock; this test's week is its own.
        sqlx::query("UPDATE fin_settings SET reminder_last_at = NULL").execute(&db).await.unwrap();
        let _ = e_mia;
        // Host-local Monday 2026-07-06.
        let at = |d: u32, h: u32| Local.with_ymd_and_hms(2026, 7, d, h, 0, 0).earliest().unwrap().with_timezone(&Utc);
        assert_eq!(check(&db, at(6, 10)).await.unwrap(), 2, "a first check catches up on each user's latest instant");
        assert_eq!((count(&db, mia.id).await, count(&db, ana.id).await), (1, 1));
        // The rest of the week: nothing new until each user's next instant.
        for h in [11, 15, 23] {
            assert_eq!(check(&db, at(6, h)).await.unwrap(), 0);
        }
        assert_eq!(check(&db, at(9, 8)).await.unwrap(), 0);
        assert_eq!(check(&db, at(9, 9)).await.unwrap(), 1, "Ana's Thursday");
        assert_eq!(check(&db, at(10, 9)).await.unwrap(), 0);
        assert_eq!(check(&db, at(13, 9)).await.unwrap(), 1, "Mia's next Monday");
        assert_eq!(check(&db, at(13, 9) + Duration::minutes(1)).await.unwrap(), 0);
        assert_eq!((count(&db, mia.id).await, count(&db, ana.id).await), (2, 2));
        // Users without Finance get none; a user who turned it off gets none.
        assert_eq!(count(&db, 9).await, 0);
        finance::reminder::update_settings(&db, &e_ana, finance::reminder::SettingsPatch {
            reminder: Some(finance::reminder::ReminderPatch { enabled: Some(false), ..Default::default() }),
        })
        .await
        .unwrap();
        assert_eq!(check(&db, at(16, 10)).await.unwrap(), 0);
        let title: String = sqlx::query_scalar("SELECT title FROM notifications WHERE category = 'finance' LIMIT 1").fetch_one(&db).await.unwrap();
        assert_eq!(title, finance::reminder::REMINDER_TITLE);
    }
}
