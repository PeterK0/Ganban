//! The one command table (ADR 0001).
//!
//! A **command** is a named operation a client asks the host to run, such as `create_task`
//! or `get_project_comment_board`. Every command is one entry in this table, grouped by
//! entity in the child modules. An entry declares:
//!
//! - its **access rule**: who may run it ([`Access`]);
//! - its **result filter**: what trims the result for a non-owner ([`ResultFilter`]);
//! - its authorship field: the argument that says who did it ([`Author`]);
//! - its handler, which reads its arguments from the JSON the client sent ([`Args`]).
//!
//! Two adapters run the table. The host's HTTP `/invoke` runs it for a signed-in
//! [`Caller::Http`]: access rules and result filters apply to everyone but the owner, and the
//! authorship field is overwritten with the signed-in user. The desktop app runs it
//! in-process as the owner ([`Caller::InProcess`]): no access rule or result filter applies,
//! and authorship is the profile id the app sends. The host's agent tools apply approved
//! writes in-process too (`crate::dispatch`).
//!
//! A command without an access rule is refused, and `every_command_declares_an_access_rule`
//! fails.
//!
//! Task visibility (ADR 0002) rides the same two mechanisms. A [`Target`] naming a task, or a
//! row that belongs to one, also checks that the caller is in the task's audience: outside
//! it, the row is "not found". [`ResultFilter::Tasks`] keeps only the tasks the caller can
//! see. Handlers that aggregate over a project's tasks ask [`Ctx::visible_tasks`].

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use ganban_core::auth;
use ganban_core::error::AppError;
use ganban_core::visibility::{self, Viewer};
use ganban_core::Db;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{AuthUser, Shares};

mod account;
mod admin;
mod comments;
mod contacts;
pub(crate) mod events;
mod files;
mod models;
mod pins;
mod projects;
mod proposals;
mod quiz;
mod share;
mod tasks;
mod users;
#[cfg(test)]
mod visibility_tests;

/// Every command, by entity group.
const TABLE: &[&[Command]] = &[
    projects::COMMANDS,
    tasks::COMMANDS,
    comments::COMMANDS,
    files::COMMANDS,
    share::COMMANDS,
    events::COMMANDS,
    contacts::COMMANDS,
    quiz::COMMANDS,
    models::COMMANDS,
    proposals::COMMANDS,
    users::COMMANDS,
    pins::COMMANDS,
    account::COMMANDS,
    admin::COMMANDS,
];

/// Bespoke desktop Tauri commands that never join the table: they work on the desktop's own
/// files. Asked for over HTTP they're refused by name, not as unknown.
const DESKTOP_ONLY: &[&str] = &["export_database", "import_database", "set_user_profile"];

/// A boxed future borrowing the command's context and arguments.
pub(crate) type Fut<'a, T> = Pin<Box<dyn Future<Output = Result<T, AppError>> + Send + 'a>>;

/// How a [`Target`] finds the project its row belongs to: `Some(project)`, or `None` for a
/// row that belongs to no project (only the owner may touch those). A missing row is an error.
pub(crate) type ProjectOf = for<'a> fn(&'a Db, i64) -> Fut<'a, Option<i64>>;

/// Whether a viewer may see the row a [`Target`] names (task visibility). A missing row is
/// not seen.
pub(crate) type Sees = for<'a> fn(&'a Db, Viewer, i64) -> Fut<'a, bool>;

/// A command's behaviour: runs after its access rule passed, before its result filter.
pub(crate) type Handler = for<'a> fn(&'a Ctx<'a>, &'a Args<'a>) -> Fut<'a, Value>;

/// An access rule that fits no other shape, checked for a signed-in non-owner.
pub(crate) type Check = for<'a> fn(&'a Ctx<'a>, &'a Args<'a>, &'a AuthUser) -> Fut<'a, ()>;

/// One entry of the table.
pub(crate) struct Command {
    name: &'static str,
    /// Who may run it. `None` refuses the command to everyone.
    access: Option<Access>,
    filter: ResultFilter,
    author: Option<Author>,
    run: Handler,
}

/// An entry being declared: `command("get_areas").access(Access::Member(PROJECT)).run(…)`.
pub(crate) struct Entry {
    name: &'static str,
    access: Option<Access>,
    filter: ResultFilter,
    author: Option<Author>,
}

