//! Finance, import, pairing and rules (`docs/design/FINANCE.md` § Commands, lane B).
//!
//! Like the ledger's commands, each is the caller's own: [`Access::OwnFinance`] and the
//! `userId` authorship field pick the entity, so another user's account, pair or rule id
//! is "not found". Files arrive as base64 in the arguments, capped at 1.5 MB.

use std::collections::HashMap;

use base64::Engine;
use ganban_core::error::AppError;
use ganban_core::finance::import::{jobs, pipeline, MAX_FILE_BYTES, TOO_LARGE};
use ganban_core::finance::{self, pairing, rules, Entity};
use serde::de::DeserializeOwned;
use serde_json::json;

use super::{command, reply, Access, Args, Author, Command, Ctx};

const USER: Author = Author::Arg("userId");

async fn entity(cx: &Ctx<'_>, a: &Args<'_>) -> Result<Entity, AppError> {
    finance::entity_for_user(cx.db, a.author()?).await
}

/// A required top-level argument, deserialized.
fn req<T: DeserializeOwned>(a: &Args<'_>, key: &str) -> Result<T, AppError> {
    let v = a.get(key).filter(|v| !v.is_null()).ok_or_else(|| AppError::InvalidInput(format!("missing '{key}'")))?;
    serde_json::from_value(v.clone()).map_err(|_| AppError::InvalidInput(format!("invalid '{key}'")))
}

