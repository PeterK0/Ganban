//! Finance, wave 2 (`docs/design/FINANCE.md` § Wave 2): period close, recognition schedules,
//! budgets, recurring and planned items, the forecast, the statements and the settings.
//!
//! Like the ledger's commands, each is the caller's own: [`Access::OwnFinance`] and the
//! `userId` authorship field pick the entity, so another user's row id is "not found".

use ganban_core::error::AppError;
use ganban_core::finance::{self, budgets, close, forecast, recurring, reminder, schedules, statements, Entity};
use serde_json::json;

use super::{command, reply, Access, Args, Author, Command, Ctx};

const USER: Author = Author::Arg("userId");

async fn entity(cx: &Ctx<'_>, a: &Args<'_>) -> Result<Entity, AppError> {
    finance::entity_for_user(cx.db, a.author()?).await
}

/// The host's local date, `YYYY-MM-DD`.
fn today() -> String {
    chrono::Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn statement_args(a: &Args<'_>) -> Result<(String, String, bool), AppError> {
    Ok((a.req_str("kind")?, a.req_str("period")?, a.opt_bool("comparatives").unwrap_or(true)))
}

pub(super) const COMMANDS: &[Command] = &[
    // ---- Close ----
    command("fin_list_periods").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(close::list_periods(cx.db, &entity(cx, a).await?, &today()).await?) })
    }),
    command("fin_close_period").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (month, force) = (a.req_str("month")?, a.opt_bool("force").unwrap_or(false));
            reply(close::close_period(cx.db, &entity(cx, a).await?, &month, force, &today()).await?)
        })
    }),
    // ---- Recognition schedules ----
    command("fin_list_schedules").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(schedules::list_schedules(cx.db, &entity(cx, a).await?, a.opt_i64("entryId")).await?) })
    }),
    command("fin_create_schedule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(schedules::create_schedule(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_delete_schedule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            schedules::delete_schedule(cx.db, &entity(cx, a).await?, a.req_i64("scheduleId")?).await?;
            reply(json!({}))
        })
    }),
    // ---- Budgets ----
    command("fin_list_budgets").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(budgets::list_budgets(cx.db, &entity(cx, a).await?).await?) })
    }),
    command("fin_create_budget").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(budgets::create_budget(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_budget").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("budgetId")?;
            reply(budgets::update_budget(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_delete_budget").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            budgets::delete_budget(cx.db, &entity(cx, a).await?, a.req_i64("budgetId")?).await?;
            reply(json!({}))
        })
    }),
    command("fin_budget_progress").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(budgets::budget_progress(cx.db, &entity(cx, a).await?, &a.req_str("month")?).await?) })
    }),
    // ---- Recurring and planned ----
    command("fin_detect_recurring").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(recurring::detect_recurring(cx.db, &entity(cx, a).await?, &today()).await?) })
    }),
    command("fin_list_recurring").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let status = a.opt_str("status");
            reply(recurring::list_recurring(cx.db, &entity(cx, a).await?, status.as_deref()).await?)
        })
    }),
    command("fin_resolve_recurring").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (id, confirm) = (a.req_i64("recurringId")?, a.opt_bool("confirm").unwrap_or(false));
            reply(recurring::resolve_recurring(cx.db, &entity(cx, a).await?, id, confirm).await?)
        })
    }),
    command("fin_list_planned").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (from, to) = (a.opt_str("from"), a.opt_str("to"));
            reply(recurring::list_planned(cx.db, &entity(cx, a).await?, from.as_deref(), to.as_deref()).await?)
        })
    }),
    command("fin_create_planned").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(recurring::create_planned(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_planned").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("plannedId")?;
            reply(recurring::update_planned(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_delete_planned").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            recurring::delete_planned(cx.db, &entity(cx, a).await?, a.req_i64("plannedId")?).await?;
            reply(json!({}))
        })
    }),
    // ---- Forecast and statements ----
    command("fin_forecast").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(forecast::forecast(cx.db, &entity(cx, a).await?, &a.req_str("month")?, &today()).await?) })
    }),
    command("fin_statement").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (kind, period, comparatives) = statement_args(a)?;
            reply(statements::statement(cx.db, &entity(cx, a).await?, &kind, &period, comparatives).await?)
        })
    }),
    command("fin_statement_csv").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (kind, period, comparatives) = statement_args(a)?;
            reply(statements::statement_csv(cx.db, &entity(cx, a).await?, &kind, &period, comparatives).await?)
        })
    }),
    // ---- Settings ----
    command("fin_get_settings").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(reminder::get_settings(cx.db, &entity(cx, a).await?).await?) })
    }),
    command("fin_update_settings").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(reminder::update_settings(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{find, Access, Author};
    use serde_json::{json, Value};

    #[test]
    fn every_wave_2_command_is_the_callers_own() {
        assert_eq!(super::COMMANDS.len(), 22);
        for c in super::COMMANDS {
            assert!(c.name.starts_with("fin_"), "{}", c.name);
            assert!(matches!(c.access, Some(Access::OwnFinance)), "{} must use OwnFinance", c.name);
            assert!(matches!(c.author, Some(Author::Arg("userId"))), "{} must stamp userId", c.name);
            assert!(find(c.name).is_some());
        }
    }

    fn id(v: &Value) -> i64 {
        v["id"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn the_owner_and_other_members_never_reach_a_members_wave_2_rows() {
        let db = test_db("finance_w2_private").await;
        let owner = owner(&db).await;
        let mia = member(&db, 7, &[]).await;
        let ana = member(&db, 8, &[]).await;

        let account = http(&db, mia, "fin_create_account", json!({ "input": {
            "kind": "current", "name": "Everyday", "currency": "EUR", "openingBalanceMinor": 90_000, "openingDate": "2026-01-01"
        }}))
        .await
        .unwrap();
        let chart = http(&db, mia, "fin_list_ledger_accounts", json!({})).await.unwrap();
        let named = |n: &str| chart.as_array().unwrap().iter().find(|a| a["name"] == n).map(id).unwrap();
        let (housing, groceries) = (named("Housing"), named("Groceries"));
        let entry = http(&db, mia, "fin_create_entry", json!({ "input": { "date": "2026-02-01", "description": "Insurance", "lines": [
            { "ledgerAccountId": account["ledger_account_id"], "amountMinor": -12_000, "currency": "EUR" },
            { "ledgerAccountId": housing, "amountMinor": 12_000, "currency": "EUR" }
        ]}}))
        .await
        .unwrap();
        let schedule = http(&db, mia, "fin_create_schedule", json!({ "input": { "entryId": id(&entry), "startMonth": "2026-02", "months": 6 } }))
            .await
            .unwrap();
        let budget = http(&db, mia, "fin_create_budget", json!({ "input": { "ledgerAccountId": groceries, "amountMinor": 30_000 } }))
            .await
            .unwrap();
        let planned = http(&db, mia, "fin_create_planned", json!({ "input": { "date": "2026-03-10", "description": "Trip", "amountMinor": -50_000 } }))
            .await
            .unwrap();
        let settings = http(&db, mia, "fin_update_settings", json!({ "input": { "reminder": { "weekday": "thu", "time": "8:30" } } }))
            .await
            .unwrap();
        assert_eq!(settings["reminder"], json!({ "enabled": true, "weekday": "Thu", "time": "08:30" }));
        let progress = http(&db, mia, "fin_budget_progress", json!({ "month": "2026-02" })).await.unwrap();
        assert_eq!(progress[0]["target_minor"], 30_000);
        let pos = http(&db, mia, "fin_statement", json!({ "kind": "position", "period": "2026-02" })).await.unwrap();
        assert_eq!(pos["checks"]["balanced"], true);

        for user in [owner, ana] {
            for (name, args) in [
                ("fin_create_schedule", json!({ "input": { "entryId": id(&entry), "startMonth": "2026-02", "months": 2 } })),
                ("fin_delete_schedule", json!({ "scheduleId": id(&schedule) })),
                ("fin_create_budget", json!({ "input": { "ledgerAccountId": groceries, "amountMinor": 1 } })),
                ("fin_update_budget", json!({ "budgetId": id(&budget), "input": { "amountMinor": 1 } })),
                ("fin_delete_budget", json!({ "budgetId": id(&budget) })),
                ("fin_update_planned", json!({ "plannedId": id(&planned), "input": { "date": "2026-03-10", "description": "x", "amountMinor": 1 } })),
                ("fin_delete_planned", json!({ "plannedId": id(&planned) })),
                ("fin_resolve_recurring", json!({ "recurringId": 1, "confirm": true })),
            ] {
                let err = http(&db, user, name, args).await.unwrap_err();
                assert!(err.is_not_found(), "{name} as user {}: {err}", user.id);
            }
            for (name, args) in [
                ("fin_list_schedules", json!({})),
                ("fin_list_budgets", json!({})),
                ("fin_list_planned", json!({})),
                ("fin_list_recurring", json!({})),
                ("fin_detect_recurring", json!({})),
                ("fin_budget_progress", json!({ "month": "2026-02" })),
            ] {
                assert_eq!(http(&db, user, name, args).await.unwrap(), json!([]), "{name} as user {}", user.id);
            }
            let theirs = http(&db, user, "fin_statement", json!({ "kind": "position", "period": "2026-02", "userId": mia.id })).await.unwrap();
            assert_eq!(theirs["rows"].as_array().unwrap().iter().map(|r| r["amount_minor"].as_i64().unwrap().abs()).sum::<i64>(), 0);
            let f = http(&db, user, "fin_forecast", json!({ "month": "2026-02" })).await.unwrap();
            assert_eq!(f["end_minor"], 0);
            let periods = http(&db, user, "fin_list_periods", json!({})).await.unwrap();
            assert!(periods.as_array().unwrap().iter().all(|p| p["entries"] == 0));
            let csv = http(&db, user, "fin_statement_csv", json!({ "kind": "profit_loss", "period": "2026" })).await.unwrap();
            assert!(!csv["content"].as_str().unwrap().contains("Housing"));
            assert_eq!(http(&db, user, "fin_get_settings", json!({})).await.unwrap()["reminder"]["weekday"], "Mon");
        }
        // Mia's rows are untouched.
        assert_eq!(http(&db, mia, "fin_list_budgets", json!({})).await.unwrap()[0]["amount_minor"], 30_000);
        assert_eq!(ids(&http(&db, mia, "fin_list_planned", json!({})).await.unwrap()), vec![id(&planned)]);
        assert_eq!(ids(&http(&db, mia, "fin_list_schedules", json!({})).await.unwrap()), vec![id(&schedule)]);
    }
}
