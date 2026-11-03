//! Offline-sync engine (server side).
//!
//! Owner-only: the desktop keeps a local replica and PULLs the host's changed
//! rows since a cursor; members stay live thin clients (no sync, no conflicts).
//! Rows are exported generically via SQLite's own `json_object`, driven off
//! `PRAGMA table_info`, so adding a column to a synced table needs no changes
//! here. This is the read half; the push/conflict/id-remap half is layered on
//! top in a later stage.

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::{Db, Result};

/// Tables a desktop replica mirrors, in dependency order (parents before
/// children) — the same order the push half will apply incoming rows.
pub const SYNC_TABLES: &[&str] = &[
    "users",
    "projects",
    "areas",
    "tasks",
    "time_entries",
    "file_attachments",
    "comments",
    "comment_tasks",
    "events",
    "event_tasks",
    "event_projects",
    "contacts",
    "task_contacts",
    "user_settings",
];

/// Column names of `table` (from the live schema).
async fn column_names(db: &Db, table: &str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info(?)")
        .bind(table)
        .fetch_all(db)
        .await?)
}

/// Tables a replica may PUSH (write). Excludes `users` (auth-sensitive:
/// is_owner / is_active / username) — users are pulled read-only into a replica;
/// profile edits sync via the dedicated self-service path, not generic row-sync.
pub const PUSH_TABLES: &[&str] = &[
    "projects",
    "areas",
    "tasks",
    "time_entries",
    "file_attachments",
    "comments",
    "comment_tasks",
    "events",
    "event_tasks",
    "event_projects",
    "contacts",
    "task_contacts",
    "user_settings",
];

/// Max changes accepted in one push (bounds memory/CPU).
const MAX_CHANGES: usize = 5000;

/// A safe SQL identifier (column names are interpolated, so be strict).
fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A `json_object('c','"c"', …)` expression over a table's identifier-safe columns.
async fn json_object_expr(db: &Db, table: &str) -> Result<String> {
    let cols = column_names(db, table).await?;
    Ok(cols
        .iter()
        .filter(|c| is_ident(c))
        .map(|c| format!("'{c}', \"{c}\""))
        .collect::<Vec<_>>()
        .join(", "))
}