/// Start declaring the command `name`.
pub(crate) const fn command(name: &'static str) -> Entry {
    Entry { name, access: None, filter: ResultFilter::None, author: None }
}

impl Entry {
    pub(crate) const fn access(mut self, rule: Access) -> Self {
        self.access = Some(rule);
        self
    }

    pub(crate) const fn filter(mut self, filter: ResultFilter) -> Self {
        self.filter = filter;
        self
    }

    pub(crate) const fn author(mut self, author: Author) -> Self {
        self.author = Some(author);
        self
    }

    pub(crate) const fn run(self, run: Handler) -> Command {
        Command { name: self.name, access: self.access, filter: self.filter, author: self.author, run }
    }
}

// ============== Access rules ==============

/// An access rule: who may run a command. The owner may run every command (the rule decides
/// for everyone else), and so may the in-process callers.
#[derive(Clone, Copy)]
pub(crate) enum Access {
    /// The workspace owner only.
    Owner,
    /// Any signed-in member. What they get back is trimmed by the command's result filter, or
    /// limited to their own rows by its authorship field.
    AnyMember,
    /// A member (or more) of the project the arguments point at.
    Member(Target),
    /// An admin (or the owner-member) of the project the arguments point at.
    Admin(Target),
    /// An admin of any project: the workspace's shared calendar and address book are
    /// managed by the owner and the workspace admins.
    AdminAnywhere,
    /// The user the named argument points at, themselves, or the owner: personal settings
    /// and PINs (the owner may reset a member's forgotten PIN).
    SelfOrOwner(&'static str),
    /// A rule that fits no other shape, spelled out where the command is declared.
    Custom(Check),
}

impl Access {
    async fn check(self, cx: &Ctx<'_>, user: &AuthUser, a: &Args<'_>) -> Result<(), AppError> {
        match self {
            Access::Owner => Err(AppError::Forbidden("owner only".into())),
            Access::AnyMember => Ok(()),
            Access::Member(target) => {
                role_on(cx.db, user, target.project(cx.db, a).await?, auth::ROLE_MEMBER).await?;
                target.seen(cx.db, user, a).await
            }
            Access::Admin(target) => {
                role_on(cx.db, user, target.project(cx.db, a).await?, auth::ROLE_ADMIN).await?;
                target.seen(cx.db, user, a).await
            }
            Access::AdminAnywhere => {
                if auth::is_admin_anywhere(cx.db, user.id).await? {
                    Ok(())
                } else {
                    Err(AppError::Forbidden("only the owner or a project admin can do that".into()))
                }
            }
            Access::SelfOrOwner(key) => {
                if a.req_i64(key)? == user.id {
                    Ok(())
                } else {
                    Err(AppError::Forbidden("only they or the owner can do that".into()))
                }
            }
            Access::Custom(check) => check(cx, a, user).await,
        }
    }
}

/// The row a command's arguments point at, and how to find the project it belongs to. Access
/// rules check the caller's role on that project; handlers read the same argument with
/// [`Args::id`], so the rule and the behaviour can't drift apart.
#[derive(Clone, Copy)]
pub(crate) struct Target {
    key: Key,
    /// The project the row belongs to.
    project: ProjectOf,
    /// For a task, or a row that belongs to one: whether the caller is in its audience.
    sees: Option<Sees>,
}

#[derive(Clone, Copy)]
enum Key {
    /// A top-level argument, such as `taskId`.
    Arg(&'static str),
    /// A field of the `input` object, such as `input.project_id` for a row being created.
    Input(&'static str),
    /// A top-level argument that may be left out, meaning "no project" (the owner's).
    Optional(&'static str),
}

impl Target {
    pub(crate) const fn arg(key: &'static str, project: ProjectOf) -> Self {
        Target { key: Key::Arg(key), project, sees: None }
    }

    pub(crate) const fn input(key: &'static str, project: ProjectOf) -> Self {
        Target { key: Key::Input(key), project, sees: None }
    }

    pub(crate) const fn optional(key: &'static str, project: ProjectOf) -> Self {
        Target { key: Key::Optional(key), project, sees: None }
    }

    /// Also require the caller to see the row (task visibility).
    pub(crate) const fn seen_by(mut self, sees: Sees) -> Self {
        self.sees = Some(sees);
        self
    }

    /// The visibility half of an access rule: outside the row's audience it's "not found",
    /// as another project's rows are.
    async fn seen(self, db: &Db, user: &AuthUser, a: &Args<'_>) -> Result<(), AppError> {
        let (Some(sees), Some(id)) = (self.sees, a.opt_id(self)) else { return Ok(()) };
        if sees(db, viewer_of(user), id).await? {
            Ok(())
        } else {
            Err(AppError::NotFound("not found".into()))
        }
    }

    async fn project(self, db: &Db, a: &Args<'_>) -> Result<Option<i64>, AppError> {
        match (self.key, a.opt_id(self)) {
            (Key::Optional(_), None) => Ok(None),
            _ => (self.project)(db, a.id(self)?).await,
        }
    }
}

/// The project named by `projectId`.
pub(crate) const PROJECT: Target = Target::arg("projectId", |_, id| Box::pin(async move { Ok(Some(id)) }));

/// The project a new row goes into, by `input.project_id`.
pub(crate) const INPUT_PROJECT: Target = Target::input("project_id", |_, id| Box::pin(async move { Ok(Some(id)) }));

/// The task named by `taskId`.
pub(crate) const TASK: Target = Target::arg("taskId", |db, id| Box::pin(task_project(db, id))).seen_by(SEES_TASK);

/// The task a new row hangs off, by `input.task_id`.
pub(crate) const INPUT_TASK: Target = Target::input("task_id", |db, id| Box::pin(task_project(db, id))).seen_by(SEES_TASK);

/// Whether a viewer can see a task.
pub(crate) const SEES_TASK: Sees = |db, v, id| Box::pin(visibility::can_see_task(db, v, id));

/// The viewer an HTTP caller is.
pub(crate) fn viewer_of(user: &AuthUser) -> Viewer {
    Viewer { user_id: user.id, is_owner: user.is_owner }
}

async fn task_project(db: &Db, task_id: i64) -> Result<Option<i64>, AppError> {
    Ok(Some(auth::task_project_id(db, task_id).await?.ok_or_else(|| AppError::NotFound(format!("task {task_id}")))?))
}

/// Whether `user` holds at least `min_role` on the project. The owner always does. A
/// non-member gets "not found", so a project's existence isn't revealed to someone outside it.
pub(crate) async fn require_role(db: &Db, user: &AuthUser, project_id: i64, min_role: &str) -> Result<(), AppError> {
    if user.is_owner {
        return Ok(());
    }
    match auth::member_role(db, project_id, user.id).await? {
        Some(r) if auth::role_rank(&r) >= auth::role_rank(min_role) => Ok(()),
        Some(_) => Err(AppError::Forbidden(format!("requires {min_role} on this project"))),
        None => Err(AppError::NotFound("not found".into())),
    }
}

/// [`require_role`] on a target's project; a row that belongs to no project is the owner's.
async fn role_on(db: &Db, user: &AuthUser, project: Option<i64>, min_role: &str) -> Result<(), AppError> {
    match project {
        Some(pid) => require_role(db, user, pid, min_role).await,
        None => Err(AppError::Forbidden("owner only".into())),
    }
}

// ============== Result filters ==============

/// A result filter: what trims a command's result so a non-owner sees only rows from
/// projects they belong to.
#[derive(Clone, Copy)]
pub(crate) enum ResultFilter {
    /// Nothing to trim: the access rule already confines the caller.
    None,
    /// A list of projects → the caller's projects.
    Projects,
    /// A list of tasks → those the caller can see.
    Tasks,
    /// A list of areas → those the caller can see (a restricted area is hidden from
    /// non-members).
    Areas,
    /// A list of rows about tasks, by the named field → those about a task the caller can
    /// see. Rows about no task stay (a notification that isn't about one).
    OfTasks(&'static str),
    /// The running timer, `[entry, task]` → null unless the task is in one of the caller's
    /// projects.
    ActiveTimer,
    /// A list of events → those linked to one of the caller's projects (an event linked to
    /// no project is the owner's).
    Events,
    /// One event → null unless linked to one of the caller's projects.
    Event,
    /// A list of event ids → the same events as [`ResultFilter::Events`].
    EventIds,
    /// A list of contacts → those linked to a task in one of the caller's projects (the
    /// address book is the owner's; members see the contacts of their own work).
    Contacts,
    /// A list of users → the caller and those who share a project with them (profiles
    /// carry PII).
    Users,
}

impl ResultFilter {
    async fn apply(self, db: &Db, user: &AuthUser, v: &mut Value) -> Result<(), AppError> {
        match self {
            ResultFilter::None => {}
            ResultFilter::Projects => retain_rows(v, "id", &my_projects(db, user).await?),
            ResultFilter::Tasks => {
                if let Some(seen) = visibility::visible_tasks(db, viewer_of(user), None).await? {
                    retain_rows(v, "id", &seen);
                }
            }
            ResultFilter::OfTasks(field) => {
                if let (Some(seen), Some(rows)) = (visibility::visible_tasks(db, viewer_of(user), None).await?, v.as_array_mut()) {
                    rows.retain(|r| r.get(field).and_then(Value::as_i64).is_none_or(|t| seen.contains(&t)));
                }
            }
            ResultFilter::Areas => {
                if let Some(seen) = visibility::visible_areas(db, viewer_of(user), None).await? {
                    retain_rows(v, "id", &seen);
                }
            }
            ResultFilter::Events => retain_rows(v, "id", &visible_events(db, user).await?),
            ResultFilter::Event => {
                let visible = visible_events(db, user).await?;
                if !v.get("id").and_then(Value::as_i64).is_some_and(|id| visible.contains(&id)) {
                    *v = Value::Null;
                }
            }
            ResultFilter::EventIds => {
                let visible = visible_events(db, user).await?;
                if let Some(ids) = v.as_array_mut() {
                    ids.retain(|id| id.as_i64().is_some_and(|id| visible.contains(&id)));
                }
            }
            ResultFilter::Contacts => retain_rows(v, "id", &visible_contacts(db, user).await?),
            ResultFilter::Users => retain_rows(v, "id", &covisible_users(db, user).await?),
            ResultFilter::ActiveTimer => {
                if let Some(task) = v.get(1).and_then(|task| task.get("id")).and_then(Value::as_i64) {
                    if !visibility::can_see_task(db, viewer_of(user), task).await? {
                        *v = Value::Null;
                    }
                }
            }
        }
        Ok(())
    }
}

async fn my_projects(db: &Db, user: &AuthUser) -> Result<HashSet<i64>, AppError> {
    Ok(auth::accessible_project_ids(db, user.id).await?.into_iter().collect())
}

async fn visible_events(db: &Db, user: &AuthUser) -> Result<HashSet<i64>, AppError> {
    Ok(auth::accessible_event_ids(db, user.id).await?.into_iter().collect())
}

/// The contacts of the caller's work: linked to a task they can see.
async fn visible_contacts(db: &Db, user: &AuthUser) -> Result<HashSet<i64>, AppError> {
    let mut contacts: HashSet<i64> = auth::accessible_contact_ids(db, user.id).await?.into_iter().collect();
    if let Some(seen) = visibility::visible_tasks(db, viewer_of(user), None).await? {
        let linked: Vec<(i64, i64)> = sqlx::query_as("SELECT contact_id, task_id FROM task_contacts").fetch_all(db).await?;
        let keep: HashSet<i64> = linked.into_iter().filter(|(_, t)| seen.contains(t)).map(|(c, _)| c).collect();
        contacts.retain(|c| keep.contains(c));
    }
    Ok(contacts)
}

/// The caller and everyone who shares a project with them.
async fn covisible_users(db: &Db, user: &AuthUser) -> Result<HashSet<i64>, AppError> {
    Ok(auth::covisible_user_ids(db, user.id).await?.into_iter().collect())
}

/// Keep the rows of a JSON array whose `field` is in `allowed`.
fn retain_rows(v: &mut Value, field: &str, allowed: &HashSet<i64>) {
    if let Some(rows) = v.as_array_mut() {
        rows.retain(|r| r.get(field).and_then(Value::as_i64).is_some_and(|id| allowed.contains(&id)));
    }
}

// ============== Authorship ==============

/// The argument that says who did it: a comment's author, a task's assigner, a project's
/// creator. Over HTTP the host overwrites it with the signed-in user, so a client can never
/// act as someone else; in-process it's the profile id the desktop app sends.
#[derive(Clone, Copy)]
pub(crate) enum Author {
    /// A top-level argument, such as `assignedBy`.
    Arg(&'static str),
    /// A field of the `input` object, such as a new comment's `input.user_id`.
    Input(&'static str),
}

impl Author {
    fn stamp(self, args: &mut Value, user_id: i64) {
        match self {
            Author::Arg(key) => args[key] = json!(user_id),
            Author::Input(key) => {
                if let Some(input) = args.get_mut("input").and_then(Value::as_object_mut) {
                    input.insert(key.into(), json!(user_id));
                }
            }
        }
    }
}

// ============== Running a command ==============

/// Who is running a command.
#[derive(Clone, Copy)]
pub(crate) enum Caller {
    /// In-process and trusted: the desktop app, which is the owner, and the host's agent
    /// tools applying an approved write. No access rule or result filter applies, and
    /// authorship is whatever the arguments carry.
    InProcess,
    /// A signed-in client of the host's HTTP `/invoke`.
    Http(AuthUser),
}

impl Caller {
    /// The signed-in non-owner that access rules and result filters apply to.
    fn non_owner(&self) -> Option<&AuthUser> {
        match self {
            Caller::Http(user) if !user.is_owner => Some(user),
            _ => None,
        }
    }

    /// Whether the caller is the owner (the desktop app in-process is).
    pub(crate) fn is_owner(&self) -> bool {
        match self {
            Caller::InProcess => true,
            Caller::Http(user) => user.is_owner,
        }
    }

    /// The device token behind an HTTP call.
    pub(crate) fn device_id(&self) -> Option<i64> {
        match self {
            Caller::InProcess => None,
            Caller::Http(user) => user.device_id,
        }
    }
}

/// What a handler runs against.
pub(crate) struct Ctx<'a> {
    pub(crate) db: &'a Db,
    pub(crate) caller: Caller,
    /// Where shared file bytes live. `crate::dispatch` runs without one: the agent tools
    /// never move file bytes.
    storage_root: Option<&'a Path>,
    /// The native builds offered at `/download`, where a host serves them.
    shares: Option<&'a Shares>,
    /// Where the client builds and the host update's status live; `None` reads them from
    /// the environment (`crate::updates::shared`).
    update_paths: Option<&'a crate::updates::UpdatePaths>,
}

impl<'a> Ctx<'a> {
    pub(crate) fn http(db: &'a Db, user: AuthUser) -> Self {
        Ctx { db, caller: Caller::Http(user), storage_root: None, shares: None, update_paths: None }
    }

    pub(crate) fn in_process(db: &'a Db) -> Self {
        Ctx { db, caller: Caller::InProcess, storage_root: None, shares: None, update_paths: None }
    }

    pub(crate) fn with_shares(self, shares: &'a Shares) -> Self {
        Ctx { shares: Some(shares), ..self }
    }

    /// The native builds offered at `/download`, for the build-sharing commands.
    pub(crate) fn shares(&self) -> Result<&'a Shares, AppError> {
        self.shares.ok_or_else(|| AppError::InvalidInput("no build sharing here".into()))
    }

    pub(crate) fn with_update_paths(self, paths: &'a crate::updates::UpdatePaths) -> Self {
        Ctx { update_paths: Some(paths), ..self }
    }

    /// Where the client builds and the host update's status live.
    pub(crate) fn update_paths(&self) -> std::sync::Arc<crate::updates::UpdatePaths> {
        match self.update_paths {
            Some(p) => std::sync::Arc::new(p.clone()),
            None => crate::updates::shared(),
        }
    }

    pub(crate) fn with_storage_root(self, root: &'a Path) -> Self {
        Ctx { storage_root: Some(root), ..self }
    }

    /// Where shared file bytes live, for commands that move them.
    pub(crate) fn storage_root(&self) -> Result<&'a Path, AppError> {
        self.storage_root.ok_or_else(|| AppError::InvalidInput("no shared-file storage here".into()))
    }

    /// The viewer task visibility applies to: a signed-in non-owner. `None` sees everything
    /// (the owner, the desktop app, the host's agents).
    pub(crate) fn viewer(&self) -> Option<Viewer> {
        self.caller.non_owner().map(viewer_of)
    }

    /// The tasks the caller can see in a project (or all projects); `None` means all of them.
    /// For handlers that aggregate over tasks: counts, the comment board, stats.
    pub(crate) async fn visible_tasks(&self, project: Option<i64>) -> Result<Option<HashSet<i64>>, AppError> {
        match self.viewer() {
            Some(v) => visibility::visible_tasks(self.db, v, project).await,
            None => Ok(None),
        }
    }

    /// Refuse task ids the caller can't see, as "not found" (a comment's extra tags).
    pub(crate) async fn require_visible(&self, tasks: &[i64]) -> Result<(), AppError> {
        if let Some(v) = self.viewer() {
            for &t in tasks {
                if !visibility::can_see_task(self.db, v, t).await? {
                    return Err(AppError::NotFound(format!("task {t}")));
                }
            }
        }
        Ok(())
    }
}

/// A command's arguments: the camelCase JSON object the client sent, as received by Tauri
/// `invoke` and `/invoke` alike.
pub(crate) struct Args<'a> {
    json: &'a Value,
    author: Option<Author>,
}

fn missing(key: &str) -> AppError {
    AppError::InvalidInput(format!("missing argument '{key}'"))
}

impl Args<'_> {
    /// The raw value of an argument.
    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.json.get(key)
    }