/// The uploaded file: `contentBase64` (a `data:` URL prefix is fine), at most 1.5 MB.
fn file_bytes(a: &Args<'_>) -> Result<Vec<u8>, AppError> {
    let raw = a.req_str("contentBase64")?;
    let b64 = match raw.find(";base64,") {
        Some(i) if raw.starts_with("data:") => &raw[i + 8..],
        _ => raw.as_str(),
    };
    let b64: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    if b64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
        return Err(AppError::InvalidInput(TOO_LARGE.into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| AppError::InvalidInput("the file isn't valid base64".into()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(TOO_LARGE.into()));
    }
    Ok(bytes)
}

pub(super) const COMMANDS: &[Command] = &[
    command("fin_list_profiles").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(pipeline::list_profiles(cx.db, &entity(cx, a).await?).await?) })
    }),
    command("fin_save_profile").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(pipeline::save_profile(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_delete_profile").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            pipeline::delete_profile(cx.db, &entity(cx, a).await?, &a.req_str("key")?).await?;
            reply(json!({}))
        })
    }),
    command("fin_preview_import").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let bytes = file_bytes(a)?;
            let key = a.opt_str("profileKey").filter(|k| !k.is_empty());
            reply(pipeline::preview(cx.db, &entity(cx, a).await?, &bytes, key.as_deref()).await?)
        })
    }),
    // Starts the import as a background job and answers at once with the job;
    // `fin_import_status` follows it. A wrong profile or account is refused here.
    command("fin_import").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let bytes = file_bytes(a)?;
            let account_map: HashMap<String, pipeline::AccountChoice> = req(a, "accountMap")?;
            let ent = entity(cx, a).await?;
            let profile_key = a.req_str("profileKey")?;
            pipeline::check_request(cx.db, &ent, &profile_key, &account_map).await?;
            let file_name = a.opt_str("fileName").unwrap_or_default();
            reply(jobs::start(cx.db, &ent, jobs::ImportRequest { file_name, bytes, profile_key, account_map })?)
        })
    }),
    // The caller's import job: `jobId`'s, else their latest (null when there's none).
    command("fin_import_status").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let job_id = match a.get("jobId").filter(|v| !v.is_null()) {
                None => None,
                Some(v) => Some(v.as_u64().ok_or_else(|| AppError::InvalidInput("invalid 'jobId'".into()))?),
            };
            reply(jobs::status(cx.db, &entity(cx, a).await?, job_id)?)
        })
    }),
    command("fin_list_pairs").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let status = a.opt_str("status").filter(|s| !s.is_empty());
            reply(pairing::list_pairs(cx.db, &entity(cx, a).await?, status.as_deref()).await?)
        })
    }),
    command("fin_resolve_pair").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let accept: bool = req(a, "accept")?;
            reply(pairing::resolve_pair(cx.db, &entity(cx, a).await?, a.req_i64("pairId")?, accept).await?)
        })
    }),
    command("fin_pair_entries").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let (x, y) = (a.req_i64("entryA")?, a.req_i64("entryB")?);
            reply(pairing::pair_entries(cx.db, &entity(cx, a).await?, x, y).await?)
        })
    }),
    command("fin_list_rules").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(rules::list_rules(cx.db, &entity(cx, a).await?).await?) })
    }),
    command("fin_create_rule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(rules::create_rule(cx.db, &entity(cx, a).await?, a.input()?).await?) })
    }),
    command("fin_update_rule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let id = a.req_i64("ruleId")?;
            reply(rules::update_rule(cx.db, &entity(cx, a).await?, id, a.input()?).await?)
        })
    }),
    command("fin_delete_rule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            rules::delete_rule(cx.db, &entity(cx, a).await?, a.req_i64("ruleId")?).await?;
            reply(json!({}))
        })
    }),
    command("fin_suggest_rule").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move { reply(rules::suggest_rule(cx.db, &entity(cx, a).await?, a.req_i64("entryId")?).await?) })
    }),
    command("fin_apply_rules").access(Access::OwnFinance).author(USER).run(|cx, a| {
        Box::pin(async move {
            let ids = a.get("entryIds").filter(|v| !v.is_null()).map(|_| a.i64_list("entryIds"));
            let categorised = rules::apply_rules(cx.db, &entity(cx, a).await?, ids).await?;
            reply(json!({ "categorised": categorised }))
        })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{find, Access, Author};
    use base64::Engine;
    use serde_json::{json, Value};

    #[test]
    fn every_import_command_is_the_callers_own() {
        let names: Vec<&str> = super::COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names.len(), 15, "{names:?}");
        for c in super::COMMANDS {
            assert!(c.name.starts_with("fin_"));
            assert!(matches!(c.access, Some(Access::OwnFinance)), "{} must use OwnFinance", c.name);
            assert!(matches!(c.author, Some(Author::Arg("userId"))), "{} must stamp userId", c.name);
            assert!(find(c.name).is_some());
        }
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    const FILE: &str = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n\
        Card Payment,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Green Market,-20.00,0.00,EUR,COMPLETED,980.00\n\
        Transfer,Current,2026-10-02 09:00:00,2026-10-02 09:00:00,To EUR Holiday,-50.00,0.00,EUR,COMPLETED,930.00\n";

    fn id(v: &Value) -> i64 {
        v["id"].as_i64().unwrap()
    }

    /// Starts an import and waits for its job; returns the job's result.
    async fn import(db: &ganban_core::Db, who: crate::AuthUser, args: Value) -> Value {
        let job = http(db, who, "fin_import", args).await.unwrap();
        assert_eq!(job["state"], "running");
        loop {
            let st = http(db, who, "fin_import_status", json!({ "jobId": job["job_id"] })).await.unwrap();
            match st["state"].as_str() {
                Some("done") => return st["result"].clone(),
                Some("running") => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
                _ => panic!("import failed: {st}"),
            }
        }
    }

    #[tokio::test]
    async fn preview_then_import_over_the_table() {
        let db = test_db("fin_import_flow").await;
        let mia = member(&db, 7, &[]).await;
        let p = http(&db, mia, "fin_preview_import", json!({ "fileName": "s.csv", "contentBase64": b64(FILE) })).await.unwrap();
        assert_eq!((p["format"].as_str(), p["profile_key"].as_str()), (Some("csv"), Some("revolut")));
        assert_eq!(p["rows"][0]["amount_minor"], -2000);
        assert_eq!(p["accounts"][0]["guess_key"], "revolut:current:EUR");
        assert!(p["sample"].as_array().unwrap().len() >= 3);

        let args = json!({ "fileName": "s.csv", "contentBase64": format!("data:text/csv;base64,{}", b64(FILE)), "profileKey": "revolut",
            "accountMap": {
                "revolut:current:EUR": { "create": { "kind": "current", "name": "Everyday", "currency": "EUR" } },
                "revolut:pocket:holiday:EUR": { "create": { "kind": "savings", "name": "Holiday", "currency": "EUR" } }
            } });
        let r = import(&db, mia, args).await;
        assert_eq!((r["created"].as_i64(), r["paired"].as_i64(), r["review"].as_i64()), (Some(2), Some(1), Some(0)));
        assert!(r["batch_id"].as_i64().is_some() && r["categorised_by_rules"] == 0);
        let pairs = http(&db, mia, "fin_list_pairs", json!({ "status": "auto" })).await.unwrap();
        assert_eq!(pairs.as_array().unwrap().len(), 1);
        assert!(pairs[0]["entry_a"]["lines"].is_array());

        // The same file again adds nothing.
        let accounts = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
        let by_name = |n: &str| accounts.as_array().unwrap().iter().find(|a| a["name"] == n).map(id).unwrap();
        let again = json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "revolut",
            "accountMap": { "revolut:current:EUR": by_name("Everyday"), "revolut:pocket:holiday:EUR": by_name("Holiday") } });
        let r = import(&db, mia, again).await;
        assert_eq!((r["created"].as_i64(), r["duplicates"].as_i64()), (Some(0), Some(2)));

        // Rules over the table.
        let chart = http(&db, mia, "fin_list_ledger_accounts", json!({})).await.unwrap();
        let groceries = chart.as_array().unwrap().iter().find(|a| a["name"] == "Groceries").map(id).unwrap();
        let rule = http(&db, mia, "fin_create_rule", json!({ "input": {
            "conditions": { "text": "market" }, "action": { "ledgerAccountId": groceries } } }))
        .await
        .unwrap();
        assert_eq!(rule["conditions"]["text"], "market");
        let n = http(&db, mia, "fin_apply_rules", json!({})).await.unwrap();
        assert_eq!(n["categorised"], 1);
        assert_eq!(http(&db, mia, "fin_list_rules", json!({})).await.unwrap()[0]["hits"], 1);
    }

    #[tokio::test]
    async fn another_users_rows_are_not_found() {
        let db = test_db("fin_import_private").await;
        let mia = member(&db, 7, &[]).await;
        let ana = member(&db, 8, &[]).await;
        let owner = owner(&db).await;
        let hers = http(&db, ana, "fin_create_account", json!({ "input": { "kind": "current", "name": "Ana", "currency": "EUR" } }))
            .await
            .unwrap();
        let chart = http(&db, ana, "fin_list_ledger_accounts", json!({})).await.unwrap();
        let groceries = chart.as_array().unwrap().iter().find(|a| a["name"] == "Groceries").map(id).unwrap();
        let rule = http(&db, ana, "fin_create_rule", json!({ "input": { "conditions": { "text": "x" }, "action": { "ledgerAccountId": groceries } } }))
            .await
            .unwrap();
        import(&db, ana, json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "revolut",
            "accountMap": { "revolut:current:EUR": id(&hers),
                "revolut:pocket:holiday:EUR": { "create": { "kind": "savings", "name": "Holiday", "currency": "EUR" } } } }))
        .await;
        let pair = id(&http(&db, ana, "fin_list_pairs", json!({})).await.unwrap()[0]);
        let entries = http(&db, ana, "fin_list_entries", json!({})).await.unwrap();
        let entry = id(&entries["entries"][0]);

        for user in [mia, owner] {
            for (name, args) in [
                ("fin_import", json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "revolut",
                    "accountMap": { "revolut:current:EUR": id(&hers) } })),
                ("fin_resolve_pair", json!({ "pairId": pair, "accept": false })),
                ("fin_pair_entries", json!({ "entryA": entry, "entryB": entry + 1 })),
                ("fin_update_rule", json!({ "ruleId": id(&rule), "input": { "conditions": { "text": "y" }, "action": { "ledgerAccountId": groceries } } })),
                ("fin_delete_rule", json!({ "ruleId": id(&rule) })),
                ("fin_suggest_rule", json!({ "entryId": entry })),
                ("fin_apply_rules", json!({ "entryIds": [entry] })),
                ("fin_create_rule", json!({ "input": { "conditions": { "text": "y" }, "action": { "ledgerAccountId": groceries } } })),
                ("fin_delete_profile", json!({ "key": "anything" })),
            ] {
                let err = http(&db, user, name, args).await.unwrap_err();
                assert!(err.is_not_found(), "{name} as user {}: {err}", user.id);
            }
            assert_eq!(http(&db, user, "fin_list_pairs", json!({})).await.unwrap(), json!([]));
            assert_eq!(http(&db, user, "fin_list_rules", json!({})).await.unwrap(), json!([]));
        }
    }

    #[tokio::test]
    async fn an_import_is_a_job_with_progress_one_per_user() {
        let db = test_db("fin_import_job").await;
        let mia = member(&db, 7, &[]).await;
        let ana = member(&db, 8, &[]).await;
        assert_eq!(http(&db, mia, "fin_import_status", json!({})).await.unwrap(), Value::Null);
        let args = json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "revolut",
            "accountMap": { "revolut:current:EUR": { "create": { "kind": "current", "name": "Everyday", "currency": "EUR" } } } });
        // The job answers at once; a second import waits for the first to finish.
        let job = http(&db, mia, "fin_import", args.clone()).await.unwrap();
        assert_eq!((job["state"].as_str(), job["file_name"].as_str()), (Some("running"), Some("s.csv")));
        let err = http(&db, mia, "fin_import", args.clone()).await.unwrap_err();
        assert!(err.to_string().contains("already running"), "{err}");
        // Another user can import alongside, and can't see Mia's job.
        assert_eq!(http(&db, ana, "fin_import_status", json!({})).await.unwrap(), Value::Null);
        assert!(http(&db, ana, "fin_import_status", json!({ "jobId": job["job_id"] })).await.unwrap_err().is_not_found());
        // Without an id, the status finds the latest job (a refreshed page).
        let mut st = http(&db, mia, "fin_import_status", json!({})).await.unwrap();
        while st["state"] == "running" {
            assert!(st["total"].as_u64().unwrap() >= st["done"].as_u64().unwrap());
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            st = http(&db, mia, "fin_import_status", json!({})).await.unwrap();
        }
        assert_eq!((st["state"].as_str(), st["stage"].as_str(), st["job_id"].as_u64()), (Some("done"), Some("done"), job["job_id"].as_u64()));
        assert_eq!((st["result"]["created"].as_i64(), st["done"].as_i64(), st["total"].as_i64()), (Some(2), Some(2), Some(2)));
        assert!(st["finished_at"].is_string() && st["error"].is_null());
        // Done, the next import may start; a bad profile is refused before any job.
        let err = http(&db, mia, "fin_import", json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "nope", "accountMap": {} }))
            .await
            .unwrap_err();
        assert!(err.is_not_found());
        let accounts = http(&db, mia, "fin_list_accounts", json!({})).await.unwrap();
        let again = json!({ "fileName": "s.csv", "contentBase64": b64(FILE), "profileKey": "revolut",
            "accountMap": { "revolut:current:EUR": id(&accounts[0]) } });
        let r = import(&db, mia, again).await;
        assert_eq!((r["created"].as_i64(), r["duplicates"].as_i64()), (Some(0), Some(2)));
    }

    #[tokio::test]
    async fn oversized_and_broken_uploads_are_refused() {
        let db = test_db("fin_import_size").await;
        let mia = member(&db, 7, &[]).await;
        let big = "a".repeat(ganban_core::finance::import::MAX_FILE_BYTES + 1);
        let err = http(&db, mia, "fin_preview_import", json!({ "fileName": "x.csv", "contentBase64": b64(&big) })).await.unwrap_err();
        assert_eq!(err.to_string(), "Invalid input: file too large: export a shorter period");
        let err = http(&db, mia, "fin_preview_import", json!({ "fileName": "x.csv", "contentBase64": "%%%" })).await.unwrap_err();
        assert!(err.is_invalid_input());
    }
}
