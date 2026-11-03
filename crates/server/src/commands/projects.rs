//! Projects and their areas.

use ganban_core::error::AppError;
use ganban_core::{auth, ops, visibility};

use super::{command, reply, Access, Author, Command, ResultFilter, Sees, Target, INPUT_PROJECT, PROJECT};

/// The area named by `areaId`; a restricted area is only its members' (and admins').
pub(super) const AREA: Target = Target::arg("areaId", |db, id| {
    Box::pin(async move { Ok(Some(auth::area_project_id(db, id).await?.ok_or_else(|| AppError::NotFound("area".into()))?)) })
})
.seen_by(SEES_AREA);

/// Whether a viewer can see an area.
pub(super) const SEES_AREA: Sees = |db, v, id| Box::pin(visibility::can_see_area(db, v, id));

pub(super) const COMMANDS: &[Command] = &[
    // ----- Projects -----
    command("get_projects")
        .access(Access::AnyMember)
        .filter(ResultFilter::Projects)
        .run(|cx, _| Box::pin(async move { reply(ops::get_projects(cx.db).await?) })),
    // A top-level project is a workspace-level action: members are invited to existing
    // projects, or they could spawn projects in the owner's workspace. Its creator becomes
    // the owner-member, so they can never lose sight of it.
    command("create_project")
        .access(Access::Owner)
        .author(Author::Arg("createdBy"))
        .run(|cx, a| {
            Box::pin(async move {
                let project = ops::create_project(cx.db, a.input()?).await?;
                if let Some(creator) = a.opt_author() {
                    auth::add_project_member(cx.db, project.id, creator, auth::ROLE_OWNER).await?;
                }
                reply(project)
            })
        }),
    command("update_project")
        .access(Access::Admin(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(ops::update_project(cx.db, a.id(PROJECT)?, a.input()?).await?) })),
    command("archive_project").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            reply(ops::archive_project(cx.db, a.id(PROJECT)?, a.opt_bool("archived").unwrap_or(false)).await?)
        })
    }),
    command("delete_project")
        .access(Access::Admin(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_project(cx.db, a.id(PROJECT)?).await?) })),
    command("set_project_model_profile").access(Access::Admin(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            reply(ops::set_project_model_profile(cx.db, a.id(PROJECT)?, a.opt_i64("profileId")).await?)
        })
    }),
    // Counted over the tasks the caller can see (task visibility).
    command("get_project_stats").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let pid = a.id(PROJECT)?;
            reply(ops::get_project_stats_among(cx.db, pid, cx.visible_tasks(Some(pid)).await?.as_ref()).await?)
        })
    }),
    command("get_project_member_overview").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            let pid = a.id(PROJECT)?;
            reply(ops::get_project_member_overview_among(cx.db, pid, cx.visible_tasks(Some(pid)).await?.as_ref()).await?)
        })
    }),
    // ----- Areas -----
    command("get_areas")
        .access(Access::Member(PROJECT))
        .filter(ResultFilter::Areas)
        .run(|cx, a| Box::pin(async move { reply(ops::get_areas(cx.db, a.id(PROJECT)?).await?) })),
    // Who an area is restricted to: admins decide (ADR 0002).
    command("set_area_restricted").access(Access::Admin(AREA)).run(|cx, a| {
        Box::pin(async move {
            reply(visibility::set_area_restricted(cx.db, a.id(AREA)?, a.opt_bool("restricted").unwrap_or(false)).await?)
        })
    }),
    command("set_area_members").access(Access::Admin(AREA)).run(|cx, a| {
        Box::pin(async move { reply(visibility::set_area_members(cx.db, a.id(AREA)?, &a.i64_list("userIds")).await?) })
    }),
    command("get_area_members")
        .access(Access::Member(AREA))
        .run(|cx, a| Box::pin(async move { reply(visibility::area_member_ids(cx.db, a.id(AREA)?).await?) })),
    command("create_area")
        .access(Access::Admin(INPUT_PROJECT))
        .run(|cx, a| Box::pin(async move { reply(ops::create_area(cx.db, a.input()?).await?) })),
    command("update_area")
        .access(Access::Admin(AREA))
        .run(|cx, a| Box::pin(async move { reply(ops::update_area(cx.db, a.id(AREA)?, a.input()?).await?) })),
    command("delete_area")
        .access(Access::Admin(AREA))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_area(cx.db, a.id(AREA)?).await?) })),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    async fn two_projects(db: &ganban_core::Db) -> (i64, i64) {
        let a = seed(db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        (a, b)
    }

    #[tokio::test]
    async fn a_member_lists_only_their_projects_and_the_owner_lists_all() {
        let db = test_db("projects_filter").await;
        let (a, b) = two_projects(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        assert_eq!(ids(&http(&db, mia, "get_projects", json!({})).await.unwrap()), vec![a]);
        let owner = owner(&db).await;
        let all = ids(&http(&db, owner, "get_projects", json!({})).await.unwrap());
        assert!(all.contains(&a) && all.contains(&b));
    }

    #[tokio::test]
    async fn project_reads_need_membership_and_config_needs_admin() {
        let db = test_db("projects_rules").await;
        let (a, b) = two_projects(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;

        for read in ["get_project_stats", "get_project_member_overview", "get_areas"] {
            assert!(http(&db, mia, read, json!({ "projectId": a })).await.is_ok(), "{read} on her project");
            let err = http(&db, mia, read, json!({ "projectId": b })).await.unwrap_err();
            assert!(err.is_not_found(), "{read} on a project she isn't in looks absent: {err}");
        }

        let rename = json!({ "projectId": a, "input": { "name": "A2" } });
        assert!(http(&db, mia, "update_project", rename.clone()).await.unwrap_err().is_forbidden());
        assert!(http(&db, mia, "archive_project", json!({ "projectId": a, "archived": true })).await.unwrap_err().is_forbidden());
        assert!(http(&db, mia, "delete_project", json!({ "projectId": a })).await.unwrap_err().is_forbidden());
        assert_eq!(http(&db, ana, "update_project", rename).await.unwrap()["name"], "A2");
        assert!(http(&db, ana, "delete_project", json!({ "projectId": b })).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn only_the_owner_creates_projects_and_becomes_their_owner_member() {
        let db = test_db("projects_create").await;
        // Flag the owner first: promoting one backfills owner membership on every project.
        let owner = owner(&db).await;
        let (a, _) = two_projects(&db).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let new = json!({ "input": { "name": "Mine" } });
        assert!(http(&db, ana, "create_project", new.clone()).await.unwrap_err().is_forbidden());

        let pid = http(&db, owner, "create_project", new).await.unwrap()["id"].as_i64().unwrap();
        assert_eq!(ganban_core::auth::member_role(&db, pid, owner.id).await.unwrap().as_deref(), Some("owner"));
        // In-process (desktop) nobody is stamped as creator, so no member row appears.
        assert_eq!(ganban_core::auth::member_role(&db, a, owner.id).await.unwrap(), None);
    }

    #[tokio::test]
    async fn areas_are_managed_by_the_projects_admins() {
        let db = test_db("areas_rules").await;
        let (a, _) = two_projects(&db).await;
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let new = json!({ "input": { "project_id": a, "name": "Backend" } });
        assert!(http(&db, mia, "create_area", new.clone()).await.unwrap_err().is_forbidden());
        let area = http(&db, ana, "create_area", new).await.unwrap()["id"].as_i64().unwrap();

        let rename = json!({ "areaId": area, "input": { "name": "Server" } });
        assert!(http(&db, mia, "update_area", rename.clone()).await.unwrap_err().is_forbidden());
        assert_eq!(http(&db, ana, "update_area", rename).await.unwrap()["name"], "Server");
        assert!(http(&db, mia, "delete_area", json!({ "areaId": area })).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "delete_area", json!({ "areaId": 999 })).await.unwrap_err().is_not_found());
        http(&db, ana, "delete_area", json!({ "areaId": area })).await.unwrap();
    }
}
