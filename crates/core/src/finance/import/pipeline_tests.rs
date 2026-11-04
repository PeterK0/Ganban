//! The import pipeline on a throwaway database, with made-up files.

use std::collections::HashMap;

use super::pipeline::*;
use crate::finance::rules::{create_rule, suggest_rule, Action, Conditions, RuleInput};
use crate::finance::*;
use crate::Db;

async fn test_db(tag: &str) -> Db {
    let path = std::env::temp_dir().join(format!("ganban_fimport_{}_{}.db", std::process::id(), tag));
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
    entity_for_user(db, id).await.unwrap()
}

async fn la(db: &Db, ent: &Entity, name: &str) -> i64 {
    list_ledger_accounts(db, ent, true).await.unwrap().into_iter().find(|a| a.name == name).unwrap().id
}

async fn sys_la(db: &Db, ent: &Entity, key: &str) -> i64 {
    system_account(db, ent, key).await.unwrap().id
}

/// The functional balance of a ledger account across the entity's entries.
async fn ledger_sum(db: &Db, ent: &Entity, la: i64) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(l.functional_minor), 0) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id \
         WHERE e.entity_id = ? AND l.ledger_account_id = ?",
    )
    .bind(ent.id)
    .bind(la)
    .fetch_one(db)
    .await
    .unwrap()
}

const HEADER: &str = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

fn revolut(lines: &[&str]) -> Vec<u8> {
    let mut s = HEADER.to_string();
    for l in lines {
        s.push_str(l);
        s.push('\n');
    }
    s.into_bytes()
}

fn create(kind: &str, name: &str, currency: &str) -> AccountChoice {
    AccountChoice::Create {
        create: NewAccount { kind: kind.into(), name: name.into(), institution: Some("Revolut".into()), currency: currency.into() },
    }
}

fn map(pairs: Vec<(&str, AccountChoice)>) -> HashMap<String, AccountChoice> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

async fn account_id(db: &Db, ent: &Entity, name: &str) -> i64 {
    list_accounts(db, ent, true).await.unwrap().into_iter().find(|a| a.name == name).unwrap().id
}

async fn entries_of(db: &Db, ent: &Entity, account: i64) -> Vec<Entry> {
    let f = EntryFilter { account_id: Some(account), ..Default::default() };
    list_entries(db, ent, f, 100, 0).await.unwrap().entries
}

fn counter(e: &Entry, la: i64) -> bool {
    e.lines.iter().any(|l| l.ledger_account_id == la)
}

const CARD: &str = "Card Payment,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Green Market,-20.00,0.00,EUR,COMPLETED,980.00";
const POCKET: &str = "Transfer,Current,2026-10-02 09:00:00,2026-10-02 09:00:00,To EUR Holiday,-50.00,0.00,EUR,COMPLETED,930.00";

#[tokio::test]
async fn importing_twice_adds_nothing() {
    let db = test_db("twice").await;
    let ent = user(&db, 7).await;
    let file = revolut(&[CARD, POCKET]);
    let m = || map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR")), ("revolut:pocket:holiday:EUR", create("savings", "Holiday", "EUR"))]);
    let first = import_file(&db, &ent, "statement.csv", &file, "revolut", m()).await.unwrap();
    assert_eq!((first.created, first.duplicates), (2, 0));
    let everyday = account_id(&db, &ent, "Everyday").await;
    // The opening balance comes from the running balance before the first line.
    let a = list_accounts(&db, &ent, false).await.unwrap().into_iter().find(|a| a.id == everyday).unwrap();
    assert_eq!(a.balance_minor + a.draft_balance_minor, 93_000);

    let holiday = account_id(&db, &ent, "Holiday").await;
    let again = map(vec![("revolut:current:EUR", AccountChoice::Existing(everyday)), ("revolut:pocket:holiday:EUR", AccountChoice::Existing(holiday))]);
    let second = import_file(&db, &ent, "statement.csv", &file, "revolut", again).await.unwrap();
    assert_eq!((second.created, second.duplicates, second.paired), (0, 2, 0));
    assert_eq!(entries_of(&db, &ent, everyday).await.len(), 3, "opening + two lines");
}

