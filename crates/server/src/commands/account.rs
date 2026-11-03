//! The caller's own account: their name and profile, leaving a project, their notifications
//! and tickets, and their devices. Each command acts on the caller, the `userId` authorship
//! field: stamped from the signed-in user over HTTP, sent by the desktop app in-process.

use ganban_core::error::AppError;
use ganban_core::{auth, ops};
use serde_json::{json, Value};

use super::{command, reply, Access, Author, Command, ResultFilter};

/// The caller, as the authorship field.
const ME: Author = Author::Arg("userId");

/// The device token named by `tokenId`.
const DEVICE: &str = "tokenId";

pub(super) const COMMANDS: &[Command] = &[
    // ----- Profile -----
    command("set_my_display_name").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            let name = a.req_str("fullName")?;
            let name = name.trim();
            if name.is_empty() {
                return Err(AppError::InvalidInput("name cannot be empty".into()));
            }
            reply(auth::set_display_name(cx.db, a.author()?, name).await?)
        })
    }),
    // The profile blob is opaque to the host; the client validates its shape.
    command("set_my_profile").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            reply(ops::set_user_profile(cx.db, a.author()?, a.get("profileJson").and_then(Value::as_str)).await?)
        })
    }),
    // The owner is owner-member of every project and can't orphan one.
    command("leave_project").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            if cx.caller.is_owner() {
                return Err(AppError::Forbidden("the owner cannot leave a project".into()));
            }
            reply(auth::remove_project_member(cx.db, a.req_i64("projectId")?, a.author()?).await?)
        })
    }),
    // ----- Notifications -----
    command("get_notifications")
        .access(Access::AnyMember)
        .author(ME)
        // A notification about a task goes with the task (task visibility).
        .filter(ResultFilter::OfTasks("link_task_id"))
        .run(|cx, a| Box::pin(async move { reply(ops::list_notifications(cx.db, a.author()?).await?) })),
    command("mark_notifications_read")
        .access(Access::AnyMember)
        .author(ME)
        .run(|cx, a| Box::pin(async move { reply(ops::mark_notifications_read(cx.db, a.author()?).await?) })),
    // ----- Tickets (bug reports and feature requests against the host) -----
    command("create_ticket").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            let kind = a.opt_str("kind").unwrap_or_else(|| "bug".into());
            reply(ops::create_ticket(cx.db, a.author()?, &kind, &a.req_str("title")?, a.opt_str("body").as_deref()).await?)
        })
    }),
    // ops scopes by viewer: the owner sees every ticket, anyone else their own.
    command("list_tickets")
        .access(Access::AnyMember)
        .author(ME)
        .run(|cx, a| Box::pin(async move { reply(ops::list_tickets(cx.db, a.author()?).await?) })),
    command("set_ticket_status").access(Access::Owner).run(|cx, a| {
        Box::pin(async move { reply(ops::set_ticket_status(cx.db, a.req_i64("id")?, &a.req_str("status")?).await?) })
    }),
    // ----- Devices -----
    // The caller's devices, with the one making this request flagged.
    command("list_my_devices").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            let mut devices = auth::list_user_devices(cx.db, a.author()?).await?;
            for d in &mut devices {
                d.current = cx.caller.device_id() == Some(d.id);
            }
            reply(devices)
        })
    }),
    // Another device for the caller: a "new_device" token pinned to their own account, so
    // enrolling it resolves to them (profile and memberships carry over), never anyone else.
    command("create_device_enrollment").access(Access::AnyMember).author(ME).run(|cx, a| {
        Box::pin(async move {
            let token =
                auth::create_enrollment_token(cx.db, "new_device", Some(a.author()?), None, None, None, auth::ENROLLMENT_TTL_SECS)
                    .await?;
            Ok(json!({ "token": token }))
        })
    }),
    // The owner may revoke any device; everyone else their own (losing a phone shouldn't
    // need the owner).
    command("revoke_device")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                if auth::device_token_user(cx.db, a.req_i64(DEVICE)?).await? == Some(user.id) {
                    Ok(())
                } else {
                    Err(AppError::Forbidden("you can only revoke your own devices".into()))
                }
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(auth::revoke_device_token(cx.db, a.req_i64(DEVICE)?).await?) })),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;
    use crate::AuthUser;

    #[tokio::test]
    async fn self_service_acts_on_the_caller_whatever_the_client_sends() {
        let db = test_db("account_self").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        member(&db, 8, &[(a, "member")]).await;

        http(&db, mia, "set_my_display_name", json!({ "fullName": "  Mia  ", "userId": 8 })).await.unwrap();
        assert_eq!(seed(&db, "get_user", json!({ "userId": 7 })).await["full_name"], "Mia");
        assert_eq!(seed(&db, "get_user", json!({ "userId": 8 })).await["full_name"], "User 8");
        assert!(http(&db, mia, "set_my_display_name", json!({ "fullName": " " })).await.unwrap_err().is_invalid_input());

        let ticket = http(&db, mia, "create_ticket", json!({ "title": "It broke", "userId": 8 })).await.unwrap();
        assert_eq!(ticket["user_id"], 7);
        assert_eq!(ids(&http(&db, mia, "list_tickets", json!({ "userId": 8 })).await.unwrap()).len(), 1);
        assert!(http(&db, mia, "set_ticket_status", json!({ "id": ticket["id"], "status": "closed" })).await.unwrap_err().is_forbidden());

        http(&db, mia, "leave_project", json!({ "projectId": a, "userId": 8 })).await.unwrap();
        assert_eq!(ganban_core::auth::member_role(&db, a, 7).await.unwrap(), None, "Mia left");
        assert!(ganban_core::auth::member_role(&db, a, 8).await.unwrap().is_some(), "user 8 stayed");
        let owner = owner(&db).await;
        assert!(http(&db, owner, "leave_project", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
    }

    #[tokio::test]
    async fn members_manage_their_own_devices_and_the_owner_any() {
        let db = test_db("account_devices").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let enrol = |name: &'static str| {
            let db = db.clone();
            async move {
                let invite = ganban_core::auth::create_enrollment_token(&db, "invite", None, Some(a), Some("member"), Some(name), 3600)
                    .await
                    .unwrap();
                let joined = ganban_core::auth::enroll(&db, &invite, Some("phone"), Some(name)).await.unwrap();
                let (user, device) = ganban_core::auth::validate_device_token(&db, &joined.device_token).await.unwrap().unwrap();
                AuthUser { id: user.id, is_owner: false, device_id: Some(device) }
            }
        };
        let mia = enrol("Mia").await;
        let bo = enrol("Bo").await;

        let mine = http(&db, mia, "list_my_devices", json!({ "userId": bo.id })).await.unwrap();
        assert_eq!(mine.as_array().unwrap().len(), 1);
        assert_eq!(mine[0]["current"], true, "the device making the request is flagged");

        let token = http(&db, mia, "create_device_enrollment", json!({ "userId": bo.id })).await.unwrap()["token"].clone();
        let second = ganban_core::auth::enroll(&db, token.as_str().unwrap(), Some("laptop"), None).await.unwrap();
        assert_eq!(second.user.id, mia.id, "a pairing code enrols the caller, never the user named");

        let bos = bo.device_id.unwrap();
        assert!(http(&db, mia, "revoke_device", json!({ "tokenId": bos })).await.unwrap_err().is_forbidden());
        http(&db, mia, "revoke_device", json!({ "tokenId": mia.device_id.unwrap() })).await.unwrap();
        http(&db, owner, "revoke_device", json!({ "tokenId": bos })).await.unwrap();
    }
}
