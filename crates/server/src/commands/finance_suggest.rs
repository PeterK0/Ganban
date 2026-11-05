//! Finance category suggestions from the host's local model (`docs/design/FINANCE.md`
//! § Assistant). Like every finance command they act on the caller's own entity; the model
//! sees each line's description, payee and amount and the chart's names, and the user applies
//! a suggestion or not (`crate::finance_tools`).

use ganban_core::finance;
use serde_json::json;

use super::{command, reply, Access, Author, Command};

const USER: Author = Author::Arg("userId");

pub(super) const COMMANDS: &[Command] = &[
    // Whether suggestions can be asked for: a local model is installed on the host's engine.
    // The interface hides "Suggest" when not.
    command("fin_suggest_available").access(Access::OwnFinance).author(USER).run(|cx, _a| {
        Box::pin(async move {
            let model = crate::finance_tools::local_engine(cx.db).await.map(|(_, p)| p.model);
            Ok(json!({ "available": model.is_some(), "model": model }))
        })
    }),
    command("fin_suggest_categories").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let ent = finance::entity_for_user(cx.db, a.author()?).await?;
            crate::finance_tools::suggest_categories(cx.db, &ent, &a.i64_list("entryIds")).await
        })
    }),
    // "Suggest categories for all uncategorised": a background job over the inbox's payee
    // groups, followed with `fin_suggest_groups_status`.
    command("fin_suggest_groups").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let ent = finance::entity_for_user(cx.db, a.author()?).await?;
            reply(crate::finance_suggest_job::start(cx.db, &ent).await?)
        })
    }),
    command("fin_suggest_groups_status").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let ent = finance::entity_for_user(cx.db, a.author()?).await?;
            reply(crate::finance_suggest_job::status(cx.db, &ent))
        })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{find, Access, Author};
    use serde_json::json;

    #[test]
    fn suggestion_commands_are_the_callers_own() {
        for c in super::COMMANDS {
            assert!(matches!(c.access, Some(Access::OwnFinance)), "{} must use OwnFinance", c.name);
            assert!(matches!(c.author, Some(Author::Arg("userId"))), "{} must stamp userId", c.name);
            assert!(find(c.name).is_some());
        }
    }

    #[tokio::test]
    async fn another_users_entries_are_not_found() {
        let db = test_db("fin_suggest_scope").await;
        let mia = member(&db, 7, &[]).await;
        let ana = member(&db, 8, &[]).await;
        let account = http(&db, mia, "fin_create_account", json!({ "input": {
            "kind": "current", "name": "Everyday", "currency": "EUR", "openingBalanceMinor": 100, "openingDate": "2026-01-01"
        }}))
        .await
        .unwrap();
        let entries = http(&db, mia, "fin_list_entries", json!({ "filter": { "accountId": account["id"] } })).await.unwrap();
        let entry = entries["entries"][0]["id"].as_i64().unwrap();
        // Ana names Mia's entry: absent, checked before any model is asked.
        let err = http(&db, ana, "fin_suggest_categories", json!({ "entryIds": [entry] })).await.unwrap_err();
        assert!(err.is_not_found(), "{err}");
        let too_many: Vec<i64> = (0..100).collect();
        assert!(http(&db, mia, "fin_suggest_categories", json!({ "entryIds": too_many })).await.unwrap_err().is_invalid_input());
    }
}
