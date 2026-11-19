//! Payees on a throwaway database, with made-up merchants and amounts.

use std::collections::HashMap;

use super::*;
use crate::finance::import::pipeline::{import_file_with, AccountChoice, ImportOptions, ImportResult, NewAccount};
use crate::finance::inbox::{categorise_matching, BulkOptions};
use crate::finance::{list_accounts, list_entries, list_ledger_accounts, rates, system_account, EntryFilter};

async fn test_db(tag: &str) -> Db {
    let path = std::env::temp_dir().join(format!("ganban_payees_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    crate::init_db(&path).await.unwrap()
}

async fn user(db: &Db, id: i64) -> Entity {
    sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
        .bind(id)
        .bind(format!("user{id}"))
        .bind(format!("User {id}"))
        .execute(db)
        .await
        .unwrap();
    crate::finance::entity_for_user(db, id).await.unwrap()
}

async fn la(db: &Db, ent: &Entity, name: &str) -> i64 {
    list_ledger_accounts(db, ent, true).await.unwrap().into_iter().find(|a| a.name == name).unwrap().id
}

/// A sample-format file: `(kind, day, text, amount)` rows on the current EUR account.
fn file(rows: &[(&str, &str, &str, &str)]) -> Vec<u8> {
    let mut s = String::from("Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n");
    for (n, (kind, day, text, amount)) in rows.iter().enumerate() {
        s.push_str(&format!("{kind},Current,{day} 09:{:02}:00,{day} 10:00:00,{text},{amount},0.00,EUR,,,\n", n % 60));
    }
    s.into_bytes()
}

fn opts(history_before: Option<&str>) -> ImportOptions {
    ImportOptions {
        pause: std::time::Duration::ZERO,
        pass_pause: std::time::Duration::ZERO,
        post_before: history_before.map(str::to_string),
        ..Default::default()
    }
}

async fn import(db: &Db, ent: &Entity, bytes: &[u8], history_before: Option<&str>) -> ImportResult {
    let everyday = list_accounts(db, ent, true).await.unwrap().into_iter().find(|a| a.name == "Everyday");
    let choice = match everyday {
        Some(a) => AccountChoice::Existing(a.id),
        None => AccountChoice::Create {
            create: NewAccount {
                kind: "current".into(),
                name: "Everyday".into(),
                institution: Some("Sample Bank".into()),
                currency: "EUR".into(),
            },
        },
    };
    let map: HashMap<String, AccountChoice> = [("sample:current:EUR".to_string(), choice)].into();
    import_file_with(db, ent, "s.csv", bytes, "sample", map, &opts(history_before), &|_| {}).await.unwrap()
}

async fn drafts(db: &Db, ent: &Entity) -> i64 {
    let f = EntryFilter { status: Some("draft".into()), ..Default::default() };
    list_entries(db, ent, f, 1, 0).await.unwrap().total
}

async fn entry_ids(db: &Db, ent: &Entity, payee: i64) -> Vec<i64> {
    let f = EntryFilter { payee_id: Some(payee), ..Default::default() };
    list_entries(db, ent, f, 1000, 0).await.unwrap().entries.into_iter().map(|e| e.id).collect()
}

async fn by_key(db: &Db, key: &str) -> i64 {
    sqlx::query_scalar("SELECT payee_id FROM fin_payee_aliases WHERE key = ?").bind(key).fetch_one(db).await.unwrap()
}

async fn payee_named(db: &Db, ent: &Entity, search: &str) -> Payee {
    let f = PayeeFilter { search: Some(search.into()), ..Default::default() };
    let page = list_payees(db, ent, f, 50, 0).await.unwrap();
    assert_eq!(page.total, 1, "{search}: {:?}", page.payees.iter().map(|p| &p.name).collect::<Vec<_>>());
    page.payees.into_iter().next().unwrap()
}

#[tokio::test]
async fn three_spellings_are_one_payee_that_learns_its_category() {
    let db = test_db("learn").await;
    let ent = user(&db, 7).await;
    let r = import(
        &db,
        &ent,
        &file(&[
            ("card", "2026-10-01", "WOΛT", "-14.76"),
            ("card", "2026-10-02", "Wolt", "-9.10"),
            ("card", "2026-10-03", "WOLT*ORDER 128", "-22.00"),
            ("card", "2026-10-04", "Green Market", "-30.00"),
        ]),
        None,
    )
    .await;
    assert_eq!((r.created, r.decisions), (4, 4));
    let wolt = payee_named(&db, &ent, "wolt").await;
    assert_eq!((wolt.lines, wolt.aliases.len(), wolt.default_ledger_account_id), (3, 1, None));
    assert_eq!(wolt.name, "Wolt");
    // The raw text stays on the source line as the bank wrote it.
    let raw: Vec<String> =
        sqlx::query_scalar("SELECT description FROM fin_source_lines ORDER BY id").fetch_all(&db).await.unwrap();
    assert_eq!(raw[2], "WOLT*ORDER 128");

    // The first category files the payee's other lines and posts all three.
    let eating = la(&db, &ent, "Eating out").await;
    let target: i64 = sqlx::query_scalar(
        "SELECT e.id FROM fin_entries e JOIN fin_source_lines s ON s.id = e.source_line_id WHERE s.description = 'Wolt'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let split_of = |la: i64| vec![Split { ledger_account_id: la, amount_minor: -910, memo: None }];
    let c = categorise(&db, &ent, target, split_of(eating), DefaultChoice::Once).await.unwrap();
    assert_eq!(c.entry.status, "posted");
    let change = c.payee_default.unwrap();
    assert_eq!((change.ledger_account_id, change.previous_ledger_account_id), (Some(eating), None));
    assert_eq!(change.filed_drafts.len(), 2);
    assert_eq!(drafts(&db, &ent).await, 1, "only Green Market is left");

    // Filing a later line differently asks: "once" leaves the default, "change" moves it.
    let groceries = la(&db, &ent, "Groceries").await;
    let c = categorise(&db, &ent, target, split_of(groceries), DefaultChoice::Once).await.unwrap();
    assert!(c.payee_default.is_none());
    assert_eq!(get_payee(&db, &ent, wolt.id).await.unwrap().default_ledger_account_id, Some(eating));
    let c = categorise(&db, &ent, target, split_of(groceries), DefaultChoice::Change).await.unwrap();
    assert_eq!(c.payee_default.unwrap().previous_ledger_account_id, Some(eating));
    categorise(&db, &ent, target, split_of(eating), DefaultChoice::Change).await.unwrap();

    // Undo puts the filed lines back in the inbox and the default back to none.
    let p = undo_default(&db, &ent, wolt.id, None, None, &change.filed_drafts, &[]).await.unwrap();
    assert_eq!(p.default_ledger_account_id, None);
    assert_eq!(drafts(&db, &ent).await, 3);

    // A new import files the payee's lines by its default, posted, out of the inbox.
    set_default(&db, &ent, wolt.id, Some(eating), true).await.unwrap();
    assert_eq!(drafts(&db, &ent).await, 1);
    let r = import(&db, &ent, &file(&[("card", "2026-10-09", "wolt", "-11.00")]), None).await;
    assert_eq!((r.filed_by_payee, r.posted, r.decisions), (1, 1, 0));

    // Ask every time: the default stays, but nothing is filed by it.
    update_payee(&db, &ent, wolt.id, PayeePatch { ask_every_time: Some(true), ..Default::default() }).await.unwrap();
    let r = import(&db, &ent, &file(&[("card", "2026-10-10", "WOLT", "-12.00")]), None).await;
    assert_eq!((r.filed_by_payee, r.decisions), (0, 1));
}

#[tokio::test]
async fn merge_and_split_undo_each_other() {
    let db = test_db("merge").await;
    let ent = user(&db, 7).await;
    import(
        &db,
        &ent,
        &file(&[
            ("card", "2026-10-01", "Wolt", "-14.76"),
            ("card", "2026-10-02", "WOLT ORDER", "-9.10"),
            ("card", "2026-10-03", "Bolt", "-5.00"),
            ("card", "2026-10-04", "Bolt Food", "-6.00"),
        ]),
        None,
    )
    .await;
    // "Wolt order" is suggested for Wolt; Bolt and Bolt Food are not.
    let (wolt_id, other) = (by_key(&db, "wolt").await, by_key(&db, "wolt order").await);
    let s = suggestions(&db, &ent, 50).await.unwrap();
    assert_eq!(s.len(), 1, "{s:?}");
    assert_eq!((s[0].a.id.min(s[0].b.id), s[0].a.id.max(s[0].b.id)), (wolt_id.min(other), wolt_id.max(other)));
    assert_eq!(s[0].reason, "same name");

    // Rename, then merge "Wolt order" into it.
    let renamed =
        update_payee(&db, &ent, wolt_id, PayeePatch { name: Some("Wolt".into()), ..Default::default() }).await.unwrap();
    assert_eq!(renamed.name, "Wolt");
    let merged = merge_payees(&db, &ent, wolt_id, &[other]).await.unwrap();
    assert_eq!((merged.lines, merged.aliases.len()), (2, 2));
    assert!(merged.aliases.iter().any(|al| al.origin_payee_id == Some(other)));
    assert!(suggestions(&db, &ent, 50).await.unwrap().is_empty());
    // A merged payee can't be acted on.
    assert!(update_payee(&db, &ent, other, PayeePatch::default()).await.unwrap_err().is_invalid_input());
    // A new spelling of the merged alias resolves to the merged payee.
    import(&db, &ent, &file(&[("card", "2026-10-05", "Wolt  order", "-8.00")]), None).await;
    assert_eq!(get_payee(&db, &ent, wolt_id).await.unwrap().lines, 3);

    // Split gives the alias, with its lines, back to the payee it came from.
    let back = split_payee(&db, &ent, wolt_id, &["wolt order".to_string()]).await.unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!((back[0].id, back[0].lines), (other, 2));
    assert_eq!(get_payee(&db, &ent, wolt_id).await.unwrap().lines, 1);
    // A payee keeps one alias.
    assert!(split_payee(&db, &ent, wolt_id, &["wolt".to_string()]).await.is_err());

    // A dismissed suggestion isn't offered again.
    let s = suggestions(&db, &ent, 50).await.unwrap();
    assert_eq!(s.len(), 1);
    dismiss_suggestion(&db, &ent, s[0].a.id, s[0].b.id).await.unwrap();
    assert!(suggestions(&db, &ent, 50).await.unwrap().is_empty());
}

#[tokio::test]
async fn old_lines_file_themselves_and_the_rest_waits() {
    let db = test_db("history").await;
    let ent = user(&db, 7).await;
    let r = import(
        &db,
        &ent,
        &file(&[
            ("card", "2025-01-10", "Lumen Bakery", "-4.00"),
            ("card", "2025-01-11", "Lumen Bakery", "-4.50"),
            ("fee", "2025-01-12", "Plan fee", "-7.99"),
            ("card", "2026-10-01", "Lumen Bakery", "-5.00"),
        ]),
        Some("2026-07-01"),
    )
    .await;
    // The fee files itself; the old bakery lines are unsorted history; the recent one waits.
    assert_eq!((r.history_unsorted, r.decisions, r.posted), (2, 1, 3));
    assert_eq!(drafts(&db, &ent).await, 1);
    let unsorted = list_payees(&db, &ent, PayeeFilter { unsorted: true, ..Default::default() }, 50, 0).await.unwrap();
    assert_eq!((unsorted.total, unsorted.payees[0].unsorted, unsorted.payees[0].unsorted_total_minor), (1, 2, -850));

    // Bulk categorising wants a narrowing filter.
    let eating = la(&db, &ent, "Eating out").await;
    let err = categorise_matching(&db, &ent, EntryFilter::default(), eating, false, &BulkOptions::default()).await;
    assert!(err.unwrap_err().is_invalid_input());

    // The first category for the payee also files its unsorted history.
    let recent = entry_ids(&db, &ent, unsorted.payees[0].id).await[0];
    let c = categorise(
        &db,
        &ent,
        recent,
        vec![Split { ledger_account_id: eating, amount_minor: -500, memo: None }],
        DefaultChoice::Once,
    )
    .await
    .unwrap();
    assert_eq!(c.payee_default.as_ref().unwrap().filed_history.len(), 2);
    assert_eq!(
        list_payees(&db, &ent, PayeeFilter { unsorted: true, ..Default::default() }, 50, 0).await.unwrap().total,
        0
    );
    // Undo makes it unsorted history again.
    let change = c.payee_default.unwrap();
    undo_default(&db, &ent, change.payee_id, None, None, &change.filed_drafts, &change.filed_history).await.unwrap();
    let f = EntryFilter { unsorted: Some(true), ..Default::default() };
    assert_eq!(list_entries(&db, &ent, f, 10, 0).await.unwrap().total, 2);
}

#[tokio::test]
async fn an_exchange_leg_moves_money_to_the_other_currency_balance() {
    let db = test_db("roundup").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-10-01".into(), "GBP".into(), 0.85)], "test").await.unwrap();
    let bytes = "Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n\
        card,Current,2026-10-01 12:00:00,2026-10-01 12:00:00,Corner Shop,-4.65,0.00,EUR,,,\n\
        exchange,Current,2026-10-01 12:01:00,2026-10-01 12:01:00,Exchanged to GBP,-0.35,0.00,EUR,,,GBP\n"
        .as_bytes();
    let create = |name: &str, cur: &str| AccountChoice::Create {
        create: NewAccount {
            kind: "current".into(),
            name: name.into(),
            institution: Some("Sample Bank".into()),
            currency: cur.into(),
        },
    };
    let map: HashMap<String, AccountChoice> = [
        ("sample:current:EUR".to_string(), create("Everyday", "EUR")),
        ("sample:current:GBP".to_string(), create("Pounds", "GBP")),
    ]
    .into();
    let r = import_file_with(&db, &ent, "s.csv", bytes, "sample", map, &opts(None), &|_| {}).await.unwrap();
    // The round-up is a move, booked and posted: only the shop waits.
    assert_eq!((r.created, r.paired, r.decisions, r.transfer_pair_ids.len()), (2, 1, 1, 1));
    let accounts = list_accounts(&db, &ent, true).await.unwrap();
    let pounds = accounts.iter().find(|a| a.name == "Pounds").unwrap();
    let everyday = accounts.iter().find(|a| a.name == "Everyday").unwrap();
    assert!(pounds.unconfirmed && !everyday.unconfirmed);
    // 0.35 EUR at 0.85 is 0.30 GBP, an estimate.
    assert_eq!(pounds.balance_minor, 30);
    let transfers = EntryFilter { transfers: Some(true), ..Default::default() };
    assert_eq!(list_entries(&db, &ent, transfers, 10, 0).await.unwrap().total, 2);
    // The import result's links: its transfers, and what it filed that isn't one.
    let of_import = |transfers| EntryFilter { import_batch_id: Some(r.batch_id), transfers, ..Default::default() };
    assert_eq!(list_entries(&db, &ent, of_import(Some(true)), 10, 0).await.unwrap().total, 1);
    assert_eq!(list_entries(&db, &ent, of_import(Some(false)), 10, 0).await.unwrap().total, 1);
    assert_eq!(list_entries(&db, &ent, of_import(None), 10, 0).await.unwrap().total, 2);

    // The pounds statement arrives: its line replaces the estimate, and the account is
    // confirmed.
    let gbp = "Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n\
        exchange,Current,2026-10-01 12:01:00,2026-10-01 12:01:00,Exchanged from EUR,0.29,0.00,GBP,,,\n"
        .as_bytes();
    let map: HashMap<String, AccountChoice> =
        [("sample:current:GBP".to_string(), AccountChoice::Existing(pounds.id))].into();
    let r = import_file_with(&db, &ent, "g.csv", gbp, "sample", map, &opts(None), &|_| {}).await.unwrap();
    assert_eq!((r.created, r.decisions), (1, 0));
    let pounds = list_accounts(&db, &ent, true).await.unwrap().into_iter().find(|a| a.name == "Pounds").unwrap();
    assert_eq!((pounds.unconfirmed, pounds.balance_minor), (false, 29));
    let estimates: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_entries WHERE notes = ?")
        .bind(crate::finance::pairing::FX_ESTIMATE_NOTE)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(estimates, 0);
    // The clearing account nets to zero; the difference is realised FX.
    let clearing = system_account(&db, &ent, crate::finance::system::TRANSFERS_CLEARING).await.unwrap().id;
    let on_clearing: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(functional_minor), 0) FROM fin_lines WHERE ledger_account_id = ?")
            .bind(clearing)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(on_clearing, 0);

    // "Not a transfer" puts both legs back in the inbox.
    let pair: i64 = sqlx::query_scalar("SELECT id FROM fin_pairs WHERE status = 'auto'").fetch_one(&db).await.unwrap();
    crate::finance::pairing::resolve_pair(&db, &ent, pair, false).await.unwrap();
    assert_eq!(drafts(&db, &ent).await, 3);
}

/// Takes a database back to how `main` leaves it: no payee tables or columns.
/// A database as `main` left it: no payee tables or columns. The job after startup builds
/// payees from the lines, learns defaults from the categories and from one-payee rules, and
/// posts the categorised drafts.
pub(super) async fn make_main_shaped(db: &Db) {
    for sql in [
        "DROP INDEX idx_fin_entries_payee",
        "DROP INDEX idx_fin_entries_unsorted",
        "ALTER TABLE fin_entries DROP COLUMN payee_id",
        "ALTER TABLE fin_entries DROP COLUMN payee_key",
        "ALTER TABLE fin_entries DROP COLUMN unsorted",
        "ALTER TABLE fin_source_lines DROP COLUMN payee_id",
        "ALTER TABLE fin_accounts DROP COLUMN unconfirmed",
        "ALTER TABLE fin_entities DROP COLUMN payees_learned",
        "DROP TABLE fin_payee_dismissed",
        "DROP TABLE fin_payee_aliases",
        "DROP TABLE fin_payees",
    ] {
        sqlx::query(sql).execute(db).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
}

#[tokio::test]
async fn the_migration_builds_payees_from_existing_books() {
    let db = test_db("migrate").await;
    let ent = user(&db, 7).await;
    import(
        &db,
        &ent,
        &file(&[
            ("card", "2026-09-01", "WOΛT", "-14.76"),
            ("card", "2026-09-02", "Wolt", "-9.10"),
            ("card", "2026-09-03", "WOLT*ORDER 128", "-22.00"),
            ("card", "2026-09-04", "Green Market", "-30.00"),
            ("card", "2026-09-05", "Green Market #2", "-31.00"),
            ("card", "2026-09-06", "Lumen Bakery", "-3.00"),
        ]),
        None,
    )
    .await;
    let (eating, groceries) = (la(&db, &ent, "Eating out").await, la(&db, &ent, "Groceries").await);
    // As main would have it: two Wolt lines categorised as drafts, a rule for Green Market.
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM fin_entries WHERE source_line_id IS NOT NULL ORDER BY id")
        .fetch_all(&db)
        .await
        .unwrap();
    for (id, amount) in [(ids[0], -1476), (ids[1], -910)] {
        crate::finance::categorise(
            &db,
            &ent,
            id,
            vec![Split { ledger_account_id: eating, amount_minor: amount, memo: None }],
        )
        .await
        .unwrap();
    }
    let rule = crate::finance::rules::RuleInput {
        position: None,
        conditions: crate::finance::rules::Conditions { payee: Some("green market".into()), ..Default::default() },
        action: crate::finance::rules::Action { ledger_account_id: Some(groceries), splits: vec![] },
        learned: false,
    };
    crate::finance::rules::create_rule(&db, &ent, rule).await.unwrap();
    let bakery_rule = crate::finance::rules::RuleInput {
        position: None,
        conditions: crate::finance::rules::Conditions {
            text: Some("bakery".into()),
            min_amount_minor: Some(-500),
            ..Default::default()
        },
        action: crate::finance::rules::Action { ledger_account_id: Some(eating), splits: vec![] },
        learned: false,
    };
    crate::finance::rules::create_rule(&db, &ent, bakery_rule).await.unwrap();
    sqlx::query("UPDATE fin_entries SET status = 'draft' WHERE source_line_id IS NOT NULL").execute(&db).await.unwrap();
    make_main_shaped(&db).await;
    crate::finance::schema::migrate(&db).await.unwrap();
    // The migration only changes the schema; the job after startup does the rest.
    assert_eq!(preparing(&db, &ent).await.unwrap(), Some((0, 6)));
    let quick = BackfillOptions { pause: std::time::Duration::ZERO, ..Default::default() };
    backfill(&db, &quick).await.unwrap();
    backfill(&db, &quick).await.unwrap(); // twice changes nothing
    assert_eq!(preparing(&db, &ent).await.unwrap(), None);

    let page = list_payees(&db, &ent, PayeeFilter::default(), 50, 0).await.unwrap();
    assert_eq!(page.total, 3, "{:?}", page.payees.iter().map(|p| &p.name).collect::<Vec<_>>());
    let wolt = payee_named(&db, &ent, "wolt").await;
    assert_eq!((wolt.lines, wolt.default_ledger_account_id), (3, Some(eating)));
    // The text-only rule for one payee gave it its default (and stays, for an older build);
    // the one with an amount bound gave nothing.
    let market = payee_named(&db, &ent, "green market").await;
    assert_eq!(market.default_ledger_account_id, Some(groceries));
    assert_eq!(payee_named(&db, &ent, "bakery").await.default_ledger_account_id, None);
    assert_eq!(crate::finance::rules::list_rules(&db, &ent).await.unwrap().len(), 2);
    // The two categorised drafts posted; the rest wait, and tidying files the defaults.
    assert_eq!(drafts(&db, &ent).await, 4);
    let dry = tidy_inbox(&db, &ent, None, true).await.unwrap();
    assert_eq!((dry.filed, dry.history, dry.left), (3, 0, 1));
    let done = tidy_inbox(&db, &ent, None, false).await.unwrap();
    assert_eq!((done.filed, done.left), (3, 1));
}

#[tokio::test]
async fn another_users_payees_are_not_found() {
    let db = test_db("private").await;
    let mia = user(&db, 7).await;
    let ana = user(&db, 8).await;
    import(&db, &mia, &file(&[("card", "2026-10-01", "Wolt", "-1.00"), ("card", "2026-10-02", "Bolt", "-1.00")]), None)
        .await;
    let wolt = payee_named(&db, &mia, "wolt").await;
    let bolt = payee_named(&db, &mia, "bolt").await;
    assert!(get_payee(&db, &ana, wolt.id).await.unwrap_err().is_not_found());
    assert!(update_payee(&db, &ana, wolt.id, PayeePatch::default()).await.unwrap_err().is_not_found());
    assert!(merge_payees(&db, &ana, wolt.id, &[bolt.id]).await.unwrap_err().is_not_found());
    assert!(set_default(&db, &ana, wolt.id, None, false).await.unwrap_err().is_not_found());
    assert_eq!(list_payees(&db, &ana, PayeeFilter::default(), 50, 0).await.unwrap().total, 0);
}

#[tokio::test]
async fn a_draft_carries_its_groups_waiting_suggestion() {
    let db = test_db("draft_suggestion").await;
    let ent = user(&db, 1).await;
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    import(&db, &ent, &file(&[("card", &today, "Corner Shop", "-4.20")]), None).await;
    crate::finance::inbox::summary(&db, &ent).await.unwrap(); // fills the group keys
    let f = EntryFilter { status: Some("draft".into()), ..Default::default() };
    let draft = list_entries(&db, &ent, f.clone(), 1, 0).await.unwrap().entries.remove(0);
    assert_eq!(draft.suggested_ledger_account_id, None);
    assert_eq!(draft.payee_name.as_deref(), Some("Corner Shop"));
    let eating = la(&db, &ent, "Eating out").await;
    sqlx::query(
        "INSERT INTO fin_group_suggestions (entity_id, group_key, ledger_account_id, created_at) \
         SELECT entity_id, group_key, ?, '' FROM fin_entries WHERE id = ?",
    )
    .bind(eating)
    .bind(draft.id)
    .execute(&db)
    .await
    .unwrap();
    let draft = list_entries(&db, &ent, f, 1, 0).await.unwrap().entries.remove(0);
    assert_eq!(draft.suggested_ledger_account_id, Some(eating));
}

#[tokio::test]
async fn by_payee_is_one_row_per_payee_with_a_tidy_name() {
    let db = test_db("groups").await;
    let ent = user(&db, 7).await;
    import(
        &db,
        &ent,
        &file(&[
            ("card", "2026-10-01", "CORNER BAKERY*ORDER 102", "-4.00"),
            ("card", "2026-10-02", "Corner Bakery", "-3.00"),
            ("card", "2026-10-03", "GOLDEN BAKERY", "-5.00"),
            ("transfer", "2026-10-04", "Rent 2026-10", "-500.00"),
        ]),
        None,
    )
    .await;
    let page = crate::finance::inbox::inbox_groups(&db, &ent, EntryFilter::default(), 50, 0).await.unwrap();
    let rows: Vec<(String, i64)> = page.groups.iter().map(|g| (g.label.clone(), g.count)).collect();
    // The first spelling named the payee, title-cased; a line without a payee keeps its text key.
    assert_eq!(page.total_groups, 3, "{rows:?}");
    assert!(rows.contains(&("Corner Bakery".to_string(), 2)), "{rows:?}");
    assert!(rows.contains(&("Golden Bakery".to_string(), 1)), "{rows:?}");
    let corner = page.groups.iter().find(|g| g.label == "Corner Bakery").unwrap();
    assert!(corner.key.starts_with("out:#"));
    // Filing the group files both spellings, with a rule offered on the payee's name.
    let eating = la(&db, &ent, "Eating out").await;
    let f = EntryFilter { group_key: Some(corner.key.clone()), ..Default::default() };
    let r = categorise_matching(&db, &ent, f, eating, false, &BulkOptions::default()).await.unwrap();
    assert_eq!(r.categorised, 2);
    assert_eq!(r.rule_input.unwrap().conditions.payee.as_deref(), Some("*corner*bakery*"));
    // A merge regroups: the merged payee's lines join the target's row.
    let golden = payee_named(&db, &ent, "golden").await;
    let rent = import(&db, &ent, &file(&[("card", "2026-10-05", "GOLDEN BAKERY", "-6.00")]), None).await;
    assert_eq!(rent.decisions, 1);
    let renamed = update_payee(&db, &ent, golden.id, PayeePatch { name: Some("GB".into()), ..Default::default() });
    assert_eq!(renamed.await.unwrap().name, "GB");
}

#[tokio::test]
async fn bank_capitals_are_retitled_once_unless_renamed() {
    let db = test_db("retitle").await;
    let ent = user(&db, 7).await;
    for (name, renamed) in [("GOLDEN GRILL", 0), ("NORTH SHOP", 1), ("Lumen Cafe", 0)] {
        sqlx::query("INSERT INTO fin_payees (entity_id, name, renamed, created_at) VALUES (?, ?, ?, ?)")
            .bind(ent.id)
            .bind(name)
            .bind(renamed)
            .bind(now())
            .execute(&db)
            .await
            .unwrap();
    }
    // A database from before the column: every name is retitled once…
    sqlx::query("ALTER TABLE fin_payees DROP COLUMN renamed").execute(&db).await.unwrap();
    crate::finance::schema::migrate(&db).await.unwrap();
    let names = |db: Db| async move {
        sqlx::query_scalar::<_, String>("SELECT name FROM fin_payees ORDER BY id").fetch_all(&db).await.unwrap()
    };
    assert_eq!(names(db.clone()).await, ["Golden Grill", "North Shop", "Lumen Cafe"]);
    // …and a rename is never overwritten afterwards.
    let id: i64 =
        sqlx::query_scalar("SELECT id FROM fin_payees WHERE name = 'North Shop'").fetch_one(&db).await.unwrap();
    update_payee(&db, &ent, id, PayeePatch { name: Some("NORTH SHOP".into()), ..Default::default() }).await.unwrap();
    crate::finance::schema::migrate(&db).await.unwrap();
    assert_eq!(names(db.clone()).await[1], "NORTH SHOP");
}

#[tokio::test]
async fn a_line_is_a_move_to_my_own_account_by_my_say_so() {
    let db = test_db("say_so").await;
    let ent = user(&db, 7).await;
    import(&db, &ent, &file(&[("transfer", "2026-10-01", "Transfer to Savings", "-100.00")]), None).await;
    let line: i64 =
        sqlx::query_scalar("SELECT id FROM fin_entries WHERE source_line_id IS NOT NULL").fetch_one(&db).await.unwrap();
    let to = TransferTo::New { create: NewMoveAccount { name: "Savings".into(), kind: None, institution: None } };
    let c = categorise_move(&db, &ent, line, to, DefaultChoice::Once).await.unwrap();
    assert_eq!((c.entry.status.as_str(), c.entry.pair.as_ref().map(|p| p.status.as_str())), ("posted", Some("auto")));
    let savings = list_accounts(&db, &ent, true).await.unwrap().into_iter().find(|a| a.name == "Savings").unwrap();
    assert!(savings.unconfirmed && savings.kind == "savings");
    assert_eq!(savings.balance_minor, 10_000);
    let change = c.payee_default.unwrap();
    assert_eq!((change.account_id, change.ledger_account_id), (Some(savings.id), None));
    assert_eq!(drafts(&db, &ent).await, 0);
    let transfers = EntryFilter { transfers: Some(true), ..Default::default() };
    assert_eq!(list_entries(&db, &ent, transfers.clone(), 10, 0).await.unwrap().total, 2);

    // Next week's line files itself by the payee's default.
    let r = import(&db, &ent, &file(&[("transfer", "2026-10-08", "Transfer to Savings", "-50.00")]), None).await;
    assert_eq!((r.filed_by_payee, r.decisions), (1, 0));
    assert_eq!(list_entries(&db, &ent, transfers, 10, 0).await.unwrap().total, 4);

    // The savings statement arrives: its line takes over the written side, and confirms it.
    let map: HashMap<String, AccountChoice> =
        [("sample:savings:EUR".to_string(), AccountChoice::Existing(savings.id))].into();
    let bytes = "Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n\
        transfer,Savings,2026-10-01 09:00:00,2026-10-01 10:00:00,From Everyday,100.00,0.00,EUR,,,\n"
        .as_bytes();
    let r = import_file_with(&db, &ent, "s.csv", bytes, "sample", map, &opts(None), &|_| {}).await.unwrap();
    assert_eq!((r.created, r.duplicates, r.decisions), (0, 1, 0));
    let savings = list_accounts(&db, &ent, true).await.unwrap().into_iter().find(|a| a.name == "Savings").unwrap();
    assert!(!savings.unconfirmed);

    // "Not a transfer" undoes one; Undo of the default puts the filed move back too.
    let pair = c.entry.pair.unwrap().id;
    crate::finance::pairing::resolve_pair(&db, &ent, pair, false).await.unwrap();
    assert_eq!(drafts(&db, &ent).await, 2, "both sides are real lines now: both wait");
    let undone = undo_default(&db, &ent, change.payee_id, None, None, &change.filed_drafts, &[]).await.unwrap();
    assert_eq!(undone.default_account_id, None);
}

#[tokio::test]
async fn splitting_keeps_the_name_the_user_gave() {
    let db = test_db("split_names").await;
    let ent = user(&db, 7).await;
    import(
        &db,
        &ent,
        &file(&[
            ("card", "2026-10-01", "Harbor Cafe", "-4.00"),
            ("card", "2026-10-02", "Harbor Cafe", "-4.00"),
            ("card", "2026-10-03", "Harbor Cafe Kiosk", "-3.00"),
            ("card", "2026-10-04", "Delta Kiosk Ltd", "-2.00"),
            ("card", "2026-10-05", "Delta Kiosk", "-2.00"),
        ]),
        None,
    )
    .await;
    // H4: a legal-form ending makes no new payee.
    assert_eq!(payee_named(&db, &ent, "delta").await.lines, 2);
    let (cafe, kiosk) = (by_key(&db, "harbor cafe").await, by_key(&db, "harbor cafe kiosk").await);
    merge_payees(&db, &ent, cafe, &[kiosk]).await.unwrap();
    update_payee(&db, &ent, cafe, PayeePatch { name: Some("Harbour Cafe".into()), ..Default::default() })
        .await
        .unwrap();
    let off = split_payee(&db, &ent, cafe, &["harbor cafe kiosk".to_string()]).await.unwrap();
    assert_eq!((off[0].name.as_str(), off[0].lines), ("Harbor Cafe Kiosk", 1));
    let kept = get_payee(&db, &ent, cafe).await.unwrap();
    assert_eq!((kept.name.as_str(), kept.lines), ("Harbour Cafe", 2));
}

#[tokio::test]
async fn unsorted_history_dates_by_its_own_lines() {
    let db = test_db("unsorted_dates").await;
    let ent = user(&db, 7).await;
    import(
        &db,
        &ent,
        &file(&[("card", "2025-01-10", "Lumen Bakery", "-4.00"), ("card", "2026-10-01", "Lumen Bakery", "-5.00")]),
        Some("2026-07-01"),
    )
    .await;
    let page = list_payees(&db, &ent, PayeeFilter { unsorted: true, ..Default::default() }, 10, 0).await.unwrap();
    assert_eq!(page.payees[0].last_date.as_deref(), Some("2025-01-10"));
    let all = list_payees(&db, &ent, PayeeFilter::default(), 10, 0).await.unwrap();
    assert_eq!(all.payees[0].last_date.as_deref(), Some("2026-10-01"));
}

#[tokio::test]
async fn a_new_rule_files_waiting_lines_and_a_move_needs_another_account() {
    let db = test_db("rule_files").await;
    let ent = user(&db, 7).await;
    import(&db, &ent, &file(&[("card", "2026-10-01", "Opal Oil Co", "-40.00")]), None).await;
    assert_eq!(drafts(&db, &ent).await, 1);
    let travel = la(&db, &ent, "Travel").await;
    let rule = crate::finance::rules::RuleInput {
        position: None,
        conditions: crate::finance::rules::Conditions { text: Some("opal oil".into()), ..Default::default() },
        action: crate::finance::rules::Action { ledger_account_id: Some(travel), splits: vec![] },
        learned: false,
    };
    crate::finance::rules::create_rule(&db, &ent, rule).await.unwrap();
    // Categorised means done: the line leaves To sort, and the rule counts it.
    assert_eq!(crate::finance::rules::apply_rules(&db, &ent, None).await.unwrap(), 1);
    assert_eq!(drafts(&db, &ent).await, 0);
    assert_eq!(crate::finance::rules::list_rules(&db, &ent).await.unwrap()[0].hits, 1);

    // A move to the line's own account is refused, plainly.
    let line: i64 =
        sqlx::query_scalar("SELECT id FROM fin_entries WHERE source_line_id IS NOT NULL").fetch_one(&db).await.unwrap();
    let own = list_accounts(&db, &ent, true).await.unwrap()[0].id;
    let err = categorise_move(&db, &ent, line, TransferTo::Existing { account_id: own }, DefaultChoice::Once).await;
    assert!(err.unwrap_err().to_string().contains("already in that account"));
}
