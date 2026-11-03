//! Loadouts: named tool/prompt/sub-model bundles assigned to a personality.
//! The chat-handler resolution (tool scoping, prompt fragments, routing) lives
//! in the server; here we lock the data layer it depends on.

use ganban_core::models::{NewLoadout, UpdateLoadout};
use ganban_core::{init_db, ops};

fn temp_db(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ganban_loadouts_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    path
}

async fn a_profile(db: &ganban_core::Db, name: &str, model: &str) -> i64 {
    ops::upsert_model_profile(db, None, name, model, None, None, None, None, None, None, None, None)
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn loadout_roundtrip_tools_prompt_routing_and_assignment() {
    let db = init_db(&temp_db("roundtrip")).await.unwrap();
    let persona = a_profile(&db, "Researcher", "big:70b").await;
    let fast = a_profile(&db, "Fast tool runner", "light:8b").await;

    // A loadout that grants two tools, a prompt fragment, and a routed sub-model.
    let lo = ops::create_loadout(
        &db,
        NewLoadout {
            name: "Research".into(),
            description: "Search + cite.".into(),
            prompt_fragment: Some("Always cite your sources.".into()),
            routing_profile_id: Some(fast),
            tools: vec!["search_corpus".into(), "ask_atlas".into()],
        },
    )
    .await
    .unwrap();
    assert_eq!(lo.routing_profile_id, Some(fast));
    assert_eq!(lo.prompt_fragment.as_deref(), Some("Always cite your sources."));

    let mut tools = ops::loadout_tool_names(&db, lo.id).await.unwrap();
    tools.sort();
    assert_eq!(tools, vec!["ask_atlas".to_string(), "search_corpus".to_string()]);

    // Assign it to the personality; resolution sees it with its fields intact.
    ops::set_profile_loadouts(&db, persona, &[lo.id]).await.unwrap();
    assert_eq!(ops::profile_loadout_ids(&db, persona).await.unwrap(), vec![lo.id]);
    let resolved = ops::profile_loadouts(&db, persona).await.unwrap();
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].routing_profile_id, Some(fast));

    // Update replaces the tool set; other fields persist when omitted.
    ops::update_loadout(
        &db,
        lo.id,
        UpdateLoadout { tools: Some(vec!["search_corpus".into()]), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(ops::loadout_tool_names(&db, lo.id).await.unwrap(), vec!["search_corpus".to_string()]);
    assert_eq!(ops::get_loadout(&db, lo.id).await.unwrap().unwrap().prompt_fragment.as_deref(), Some("Always cite your sources."));

    // Deleting the loadout unassigns it everywhere.
    ops::delete_loadout(&db, lo.id).await.unwrap();
    assert!(ops::profile_loadout_ids(&db, persona).await.unwrap().is_empty());
    assert!(ops::loadout_tool_names(&db, lo.id).await.unwrap().is_empty());
}
