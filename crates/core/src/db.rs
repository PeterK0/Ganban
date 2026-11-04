use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};
use sqlx::ConnectOptions;
use std::path::Path;
use std::str::FromStr;

use crate::error::Result;

/// How long a statement waits for another connection's write lock before it fails
/// with "database is locked". Writes are kept short (a large import commits in
/// batches), so this only ever covers a queue of short transactions.
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Shared database handle. A thin alias over the sqlx SQLite pool so callers can
/// store/pass `core::Db` without depending on sqlx directly.
pub type Db = SqlitePool;

/// How this process relates to the canonical data.
///
/// - `Server`: this DB *is* the authoritative copy (the always-on host running
///   the `ganban-server` binary, or any in-process daemon). It is never
///   dirty-tracked — it has no changes to push anywhere.
/// - `Replica`: a local working copy (the desktop app) that reconciles with a
///   remote host via the sync engine. It installs change-capture triggers that
///   populate `sync_state`/`tombstones`, so `sync_now` can collect what changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Server,
    Replica,
}

/// Open (creating if missing) the SQLite database at `db_path` in `Server` role,
/// run migrations, and return a connection pool. See [`init_db_role`].
pub async fn init_db(db_path: &Path) -> Result<SqlitePool> {
    init_db_role(db_path, Role::Server).await
}

/// Open the database at `db_path` with an explicit [`Role`].
///
/// The path is supplied explicitly rather than derived from any platform layout:
/// the desktop app passes its Tauri `app_data_dir`/`gansty.db`, while the daemon
/// resolves the canonical location from configuration. A `Replica` additionally
/// installs offline-sync change-capture (triggers + bookkeeping tables) and
/// enables `recursive_triggers` so cascade-deleted children are tombstoned.
pub async fn init_db_role(db_path: &Path, role: Role) -> Result<SqlitePool> {
    // Ensure the parent directory exists.
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let db_url = format!("sqlite:{}", db_path.to_string_lossy());

    println!("Database path: {} (role: {:?})", db_path.display(), role);

    // Set explicitly rather than trusting driver defaults (the default is a rollback
    // journal, where a writer blocks every reader, and a 5 s busy timeout):
    // - WAL, so reads never wait on a writer and a writer never waits on reads;
    // - a busy timeout long enough to queue behind another writer's short
    //   transaction instead of failing with "database is locked";
    // - synchronous NORMAL, the safe pairing with WAL (no corruption on power loss,
    //   at most the last commits lost), which keeps commits cheap;
    // - foreign keys on (ON DELETE CASCADE relies on it).
    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(BUSY_TIMEOUT)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .disable_statement_logging();

    let mut builder = SqlitePoolOptions::new().max_connections(5);
    if role == Role::Replica {
        // Change-capture must see cascade-deleted children, so triggers fired by
        // FK ON DELETE CASCADE need to fire in turn (foreign_keys is already ON
        // by sqlx default; recursive_triggers defaults OFF).
        builder = builder.after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("PRAGMA recursive_triggers = ON").execute(&mut *conn).await?;
                Ok(())
            })
        });
    }
    let pool = builder.connect_with(options).await?;

    run_migrations(&pool).await?;
    match role {
        Role::Server => install_server_tombstones(&pool).await,
        Role::Replica => sync_capture_groundwork(&pool).await,
    }

    Ok(pool)
}

