//! Profile PINs: hashed at rest (salt$sha256), verified in core, surfaced only
//! as a `has_pin` flag — and deactivation must cut off device tokens.

use ganban_core::{auth, init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_pin_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

#[tokio::test]
async fn pin_set_verify_clear_roundtrip() {
    let db = init_db(&temp_db("roundtrip")).await.unwrap();
    let uid = ops::get_users(&db).await.unwrap()[0].id; // the seeded default user

    // No pin: verifies trivially, has_pin = false.
    assert!(ops::verify_user_pin(&db, uid, "0000").await.unwrap());
    assert!(!ops::get_user(&db, uid).await.unwrap().has_pin);

    // Set: only the right pin verifies; the stored value is salted, not raw.
    ops::set_user_pin(&db, uid, Some("4711")).await.unwrap();
    assert!(ops::verify_user_pin(&db, uid, "4711").await.unwrap());
    assert!(!ops::verify_user_pin(&db, uid, "1234").await.unwrap());
    assert!(ops::get_user(&db, uid).await.unwrap().has_pin);
    let stored: String = sqlx::query_scalar("SELECT pin_hash FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(stored.contains('$') && !stored.contains("4711"));

    // Re-set: new pin replaces the old (fresh salt each time).
    ops::set_user_pin(&db, uid, Some("90210")).await.unwrap();
    assert!(!ops::verify_user_pin(&db, uid, "4711").await.unwrap());
    assert!(ops::verify_user_pin(&db, uid, "90210").await.unwrap());

    // Clear: back to an open profile.
    ops::set_user_pin(&db, uid, None).await.unwrap();
    assert!(ops::verify_user_pin(&db, uid, "anything-no-wait-digits").await.unwrap());
    assert!(!ops::get_user(&db, uid).await.unwrap().has_pin);
}

#[tokio::test]
async fn pin_must_be_4_to_8_digits() {
    let db = init_db(&temp_db("shape")).await.unwrap();
    let uid = ops::get_users(&db).await.unwrap()[0].id;
    for bad in ["123", "123456789", "12a4", "....", ""] {
        assert!(ops::set_user_pin(&db, uid, Some(bad)).await.is_err(), "accepted {bad:?}");
    }
    for good in ["1234", "12345678"] {
        ops::set_user_pin(&db, uid, Some(good)).await.unwrap();
    }
}

#[tokio::test]
async fn deactivated_user_loses_device_access() {
    let db = init_db(&temp_db("deactivate")).await.unwrap();
    let user = ops::create_user(
        &db,
        ganban_core::models::CreateUserInput {
            username: "friend".into(),
            full_name: "Test Friend".into(),
            email: None,
        },
    )
    .await
    .unwrap();

    // Enroll a device for them the way the daemon does.
    let raw = auth::create_enrollment_token(&db, "new_device", Some(user.id), None, None, None, 3600)
        .await
        .unwrap();
    let enrolled = auth::enroll(&db, &raw, Some("phone"), None).await.unwrap();
    assert!(auth::validate_device_token(&db, &enrolled.device_token).await.unwrap().is_some());

    // Deactivate: the token must stop authenticating, not just hide the user.
    ops::update_user(
        &db,
        user.id,
        ganban_core::models::UpdateUserInput { full_name: None, email: None, is_active: Some(false) },
    )
    .await
    .unwrap();
    assert!(auth::validate_device_token(&db, &enrolled.device_token).await.unwrap().is_none());
}