/// Bind a JSON value to a sqlite query as its natural type (column affinity
/// coerces the rest). Bound values are owned, so no borrow of the source.
fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(Option::<String>::None),
        Value::Bool(b) => q.bind(if *b { 1_i64 } else { 0_i64 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else if let Some(u) = n.as_u64() {
                q.bind(u as i64)
            } else {
                q.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

/// One incoming change from a replica.
#[derive(serde::Deserialize)]
pub struct IncomingChange {
    pub entity: String,
    pub sync_uuid: String,
    #[serde(default = "default_op")]
    pub op: String, // "upsert" | "delete"
    #[serde(default)]
    pub base_updated_at: Option<String>,
    /// Common-ancestor row image (the value both sides last agreed on) for the
    /// 3-way merge. Push sends it from the replica's sync_state; ingest fills it
    /// locally. Absent => merge degrades to wholesale LWW-by-base_updated_at.
    #[serde(default)]
    pub base: Option<Map<String, Value>>,
    #[serde(default)]
    pub data: Map<String, Value>,
    /// fk_column -> parent sync_uuid (resolve to the server's id), or null.
    #[serde(default)]
    pub fk_refs: Map<String, Value>,
}
fn default_op() -> String {
    "upsert".to_string()
}

/// The parent table a foreign-key column points at, but only if it's a
/// push-syncable entity (has a sync_uuid to remap by). FKs to `users` etc. are
/// left as the client's value (a replica adopts the host's user ids).
async fn fk_parent_table(db: &Db, table: &str, col: &str) -> Result<Option<String>> {
    let parent: Option<String> = sqlx::query_scalar("SELECT \"table\" FROM pragma_foreign_key_list(?) WHERE \"from\" = ?")
        .bind(table)
        .bind(col)
        .fetch_optional(db)
        .await?;
    Ok(parent.filter(|p| PUSH_TABLES.contains(&p.as_str())))
}

enum RowOutcome {
    Applied,
    Inserted(i64),
    Conflict(Value),
    Rejected(String),
}

/// Which side is applying, and so which policy: `Push` (a replica's edits land
/// on the authoritative host) vs `Ingest` (the host's edits land on a replica).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Push,
    Ingest,
}

impl Mode {
    /// Tables this mode may write. Push excludes `users` (auth-sensitive);
    /// Ingest admits them (the replica mirrors host users, adopting their ids).
    fn allowed(self) -> &'static [&'static str] {
        match self {
            Mode::Push => PUSH_TABLES,
            Mode::Ingest => SYNC_TABLES,
        }
    }
}

/// Apply a replica's offline changes to the authoritative host (owner-only).
/// Inserts mint a fresh server id (returned in `id_remap`); FKs are remapped
/// from parent sync_uuids; conflicts (the host changed a row since the client's
/// base) are reported, not written. Returns
/// { id_remap, conflicts, applied, rejected, cursor }.
pub async fn push(db: &Db, changes: Vec<IncomingChange>) -> Result<Value> {
    apply(db, changes, Mode::Push).await
}

/// Apply the host's pulled changes to a local replica. The dual of `push`:
/// admits `users` (adopting host ids), trusts the incoming `updated_at` rather
/// than restamping, mints local ids for everything else, and remaps FKs into
/// the replica's id-space. Same return shape as `push`.
pub async fn ingest(db: &Db, changes: Vec<IncomingChange>) -> Result<Value> {
    apply(db, changes, Mode::Ingest).await
}

async fn apply(db: &Db, mut changes: Vec<IncomingChange>, mode: Mode) -> Result<Value> {
    if changes.len() > MAX_CHANGES {
        return Err(crate::AppError::InvalidInput(format!("too many changes in one batch (max {MAX_CHANGES})")));
    }
    // Parents before children, so FK targets exist when a child is applied.
    // Ingest sorts by SYNC_TABLES (users first — comments/user_settings FK them).
    let order = mode.allowed();
    changes.sort_by_key(|c| order.iter().position(|t| *t == c.entity).unwrap_or(usize::MAX));

    // Ingest: synthesize the conflict base from the replica's own bookkeeping.
    // A clean (or untracked) local row leaves base_updated_at None -> the host
    // wins with no conflict; a dirty row supplies its captured ancestor so the
    // 3-way merge fires when the host also changed the row.
    if mode == Mode::Ingest {
        for ch in changes.iter_mut() {
            if ch.op == "delete" || !SYNC_TABLES.contains(&ch.entity.as_str()) {
                continue;
            }
            let row_id: Option<i64> =
                sqlx::query_scalar(&format!("SELECT rowid FROM \"{}\" WHERE sync_uuid = ?", ch.entity))
                    .bind(&ch.sync_uuid)
                    .fetch_optional(db)
                    .await?;
            if let Some(rid) = row_id {
                let st: Option<(i64, Option<String>)> =
                    sqlx::query_as("SELECT dirty, base_snapshot FROM sync_state WHERE entity_type = ? AND row_id = ?")
                        .bind(&ch.entity)
                        .bind(rid)
                        .fetch_optional(db)
                        .await?;
                if let Some((1, Some(base_json))) = st {
                    if let Ok(base_map) = serde_json::from_str::<Map<String, Value>>(&base_json) {
                        ch.base_updated_at = base_map.get("updated_at").and_then(|v| v.as_str()).map(String::from);
                        ch.base = Some(base_map);
                    }
                }
            }
        }
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    let mut cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut col_cache: std::collections::HashMap<String, std::collections::HashSet<String>> = std::collections::HashMap::new();
    let mut id_remap = Map::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let mut applied: Vec<String> = Vec::new();
    let mut rejected: Vec<Value> = Vec::new();

    let mut tx = db.begin().await?;
    // Echo-guard: suppress the replica's capture triggers for the duration of the
    // ingest writes (in-tx, so a rollback restores it) — otherwise ingested host
    // rows would be recaptured as local changes and pushed straight back.
    if mode == Mode::Ingest {
        sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&mut *tx).await?;
    }
    for ch in &changes {
        match apply_change(db, &mut tx, &mut cache, &mut col_cache, ch, &now, mode).await {
            Ok(RowOutcome::Applied) => applied.push(ch.sync_uuid.clone()),
            Ok(RowOutcome::Inserted(id)) => {
                applied.push(ch.sync_uuid.clone());
                id_remap.insert(ch.sync_uuid.clone(), Value::from(id));
            }
            Ok(RowOutcome::Conflict(v)) => conflicts.push(v),
            Ok(RowOutcome::Rejected(reason)) | Err(crate::AppError::InvalidInput(reason)) => {
                rejected.push(serde_json::json!({ "entity": ch.entity, "sync_uuid": ch.sync_uuid, "reason": reason }));
            }
            Err(e) => {
                // A failed statement doesn't poison the SQLite tx; record + continue.
                rejected.push(serde_json::json!({ "entity": ch.entity, "sync_uuid": ch.sync_uuid, "reason": e.to_string() }));
            }
        }
    }
    if mode == Mode::Ingest {
        sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&mut *tx).await?;
    }
    tx.commit().await?;

    Ok(serde_json::json!({
        "id_remap": Value::Object(id_remap),
        "conflicts": Value::Array(conflicts),
        "applied": applied,
        "rejected": rejected,
        "cursor": now,
    }))
}

