//! Users: the workspace's people and their profiles. A member sees the people they share a
//! project with; the owner manages accounts. PINs and personal settings belong to their user.

use ganban_core::error::AppError;
use ganban_core::{auth, ops};

use super::{command, reply, Access, Command, ResultFilter};

/// The user a command is about.
const USER: &str = "userId";

pub(super) const COMMANDS: &[Command] = &[
    command("get_users")
        .access(Access::AnyMember)
        .filter(ResultFilter::Users)
        .run(|cx, _| Box::pin(async move { reply(ops::get_users(cx.db).await?) })),
    command("get_active_users")
        .access(Access::AnyMember)
        .filter(ResultFilter::Users)
        .run(|cx, _| Box::pin(async move { reply(ops::get_active_users(cx.db).await?) })),
    // A profile carries PII: a member may read their own and those of the people they share
    // a project with. One they can't see and one that doesn't exist look the same.
    command("get_user")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                if auth::covisible_user_ids(cx.db, user.id).await?.contains(&a.req_i64(USER)?) {
                    Ok(())
                } else {
                    Err(AppError::NotFound("user".into()))
                }
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(ops::get_user(cx.db, a.req_i64(USER)?).await?) })),
    command("create_user")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::create_user(cx.db, a.input()?).await?) })),
    command("update_user")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::update_user(cx.db, a.req_i64(USER)?, a.input()?).await?) })),
    command("delete_user")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::delete_user(cx.db, a.req_i64(USER)?).await?) })),
    // ----- PINs -----
    command("set_user_pin").access(Access::SelfOrOwner(USER)).run(|cx, a| {
        Box::pin(async move { reply(ops::set_user_pin(cx.db, a.req_i64(USER)?, a.opt_str("pin").as_deref()).await?) })
    }),
    // Open to every signed-in device: it's how the profile picker checks the PIN typed for
    // the chosen profile.
    command("verify_user_pin").access(Access::AnyMember).run(|cx, a| {
        Box::pin(async move { reply(ops::verify_user_pin(cx.db, a.req_i64(USER)?, &a.req_str("pin")?).await?) })
    }),
    // ----- Personal settings -----
    command("get_user_setting").access(Access::SelfOrOwner(USER)).run(|cx, a| {
        Box::pin(async move { reply(ops::get_user_setting(cx.db, a.req_i64(USER)?, a.req_str("settingKey")?).await?) })
    }),
    command("set_user_setting").access(Access::SelfOrOwner(USER)).run(|cx, a| {
        Box::pin(async move {
            reply(ops::set_user_setting(cx.db, a.req_i64(USER)?, a.req_str("settingKey")?, a.req_str("settingValue")?).await?)
        })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    #[tokio::test]
    async fn members_see_only_the_people_they_share_a_project_with() {
        let db = test_db("users_filter").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        member(&db, 8, &[(a, "member")]).await;
        member(&db, 9, &[(b, "member")]).await;

        let mut seen = ids(&http(&db, mia, "get_users", json!({})).await.unwrap());
        seen.sort();
        // The owner is owner-member of every project, so Mia shares A with them too.
        assert_eq!(seen, vec![owner.id, 7, 8]);
        assert_eq!(ids(&http(&db, mia, "get_active_users", json!({})).await.unwrap()).len(), 3);
        assert_eq!(http(&db, mia, "get_user", json!({ "userId": 8 })).await.unwrap()["id"], 8);
        let hidden = http(&db, mia, "get_user", json!({ "userId": 9 })).await.unwrap_err();
        let absent = http(&db, mia, "get_user", json!({ "userId": 999 })).await.unwrap_err();
        assert!(hidden.is_not_found(), "{hidden}");
        assert_eq!(hidden.to_string(), absent.to_string(), "a hidden user and a missing one look the same");
        assert_eq!(ids(&http(&db, owner, "get_users", json!({})).await.unwrap()).len(), 4);
    }

    #[tokio::test]
    async fn accounts_are_the_owners_and_pins_and_settings_their_users() {
        let db = test_db("users_rules").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;

        assert!(http(&db, ana, "create_user", json!({ "input": { "username": "x", "full_name": "X" } })).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "delete_user", json!({ "userId": 7 })).await.unwrap_err().is_forbidden());

        let setting = |uid: i64| json!({ "userId": uid, "settingKey": "theme", "settingValue": "dark" });
        http(&db, mia, "set_user_setting", setting(7)).await.unwrap();
        assert!(http(&db, ana, "set_user_setting", setting(7)).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "get_user_setting", json!({ "userId": 7, "settingKey": "theme" })).await.unwrap_err().is_forbidden());

        http(&db, mia, "set_user_pin", json!({ "userId": 7, "pin": "1234" })).await.unwrap();
        assert!(http(&db, ana, "set_user_pin", json!({ "userId": 7, "pin": null })).await.unwrap_err().is_forbidden());
        assert_eq!(http(&db, ana, "verify_user_pin", json!({ "userId": 7, "pin": "1234" })).await.unwrap(), true);
        // The owner may clear a member's forgotten PIN.
        http(&db, owner, "set_user_pin", json!({ "userId": 7, "pin": null })).await.unwrap();
    }
}
