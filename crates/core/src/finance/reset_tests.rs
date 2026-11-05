//! Reset tests on a throwaway database, with made-up accounts and amounts.

use super::*;
use crate::finance::rules::{self, Action, Conditions, RuleInput};
use crate::finance::tests::{account, la, test_db, user};
use crate::finance::{create_account, create_ledger_account, entity_for_user, list_ledger_accounts};

fn fast() -> ResetOptions {
    ResetOptions { batch: 500, pause: Duration::from_millis(1) }
}

async fn n(db: &Db, sql: &str, ent: &Entity) -> i64 {
    sqlx::query_scalar(sql).bind(ent.id).fetch_one(db).await.unwrap()
}

/// Rows of every per-entity table the reset empties.
async fn rows(db: &Db, ent: &Entity) -> Vec<(&'static str, i64)> {
    let mut out = Vec::new();
    for t in [
        "fin_accounts", "fin_entries", "fin_source_lines", "fin_import_batches", "fin_pairs", "fin_budgets",
        "fin_planned", "fin_recurring", "fin_schedules", "fin_periods", "fin_group_suggestions",
    ] {
        out.push((t, n(db, &format!("SELECT COUNT(*) FROM {t} WHERE entity_id = ?"), ent).await));
    }
    out.push(("fin_lines", n(db, "SELECT COUNT(*) FROM fin_lines l JOIN fin_entries e ON e.id = l.entry_id WHERE e.entity_id = ?", ent).await));
    out
}

