//! Finance, the ledger (`docs/design/FINANCE.md` § Commands, ADR 0009, ADR 0010).
//!
//! Every command is the caller's own: [`Access::OwnFinance`] admits any signed-in member, and
//! the authorship field names whose entity it acts on. Over HTTP that is always the signed-in
//! user, the host owner included, so a row id from another entity is "not found".

use ganban_core::error::AppError;
use ganban_core::finance::{self, rates, Entity};
use serde::de::DeserializeOwned;
use serde_json::json;

use super::{command, reply, Access, Args, Author, Command, Ctx};

const USER: Author = Author::Arg("userId");

/// The caller's entity (created with its chart on first use).
async fn entity(cx: &Ctx<'_>, a: &Args<'_>) -> Result<Entity, AppError> {
    finance::entity_for_user(cx.db, a.author()?).await
}

/// A top-level argument, deserialized; missing → the type's default.
fn arg<T: DeserializeOwned + Default>(a: &Args<'_>, key: &str) -> Result<T, AppError> {
    match a.get(key) {
        None | Some(serde_json::Value::Null) => Ok(T::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| AppError::InvalidInput(format!("invalid '{key}': {e}"))),
    }
}

pub(super) const COMMANDS: &[Command] = &[
    command("fin_get_entity").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(entity(cx, a).await?) })
    }),
    command("fin_update_entity").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(finance::update_entity(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_list_ledger_accounts").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let all = a.opt_bool("includeArchived").unwrap_or(false);
            reply(finance::list_ledger_accounts(cx.db, &entity(cx, a).await?, all).await?)
        })
    }),
    command("fin_create_ledger_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(finance::create_ledger_account(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_ledger_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("ledgerAccountId")?;
            reply(finance::update_ledger_account(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_archive_ledger_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("ledgerAccountId")?;
            reply(finance::archive_ledger_account(cx.db, &entity(cx, a).await?, id).await?)
        })
    }),
    command("fin_list_accounts").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let all = a.opt_bool("includeArchived").unwrap_or(false);
            reply(finance::list_accounts(cx.db, &entity(cx, a).await?, all).await?)
        })
    }),
    command("fin_create_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(finance::create_account(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("accountId")?;
            reply(finance::update_account(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_archive_account").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("accountId")?;
            reply(finance::archive_account(cx.db, &entity(cx, a).await?, id).await?)
        })
    }),
    command("fin_list_entries").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let filter: finance::EntryFilter = arg(a, "filter")?;
            let (limit, offset) = (a.opt_i64("limit").unwrap_or(100), a.opt_i64("offset").unwrap_or(0));
            reply(finance::list_entries(cx.db, &entity(cx, a).await?, filter, limit, offset).await?)
        })
    }),
    command("fin_create_entry").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(finance::create_entry(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_entry").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("entryId")?;
            reply(finance::update_entry(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_categorise").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("entryId")?;
            let splits: Vec<finance::Split> = arg(a, "splits")?;
            reply(finance::categorise(cx.db, &entity(cx, a).await?, id, splits).await?)
        })
    }),
    command("fin_post_entries").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let posted = finance::post_entries(cx.db, &entity(cx, a).await?, &a.i64_list("entryIds")).await?;
            reply(json!({ "posted": posted }))
        })
    }),
    command("fin_delete_entry").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            finance::delete_entry(cx.db, &entity(cx, a).await?, a.req_i64("entryId")?).await?;
            reply(json!({}))
        })
    }),
    command("fin_reverse_entry").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (id, date) = (a.req_i64("entryId")?, a.req_str("date")?);
            reply(finance::reverse_entry(cx.db, &entity(cx, a).await?, id, &date).await?)
        })
    }),
    command("fin_trial_balance").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(finance::trial_balance(cx.db, &entity(cx, a).await?, &a.req_str("asOf")?).await?) })
    }),
    // Rates are global (public ECB data), so this one reads no entity.
    command("fin_rate").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(rates::rate_on(cx.db, &a.req_str("currency")?, &a.req_str("date")?).await?) })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{find, Access, Author};
    use serde_json::{json, Value};

    #[test]
    fn every_finance_command_is_the_callers_own() {
        let names: Vec<&str> = super::COMMANDS.iter().map(|c| c.name).collect();
        assert!(names.len() >= 19 && names.iter().all(|n| n.starts_with("fin_")), "{names:?}");
        for c in super::COMMANDS {
            assert!(matches!(c.access, Some(Access::OwnFinance)), "{} must use OwnFinance", c.name);
            assert!(matches!(c.author, Some(Author::Arg("userId"))), "{} must stamp userId", c.name);
            assert!(find(c.name).is_some());
        }
    }

    fn id(v: &Value) -> i64 {
        v["id"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn the_owner_and_other_members_never_reach_a_members_finance() {
        let db = test_db("finance_private").await;
        let owner = owner(&db).await;
        let mia = member(&db, 7, &[]).await;
        let ana = member(&db, 8, &[]).await;

        // Mia names the owner as the author; the host stamps her own id.
        let account = http(&db, mia, "fin_create_account", json!({ "userId": owner.id, "input": {
            "kind": "current", "name": "Everyday", "currency": "EUR",
            "openingBalanceMinor": 50_000, "openingDate": "2026-01-01"
        }}))
        .await
        .unwrap();
        let mine = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
        assert_eq!((ids(&mine), mine[0]["balance_minor"].as_i64()), (vec![id(&account)], Some(50_000)));
        let entries = http(&db, mia, "fin_list_entries", json!({ "filter": { "accountId": id(&account) } })).await.unwrap();
        assert_eq!(entries["total"], 1);
        let entry = id(&entries["entries"][0]);
        let groceries = http(&db, mia, "fin_list_ledger_accounts", json!({})).await.unwrap().as_array().unwrap().iter()
            .find(|a| a["name"] == "Groceries").map(id).unwrap();

        // The owner and Ana see none of it, and Mia's row ids are "not found" to both.
        for user in [owner, ana] {
            for (name, args) in [
                ("fin_update_account", json!({ "accountId": id(&account), "input": { "name": "Mine now" } })),
                ("fin_archive_account", json!({ "accountId": id(&account) })),
                ("fin_list_entries", json!({ "filter": { "accountId": id(&account) } })),
                ("fin_update_entry", json!({ "entryId": entry, "input": { "description": "x" } })),
                ("fin_categorise", json!({ "entryId": entry, "splits": [{ "ledgerAccountId": groceries, "amountMinor": 1 }] })),
                ("fin_delete_entry", json!({ "entryId": entry })),
                ("fin_reverse_entry", json!({ "entryId": entry, "date": "2026-02-01" })),
                ("fin_post_entries", json!({ "entryIds": [entry] })),
                ("fin_archive_ledger_account", json!({ "ledgerAccountId": groceries })),
                ("fin_update_ledger_account", json!({ "ledgerAccountId": groceries, "input": { "name": "x" } })),
            ] {
                let err = http(&db, user, name, args).await.unwrap_err();
                assert!(err.is_not_found(), "{name} as user {}: {err}", user.id);
            }
            assert!(ids(&http(&db, user, "fin_list_accounts", json!({ "includeArchived": true })).await.unwrap()).is_empty());
            assert_eq!(http(&db, user, "fin_list_entries", json!({})).await.unwrap()["total"], 0);
            assert_eq!(http(&db, user, "fin_trial_balance", json!({ "asOf": "2030-01-01" })).await.unwrap(), json!([]));
            let theirs = http(&db, user, "fin_get_entity", json!({ "userId": mia.id })).await.unwrap();
            assert_eq!(theirs["user_id"].as_i64(), Some(user.id));
        }
        // Mia's books are untouched.
        let tb = http(&db, mia, "fin_trial_balance", json!({ "asOf": "2026-12-31" })).await.unwrap();
        let total = |k: &str| tb.as_array().unwrap().iter().map(|r| r[k].as_i64().unwrap()).sum::<i64>();
        assert_eq!((total("debit_minor"), total("credit_minor")), (50_000, 50_000));
    }

    #[tokio::test]
    async fn a_journal_round_trip_over_the_table() {
        let db = test_db("finance_journal").await;
        let mia = member(&db, 7, &[]).await;
        let account = http(&db, mia, "fin_create_account", json!({ "input": { "kind": "current", "name": "Everyday", "currency": "EUR" } }))
            .await
            .unwrap();
        let chart = http(&db, mia, "fin_list_ledger_accounts", json!({})).await.unwrap();
        let salary = chart.as_array().unwrap().iter().find(|a| a["name"] == "Salary").map(id).unwrap();
        let la = account["ledger_account_id"].as_i64().unwrap();
        let entry = http(&db, mia, "fin_create_entry", json!({ "input": { "date": "2026-03-01", "description": "Pay", "lines": [
            { "ledgerAccountId": la, "amountMinor": 200_000, "currency": "EUR" },
            { "ledgerAccountId": salary, "amountMinor": -200_000, "currency": "eur" }
        ]}}))
        .await
        .unwrap();
        assert_eq!(entry["status"], "posted");
        let rev = http(&db, mia, "fin_reverse_entry", json!({ "entryId": id(&entry), "date": "2026-03-02" })).await.unwrap();
        assert_eq!(rev["reverses_id"].as_i64(), Some(id(&entry)));
        let accounts = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
        assert_eq!(accounts[0]["balance_minor"], 0);
        assert_eq!(http(&db, mia, "fin_rate", json!({ "currency": "EUR", "date": "2026-03-01" })).await.unwrap()["rate"], 1.0);
    }
}