/// Apply one change within the transaction.
async fn apply_change(
    db: &Db,
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    cache: &mut std::collections::HashMap<String, i64>,
    col_cache: &mut std::collections::HashMap<String, std::collections::HashSet<String>>,
    ch: &IncomingChange,
    now: &str,
    mode: Mode,
) -> Result<RowOutcome> {
    let table = ch.entity.as_str();
    if !mode.allowed().contains(&table) {
        return Ok(RowOutcome::Rejected("entity is not syncable in this direction".into()));
    }
    if !col_cache.contains_key(table) {
        let cols: std::collections::HashSet<String> =
            column_names(db, table).await?.into_iter().filter(|c| is_ident(c)).collect();
        col_cache.insert(table.to_string(), cols);
    }
    let valid = col_cache.get(table).unwrap().clone();

    // Resolve FK references (parent sync_uuid -> server id) into the row data.
    // Only valid columns are touched; FKs to non-push tables (e.g. users) keep
    // the client value; an unresolvable required parent rejects the row.
    let mut data = ch.data.clone();
    for (col, parent_ref) in &ch.fk_refs {
        if !valid.contains(col) {
            continue;
        }
        match parent_ref.as_str() {
            Some(puuid) => {
                if let Some(parent_table) = fk_parent_table(db, table, col).await? {
                    let key = format!("{parent_table}:{puuid}");
                    let pid = match cache.get(&key) {
                        Some(id) => Some(*id),
                        None => {
                            let id: Option<i64> = sqlx::query_scalar(&format!(
                                "SELECT id FROM \"{parent_table}\" WHERE sync_uuid = ?"
                            ))
                            .bind(puuid)
                            .fetch_optional(&mut **tx)
                            .await?;
                            if let Some(i) = id {
                                cache.insert(key, i);
                            }
                            id
                        }
                    };
                    match pid {
                        Some(pid) => {
                            data.insert(col.clone(), Value::from(pid));
                        }
                        None => return Ok(RowOutcome::Rejected(format!("unresolved parent for {col}"))),
                    }
                }
            }
            None => {
                data.insert(col.clone(), Value::Null);
            }
        }
    }

    let existing: Option<(i64, i64)> = sqlx::query_as(&format!(
        // julianday (not datetime): sub-second precision so two edits in the same
        // wall-clock second aren't silently mis-classified as no-conflict.
        "SELECT id, CASE WHEN ? IS NOT NULL AND julianday(updated_at) > julianday(?) THEN 1 ELSE 0 END \
         FROM \"{table}\" WHERE sync_uuid = ?"
    ))
    .bind(ch.base_updated_at.as_deref())
    .bind(ch.base_updated_at.as_deref())
    .bind(&ch.sync_uuid)
    .fetch_optional(&mut **tx)
    .await?;

    if ch.op == "delete" {
        if let Some((id, conflict)) = existing {
            if conflict == 1 {
                // Edit-beats-delete: the other side changed the row since the
                // deleter's base, so the edit wins and the delete is abandoned.
                // Returning Applied (not Conflict) lets the deleter drop its
                // tombstone (push: via ack; ingest: it's just skipped) so the
                // edited row survives and the system converges — no stuck,
                // unrenderable delete-conflict and no doomed re-push loop.
                return Ok(RowOutcome::Applied);
            }
            // Tombstone creation is owned by the AFTER DELETE triggers (Server:
            // unguarded; Replica: suppressed under the ingest echo-guard), so the
            // host propagates this delete onward while a replica ingesting a
            // host-delete doesn't echo it straight back.
            sqlx::query(&format!("DELETE FROM \"{table}\" WHERE sync_uuid = ?")).bind(&ch.sync_uuid).execute(&mut **tx).await?;
            if mode == Mode::Ingest {
                // The capture trigger that would clear sync_state is suppressed
                // during ingest, so drop any (possibly dirty) bookkeeping here.
                sqlx::query("DELETE FROM sync_state WHERE entity_type = ? AND row_id = ?")
                    .bind(table)
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        return Ok(RowOutcome::Applied);
    }

    // `users` is host-authoritative and matched/adopted by id, so a replica keeps
    // the host's id verbatim (authorship FKs like comments.user_id are raw ints).
    let keep_id = mode == Mode::Ingest && table == "users";

    // updated_at: Push restamps (host-authoritative time); Ingest trusts the
    // host's incoming value (falling back to now only if absent).
    if mode == Mode::Push || !data.contains_key("updated_at") {
        data.insert("updated_at".to_string(), Value::from(now.to_string()));
    }
    data.insert("sync_uuid".to_string(), Value::from(ch.sync_uuid.clone()));
    if !keep_id {
        data.remove("id");
    }
    data.retain(|k, _| valid.contains(k)); // SECURITY: only real columns reach SQL
    if data.is_empty() {
        return Ok(RowOutcome::Rejected("no valid columns".into()));
    }

    if let Some((_id, conflict)) = existing {
        if conflict == 1 {
            // The target moved since the common ancestor. Try a field-level merge:
            // disjoint changes auto-merge; a true clash is reported for review.
            match (&ch.base, row_map(db, &mut *tx, table, &ch.sync_uuid).await?) {
                (Some(base), Some(theirs)) => {
                    // For Ingest, base/theirs are both in the replica's id-space and
                    // `data` carries the FK columns resolved into that space, so
                    // include FKs in the comparison (catches concurrent re-parenting).
                    // For Push the wire base is the replica's id-space while `theirs`
                    // is the host's, so FK ids aren't comparable — compare plain
                    // fields only (ch.data has FKs lifted out).
                    let mine: &Map<String, Value> = if mode == Mode::Ingest { &data } else { &ch.data };
                    let (overrides, clashes) = three_way(base, mine, &theirs);
                    if !clashes.is_empty() {
                        return Ok(RowOutcome::Conflict(conflict_value(
                            table,
                            &ch.sync_uuid,
                            ch.base_updated_at.clone(),
                            base,
                            mine,
                            &theirs,
                            &clashes,
                            mode,
                        )));
                    }
                    // Fold the columns only the other side changed into the merged row.
                    for (col, val) in overrides {
                        if valid.contains(&col) {
                            data.insert(col, val);
                        }
                    }
                }
                _ => {
                    // No common ancestor (or row vanished): can't merge -> wholesale report.
                    return Ok(RowOutcome::Conflict(
                        server_conflict(db, &mut *tx, table, &ch.sync_uuid, ch.base_updated_at.clone()).await?,
                    ));
                }
            }
        }
        // Soft-delete protection. `archived` is an ordinary column with no
        // delete-tombstone, so with no common ancestor (base_updated_at NULL ->
        // conflict==0, no 3-way merge) a non-conflicting incoming upsert carrying
        // archived=0 would blindly overwrite a row the user binned HERE,
        // resurrecting it (the ghost-events bug). Keep the local bin instead: a
        // genuine restore is dirty-tracked and travels the merge/push path, where
        // its archived=0 rides a real base and is applied correctly. Covers every
        // archived-bearing table (events, tasks, projects, contacts).
        //
        // SCOPE: this guards the literal `archived` flag only. A 2026-06-14 sweep
        // confirmed it is the SOLE live synced soft-delete: `deleted_at` columns
        // are vestigial (those tables hard-delete + tombstone instead) and a
        // deactivated user can't resurrect (users are host-authoritative, not in
        // PUSH_TABLES). Any NEW synced soft-delete flag must be added here too.
        if conflict == 0 && valid.contains("archived") {
            let incoming_active = matches!(data.get("archived"), Some(Value::Number(n)) if n.as_i64() == Some(0))
                || data.get("archived") == Some(&Value::Bool(false));
            if incoming_active {
                let local_archived: Option<i64> =
                    sqlx::query_scalar(&format!("SELECT archived FROM \"{table}\" WHERE sync_uuid = ?"))
                        .bind(&ch.sync_uuid)
                        .fetch_optional(&mut **tx)
                        .await?;
                if local_archived == Some(1) {
                    data.remove("archived");
                }
            }
        }
        // id / sync_uuid / created_at are immutable on update.
        let set_cols: Vec<&String> = data
            .keys()
            .filter(|k| k.as_str() != "sync_uuid" && k.as_str() != "created_at" && k.as_str() != "id")
            .collect();
        if set_cols.is_empty() {
            return Ok(RowOutcome::Applied);
        }
        let set_clause = set_cols.iter().map(|c| format!("\"{c}\"=?")).collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE \"{table}\" SET {set_clause} WHERE sync_uuid = ?");
        let mut q = sqlx::query(&sql);
        for c in &set_cols {
            q = bind_value(q, &data[*c]);
        }
        q = q.bind(ch.sync_uuid.clone());
        q.execute(&mut **tx).await?;
        Ok(RowOutcome::Applied)
    } else {
        let cols: Vec<&String> = data.keys().collect();
        let placeholders = vec!["?"; cols.len()].join(", ");
        let col_list = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        // users adopt the host id: UPSERT in place on the id (NOT INSERT OR
        // REPLACE, which is delete-then-insert and would CASCADE-delete the
        // replica's user_settings / other user-FK children). Other tables mint a
        // fresh local id.
        let sql = if keep_id {
            let set = cols
                .iter()
                .filter(|c| c.as_str() != "id")
                .map(|c| format!("\"{c}\"=excluded.\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO \"{table}\" ({col_list}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {set}")
        } else {
            format!("INSERT INTO \"{table}\" ({col_list}) VALUES ({placeholders})")
        };
        let mut q = sqlx::query(&sql);
        for c in &cols {
            q = bind_value(q, &data[*c]);
        }
        let new_id = q.execute(&mut **tx).await?.last_insert_rowid();
        cache.insert(format!("{table}:{}", ch.sync_uuid), new_id);
        // A row coming (back) into existence clears any tombstone for it, so a
        // resurrected row's death record can't re-propagate the delete.
        sqlx::query("DELETE FROM tombstones WHERE entity_type = ? AND sync_uuid = ?")
            .bind(table)
            .bind(&ch.sync_uuid)
            .execute(&mut **tx)
            .await?;
        // No id_remap for adopted users (the replica uses the host id directly).
        if keep_id {
            Ok(RowOutcome::Applied)
        } else {
            Ok(RowOutcome::Inserted(new_id))
        }
    }
}

/// The server's current row (as JSON) for a conflict report.
async fn server_conflict(
    db: &Db,
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    sync_uuid: &str,
    base_updated_at: Option<String>,
) -> Result<Value> {
    let obj = json_object_expr(db, table).await?;
    let row: Option<String> =
        sqlx::query_scalar(&format!("SELECT json_object({obj}) FROM \"{table}\" WHERE sync_uuid = ?"))
            .bind(sync_uuid)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(serde_json::json!({
        "entity": table,
        "sync_uuid": sync_uuid,
        "base_updated_at": base_updated_at,
        // Same shape as conflict_value so get_conflicts / the review UI never see
        // a null clashing_cols (wholesale conflict: no per-field resolution).
        "clashing_cols": Vec::<String>::new(),
        "base": Map::new(),
        "local": Map::new(),
        "server": row.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
    }))
}

/// Columns excluded from field-level merge — metadata, not user-editable fields.
fn is_merge_meta(col: &str) -> bool {
    matches!(col, "id" | "sync_uuid" | "updated_at" | "created_at" | "deleted_at")
}

/// 3-way field merge over the keys present in `mine`. Returns the columns where
/// only `theirs` diverged from the common ancestor `base` (to fold into the
/// merged row) and the columns both sides changed *differently* (true clashes).
fn three_way(
    base: &Map<String, Value>,
    mine: &Map<String, Value>,
    theirs: &Map<String, Value>,
) -> (Vec<(String, Value)>, Vec<String>) {
    let mut overrides = Vec::new();
    let mut clashes = Vec::new();
    for (col, mine_v) in mine {
        if is_merge_meta(col) {
            continue;
        }
        let theirs_v = match theirs.get(col) {
            Some(v) => v,
            None => continue, // column not on the other side; nothing to merge
        };
        let base_v = base.get(col).unwrap_or(&Value::Null);
        let mine_changed = mine_v != base_v;
        let theirs_changed = theirs_v != base_v;
        if !mine_changed && theirs_changed {
            overrides.push((col.clone(), theirs_v.clone())); // disjoint: take theirs
        } else if mine_changed && theirs_changed && mine_v != theirs_v {
            clashes.push(col.clone()); // both moved, different => true clash
        }
        // else: only mine changed / both equal / neither -> keep mine (already in data)
    }
    (overrides, clashes)
}

/// The target row (as a JSON object) within the apply transaction.
async fn row_map(
    db: &Db,
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    sync_uuid: &str,
) -> Result<Option<Map<String, Value>>> {
    let obj = json_object_expr(db, table).await?;
    let row: Option<String> =
        sqlx::query_scalar(&format!("SELECT json_object({obj}) FROM \"{table}\" WHERE sync_uuid = ?"))
            .bind(sync_uuid)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row.and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok()))
}