#[tokio::test]
async fn a_pocket_move_nets_to_zero_in_clearing() {
    let db = test_db("pocket").await;
    let ent = user(&db, 7).await;
    let m = map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR")), ("revolut:pocket:holiday:EUR", create("savings", "Holiday", "EUR"))]);
    let r = import_file(&db, &ent, "s.csv", &revolut(&[POCKET]), "revolut", m).await.unwrap();
    assert_eq!((r.created, r.paired, r.review), (1, 1, 0));
    let clearing = sys_la(&db, &ent, system::TRANSFERS_CLEARING).await;
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);
    let holiday = account_id(&db, &ent, "Holiday").await;
    let side = entries_of(&db, &ent, holiday).await;
    let written = side.iter().find(|e| e.source_line_id.is_none() && e.notes.as_deref() == Some(crate::finance::pairing::COUNTERPART_NOTE)).unwrap();
    assert!(counter(written, clearing));
    assert_eq!(written.pair.as_ref().unwrap().status, "auto");

    // The pocket's own export arrives later: its line takes over the written side.
    let pocket_file = revolut(&["Transfer,Savings,2026-10-02 09:00:00,2026-10-02 09:00:00,From EUR Everyday,50.00,0.00,EUR,COMPLETED,"]);
    let r = import_file(&db, &ent, "p.csv", &pocket_file, "revolut", map(vec![("revolut:savings:EUR", AccountChoice::Existing(holiday))]))
        .await
        .unwrap();
    assert_eq!((r.created, r.duplicates), (0, 1));
    let side = entries_of(&db, &ent, holiday).await;
    assert!(side.iter().any(|e| e.id == written.id && e.source_line_id.is_some() && e.notes.is_none()));
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);

    // Rejecting the pair undoes it: the move is uncategorised again.
    let pair = written.pair.as_ref().unwrap().id;
    let p = crate::finance::pairing::resolve_pair(&db, &ent, pair, false).await.unwrap();
    assert_eq!(p.status, "rejected");
    let unc = sys_la(&db, &ent, system::UNCATEGORISED_EXPENSE).await;
    let everyday = account_id(&db, &ent, "Everyday").await;
    assert!(entries_of(&db, &ent, everyday).await.iter().any(|e| e.source_line_id.is_some() && counter(e, unc)));
}

#[tokio::test]
async fn an_fx_pair_posts_its_difference() {
    let db = test_db("fx").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-10-01".into(), "GBP".into(), 0.85)], "test").await.unwrap();
    let file = revolut(&[
        "Exchange,Current,2026-10-01 12:00:00,2026-10-01 12:00:00,Exchanged to GBP,-10.00,0.00,EUR,COMPLETED,",
        "Exchange,Current,2026-10-01 12:00:01,2026-10-01 12:00:01,Exchanged to GBP,8.61,0.00,GBP,COMPLETED,",
    ]);
    let m = map(vec![("revolut:current:EUR", create("current", "Euro", "EUR")), ("revolut:current:GBP", create("current", "Pounds", "GBP"))]);
    let r = import_file(&db, &ent, "fx.csv", &file, "revolut", m).await.unwrap();
    assert_eq!((r.created, r.paired, r.review), (2, 1, 0));
    // 8.61 GBP at 0.85 is 10.13 EUR for 10.00 EUR given: a 0.13 realised gain.
    let clearing = sys_la(&db, &ent, system::TRANSFERS_CLEARING).await;
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);
    assert_eq!(ledger_sum(&db, &ent, sys_la(&db, &ent, system::FX_REALISED_GAIN).await).await, -13);
    let pairs = crate::finance::pairing::list_pairs(&db, &ent, None).await.unwrap();
    assert_eq!((pairs[0].kind.as_str(), pairs[0].status.as_str()), ("fx", "auto"));
    assert!(pairs[0].adjust_entry_id.is_some());
}

