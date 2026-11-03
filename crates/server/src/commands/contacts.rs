//! The address book: workspace-wide contacts that tasks link to. The owner and the
//! workspace admins manage it; a member sees the contacts linked to tasks in their projects.

use ganban_core::error::AppError;
use ganban_core::{auth, ops};

use super::{command, reply, Access, Command, ResultFilter, TASK};

/// The contact a command is about.
const CONTACT: &str = "contactId";

pub(super) const COMMANDS: &[Command] = &[
    command("get_contacts")
        .access(Access::AnyMember)
        .filter(ResultFilter::Contacts)
        .run(|cx, a| Box::pin(async move { reply(ops::get_contacts(cx.db, a.opt_bool("archived")).await?) })),
    // A single contact carries PII: a member may read one only if it's linked to a task in
    // one of their projects. One they can't see and one that doesn't exist look the same.
    command("get_contact")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                if auth::accessible_contact_ids(cx.db, user.id).await?.contains(&a.req_i64(CONTACT)?) {
                    Ok(())
                } else {
                    Err(AppError::NotFound("contact".into()))
                }
            })
        }))
        .run(|cx, a| Box::pin(async move { reply(ops::get_contact(cx.db, a.req_i64(CONTACT)?).await?) })),
    command("create_contact")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::create_contact(cx.db, a.input()?).await?) })),
    command("update_contact").access(Access::AdminAnywhere).run(|cx, a| {
        Box::pin(async move { reply(ops::update_contact(cx.db, a.req_i64(CONTACT)?, a.input()?).await?) })
    }),
    command("delete_contact")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::delete_contact(cx.db, a.req_i64(CONTACT)?).await?) })),
    command("restore_contact")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::restore_contact(cx.db, a.req_i64(CONTACT)?).await?) })),
    command("permanently_delete_contact")
        .access(Access::AdminAnywhere)
        .run(|cx, a| Box::pin(async move { reply(ops::permanently_delete_contact(cx.db, a.req_i64(CONTACT)?).await?) })),
    // ----- Links to tasks -----
    command("link_contact_to_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::link_contact_to_task(cx.db, a.id(TASK)?, a.req_i64(CONTACT)?).await?) })
    }),
    command("unlink_contact_from_task").access(Access::Member(TASK)).run(|cx, a| {
        Box::pin(async move { reply(ops::unlink_contact_from_task(cx.db, a.id(TASK)?, a.req_i64(CONTACT)?).await?) })
    }),
    command("get_task_contacts")
        .access(Access::Member(TASK))
        .run(|cx, a| Box::pin(async move { reply(ops::get_task_contacts(cx.db, a.id(TASK)?).await?) })),
    command("get_contact_tasks")
        .access(Access::AnyMember)
        .filter(ResultFilter::Tasks)
        .run(|cx, a| Box::pin(async move { reply(ops::get_contact_tasks(cx.db, a.req_i64(CONTACT)?).await?) })),
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::testkit::*;

    #[tokio::test]
    async fn members_see_only_the_contacts_of_their_work() {
        let db = test_db("contacts_filter").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let b = seed(&db, "create_project", json!({ "input": { "name": "B" } })).await["id"].as_i64().unwrap();
        let task = |pid: i64| json!({ "input": { "project_id": pid, "title": "t", "status": "To Do", "priority": "Low" } });
        let ta = seed(&db, "create_task", task(a)).await["id"].as_i64().unwrap();
        let tb = seed(&db, "create_task", task(b)).await["id"].as_i64().unwrap();
        let contact = |name: &str| json!({ "input": { "full_name": name } });
        let ca = seed(&db, "create_contact", contact("Ann")).await["id"].as_i64().unwrap();
        let cb = seed(&db, "create_contact", contact("Ben")).await["id"].as_i64().unwrap();
        seed(&db, "link_contact_to_task", json!({ "taskId": ta, "contactId": ca })).await;
        seed(&db, "link_contact_to_task", json!({ "taskId": tb, "contactId": cb })).await;
        let mia = member(&db, 7, &[(a, "member")]).await;

        assert_eq!(ids(&http(&db, mia, "get_contacts", json!({})).await.unwrap()), vec![ca]);
        assert_eq!(http(&db, mia, "get_contact", json!({ "contactId": ca })).await.unwrap()["id"], ca);
        let hidden = http(&db, mia, "get_contact", json!({ "contactId": cb })).await.unwrap_err();
        let absent = http(&db, mia, "get_contact", json!({ "contactId": 999 })).await.unwrap_err();
        assert!(hidden.is_not_found(), "{hidden}");
        assert_eq!(hidden.to_string(), absent.to_string(), "a hidden contact and a missing one look the same");
        assert_eq!(ids(&http(&db, mia, "get_contact_tasks", json!({ "contactId": cb })).await.unwrap()), Vec::<i64>::new());
        assert!(http(&db, mia, "get_task_contacts", json!({ "taskId": tb })).await.unwrap_err().is_not_found());
        let link_b = json!({ "taskId": tb, "contactId": ca });
        assert!(http(&db, mia, "link_contact_to_task", link_b).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn the_owner_and_workspace_admins_manage_contacts() {
        let db = test_db("contacts_manage").await;
        owner(&db).await;
        let a = seed(&db, "create_project", json!({ "input": { "name": "A" } })).await["id"].as_i64().unwrap();
        let mia = member(&db, 7, &[(a, "member")]).await;
        let ana = member(&db, 8, &[(a, "admin")]).await;
        let new = json!({ "input": { "full_name": "Cat" } });
        assert!(http(&db, mia, "create_contact", new.clone()).await.unwrap_err().is_forbidden());
        let c = http(&db, ana, "create_contact", new).await.unwrap()["id"].as_i64().unwrap();
        assert!(http(&db, mia, "update_contact", json!({ "contactId": c, "input": { "full_name": "Kat" } })).await.unwrap_err().is_forbidden());
        assert!(http(&db, ana, "delete_contact", json!({ "contactId": c })).await.is_ok());
    }
}
