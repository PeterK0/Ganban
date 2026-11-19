//! Finance payees: list, rename, merge, split, default categories, merge suggestions, and
//! the inbox's summary (`docs/design/FINANCE.md` § Payees). Every command is the caller's
//! own, as in `finance.rs`.

use ganban_core::error::AppError;
use ganban_core::finance::{self, payees, Entity};
use serde::de::DeserializeOwned;
use serde_json::json;

use super::{command, reply, Access, Args, Author, Command, Ctx};

const USER: Author = Author::Arg("userId");

async fn entity(cx: &Ctx<'_>, a: &Args<'_>) -> Result<Entity, AppError> {
    finance::entity_for_user(cx.db, a.author()?).await
}

fn arg<T: DeserializeOwned + Default>(a: &Args<'_>, key: &str) -> Result<T, AppError> {
    match a.get(key) {
        None | Some(serde_json::Value::Null) => Ok(T::default()),
        Some(v) => {
            serde_json::from_value(v.clone()).map_err(|e| AppError::InvalidInput(format!("invalid '{key}': {e}")))
        }
    }
}

/// A nullable id: absent or null is `None`.
fn opt_id(a: &Args<'_>, key: &str) -> Result<Option<i64>, AppError> {
    match a.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(|| AppError::InvalidInput(format!("invalid '{key}'"))),
    }
}