#[tokio::test]
async fn a_refund_goes_to_the_original_category() {
    let db = test_db("refund").await;
    let ent = user(&db, 7).await;
    let m = map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR"))]);
    import_file(&db, &ent, "a.csv", &revolut(&[CARD]), "revolut", m).await.unwrap();
    let everyday = account_id(&db, &ent, "Everyday").await;
    let groceries = la(&db, &ent, "Groceries").await;
    let card = entries_of(&db, &ent, everyday).await.into_iter().find(|e| e.source_line_id.is_some()).unwrap();
    categorise(&db, &ent, card.id, vec![Split { ledger_account_id: groceries, amount_minor: -2_000, memo: None }]).await.unwrap();

    let refund = revolut(&["Card Refund,Current,2026-10-05 09:00:00,2026-10-05 10:00:00,Green Market,5.00,0.00,EUR,COMPLETED,"]);
    let r = import_file(&db, &ent, "b.csv", &refund, "revolut", map(vec![("revolut:current:EUR", AccountChoice::Existing(everyday))]))
        .await
        .unwrap();
    assert_eq!((r.created, r.refunds), (1, 1));
    let back = entries_of(&db, &ent, everyday).await.into_iter().find(|e| e.date == "2026-10-05").unwrap();
    assert!(counter(&back, groceries));
    // The refund on the expense's category isn't a second identical fix.
    assert_eq!(suggest_rule(&db, &ent, back.id).await.unwrap(), None);
}

