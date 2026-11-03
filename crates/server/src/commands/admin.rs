//! Host administration: invites and project membership, other members' devices, app
//! settings, Tailscale sharing, automation rules, and the native builds the host offers.

use ganban_core::error::AppError;
use ganban_core::{auth, ops};
use serde_json::{json, Value};

use super::{command, reply, require_role, Access, Command, Target, PROJECT};

/// The project named by `projectId`, if any; leaving it out means the whole workspace
/// (the owner's).
const MAYBE_PROJECT: Target = Target::optional("projectId", |_, id| Box::pin(async move { Ok(Some(id)) }));

/// The invite named by `id`, and the project it joins (a device-pairing token joins none).
const INVITE: Target = Target::arg("id", |db, id| {
    Box::pin(async move { Ok(auth::get_invite_token(db, id).await?.ok_or_else(|| AppError::NotFound("invite not found".into()))?.project_id) })
});

/// A raw invite or pairing token.
const TOKEN: &str = "token";

/// The member whose role or membership changes.
const TARGET_USER: &str = "userId";

/// Roles the API can grant: never "owner" (no self-escalation).
fn grantable(role: String) -> Result<String, AppError> {
    if auth::is_grantable_role(&role) {
        Ok(role)
    } else {
        Err(AppError::InvalidInput("role must be 'admin' or 'member'".into()))
    }
}

/// Only the owner may change or remove a project's owner-member.
async fn spare_the_project_owner(cx: &super::Ctx<'_>, project: i64, target: i64, what: &str) -> Result<(), AppError> {
    if !cx.caller.is_owner() && auth::member_role(cx.db, project, target).await?.as_deref() == Some(auth::ROLE_OWNER) {
        return Err(AppError::Forbidden(format!("only the owner can {what} the project owner")));
    }
    Ok(())
}