pub(super) const COMMANDS: &[Command] = &[
    command("fin_list_payees").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let filter: payees::PayeeFilter = arg(a, "filter")?;
            let (limit, offset) = (a.opt_i64("limit").unwrap_or(100), a.opt_i64("offset").unwrap_or(0));
            reply(payees::list_payees(cx.db, &entity(cx, a).await?, filter, limit, offset).await?)
        })
    }),
    command("fin_get_payee").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(payees::get_payee(cx.db, &entity(cx, a).await?, a.req_i64("payeeId")?).await?) })
    }),
    command("fin_update_payee").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("payeeId")?;
            reply(payees::update_payee(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    // The default: a category (`ledgerAccountId`) or a move to an account (`accountId`), both
    // null to clear it; `file` (default true) files the
    // payee's uncategorised drafts and unsorted history under it. The answer is Undo's data.
    command("fin_set_payee_default").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (id, la, file) = (a.req_i64("payeeId")?, opt_id(a, "ledgerAccountId")?, a.opt_bool("file"));
            let account = opt_id(a, "accountId")?;
            let ent = entity(cx, a).await?;
            reply(payees::set_default_to(cx.db, &ent, id, la, account, file.unwrap_or(true)).await?)
        })
    }),
    command("fin_undo_payee_default").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (id, previous) = (a.req_i64("payeeId")?, opt_id(a, "previousLedgerAccountId")?);
            let previous_account = opt_id(a, "previousAccountId")?;
            let (drafts, history) = (a.i64_list("filedDrafts"), a.i64_list("filedHistory"));
            let ent = entity(cx, a).await?;
            reply(payees::undo_default(cx.db, &ent, id, previous, previous_account, &drafts, &history).await?)
        })
    }),
    command("fin_merge_payees").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (target, sources) = (a.req_i64("targetId")?, a.i64_list("payeeIds"));
            reply(payees::merge_payees(cx.db, &entity(cx, a).await?, target, &sources).await?)
        })
    }),
    command("fin_split_payee").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (id, keys) = (a.req_i64("payeeId")?, arg::<Vec<String>>(a, "aliasKeys")?);
            reply(payees::split_payee(cx.db, &entity(cx, a).await?, id, &keys).await?)
        })
    }),
    command("fin_payee_suggestions").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let limit = a.opt_i64("limit").unwrap_or(50).clamp(1, 500) as usize;
            reply(payees::suggestions(cx.db, &entity(cx, a).await?, limit).await?)
        })
    }),
    command("fin_dismiss_payee_suggestion").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (x, y) = (a.req_i64("payeeA")?, a.req_i64("payeeB")?);
            payees::dismiss_suggestion(cx.db, &entity(cx, a).await?, x, y).await?;
            reply(json!({}))
        })
    }),
    // Brings an inbox from before payees in line: defaults file their drafts, and with
    // `historyDays` uncategorised drafts older than that post as unsorted history. `dryRun`
    // only counts.
    command("fin_tidy_inbox").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let before = match a.opt_i64("historyDays") {
                None => None,
                Some(d) if (1..=3650).contains(&d) => {
                    Some((chrono::Local::now().date_naive() - chrono::Duration::days(d)).format("%Y-%m-%d").to_string())
                }
                Some(_) => return Err(AppError::InvalidInput("'historyDays' is 1 to 3650".into())),
            };
            let dry = a.opt_bool("dryRun").unwrap_or(false);
            let (db, ent) = (cx.db.clone(), entity(cx, a).await?);
            let work = async move { payees::tidy_inbox(&db, &ent, before.as_deref(), dry).await };
            reply(tokio::spawn(work).await.map_err(|_| AppError::Io(std::io::Error::other("the tidy stopped")))??)
        })
    }),
    // The inbox's counts: what needs the user, and what stays out of it.
    command("fin_inbox_summary")
        .access(Access::OwnFinance)
        .author(USER)
        .run(|cx, a| Box::pin(async move { reply(finance::inbox::summary(cx.db, &entity(cx, a).await?).await?) })),
    // Booked transfers folded by kind: "Exchanged to GBP: 1,240 moves, €612".
    command("fin_transfer_groups").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let filter: finance::EntryFilter = arg(a, "filter")?;
            reply(finance::inbox::transfer_groups(cx.db, &entity(cx, a).await?, filter).await?)
        })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{find, Access, Author};
    use serde_json::json;

    #[test]
    fn every_payee_command_is_the_callers_own() {
        for c in super::COMMANDS {
            assert!(matches!(c.access, Some(Access::OwnFinance)), "{} must use OwnFinance", c.name);
            assert!(matches!(c.author, Some(Author::Arg("userId"))), "{} must stamp userId", c.name);
            assert!(find(c.name).is_some());
        }
    }

    #[tokio::test]
    async fn the_owner_never_reaches_a_members_payees() {
        let db = test_db("finance_payees_private").await;
        let owner = owner(&db).await;
        let mia = member(&db, 7, &[]).await;
        let account = http(
            &db,
            mia,
            "fin_create_account",
            json!({ "input": { "kind": "cash", "name": "Wallet", "currency": "EUR" } }),
        )
        .await
        .unwrap();
        let chart = http(&db, mia, "fin_list_ledger_accounts", json!({})).await.unwrap();
        let find_la =
            |name: &str| chart.as_array().unwrap().iter().find(|a| a["name"] == name).unwrap()["id"].as_i64().unwrap();
        let (eating, cash) = (find_la("Eating out"), account["ledger_account_id"].as_i64().unwrap());
        for payee in ["Wolt", "Bolt"] {
            http(
                &db,
                mia,
                "fin_create_entry",
                json!({ "input": { "date": "2026-03-01", "description": payee, "payee": payee, "lines": [
                    { "ledgerAccountId": eating, "amountMinor": 500, "currency": "EUR" },
                    { "ledgerAccountId": cash, "amountMinor": -500, "currency": "EUR" }
                ]}}),
            )
            .await
            .unwrap();
        }
        let mine = http(&db, mia, "fin_list_payees", json!({})).await.unwrap();
        assert_eq!(mine["total"], 2);
        let (a, b) = (mine["payees"][0]["id"].as_i64().unwrap(), mine["payees"][1]["id"].as_i64().unwrap());

        // The owner, even naming Mia as the author, sees none and reaches none.
        let theirs = http(&db, owner, "fin_list_payees", json!({ "userId": mia.id })).await.unwrap();
        assert_eq!(theirs["total"], 0);
        for (name, args) in [
            ("fin_get_payee", json!({ "payeeId": a })),
            ("fin_update_payee", json!({ "payeeId": a, "input": { "name": "Mine" } })),
            ("fin_set_payee_default", json!({ "payeeId": a, "ledgerAccountId": null })),
            ("fin_undo_payee_default", json!({ "payeeId": a })),
            ("fin_merge_payees", json!({ "targetId": a, "payeeIds": [b] })),
            ("fin_split_payee", json!({ "payeeId": a, "aliasKeys": ["wolt"] })),
            ("fin_dismiss_payee_suggestion", json!({ "payeeA": a, "payeeB": b })),
        ] {
            let err = http(&db, owner, name, args).await.unwrap_err();
            assert!(err.is_not_found(), "{name}: {err}");
        }
        assert_eq!(http(&db, mia, "fin_get_payee", json!({ "payeeId": a })).await.unwrap()["lines"], 1);
    }
}