    pub(crate) fn req_i64(&self, key: &str) -> Result<i64, AppError> {
        self.opt_i64(key).ok_or_else(|| missing(key))
    }

    pub(crate) fn req_str(&self, key: &str) -> Result<String, AppError> {
        self.opt_str(key).ok_or_else(|| missing(key))
    }

    pub(crate) fn opt_str(&self, key: &str) -> Option<String> {
        self.json.get(key).and_then(Value::as_str).map(str::to_owned)
    }

    pub(crate) fn opt_i64(&self, key: &str) -> Option<i64> {
        self.json.get(key).and_then(Value::as_i64)
    }

    pub(crate) fn opt_bool(&self, key: &str) -> Option<bool> {
        self.json.get(key).and_then(Value::as_bool)
    }

    /// An array of ids (non-integers dropped); missing or not an array → empty.
    pub(crate) fn i64_list(&self, key: &str) -> Vec<i64> {
        self.json.get(key).and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
    }

    /// The `input` object, deserialized.
    pub(crate) fn input<T: DeserializeOwned>(&self) -> Result<T, AppError> {
        let v = self.json.get("input").ok_or_else(|| missing("input"))?;
        serde_json::from_value(v.clone()).map_err(|e| AppError::InvalidInput(format!("invalid 'input': {e}")))
    }

