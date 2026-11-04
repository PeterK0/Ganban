//! Large imports and dedupe across repeat imports, on synthetic Revolut- and
//! Piraeus-shaped exports (made-up payees and amounts): chunking and resume, rates
//! fetched before any write, a concurrent write during an import, and every dedupe
//! case the owner of a long history runs into.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{Duration, NaiveDate, NaiveDateTime};
use rust_xlsxwriter::{Format as XFormat, Workbook};

use super::pipeline::*;
use crate::finance::*;
use crate::Db;

async fn test_db(tag: &str) -> Db {
    let path = std::env::temp_dir().join(format!("ganban_fdedupe_{}_{}.db", std::process::id(), tag));
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

/// One bank line of the synthetic truth: what the bank has, whatever the export.
#[derive(Clone)]
struct Line {
    typ: &'static str,
    product: &'static str,
    started: NaiveDateTime,
    desc: &'static str,
    amount: i64,
    fee: i64,
    cur: &'static str,
    balance: i64,
}

fn at(d: NaiveDate, h: u32, m: u32) -> NaiveDateTime {
    d.and_hms_opt(h, m, 0).unwrap()
}

/// Every day: two identical €3.20 coffees (08:05 and 15:00) and a grocery shop; the
/// 1st a salary and the plan fee; the 2nd a pocket move; the 15th an exchange to USD
/// with a fee. Balances run per account over the whole history.
fn truth(from: &str, to: &str) -> Vec<Line> {
    let (mut d, to) = (NaiveDate::parse_from_str(from, "%Y-%m-%d").unwrap(), NaiveDate::parse_from_str(to, "%Y-%m-%d").unwrap());
    let mut out = Vec::new();
    let mut bal: HashMap<&str, i64> = HashMap::from([("EUR", 500_000), ("USD", 0)]);
    let mut push = |out: &mut Vec<Line>, typ, started, desc, amount: i64, fee: i64, cur: &'static str| {
        let b = bal.get_mut(cur).unwrap();
        *b += amount - fee;
        out.push(Line { typ, product: "Current", started, desc, amount, fee, cur, balance: *b });
    };
    let mut n = 0i64;
    while d <= to {
        n += 1;
        if d.format("%d").to_string() == "01" {
            push(&mut out, "Topup", at(d, 6, 0), "Payment from Acme Payroll", 250_000, 0, "EUR");
            push(&mut out, "Fee", at(d, 6, 1), "Plan fee", -799, 0, "EUR");
        }
        if d.format("%d").to_string() == "02" {
            push(&mut out, "Transfer", at(d, 7, 0), "To EUR Holiday", -5_000, 0, "EUR");
        }
        push(&mut out, "Card Payment", at(d, 8, 5), "Cafe Nero", -320, 0, "EUR");
        push(&mut out, "Card Payment", at(d, 12, 30), "Green Market", -(500 + (n * 37) % 4_000), 0, "EUR");
        if d.format("%d").to_string() == "15" {
            push(&mut out, "Exchange", at(d, 13, 0), "Exchanged to USD", -10_000, 50, "EUR");
            push(&mut out, "Exchange", at(d, 13, 0) + Duration::seconds(1), "Exchanged to USD", 10_800, 0, "USD");
        }
        push(&mut out, "Card Payment", at(d, 15, 0), "Cafe Nero", -320, 0, "EUR");
        d += Duration::days(1);
    }
    out
}

fn money(m: i64) -> String {
    format!("{}{}.{:02}", if m < 0 { "-" } else { "" }, m.abs() / 100, m.abs() % 100)
}

fn revolut_csv(lines: &[Line], balances: bool) -> Vec<u8> {
    let mut s = String::from("Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n");
    for l in lines {
        let completed = l.started + Duration::minutes(30);
        let balance = if balances { money(l.balance) } else { String::new() };
        s.push_str(&format!(
            "{},{},{},{},{},{},{},{},COMPLETED,{balance}\n",
            l.typ,
            l.product,
            l.started.format("%Y-%m-%d %H:%M:%S"),
            completed.format("%Y-%m-%d %H:%M:%S"),
            l.desc,
            money(l.amount),
            money(l.fee),
            l.cur
        ));
    }
    s.into_bytes()
}

