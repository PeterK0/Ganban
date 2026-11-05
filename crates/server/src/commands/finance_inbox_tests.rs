//! The inbox at scale over the command table: `fin_post_matching`, `fin_categorise_matching`,
//! `fin_inbox_groups` and the import's "post older lines" option.

use super::super::testkit::*;
use base64::Engine;
use ganban_core::finance::{self, inbox};
use serde_json::{json, Value};

const HEADER: &str = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

/// A Revolut export: `n` lines of each (description, amount) from `start`, a day apart per
/// round, each at its own second.
fn statement(start: chrono::NaiveDate, rows: &[(&str, &str, usize)]) -> String {
    let mut s = String::from(HEADER);
    let mut i = 0;
    for (desc, amount, n) in rows {
        for k in 0..*n {
            let day = start + chrono::Duration::days(k as i64 % 200);
            let at = format!("{} {:02}:{:02}:{:02}", day.format("%Y-%m-%d"), (i / 3600) % 24, (i / 60) % 60, i % 60);
            let kind = if desc.starts_with("To EUR") { "Transfer" } else { "Card Payment" };
            s.push_str(&format!("{kind},Current,{at},{at},{desc},{amount},0.00,EUR,COMPLETED,100.00\n"));
            i += 1;
        }
    }
    s
}

async fn import(db: &ganban_core::Db, who: crate::AuthUser, csv: &str, extra: Value) -> Value {
    let mut args = json!({ "fileName": "s.csv", "profileKey": "revolut",
        "contentBase64": base64::engine::general_purpose::STANDARD.encode(csv),
        "accountMap": {
            "revolut:current:EUR": { "create": { "kind": "current", "name": "Everyday", "currency": "EUR" } },
            "revolut:pocket:holiday:EUR": { "create": { "kind": "savings", "name": "Holiday", "currency": "EUR" } }
        } });
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    let job = http(db, who, "fin_import", args).await.unwrap();
    loop {
        let st = http(db, who, "fin_import_status", json!({ "jobId": job["job_id"] })).await.unwrap();
        match st["state"].as_str() {
            Some("done") => return st["result"].clone(),
            Some("running") => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
            _ => panic!("import failed: {st}"),
        }
    }
}

async fn total(db: &ganban_core::Db, who: crate::AuthUser, filter: Value) -> i64 {
    http(db, who, "fin_list_entries", json!({ "filter": filter, "limit": 1 })).await.unwrap()["total"].as_i64().unwrap()
}

async fn category(db: &ganban_core::Db, who: crate::AuthUser, name: &str) -> i64 {
    let chart = http(db, who, "fin_list_ledger_accounts", json!({})).await.unwrap();
    chart.as_array().unwrap().iter().find(|a| a["name"] == name).and_then(|a| a["id"].as_i64()).unwrap()
}