/// Create/upgrade the schema. Idempotent: safe to run on every startup.
pub async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    println!("Running database migrations...");

    // Create projects table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Create areas table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS areas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Create tasks table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            area_id INTEGER,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'To Do',
            priority TEXT NOT NULL DEFAULT 'Medium',
            prefix TEXT,
            cost REAL,
            archived INTEGER NOT NULL DEFAULT 0,
            deadline TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE SET NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Create indexes for better performance
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived)")
        .execute(pool)
        .await?;

    // Create time_entries table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS time_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            duration INTEGER,
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id)")
        .execute(pool)
        .await?;

    // Attribute tracked time to the user who logged it (plain nullable INTEGER,
    // sync-safe). NULL for entries created before this column existed.
    let _ = sqlx::query("ALTER TABLE time_entries ADD COLUMN user_id INTEGER")
        .execute(pool)
        .await; // ignore if already added
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id)")
        .execute(pool)
        .await?;

    // Create file_attachments table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS file_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_type TEXT,
            file_size INTEGER,
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_verified_at TEXT,
            is_valid INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_file_attachments_task_id ON file_attachments(task_id)")
        .execute(pool)
        .await?;

    // Add deadline column if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE tasks ADD COLUMN deadline TEXT")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Add archived column to projects if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Create index for better performance on archived projects
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived)")
        .execute(pool)
        .await?;

    // Add currency column if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE tasks ADD COLUMN currency TEXT")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Add pinned column to projects if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Add pinned column to tasks if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Create comments table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)")
        .execute(pool)
        .await?;

    // Emoji reactions on comments. Host-served collaborative data (reviewed over
    // the daemon) — not in the synced table set. One row per (comment, user,
    // emoji); re-reacting the same emoji removes it (toggle).
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS comment_reactions (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE, \
            user_id INTEGER, \
            emoji TEXT NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE(comment_id, user_id, emoji))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id)")
        .execute(pool)
        .await;

    // Custom emojis (added 2026-06-14): a named small image any member can add,
    // referenced in comments/reactions as :name:. Host-served collaborative data
    // (the image is a resized data-URL), not in the synced table set.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS custom_emojis (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            name TEXT NOT NULL UNIQUE, \
            image TEXT NOT NULL, \
            user_id INTEGER, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;

    // Per-user notifications (added 2026-06-14): @mention pings land here so the
    // recipient sees them even if they weren't looking at the task. Host-served
    // (not synced); the bell fetches the caller's own.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS notifications (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            user_id INTEGER NOT NULL, \
            category TEXT NOT NULL DEFAULT 'comment', \
            title TEXT NOT NULL, \
            body TEXT, \
            link_task_id INTEGER, \
            read INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)")
        .execute(pool)
        .await;

    // In-app tickets (bug reports / feature requests). Host-served (not synced);
    // the submitter sees their own, the owner sees all and triages status.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS tickets (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            user_id INTEGER NOT NULL, \
            kind TEXT NOT NULL DEFAULT 'bug', \
            title TEXT NOT NULL, \
            body TEXT, \
            status TEXT NOT NULL DEFAULT 'open', \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id)")
        .execute(pool)
        .await;

    // Create events table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            location TEXT,
            event_date TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            all_day INTEGER NOT NULL DEFAULT 0,
            reminder_minutes INTEGER,
            notification_enabled INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            rrule TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)")
        .execute(pool)
        .await?;

    // Create event_tasks junction table for linking events to tasks
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS event_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            task_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            UNIQUE(event_id, task_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_tasks_event_id ON event_tasks(event_id)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_tasks_task_id ON event_tasks(task_id)")
        .execute(pool)
        .await?;

    // Create event_projects junction table for linking events to projects
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS event_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            project_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            UNIQUE(event_id, project_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_projects_event_id ON event_projects(event_id)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_projects_project_id ON event_projects(project_id)")
        .execute(pool)
        .await?;

    // Add archived column to events if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Create index for better performance on archived events
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)")
        .execute(pool)
        .await?;

    // Imported calendars (owner-managed external ICS/webcal feeds). Host-only:
    // deliberately NOT registered for sync — the owner manages feeds on the host,
    // while the *events* they import flow through the normal (synced) events table.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS calendar_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            color TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_synced_at TEXT,
            last_status TEXT,
            last_event_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Tag events that came from an imported calendar. `calendar_id` is a plain
    // (non-FK) column on purpose: calendar_subscriptions is host-only, so a hard
    // FK would break when an imported event syncs to a replica that has no such
    // row. `external_uid` is the feed's VEVENT UID, used to upsert on re-sync.
    // Both columns ride the normal column-dynamic sync (PRAGMA table_info).
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN calendar_id INTEGER")
        .execute(pool)
        .await; // ignore if already added
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN external_uid TEXT")
        .execute(pool)
        .await; // ignore if already added
    // Recurrence rule (RFC 5545 RRULE) on the master event; occurrences are
    // expanded on read, never stored — so it stays one synced row. Added 2026-06-15.
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN rrule TEXT").execute(pool).await;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(calendar_id)")
        .execute(pool)
        .await?;
    // Dedup key for re-sync. NULLs are distinct in SQLite UNIQUE indexes, so the
    // many native events (calendar_id/external_uid both NULL) never collide.
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_uid ON events(calendar_id, external_uid)")
        .execute(pool)
        .await?;

    // Create contacts table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            occupation TEXT,
            phone_numbers TEXT,
            emails TEXT,
            birthday TEXT,
            notes TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(full_name)")
        .execute(pool)
        .await?;

    // Add archived column to contacts if it doesn't exist (for existing databases)
    let _ = sqlx::query("ALTER TABLE contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Link a contact to a user account (nullable, plain INTEGER — not a hard FK,
    // mirroring calendar_id, so it rides column-dynamic sync without referencing
    // a row a replica may not have yet). Lets the same person be reused as a
    // member across projects instead of re-registering.
    let _ = sqlx::query("ALTER TABLE contacts ADD COLUMN user_id INTEGER")
        .execute(pool)
        .await; // ignore if already added
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)")
        .execute(pool)
        .await?;

    // Create index for better performance on archived contacts
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_contacts_archived ON contacts(archived)")
        .execute(pool)
        .await?;

    // Create task_contacts junction table for linking contacts to tasks
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
            UNIQUE(task_id, contact_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_contacts_task_id ON task_contacts(task_id)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_contacts_contact_id ON task_contacts(contact_id)")
        .execute(pool)
        .await?;

    // Create users table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            email TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active)")
        .execute(pool)
        .await?;

    // Create user_settings table for per-user preferences
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS user_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            setting_key TEXT NOT NULL,
            setting_value TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, setting_key)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id)")
        .execute(pool)
        .await?;

    // Create default user if no users exist
    let user_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;

    if user_count.0 == 0 {
        println!("Creating default user...");
        sqlx::query(
            r#"
            INSERT INTO users (username, full_name, is_active, created_at, updated_at)
            VALUES ('default', 'Default User', 1, datetime('now'), datetime('now'))
            "#,
        )
        .execute(pool)
        .await?;
    }

    // ============== Auth / roles / per-user scoping ==============

    // Mark whether a user is the global owner (bootstrapped on the server).
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Optional profile PIN, stored as "salt$sha256(salt||pin)" — never raw.
    // Gates profile switching on shared machines (a speed bump against casual
    // impersonation, not cryptographic protection: local DB access bypasses it).
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN pin_hash TEXT")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Device tokens: one per enrolled device, stored as a HASH (never raw).
    // No expiry column: a paired device stays trusted until revoked (auth.rs).
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS device_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            device_label TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;
    // Earlier hosts had a 30-day sliding `expires_at NOT NULL`. Drop it once:
    // a single statement (SQLite ≥3.35, bundled 3.46), no rename, and nothing
    // references device_tokens — so none of the rebuild traps apply. Existing
    // rows keep their identity; previously "expired" devices simply work again.
    let has_expiry: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM pragma_table_info('device_tokens') WHERE name = 'expires_at'")
            .fetch_optional(pool)
            .await?;
    if has_expiry.is_some() {
        sqlx::query("ALTER TABLE device_tokens DROP COLUMN expires_at").execute(pool).await?;
    }

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)")
        .execute(pool)
        .await?;

    // Project membership + role (owner | admin | member), scoping data access.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(project_id, user_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)")
        .execute(pool)
        .await?;

    // Short-lived, single-use enrollment tokens (hashed). `kind` is
    // 'new_device' (existing user) or 'invite' (create/attach a member).
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS enrollment_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            target_user_id INTEGER,
            project_id INTEGER,
            role TEXT,
            display_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            enrolled_user_id INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_hash ON enrollment_tokens(token_hash)")
        .execute(pool)
        .await?;

    // Attribution: who wrote a comment / uploaded a file (nullable for legacy rows).
    let _ = sqlx::query("ALTER TABLE comments ADD COLUMN user_id INTEGER")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Threaded replies (added 2026-06-14): a comment may reply to another in the
    // same task. Self-referencing FK so sync's generic FK remap carries it across
    // hosts for free; ON DELETE SET NULL orphans replies to top-level rather than
    // failing a parent delete.
    let _ = sqlx::query("ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE file_attachments ADD COLUMN uploaded_by INTEGER")
        .execute(pool)
        .await; // Ignore error if column already exists

    // Shared-file storage: a per-project allocation (default 256 MB) and, on each
    // attachment, whether a server-side copy exists and how many bytes it uses.
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN storage_quota_bytes INTEGER NOT NULL DEFAULT 268435456")
        .execute(pool)
        .await;
    // The project's default assistant personality (a model_profiles row). Plain
    // nullable INTEGER (model_profiles is host-only, so no FK across sync). NULL
    // = fall back to the globally-active profile.
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN model_profile_id INTEGER")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE file_attachments ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE file_attachments ADD COLUMN storage_size INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    // A task's folder structure (added 2026-11): where a file sits in an uploaded folder,
    // file name included. Carried over from project_files.rel_path by assign/unassign.
    let _ = sqlx::query("ALTER TABLE file_attachments ADD COLUMN rel_path TEXT").execute(pool).await;

    // User profile: a JSON blob (theme, avatar data-URL, vCard fields, flavor
    // fields). The frontend owns the shape; the DB just stores/returns it.
    let _ = sqlx::query("ALTER TABLE users ADD COLUMN profile_json TEXT")
        .execute(pool)
        .await;

    // Global key/value settings (e.g. the default per-project storage quota).
    let _ = sqlx::query("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(pool)
        .await;

    // Automations — the native rules engine (Epoch M(a)). trigger_json /
    // action_json are small editable specs; the engine matches domain events
    // against enabled rules and runs the action via ops under existing scoping.
    // HOST-ONLY (the engine runs where events are emitted) — not synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS rules (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            name TEXT NOT NULL,\
            enabled INTEGER NOT NULL DEFAULT 1,\
            trigger_json TEXT NOT NULL,\
            action_json TEXT NOT NULL,\
            created_at TEXT NOT NULL DEFAULT (datetime('now')),\
            last_fired_at TEXT,\
            fire_count INTEGER NOT NULL DEFAULT 0\
        )",
    )
    .execute(pool)
    .await;

    // Declarative agent tools (the tool registry): owner-defined tools bound to
    // a SAFE primitive (v1: an allowlisted read `ops` command), assembled into
    // chat alongside the compiled tools and run through the same gate. HOST-ONLY
    // (the host owns what tools exist; members reach them via the host's chat),
    // so NOT in the synced list — like rules/routines.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS registry_tools (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            name TEXT NOT NULL UNIQUE,\
            description TEXT NOT NULL DEFAULT '',\
            params_json TEXT NOT NULL DEFAULT '{\"type\":\"object\",\"properties\":{}}',\
            class TEXT NOT NULL DEFAULT 'read',\
            binding_kind TEXT NOT NULL,\
            binding_json TEXT NOT NULL,\
            enabled INTEGER NOT NULL DEFAULT 1,\
            created_at TEXT NOT NULL DEFAULT (datetime('now')),\
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await;

    // Loadouts: a named bundle assigned to a personality (model_profile) — a set
    // of tools it may use, an optional system-prompt fragment, and an optional
    // routed sub-model for that work. The unit of COMPOSITION (vs. tools, the
    // unit of execution). HOST-ONLY, like model_profiles / registry_tools.
    for stmt in [
        "CREATE TABLE IF NOT EXISTS loadouts (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            name TEXT NOT NULL,\
            description TEXT NOT NULL DEFAULT '',\
            prompt_fragment TEXT,\
            routing_profile_id INTEGER,\
            created_at TEXT NOT NULL DEFAULT (datetime('now')),\
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
        "CREATE TABLE IF NOT EXISTS loadout_tools (\
            loadout_id INTEGER NOT NULL,\
            tool_name TEXT NOT NULL,\
            PRIMARY KEY (loadout_id, tool_name),\
            FOREIGN KEY (loadout_id) REFERENCES loadouts(id) ON DELETE CASCADE\
        )",
        "CREATE TABLE IF NOT EXISTS profile_loadouts (\
            profile_id INTEGER NOT NULL,\
            loadout_id INTEGER NOT NULL,\
            PRIMARY KEY (profile_id, loadout_id),\
            FOREIGN KEY (profile_id) REFERENCES model_profiles(id) ON DELETE CASCADE,\
            FOREIGN KEY (loadout_id) REFERENCES loadouts(id) ON DELETE CASCADE\
        )",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // Connector secrets: API keys for the registry's `http` connector binding,
    // referenced by NAME from a tool's binding. HOST-ONLY and never returned by
    // any API (the model/clients see the name, never the value) — like the
    // ragrat token. Deliberately NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS connector_secrets (\
            name TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            created_at TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await;

    // AI assistant: per-project chat threads + their messages. HOST-ONLY — these
    // are deliberately NOT in sync_groundwork's synced list / CAPTURED_TABLES,
    // because chat requires the host's model + retrieval (a replica can't generate
    // offline), and replicating transcripts would be wrong + low-value.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS chats (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            user_id INTEGER REFERENCES users(id), \
            profile_id INTEGER, \
            title TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    // Chat bin: two-stage deletion (bin → restore / purge). NULL = live.
    let _ = sqlx::query("ALTER TABLE chats ADD COLUMN deleted_at TEXT")
        .execute(pool)
        .await; // Ignore error if column already exists
    // Pinned chats float to the top of their project's list.
    let _ = sqlx::query("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // Ignore error if column already exists
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS chat_messages (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, \
            role TEXT NOT NULL, \
            content TEXT NOT NULL, \
            sources_json TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id)")
        .execute(pool)
        .await;
    // Published chats: a member can share a thread so the whole team can read it.
    let _ = sqlx::query("ALTER TABLE chats ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await; // ignore if the column already exists
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_chats_project_public ON chats(project_id, is_public)")
        .execute(pool)
        .await;

    // Project-level files (a project drop zone). Stored on the host (blob at
    // <storage>/pf/<id>), accessed over HTTP — so there are no fragile local
    // paths. Host-only — NOT synced (the bytes live only on the host). rel_path
    // preserves structure for folder uploads.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS project_files (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            file_name TEXT NOT NULL, \
            file_type TEXT, \
            rel_path TEXT, \
            size_bytes INTEGER NOT NULL DEFAULT 0, \
            uploaded_by INTEGER, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id)")
        .execute(pool)
        .await;

    // The AI overview (the ragrat index of a project) takes only the files someone
    // included: 0 = left out (the default for new files), 1 = included, 2 = included
    // past the size guard on purpose. Files that were already there stay in, so nothing
    // indexed silently disappears: the column and the backfill land together, once. On a
    // replica the backfill runs with change capture off, so it doesn't mark every
    // attachment dirty (the host backfills its own rows the same way), and the capture
    // trigger is rebuilt so its base snapshot carries the new column.
    for table in ["file_attachments", "project_files"] {
        let has: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = 'ai_included'")
            .bind(table)
            .fetch_one(pool)
            .await?;
        if has > 0 {
            continue;
        }
        let mut tx = pool.begin().await?;
        sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN ai_included INTEGER NOT NULL DEFAULT 0")).execute(&mut *tx).await?;
        let _ = sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&mut *tx).await;
        sqlx::query(&format!("UPDATE {table} SET ai_included = 1")).execute(&mut *tx).await?;
        let _ = sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&mut *tx).await;
        sqlx::query(&format!("DROP TRIGGER IF EXISTS trg_{table}_cap_upd")).execute(&mut *tx).await?;
        tx.commit().await?;
    }

    // AI model profiles (personalities): a model + system prompt + params, one
    // active at a time (via the 'ai_active_profile_id' app_setting). Multi-row by
    // design so task-specific profiles can be added later. Host-only config —
    // NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_profiles (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            name TEXT NOT NULL, \
            model TEXT NOT NULL, \
            system_prompt TEXT, \
            temperature REAL, \
            max_tokens INTEGER, \
            role TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    // Epoch H: remote engine designation per profile. NULL endpoint = local.
    for col in ["endpoint TEXT", "fallback_note TEXT"] {
        let _ = sqlx::query(&format!("ALTER TABLE model_profiles ADD COLUMN {col}")).execute(pool).await;
    }
    // "vCard" extras for a model profile: a custom avatar (data-URL) and a cached
    // snapshot of the model's capabilities (context window, family, params, tools)
    // from Ollama /api/show. Both nullable — existing profiles keep working.
    let _ = sqlx::query("ALTER TABLE model_profiles ADD COLUMN avatar TEXT")
        .execute(pool)
        .await; // ignore if the column already exists
    let _ = sqlx::query("ALTER TABLE model_profiles ADD COLUMN model_meta TEXT")
        .execute(pool)
        .await; // ignore if the column already exists

    // Read-tool breadcrumbs for an assistant turn (JSON array of tool names), so
    // the "what was looked up" trace survives a reload like sources_json does.
    let _ = sqlx::query("ALTER TABLE chat_messages ADD COLUMN tools_json TEXT")
        .execute(pool)
        .await; // ignore if the column already exists

    // Capacity meter: per-assistant-turn model + token/latency totals (the tool
    // loop's rounds plus the final streamed answer). Capacity planning is
    // arithmetic over these columns — without them every throughput number is
    // a guess. Nullable: user turns and pre-meter history carry NULLs.
    for col in ["model TEXT", "prompt_tokens INTEGER", "completion_tokens INTEGER", "duration_ms INTEGER"] {
        let _ = sqlx::query(&format!("ALTER TABLE chat_messages ADD COLUMN {col}")).execute(pool).await;
    }

    // The agent action ledger: an append-only record of every gated write the
    // user resolved (applied or rejected) and every routine run. The executor
    // writes it at apply time; it is never updated or deleted. project_id is
    // nullable because a routine run (e.g. the daily rundown) spans projects.
    // Host-only — NOT synced, like the rest of the AI tables.
    //
    // The first cut of this table had project_id NOT NULL; SQLite can't relax a
    // column, so rebuild once if that shape is detected.
    let old_shape: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM pragma_table_info('agent_actions') WHERE name='project_id' AND \"notnull\"=1",
    )
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    if old_shape.is_some() {
        let _ = sqlx::query("ALTER TABLE agent_actions RENAME TO agent_actions_v1").execute(pool).await;
    }
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_actions (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            status TEXT NOT NULL, \
            user_id INTEGER NOT NULL, \
            profile_id INTEGER, \
            project_id INTEGER, \
            chat_id INTEGER, \
            routine_id INTEGER, \
            tool TEXT NOT NULL, \
            summary TEXT NOT NULL, \
            args_json TEXT NOT NULL, \
            result_json TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    if old_shape.is_some() {
        let _ = sqlx::query("INSERT INTO agent_actions SELECT * FROM agent_actions_v1").execute(pool).await;
        let _ = sqlx::query("DROP TABLE agent_actions_v1").execute(pool).await;
    }
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_actions_project ON agent_actions(project_id)")
        .execute(pool)
        .await;
    // Capacity meter (Epoch A amendment): which model did the work and what it
    // cost, for routine runs and any future model-driven ledger entries.
    // Added as ALTERs (not in the CREATE) so the v1 positional rebuild above
    // keeps working. Nullable: interactive approvals don't run a model.
    for col in ["model TEXT", "prompt_tokens INTEGER", "completion_tokens INTEGER", "duration_ms INTEGER"] {
        let _ = sqlx::query(&format!("ALTER TABLE agent_actions ADD COLUMN {col}")).execute(pool).await;
    }

    // Protocols (Epoch R.1, docs/design/PROTOCOLS.md): the repeatability artifact.
    // The DB is canonical; .md files are interchange. Versions are IMMUTABLE
    // (editing creates N+1; rollback moves active_version). The ledger
    // provenance columns land in the SAME migration as the tables —
    // retrofitting provenance is miserable, so we don't (PROTOCOLS.md §2).
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS protocols (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            slug TEXT NOT NULL UNIQUE, \
            name TEXT NOT NULL, \
            task_class TEXT NOT NULL, \
            active_version INTEGER, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS protocol_versions (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            protocol_id INTEGER NOT NULL REFERENCES protocols(id) ON DELETE CASCADE, \
            version INTEGER NOT NULL, \
            frontmatter_json TEXT NOT NULL, \
            briefing_md TEXT NOT NULL DEFAULT '', \
            content_hash TEXT NOT NULL, \
            status TEXT NOT NULL DEFAULT 'draft', \
            created_by INTEGER, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE(protocol_id, version))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_protocols_task_class ON protocols(task_class)")
        .execute(pool)
        .await;
    // Ledger provenance: which protocol version produced each run. Nullable —
    // interactive approvals and legacy-routed runs carry no protocol.
    // `parent_action_id` (DELEGATE.md §3): a delegation's row links to the
    // calling turn's row — the ledger becomes a tree and cost roll-up is a
    // query. Same migration family, same nullable discipline.
    for col in ["protocol_slug TEXT", "protocol_version INTEGER", "content_hash TEXT", "parent_action_id INTEGER", "approver_id INTEGER"] {
        let _ = sqlx::query(&format!("ALTER TABLE agent_actions ADD COLUMN {col}")).execute(pool).await;
    }

    // Durable proposals (MEMBER_AGENTS.md prerequisite 1): a restart or
    // eviction must not eat pending work. Consume-once semantics preserved:
    // resolution DELETEs the row (the double-submit guard). `approver_id`
    // lands on the LEDGER (above) — who resolved, alongside user_id = who
    // proposed. The per-project policy decides who may resolve.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS proposals (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL, \
            user_id INTEGER NOT NULL, \
            profile_id INTEGER, \
            chat_id INTEGER NOT NULL, \
            command TEXT NOT NULL, \
            args_json TEXT NOT NULL, \
            summary TEXT NOT NULL, \
            details_json TEXT NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_proposals_user ON proposals(user_id)")
        .execute(pool)
        .await;
    // Where a proposal came from (MEMBER_AGENTS §2): NULL = a host chat turn;
    // 'agent' = a member's own machine's agent, returned through the gate —
    // rendered as “Name (via agent)”. Attribution only, never authorization.
    let _ = sqlx::query("ALTER TABLE proposals ADD COLUMN origin TEXT")
        .execute(pool)
        .await;
    // Which AGENT (model profile) authored a comment — applied comments from
    // approved proposals carry the personality's face, not just the approver's.
    let _ = sqlx::query("ALTER TABLE comments ADD COLUMN profile_id INTEGER")
        .execute(pool)
        .await;
    // Task assignment (a MEMBER_AGENTS dependency):
    // many-to-many join, tasks unchanged. brief_json is the ADVISORY work
    // brief that rides the assignment across the machine boundary.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS task_assignees (\
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, \
            user_id INTEGER NOT NULL, \
            assigned_by INTEGER NOT NULL, \
            assigned_at TEXT NOT NULL DEFAULT (datetime('now')), \
            brief_json TEXT, \
            PRIMARY KEY (task_id, user_id))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id)")
        .execute(pool)
        .await;
    // Contact assignees (2026-09-10): "Nikolai is doing this" when Nikolai is
    // a CONTACT, not a member. A parallel table rather than a nullable user_id
    // on task_assignees — no rebuild (the RENAME-FK trap), and the semantics
    // stay honest: a contact can't log in, receives nothing, dispatches
    // nothing; it is the named responsible party, as data.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS task_contact_assignees (            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,             contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,             assigned_by INTEGER NOT NULL,             assigned_at TEXT NOT NULL DEFAULT (datetime('now')),             PRIMARY KEY (task_id, contact_id))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_contact_assignees_contact ON task_contact_assignees(contact_id)")
        .execute(pool)
        .await;
    // Task visibility (ADR 0002). A task follows its area ('area', the default:
    // existing tasks keep today's behaviour), or is seen by selected members
    // ('members', listed in task_selected_members), or by admins only ('admins'). An area
    // can be restricted to its area members. The two lists are host-side, like
    // task_assignees; the two columns ride the replica's row sync.
    let _ = sqlx::query("ALTER TABLE tasks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'area'")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE areas ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS area_members (\
            area_id INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE, \
            user_id INTEGER NOT NULL, \
            PRIMARY KEY (area_id, user_id))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS task_selected_members (\
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, \
            user_id INTEGER NOT NULL, \
            PRIMARY KEY (task_id, user_id))",
    )
    .execute(pool)
    .await;
    // Quiz domain (QuizForge adoption, 2026-07-13) — subjects/topics/question
    // bank/quizzes/attempts. Own module, same idempotent-boot discipline.
    crate::quiz::ensure_schema(pool).await;

    // Oracle automations (the Assistant's workflow builder): user-authored
    // node graphs. Definitions only — runs live in workflow_runs; writes go
    // through the proposal gate like everything else.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS oracle_workflows (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            name TEXT NOT NULL, \
            status TEXT NOT NULL DEFAULT 'paused', \
            definition_json TEXT NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), \
            last_run_at TEXT)",
    )
    .execute(pool)
    .await;
    // Full node outputs of the last run — what “run from this node” freezes:
    // upstream nodes replay from here instead of re-fetching the world.
    // Per-node status/preview of the LAST run (added 2026-07-03): the Bridge's
    // expandable run log — "1 node failed" must be inspectable next morning,
    // not only while a live progress stream happens to be attached.
    let _ = sqlx::query("ALTER TABLE oracle_workflows ADD COLUMN last_results_json TEXT")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE oracle_workflows ADD COLUMN last_outputs_json TEXT")
        .execute(pool)
        .await;
    // Personal containers (Atlas Phase 2b): a hidden per-user project that
    // hosts personal tab data (Models first) — reusing every table, command
    // and scoping rule projects already have. Non-null = user X's container;
    // excluded from project listings, immune to any project's lifecycle.
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN personal_user_id INTEGER")
        .execute(pool)
        .await;
    // Owner-granted: members may copy this project's files into THEIR OWN
    // Atlas (their machine, their corpus) so their local agents can reference
    // the documents a work brief points at. Off by default.
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN member_atlas_export INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    // Approval policy (prerequisite 3): 'proposer' (default — the assignee
    // reviews their own agent's work) or 'owner' (stricter desks).
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'proposer'")
        .execute(pool)
        .await;

    // Workflows (PROTOCOLS.md §6): durable run state. A gated write
    // mid-workflow SUSPENDS the run (waiting_approval) — it must survive a
    // restart while the human thinks, so this is a table, not memory. The
    // idempotency key lands HERE, with the tables (mandatory the moment a
    // step's side effect lives outside our DB — the Epoch J booking case).
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS workflow_runs (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            workflow_slug TEXT NOT NULL, \
            version INTEGER NOT NULL, \
            status TEXT NOT NULL DEFAULT 'running', \
            current_step INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    // Per-run node log (added 2026-07-03): {node_id: {status, preview, note}}
    // stored at run end — the Bridge's Recent-runs forensics. Previews only,
    // never full outputs.
    let _ = sqlx::query("ALTER TABLE workflow_runs ADD COLUMN results_json TEXT")
        .execute(pool)
        .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS workflow_step_runs (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, \
            step INTEGER NOT NULL, \
            status TEXT NOT NULL DEFAULT 'running', \
            agent_action_id INTEGER, \
            idempotency_key TEXT UNIQUE, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(run_id)")
        .execute(pool)
        .await;

    // Routines: named, versioned scheduled agent work. The record is the spec —
    // prompt/toolset/trigger/output are data, not code; the runner dispatches on
    // `kind`. Triggers are catch-up-on-launch shaped ("run if last run is older
    // than N hours"), because the desktop app starts and stops. Host-only.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS routines (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            name TEXT NOT NULL UNIQUE, \
            kind TEXT NOT NULL, \
            version INTEGER NOT NULL DEFAULT 1, \
            enabled INTEGER NOT NULL DEFAULT 1, \
            prompt_template TEXT, \
            toolset_json TEXT NOT NULL DEFAULT '[]', \
            trigger_json TEXT NOT NULL DEFAULT '{}', \
            output_target_json TEXT NOT NULL DEFAULT '{}', \
            last_run_at TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    // Routine #1: the daily rundown. Reads across projects, writes only its own
    // digest (the secretary_rundown app_setting) — a low-stakes scheduled
    // exercise of the agent machinery.
    let _ = sqlx::query(
        "INSERT INTO routines (name, kind, toolset_json, trigger_json, output_target_json) \
         SELECT 'Daily rundown', 'rundown', \
                '[\"get_tasks\",\"get_project_events\",\"search_corpus\"]', \
                '{\"on_launch_after_hours\": 12}', \
                '{\"type\":\"secretary_rundown\"}' \
         WHERE NOT EXISTS (SELECT 1 FROM routines WHERE kind = 'rundown')",
    )
    .execute(pool)
    .await;

    // Stash tabs: per-project enablement (+ per-tab config) for the compiled-in
    // tab modules. Presence of a row = enabled. Which tabs *exist* is decided at
    // compile time (server feature flags); this table only records the owner's
    // per-project choices. Host-only — NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS project_tabs (\
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            tab_id TEXT NOT NULL, \
            config_json TEXT NOT NULL DEFAULT '{}', \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            PRIMARY KEY (project_id, tab_id))",
    )
    .execute(pool)
    .await;

    // Per-user, per-tab state for stash tabs (game saves, quiz history):
    // game settings, custom lists, aggregated stats — keyed by the
    // AUTHENTICATED user, written only through member-gated own-row routes.
    // Survives tab disable (re-enable restores). Host-only — NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS tab_user_state (\
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            tab_id TEXT NOT NULL, \
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, \
            state_json TEXT NOT NULL DEFAULT '{}', \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), \
            PRIMARY KEY (project_id, tab_id, user_id))",
    )
    .execute(pool)
    .await;

    // Stash-tab scores (game leaderboards): append-only
    // rows visible to every project member — the gamification surface.
    // Host-only — NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS tab_scores (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            tab_id TEXT NOT NULL, \
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, \
            kind TEXT NOT NULL, \
            score REAL NOT NULL, \
            meta_json TEXT NOT NULL DEFAULT '{}', \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_tab_scores_lookup ON tab_scores(project_id, tab_id, id)",
    )
    .execute(pool)
    .await;

    // Pinned tabs (2026-10-15): a user's shortcuts in the global top bar, one
    // row per (user, project, tab), stored on the host that owns the project so
    // a desktop with several workspaces merges them like projects. `position`
    // is a float the client picks, so the merged order across hosts is one sort
    // and a move rewrites one row. A deleted project takes its pins with it
    // (CASCADE); disabling a stash tab drops them in `set_project_tab`.
    // Host-only, NOT synced, like tab_user_state: replica sync remaps project
    // ids, and a pin is a per-user shortcut, not shared work.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS tab_pins (\
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            tab_id TEXT NOT NULL, \
            sub_view TEXT, \
            position REAL NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            PRIMARY KEY (user_id, project_id, tab_id))",
    )
    .execute(pool)
    .await;

    // Explicit project folders (added 2026-07-02). Blobs are stored flat
    // (pf/<id>); folder structure is rel_path metadata — which meant an EMPTY
    // folder couldn't exist. This table holds folders as first-class rows so
    // "New folder" in the file browser survives a reload; folders that contain
    // files are still also derived from rel_paths.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS project_folders (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL, \
            rel_path TEXT NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE(project_id, rel_path))",
    )
    .execute(pool)
    .await;

    // Explicit task folders (added 2026-07, lane files-ui): the task Files tab's "New
    // folder" survives with nothing in it, as project_folders does for the project.
    // Folders holding attachments also come from their rel_paths.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS task_folders (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, \
            rel_path TEXT NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE(task_id, rel_path))",
    )
    .execute(pool)
    .await;

    // Atlas (Epoch I): shared ragrat collections that no project owns —
    // owner-registered, member-readable. `slug` names the collection
    // ("atlas-<slug>"); `source_dir` is the folder the corpus ingests from.
    // Host-only, like the rest of the AI tables.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS atlas_collections (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            slug TEXT NOT NULL UNIQUE, \
            name TEXT NOT NULL, \
            source_dir TEXT NOT NULL, \
            owner_only INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            last_ingest_at TEXT)",
    )
    .execute(pool)
    .await;
    // Owner-private Atlas collections (added 2026-06-14): hidden from members in
    // the registry and the read handlers; the project Atlas lens is how curated
    // slices of private knowledge reach members. Migrate existing registries.
    // Library indexing control: auto_index OFF by default — bulk document
    // dumps must never trigger an ingest storm; the owner indexes on demand
    // (or opts into auto with a quiet-period debounce). dirty_at = when the
    // folder last changed after the last ingest.
    let _ = sqlx::query("ALTER TABLE atlas_collections ADD COLUMN auto_index INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE atlas_collections ADD COLUMN dirty_at TEXT")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE atlas_collections ADD COLUMN owner_only INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;

    // Folder sync: per-project mappings from a LOCAL folder (typically one a
    // cloud provider's own desktop client keeps mirrored — OneDrive, Nextcloud,
    // Google Drive…) into the project's files. One-way import, filterable by
    // extension and size; controls live in Settings → Plug-ins. Host-only.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_folders (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            path TEXT NOT NULL, \
            include_ext TEXT NOT NULL DEFAULT '', \
            max_bytes INTEGER NOT NULL DEFAULT 0, \
            enabled INTEGER NOT NULL DEFAULT 1, \
            last_scan_at TEXT, \
            last_result TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    // What each mapping has imported (rel_path → project file + change stamp),
    // so rescans update in place (stable file ids → references and the RAG
    // corpus follow changes) instead of duplicating.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_folder_files (\
            folder_id INTEGER NOT NULL REFERENCES sync_folders(id) ON DELETE CASCADE, \
            rel_path TEXT NOT NULL, \
            mtime INTEGER NOT NULL, \
            size INTEGER NOT NULL, \
            project_file_id INTEGER NOT NULL, \
            PRIMARY KEY (folder_id, rel_path))",
    )
    .execute(pool)
    .await;

    // Email tab: IMAP accounts (owner's mailboxes), synced thread/message
    // envelopes within a horizon, and bodies — fetched ONLY for threads the
    // owner explicitly links to a project (linking = publishing to the team).
    // Ganban is a CLIENT of these mailboxes, never a server, and has no SMTP:
    // drafts land in the mailbox's own Drafts folder. Host-only — NOT synced.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS email_accounts (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            label TEXT NOT NULL, \
            host TEXT NOT NULL, \
            port INTEGER NOT NULL DEFAULT 993, \
            username TEXT NOT NULL, \
            password TEXT NOT NULL, \
            folders TEXT NOT NULL DEFAULT 'INBOX', \
            drafts_folder TEXT NOT NULL DEFAULT '', \
            horizon_days INTEGER NOT NULL DEFAULT 90, \
            enabled INTEGER NOT NULL DEFAULT 1, \
            last_sync_at TEXT, \
            last_result TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS email_threads (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE, \
            thread_key TEXT NOT NULL, \
            subject TEXT NOT NULL DEFAULT '', \
            last_date TEXT, \
            message_count INTEGER NOT NULL DEFAULT 0, \
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE (account_id, thread_key))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS email_messages (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE, \
            thread_id INTEGER NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE, \
            folder TEXT NOT NULL, \
            uid INTEGER NOT NULL, \
            uid_validity INTEGER NOT NULL DEFAULT 0, \
            message_id TEXT NOT NULL DEFAULT '', \
            subject TEXT NOT NULL DEFAULT '', \
            from_addr TEXT NOT NULL DEFAULT '', \
            date TEXT, \
            body_text TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            UNIQUE (account_id, folder, uid_validity, uid))",
    )
    .execute(pool)
    .await;
    // Accounts belong to individual USERS (members hook up their own inboxes;
    // nobody reads anyone else's unlinked mail). Pre-existing rows -> the owner.
    let _ = sqlx::query("ALTER TABLE email_accounts ADD COLUMN user_id INTEGER")
        .execute(pool)
        .await; // ignore if the column already exists
    // OAuth (XOAUTH2) auth as an alternative to app passwords. auth_type
    // 'password' (default) uses the `password` column; 'oauth' uses the
    // owner's own Google client + a stored refresh token (no password).
    for col in [
        "auth_type TEXT NOT NULL DEFAULT 'password'",
        "oauth_client_id TEXT",
        "oauth_client_secret TEXT",
        "oauth_refresh_token TEXT",
    ] {
        let _ = sqlx::query(&format!("ALTER TABLE email_accounts ADD COLUMN {col}")).execute(pool).await;
    }
    let _ = sqlx::query(
        "UPDATE email_accounts SET user_id = (SELECT id FROM users WHERE is_owner = 1 LIMIT 1) WHERE user_id IS NULL",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_email_threads_project ON email_threads(project_id)")
        .execute(pool)
        .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id)")
        .execute(pool)
        .await;

    // Diagnostics: record who redeemed an enrollment token so the inviter can see
    // "joined as <name>" even when the token minted a fresh account.
    let _ = sqlx::query("ALTER TABLE enrollment_tokens ADD COLUMN enrolled_user_id INTEGER")
        .execute(pool)
        .await;

    // ----------------------------------------------------------------------- //
    // Model Assembly domain (Gundam kits + Warhammer 40K / Age of Sigmar
    // armies). A kit has boards (runners/sprues) of numbered parts; build
    // sections consume parts as you assemble. Images are project_files linked
    // by model_kit_files (so upload/serve/thumbnail are reused). Host-only —
    // NOT synced (hobby data lives on the builder's machine).
    // ----------------------------------------------------------------------- //
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_kits (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            kind TEXT NOT NULL DEFAULT 'gundam', \
            grade TEXT, \
            scale TEXT, \
            faction TEXT, \
            points INTEGER, \
            status TEXT NOT NULL DEFAULT 'Backlog', \
            notes TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_kits_project ON model_kits(project_id)")
        .execute(pool)
        .await;
    // Card cover focus (added 2026-07-02): vertical focal point 0..100 for the
    // cover crop — object-cover's center crop kept beheading the models.
    let _ = sqlx::query("ALTER TABLE model_kits ADD COLUMN cover_focus INTEGER NOT NULL DEFAULT 50")
        .execute(pool)
        .await;
    // Companion task for time tracking (added 2026-07-02): "set this kit
    // active" rides the existing task timer/time-entry machinery instead of
    // growing a parallel one.
    let _ = sqlx::query("ALTER TABLE model_kits ADD COLUMN task_id INTEGER")
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_boards (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            kit_id INTEGER NOT NULL REFERENCES model_kits(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            max_parts INTEGER NOT NULL, \
            color TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0)",
    )
    .execute(pool)
        .await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_parts (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            board_id INTEGER NOT NULL REFERENCES model_boards(id) ON DELETE CASCADE, \
            number INTEGER NOT NULL, \
            is_used INTEGER NOT NULL DEFAULT 0)",
    )
    .execute(pool)
        .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_parts_board ON model_parts(board_id)")
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_sections (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            kit_id INTEGER NOT NULL REFERENCES model_kits(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            start_step TEXT, \
            end_step TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0)",
    )
    .execute(pool)
        .await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_used_parts (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            part_id INTEGER NOT NULL REFERENCES model_parts(id) ON DELETE CASCADE, \
            section_id INTEGER NOT NULL REFERENCES model_sections(id) ON DELETE CASCADE, \
            used_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
        .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_used_section ON model_used_parts(section_id)")
        .execute(pool)
        .await;

    // Typed link from a kit to a project_file under a category. The file bytes
    // (and quota, serving, deletion) stay in project_files; deleting a kit
    // drops the link but leaves the file (the owner may reuse a manual scan
    // across kits). Deleting the project_file is what frees the bytes.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_kit_files (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            kit_id INTEGER NOT NULL REFERENCES model_kits(id) ON DELETE CASCADE, \
            file_id INTEGER NOT NULL REFERENCES project_files(id) ON DELETE CASCADE, \
            kind TEXT NOT NULL DEFAULT 'photo', \
            caption TEXT, \
            sort_order INTEGER NOT NULL DEFAULT 0)",
    )
    .execute(pool)
        .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_kit_files_kit ON model_kit_files(kit_id)")
        .execute(pool)
        .await;

    // Comment task tags (added 2026-10): a comment keeps its HOME task in
    // `comments.task_id` and may be tagged on more tasks of the same project
    // (an end-of-day update that covers two tasks). Extra tags live here; the
    // home task is never duplicated in this table. Mirrors task_contacts, so
    // the generic sync engine remaps both FKs by parent sync_uuid.
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS comment_tasks (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            comment_id INTEGER NOT NULL, \
            task_id INTEGER NOT NULL, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE, \
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE, \
            UNIQUE(comment_id, task_id))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_comment_tasks_task ON comment_tasks(task_id)")
        .execute(pool)
        .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_comment_tasks_comment ON comment_tasks(comment_id)")
        .execute(pool)
        .await;
    // The board lists a project's top-level comments newest first.
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)")
        .execute(pool)
        .await;

    share_links(pool).await?;

    event_done_and_files(pool).await;

    event_occurrences(pool).await;

    sync_groundwork(pool).await;

    // Finance (docs/design/FINANCE.md): host-only tables, never synced.
    crate::finance::schema::migrate(pool).await?;

    println!("Database migrations completed");

    Ok(())
}