    /// The id the target's argument names.
    pub(crate) fn id(&self, target: Target) -> Result<i64, AppError> {
        match target.key {
            Key::Arg(key) | Key::Optional(key) => self.json.get(key).and_then(Value::as_i64).ok_or_else(|| missing(key)),
            Key::Input(key) => {
                self.json.get("input").and_then(|i| i.get(key)).and_then(Value::as_i64).ok_or_else(|| missing(key))
            }
        }
    }

    /// The id the target's argument names, if it's there.
    pub(crate) fn opt_id(&self, target: Target) -> Option<i64> {
        self.id(target).ok()
    }

    /// The authorship field (stamped over HTTP; sent by the app in-process).
    pub(crate) fn author(&self) -> Result<i64, AppError> {
        let key = match self.author {
            Some(Author::Arg(key) | Author::Input(key)) => key,
            None => return Err(AppError::InvalidInput("this command has no authorship field".into())),
        };
        self.opt_author().ok_or_else(|| missing(key))
    }

    /// The authorship field, if the command declares one and it's set.
    pub(crate) fn opt_author(&self) -> Option<i64> {
        match self.author? {
            Author::Arg(key) => self.opt_i64(key),
            Author::Input(key) => self.json.get("input")?.get(key)?.as_i64(),
        }
    }
}

/// Serialize a handler's result (unit → `null`).
pub(crate) fn reply<T: Serialize>(t: T) -> Result<Value, AppError> {
    Ok(serde_json::to_value(t)?)
}

/// The entry named `name`.
pub(crate) fn find(name: &str) -> Option<&'static Command> {
    TABLE.iter().flat_map(|group| group.iter()).find(|c| c.name == name)
}