fn d(s: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

#[tokio::test]
async fn post_matching_posts_every_match_of_the_callers_own_and_leaves_closed_months() {
    let db = test_db("fin_post_matching").await;
    let mia = member(&db, 7, &[]).await;
    let ana = member(&db, 8, &[]).await;
    import(&db, mia, &statement(d("2026-01-01"), &[("Green Market", "-20.00", 300), ("Corner Cafe", "-3.50", 150)]), json!({})).await;
    import(&db, ana, &statement(d("2026-01-01"), &[("Corner Cafe", "-3.50", 5)]), json!({})).await;
    assert_eq!(total(&db, mia, json!({ "status": "draft" })).await, 450);

    // More than a page and a batch: every Corner Cafe line, and nothing else.
    let r = http(&db, mia, "fin_post_matching", json!({ "filter": { "search": "cafe" } })).await.unwrap();
    assert_eq!((r["posted"].as_i64(), r["closed"].as_i64()), (Some(150), Some(0)));
    assert_eq!(total(&db, mia, json!({ "status": "posted", "search": "cafe" })).await, 150);
    assert_eq!(total(&db, mia, json!({ "status": "draft" })).await, 300);
    assert_eq!(total(&db, ana, json!({ "status": "draft" })).await, 5, "Ana's drafts are hers");

    // A date range; a status in the filter is ignored (drafts only).
    let r = http(&db, mia, "fin_post_matching", json!({ "filter": { "from": "2026-01-01", "to": "2026-01-10", "status": "posted" } }))
        .await
        .unwrap();
    assert_eq!(r["posted"].as_i64(), Some(20), "Green Market's lines of those days (two rounds)");

    // A closed month keeps its drafts (as if they slipped in before the close).
    let mia_ent = finance::entity_for_user(&db, mia.id).await.unwrap();
    sqlx::query("INSERT INTO fin_periods (entity_id, month, status, closed_at) VALUES (?, '2026-02', 'closed', '2026-03-01')")
        .bind(mia_ent.id)
        .execute(&db)
        .await
        .unwrap();
    let in_closed = total(&db, mia, json!({ "status": "draft", "to": "2026-02-28" })).await;
    assert!(in_closed > 0);
    let r = http(&db, mia, "fin_post_matching", json!({ "filter": {} })).await.unwrap();
    assert_eq!(r["closed"].as_i64(), Some(in_closed));
    assert_eq!(total(&db, mia, json!({ "status": "draft" })).await, in_closed);

    // Another user's account in the filter is not found, and nothing of Mia's moves.
    let accounts = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
    let err = http(&db, ana, "fin_post_matching", json!({ "filter": { "accountId": accounts[0]["id"] } })).await.unwrap_err();
    assert!(err.is_not_found(), "{err}");
    assert_eq!(total(&db, ana, json!({ "status": "draft" })).await, 5);
}

#[tokio::test]
async fn bulk_posting_runs_in_batches_and_audits_each_entry() {
    let db = test_db("fin_post_batches").await;
    let mia = member(&db, 7, &[]).await;
    import(&db, mia, &statement(d("2026-03-01"), &[("Green Market", "-20.00", 130)]), json!({})).await;
    let ent = finance::entity_for_user(&db, mia.id).await.unwrap();
    // Two drafts wait in a transfer pair to review: the user decides those, not a bulk post.
    let two: Vec<i64> = sqlx::query_scalar("SELECT id FROM fin_entries WHERE entity_id = ? AND status = 'draft' ORDER BY id LIMIT 2").bind(ent.id).fetch_all(&db).await.unwrap();
    sqlx::query("INSERT INTO fin_pairs (entity_id, kind, entry_a, entry_b, status, score, created_at) VALUES (?, 'transfer', ?, ?, 'review', 0.5, '2026-03-01')")
        .bind(ent.id)
        .bind(two[0])
        .bind(two[1])
        .execute(&db)
        .await
        .unwrap();
    let opts = inbox::BulkOptions { batch: 7, pause: std::time::Duration::ZERO };
    let r = inbox::post_matching(&db, &ent, finance::EntryFilter::default(), &opts).await.unwrap();
    assert_eq!((r.posted, r.review), (128, 2));
    let audited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_audit WHERE entity_id = ? AND action = 'post'")
        .bind(ent.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(audited, 128);
    // Posted entries stay editable while their month is open: bulk posting is reversible.
    let page = http(&db, mia, "fin_list_entries", json!({ "limit": 1 })).await.unwrap();
    let id = page["entries"][0]["id"].as_i64().unwrap();
    http(&db, mia, "fin_update_entry", json!({ "entryId": id, "input": { "notes": "fine" } })).await.unwrap();
}

#[tokio::test]
async fn groups_and_categorising_a_whole_group_with_its_rule() {
    let db = test_db("fin_inbox_groups").await;
    let mia = member(&db, 7, &[]).await;
    let ana = member(&db, 8, &[]).await;
    let csv = statement(
        d("2026-04-01"),
        &[("Green Market", "-20.00", 40), ("Card 1234 Corner Cafe", "-3.50", 25), ("Card 9876 Corner Cafe", "-4.00", 5), ("Green Market", "5.00", 2), ("To EUR Holiday", "-50.00", 3)],
    );
    import(&db, mia, &csv, json!({})).await;
    import(&db, ana, &statement(d("2026-04-01"), &[("Green Market", "-20.00", 3)]), json!({})).await;

    let page = http(&db, mia, "fin_inbox_groups", json!({ "filter": {} })).await.unwrap();
    assert_eq!(page["total_lines"].as_i64(), Some(78), "with the pocket's own side of each move");
    let groups = page["groups"].as_array().unwrap();
    let keys: Vec<&str> = groups.iter().map(|g| g["key"].as_str().unwrap()).collect();
    assert_eq!(&keys[..2], ["out:green market", "out:card corner cafe"], "largest first; card refs dropped");
    assert!(keys.contains(&"in:green market"), "a refund is its own group");
    let market = &groups[0];
    assert_eq!((market["count"].as_i64(), market["uncategorised"].as_i64(), market["label"].as_str()), (Some(40), Some(40), Some("Green Market")));
    assert_eq!(market["total_minor"].as_i64(), Some(-80_000));
    assert_eq!((market["first_date"].as_str(), market["direction"].as_str()), (Some("2026-04-01"), Some("out")));
    let pocket = groups.iter().find(|g| g["key"] == "out:to eur holiday").unwrap();
    assert_eq!((pocket["paired"].as_i64(), pocket["uncategorised"].as_i64()), (Some(3), Some(0)));
    // Filters narrow the groups.
    let cafe = http(&db, mia, "fin_inbox_groups", json!({ "filter": { "search": "cafe" } })).await.unwrap();
    assert_eq!((cafe["total_groups"].as_i64(), cafe["total_lines"].as_i64()), (Some(1), Some(30)));

    // One click for the group: every line in it, with a rule offered.
    let groceries = category(&db, mia, "Groceries").await;
    let r = http(&db, mia, "fin_categorise_matching", json!({ "filter": { "groupKey": "out:green market" }, "ledgerAccountId": groceries }))
        .await
        .unwrap();
    assert_eq!((r["categorised"].as_i64(), r["skipped"].as_i64()), (Some(40), Some(0)));
    assert!(r["rule"].is_null());
    let when = &r["rule_input"]["conditions"];
    assert_eq!((when["payee"].as_str(), when["maxAmountMinor"].as_i64()), (Some("*green*market*"), Some(-1)));
    assert_eq!(r["rule_input"]["action"]["ledgerAccountId"].as_i64(), Some(groceries));
    let after = http(&db, mia, "fin_inbox_groups", json!({ "filter": { "groupKey": "out:green market" } })).await.unwrap();
    assert_eq!((after["groups"][0]["uncategorised"].as_i64(), after["groups"][0]["category_id"].as_i64()), (Some(0), Some(groceries)));
    assert_eq!(total(&db, mia, json!({ "groupKey": "out:green market", "uncategorised": true })).await, 0);
    assert_eq!(total(&db, mia, json!({ "groupKey": "in:green market", "uncategorised": true })).await, 2, "the refunds are another group");
    // Ana's Green Market is hers.
    assert_eq!(total(&db, ana, json!({ "uncategorised": true })).await, 3);

    // With the rule: created, and it files the next import.
    let eating = category(&db, mia, "Eating out").await;
    let r = http(&db, mia, "fin_categorise_matching", json!({ "filter": { "groupKey": "out:card corner cafe" }, "ledgerAccountId": eating, "createRule": true }))
        .await
        .unwrap();
    assert_eq!(r["categorised"].as_i64(), Some(30));
    assert!(r["rule"]["id"].as_i64().is_some());
    let more = statement(d("2026-10-01"), &[("Card 5555 Corner Cafe", "-3.80", 2)]);
    let res = import(&db, mia, &more, json!({})).await;
    assert_eq!(res["categorised_by_rules"].as_i64(), Some(2));

    // Everything else that matches: transfer legs are left alone.
    let r = http(&db, mia, "fin_categorise_matching", json!({ "filter": {}, "ledgerAccountId": category(&db, mia, "Other income").await })).await.unwrap();
    assert_eq!(r["categorised"].as_i64(), Some(2), "only the refunds were left; the pocket moves stay transfers");
    assert_eq!(total(&db, mia, json!({ "groupKey": "out:to eur holiday" })).await, 3);

    // Refused: a rule with nothing to match on, a non-category, another user's category.
    let err = http(&db, mia, "fin_categorise_matching", json!({ "filter": { "from": "2026-01-01" }, "ledgerAccountId": groceries, "createRule": true }))
        .await
        .unwrap_err();
    assert!(err.is_invalid_input(), "{err}");
    let accounts = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
    let bank_la = accounts[0]["ledger_account_id"].as_i64().unwrap();
    assert!(http(&db, mia, "fin_categorise_matching", json!({ "filter": {}, "ledgerAccountId": bank_la })).await.unwrap_err().is_invalid_input());
    assert!(http(&db, ana, "fin_categorise_matching", json!({ "filter": {}, "ledgerAccountId": groceries })).await.unwrap_err().is_not_found());
    assert_eq!(total(&db, ana, json!({ "uncategorised": true })).await, 3);
}

#[tokio::test]
async fn group_suggestions_are_kept_per_group_until_the_user_chooses() {
    let db = test_db("fin_group_suggestions").await;
    let mia = member(&db, 7, &[]).await;
    import(&db, mia, &statement(d("2026-04-01"), &[("Green Market", "-20.00", 4), ("Corner Cafe", "-3.50", 2)]), json!({})).await;
    let ent = finance::entity_for_user(&db, mia.id).await.unwrap();
    let todo = inbox::groups_to_suggest(&db, &ent).await.unwrap();
    assert_eq!(todo.iter().map(|g| (g.key.as_str(), g.count)).collect::<Vec<_>>(), [("out:green market", 4), ("out:corner cafe", 2)]);
    assert_eq!((todo[0].amount_minor, todo[0].currency.as_str()), (-2000, "EUR"));
    let groceries = category(&db, mia, "Groceries").await;
    inbox::save_group_suggestions(&db, &ent, &[("out:green market".into(), Some(groceries)), ("out:corner cafe".into(), None)]).await.unwrap();
    assert!(inbox::groups_to_suggest(&db, &ent).await.unwrap().is_empty(), "asked once per group");
    let page = http(&db, mia, "fin_inbox_groups", json!({})).await.unwrap();
    assert_eq!(page["groups"][0]["suggested_ledger_account_id"].as_i64(), Some(groceries));
    assert!(page["groups"][1]["suggested_ledger_account_id"].is_null());
    // Another entity's category can't be stored as a suggestion.
    let ana = member(&db, 8, &[]).await;
    let ana_ent = finance::entity_for_user(&db, ana.id).await.unwrap();
    assert!(inbox::save_group_suggestions(&db, &ana_ent, &[("out:x".into(), Some(groceries))]).await.unwrap_err().is_not_found());
    // Dismissed, it's gone; taken, it's gone too.
    http(&db, mia, "fin_dismiss_group_suggestion", json!({ "groupKey": "out:green market" })).await.unwrap();
    let page = http(&db, mia, "fin_inbox_groups", json!({})).await.unwrap();
    assert!(page["groups"][0]["suggested_ledger_account_id"].is_null());
    // Without a local model the job is refused (the button is hidden then).
    assert!(http(&db, mia, "fin_suggest_groups", json!({})).await.unwrap_err().is_invalid_input());
}

#[tokio::test]
async fn an_import_can_post_older_lines_straight_away() {
    let db = test_db("fin_import_post_older").await;
    let mia = member(&db, 7, &[]).await;
    let today = chrono::Local::now().date_naive();
    let old = statement(today - chrono::Duration::days(120), &[("Green Market", "-20.00", 3)]);
    let recent = statement(today - chrono::Duration::days(5), &[("Corner Cafe", "-3.50", 2)]);
    let csv = format!("{old}{}", recent.trim_start_matches(HEADER));
    let r = import(&db, mia, &csv, json!({ "postOlderThanDays": 30 })).await;
    assert_eq!((r["created"].as_i64(), r["posted"].as_i64()), (Some(5), Some(3)));
    assert_eq!(total(&db, mia, json!({ "status": "draft" })).await, 2);
    // The option is remembered per user, off by default.
    let s = http(&db, mia, "fin_get_settings", json!({})).await.unwrap();
    assert_eq!(s["import"], json!({ "post_older": false, "post_older_days": 30 }));
    let s = http(&db, mia, "fin_update_settings", json!({ "input": { "import": { "postOlder": true, "postOlderDays": 90 } } })).await.unwrap();
    assert_eq!(s["import"], json!({ "post_older": true, "post_older_days": 90 }));
    assert!(http(&db, mia, "fin_update_settings", json!({ "input": { "import": { "postOlderDays": 0 } } })).await.unwrap_err().is_invalid_input());
    assert!(http(&db, mia, "fin_import", json!({ "postOlderThanDays": -1, "fileName": "x", "contentBase64": "", "profileKey": "revolut", "accountMap": {} }))
        .await
        .unwrap_err()
        .is_invalid_input());
}
