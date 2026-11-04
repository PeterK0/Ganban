//! Wave 2 tests on a throwaway database: close, schedules, budgets, the forecast and the
//! statements, with made-up accounts, amounts and rates.

use super::tests::{account, balanced, la, test_db, user};
use super::*;

fn journal(date: &str, payee: &str, lines: Vec<LineInput>) -> EntryInput {
    EntryInput { date: date.into(), description: payee.into(), payee: Some(payee.into()), notes: None, lines }
}

/// A posted bank movement: `amount` on the account against `category`.
async fn spend(db: &Db, ent: &Entity, acct: &FinAccount, category: i64, date: &str, payee: &str, amount: i64) -> Entry {
    let lines = vec![LineInput::new(acct.ledger_account_id, amount, &acct.currency), LineInput::new(category, -amount, "EUR")];
    create_entry(db, ent, journal(date, payee, lines)).await.unwrap()
}

async fn balance(db: &Db, ent: &Entity, la: i64, as_of: &str) -> i64 {
    trial_balance(db, ent, as_of).await.unwrap().iter().find(|r| r.ledger_account_id == la).map_or(0, |r| r.debit_minor - r.credit_minor)
}

fn row<'a>(s: &'a statements::Statement, key: &str) -> &'a statements::Row {
    s.rows.iter().find(|r| r.key == key).unwrap_or_else(|| panic!("no row {key}"))
}