/// One day of a repeating event at a time (added 2026-11).
///
/// `events.exdates` lists a series' skipped days (comma-separated ISO dates; the client
/// leaves them out when it expands the rule). `events.series_id` marks a one-off copy that
/// replaced one day of a series ("This event"), pointing at that series. A plain integer,
/// as `calendar_id`, so both ride the column-dynamic sync.
async fn event_occurrences(pool: &SqlitePool) {
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN exdates TEXT").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN series_id INTEGER").execute(pool).await;
}

/// An event marked past by hand, and files attached to an event (added 2026-11).
///
/// `events.done_at` is when someone marked the event past; it rides the events table's
/// column-dynamic sync. For a recurring event it covers the whole series.
///
/// `event_attachments` holds an event's files: its own table, not `file_attachments`
/// (whose rows hang off a task, count against that task's project quota and sync) or
/// `project_files` (which belong to a project). Events belong to no project, so their
/// files count against no quota. Host-only, not synced: the bytes live at
/// `<storage>/ev/<id>`.
async fn event_done_and_files(pool: &SqlitePool) {
    let _ = sqlx::query("ALTER TABLE events ADD COLUMN done_at TEXT").execute(pool).await;
    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS event_attachments (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, \
            file_name TEXT NOT NULL, \
            file_type TEXT, \
            rel_path TEXT, \
            size_bytes INTEGER NOT NULL DEFAULT 0, \
            uploaded_by INTEGER, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_event_attachments_event ON event_attachments(event_id)")
        .execute(pool)
        .await;
}

/// Share links (ADR 0006): a public link to a fixed set of a project's files. Host-only, not
/// synced. The token is kept as issued (the creator's list shows the link again); the
/// password is an argon2 PHC string. `prepared_at` is null while the files' CRC-32s are
/// being computed (status "preparing"). `task_id` is the task the link was made from, or
/// null for a link made from the project's Files.
///
/// `share_link_files` is the snapshot taken at creation, `n` its stable position (the
/// door's `/f/:n`). Each row names its blob by `kind` and `file_id`: a task attachment
/// (`<storage>/<id>`) or a project file (`<storage>/pf/<id>`). It keeps the folder and name
/// shown, the size and mtime (unix seconds) it was snapshotted at, and the CRC-32 (null
/// until computed, and again when the blob changed and is re-read).
async fn share_links(pool: &SqlitePool) -> Result<()> {
    const LINKS: &str = "(\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            token TEXT NOT NULL UNIQUE, \
            task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, \
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
            label TEXT NOT NULL, \
            password_hash TEXT, \
            expires_at TEXT, \
            revoked_at TEXT, \
            prepared_at TEXT, \
            created_by INTEGER, \
            created_at TEXT NOT NULL, \
            download_count INTEGER NOT NULL DEFAULT 0, \
            last_download_at TEXT)";
    const FILES: &str = "(\
            link_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE, \
            n INTEGER NOT NULL, \
            kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('attachment', 'project')), \
            file_id INTEGER NOT NULL, \
            folder TEXT NOT NULL DEFAULT '', \
            name TEXT NOT NULL, \
            size INTEGER NOT NULL, \
            mtime INTEGER NOT NULL, \
            crc32 INTEGER, \
            PRIMARY KEY (link_id, n))";
    let _ = sqlx::query(&format!("CREATE TABLE IF NOT EXISTS share_links {LINKS}")).execute(pool).await;
    let _ = sqlx::query(&format!("CREATE TABLE IF NOT EXISTS share_link_files {FILES}")).execute(pool).await;
    // A failed rebuild rolls back and stops startup: serving on the old shape would fail every
    // new link with an opaque SQL error. The next start tries again.
    share_links_from_projects(pool, LINKS, FILES).await?;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_share_links_task ON share_links(task_id)").execute(pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_share_links_project ON share_links(project_id)").execute(pool).await;
    Ok(())
}

