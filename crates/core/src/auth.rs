//! Authentication, roles, and per-user scoping primitives.
//!
//! Tokens are high-entropy random bytes; we store only their SHA-256 hash and
//! hand the raw token to the device once. Enrollment tokens are short-lived and
//! single-use. Device tokens DO NOT EXPIRE: a paired device is like an SSH key —
//! it stays trusted until someone revokes it. Expiry bought no security a stolen
//! phone wouldn't already have inside the window, and it silently locked out
//! the member who didn't open the app for a month — the one failure the owner
//! may have no means to repair. Revocation (devices list) is the control.
//!
//! Scoping data (who can see which project) lives here; the *enforcement* lives
//! in the daemon (`crates/server`) so the desktop's local `invoke` path stays
//! full-access.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::{AppError, Result};
use crate::models::User;

/// Lifetime of a device-pairing ("new_device") enrollment token — short, since
/// the owner pairs their own device right then and there.
pub const ENROLLMENT_TTL_SECS: i64 = 24 * 3600;
/// Lifetime of an "invite"/contact enrollment token — long, to match the ~30d
/// Tailscale device-share: an invitee who accepts the machine-share today but
/// opens Ganban next week must not hit an expired token (the "half-joined" trap).
pub const INVITE_TTL_SECS: i64 = 30 * 24 * 3600;

pub const ROLE_OWNER: &str = "owner";
pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_MEMBER: &str = "member";

/// Whether a role may be granted through an invite or a role change: admin or member,
/// never "owner" (no self-escalation).
pub fn is_grantable_role(role: &str) -> bool {
    role == ROLE_ADMIN || role == ROLE_MEMBER
}

/// Higher = more privileged. Unknown roles rank 0.
pub fn role_rank(role: &str) -> i32 {
    match role {
        ROLE_OWNER => 3,
        ROLE_ADMIN => 2,
        ROLE_MEMBER => 1,
        _ => 0,
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// A fresh 256-bit token as a 64-char hex string (from the OS CSPRNG).
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS RNG unavailable");
    hex(&bytes)
}

/// SHA-256(token) as hex. Tokens are high-entropy, so a fast hash is the right
/// tool (this is API-key hashing, not password hashing).
pub fn hash_token(raw: &str) -> String {
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    hex(h.finalize().as_slice())
}

/// Hash a profile PIN as "salt$sha256(salt||pin)". A 4-digit PIN is a speed
/// bump against casual profile switching, not real crypto — the salt just
/// keeps the stored value from being a trivially reversible lookup.
pub fn hash_pin(pin: &str) -> String {
    let salt = {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes).expect("OS RNG unavailable");
        hex(&bytes)
    };
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(pin.as_bytes());
    format!("{salt}${}", hex(h.finalize().as_slice()))
}

/// Check a PIN against a stored "salt$hash" value.
pub fn pin_matches(stored: &str, pin: &str) -> bool {
    let Some((salt, expected)) = stored.split_once('$') else { return false };
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(pin.as_bytes());
    hex(h.finalize().as_slice()) == expected
}

// ============== DTOs ==============

#[derive(Debug, Serialize)]
pub struct EnrollResult {
    pub device_token: String,
    pub user: User,
}

#[derive(Debug, Serialize)]
pub struct MembershipInfo {
    pub project_id: i64,
    pub project_name: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct Me {
    pub user: User,
    pub memberships: Vec<MembershipInfo>,
}

#[derive(Debug, Serialize)]
pub struct MemberInfo {
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub id: i64,
    pub device_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    /// The device making THIS request (set by the handler, which knows the
    /// caller's token) — so a devices list can say "this one" and warn before
    /// someone revokes the session they're looking at.
    #[serde(default)]
    pub current: bool,
}

// ============== Bootstrap ==============

/// Ensure a global owner exists; if none is flagged, promote the earliest user
/// (the migration's default user) and backfill them as owner-member of every
/// existing project. Returns the owner's user id.
pub async fn ensure_owner(db: &Db) -> Result<i64> {
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>("SELECT id FROM users WHERE is_owner = 1 LIMIT 1")
        .fetch_optional(db)
        .await?
    {
        return Ok(id);
    }

    let owner_id: i64 = sqlx::query_scalar("SELECT id FROM users ORDER BY id ASC LIMIT 1")
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("no users to bootstrap as owner".into()))?;