#[tokio::test]
async fn close_retranslates_releases_and_locks_in_order() {
    let db = test_db("w2_close").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-01-01".into(), "USD".into(), 1.25), ("2026-01-30".into(), "USD".into(), 1.0)], "ecb")
        .await
        .unwrap();
    let eur = create_account(&db, &ent, account("current", "Everyday", "EUR", 500_000)).await.unwrap();
    // 100.00 USD at 1.25 = 80.00 EUR on opening.
    let usd = create_account(&db, &ent, account("current", "Dollars", "USD", 10_000)).await.unwrap();
    assert_eq!(get_account(&db, &ent, usd.id).await.unwrap().balance_functional_minor, 8_000);

    // A month closes after it ends, and in order.
    assert!(close::close_period(&db, &ent, "2026-02", false, "2026-02-20").await.unwrap_err().is_invalid_input());
    assert!(close::close_period(&db, &ent, "2026-02", false, "2026-03-05").await.unwrap_err().to_string().contains("2026-01"));

    // January: the closing rate (the 30th, the last on or before the 31st) is 1.00.
    let jan = close::close_period(&db, &ent, "2026-01", false, "2026-02-15").await.unwrap();
    assert!(jan.closed && jan.blockers.is_empty());
    let retr = get_entry(&db, &ent, jan.retranslation_entry_id.unwrap()).await.unwrap();
    assert!(balanced(&retr));
    assert_eq!(retr.date, "2026-01-31");
    let gain = system_account(&db, &ent, system::FX_UNREALISED_GAIN).await.unwrap().id;
    assert_eq!(balance(&db, &ent, gain, "2026-01-31").await, -2_000);
    let a = get_account(&db, &ent, usd.id).await.unwrap();
    assert_eq!((a.balance_minor, a.balance_functional_minor), (10_000, 10_000));
    assert!(close::close_period(&db, &ent, "2026-01", false, "2026-02-15").await.is_err(), "only once");

    // February: a year's insurance paid ahead, spread over 12 months from February.
    let housing = la(&db, &ent, "Housing").await;
    let paid = spend(&db, &ent, &eur, housing, "2026-02-01", "Insurer", -120_000).await;
    let sched = schedules::create_schedule(&db, &ent, schedules::ScheduleInput {
        entry_id: paid.id,
        ledger_account_id: None,
        start_month: "2026-02".into(),
        months: 12,
    })
    .await
    .unwrap();
    assert_eq!((sched.kind.as_str(), sched.amount_minor, sched.rows.len()), ("prepaid", 120_000, 12));
    assert!(sched.rows.iter().all(|r| r.amount_minor == 10_000 && !r.released));
    let prepay = system_account(&db, &ent, system::PREPAYMENTS).await.unwrap().id;
    assert_eq!(balance(&db, &ent, prepay, "2026-02-28").await, 120_000, "deferred to prepayments");
    // The entry's lines are fixed while it has a schedule, and it says so.
    assert!(!paid.scheduled);
    let paid_now = get_entry(&db, &ent, paid.id).await.unwrap();
    assert!(paid_now.scheduled, "the screens hide splits and Delete on it");
    assert!(get_entry(&db, &ent, sched.deferral_entry_id.unwrap()).await.unwrap().scheduled);
    assert!(delete_entry(&db, &ent, paid.id).await.unwrap_err().is_invalid_input());

    // Profit or loss and budgets go by recognition period, before the release posts.
    budgets::create_budget(&db, &ent, budgets::BudgetInput { ledger_account_id: housing, month: None, amount_minor: 15_000 }).await.unwrap();
    let progress = budgets::budget_progress(&db, &ent, "2026-02").await.unwrap();
    assert_eq!((progress[0].actual_minor, progress[0].remaining_minor), (10_000, 5_000));
    let pl = statements::statement(&db, &ent, "profit_loss", "2026-02", true).await.unwrap();
    assert_eq!(row(&pl, &format!("expense:{housing}")).amount_minor, 10_000);

    // A draft blocks the close unless forced.
    let unc = system_account(&db, &ent, system::UNCATEGORISED_EXPENSE).await.unwrap().id;
    let mut d = BankDraft {
        account_id: eur.id,
        date: "2026-02-10".into(),
        description: "Shop".into(),
        payee: None,
        amount_minor: -500,
        fee_minor: 0,
        counter_ledger_account_id: unc,
        source_line_id: None,
        functional_minor: None,
    };
    let draft = create_bank_draft(&db, &ent, d.clone()).await.unwrap();
    let held = close::close_period(&db, &ent, "2026-02", false, "2026-03-05").await.unwrap();
    assert!(!held.closed);
    assert_eq!(held.blockers.drafts, vec![draft.id]);
    assert!(!close::close_period(&db, &ent, "2026-02", true, "2026-03-05").await.unwrap().closed, "drafts hold even a forced close");
    delete_entry(&db, &ent, draft.id).await.unwrap();
    // An uncategorised posted line blocks it too.
    d.date = "2026-02-11".into();
    let posted = create_bank_draft(&db, &ent, d).await.unwrap();
    post_entries(&db, &ent, &[posted.id]).await.unwrap();
    let held = close::close_period(&db, &ent, "2026-02", false, "2026-03-05").await.unwrap();
    assert_eq!((held.closed, held.blockers.uncategorised.clone()), (false, vec![posted.id]));
    let feb = close::close_period(&db, &ent, "2026-02", true, "2026-03-05").await.unwrap();
    assert!(feb.closed);
    assert_eq!(feb.retranslation_entry_id, None, "no rate moved");
    assert_eq!(feb.release_entry_ids.len(), 1);
    let release = get_entry(&db, &ent, feb.release_entry_ids[0]).await.unwrap();
    assert_eq!(release.date, "2026-02-28");
    assert_eq!(balance(&db, &ent, prepay, "2026-02-28").await, 110_000);
    assert_eq!(balance(&db, &ent, housing, "2026-02-28").await, 10_000);
    let rows = schedules::list_schedules(&db, &ent, Some(paid.id)).await.unwrap().remove(0).rows;
    assert!(rows[0].released && !rows[1].released);
    // Released months can't be undone by deleting the schedule.
    assert!(schedules::delete_schedule(&db, &ent, sched.id).await.is_err());

    let periods = close::list_periods(&db, &ent, "2026-03-05").await.unwrap();
    let st: Vec<(&str, &str)> = periods.iter().map(|p| (p.month.as_str(), p.status.as_str())).collect();
    assert_eq!(st, vec![("2026-01", "closed"), ("2026-02", "closed"), ("2026-03", "open")]);

    // After the close, reversing the paid entry takes its deferral and release with it.
    assert!(reverse_entry(&db, &ent, release.id, "2026-03-02").await.is_err(), "not the release alone");
    reverse_entry(&db, &ent, paid.id, "2026-03-02").await.unwrap();
    assert_eq!((balance(&db, &ent, prepay, "2026-03-31").await, balance(&db, &ent, housing, "2026-03-31").await), (0, 0));
    assert!(schedules::list_schedules(&db, &ent, None).await.unwrap().is_empty());

    // An accrued bill: paid in May for March to May. April has no entries, so closing May
    // after March posts April's release too.
    let bill = spend(&db, &ent, &eur, housing, "2026-05-10", "Water", -9_000).await;
    let accrued = schedules::create_schedule(&db, &ent, schedules::ScheduleInput {
        entry_id: bill.id,
        ledger_account_id: Some(housing),
        start_month: "2026-03".into(),
        months: 3,
    })
    .await
    .unwrap();
    assert_eq!(accrued.kind, "accrued");
    let accrual = system_account(&db, &ent, system::ACCRUED_EXPENSES).await.unwrap().id;
    assert_eq!(close::close_period(&db, &ent, "2026-03", true, "2026-06-02").await.unwrap().release_entry_ids.len(), 1);
    assert_eq!(balance(&db, &ent, accrual, "2026-03-31").await, -3_000, "owed, not yet paid");
    assert_eq!(close::close_period(&db, &ent, "2026-05", true, "2026-06-02").await.unwrap().release_entry_ids.len(), 2);
    assert_eq!(balance(&db, &ent, accrual, "2026-05-31").await, 0);
    assert_eq!(balance(&db, &ent, housing, "2026-04-30").await, 6_000);
}