/// The same export as Revolut's XLSX: serial dates, numbers as numbers.
fn revolut_xlsx(lines: &[Line]) -> Vec<u8> {
    let mut book = Workbook::new();
    let sheet = book.add_worksheet();
    let date = XFormat::new().set_num_format("yyyy-mm-dd hh:mm:ss");
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let serial = |t: NaiveDateTime| (t - epoch).num_seconds() as f64 / 86_400.0;
    for (c, h) in ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"]
        .iter()
        .enumerate()
    {
        sheet.write_string(0, c as u16, *h).unwrap();
    }
    for (i, l) in lines.iter().enumerate() {
        let r = i as u32 + 1;
        sheet.write_string(r, 0, l.typ).unwrap();
        sheet.write_string(r, 1, l.product).unwrap();
        sheet.write_number_with_format(r, 2, serial(l.started), &date).unwrap();
        sheet.write_number_with_format(r, 3, serial(l.started + Duration::minutes(30)), &date).unwrap();
        sheet.write_string(r, 4, l.desc).unwrap();
        sheet.write_number(r, 5, l.amount as f64 / 100.0).unwrap();
        sheet.write_number(r, 6, l.fee as f64 / 100.0).unwrap();
        sheet.write_string(r, 7, l.cur).unwrap();
        sheet.write_string(r, 8, "COMPLETED").unwrap();
        sheet.write_number(r, 9, l.balance as f64 / 100.0).unwrap();
    }
    book.save_to_buffer().unwrap()
}

/// A Piraeus export of the EUR lines: dates only, with the progressive balance.
fn piraeus_csv(lines: &[Line], balances: bool) -> Vec<u8> {
    let mut s = String::from("Piraeus Bank\r\nACC: GR16 0110 1250 0000 0001 2300 695\r\n\r\n");
    s.push_str("Category;Transaction Details;Transaction Date;Transaction Comments / Reference Code;Amount;Currency;Progressive Ledger Balance;Currency\r\n");
    for l in lines.iter().filter(|l| l.cur == "EUR") {
        s.push_str(&format!(
            "Shopping;{};{};;{};EUR;{};EUR\r\n",
            l.desc.to_uppercase(),
            l.started.format("%d/%m/%Y"),
            money(l.amount - l.fee).replace('.', ","),
            if balances { money(l.balance).replace('.', ",") } else { String::new() }
        ));
    }
    s.into_bytes()
}

fn between(lines: &[Line], from: &str, to: &str) -> Vec<Line> {
    lines.iter().filter(|l| l.started.format("%Y-%m-%d %H:%M").to_string().as_str() >= from && l.started.format("%Y-%m-%d %H:%M").to_string().as_str() < to).cloned().collect()
}

/// Maps the file's accounts: the user's existing ones by name, else new ones.
async fn map_for(db: &Db, ent: &Entity, bytes: &[u8]) -> HashMap<String, AccountChoice> {
    let parsed = super::parse(bytes, None).unwrap();
    let accounts = list_accounts(db, ent, false).await.unwrap();
    parsed
        .accounts
        .iter()
        .map(|g| {
            let choice = match accounts.iter().find(|a| a.name == g.name) {
                Some(a) => AccountChoice::Existing(a.id),
                None => AccountChoice::Create {
                    create: NewAccount { kind: g.kind.clone(), name: g.name.clone(), institution: g.institution.clone(), currency: g.currency.clone() },
                },
            };
            (g.guess_key.clone(), choice)
        })
        .collect()
}

async fn import(db: &Db, ent: &Entity, bytes: &[u8]) -> ImportResult {
    let key = super::parse(bytes, None).unwrap().profile_key.unwrap();
    import_file(db, ent, "export", bytes, &key, map_for(db, ent, bytes).await).await.unwrap()
}

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(db).await.unwrap()
}

async fn source_lines(db: &Db) -> i64 {
    count(db, "SELECT COUNT(*) FROM fin_source_lines").await
}

