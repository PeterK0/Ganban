//! Ledger tests on a throwaway database, with made-up accounts and amounts.

use super::*;

pub(super) async fn test_db(tag: &str) -> Db {
    let path = std::env::temp_dir().join(format!("ganban_finance_{}_{}.db", std::process::id(), tag));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    crate::init_db(&path).await.unwrap()
}

pub(super) async fn user(db: &Db, id: i64) -> Entity {
    sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
        .bind(id)
        .bind(format!("user{id}"))
        .bind(format!("User {id}"))
        .execute(db)
        .await
        .unwrap();
    entity_for_user(db, id).await.unwrap()
}

pub(super) fn account(kind: &str, name: &str, currency: &str, opening: i64) -> FinAccountInput {
    FinAccountInput {
        kind: kind.into(),
        name: name.into(),
        institution: Some("Testbank".into()),
        currency: currency.into(),
        iban_mask: None,
        profile_key: None,
        opening_balance_minor: Some(opening),
        opening_date: Some("2026-01-01".into()),
    }
}

pub(super) async fn la(db: &Db, ent: &Entity, name: &str) -> i64 {
    list_ledger_accounts(db, ent, true).await.unwrap().into_iter().find(|a| a.name == name).unwrap().id
}

async fn audit_count(db: &Db, ent: &Entity, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM fin_audit WHERE entity_id = ? AND action = ?")
        .bind(ent.id)
        .bind(action)
        .fetch_one(db)
        .await
        .unwrap()
}

fn draft(account_id: i64, amount: i64, fee: i64, counter: i64) -> BankDraft {
    BankDraft {
        account_id,
        date: "2026-02-10".into(),
        description: "Corner shop".into(),
        payee: Some("Corner shop".into()),
        amount_minor: amount,
        fee_minor: fee,
        counter_ledger_account_id: counter,
        source_line_id: None,
        functional_minor: None,
    }
}

async fn source_line(db: &Db, ent: &Entity, account_id: i64, amount: i64, fee: i64) -> i64 {
    sqlx::query(
        "INSERT INTO fin_source_lines (entity_id, account_id, hash, booked_date, description, amount_minor, currency, fee_minor, created_at) \
         VALUES (?, ?, ?, '2026-02-10', 'Corner shop', ?, 'EUR', ?, ?)",
    )
    .bind(ent.id)
    .bind(account_id)
    .bind(format!("h{amount}/{fee}"))
    .bind(amount)
    .bind(fee)
    .bind(now())
    .execute(db)
    .await
    .unwrap()
    .last_insert_rowid()
}

pub(super) fn balanced(e: &Entry) -> bool {
    e.lines.iter().map(|l| l.functional_minor).sum::<i64>() == 0
}

#[tokio::test]
async fn the_entity_comes_with_the_default_chart() {
    let db = test_db("chart").await;
    let ent = user(&db, 7).await;
    assert_eq!(ent.functional_currency, "EUR");
    assert_eq!(entity_for_user(&db, 7).await.unwrap().id, ent.id, "one entity per user");
    let chart = list_ledger_accounts(&db, &ent, false).await.unwrap();
    for key in [
        system::OPENING_EQUITY,
        system::TRANSFERS_CLEARING,
        system::FX_REALISED_GAIN,
        system::FX_REALISED_LOSS,
        system::FX_UNREALISED_GAIN,
        system::FX_UNREALISED_LOSS,
        system::BANK_FEES,
        system::UNCATEGORISED_EXPENSE,
        system::UNCATEGORISED_INCOME,
    ] {
        let a = system_account(&db, &ent, key).await.unwrap();
        assert!(chart.iter().any(|c| c.id == a.id), "{key}");
    }
    for name in ["Groceries", "Salary", "Accumulated surplus", "Prepayments", "Accrued expenses"] {
        assert!(chart.iter().any(|c| c.name == name), "{name}");
    }
    // System accounts can't be archived.
    let fees = system_account(&db, &ent, system::BANK_FEES).await.unwrap();
    assert!(archive_ledger_account(&db, &ent, fees.id).await.unwrap_err().is_invalid_input());
    assert_eq!(audit_count(&db, &ent, "create").await, 1);
}

