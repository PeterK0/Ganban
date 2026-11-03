use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub archived: bool,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Bytes a project may use for shared files (default 256 MB).
    #[serde(default)]
    pub storage_quota_bytes: i64,
    /// Default assistant personality for this project's chats (else NULL = the
    /// globally-active profile).
    #[serde(default)]
    pub model_profile_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Area {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Only its area members (and those who always see) see it and its tasks.
    #[serde(default)]
    pub restricted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub area_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub prefix: Option<String>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
    pub archived: bool,
    pub pinned: bool,
    pub deadline: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    /// Who may see it (crate::visibility): "area" (follows its area), "members"
    /// (selected members) or "admins".
    #[serde(default = "crate::visibility::default_visibility")]
    pub visibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TimeEntry {
    pub id: i64,
    pub task_id: i64,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub duration: Option<i64>,
    pub notes: Option<String>,
    /// Who logged this time (NULL for entries created before attribution existed).
    pub user_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// A member's tracked time on one task within a project (for the Members tab).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberTaskTime {
    pub task_id: i64,
    pub task_title: String,
    pub seconds: i64,
}

/// Per-member overview for a project: access (role), presence (last seen),
/// and tracked time broken down by task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMemberOverview {
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub total_seconds: i64,
    pub by_task: Vec<MemberTaskTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskInput {
    pub project_id: i64,
    pub area_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub prefix: Option<String>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
    pub deadline: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub prefix: Option<String>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
    pub area_id: Option<i64>,
    pub deadline: Option<DateTime<Utc>>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAreaInput {
    pub project_id: i64,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAreaInput {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FileAttachment {
    pub id: i64,
    pub task_id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_type: Option<String>,
    pub file_size: Option<i64>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub is_valid: bool,
    #[serde(default)]
    pub uploaded_by: Option<i64>,
    /// Whether a server-side copy exists (downloadable by the whole team).
    #[serde(default)]
    pub is_shared: bool,
    /// Bytes the server-side copy uses against the project's allocation.
    #[serde(default)]
    pub storage_size: i64,
    /// Where the file sits in an uploaded folder, file name included ("Photos/2026/a.jpg"),
    /// or null for a loose file. Kept from a folder upload and across assign/unassign.
    #[serde(default)]
    #[sqlx(default)]
    pub rel_path: Option<String>,
    /// Whether the AI overview (the project's knowledge base) may index this file. New
    /// files start out of it; the stored flag is 0 (out), 1 (in) or 2 (in, past the
    /// size guard on purpose).
    #[serde(default)]
    #[sqlx(default)]
    pub ai_included: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFileAttachmentInput {
    pub task_id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_type: Option<String>,
    pub file_size: Option<i64>,
    pub notes: Option<String>,
    /// Uploader. The daemon overrides this with the authenticated user.
    #[serde(default)]
    pub uploaded_by: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateFileAttachmentInput {
    pub file_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TasksByStatus {
    pub todo: i64,
    pub in_progress: i64,
    pub done: i64,
    pub blocked: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub total_tasks: i64,
    pub tasks_by_status: TasksByStatus,
    pub total_time_seconds: i64,
    pub total_files: i64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Comment {
    pub id: i64,
    pub task_id: i64,
    pub content: String,
    #[serde(default)]
    pub user_id: Option<i64>,
    /// The comment this one replies to (same task), or None for a top-level comment.
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// The AGENT (model profile) that authored this comment, when it arrived
    /// through an approved proposal. The human approver stays in `user_id`.
    #[serde(default)]
    pub profile_id: Option<i64>,
    /// Joined for display (get_task_comments) — the agent's face on the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub profile_avatar: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Every task this comment is tagged with: the home `task_id` first, then
    /// the extra tags (`comment_tasks`). Filled by the comment reads, never a
    /// column. Replies follow their thread and carry only the home task.
    #[serde(default)]
    #[sqlx(skip)]
    pub task_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommentInput {
    pub task_id: i64,
    pub content: String,
    /// Author. The daemon overrides this with the authenticated user.
    #[serde(default)]
    pub user_id: Option<i64>,
    /// Reply target (a comment on the same task), or None for top-level.
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// The agent (model profile) that authored the content, if any — stamped
    /// by the approval path from the proposal, never trusted from a client.
    #[serde(default)]
    pub profile_id: Option<i64>,
    /// Extra tasks to tag (same project as `task_id`; the home task and
    /// duplicates are ignored). Top-level comments only.
    #[serde(default)]
    pub task_ids: Vec<i64>,
}

/// The project comment board: top-level comments newest first (with their
/// replies), per-task counts for the task list, and the time tracked per task
/// since a client-chosen instant ("worked on today" — the client's midnight).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentBoard {
    pub comments: Vec<Comment>,
    /// Top-level comments tagged with each task (home or extra), whole project.
    pub task_counts: Vec<TaskCount>,
    /// More top-level comments exist beyond the requested limit.
    pub has_more: bool,
    pub time_since: Vec<TaskSeconds>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TaskCount {
    pub task_id: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TaskSeconds {
    pub task_id: i64,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCommentInput {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Event {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub event_date: DateTime<Utc>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub reminder_minutes: Option<i64>,
    pub notification_enabled: bool,
    pub archived: bool,
    /// Set when this event was imported from a calendar subscription (else NULL).
    pub calendar_id: Option<i64>,
    /// The source feed's VEVENT UID — used to upsert the event on re-sync.
    pub external_uid: Option<String>,
    /// RFC 5545 recurrence rule on this (master) event, e.g.
    /// "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;UNTIL=20260901". NULL = single event.
    /// Occurrences are expanded on read by the client; only this row is stored.
    #[serde(default)]
    #[sqlx(default)]
    pub rrule: Option<String>,
    /// When someone marked the event past by hand (NULL = not marked). It then counts as
    /// past wherever "upcoming" is worked out; for a recurring event, the whole series.
    #[serde(default)]
    #[sqlx(default)]
    pub done_at: Option<DateTime<Utc>>,
    /// A repeating event's skipped days: comma-separated local ISO dates
    /// ("2026-11-03,2026-11-10"). The client leaves them out when it expands the rule.
    #[serde(default)]
    #[sqlx(default)]
    pub exdates: Option<String>,
    /// On a one-off copy that replaced one day of a repeating event ("This event"),
    /// the series it came from. NULL on every other event.
    #[serde(default)]
    #[sqlx(default)]
    pub series_id: Option<i64>,
    /// How many files are attached to the event (`event_attachments`), counted on read.
    #[serde(default)]
    #[sqlx(default)]
    pub file_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A file attached to an event, stored on the host at `<storage>/ev/<id>`. Host-only.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EventAttachment {
    pub id: i64,
    pub event_id: i64,
    pub file_name: String,
    #[serde(default)]
    pub file_type: Option<String>,
    /// Where it sits in an uploaded folder, file name included ("Brief/maps/route.png").
    #[serde(default)]
    pub rel_path: Option<String>,
    pub size_bytes: i64,
    #[serde(default)]
    pub uploaded_by: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EventTask {
    pub id: i64,
    pub event_id: i64,
    pub task_id: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EventProject {
    pub id: i64,
    pub event_id: i64,
    pub project_id: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEventInput {
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub event_date: DateTime<Utc>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub reminder_minutes: Option<i64>,
    pub notification_enabled: bool,
    #[serde(default)]
    pub rrule: Option<String>,
    /// Skipped days of the series (see `Event::exdates`).
    #[serde(default)]
    pub exdates: Option<String>,
    /// The series a one-off copy of one day came from (see `Event::series_id`).
    #[serde(default)]
    pub series_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateEventInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub event_date: Option<DateTime<Utc>>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: Option<bool>,
    pub reminder_minutes: Option<i64>,
    pub notification_enabled: Option<bool>,
    /// Some(Some(rule)) sets it, Some(None) clears it, None leaves it unchanged.
    /// JSON: omitted leaves it, `null` clears it.
    #[serde(default, deserialize_with = "some_or_null")]
    pub rrule: Option<Option<String>>,
    /// The skipped days, as `rrule`: omitted leaves them, `null` (or "") clears them.
    #[serde(default, deserialize_with = "some_or_null")]
    pub exdates: Option<Option<String>>,
}

/// A present field, `null` included, is `Some`: plain serde reads `null` as an absent
/// `Option<Option<_>>`, so "clear it" never got through.
fn some_or_null<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// An owner-managed external calendar feed (ICS/webcal). Host-only.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CalendarSubscription {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub color: Option<String>,
    pub enabled: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_event_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCalendarSubscriptionInput {
    pub name: String,
    pub url: String,
    pub color: Option<String>,
}

/// One VEVENT parsed from an ICS feed, normalized onto the events table shape.
#[derive(Debug, Clone)]
pub struct ParsedIcsEvent {
    pub uid: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub event_date: DateTime<Utc>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    /// The VEVENT's RRULE line value, if recurring (e.g. "FREQ=WEEKLY;BYDAY=MO").
    pub rrule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Contact {
    pub id: i64,
    pub full_name: String,
    pub occupation: Option<String>,
    pub phone_numbers: Option<String>, // JSON array stored as string
    pub emails: Option<String>,        // JSON array stored as string
    pub birthday: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub archived: bool,
    /// Linked user account, if this contact is a collaborator (else NULL).
    pub user_id: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TaskContact {
    pub id: i64,
    pub task_id: i64,
    pub contact_id: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateContactInput {
    pub full_name: String,
    pub occupation: Option<String>,
    pub phone_numbers: Option<String>,
    pub emails: Option<String>,
    pub birthday: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateContactInput {
    pub full_name: Option<String>,
    pub occupation: Option<String>,
    pub phone_numbers: Option<String>,
    pub emails: Option<String>,
    pub birthday: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub email: Option<String>,
    pub is_active: bool,
    #[serde(default)]
    pub is_owner: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Frontend-owned profile blob: theme, avatar data-URL, vCard + flavor fields.
    #[serde(default)]
    pub profile_json: Option<String>,
    /// Whether a profile PIN is set (the hash itself never leaves the core).
    /// Populated by queries that SELECT `pin_hash IS NOT NULL AS has_pin`.
    #[serde(default)]
    #[sqlx(default)]
    pub has_pin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserSetting {
    pub id: i64,
    pub user_id: i64,
    pub setting_key: String,
    pub setting_value: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A tab pinned to a user's top bar (`tab_pins`). `sub_view` is the tab's own
/// mode when it exposes one (a game tab's `play` or `practice`, say).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TabPin {
    pub project_id: i64,
    pub tab_id: String,
    pub sub_view: Option<String>,
    pub position: f64,
}

/// One leaderboard row for a stash tab, joined with the player's name.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TabScore {
    pub user_id: i64,
    pub display_name: String,
    pub kind: String,
    pub score: f64,
    pub meta_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateUserInput {
    pub username: String,
    pub full_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateUserInput {
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub is_active: Option<bool>,
}

// ============== Auth / roles / scoping ==============

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DeviceToken {
    pub id: i64,
    pub user_id: i64,
    pub token_hash: String,
    pub device_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ProjectMember {
    pub id: i64,
    pub project_id: i64,
    pub user_id: i64,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EnrollmentToken {
    pub id: i64,
    pub token_hash: String,
    pub kind: String,
    pub target_user_id: Option<i64>,
    pub project_id: Option<i64>,
    pub role: Option<String>,
    pub display_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    /// The user that redeemed this token (set on enroll), so diagnostics can show
    /// who joined even when the token created a fresh account. Older rows: null.
    #[serde(default)]
    #[sqlx(default)]
    pub enrolled_user_id: Option<i64>,
}

// --------------------------------------------------------------------------- //
// AI assistant (host-only): per-project chat threads + messages.
// --------------------------------------------------------------------------- //
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Chat {
    pub id: i64,
    pub project_id: i64,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub profile_id: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    /// When set, every member of the project can read this thread (not just the
    /// author). Host-only, like the rest of the chat tables.
    #[serde(default)]
    pub is_public: bool,
    /// Not stored — computed per request: whether the authenticated caller
    /// authored this thread (so write/publish access never relies on the
    /// client's notion of identity). The server stamps it in list_chats_handler.
    #[sqlx(default)]
    #[serde(default)]
    pub is_mine: bool,
    /// In the bin since (NULL = live). Two-stage deletion: bin → restore/purge.
    #[sqlx(default)]
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
    /// Pinned to the top of its project's chat list.
    #[sqlx(default)]
    #[serde(default)]
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChatMessage {
    pub id: i64,
    pub chat_id: i64,
    /// "user" | "assistant" | "system"
    pub role: String,
    pub content: String,
    /// Cited sources for an assistant turn (JSON array), else null.
    #[serde(default)]
    pub sources_json: Option<String>,
    /// Read tools the agent invoked for this turn (JSON array of names), else null.
    #[serde(default)]
    #[sqlx(default)]
    pub tools_json: Option<String>,
    /// Capacity meter (assistant turns): the answering model + cost totals
    /// across the tool loop and the streamed answer. Null on user turns.
    #[serde(default)]
    #[sqlx(default)]
    pub model: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub prompt_tokens: Option<i64>,
    #[serde(default)]
    #[sqlx(default)]
    pub completion_tokens: Option<i64>,
    #[serde(default)]
    #[sqlx(default)]
    pub duration_ms: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// One row of the agent action ledger (`agent_actions`): a gated write the user
/// resolved (applied or rejected). Append-only; the activity view renders these.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AgentAction {
    pub id: i64,
    /// "applied" | "rejected"
    pub status: String,
    pub user_id: i64,
    /// The personality acting when it was proposed, if any.
    #[serde(default)]
    pub profile_id: Option<i64>,
    /// Null for cross-project work (e.g. a routine run like the daily rundown).
    #[serde(default)]
    pub project_id: Option<i64>,
    /// The conversation it was proposed in (null for non-chat origins).
    #[serde(default)]
    pub chat_id: Option<i64>,
    /// The routine that drove it (reserved; null for interactive chat).
    #[serde(default)]
    pub routine_id: Option<i64>,
    pub tool: String,
    pub summary: String,
    pub args_json: String,
    #[serde(default)]
    pub result_json: Option<String>,
    /// Capacity meter: model + cost where a model did the work (routine runs);
    /// null for interactive approvals of proposed writes.
    #[serde(default)]
    #[sqlx(default)]
    pub model: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub prompt_tokens: Option<i64>,
    #[serde(default)]
    #[sqlx(default)]
    pub completion_tokens: Option<i64>,
    #[serde(default)]
    #[sqlx(default)]
    pub duration_ms: Option<i64>,
    /// Protocol provenance (PROTOCOLS.md §2): slug + version + content hash of
    /// the protocol version that produced this run. Null for interactive
    /// approvals and legacy-routed runs.
    #[serde(default)]
    #[sqlx(default)]
    pub protocol_slug: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub protocol_version: Option<i64>,
    #[serde(default)]
    #[sqlx(default)]
    pub content_hash: Option<String>,
    /// The calling turn's ledger row — delegations form a tree (DELEGATE.md §3).
    #[serde(default)]
    #[sqlx(default)]
    pub parent_action_id: Option<i64>,
    /// Who resolved it — may differ from user_id (the proposer) under an
    /// 'owner' approval policy. Both identities on the row, always.
    #[serde(default)]
    #[sqlx(default)]
    pub approver_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// A shared Atlas knowledge collection (Epoch I): a ragrat corpus no project
/// owns, registered by the owner and readable by every member. The ragrat
/// collection name is "atlas-<slug>".
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AtlasCollection {
    pub id: i64,
    pub slug: String,
    pub name: String,
    /// The folder its documents ingest from (host-local path).
    pub source_dir: String,
    /// Owner-private: hidden from members in the registry + read handlers. The
    /// project Atlas lens is how curated slices of private knowledge reach members.
    #[serde(default)]
    pub owner_only: bool,
    /// Index automatically after changes (with a quiet-period debounce).
    /// DEFAULT OFF: a bulk dump into the Library must never start an ingest
    /// storm — the owner presses “Index now” when the folder is ready.
    #[serde(default)]
    pub auto_index: bool,
    /// When the folder last changed after the last ingest (None = clean).
    #[serde(default)]
    pub dirty_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_ingest_at: Option<DateTime<Utc>>,
}

/// An IMAP account the owner connected (Ganban is a mail CLIENT — no SMTP).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EmailAccount {
    pub id: i64,
    /// The user this mailbox belongs to (members connect their own; legacy
    /// rows backfilled to the owner).
    #[serde(default)]
    #[sqlx(default)]
    pub user_id: Option<i64>,
    pub label: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    /// "password" (app password / basic IMAP) | "oauth" (XOAUTH2).
    #[serde(default)]
    #[sqlx(default)]
    pub auth_type: String,
    /// App password / IMAP password. Stored like the ragrat token (host-local
    /// DB); never serialized out.
    #[serde(skip_serializing)]
    pub password: String,
    /// OAuth: the owner's own Google client id (safe to show — it's not secret).
    #[serde(default)]
    #[sqlx(default)]
    pub oauth_client_id: Option<String>,
    /// OAuth: the client "secret" (Desktop-type; not truly confidential) — held
    /// host-side, never serialized out.
    #[serde(skip_serializing)]
    #[sqlx(default)]
    pub oauth_client_secret: Option<String>,
    /// OAuth: the long-lived refresh token. Host-side only, never serialized.
    #[serde(skip_serializing)]
    #[sqlx(default)]
    pub oauth_refresh_token: Option<String>,
    /// Comma-separated folders to sync envelopes from.
    pub folders: String,
    /// Where approved drafts are APPENDed ("" = auto-detect at sync).
    pub drafts_folder: String,
    /// Envelope sync horizon in days.
    pub horizon_days: i64,
    pub enabled: bool,
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_result: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A conversation in a synced mailbox. `project_id` set = the owner linked it
/// to a project (publishing it to that project's members + RAG corpus).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EmailThread {
    pub id: i64,
    pub account_id: i64,
    /// Not stored — stamped per request: does this thread come from one of the
    /// CALLER's mailboxes (so the UI knows to offer unlink/draft affordances)?
    #[sqlx(default)]
    #[serde(default)]
    pub is_mine: bool,
    pub thread_key: String,
    pub subject: String,
    #[serde(default)]
    pub last_date: Option<DateTime<Utc>>,
    pub message_count: i64,
    #[serde(default)]
    pub project_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// One message's envelope (+ body text once its thread is linked).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EmailMessage {
    pub id: i64,
    pub account_id: i64,
    pub thread_id: i64,
    pub folder: String,
    pub uid: i64,
    pub uid_validity: i64,
    pub message_id: String,
    pub subject: String,
    pub from_addr: String,
    #[serde(default)]
    pub date: Option<DateTime<Utc>>,
    /// Extracted text body — present only after the thread was linked.
    #[serde(default)]
    pub body_text: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A folder-sync mapping: import files from a local folder (usually one a
/// cloud provider's desktop client keeps mirrored) into a project's files.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SyncFolder {
    pub id: i64,
    pub project_id: i64,
    /// Absolute path of the watched local folder.
    pub path: String,
    /// Comma-separated extension allowlist (lowercase, no dots); empty = all.
    pub include_ext: String,
    /// Per-file size ceiling in bytes; 0 = unlimited.
    pub max_bytes: i64,
    pub enabled: bool,
    #[serde(default)]
    pub last_scan_at: Option<DateTime<Utc>>,
    /// Human summary of the last scan ("3 added, 1 updated…").
    #[serde(default)]
    pub last_result: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A routine: a named, versioned record of scheduled agent work. The record is
/// the spec (prompt/toolset/trigger/output as data); the runner dispatches on
/// `kind`. Triggers are catch-up-on-launch shaped because the app starts/stops.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Routine {
    pub id: i64,
    pub name: String,
    /// Runner dispatch key (e.g. "rundown").
    pub kind: String,
    pub version: i64,
    pub enabled: bool,
    /// Null = the kind's built-in prompt.
    #[serde(default)]
    pub prompt_template: Option<String>,
    /// JSON array of registry tool names this routine may use.
    pub toolset_json: String,
    /// e.g. {"on_launch_after_hours": 12} — absent key = manual-only.
    pub trigger_json: String,
    /// Where the result lands, e.g. {"type":"secretary_rundown"}.
    pub output_target_json: String,
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// An AI model profile / personality: a model + system prompt + generation
/// params. Multiple may exist; one is active (app_settings 'ai_active_profile_id').
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelProfile {
    pub id: i64,
    pub name: String,
    pub model: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<i64>,
    /// Optional free-form purpose tag (e.g. "coding", "writing") for future
    /// per-task routing. Unused by the engine today.
    #[serde(default)]
    pub role: Option<String>,
    /// Epoch H: a remote Ollama base URL this profile runs against (e.g. the
    /// 4090 box's tailscale address). NULL = the host's supervised local engine.
    #[serde(default)]
    #[sqlx(default)]
    pub endpoint: Option<String>,
    /// What the assistant says when the remote engine is unreachable (a
    /// sleeping gaming PC is an expected state, not an error).
    #[serde(default)]
    #[sqlx(default)]
    pub fallback_note: Option<String>,
    /// A custom profile picture, stored inline as a data-URL.
    #[serde(default)]
    pub avatar: Option<String>,
    /// Cached model capabilities (context window, family, params, tools) as JSON,
    /// snapshotted from Ollama /api/show — for the profile's "vCard".
    #[serde(default)]
    pub model_meta: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A project-level file (a project "drop zone" file), stored on the host.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ProjectFile {
    pub id: i64,
    pub project_id: i64,
    pub file_name: String,
    #[serde(default)]
    pub file_type: Option<String>,
    /// Relative path within an uploaded folder (e.g. "specs/roof.pdf"), else null.
    #[serde(default)]
    pub rel_path: Option<String>,
    pub size_bytes: i64,
    #[serde(default)]
    pub uploaded_by: Option<i64>,
    pub created_at: DateTime<Utc>,
    /// Whether the AI overview (the project's knowledge base) may index this file. New
    /// files start out of it; the stored flag is 0 (out), 1 (in) or 2 (in, past the
    /// size guard on purpose).
    #[serde(default)]
    #[sqlx(default)]
    pub ai_included: bool,
}

/// Per-comment, per-emoji reaction tally. `mine` is 1 when the requesting user
/// has reacted with this emoji (computed server-side, so the client never has to
/// guess its own identity).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReactionSummary {
    pub comment_id: i64,
    pub emoji: String,
    pub count: i64,
    pub mine: i64,
}

/// A per-user notification (e.g. an @mention). Host-served; the bell fetches the
/// caller's own and can mark them read.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Notification {
    pub id: i64,
    pub user_id: i64,
    pub category: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub link_task_id: Option<i64>,
    pub read: bool,
    pub created_at: DateTime<Utc>,
}

/// An in-app ticket — a bug report or feature request filed by a user. Host-served.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Ticket {
    pub id: i64,
    pub user_id: i64,
    /// "bug" or "feature".
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// "open" or "closed".
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Resolved in the list query (full_name of the submitter); absent on create.
    #[serde(default)]
    #[sqlx(default)]
    pub submitter_name: Option<String>,
}

/// A custom emoji: a named small image, referenced in comments/reactions as
/// `:name:`. Host-served; `image` is a resized data-URL.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CustomEmoji {
    pub id: i64,
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub user_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// A shared (host-stored) task attachment, surfaced in a project's central file
/// view. Carries the owning task's title so the UI can group by task.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ProjectAttachment {
    pub id: i64,
    pub task_id: i64,
    pub task_title: String,
    pub file_name: String,
    #[serde(default)]
    pub file_type: Option<String>,
    pub storage_size: i64,
    /// False = legacy local-path attachment (no host copy; lives on the
    /// uploader's machine only).
    #[serde(default)]
    #[sqlx(default)]
    pub is_shared: bool,
    /// The original local path (meaningful only on the machine that attached
    /// it) — lets that machine's client read + push the bytes to the host.
    #[serde(default)]
    #[sqlx(default)]
    pub file_path: String,
    pub created_at: DateTime<Utc>,
    /// Whether the AI overview may index it (see [`FileAttachment::ai_included`]).
    #[serde(default)]
    #[sqlx(default)]
    pub ai_included: bool,
    /// Where it sits among the task's folders, file name included (see
    /// [`FileAttachment::rel_path`]).
    #[serde(default)]
    #[sqlx(default)]
    pub rel_path: Option<String>,
    /// Who attached it.
    #[serde(default)]
    #[sqlx(default)]
    pub uploaded_by: Option<i64>,
}

// ============== Automations — rules engine (Epoch M(a)) ==============

/// One automation rule (the `rules` table). `trigger_json` / `action_json` are
/// small editable specs the engine parses; timestamps are kept as strings (the
/// UI only displays them).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Rule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub trigger_json: String,
    pub action_json: String,
    #[serde(default)]
    #[sqlx(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_fired_at: Option<String>,
    #[serde(default)]
    pub fire_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRule {
    pub name: String,
    pub trigger_json: String,
    pub action_json: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A declarative ("registry") agent tool: defined as DATA, not compiled Rust,
/// and bound to a SAFE primitive (`binding_kind` — v1: an allowlisted read
/// `ops` command). Assembled into chat next to the built-in tools and run
/// through the same gate; it can only ever do what its binding already allows.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RegistryTool {
    pub id: i64,
    pub name: String,
    pub description: String,
    /// JSON-schema for the call arguments the model supplies.
    pub params_json: String,
    /// "read" | "write" (v1 supports read only).
    pub class: String,
    /// Binding discriminator ("ops" in v1; "mcp"/"rag"/"http" later).
    pub binding_kind: String,
    /// Binding spec, shape per kind (ops: {"command": "...", "args": {...}}).
    pub binding_json: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A loadout: a named bundle assigned to a personality (`model_profiles` row) —
/// a set of tools (`loadout_tools`), an optional system-prompt fragment, and an
/// optional routed sub-model (`routing_profile_id`) for that loadout's tool
/// work. The unit of COMPOSITION (vs. a tool, the unit of execution).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Loadout {
    pub id: i64,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub prompt_fragment: Option<String>,
    /// A model_profiles id whose model runs this loadout's tool loop. NULL =
    /// fall back to the global tool tier.
    #[serde(default)]
    pub routing_profile_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewLoadout {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub prompt_fragment: Option<String>,
    #[serde(default)]
    pub routing_profile_id: Option<i64>,
    /// Tool names this loadout grants (built-in or registry).
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateLoadout {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Present = set (incl. clearing to null via JSON null handled at the op).
    #[serde(default)]
    pub prompt_fragment: Option<String>,
    #[serde(default)]
    pub routing_profile_id: Option<i64>,
    /// Present = replace the loadout's tool set.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRegistryTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub params_json: Option<String>,
    #[serde(default)]
    pub class: Option<String>,
    pub binding_kind: String,
    pub binding_json: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateRule {
    pub name: Option<String>,
    pub trigger_json: Option<String>,
    pub action_json: Option<String>,
    pub enabled: Option<bool>,
}

fn default_true() -> bool {
    true
}

// --------------------------------------------------------------------------- //
// Model Assembly domain (Gundam kits + Warhammer 40K / Age of Sigmar armies).
// A kit/army is a collection of boards (runners/sprues), each carrying parts
// numbered 1..max_parts; build sections ("Chest Unit", steps 02-1..02-5)
// consume parts as you build. Images — model photos, manual scans, paint
// charts — are project_files linked to a kit with a category, so the existing
// upload/serve/thumbnail infrastructure is reused verbatim.
// --------------------------------------------------------------------------- //

/// The model families this domain tracks. Gundam kits use grade/scale;
/// Warhammer armies use faction/points. The string is stored as-is so future
/// families (Gunpla variants, model cars…) need no migration.
pub static MODEL_KINDS: &[&str] = &["gundam", "40k", "aos", "other"];

/// Build status for a kit/army — a richer lifecycle than the original TUI's
/// derived-only progress. Order matters: it's the left-to-right shelf order.
pub static MODEL_STATUSES: &[&str] =
    &["Backlog", "In Progress", "Assembled", "Painted", "Display", "Shelved"];

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelKit {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    /// "gundam" | "40k" | "aos" | "other".
    pub kind: String,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub scale: Option<String>,
    #[serde(default)]
    pub faction: Option<String>,
    #[serde(default)]
    pub points: Option<i64>,
    pub status: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    /// Vertical focal point of the cover crop, 0 (top) .. 100 (bottom).
    #[serde(default = "default_cover_focus")]
    #[sqlx(default)]
    pub cover_focus: i64,
    /// Companion task for time tracking ("set kit active" targets it).
    #[serde(default)]
    #[sqlx(default)]
    pub task_id: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_cover_focus() -> i64 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelBoard {
    pub id: i64,
    pub kit_id: i64,
    pub name: String,
    pub max_parts: i64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelPart {
    pub id: i64,
    pub board_id: i64,
    pub number: i64,
    pub is_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelSection {
    pub id: i64,
    pub kit_id: i64,
    pub name: String,
    #[serde(default)]
    pub start_step: Option<String>,
    #[serde(default)]
    pub end_step: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelUsedPart {
    pub id: i64,
    pub part_id: i64,
    pub section_id: i64,
    pub used_at: DateTime<Utc>,
}

/// A project_file linked to a kit under a category (photo / manual / paint).
/// The file bytes live in project_files; this row is just the typed link.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelKitFile {
    pub id: i64,
    pub kit_id: i64,
    pub file_id: i64,
    /// "photo" | "manual" | "paint".
    pub kind: String,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateModelKitInput {
    pub project_id: i64,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub scale: Option<String>,
    #[serde(default)]
    pub faction: Option<String>,
    #[serde(default)]
    pub points: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateModelKitInput {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub grade: Option<String>,
    pub scale: Option<String>,
    pub faction: Option<String>,
    pub points: Option<i64>,
    pub status: Option<String>,
    pub notes: Option<String>,
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub cover_focus: Option<i64>,
    #[serde(default)]
    pub task_id: Option<i64>,
}

/// Add a board (runner) and pre-create its parts 1..max_parts.
/// `duplicates` maps part-number → extra copies (a runner with two of #7 and
/// three of #15 is `{7: 2, 15: 3}`). Mirrors the TUI's add_board_with_parts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateModelBoardInput {
    pub kit_id: i64,
    pub name: String,
    pub max_parts: i64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub duplicates: Option<std::collections::BTreeMap<i64, i64>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateModelBoardInput {
    pub name: Option<String>,
    pub max_parts: Option<i64>,
    pub color: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateModelSectionInput {
    pub kit_id: i64,
    pub name: String,
    #[serde(default)]
    pub start_step: Option<String>,
    #[serde(default)]
    pub end_step: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateModelSectionInput {
    pub name: Option<String>,
    pub start_step: Option<String>,
    pub end_step: Option<String>,
    pub sort_order: Option<i64>,
}

/// Mark a part used in a section. `board_name` + `part_number` identify the
/// part (mirroring how manuals reference parts); `section_id` is the consumer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkModelPartInput {
    pub kit_id: i64,
    pub board_name: String,
    pub part_number: i64,
    pub section_id: i64,
}

/// One kit's full, nested shape for the detail view (boards with their parts,
/// sections with the part-numbers they consumed, the image links, and roll-up
/// progress). One round trip, no N+1 on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelKitDetail {
    pub kit: ModelKit,
    pub boards: Vec<ModelBoard>,
    /// parts grouped by board_id, each list sorted by number.
    pub parts_by_board: std::collections::BTreeMap<i64, Vec<ModelPart>>,
    pub sections: Vec<ModelSection>,
    /// section_id → (board_id → sorted part numbers used) — the manual's view.
    pub used_by_section: std::collections::BTreeMap<i64, std::collections::BTreeMap<i64, Vec<i64>>>,
    pub files: Vec<ModelKitFile>,
    pub total_parts: i64,
    pub used_parts: i64,
    pub percent: f64,
}

/// A chronological build-log entry (newest-first) — the UsedPart audit trail.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelBuildLogEntry {
    pub id: i64,
    pub used_at: DateTime<Utc>,
    pub section_id: i64,
    pub section_name: String,
    pub board_id: i64,
    pub board_name: String,
    pub part_number: i64,
}