async fn coffees_on(db: &Db, date: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM fin_source_lines WHERE booked_date = ? AND lower(description) = 'cafe nero'")
        .bind(date)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn usd_rates(db: &Db) {
    rates::store_rates(db, &[("2018-01-01".into(), "USD".into(), 1.08)], "test").await.unwrap();
}

#[tokio::test]
async fn the_same_full_year_twice_adds_nothing() {
    let db = test_db("year_twice").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let year = truth("2025-01-01", "2025-12-31");
    let file = revolut_csv(&year, true);
    let first = import(&db, &ent, &file).await;
    assert_eq!((first.created, first.duplicates), (year.len(), 0));
    // Two identical coffees a day, both kept.
    assert_eq!(coffees_on(&db, "2025-03-10").await, 2);
    let second = import(&db, &ent, &file).await;
    assert_eq!((second.created, second.duplicates), (0, year.len()));
    assert_eq!(source_lines(&db).await, year.len() as i64);
    assert_eq!(coffees_on(&db, "2025-03-10").await, 2);
}

#[tokio::test]
async fn overlapping_exports_leave_each_line_once() {
    let db = test_db("overlap").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let all = truth("2025-01-01", "2026-03-31");
    let jan_dec = between(&all, "2025-01-01", "2026-01-01");
    let jul_mar = between(&all, "2025-07-01", "2026-04-01");
    import(&db, &ent, &revolut_csv(&jan_dec, true)).await;
    let r = import(&db, &ent, &revolut_csv(&jul_mar, true)).await;
    assert_eq!(r.created, all.len() - jan_dec.len());
    assert_eq!(source_lines(&db).await, all.len() as i64);
    for day in ["2025-06-30", "2025-07-01", "2025-12-31", "2026-01-01"] {
        assert_eq!(coffees_on(&db, day).await, 2, "{day}");
    }
}

#[tokio::test]
async fn an_export_cutting_into_a_day_neither_drops_nor_doubles() {
    // Revolut: the window ends at noon, the next starts at noon; one coffee each side.
    let all = truth("2025-05-01", "2025-05-03");
    for balances in [true, false] {
        let db = test_db(&format!("cut_revolut_{balances}")).await;
        let ent = user(&db, 7).await;
        import(&db, &ent, &revolut_csv(&between(&all, "2025-05-01", "2025-05-02 12:00"), balances)).await;
        assert_eq!(coffees_on(&db, "2025-05-02").await, 1);
        import(&db, &ent, &revolut_csv(&between(&all, "2025-05-02 12:00", "2025-05-04"), balances)).await;
        assert_eq!(coffees_on(&db, "2025-05-02").await, 2, "balances: {balances}");
        // And the whole period again adds nothing.
        let r = import(&db, &ent, &revolut_csv(&all, balances)).await;
        assert_eq!(r.created, 0, "balances: {balances}");
        assert_eq!(source_lines(&db).await, all.len() as i64);
    }
    // Piraeus has no time, so the progressive balance tells the coffees apart.
    let db = test_db("cut_piraeus").await;
    let ent = user(&db, 7).await;
    let eur: Vec<Line> = all.iter().filter(|l| l.cur == "EUR").cloned().collect();
    import(&db, &ent, &piraeus_csv(&between(&eur, "2025-05-01", "2025-05-02 12:00"), true)).await;
    import(&db, &ent, &piraeus_csv(&between(&eur, "2025-05-02 12:00", "2025-05-04"), true)).await;
    assert_eq!(coffees_on(&db, "2025-05-02").await, 2);
    assert_eq!(import(&db, &ent, &piraeus_csv(&eur, true)).await.created, 0);
    assert_eq!(source_lines(&db).await, eur.len() as i64);
}

#[tokio::test]
async fn csv_and_xlsx_of_the_same_data_dedupe() {
    let db = test_db("formats").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let lines = truth("2025-02-01", "2025-03-31");
    let xlsx = revolut_xlsx(&lines);
    assert_eq!(super::parse(&xlsx, None).unwrap().format, super::Format::Xlsx);
    assert_eq!(import(&db, &ent, &revolut_csv(&lines, true)).await.created, lines.len());
    let r = import(&db, &ent, &xlsx).await;
    assert_eq!((r.created, r.duplicates), (0, lines.len()));
}

#[tokio::test]
async fn a_masked_balance_still_dedupes_against_an_import_with_balances() {
    let db = test_db("masked").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let lines = truth("2025-04-01", "2025-04-30");
    import(&db, &ent, &revolut_csv(&lines, true)).await;
    let r = import(&db, &ent, &revolut_csv(&lines, false)).await;
    assert_eq!((r.created, r.duplicates), (0, lines.len()));
    // With no timestamps either (Piraeus), both ways round: counting keeps the two
    // coffees a day two, and adds none.
    for (first, then) in [(true, false), (false, true)] {
        let db = test_db(&format!("masked_piraeus_{first}")).await;
        let ent = user(&db, 7).await;
        assert_eq!(import(&db, &ent, &piraeus_csv(&lines, first)).await.created, lines.len() - 1, "the USD leg isn't a Piraeus line");
        assert_eq!(import(&db, &ent, &piraeus_csv(&lines, then)).await.created, 0);
        assert_eq!(coffees_on(&db, "2025-04-10").await, 2);
    }
}

#[tokio::test]
async fn lines_imported_before_groups_existed_still_match() {
    let db = test_db("old_hash").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let lines = truth("2025-01-01", "2025-01-31");
    let file = revolut_csv(&lines, true);
    import(&db, &ent, &file).await;
    // Stand for lines stored by the old importer: a v1 hash, no group, no timestamp.
    sqlx::query("UPDATE fin_source_lines SET hash = 'v1-' || id, dedupe_key = NULL, occurred_at = NULL").execute(&db).await.unwrap();
    super::dedupe::backfill(&db).await.unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_source_lines WHERE dedupe_key IS NULL OR occurred_at IS NULL").await, 0);
    let r = import(&db, &ent, &file).await;
    assert_eq!((r.created, r.duplicates), (0, lines.len()));
}

#[tokio::test]
async fn an_interrupted_import_finishes_on_a_rerun() {
    let db = test_db("resume").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let lines = truth("2025-01-01", "2025-03-31");
    let file = revolut_csv(&lines, true);
    let opts = ImportOptions { chunk: 25, pass_chunk: 10, fail_after_chunks: Some(3), ..Default::default() };
    let map = map_for(&db, &ent, &file).await;
    let err = import_file_with(&db, &ent, "export", &file, "revolut", map, &opts, &|_| {}).await.unwrap_err();
    assert!(err.is_invalid_input());
    // Three batches committed; the batch is left unfinished, unpaired.
    assert_eq!(source_lines(&db).await, 75);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_import_batches WHERE status = 'running'").await, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_pairs").await, 0);

    let mut seen = Vec::new();
    let seen_ref = Arc::new(Mutex::new(Vec::new()));
    let sink = seen_ref.clone();
    let map = map_for(&db, &ent, &file).await;
    let opts = ImportOptions { chunk: 25, pass_chunk: 10, ..Default::default() };
    let r = import_file_with(&db, &ent, "export", &file, "revolut", map, &opts, &move |p| sink.lock().unwrap().push(p)).await.unwrap();
    seen.extend(seen_ref.lock().unwrap().iter().copied());
    assert_eq!((r.created, r.duplicates), (lines.len() - 75, 75));
    assert_eq!(source_lines(&db).await, lines.len() as i64);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_import_batches WHERE status = 'running'").await, 0);
    // Every pocket move and exchange is paired, the first batches' ones too: 3 pocket
    // moves, 3 exchanges.
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_pairs WHERE status = 'auto'").await, 6);
    // Progress went through the stages, the rows in batches, and ended done.
    let rows: Vec<&Progress> = seen.iter().filter(|p| p.stage == Stage::Rows).collect();
    assert_eq!(rows.first().map(|p| (p.done, p.total)), Some((75, lines.len())));
    assert!(rows.len() > 2 && rows.windows(2).all(|w| w[0].done <= w[1].done));
    assert_eq!(seen.last().map(|p| p.stage), Some(Stage::Done));
    // A third run adds nothing and pairs nothing twice.
    let r = import(&db, &ent, &file).await;
    assert_eq!((r.created, r.paired), (0, 0));
}