#[tokio::test]
async fn accounts_open_with_a_balance_against_opening_equity() {
    let db = test_db("accounts").await;
    let ent = user(&db, 7).await;
    let cur = create_account(&db, &ent, account("current", "Everyday", "EUR", 120_000)).await.unwrap();
    let card = create_account(&db, &ent, account("card", "Card", "EUR", -30_000)).await.unwrap();
    let sav = create_account(&db, &ent, account("savings", "Vault", "EUR", 0)).await.unwrap();

    let chart = list_ledger_accounts(&db, &ent, false).await.unwrap();
    let ledger = |id: i64| chart.iter().find(|a| a.id == id).unwrap().clone();
    let (lc, lk, ls) = (ledger(cur.ledger_account_id), ledger(card.ledger_account_id), ledger(sav.ledger_account_id));
    assert_eq!((lc.class.as_str(), lc.currency.as_deref()), ("asset", Some("EUR")));
    assert_eq!(lk.class, "liability");
    assert_eq!((ls.class.as_str(), ls.cash_flow_class.as_deref()), ("asset", Some("investing")));
    assert_eq!(lc.parent_id, Some(system_account(&db, &ent, chart::GROUP_CASH).await.unwrap().id));
    assert_eq!(lc.code, "1001");

    assert_eq!((cur.balance_minor, cur.balance_functional_minor), (120_000, 120_000));
    assert_eq!(card.balance_minor, -30_000);
    assert_eq!(sav.balance_minor, 0);
    let tb = trial_balance(&db, &ent, "2026-12-31").await.unwrap();
    let equity = system_account(&db, &ent, system::OPENING_EQUITY).await.unwrap();
    let row = tb.iter().find(|r| r.ledger_account_id == equity.id).unwrap();
    assert_eq!((row.debit_minor, row.credit_minor), (0, 90_000));
    assert_eq!(tb.iter().map(|r| r.debit_minor).sum::<i64>(), tb.iter().map(|r| r.credit_minor).sum::<i64>());
    assert!(trial_balance(&db, &ent, "2025-12-31").await.unwrap().is_empty(), "nothing before the opening date");

    // A financial account's ledger account goes with it.
    assert!(archive_ledger_account(&db, &ent, lc.id).await.unwrap_err().is_invalid_input());
    let archived = archive_account(&db, &ent, sav.id).await.unwrap();
    assert!(archived.archived);
    assert_eq!(list_accounts(&db, &ent, false).await.unwrap().len(), 2);
    assert_eq!(list_accounts(&db, &ent, true).await.unwrap().len(), 3);
}