#[tokio::test]
async fn a_closed_period_refuses_edits() {
    let db = test_db("w2_locked").await;
    let ent = user(&db, 7).await;
    let eur = create_account(&db, &ent, account("current", "Everyday", "EUR", 100_000)).await.unwrap();
    let groceries = la(&db, &ent, "Groceries").await;
    let shop = spend(&db, &ent, &eur, groceries, "2026-01-20", "Market", -2_000).await;
    close::close_period(&db, &ent, "2026-01", false, "2026-02-02").await.unwrap();

    let closed = |e: AppError| e.to_string() == "Invalid input: closed period: reverse it instead";
    assert!(closed(update_entry(&db, &ent, shop.id, EntryPatch { description: Some("x".into()), ..Default::default() }).await.unwrap_err()));
    assert!(closed(delete_entry(&db, &ent, shop.id).await.unwrap_err()));
    let line = |la: i64, amount: i64| LineInput::new(la, amount, "EUR");
    let jan = journal("2026-01-25", "Late", vec![line(eur.ledger_account_id, -100), line(groceries, 100)]);
    assert!(closed(create_entry(&db, &ent, jan).await.unwrap_err()));
    // A month before the first close is locked too, though it never had an entry.
    let dec = journal("2025-12-20", "Older", vec![line(eur.ledger_account_id, -100), line(groceries, 100)]);
    assert!(closed(create_entry(&db, &ent, dec).await.unwrap_err()));
    assert!(closed(reverse_entry(&db, &ent, shop.id, "2026-01-31").await.unwrap_err()));
    // Corrections go through a reversal in an open month.
    let rev = reverse_entry(&db, &ent, shop.id, "2026-02-01").await.unwrap();
    assert_eq!(rev.reverses_id, Some(shop.id));
    // A schedule can't reach back into the closed month.
    let feb = spend(&db, &ent, &eur, groceries, "2026-02-03", "Market", -1_200).await;
    let back = schedules::ScheduleInput { entry_id: feb.id, ledger_account_id: None, start_month: "2026-01".into(), months: 3 };
    assert!(closed(schedules::create_schedule(&db, &ent, back).await.unwrap_err()));
}

