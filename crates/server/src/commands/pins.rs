//! Pinned tabs: a user's shortcuts in the global top bar (project + tab, and the tab's
//! sub-view where it has one). Each pin lives on the host that owns its project; a desktop
//! with several workspaces merges them, ordered by `position`. Every row is the caller's own:
//! the authorship field names the user, so over HTTP it is always the signed-in one.

use ganban_core::{auth, ops};
use serde_json::Value;

use super::{command, reply, Access, Author, Command, PROJECT};

const USER: Author = Author::Arg("userId");

pub(super) const COMMANDS: &[Command] = &[
    // Pins to a project the caller has since left stay in the table but aren't shown.
    command("list_tab_pins").access(Access::AnyMember).author(USER).run(|cx, a| {
        Box::pin(async move {
            let mut pins = ops::list_tab_pins(cx.db, a.author()?).await?;
            if let Some(user) = cx.caller.non_owner() {
                let mut kept = Vec::with_capacity(pins.len());
                for p in pins {
                    if auth::member_role(cx.db, p.project_id, user.id).await?.is_some() {
                        kept.push(p);
                    }
                }
                pins = kept;
            }
            reply(pins)
        })
    }),
    command("set_tab_pin").access(Access::Member(PROJECT)).author(USER).run(|cx, a| {
        Box::pin(async move {
            let position = a.get("position").and_then(Value::as_f64).unwrap_or(0.0);
            let sub = a.opt_str("subView");
            reply(ops::set_tab_pin(cx.db, a.author()?, a.id(PROJECT)?, &a.req_str("tabId")?, sub.as_deref(), position).await?)
        })
    }),
    // Only ever the caller's own row, so no project rule: a member who has left can still
    // clear a pin.
    command("unpin_tab").access(Access::AnyMember).author(USER).run(|cx, a| {
        Box::pin(async move { reply(ops::unpin_tab(cx.db, a.author()?, a.req_i64("projectId")?, &a.req_str("tabId")?).await?) })
    }),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use serde_json::json;

    fn tabs(v: &serde_json::Value) -> Vec<(i64, String)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (p["project_id"].as_i64().unwrap(), p["tab_id"].as_str().unwrap().to_string()))
            .collect()
    }

    #[tokio::test]
    async fn pins_are_the_callers_own_and_follow_membership() {
        let db = test_db("tab_pins").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "member"), (b, "member")]).await;

        // The authorship field is stamped: Mia naming Ana still pins for Mia.
        let pin = |pid: i64, tab: &str, pos: f64| json!({ "userId": 8, "projectId": pid, "tabId": tab, "subView": "practice", "position": pos });
        http(&db, mia, "set_tab_pin", pin(a, "quiz", 2.0)).await.unwrap();
        http(&db, mia, "set_tab_pin", pin(a, "tasks", 1.0)).await.unwrap();
        // Not a member of B: refused, and B's existence isn't revealed.
        assert!(http(&db, mia, "set_tab_pin", pin(b, "tasks", 3.0)).await.unwrap_err().is_not_found());

        let mine = http(&db, mia, "list_tab_pins", json!({ "userId": 8 })).await.unwrap();
        assert_eq!(tabs(&mine), vec![(a, "tasks".into()), (a, "quiz".into())], "ordered by position");
        assert_eq!(mine[1]["sub_view"], "practice");
        assert!(tabs(&http(&db, ana, "list_tab_pins", json!({})).await.unwrap()).is_empty(), "Ana sees only hers");

        // Re-pinning moves the one pin; it doesn't add a second.
        http(&db, mia, "set_tab_pin", pin(a, "quiz", 0.5)).await.unwrap();
        let mine = http(&db, mia, "list_tab_pins", json!({})).await.unwrap();
        assert_eq!(tabs(&mine), vec![(a, "quiz".into()), (a, "tasks".into())]);

        // Leaving the project hides its pins; unpinning still works.
        sqlx::query("DELETE FROM project_members WHERE user_id = 7").execute(&db).await.unwrap();
        assert!(tabs(&http(&db, mia, "list_tab_pins", json!({})).await.unwrap()).is_empty());
        http(&db, mia, "unpin_tab", json!({ "projectId": a, "tabId": "tasks" })).await.unwrap();
        assert_eq!(tabs(&seed(&db, "list_tab_pins", json!({ "userId": 7 })).await), vec![(a, "quiz".into())]);
    }

    #[tokio::test]
    async fn a_disabled_tab_or_deleted_project_drops_its_pins() {
        let db = test_db("tab_pins_drop").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let me = owner.id;
        for (pid, tab, pos) in [(a, "quiz", 1.0), (a, "nato", 2.0), (b, "tasks", 3.0)] {
            seed(&db, "set_tab_pin", json!({ "userId": me, "projectId": pid, "tabId": tab, "position": pos })).await;
        }
        ganban_core::ops::set_project_tab(&db, a, "nato", false).await.unwrap();
        seed(&db, "delete_project", json!({ "projectId": b })).await;
        let left = seed(&db, "list_tab_pins", json!({ "userId": me })).await;
        assert_eq!(tabs(&left), vec![(a, "quiz".into())]);
    }

    #[tokio::test]
    async fn bad_ids_are_refused() {
        let db = test_db("tab_pins_bad").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let bad = json!({ "projectId": a, "tabId": "../x", "position": 1.0 });
        assert!(http(&db, owner, "set_tab_pin", bad).await.unwrap_err().is_invalid_input());
    }
}