/// Run the command `name` in-process for the desktop app, against its own database: as the
/// owner, so no access rule or result filter applies, with authorship as the app sent it.
pub async fn run_in_process(
    db: &Db,
    storage_root: &Path,
    shares: &Shares,
    name: &str,
    args: Value,
) -> Result<Value, AppError> {
    run(&Ctx::in_process(db).with_storage_root(storage_root).with_shares(shares), name, args).await
}

/// Run the command `name`: its access rule, its handler, then its result filter.
pub(crate) async fn run(cx: &Ctx<'_>, name: &str, args: Value) -> Result<Value, AppError> {
    let Some(command) = find(name) else {
        return Err(if DESKTOP_ONLY.contains(&name) {
            AppError::InvalidInput(format!("'{name}' is a desktop-only operation and is not available over HTTP"))
        } else {
            AppError::NotFound(format!("unknown command '{name}'"))
        });
    };
    execute(cx, command, args).await
}

async fn execute(cx: &Ctx<'_>, command: &Command, args: Value) -> Result<Value, AppError> {
    let access = command
        .access
        .ok_or_else(|| AppError::Forbidden(format!("'{}' declares no access rule", command.name)))?;
    let mut args = if args.is_object() { args } else { json!({}) };
    if let (Caller::Http(user), Some(author)) = (cx.caller, command.author) {
        author.stamp(&mut args, user.id);
    }
    let a = Args { json: &args, author: command.author };
    if let Some(user) = cx.caller.non_owner() {
        access.check(cx, user, &a).await?;
    }
    let mut v = (command.run)(cx, &a).await?;
    if let Some(user) = cx.caller.non_owner() {
        command.filter.apply(cx.db, user, &mut v).await?;
    }
    Ok(v)
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Temp databases and callers for tests that go through the table.
    use super::*;

    pub(crate) async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_commands_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    /// The owner over HTTP (the database's first user).
    pub(crate) async fn owner(db: &Db) -> AuthUser {
        let id = auth::ensure_owner(db).await.unwrap();
        AuthUser { id, is_owner: true, device_id: None }
    }

    /// A new user over HTTP with `role` on each of `projects`.
    pub(crate) async fn member(db: &Db, id: i64, projects: &[(i64, &str)]) -> AuthUser {
        sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
            .bind(id)
            .bind(format!("user{id}"))
            .bind(format!("User {id}"))
            .execute(db)
            .await
            .unwrap();
        for (pid, role) in projects {
            auth::add_project_member(db, *pid, id, role).await.unwrap();
        }
        AuthUser { id, is_owner: false, device_id: None }
    }

    /// Run a command over HTTP as `user`.
    pub(crate) async fn http(db: &Db, user: AuthUser, name: &str, args: Value) -> Result<Value, AppError> {
        run(&Ctx::http(db, user), name, args).await
    }

    /// Run a command in-process (setup steps), expecting success.
    pub(crate) async fn seed(db: &Db, name: &str, args: Value) -> Value {
        run(&Ctx::in_process(db), name, args).await.unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    /// The ids of a JSON array's rows.
    pub(crate) fn ids(v: &Value) -> Vec<i64> {
        v.as_array().unwrap().iter().filter_map(|r| r["id"].as_i64()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;

    #[test]
    fn every_command_declares_an_access_rule() {
        let open: Vec<&str> =
            TABLE.iter().flat_map(|g| g.iter()).filter(|c| c.access.is_none()).map(|c| c.name).collect();
        assert!(open.is_empty(), "commands without an access rule (refused to everyone): {open:?}");
    }

    #[test]
    fn command_names_are_unique() {
        let mut seen = HashSet::new();
        for c in TABLE.iter().flat_map(|g| g.iter()) {
            assert!(seen.insert(c.name), "'{}' is declared twice", c.name);
        }
    }

    #[tokio::test]
    async fn a_command_without_an_access_rule_is_refused_to_everyone() {
        let db = test_db("no_rule").await;
        let open = command("open_door").run(|_, _| Box::pin(async move { Ok(json!("opened")) }));
        let owner = owner(&db).await;
        for cx in [Ctx::http(&db, owner), Ctx::in_process(&db)] {
            let err = execute(&cx, &open, json!({})).await.unwrap_err();
            assert!(err.is_forbidden(), "{err}");
        }
    }

    /// The string literals passed as argument `nth` (0-based) of every call to `callee` in
    /// `src`, as in `callee("name", …)` or `callee<T>(ws, 'name', …)`. Calls whose argument
    /// isn't a literal (the helper's own definition, a variable) are skipped.
    fn literal_args(src: &str, callee: &str, nth: usize) -> Vec<String> {
        let mut found = Vec::new();
        let mut at = 0;
        while let Some(i) = src[at..].find(callee).map(|i| i + at) {
            at = i + callee.len();
            if src[..i].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue; // the tail of a longer identifier
            }
            let mut rest = &src[at..];
            if let Some(generic) = rest.strip_prefix('<') {
                let mut depth = 1;
                let end = generic.char_indices().find(|&(_, c)| {
                    depth += match c { '<' => 1, '>' => -1, _ => 0 };
                    depth == 0
                });
                let Some((end, _)) = end else { continue };
                rest = &generic[end + 1..];
            }
            let Some(mut rest) = rest.strip_prefix('(') else { continue };
            for _ in 0..nth {
                match rest.find(',') {
                    Some(comma) => rest = &rest[comma + 1..],
                    None => break,
                }
            }
            if let Some(literal) = leading_literal(rest) {
                found.push(literal);
            }
        }
        found
    }

    /// `"name"` or `'name'` at the start of `s` (after whitespace).
    fn leading_literal(s: &str) -> Option<String> {
        let s = s.trim_start();
        let quote = s.chars().next().filter(|q| *q == '"' || *q == '\'')?;
        let body = &s[1..];
        Some(body[..body.find(quote)?].to_string())
    }

    /// Every `command: "name"` in a JSON body sent to `/invoke`.
    fn command_fields(src: &str) -> Vec<String> {
        src.match_indices("command:").filter_map(|(i, _)| leading_literal(&src[i + "command:".len()..])).collect()
    }

    /// Every `.ts` / `.tsx` file under `dir`.
    fn sources(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(sources(&path));
            } else if path.extension().is_some_and(|e| e == "ts" || e == "tsx") {
                files.push(path);
            }
        }
        files
    }

    #[test]
    fn every_command_the_frontend_calls_is_in_the_table() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let lib = src.join("lib");
        let read = |file: &str| std::fs::read_to_string(lib.join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        let (api, workspace, host) = (read("api.ts"), read("workspaceData.ts"), read("host.ts"));

        let mut called = std::collections::BTreeSet::new();
        called.extend(literal_args(&api, "invokeWithLogging", 0));
        called.extend(command_fields(&api));
        called.extend(literal_args(&workspace, "call", 1));
        called.extend(command_fields(&host));
        called.extend(literal_args(&host, "ownerInvoke", 1)); // (local Tauri name, host command, …)
        called.extend(literal_args(&read("sync.ts"), "invokeLocal", 0));
        called.extend(literal_args(&read("devices.ts"), "inv", 0));
        called.extend(command_fields(&read("daemon.ts")));
        for file in sources(&src) {
            called.extend(literal_args(&std::fs::read_to_string(file).unwrap(), "daemonInvoke", 0));
        }
        assert!(called.len() > 100, "the scan found only {} names: has a call shape changed?", called.len());

        // api.ts calls its desktop-only Tauri commands by name; they are never in the table.
        let desktop_only = api.split("const DESKTOP_ONLY = new Set([").nth(1).and_then(|s| s.split("]);").next()).unwrap();
        let desktop_only: Vec<String> = desktop_only.split(',').filter_map(leading_literal).collect();
        let mut host_side: Vec<&str> = DESKTOP_ONLY.to_vec();
        let mut app_side: Vec<&str> = desktop_only.iter().map(String::as_str).collect();
        host_side.sort_unstable();
        app_side.sort_unstable();
        assert_eq!(host_side, app_side, "the host's DESKTOP_ONLY and api.ts's must name the same commands");
        for name in &desktop_only {
            assert!(find(name).is_none(), "'{name}' is both desktop-only and a table command");
        }

        let missing: Vec<&String> = called.iter().filter(|n| find(n).is_none() && !desktop_only.contains(n)).collect();
        assert!(missing.is_empty(), "the frontend calls commands the table doesn't have: {missing:?}");
    }

    #[tokio::test]
    async fn unknown_commands_say_so() {
        let db = test_db("unknown").await;
        let err = run(&Ctx::in_process(&db), "frobnicate", json!({})).await.unwrap_err();
        // The comment board's "update your host" hint matches this wording.
        assert_eq!(err.to_string(), "Not found: unknown command 'frobnicate'");
    }
}