pub(super) const COMMANDS: &[Command] = &[
    // ----- Invites -----
    command("create_invite").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let role = grantable(a.opt_str("role").unwrap_or_else(|| auth::ROLE_MEMBER.to_string()))?;
            let token = auth::create_enrollment_token(
                cx.db,
                "invite",
                None,
                Some(a.id(PROJECT)?),
                Some(&role),
                a.opt_str("displayName").as_deref(),
                auth::INVITE_TTL_SECS,
            )
            .await?;
            Ok(json!({ "token": token }))
        })
    }),
    // A just-minted token's lifecycle, for the inviter's diagnostics: the admins of the
    // token's own project may look; a project-less pairing token is the owner's.
    command("invite_status")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                match auth::invite_status(cx.db, &a.req_str(TOKEN)?).await?.project_id {
                    Some(project) => require_role(cx.db, user, project, auth::ROLE_ADMIN).await,
                    None => Err(AppError::Forbidden("owner only".into())),
                }
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(auth::invite_status(cx.db, &a.req_str(TOKEN)?).await?) })),
    // Pending invites, to review and revoke: one project's (its admins) or all (the owner).
    command("list_invites")
        .access(Access::Admin(MAYBE_PROJECT))
        .run(|cx, a| Box::pin(async move { reply(auth::list_invites(cx.db, a.opt_id(MAYBE_PROJECT)).await?) })),
    command("revoke_invite")
        .access(Access::Admin(INVITE))
        .run(|cx, a| Box::pin(async move { reply(auth::revoke_invite(cx.db, a.id(INVITE)?).await?) })),
    command("contact_invite").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let role = grantable(a.opt_str("role").unwrap_or_else(|| auth::ROLE_MEMBER.to_string()))?;
            let token = auth::create_contact_invite(cx.db, a.req_i64("contactId")?, a.id(PROJECT)?, &role).await?;
            Ok(json!({ "token": token }))
        })
    }),
    command("contact_add_to_project").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let role = grantable(a.opt_str("role").unwrap_or_else(|| auth::ROLE_MEMBER.to_string()))?;
            reply(auth::add_contact_to_project(cx.db, a.req_i64("contactId")?, a.id(PROJECT)?, &role).await?)
        })
    }),
    // ----- Members -----
    command("list_members")
        .access(Access::Admin(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(auth::list_project_members(cx.db, a.id(PROJECT)?).await?) })),
    command("set_member_role").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let (project, target, role) = (a.id(PROJECT)?, a.req_i64(TARGET_USER)?, grantable(a.req_str("role")?)?);
            spare_the_project_owner(cx, project, target, "change").await?;
            reply(auth::add_project_member(cx.db, project, target, &role).await?)
        })
    }),
    command("remove_member").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let (project, target) = (a.id(PROJECT)?, a.req_i64(TARGET_USER)?);
            spare_the_project_owner(cx, project, target, "remove").await?;
            reply(auth::remove_project_member(cx.db, project, target).await?)
        })
    }),
    // ----- Other members' devices -----
    // Pair a new device FOR a member who has none left (lost phone, cleared browser): a
    // "new_device" token that resolves to their existing account. The owner is the host's
    // perimeter, which is why this is theirs alone.
    command("create_member_device_enrollment").access(Access::Owner).run(|cx, a| {
        Box::pin(async move { Ok(json!({ "token": auth::create_member_device_enrollment(cx.db, a.req_i64(TARGET_USER)?).await? })) })
    }),
    command("list_devices")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(auth::list_user_devices(cx.db, a.req_i64(TARGET_USER)?).await?) })),
    // ----- App settings (e.g. the default storage allocation) -----
    command("get_app_setting")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::get_app_setting(cx.db, &a.req_str("key")?).await?) })),
    command("set_app_setting").access(Access::Owner).run(|cx, a| {
        Box::pin(async move { reply(ops::set_app_setting(cx.db, &a.req_str("key")?, &a.req_str("value")?).await?) })
    }),
    // ----- The optional knowledge engine (ragrat) -----
    // Whether one is set up, so a client can show a calm "not set up" state instead of the
    // error every ragrat-backed call returns without it. A yes/no, never its address or token.
    command("get_knowledge_engine").access(Access::AnyMember).run(|cx, _| {
        Box::pin(async move { Ok(json!({ "setUp": crate::rag::RagConfig::from_db(cx.db).await.is_some() })) })
    }),
    // ----- Tailscale sharing: device metadata and invite URLs, never the credential -----
    command("tailscale_check").access(Access::Owner).run(|cx, _| {
        Box::pin(async move { crate::tailscale::list_devices(cx.db).await.map_err(AppError::InvalidInput) })
    }),
    // Best-effort: a broken credential must not block the Ganban invite, so its error is a
    // soft field, not a failed call.
    command("tailscale_share").access(Access::Owner).run(|cx, _| {
        Box::pin(async move {
            Ok(match crate::tailscale::create_share_detailed(cx.db).await {
                Ok(Some(share)) => json!({ "ts": share.url, "token_expiry": share.token_expiry }),
                Ok(None) => json!({ "ts": Value::Null }),
                Err(e) => json!({ "ts": Value::Null, "error": e }),
            })
        })
    }),
    // ----- Automation rules (the engine runs on the host) -----
    command("list_rules")
        .access(Access::Owner)
        .run(|cx, _| Box::pin(async move { reply(ops::list_rules(cx.db).await?) })),
    command("create_rule")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::create_rule(cx.db, a.input()?).await?) })),
    command("update_rule")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::update_rule(cx.db, a.req_i64("ruleId")?, a.input()?).await?) })),
    command("delete_rule")
        .access(Access::Owner)
        .run(|cx, a| Box::pin(async move { reply(ops::delete_rule(cx.db, a.req_i64("ruleId")?).await?) })),
    // ----- Native builds offered at /download -----
    // The build files live on the host: a remote owner picks from host-side discovery and
    // toggles what's shared; nothing is uploaded.
    command("discover_builds")
        .access(Access::Owner)
        .run(|_, a| Box::pin(async move { reply(crate::builds::discover(a.opt_str("base"))) })),
    command("set_build").access(Access::Owner).run(|cx, a| {
        Box::pin(async move {
            let shares = cx.shares()?;
            let kind = a.opt_str("kind").ok_or_else(|| AppError::InvalidInput("kind required".into()))?;
            let slot = shares.slot(&kind).ok_or_else(|| AppError::InvalidInput(format!("unknown build kind: {kind}")))?;
            crate::set_share_slot(slot, a.opt_str("path")).map_err(AppError::InvalidInput)?;
            Ok(crate::shared_builds_json(shares))
        })
    }),
    command("shared_builds")
        .access(Access::Owner)
        .run(|cx, _| Box::pin(async move { Ok(crate::shared_builds_json(cx.shares()?)) })),
    // ----- Client updates and the host's own update (ADR 0007) -----
    // What the host built for the clients: every member's app checks it.
    command("get_client_builds").access(Access::AnyMember).run(|cx, a| {
        Box::pin(async move {
            let (target, arch) = (a.opt_str("target"), a.opt_str("arch"));
            Ok(crate::updates::client_builds(&cx.update_paths(), target.as_deref(), arch.as_deref()))
        })
    }),
    // Runs ops/update.sh as its own launchd job; it restarts this server.
    command("start_host_update")
        .access(Access::Owner)
        .run(|cx, _| Box::pin(async move { crate::updates::start_host_update(&cx.update_paths()).await })),
    command("get_host_update_status")
        .access(Access::Owner)
        .run(|cx, _| Box::pin(async move { Ok(crate::updates::host_update_status(&cx.update_paths()).await) })),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;
    use super::super::{run, Ctx};

    #[tokio::test]
    async fn invites_and_members_are_managed_by_the_projects_admins() {
        let db = test_db("admin_members").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        // The owner as owner-member of A.
        ganban_core::auth::add_project_member(&db, a, owner.id, "owner").await.unwrap();

        let invite = json!({ "projectId": a, "role": "member" });
        assert!(http(&db, mia, "create_invite", invite.clone()).await.unwrap_err().is_forbidden());
        // An invite grants member or admin, never "owner", whoever mints it.
        for who in [ana, owner] {
            let crown = json!({ "projectId": a, "role": "owner" });
            assert!(http(&db, who, "create_invite", crown).await.unwrap_err().is_invalid_input());
        }
        let token = http(&db, ana, "create_invite", invite).await.unwrap()["token"].as_str().unwrap().to_string();
        assert_eq!(http(&db, ana, "invite_status", json!({ "token": token })).await.unwrap()["state"], "pending");
        assert!(http(&db, mia, "invite_status", json!({ "token": token })).await.unwrap_err().is_forbidden());
        assert_eq!(http(&db, ana, "list_invites", json!({ "projectId": a })).await.unwrap().as_array().unwrap().len(), 1);
        assert!(http(&db, ana, "list_invites", json!({})).await.unwrap_err().is_forbidden(), "all invites are the owner's");

        assert!(http(&db, mia, "list_members", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
        let promote = json!({ "projectId": a, "userId": 7, "role": "admin" });
        http(&db, ana, "set_member_role", promote).await.unwrap();
        let crown = json!({ "projectId": a, "userId": 7, "role": "owner" });
        assert!(http(&db, ana, "set_member_role", crown).await.unwrap_err().is_invalid_input());
        let demote_owner = json!({ "projectId": a, "userId": owner.id, "role": "member" });
        assert!(http(&db, ana, "set_member_role", demote_owner).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "remove_member", json!({ "projectId": a, "userId": owner.id })).await.unwrap_err().is_forbidden());
        http(&db, ana, "remove_member", json!({ "projectId": a, "userId": 7 })).await.unwrap();
    }

    #[tokio::test]
    async fn pairing_tokens_and_host_machinery_are_the_owners() {
        let db = test_db("admin_owner").await;
        let owner = owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let ana = member(&db, 8, &[(a, "admin")]).await;

        for (cmd, args) in [
            ("create_member_device_enrollment", json!({ "userId": 8 })),
            ("list_devices", json!({ "userId": 8 })),
            ("get_app_setting", json!({ "key": "k" })),
            ("set_app_setting", json!({ "key": "k", "value": "v" })),
            ("list_rules", json!({})),
            ("tailscale_check", json!({})),
            ("discover_builds", json!({})),
            ("shared_builds", json!({})),
            ("start_host_update", json!({})),
            ("get_host_update_status", json!({})),
        ] {
            assert!(http(&db, ana, cmd, args).await.unwrap_err().is_forbidden(), "{cmd}");
        }

        // A device-pairing token joins no project: only the owner may revoke it.
        let pairing = seed(&db, "create_device_enrollment", json!({ "userId": 8 })).await;
        let invites = http(&db, owner, "list_invites", json!({})).await.unwrap();
        let id = invites.as_array().unwrap().iter().find(|i| i["kind"] == "new_device").unwrap()["id"].clone();
        assert!(http(&db, ana, "revoke_invite", json!({ "id": id })).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "invite_status", json!({ "token": pairing["token"] })).await.unwrap_err().is_forbidden());
        http(&db, owner, "revoke_invite", json!({ "id": id })).await.unwrap();
    }

    #[tokio::test]
    async fn any_member_learns_whether_the_knowledge_engine_is_set_up_and_nothing_more() {
        let db = test_db("admin_knowledge_engine").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        let off = http(&db, mia, "get_knowledge_engine", json!({})).await.unwrap();
        assert_eq!(off, json!({ "setUp": false }));

        let conn = json!({ "url": "http://127.0.0.1:8780", "token": "secret" }).to_string();
        seed(&db, "set_app_setting", json!({ "key": "ragrat_connection", "value": conn })).await;
        let on = http(&db, mia, "get_knowledge_engine", json!({})).await.unwrap();
        assert_eq!(on, json!({ "setUp": true }), "a yes/no only: no address, no token");
    }

    #[tokio::test]
    async fn build_sharing_runs_where_builds_are_served() {
        let db = test_db("admin_builds").await;
        let owner = owner(&db).await;
        let shares = crate::Shares::default();
        let cx = Ctx::http(&db, owner).with_shares(&shares);
        assert_eq!(run(&cx, "shared_builds", json!({})).await.unwrap()["android"], serde_json::Value::Null);
        let bad = run(&cx, "set_build", json!({ "kind": "amiga", "path": null })).await.unwrap_err();
        assert!(bad.is_invalid_input(), "{bad}");
        // Without shares (no host serving downloads) the commands say so.
        assert!(http(&db, owner, "shared_builds", json!({})).await.unwrap_err().is_invalid_input());
    }
}