/// A self-contained field-level conflict for the review UI. `local`/`server` are
/// always from the replica's point of view (the side the UI runs on): in Push
/// `mine` is the replica's edit; in Ingest `mine` is the host's incoming row.
/// Full rows are carried (not just the clash) so `resolve_conflict` can adopt
/// the server row as the new ancestor and the UI can show context.
#[allow(clippy::too_many_arguments)]
fn conflict_value(
    table: &str,
    sync_uuid: &str,
    base_updated_at: Option<String>,
    base: &Map<String, Value>,
    mine: &Map<String, Value>,
    theirs: &Map<String, Value>,
    clashes: &[String],
    mode: Mode,
) -> Value {
    let (local, server) = if mode == Mode::Push { (mine, theirs) } else { (theirs, mine) };
    serde_json::json!({
        "entity": table,
        "sync_uuid": sync_uuid,
        "base_updated_at": base_updated_at,
        "clashing_cols": clashes,
        "base": base,
        "local": local,
        "server": server,
    })
}

/// Export the host's changes since `since` (empty = a full snapshot) as the dual
/// of `push`: `{ changes: [IncomingChange, …], cursor }`. Each row becomes an
/// `upsert` with its FK columns lifted into `fk_refs` (parent sync_uuids), so a
/// replica can feed the result straight back through the same apply engine and
/// remap into its own id-space. Host tombstones become `op:delete` rows.
///
/// `julianday(...)` on both sides keeps sub-second precision and parses the
/// mixed timestamp formats in the DB. The cursor is taken *before* the queries
/// so a row changed mid-pull is re-pulled next time rather than skipped.
pub async fn pull(db: &Db, since: &str) -> Result<Value> {
    let incremental = !since.trim().is_empty();
    // Z suffix (not +00:00) so the cursor is URL-safe in the next ?since=.
    let cursor = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    let mut changes: Vec<Value> = Vec::new();

    for &table in SYNC_TABLES {
        let cols = column_names(db, table).await?;
        if cols.is_empty() || !cols.iter().any(|c| c == "sync_uuid") {
            continue; // table absent / not yet sync-stamped
        }
        let (data_obj, fk_obj) = row_projection(db, table, &cols).await?;

        let where_clause = if incremental && cols.iter().any(|c| c == "updated_at") {
            "WHERE julianday(t.updated_at) > julianday(?)"
        } else {
            ""
        };
        let sql = format!(
            "SELECT json_object('entity','{table}','sync_uuid',t.sync_uuid,'op','upsert',\
             'data',{data_obj},'fk_refs',{fk_obj}) FROM \"{table}\" t {where_clause}"
        );
        let q = sqlx::query_scalar::<_, String>(&sql);
        let q = if where_clause.is_empty() { q } else { q.bind(since) };
        for s in q.fetch_all(db).await? {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                changes.push(v);
            }
        }
    }

    // Deletes — incremental only (a full snapshot has nothing to delete).
    if incremental {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT json_object('entity',entity_type,'sync_uuid',sync_uuid,'op','delete',\
             'base_updated_at',base_updated_at) FROM tombstones WHERE julianday(deleted_at) > julianday(?)",
        )
        .bind(since)
        .fetch_all(db)
        .await?;
        for s in &rows {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                changes.push(v);
            }
        }
    }

    Ok(serde_json::json!({ "changes": changes, "cursor": cursor }))
}

