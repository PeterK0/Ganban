//! Atlas registry (Epoch I): slug-keyed shared collections — the slug is the
//! security boundary (member routes resolve through it, never raw collection
//! names), so its shape is enforced at the ops layer.

use ganban_core::{init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_atlas_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

#[tokio::test]
async fn registry_roundtrip_and_slug_rules() {
    let db = init_db(&temp_db("registry")).await.unwrap();

    // Slug shape is enforced: it becomes the collection name "atlas-<slug>".
    for bad in ["", "Has Caps", "spaces here", "under_score", "x".repeat(41).as_str(), "ünïcode"] {
        assert!(
            ops::create_atlas_collection(&db, bad, "Name", "/tmp", false).await.is_err(),
            "accepted bad slug {bad:?}"
        );
    }

    let c = ops::create_atlas_collection(&db, "countries", "Countries", "/tmp/atlas/countries", false).await.unwrap();
    assert_eq!(c.slug, "countries");
    assert!(c.last_ingest_at.is_none(), "never ingested yet");
    assert!(!c.owner_only, "collections are member-visible by default");

    // Owner-private flag round-trips.
    ops::set_atlas_visibility(&db, c.id, true).await.unwrap();
    assert!(ops::get_atlas_collection(&db, c.id).await.unwrap().unwrap().owner_only, "flipped owner-private");
    ops::set_atlas_visibility(&db, c.id, false).await.unwrap();

    // Duplicate slugs refuse (UNIQUE).
    assert!(ops::create_atlas_collection(&db, "countries", "Again", "/tmp", false).await.is_err());

    // Lookup by slug + list ordering by name.
    ops::create_atlas_collection(&db, "vessels", "A Vessels", "/tmp/atlas/vessels", false).await.unwrap();
    let by_slug = ops::get_atlas_collection_by_slug(&db, "countries").await.unwrap().unwrap();
    assert_eq!(by_slug.id, c.id);
    let all = ops::list_atlas_collections(&db).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].name, "A Vessels", "sorted by name");

    // Ingest stamp.
    ops::touch_atlas_ingest(&db, c.id).await.unwrap();
    assert!(ops::get_atlas_collection(&db, c.id).await.unwrap().unwrap().last_ingest_at.is_some());

    // Unregister removes the row (the corpus on disk is not this layer's business).
    ops::delete_atlas_collection(&db, c.id).await.unwrap();
    assert!(ops::get_atlas_collection_by_slug(&db, "countries").await.unwrap().is_none());
}

#[tokio::test]
async fn tab_config_requires_enablement() {
    let db = init_db(&temp_db("tabcfg")).await.unwrap();
    let pid = ops::create_project(&db, ganban_core::models::CreateProjectInput { name: "P".into(), description: None })
        .await
        .unwrap()
        .id;

    // Config without enablement refuses (the row IS the enablement).
    assert!(ops::set_project_tab_config(&db, pid, "atlas", "{\"slug\":\"countries\"}").await.is_err());
    assert_eq!(ops::project_tab_config(&db, pid, "atlas").await.unwrap(), "{}");

    ops::set_project_tab(&db, pid, "atlas", true).await.unwrap();
    ops::set_project_tab_config(&db, pid, "atlas", "{\"slug\":\"countries\"}").await.unwrap();
    assert_eq!(ops::project_tab_config(&db, pid, "atlas").await.unwrap(), "{\"slug\":\"countries\"}");

    // Disabling drops the config with the row.
    ops::set_project_tab(&db, pid, "atlas", false).await.unwrap();
    assert_eq!(ops::project_tab_config(&db, pid, "atlas").await.unwrap(), "{}");
}
