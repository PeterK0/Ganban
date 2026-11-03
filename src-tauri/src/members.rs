//! Desktop-only: the owner (this host machine) manages project membership and
//! devices directly against the local pool. The desktop is always the trusted
//! owner, so these wrap `ganban_core::auth` with no extra auth — they work even
//! when the daemon isn't hosting. Networked members manage *themselves* over the
//! daemon's `/invoke` self-service path instead.

use ganban_core::auth::{self, DeviceInfo, MemberInfo};
use ganban_core::Db;
use tauri::State;

#[tauri::command]
pub async fn member_list(pool: State<'_, Db>, project_id: i64) -> Result<Vec<MemberInfo>, String> {
    auth::list_project_members(pool.inner(), project_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn member_set_role(
    pool: State<'_, Db>,
    project_id: i64,
    user_id: i64,
    role: String,
) -> Result<(), String> {
    if !auth::is_grantable_role(&role) {
        return Err("role must be 'admin' or 'member'".into());
    }
    // Never demote the project owner.
    let current = auth::member_role(pool.inner(), project_id, user_id)
        .await
        .map_err(|e| e.to_string())?;
    if current.as_deref() == Some(auth::ROLE_OWNER) {
        return Err("cannot change the owner's role".into());
    }
    auth::add_project_member(pool.inner(), project_id, user_id, &role)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn member_remove(pool: State<'_, Db>, project_id: i64, user_id: i64) -> Result<(), String> {
    let current = auth::member_role(pool.inner(), project_id, user_id)
        .await
        .map_err(|e| e.to_string())?;
    if current.as_deref() == Some(auth::ROLE_OWNER) {
        return Err("cannot remove the project owner".into());
    }
    auth::remove_project_member(pool.inner(), project_id, user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_list(pool: State<'_, Db>, user_id: i64) -> Result<Vec<DeviceInfo>, String> {
    auth::list_user_devices(pool.inner(), user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_revoke(pool: State<'_, Db>, token_id: i64) -> Result<(), String> {
    auth::revoke_device_token(pool.inner(), token_id)
        .await
        .map_err(|e| e.to_string())
}

/// Mint an invite for a contact, targeting their (created-if-needed) account so
/// accepting reuses that identity. Returns the raw enrollment token.
#[tauri::command]
pub async fn contact_invite(
    pool: State<'_, Db>,
    contact_id: i64,
    project_id: i64,
    role: String,
) -> Result<String, String> {
    if !auth::is_grantable_role(&role) {
        return Err("role must be 'admin' or 'member'".into());
    }
    auth::create_contact_invite(pool.inner(), contact_id, project_id, &role)
        .await
        .map_err(|e| e.to_string())
}

/// Add an already-account-linked contact to a project directly (no re-invite).
#[tauri::command]
pub async fn contact_add_to_project(
    pool: State<'_, Db>,
    contact_id: i64,
    project_id: i64,
    role: String,
) -> Result<(), String> {
    if !auth::is_grantable_role(&role) {
        return Err("role must be 'admin' or 'member'".into());
    }
    auth::add_contact_to_project(pool.inner(), contact_id, project_id, &role)
        .await
        .map_err(|e| e.to_string())
}