#[tokio::test]
async fn a_journal_across_currencies_posts_its_exchange_difference() {
    let db = test_db("w2_multi").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-03-01".into(), "USD".into(), 1.25)], "ecb").await.unwrap();
    let eur = create_account(&db, &ent, account("cash", "Wallet", "EUR", 0)).await.unwrap();
    let usd = create_account(&db, &ent, account("cash", "Dollars", "USD", 0)).await.unwrap();
    // 100.00 EUR changed into 108.00 USD: 108 / 1.25 = 86.40 EUR, so 13.60 EUR lost.
    let e = create_entry(&db, &ent, journal("2026-03-02", "Exchange desk", vec![
        LineInput::new(usd.ledger_account_id, 10_800, "USD"),
        LineInput::new(eur.ledger_account_id, -10_000, "EUR"),
    ]))
    .await
    .unwrap();
    assert!(balanced(&e));
    let loss = system_account(&db, &ent, system::FX_REALISED_LOSS).await.unwrap().id;
    assert_eq!(e.lines.iter().find(|l| l.ledger_account_id == loss).map(|l| l.functional_minor), Some(1_360));
    // One currency still has to balance on its own.
    let groceries = la(&db, &ent, "Groceries").await;
    let off = journal("2026-03-02", "Off", vec![LineInput::new(eur.ledger_account_id, -100, "EUR"), LineInput::new(groceries, 99, "EUR")]);
    assert!(create_entry(&db, &ent, off).await.is_err());
}

/// Six months of history: rent on the 1st, pay on the 25th, groceries twice a month.
async fn history(db: &Db, ent: &Entity) -> (FinAccount, i64, i64) {
    let eur = create_account(db, ent, account("current", "Everyday", "EUR", 500_000)).await.unwrap();
    let (housing, salary, groceries) = (la(db, ent, "Housing").await, la(db, ent, "Salary").await, la(db, ent, "Groceries").await);
    let grocery_months = [30_000, 35_000, 32_000, 28_000, 40_000, 31_000];
    for (i, g) in grocery_months.iter().enumerate() {
        let m = format!("2026-{:02}", i + 1);
        spend(db, ent, &eur, housing, &format!("{m}-01"), "Landlord", -80_000).await;
        spend(db, ent, &eur, groceries, &format!("{m}-03"), "Market", -g / 2).await;
        spend(db, ent, &eur, groceries, &format!("{m}-17"), "Market", -(g - g / 2)).await;
        spend(db, ent, &eur, salary, &format!("{m}-25"), "Employer", 250_000).await;
    }
    spend(db, ent, &eur, housing, "2026-07-01", "Landlord", -80_000).await;
    spend(db, ent, &eur, groceries, "2026-07-03", "Market", -10_000).await;
    (eur, groceries, housing)
}

