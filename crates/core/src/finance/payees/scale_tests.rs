//! The first-user measure on generated data (never a real export): six years of 10,000 lines
//! from about 500 payees, many under two or three spellings, then a weekly file of 50 lines.
//! Ignored by default; run with
//! `cargo test -p ganban-core payees::scale_tests -- --ignored --nocapture`.

use std::collections::HashMap;

use chrono::{Duration, Local, NaiveDate};

use super::*;
use crate::finance::import::pipeline::{import_file_with, AccountChoice, ImportOptions, ImportResult, NewAccount};
use crate::finance::{list_accounts, list_entries, list_ledger_accounts, EntryFilter};

const CATEGORIES: &[&str] =
    &["Groceries", "Eating out", "Transport", "Shopping", "Entertainment", "Subscriptions", "Health", "Utilities"];
const FIRST: &[&str] = &[
    "Lumen", "Nordic", "Blue", "Olive", "Harbor", "Cedar", "Golden", "Silver", "Maple", "Aster", "Coral", "Ember",
    "Juniper", "Willow", "Saffron", "Indigo", "Velvet", "Granite", "Meadow", "Pebble",
];
const SECOND: &[&str] = &[
    "Bakery",
    "Market",
    "Kitchen",
    "Fuel",
    "Books",
    "Cinema",
    "Pharmacy",
    "Taxi",
    "Studio",
    "Garden",
    "Grill",
    "Records",
    "Outfitters",
    "Cafe",
    "Deli",
    "Hardware",
    "Optics",
    "Arcade",
    "Florist",
    "Gym",
    "Tailor",
    "Bistro",
    "Electric",
    "Water",
    "Transit",
];

/// A tiny deterministic generator.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Merchant {
    spellings: Vec<String>,
    category: &'static str,
    amount: i64,
}

/// One spelling of a name: as it is, upper case with an order tail, with a reference, with a
/// Greek letter standing in for a Latin one, or with a typo.
fn spell(name: &str, how: u64, n: u64) -> String {
    match how {
        0 => name.to_string(),
        1 => format!("{}*ORDER {n}", name.to_uppercase()),
        2 => format!("{name} #{n}"),
        3 => name.to_uppercase().replacen('A', "Α", 1).replacen('O', "Ο", 1),
        // A typo: a letter dropped. Only suggested, never merged.
        _ => {
            let at = name.len() - 2;
            format!("{}{}", &name[..at], &name[at + 1..])
        }
    }
}

fn merchants(rng: &mut Rng) -> Vec<Merchant> {
    let mut out = Vec::new();
    for (i, first) in FIRST.iter().enumerate() {
        for (j, second) in SECOND.iter().enumerate() {
            let name = format!("{first} {second}");
            let kinds = 1 + rng.below(3); // one to three spellings
            let spellings =
                (0..kinds).map(|k| spell(&name, if k == 0 { 0 } else { 1 + rng.below(4) }, 100 + k)).collect();
            out.push(Merchant {
                spellings,
                category: CATEGORIES[(i * 3 + j) % CATEGORIES.len()],
                amount: 300 + rng.below(9000) as i64,
            });
        }
    }
    out
}

fn line(day: NaiveDate, n: usize, text: &str, amount: i64) -> String {
    let (h, m, s) = (8 + n % 12, (n / 12) % 60, n % 60);
    format!(
        "card,Current,{day} {h:02}:{m:02}:{s:02},{day} {h:02}:{m:02}:{s:02},{text},-{}.{:02},0.00,EUR,,,\n",
        amount / 100,
        amount % 100
    )
}

/// Picks a merchant: a few are frequent, most are rare (weights 1/(i+1)).
fn pick(rng: &mut Rng, weights: &[f64], total: f64) -> usize {
    let mut x = (rng.below(1_000_000) as f64 / 1_000_000.0) * total;
    for (i, w) in weights.iter().enumerate() {
        if x < *w {
            return i;
        }
        x -= w;
    }
    weights.len() - 1
}