#[tokio::test]
async fn bank_drafts_categorise_post_and_count_separately() {
    let db = test_db("drafts").await;
    let ent = user(&db, 7).await;
    let cur = create_account(&db, &ent, account("current", "Everyday", "EUR", 100_000)).await.unwrap();
    let unc = system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id;
    let fees = system_account(&db, &ent, system::BANK_FEES).await.unwrap().id;

    // 25.00 out with a 0.50 fee: the bank moves 25.50.
    let sl = source_line(&db, &ent, cur.id, -2_500, 50).await;
    let mut tx = db.begin().await.unwrap();
    let e = draft_from_source_line_in(&mut tx, &ent, sl, unc, None).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(e.status, "draft");
    assert!(balanced(&e));
    let amounts: Vec<(i64, i64)> = e.lines.iter().map(|l| (l.ledger_account_id, l.amount_minor)).collect();
    assert_eq!(amounts, vec![(cur.ledger_account_id, -2_550), (fees, 50), (unc, 2_500)]);

    let a = get_account(&db, &ent, cur.id).await.unwrap();
    assert_eq!((a.balance_minor, a.draft_balance_minor), (100_000, -2_550));
    let page = list_entries(&db, &ent, EntryFilter { uncategorised: Some(true), ..Default::default() }, 50, 0).await.unwrap();
    assert_eq!((page.total, page.entries[0].id), (1, e.id));

    // Split it: the splits add up to the bank line (either sign); the fee line stays.
    let (groc, home) = (la(&db, &ent, "Groceries").await, la(&db, &ent, "Housing").await);
    let bad = vec![Split { ledger_account_id: groc, amount_minor: 2_000, memo: None }];
    assert!(categorise(&db, &ent, e.id, bad).await.unwrap_err().is_invalid_input());
    let splits = vec![
        Split { ledger_account_id: groc, amount_minor: -1_500, memo: None },
        Split { ledger_account_id: home, amount_minor: -1_000, memo: Some("bulbs".into()) },
    ];
    let e = categorise(&db, &ent, e.id, splits).await.unwrap();
    assert!(balanced(&e));
    let amounts: Vec<(i64, i64)> = e.lines.iter().map(|l| (l.ledger_account_id, l.amount_minor)).collect();
    assert_eq!(amounts, vec![(cur.ledger_account_id, -2_550), (fees, 50), (groc, 1_500), (home, 1_000)]);
    let page = list_entries(&db, &ent, EntryFilter { uncategorised: Some(true), ..Default::default() }, 50, 0).await.unwrap();
    assert_eq!(page.total, 0);
    let page = list_entries(&db, &ent, EntryFilter { ledger_account_id: Some(home), ..Default::default() }, 50, 0).await.unwrap();
    assert_eq!(page.total, 1);
    let page = list_entries(&db, &ent, EntryFilter { search: Some("corner".into()), ..Default::default() }, 50, 0).await.unwrap();
    assert_eq!(page.total, 1);

    assert_eq!(post_entries(&db, &ent, &[e.id]).await.unwrap(), 1);
    assert_eq!(post_entries(&db, &ent, &[e.id]).await.unwrap(), 0, "already posted");
    let a = get_account(&db, &ent, cur.id).await.unwrap();
    assert_eq!((a.balance_minor, a.draft_balance_minor), (97_450, 0));
    let tb = trial_balance(&db, &ent, "2026-12-31").await.unwrap();
    assert_eq!(tb.iter().map(|r| r.debit_minor).sum::<i64>(), tb.iter().map(|r| r.credit_minor).sum::<i64>());
    assert_eq!(tb.iter().find(|r| r.ledger_account_id == groc).unwrap().debit_minor, 1_500);
    assert!(audit_count(&db, &ent, "categorise").await == 1 && audit_count(&db, &ent, "post").await == 1);
}

#[tokio::test]
async fn manual_journals_must_balance() {
    let db = test_db("journal").await;
    let ent = user(&db, 7).await;
    let cur = create_account(&db, &ent, account("current", "Everyday", "EUR", 0)).await.unwrap();
    let salary = la(&db, &ent, "Salary").await;
    let line = |la: i64, amount: i64| LineInput::new(la, amount, "EUR");
    let input = |lines| EntryInput { date: "2026-03-01".into(), description: "Pay".into(), payee: None, notes: None, lines };

    let err = create_entry(&db, &ent, input(vec![line(cur.ledger_account_id, 300_000), line(salary, -299_999)])).await.unwrap_err();
    assert!(err.is_invalid_input(), "{err}");
    assert!(create_entry(&db, &ent, input(vec![line(cur.ledger_account_id, 1)])).await.is_err(), "one line");
    // A monetary account takes lines only in its currency.
    let usd = LineInput::new(cur.ledger_account_id, 100, "USD");
    assert!(create_entry(&db, &ent, input(vec![usd, line(salary, -100)])).await.is_err());

    let e = create_entry(&db, &ent, input(vec![line(cur.ledger_account_id, 300_000), line(salary, -300_000)])).await.unwrap();
    assert_eq!(e.status, "posted");
    assert_eq!(get_account(&db, &ent, cur.id).await.unwrap().balance_minor, 300_000);

    // Editing replaces the lines, which must still balance.
    let patch = |lines| EntryPatch { lines: Some(lines), ..Default::default() };
    assert!(update_entry(&db, &ent, e.id, patch(vec![line(cur.ledger_account_id, 5), line(salary, -4)])).await.is_err());
    let e = update_entry(&db, &ent, e.id, patch(vec![line(cur.ledger_account_id, 310_000), line(salary, -310_000)])).await.unwrap();
    assert_eq!(get_account(&db, &ent, cur.id).await.unwrap().balance_minor, 310_000);
    assert_eq!(audit_count(&db, &ent, "update").await, 1);

    delete_entry(&db, &ent, e.id).await.unwrap();
    assert_eq!(get_account(&db, &ent, cur.id).await.unwrap().balance_minor, 0);
    assert_eq!(audit_count(&db, &ent, "delete").await, 1);
}

