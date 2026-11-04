//! Device pairing is how identity survives a lost device: a person is ONE
//! user with MANY device tokens. Two ways to add a device — from a signed-in
//! device (self-service, `create_enrollment_token(new_device, self)`) or by
//! the owner FOR a member (`create_member_device_enrollment`). Both must land
//! on the SAME account, and validation must say which device is calling.

use ganban_core::models::CreateProjectInput;
use ganban_core::{auth, init_db_role, ops, Db, Role};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_devrec_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

/// A member "Misha" who joined via a contact invite, on one device.
async fn member_on_one_device(db: &Db) -> (i64, String) {
    auth::ensure_owner(db).await.unwrap();
    let pid = ops::create_project(db, CreateProjectInput { name: "Reno".into(), description: None }).await.unwrap().id;
    let contact = ops::create_contact(
        db,
        ganban_core::models::CreateContactInput {
            full_name: "Misha".into(),
            occupation: None,
            phone_numbers: None,
            emails: None,
            birthday: None,
            notes: None,
        },
    )
    .await
    .unwrap();
    let raw = auth::create_contact_invite(db, contact.id, pid, "member").await.unwrap();
    let first = auth::enroll(db, &raw, Some("Safari tab"), None).await.unwrap();
    (first.user.id, first.device_token)
}

#[tokio::test]
async fn owner_pairs_a_new_device_for_a_member_and_it_is_the_same_account() {
    let db = init_db_role(&temp_db("owner_pairs"), Role::Server).await.unwrap();
    let (misha, first_token) = member_on_one_device(&db).await;

    // The "lost phone": recovery is the owner minting FOR Misha.
    let raw = auth::create_member_device_enrollment(&db, misha).await.unwrap();
    let second = auth::enroll(&db, &raw, Some("Home Screen app"), None).await.unwrap();
    assert_eq!(second.user.id, misha, "same account, not a duplicate");
    assert_eq!(second.user.full_name, "Misha");

    // Both tokens are live and each identifies ITS OWN device.
    let (u1, d1) = auth::validate_device_token(&db, &first_token).await.unwrap().unwrap();
    let (u2, d2) = auth::validate_device_token(&db, &second.device_token).await.unwrap().unwrap();
    assert_eq!((u1.id, u2.id), (misha, misha));
    assert_ne!(d1, d2, "two devices, two identities");
    let devices = auth::list_user_devices(&db, misha).await.unwrap();
    assert_eq!(devices.len(), 2);
    assert!(devices.iter().any(|d| d.device_label.as_deref() == Some("Home Screen app")));

    // Whose device is it? (the permission behind member self-revoke)
    assert_eq!(auth::device_token_user(&db, d2).await.unwrap(), Some(misha));
    assert_eq!(auth::device_token_user(&db, 9_999).await.unwrap(), None);

    // Revoking the old device leaves the new one working — the account survives the device.
    auth::revoke_device_token(&db, d1).await.unwrap();
    assert!(auth::validate_device_token(&db, &first_token).await.unwrap().is_none());
    assert!(auth::validate_device_token(&db, &second.device_token).await.unwrap().is_some());
}

#[tokio::test]
async fn self_service_pairing_from_a_signed_in_device_lands_on_the_same_account() {
    let db = init_db_role(&temp_db("self_service"), Role::Server).await.unwrap();
    let (misha, _) = member_on_one_device(&db).await;
    // What `create_device_enrollment` does server-side for the caller.
    let raw = auth::create_enrollment_token(&db, "new_device", Some(misha), None, None, None, auth::ENROLLMENT_TTL_SECS)
        .await
        .unwrap();
    let laptop = auth::enroll(&db, &raw, Some("Chrome on Windows"), None).await.unwrap();
    assert_eq!(laptop.user.id, misha);
    // Single use.
    assert!(auth::enroll(&db, &raw, Some("again"), None).await.is_err());
}

#[tokio::test]
async fn recovery_refuses_unknown_and_inactive_users() {
    let db = init_db_role(&temp_db("refuse"), Role::Server).await.unwrap();
    let (misha, _) = member_on_one_device(&db).await;
    assert!(auth::create_member_device_enrollment(&db, 9_999).await.is_err(), "unknown user");
    sqlx::query("UPDATE users SET is_active = 0 WHERE id = ?").bind(misha).execute(&db).await.unwrap();
    assert!(auth::create_member_device_enrollment(&db, misha).await.is_err(), "removed member can't be re-armed");
}