/// The `(data, fk_refs)` json_object SQL fragments for a table aliased `t`:
/// `data` is the row minus id (kept for users) / sync_uuid / push-FK columns;
/// `fk_refs` maps each push-FK column to the parent's sync_uuid. Shared by pull
/// (host -> wire) and local_pending (replica -> wire) so both sides agree.
async fn row_projection(db: &Db, table: &str, cols: &[String]) -> Result<(String, String)> {
    let fks: Vec<(String, String)> = sqlx::query_as("SELECT \"from\", \"table\" FROM pragma_foreign_key_list(?)")
        .bind(table)
        .fetch_all(db)
        .await?;
    let remap: std::collections::HashMap<&str, &str> = fks
        .iter()
        .filter(|(from, parent)| is_ident(from) && PUSH_TABLES.contains(&parent.as_str()))
        .map(|(from, parent)| (from.as_str(), parent.as_str()))
        .collect();

    // users are adopted by id (keep it); other tables mint a fresh local id.
    let strip_id = table != "users";
    let data_pairs: Vec<String> = cols
        .iter()
        .filter(|c| is_ident(c))
        .filter(|c| !(strip_id && c.as_str() == "id"))
        .filter(|c| c.as_str() != "sync_uuid") // carried as the top-level identity
        .filter(|c| !remap.contains_key(c.as_str()))
        .map(|c| format!("'{c}', t.\"{c}\""))
        .collect();
    let data_obj = format!("json_object({})", data_pairs.join(", "));

    let fk_obj = if remap.is_empty() {
        "json_object()".to_string()
    } else {
        let pairs: Vec<String> = remap
            .iter()
            .map(|(col, parent)| format!("'{col}', (SELECT sync_uuid FROM \"{parent}\" WHERE id = t.\"{col}\")"))
            .collect();
        format!("json_object({})", pairs.join(", "))
    };
    Ok((data_obj, fk_obj))
}