/// The first share links (2026-11) were a task's only: `share_links.task_id` was NOT NULL and
/// `share_link_files.attachment_id` named an attachment. Rebuild both tables once into the
/// shape above (SQLite can't drop a NOT NULL in place), keeping every link and its files.
/// Foreign keys are off on this one connection meanwhile, so dropping the old tables
/// cascades nothing. It runs with the other migrations, before the host serves anything.
async fn share_links_from_projects(pool: &SqlitePool, links: &str, files: &str) -> Result<()> {
    let old: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('share_link_files') WHERE name = 'attachment_id'")
            .fetch_one(pool)
            .await?;
    if old == 0 {
        return Ok(());
    }
    let mut conn = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await?;
    let rebuilt = async {
        let mut tx = sqlx::Connection::begin(&mut *conn).await?;
        for sql in [
            format!("CREATE TABLE share_links_v2 {links}"),
            "INSERT INTO share_links_v2 (id, token, task_id, project_id, label, password_hash, expires_at, revoked_at, \
               prepared_at, created_by, created_at, download_count, last_download_at) \
             SELECT id, token, task_id, project_id, label, password_hash, expires_at, revoked_at, prepared_at, \
               created_by, created_at, download_count, last_download_at FROM share_links"
                .to_string(),
            format!("CREATE TABLE share_link_files_v2 {}", files.replace("REFERENCES share_links(", "REFERENCES share_links_v2(")),
            "INSERT INTO share_link_files_v2 (link_id, n, kind, file_id, folder, name, size, mtime, crc32) \
             SELECT link_id, n, 'attachment', attachment_id, folder, name, size, mtime, crc32 FROM share_link_files"
                .to_string(),
            "DROP TABLE share_link_files".to_string(),
            "DROP TABLE share_links".to_string(),
            // Renaming the parent rewrites the child's REFERENCES to the new name.
            "ALTER TABLE share_links_v2 RENAME TO share_links".to_string(),
            "ALTER TABLE share_link_files_v2 RENAME TO share_link_files".to_string(),
        ] {
            sqlx::query(&sql).execute(&mut *tx).await?;
        }
        tx.commit().await
    }
    .await;
    sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await?;
    rebuilt?;
    println!("share links: tables widened for project files");
    Ok(())
}