    sqlx::query("UPDATE users SET is_owner = 1 WHERE id = ?")
        .bind(owner_id)
        .execute(db)
        .await?;

    // Backfill owner membership on all existing projects.
    let project_ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM projects").fetch_all(db).await?;
    for (pid,) in project_ids {
        add_project_member(db, pid, owner_id, ROLE_OWNER).await?;
    }

    Ok(owner_id)
}

/// Repair the rule that the owner is owner-member of every project: add the
/// owner to any project that lacks them. Desktops in local mode used to create
/// projects with no member rows, so the owner was missing from their members
/// (and from their assignees). Leaves an existing membership's role alone, and
/// skips personal containers (they belong to their one user).
/// Idempotent; returns how many projects it repaired.
pub async fn ensure_owner_memberships(db: &Db, owner_id: i64) -> Result<u64> {
    let done = sqlx::query(
        r#"
        INSERT INTO project_members (project_id, user_id, role, created_at)
        SELECT p.id, ?1, ?2, ?3 FROM projects p
        WHERE p.personal_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1)
        "#,
    )
    .bind(owner_id)
    .bind(ROLE_OWNER)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(done.rows_affected())
}

/// Bootstrap auth on startup: ensure an owner who is owner-member of every
/// project, and if the owner has no enrolled device (and no pending owner
/// token), mint a one-time owner enrollment token and return its raw value so
/// the daemon can surface it. Idempotent.
pub async fn bootstrap(db: &Db) -> Result<Option<String>> {
    let owner_id = ensure_owner(db).await?;
    ensure_owner_memberships(db, owner_id).await?;

    let has_device: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM device_tokens WHERE user_id = ? LIMIT 1")
            .bind(owner_id)
            .fetch_optional(db)
            .await?;
    let has_pending: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM enrollment_tokens WHERE target_user_id = ? AND kind = 'new_device' AND consumed_at IS NULL AND expires_at > ? LIMIT 1",
    )
    .bind(owner_id)
    .bind(Utc::now())
    .fetch_optional(db)
    .await?;

    if has_device.is_none() && has_pending.is_none() {
        // Short-lived: it's a full-owner credential printed to logs; the desktop
        // owner normally mints the phone invite from the UI instead.
        let raw = create_enrollment_token(db, "new_device", Some(owner_id), None, None, None, ENROLLMENT_TTL_SECS).await?;
        Ok(Some(raw))
    } else {
        Ok(None)
    }
}

// ============== Enrollment + device tokens ==============