/// Fills an entity with `entries` imported drafts and one row in every other table.
async fn seed(db: &Db, ent: &Entity, entries: usize) {
    let acc = create_account(db, ent, account("current", "Everyday", "EUR", 10_000)).await.unwrap();
    let groceries = la(db, ent, "Groceries").await;
    let mut tx = db.begin().await.unwrap();
    let batch = sqlx::query("INSERT INTO fin_import_batches (entity_id, file_name, imported_at) VALUES (?, 'export.csv', ?)")
        .bind(ent.id)
        .bind(now())
        .execute(&mut *tx)
        .await
        .unwrap()
        .last_insert_rowid();
    let mut ids = Vec::new();
    for i in 0..entries {
        let src = sqlx::query(
            "INSERT INTO fin_source_lines (entity_id, account_id, batch_id, hash, booked_date, description, amount_minor, currency, created_at) \
             VALUES (?, ?, ?, ?, '2026-02-10', 'Shop', -100, 'EUR', ?)",
        )
        .bind(ent.id)
        .bind(acc.id)
        .bind(batch)
        .bind(format!("h{i}"))
        .bind(now())
        .execute(&mut *tx)
        .await
        .unwrap()
        .last_insert_rowid();
        let e = sqlx::query(
            "INSERT INTO fin_entries (entity_id, date, description, status, source_line_id, created_at, updated_at) \
             VALUES (?, '2026-02-10', 'Shop', 'draft', ?, ?, ?)",
        )
        .bind(ent.id)
        .bind(src)
        .bind(now())
        .bind(now())
        .execute(&mut *tx)
        .await
        .unwrap()
        .last_insert_rowid();
        for (la_id, amount) in [(acc.ledger_account_id, -100), (groceries, 100)] {
            sqlx::query("INSERT INTO fin_lines (entry_id, ledger_account_id, amount_minor, currency, functional_minor) VALUES (?, ?, ?, 'EUR', ?)")
                .bind(e)
                .bind(la_id)
                .bind(amount)
                .bind(amount)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        ids.push(e);
    }
    let (a, b) = (ids[0], ids[1]);
    sqlx::query("UPDATE fin_entries SET reverses_id = ? WHERE id = ?").bind(a).bind(b).execute(&mut *tx).await.unwrap();
    for sql in [
        "INSERT INTO fin_pairs (entity_id, kind, entry_a, entry_b, status, created_at) VALUES (?1, 'transfer', ?2, ?3, 'review', '')",
        "INSERT INTO fin_schedules (entity_id, entry_id, ledger_account_id, balance_account_id, kind, start_month, months, amount_minor, created_at) \
         VALUES (?1, ?2, ?4, ?4, 'prepaid', '2026-02', 3, 300, '')",
        "INSERT INTO fin_schedule_releases (schedule_id, month, entry_id) SELECT id, '2026-02', ?3 FROM fin_schedules WHERE entity_id = ?1",
        "INSERT INTO fin_budgets (entity_id, ledger_account_id, amount_minor, created_at, updated_at) VALUES (?1, ?4, 5000, '', '')",
        "INSERT INTO fin_planned (entity_id, date, description, amount_minor, created_at, updated_at) VALUES (?1, '2026-03-01', 'Trip', -900, '', '')",
        "INSERT INTO fin_recurring (entity_id, key, label, cadence, amount_minor, amount_low_minor, amount_high_minor, first_date, last_date, next_date, created_at, updated_at) \
         VALUES (?1, 'gym', 'Gym', 'monthly', -3000, -3000, -3000, '2026-01-01', '2026-02-01', '2026-03-01', '', '')",
        "INSERT INTO fin_periods (entity_id, month, status) VALUES (?1, '2025-12', 'closed')",
        "INSERT INTO fin_group_suggestions (entity_id, group_key, ledger_account_id, created_at) VALUES (?1, 'out:shop', ?4, '')",
        "INSERT INTO fin_profiles (entity_id, key, name, mapping_json) VALUES (?1, 'mybank', 'My bank', '{}')",
        "INSERT OR REPLACE INTO fin_settings (entity_id, reminder_enabled, reminder_weekday, reminder_time) VALUES (?1, 0, 'Fri', '18:30')",
    ] {
        sqlx::query(sql).bind(ent.id).bind(a).bind(b).bind(groceries).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let rule = RuleInput {
        position: None,
        conditions: Conditions { text: Some("shop".into()), account_id: Some(acc.id), ..Default::default() },
        action: Action { ledger_account_id: Some(groceries), splits: vec![] },
        learned: false,
    };
    rules::create_rule(db, ent, rule).await.unwrap();
}

#[tokio::test]
async fn a_reset_empties_only_the_callers_books_and_keeps_their_settings() {
    let db = test_db("reset_scope").await;
    let mia = user(&db, 7).await;
    let ana = user(&db, 8).await;
    seed(&db, &mia, 20).await;
    seed(&db, &ana, 20).await;
    sqlx::query("INSERT OR IGNORE INTO fin_rates (currency, date, rate) VALUES ('USD', '2026-02-10', 1.08)").execute(&db).await.unwrap();
    let anas_before = rows(&db, &ana).await;
    let chart_before = list_ledger_accounts(&db, &mia, true).await.unwrap().len();

    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let progress = move |d: usize, t: usize| log.lock().unwrap().push((d, t));
    let r = reset(&db, &mia, false, &fast(), &progress).await.unwrap();
    assert_eq!(r.removed, ResetCounts { accounts: 1, entries: 21, rules: 1, layouts: 1 });

    assert!(rows(&db, &mia).await.iter().all(|(_, c)| *c == 0), "{:?}", rows(&db, &mia).await);
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_rules WHERE entity_id = ?", &mia).await, 0);
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_profiles WHERE entity_id = ?", &mia).await, 0);
    // The audit trail is gone but for the reset itself.
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_audit WHERE entity_id = ? AND action != 'reset'", &mia).await, 0);
    // A fresh default chart, the same entity and its settings, and the global rates.
    let chart = list_ledger_accounts(&db, &mia, true).await.unwrap();
    assert_eq!(chart.len(), chart_before - 1, "the account's own ledger account went");
    assert!(chart.iter().all(|a| a.currency.is_none()));
    assert_eq!(entity_for_user(&db, 7).await.unwrap().id, mia.id);
    let s: (i64, String, String) = sqlx::query_as("SELECT reminder_enabled, reminder_weekday, reminder_time FROM fin_settings WHERE entity_id = ?")
        .bind(mia.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(s, (0, "Fri".into(), "18:30".into()));
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM fin_rates").fetch_one(&db).await.unwrap(), 1);
    // Ana's books are untouched.
    assert_eq!(rows(&db, &ana).await, anas_before);
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_rules WHERE entity_id = ?", &ana).await, 1);
    // Progress climbed to the total.
    let seen = seen.lock().unwrap();
    let (last_done, last_total) = *seen.last().unwrap();
    assert!(last_total > 50 && last_done == last_total, "{seen:?}");

    // Again, on the empty entity: nothing to remove, the same fresh chart.
    let again = reset(&db, &mia, false, &fast(), &|_, _| {}).await.unwrap();
    assert_eq!(again.removed, ResetCounts::default());
    assert_eq!(list_ledger_accounts(&db, &mia, true).await.unwrap().len(), chart.len());
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_audit WHERE entity_id = ?", &mia).await, 1);
}

#[tokio::test]
async fn keeping_rules_keeps_rules_and_layouts_and_nothing_else() {
    let db = test_db("reset_keep").await;
    let mia = user(&db, 7).await;
    seed(&db, &mia, 5).await;
    // A category of the user's own, used by a rule: it comes back, by its name.
    let pets = create_ledger_account(
        &db,
        &mia,
        serde_json::from_value(serde_json::json!({ "code": "6600", "name": "Pets", "class": "expense" })).unwrap(),
    )
    .await
    .unwrap();
    let vet = RuleInput {
        position: None,
        conditions: Conditions { payee: Some("vet".into()), ..Default::default() },
        action: Action { ledger_account_id: Some(pets.id), splits: vec![] },
        learned: true,
    };
    rules::create_rule(&db, &mia, vet).await.unwrap();
    // A rule on the account alone would match everything once the account is gone.
    let acc_id: i64 = n(&db, "SELECT id FROM fin_accounts WHERE entity_id = ?", &mia).await;
    let only_account = RuleInput {
        position: None,
        conditions: Conditions { account_id: Some(acc_id), ..Default::default() },
        action: Action { ledger_account_id: Some(pets.id), splits: vec![] },
        learned: false,
    };
    rules::create_rule(&db, &mia, only_account).await.unwrap();

    let r = reset(&db, &mia, true, &fast(), &|_, _| {}).await.unwrap();
    assert!(r.kept_rules);
    assert_eq!((r.removed.rules, r.removed.layouts), (0, 0));
    assert!(rows(&db, &mia).await.iter().all(|(_, c)| *c == 0));
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_profiles WHERE entity_id = ?", &mia).await, 1);

    let kept = rules::list_rules(&db, &mia).await.unwrap();
    assert_eq!(kept.len(), 2, "the shop and vet rules; the account-only one went");
    let chart = list_ledger_accounts(&db, &mia, true).await.unwrap();
    let name_of = |id: i64| chart.iter().find(|a| a.id == id).map(|a| a.name.clone());
    let shop = kept.iter().find(|r| r.conditions.text.as_deref() == Some("shop")).unwrap();
    assert_eq!(shop.conditions.account_id, None);
    assert_eq!(name_of(shop.action.ledger_account_id.unwrap()).as_deref(), Some("Groceries"));
    let vet = kept.iter().find(|r| r.conditions.payee.as_deref() == Some("vet")).unwrap();
    assert_eq!(name_of(vet.action.ledger_account_id.unwrap()).as_deref(), Some("Pets"));
    assert!(vet.learned);
}

#[tokio::test]
async fn a_reset_waits_for_nothing_it_refuses_while_other_work_runs() {
    let db = test_db("reset_refuse").await;
    let mia = user(&db, 7).await;
    assert!(start(&db, &mia, "delete", false).unwrap_err().to_string().contains("DELETE"));

    // An import running: refused. (The job is running from the moment it starts.)
    let req = crate::finance::import::jobs::ImportRequest {
        file_name: "export.csv".into(),
        bytes: b"not a bank file".to_vec(),
        profile_key: "revolut".into(),
        account_map: Default::default(),
        post_older_than_days: None,
    };
    crate::finance::import::jobs::start(&db, &mia, req).unwrap();
    let err = start(&db, &mia, CONFIRM_WORD, false).unwrap_err();
    assert!(err.to_string().contains("import is running"), "{err}");
    while crate::finance::import::jobs::is_running(&db, &mia) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // A bulk action running: refused.
    let guard = begin_bulk(&db, &mia).unwrap();
    assert!(start(&db, &mia, CONFIRM_WORD, false).unwrap_err().to_string().contains("bulk action"));
    drop(guard);

    // A reset running: a bulk action, an import and a second reset are refused.
    let job = start(&db, &mia, CONFIRM_WORD, false).unwrap();
    assert_eq!(job.state, "running");
    assert!(begin_bulk(&db, &mia).is_err());
    assert!(start(&db, &mia, CONFIRM_WORD, false).is_err());
    let req = crate::finance::import::jobs::ImportRequest {
        file_name: "export.csv".into(),
        bytes: vec![],
        profile_key: "revolut".into(),
        account_map: Default::default(),
        post_older_than_days: None,
    };
    assert!(crate::finance::import::jobs::start(&db, &mia, req).unwrap_err().to_string().contains("being deleted"));
    loop {
        let j = status(&db, &mia, Some(job.job_id)).unwrap().unwrap();
        if j.state != "running" {
            assert_eq!(j.state, "done", "{j:?}");
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // Done: work is let in again.
    drop(begin_bulk(&db, &mia).unwrap());
    // Another user's job id is not found.
    let ana = user(&db, 8).await;
    assert!(matches!(status(&db, &ana, Some(job.job_id)), Err(AppError::NotFound(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_reset_doesnt_fail_a_concurrent_task_update() {
    let db = test_db("reset_concurrent").await;
    let mia = user(&db, 7).await;
    seed(&db, &mia, 10_000).await;
    let project = sqlx::query("INSERT INTO projects (name) VALUES ('P')").execute(&db).await.unwrap().last_insert_rowid();
    let task = sqlx::query("INSERT INTO tasks (project_id, title) VALUES (?, 'T')").bind(project).execute(&db).await.unwrap().last_insert_rowid();
    let started = std::time::Instant::now();
    let job = {
        let (db, mia) = (db.clone(), mia.clone());
        tokio::spawn(async move { reset(&db, &mia, false, &ResetOptions::default(), &|_, _| {}).await })
    };
    let mut slowest = Duration::ZERO;
    let mut updates = 0;
    while !job.is_finished() {
        let t = std::time::Instant::now();
        let input = crate::models::UpdateTaskInput { description: Some(format!("touch {updates}")), ..Default::default() };
        crate::ops::update_task(&db, task, input).await.expect("a task update during a reset");
        slowest = slowest.max(t.elapsed());
        updates += 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let took = started.elapsed();
    let r = job.await.unwrap().unwrap();
    assert_eq!(r.removed.entries, 10_001);
    assert_eq!(n(&db, "SELECT COUNT(*) FROM fin_entries WHERE entity_id = ?", &mia).await, 0);
    assert!(updates >= 3, "the reset ran {took:?}, {updates} updates");
    // As for the import: an update waits for one batch at most, well short of the whole reset.
    assert!(slowest < took * 3 / 4, "slowest update {slowest:?} of a reset taking {took:?}");
}