/// P2.0 — offline-sync groundwork (purely additive; no behavior change yet).
///
/// Every synced entity gets a stable cross-replica `sync_uuid` (SQLite mints one
/// per row via `randomblob`, backfilled for existing rows and auto-filled on
/// insert by a trigger — so no ops.rs changes are needed). Entities that lacked
/// `updated_at` gain it (backfilled from `created_at`); syncable entities gain a
/// nullable `deleted_at` for future tombstones. Bookkeeping tables `sync_state`
/// and `tombstones` are created, and `device_tokens` gets a `last_sync_at`
/// cursor. The behavior-changing parts (soft-delete conversion, read filters,
/// the /sync engine) land in later stages where they're exercised.
async fn sync_groundwork(pool: &SqlitePool) {
    // Tables that participate in sync, and which extra columns they still need.
    // (need_updated_at: tables that don't already have an updated_at column.)
    let synced: &[(&str, bool)] = &[
        // `users` is pull-only + host-authoritative (never in PUSH_TABLES /
        // CAPTURED_TABLES), but still needs a stable sync_uuid so symmetric pull
        // can carry it as the row identity.
        ("users", false),
        ("projects", false),
        ("areas", true),
        ("tasks", false),
        ("time_entries", true),
        ("file_attachments", true),
        ("comments", false),
        ("comment_tasks", true),
        ("events", false),
        ("event_tasks", true),
        ("event_projects", true),
        ("contacts", false),
        ("task_contacts", true),
        ("user_settings", true),
    ];
    // Tables whose hard-deletes will become tombstones in a later stage.
    let needs_deleted_at: &[&str] = &[
        "areas",
        "time_entries",
        "comments",
        "comment_tasks",
        "file_attachments",
        "event_tasks",
        "event_projects",
        "task_contacts",
    ];

    let run = |sql: String| async move {
        let _ = sqlx::query(&sql).execute(pool).await; // idempotent; ignore "already exists"
    };

    for (t, need_updated) in synced {
        run(format!("ALTER TABLE {t} ADD COLUMN sync_uuid TEXT")).await;
        // randomblob is evaluated per-row, so each existing row gets a distinct id.
        run(format!("UPDATE {t} SET sync_uuid = lower(hex(randomblob(16))) WHERE sync_uuid IS NULL")).await;
        run(format!("CREATE UNIQUE INDEX IF NOT EXISTS idx_{t}_sync_uuid ON {t}(sync_uuid)")).await;

        if *need_updated {
            run(format!("ALTER TABLE {t} ADD COLUMN updated_at TEXT")).await;
            run(format!("UPDATE {t} SET updated_at = created_at WHERE updated_at IS NULL")).await;
            // Insert trigger: stamp the new row's sync_uuid + updated_at.
            run(format!(
                "CREATE TRIGGER IF NOT EXISTS trg_{t}_sync AFTER INSERT ON {t} \
                 BEGIN UPDATE {t} SET \
                   sync_uuid = COALESCE(NEW.sync_uuid, lower(hex(randomblob(16)))), \
                   updated_at = COALESCE(NEW.updated_at, NEW.created_at, datetime('now')) \
                 WHERE rowid = NEW.rowid; END"
            ))
            .await;
        } else {
            run(format!(
                "CREATE TRIGGER IF NOT EXISTS trg_{t}_sync AFTER INSERT ON {t} \
                 WHEN NEW.sync_uuid IS NULL \
                 BEGIN UPDATE {t} SET sync_uuid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid; END"
            ))
            .await;
        }
    }

    for t in needs_deleted_at {
        run(format!("ALTER TABLE {t} ADD COLUMN deleted_at TEXT")).await;
    }

    run("ALTER TABLE device_tokens ADD COLUMN last_sync_at TEXT".to_string()).await;

    run(
        "CREATE TABLE IF NOT EXISTS sync_state (\
            entity_type TEXT NOT NULL, \
            row_id INTEGER NOT NULL, \
            sync_uuid TEXT, \
            updated_at TEXT, \
            deleted INTEGER NOT NULL DEFAULT 0, \
            origin_uuid TEXT, \
            dirty INTEGER NOT NULL DEFAULT 1, \
            base_snapshot TEXT, \
            PRIMARY KEY (entity_type, row_id))"
            .to_string(),
    )
    .await;

    run(
        "CREATE TABLE IF NOT EXISTS tombstones (\
            entity_type TEXT NOT NULL, \
            row_id INTEGER, \
            sync_uuid TEXT, \
            deleted_at TEXT, \
            base_updated_at TEXT, \
            PRIMARY KEY (entity_type, sync_uuid))"
            .to_string(),
    )
    .await;
    // (`base_updated_at` exists on both roles: the host needs it on its own
    //  tombstones so a delete carries an LWW reference when pulled to replicas.)
    run("ALTER TABLE tombstones ADD COLUMN base_updated_at TEXT".to_string()).await; // upgrade older DBs
}