/// Create a short-lived, single-use enrollment token; returns the RAW token
/// (store only its hash). `kind` is "new_device" or "invite".
pub async fn create_enrollment_token(
    db: &Db,
    kind: &str,
    target_user_id: Option<i64>,
    project_id: Option<i64>,
    role: Option<&str>,
    display_name: Option<&str>,
    ttl_secs: i64,
) -> Result<String> {
    let raw = random_token();
    let hash = hash_token(&raw);
    let expires = Utc::now() + Duration::seconds(ttl_secs);
    sqlx::query(
        r#"
        INSERT INTO enrollment_tokens
            (token_hash, kind, target_user_id, project_id, role, display_name, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&hash)
    .bind(kind)
    .bind(target_user_id)
    .bind(project_id)
    .bind(role)
    .bind(display_name)
    .bind(Utc::now())
    .bind(expires)
    .execute(db)
    .await?;
    Ok(raw)
}

/// Mint a "new_device" token FOR an existing, active user — the owner-side
/// recovery path when a member has no signed-in device left. Enrolling it
/// resolves to that account (nothing duplicated, nothing lost). Authorization
/// (owner only) is the caller's job; this refuses only what can't be right.
pub async fn create_member_device_enrollment(db: &Db, target_user_id: i64) -> Result<String> {
    let active: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND is_active = 1")
        .bind(target_user_id)
        .fetch_optional(db)
        .await?;
    if active.is_none() {
        return Err(AppError::NotFound("no active user with that id".into()));
    }
    create_enrollment_token(db, "new_device", Some(target_user_id), None, None, None, ENROLLMENT_TTL_SECS).await
}

/// Consume an enrollment token and issue a device token. For "invite", create
/// (or attach to `target_user_id`) a user and add the project membership.
/// Returns the RAW device token once.
pub async fn enroll(
    db: &Db,
    raw_enrollment: &str,
    device_label: Option<&str>,
    display_name: Option<&str>,
) -> Result<EnrollResult> {
    let hash = hash_token(raw_enrollment);

    // Everything is one transaction: if any step fails, the token claim rolls
    // back (retryable) and no orphan user/device is left behind.
    let mut tx = db.begin().await?;

    let token = sqlx::query_as::<_, crate::models::EnrollmentToken>(
        "SELECT * FROM enrollment_tokens WHERE token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::InvalidInput("invalid enrollment token".into()))?;

    if token.expires_at < Utc::now() {
        return Err(AppError::InvalidInput("enrollment token expired".into()));
    }

    // Atomic single-use claim: only one caller wins this UPDATE.
    let claimed = sqlx::query("UPDATE enrollment_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .bind(Utc::now())
        .bind(token.id)
        .execute(&mut *tx)
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(AppError::InvalidInput("enrollment token already used".into()));
    }

    let now = Utc::now();
    let user_id = match token.kind.as_str() {
        "new_device" => token
            .target_user_id
            .ok_or_else(|| AppError::InvalidInput("enrollment token missing user".into()))?,
        "invite" => {
            if let Some(uid) = token.target_user_id {
                uid
            } else {
                // The joiner's chosen name wins over any name the inviter suggested.
                let display = display_name
                    .map(str::to_owned)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| token.display_name.clone())
                    .unwrap_or_else(|| "Member".to_string());
                let username = format!("u{}", &random_token()[..20]);
                let res = sqlx::query(
                    "INSERT INTO users (username, full_name, email, is_active, is_owner, created_at, updated_at) VALUES (?, ?, NULL, 1, 0, ?, ?)",
                )
                .bind(&username)
                .bind(&display)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                res.last_insert_rowid()
            }
        }
        other => return Err(AppError::InvalidInput(format!("unknown enrollment kind '{other}'"))),
    };

    // Record who completed this enrollment so the inviter's diagnostics can show
    // "joined as <name>" (the token's target_user_id is null for fresh accounts).
    sqlx::query("UPDATE enrollment_tokens SET enrolled_user_id = ? WHERE id = ?")
        .bind(user_id)
        .bind(token.id)
        .execute(&mut *tx)
        .await?;

    if token.kind == "invite" {
        if let Some(pid) = token.project_id {
            let role = token.role.as_deref().unwrap_or(ROLE_MEMBER);
            sqlx::query(
                "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
            )
            .bind(pid)
            .bind(user_id)
            .bind(role)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        // Surface the joiner in Contacts (link an existing contact, or create one)
        // so collaborators are reusable across projects from the address book.
        let linked: Option<i64> = sqlx::query_scalar("SELECT id FROM contacts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
        if linked.is_none() {
            let full_name: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id = ?")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO contacts (full_name, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
                .bind(&full_name)
                .bind(user_id)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
        }
    }

    let raw_device = random_token();
    let device_hash = hash_token(&raw_device);
    sqlx::query(
        "INSERT INTO device_tokens (user_id, token_hash, device_label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(&device_hash)
    .bind(device_label)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(EnrollResult { device_token: raw_device, user })
}

/// Validate a device token. A token is valid until its row is gone (revoked)
/// or its user is deactivated — there is no time limit. Stamps `last_seen_at`
/// (what the devices list shows) and returns the user WITH the token's row id
/// (the caller's device identity — "this device" in that list). Otherwise `None`.
pub async fn validate_device_token(db: &Db, raw: &str) -> Result<Option<(User, i64)>> {
    let hash = hash_token(raw);
    let row = sqlx::query_as::<_, DeviceTokenRow>("SELECT id, user_id FROM device_tokens WHERE token_hash = ?")
        .bind(&hash)
        .fetch_optional(db)
        .await?;

    let Some(row) = row else { return Ok(None) };

    sqlx::query("UPDATE device_tokens SET last_seen_at = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(row.id)
        .execute(db)
        .await?;

    // is_active = 0 is "removed from this host": their enrolled devices must
    // stop authenticating, not just disappear from pickers.
    let user = sqlx::query_as::<_, User>(
        "SELECT *, pin_hash IS NOT NULL AS has_pin FROM users WHERE id = ? AND is_active = 1",
    )
    .bind(row.user_id)
    .fetch_optional(db)
    .await?;
    Ok(user.map(|u| (u, row.id)))
}

/// Whose device token is this? (`None` if it doesn't exist.) The permission
/// check behind "a member may revoke their OWN devices".
pub async fn device_token_user(db: &Db, token_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT user_id FROM device_tokens WHERE id = ?")
        .bind(token_id)
        .fetch_optional(db)
        .await?)
}

#[derive(sqlx::FromRow)]
struct DeviceTokenRow {
    id: i64,
    user_id: i64,
}

pub async fn revoke_device_token(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM device_tokens WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// All current device tokens for a user (revoking deletes the row, so every row
/// here is a live device). Most-recently-seen first.
pub async fn list_user_devices(db: &Db, user_id: i64) -> Result<Vec<DeviceInfo>> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        SELECT id, device_label, created_at, last_seen_at
        FROM device_tokens
        WHERE user_id = ?
        ORDER BY COALESCE(last_seen_at, created_at) DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, device_label, created_at, last_seen_at)| DeviceInfo {
            id,
            device_label,
            created_at,
            last_seen_at,
            current: false,
        })
        .collect())
}

/// Update a user's display name (self-service profile edits).
pub async fn set_display_name(db: &Db, user_id: i64, name: &str) -> Result<()> {
    sqlx::query("UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(Utc::now())
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

// ============== Membership / scope ==============

pub async fn add_project_member(db: &Db, project_id: i64, user_id: i64, role: &str) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO project_members (project_id, user_id, role, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .bind(role)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(())
}

/// Remove someone from a project, and from its areas and its tasks' lists of
/// selected members (their assignments stay on record but grant nothing).
pub async fn remove_project_member(db: &Db, project_id: i64, user_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
        .bind(project_id)
        .bind(user_id)
        .execute(db)
        .await?;
    crate::visibility::forget_project_member(db, project_id, user_id).await
}

/// First non-empty email from a contact's JSON-array email string.
fn first_email(emails_json: Option<&str>) -> Option<String> {
    emails_json
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .and_then(|v| v.into_iter().find(|e| !e.trim().is_empty()))
}

/// Resolve the user account backing a contact, creating + linking one if the
/// contact isn't an account yet. Lets a contact be invited/added as a reusable
/// member. Returns the user id.
pub async fn ensure_user_for_contact(db: &Db, contact_id: i64) -> Result<i64> {
    let row = sqlx::query_as::<_, (Option<i64>, String, Option<String>)>(
        "SELECT user_id, full_name, emails FROM contacts WHERE id = ?",
    )
    .bind(contact_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("contact".into()))?;
    let (existing, full_name, emails) = row;
    if let Some(uid) = existing {
        return Ok(uid);
    }
    let now = Utc::now();
    let username = format!("u{}", &random_token()[..20]);
    let email = first_email(emails.as_deref());
    let res = sqlx::query(
        "INSERT INTO users (username, full_name, email, is_active, is_owner, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)",
    )
    .bind(&username)
    .bind(&full_name)
    .bind(&email)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    let uid = res.last_insert_rowid();
    sqlx::query("UPDATE contacts SET user_id = ?, updated_at = ? WHERE id = ?")
        .bind(uid)
        .bind(now)
        .bind(contact_id)
        .execute(db)
        .await?;
    Ok(uid)
}

/// Invite a contact to a project by minting a join link for a FRESH account.
///
/// SECURITY: this only ever creates a brand-new identity. It refuses if the
/// contact already has a linked account — otherwise an admin of any project
/// could mint an enrollment token targeting an existing user (contacts are a
/// global pool and every invited member is auto-linked to a contact) and redeem
/// it to obtain that user's credentials = account takeover. Already-linked
/// contacts are added via `add_contact_to_project` (membership only, no
/// credential issuance). Returns the RAW enrollment token.
pub async fn create_contact_invite(db: &Db, contact_id: i64, project_id: i64, role: &str) -> Result<String> {
    let existing: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT user_id FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_optional(db)
        .await?
        .flatten();
    if existing.is_some() {
        return Err(AppError::InvalidInput(
            "this contact already has an account — use Add to project instead of an invite".into(),
        ));
    }
    // No account yet: create + link a fresh one and target the invite at it.
    let uid = ensure_user_for_contact(db, contact_id).await?;
    let name: Option<String> = sqlx::query_scalar("SELECT full_name FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_optional(db)
        .await?;
    create_enrollment_token(db, "invite", Some(uid), Some(project_id), Some(role), name.as_deref(), INVITE_TTL_SECS).await
}

/// Lifecycle of an enrollment/invite token, for the inviter's diagnostics panel.
/// Non-sensitive: lets the owner see "pending → joined" instead of guessing.
#[derive(Debug, Clone, Serialize)]
pub struct InviteStatus {
    /// "pending" (live, not yet redeemed), "joined" (redeemed), "expired", or
    /// "unknown" (no such token — wrong/garbled link, or already cleaned up).
    pub state: String,
    pub kind: Option<String>,
    pub project_id: Option<i64>,
    pub created_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub consumed_at: Option<DateTime<Utc>>,
    /// Display name of whoever completed the join (when resolvable).
    pub joined_name: Option<String>,
}

/// One row of the "pending invites" list — an enrollment token plus resolved
/// project/joiner names, so the owner can review and revoke stale invites.
#[derive(Debug, Clone, Serialize)]
pub struct InviteSummary {
    pub id: i64,
    pub kind: String,
    /// "pending" (live, unredeemed), "joined" (redeemed), or "expired".
    pub state: String,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub role: Option<String>,
    /// The name the inviter attached (who it's for), if any.
    pub display_name: Option<String>,
    /// Who actually completed the join (only once redeemed).
    pub joined_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: i64,
    kind: String,
    project_id: Option<i64>,
    role: Option<String>,
    display_name: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    consumed_at: Option<DateTime<Utc>>,
    project_name: Option<String>,
    joiner_name: Option<String>,
}

/// List enrollment tokens (optionally scoped to one project), newest first, with
/// project + joiner names resolved. Authorized at the dispatch layer (owner for
/// the global list; project admin for a single project). Bounded at 500.
pub async fn list_invites(db: &Db, project_id: Option<i64>) -> Result<Vec<InviteSummary>> {
    let rows = sqlx::query_as::<_, InviteRow>(
        r#"
        SELECT t.id, t.kind, t.project_id, t.role, t.display_name,
               t.created_at, t.expires_at, t.consumed_at,
               p.name AS project_name,
               u.full_name AS joiner_name
        FROM enrollment_tokens t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = COALESCE(t.enrolled_user_id, t.target_user_id)
        WHERE (? IS NULL OR t.project_id = ?)
        ORDER BY t.created_at DESC
        LIMIT 500
        "#,
    )
    .bind(project_id)
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let now = Utc::now();
    Ok(rows
        .into_iter()
        .map(|r| {
            let consumed = r.consumed_at.is_some();
            let state = if consumed {
                "joined"
            } else if r.expires_at < now {
                "expired"
            } else {
                "pending"
            };
            InviteSummary {
                id: r.id,
                kind: r.kind,
                state: state.into(),
                project_id: r.project_id,
                project_name: r.project_name,
                role: r.role,
                display_name: r.display_name,
                // Only surface "joined as" once actually redeemed — a pending
                // contact invite pre-creates the target user, so the join would
                // otherwise resolve a name for someone who hasn't joined.
                joined_name: if consumed { r.joiner_name } else { None },
                created_at: r.created_at,
                expires_at: r.expires_at,
                consumed_at: r.consumed_at,
            }
        })
        .collect())
}

/// Fetch a single enrollment token by id (for authorization before revoke).
pub async fn get_invite_token(db: &Db, id: i64) -> Result<Option<crate::models::EnrollmentToken>> {
    Ok(
        sqlx::query_as::<_, crate::models::EnrollmentToken>("SELECT * FROM enrollment_tokens WHERE id = ?")
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// Revoke (delete) an enrollment token so a stale/leaked invite can no longer be
/// redeemed. Already-joined members keep their access — their device token is a
/// separate, independent credential. Authorized at the dispatch layer.
pub async fn revoke_invite(db: &Db, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM enrollment_tokens WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Look up an enrollment token's lifecycle by its RAW value (hashed here, never
/// stored raw). The caller is authorized at the dispatch layer against the
/// token's project. Returns "unknown" rather than erroring on a missing token so
/// a mistyped/expired-and-purged link reads cleanly in the UI.
pub async fn invite_status(db: &Db, raw_token: &str) -> Result<InviteStatus> {
    let hash = hash_token(raw_token);
    let token = sqlx::query_as::<_, crate::models::EnrollmentToken>(
        "SELECT * FROM enrollment_tokens WHERE token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?;
    let Some(t) = token else {
        return Ok(InviteStatus {
            state: "unknown".into(),
            kind: None,
            project_id: None,
            created_at: None,
            expires_at: None,
            consumed_at: None,
            joined_name: None,
        });
    };
    let state = if t.consumed_at.is_some() {
        "joined"
    } else if t.expires_at < Utc::now() {
        "expired"
    } else {
        "pending"
    };
    let joined_name = if t.consumed_at.is_some() {
        match t.enrolled_user_id.or(t.target_user_id) {
            Some(uid) => sqlx::query_scalar::<_, String>("SELECT full_name FROM users WHERE id = ?")
                .bind(uid)
                .fetch_optional(db)
                .await?,
            None => None,
        }
    } else {
        None
    };
    Ok(InviteStatus {
        state: state.into(),
        kind: Some(t.kind),
        project_id: t.project_id,
        created_at: Some(t.created_at),
        expires_at: Some(t.expires_at),
        consumed_at: t.consumed_at,
        joined_name,
    })
}

/// Add a contact to a project directly — only valid once the contact is linked
/// to an account (i.e. they've joined before, so their device already works).
pub async fn add_contact_to_project(db: &Db, contact_id: i64, project_id: i64, role: &str) -> Result<()> {
    let user_id: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT user_id FROM contacts WHERE id = ?")
        .bind(contact_id)
        .fetch_optional(db)
        .await?
        .flatten();
    let uid = user_id.ok_or_else(|| {
        AppError::InvalidInput("this contact has no account yet — use Invite to send them a join link".into())
    })?;
    // Never let this path change a project owner's role (add_project_member is an
    // upsert; demoting the owner here would bypass member_set_role's guard).
    if member_role(db, project_id, uid).await?.as_deref() == Some(ROLE_OWNER) {
        return Ok(());
    }
    add_project_member(db, project_id, uid, role).await
}

/// User ids a member may "see": anyone who co-belongs to a project they're a
/// member of, plus themselves. Used to scope the user list (and profiles/PII) so
/// a member can't read the profile of someone they share no project with.
pub async fn covisible_user_ids(db: &Db, user_id: i64) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT pm2.user_id
        FROM project_members pm1
        JOIN project_members pm2 ON pm2.project_id = pm1.project_id
        WHERE pm1.user_id = ?
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
    if !ids.contains(&user_id) {
        ids.push(user_id);
    }
    Ok(ids)
}

/// The project ids a user is a member of.
pub async fn accessible_project_ids(db: &Db, user_id: i64) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT project_id FROM project_members WHERE user_id = ?")
        .bind(user_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// The event ids a user may see: those linked (via event_projects) to a project
/// they're a member of. Events with no project link are not visible to members
/// (only the owner sees them). Used to scope the global event list/read.
pub async fn accessible_event_ids(db: &Db, user_id: i64) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ep.event_id
        FROM event_projects ep
        JOIN project_members pm ON pm.project_id = ep.project_id
        WHERE pm.user_id = ?
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// The contact ids a member may see: contacts linked (via task_contacts) to a
/// task in a project they belong to. The full address book is the owner's; a
/// member only sees contacts relevant to their own work.
pub async fn accessible_contact_ids(db: &Db, user_id: i64) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT tc.contact_id
        FROM task_contacts tc
        JOIN tasks t ON t.id = tc.task_id
        JOIN project_members pm ON pm.project_id = t.project_id
        WHERE pm.user_id = ?
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether the user is an admin or owner of any project — a "workspace admin"
/// who may manage shared resources (the calendar, the address book).
pub async fn is_admin_anywhere(db: &Db, user_id: i64) -> Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_members WHERE user_id = ? AND role IN ('owner', 'admin')",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    Ok(n > 0)
}

/// A user's role in a project, if any.
pub async fn member_role(db: &Db, project_id: i64, user_id: i64) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?)
}

pub async fn list_project_members(db: &Db, project_id: i64) -> Result<Vec<MemberInfo>> {
    let rows = sqlx::query_as::<_, (i64, String, String, String)>(
        r#"
        SELECT u.id, u.username, u.full_name, pm.role
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY u.full_name ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_id, username, display_name, role)| MemberInfo { user_id, username, display_name, role })
        .collect())
}

pub async fn list_memberships(db: &Db, user_id: i64) -> Result<Vec<MembershipInfo>> {
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        r#"
        SELECT p.id, p.name, pm.role
        FROM project_members pm
        JOIN projects p ON p.id = pm.project_id
        WHERE pm.user_id = ?
        ORDER BY p.name ASC
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(project_id, project_name, role)| MembershipInfo { project_id, project_name, role })
        .collect())
}

// ---- Entity → project resolvers (for scope enforcement) ----

pub async fn task_project_id(db: &Db, task_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT project_id FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(db)
        .await?)
}

/// The project a model kit belongs to (for access checks on kit-scoped ops).
pub async fn model_kit_project_id(db: &Db, kit_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT project_id FROM model_kits WHERE id = ?")
        .bind(kit_id)
        .fetch_optional(db)
        .await?)
}

pub async fn area_project_id(db: &Db, area_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT project_id FROM areas WHERE id = ?")
        .bind(area_id)
        .fetch_optional(db)
        .await?)
}

pub async fn time_entry_project_id(db: &Db, entry_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT t.project_id FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE te.id = ?",
    )
    .bind(entry_id)
    .fetch_optional(db)
    .await?)
}

pub async fn comment_project_id(db: &Db, comment_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?",
    )
    .bind(comment_id)
    .fetch_optional(db)
    .await?)
}

pub async fn attachment_project_id(db: &Db, attachment_id: i64) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT t.project_id FROM file_attachments f JOIN tasks t ON t.id = f.task_id WHERE f.id = ?",
    )
    .bind(attachment_id)
    .fetch_optional(db)
    .await?)
}

// Re-export the row model used above so the daemon can name it if needed.
pub use crate::models::DeviceToken;