/// Collect the replica's pending changes to push to the host: dirty rows (as
/// upserts carrying their captured ancestor + base_updated_at) in dependency
/// order, then local deletes from `tombstones`. The dual of what the host's
/// `pull` produces, so the host applies it through the same engine.
pub async fn local_pending(db: &Db) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();

    for &table in PUSH_TABLES {
        let cols = column_names(db, table).await?;
        if cols.is_empty() || !cols.iter().any(|c| c == "sync_uuid") {
            continue;
        }
        let (data_obj, fk_obj) = row_projection(db, table, &cols).await?;
        // base_snapshot is the captured ancestor (NULL for a locally-born row).
        let sql = format!(
            "SELECT json_object('entity','{table}','sync_uuid',t.sync_uuid,'op','upsert',\
             'data',{data_obj},'fk_refs',{fk_obj},\
             'base_updated_at',json_extract(s.base_snapshot,'$.updated_at'),\
             'base',json(s.base_snapshot)) \
             FROM sync_state s JOIN \"{table}\" t ON t.rowid = s.row_id \
             WHERE s.entity_type = '{table}' AND s.dirty = 1"
        );
        for row in sqlx::query_scalar::<_, String>(&sql).fetch_all(db).await? {
            if let Ok(v) = serde_json::from_str::<Value>(&row) {
                out.push(v);
            }
        }
    }

    // Local deletes (replica-origin only — ingest is echo-guarded, so the host's
    // deletes never land here). users are never pushed.
    let placeholders = PUSH_TABLES.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let del_sql = format!(
        "SELECT json_object('entity',entity_type,'sync_uuid',sync_uuid,'op','delete',\
         'base_updated_at',base_updated_at) FROM tombstones WHERE entity_type IN ({placeholders})"
    );
    let mut q = sqlx::query_scalar::<_, String>(&del_sql);
    for &t in PUSH_TABLES {
        q = q.bind(t);
    }
    for row in q.fetch_all(db).await? {
        if let Ok(v) = serde_json::from_str::<Value>(&row) {
            out.push(v);
        }
    }

    Ok(out)
}