#[tokio::test]
async fn a_line_in_a_closed_month_is_skipped_with_a_warning() {
    let db = test_db("closed_month").await;
    let ent = user(&db, 7).await;
    sqlx::query("INSERT INTO fin_periods (entity_id, month, status, closed_at) VALUES (?, '2026-10', 'closed', ?)")
        .bind(ent.id)
        .bind(now())
        .execute(&db)
        .await
        .unwrap();
    let october = "Card Payment,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Green Market,-20.00,0.00,EUR,COMPLETED,";
    let file = revolut(&[october, "Card Payment,Current,2026-11-02 09:00:00,2026-11-02 10:00:00,Green Market,-3.00,0.00,EUR,COMPLETED,"]);
    let r = import_file(&db, &ent, "c.csv", &file, "revolut", map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR"))]))
        .await
        .unwrap();
    assert_eq!(r.created, 1);
    assert!(r.warnings.iter().any(|w| w == "1 lines skipped: they fall in a closed month"), "{:?}", r.warnings);
}

#[tokio::test]
async fn a_fee_line_lands_on_bank_fees() {
    let db = test_db("fee_kind").await;
    let ent = user(&db, 7).await;
    let file = revolut(&["Fee,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Plan fee,-7.99,0.00,EUR,COMPLETED,"]);
    import_file(&db, &ent, "f.csv", &file, "revolut", map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR"))]))
        .await
        .unwrap();
    let everyday = account_id(&db, &ent, "Everyday").await;
    let fee = entries_of(&db, &ent, everyday).await.into_iter().find(|e| e.source_line_id.is_some()).unwrap();
    assert!(counter(&fee, sys_la(&db, &ent, crate::finance::system::BANK_FEES).await));
}

#[tokio::test]
async fn a_rule_categorises_and_a_second_fix_suggests_one() {
    let db = test_db("rules").await;
    let ent = user(&db, 7).await;
    let groceries = la(&db, &ent, "Groceries").await;
    let transport = la(&db, &ent, "Transport").await;
    create_rule(
        &db,
        &ent,
        RuleInput {
            position: None,
            conditions: Conditions { text: Some("market".into()), ..Default::default() },
            action: Action { ledger_account_id: Some(groceries), splits: vec![] },
            learned: false,
        },
    )
    .await
    .unwrap();
    let file = revolut(&[
        CARD,
        "Card Payment,Current,2026-10-03 09:00:00,2026-10-03 10:00:00,City Bus 0412,-2.00,0.00,EUR,COMPLETED,",
        "Card Payment,Current,2026-10-04 09:00:00,2026-10-04 10:00:00,City Bus 0977,-2.00,0.00,EUR,COMPLETED,",
    ]);
    let r = import_file(&db, &ent, "a.csv", &file, "revolut", map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR"))]))
        .await
        .unwrap();
    assert_eq!((r.created, r.categorised_by_rules), (3, 1));
    let everyday = account_id(&db, &ent, "Everyday").await;
    let all = entries_of(&db, &ent, everyday).await;
    assert!(counter(all.iter().find(|e| e.date == "2026-10-01").unwrap(), groceries));

    let bus: Vec<&Entry> = all.iter().filter(|e| e.description.starts_with("City Bus")).collect();
    let fix = |id| categorise(&db, &ent, id, vec![Split { ledger_account_id: transport, amount_minor: -200, memo: None }]);
    fix(bus[0].id).await.unwrap();
    assert_eq!(suggest_rule(&db, &ent, bus[0].id).await.unwrap(), None, "one fix is not a habit");
    fix(bus[1].id).await.unwrap();
    let rule = suggest_rule(&db, &ent, bus[1].id).await.unwrap().expect("second identical fix");
    assert_eq!(rule.action.ledger_account_id, Some(transport));
    assert!(rule.learned);
    // The suggestion is fin_create_rule's input; once saved, it's not offered again.
    let json = serde_json::to_value(&rule).unwrap();
    let input: RuleInput = serde_json::from_value(json).unwrap();
    create_rule(&db, &ent, input).await.unwrap();
    assert_eq!(suggest_rule(&db, &ent, bus[1].id).await.unwrap(), None);
}

#[tokio::test]
async fn an_uncertain_transfer_waits_for_review() {
    let db = test_db("review").await;
    let ent = user(&db, 7).await;
    let file = revolut(&[CARD, "Transfer,Savings,2026-10-01 11:00:00,2026-10-01 11:00:00,Payment from Alex,20.00,0.00,EUR,COMPLETED,"]);
    let m = map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR")), ("revolut:savings:EUR", create("savings", "Savings", "EUR"))]);
    let r = import_file(&db, &ent, "a.csv", &file, "revolut", m).await.unwrap();
    assert_eq!((r.paired, r.review), (0, 1));
    let pairs = crate::finance::pairing::list_pairs(&db, &ent, Some("review")).await.unwrap();
    let clearing = sys_la(&db, &ent, system::TRANSFERS_CLEARING).await;
    assert!(!counter(&pairs[0].entry_a, clearing), "untouched until accepted");
    let p = crate::finance::pairing::resolve_pair(&db, &ent, pairs[0].id, true).await.unwrap();
    assert_eq!(p.status, "confirmed");
    assert!(counter(&p.entry_a, clearing) && counter(&p.entry_b, clearing));
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);
}

#[tokio::test]
async fn another_users_account_is_not_found() {
    let db = test_db("others").await;
    let mia = user(&db, 7).await;
    let ana = user(&db, 8).await;
    let hers = create_account(
        &db,
        &ana,
        FinAccountInput {
            kind: "current".into(),
            name: "Ana's".into(),
            institution: None,
            currency: "EUR".into(),
            iban_mask: None,
            profile_key: None,
            opening_balance_minor: None,
            opening_date: None,
        },
    )
    .await
    .unwrap();
    let err = import_file(&db, &mia, "a.csv", &revolut(&[CARD]), "revolut", map(vec![("revolut:current:EUR", AccountChoice::Existing(hers.id))]))
        .await
        .unwrap_err();
    assert!(err.is_not_found(), "{err}");
    assert!(entries_of(&db, &ana, hers.id).await.is_empty());
}

#[tokio::test]
async fn preview_matches_known_accounts_and_profiles_round_trip() {
    let db = test_db("preview").await;
    let ent = user(&db, 7).await;
    let file = revolut(&[CARD]);
    let p = preview(&db, &ent, &file, None).await.unwrap();
    assert_eq!(p.accounts[0].matched_account_id, None);
    import_file(&db, &ent, "a.csv", &file, "revolut", map(vec![("revolut:current:EUR", create("current", "Revolut Current (EUR)", "EUR"))]))
        .await
        .unwrap();
    let p = preview(&db, &ent, &file, None).await.unwrap();
    assert!(p.accounts[0].matched_account_id.is_some());

    let mapping: super::Mapping =
        serde_json::from_value(serde_json::json!({ "bookedDate": "Datum", "description": ["Text"], "amount": "Betrag" })).unwrap();
    save_profile(&db, &ent, ProfileInput { key: "mybank".into(), name: "My bank".into(), mapping }).await.unwrap();
    let keys: Vec<String> = list_profiles(&db, &ent).await.unwrap().into_iter().map(|p| p.key).collect();
    assert_eq!(keys, ["revolut", "piraeus", "mybank"]);
    let csv = "Datum;Text;Betrag\n01.10.2026;Bakery;-3,20\n";
    let p = preview(&db, &ent, csv.as_bytes(), Some("mybank")).await.unwrap();
    assert_eq!(p.rows[0].amount_minor, -320);
    assert!(save_profile(&db, &ent, ProfileInput { key: "revolut".into(), name: "x".into(), mapping: Default::default() }).await.is_err());
    delete_profile(&db, &ent, "mybank").await.unwrap();
    assert!(delete_profile(&db, &ent, "mybank").await.unwrap_err().is_not_found());
    assert!(preview(&db, &ent, csv.as_bytes(), Some("mybank")).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn rejecting_a_fresh_pocket_move_deletes_the_written_side() {
    let db = test_db("reject_fresh").await;
    let ent = user(&db, 7).await;
    let m = map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR")), ("revolut:pocket:holiday:EUR", create("savings", "Holiday", "EUR"))]);
    import_file(&db, &ent, "s.csv", &revolut(&[POCKET]), "revolut", m).await.unwrap();
    let pair = crate::finance::pairing::list_pairs(&db, &ent, None).await.unwrap().remove(0);
    let p = crate::finance::pairing::resolve_pair(&db, &ent, pair.id, false).await.unwrap();
    assert_eq!(p.status, "rejected");
    let holiday = account_id(&db, &ent, "Holiday").await;
    assert!(entries_of(&db, &ent, holiday).await.is_empty(), "the written side is gone");
    let clearing = sys_la(&db, &ent, system::TRANSFERS_CLEARING).await;
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);
    let everyday = account_id(&db, &ent, "Everyday").await;
    let unc = sys_la(&db, &ent, system::UNCATEGORISED_EXPENSE).await;
    assert!(entries_of(&db, &ent, everyday).await.iter().any(|e| e.source_line_id.is_some() && counter(e, unc)));
}

#[tokio::test]
async fn a_rule_on_a_transfer_leg_doesnt_stop_the_pairing() {
    let db = test_db("rule_transfer").await;
    let ent = user(&db, 7).await;
    let shopping = la(&db, &ent, "Shopping").await;
    let rule = RuleInput {
        position: None,
        conditions: Conditions { text: Some("holiday".into()), ..Default::default() },
        action: Action { ledger_account_id: Some(shopping), splits: vec![] },
        learned: false,
    };
    create_rule(&db, &ent, rule).await.unwrap();
    let m = map(vec![("revolut:current:EUR", create("current", "Everyday", "EUR")), ("revolut:pocket:holiday:EUR", create("savings", "Holiday", "EUR"))]);
    let r = import_file(&db, &ent, "s.csv", &revolut(&[POCKET]), "revolut", m).await.unwrap();
    assert_eq!((r.paired, r.categorised_by_rules), (1, 0));
    assert_eq!(ledger_sum(&db, &ent, shopping).await, 0);
}

#[tokio::test]
async fn rejecting_an_fx_pair_removes_its_adjustment() {
    let db = test_db("fx_reject").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-10-01".into(), "GBP".into(), 0.85)], "test").await.unwrap();
    let file = revolut(&[
        "Exchange,Current,2026-10-01 12:00:00,2026-10-01 12:00:00,Exchanged to GBP,-10.00,0.00,EUR,COMPLETED,",
        "Exchange,Current,2026-10-01 12:00:01,2026-10-01 12:00:01,Exchanged to GBP,8.61,0.00,GBP,COMPLETED,",
    ]);
    let m = map(vec![("revolut:current:EUR", create("current", "Euro", "EUR")), ("revolut:current:GBP", create("current", "Pounds", "GBP"))]);
    import_file(&db, &ent, "fx.csv", &file, "revolut", m).await.unwrap();
    let pair = crate::finance::pairing::list_pairs(&db, &ent, None).await.unwrap().remove(0);
    let adjust = pair.adjust_entry_id.unwrap();
    let p = crate::finance::pairing::resolve_pair(&db, &ent, pair.id, false).await.unwrap();
    assert_eq!((p.status.as_str(), p.adjust_entry_id), ("rejected", None));
    assert!(get_entry(&db, &ent, adjust).await.unwrap_err().is_not_found());
    let clearing = sys_la(&db, &ent, system::TRANSFERS_CLEARING).await;
    assert_eq!(ledger_sum(&db, &ent, clearing).await, 0);
    assert_eq!(ledger_sum(&db, &ent, sys_la(&db, &ent, system::FX_REALISED_GAIN).await).await, 0);
}