#[tokio::test]
async fn foreign_lines_translate_at_the_ecb_rate() {
    let db = test_db("fx").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-02-09".into(), "USD".into(), 1.25)], "ecb").await.unwrap();
    let usd = create_account(&db, &ent, account("current", "Dollars", "USD", 0)).await.unwrap();
    let unc = system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id;

    // 10.00 USD out at 1.25 USD/EUR = 8.00 EUR.
    let e = create_bank_draft(&db, &ent, draft(usd.id, -1_000, 0, unc)).await.unwrap();
    assert_eq!(e.lines[0].functional_minor, -800);
    assert!((e.lines[0].rate - 0.8).abs() < 1e-12);
    assert!(balanced(&e));
    // The bank's own converted amount wins.
    let mut d = draft(usd.id, -1_000, 0, unc);
    d.functional_minor = Some(-795);
    assert_eq!(create_bank_draft(&db, &ent, d).await.unwrap().lines[0].functional_minor, -795);
    // Three uneven splits keep the entry balanced in EUR.
    let groc = la(&db, &ent, "Groceries").await;
    let splits = (0..3).map(|i| Split { ledger_account_id: groc, amount_minor: if i == 0 { 334 } else { 333 }, memo: None }).collect();
    assert!(balanced(&categorise(&db, &ent, e.id, splits).await.unwrap()));
    let a = get_account(&db, &ent, usd.id).await.unwrap();
    assert_eq!((a.draft_balance_minor, a.draft_balance_functional_minor), (-2_000, -1_595));

    // No rate before the cache starts: refused, not guessed.
    let mut early = draft(usd.id, -1_000, 0, unc);
    early.date = "2026-01-01".into();
    assert!(create_bank_draft(&db, &ent, early).await.unwrap_err().is_invalid_input());
}

