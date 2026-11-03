//! get_events date-window boundaries. Regression: the Day view (start == end)
//! must include a timed event on that day. The window bounds are date-only
//! ("2026-06-17") while event_date is a full timestamp, so a raw string
//! compare made `event_date <= end` exclude every timed event on the end day
//! and silently emptied the Day view.

use chrono::{DateTime, Utc};
use ganban_core::models::{CreateEventInput, CreateProjectInput, CreateTaskInput};
use ganban_core::{init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_events_window_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

async fn add(db: &ganban_core::Db, title: &str, ts: &str, all_day: bool) -> i64 {
    ops::create_event(
        db,
        CreateEventInput {
            title: title.into(),
            description: None,
            location: None,
            event_date: DateTime::parse_from_rfc3339(ts).unwrap().with_timezone(&Utc),
            start_time: if all_day { None } else { Some("15:00".into()) },
            end_time: None,
            all_day,
            reminder_minutes: None,
            notification_enabled: false,
            rrule: None,
            exdates: None,
            series_id: None,
        },
    )
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn day_view_includes_timed_and_all_day_events_on_that_day() {
    let db = init_db(&temp_db("day")).await.unwrap();
    let timed = add(&db, "Afternoon sync", "2026-06-17T15:00:00Z", false).await;
    let allday = add(&db, "All day", "2026-06-17T00:00:00Z", true).await;
    let _next = add(&db, "Tomorrow", "2026-06-18T09:00:00Z", false).await;

    // Day view asks for a single day: start == end.
    let got = ops::get_events(&db, Some("2026-06-17".into()), Some("2026-06-17".into()), Some(false))
        .await
        .unwrap();
    let ids: Vec<i64> = got.iter().map(|e| e.id).collect();

    assert!(ids.contains(&timed), "timed event on the day must show in the Day view");
    assert!(ids.contains(&allday), "all-day event must show in the Day view");
    assert_eq!(ids.len(), 2, "the next day's event must NOT leak in: {ids:?}");
}

#[tokio::test]
async fn task_linked_event_ids_lists_only_task_connected_events() {
    let db = init_db(&temp_db("tasklinked")).await.unwrap();
    let with_task = add(&db, "Has task", "2026-06-17T10:00:00Z", false).await;
    let _without = add(&db, "No task", "2026-06-17T11:00:00Z", false).await;

    let pid = ops::create_project(&db, CreateProjectInput { name: "P".into(), description: None })
        .await
        .unwrap()
        .id;
    let task = ops::create_task(
        &db,
        CreateTaskInput {
            project_id: pid,
            area_id: None,
            title: "T".into(),
            description: None,
            status: "todo".into(),
            priority: "normal".into(),
            prefix: None,
            cost: None,
            currency: None,
            deadline: None,
        },
    )
    .await
    .unwrap()
    .id;
    ops::link_event_to_task(&db, with_task, task).await.unwrap();

    let linked = ops::get_task_linked_event_ids(&db).await.unwrap();
    assert_eq!(linked, vec![with_task], "only the task-connected event is listed");

    // Unlinking (a hard delete of the junction row) drops it from the set.
    ops::unlink_event_from_task(&db, with_task, task).await.unwrap();
    assert!(ops::get_task_linked_event_ids(&db).await.unwrap().is_empty());
}

#[tokio::test]
async fn month_window_is_inclusive_of_the_last_day() {
    let db = init_db(&temp_db("month")).await.unwrap();
    let last = add(&db, "Month end", "2026-06-30T23:30:00Z", false).await;
    let _after = add(&db, "Next month", "2026-07-01T00:00:00Z", false).await;

    let got = ops::get_events(&db, Some("2026-06-01".into()), Some("2026-06-30".into()), Some(false))
        .await
        .unwrap();
    let ids: Vec<i64> = got.iter().map(|e| e.id).collect();
    assert!(ids.contains(&last), "an event late on the last day must be in-window");
    assert_eq!(ids.len(), 1, "July must be excluded: {ids:?}");
}