#[tokio::test]
async fn the_forecast_is_stable_for_a_fixture_history() {
    let db = test_db("w2_forecast").await;
    let ent = user(&db, 7).await;
    let (_eur, groceries, _) = history(&db, &ent).await;
    let found = recurring::detect_recurring(&db, &ent, "2026-07-05").await.unwrap();
    let mut keys: Vec<(&str, &str)> = found.iter().map(|r| (r.key.as_str(), r.cadence.as_str())).collect();
    keys.sort();
    assert_eq!(keys, vec![("employer:in", "monthly"), ("landlord:out", "monthly")], "groceries don't keep a cadence");
    for r in &found {
        recurring::resolve_recurring(&db, &ent, r.id, true).await.unwrap();
    }
    budgets::create_budget(&db, &ent, budgets::BudgetInput { ledger_account_id: groceries, month: None, amount_minor: 30_000 }).await.unwrap();
    recurring::create_planned(&db, &ent, recurring::PlannedInput {
        date: "2026-07-20".into(),
        description: "Concert tickets".into(),
        amount_minor: -6_000,
        ledger_account_id: None,
        account_id: None,
    })
    .await
    .unwrap();

    let f = forecast::forecast(&db, &ent, "2026-07", "2026-07-05").await.unwrap();
    // Opening: 5000 + 6 × (2500 − 800) − 1960 groceries − 800 rent − 100 groceries.
    assert_eq!(f.opening_minor, 1_234_000);
    let kinds: Vec<(&str, i64)> = f.lines.iter().map(|l| (l.kind.as_str(), l.amount_minor)).collect();
    // Pay on the 25th; the concert; groceries' median (315.00) less the 100.00 spent.
    assert_eq!(kinds, vec![("opening", 1_234_000), ("recurring", 250_000), ("planned", -6_000), ("category", -21_500)]);
    assert_eq!((f.end_minor, f.low_minor, f.high_minor), (1_456_500, 1_448_000, 1_460_000));
    assert_eq!(f.end_minor, f.lines.iter().map(|l| l.amount_minor).sum::<i64>(), "line by line");
    let g = f.categories.iter().find(|c| c.ledger_account_id == groceries).unwrap();
    assert_eq!((g.actual_minor, g.projected_minor, g.median_minor, g.history_months), (10_000, 31_500, 31_500, 6));
    assert_eq!(f.warnings.len(), 1);
    assert_eq!(f.warnings[0].over_minor, 1_500);
    // The same books give the same forecast.
    let again = forecast::forecast(&db, &ent, "2026-07", "2026-07-05").await.unwrap();
    assert_eq!(serde_json::to_value(&f).unwrap(), serde_json::to_value(&again).unwrap());

    // August builds on July's projected end: rent, pay and a full month of groceries.
    let aug = forecast::forecast(&db, &ent, "2026-08", "2026-07-05").await.unwrap();
    assert_eq!(aug.opening_minor, 1_456_500);
    assert_eq!(aug.end_minor, 1_456_500 - 80_000 + 250_000 - 31_500);
    // A month that's over reports what happened.
    let june = forecast::forecast(&db, &ent, "2026-06", "2026-07-05").await.unwrap();
    assert_eq!(june.end_minor - june.opening_minor, 250_000 - 80_000 - 31_000);

    // Dismissed stays dismissed on the next detection.
    let landlord = found.iter().find(|r| r.key == "landlord:out").unwrap();
    recurring::resolve_recurring(&db, &ent, landlord.id, false).await.unwrap();
    let again = recurring::detect_recurring(&db, &ent, "2026-07-06").await.unwrap();
    assert_eq!(again.iter().find(|r| r.id == landlord.id).unwrap().status, "dismissed");
}

