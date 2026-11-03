//! Model Assembly (Gundam kits and Warhammer armies): kits, their boards of numbered parts,
//! the build sections that consume them, and image links. Members read and write, the same
//! as tasks. Also each member's personal container, where the Models tab keeps a collection
//! of their own.

use ganban_core::error::AppError;
use ganban_core::{auth, ops, Db};
use serde_json::json;

use super::{command, reply, Access, Author, Command, Target, INPUT_PROJECT, PROJECT};

/// The kit named by `kitId`.
const KIT: Target = Target::arg("kitId", |db, id| Box::pin(kit_project(db, id)));

/// The kit a new board, section or part mark belongs to, by `input.kit_id`.
const INPUT_KIT: Target = Target::input("kit_id", |db, id| Box::pin(kit_project(db, id)));

/// The board named by `boardId` (board → kit → project).
const BOARD: Target = Target::arg("boardId", |db, id| {
    Box::pin(via_kit(db, "SELECT kit_id FROM model_boards WHERE id = ?", id, "model board"))
});

/// The build section named by `sectionId`.
const SECTION: Target = Target::arg("sectionId", |db, id| {
    Box::pin(via_kit(db, "SELECT kit_id FROM model_sections WHERE id = ?", id, "model section"))
});

/// The image link named by `linkId`.
const KIT_FILE: Target = Target::arg("linkId", |db, id| {
    Box::pin(via_kit(db, "SELECT kit_id FROM model_kit_files WHERE id = ?", id, "model file link"))
});

async fn kit_project(db: &Db, kit_id: i64) -> Result<Option<i64>, AppError> {
    Ok(Some(auth::model_kit_project_id(db, kit_id).await?.ok_or_else(|| AppError::NotFound(format!("model kit {kit_id}")))?))
}

/// The project of the kit a kit-owned row (`kit_of`: its `SELECT kit_id …`) belongs to.
async fn via_kit(db: &Db, kit_of: &'static str, id: i64, what: &'static str) -> Result<Option<i64>, AppError> {
    let kit: i64 = sqlx::query_scalar(kit_of)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(what.into()))?;
    kit_project(db, kit).await
}