/// One row the host confirmed it applied, fed back to settle local bookkeeping.
#[derive(serde::Deserialize)]
pub struct AckItem {
    pub entity: String,
    pub sync_uuid: String,
    #[serde(default = "default_op")]
    pub op: String,
    /// The row's updated_at at collect time — compare-and-clear guards against a
    /// local edit slipped in between collect and ack.
    #[serde(default)]
    pub pushed_updated_at: Option<String>,
}

/// Settle local state after a successful push: for confirmed upserts, clear
/// `dirty` and refresh the ancestor to the now-agreed row — but only if the row
/// hasn't been edited since it was collected (else it stays dirty for the next
/// sync). For confirmed deletes, drop the tombstone. Run in one transaction.
pub async fn ack(db: &Db, items: Vec<AckItem>) -> Result<()> {
    let mut tx = db.begin().await?;
    for item in &items {
        let table = item.entity.as_str();
        if !PUSH_TABLES.contains(&table) {
            continue;
        }
        if item.op == "delete" {
            sqlx::query("DELETE FROM tombstones WHERE entity_type = ? AND sync_uuid = ?")
                .bind(table)
                .bind(&item.sync_uuid)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        let rid: Option<i64> = sqlx::query_scalar(&format!("SELECT rowid FROM \"{table}\" WHERE sync_uuid = ?"))
            .bind(&item.sync_uuid)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(rid) = rid {
            let obj = json_object_expr(db, table).await?;
            // Clear + refresh the ancestor only if updated_at is unchanged since collect.
            sqlx::query(&format!(
                "UPDATE sync_state SET dirty = 0, \
                 base_snapshot = (SELECT json_object({obj}) FROM \"{table}\" WHERE rowid = ?1) \
                 WHERE entity_type = ?2 AND row_id = ?1 \
                 AND (SELECT updated_at FROM \"{table}\" WHERE rowid = ?1) IS ?3"
            ))
            .bind(rid)
            .bind(table)
            .bind(&item.pushed_updated_at)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Persist field-level conflicts (from either direction) for the review UI.
pub async fn record_conflicts(db: &Db, conflicts: Vec<Value>) -> Result<()> {
    let mut tx = db.begin().await?;
    for c in &conflicts {
        let sync_uuid = c.get("sync_uuid").and_then(|v| v.as_str()).unwrap_or_default();
        if sync_uuid.is_empty() {
            continue;
        }
        let entity = c.get("entity").and_then(|v| v.as_str()).unwrap_or_default();
        let as_text = |k: &str| c.get(k).map(|v| v.to_string());
        sqlx::query(
            "INSERT OR REPLACE INTO sync_conflicts \
             (sync_uuid, entity, base_json, local_json, server_json, clashing_cols, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
        )
        .bind(sync_uuid)
        .bind(entity)
        .bind(as_text("base"))
        .bind(as_text("local"))
        .bind(as_text("server"))
        .bind(as_text("clashing_cols"))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The pending conflicts for the review UI (base/local/server/clashing_cols).
pub async fn get_conflicts(db: &Db) -> Result<Vec<Value>> {
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, Option<String>, String)> =
        sqlx::query_as(
            "SELECT sync_uuid, entity, base_json, local_json, server_json, clashing_cols, created_at \
             FROM sync_conflicts ORDER BY created_at",
        )
        .fetch_all(db)
        .await?;
    let parse = |s: Option<String>| s.and_then(|x| serde_json::from_str::<Value>(&x).ok()).unwrap_or(Value::Null);
    Ok(rows
        .into_iter()
        .map(|(uuid, entity, base, local, server, clash, created)| {
            serde_json::json!({
                "sync_uuid": uuid,
                "entity": entity,
                "base": parse(base),
                "local": parse(local),
                "server": parse(server),
                "clashing_cols": parse(clash),
                "created_at": created,
            })
        })
        .collect())
}

/// Apply the user's chosen resolution for a conflict, then clear it. The
/// resolved field values are written to the local row with a fresh updated_at,
/// the row is marked dirty, and its ancestor is set to the server row that
/// conflicted — so the next push carries the decision and wins the LWW gate
/// (re-conflicting only if the host moved again since). One transaction.
pub async fn resolve_conflict(db: &Db, sync_uuid: &str, resolved: Map<String, Value>) -> Result<()> {
    let mut tx = db.begin().await?;
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT entity, server_json FROM sync_conflicts WHERE sync_uuid = ?")
            .bind(sync_uuid)
            .fetch_optional(&mut *tx)
            .await?;
    let (entity, server_json) = match row {
        Some(r) => r,
        None => {
            tx.commit().await?;
            return Ok(());
        }
    };
    if !PUSH_TABLES.contains(&entity.as_str()) {
        sqlx::query("DELETE FROM sync_conflicts WHERE sync_uuid = ?").bind(sync_uuid).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(());
    }

    let valid: std::collections::HashSet<String> =
        column_names(db, &entity).await?.into_iter().filter(|c| is_ident(c)).collect();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    let mut data = resolved;
    data.retain(|k, _| valid.contains(k) && k != "id" && k != "sync_uuid" && k != "created_at");
    data.insert("updated_at".to_string(), Value::from(now.clone()));

    // Suppress capture so we control sync_state precisely (dirty + server ancestor).
    sqlx::query("UPDATE _sync_ctl SET value='1' WHERE key='applying'").execute(&mut *tx).await?;
    if !data.is_empty() {
        let set_cols: Vec<&String> = data.keys().collect();
        let set_clause = set_cols.iter().map(|c| format!("\"{c}\"=?")).collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE \"{entity}\" SET {set_clause} WHERE sync_uuid = ?");
        let mut q = sqlx::query(&sql);
        for c in &set_cols {
            q = bind_value(q, &data[*c]);
        }
        q = q.bind(sync_uuid);
        q.execute(&mut *tx).await?;
    }
    let rid: Option<i64> = sqlx::query_scalar(&format!("SELECT rowid FROM \"{entity}\" WHERE sync_uuid = ?"))
        .bind(sync_uuid)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(rid) = rid {
        sqlx::query(
            "INSERT INTO sync_state(entity_type,row_id,sync_uuid,updated_at,deleted,dirty,base_snapshot) \
             VALUES(?1,?2,?3,?4,0,1,?5) \
             ON CONFLICT(entity_type,row_id) DO UPDATE SET dirty=1, updated_at=?4, base_snapshot=?5",
        )
        .bind(&entity)
        .bind(rid)
        .bind(sync_uuid)
        .bind(&now)
        .bind(&server_json)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE _sync_ctl SET value='0' WHERE key='applying'").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sync_conflicts WHERE sync_uuid = ?").bind(sync_uuid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// At-a-glance replica sync state (counts are 0 where the bookkeeping tables are
/// absent, e.g. on a Server-role DB).
pub async fn status(db: &Db) -> Result<Value> {
    let count = |sql: &'static str| async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(db).await.unwrap_or(0) };
    Ok(serde_json::json!({
        "dirty_count": count("SELECT COUNT(*) FROM sync_state WHERE dirty=1").await,
        "tombstone_count": count("SELECT COUNT(*) FROM tombstones").await,
        "conflict_count": count("SELECT COUNT(*) FROM sync_conflicts").await,
    }))
}
