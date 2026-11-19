//! Startup on a big book from before payees: the migration only changes the schema, and the
//! background job (`backfill`) does the rest in short transactions, resumable and idempotent.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::tests::make_main_shaped;
use super::*;
use crate::finance::{create_account, list_ledger_accounts, system, system_account, FinAccountInput};

/// Shop names without digits (a trailing number is a reference to the certain key).
fn shop(k: i64) -> String {
    format!("Shop {}{}x", (b'a' + (k / 26) as u8) as char, (b'a' + (k % 26) as u8) as char)
}

async fn snapshot(db: &Db) -> Vec<i64> {
    let mut out = Vec::new();
    for sql in [
        "SELECT COUNT(*) FROM fin_payees",
        "SELECT COUNT(*) FROM fin_payees WHERE default_ledger_account_id IS NOT NULL",
        "SELECT COUNT(*) FROM fin_payee_aliases",
        "SELECT COUNT(*) FROM fin_entries WHERE status = 'posted'",
        "SELECT COUNT(*) FROM fin_entries WHERE payee_id IS NOT NULL",
        "SELECT COUNT(*) FROM fin_rules",
        "SELECT COUNT(*) FROM fin_lines",
    ] {
        out.push(sqlx::query_scalar(sql).fetch_one(db).await.unwrap());
    }
    out
}

#[tokio::test]
async fn startup_is_prompt_on_a_big_book_and_the_job_resumes() {
    let path = std::env::temp_dir().join(format!("ganban_payees_startup_{}.db", std::process::id()));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    let db = crate::init_db(&path).await.unwrap();
    sqlx::query("INSERT INTO users (id, username, full_name) VALUES (7, 'u7', 'User')").execute(&db).await.unwrap();
    let ent = crate::finance::entity_for_user(&db, 7).await.unwrap();
    let account = create_account(
        &db,
        &ent,
        FinAccountInput {
            kind: "current".into(),
            name: "Everyday".into(),
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
    let unc = system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id;
    let groceries = list_ledger_accounts(&db, &ent, false).await.unwrap().into_iter().find(|a| a.name == "Groceries");
    let groceries = groceries.unwrap().id;

    // A book as main leaves it: 10,000 imported lines from 400 shops under two spellings, all
    // drafts, about 300 of them categorised, and 50 rules.
    let mut tx = crate::db::begin_write(&db).await.unwrap();
    let start = chrono::NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
    for n in 0..10_000i64 {
        let name = shop(n % 400);
        let text = if n % 3 == 0 { format!("{}*ORDER {n}", name.to_uppercase()) } else { name };
        let date = (start + chrono::Duration::days(n / 5)).format("%Y-%m-%d").to_string();
        let amount = 100 + n % 5000;
        let line = sqlx::query(
            "INSERT INTO fin_source_lines (entity_id, account_id, hash, dedupe_key, booked_date, description, payee, \
             amount_minor, currency, kind_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', 'card', ?)",
        )
        .bind(ent.id)
        .bind(account.id)
        .bind(format!("h{n}"))
        .bind(format!("k{n}"))
        .bind(&date)
        .bind(&text)
        .bind(&text)
        .bind(-amount)
        .bind(now())
        .execute(&mut *tx)
        .await
        .unwrap()
        .last_insert_rowid();
        let entry = sqlx::query(
            "INSERT INTO fin_entries (entity_id, date, description, payee, status, source_line_id, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
        )
        .bind(ent.id)
        .bind(&date)
        .bind(&text)
        .bind(&text)
        .bind(line)
        .bind(now())
        .bind(now())
        .execute(&mut *tx)
        .await
        .unwrap()
        .last_insert_rowid();
        let counter = if n % 33 == 0 { groceries } else { unc };
        for (la, a) in [(account.ledger_account_id, -amount), (counter, amount)] {
            sqlx::query(
                "INSERT INTO fin_lines (entry_id, ledger_account_id, amount_minor, currency, functional_minor, rate) \
                 VALUES (?, ?, ?, 'EUR', ?, 1)",
            )
            .bind(entry)
            .bind(la)
            .bind(a)
            .bind(a)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();
    for i in 0..50 {
        let rule = crate::finance::rules::RuleInput {
            position: None,
            conditions: crate::finance::rules::Conditions { payee: Some(shop(300 + i)), ..Default::default() },
            action: crate::finance::rules::Action { ledger_account_id: Some(groceries), splits: vec![] },
            learned: false,
        };
        crate::finance::rules::create_rule(&db, &ent, rule).await.unwrap();
    }
    make_main_shaped(&db).await;
    db.close().await;

    // Startup: the schema changes only.
    let t = Instant::now();
    let db = crate::init_db(&path).await.unwrap();
    let startup = t.elapsed();
    println!("init_db on a 10,000-line book from main: {startup:.2?}");
    assert!(startup < Duration::from_secs(10), "{startup:?}");
    assert_eq!(preparing(&db, &ent).await.unwrap(), Some((0, 10_000)));
    // Finance answers meanwhile; an import is refused politely.
    assert_eq!(crate::finance::inbox::summary(&db, &ent).await.unwrap().preparing.unwrap().total, 10_000);
    let err = crate::finance::import::pipeline::check_request(&db, &ent, "sample", &HashMap::new()).await;
    assert!(err.unwrap_err().to_string().contains("of 10000"));

    // The job, killed after 20 of its transactions.
    let quick = BackfillOptions { batch: 250, pause: Duration::ZERO, stop_after: Some(20) };
    backfill(&db, &quick).await.unwrap();
    assert_eq!(preparing(&db, &ent).await.unwrap(), Some((5_000, 10_000)));

    // A restart: the migration again, then the job finishes.
    crate::finance::schema::migrate(&db).await.unwrap();
    let t = Instant::now();
    backfill(&db, &BackfillOptions { stop_after: None, ..quick.clone() }).await.unwrap();
    println!("the job's work, without its pauses: {:.2?}", t.elapsed());
    assert_eq!(preparing(&db, &ent).await.unwrap(), None);
    let after = snapshot(&db).await;
    // 400 payees; Shop 0..399 with ~300 categorised lines learn defaults; 50 rules give theirs.
    assert_eq!((after[0], after[2], after[4], after[5]), (400, 400, 10_000, 50));
    assert!(after[1] >= 50 && after[3] >= 300, "{after:?}");

    // Running it twice, or the learning again, changes nothing.
    backfill(&db, &quick).await.unwrap();
    learn_from_books(&db, &ent, &quick).await.unwrap();
    assert_eq!(snapshot(&db).await, after);
}