#[tokio::test]
async fn closed_periods_refuse_edits_and_take_reversals() {
    let db = test_db("closed").await;
    let ent = user(&db, 7).await;
    let cur = create_account(&db, &ent, account("current", "Everyday", "EUR", 50_000)).await.unwrap();
    let opening = list_entries(&db, &ent, EntryFilter::default(), 10, 0).await.unwrap().entries.remove(0);
    sqlx::query("INSERT INTO fin_periods (entity_id, month, status, closed_at) VALUES (?, '2026-01', 'closed', ?)")
        .bind(ent.id)
        .bind(now())
        .execute(&db)
        .await
        .unwrap();

    let err = update_entry(&db, &ent, opening.id, EntryPatch { description: Some("x".into()), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.to_string(), "Invalid input: closed period: reverse it instead");
    assert!(delete_entry(&db, &ent, opening.id).await.unwrap_err().is_invalid_input());
    assert!(reverse_entry(&db, &ent, opening.id, "2026-01-31").await.is_err(), "a reversal dated in the closed month");

    let rev = reverse_entry(&db, &ent, opening.id, "2026-02-01").await.unwrap();
    assert!(balanced(&rev));
    assert_eq!(rev.reverses_id, Some(opening.id));
    assert_eq!(get_entry(&db, &ent, opening.id).await.unwrap().status, "reversed");
    assert_eq!(get_account(&db, &ent, cur.id).await.unwrap().balance_minor, 0);
    assert!(reverse_entry(&db, &ent, opening.id, "2026-02-01").await.is_err(), "only once");
    assert_eq!(audit_count(&db, &ent, "reverse").await, 1);
    // The January books still show the opening balance.
    let jan = trial_balance(&db, &ent, "2026-01-31").await.unwrap();
    assert_eq!(jan.iter().map(|r| r.debit_minor).sum::<i64>(), 50_000);
}

#[tokio::test]
async fn deleting_a_draft_dismisses_its_source_line() {
    let db = test_db("dismiss").await;
    let ent = user(&db, 7).await;
    let cur = create_account(&db, &ent, account("current", "Everyday", "EUR", 0)).await.unwrap();
    let sl = source_line(&db, &ent, cur.id, -1_200, 0).await;
    let unc = system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id;
    let mut tx = db.begin().await.unwrap();
    let e = draft_from_source_line_in(&mut tx, &ent, sl, unc, None).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!((e.source_line_id, e.lines[0].amount_minor), (Some(sl), -1_200));

    delete_entry(&db, &ent, e.id).await.unwrap();
    let dismissed: Option<String> = sqlx::query_scalar("SELECT dismissed_at FROM fin_source_lines WHERE id = ?").bind(sl).fetch_one(&db).await.unwrap();
    assert!(dismissed.is_some());
}

#[tokio::test]
async fn entities_never_reach_each_others_rows() {
    let db = test_db("isolation").await;
    let (mia, ana) = (user(&db, 7).await, user(&db, 8).await);
    let a = create_account(&db, &mia, account("current", "Mia's", "EUR", 1_000)).await.unwrap();
    let entry = list_entries(&db, &mia, EntryFilter::default(), 10, 0).await.unwrap().entries.remove(0);
    let groc = la(&db, &mia, "Groceries").await;

    assert!(get_account(&db, &ana, a.id).await.unwrap_err().is_not_found());
    assert!(update_account(&db, &ana, a.id, FinAccountPatch::default()).await.unwrap_err().is_not_found());
    assert!(get_entry(&db, &ana, entry.id).await.unwrap_err().is_not_found());
    assert!(delete_entry(&db, &ana, entry.id).await.unwrap_err().is_not_found());
    assert!(reverse_entry(&db, &ana, entry.id, "2026-02-01").await.unwrap_err().is_not_found());
    assert!(post_entries(&db, &ana, &[entry.id]).await.unwrap_err().is_not_found());
    assert!(archive_ledger_account(&db, &ana, groc).await.unwrap_err().is_not_found());
    // Ana can't post to Mia's accounts either.
    let ana_unc = system_account(&db, &ana, system::UNCATEGORISED_EXPENSE).await.unwrap().id;
    assert!(create_bank_draft(&db, &ana, draft(a.id, -100, 0, ana_unc)).await.unwrap_err().is_not_found());
    let lines = vec![LineInput::new(groc, 100, "EUR"), LineInput::new(ana_unc, -100, "EUR")];
    let input = EntryInput { date: "2026-03-01".into(), description: "x".into(), payee: None, notes: None, lines };
    assert!(create_entry(&db, &ana, input).await.unwrap_err().is_not_found());

    assert!(list_accounts(&db, &ana, true).await.unwrap().is_empty());
    assert_eq!(list_entries(&db, &ana, EntryFilter::default(), 10, 0).await.unwrap().total, 0);
    assert!(trial_balance(&db, &ana, "2030-01-01").await.unwrap().is_empty());
}

#[tokio::test]
async fn the_functional_currency_changes_only_before_posting() {
    let db = test_db("currency").await;
    let ent = user(&db, 7).await;
    let ent = update_entity(&db, &ent, EntityPatch { name: Some("Home".into()), functional_currency: Some("usd".into()) }).await.unwrap();
    assert_eq!((ent.name.as_str(), ent.functional_currency.as_str()), ("Home", "USD"));
    create_account(&db, &ent, account("current", "Everyday", "USD", 1_000)).await.unwrap();
    let err = update_entity(&db, &ent, EntityPatch { functional_currency: Some("EUR".into()), ..Default::default() }).await.unwrap_err();
    assert!(err.is_invalid_input());
}

#[tokio::test]
async fn malformed_lines_and_charts_are_refused() {
    let db = test_db("malformed").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-02-09".into(), "USD".into(), 1.25)], "ecb").await.unwrap();
    let eur = create_account(&db, &ent, account("current", "Everyday", "EUR", 0)).await.unwrap();
    let usd = create_account(&db, &ent, account("current", "Dollars", "USD", 0)).await.unwrap();

    // A known functional amount keeps its line's sign.
    let mut d = draft(usd.id, -1_000, 0, system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id);
    d.functional_minor = Some(800);
    assert!(create_bank_draft(&db, &ent, d).await.unwrap_err().is_invalid_input());
    // A counter that is another monetary account takes only its own currency.
    assert!(create_bank_draft(&db, &ent, draft(usd.id, -1_000, 0, eur.ledger_account_id)).await.unwrap_err().is_invalid_input());

    // No cycles in the chart.
    let (a, b) = (la(&db, &ent, "Housing").await, la(&db, &ent, "Utilities").await);
    update_ledger_account(&db, &ent, b, LedgerAccountPatch { parent_id: Some(a), ..Default::default() }).await.unwrap();
    let err = update_ledger_account(&db, &ent, a, LedgerAccountPatch { parent_id: Some(b), ..Default::default() }).await.unwrap_err();
    assert!(err.is_invalid_input());
}

#[tokio::test]
async fn deleting_a_paired_entry_audits_the_pair() {
    let db = test_db("pairs").await;
    let ent = user(&db, 7).await;
    let a = create_account(&db, &ent, account("current", "Everyday", "EUR", 0)).await.unwrap();
    let b = create_account(&db, &ent, account("savings", "Vault", "EUR", 0)).await.unwrap();
    let clearing = system_account(&db, &ent, system::TRANSFERS_CLEARING).await.unwrap().id;
    let out = create_bank_draft(&db, &ent, draft(a.id, -5_000, 0, clearing)).await.unwrap();
    let inn = create_bank_draft(&db, &ent, draft(b.id, 5_000, 0, clearing)).await.unwrap();
    sqlx::query("INSERT INTO fin_pairs (entity_id, kind, entry_a, entry_b, status, created_at) VALUES (?, 'transfer', ?, ?, 'auto', ?)")
        .bind(ent.id)
        .bind(out.id)
        .bind(inn.id)
        .bind(now())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(get_entry(&db, &ent, inn.id).await.unwrap().pair.unwrap().other_entry_id, out.id);
    delete_entry(&db, &ent, out.id).await.unwrap();
    assert!(get_entry(&db, &ent, inn.id).await.unwrap().pair.is_none());
    let audited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_audit WHERE kind = 'pair' AND action = 'delete'").fetch_one(&db).await.unwrap();
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn category_totals_count_drafts_by_entry_date_in_natural_sign() {
    let db = test_db("category_totals").await;
    let ent = user(&db, 7).await;
    let a = create_account(&db, &ent, account("current", "Everyday", "EUR", 100_000)).await.unwrap();
    let (unc, groceries) = (la(&db, &ent, "Uncategorised").await, la(&db, &ent, "Groceries").await);
    let shop = create_bank_draft(&db, &ent, draft(a.id, -4_200, 0, unc)).await.unwrap();
    categorise(&db, &ent, shop.id, vec![Split { ledger_account_id: groceries, amount_minor: 4_200, memo: None }]).await.unwrap();
    let refund = create_bank_draft(&db, &ent, draft(a.id, 200, 0, unc)).await.unwrap();
    categorise(&db, &ent, refund.id, vec![Split { ledger_account_id: groceries, amount_minor: -200, memo: None }]).await.unwrap();
    create_bank_draft(&db, &ent, draft(a.id, -999, 0, unc)).await.unwrap();

    let rows = category_totals(&db, &ent, "2026-02-01", "2026-02-28").await.unwrap();
    let get = |name: &str| rows.iter().find(|r| r.name == name).map(|r| (r.amount_minor, r.entries));
    assert_eq!(get("Groceries"), Some((4_000, 2)), "spent, net of the refund, drafts included");
    assert_eq!(get("Uncategorised"), Some((999, 1)));
    assert!(rows.iter().all(|r| r.class == "income" || r.class == "expense"), "the opening balance isn't a category");
    assert!(category_totals(&db, &ent, "2026-03-01", "2026-03-31").await.unwrap().is_empty());
}
