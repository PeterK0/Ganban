//! Regression: a binned (soft-deleted, `archived=1`) row must survive a
//! NON-conflicting host upsert that carries `archived=0`. `archived` has no
//! delete-tombstone, so without the soft-delete guard in `apply_change` a host
//! edit to a still-live event would un-bin the replica's local delete and the
//! event would reappear on the calendar — the ghost-events bug.

use ganban_core::models::{CreateEventInput, UpdateEventInput};
use ganban_core::{init_db_role, ops, sync, Db, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_softdel_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(p.with_extension(ext));
    }
    p
}

/// Pull everything from the host and ingest it into the replica, bracketed by
/// the orchestrator's echo-guard (so ingested rows aren't recaptured + pushed back).
async fn ingest_all(host: &Db, replica: &Db) {
    let pulled = sync::pull(host, "").await.unwrap();
    let changes: Vec<sync::IncomingChange> = serde_json::from_value(pulled["changes"].clone()).unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(replica).await.unwrap();
    sync::ingest(replica, changes).await.unwrap();
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(replica).await.unwrap();
}

fn event_in(title: &str) -> CreateEventInput {
    CreateEventInput {
        title: title.into(),
        description: None,
        location: None,
        event_date: "2026-06-01T09:00:00Z".parse().unwrap(),
        start_time: Some("09:00".into()),
        end_time: None,
        all_day: false,
        reminder_minutes: None,
        notification_enabled: false,
        rrule: None,
        exdates: None,
        series_id: None,
    }
}

#[tokio::test]
async fn binned_event_survives_nonconflicting_host_upsert() {
    let host = init_db_role(&temp_db("host"), Role::Server).await.unwrap();
    let replica = init_db_role(&temp_db("replica"), Role::Replica).await.unwrap();

    // Host creates an event; the replica ingests it (archived=0 on both).
    let h_eid = ops::create_event(&host, event_in("Lecture 02")).await.unwrap().id;
    let uuid: String = sqlx::query_scalar("SELECT sync_uuid FROM events WHERE id=?")
        .bind(h_eid)
        .fetch_one(&host)
        .await
        .unwrap();
    ingest_all(&host, &replica).await;

    // The replica bins the event, then we clear its dirty flag to model the bin
    // having ALREADY been synced. That's the no-synthesizable-base case, so the
    // host's next upsert arrives as conflict==0 — the resurrection window.
    let r_eid: i64 = sqlx::query_scalar("SELECT id FROM events WHERE sync_uuid=?")
        .bind(&uuid)
        .fetch_one(&replica)
        .await
        .unwrap();
    ops::delete_event(&replica, r_eid).await.unwrap();
    sqlx::query("UPDATE sync_state SET dirty=0 WHERE entity_type='events' AND row_id=?")
        .bind(r_eid)
        .execute(&replica)
        .await
        .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT archived FROM events WHERE id=?")
        .bind(r_eid)
        .fetch_one(&replica)
        .await
        .unwrap();
    assert_eq!(before, 1, "precondition: the event is binned on the replica");

    // The host edits the still-live event (archived stays 0); replica re-ingests.
    ops::update_event(
        &host,
        h_eid,
        UpdateEventInput {
            title: Some("Lecture 02 (room change)".into()),
            description: None,
            location: None,
            event_date: None,
            start_time: None,
            end_time: None,
            all_day: None,
            reminder_minutes: None,
            notification_enabled: None,
            rrule: None,
            exdates: None,
        },
    )
    .await
    .unwrap();
    ingest_all(&host, &replica).await;

    let (archived, title): (i64, String) = sqlx::query_as("SELECT archived, title FROM events WHERE sync_uuid=?")
        .bind(&uuid)
        .fetch_one(&replica)
        .await
        .unwrap();
    assert_eq!(archived, 1, "binned event must NOT be resurrected by a non-conflicting host upsert");
    assert_eq!(title, "Lecture 02 (room change)", "the host's edit still lands");
}