#[tokio::test]
async fn the_statements_balance_and_reconcile() {
    let db = test_db("w2_statements").await;
    let ent = user(&db, 7).await;
    rates::store_rates(&db, &[("2026-01-01".into(), "USD".into(), 1.25), ("2026-01-30".into(), "USD".into(), 1.0)], "ecb")
        .await
        .unwrap();
    let eur = create_account(&db, &ent, account("current", "Everyday", "EUR", 100_000)).await.unwrap();
    create_account(&db, &ent, account("current", "Dollars", "USD", 10_000)).await.unwrap();
    let loan = create_account(&db, &ent, account("loan", "Car loan", "EUR", 0)).await.unwrap();
    let savings = create_account(&db, &ent, account("savings", "Rainy day", "EUR", 0)).await.unwrap();
    let card = create_account(&db, &ent, account("card", "Credit card", "EUR", 0)).await.unwrap();
    let (salary, groceries) = (la(&db, &ent, "Salary").await, la(&db, &ent, "Groceries").await);
    spend(&db, &ent, &eur, salary, "2026-01-25", "Employer", 250_000).await;
    spend(&db, &ent, &eur, groceries, "2026-01-05", "Market", -30_000).await;
    spend(&db, &ent, &card, groceries, "2026-01-06", "Market", -5_000).await;
    // A savings move (investing), paying the card off (operating, as cards are) and a loan
    // drawn (financing).
    let line = |la: i64, amount: i64| LineInput::new(la, amount, "EUR");
    create_entry(&db, &ent, journal("2026-01-26", "To savings", vec![line(savings.ledger_account_id, 20_000), line(eur.ledger_account_id, -20_000)]))
        .await
        .unwrap();
    create_entry(&db, &ent, journal("2026-01-27", "Card bill", vec![line(card.ledger_account_id, 5_000), line(eur.ledger_account_id, -5_000)]))
        .await
        .unwrap();
    create_entry(&db, &ent, journal("2026-01-28", "Loan", vec![line(eur.ledger_account_id, 50_000), line(loan.ledger_account_id, -50_000)]))
        .await
        .unwrap();
    close::close_period(&db, &ent, "2026-01", false, "2026-02-03").await.unwrap();
    spend(&db, &ent, &eur, groceries, "2026-02-05", "Market", -12_000).await;

    for period in ["2026-01", "2026-02", "2026"] {
        let pos = statements::statement(&db, &ent, "position", period, true).await.unwrap();
        assert_eq!(pos.checks["balanced"], true, "{period}");
        let cf = statements::statement(&db, &ent, "cash_flow", period, true).await.unwrap();
        assert_eq!(cf.checks["reconciles"], true, "{period}: {}", cf.checks);
        let eq = statements::statement(&db, &ent, "equity", period, true).await.unwrap();
        assert_eq!(eq.checks["reconciles"], true, "{period}");
        assert_eq!(row(&eq, "closing").amount_minor, row(&pos, "net_worth_total").amount_minor);
    }
    let jan = statements::statement(&db, &ent, "cash_flow", "2026-01", false).await.unwrap();
    assert_eq!(row(&jan, "operating_total").amount_minor, 250_000 - 30_000 - 5_000);
    assert_eq!(row(&jan, "investing_total").amount_minor, -20_000);
    assert_eq!(row(&jan, "financing_total").amount_minor, 50_000);
    assert_eq!(row(&jan, "fx_effect").amount_minor, 2_000, "retranslation of the dollars");
    assert_eq!(row(&jan, "opening_balances").amount_minor, 108_000);
    assert_eq!(row(&jan, "cash_closing").amount_minor, 100_000 + 10_000 + 250_000 - 30_000 - 20_000 - 5_000 + 50_000);
    assert!(jan.comparative.is_none());

    let pl = statements::statement(&db, &ent, "profit_loss", "2026-02", true).await.unwrap();
    assert_eq!(pl.comparative.as_ref().unwrap().period, "2026-01");
    let g = row(&pl, &format!("expense:{groceries}"));
    assert_eq!((g.amount_minor, g.comparative_minor), (12_000, Some(35_000)));
    // Salary only in the comparative month still gets its row.
    let s = row(&pl, &format!("income:{salary}"));
    assert_eq!((s.amount_minor, s.comparative_minor), (0, Some(250_000)));
    let year = statements::statement(&db, &ent, "profit_loss", "2026", true).await.unwrap();
    assert_eq!(row(&year, "surplus").amount_minor, 250_000 + 2_000 - 47_000);
    assert_eq!(row(&year, "comprehensive").amount_minor, row(&year, "surplus").amount_minor);

    let csv = statements::statement_csv(&db, &ent, "profit_loss", "2026-02", true).await.unwrap();
    assert_eq!(csv.file_name, "profit-loss-2026-02.csv");
    assert!(csv.content.starts_with("Line,2026-02 (EUR),2026-01 (EUR)\r\n"), "{}", csv.content);
    assert!(csv.content.contains("  Groceries,120.00,350.00\r\n"), "{}", csv.content);
    assert_eq!(statements::major(-5, "EUR"), "-0.05");
    assert!(statements::statement(&db, &ent, "balance", "2026", true).await.is_err());
}