/// Device tokens don't expire. The failure this guards against: a member who
/// didn't open the app for a month came back to the Join screen — and if the
/// owner had no way to reconnect them, they were gone.
#[tokio::test]
async fn a_device_unused_for_a_year_still_signs_in() {
    let db = init_db_role(&temp_db("stale"), Role::Server).await.unwrap();
    let (misha, token) = member_on_one_device(&db).await;
    sqlx::query("UPDATE device_tokens SET created_at = '2020-01-01T00:00:00Z', last_seen_at = '2020-01-01T00:00:00Z' WHERE user_id = ?")
        .bind(misha)
        .execute(&db)
        .await
        .unwrap();
    let (user, _) = auth::validate_device_token(&db, &token).await.unwrap().expect("still valid");
    assert_eq!(user.id, misha);
    // Using it is what the devices list reports — last seen moves, nothing else does.
    let devices = auth::list_user_devices(&db, misha).await.unwrap();
    assert!(devices[0].last_seen_at.unwrap() > chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap());
}

/// Hosts upgraded from the 30-day-expiry era carry `expires_at NOT NULL`. The
/// one-statement migration drops it and a device that had "expired" works again.
#[tokio::test]
async fn migration_drops_expiry_and_revives_expired_devices() {
    let path = temp_db("migrate");
    let db = init_db_role(&path, Role::Server).await.unwrap();
    let (misha, token) = member_on_one_device(&db).await;
    // Recreate the old shape on top of live rows: an expired device.
    sqlx::query("ALTER TABLE device_tokens ADD COLUMN expires_at TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z'")
        .execute(&db)
        .await
        .unwrap();
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('device_tokens')").fetch_all(&db).await.unwrap();
    assert!(cols.iter().any(|c| c == "expires_at"), "old shape in place");
    db.close().await;

    // Reopen = the host upgrading.
    let db = init_db_role(&path, Role::Server).await.unwrap();
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('device_tokens')").fetch_all(&db).await.unwrap();
    assert!(!cols.iter().any(|c| c == "expires_at"), "column dropped");
    let (user, _) = auth::validate_device_token(&db, &token).await.unwrap().expect("the 'expired' device signs in");
    assert_eq!(user.id, misha);
    // Idempotent: a third open is a no-op.
    db.close().await;
    init_db_role(&path, Role::Server).await.unwrap();
}

/// A device's last-seen stamp is bookkeeping: while another connection holds the
/// write lock (a long import), signing in still works at once, and the stamp lands
/// once the lock frees.
#[tokio::test]
async fn signing_in_while_the_database_is_busy_defers_the_last_seen_stamp() {
    let db = init_db_role(&temp_db("busy"), Role::Server).await.unwrap();
    let (misha, token) = member_on_one_device(&db).await;
    sqlx::query("UPDATE device_tokens SET last_seen_at = '2020-01-01T00:00:00Z' WHERE user_id = ?").bind(misha).execute(&db).await.unwrap();
    let mut writer = db.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer).await.unwrap();
    let t = std::time::Instant::now();
    let (user, _) = auth::validate_device_token(&db, &token).await.unwrap().expect("still valid");
    assert_eq!(user.id, misha);
    assert!(t.elapsed() < std::time::Duration::from_secs(2), "waited {:?}", t.elapsed());
    let devices = auth::list_user_devices(&db, misha).await.unwrap();
    assert!(devices[0].last_seen_at.unwrap() < chrono::DateTime::parse_from_rfc3339("2021-01-01T00:00:00Z").unwrap(), "not yet");
    sqlx::query("ROLLBACK").execute(&mut *writer).await.unwrap();
    drop(writer);
    // Free again: the deferred stamp lands.
    let landed = async {
        loop {
            let devices = auth::list_user_devices(&db, misha).await.unwrap();
            if devices[0].last_seen_at.unwrap() > chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), landed).await.expect("the stamp landed");
}