/// The tables a replica can mutate locally and must push (== `sync::PUSH_TABLES`;
/// `users` is host-authoritative and never push-synced).
pub(crate) const CAPTURED_TABLES: &[&str] = &[
    "projects", "areas", "tasks", "time_entries", "file_attachments", "comments", "comment_tasks",
    "events", "event_tasks", "event_projects", "contacts", "task_contacts", "user_settings",
];

/// Server-role delete capture: an authoritative host records a tombstone for
/// every hard-delete (incl. member edits via `/invoke`, which never touch the
/// sync engine) so `sync::pull` can propagate deletes to replicas. No dirty
/// tracking — the host is authoritative and pushes nowhere.
async fn install_server_tombstones(pool: &SqlitePool) {
    let run = |sql: String| async move {
        let _ = sqlx::query(&sql).execute(pool).await;
    };
    for &t in CAPTURED_TABLES {
        run(format!(
            "CREATE TRIGGER IF NOT EXISTS trg_{t}_tomb AFTER DELETE ON {t} \
             WHEN OLD.sync_uuid IS NOT NULL \
             BEGIN \
               INSERT OR REPLACE INTO tombstones(entity_type,row_id,sync_uuid,deleted_at,base_updated_at) \
               VALUES('{t}', OLD.rowid, OLD.sync_uuid, strftime('%Y-%m-%dT%H:%M:%fZ','now'), OLD.updated_at); \
             END"
        ))
        .await;
    }
}