pub(super) const COMMANDS: &[Command] = &[
    // ----- Kits -----
    command("list_model_kits")
        .access(Access::Member(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(ops::list_model_kits(cx.db, a.id(PROJECT)?).await?) })),
    command("create_model_kit")
        .access(Access::Member(INPUT_PROJECT))
        .run(|cx, a| Box::pin(async move { reply(ops::create_model_kit(cx.db, a.input()?).await?) })),
    command("update_model_kit")
        .access(Access::Member(KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::update_model_kit(cx.db, a.id(KIT)?, a.input()?).await?) })),
    command("delete_model_kit")
        .access(Access::Member(KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_model_kit(cx.db, a.id(KIT)?).await?) })),
    command("get_model_kit_detail")
        .access(Access::Member(KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::get_model_kit_detail(cx.db, a.id(KIT)?).await?) })),
    command("get_model_build_log")
        .access(Access::Member(KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::get_model_build_log(cx.db, a.id(KIT)?).await?) })),
    // ----- Boards and sections -----
    command("create_model_board")
        .access(Access::Member(INPUT_KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::create_model_board(cx.db, a.input()?).await?) })),
    command("update_model_board")
        .access(Access::Member(BOARD))
        .run(|cx, a| Box::pin(async move { reply(ops::update_model_board(cx.db, a.id(BOARD)?, a.input()?).await?) })),
    command("delete_model_board")
        .access(Access::Member(BOARD))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_model_board(cx.db, a.id(BOARD)?).await?) })),
    command("create_model_section")
        .access(Access::Member(INPUT_KIT))
        .run(|cx, a| Box::pin(async move { reply(ops::create_model_section(cx.db, a.input()?).await?) })),
    command("update_model_section")
        .access(Access::Member(SECTION))
        .run(|cx, a| Box::pin(async move { reply(ops::update_model_section(cx.db, a.id(SECTION)?, a.input()?).await?) })),
    command("delete_model_section")
        .access(Access::Member(SECTION))
        .run(|cx, a| Box::pin(async move { reply(ops::delete_model_section(cx.db, a.id(SECTION)?).await?) })),
    // ----- Parts -----
    // Returns `[marked, auto_duplicated]`.
    command("mark_model_part").access(Access::Member(INPUT_KIT)).run(|cx, a| {
        Box::pin(async move {
            let (marked, duplicated) = ops::mark_model_part(cx.db, a.input()?).await?;
            Ok(json!([marked, duplicated]))
        })
    }),
    command("unmark_model_part").access(Access::Member(KIT)).run(|cx, a| {
        Box::pin(async move {
            reply(ops::unmark_model_part(cx.db, a.id(KIT)?, &a.req_str("boardName")?, a.req_i64("partNumber")?).await?)
        })
    }),
    // ----- Image links (project files only; ops refuses another project's file) -----
    command("link_model_kit_file").access(Access::Member(KIT)).run(|cx, a| {
        Box::pin(async move {
            reply(
                ops::link_model_kit_file(cx.db, a.id(KIT)?, a.req_i64("fileId")?, &a.req_str("kind")?, a.opt_str("caption").as_deref())
                    .await?,
            )
        })
    }),
    command("unlink_model_kit_file")
        .access(Access::Member(KIT_FILE))
        .run(|cx, a| Box::pin(async move { reply(ops::unlink_model_kit_file(cx.db, a.id(KIT_FILE)?).await?) })),
    // ----- Personal containers (Atlas Phase 2b) -----
    // A per-user hidden project hosting personal tab data (Models first): same tables, same
    // scoping, never listed. Always the caller's own: the user is the authorship field.
    command("ensure_personal_space").access(Access::AnyMember).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move { Ok(json!({ "projectId": ops::ensure_personal_project(cx.db, a.author()?).await? })) })
    }),
    // "Move my collection to Atlas": from a project the caller is a member of, always into
    // their own container.
    command("adopt_model_kits").access(Access::Member(PROJECT)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move {
            let personal = ops::ensure_personal_project(cx.db, a.author()?).await?;
            let moved = ops::adopt_model_kits(cx.db, a.id(PROJECT)?, personal).await?;
            Ok(json!({ "moved": moved, "projectId": personal }))
        })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    /// A kit in `project` with a board, a section and a part marked; returns (kit, board, section).
    async fn kit(db: &ganban_core::Db, project: i64) -> (i64, i64, i64) {
        let kit = seed(db, "create_model_kit", json!({ "input": { "project_id": project, "name": "RX-78", "kind": "gundam" } })).await;
        let kit = kit["id"].as_i64().unwrap();
        let board = seed(db, "create_model_board", json!({ "input": { "kit_id": kit, "name": "A", "max_parts": 10 } })).await;
        let section = seed(db, "create_model_section", json!({ "input": { "kit_id": kit, "name": "Head" } })).await;
        (kit, board["id"].as_i64().unwrap(), section["id"].as_i64().unwrap())
    }

    #[tokio::test]
    async fn kit_scoped_commands_need_membership_of_the_kits_project() {
        let db = test_db("models_rules").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let (ka, ba, sa) = kit(&db, a).await;
        let (kb, bb, sb) = kit(&db, b).await;
        let mia = member(&db, 7, &[(a, "member")]).await;

        let calls = |k: i64, board: i64, section: i64| {
            vec![
                ("get_model_kit_detail", json!({ "kitId": k })),
                ("update_model_board", json!({ "boardId": board, "input": { "name": "B2" } })),
                ("update_model_section", json!({ "sectionId": section, "input": { "name": "Torso" } })),
                ("mark_model_part", json!({ "input": { "kit_id": k, "board_name": "A", "part_number": 1, "section_id": section } })),
                ("create_model_board", json!({ "input": { "kit_id": k, "name": "C", "max_parts": 5 } })),
            ]
        };
        for (cmd, args) in calls(ka, ba, sa) {
            assert!(http(&db, mia, cmd, args).await.is_ok(), "{cmd} on her project's kit");
        }
        for (cmd, args) in calls(kb, bb, sb) {
            assert!(http(&db, mia, cmd, args).await.unwrap_err().is_not_found(), "{cmd} on another project's kit");
        }
        assert_eq!(ids(&http(&db, mia, "list_model_kits", json!({ "projectId": a })).await.unwrap()), vec![ka]);
        assert!(http(&db, mia, "list_model_kits", json!({ "projectId": b })).await.unwrap_err().is_not_found());
        assert!(http(&db, mia, "update_model_board", json!({ "boardId": 999, "input": {} })).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn a_member_adopts_kits_into_their_own_personal_space() {
        let db = test_db("models_personal").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        kit(&db, a).await;
        let mia = member(&db, 7, &[(a, "member")]).await;

        let space = http(&db, mia, "ensure_personal_space", json!({ "userId": 1 })).await.unwrap()["projectId"].as_i64().unwrap();
        assert_eq!(ganban_core::auth::member_role(&db, space, 7).await.unwrap().as_deref(), Some("admin"), "hers, not user 1's");

        let moved = http(&db, mia, "adopt_model_kits", json!({ "projectId": a })).await.unwrap();
        assert_eq!((moved["moved"].as_i64(), moved["projectId"].as_i64()), (Some(1), Some(space)));
        assert!(http(&db, mia, "adopt_model_kits", json!({ "projectId": b })).await.unwrap_err().is_not_found());
    }
}
