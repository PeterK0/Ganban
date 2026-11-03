//! Proposals a member's own machine submits (MEMBER_AGENTS §2 step 3).

use ganban_core::error::AppError;
use ganban_core::proposals;
use serde_json::json;

use super::{command, Access, Author, Command, PROJECT};

pub(super) const COMMANDS: &[Command] = &[
    // The member-agent return path: a member's client submits their LOCAL agent's output as
    // a durable proposal on the host. Same validator (prepare_write), same gate, same ledger
    // as a host chat turn; "via agent" marks it for attribution. Nothing executes here, and
    // the host's model columns stay empty. The proposer is the authorship field.
    command("submit_proposal").access(Access::Member(PROJECT)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move {
            let (proposer, project) = (a.author()?, a.id(PROJECT)?);
            let tool = a.req_str("tool")?;
            let tool_args = a.get("args").cloned().unwrap_or_else(|| json!({}));
            let via_agent = a.opt_bool("viaAgent").unwrap_or(false);
            let pw = crate::tools::prepare_write(cx.db, proposer, project, &tool, &tool_args)
                .await
                .map_err(AppError::InvalidInput)?;
            let id = proposals::register(
                cx.db,
                project,
                proposer,
                None,
                0, // no host conversation behind it (0 → NULL on the ledger)
                pw.command,
                &pw.args,
                &pw.summary,
                &pw.details,
                via_agent.then_some("agent"),
            )
            .await?;
            Ok(json!({ "id": id, "tool": pw.command, "summary": pw.summary, "details": pw.details }))
        })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    #[tokio::test]
    async fn a_member_proposes_in_their_own_name_on_their_own_projects() {
        let db = test_db("proposals_submit").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;

        let draft = |pid: i64| json!({ "projectId": pid, "tool": "create_task", "args": { "title": "Draft" }, "viaAgent": true, "userId": 1 });
        let p = http(&db, mia, "submit_proposal", draft(a)).await.unwrap();
        let mine = ganban_core::proposals::list_for_user(&db, 7, false).await.unwrap();
        assert_eq!(mine.len(), 1, "the proposal is Mia's, whatever userId the client sent");
        assert_eq!((mine[0].id, mine[0].origin.as_deref()), (p["id"].as_i64().unwrap(), Some("agent")));
        assert!(http(&db, mia, "submit_proposal", draft(b)).await.unwrap_err().is_not_found());
    }
}