/// P2.2a — replica-only change-capture. Installs the bookkeeping tables and the
/// AFTER INSERT/UPDATE/DELETE triggers that keep `sync_state` + `tombstones`
/// current on EVERY local mutation (regardless of which Rust path issued it — a
/// cursor `WHERE updated_at > since` would miss `storage.rs` writes that don't
/// bump `updated_at`, and hard-deletes leave no row to scan).
///
/// Only the desktop replica runs this; the authoritative host (`Role::Server`)
/// is never dirty-tracked. Capture is suppressed while `_sync_ctl.applying='1'`
/// so ingesting host rows during a sync doesn't echo straight back as local
/// changes. The OLD-image `base_snapshot` is captured only on the clean->dirty
/// edge so an intermediate edit can't corrupt the common ancestor.
async fn sync_capture_groundwork(pool: &SqlitePool) {
    let run = |sql: String| async move {
        let _ = sqlx::query(&sql).execute(pool).await; // idempotent; ignore "already exists"
    };

    // Echo-guard sentinel: '1' during ingest, '0' otherwise.
    run("CREATE TABLE IF NOT EXISTS _sync_ctl (key TEXT PRIMARY KEY, value TEXT NOT NULL)".into()).await;
    run("INSERT OR IGNORE INTO _sync_ctl (key, value) VALUES ('applying', '0')".into()).await;

    // Field-level conflicts surfaced from either sync direction, for the review UI.
    run(
        "CREATE TABLE IF NOT EXISTS sync_conflicts (\
            sync_uuid TEXT PRIMARY KEY, \
            entity TEXT NOT NULL, \
            base_json TEXT, \
            local_json TEXT, \
            server_json TEXT, \
            clashing_cols TEXT, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')))"
            .into(),
    )
    .await;

    for &t in CAPTURED_TABLES {
        // OLD-image column list (minus id) for the base snapshot json_object.
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
            .bind(t)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        let old_obj = cols
            .iter()
            .filter(|c| c.as_str() != "id" && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
            .map(|c| format!("'{c}', OLD.\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        if old_obj.is_empty() {
            continue; // table not present in this DB
        }

        // INSERT: a locally-born row -> dirty, no common ancestor (base NULL).
        // sync_uuid/updated_at are read live (robust to AFTER-INSERT trigger order
        // vs. the existing trg_{t}_sync stamping trigger).
        run(format!(
            "CREATE TRIGGER IF NOT EXISTS trg_{t}_cap_ins AFTER INSERT ON {t} \
             WHEN (SELECT value FROM _sync_ctl WHERE key='applying')='0' \
             BEGIN \
               INSERT INTO sync_state(entity_type,row_id,sync_uuid,updated_at,deleted,dirty,base_snapshot) \
               VALUES('{t}', NEW.rowid, \
                      (SELECT sync_uuid FROM {t} WHERE rowid=NEW.rowid), \
                      (SELECT updated_at FROM {t} WHERE rowid=NEW.rowid), \
                      0, 1, NULL) \
               ON CONFLICT(entity_type,row_id) DO UPDATE SET \
                 dirty=1, deleted=0, \
                 sync_uuid=(SELECT sync_uuid FROM {t} WHERE rowid=NEW.rowid), \
                 updated_at=(SELECT updated_at FROM {t} WHERE rowid=NEW.rowid); \
             END"
        ))
        .await;

        // UPDATE: capture the OLD image as the common ancestor, but ONLY on the
        // clean->dirty edge (existing dirty row keeps its ancestor). The
        // `OLD.sync_uuid IS NOT NULL` guard skips the trg_{t}_sync self-UPDATE
        // that stamps a freshly-inserted row.
        run(format!(
            "CREATE TRIGGER IF NOT EXISTS trg_{t}_cap_upd AFTER UPDATE ON {t} \
             WHEN (SELECT value FROM _sync_ctl WHERE key='applying')='0' AND OLD.sync_uuid IS NOT NULL \
             BEGIN \
               INSERT INTO sync_state(entity_type,row_id,sync_uuid,updated_at,deleted,dirty,base_snapshot) \
               VALUES('{t}', NEW.rowid, \
                      (SELECT sync_uuid FROM {t} WHERE rowid=NEW.rowid), \
                      (SELECT updated_at FROM {t} WHERE rowid=NEW.rowid), \
                      0, 1, json_object({old_obj})) \
               ON CONFLICT(entity_type,row_id) DO UPDATE SET \
                 dirty=1, deleted=0, \
                 sync_uuid=excluded.sync_uuid, updated_at=excluded.updated_at, \
                 base_snapshot=CASE WHEN sync_state.dirty=0 THEN excluded.base_snapshot ELSE sync_state.base_snapshot END; \
             END"
        ))
        .await;

        // DELETE: record a tombstone (with the pre-delete updated_at) and drop
        // any dirty state for the row.
        run(format!(
            "CREATE TRIGGER IF NOT EXISTS trg_{t}_cap_del AFTER DELETE ON {t} \
             WHEN (SELECT value FROM _sync_ctl WHERE key='applying')='0' AND OLD.sync_uuid IS NOT NULL \
             BEGIN \
               INSERT OR REPLACE INTO tombstones(entity_type,row_id,sync_uuid,deleted_at,base_updated_at) \
               VALUES('{t}', OLD.rowid, OLD.sync_uuid, strftime('%Y-%m-%dT%H:%M:%fZ','now'), OLD.updated_at); \
               DELETE FROM sync_state WHERE entity_type='{t}' AND row_id=OLD.rowid; \
             END"
        ))
        .await;
    }
}