#[tokio::test]
async fn a_rerun_with_another_file_still_finishes_the_interrupted_lines() {
    let db = test_db("resume_other").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let lines = truth("2025-01-01", "2025-03-31");
    let file = revolut_csv(&lines, true);
    let opts = ImportOptions { chunk: 25, fail_after_chunks: Some(3), ..Default::default() };
    let map = map_for(&db, &ent, &file).await;
    import_file_with(&db, &ent, "export", &file, "revolut", map, &opts, &|_| {}).await.unwrap_err();
    assert_eq!(source_lines(&db).await, 75, "1 to about 19 January, with the exchange on the 15th");
    // The next import is March only: January's stored lines still get paired.
    let r = import(&db, &ent, &revolut_csv(&between(&lines, "2025-03-01", "2025-04-01"), true)).await;
    assert_eq!(r.duplicates, 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM fin_import_batches WHERE status = 'running'").await, 0);
    let january_fx: i64 = count(
        &db,
        "SELECT COUNT(*) FROM fin_pairs p JOIN fin_entries e ON e.id = p.entry_a WHERE p.kind = 'fx' AND e.date LIKE '2025-01-%'",
    )
    .await;
    assert_eq!(january_fx, 1);
}

#[tokio::test]
async fn rates_are_fetched_before_anything_is_written() {
    let db = test_db("rates_first").await;
    let ent = user(&db, 7).await;
    let lines = truth("2025-01-10", "2025-01-20");
    let file = revolut_csv(&lines, true);
    let map = map_for(&db, &ent, &file).await;
    // The fetcher looks at the database when it's called: nothing may be written yet.
    let calls: Arc<Mutex<Vec<(i64, i64)>>> = Arc::new(Mutex::new(Vec::new()));
    let (seen, probe) = (calls.clone(), db.clone());
    let fetcher: rates::Fetcher = Arc::new(move |_url| {
        let (seen, probe) = (seen.clone(), probe.clone());
        Box::pin(async move {
            let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_source_lines").fetch_one(&probe).await.unwrap();
            let batches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fin_import_batches").fetch_one(&probe).await.unwrap();
            seen.lock().unwrap().push((lines, batches));
            Ok("<Cube><Cube time='2025-01-02'><Cube currency='USD' rate='1.0800'/></Cube></Cube>".to_string())
        })
    });
    let r = rates::with_fetcher(fetcher, import_file(&db, &ent, "export", &file, "revolut", map)).await.unwrap();
    assert_eq!(r.created, lines.len());
    assert_eq!(*calls.lock().unwrap(), vec![(0, 0)], "one fetch, before any write");
    // The needs: each USD line's date (the functional currency is the euro).
    let parsed = super::parse(&file, None).unwrap();
    let rows: Vec<&super::ParsedRow> = parsed.rows.iter().collect();
    let (need, like) = rates_needed(&rows, "EUR");
    assert_eq!(need, vec![("USD".to_string(), "2025-01-15".to_string())]);
    assert_eq!(like, need);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_long_import_doesnt_fail_a_concurrent_task_update() {
    let db = test_db("concurrent").await;
    let ent = user(&db, 7).await;
    usd_rates(&db).await;
    let project = sqlx::query("INSERT INTO projects (name) VALUES ('P')").execute(&db).await.unwrap().last_insert_rowid();
    let task = sqlx::query("INSERT INTO tasks (project_id, title) VALUES (?, 'T')").bind(project).execute(&db).await.unwrap().last_insert_rowid();
    let lines = truth("2025-01-01", "2025-12-31");
    let file = revolut_csv(&lines, true);
    let map = map_for(&db, &ent, &file).await;
    let started = std::time::Instant::now();
    let job = {
        let (db, ent) = (db.clone(), ent.clone());
        tokio::spawn(async move { import_file(&db, &ent, "export", &file, "revolut", map).await })
    };
    let mut slowest = std::time::Duration::ZERO;
    let mut updates = 0;
    while !job.is_finished() {
        let t = std::time::Instant::now();
        let input = crate::models::UpdateTaskInput { description: Some(format!("touch {updates}")), ..Default::default() };
        crate::ops::update_task(&db, task, input).await.expect("a task update during an import");
        slowest = slowest.max(t.elapsed());
        updates += 1;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let took = started.elapsed();
    let r = job.await.unwrap().unwrap();
    assert_eq!(r.created, lines.len());
    assert!(updates >= 3, "the import ran {took:?}, {updates} updates");
    // No update waited anywhere near the import's length (one batch at most).
    assert!(slowest < took / 3, "slowest update {slowest:?} of an import taking {took:?}");
}