/// The user files one line under its payee's true category.
async fn sort_one(
    db: &Db,
    ent: &Entity,
    e: &crate::finance::Entry,
    truth: &HashMap<String, &'static str>,
    cat: &impl Fn(&str) -> i64,
) {
    let raw = e.payee.clone().unwrap_or(e.description.clone());
    let category = cat(truth.get(&certain_key(&raw)).copied().unwrap_or("Shopping"));
    let amount = e.lines.iter().find(|l| l.ledger_account_id != category).map(|l| l.amount_minor).unwrap();
    let split = vec![Split { ledger_account_id: category, amount_minor: amount, memo: None }];
    categorise(db, ent, e.id, split, DefaultChoice::Once).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn ten_thousand_lines_then_a_weekly_file() {
    let path = std::env::temp_dir().join(format!("ganban_payees_scale_{}.db", std::process::id()));
    for ext in ["db", "db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    let db = crate::init_db(&path).await.unwrap();
    sqlx::query("INSERT INTO users (id, username, full_name) VALUES (7, 'u7', 'User')").execute(&db).await.unwrap();
    let ent = crate::finance::entity_for_user(&db, 7).await.unwrap();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let ms = merchants(&mut rng);
    let weights: Vec<f64> = (0..ms.len()).map(|i| 1.0 / (i as f64 + 1.0)).collect();
    let total: f64 = weights.iter().sum();
    let spellings: usize = ms.iter().map(|m| m.spellings.len()).sum();

    let today = Local::now().date_naive();
    let start = today - Duration::days(6 * 365);
    let mut csv = String::from("Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n");
    for n in 0..10_000usize {
        let day = start + Duration::days((n as i64 * (6 * 365 - 8)) / 10_000);
        let m = &ms[pick(&mut rng, &weights, total)];
        let text = &m.spellings[rng.below(m.spellings.len() as u64) as usize];
        csv.push_str(&line(day, n, text, m.amount));
    }
    let opts = ImportOptions {
        pause: std::time::Duration::ZERO,
        pass_pause: std::time::Duration::ZERO,
        post_before: Some((today - Duration::days(90)).format("%Y-%m-%d").to_string()),
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let create = AccountChoice::Create {
        create: NewAccount {
            kind: "current".into(),
            name: "Everyday".into(),
            institution: None,
            currency: "EUR".into(),
        },
    };
    let map: HashMap<String, AccountChoice> = [("sample:current:EUR".to_string(), create)].into();
    let first: ImportResult =
        import_file_with(&db, &ent, "six-years.csv", csv.as_bytes(), "sample", map, &opts, &|_| {}).await.unwrap();
    let took = started.elapsed();
    let payees_after = list_payees(&db, &ent, PayeeFilter::default(), 1, 0).await.unwrap().total;
    let offered = suggestions(&db, &ent, 500).await.unwrap();

    // The user takes the merge suggestions that are right and dismisses the rest.
    let who: HashMap<String, usize> =
        ms.iter().enumerate().flat_map(|(i, m)| m.spellings.iter().map(move |s| (certain_key(s), i))).collect();
    let (mut merged, mut dismissed) = (0, 0);
    for sug in &offered {
        let key_of = |id: i64| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT key FROM fin_payee_aliases WHERE payee_id = ? LIMIT 1")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .unwrap()
            }
        };
        let live = |id: i64| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, Option<i64>>("SELECT merged_into FROM fin_payees WHERE id = ?")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .unwrap()
                    .is_none()
            }
        };
        if !(live(sug.a.id).await && live(sug.b.id).await) {
            continue;
        }
        let (a, b) = (key_of(sug.a.id).await, key_of(sug.b.id).await);
        if who.get(&a) == who.get(&b) {
            merge_payees(&db, &ent, sug.a.id, &[sug.b.id]).await.unwrap();
            merged += 1;
        } else {
            dismiss_suggestion(&db, &ent, sug.a.id, sug.b.id).await.unwrap();
            dismissed += 1;
        }
    }

    // The user sorts the inbox payee by payee: one line each, its default files the rest.
    let chart = list_ledger_accounts(&db, &ent, false).await.unwrap();
    let cat = |name: &str| chart.iter().find(|a| a.name == name).unwrap().id;
    let truth: HashMap<String, &'static str> =
        ms.iter().flat_map(|m| m.spellings.iter().map(move |s| (certain_key(s), m.category))).collect();
    let mut decisions = 0;
    loop {
        let f = EntryFilter { status: Some("draft".into()), ..Default::default() };
        let page = list_entries(&db, &ent, f, 1, 0).await.unwrap();
        let Some(e) = page.entries.into_iter().next() else { break };
        sort_one(&db, &ent, &e, &truth, &cat).await;
        decisions += 1;
    }

    // Two weekly files: 50 lines each from the same life, three of them from shops never
    // seen before. Between them the user works through the 50 largest payees of unsorted
    // history, one line each.
    let everyday = list_accounts(&db, &ent, false).await.unwrap()[0].id;
    let mut weekly = Vec::new();
    for w in 0..2i64 {
        let mut week = String::from("Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n");
        for n in 0..47usize {
            let m = &ms[pick(&mut rng, &weights, total)];
            let text = &m.spellings[rng.below(m.spellings.len() as u64) as usize];
            week.push_str(&line(
                today - Duration::days(1 + (n as i64 % 6)),
                20_000 + 100 * w as usize + n,
                text,
                m.amount,
            ));
        }
        for (n, shop) in ["Tidepool Ramen", "Quartz Laundry", "Harbor Bakery Patras"].iter().enumerate() {
            let shop = format!("{shop} {}", ["North", "South"][w as usize]);
            week.push_str(&line(today - Duration::days(1), 30_000 + 10 * w as usize + n, &shop, 1250));
        }
        let map: HashMap<String, AccountChoice> =
            [("sample:current:EUR".to_string(), AccountChoice::Existing(everyday))].into();
        let r = import_file_with(&db, &ent, "week.csv", week.as_bytes(), "sample", map, &opts, &|_| {}).await.unwrap();
        let payees: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT COALESCE(payee_id, -id)) FROM fin_entries WHERE entity_id = ? AND status = 'draft'",
        )
        .bind(ent.id)
        .fetch_one(&db)
        .await
        .unwrap();
        weekly.push((r, payees));
        // The user sorts it, then (after the first week) the largest unsorted history.
        let mut sorted = 0;
        loop {
            let f = EntryFilter { status: Some("draft".into()), ..Default::default() };
            let Some(e) = list_entries(&db, &ent, f, 1, 0).await.unwrap().entries.into_iter().next() else { break };
            sort_one(&db, &ent, &e, &truth, &cat).await;
            sorted += 1;
        }
        assert_eq!(sorted as i64, payees, "one decision per payee");
        if w == 0 {
            let page =
                list_payees(&db, &ent, PayeeFilter { unsorted: true, ..Default::default() }, 50, 0).await.unwrap();
            for p in page.payees {
                let f = EntryFilter { payee_id: Some(p.id), unsorted: Some(true), ..Default::default() };
                let e = list_entries(&db, &ent, f, 1, 0).await.unwrap().entries.remove(0);
                sort_one(&db, &ent, &e, &truth, &cat).await;
            }
        }
    }
    let history_left =
        list_payees(&db, &ent, PayeeFilter { unsorted: true, ..Default::default() }, 1, 0).await.unwrap();
    let left_lines: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM fin_entries WHERE unsorted = 1").fetch_one(&db).await.unwrap();

    println!("generated: 10000 lines over six years, {} payees under {spellings} spellings", ms.len());
    println!(
        "first import: {} created in {:.1?}; inbox {} (filed by payee {}, unsorted history {}, posted {})",
        first.created, took, first.decisions, first.filed_by_payee, first.history_unsorted, first.posted
    );
    println!("payees after certain merges: {payees_after}; merge suggestions offered: {}", offered.len());
    println!("suggestions taken: {merged} right, {dismissed} wrong (dismissed)");
    println!("sorting the first inbox took {decisions} decisions");
    for (w, (r, payees)) in weekly.iter().enumerate() {
        println!(
            "weekly file {} of 50: {} lines wait, from {payees} payees: {payees} decisions ({} filed by payee)",
            w + 1,
            r.decisions,
            r.filed_by_payee
        );
    }
    println!("unsorted history left: {left_lines} lines from {} payees", history_left.total);
    assert_eq!(first.created, 10_000);
    assert!(weekly[1].1 < 10, "{}", weekly[1].1);
}
