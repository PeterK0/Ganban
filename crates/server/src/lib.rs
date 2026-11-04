//! Ganban HTTP daemon as a library.
//!
//! A thin `axum` layer over `ganban_core`: feature routes (files, chat, Atlas,
//! AI, …) plus `/invoke`, which runs any command of the one command table
//! (`commands`, ADR 0001), the same table the desktop app runs in-process.
//!
//! `router(db)` builds the app so it can be served either by the standalone
//! `ganban-server` binary (headless) OR in-process by the desktop app, which
//! serves its own DB pool so a phone can pair with the desktop over the tailnet.
//!
//! No auth (trusted Tailscale tailnet only — never port-forward to the public
//! internet); CORS permissive (clients issue cross-origin `fetch`).

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts, Path, Query, State},
    http::{header, request::Parts, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use async_stream::stream;
use futures_util::{Stream, StreamExt};
use ganban_core::auth;
use ganban_core::error::AppError;
use ganban_core::models::*;
use ganban_core::storage::{self, StorageRoot};
use ganban_core::{ops, visibility, Db};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// The built web app (touch UI), served to browsers over the tailnet. In dev
/// this checkout path is served from disk (a vite rebuild applies live, no
/// recompile); shipped binaries can't rely on it — the build machine's path
/// means nothing elsewhere — so release builds embed dist/ at compile time
/// (feature `embed-web`, enabled by the desktop shell). `GANBAN_WEB_DIR`
/// overrides both.
const WEB_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../dist");

#[cfg(feature = "embed-web")]
static WEB_EMBED: include_dir::Dir<'static> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../dist");

/// One shareable file slot (an APK or a desktop installer). A plain std Mutex:
/// only ever held briefly, never across await.
pub type SharedApk = Arc<Mutex<Option<PathBuf>>>;

/// Native builds the host offers for download, one slot per platform. The
/// `/download` page auto-offers the one matching the visitor's OS.
#[derive(Clone, Default)]
pub struct Shares {
    pub android: SharedApk,
    pub windows: SharedApk,
    pub macos: SharedApk,
    pub linux: SharedApk,
    /// The standalone headless ganban-server build (self-host). A download
    /// category, not a desktop auto-update target (a server has no client UA).
    pub server: SharedApk,
}

/// Write proposals are DURABLE rows (`ganban_core::proposals`,
/// MEMBER_AGENTS.md prerequisite 1): a restart or eviction must not eat
/// pending work. Consume-once semantics unchanged — resolution deletes the
/// row, and that deletion is the double-submit guard. Who may resolve is the
/// project's approval policy ('proposer' default | 'owner'); both identities
/// land on the ledger row (user_id = proposer, approver_id = resolver).

impl Shares {
    /// The slot for a platform key (`android` | `windows` | `macos` | `linux` | `server`).
    pub fn slot(&self, kind: &str) -> Option<&SharedApk> {
        match kind {
            "android" => Some(&self.android),
            "windows" => Some(&self.windows),
            "macos" => Some(&self.macos),
            "linux" => Some(&self.linux),
            "server" => Some(&self.server),
            _ => None,
        }
    }
}

/// All platform keys with their human labels, in display order.
pub const BUILD_KINDS: [(&str, &str); 5] =
    [("android", "Android"), ("windows", "Windows"), ("macos", "macOS"), ("linux", "Linux"), ("server", "Server (self-host)")];

/// Bind a TCP listener at `addr` (so callers can surface "port in use" before
/// spawning the server task).
pub async fn bind(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(addr).await
}

mod agent_work;

/// Serve the router on `listener` until `shutdown` resolves. Lets the desktop
/// app host the daemon in-process with graceful stop, and the standalone binary
/// serve forever (`std::future::pending()`).
#[cfg(feature = "tab-email")]
mod email;
mod events;
#[cfg(feature = "tab-email")]
mod email_oauth;
mod finance_rates;
mod finance_tools;
mod finance_reminder;
mod foldersync;
mod hostmon;
mod maptiles;
mod net_guard;
// Tabs whose host side lives in one optional file, compiled in when the file is
// there (build.rs sets the cfg): a build can carry tabs the public tree doesn't.
#[cfg(extra_tabs)]
mod extra_tabs;
// Public so the desktop shell's `daemon_*` Tauri commands and the daemon's
// /invoke surface share one build-discovery implementation (remote admins too).
pub mod builds;
// The one command table (ADR 0001): every /invoke command, its access rule,
// result filter, authorship field and handler. The desktop shell runs it
// in-process through `run_in_process`.
mod commands;
pub use commands::run_in_process;
mod diagnostics;
mod librarian;
mod delegate;
mod demo;
// Public so the desktop shell + standalone daemon both initialize logging.
pub mod logging;
pub use logging::init_logging;
mod ollama;
mod oracle_run;
mod pi_rpc;
mod pi_sandbox;
mod rag;
mod rules;
// Public so the desktop shell's Tauri commands can drive auto-share locally
// (the same logic the daemon's /invoke surface exposes for remote admins).
pub mod tailscale;
mod routines;
mod secretary;
// Share links and the share door (ADR 0006).
mod share;
// Client updates from the host (ADR 0007): the /updates routes and the host-update commands.
pub mod updates;
mod tabs;
mod tools;

pub async fn serve(
    listener: tokio::net::TcpListener,
    db: Db,
    shares: Shares,
    storage_root: PathBuf,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    bootstrap(&db).await;
    // One-time data migration (Epoch R.1): legacy `ai_routing` entries become
    // version-1 manual protocols in the authoritative table. Idempotent — a
    // slug that already exists is never touched (the user's explicit state,
    // including a deliberate deactivation, wins over the legacy mirror).
    migrate_routing_to_protocols(&db).await;
    // Optional RAG sidecar (ragrat). Enabled only when GANBAN_RAGRAT_URL is set;
    // when on, a background poller keeps each project's corpus fresh.
    // Connection config is DB-backed (written by the owner from Settings), so the
    // headless host reads what the desktop UI wrote; env is a migration fallback.
    // Held behind RwLocks so POST /ai/reload can re-read it live (no restart).
    use std::sync::Arc;
    use tokio::sync::RwLock;
    // Background workers (RAG poller, routine runner) are tied to THIS daemon's
    // lifetime via a watch channel: when the daemon stops — gracefully or by
    // the serve future ending — they exit too. Otherwise every restart or
    // loopback→tailnet upgrade leaks a second set of workers (observed as
    // double rundown runs and ingest calls to a dead ragrat port).
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let shutdown = async move {
        shutdown.await;
        let _ = stop_tx.send(true);
        // stop_tx drops here either way — a dropped sender also stops workers.
    };
    let rag: rag::SharedRag = Arc::new(RwLock::new(rag::RagConfig::from_db(&db).await.map(rag::RagClient::new)));
    if let Some(c) = rag.read().await.as_ref() {
        tracing::info!("RAG: ragrat sidecar enabled at {}", c.config().base_url);
    }
    rag::spawn_poller(db.clone(), rag.clone(), storage_root.clone(), stop_rx.clone());
    // Local model engine for the assistant. Always present (default localhost
    // Ollama); reachability is a runtime concern surfaced per request.
    let ollama: ollama::SharedOllama =
        Arc::new(RwLock::new(Some(ollama::OllamaClient::new(ollama::OllamaConfig::from_db(&db).await))));
    // Catch-up routine runner: shortly after launch (and periodically while
    // running), execute any routine whose "last run older than N hours" trigger
    // is due — the embedded-app-native version of a schedule.
    routines::spawn_runner(db.clone(), rag.clone(), ollama.clone(), stop_rx.clone());
    // Finance translations that miss the rates cache fetch the ECB feed on demand.
    finance_rates::register_on_demand();
    // Finance's weekly bank-import reminder (a host-local "Mon 09:00" per user).
    finance_reminder::spawn(db.clone(), stop_rx.clone());
    // Oracle schedule triggers: LIVE workflows with a parseable cadence run on
    // the host's clock (60s scheduler; paused workflows never fire).
    // A 'running' workflow run cannot have survived the restart we just did —
    // reconcile zombies before the scheduler starts anything new.
    {
        let db = db.clone();
        tokio::spawn(async move {
            let _ = ganban_core::workflows::reconcile_interrupted(&db).await;
        });
    }
    oracle_run::spawn_scheduler(db.clone(), ollama.clone(), storage_root.clone(), stop_rx.clone());
    // Host health sampler: 30s load/space/db-size rows, 7-day retention.
    hostmon::mark_started();
    hostmon::spawn_sampler(db.clone(), storage_root.clone(), stop_rx.clone());
    // Schedule-triggered rules (Settings › Automations): notify on a cadence.
    rules::spawn_schedule_runner(db.clone(), stop_rx.clone());
    // Atlas Library auto-index (opt-in per collection, quiet-period debounced).
    spawn_atlas_autoingest(db.clone(), rag.clone(), stop_rx.clone());
    // Folder sync: import from locally-mirrored cloud folders (Plug-ins card).
    foldersync::spawn_poller(db.clone(), storage_root.clone(), stop_rx.clone());
    // Email envelope sync (feature tab-email): the owner's mailboxes, selective.
    #[cfg(feature = "tab-email")]
    email::spawn_sync(db.clone(), stop_rx.clone());
    // Automations (M(a)): register the domain-event sink + drain task so rules
    // fire on writes through this process. Registered once (process-lifetime),
    // so a daemon restart is a no-op here — no re-subscribe race.
    rules::spawn_engine(db.clone());
    // The share door (ADR 0006): a second listener on GANBAN_SHARE_ADDR, if set, that
    // serves only share links. It stops with this daemon.
    {
        let mut stop = stop_rx.clone();
        share::start(db.clone(), storage_root.clone(), async move {
            let _ = stop.wait_for(|stopped| *stopped).await;
        })
        .await;
    }
    drop(stop_rx);
    // Freshness push hub (G3): writes pulse, clients refetch. Created here (not
    // in router()) so background workers can someday publish too.
    let hub = events::EventHub::new();
    // ConnectInfo is needed so the auth layer can treat loopback as the owner.
    let app = router(db, shares, storage_root, rag, ollama, hub).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await
}

/// Legacy `ai_routing` → protocols-table migration (PROTOCOLS.md §2: "v1
/// ai_routing entries migrate as version-1 protocols with trigger: manual").
/// Runs at every startup; a slug already present in the table is skipped, so
/// this is a one-time copy per task class, not a sync.
pub(crate) async fn migrate_routing_to_protocols(db: &Db) {
    let Some(raw) = ops::get_app_setting(db, "ai_routing").await.ok().flatten() else { return };
    let Ok(table) = serde_json::from_str::<serde_json::Map<String, Value>>(&raw) else { return };
    for (class, entry) in table {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM protocols WHERE slug = ?")
            .bind(&class)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        if exists.is_some() {
            continue;
        }
        // Legacy int = ollama + profile_id; object = the frozen v1 contract.
        let (runner, profile_id, model) = if let Some(pid) = entry.as_i64() {
            ("ollama".to_string(), Some(pid), None)
        } else if entry.is_object() {
            (
                entry.get("runner").and_then(Value::as_str).unwrap_or("ollama").to_string(),
                entry.get("profile_id").and_then(Value::as_i64),
                entry.get("model").and_then(Value::as_str).map(String::from),
            )
        } else {
            continue;
        };
        let fm = json!({
            "protocol": 1,
            "task_class": class,
            "trigger": { "kind": "manual" },
            "engine": { "runner": runner, "profile_id": profile_id, "model": model },
        })
        .to_string();
        match ganban_core::protocols::upsert_protocol_version(db, &class, &format!("{class} routing"), &fm, "", None, true).await {
            Ok((_, v, _)) => tracing::info!("migrated ai_routing['{class}'] → protocol '{class}' v{v}"),
            Err(e) => tracing::warn!("could not migrate ai_routing['{class}'] to a protocol: {e}"),
        }
    }
}

/// Ensure an owner exists and, on first auth setup (owner has no enrolled
/// device), mint + print a one-time owner enrollment token.
async fn bootstrap(db: &Db) {
    match auth::bootstrap(db).await {
        Ok(Some(token)) => {
            // Deliberately `println!`, not `tracing`: this is one-time operator
            // console UX for the standalone daemon, and we keep the secret token
            // OUT of the persisted log file.
            println!("\n========================================================");
            println!(" Ganban owner enrollment token (one-time, valid ~24h):");
            println!("   {token}");
            println!(" Enroll your owner device with POST /enroll {{\"token\": ...}}");
            println!("========================================================\n");
        }
        Ok(None) => {}
        Err(e) => tracing::error!("auth bootstrap failed: {e}"),
    }
}

/// Build the daemon's axum router over the given database pool. `apk` holds an
/// optional path to an Android APK the host offers for phone download.
pub fn router(
    db: Db,
    shares: Shares,
    storage_root: PathBuf,
    rag: rag::SharedRag,
    ollama: ollama::SharedOllama,
    hub: events::EventHub,
) -> Router {
    // Ephemeral, process-global store of pending (unapproved) write proposals.
    // In-flight email OAuth sign-ins (browser dances), keyed by flow id.
    #[cfg(feature = "tab-email")]
    let oauth_flows: email_oauth::SharedFlows = Arc::new(email_oauth::OAuthFlows::default());
    let router = Router::new()
        .route("/health", get(health))
        // Approval policy (MEMBER_AGENTS.md prereq 3): who resolves this
        // project's agent proposals — 'proposer' (default) or 'owner'.
        .route("/projects/:id/approval-policy", get(approval_policy_get_handler).put(approval_policy_set_handler))
        .route("/snapshot", get(snapshot))
        // Auth: enrollment is public (consumes a token); /me needs a device token.
        .route("/enroll", post(enroll_handler))
        .route("/me", get(me_handler))
        // Freshness push (G3): coarse "something changed" pulses, no payloads.
        .route("/events/stream", get(events_stream_handler))
        // The hosting desktop's local-mode writes bypass HTTP (Tauri → ops
        // directly), so its UI reports them here — otherwise phones never
        // hear about the primary writer's edits.
        .route("/events/pulse", post(events_pulse_handler))
        // Commands: { command, args } -> the one command table (ADR 0001).
        // This is how the mobile/desktop/web clients reach data.
        .route("/invoke", post(invoke_handler))
        // Shared-file storage: upload (raw body) + download a project's shared files.
        .route("/files/upload", post(upload_file))
        .route("/files/:id", get(download_file).delete(attachment_delete))
        // Project-level files (the project "drop zone") — host-stored.
        .route("/projects/:id/files", get(project_files_list))
        .route("/projects/:id/files/audit", get(project_files_audit))
        .route("/projects/:id/files/clear-missing", post(project_files_clear_missing))
        .route("/projects/:id/files/share-local", post(project_files_share_local))
        .route("/projects/files/:fid/assign", post(project_file_assign))
        .route("/files/:id/unassign", post(attachment_unassign))
        .route("/files/:id/share", post(attachment_share))
        .route("/projects/files/:fid/restore", post(project_file_restore))
        .route("/files/:id/restore", post(attachment_restore))
        .route("/projects/:id/files/upload", post(project_file_upload))
        .route("/projects/files/:fid", axum::routing::delete(project_file_delete).patch(project_file_rename))
        .route("/projects/:id/folders", get(project_folders_list).post(project_folder_create))
        .route("/projects/:id/files/move", post(project_files_move))
        .route("/projects/files/:fid/download", get(project_file_download))
        // Shared task attachments aggregated for a project's central file view.
        .route("/projects/:id/attachments", get(project_attachments_list))
        // Event files: an admin uploads (raw body), a member who sees the event downloads.
        .route("/event-files/upload", post(event_file_upload))
        .route("/event-files/:id", get(event_file_download))
        // Offline sync (owner-only): pull the host's changed rows for a replica,
        // and push a replica's offline edits back (with conflict detection + id remap).
        .route("/sync/pull", get(sync_pull))
        .route("/sync/push", post(sync_push))
        // RAG (ragrat sidecar): semantic search scoped to a project the caller can
        // access; owner-only on-demand re-index. No-ops (404) when RAG is disabled.
        .route("/search", post(search_handler))
        .route("/ai/facets", get(facets_handler))
        .route("/reindex", post(reindex_handler))
        // AI assistant: per-project RAG chat (SSE stream) + thread history.
        .route("/chat", post(chat_handler))
        .route("/chats", get(list_chats_handler))
        .route("/chats/:id/messages", get(chat_messages_handler))
        .route("/chats/:id/publish", post(chat_set_public))
        .route("/chats/:id/pin", post(chat_set_pinned))
        // Atlas (Epoch I): shared knowledge collections no project owns.
        // Registry reads + facets/search/document are member-level (Atlas is
        // workspace knowledge); registration/ingest is owner-only. Read routes
        // take the registry SLUG, never a raw collection name — so they can
        // never be pointed at a project's corpus.
        .route("/atlas/collections", get(atlas_list_handler).post(atlas_create_handler))
        .route("/atlas/collections/:id", axum::routing::delete(atlas_delete_handler))
        .route("/atlas/collections/:id/reingest", post(atlas_reingest_handler))
        .route("/atlas/collections/:id/visibility", post(atlas_visibility_handler))
        // The Library (Atlas › Library): managed collection folders the owner
        // uploads into; indexing is EXPLICIT (or opt-in auto with a debounce).
        .route("/atlas/collections/:id/files", get(atlas_files_list_handler).post(atlas_file_upload_handler).delete(atlas_file_delete_handler))
        .route("/atlas/collections/:id/auto-index", post(atlas_auto_index_handler))
        // File flows across surfaces: project blobs ⇄ Library folders, and the
        // owner-granted member export (files → a member's OWN Atlas).
        .route("/atlas/collections/:id/import-project-file", post(atlas_import_project_file_handler))
        .route("/projects/:id/import-atlas-file", post(project_import_atlas_file_handler))
        .route("/projects/:id/member-atlas-export", get(member_atlas_export_get_handler).put(member_atlas_export_set_handler))
        .route("/atlas/facets", get(atlas_facets_handler))
        .route("/atlas/manifest", get(atlas_manifest_handler))
        .route("/atlas/report", get(atlas_report_handler))
        .route("/atlas/search", post(atlas_search_handler))
        .route("/atlas/document", get(atlas_document_handler))
        // A project tab's saved configuration (e.g. the Atlas tab's filters).
        .route("/projects/:id/tabs/:tab_id/config", get(project_tab_config_handler).put(project_tab_config_set_handler))
        .route("/projects/:id/tabs/:tab_id/state", get(tab_user_state_handler).put(tab_user_state_set_handler))
        .route("/projects/:id/tabs/:tab_id/scores", get(tab_scores_handler).post(tab_scores_post_handler))
        .route("/projects/:id/ai-files", post(project_ai_files_handler))
        // GIF search proxy: the GIPHY key is an owner-only app_setting that
        // never leaves the host — members get search results, not the secret.
        .route("/giphy/search", get(giphy_search_handler))
        // Map imagery (satellite / ocean / labels) for map surfaces: a caching
        // proxy to the owner-chosen provider. Any enrolled device may read;
        // provider + key are owner-only app_settings (see maptiles.rs).
        .route("/tiles/config", get(tiles_config_handler))
        .route("/tiles/:layer/:z/:x/:y", get(tile_handler))
        // Two-stage thread deletion: bin (restorable) → purge (only from the bin).
        .route("/chats/binned", get(chats_binned_handler))
        .route("/chats/:id/bin", post(chat_bin_handler))
        .route("/chats/:id/restore", post(chat_restore_handler))
        .route("/chats/:id", axum::routing::delete(chat_purge_handler))
        // The "secretary" (owner-only): a grounded, cross-project daily assistant.
        // brief = deterministic facts (no LLM); chat = ephemeral grounded SSE
        // stream; rundown = read the latest / regenerate today's per-project digest.
        .route("/secretary/brief", get(secretary_brief_handler))
        .route("/secretary/chat", post(secretary_chat_handler))
        .route("/system/stats", get(hostmon::stats_handler))
        .route("/secretary/rundown", get(rundown_latest_handler).post(rundown_generate_handler))
        // Agent tool layer: execute a write the assistant proposed, on approval.
        .route("/tools/execute", post(tool_execute_handler))
        .route("/tools/reject", post(tool_reject_handler))
        .route("/tools/proposals", get(tool_proposals_handler))
        // Tool inspector: the catalog of agent tools this build offers (+ the
        // knowledge engine's status for the owner). Read-only; executes nothing.
        .route("/tools/catalog", get(tools_catalog_handler))
        // Declarative tool registry (owner-only management).
        .route("/tools/registry", get(registry_list_handler).post(registry_create_handler))
        .route("/tools/registry/:id", axum::routing::delete(registry_delete_handler))
        .route("/tools/registry/:id/enabled", axum::routing::put(registry_enabled_handler))
        .route("/tools/registry/bindings", get(registry_bindings_handler))
        // Connector secrets (owner-only): names listed; values are write-only.
        .route("/ai/connector-secrets", get(connector_secrets_list_handler).put(connector_secret_set_handler))
        .route("/ai/connector-secrets/:name", axum::routing::delete(connector_secret_delete_handler))
        .route("/agent/actions", get(agent_actions_handler))
        // Protocols (Epoch R): the artifact surface. List + lifecycle + the
        // R.2 dry-run harness (fixture engine check, cost-metered).
        .route("/ai/protocols", get(protocols_list_handler).post(protocol_create_handler))
        .route("/ai/protocols/gallery", get(protocol_gallery_handler))
        .route("/ai/protocols/:slug/dry-run", post(protocol_dry_run_handler))
        .route("/ai/protocols/:slug/activate", post(protocol_activate_handler))
        .route("/ai/protocols/:slug/deactivate", post(protocol_deactivate_handler))
        // Demonstration synthesis (R.4 Phase A): recording → protocol DRAFT.
        .route("/ai/demo/synthesize", post(demo_synthesize_handler))
        // Oracle — the Assistant's workflow builder (owner-only automations).
        .route("/ai/oracle", get(oracle_list_handler).post(oracle_create_handler))
        .route("/ai/oracle/:id", axum::routing::put(oracle_update_handler).delete(oracle_delete_handler))
        .route("/ai/oracle/:id/run", post(oracle_run_handler))
        .route("/ai/oracle/:id/cancel", post(oracle_cancel_handler))
        .route("/ai/oracle/active", get(oracle_active_handler))
        .route("/ai/oracle/runs", get(oracle_runs_handler))
        // Owner-only diagnostics bundle for the bug reporter (read-only,
        // redacted): versions, platform, log tails, slim ledger.
        .route("/diagnostics", get(diagnostics_handler))
        // Owner-only: download a full (redacted) host log file.
        .route("/diagnostics/log", get(diagnostics_log_handler))
        .route("/routines", get(routines_list_handler))
        .route("/routines/:id/run", post(routine_run_handler))
        .route("/sync-folders", get(sync_folders_list).post(sync_folders_create))
        .route("/sync-folders/:id", axum::routing::patch(sync_folders_patch).delete(sync_folders_delete))
        .route("/sync-folders/:id/run", post(sync_folders_run))
        .route("/tabs", get(tabs_available_handler))
        .route("/projects/:id/tabs", get(project_tabs_handler).put(project_tabs_set_handler))
        // Emoji reactions on comments (member-scoped).
        .route("/comments/:id/react", post(comment_react_handler))
        .route("/tasks/:id/reactions", get(task_reactions_handler))
        .route("/projects/:id/reactions", get(project_reactions_handler))
        .route("/emoji", get(custom_emoji_list_handler).post(custom_emoji_create_handler))
        .route("/emoji/:id", axum::routing::delete(custom_emoji_delete_handler))
        // Owner-only imported calendars: manage external ICS/webcal feeds and
        // sync their events into the (synced) events table, tagged + unallocated.
        .route("/calendar/subscriptions", get(calendar_list).post(calendar_create))
        .route("/calendar/subscriptions/:id", axum::routing::delete(calendar_delete))
        .route("/calendar/subscriptions/:id/sync", post(calendar_sync))
        // Owner-only: test a candidate ragrat/Ollama connection from Settings
        // (run server-side — the host's loopback engines aren't reachable from a
        // remote client). Also lists Ollama models for the Settings pickers.
        .route("/ai/test", post(ai_test_handler))
        // Owner-only model management: pull a model (SSE progress), probe an
        // embedding model's dimensions, and re-embed all projects after a change.
        .route("/ai/pull", post(ai_pull_handler))
        .route("/ai/embed-test", post(ai_embed_test_handler))
        .route("/ai/reembed", post(ai_reembed_handler))
        // Owner-only model profiles (personalities): list / upsert / delete /
        // set-active.
        .route("/ai/profiles", get(ai_profiles_handler).post(ai_profile_upsert_handler))
        .route("/ai/profiles/:id", axum::routing::delete(ai_profile_delete_handler))
        // Loadouts (owner-only): named tool/prompt/sub-model bundles + which
        // personality carries them.
        .route("/ai/loadouts", get(loadouts_list_handler).post(loadout_create_handler))
        .route("/ai/loadouts/:id", axum::routing::put(loadout_update_handler).delete(loadout_delete_handler))
        .route("/ai/profiles/:id/loadouts", get(profile_loadouts_handler).put(profile_loadouts_set_handler))
        .route("/ai/active-profile", post(ai_active_profile_handler))
        .route("/ai/secretary-profile", post(ai_secretary_profile_handler))
        .route("/ai/routing", post(ai_routing_handler))
        .route("/ai/agent-task", post(agent_task_handler))
        .route("/ai/agent-task/:id", get(agent_task_status_handler))
        .route("/ai/ocr", post(ocr_handler))
        .route("/ai/model-info", get(ai_model_info_handler))
        .route("/ai/models", get(ai_models_handler))
        // Indexing queue: the ragrat ingest jobs, scoped to projects the caller
        // can see (owner sees all). Powers the Assistant's Indexing tab.
        .route("/ai/jobs", get(ai_jobs_handler))
        .route("/ai/jobs/:id", get(ai_job_get_handler))
        .route("/ai/jobs/:id/cancel", post(ai_job_cancel_handler))
        // Owner-only: re-read the ragrat/Ollama connection from settings live, so
        // an AI Engines change applies without a daemon restart.
        .route("/ai/reload", post(ai_reload_handler))
        // App downloads (served only while the desktop is sharing the file).
        .route("/download", get(download_page))
        .route("/download/:kind", get(download_build))
        // Client updates (ADR 0007): the Tauri updater's check and bundle, and the phone's APK.
        // A device token (header or ?token=), loopback = the owner.
        .route("/updates/desktop/:target/:arch/:last", get(updates::desktop_route))
        .route("/updates/android/apk", get(updates::android_apk_route));
    // The email tab's routes exist only when its feature is compiled in.
    #[cfg(feature = "tab-email")]
    let router = router
        .route("/email/accounts", get(email_accounts_list).post(email_accounts_create))
        .route("/email/accounts/test", post(email_account_test))
        .route(
            "/email/accounts/:id",
            axum::routing::patch(email_account_patch).delete(email_account_delete),
        )
        .route("/email/accounts/:id/sync", post(email_account_sync))
        .route("/email/oauth/begin", post(email_oauth_begin))
        .route("/email/oauth/poll/:flow_id", get(email_oauth_poll))
        .route("/email/threads/unlinked", get(email_threads_unlinked))
        .route("/email/threads/:id/link", post(email_thread_link))
        .route("/email/threads/:id/messages", get(email_thread_messages))
        .route("/projects/:id/email/threads", get(project_email_threads))
        .layer(Extension(oauth_flows));
    // Anything else → the built touch UI, SPA-fallback to index.html, so a
    // browser over the tailnet can use Ganban with no install. A directory on
    // disk (GANBAN_WEB_DIR, else the dev checkout's dist/) wins; otherwise the
    // copy embedded at compile time serves it.
    let web_dir = std::env::var("GANBAN_WEB_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| Some(PathBuf::from(WEB_DIR)).filter(|p| p.is_dir()));
    let router = match web_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            router.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)))
        }
        None => router.fallback(embedded_web),
    };
    router
        // Cache policy for the web UI (see web_cache_mw): the shell always
        // revalidates, hashed assets never do. Without it, ServeDir sent no
        // Cache-Control and a phone kept yesterday's index.html for hours after
        // `npm run build` — "the option you described isn't there".
        .layer(axum::middleware::from_fn(web_cache_mw))
        .layer(Extension(shares))
        .layer(Extension(StorageRoot(storage_root)))
        .layer(Extension(rag))
        .layer(Extension(ollama))
        // After any successful mutating request on a data route, pulse the hub.
        // Never touches bodies, so the SSE/chat streams pass through untouched.
        .layer(axum::middleware::from_fn_with_state(hub.clone(), pulse_mw))
        // Request count/latency counters for /system/stats (bodies untouched).
        .layer(axum::middleware::from_fn(hostmon::track_mw))
        .layer(Extension(hub))
        .layer(CorsLayer::permissive())
        .with_state(db)
}

/// Cache-Control for what the host serves to browsers. Vite names assets by
/// content hash (`/assets/index-Ab12Cd.js`), so those may be cached forever;
/// everything that POINTS at them — index.html (and every SPA route that falls
/// back to it), the manifest, build.json — must be revalidated on each load so
/// a rebuild is picked up on the next launch. Conditional requests keep that
/// cheap (ServeDir answers 304 on If-Modified-Since). API responses are left
/// alone: only text/html and the named UI files are touched.
async fn web_cache_mw(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    let policy: Option<&'static str> = if path.starts_with("/assets/") {
        Some("public, max-age=31536000, immutable")
    } else if path == "/build.json" || path == "/manifest.webmanifest" || path.ends_with(".html") {
        Some("no-cache")
    } else {
        let is_html = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.starts_with("text/html"))
            .unwrap_or(false);
        if is_html { Some("no-cache") } else { None }
    };
    if let Some(p) = policy {
        res.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static(p));
    }
    res
}

/// Serve the web UI embedded at compile time (feature `embed-web`). Reached
/// only when no dist/ directory exists on disk — i.e. a shipped binary running
/// outside the build checkout.
async fn embedded_web(uri: axum::http::Uri) -> Response {
    #[cfg(feature = "embed-web")]
    {
        let path = uri.path().trim_start_matches('/');
        // Unknown paths fall back to index.html (SPA routing).
        let file = WEB_EMBED.get_file(path).or_else(|| WEB_EMBED.get_file("index.html"));
        if let Some(f) = file {
            let mime = match f.path().extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") | Some("mjs") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("ico") => "image/x-icon",
                Some("json") | Some("map") | Some("webmanifest") => "application/json",
                Some("wasm") => "application/wasm",
                Some("woff2") => "font/woff2",
                Some("txt") => "text/plain; charset=utf-8",
                _ => "application/octet-stream",
            };
            return ([(header::CONTENT_TYPE, mime)], f.contents()).into_response();
        }
        StatusCode::NOT_FOUND.into_response()
    }
    #[cfg(not(feature = "embed-web"))]
    {
        let _ = uri;
        (
            StatusCode::NOT_FOUND,
            "web UI not found — build it (npm run build) or point GANBAN_WEB_DIR at a built dist/",
        )
            .into_response()
    }
}

/// The file name currently held in a share slot, if any.
fn slot_filename(slot: &SharedApk) -> Option<String> {
    slot.lock().unwrap().as_ref().and_then(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
}

/// Set (Some) or clear (None) a share slot, validating the path exists on the
/// host. Shared by the desktop `daemon_set_build` Tauri command and the `/invoke`
/// `set_build` surface so a remote owner can drive downloads on the host too.
pub fn set_share_slot(slot: &SharedApk, path: Option<String>) -> Result<(), String> {
    let mut guard = slot.lock().unwrap();
    *guard = match path {
        Some(p) => {
            let pb = PathBuf::from(&p);
            if !pb.exists() {
                return Err(format!("File not found: {p}"));
            }
            Some(pb)
        }
        None => None,
    };
    Ok(())
}

/// The full host path currently held in each platform slot (or null). The Sync
/// UI keys availability off the full path so two same-named builds don't collide,
/// matching `DaemonStatus`'s per-platform fields. Backs the `/invoke` build
/// commands so a remote client sees exactly what the host is serving.
fn shared_builds_json(shares: &Shares) -> Value {
    let path = |slot: &SharedApk| slot.lock().unwrap().as_ref().map(|p| p.to_string_lossy().into_owned());
    json!({
        "android": path(&shares.android),
        "windows": path(&shares.windows),
        "macos": path(&shares.macos),
        "linux": path(&shares.linux),
        "server": path(&shares.server),
    })
}

/// Guess the visitor's platform key from the User-Agent.
fn detect_os(headers: &axum::http::HeaderMap) -> &'static str {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if ua.contains("android") {
        "android"
    } else if ua.contains("windows") {
        "windows"
    } else if ua.contains("macintosh") || ua.contains("mac os") {
        "macos"
    } else if ua.contains("linux") {
        "linux"
    } else {
        ""
    }
}

/// A landing page offering whichever native builds the host is sharing, with the
/// one matching the visitor's OS featured first. Public (no token) — the
/// install/update path. A browser joiner can grab a build or just use the web app.
async fn download_page(Extension(s): Extension<Shares>, headers: axum::http::HeaderMap) -> Response {
    let detected = detect_os(&headers);
    let btn = |kind: &str, label: &str, file: &str, primary: bool| {
        let (bg, fg) = if primary { ("#cba6f7", "#1e1e2e") } else { ("#313244", "#cdd6f4") };
        format!(
            "<p><a href=\"/download/{kind}\" style=\"display:inline-block;background:{bg};color:{fg};padding:14px 26px;border-radius:14px;text-decoration:none;font-weight:600\">{label} — {file}</a></p>"
        )
    };
    let mut html = String::new();
    if let Some(file) = s.slot(detected).and_then(slot_filename) {
        let label = BUILD_KINDS.iter().find(|(k, _)| *k == detected).map(|(_, l)| *l).unwrap_or("");
        html.push_str("<p style=\"opacity:.7;font-size:13px\">Recommended for this device</p>");
        html.push_str(&btn(detected, label, &file, true));
        html.push_str("<hr style=\"border:none;border-top:1px solid #313244;margin:16px 0\">");
    }
    for (kind, label) in BUILD_KINDS {
        if kind == detected {
            continue;
        }
        if let Some(file) = s.slot(kind).and_then(slot_filename) {
            html.push_str(&btn(kind, label, &file, false));
        }
    }
    if html.is_empty() {
        html.push_str("<p style=\"opacity:.6\">No native build shared yet — you can still use Ganban in this browser.</p>");
    }
    Html(format!(
        "<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <title>Get Ganban</title>\
         <body style=\"font-family:system-ui;background:#1e1e2e;color:#cdd6f4;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center\">\
         <div style=\"max-width:360px\"><div style=\"font-size:42px\">\u{1f338}</div><h1>Get Ganban</h1>{html}\
         <p><a href=\"/\" style=\"color:#cba6f7\">Open in this browser instead \u{2192}</a></p>\
         <p style=\"opacity:.5;font-size:13px\">Allow installs from this browser if your device prompts you.</p></div></body>"
    ))
    .into_response()
}

/// Strip characters that could break (or inject into) a `Content-Disposition`
/// header — filenames can come from untrusted uploaders.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !c.is_control()
                && *c != '"'
                && *c != '\\'
                && *c != '/'
                // Strip bidi/format overrides so a download name can't be spoofed.
                && !('\u{202A}'..='\u{202E}').contains(c)
                && !('\u{2066}'..='\u{2069}').contains(c)
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Stream a shared file (APK or desktop installer) as an attachment.
async fn serve_shared(slot: &SharedApk, fallback_name: &str) -> Response {
    let path = slot.lock().unwrap().clone();
    let Some(path) = path else {
        return (StatusCode::NOT_FOUND, "Not shared from the desktop").into_response();
    };
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::NOT_FOUND, format!("File not found: {e}")).into_response(),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(fallback_name).to_string();
    let ctype = if name.ends_with(".apk") {
        "application/vnd.android.package-archive"
    } else {
        "application/octet-stream"
    };
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    (
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", sanitize_filename(&name))),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
struct SyncPullQuery {
    since: Option<String>,
}

/// Owner-only: export the host's rows changed since the given cursor, for a
/// desktop replica to apply. Members stay live thin clients and never sync.
async fn sync_pull(
    State(db): State<Db>,
    _owner: AuthOwner,
    Query(q): Query<SyncPullQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ganban_core::sync::pull(&db, q.since.as_deref().unwrap_or("")).await?))
}

#[derive(Deserialize)]
struct SyncPushBody {
    changes: Vec<ganban_core::sync::IncomingChange>,
}

/// Owner-only: apply a replica's offline changes to the host (conflict detection
/// + server-side id mint / FK remap). Returns id_remap + conflicts + cursor.
async fn sync_push(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<SyncPushBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ganban_core::sync::push(&db, body.changes).await?))
}

async fn download_build(Extension(s): Extension<Shares>, Path(kind): Path<String>) -> Response {
    match s.slot(&kind) {
        Some(slot) => serve_shared(slot, "ganban").await,
        None => (StatusCode::NOT_FOUND, "unknown build").into_response(),
    }
}

// ============== Auth ==============

/// An authenticated identity. Loopback connections resolve to the owner (the
/// desktop hosting the daemon is trusted); otherwise a `Bearer` device token.
#[derive(Clone, Copy)]
pub struct AuthUser {
    pub id: i64,
    pub is_owner: bool,
    /// The device token that authenticated this request (None over loopback,
    /// which needs no token). Lets "your devices" mark the current one.
    pub device_id: Option<i64>,
}

#[async_trait]
impl FromRequestParts<Db> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, db: &Db) -> Result<Self, Self::Rejection> {
        // Loopback (the host machine — e.g. the desktop's own Sync view) = owner.
        if let Some(ConnectInfo(addr)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            if addr.ip().is_loopback() {
                let owner_id = auth::ensure_owner(db).await?;
                return Ok(AuthUser { id: owner_id, is_owner: true, device_id: None });
            }
        }
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| s.len() >= 7 && s[..7].eq_ignore_ascii_case("bearer "))
            .map(|s| s[7..].trim().to_string());
        let Some(token) = token else {
            return Err(ApiError(AppError::Unauthorized("missing bearer token".into())));
        };
        match auth::validate_device_token(db, &token).await? {
            Some((user, device_id)) => Ok(AuthUser { id: user.id, is_owner: user.is_owner, device_id: Some(device_id) }),
            None => Err(ApiError(AppError::Unauthorized("invalid or expired token".into()))),
        }
    }
}

/// G3 freshness middleware: a successful POST/PUT/PATCH/DELETE on a data route
/// pulses the hub. Method+path only — bodies stream through untouched.
async fn pulse_mw(
    State(hub): State<events::EventHub>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    use axum::http::Method;
    let mutating = matches!(*req.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    let kind = if mutating { events::pulse_kind(req.uri().path()) } else { None };
    let res = next.run(req).await;
    if let Some(k) = kind {
        if res.status().is_success() {
            hub.publish(k);
        }
    }
    res
}

/// The pulse stream itself: relays the hub as SSE. Coarse by design — entity
/// kind or command name, never payloads, so there's nothing to authorize per
/// recipient beyond holding a valid device token. Auth allows `?token=` like
/// downloads (EventSource cannot set an Authorization header); this stream is
/// non-mutating, so the token-in-URL doctrine holds.
async fn events_stream_handler(
    Extension(hub): Extension<events::EventHub>,
    _user: AuthDownload,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    // Subscribe BEFORE reading the id: a pulse racing the connect then lands
    // on `rx` (and moves the id) — never slips between the two.
    let mut rx = hub.subscribe();
    let hello_id = hub.current_id();
    let sse = stream! {
        // Lets the client distinguish "connected, quiet" from "connecting" —
        // and, via the id, tell a routine reconnect from one that missed pulses.
        yield Ok(Event::default().event("hello").data("connected").id(hello_id));
        // Auth happens at connect; without a bound, a revoked device would
        // keep its stream forever. Ending the response makes EventSource
        // reconnect, which re-validates the token.
        // (GANBAN_SSE_RENEW_SECS shortens it for testing reconnect behaviour.)
        let renew = std::env::var("GANBAN_SSE_RENEW_SECS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(600);
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(renew));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                r = rx.recv() => match r {
                    Ok((n, what)) => yield Ok(Event::default().event("changed").data(what).id(hub.id_of(n))),
                    // Missed pulses mean the same thing, just coarser — clients
                    // refetch wholesale anyway.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        yield Ok(Event::default().event("changed").data("lagged").id(hub.current_id()));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    };
    Sse::new(sse).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
struct PulseBody {
    what: String,
}

/// Accepts "I changed something" from the hosting desktop's UI, whose
/// local-mode writes go straight to the DB (Tauri commands, no HTTP) and would
/// otherwise be invisible to subscribed phones. The command name is mapped to
/// a coarse kind exactly like `/invoke` — never published raw.
async fn events_pulse_handler(
    Extension(hub): Extension<events::EventHub>,
    _owner: AuthOwner,
    Json(body): Json<PulseBody>,
) -> StatusCode {
    if let Some(kind) = events::invoke_pulse_kind(&body.what) {
        hub.publish(kind);
    }
    StatusCode::NO_CONTENT
}

/// Like `AuthUser`, but ALSO accepts the device token as a `?token=<hex>` query
/// param — used ONLY by the file-download routes and the freshness pulse stream
/// (`/events/stream`), so a file can be opened in the system browser on mobile
/// and an `EventSource` can connect (neither GET can carry an Authorization
/// header). Kept separate so a token-in-URL is never honoured on mutating
/// endpoints.
pub struct AuthDownload(pub AuthUser);

#[async_trait]
impl FromRequestParts<Db> for AuthDownload {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, db: &Db) -> Result<Self, Self::Rejection> {
        if let Some(ConnectInfo(addr)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            if addr.ip().is_loopback() {
                let owner_id = auth::ensure_owner(db).await?;
                return Ok(AuthDownload(AuthUser { id: owner_id, is_owner: true, device_id: None }));
            }
        }
        let header_token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| s.len() >= 7 && s[..7].eq_ignore_ascii_case("bearer "))
            .map(|s| s[7..].trim().to_string());
        // Device tokens are hex → URL-safe, so no percent-decoding is needed.
        let token = header_token.or_else(|| {
            parts
                .uri
                .query()
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=").map(str::to_string)))
        });
        let Some(token) = token else {
            return Err(ApiError(AppError::Unauthorized("missing token".into())));
        };
        match auth::validate_device_token(db, &token).await? {
            Some((user, device_id)) => Ok(AuthDownload(AuthUser { id: user.id, is_owner: user.is_owner, device_id: Some(device_id) })),
            None => Err(ApiError(AppError::Unauthorized("invalid or expired token".into()))),
        }
    }
}

/// Like `AuthUser` but rejects non-owners. The owner-only routes use it;
/// members reach data through commands (`/invoke`), under their access rules.
pub struct AuthOwner;

#[async_trait]
impl FromRequestParts<Db> for AuthOwner {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, db: &Db) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, db).await?;
        if user.is_owner {
            Ok(AuthOwner)
        } else {
            Err(ApiError(AppError::Forbidden("owner-only endpoint".into())))
        }
    }
}

#[derive(Deserialize)]
struct EnrollBody {
    token: String,
    device_label: Option<String>,
    /// The joiner's chosen display name (overrides any name the inviter set).
    display_name: Option<String>,
}

async fn enroll_handler(
    State(db): State<Db>,
    Json(body): Json<EnrollBody>,
) -> Result<Json<auth::EnrollResult>, ApiError> {
    Ok(Json(
        auth::enroll(&db, &body.token, body.device_label.as_deref(), body.display_name.as_deref()).await?,
    ))
}

async fn me_handler(State(db): State<Db>, user: AuthUser) -> Result<Json<auth::Me>, ApiError> {
    let u = ops::get_user(&db, user.id).await?;
    let memberships = auth::list_memberships(&db, user.id).await?;
    Ok(Json(auth::Me { user: u, memberships }))
}

// ---- scope enforcement ----

async fn require(db: &Db, user: &AuthUser, project_id: i64, min_role: &str) -> Result<(), ApiError> {
    Ok(commands::require_role(db, user, project_id, min_role).await?)
}

/// Task visibility (ADR 0002) for the routes outside the command table: a row outside the
/// caller's audience is "not found", like another project's.
fn sees(seen: bool) -> Result<(), ApiError> {
    if seen {
        Ok(())
    } else {
        Err(ApiError(AppError::NotFound("not found".into())))
    }
}

#[derive(Deserialize)]
struct UploadQuery {
    task_id: i64,
    file_name: String,
    file_type: Option<String>,
    /// Where the file sits in an uploaded folder, file name included ("Photos/a.jpg"):
    /// a folder dropped on a task keeps its structure.
    #[serde(default)]
    rel_path: Option<String>,
}

/// Upload a file as a *shared* attachment (the raw body is the bytes). Any
/// member of the task's project may upload; the project's quota is enforced.
/// An upload streamed to a temp file under `<storage root>/tmp`. Deleted on
/// drop unless kept — so a client that disconnects mid-upload (axum drops the
/// handler future) leaves no orphan behind.
struct Spooled {
    path: PathBuf,
    size: u64,
    armed: bool,
}

impl Spooled {
    /// The caller moved the file into place; don't delete it.
    fn keep(mut self) -> PathBuf {
        self.armed = false;
        std::mem::take(&mut self.path)
    }
}

impl Drop for Spooled {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Stream an upload body to disk instead of buffering it whole in RAM (a big
/// file used to sit in memory, then go through a blocking write on an async
/// worker — stalling the host's other requests, the desktop's own UI calls
/// included when this device is the host). Refuses more than `limit` bytes; a
/// declared Content-Length over it is refused before reading a byte.
async fn spool_upload(
    root: &std::path::Path,
    headers: &axum::http::HeaderMap,
    body: axum::body::Body,
    limit: u64,
    too_big: &str,
) -> Result<Spooled, ApiError> {
    use tokio::io::AsyncWriteExt;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(ApiError(AppError::InvalidInput(too_big.into())));
    }
    let dir = root.join("tmp");
    tokio::fs::create_dir_all(&dir).await.map_err(AppError::from)?;
    sweep_stale_spool(&dir).await;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut spooled = Spooled { path: dir.join(format!("upload-{nanos}-{n}")), size: 0, armed: true };
    let mut file = tokio::fs::File::create(&spooled.path).await.map_err(AppError::from)?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::InvalidInput(format!("upload interrupted: {e}")))?;
        spooled.size += chunk.len() as u64;
        if spooled.size > limit {
            return Err(ApiError(AppError::InvalidInput(too_big.into())));
        }
        file.write_all(&chunk).await.map_err(AppError::from)?;
    }
    file.flush().await.map_err(AppError::from)?;
    file.sync_all().await.map_err(AppError::from)?;
    if spooled.size == 0 {
        return Err(ApiError(AppError::InvalidInput("empty file".into())));
    }
    Ok(spooled)
}

/// Best-effort: remove spool files a crash left behind (older than a day).
async fn sweep_stale_spool(dir: &std::path::Path) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    while let Ok(Some(e)) = rd.next_entry().await {
        if let Ok(meta) = e.metadata().await {
            if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                let _ = tokio::fs::remove_file(e.path()).await;
            }
        }
    }
}

/// One upload in the host log: a line when it starts (who, from which device,
/// where to, the file, its declared size) and one when it ends: stored (size,
/// time, rate), refused (why), or dropped. A client that disconnects mid-upload
/// makes axum drop the handler, and with it this guard, which logs the drop.
struct UploadLog {
    line: String,
    started: std::time::Instant,
    ended: bool,
}

impl UploadLog {
    /// `who` is from [`uploader`]; `target` says where the file goes.
    fn start(who: String, target: String, file: &str, headers: &axum::http::HeaderMap) -> Self {
        let declared = headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(fmt_bytes)
            .unwrap_or_else(|| "size not declared".into());
        let line = format!("{who} → {target}, '{file}'");
        tracing::info!("upload started: {line} ({declared})");
        UploadLog { line, started: std::time::Instant::now(), ended: false }
    }

    /// Log how the upload ended and pass its result on.
    fn finish<T>(mut self, result: Result<T, ApiError>, size: impl Fn(&T) -> u64) -> Result<T, ApiError> {
        self.ended = true;
        let secs = self.started.elapsed().as_secs_f64();
        match &result {
            Ok(v) => {
                let n = size(v);
                let rate = if secs > 0.0 { fmt_bytes((n as f64 / secs) as u64) } else { "—".into() };
                tracing::info!("upload stored: {} — {} in {secs:.1}s ({rate}/s)", self.line, fmt_bytes(n));
            }
            Err(e) => tracing::warn!("upload refused: {} after {secs:.1}s — {}", self.line, e.0),
        }
        result
    }
}

impl Drop for UploadLog {
    fn drop(&mut self) {
        if !self.ended {
            let secs = self.started.elapsed().as_secs_f64();
            tracing::warn!("upload dropped: {} after {secs:.1}s — the client disconnected or cancelled", self.line);
        }
    }
}

/// Who is uploading, for the log: "user 7 'mia' (device 3)", or the owner.
async fn uploader(db: &Db, user: &AuthUser) -> String {
    let name: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE id = ?")
        .bind(user.id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let name = name.map(|n| format!(" '{n}'")).unwrap_or_default();
    let role = if user.is_owner { "owner" } else { "user" };
    match user.device_id {
        Some(d) => format!("{role} {}{name} (device {d})", user.id),
        None => format!("{role} {}{name} (loopback)", user.id),
    }
}

/// "1.2 GB" — byte counts for the log.
fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[u]) }
}

/// Room left in a project's storage allocation.
async fn project_remaining(db: &Db, project_id: i64) -> Result<u64, ApiError> {
    Ok((storage::project_quota(db, project_id).await? - storage::project_used(db, project_id).await?).max(0) as u64)
}

async fn upload_file(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Query(q): Query<UploadQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<FileAttachment>, ApiError> {
    let log = UploadLog::start(uploader(&db, &user).await, format!("task {}", q.task_id), &q.file_name, &headers);
    let stored = async {
        let project_id = storage::task_project(&db, q.task_id).await?;
        require(&db, &user, project_id, auth::ROLE_MEMBER).await?;
        sees(visibility::can_see_task(&db, commands::viewer_of(&user), q.task_id).await?)?;
        let rel_path = q.rel_path.as_deref().map(|p| storage::clean_rel_path(p, true)).transpose()?;
        let remaining = project_remaining(&db, project_id).await?;
        let spooled = spool_upload(&root.0, &headers, body, remaining, "file exceeds the project's remaining storage").await?;
        let size = spooled.size as i64;
        // On error `spooled` drops and removes the temp file; on success it moved.
        let att = storage::store_shared_from_path(
            &db,
            &root.0,
            q.task_id,
            &q.file_name,
            q.file_type.as_deref(),
            Some(user.id),
            &spooled.path,
            size,
        )
        .await?;
        spooled.keep();
        match rel_path {
            Some(p) => Ok(storage::set_rel_path(&db, att.id, Some(&p)).await?),
            None => Ok(att),
        }
    }
    .await;
    log.finish(stored, |a| a.storage_size.max(0) as u64).map(Json)
}

/// Download a shared attachment's bytes (any member of its project).
async fn download_file(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    AuthDownload(user): AuthDownload,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let project_id = storage::attachment_project(&db, id).await?;
    require(&db, &user, project_id, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_attachment(&db, commands::viewer_of(&user), id).await?)?;
    let (file_name, file_type, path) = storage::shared_for_download(&db, &root.0, id).await?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError(AppError::NotFound("file".into())))?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    // Content-Type is required for inline image rendering: a blob created from a
    // fetch() response inherits the response's type, and an <img> won't render a
    // blob typed as application/octet-stream (browsers don't sniff blob URLs).
    // Fall back to octet-stream so non-image downloads still work.
    let mime = file_type
        .filter(|t| t.contains('/') && !t.trim().is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", sanitize_filename(&file_name))),
        ],
        body,
    )
        .into_response())
}

/// The most one event file may be: events have no project, so no quota bounds them.
const EVENT_FILE_MAX: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct EventUploadQuery {
    event_id: i64,
    file_name: String,
    #[serde(default)]
    file_type: Option<String>,
    /// Where the file sits in an uploaded folder, file name included ("Brief/a.pdf").
    #[serde(default)]
    rel_path: Option<String>,
}

/// Upload a file onto an event (raw body = bytes). The owner and the workspace admins,
/// who manage events, on an event they see. Counts against no project's quota.
async fn event_file_upload(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Query(q): Query<EventUploadQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<EventAttachment>, ApiError> {
    let file = q.rel_path.as_deref().unwrap_or(&q.file_name);
    let log = UploadLog::start(uploader(&db, &user).await, format!("event {}", q.event_id), file, &headers);
    let stored = async {
        commands::events::manages_event(&db, &user, q.event_id).await?;
        let file_name = storage::clean_rel_path(&q.file_name, false)?;
        let rel_path = q.rel_path.as_deref().map(|p| storage::clean_rel_path(p, true)).transpose()?;
        if rel_path.as_deref().is_some_and(|p| p.rsplit('/').next() != Some(file_name.as_str())) {
            return Err(ApiError(AppError::InvalidInput("rel_path must end in the file's name".into())));
        }
        let spooled = spool_upload(&root.0, &headers, body, EVENT_FILE_MAX, "file too large (2 GB max)").await?;
        let size = spooled.size as i64;
        let att = storage::store_event_file_from_path(
            &db,
            &root.0,
            q.event_id,
            &file_name,
            q.file_type.as_deref(),
            rel_path.as_deref(),
            Some(user.id),
            &spooled.path,
            size,
        )
        .await?;
        spooled.keep();
        Ok(att)
    }
    .await;
    log.finish(stored, |a| a.size_bytes.max(0) as u64).map(Json)
}

/// Download an event file (any member who sees the event).
async fn event_file_download(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    AuthDownload(user): AuthDownload,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let f = storage::get_event_file(&db, id).await?;
    sees(commands::events::sees_event(&db, &user, f.event_id).await?)?;
    let (file_name, file_type, path) = storage::event_file_for_download(&db, &root.0, id).await?;
    let file = tokio::fs::File::open(&path).await.map_err(|_| ApiError(AppError::NotFound("file".into())))?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    let mime = file_type.filter(|t| t.contains('/') && !t.trim().is_empty()).unwrap_or_else(|| "application/octet-stream".to_string());
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", sanitize_filename(&file_name))),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
struct ProjectUploadQuery {
    file_name: String,
    #[serde(default)]
    file_type: Option<String>,
    /// Relative path within an uploaded folder, for structure-preserving uploads.
    #[serde(default)]
    rel_path: Option<String>,
}

/// Upload a project-level file (raw body = bytes). Any project member; quota-checked.
async fn project_file_upload(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(pid): Path<i64>,
    Query(q): Query<ProjectUploadQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<ProjectFile>, ApiError> {
    let file = q.rel_path.as_deref().unwrap_or(&q.file_name);
    let log = UploadLog::start(uploader(&db, &user).await, format!("project {pid}"), file, &headers);
    let stored = async {
        require(&db, &user, pid, auth::ROLE_MEMBER).await?;
        let remaining = project_remaining(&db, pid).await?;
        let spooled = spool_upload(&root.0, &headers, body, remaining, "file exceeds the project's remaining storage").await?;
        let size = spooled.size as i64;
        let f = storage::store_project_file_from_path(
            &db,
            &root.0,
            pid,
            &q.file_name,
            q.file_type.as_deref(),
            q.rel_path.as_deref(),
            Some(user.id),
            &spooled.path,
            size,
        )
        .await?;
        spooled.keep();
        Ok(f)
    }
    .await;
    log.finish(stored, |f| f.size_bytes.max(0) as u64).map(Json)
}

/// List a project's files (any member).
async fn project_files_list(State(db): State<Db>, user: AuthUser, Path(pid): Path<i64>) -> Result<Json<Vec<ProjectFile>>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(storage::list_project_files(&db, pid).await?))
}

/// Files-tab integrity audit: which of this project's host-stored files
/// (project files + shared attachments) have lost their bytes on disk. Same
/// scope as listing — any member may look.
async fn project_files_audit(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(pid): Path<i64>,
) -> Result<Json<Vec<storage::MissingFile>>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(storage::audit_project_files(&db, &root.0, pid).await?))
}

/// Clear every missing file the audit finds (project rows deleted, shared
/// attachments reverted to unshared). Member — the same role that deletes
/// files one by one.
async fn project_files_clear_missing(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(pid): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let cleared = storage::clear_missing_files(&db, &root.0, pid).await?;
    Ok(Json(json!({ "cleared": cleared })))
}

#[derive(Deserialize)]
struct RestoreQuery {
    #[serde(default)]
    file_type: Option<String>,
}

/// Re-upload bytes for an existing project file (fixing a broken link found by
/// the audit) — the file id, and every reference to it, is preserved.
async fn project_file_restore(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(fid): Path<i64>,
    Query(q): Query<RestoreQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<ProjectFile>, ApiError> {
    let log = UploadLog::start(uploader(&db, &user).await, format!("project file {fid} (replacement)"), "replacement bytes", &headers);
    let stored = async {
        let pid = storage::project_file_project(&db, fid).await?;
        require(&db, &user, pid, auth::ROLE_MEMBER).await?;
        let cap = storage::project_quota(&db, pid).await?.max(0) as usize;
        let bytes = axum::body::to_bytes(body, cap)
            .await
            .map_err(|_| AppError::InvalidInput("file exceeds the project's storage quota".into()))?;
        if bytes.is_empty() {
            return Err(ApiError(AppError::InvalidInput("empty file".into())));
        }
        Ok(storage::restore_project_file(&db, &root.0, fid, q.file_type.as_deref(), &bytes).await?)
    }
    .await;
    log.finish(stored, |f| f.size_bytes.max(0) as u64).map(Json)
}

/// Batch-push every local-path attachment of a project to the host (the
/// follow-up to the Files audit). Per-file failures are reported, not fatal.
/// Only meaningful where the daemon can read the local paths — i.e. the
/// embedded desktop host, which is exactly where legacy local files live.
async fn project_files_share_local(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(pid): Path<i64>,
) -> Result<Json<storage::ShareLocalSummary>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(storage::share_all_local(&db, &root.0, pid).await?))
}

#[derive(Deserialize)]
struct AssignBody {
    task_id: i64,
}

/// Allocate a project file to a task (converts to a shared attachment; the
/// blob moves with it).
async fn project_file_assign(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(fid): Path<i64>,
    Json(body): Json<AssignBody>,
) -> Result<Json<FileAttachment>, ApiError> {
    let pid = storage::project_file_project(&db, fid).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_task(&db, commands::viewer_of(&user), body.task_id).await?)?;
    Ok(Json(storage::assign_file_to_task(&db, &root.0, fid, body.task_id).await?))
}

/// Detach a shared attachment from its task back into a plain project file.
async fn attachment_unassign(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<ProjectFile>, ApiError> {
    let pid = storage::attachment_project(&db, id).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_attachment(&db, commands::viewer_of(&user), id).await?)?;
    Ok(Json(storage::unassign_attachment(&db, &root.0, id).await?))
}

/// Push ONE local attachment to the host (the per-row variant of share-local).
async fn attachment_share(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<FileAttachment>, ApiError> {
    let pid = storage::attachment_project(&db, id).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_attachment(&db, commands::viewer_of(&user), id).await?)?;
    Ok(Json(storage::share_local_file(&db, &root.0, id).await?))
}

/// Delete a task attachment record (+ host blob, if any) — the Files page's
/// one-stop cleanup for legacy task-tied files. The uploader's local original,
/// if any, is untouched.
async fn attachment_delete(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let pid = storage::attachment_project(&db, id).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_attachment(&db, commands::viewer_of(&user), id).await?)?;
    storage::delete_attachment(&db, &root.0, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Re-upload bytes for an existing shared task attachment (same id/task link).
async fn attachment_restore(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(id): Path<i64>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<FileAttachment>, ApiError> {
    let log = UploadLog::start(uploader(&db, &user).await, format!("attachment {id} (replacement)"), "replacement bytes", &headers);
    let stored = async {
        let pid = storage::attachment_project(&db, id).await?;
        require(&db, &user, pid, auth::ROLE_MEMBER).await?;
        sees(visibility::can_see_attachment(&db, commands::viewer_of(&user), id).await?)?;
        let cap = storage::project_quota(&db, pid).await?.max(0) as usize;
        let bytes = axum::body::to_bytes(body, cap)
            .await
            .map_err(|_| AppError::InvalidInput("file exceeds the project's storage quota".into()))?;
        if bytes.is_empty() {
            return Err(ApiError(AppError::InvalidInput("empty file".into())));
        }
        Ok(storage::restore_attachment(&db, &root.0, id, &bytes).await?)
    }
    .await;
    log.finish(stored, |a| a.storage_size.max(0) as u64).map(Json)
}

/// Shared task attachments across the project (for the central Files view).
async fn project_attachments_list(State(db): State<Db>, user: AuthUser, Path(pid): Path<i64>) -> Result<Json<Vec<ProjectAttachment>>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let mut rows = storage::list_project_attachments(&db, pid).await?;
    if let Some(seen) = visibility::visible_tasks(&db, commands::viewer_of(&user), Some(pid)).await? {
        rows.retain(|a| seen.contains(&a.task_id));
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct ReactBody {
    emoji: String,
}

/// Toggle the caller's emoji reaction on a comment (member of its project).
async fn comment_react_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ReactBody>,
) -> Result<Json<Value>, ApiError> {
    let pid = auth::comment_project_id(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("comment".into())))?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_comment(&db, commands::viewer_of(&user), id).await?)?;
    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.len() > 32 {
        return Err(ApiError(AppError::InvalidInput("invalid emoji".into())));
    }
    let reacted = ops::toggle_comment_reaction(&db, id, user.id, emoji).await?;
    Ok(Json(json!({ "reacted": reacted })))
}

/// Reaction tallies for a task's comments, with the caller's own reactions flagged.
async fn task_reactions_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ReactionSummary>>, ApiError> {
    let pid = auth::task_project_id(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("task".into())))?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    sees(visibility::can_see_task(&db, commands::viewer_of(&user), id).await?)?;
    Ok(Json(ops::task_reaction_summary(&db, id, user.id).await?))
}

/// Reaction tallies for every comment in a project (the comment board).
async fn project_reactions_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ReactionSummary>>, ApiError> {
    require(&db, &user, id, auth::ROLE_MEMBER).await?;
    let mut tallies = ops::project_reaction_summary(&db, id, user.id).await?;
    if let Some(seen) = visibility::visible_comments(&db, commands::viewer_of(&user), id).await? {
        tallies.retain(|r| seen.contains(&r.comment_id));
    }
    Ok(Json(tallies))
}

#[derive(Deserialize)]
struct CustomEmojiBody {
    name: String,
    image: String,
}

/// All custom emojis — a shared chat resource any member can read.
async fn custom_emoji_list_handler(State(db): State<Db>, _user: AuthUser) -> Result<Json<Vec<CustomEmoji>>, ApiError> {
    Ok(Json(ops::list_custom_emojis(&db).await?))
}

/// Add a custom emoji (any member); the image is a small resized data-URL,
/// validated + size-capped in ops.
async fn custom_emoji_create_handler(
    State(db): State<Db>,
    user: AuthUser,
    Json(body): Json<CustomEmojiBody>,
) -> Result<Json<CustomEmoji>, ApiError> {
    Ok(Json(ops::create_custom_emoji(&db, &body.name, &body.image, Some(user.id)).await?))
}

/// Remove a custom emoji — the owner, or whoever added it.
async fn custom_emoji_delete_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let author = ops::custom_emoji_author(&db, id).await?;
    if !user.is_owner && author != Some(user.id) {
        return Err(ApiError(AppError::Forbidden("only the owner or the emoji's author can remove it".into())));
    }
    ops::delete_custom_emoji(&db, id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Delete a project file (any member of its project).
async fn project_file_delete(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Path(fid): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let pid = storage::project_file_project(&db, fid).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    storage::delete_project_file(&db, &root.0, fid).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameBody {
    file_name: String,
}

/// Rename a project file (any member — same trust level as upload/delete).
async fn project_file_rename(
    State(db): State<Db>,
    user: AuthUser,
    Path(fid): Path<i64>,
    Json(body): Json<RenameBody>,
) -> Result<Json<ProjectFile>, ApiError> {
    let pid = storage::project_file_project(&db, fid).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(storage::rename_project_file(&db, fid, &body.file_name).await?))
}

#[derive(Deserialize)]
struct FolderBody {
    rel_path: String,
}

/// Create an explicit (possibly empty) folder in a project's file browser.
async fn project_folder_create(
    State(db): State<Db>,
    user: AuthUser,
    Path(pid): Path<i64>,
    Json(body): Json<FolderBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let path = storage::create_project_folder(&db, pid, &body.rel_path).await?;
    Ok(Json(json!({ "rel_path": path })))
}

/// A project's explicit folders (any member).
async fn project_folders_list(
    State(db): State<Db>,
    user: AuthUser,
    Path(pid): Path<i64>,
) -> Result<Json<Vec<String>>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(storage::list_project_folders(&db, pid).await?))
}

#[derive(Deserialize)]
struct MoveBody {
    ids: Vec<i64>,
    /// Target folder; "" moves to the root.
    dir: String,
}

/// Move project files into a folder (bulk; any member).
async fn project_files_move(
    State(db): State<Db>,
    user: AuthUser,
    Path(pid): Path<i64>,
    Json(body): Json<MoveBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let moved = storage::move_project_files(&db, pid, &body.ids, &body.dir).await?;
    Ok(Json(json!({ "moved": moved })))
}

/// Download a project file (any member of its project).
async fn project_file_download(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    AuthDownload(user): AuthDownload,
    Path(fid): Path<i64>,
) -> Result<Response, ApiError> {
    let pid = storage::project_file_project(&db, fid).await?;
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let (file_name, file_type, path) = storage::project_file_for_download(&db, &root.0, fid).await?;
    let file = tokio::fs::File::open(&path).await.map_err(|_| ApiError(AppError::NotFound("file".into())))?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    // Content-Type is required for inline image rendering (same fix as the
    // /files/:id attachment route): a blob created from a fetch() response
    // inherits the response's type, and an <img> won't render a blob typed as
    // application/octet-stream.
    let mime = file_type
        .filter(|t| t.contains('/') && !t.trim().is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", sanitize_filename(&file_name))),
        ],
        body,
    )
        .into_response())
}

// ============== Handlers ==============

/// Server features a client may probe for instead of inferring them from a
/// 404/SPA fallback. Append when a client-visible route family lands.
pub const CAPABILITIES: &[&str] = &["tab-state-slots", "map-tiles", "client-updates"];

async fn health() -> Json<serde_json::Value> {
    let built_at = env!("GANBAN_SERVER_BUILT_AT")
        .parse::<i64>()
        .ok()
        .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
        .map(|t| t.to_rfc3339());
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "service": "ganban-server",
        // Which build this host is ACTUALLY running (git hash, `+` = built
        // from uncommitted changes) — the answer to "I rebuilt, why is it old?".
        "build": env!("GANBAN_SERVER_BUILD"),
        "builtAt": built_at,
        "capabilities": CAPABILITIES,
    }))
}

/// Coarse read-through of the whole (active) DB for the desktop "Sync" view.
async fn snapshot(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<serde_json::Value>, ApiError> {
    let projects = ops::get_projects(&db).await?;
    let tasks = ops::get_all_tasks(&db, Some(false)).await?;
    let project_count = projects.len();
    let task_count = tasks.len();
    Ok(Json(json!({
        "projects": projects,
        "tasks": tasks,
        "counts": {
            "projects": project_count,
            "tasks": task_count,
        }
    })))
}

// ============== Commands: /invoke, the HTTP adapter over the table ==============

#[derive(Deserialize)]
struct InvokeBody {
    command: String,
    #[serde(default)]
    args: Value,
}

/// The /invoke route: runs the command and tags the response with its name,
/// so the host's traffic window (Bridge › Host health) can say WHICH commands
/// are busy instead of one big "POST /invoke".
async fn invoke_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    Extension(hub): Extension<events::EventHub>,
    Extension(shares): Extension<Shares>,
    update_paths: Option<Extension<Arc<updates::UpdatePaths>>>,
    user: AuthUser,
    Json(body): Json<InvokeBody>,
) -> Response {
    let label: String = body.command.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect();
    let mut res = invoke_inner(State(db), Extension(root), Extension(hub), Extension(shares), update_paths, user, Json(body))
        .await
        .into_response();
    res.extensions_mut().insert(hostmon::InvokeLabel(label));
    res
}

/// The HTTP adapter over the one command table (ADR 0001): the signed-in
/// caller's access rule, handler and result filter, authorship stamped from
/// that caller.
async fn invoke_inner(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    Extension(hub): Extension<events::EventHub>,
    Extension(shares): Extension<Shares>,
    update_paths: Option<Extension<Arc<updates::UpdatePaths>>>,
    user: AuthUser,
    Json(body): Json<InvokeBody>,
) -> Result<Json<Value>, ApiError> {
    let cx = commands::Ctx::http(&db, user).with_storage_root(&root.0).with_shares(&shares).with_agents(hub.agents());
    let cx = match &update_paths {
        Some(Extension(p)) => cx.with_update_paths(p),
        None => cx,
    };
    let v = commands::run(&cx, &body.command, body.args).await?;
    // Freshness pulse for command writes: reads share this route, so the
    // middleware can't tell — the command name can. Mapped to a coarse kind
    // (never the raw name) so the stream doesn't narrate admin activity.
    if let Some(kind) = events::invoke_pulse_kind(&body.command) {
        hub.publish(kind);
    }
    Ok(Json(v))
}

/// Run a command in-process through the one table: no access rule, no result
/// filter, authorship as the arguments carry it. The agent tools' approved
/// writes and reads go through here, as do tests.
pub(crate) async fn dispatch(db: &Db, command: &str, a: &Value) -> Result<Value, AppError> {
    commands::run(&commands::Ctx::in_process(db), command, a.clone()).await
}

// ============== Error mapping ==============

/// Wraps `core::AppError` so it can become an HTTP response.
pub struct ApiError(AppError);

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        ApiError(e)
    }
}

#[derive(Deserialize)]
struct SearchBody {
    query: String,
    project_id: i64,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    filters: Option<Value>,
}

/// Semantic search over a project's RAG corpus. Scope is enforced here — the
/// caller must be a member of `project_id` (owner bypasses) — and the request is
/// proxied to ragrat with the host-held token, so a member never sees it. Hits
/// carry provenance (entity/sync_uuid) so the client can deep-link back.
async fn search_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Json(body): Json<SearchBody>,
) -> Result<Json<Value>, ApiError> {
    let client = rag.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("search is not enabled on this host".into())))?;
    require(&db, &user, body.project_id, auth::ROLE_MEMBER).await?;
    if !rag::ai_files_enabled(&db, body.project_id).await {
        return Ok(Json(json!({ "hits": [] }))); // owner disabled AI file access
    }
    let limit = body.limit.unwrap_or(10).clamp(1, 50);
    let mut hits = client
        .search(&rag::collection_name(body.project_id), &body.query, limit, body.filters)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(format!("ragrat search: {e}")))))?;
    // Only what the searcher can see (task visibility).
    rag::retain_visible_hits(&db, commands::viewer_of(&user), body.project_id, &mut hits)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    Ok(Json(json!({ "hits": hits })))
}

#[derive(Deserialize)]
struct FacetsQuery {
    project_id: i64,
}

/// The corpus lens data: a project's facets (role → value → count) as recorded
/// by ragrat at ingest time. Same scope as /search — any member of the project.
/// Values feed /search `filters` (a flat {role: value} dict) on click.
async fn facets_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Query(q): Query<FacetsQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = rag.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("search is not enabled on this host".into())))?;
    require(&db, &user, q.project_id, auth::ROLE_MEMBER).await?;
    Ok(Json(json!({ "facets": client.read_facets(&rag::collection_name(q.project_id)) })))
}

#[derive(Deserialize)]
struct ReindexBody {
    project_id: i64,
}

/// Owner-only on-demand re-index of one project (the poller handles it
/// automatically; this forces a refresh, e.g. right after a big edit).
async fn reindex_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Json(body): Json<ReindexBody>,
) -> Result<Json<Value>, ApiError> {
    let client = rag.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("search is not enabled on this host".into())))?;
    let job = rag::reindex_project(&db, &client, &root.0, body.project_id)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(format!("ragrat reindex: {e}")))))?;
    Ok(Json(json!({ "job_id": job })))
}

// ---------------------------------------------------------------------------
// Imported calendars (owner-only). Subscriptions are host-only config; the
// events they pull in go into the normal (synced) events table tagged with
// calendar_id and left unallocated for the owner to review + assign.
// ---------------------------------------------------------------------------

async fn calendar_list(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<CalendarSubscription>>, ApiError> {
    Ok(Json(ops::get_calendar_subscriptions(&db).await?))
}

#[derive(Deserialize)]
struct CreateCalBody {
    name: String,
    url: String,
    #[serde(default)]
    color: Option<String>,
}

async fn calendar_create(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<CreateCalBody>,
) -> Result<Json<Value>, ApiError> {
    let sub = ops::create_calendar_subscription(
        &db,
        CreateCalendarSubscriptionInput { name: body.name, url: body.url, color: body.color },
    )
    .await?;
    // Pull events immediately so they appear without a second click.
    let sync = sync_subscription(&db, &sub).await;
    let subscription = ops::get_calendar_subscription(&db, sub.id).await?;
    Ok(Json(json!({ "subscription": subscription, "sync": sync })))
}

async fn calendar_delete(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    ops::delete_calendar_subscription(&db, id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn calendar_sync(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    let sub = ops::get_calendar_subscription(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("calendar subscription".into())))?;
    Ok(Json(sync_subscription(&db, &sub).await))
}

/// webcal(s):// is plain http(s) for ICS; most feeds are https.
fn normalize_ics_url(url: &str) -> String {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("webcals://") {
        format!("https://{rest}")
    } else if let Some(rest) = url.strip_prefix("webcal://") {
        format!("https://{rest}")
    } else {
        url.to_string()
    }
}

async fn fetch_ics(url: &str) -> std::result::Result<String, String> {
    // Only the owner enters subscription URLs (a model can't), and a calendar
    // on a home Nextcloud over the LAN or tailnet is a normal setup, so the
    // owner's network is in reach. The guard still refuses cloud metadata
    // endpoints and non-http(s) URLs, checks and pins every hop's address,
    // and caps redirects.
    let parsed = reqwest::Url::parse(url).map_err(|_| "that doesn't look like a valid URL".to_string())?;
    net_guard::check_url_in(&parsed, net_guard::Scope::OwnerNetwork).await?;
    let client = net_guard::client_builder_in(net_guard::Scope::OwnerNetwork, 3)
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Ganban/0.5 (calendar-import)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod ics_fetch_tests {
    /// Calendar subscriptions reach the owner's network (a Nextcloud on the
    /// LAN or tailnet) but never a cloud metadata endpoint or a non-http URL.
    #[tokio::test]
    async fn ics_fetch_reaches_the_owners_network_but_not_metadata() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let body = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        let cal = super::fetch_ics(&format!("http://localhost:{port}/remote.php/dav/calendars/me/home?export")).await.unwrap();
        assert!(cal.starts_with("BEGIN:VCALENDAR"), "a calendar on the owner's own network is fetched");
        for url in ["http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://100.100.100.200/"] {
            let err = super::fetch_ics(url).await.unwrap_err();
            assert!(err.contains("not allowed"), "{url}: {err}");
        }
        assert!(super::fetch_ics("file:///etc/passwd").await.is_err());
    }
}

/// Fetch + parse + upsert one subscription's events. Never returns Err — a bad
/// feed is recorded in last_status and surfaced as `{ ok: false, error }` so the
/// UI can show it without a 500.
async fn sync_subscription(db: &Db, sub: &CalendarSubscription) -> Value {
    if !sub.enabled {
        return json!({ "ok": true, "skipped": true });
    }
    let url = normalize_ics_url(&sub.url);
    match fetch_ics(&url).await {
        Err(e) => {
            let _ = ops::set_calendar_sync_result(db, sub.id, &format!("error: {e}"), sub.last_event_count).await;
            json!({ "ok": false, "error": e })
        }
        Ok(text) => {
            let events = ganban_core::ics::parse_ics(&text);
            let (mut added, mut updated) = (0i64, 0i64);
            for ev in &events {
                match ops::upsert_imported_event(db, sub.id, ev).await {
                    Ok(true) => added += 1,
                    Ok(false) => updated += 1,
                    Err(_) => {}
                }
            }
            let total = added + updated;
            let _ = ops::set_calendar_sync_result(db, sub.id, &format!("ok: {total} events ({added} new)"), total).await;
            json!({ "ok": true, "added": added, "updated": updated, "total": total })
        }
    }
}

/// The default chat personality (M1; M5 replaces this with a DB model_profile).
const DEFAULT_SYSTEM_PROMPT: &str = "You are Ganban's project assistant. Answer using the project context provided below (tasks, comments, areas, and shared files). If the context doesn't cover the question, say so plainly rather than inventing facts. Refer to sources by their bracketed label (e.g. [task-…]) when relevant. Be concise.";

/// Resolve the chat profile for a turn: an explicit `profile_id`, else the
/// active `model_profiles` row, else the legacy singleton `chat_profile` setting
/// (and env/default). Read per-request, so Settings changes apply without a
/// daemon restart.
async fn resolve_profile(db: &Db, profile_id: Option<i64>) -> (ollama::ChatParams, String) {
    let profile = match profile_id {
        Some(id) => ops::get_model_profile(db, id).await.ok().flatten(),
        None => ops::active_model_profile(db).await.ok().flatten(),
    };
    if let Some(p) = profile {
        let system = p.system_prompt.filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.into());
        return (
            ollama::ChatParams { model: p.model, temperature: p.temperature, max_tokens: p.max_tokens, num_ctx: None, endpoint: p.endpoint },
            system,
        );
    }
    chat_profile_fallback(db).await
}

/// Task classes the routing table understands. Conversation/personality is the
/// implicit default class (the resolved chat profile); everything else is config.
/// `structure_toc` is the first agent-task class (PDF Studio's auto-build ToC).
const ROUTING_CLASSES: [&str; 3] = ["tools", "librarian", "structure_toc"];

/// Which runner executes a task class. Ollama is the free local default; pi is
/// the external-model runner (paid API keys in ~/.pi/agent/auth.json). The
/// python runner will join this enum when the sandbox gate passes.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runner {
    Ollama,
    Pi,
}
impl Default for Runner {
    fn default() -> Self { Runner::Ollama }
}

/// A resolved protocol: the full dispatch decision for one task class. Frozen
/// shape (build brief #4) — agent-workflows and python blocks bind to this.
/// Extended `ai_routing` JSON entries are objects: `{ runner, profile_id }`.
/// Legacy integer entries (just a profile_id) are treated as `{ runner: ollama }`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Protocol {
    #[serde(default)]
    pub runner: Runner,
    /// The model_profiles row for Ollama runner (NULL = active profile).
    #[serde(default)]
    pub profile_id: Option<i64>,
    /// For the pi runner: a model pattern like "anthropic/claude-sonnet-4".
    /// NULL = pi's default model. Model NAMES only — never API keys.
    #[serde(default)]
    pub model: Option<String>,
    /// Provenance (PROTOCOLS.md §2) — set when resolved from the protocols
    /// table; None for legacy `ai_routing` entries and defaults. Written to
    /// every ledger row so "what produced this" is answerable forever.
    #[serde(skip)]
    pub slug: Option<String>,
    #[serde(skip)]
    pub version: Option<i64>,
    #[serde(skip)]
    pub content_hash: Option<String>,
}

/// Resolve the protocol for a task class. Read order:
///   1. The `protocols` table (Epoch R.1) — the authoritative artifact: the
///      active APPROVED version's frontmatter `engine` block, with provenance.
///   2. Legacy `ai_routing` JSON — an integer entry (oldest shape) →
///      `{ runner: ollama, profile_id: <int> }`; an object entry → the frozen
///      v1 contract `{ runner, profile_id, model }`.
///   3. Default (ollama, active profile).
pub(crate) async fn resolve_protocol(db: &Db, task_class: &str) -> Protocol {
    if let Ok(Some((rec, ver))) = ganban_core::protocols::active_protocol_for_task_class(db, task_class).await {
        if let Ok(fm) = ganban_core::protocols::validate_frontmatter(&ver.frontmatter_json) {
            // "remote" rides the Ollama runner: a profile's `endpoint` field
            // already points chat at a remote engine (Epoch H).
            let runner = if fm.engine.runner == "pi" { Runner::Pi } else { Runner::Ollama };
            return Protocol {
                runner,
                profile_id: fm.engine.profile_id,
                model: fm.engine.model,
                slug: Some(rec.slug),
                version: Some(ver.version),
                content_hash: Some(ver.content_hash),
            };
        }
        tracing::warn!("protocol for '{task_class}' has invalid frontmatter — falling back to legacy routing");
    }
    let raw = ops::get_app_setting(db, "ai_routing").await.ok().flatten();
    let table: Value = match raw.and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => v,
        None => return Protocol::default(),
    };
    let entry = table.get(task_class);
    if let Some(pid) = entry.and_then(Value::as_i64) {
        // Legacy: { task_class: <profile_id_int> } → ollama runner.
        return Protocol { runner: Runner::Ollama, profile_id: Some(pid), ..Default::default() };
    }
    if let Some(obj) = entry {
        // New shape: { task_class: { runner, profile_id, model } }.
        return serde_json::from_value(obj.clone()).unwrap_or_default();
    }
    Protocol::default()
}

/// The model routing table: task class → profile id. Reads through the
/// `protocols` table first (the authoritative artifact), then the legacy
/// `ai_routing` app_setting. Missing/invalid entries mean "no routing": the
/// task runs on the conversation's own profile.
pub(crate) async fn routed_profile_id(db: &Db, task_class: &str) -> Option<i64> {
    if let Ok(Some((_, ver))) = ganban_core::protocols::active_protocol_for_task_class(db, task_class).await {
        if let Ok(fm) = ganban_core::protocols::validate_frontmatter(&ver.frontmatter_json) {
            return fm.engine.profile_id;
        }
    }
    let raw = ops::get_app_setting(db, "ai_routing").await.ok().flatten()?;
    let table: Value = serde_json::from_str(&raw).ok()?;
    table.get(task_class).and_then(Value::as_i64)
}

/// The generation params for a task class: the routed profile's if one is
/// configured (and still exists), else the conversation's own params.
pub(crate) async fn resolve_task_params(db: &Db, task_class: &str, fallback: &ollama::ChatParams) -> ollama::ChatParams {
    match routed_profile_id(db, task_class).await {
        Some(pid) => match ops::get_model_profile(db, pid).await.ok().flatten() {
            Some(p) => ollama::ChatParams { model: p.model, temperature: p.temperature, max_tokens: p.max_tokens, num_ctx: None, endpoint: p.endpoint },
            None => fallback.clone(), // stale pointer → behave as unrouted
        },
        None => fallback.clone(),
    }
}

/// The result of a dispatched agent task: the model's text response + the cost
/// meter fields the caller writes to `agent_actions`. `dispatch_agent_task`
/// writes the cost row itself (it has the full context); this struct carries
/// the response text + meter for the caller to use.
#[derive(Debug, Clone)]
pub struct AgentTaskResult {
    pub text: String,
    pub model: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// In-memory store for async agent-task results. A long-running task (pi takes
/// 30-60s+) cannot hold an HTTP connection open — Tailscale/reqwest drop idle
/// connections well before the model responds. So the endpoint spawns the task,
/// returns a job_id immediately, and the frontend polls GET /ai/agent-task/:id.
use serde::Serialize;

pub(crate) type AgentTaskStore = std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, AgentTaskStatus>>>;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AgentTaskStatus {
    /// `progress` lets a long job narrate itself (the Oracle runner reports
    /// per-node state here) — pollers that only read `status` are unaffected.
    Running { progress: Option<serde_json::Value> },
    Done { result: serde_json::Value, error: Option<String> },
}

fn agent_task_store() -> &'static AgentTaskStore {
    static STORE: std::sync::OnceLock<AgentTaskStore> = std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())))
}

/// Dispatch an agent task through the protocol layer. This is the indirection
/// seam (build brief #2): features call this, never a runner directly. The
/// protocol decides runner (Ollama free / pi paid) + model. A cost row is
/// written to `agent_actions` on EVERY invocation (success or failure) — the
/// caller passes the project/user/profile context for the ledger.
///
/// Mirrors `routines.rs::run_routine` (dispatch → run → ledger) but for
/// on-demand tasks rather than scheduled routines.
pub(crate) async fn dispatch_agent_task(
    db: &Db,
    ollama: Option<&ollama::OllamaClient>,
    task_class: &str,
    prompt: &str,
    system_prompt: Option<&str>,
    project_id: Option<i64>,
    user_id: i64,
    profile_id: Option<i64>,
) -> Result<AgentTaskResult, AppError> {
    let protocol = resolve_protocol(db, task_class).await;
    run_agent_protocol(db, ollama, &protocol, task_class, prompt, system_prompt, project_id, user_id, profile_id, "applied").await
}

/// Execute ONE runner invocation under an explicit protocol and write the
/// ledger row. `dispatch_agent_task` resolves the active protocol and calls
/// this with status "applied"; the R.2 dry-run harness builds a protocol from
/// the version UNDER TEST and calls it with status "dryrun" — same engine
/// path, same cost metering, clearly labeled in the ledger.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_agent_protocol(
    db: &Db,
    ollama: Option<&ollama::OllamaClient>,
    protocol: &Protocol,
    task_class: &str,
    prompt: &str,
    system_prompt: Option<&str>,
    project_id: Option<i64>,
    user_id: i64,
    profile_id: Option<i64>,
    ledger_status: &str,
) -> Result<AgentTaskResult, AppError> {
    let start = std::time::Instant::now();

    let (result_text, model, prompt_tokens, completion_tokens) = match protocol.runner {
        Runner::Ollama => {
            let client = ollama.ok_or_else(|| AppError::NotFound(
                "chat is not enabled on this host — start Ollama or route this task to pi".into()
            ))?;
            // Resolve params: the protocol's profile, else the active profile,
            // else the legacy fallback.
            let (mut params, default_system) = resolve_profile(db, protocol.profile_id).await;
            let system = system_prompt.unwrap_or(&default_system);
            // Agent tasks are structured-extraction jobs, not chat turns.
            // Two silent truncation traps (both seen in testing):
            //  1. The profile's chat-tuned max_tokens clamps the OUTPUT — a
            //     250-entry ToC JSON is ~10k tokens. Floor it at 16k.
            //  2. Ollama's DEFAULT num_ctx (2048-4096) truncates the INPUT —
            //     10 OCR'd pages blow past it and the model never sees the
            //     tail. Size the context to prompt + output headroom
            //     (chars/3 ≈ conservative token estimate), capped at 32k.
            params.max_tokens = Some(params.max_tokens.unwrap_or(0).max(16384));
            let est_prompt_tokens = ((prompt.len() + system.len()) / 3) as i64;
            // 64k ceiling: Oracle's llm.transform input cap now reaches 120k
            // chars (~40k tokens) — a 32k ctx would silently starve the tail.
            // num_ctx only grows when the prompt actually does; small tasks
            // still run at 8k.
            params.num_ctx = Some((est_prompt_tokens + 16384).clamp(8192, 65536));
            let messages = vec![
                serde_json::json!({ "role": "system", "content": system }),
                serde_json::json!({ "role": "user", "content": prompt }),
            ];
            let turn = client.chat_once(&params, &messages, &[]).await
                .map_err(|e| {
                    let msg = e.to_string();
                    // A model-not-found error is the most common failure: the
                    // protocol resolved to an Ollama profile whose model isn't
                    // pulled on this host. Give the user an actionable message
                    // instead of the raw Ollama 404.
                    if msg.contains("not found") && msg.contains("model") {
                        AppError::InvalidInput(format!(
                            "Ollama model '{}' is not available on this host. \
                             Pull it (ollama pull <model>) or route the '{}' task to pi \
                             in Settings → AI → Personalities → Task routing.",
                            params.model, task_class
                        ))
                    } else {
                        AppError::InvalidInput(format!("Ollama failed: {e}"))
                    }
                })?;
            (turn.content, Some(params.model.clone()),
             Some(turn.usage.prompt_tokens), Some(turn.usage.completion_tokens))
        }
        Runner::Pi => {
            let pi_binary = pi_rpc::resolve_pi_binary(db).await.ok_or_else(|| AppError::InvalidInput(
                "pi is not installed or not configured — set the binary path in Settings".into()
            ))?;
            // Sandboxed tempdir cwd; pi runs with tools:[read] only.
            let cwd = std::env::temp_dir().join(format!("ganban-pi-task-{}-{}", task_class, std::process::id()));
            std::fs::create_dir_all(&cwd).map_err(AppError::from)?;
            let r = pi_rpc::run_once(&pi_binary, protocol.model.as_deref(), prompt, &cwd, true).await?;
            let _ = std::fs::remove_dir_all(&cwd); // best-effort cleanup
            (r.text, r.model, r.prompt_tokens, r.completion_tokens)
        }
    };
    let duration_ms = start.elapsed().as_millis() as i64;

    // Write the cost row on EVERY invocation (build brief #7). Even failures
    // above return early with Err — but a failure past this point still logs.
    let result_for_ledger = serde_json::json!({ "task_class": task_class, "chars": result_text.len() }).to_string();
    if let Err(e) = ops::record_agent_action(db, ops::NewAgentAction {
        status: ledger_status,
        user_id,
        profile_id,
        project_id,
        chat_id: None,
        routine_id: None,
        tool: task_class,
        summary: &format!("Agent task '{}'", task_class),
        args_json: &serde_json::json!({ "runner": format!("{:?}", protocol.runner).to_lowercase() }).to_string(),
        result_json: Some(&result_for_ledger),
        model: model.as_deref(),
        prompt_tokens,
        completion_tokens,
        duration_ms: Some(duration_ms),
        protocol_slug: protocol.slug.as_deref(),
        protocol_version: protocol.version,
        content_hash: protocol.content_hash.as_deref(),
        parent_action_id: None,
        approver_id: None,
    }).await {
        tracing::warn!("agent task '{}' completed but could not ledger it: {e}", task_class);
    }

    Ok(AgentTaskResult { text: result_text, model, prompt_tokens, completion_tokens, duration_ms: Some(duration_ms) })
}

/// Legacy/fallback singleton profile from the `chat_profile` app_setting (env +
/// built-in default behind it). Used until a model_profiles row is active.
async fn chat_profile_fallback(db: &Db) -> (ollama::ChatParams, String) {
    let cfg: Value = ops::get_app_setting(db, "chat_profile")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let gets = |k: &str| cfg.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
    let model = gets("model")
        .or_else(|| std::env::var("GANBAN_CHAT_MODEL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "llama3.1:8b".into());
    let temperature = cfg
        .get("temperature")
        .and_then(|v| v.as_f64())
        .or_else(|| std::env::var("GANBAN_CHAT_TEMPERATURE").ok().and_then(|s| s.parse().ok()));
    let max_tokens = cfg
        .get("max_tokens")
        .and_then(|v| v.as_i64())
        .or_else(|| std::env::var("GANBAN_CHAT_MAX_TOKENS").ok().and_then(|s| s.parse().ok()));
    let system = gets("system_prompt")
        .or_else(|| std::env::var("GANBAN_CHAT_SYSTEM_PROMPT").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.into());
    (ollama::ChatParams { model, temperature, max_tokens, num_ctx: None, endpoint: None }, system)
}

fn hit_label(source: &str) -> &'static str {
    if source.starts_with("task-") {
        "Task"
    } else if source.starts_with("area-") {
        "Area"
    } else if source == "project.md" {
        "Project"
    } else {
        "File"
    }
}

#[derive(Deserialize)]
struct ChatBody {
    project_id: i64,
    #[serde(default)]
    chat_id: Option<i64>,
    message: String,
    #[serde(default)]
    top_k: Option<i64>,
    #[serde(default)]
    profile_id: Option<i64>,
    /// Opt-in: let the model call read tools (project-scoped) before answering.
    #[serde(default)]
    use_tools: bool,
}

/// Per-project RAG chat (Server-Sent Events). Scope = project membership (same
/// as /search). Retrieves context via ragrat (best-effort), generates via the
/// local Ollama, streams `token` events, then persists the assistant turn and
/// emits `sources` + `done`. A mid-stream disconnect discards the partial.
async fn chat_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    Extension(hub): Extension<events::EventHub>,
    user: AuthUser,
    Json(body): Json<ChatBody>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError> {
    let ollama = ollama.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("chat is not enabled on this host".into())))?;
    let rag = rag.read().await.clone();
    require_chat_project(&db, &user, body.project_id).await?;
    if body.message.trim().is_empty() {
        return Err(ApiError(AppError::InvalidInput("empty message".into())));
    }
    // Continuing a thread: it must belong to this project (don't leak others'),
    // and only its author may write to it — a published chat is readable by the
    // team but not continuable by them (the UI enforces this too).
    if let Some(cid) = body.chat_id {
        match ops::get_chat(&db, cid).await? {
            Some(c) if c.project_id == body.project_id => {
                if c.user_id != Some(user.id) {
                    return Err(ApiError(AppError::Forbidden("this chat belongs to a teammate".into())));
                }
            }
            _ => return Err(ApiError(AppError::NotFound("chat not found".into()))),
        }
    }

    // An explicit profile (e.g. an @mention) wins; otherwise use the project's
    // configured assistant; otherwise the globally-active profile (resolve_profile).
    let profile_id = match body.profile_id {
        Some(p) => Some(p),
        None => ops::get_project_model_profile(&db, body.project_id).await.ok().flatten(),
    };
    let (params, system_prompt) = resolve_profile(&db, profile_id).await;
    // A Personal chat may hold figures from the finance tools in its history, so it runs on a
    // local model only, tools on or off (FINANCE.md § Assistant).
    if finance_tools::is_own_personal(&db, user.id, body.project_id).await
        && !finance_tools::engine_is_local(&Runner::Ollama, &params, &ollama.config().base_url)
    {
        return Err(ApiError(AppError::InvalidInput(
            "Personal chats run on local models only: pick a personality on a local Ollama model".into(),
        )));
    }

    // Loadouts (Step 3): the personality's assigned loadouts SCOPE which tools
    // it may use, contribute system-prompt fragments, and may route the tool
    // loop to a sub-model. No loadout assigned = today's behaviour (every
    // enabled tool, global tool tier).
    let loadouts = match profile_id {
        Some(pid) => ops::profile_loadouts(&db, pid).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let mut loadout_fragments: Vec<String> = Vec::new();
    let mut loadout_tool_filter: Option<std::collections::HashSet<String>> = None;
    let mut loadout_routing: Option<i64> = None;
    if !loadouts.is_empty() {
        let mut allowed = std::collections::HashSet::new();
        for l in &loadouts {
            if let Some(f) = l.prompt_fragment.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                loadout_fragments.push(f.to_string());
            }
            if loadout_routing.is_none() {
                loadout_routing = l.routing_profile_id;
            }
            for t in ops::loadout_tool_names(&db, l.id).await.unwrap_or_default() {
                allowed.insert(t);
            }
        }
        loadout_tool_filter = Some(allowed);
    }

    // Retrieve project context — best-effort, so chat still works if RAG is
    // disabled/down/empty (the model just answers without grounding).
    let mut sources: Vec<Value> = Vec::new();
    let mut context = String::new();
    if let Some(rc) = &rag {
        if !rag::ai_files_enabled(&db, body.project_id).await {
            // Owner disabled AI file access: chat proceeds ungrounded.
        } else {
        let top_k = body.top_k.unwrap_or(8).clamp(1, 20);
        if let Ok(mut hits) = rc.search(&rag::collection_name(body.project_id), &body.message, top_k, None).await {
            // Ground only on what the asker can see (task visibility).
            if rag::retain_visible_hits(&db, commands::viewer_of(&user), body.project_id, &mut hits).await.is_err() {
                hits.clear();
            }
            for h in &hits {
                let src = h.get("source").and_then(|s| s.as_str()).unwrap_or("");
                let text = h.get("text").and_then(|t| t.as_str()).unwrap_or("");
                context.push_str(&format!("[{src}] {text}\n\n"));
                sources.push(json!({ "source": src, "score": h.get("score").cloned().unwrap_or(Value::Null), "label": hit_label(src) }));
            }
        }
        }
    }

    // system (+context) + recent history + the new user turn.
    let mut sys = if context.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n## Project context\n\n{context}")
    };
    // A personality's loadouts speak through their prompt fragments (the "skill"
    // instructions/voice), appended after its base persona + the grounding.
    for f in &loadout_fragments {
        sys.push_str("\n\n");
        sys.push_str(f);
    }
    // Capability honesty: small models confidently narrate actions they never
    // took (observed: "I have deleted the events" with tools off). Tell the
    // model exactly what it can and cannot do in this conversation.
    sys.push_str(if body.use_tools {
        "\n\nYou have agent tools in this conversation, and they are LIVE and authoritative — they override anything earlier in this prompt about what you can or cannot access. If the user needs information you would otherwise lack (current, external, web, or live data) and a tool can fetch it, CALL that tool instead of replying that you have no access; only after the tool returns nothing should you say so. Reads execute immediately. Writes NEVER execute directly — they only create proposals the user must approve, so never claim a change has been made; say it awaits the user's approval. Only describe actions you actually invoked as tool calls; if you did not call a tool, do not imply you acted. When the user asks for a change to MANY items (\"link all…\", \"create these…\"), keep calling the write tool once per item until every item has its own proposal — do not stop after the first — then summarize what you proposed."
    } else {
        "\n\nYou have NO tools in this conversation: you cannot create, edit, delete, move, or link anything, and you cannot look up live data. If the user asks you to perform an action, do not pretend to do it or claim it is done — tell them to enable Tools mode (the 🔧 toggle under the message box) and ask again."
    });
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": sys })];
    if let Some(cid) = body.chat_id {
        let history = ops::get_chat_messages(&db, cid).await.unwrap_or_default();
        let start = history.len().saturating_sub(20); // cap context window
        for m in &history[start..] {
            messages.push(json!({ "role": m.role, "content": m.content }));
        }
    }
    messages.push(json!({ "role": "user", "content": body.message }));

    // Agentic tools (opt-in). Read tools (tasks/events/comments/corpus) execute
    // automatically, scoped to this project; write tools (create/update/delete
    // task, comment) are NEVER auto-run — they come back as proposals the user
    // approves. Capped + best-effort; the answer itself still streams below.
    let mut tools_used: Vec<String> = Vec::new();
    let mut prepared_writes: Vec<tools::PreparedWrite> = Vec::new();
    // Capacity meter: token/latency totals for this turn (tool rounds + the
    // final streamed answer, summed at persist time).
    let mut turn_usage = ollama::Usage::default();
    // Live agent work (the timer's "Agents"): the tasks this turn's tools touch, under
    // the personality's name, until the turn ends. Dropped with the answer stream, so
    // a failed or abandoned turn clears itself too.
    let personality = match profile_id {
        Some(pid) => ops::get_model_profile(&db, pid).await.ok().flatten(),
        None => ops::active_model_profile(&db).await.ok().flatten(),
    }
    .map(|p| p.name)
    .unwrap_or_else(|| "Assistant".into());
    let agent_run = agent_work::Run::start(&hub, user.id, user.is_owner, body.project_id, &personality);
    if body.use_tools {
        // ask_atlas exists when the knowledge engine is up AND the workspace
        // has Atlas collections to ask about.
        let atlas_on = rag.is_some()
            && !ops::list_atlas_collections(&db).await.unwrap_or_default().is_empty();
        let mut tool_defs = tools::ollama_tools(rag.is_some(), atlas_on);
        tool_defs.extend(tools::ollama_write_tools());
        // Tabs enabled on this project contribute their tool bundles — through
        // the same registry and gate, never around them.
        let enabled_tabs = ops::enabled_project_tabs(&db, body.project_id).await.unwrap_or_default();
        tool_defs.extend(tabs::tool_defs_for(&enabled_tabs));
        // Declarative registry tools (owner-defined, data-bound) ride the same
        // loop + gate as everything else. rag needs the engine; mcp is owner-only.
        tool_defs.extend(tools::registry_tool_defs(&db, rag.is_some(), user.is_owner).await);
        // Loadout scoping: if the personality carries loadouts, restrict the
        // offered tools to the union they grant (∩ what's enabled above). No
        // loadout → the full set is offered, exactly as before.
        if let Some(filter) = &loadout_tool_filter {
            tool_defs.retain(|d| {
                d.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .map(|n| filter.contains(n))
                    .unwrap_or(false)
            });
        }
        // Teamwork (DELEGATE.md decision 3): the `delegate` tool is OFF by
        // default — offered ONLY when one of this personality's loadouts
        // grants a tool named "delegate". Pushed after the retain because it
        // is not part of the base defs; the loadout grant IS its gate.
        if loadout_tool_filter.as_ref().is_some_and(|f| f.contains("delegate")) {
            tool_defs.push(crate::delegate::delegate_tool_def());
        }
        // Route the tool loop: a loadout's routed sub-model wins, else the
        // configured global tool tier (Settings → Personalities → Tool runner);
        // the personality's own model still writes the final streamed answer.
        let tool_params = match loadout_routing {
            Some(rpid) => match ops::get_model_profile(&db, rpid).await.ok().flatten() {
                Some(p) => ollama::ChatParams { model: p.model, temperature: p.temperature, max_tokens: p.max_tokens, num_ctx: None, endpoint: p.endpoint },
                None => resolve_task_params(&db, "tools", &params).await,
            },
            None => resolve_task_params(&db, "tools", &params).await,
        };
        // The runner the tool tier names (a loadout's routed sub-model is an Ollama profile).
        let tool_runner = match loadout_routing {
            Some(_) => Runner::Ollama,
            None => resolve_protocol(&db, "tools").await.runner,
        };
        // Finance reads: only in the caller's own Personal chat, only when the tool loop
        // and the answer both run on a local Ollama model (FINANCE.md § Assistant). A
        // loadout still scopes them like any other tool.
        // The answer streams through Ollama's chat API (`chat_stream`), so its runner is Ollama.
        let host_url = ollama.config().base_url.clone();
        let finance_engines_local = finance_tools::engine_is_local(&Runner::Ollama, &params, &host_url);
        let finance_defs: Vec<Value> = if finance_engines_local {
            finance_tools::offered_defs(&db, user.id, body.project_id, &tool_runner, &tool_params, &host_url).await
        } else {
            Vec::new()
        }
        .into_iter()
        .filter(|d| {
            let name = d["function"]["name"].as_str().unwrap_or("");
            loadout_tool_filter.as_ref().is_none_or(|f| f.contains(name))
        })
        .collect();
        if !finance_defs.is_empty() {
            if let Some(Value::String(content)) = messages.first_mut().and_then(|m| m.get_mut("content")) {
                content.push_str(&finance_tools::prompt_note(chrono::Local::now().date_naive()));
            }
            tool_defs.extend(finance_defs);
        }
        // Epoch H: the tool tier may designate a remote engine.
        let tool_client = ollama::OllamaClient::for_params(&ollama, &tool_params);
        // When the answering model isn't local, the finance gate must fail at execution too,
        // so the loop is told the turn isn't on a local Ollama runner.
        let runner = if finance_engines_local { tool_runner } else { Runner::Pi };
        let (used, prepared, loop_usage) = tools::run_tool_loop(
            &db, rag.as_ref(), &tool_client, &tool_params, &mut messages, &tool_defs, body.project_id, user.id, user.is_owner, &agent_run, &runner,
        )
        .await;
        tools_used = used;
        prepared_writes = prepared;
        turn_usage.add(loop_usage);
    }

    // Start the model stream BEFORE persisting anything, so a failed start
    // (Ollama down) leaves no dangling chat/message rows.
    let answer_client = ollama::OllamaClient::for_params(&ollama, &params);
    let (delta_stream, stream_usage) = match answer_client.chat_stream(&params, messages).await {
        Ok(s) => s,
        Err(e) => {
            // A sleeping remote box is an expected state: answer with the
            // profile's declared fallback note instead of a bare transport error.
            if params.endpoint.is_some() {
                let note = match body.profile_id {
                    Some(pid) => ops::get_model_profile(&db, pid).await.ok().flatten().and_then(|p| p.fallback_note),
                    None => ops::active_model_profile(&db).await.ok().flatten().and_then(|p| p.fallback_note),
                };
                let note = note.unwrap_or_else(|| "its remote engine looks offline — try again when it's awake, or switch the profile to a local model".into());
                return Err(ApiError(AppError::InvalidInput(format!("This personality couldn't answer: {note} ({e})"))));
            }
            return Err(ApiError(AppError::Io(std::io::Error::other(format!("ollama: {e}")))));
        }
    };

    // Create the thread (if new) + record the user turn.
    let chat_id = match body.chat_id {
        Some(cid) => cid,
        None => {
            let title: String = body.message.chars().take(60).collect();
            ops::create_chat(&db, body.project_id, Some(user.id), None, Some(&title)).await?.id
        }
    };
    ops::append_message(&db, chat_id, "user", &body.message, None, None, None, None, None, None).await?;

    // Register proposals only now that the thread exists, so each one carries the
    // conversation it came from into the action ledger on approval/rejection.
    let mut proposal_payload: Vec<Value> = Vec::with_capacity(prepared_writes.len());
    for pw in prepared_writes {
        match ganban_core::proposals::register(
            &db, body.project_id, user.id, profile_id, chat_id, pw.command, &pw.args, &pw.summary, &pw.details, None,
        )
        .await
        {
            Ok(id) => proposal_payload.push(json!({ "id": id, "tool": pw.command, "summary": pw.summary, "details": pw.details })),
            Err(e) => tracing::warn!("could not store a proposal ({}): {e}", pw.command),
        }
    }
    let proposal_payload = proposal_payload;

    let db2 = db.clone();
    let sources_payload = serde_json::to_string(&sources).unwrap_or_else(|_| "[]".into());
    let tools_payload = serde_json::to_string(&tools_used).unwrap_or_else(|_| "[]".into());
    let had_tools = !tools_used.is_empty();
    let tools_json_save = had_tools.then(|| tools_payload.clone());
    let proposals_payload = serde_json::to_string(&proposal_payload).unwrap_or_else(|_| "[]".into());
    let had_proposals = !proposal_payload.is_empty();
    // A tool-heavy turn can legitimately stream zero prose (the model said its
    // piece in tool calls). The turn must STILL be persisted — a vanished turn
    // confuses the user AND erases the model's own memory that it was
    // mid-task, which is how "link them all" dies after item one.
    let fallback_content = if had_proposals {
        let mut s =
            String::from("I've prepared the following changes — nothing is applied until you approve each one:");
        for p in &proposal_payload {
            if let Some(sum) = p.get("summary").and_then(|v| v.as_str()) {
                s.push_str("\n• ");
                s.push_str(sum);
            }
        }
        s
    } else {
        String::from("(I consulted tools but produced no answer — ask again if something is missing.)")
    };
    let model_name = params.model.clone();
    let sse = stream! {
        // Owned by the stream, so the run ends when the answer does, errors or is dropped.
        let _agent_run = agent_run;
        // Surface what we grounded on up front, so references show *before* the
        // answer (LM-Studio-style "tool use"), then signal that the model is
        // generating. The client shows a "retrieving context" state for the gap
        // before this first frame arrives.
        if had_tools {
            yield Ok(Event::default().event("tools").data(tools_payload.clone()));
        }
        if had_proposals {
            yield Ok(Event::default().event("proposals").data(proposals_payload.clone()));
        }
        yield Ok(Event::default().event("sources").data(sources_payload.clone()));
        yield Ok(Event::default().event("stage").data(json!({ "stage": "generating", "model": model_name }).to_string()));
        futures_util::pin_mut!(delta_stream);
        let mut full = String::new();
        let mut errored = false;
        while let Some(item) = delta_stream.next().await {
            match item {
                Ok(delta) => {
                    full.push_str(&delta);
                    yield Ok(Event::default().event("token").data(delta));
                }
                Err(e) => {
                    errored = true;
                    yield Ok(Event::default().event("error").data(e));
                    break;
                }
            }
        }
        // Persist the assistant turn once the upstream stream completed — also
        // when the prose is empty but the turn did tool work or made proposals
        // (otherwise the turn vanishes on reload and from the model's memory).
        if !errored && (!full.is_empty() || had_tools || had_proposals) {
            let content = if full.is_empty() { fallback_content.clone() } else { full };
            // Total turn cost = tool rounds + the streamed answer.
            let mut total = turn_usage;
            if let Some(u) = *stream_usage.lock().unwrap() {
                total.add(u);
            }
            let saved = ops::append_message(
                &db2, chat_id, "assistant", &content, Some(&sources_payload), tools_json_save.as_deref(),
                Some(&model_name), Some(total.prompt_tokens), Some(total.completion_tokens), Some(total.duration_ms),
            ).await;
            let msg_id = saved.map(|m| m.id).unwrap_or(0);
            yield Ok(Event::default().event("done").data(json!({ "chat_id": chat_id, "message_id": msg_id, "usage": total }).to_string()));
        }
    };
    Ok(Sse::new(sse).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct ListChatsQuery {
    project_id: i64,
}

/// A member's chat threads in a project (their own only).
async fn list_chats_handler(
    State(db): State<Db>,
    user: AuthUser,
    Query(q): Query<ListChatsQuery>,
) -> Result<Json<Vec<Chat>>, ApiError> {
    require_chat_project(&db, &user, q.project_id).await?;
    let mut chats = ops::list_chats(&db, q.project_id, Some(user.id)).await?;
    // Stamp authorship server-side, so the client never has to guess who "me" is.
    for c in &mut chats {
        c.is_mine = c.user_id == Some(user.id);
    }
    Ok(Json(chats))
}

#[derive(Deserialize)]
struct SetPublicBody {
    public: bool,
}

/// Publish or unpublish a chat to the project team. The author may share their
/// own thread; project admins may manage anyone's.
async fn chat_set_public(
    State(db): State<Db>,
    user: AuthUser,
    Path(cid): Path<i64>,
    Json(body): Json<SetPublicBody>,
) -> Result<Json<Chat>, ApiError> {
    let pid = ops::chat_project(&db, cid)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("chat".into())))?;
    require_chat_project(&db, &user, pid).await?;
    let chat = ops::get_chat(&db, cid)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("chat".into())))?;
    if chat.user_id != Some(user.id) {
        require(&db, &user, pid, auth::ROLE_ADMIN).await?;
    }
    if body.public && finance_tools::is_own_personal(&db, user.id, pid).await {
        return Err(ApiError(AppError::InvalidInput("a Personal chat stays private to you".into())));
    }
    Ok(Json(ops::set_chat_public(&db, cid, body.public).await?))
}

#[derive(Deserialize)]
struct SetPinnedBody {
    pinned: bool,
}

/// Pin/unpin a chat (author-or-admin, like the other manage actions).
async fn chat_set_pinned(
    State(db): State<Db>,
    user: AuthUser,
    Path(cid): Path<i64>,
    Json(body): Json<SetPinnedBody>,
) -> Result<Json<Chat>, ApiError> {
    chat_for_manage(&db, &user, cid).await?;
    Ok(Json(ops::set_chat_pinned(&db, cid, body.pinned).await?))
}

// ---------------- Atlas (Epoch I): shared knowledge collections ---------------- //

/// The ragrat collection an Atlas slug maps to. Read routes resolve through
/// the registry, so a member request can NEVER name a project corpus.
fn atlas_collection_name(slug: &str) -> String {
    format!("atlas-{slug}")
}

async fn atlas_rag(rag: &rag::SharedRag) -> Result<rag::RagClient, ApiError> {
    rag.read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("Atlas needs the optional knowledge engine, which isn't set up on this host — set up ragrat in Settings → AI Engines".into())))
}

async fn atlas_by_slug(db: &Db, slug: &str) -> Result<AtlasCollection, ApiError> {
    ops::get_atlas_collection_by_slug(db, slug)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound(format!("no Atlas collection '{slug}'"))))
}

/// Resolve a collection for a MEMBER read. An owner-private collection is
/// invisible to non-owners — returned as 404 (not 403) so its very existence
/// isn't revealed to someone who guessed the slug.
async fn atlas_by_slug_visible(db: &Db, slug: &str, user: &AuthUser) -> Result<AtlasCollection, ApiError> {
    let col = atlas_by_slug(db, slug).await?;
    if col.owner_only && !user.is_owner {
        return Err(ApiError(AppError::NotFound(format!("no Atlas collection '{slug}'"))));
    }
    Ok(col)
}

/// Members read the registry — Atlas is workspace knowledge, like the calendar —
/// EXCEPT owner-private collections, which never appear for a non-owner.
async fn atlas_list_handler(State(db): State<Db>, user: AuthUser) -> Result<Json<Vec<AtlasCollection>>, ApiError> {
    let mut cols = ops::list_atlas_collections(&db).await?;
    if !user.is_owner {
        cols.retain(|c| !c.owner_only);
    }
    Ok(Json(cols))
}

#[derive(Deserialize)]
struct AtlasCreateBody {
    slug: String,
    name: String,
    /// Empty = a MANAGED library collection: Ganban creates and owns
    /// `<storage root>/atlas/<slug>/` and the owner uploads into it from the
    /// Atlas › Library tab. Non-empty = the classic point-at-a-host-folder.
    #[serde(default)]
    source_dir: String,
    #[serde(default)]
    owner_only: bool,
}

/// Whether a collection's folder is Ganban-managed (under the storage root's
/// atlas tree). Uploads/deletes are refused elsewhere — “we never write into
/// source folders” stays true for folders the USER owns.
fn atlas_is_managed(root: &std::path::Path, col: &AtlasCollection) -> bool {
    std::path::Path::new(&col.source_dir).starts_with(root.join("atlas"))
}

/// A library-relative path, sanitized: forward slashes, no traversal, no
/// absolute paths, no hidden segments. Rejects, never rewrites.
fn atlas_rel_path(raw: &str) -> Result<std::path::PathBuf, ApiError> {
    let raw = raw.trim().replace('\\', "/");
    if raw.is_empty() || raw.len() > 512 {
        return Err(ApiError(AppError::InvalidInput("bad file path".into())));
    }
    let mut out = std::path::PathBuf::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.') {
            return Err(ApiError(AppError::InvalidInput(format!("path segment '{seg}' is not allowed"))));
        }
        out.push(seg);
    }
    Ok(out)
}

/// Kick an ingest of a collection's source folder (shared by create/reingest).
async fn atlas_ingest(db: &Db, client: &rag::RagClient, col: &AtlasCollection) -> Result<String, ApiError> {
    let src = std::path::Path::new(&col.source_dir);
    if !src.is_dir() {
        return Err(ApiError(AppError::InvalidInput(format!(
            "source folder {} does not exist on the host",
            col.source_dir
        ))));
    }
    let collection = atlas_collection_name(&col.slug);
    let out = client.config().out_root.join(&collection);
    // Stage (copy + pin the embedder) — ingesting the raw folder produces an
    // index-less, unsearchable collection (ragrat defaults: embedding OFF).
    let staged = rag::stage_atlas(&db.clone(), client.config(), &col.slug, src)
        .await
        .map_err(|e| ApiError(AppError::InvalidInput(e)))?;
    let job = client
        .ingest(&staged, &out, &collection, json!({ "atlas": col.slug }))
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    ops::touch_atlas_ingest(db, col.id).await?;
    let _ = ops::clear_atlas_dirty(db, col.id).await;
    Ok(job)
}

/// Owner-only: register a collection and start its first ingest.
async fn atlas_create_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Json(body): Json<AtlasCreateBody>,
) -> Result<Json<Value>, ApiError> {
    let managed = body.source_dir.trim().is_empty();
    let source_dir = if managed {
        // A managed LIBRARY collection: Ganban owns the folder; the owner
        // fills it from the Library tab and indexes when ready.
        let dir = root.0.join("atlas").join(body.slug.trim());
        std::fs::create_dir_all(&dir).map_err(AppError::from)?;
        dir.to_string_lossy().to_string()
    } else {
        body.source_dir.clone()
    };
    let col = ops::create_atlas_collection(&db, body.slug.trim(), &body.name, &source_dir, body.owner_only).await?;
    // A pointed-at folder has content NOW → ingest immediately (engine up).
    // A managed library starts EMPTY → never auto-ingest at create; the owner
    // dumps documents in and presses “Index now” (or enables auto-index).
    let job = if managed {
        None
    } else {
        match rag.read().await.clone() {
            Some(client) => atlas_ingest(&db, &client, &col).await.ok(),
            None => None,
        }
    };
    Ok(Json(json!({ "collection": col, "job_id": job })))
}

#[derive(Deserialize)]
struct AtlasVisibilityBody {
    owner_only: bool,
}

/// Owner-only: flip a collection's owner-private flag. Private collections vanish
/// from members' Atlas page + read routes; the project Atlas lens stays the
/// curated way owner-private knowledge reaches a member.
async fn atlas_visibility_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<AtlasVisibilityBody>,
) -> Result<Json<Value>, ApiError> {
    ops::set_atlas_visibility(&db, id, body.owner_only).await?;
    Ok(Json(json!({ "ok": true, "owner_only": body.owner_only })))
}

/// Owner-only: unregister. The corpus dir stays on disk — deleting indexed
/// knowledge is a manual act, not a click.
async fn atlas_delete_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let col = ops::get_atlas_collection(&db, id).await?;
    ops::delete_atlas_collection(&db, id).await?;
    // Take the indexed data with it, and say how much that was. Best-effort:
    // unregistering must work even with ragrat down (freed reported as null).
    let mut freed = Value::Null;
    if let (Some(col), Some(client)) = (col, rag.read().await.clone()) {
        if let Ok(v) = client.delete_collection(&atlas_collection_name(&col.slug)).await {
            freed = v;
        }
    }
    Ok(Json(json!({ "ok": true, "freed": freed })))
}

#[derive(Deserialize)]
struct AiFilesBody {
    enabled: bool,
}

/// The Project Settings "Allow AI access to files" switch, server-side:
/// persists the flag, and on DISABLE deletes the project's ragrat collection
/// (quantified — freed bytes come back to the UI) and clears the index stamp
/// so a future re-enable starts a fresh ingest.
async fn project_ai_files_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Path(pid): Path<i64>,
    Json(body): Json<AiFilesBody>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_ADMIN).await?;
    ops::set_app_setting(&db, &format!("rag_files_enabled_{pid}"), if body.enabled { "1" } else { "0" }).await?;
    let mut freed = Value::Null;
    if !body.enabled {
        let _ = ops::set_app_setting(&db, &format!("rag_stamp_{pid}"), "").await;
        if let Some(client) = rag.read().await.clone() {
            if let Ok(v) = client.delete_collection(&rag::collection_name(pid)).await {
                freed = v;
            }
        }
    }
    Ok(Json(json!({ "enabled": body.enabled, "freed": freed })))
}

async fn atlas_reingest_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let col = ops::get_atlas_collection(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
    let client = atlas_rag(&rag).await?;
    let job = atlas_ingest(&db, &client, &col).await?;
    Ok(Json(json!({ "job_id": job })))
}

#[cfg(test)]
mod atlas_library_tests {
    use super::*;

    /// The Library write path is the ONE place clients name host paths —
    /// sanitize rejects, never rewrites.
    #[test]
    fn library_paths_reject_traversal_and_hidden_segments() {
        assert!(atlas_rel_path("charters/2026/panamax.pdf").is_ok());
        assert!(atlas_rel_path("a.pdf").is_ok());
        for bad in ["../etc/passwd", "a/../../b", "/abs/path", "a//b", ".hidden/x", "a/.ssh/keys", ""] {
            assert!(atlas_rel_path(bad).is_err(), "must reject '{bad}'");
        }
        // Backslashes normalize to separators, then the same rules apply.
        assert!(atlas_rel_path("..\\up").is_err());
    }

    #[test]
    fn managed_means_under_the_storage_roots_atlas_tree() {
        let root = std::path::Path::new("/srv/ganban");
        let mk = |dir: &str| AtlasCollection {
            id: 1, slug: "x".into(), name: "X".into(), source_dir: dir.into(),
            owner_only: false, auto_index: false, dirty_at: None,
            created_at: chrono::Utc::now(), last_ingest_at: None,
        };
        assert!(atlas_is_managed(root, &mk("/srv/ganban/atlas/x")));
        assert!(!atlas_is_managed(root, &mk("/home/user/docs")), "user folders are never written to");
        assert!(!atlas_is_managed(root, &mk("/srv/ganban/projects/3")), "project storage is not the library");
    }
}

#[derive(Deserialize)]
struct AtlasFileQuery {
    /// Library-relative path ("folder/file.pdf") — sanitized, never rewritten.
    rel_path: String,
}

/// The files currently in a collection's source folder (owner; any collection
/// — listing is read-only). rel_path + size + mtime, walked to depth 8.
async fn atlas_files_list_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let col = ops::get_atlas_collection(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
    let base = std::path::PathBuf::from(&col.source_dir);
    let mut files: Vec<Value> = Vec::new();
    fn walk(base: &std::path::Path, dir: &std::path::Path, depth: u32, out: &mut Vec<Value>) {
        if depth > 8 || out.len() > 5000 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let p = entry.path();
            let Ok(ty) = entry.file_type() else { continue };
            if ty.is_dir() {
                walk(base, &p, depth + 1, out);
            } else if ty.is_file() {
                let meta = entry.metadata().ok();
                let modified = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                out.push(json!({
                    "rel_path": p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/"),
                    "size_bytes": meta.map(|m| m.len()).unwrap_or(0),
                    "modified": modified,
                }));
            }
        }
    }
    walk(&base, &base, 0, &mut files);
    files.sort_by(|a, b| a["rel_path"].as_str().cmp(&b["rel_path"].as_str()));
    Ok(Json(json!({
        "files": files,
        "managed": atlas_is_managed(&root.0, &col),
        "dirty_at": col.dirty_at,
        "last_ingest_at": col.last_ingest_at,
        "auto_index": col.auto_index,
    })))
}

/// Upload one file into a MANAGED library folder (raw body). Never indexes —
/// it stamps dirty_at, and either the owner presses “Index now” or the
/// auto-index debounce picks it up after a quiet period.
async fn atlas_file_upload_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Query(q): Query<AtlasFileQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> Result<Json<Value>, ApiError> {
    let log = UploadLog::start("the owner".into(), format!("atlas collection {id}"), &q.rel_path, &headers);
    let stored = async {
        let col = ops::get_atlas_collection(&db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
        if !atlas_is_managed(&root.0, &col) {
            return Err(ApiError(AppError::InvalidInput(
                "this collection points at your own folder — Ganban never writes into user folders; add files there directly, or create a managed Library collection".into(),
            )));
        }
        let rel = atlas_rel_path(&q.rel_path)?;
        let spooled = spool_upload(&root.0, &headers, body, 256 * 1024 * 1024, "file too large (256MB max)").await?;
        let size = spooled.size;
        let dest = std::path::PathBuf::from(&col.source_dir).join(&rel);
        storage::move_into_place(&spooled.path, &dest).await.map_err(AppError::from)?;
        spooled.keep();
        ops::mark_atlas_dirty(&db, col.id).await?;
        Ok(json!({ "ok": true, "rel_path": rel.to_string_lossy(), "size_bytes": size }))
    }
    .await;
    log.finish(stored, |v| v["size_bytes"].as_u64().unwrap_or(0)).map(Json)
}

/// Delete one file from a MANAGED library folder. Stamps dirty_at.
async fn atlas_file_delete_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Query(q): Query<AtlasFileQuery>,
) -> Result<StatusCode, ApiError> {
    let col = ops::get_atlas_collection(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
    if !atlas_is_managed(&root.0, &col) {
        return Err(ApiError(AppError::InvalidInput("this collection points at your own folder — manage its files there".into())));
    }
    let rel = atlas_rel_path(&q.rel_path)?;
    let p = std::path::PathBuf::from(&col.source_dir).join(&rel);
    std::fs::remove_file(&p).map_err(|_| ApiError(AppError::NotFound("file".into())))?;
    ops::mark_atlas_dirty(&db, col.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AtlasAutoIndexBody {
    enabled: bool,
}

async fn atlas_auto_index_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<AtlasAutoIndexBody>,
) -> Result<StatusCode, ApiError> {
    ops::set_atlas_auto_index(&db, id, body.enabled).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AtlasImportBody {
    project_file_id: i64,
    /// Library-relative destination; defaults to the file's own name/rel_path.
    #[serde(default)]
    rel_path: Option<String>,
}

/// Copy a project file's blob INTO a managed library folder (owner) —
/// server-side, no download/upload round trip. Never indexes; stamps dirty.
async fn atlas_import_project_file_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<AtlasImportBody>,
) -> Result<Json<Value>, ApiError> {
    let col = ops::get_atlas_collection(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
    if !atlas_is_managed(&root.0, &col) {
        return Err(ApiError(AppError::InvalidInput("imports go into MANAGED library collections only".into())));
    }
    let f: Option<ganban_core::models::ProjectFile> =
        sqlx::query_as("SELECT * FROM project_files WHERE id = ?")
            .bind(body.project_file_id)
            .fetch_optional(&db)
            .await
            .map_err(AppError::from)?;
    let f = f.ok_or_else(|| ApiError(AppError::NotFound("project file".into())))?;
    let blob = storage::project_blob_path(&root.0, f.id);
    let bytes = std::fs::read(&blob).map_err(|_| ApiError(AppError::NotFound("the file's bytes are missing on the host".into())))?;
    let rel = atlas_rel_path(body.rel_path.as_deref().unwrap_or(f.rel_path.as_deref().unwrap_or(&f.file_name)))?;
    let dest = std::path::PathBuf::from(&col.source_dir).join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    std::fs::write(&dest, &bytes).map_err(AppError::from)?;
    ops::mark_atlas_dirty(&db, col.id).await?;
    Ok(Json(json!({ "ok": true, "rel_path": rel.to_string_lossy(), "size_bytes": bytes.len() })))
}

#[derive(Deserialize)]
struct ProjectImportAtlasBody {
    collection_id: i64,
    rel_path: String,
}

/// Copy a library file INTO a project's files (owner; quota-checked like any
/// upload). The reverse flow — curate in the Library, publish to a project.
async fn project_import_atlas_file_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(pid): Path<i64>,
    Json(body): Json<ProjectImportAtlasBody>,
) -> Result<Json<ganban_core::models::ProjectFile>, ApiError> {
    let owner = auth::ensure_owner(&db).await?;
    let col = ops::get_atlas_collection(&db, body.collection_id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("atlas collection".into())))?;
    let rel = atlas_rel_path(&body.rel_path)?;
    let src = std::path::PathBuf::from(&col.source_dir).join(&rel);
    let bytes = std::fs::read(&src).map_err(|_| ApiError(AppError::NotFound("file".into())))?;
    let name = rel.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let rel_dir = rel.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| format!("{}/{name}", p.to_string_lossy()));
    let f = storage::store_project_file(&db, &root.0, pid, &name, None, rel_dir.as_deref(), Some(owner), &bytes).await?;
    Ok(Json(f))
}

/// `GET` — any member may ask (their client shows/hides the “Add to my
/// Atlas” affordance). `PUT` — owner-only grant.
async fn member_atlas_export_get_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, id, auth::ROLE_MEMBER).await?;
    let enabled: bool = sqlx::query_scalar("SELECT member_atlas_export FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(&db)
        .await
        .map_err(AppError::from)?
        .unwrap_or(false);
    Ok(Json(json!({ "enabled": enabled })))
}

#[derive(Deserialize)]
struct MemberAtlasExportBody {
    enabled: bool,
}

async fn member_atlas_export_set_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<MemberAtlasExportBody>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("UPDATE projects SET member_atlas_export = ? WHERE id = ?")
        .bind(body.enabled)
        .bind(id)
        .execute(&db)
        .await
        .map_err(AppError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Auto-index debounce loop: collections with auto_index ON whose folder has
/// been dirty AND QUIET for ≥90s get one reingest. A bulk dump (the whole
/// point of the Library) therefore triggers exactly one ingest, after the
/// dust settles — never one per file. Default remains OFF: “Index now” only.
fn spawn_atlas_autoingest(db: Db, rag: rag::SharedRag, mut stop: tokio::sync::watch::Receiver<bool>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
                _ = stop.changed() => return,
            }
            let Some(client) = rag.read().await.clone() else { continue };
            let Ok(cols) = ops::list_atlas_collections(&db).await else { continue };
            for col in cols.into_iter().filter(|c| c.auto_index) {
                let Some(dirty) = col.dirty_at else { continue };
                if (chrono::Utc::now() - dirty) < chrono::Duration::seconds(90) {
                    continue; // still being dumped into — wait for quiet
                }
                match atlas_ingest(&db, &client, &col).await {
                    Ok(job) => tracing::info!("atlas auto-index '{}' → job {job}", col.slug),
                    Err(e) => {
                        // Clear the stamp anyway: a broken folder must not
                        // retry every minute; the next change re-arms it.
                        let _ = ops::clear_atlas_dirty(&db, col.id).await;
                        tracing::warn!("atlas auto-index '{}' failed: {}", col.slug, e.0);
                    }
                }
            }
        }
    });
}

#[derive(Deserialize)]
struct AtlasSlugQuery {
    slug: String,
}

async fn atlas_facets_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Query(q): Query<AtlasSlugQuery>,
) -> Result<Json<Value>, ApiError> {
    let col = atlas_by_slug_visible(&db, &q.slug, &user).await?;
    let client = atlas_rag(&rag).await?;
    Ok(Json(client.read_facets(&atlas_collection_name(&col.slug))))
}

/// The collection's run metadata + documents table + where things live on
/// disk — the "what is Atlas actually being fed" view.
async fn atlas_manifest_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Query(q): Query<AtlasSlugQuery>,
) -> Result<Json<Value>, ApiError> {
    let col = atlas_by_slug_visible(&db, &q.slug, &user).await?;
    let client = atlas_rag(&rag).await?;
    let collection = atlas_collection_name(&col.slug);
    let manifest = client.read_manifest(&collection);
    let run = manifest.get("run").cloned().unwrap_or_else(|| json!({}));
    // Trim per-document entries to the fields the table shows.
    let documents: Vec<Value> = manifest
        .get("documents")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .map(|d| {
                    json!({
                        "relative_path": d.get("relative_path"),
                        "format": d.get("format"),
                        "size_bytes": d.get("size_bytes"),
                        "domains": d.get("domains"),
                        "ingested_at": d.get("ingested_at"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let out_dir = client.config().out_root.join(&collection);
    // Disk accounting (best-effort): what this collection has eaten.
    let stats = client.collection_stats(&collection).await.unwrap_or(Value::Null);
    Ok(Json(json!({
        "run": run,
        "documents": documents,
        "stats": stats,
        "paths": {
            "source_dir": col.source_dir,
            "out_dir": out_dir.to_string_lossy(),
            "corpus_dir": out_dir.join("corpus").to_string_lossy(),
        },
    })))
}

/// The last ingest's audit report (failures, warnings, figure accounting).
async fn atlas_report_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Query(q): Query<AtlasSlugQuery>,
) -> Result<Json<Value>, ApiError> {
    let col = atlas_by_slug_visible(&db, &q.slug, &user).await?;
    let client = atlas_rag(&rag).await?;
    let report = client
        .read_audit_report(&atlas_collection_name(&col.slug))
        .ok_or_else(|| ApiError(AppError::NotFound("no ingest has run for this collection yet".into())))?;
    Ok(Json(json!({ "report": report })))
}

#[derive(Deserialize)]
struct AtlasSearchBody {
    slug: String,
    query: String,
    #[serde(default)]
    filters: Option<Value>,
    limit: Option<i64>,
}

async fn atlas_search_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Json(body): Json<AtlasSearchBody>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let col = atlas_by_slug_visible(&db, &body.slug, &user).await?;
    let client = atlas_rag(&rag).await?;
    let limit = body.limit.unwrap_or(10).clamp(1, 50);
    let hits = client
        .search(&atlas_collection_name(&col.slug), &body.query, limit, body.filters)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    Ok(Json(hits))
}

#[derive(Deserialize)]
struct AtlasDocQuery {
    slug: String,
    source: String,
}

async fn atlas_document_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Query(q): Query<AtlasDocQuery>,
) -> Result<Json<Value>, ApiError> {
    let col = atlas_by_slug_visible(&db, &q.slug, &user).await?;
    let client = atlas_rag(&rag).await?;
    let content = client
        .corpus_document(&atlas_collection_name(&col.slug), &q.source)
        .map_err(|e| ApiError(AppError::NotFound(e)))?;
    Ok(Json(json!({ "source": q.source, "content": content })))
}

/// A project tab's saved configuration blob (member read / admin write).
async fn project_tab_config_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let raw = ops::project_tab_config(&db, pid, &tab_id).await?;
    Ok(Json(serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))))
}

#[derive(Deserialize)]
struct TabConfigBody {
    config: Value,
}

async fn project_tab_config_set_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
    Json(body): Json<TabConfigBody>,
) -> Result<StatusCode, ApiError> {
    require(&db, &user, pid, auth::ROLE_ADMIN).await?;
    let raw = body.config.to_string();
    if raw.len() > 8 * 1024 {
        return Err(ApiError(AppError::InvalidInput("tab config too large (8 KB cap)".into())));
    }
    ops::set_project_tab_config(&db, pid, &tab_id, &raw).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// One member's OWN saved state for a stash tab (game saves, lists, stats).
/// Keyed by the authenticated identity — there is no way to address another
/// user's row. Unlike /config (shared, admin-write), state is member-write.
async fn tab_user_state_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let raw = ops::tab_user_state(&db, pid, &tab_id, user.id).await?;
    Ok(Json(serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))))
}

#[derive(Deserialize)]
struct TabStateBody {
    state: Value,
}

async fn tab_user_state_set_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
    Json(body): Json<TabStateBody>,
) -> Result<StatusCode, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    // A tab may keep several independent saves ("slots"): `<tab>:<slot>`,
    // e.g. a game tab keeps its settings in `<tab>` and a running game in
    // `<tab>:game`. Each slot is its own row with its own 128 KB wall, so
    // one module's growth can never push another module's save over the cap.
    if !tab_state_key_ok(&tab_id) {
        return Err(ApiError(AppError::InvalidInput(format!("unknown tab: {tab_id}"))));
    }
    let raw = body.state.to_string();
    // Roomier than config's 8 KB: game saves and capped quiz history. Raised
    // from 64 KB (owner, 2026-10-15) so a game's save has headroom for new
    // mechanics. Still a hard wall — unbounded growth is a client bug.
    if raw.len() > TAB_STATE_MAX_BYTES {
        return Err(ApiError(AppError::InvalidInput("tab state too large (128 KB cap)".into())));
    }
    ops::set_tab_user_state(&db, pid, &tab_id, user.id, &raw).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The wall on one tab-state slot (`<tab>:<slot>`), in bytes of JSON.
const TAB_STATE_MAX_BYTES: usize = 128 * 1024;

/// `<tab>` or `<tab>:<slot>` where `<tab>` is compiled in and `<slot>` is short
/// kebab-case. The slot never widens access: the row is still keyed by the
/// authenticated user and checked against project membership.
fn tab_state_key_ok(key: &str) -> bool {
    let (tab, slot) = match key.split_once(':') {
        Some((t, s)) => (t, Some(s)),
        None => (key, None),
    };
    if !tabs::is_available(tab) {
        return false;
    }
    match slot {
        None => true,
        Some(s) => {
            !s.is_empty()
                && s.len() <= 24
                && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        }
    }
}

/// The project leaderboard for one stash tab — every member sees it (that's
/// the point). Scores are client-reported by authenticated members: a
/// friendly intra-project ranking, not an anti-cheat system.
async fn tab_scores_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    let scores = ops::list_tab_scores(&db, pid, &tab_id, 200).await?;
    Ok(Json(json!({ "scores": scores })))
}

#[derive(Deserialize)]
struct TabScoreBody {
    kind: String,
    score: f64,
    #[serde(default)]
    meta: Value,
}

async fn tab_scores_post_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path((pid, tab_id)): Path<(i64, String)>,
    Json(body): Json<TabScoreBody>,
) -> Result<StatusCode, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    if !tabs::is_available(&tab_id) {
        return Err(ApiError(AppError::InvalidInput(format!("unknown tab: {tab_id}"))));
    }
    if body.kind.is_empty()
        || body.kind.len() > 24
        || !body.kind.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(ApiError(AppError::InvalidInput("kind must be short kebab-case".into())));
    }
    if !body.score.is_finite() || !(0.0..=100_000.0).contains(&body.score) {
        return Err(ApiError(AppError::InvalidInput("score out of range".into())));
    }
    let meta = body.meta.to_string();
    if meta.len() > 1024 {
        return Err(ApiError(AppError::InvalidInput("meta too large (1 KB cap)".into())));
    }
    ops::add_tab_score(&db, pid, &tab_id, user.id, &body.kind, body.score, &meta).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Map imagery setup for the client: active provider, its layers and the
/// attribution the map must show. Never the key.
async fn tiles_config_handler(State(db): State<Db>, _user: AuthUser) -> Json<Value> {
    Json(maptiles::client_config(&db).await)
}

/// One map tile through the host's cache (stale-on-error when offline).
async fn tile_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _user: AuthUser,
    Path((layer, z, x, y)): Path<(String, u8, u32, u32)>,
) -> Response {
    use maptiles::TileError;
    let err = |code: StatusCode, msg: String| (code, Json(json!({ "error": msg }))).into_response();
    match maptiles::get_tile(&db, &root.0, &layer, z, x, y).await {
        Ok(t) => (
            [
                (header::CONTENT_TYPE, t.content_type),
                (header::CACHE_CONTROL, if t.stale { "private, max-age=300" } else { "private, max-age=86400" }),
            ],
            t.bytes,
        )
            .into_response(),
        Err(TileError::Off) => err(StatusCode::NOT_FOUND, "map imagery is switched off on this host".into()),
        Err(TileError::NotFound) => StatusCode::NOT_FOUND.into_response(),
        Err(TileError::BadRequest(m)) => err(StatusCode::BAD_REQUEST, m.into()),
        Err(TileError::Upstream(m)) => err(StatusCode::BAD_GATEWAY, m),
    }
}

#[derive(Deserialize)]
struct GiphyQuery {
    #[serde(default)]
    q: String,
    limit: Option<u32>,
}

/// GIF search for ANY enrolled device, with the host's GIPHY key injected
/// server-side (same pattern as the ragrat token: the secret is an owner-only
/// app_setting; clients get capability, never the key). Returns GIPHY's JSON
/// untouched — the client already knows that shape.
async fn giphy_search_handler(
    State(db): State<Db>,
    _user: AuthUser,
    Query(q): Query<GiphyQuery>,
) -> Result<Json<Value>, ApiError> {
    let key = ops::get_app_setting(&db, "giphy_api_key")
        .await?
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| ApiError(AppError::NotFound("GIF search is not configured on this host".into())))?;
    let limit = q.limit.unwrap_or(24).clamp(1, 50);
    let term = q.q.trim().to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Ganban/0.5 (gif-search)")
        .build()
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    let endpoint = if term.is_empty() {
        "https://api.giphy.com/v1/gifs/trending"
    } else {
        "https://api.giphy.com/v1/gifs/search"
    };
    let mut req = client
        .get(endpoint)
        .query(&[("api_key", key.as_str()), ("limit", &limit.to_string()), ("rating", "pg-13")]);
    if !term.is_empty() {
        req = req.query(&[("q", term.as_str())]);
    }
    // The key rides in the query string (GIPHY has no header form), so an error
    // must not quote the URL: it would hand the host's key to whoever searched.
    let resp = req
        .send()
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(format!("giphy: {}", net_guard::error_text(e))))))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let msg = if code == 401 || code == 403 {
            "the host's GIPHY key was rejected — the owner should check it in Settings → Plug-ins".to_string()
        } else {
            format!("GIPHY error {code}")
        };
        return Err(ApiError(AppError::InvalidInput(msg)));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(format!("giphy: {}", net_guard::error_text(e))))))?;
    Ok(Json(body))
}

/// Who may reach a project's chats: its members, except that a personal container's chats
/// (the Personal lane) are its own user's alone. The owner's project bypass stops there, as it
/// does at Finance (ADR 0009): someone else's Personal chats are "not found".
async fn require_chat_project(db: &Db, user: &AuthUser, project_id: i64) -> Result<(), ApiError> {
    require(db, user, project_id, auth::ROLE_MEMBER).await?;
    let personal_of: Option<Option<i64>> = sqlx::query_scalar("SELECT personal_user_id FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(db)
        .await
        .map_err(|e| ApiError(AppError::from(e)))?;
    match personal_of.flatten() {
        Some(owner_of) if owner_of != user.id => Err(ApiError(AppError::NotFound("project".into()))),
        _ => Ok(()),
    }
}

/// Author-or-admin guard shared by the bin lifecycle handlers; returns the chat.
async fn chat_for_manage(db: &Db, user: &AuthUser, cid: i64) -> Result<Chat, ApiError> {
    let chat = ops::get_chat(db, cid)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("chat".into())))?;
    require_chat_project(db, user, chat.project_id).await?;
    if chat.user_id != Some(user.id) {
        require(db, user, chat.project_id, auth::ROLE_ADMIN).await?;
    }
    Ok(chat)
}

/// The caller's binned threads in a project (restore/purge candidates).
async fn chats_binned_handler(
    State(db): State<Db>,
    user: AuthUser,
    Query(q): Query<ListChatsQuery>,
) -> Result<Json<Vec<Chat>>, ApiError> {
    require_chat_project(&db, &user, q.project_id).await?;
    let mut chats = ops::list_binned_chats(&db, q.project_id, user.id).await?;
    for c in &mut chats {
        c.is_mine = true;
    }
    Ok(Json(chats))
}

/// Stage 1: move a thread to the bin (it disappears from lists, restorable).
async fn chat_bin_handler(State(db): State<Db>, user: AuthUser, Path(cid): Path<i64>) -> Result<StatusCode, ApiError> {
    chat_for_manage(&db, &user, cid).await?;
    ops::bin_chat(&db, cid).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Undo: bring a binned thread back.
async fn chat_restore_handler(State(db): State<Db>, user: AuthUser, Path(cid): Path<i64>) -> Result<StatusCode, ApiError> {
    chat_for_manage(&db, &user, cid).await?;
    ops::restore_chat(&db, cid).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Stage 2: permanently delete — only allowed for threads already in the bin,
/// so a single misclick can never destroy a conversation.
async fn chat_purge_handler(State(db): State<Db>, user: AuthUser, Path(cid): Path<i64>) -> Result<StatusCode, ApiError> {
    let chat = chat_for_manage(&db, &user, cid).await?;
    if chat.deleted_at.is_none() {
        return Err(ApiError(AppError::InvalidInput("bin the chat first — permanent deletion only happens from the bin".into())));
    }
    ops::delete_chat(&db, cid).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The messages of a chat thread the caller can access.
async fn chat_messages_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ChatMessage>>, ApiError> {
    let chat = ops::get_chat(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("chat not found".into())))?;
    require_chat_project(&db, &user, chat.project_id).await?;
    // A private thread is readable only by its author (published ones by the
    // whole team); a project admin may read any for moderation.
    if !chat.is_public && chat.user_id != Some(user.id) {
        require(&db, &user, chat.project_id, auth::ROLE_ADMIN).await?;
    }
    Ok(Json(ops::get_chat_messages(&db, id).await?))
}

// ---------------------------------------------------------------------------
// The secretary: an owner-only, grounded, cross-project daily assistant.
//   * GET  /secretary/brief    — deterministic facts (date/time + upcoming events)
//   * POST /secretary/chat     — ephemeral, grounded SSE chat (no persistence)
//   * GET  /secretary/rundown  — the latest stored per-project digest (or null)
//   * POST /secretary/rundown  — (re)generate today's digest, store, return it
// ---------------------------------------------------------------------------

/// The secretary's built-in persona, used when no dedicated profile is set. The
/// daily brief (facts) is appended after this by the caller.
const DEFAULT_SECRETARY_PROMPT: &str = "You are the user's personal secretary. You help them stay on top of their day: their schedule, what's coming up, and what they should prepare for. The CURRENT DATE/TIME and the user's UPCOMING EVENTS are provided below as ground truth — always trust that block over any prior assumption about the date, and never invent events, dates, or times that aren't in it. If asked about something the context doesn't cover, say you don't have that information. Be warm, brief, and concrete.";

/// Resolve the secretary's voice + model. A dedicated profile (app_setting
/// `secretary_profile_id`) wins; otherwise the active profile's model with the
/// built-in secretary persona. (The brief is grafted on by the caller.)
async fn resolve_secretary_profile(db: &Db) -> (ollama::ChatParams, String) {
    if let Some(raw) = ops::get_app_setting(db, "secretary_profile_id").await.ok().flatten() {
        if let Ok(id) = raw.trim().parse::<i64>() {
            if let Ok(Some(p)) = ops::get_model_profile(db, id).await {
                let system = p.system_prompt.filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_SECRETARY_PROMPT.into());
                return (
                    ollama::ChatParams { model: p.model, temperature: p.temperature, max_tokens: p.max_tokens, num_ctx: None, endpoint: p.endpoint },
                    system,
                );
            }
        }
    }
    // No dedicated secretary profile: borrow the active profile's model/params but
    // speak with the secretary persona.
    let (params, _system) = resolve_profile(db, None).await;
    (params, DEFAULT_SECRETARY_PROMPT.into())
}

async fn secretary_brief_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<secretary::DailyBrief>, ApiError> {
    Ok(Json(secretary::build_brief(&db).await?))
}

#[derive(Deserialize)]
struct SecretaryTurn {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct SecretaryChatBody {
    message: String,
    /// The running conversation (owner's own ephemeral thread); the server keeps
    /// no secretary chat state, so the client passes prior turns back each time.
    #[serde(default)]
    history: Vec<SecretaryTurn>,
}

/// Ephemeral grounded chat with the secretary (SSE). Owner-only. Nothing is
/// persisted — each turn is grounded fresh with the day's brief; a disconnect
/// simply drops the partial.
async fn secretary_chat_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Json(body): Json<SecretaryChatBody>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError> {
    let ollama = ollama.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("chat is not enabled on this host".into())))?;
    if body.message.trim().is_empty() {
        return Err(ApiError(AppError::InvalidInput("empty message".into())));
    }
    let (params, persona) = resolve_secretary_profile(&db).await;
    let brief = secretary::build_brief(&db).await?;
    let system = format!("{persona}\n\n## Today (authoritative)\n\n{}", brief.render());

    // Tools note appended to whatever persona is active — a dedicated profile
    // doesn't know about the secretary's hands otherwise.
    let system = format!(
        "{system}\n\nYou have tools: find_tasks (search live tasks), find_projects (list projects), \
         create_task (PROPOSE a new task in a project — drafted content like an email draft goes in \
         its description), update_task (PROPOSE changes to an existing task — e.g. add a draft to its \
         description; the description you send REPLACES the old one, so include everything), and \
         create_event (PROPOSE a calendar event, task_id links it). The seam: \
         you do the legwork, the user decides — create_task and create_event only file proposals; \
         NOTHING is created until they approve it in their notifications. Resolve names first: \
         find_projects before create_task, find_tasks before a task-linked create_event. After \
         proposing, tell the user exactly what you proposed and that Approve/Decline is waiting in \
         their notifications. Never invent ids; never claim anything was created; and if the user \
         asks for something you have NO tool for, say so plainly — never imply you noted or saved \
         anything you didn't."
    );
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    // Cap the replayed history to keep the context window bounded.
    let start = body.history.len().saturating_sub(20);
    for m in &body.history[start..] {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        messages.push(json!({ "role": role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": body.message }));

    // Bounded tool loop (chat_once), THEN the final answer. The secretary can
    // now DO small things — find a task, create a linked event — instead of
    // only narrating. Tool rounds are non-streaming; the final text arrives
    // as one token event (answers here are short; the protocol is unchanged).
    let secretary_client = ollama::OllamaClient::for_params(&ollama, &params);
    let defs = secretary::tool_defs();
    // Proposals need the proposer's identity: the owner (this endpoint is
    // owner-only; the token doesn't carry an id, the users table does).
    let owner_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE is_owner = 1 LIMIT 1")
        .fetch_optional(&db)
        .await
        .ok()
        .flatten()
        .unwrap_or(1);
    let mut final_content = String::new();
    // 8 minutes per round: drafting long content on a local model takes what
    // it takes (field: a 3-minute cap 500'd the whole turn as "IO error").
    let round_timeout = std::time::Duration::from_secs(480);
    let mut filed: Vec<String> = Vec::new(); // proposals filed by tool rounds
    let mut broke: Option<&str> = None;
    for _ in 0..4 {
        let turn = match tokio::time::timeout(round_timeout, secretary_client.chat_once(&params, &messages, &defs)).await {
            // A timeout or model error must DEGRADE, not 500 the turn — work
            // already done (filed proposals) would vanish with the error.
            Err(_) => {
                broke = Some("the model timed out mid-thought");
                break;
            }
            Ok(Err(_)) => {
                broke = Some("the model connection dropped");
                break;
            }
            Ok(Ok(t)) => t,
        };
        if turn.tool_calls.is_empty() {
            final_content = turn.content;
            break;
        }
        let raw_calls: Vec<Value> = turn
            .tool_calls
            .iter()
            .map(|tc| json!({ "function": { "name": tc.name, "arguments": tc.arguments } }))
            .collect();
        messages.push(json!({ "role": "assistant", "content": turn.content, "tool_calls": raw_calls }));
        for tc in &turn.tool_calls {
            let note = secretary::execute_tool(&db, owner_id, &tc.name, &tc.arguments).await;
            if let Ok(v) = serde_json::from_str::<Value>(&note) {
                if let Some(sum) = v.get("summary").and_then(Value::as_str) {
                    filed.push(sum.to_string());
                }
            }
            messages.push(json!({ "role": "tool", "content": note, "name": tc.name }));
        }
    }
    if final_content.trim().is_empty() {
        let why = broke.unwrap_or("I ran out of steps before finishing");
        final_content = if filed.is_empty() {
            format!("Sorry — {why}. Nothing was filed; please try again (a shorter ask helps).")
        } else {
            format!(
                "{why} before I could write a proper reply — but the legwork landed. Awaiting your Approve/Decline in the notifications:\n{}",
                filed.iter().map(|s| format!("• {s}")).collect::<Vec<_>>().join("\n")
            )
        };
    }
    let model_name = params.model.clone();
    let sse = stream! {
        yield Ok(Event::default().event("stage").data(json!({ "stage": "generating", "model": model_name }).to_string()));
        yield Ok(Event::default().event("token").data(final_content));
        yield Ok(Event::default().event("done").data(json!({ "ok": true }).to_string()));
    };
    Ok(Sse::new(sse).keep_alive(KeepAlive::default()))
}

async fn rundown_latest_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Option<secretary::Rundown>>, ApiError> {
    Ok(Json(secretary::latest_rundown(&db).await?))
}

/// (Re)generate today's rundown. Summarizes with the active profile's model at a
/// low temperature for factual, stable digests. Idempotent per day (overwrites).
async fn rundown_generate_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    Extension(rag): Extension<rag::SharedRag>,
    _owner: AuthOwner,
) -> Result<Json<secretary::Rundown>, ApiError> {
    let client = ollama.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("chat is not enabled on this host".into())))?;
    let rag_client = rag.read().await.clone();
    // A manual "run now" is the rundown routine's other trigger: go through the
    // routine record so the run is stamped + ledgered exactly like a catch-up run.
    if let Some(routine) = ops::routine_by_kind(&db, "rundown").await? {
        routines::run_routine(&db, Some(&client), rag_client.as_ref(), &routine).await.map_err(ApiError)?;
        if let Some(r) = secretary::latest_rundown(&db).await? {
            return Ok(Json(r));
        }
    }
    // No routine row (shouldn't happen — it's seeded): generate directly.
    let (active, _system) = resolve_profile(&db, None).await;
    Ok(Json(secretary::generate_rundown(&db, &client, rag_client.as_ref(), &active.model).await?))
}

#[derive(Deserialize)]
struct ExecuteToolBody {
    proposal_id: i64,
}

/// Consume an approved proposal, run it through the shared dispatcher, and
/// append the applied action to the `agent_actions` ledger. The take() is the
/// double-submit guard: a concurrent second approval finds nothing. A failed
/// apply reinserts the proposal so a transient error stays retryable. Callers
/// must have authorized the user (proposer + live role) BEFORE calling this.
async fn consume_and_apply(
    db: &Db,
    root: &std::path::Path,
    proposal_id: i64,
    approver_id: i64,
) -> Result<Value, AppError> {
    let pending = ganban_core::proposals::take(db, proposal_id)
        .await?
        .ok_or_else(|| AppError::NotFound("this action has expired or was already applied".into()))?;
    // Agent authorship on the artifact itself: a comment born from a proposal
    // carries the personality's face (comments.profile_id) — stamped HERE from
    // the proposal row, never trusted from a client value.
    let mut args = pending.args.clone();
    if pending.command == "create_comment" {
        if let (Some(pid), Some(input)) = (pending.profile_id, args.get_mut("input").and_then(Value::as_object_mut)) {
            input.insert("profile_id".into(), json!(pid));
        }
    }
    // Scope is re-checked now, not only when the proposal was made: the task
    // may have moved or the proposer left in between. A stale proposal stays
    // listed so it can be rejected.
    if let Err(why) = tools::recheck_scope(db, &pending.command, &args, pending.project_id, pending.user_id).await {
        if let Err(e2) = ganban_core::proposals::reinsert(db, &pending).await {
            tracing::warn!("could not reinsert proposal {proposal_id}: {e2}");
        }
        return Err(AppError::Forbidden(format!("this proposal no longer applies: {why}")));
    }
    match tools::apply_write(db, root, &pending.command, &args).await {
        Ok(result) => {
            tracing::info!("user {} approved {} in project {}", pending.user_id, pending.command, pending.project_id);
            // The ledger is the durable trace of every applied agent write. The
            // domain write has already landed, so a failed insert is logged
            // rather than turned into a client error (the proposal is consumed —
            // a retry could double-apply).
            let args_json = pending.args.to_string();
            let result_json = result.to_string();
            if let Err(e) = ops::record_agent_action(db, ops::NewAgentAction {
                status: "applied",
                user_id: pending.user_id,
                profile_id: pending.profile_id,
                project_id: Some(pending.project_id),
                // 0 = an externally-submitted proposal (member-agent return):
                // there is no host conversation behind it, so no chat link.
                chat_id: (pending.chat_id != 0).then_some(pending.chat_id),
                routine_id: None,
                tool: &pending.command,
                summary: &pending.summary,
                args_json: &args_json,
                result_json: Some(&result_json),
                model: None,
                prompt_tokens: None,
                completion_tokens: None,
                duration_ms: None,
                protocol_slug: None,
                protocol_version: None,
                content_hash: None,
                parent_action_id: None,
                // Both identities, always: user_id = proposer (above),
                // approver_id = who resolved (may differ under 'owner' policy).
                approver_id: Some(approver_id),
            })
            .await
            {
                tracing::warn!("applied {} but could not ledger it: {e}", pending.command);
            }
            Ok(json!({ "ok": true, "command": pending.command, "result": result }))
        }
        Err(e) => {
            // Restore it so a transient failure can be retried rather than lost.
            tracing::warn!("user {} failed to apply {} in project {}: {e}", pending.user_id, pending.command, pending.project_id);
            if let Err(e2) = ganban_core::proposals::reinsert(db, &pending).await {
                tracing::warn!("could not reinsert proposal {proposal_id} for retry: {e2}");
            }
            Err(e)
        }
    }
}

/// Consume a rejected proposal — no domain write happens — and record the
/// rejection in the ledger so the trail shows what the user turned down.
async fn consume_and_reject(db: &Db, proposal_id: i64, approver_id: i64) -> Result<(), AppError> {
    let pending = ganban_core::proposals::take(db, proposal_id)
        .await?
        .ok_or_else(|| AppError::NotFound("this action has expired or was already resolved".into()))?;
    let args_json = pending.args.to_string();
    if let Err(e) = ops::record_agent_action(db, ops::NewAgentAction {
        status: "rejected",
        user_id: pending.user_id,
        profile_id: pending.profile_id,
        project_id: Some(pending.project_id),
        chat_id: (pending.chat_id != 0).then_some(pending.chat_id),
        routine_id: None,
        tool: &pending.command,
        summary: &pending.summary,
        args_json: &args_json,
        result_json: None,
        model: None,
        prompt_tokens: None,
        completion_tokens: None,
        duration_ms: None,
        protocol_slug: None,
        protocol_version: None,
        content_hash: None,
        parent_action_id: None,
        approver_id: Some(approver_id),
    })
    .await
    {
        tracing::warn!("rejected {} but could not ledger it: {e}", pending.command);
    }
    Ok(())
}

#[derive(Deserialize)]
struct ApprovalPolicyBody {
    policy: String,
}

/// `GET /projects/:id/approval-policy` — any member may see who resolves
/// agent proposals here.
async fn approval_policy_get_handler(
    State(db): State<Db>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, id, auth::ROLE_MEMBER).await?;
    Ok(Json(json!({ "policy": ganban_core::proposals::approval_policy(&db, id).await? })))
}

/// `PUT /projects/:id/approval-policy` — owner-only; rejects unknown values.
async fn approval_policy_set_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<ApprovalPolicyBody>,
) -> Result<StatusCode, ApiError> {
    ganban_core::proposals::set_approval_policy(&db, id, body.policy.trim()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Authorize a proposal action WITHOUT consuming it: only its proposer may
/// resolve it, and their write access to the project is re-checked live. A
/// failed/unauthorized call must never destroy a legitimate pending proposal
/// (the consume is the guard, but it must come after these checks pass).
async fn authorize_proposal(
    db: &Db,
    user: &AuthUser,
    proposal_id: i64,
) -> Result<(), ApiError> {
    let (_, project_id) = ganban_core::proposals::peek_meta(db, proposal_id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("this action has expired or was already resolved".into())))?;
    // Who may resolve is the PROJECT'S policy (MEMBER_AGENTS.md prereq 3):
    // 'proposer' (default) — only the proposer; 'owner' — only the owner.
    if !ganban_core::proposals::may_resolve(db, proposal_id, user.id, user.is_owner).await? {
        return Err(ApiError(AppError::Forbidden(
            "this project's approval policy does not let you resolve this proposal".into(),
        )));
    }
    require(db, user, project_id, auth::ROLE_MEMBER).await?;
    Ok(())
}

/// Every tab compiled into this binary (id, name, tier, description). Any
/// authenticated user may look — enablement is per project, availability is
/// per build.
async fn tabs_available_handler(_user: AuthUser) -> Json<Value> {
    Json(json!(tabs::available_tabs()))
}

/// The agent-tool catalog this build offers — every read + gated-write tool,
/// builtin or tab-contributed, with its shape, trust class and source. Members
/// may see the catalog (transparency about what the assistant can do); the
/// knowledge engine's internals (ragrat mounts, MCP surface, base URL) are
/// owner-only. Lists definitions; never executes.
async fn tools_catalog_handler(State(db): State<Db>, Extension(rag): Extension<rag::SharedRag>, user: AuthUser) -> Json<Value> {
    let tab_ids: Vec<String> = tabs::available_tabs().iter().map(|t| t.id.to_string()).collect();
    let mut catalog = tools::tool_catalog(&tab_ids);
    // Declarative registry tools (owner-defined, data-bound) sit alongside the
    // compiled ones — same shape, same gate; source "registry:<kind>". Members
    // don't see owner-only mcp tools.
    catalog.extend(tools::registry_tool_infos(&db, user.is_owner).await);
    let engine = if user.is_owner {
        match rag.read().await.clone() {
            Some(rc) => {
                let status = rc.status().await;
                // Brokered visibility: list the tools on ragrat's root MCP mount
                // (best-effort) so the engine's actual tool surface is shown, not
                // just its mount paths. Only when the engine is reachable.
                let mcp_tools = if status.is_some() { rc.mcp_tools("/mcp/").await } else { None };
                json!({ "configured": true, "base_url": rc.config().base_url, "status": status, "mcp_tools": mcp_tools })
            }
            None => json!({ "configured": false }),
        }
    } else {
        Value::Null
    };
    Json(json!({ "version": env!("CARGO_PKG_VERSION"), "tools": catalog, "engine": engine }))
}

/// Owner-only: the declarative tool registry (all rows, incl. disabled, with
/// their bindings) — the management view behind the Tools panel.
async fn registry_list_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<ganban_core::models::RegistryTool>>, ApiError> {
    Ok(Json(ops::list_registry_tools(&db).await?))
}

/// Owner-only: the binding kinds + allowlisted commands a new registry tool may
/// use — drives the "New tool" form so it can only offer safe choices.
async fn registry_bindings_handler(Extension(rag): Extension<rag::SharedRag>, _owner: AuthOwner) -> Json<Value> {
    // For the mcp binding, surface ragrat's actual mounts + the tools on each,
    // so the "New tool" form only offers real, callable {mount, tool} pairs.
    let mut mcp: Vec<Value> = Vec::new();
    if let Some(rc) = rag.read().await.clone() {
        if let Some(status) = rc.status().await {
            let mounts = status.get("mcp_mounts").and_then(Value::as_array).cloned().unwrap_or_default();
            for m in mounts.iter().filter_map(Value::as_str) {
                let tools: Vec<String> = rc
                    .mcp_tools(m)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|t| t.get("name").and_then(Value::as_str).map(String::from))
                    .collect();
                if !tools.is_empty() {
                    mcp.push(json!({ "mount": m, "tools": tools }));
                }
            }
        }
    }
    Json(json!({
        "kinds": ["ops", "rag", "mcp", "http", "fetch"],
        "ops_commands": tools::REGISTRY_OPS_READ,
        "mcp_mounts": mcp,
    }))
}

/// Owner-only: the NAMES of stored connector secrets (never the values).
async fn connector_secrets_list_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(ops::list_connector_secret_names(&db).await?))
}

/// Owner-only: set a connector secret (body: `{ "name": ..., "value": ... }`).
async fn connector_secret_set_handler(State(db): State<Db>, _owner: AuthOwner, Json(body): Json<Value>) -> Result<StatusCode, ApiError> {
    let name = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let value = body.get("value").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || value.is_empty() {
        return Err(ApiError(AppError::InvalidInput("name and value are required".into())));
    }
    ops::set_connector_secret(&db, name, value).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only: delete a connector secret.
async fn connector_secret_delete_handler(State(db): State<Db>, _owner: AuthOwner, Path(name): Path<String>) -> Result<StatusCode, ApiError> {
    ops::delete_connector_secret(&db, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only: define a new registry tool (validated against the allowlist).
async fn registry_create_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(input): Json<ganban_core::models::NewRegistryTool>,
) -> Result<Json<ganban_core::models::RegistryTool>, ApiError> {
    tools::validate_new_registry_tool(&input).map_err(|e| ApiError(AppError::InvalidInput(e)))?;
    if ops::get_registry_tool_by_name(&db, input.name.trim()).await?.is_some() {
        return Err(ApiError(AppError::InvalidInput(format!("a tool named '{}' already exists", input.name.trim()))));
    }
    Ok(Json(ops::create_registry_tool(&db, input).await?))
}

/// Owner-only: enable/disable a registry tool (data-driven, no redeploy).
async fn registry_enabled_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    ops::set_registry_tool_enabled(&db, id, enabled).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only: delete a registry tool.
async fn registry_delete_handler(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<StatusCode, ApiError> {
    ops::delete_registry_tool(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The tab ids enabled for a project (members; it shapes their project view).
async fn project_tabs_handler(
    State(db): State<Db>,
    user: AuthUser,
    axum::extract::Path(pid): axum::extract::Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require(&db, &user, pid, auth::ROLE_MEMBER).await?;
    Ok(Json(json!(ops::enabled_project_tabs(&db, pid).await?)))
}

#[derive(Deserialize)]
struct SetTabBody {
    tab_id: String,
    enabled: bool,
}

/// Enable/disable a tab on a project (project admins and up). Only tabs
/// actually compiled into this binary can be enabled.
async fn project_tabs_set_handler(
    State(db): State<Db>,
    user: AuthUser,
    axum::extract::Path(pid): axum::extract::Path<i64>,
    Json(body): Json<SetTabBody>,
) -> Result<StatusCode, ApiError> {
    require(&db, &user, pid, auth::ROLE_ADMIN).await?;
    if body.enabled && !tabs::is_available(&body.tab_id) {
        return Err(ApiError(AppError::InvalidInput(format!("unknown tab '{}'", body.tab_id))));
    }
    ops::set_project_tab(&db, pid, &body.tab_id, body.enabled).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SyncFolderCreate {
    project_id: i64,
    path: String,
    #[serde(default)]
    include_ext: String,
    #[serde(default)]
    max_bytes: i64,
}

#[derive(Deserialize)]
struct SyncFolderPatch {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    include_ext: Option<String>,
    #[serde(default)]
    max_bytes: Option<i64>,
}

/// Owner-only: folder-sync mappings (the daemon reads the host's filesystem).
async fn sync_folders_list(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<SyncFolder>>, ApiError> {
    Ok(Json(ops::list_sync_folders(&db).await?))
}

async fn sync_folders_create(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<SyncFolderCreate>,
) -> Result<Json<SyncFolder>, ApiError> {
    let path = body.path.trim();
    if !std::path::Path::new(path).is_dir() {
        return Err(ApiError(AppError::InvalidInput(format!("'{path}' is not a folder on the host"))));
    }
    // Validate the project exists before binding a folder to it.
    sqlx::query_scalar::<_, i64>("SELECT id FROM projects WHERE id = ?")
        .bind(body.project_id)
        .fetch_optional(&db)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| ApiError(AppError::NotFound("project".into())))?;
    Ok(Json(ops::create_sync_folder(&db, body.project_id, path, body.include_ext.trim(), body.max_bytes).await?))
}

async fn sync_folders_patch(
    State(db): State<Db>,
    _owner: AuthOwner,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<SyncFolderPatch>,
) -> Result<Json<SyncFolder>, ApiError> {
    ops::update_sync_folder(&db, id, body.enabled, body.include_ext.as_deref(), body.max_bytes)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError(AppError::NotFound("sync folder".into())))
}

async fn sync_folders_delete(
    State(db): State<Db>,
    _owner: AuthOwner,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<StatusCode, ApiError> {
    ops::delete_sync_folder(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only: scan one mapping right now ("Sync now" in the Plug-ins card).
async fn sync_folders_run(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<foldersync::ScanSummary>, ApiError> {
    let folder = ops::get_sync_folder(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("sync folder".into())))?;
    Ok(Json(foldersync::scan(&db, &root.0, &folder).await?))
}

/// Owner-only: the routines and their state (trigger, last run, enabled).
async fn routines_list_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<Routine>>, ApiError> {
    Ok(Json(ops::list_routines(&db).await?))
}

/// Owner-only: run one routine now (the manual trigger). Stamps + ledgers the
/// run exactly like a catch-up run.
async fn routine_run_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    Extension(rag): Extension<rag::SharedRag>,
    _owner: AuthOwner,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let routine = ops::get_routine(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("routine not found".into())))?;
    // Only the kinds that need the model ask for one (run_routine says so).
    let client = ollama.read().await.clone();
    let rag_client = rag.read().await.clone();
    routines::run_routine(&db, client.as_ref(), rag_client.as_ref(), &routine).await.map(Json).map_err(ApiError)
}

#[cfg(feature = "tab-email")]
mod email_handlers {
    use super::*;

    #[derive(Deserialize)]
    pub struct AccountBody {
        #[serde(default)]
        pub label: String,
        pub host: String,
        #[serde(default = "default_imap_port")]
        pub port: i64,
        pub username: String,
        /// App-password path. Empty when `oauth_flow_id` is set.
        #[serde(default)]
        pub password: String,
        #[serde(default)]
        pub folders: String,
        #[serde(default)]
        pub horizon_days: Option<i64>,
        /// A completed OAuth sign-in to claim instead of a password.
        #[serde(default)]
        pub oauth_flow_id: Option<String>,
        /// The OAuth client behind that sign-in (stored to refresh tokens later).
        #[serde(default)]
        pub oauth_client_id: Option<String>,
        #[serde(default)]
        pub oauth_client_secret: Option<String>,
    }
    fn default_imap_port() -> i64 {
        993
    }

    #[derive(Deserialize)]
    pub struct OAuthBeginBody {
        pub client_id: String,
        #[serde(default)]
        pub client_secret: Option<String>,
    }

    /// Start a Gmail (XOAUTH2) sign-in with the owner's own OAuth client: opens
    /// a loopback listener + returns the auth URL the UI launches in a browser.
    pub async fn email_oauth_begin(
        Extension(flows): Extension<email_oauth::SharedFlows>,
        user: AuthUser,
        Json(b): Json<OAuthBeginBody>,
    ) -> Result<Json<Value>, ApiError> {
        let client_id = b.client_id.trim().to_string();
        if client_id.is_empty() {
            return Err(ApiError(AppError::InvalidInput("a Google OAuth client id is required".into())));
        }
        let secret = b.client_secret.filter(|s| !s.trim().is_empty());
        let begun = email_oauth::begin(flows, user.id, client_id, secret).await.map_err(AppError::InvalidInput)?;
        Ok(Json(json!({ "flow_id": begun.flow_id, "auth_url": begun.auth_url })))
    }

    /// Poll a sign-in's progress (pending / done+email / error).
    pub async fn email_oauth_poll(
        Extension(flows): Extension<email_oauth::SharedFlows>,
        user: AuthUser,
        Path(flow_id): Path<String>,
    ) -> Json<Value> {
        Json(email_oauth::poll(&flows, &flow_id, user.id))
    }

    /// Per-USER mailboxes: members connect their own inboxes; nobody browses
    /// anyone else's. The host owner additionally sees every account (they
    /// administer the box the credentials live on).
    pub async fn email_accounts_list(State(db): State<Db>, user: AuthUser) -> Result<Json<Vec<EmailAccount>>, ApiError> {
        if user.is_owner {
            return Ok(Json(ops::list_email_accounts(&db).await?));
        }
        Ok(Json(ops::list_email_accounts_for(&db, user.id).await?))
    }

    /// An account the caller may manage: theirs, or anyone's for the host owner.
    async fn require_own_account(db: &Db, user: &AuthUser, id: i64) -> Result<EmailAccount, ApiError> {
        let account = ops::get_email_account(db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::NotFound("email account".into())))?;
        if !user.is_owner && account.user_id != Some(user.id) {
            return Err(ApiError(AppError::Forbidden("that mailbox belongs to another member".into())));
        }
        Ok(account)
    }

    pub async fn email_accounts_create(
        State(db): State<Db>,
        Extension(flows): Extension<email_oauth::SharedFlows>,
        user: AuthUser,
        Json(b): Json<AccountBody>,
    ) -> Result<Json<EmailAccount>, ApiError> {
        // Refuse a member's mailbox on an internal address up front; the sync
        // would refuse it at every connect anyway (`email::Reach`).
        email::resolve_mail_host(b.host.trim(), b.port, email::Reach::for_caller(user.is_owner))
            .await
            .map_err(AppError::InvalidInput)?;
        let folders = if b.folders.trim().is_empty() { "INBOX".to_string() } else { b.folders.trim().to_string() };
        let horizon = b.horizon_days.unwrap_or(90);
        // OAuth path: claim the refresh token from the just-completed sign-in;
        // the resolved Google address wins over any typed username.
        if let Some(flow_id) = b.oauth_flow_id.as_deref().filter(|f| !f.is_empty()) {
            let (email, refresh_token) = flows
                .take_done(flow_id, user.id)
                .ok_or_else(|| ApiError(AppError::InvalidInput("sign-in not completed — finish it in the browser, then add".into())))?;
            let username = if email.is_empty() { b.username.trim().to_string() } else { email };
            let label = if b.label.trim().is_empty() { username.clone() } else { b.label.trim().to_string() };
            let client_id = b
                .oauth_client_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ApiError(AppError::InvalidInput("OAuth account needs its client id to refresh tokens".into())))?;
            let secret = b.oauth_client_secret.as_deref().map(str::trim).filter(|s| !s.is_empty());
            return Ok(Json(
                ops::create_oauth_email_account(
                    &db, user.id, &label, b.host.trim(), b.port, &username, &folders, horizon,
                    client_id, secret, &refresh_token,
                )
                .await?,
            ));
        }
        let label = if b.label.trim().is_empty() { b.username.clone() } else { b.label.trim().to_string() };
        Ok(Json(
            ops::create_email_account(&db, user.id, &label, b.host.trim(), b.port, b.username.trim(), &b.password, &folders, horizon)
                .await?,
        ))
    }

    /// Probe credentials and return the mailbox's folders (for the card).
    /// A member's probe goes only to public addresses (the SSRF guard): the
    /// host and port are theirs to type, so this is otherwise a scanner for the
    /// host's LAN and tailnet. The owner may test a mailbox on their own network.
    pub async fn email_account_test(user: AuthUser, Json(b): Json<AccountBody>) -> Result<Json<Value>, ApiError> {
        let probe = EmailAccount {
            id: 0,
            user_id: None,
            auth_type: "password".into(),
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_refresh_token: None,
            label: String::new(),
            host: b.host.trim().to_string(),
            port: b.port,
            username: b.username.trim().to_string(),
            password: b.password,
            folders: String::new(),
            drafts_folder: String::new(),
            horizon_days: 90,
            enabled: true,
            last_sync_at: None,
            last_result: None,
            created_at: chrono::Utc::now(),
        };
        let folders = email::test_account(&probe, email::Reach::for_caller(user.is_owner)).await.map_err(AppError::InvalidInput)?;
        Ok(Json(json!({ "ok": true, "folders": folders })))
    }

    #[derive(Deserialize)]
    pub struct AccountPatch {
        #[serde(default)]
        pub enabled: Option<bool>,
    }

    pub async fn email_account_patch(
        State(db): State<Db>,
        user: AuthUser,
        Path(id): Path<i64>,
        Json(b): Json<AccountPatch>,
    ) -> Result<StatusCode, ApiError> {
        require_own_account(&db, &user, id).await?;
        if let Some(enabled) = b.enabled {
            ops::set_email_account_enabled(&db, id, enabled).await?;
        }
        Ok(StatusCode::NO_CONTENT)
    }

    pub async fn email_account_delete(
        State(db): State<Db>,
        user: AuthUser,
        Path(id): Path<i64>,
    ) -> Result<StatusCode, ApiError> {
        require_own_account(&db, &user, id).await?;
        ops::delete_email_account(&db, id).await?;
        Ok(StatusCode::NO_CONTENT)
    }

    pub async fn email_account_sync(
        State(db): State<Db>,
        user: AuthUser,
        Path(id): Path<i64>,
    ) -> Result<Json<email::SyncSummary>, ApiError> {
        let account = require_own_account(&db, &user, id).await?;
        let summary = email::sync_account(&db, &account).await.map_err(AppError::InvalidInput)?;
        Ok(Json(summary))
    }

    /// The link-it browser: recent unlinked threads from the CALLER's own
    /// mailboxes only (each member sees their inbox, never anyone else's).
    pub async fn email_threads_unlinked(State(db): State<Db>, user: AuthUser) -> Result<Json<Vec<EmailThread>>, ApiError> {
        let mut threads = ops::list_unlinked_email_threads_for(&db, user.id, 200).await?;
        for t in &mut threads {
            t.is_mine = true;
        }
        Ok(Json(threads))
    }

    #[derive(Deserialize)]
    pub struct LinkBody {
        #[serde(default)]
        pub project_id: Option<i64>,
    }

    /// Link (publish) a thread to a project — or unlink with null. Only the
    /// MAILBOX's user may publish or retract their own threads, and only into
    /// projects they belong to. Linking kicks a background sync so bodies
    /// arrive without waiting for the poller.
    pub async fn email_thread_link(
        State(db): State<Db>,
        user: AuthUser,
        Path(id): Path<i64>,
        Json(b): Json<LinkBody>,
    ) -> Result<Json<EmailThread>, ApiError> {
        let thread = ops::get_email_thread(&db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::NotFound("email thread".into())))?;
        require_own_account(&db, &user, thread.account_id).await?;
        if let Some(pid) = b.project_id {
            require(&db, &user, pid, auth::ROLE_MEMBER).await?;
        }
        ops::set_email_thread_project(&db, id, b.project_id).await?;
        if b.project_id.is_some() {
            if let Ok(Some(account)) = ops::get_email_account(&db, thread.account_id).await {
                let db2 = db.clone();
                tokio::spawn(async move {
                    if let Err(e) = email::sync_account(&db2, &account).await {
                        tracing::warn!("email body fetch after link failed: {e}");
                    }
                });
            }
        }
        Ok(Json(ops::get_email_thread(&db, id).await?.expect("just updated")))
    }

    /// A thread's messages. Linked thread → that project's members; unlinked →
    /// owner only (it is private mailbox content until published).
    pub async fn email_thread_messages(
        State(db): State<Db>,
        user: AuthUser,
        Path(id): Path<i64>,
    ) -> Result<Json<Vec<EmailMessage>>, ApiError> {
        let thread = ops::get_email_thread(&db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::NotFound("email thread".into())))?;
        match thread.project_id {
            Some(pid) => require(&db, &user, pid, auth::ROLE_MEMBER).await?,
            None => {
                require_own_account(&db, &user, thread.account_id).await?;
            }
        }
        Ok(Json(ops::list_email_thread_messages(&db, id).await?))
    }

    /// A project's linked threads (members — linking published them).
    pub async fn project_email_threads(
        State(db): State<Db>,
        user: AuthUser,
        Path(pid): Path<i64>,
    ) -> Result<Json<Vec<EmailThread>>, ApiError> {
        require(&db, &user, pid, auth::ROLE_MEMBER).await?;
        let mut threads = ops::list_project_email_threads(&db, pid).await?;
        let mine: std::collections::HashSet<i64> =
            ops::list_email_accounts_for(&db, user.id).await?.iter().map(|a| a.id).collect();
        for t in &mut threads {
            t.is_mine = user.is_owner || mine.contains(&t.account_id);
        }
        Ok(Json(threads))
    }
}
#[cfg(feature = "tab-email")]
use email_handlers::*;

/// The caller's pending write proposals (the inbox feed), oldest first. Each
/// entry carries the tool, human summary, and before/after details — enough for
/// any approval surface (inbox panel, future remote client) to mirror the gate.
async fn tool_proposals_handler(State(db): State<Db>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = ganban_core::proposals::list_for_user(&db, user.id, user.is_owner).await?;
    let mut out = Vec::with_capacity(rows.len());
    for p in rows {
        // Visibility ≠ approval right: the card says whether THIS viewer may
        // resolve it (e.g. a member sees their own pending work read-only
        // under an 'owner' policy).
        let can_approve = ganban_core::proposals::may_resolve(&db, p.id, user.id, user.is_owner).await.unwrap_or(false);
        // Attribution headline (MEMBER_AGENTS decision 3): the person, with a
        // "(via agent)" suffix when their own machine's agent produced it.
        let proposer_name: Option<String> = sqlx::query_scalar("SELECT full_name FROM users WHERE id = ?")
            .bind(p.user_id)
            .fetch_optional(&db)
            .await
            .ok()
            .flatten();
        // The project's name comes from THIS host — a client rendering a
        // merged multi-workspace store must never resolve a bare id itself
        // (numeric ids collide across workspaces; the "ZZ - Developing
        // Ganban" mislabel incident).
        let project_name: Option<String> = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
            .bind(p.project_id)
            .fetch_optional(&db)
            .await
            .ok()
            .flatten();
        out.push(json!({
            "id": p.id,
            "project_id": p.project_id,
            "project_name": project_name,
            "chat_id": p.chat_id,
            "tool": p.command,
            "summary": p.summary,
            "details": p.details,
            "proposer_id": p.user_id,
            "proposer_name": proposer_name,
            "origin": p.origin,
            "created_at": p.created_at,
            "can_approve": can_approve,
        }));
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct ActionsQuery {
    #[serde(default)]
    project_id: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

/// The agent activity ledger, newest first. A project's trail needs membership
/// in that project; the global (cross-project) trail is owner-only.
async fn agent_actions_handler(
    State(db): State<Db>,
    user: AuthUser,
    Query(q): Query<ActionsQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    match q.project_id {
        Some(pid) => require(&db, &user, pid, auth::ROLE_MEMBER).await?,
        None if !user.is_owner => {
            return Err(ApiError(AppError::Forbidden("the global activity view is owner-only".into())));
        }
        None => {}
    }
    let mut rows = ops::list_agent_actions(&db, q.project_id, q.limit.unwrap_or(100)).await?;
    // An action on a task goes with the task (task visibility): its summary quotes it.
    if let Some(seen) = visibility::visible_tasks(&db, commands::viewer_of(&user), q.project_id).await? {
        rows.retain(|a| {
            let args: Value = serde_json::from_str(&a.args_json).unwrap_or(Value::Null);
            visibility::task_of_args(&args).is_none_or(|t| seen.contains(&t))
        });
    }
    // Names resolved HERE (same host as the ids) — see tool_proposals_handler.
    let mut names: std::collections::HashMap<i64, Option<String>> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for a in rows {
        let name = match a.project_id {
            Some(pid) => match names.get(&pid) {
                Some(n) => n.clone(),
                None => {
                    let n: Option<String> = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
                        .bind(pid)
                        .fetch_optional(&db)
                        .await
                        .ok()
                        .flatten();
                    names.insert(pid, n.clone());
                    n
                }
            },
            None => None,
        };
        let mut v = serde_json::to_value(&a).map_err(AppError::from)?;
        v["project_name"] = json!(name);
        out.push(v);
    }
    Ok(Json(out))
}

/// Owner-only diagnostics bundle for the bug reporter: a redacted, read-only
/// snapshot (versions, platform, log tails, slim ledger). Executes nothing.
async fn diagnostics_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Value>, ApiError> {
    Ok(Json(diagnostics::collect(&db).await))
}

#[derive(Deserialize)]
struct DiagLogQuery {
    /// A bare log filename in the host's log dir (basename only); default = the
    /// newest server log.
    file: Option<String>,
}

/// Owner-only: stream a full, redacted host log file as a text attachment.
async fn diagnostics_log_handler(_owner: AuthOwner, Query(q): Query<DiagLogQuery>) -> Response {
    match diagnostics::read_log_file(q.file.as_deref()) {
        Some((name, body)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
                (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")),
            ],
            body,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "log file not found").into_response(),
    }
}

/// Approve + execute a write the assistant proposed. The proposal is consumed
/// (the removal is the double-submit guard), only its proposer may approve it,
/// and the caller's role/scope is re-checked against the live project before the
/// write lands. The applied action is appended to the `agent_actions` ledger.
async fn tool_execute_handler(
    State(db): State<Db>,
    Extension(root): Extension<StorageRoot>,
    user: AuthUser,
    Json(body): Json<ExecuteToolBody>,
) -> Result<Json<Value>, ApiError> {
    authorize_proposal(&db, &user, body.proposal_id).await?;
    consume_and_apply(&db, &root.0, body.proposal_id, user.id).await.map(Json).map_err(ApiError)
}

/// Reject a write the assistant proposed: consumes the proposal (same guard as
/// approval) without touching the domain, and ledgers the rejection.
async fn tool_reject_handler(
    State(db): State<Db>,
    user: AuthUser,
    Json(body): Json<ExecuteToolBody>,
) -> Result<Json<Value>, ApiError> {
    authorize_proposal(&db, &user, body.proposal_id).await?;
    consume_and_reject(&db, body.proposal_id, user.id).await.map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AiTestBody {
    kind: String, // "ollama" | "ragrat"
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

/// Owner-only: probe a candidate connection (the values typed in Settings, not
/// the saved/frozen ones) from the host. Never throws on a bad connection —
/// returns `{ ok: false, error }` so the UI can show it inline.
async fn ai_test_handler(_owner: AuthOwner, Json(body): Json<AiTestBody>) -> Result<Json<Value>, ApiError> {
    match body.kind.as_str() {
        "ollama" => {
            let base = body.base_url.unwrap_or_default();
            let base = base.trim().trim_end_matches('/').to_string();
            if base.is_empty() {
                return Ok(Json(json!({ "ok": false, "error": "no base URL" })));
            }
            let client = ollama::OllamaClient::new(ollama::OllamaConfig { base_url: base });
            Ok(Json(match client.list_models().await {
                Ok(models) => json!({ "ok": true, "models": models }),
                Err(e) => json!({ "ok": false, "error": e }),
            }))
        }
        "ragrat" => {
            let url = body.url.unwrap_or_default();
            let url = url.trim().trim_end_matches('/');
            if url.is_empty() {
                return Ok(Json(json!({ "ok": false, "error": "no URL" })));
            }
            let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().unwrap_or_default();
            let mut rb = http.get(format!("{url}/status"));
            if let Some(t) = body.token.as_deref().filter(|s| !s.is_empty()) {
                rb = rb.bearer_auth(t);
            }
            Ok(Json(match rb.send().await {
                Ok(r) if r.status().is_success() => {
                    let v: Value = r.json().await.unwrap_or(Value::Null);
                    json!({ "ok": true, "version": v.get("version") })
                }
                Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                    json!({ "ok": false, "error": "unauthorized — check the token" })
                }
                Ok(r) => json!({ "ok": false, "error": format!("ragrat returned {}", r.status()) }),
                Err(e) => json!({ "ok": false, "error": format!("unreachable: {e}") }),
            }))
        }
        _ => Err(ApiError(AppError::InvalidInput("unknown test kind".into()))),
    }
}

#[derive(Deserialize)]
struct PullBody {
    model: String,
}

/// Owner-only: pull an Ollama model, streaming progress as SSE `progress` events
/// (`{status, completed?, total?}`), then `done` (or `error`).
async fn ai_pull_handler(
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Json(body): Json<PullBody>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError> {
    let ollama = ollama.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("Ollama is not configured".into())))?;
    let progress = ollama
        .pull_stream(&body.model)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    let sse = stream! {
        futures_util::pin_mut!(progress);
        while let Some(item) = progress.next().await {
            match item {
                Ok(v) => yield Ok(Event::default().event("progress").data(v.to_string())),
                Err(e) => { yield Ok(Event::default().event("error").data(e)); return; }
            }
        }
        yield Ok(Event::default().event("done").data("{}"));
    };
    Ok(Sse::new(sse).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct EmbedTestBody {
    model: String,
}

/// Owner-only: probe an embedding model's output width (to pin `dimensions`).
/// Returns the endpoint + dimensions to store as `rag_embedding`.
async fn ai_embed_test_handler(
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Json(body): Json<EmbedTestBody>,
) -> Result<Json<Value>, ApiError> {
    let ollama = ollama.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("Ollama is not configured".into())))?;
    Ok(Json(match ollama.embed_dimensions(&body.model).await {
        Ok(dim) => json!({
            "ok": true,
            "dimensions": dim,
            "endpoint": format!("{}/v1/embeddings", ollama.config().base_url),
            "model": body.model,
        }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}

/// Owner-only: re-ingest every project (after the embedding model/dimensions
/// changed — required because each collection's vector schema is pinned).
async fn ai_reembed_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
) -> Result<Json<Value>, ApiError> {
    let client = rag.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("RAG (ragrat) is not configured".into())))?;
    let n = rag::reembed_all(&db, &client, &root.0)
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    Ok(Json(json!({ "reindexed": n })))
}

/// List model profiles. The owner gets everything (incl. system prompts,
/// generation params, secretary + routing config); a member gets a REDACTED
/// view — just enough identity (id, name, model, avatar, capability card) for
/// their chat header and @mention routing. Members can talk to a personality;
/// only the owner sees how it's wired.
async fn ai_profiles_handler(State(db): State<Db>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let profiles = ops::list_model_profiles(&db).await?;
    let active = ops::get_app_setting(&db, "ai_active_profile_id").await?.and_then(|s| s.trim().parse::<i64>().ok());
    if !user.is_owner {
        let redacted: Vec<Value> = profiles
            .iter()
            .map(|p| json!({ "id": p.id, "name": p.name, "model": p.model, "avatar": p.avatar, "model_meta": p.model_meta }))
            .collect();
        return Ok(Json(json!({ "profiles": redacted, "active_id": active })));
    }
    let secretary = ops::get_app_setting(&db, "secretary_profile_id").await?.and_then(|s| s.trim().parse::<i64>().ok());
    let routing: Value = ops::get_app_setting(&db, "ai_routing")
        .await?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    Ok(Json(json!({ "profiles": profiles, "active_id": active, "secretary_id": secretary, "routing": routing })))
}

#[derive(Deserialize)]
struct RoutingBody {
    /// Which task class to (re)route — currently only "tools".
    task_class: String,
    /// The profile that class should run on; `null` clears the route (the task
    /// falls back to the conversation's own profile).
    #[serde(default)]
    id: Option<i64>,
    /// The runner for this task class: "ollama" (free, local) or "pi" (paid,
    /// external). When omitted, the legacy `id` field is used (Ollama runner).
    #[serde(default)]
    runner: Option<String>,
    /// For the pi runner: a model pattern like "anthropic/claude-sonnet-4".
    /// Ignored for Ollama (the profile's model is used). Model NAME only —
    /// never an API key.
    #[serde(default)]
    model: Option<String>,
}

/// Owner-only: set or clear one entry in the model routing table (`ai_routing`).
/// Accepts both the legacy shape ({ task_class, id }) and the extended protocol
/// shape ({ task_class, runner, model, id }). Legacy integer entries are
/// backward-compatible (treated as { runner: ollama, profile_id: id }).
async fn ai_routing_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<RoutingBody>,
) -> Result<StatusCode, ApiError> {
    if !ROUTING_CLASSES.contains(&body.task_class.as_str()) {
        return Err(ApiError(AppError::InvalidInput(format!(
            "unknown task class '{}' (known: {})",
            body.task_class,
            ROUTING_CLASSES.join(", ")
        ))));
    }
    // Reject a non-existent profile up front rather than storing a stale pointer.
    if let Some(id) = body.id {
        ops::get_model_profile(&db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::InvalidInput(format!("profile {id} does not exist"))))?;
    }

    // The protocols table is authoritative (Epoch R.1). The Settings toggle is
    // a manual-trigger protocol, so it may activate directly (§3). Each save
    // is an IMMUTABLE new version — the ledger's provenance columns keep
    // pointing at exactly what ran.
    if body.runner.is_none() && body.id.is_none() {
        ganban_core::protocols::deactivate_protocol(&db, &body.task_class).await?;
    } else {
        let runner = body.runner.clone().unwrap_or_else(|| "ollama".into());
        let fm = json!({
            "protocol": 1,
            "task_class": body.task_class,
            "trigger": { "kind": "manual" },
            "engine": { "runner": runner, "profile_id": body.id, "model": body.model },
        })
        .to_string();
        let user_id = auth::ensure_owner(&db).await.ok();
        ganban_core::protocols::upsert_protocol_version(
            &db,
            &body.task_class,
            &format!("{} routing", body.task_class),
            &fm,
            "",
            user_id,
            true,
        )
        .await?;
    }

    // Mirror into the legacy ai_routing setting: the profiles GET returns it
    // to the Settings UI, and it stays a correct fallback for old builds.
    let mut table: serde_json::Map<String, Value> = ops::get_app_setting(&db, "ai_routing")
        .await?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // If a runner is specified, store the full protocol object. Otherwise use
    // the legacy integer shape (backward-compatible with existing tools/librarian).
    if body.runner.is_some() {
        let entry = json!({
            "runner": body.runner,
            "profile_id": body.id,
            "model": body.model,
        });
        table.insert(body.task_class, entry);
    } else {
        match body.id {
            Some(id) => { table.insert(body.task_class, json!(id)); }
            None => { table.remove(&body.task_class); }
        }
    }
    ops::set_app_setting(&db, "ai_routing", &Value::Object(table).to_string()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /ai/protocols` — every protocol with its full version history and the
/// parsed engine of each version (owner-only; this is the Settings surface).
async fn protocols_list_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
) -> Result<Json<Value>, ApiError> {
    let mut out = Vec::new();
    for (rec, _active) in ganban_core::protocols::list_protocols(&db).await? {
        let versions = ganban_core::protocols::list_versions(&db, rec.id).await?;
        let vers: Vec<Value> = versions
            .iter()
            .map(|v| {
                let fm = ganban_core::protocols::validate_frontmatter(&v.frontmatter_json).ok();
                json!({
                    "version": v.version,
                    "status": v.status,
                    "content_hash": v.content_hash,
                    "created_at": v.created_at,
                    "trigger": fm.as_ref().map(|f| f.trigger.kind.clone()),
                    "engine": fm.as_ref().map(|f| json!({
                        "runner": f.engine.runner,
                        "profile_id": f.engine.profile_id,
                        "model": f.engine.model,
                    })),
                })
            })
            .collect();
        out.push(json!({
            "slug": rec.slug,
            "name": rec.name,
            "task_class": rec.task_class,
            "active_version": rec.active_version,
            "versions": vers,
        }));
    }
    Ok(Json(json!({ "protocols": out })))
}

#[derive(Deserialize)]
struct ProtocolVersionBody {
    version: i64,
}

#[derive(Deserialize)]
struct ProtocolCreateBody {
    slug: String,
    name: String,
    /// The frontmatter as a JSON object — the builder form's output. YAML
    /// never appears anywhere in this flow (PROTOCOLS.md §4 door 2).
    frontmatter: Value,
    #[serde(default)]
    briefing: String,
    /// Activate on save (manual triggers only — core enforces the gate).
    #[serde(default)]
    activate: bool,
}

/// `POST /ai/protocols` — the BUILDER's save: create an immutable new version
/// (and the protocol row if the slug is new). Validation layers:
///   1. core schema validation (rejects, never coerces),
///   2. task class: a system class (ROUTING_CLASSES) or `user.*` — user
///      classes are freeform-namespaced and cannot shadow a system class,
///   3. tool names checked against THIS build's catalog — a protocol naming
///      an unknown tool is refused with the name (invariant 3/5),
///   4. engine profile existence (no stale pointers).
async fn protocol_create_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<ProtocolCreateBody>,
) -> Result<Json<Value>, ApiError> {
    let fm_str = body.frontmatter.to_string();
    let fm = ganban_core::protocols::validate_frontmatter(&fm_str)?;
    let is_system = ROUTING_CLASSES.contains(&fm.task_class.as_str());
    if !is_system && !fm.task_class.starts_with("user.") {
        return Err(ApiError(AppError::InvalidInput(format!(
            "task class '{}' is neither a system class ({}) nor a user class (user.*)",
            fm.task_class,
            ROUTING_CLASSES.join(", ")
        ))));
    }
    if let Some(tools_list) = &fm.tools {
        let tab_ids: Vec<String> = tabs::available_tabs().iter().map(|t| t.id.to_string()).collect();
        let mut known: std::collections::HashSet<String> =
            tools::tool_catalog(&tab_ids).into_iter().map(|t| t.name).collect();
        for rt in ops::list_registry_tools(&db).await.unwrap_or_default() {
            known.insert(rt.name);
        }
        for t in tools_list {
            if !known.contains(t) {
                return Err(ApiError(AppError::InvalidInput(format!(
                    "frontmatter rejected: unknown tool '{t}' — not in this build's catalog"
                ))));
            }
        }
    }
    if let Some(pid) = fm.engine.profile_id {
        ops::get_model_profile(&db, pid)
            .await?
            .ok_or_else(|| ApiError(AppError::InvalidInput(format!("profile {pid} does not exist"))))?;
    }
    let user_id = auth::ensure_owner(&db).await.ok();
    let (_, version, hash) = ganban_core::protocols::upsert_protocol_version(
        &db, body.slug.trim(), body.name.trim(), &fm_str, &body.briefing, user_id, body.activate,
    )
    .await?;
    Ok(Json(json!({ "slug": body.slug.trim(), "version": version, "content_hash": hash })))
}

/// `GET /ai/protocols/gallery` — pre-built protocol templates (PROTOCOLS.md
/// §4 door 1). Cards with plain-language names; the `inputs` declarations ARE
/// the install wizard — the client renders them as typed questions, fills the
/// frontmatter, and saves through the same validated POST as the builder.
/// Compiled-in for v1 (community sharing is R.3+, after the OSS trust story).
async fn protocol_gallery_handler(_owner: AuthOwner) -> Json<Value> {
    let gallery = json!([
        {
            "slug": "structure_toc",
            "name": "Auto-build PDF structure",
            "description": "Reads a book's contents page (OCR for scans) and proposes the chapter structure in PDF Studio. Never saves without your review.",
            "frontmatter": {
                "protocol": 1,
                "task_class": "structure_toc",
                "trigger": { "kind": "manual" },
                "engine": { "runner": "ollama" },
                "inputs": [
                    { "name": "profile_id", "type": "profile", "required": false, "label": "Which personality's model reads the contents page? (blank = active profile)" }
                ]
            },
            "briefing": "Extract the table of contents verbatim: complete titles including numbering, printed page numbers exactly as shown (arabic or roman), hierarchy levels. Respond with only the JSON array requested."
        },
        {
            "slug": "librarian",
            "name": "Atlas librarian",
            "description": "The research tier: multi-search digests over your Atlas collections, cited, ≤250 words. Route it to a strong model (a remote box or pi) for better answers.",
            "frontmatter": {
                "protocol": 1,
                "task_class": "librarian",
                "trigger": { "kind": "manual" },
                "engine": { "runner": "ollama" },
                "inputs": [
                    { "name": "profile_id", "type": "profile", "required": true, "label": "Which personality is the librarian?" }
                ]
            },
            "briefing": "Answer only from what the tools returned; cite every claim as [collection/source]; if the Atlas has nothing relevant, say exactly that."
        },
        {
            "slug": "tools",
            "name": "Tool runner tier",
            "description": "Which model drives the agent tool loop in chats. A small fast model here keeps conversations snappy while a bigger model writes the final answers.",
            "frontmatter": {
                "protocol": 1,
                "task_class": "tools",
                "trigger": { "kind": "manual" },
                "engine": { "runner": "ollama" },
                "inputs": [
                    { "name": "profile_id", "type": "profile", "required": true, "label": "Which personality runs the tool loop?" }
                ]
            },
            "briefing": ""
        }
    ]);
    Json(json!({ "gallery": gallery }))
}

/// A task-class-specific fixture for the dry-run harness. The fixture is the
/// smallest input that exercises the protocol's REAL contract — for
/// structure_toc that means: does the engine return parseable JSON for a
/// tiny contents page? For unknown classes: a plain reachability+cost check.
fn dry_run_fixture(task_class: &str) -> (&'static str, &'static str) {
    match task_class {
        "structure_toc" => (
            "Extract the table of contents from this text. Respond with ONLY a JSON array of {\"title\", \"printedPage\", \"level\"} objects. No prose, no fences.\n\n--- Page 1 ---\nContents\nPreface  ...  xi\nChapter 1  Getting Started  ...  3\n1.1  Installation  ...  4\nChapter 2  Advanced Use  ...  17\nIndex  ...  90",
            "json_array",
        ),
        _ => ("Reply with exactly the single word: READY", "contains_ready"),
    }
}

/// `POST /ai/protocols/:slug/dry-run` — the R.2 harness, first cut: run the
/// version-under-test's ENGINE against a task-class fixture, meter the cost
/// (a `dryrun` ledger row with full provenance), check the output against the
/// fixture's contract, and on success advance `draft` → `dryrun`. Nothing is
/// applied anywhere — this is preview by construction. (Replay-over-real-data
/// arrives with the first routine/rule protocol.)
async fn protocol_dry_run_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Path(slug): Path<String>,
    Json(body): Json<ProtocolVersionBody>,
) -> Result<Json<Value>, ApiError> {
    let rec = ganban_core::protocols::get_protocol(&db, &slug)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound(format!("protocol '{slug}' not found"))))?;
    let ver = ganban_core::protocols::get_version(&db, rec.id, body.version)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound(format!("version {} not found", body.version))))?;
    let fm = ganban_core::protocols::validate_frontmatter(&ver.frontmatter_json)?;
    let user_id = auth::ensure_owner(&db).await?;

    // Build the protocol from the version UNDER TEST (not the active one).
    let protocol = Protocol {
        runner: if fm.engine.runner == "pi" { Runner::Pi } else { Runner::Ollama },
        profile_id: fm.engine.profile_id,
        model: fm.engine.model.clone(),
        slug: Some(rec.slug.clone()),
        version: Some(ver.version),
        content_hash: Some(ver.content_hash.clone()),
    };
    let (fixture_prompt, check) = dry_run_fixture(&rec.task_class);
    let ollama_client = ollama.read().await.clone();
    let started = std::time::Instant::now();
    let run = run_agent_protocol(
        &db,
        ollama_client.as_ref(),
        &protocol,
        &rec.task_class,
        fixture_prompt,
        None,
        None,
        user_id,
        fm.engine.profile_id,
        "dryrun",
    )
    .await;

    let report = match run {
        Ok(r) => {
            let (passed, note) = match check {
                "json_array" => {
                    let t = r.text.trim();
                    let sliced = match (t.find('['), t.rfind(']')) {
                        (Some(a), Some(b)) if b > a => &t[a..=b],
                        _ => t,
                    };
                    match serde_json::from_str::<Vec<Value>>(sliced) {
                        Ok(arr) if !arr.is_empty() => (true, format!("returned a parseable JSON array ({} entries)", arr.len())),
                        Ok(_) => (false, "returned an EMPTY JSON array for a fixture with 5 entries".into()),
                        Err(e) => (false, format!("output did not parse as JSON: {e}")),
                    }
                }
                _ => {
                    if r.text.to_uppercase().contains("READY") {
                        (true, "engine reachable, responded to the fixture".into())
                    } else {
                        (false, format!("unexpected response: {}", r.text.chars().take(120).collect::<String>()))
                    }
                }
            };
            if passed {
                ganban_core::protocols::mark_version_dryrun(&db, rec.id, ver.version).await?;
            }
            json!({
                "passed": passed,
                "note": note,
                "model": r.model,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "duration_ms": r.duration_ms,
                "preview": r.text.chars().take(400).collect::<String>(),
            })
        }
        Err(e) => json!({
            "passed": false,
            "note": format!("engine failed: {e}"),
            "duration_ms": started.elapsed().as_millis() as i64,
        }),
    };
    Ok(Json(report))
}

/// `POST /ai/protocols/:slug/activate` — owner approval (§3 lifecycle).
async fn protocol_activate_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(slug): Path<String>,
    Json(body): Json<ProtocolVersionBody>,
) -> Result<StatusCode, ApiError> {
    ganban_core::protocols::approve_and_activate(&db, &slug, body.version).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /ai/protocols/:slug/deactivate` — active_version → NULL; versions stay.
async fn protocol_deactivate_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(slug): Path<String>,
) -> Result<StatusCode, ApiError> {
    ganban_core::protocols::deactivate_protocol(&db, &slug).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --------------------------------------------------------------------------- //
// Oracle — the Assistant's workflow builder. Definitions are validated at
// save time against the runner's compiled-in node catalog (reject, never
// coerce); runs are async jobs on the shared agent-task store; writes only
// ever file gated proposals (oracle_run.rs).
// --------------------------------------------------------------------------- //

#[derive(Deserialize)]
struct DemoSynthesizeBody {
    name: String,
    steps: Vec<Value>,
    #[serde(default)]
    narration: String,
}

/// `POST /ai/demo/synthesize` — turn a recorded demonstration into a protocol
/// DRAFT (owner; desktop capture is the only producer). The draft enters the
/// normal lifecycle: review in the builder, dry-run, the one activation gate.
async fn demo_synthesize_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<DemoSynthesizeBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth::ensure_owner(&db).await?;
    let d = demo::synthesize(&db, &body.name, body.steps, &body.narration, Some(user_id)).await?;
    Ok(Json(serde_json::to_value(d).map_err(AppError::from)?))
}

#[derive(Deserialize)]
struct OracleCreateBody {
    name: String,
    definition: Value,
}

#[derive(Deserialize)]
struct OracleUpdateBody {
    name: Option<String>,
    status: Option<String>,
    definition: Option<Value>,
}

async fn oracle_list_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Value>, ApiError> {
    let rows = ganban_core::oracle::list(&db).await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|w| {
            let def: Value = serde_json::from_str(&w.definition_json).unwrap_or(json!({ "nodes": [], "wires": [] }));
            let last_results: Value = w
                .last_results_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            json!({
                "id": w.id, "name": w.name, "status": w.status,
                "definition": def, "updated_at": w.updated_at, "last_run_at": w.last_run_at,
                "last_results": last_results,
            })
        })
        .collect();
    Ok(Json(json!({ "workflows": out, "node_types": oracle_run::NODE_TYPES })))
}

async fn oracle_create_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<OracleCreateBody>,
) -> Result<Json<Value>, ApiError> {
    let def = body.definition.to_string();
    ganban_core::oracle::validate_definition(&def, oracle_run::NODE_TYPES)?;
    let id = ganban_core::oracle::create(&db, &body.name, &def).await?;
    Ok(Json(json!({ "id": id })))
}

async fn oracle_update_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<OracleUpdateBody>,
) -> Result<StatusCode, ApiError> {
    let def = match &body.definition {
        Some(d) => {
            let s = d.to_string();
            ganban_core::oracle::validate_definition(&s, oracle_run::NODE_TYPES)?;
            Some(s)
        }
        None => None,
    };
    ganban_core::oracle::update(&db, id, body.name.as_deref(), body.status.as_deref(), def.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn oracle_delete_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    ganban_core::oracle::delete(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct OracleRunBody {
    /// Partial re-run: execute this node + everything downstream; freeze the
    /// rest to the last run's outputs (the debug loop — no re-fetching).
    from: Option<String>,
    /// With `from`: notebook semantics — execute JUST that node; upstream
    /// replays frozen, downstream keeps its stored memory untouched.
    #[serde(default)]
    only: bool,
}

/// Recent workflow runs (the Bridge's monitoring feed): oracle runs joined to
/// their automation's name, newest first.
async fn oracle_runs_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Value>, ApiError> {
    let runs = ganban_core::workflows::recent_runs(&db, 50).await?;
    let mut names: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for wf in ganban_core::oracle::list(&db).await.unwrap_or_default() {
        names.insert(wf.id, wf.name);
    }
    let out: Vec<Value> = runs
        .into_iter()
        .map(|r| {
            let name = r
                .workflow_slug
                .strip_prefix("oracle:")
                .and_then(|id| id.parse::<i64>().ok())
                .and_then(|id| names.get(&id).cloned())
                .unwrap_or_else(|| r.workflow_slug.clone());
            let workflow_id = r.workflow_slug.strip_prefix("oracle:").and_then(|id| id.parse::<i64>().ok());
            let results: Value = r
                .results_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            json!({
                "id": r.id, "name": name, "status": r.status,
                "created_at": r.created_at, "updated_at": r.updated_at,
                "workflow_id": workflow_id, "results": results,
            })
        })
        .collect();
    Ok(Json(json!({ "runs": out })))
}

/// Run an oracle workflow as an async job (same store + polling endpoint as
/// agent tasks — model steps can take minutes and held connections die).
/// Abort the active run of a workflow (manual or scheduled). Nodes not yet
/// executed are marked aborted; the in-flight node's request is dropped.
async fn oracle_cancel_handler(
    _owner: AuthOwner,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let cancelled = oracle_run::cancel_workflow_run(id);
    Ok(Json(json!({ "cancelled": cancelled })))
}

/// Live progress of every ACTIVE run — `{runs: {workflow_id: {run_id, nodes}}}`.
/// The Bridge polls this to reattach after navigation; scheduled runs included.
async fn oracle_active_handler(_owner: AuthOwner) -> Result<Json<Value>, ApiError> {
    let map = oracle_run::active_runs();
    let obj: serde_json::Map<String, Value> = map.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    Ok(Json(json!({ "runs": obj })))
}

async fn oracle_run_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    Extension(root): Extension<StorageRoot>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    body: Option<Json<OracleRunBody>>,
) -> Result<Json<Value>, ApiError> {
    let (from, only) = match body {
        Some(Json(b)) => (b.from.filter(|s| !s.is_empty()), b.only),
        None => (None, false),
    };
    let wf = ganban_core::oracle::get(&db, id)
        .await?
        .ok_or_else(|| ApiError(AppError::NotFound("workflow not found".into())))?;
    let user_id = auth::ensure_owner(&db).await?;
    let ollama_client = ollama.read().await.clone();

    let job_id = format!("oracle-{}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
        std::process::id());
    agent_task_store().lock().await.insert(job_id.clone(), AgentTaskStatus::Running { progress: None });

    let store = agent_task_store().clone();
    let job_id_for_task = job_id.clone();
    let root_path = root.0.clone();
    tokio::spawn(async move {
        let progress = Some((store.clone(), job_id_for_task.clone()));
        let result = oracle_run::run_workflow(&db, ollama_client.as_ref(), &root_path, &wf, user_id, from.as_deref(), only, progress).await;
        let entry = match result {
            Ok(v) => AgentTaskStatus::Done { result: v, error: None },
            Err(e) => AgentTaskStatus::Done { result: Value::Null, error: Some(e.to_string()) },
        };
        store.lock().await.insert(job_id_for_task, entry);
    });
    Ok(Json(json!({ "job_id": job_id, "status": "running" })))
}

/// Body for `POST /ai/agent-task` — dispatch an agent task through the protocol
/// layer. The caller provides the task_class (which selects the protocol:
/// runner + model), the prompt, and an optional system prompt. The server
/// resolves the protocol, runs the appropriate runner, writes a cost row, and
/// returns the result text. Project-scoped (member+) so the cost row carries a
/// project_id; the user_id comes from the auth token.
#[derive(Deserialize)]
struct AgentTaskBody {
    task_class: String,
    prompt: String,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    profile_id: Option<i64>,
}

/// `POST /ai/agent-task` — the one endpoint every feature calls to run an agent
/// task. It goes through `dispatch_agent_task` (never direct-to-runner) so the
/// protocol layer decides free-Ollama vs paid-pi, and a cost row is always
/// written. Owner-only for v1 (agent tasks spend budget; widen to member+ when
/// budget caps are enforced).
/// `POST /ai/agent-task` — dispatch an agent task ASYNCHRONOUSLY. Long-running
/// tasks (pi takes 30-60s+) cannot hold an HTTP connection open — Tailscale /
/// reqwest drop idle connections before the model responds. So this endpoint
/// spawns the task on a tokio task, stores the result in an in-memory map, and
/// returns a `job_id` immediately. The frontend polls `GET /ai/agent-task/:id`
/// until `status: "done"`.
async fn agent_task_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Json(body): Json<AgentTaskBody>,
) -> Result<Json<Value>, ApiError> {
    if !ROUTING_CLASSES.contains(&body.task_class.as_str()) {
        return Err(ApiError(AppError::InvalidInput(format!(
            "unknown task class '{}' (known: {})",
            body.task_class, ROUTING_CLASSES.join(", ")
        ))));
    }
    let user_id = auth::ensure_owner(&db).await?;
    let ollama_client = ollama.read().await.clone();

    // Generate a job ID and insert a 'running' entry.
    let job_id = format!("agent-{}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
        std::process::id());
    agent_task_store().lock().await.insert(job_id.clone(), AgentTaskStatus::Running { progress: None });

    // Spawn the task — it runs to completion in the background and writes its
    // result (or error) into the store. The HTTP handler returns immediately.
    let store = agent_task_store().clone();
    let job_id_for_task = job_id.clone();
    let task_class = body.task_class.clone();
    let prompt = body.prompt.clone();
    let system_prompt = body.system_prompt.clone();
    let profile_id = body.profile_id;
    tokio::spawn(async move {
        let result = dispatch_agent_task(
            &db,
            ollama_client.as_ref(),
            &task_class,
            &prompt,
            system_prompt.as_deref(),
            None,
            user_id,
            profile_id,
        ).await;
        let entry = match result {
            Ok(r) => AgentTaskStatus::Done {
                result: json!({
                    "text": r.text,
                    "model": r.model,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "duration_ms": r.duration_ms,
                }),
                error: None,
            },
            Err(e) => AgentTaskStatus::Done {
                result: json!(null),
                error: Some(e.to_string()),
            },
        };
        store.lock().await.insert(job_id_for_task, entry);
    });

    Ok(Json(json!({ "job_id": job_id, "status": "running" })))
}

/// `GET /ai/agent-task/:id` — poll for an async agent task's result. The owner's
/// alone: only the owner starts these jobs, and their results can carry project
/// content (job ids are a timestamp and a pid, so they're guessable).
async fn agent_task_status_handler(
    _owner: AuthOwner,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let store = agent_task_store().lock().await;
    match store.get(&job_id) {
        Some(status) => Ok(Json(serde_json::to_value(status).unwrap_or(json!({"status": "running"})))),
        None => Err(ApiError(AppError::NotFound(format!("unknown agent task '{job_id}'")))),
    }
}

/// `POST /ai/ocr` — OCR a PDF via ragrat's Docling+rapidocr pipeline. Takes raw
/// PDF bytes as the body (the caller slices the pages it wants with pdf-lib
/// before sending). ASYNC: Docling on CPU takes 1-5 minutes for 10 scanned
/// pages — far too long to hold an HTTP connection over Tailscale (the same
/// lesson as the agent-task endpoint).
/// Returns `{ job_id, status: "running" }` immediately; the caller polls
/// `GET /ai/agent-task/:id` (the shared async-job store) for
/// `{ status: "done", result: { text, chars }, error }`.
async fn ocr_handler(
    Extension(rag): Extension<rag::SharedRag>,
    _owner: AuthOwner,
    Query(q): Query<OcrQuery>,
    body: axum::body::Body,
) -> Result<Json<Value>, ApiError> {
    let client = rag.read().await.clone().ok_or_else(|| ApiError(AppError::NotFound("ragrat is not enabled on this host — cannot OCR".into())))?;
    let bytes = axum::body::to_bytes(body, 100 * 1024 * 1024) // 100 MB cap
        .await
        .map_err(|_| AppError::InvalidInput("could not read PDF body".into()))?;
    if bytes.is_empty() {
        return Err(ApiError(AppError::InvalidInput("empty body — send the PDF bytes".into())));
    }
    let file_name = q.file_name.unwrap_or_else(|| "scan.pdf".into());

    let job_id = format!("ocr-{}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
        std::process::id());
    agent_task_store().lock().await.insert(job_id.clone(), AgentTaskStatus::Running { progress: None });

    let store = agent_task_store().clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let entry = match client.ocr(&file_name, &bytes).await {
            Ok(text) => AgentTaskStatus::Done {
                result: json!({ "text": text, "chars": text.len() }),
                error: None,
            },
            Err(e) => AgentTaskStatus::Done {
                result: json!(null),
                error: Some(format!("ragrat OCR failed: {e}")),
            },
        };
        store.lock().await.insert(job_id_for_task, entry);
    });

    Ok(Json(json!({ "job_id": job_id, "status": "running" })))
}

#[derive(Deserialize)]
struct OcrQuery {
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct SecretaryProfileBody {
    /// The profile to use as the secretary; `null` clears it (falls back to the
    /// active profile + the built-in secretary persona).
    #[serde(default)]
    id: Option<i64>,
}

/// Owner-only: designate (or clear) the secretary's personality. `app_settings`
/// can't hold NULL, so a cleared selection stores "" — `resolve_secretary_profile`
/// treats a non-parsing value as "fall back to active".
async fn ai_secretary_profile_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<SecretaryProfileBody>,
) -> Result<StatusCode, ApiError> {
    // Reject a non-existent profile up front rather than storing a pointer that
    // would silently fall back to the active profile later.
    if let Some(id) = body.id {
        ops::get_model_profile(&db, id)
            .await?
            .ok_or_else(|| ApiError(AppError::InvalidInput(format!("profile {id} does not exist"))))?;
    }
    let value = body.id.map(|i| i.to_string()).unwrap_or_default();
    ops::set_app_setting(&db, "secretary_profile_id", &value).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ProfileUpsert {
    #[serde(default)]
    id: Option<i64>,
    name: String,
    model: String,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    max_tokens: Option<i64>,
    #[serde(default)]
    role: Option<String>,
    /// Custom profile picture as a data-URL (set/cleared by the client).
    #[serde(default)]
    avatar: Option<String>,
    /// Epoch H: remote Ollama base URL (None/empty = the local engine).
    #[serde(default)]
    endpoint: Option<String>,
    /// Shown when the remote engine is unreachable (sleeping box ≠ error).
    #[serde(default)]
    fallback_note: Option<String>,
}

/// Owner-only: create or update a model profile.
async fn ai_profile_upsert_handler(
    State(db): State<Db>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Json(p): Json<ProfileUpsert>,
) -> Result<Json<ModelProfile>, ApiError> {
    if p.name.trim().is_empty() || p.model.trim().is_empty() {
        return Err(ApiError(AppError::InvalidInput("name and model are required".into())));
    }
    // Best-effort: snapshot the model's capabilities for the vCard — against
    // the profile's OWN engine when it designates a remote one. Failure
    // (engine down, model not pulled) just leaves any cached snapshot untouched.
    let probe_client = match p.endpoint.as_deref().and_then(ollama::OllamaConfig::norm) {
        Some(base_url) => Some(ollama::OllamaClient::new(ollama::OllamaConfig { base_url })),
        None => ollama.read().await.clone(),
    };
    let model_meta = match probe_client {
        Some(c) => c.model_info(p.model.trim()).await.ok().map(|v| v.to_string()),
        None => None,
    };
    Ok(Json(
        ops::upsert_model_profile(
            &db,
            p.id,
            p.name.trim(),
            p.model.trim(),
            p.system_prompt.as_deref(),
            p.temperature,
            p.max_tokens,
            p.role.as_deref(),
            p.avatar.as_deref(),
            model_meta.as_deref(),
            p.endpoint.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            p.fallback_note.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct ModelInfoQuery {
    model: String,
}

/// Owner-only: live model capabilities for the Settings vCard preview.
async fn ai_model_info_handler(
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Query(q): Query<ModelInfoQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = ollama
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("Ollama is not configured on this host".into())))?;
    let info = client
        .model_info(q.model.trim())
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    Ok(Json(info))
}

/// Owner-only: the host's locally-available Ollama models (for the model picker
/// when setting up an assistant). Uses the live connection — no URL to pass.
#[derive(Deserialize)]
struct ModelsQuery {
    /// Probe a DIFFERENT engine (a profile's remote endpoint) instead of the
    /// host's — how the personality editor lists the big box's models.
    endpoint: Option<String>,
}

async fn ai_models_handler(
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
    Query(q): Query<ModelsQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    if let Some(base_url) = q.endpoint.as_deref().and_then(ollama::OllamaConfig::norm) {
        let remote = ollama::OllamaClient::new(ollama::OllamaConfig { base_url });
        let models = remote
            .list_models()
            .await
            .map_err(|e| ApiError(AppError::InvalidInput(format!("remote engine: {e}"))))?;
        return Ok(Json(models));
    }
    let client = ollama
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("Ollama is not configured on this host".into())))?;
    let models = client
        .list_models()
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    Ok(Json(models))
}

/// The ragrat ingest queue + history, each job annotated with its `project_id`
/// and filtered to projects the caller can see (owner sees everything).
async fn ai_jobs_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let client = rag
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("RAG is not configured on this host".into())))?;
    let jobs = client
        .list_jobs()
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    let mut allowed: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for job in jobs {
        let pid = rag::job_project_id(&job);
        let ok = match pid {
            Some(_) if user.is_owner => true,
            Some(p) => match allowed.get(&p) {
                Some(&cached) => cached,
                None => {
                    let is_member = auth::member_role(&db, p, user.id).await?.is_some();
                    allowed.insert(p, is_member);
                    is_member
                }
            },
            None => user.is_owner, // unattributable jobs are owner-only
        };
        if !ok {
            continue;
        }
        let mut j = job;
        if let Some(obj) = j.as_object_mut() {
            obj.insert("project_id".into(), pid.map(Value::from).unwrap_or(Value::Null));
        }
        out.push(j);
    }
    Ok(Json(Value::Array(out)))
}

/// One ingest job with its live log + progress — same visibility rule as the
/// list (member of the job's project; owner sees all; NotFound either way so
/// ids can't be probed).
async fn ai_job_get_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = rag
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("RAG is not configured on this host".into())))?;
    let mut job = client
        .get_job(&job_id)
        .await
        .map_err(|_| ApiError(AppError::NotFound("job not found".into())))?;
    let pid = rag::job_project_id(&job);
    let visible = match pid {
        Some(p) => user.is_owner || auth::member_role(&db, p, user.id).await?.is_some(),
        None => user.is_owner,
    };
    if !visible {
        return Err(ApiError(AppError::NotFound("job not found".into())));
    }
    if let Some(obj) = job.as_object_mut() {
        obj.insert("project_id".into(), pid.map(Value::from).unwrap_or(Value::Null));
    }
    Ok(Json(job))
}

/// Cancel an ingest job — caller must be a member of its project (owner ok).
/// Queued jobs cancel outright; a running one stops after its current file
/// (its staged run is discarded, so the collection is untouched).
async fn ai_job_cancel_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    user: AuthUser,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = rag
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError(AppError::NotFound("RAG is not configured on this host".into())))?;
    let jobs = client
        .list_jobs()
        .await
        .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?;
    let job = jobs
        .iter()
        .find(|j| j.get("id").and_then(|i| i.as_str()) == Some(job_id.as_str()))
        .ok_or_else(|| ApiError(AppError::NotFound("job not found".into())))?;
    // Return NotFound uniformly (absent OR no access) so cancel can't be used to
    // probe which job ids exist in projects the caller can't see.
    let visible = match rag::job_project_id(job) {
        Some(pid) => user.is_owner || auth::member_role(&db, pid, user.id).await?.is_some(),
        None => user.is_owner,
    };
    if !visible {
        return Err(ApiError(AppError::NotFound("job not found".into())));
    }
    Ok(Json(
        client
            .cancel_job(&job_id)
            .await
            .map_err(|e| ApiError(AppError::Io(std::io::Error::other(e))))?,
    ))
}

/// Owner-only: delete a model profile.
async fn ai_profile_delete_handler(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<StatusCode, ApiError> {
    ops::delete_model_profile(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- loadouts (owner-only) ------------------------------------------------- //

/// Every loadout, each with the tool names it grants (for the management UI).
async fn loadouts_list_handler(State(db): State<Db>, _owner: AuthOwner) -> Result<Json<Vec<Value>>, ApiError> {
    let mut out = Vec::new();
    for l in ops::list_loadouts(&db).await? {
        let tools = ops::loadout_tool_names(&db, l.id).await.unwrap_or_default();
        out.push(json!({
            "id": l.id, "name": l.name, "description": l.description,
            "prompt_fragment": l.prompt_fragment, "routing_profile_id": l.routing_profile_id,
            "tools": tools,
        }));
    }
    Ok(Json(out))
}

async fn loadout_create_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(input): Json<ganban_core::models::NewLoadout>,
) -> Result<Json<ganban_core::models::Loadout>, ApiError> {
    if input.name.trim().is_empty() {
        return Err(ApiError(AppError::InvalidInput("a loadout needs a name".into())));
    }
    refuse_unknown_tools(&db, &input.tools).await?;
    Ok(Json(ops::create_loadout(&db, input).await?))
}

/// A loadout may only name tools this host has (see `tools::unknown_tool_names`).
async fn refuse_unknown_tools(db: &Db, tools: &[String]) -> Result<(), ApiError> {
    let unknown = tools::unknown_tool_names(db, tools).await;
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(ApiError(AppError::InvalidInput(format!("no such tool on this host: {}", unknown.join(", ")))))
    }
}

async fn loadout_update_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(input): Json<ganban_core::models::UpdateLoadout>,
) -> Result<Json<ganban_core::models::Loadout>, ApiError> {
    if let Some(tools) = &input.tools {
        refuse_unknown_tools(&db, tools).await?;
    }
    Ok(Json(ops::update_loadout(&db, id, input).await?))
}

async fn loadout_delete_handler(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<StatusCode, ApiError> {
    ops::delete_loadout(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The loadout ids a personality carries.
async fn profile_loadouts_handler(State(db): State<Db>, _owner: AuthOwner, Path(id): Path<i64>) -> Result<Json<Vec<i64>>, ApiError> {
    Ok(Json(ops::profile_loadout_ids(&db, id).await?))
}

/// Set a personality's loadouts (body: `{ "loadout_ids": [..] }`).
async fn profile_loadouts_set_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let ids: Vec<i64> = body
        .get("loadout_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    ops::set_profile_loadouts(&db, id, &ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ActiveProfileBody {
    id: i64,
}

/// Owner-only: set the active model profile.
async fn ai_active_profile_handler(
    State(db): State<Db>,
    _owner: AuthOwner,
    Json(body): Json<ActiveProfileBody>,
) -> Result<StatusCode, ApiError> {
    ops::set_app_setting(&db, "ai_active_profile_id", &body.id.to_string()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only: re-read the ragrat + Ollama connection from settings and swap the
/// live clients, so an AI Engines change in Settings applies without a restart.
async fn ai_reload_handler(
    State(db): State<Db>,
    Extension(rag): Extension<rag::SharedRag>,
    Extension(ollama): Extension<ollama::SharedOllama>,
    _owner: AuthOwner,
) -> Result<Json<Value>, ApiError> {
    let new_rag = rag::RagConfig::from_db(&db).await.map(rag::RagClient::new);
    let rag_enabled = new_rag.is_some();
    *rag.write().await = new_rag;
    *ollama.write().await = Some(ollama::OllamaClient::new(ollama::OllamaConfig::from_db(&db).await));
    Ok(Json(json!({ "rag_enabled": rag_enabled })))
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = if self.0.is_not_found() {
            StatusCode::NOT_FOUND
        } else if self.0.is_invalid_input() {
            StatusCode::BAD_REQUEST
        } else if self.0.is_unauthorized() {
            StatusCode::UNAUTHORIZED
        } else if self.0.is_forbidden() {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        let body = match self.0.code() {
            Some(code) => Json(json!({ "error": self.0.to_string(), "code": code })),
            None => Json(json!({ "error": self.0.to_string() })),
        };
        (status, body).into_response()
    }
}

#[cfg(test)]
mod api_error_tests {
    use super::*;

    async fn body_of(e: AppError) -> (StatusCode, Value) {
        let res = ApiError(e).into_response();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_refusal_sends_its_code_next_to_the_message() {
        let code = ganban_core::error::codes::AI_FILE_TOO_LARGE;
        assert!(AppError::Refused { code, message: String::new() }.is_invalid_input(), "other transports map it to 400 too");
        let (status, body) = body_of(AppError::Refused { code, message: "too big".into() }).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], code);
        assert_eq!(body["error"], "Invalid input: too big");
        let (_, plain) = body_of(AppError::InvalidInput("nope".into())).await;
        assert!(plain.get("code").is_none(), "{plain}");
    }
}

#[cfg(test)]
mod proposal_tests {
    use super::*;
    use serde_json::json as j;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_proposals_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }
    fn test_root() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("ganban_root_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }


    async fn ledger_rows(db: &Db) -> Vec<(String, String, i64, Option<i64>)> {
        sqlx::query_as::<_, (String, String, i64, Option<i64>)>(
            "SELECT status, tool, project_id, chat_id FROM agent_actions ORDER BY id",
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    /// Seed a named member of a project (the assignment tools resolve names
    /// and re-check membership at proposal time).
    async fn seed_member(db: &Db, id: i64, name: &str, pid: i64) {
        sqlx::query("INSERT OR IGNORE INTO users (id, username, full_name) VALUES (?, ?, ?)")
            .bind(id).bind(name).bind(name).execute(db).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')")
            .bind(pid).bind(id).execute(db).await.unwrap();
    }

    /// The member-agent return path end to end (MEMBER_AGENTS §2§7): an
    /// externally-submitted proposal — no chat behind it, origin 'agent' —
    /// crosses the SAME gate and lands on the ledger with both identities,
    /// a NULL chat link, and NULL model columns (no host model ran).
    #[tokio::test]
    async fn member_agent_return_crosses_the_gate_with_attribution() {
        let db = test_db("crossing").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Shared" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        seed_member(&db, 2, "alice", pid).await;
        let task = dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "Charter summaries", "status": "To Do", "priority": "Medium" }
        })).await.unwrap();
        let tid = task["id"].as_i64().unwrap();

        // Alice's client submits her local agent's draft — validated by the
        // same prepare_write as a host chat turn, chat_id 0 = "no conversation".
        let pw = tools::prepare_write(&db, 2, pid, "create_comment", &j!({ "task_id": tid, "content": "Draft: 3 charters compared …" })).await.unwrap();
        let id = ganban_core::proposals::register(&db, pid, 2, None, 0, pw.command, &pw.args, &pw.summary, &pw.details, Some("agent")).await.unwrap();

        // Attribution survives storage: the feed row says who and how.
        let mine = ganban_core::proposals::list_for_user(&db, 2, false).await.unwrap();
        assert_eq!(mine[0].origin.as_deref(), Some("agent"));

        // Alice approves her own return (default 'proposer' policy)…
        let out = consume_and_apply(&db, &test_root(), id, 2).await.unwrap();
        assert_eq!(out["ok"], true);

        // …and the ledger row carries: no chat link, both identities, no host model.
        let rows = sqlx::query_as::<_, (String, i64, Option<i64>, Option<i64>, Option<String>)>(
            "SELECT status, user_id, approver_id, chat_id, model FROM agent_actions ORDER BY id DESC LIMIT 1",
        ).fetch_one(&db).await.unwrap();
        assert_eq!(rows.0, "applied");
        assert_eq!(rows.1, 2, "proposer = Alice");
        assert_eq!(rows.2, Some(2), "approver = Alice");
        assert_eq!(rows.3, None, "an external proposal has no host conversation");
        assert_eq!(rows.4, None, "no host model ran");
    }

    /// A proposed assignment bakes `assignedBy` from the authenticated
    /// proposer at prepare time — the context-free executor never trusts a
    /// client-supplied identity — and applying it really assigns.
    #[tokio::test]
    async fn assign_task_proposal_bakes_the_assigner_and_applies() {
        let db = test_db("assign").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Assign" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        seed_member(&db, 1, "owner", pid).await;
        seed_member(&db, 2, "alice", pid).await;
        let task = dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "T", "status": "To Do", "priority": "Low" }
        })).await.unwrap();
        let tid = task["id"].as_i64().unwrap();

        // A non-member target is refused at proposal time, not at apply time.
        assert!(tools::prepare_write(&db, 1, pid, "assign_task", &j!({ "task_id": tid, "user_id": 99 })).await.is_err());

        let pw = tools::prepare_write(&db, 1, pid, "assign_task", &j!({ "task_id": tid, "user_id": 2 })).await.unwrap();
        assert_eq!(pw.args["assignedBy"], 1, "assigner identity baked from the proposer");
        assert!(pw.summary.contains("alice"), "the card reads like a sentence: {}", pw.summary);

        let id = ganban_core::proposals::register(&db, pid, 1, None, 7, pw.command, &pw.args, &pw.summary, &pw.details, None).await.unwrap();
        consume_and_apply(&db, &test_root(), id, 1).await.unwrap();

        let assignees = ganban_core::assignments::assignees_for_task(&db, tid).await.unwrap();
        assert_eq!(assignees.len(), 1);
        assert_eq!(assignees[0].user_id, Some(2));
        assert_eq!(assignees[0].assigned_by, 1);
    }

    #[tokio::test]
    async fn approving_a_proposal_applies_it_and_ledgers_it() {
        let db = test_db("apply_ledger").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Ledger" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();

        let pw = tools::prepare_write(&db, 1, pid, "create_task", &j!({ "title": "Ledgered task" })).await.unwrap();
        let id = ganban_core::proposals::register(&db, pid, 1, Some(7), 42, pw.command, &pw.args, &pw.summary, &pw.details, None).await.unwrap();

        let out = consume_and_apply(&db, &test_root(), id, 1).await.unwrap();
        assert_eq!(out["ok"], true);

        // The write landed…
        let tasks = dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(tasks.as_array().unwrap().iter().any(|t| t["title"] == "Ledgered task"));
        // …and left exactly one applied row in the ledger, tied to its chat.
        let rows = ledger_rows(&db).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], ("applied".into(), "create_task".into(), pid, Some(42)));

        // Consume-once: a second approval of the same id finds nothing.
        let again = consume_and_apply(&db, &test_root(), id, 1).await;
        assert!(again.is_err(), "double-submit must fail once consumed");
        assert_eq!(ledger_rows(&db).await.len(), 1, "a failed re-approval must not ledger again");
    }

    #[tokio::test]
    async fn rejecting_a_proposal_is_a_domain_no_op_and_consumes_it() {
        let db = test_db("reject_ledger").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Reject" } })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();

        let pw = tools::prepare_write(&db, 1, pid, "create_task", &j!({ "title": "Never created" })).await.unwrap();
        let id = ganban_core::proposals::register(&db, pid, 1, None, 5, pw.command, &pw.args, &pw.summary, &pw.details, None).await.unwrap();

        consume_and_reject(&db, id, 1).await.unwrap();

        // Nothing changed in the domain…
        let tasks = dispatch(&db, "get_tasks", &j!({ "projectId": pid, "archived": false })).await.unwrap();
        assert!(tasks.as_array().unwrap().is_empty(), "reject must not create anything");
        // …the rejection is on the record…
        let rows = ledger_rows(&db).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "rejected");
        // …and the proposal is consumed: it can be neither re-rejected nor applied.
        assert!(consume_and_reject(&db, id, 1).await.is_err());
        assert!(consume_and_apply(&db, &test_root(), id, 1).await.is_err(), "a rejected proposal must never apply");
    }

    /// Scope is re-checked when a proposal is approved: a task that moved to
    /// another project, or a proposer who left, refuses the write, and the
    /// proposal stays listed to be rejected.
    #[tokio::test]
    async fn approval_rechecks_the_proposals_scope() {
        let db = test_db("rescope").await;
        let a = dispatch(&db, "create_project", &j!({ "input": { "name": "A" }, "createdBy": 1 })).await.unwrap()["id"].as_i64().unwrap();
        let b = dispatch(&db, "create_project", &j!({ "input": { "name": "B" }, "createdBy": 1 })).await.unwrap()["id"].as_i64().unwrap();
        seed_member(&db, 2, "alice", a).await;
        let tid = dispatch(&db, "create_task", &j!({
            "input": { "project_id": a, "title": "T", "status": "To Do", "priority": "Low" }
        })).await.unwrap()["id"].as_i64().unwrap();

        // The task moves to project B after Alice's agent proposed a comment on it.
        let pw = tools::prepare_write(&db, 2, a, "create_comment", &j!({ "task_id": tid, "content": "hi" })).await.unwrap();
        let id = ganban_core::proposals::register(&db, a, 2, None, 0, pw.command, &pw.args, &pw.summary, &pw.details, None).await.unwrap();
        sqlx::query("UPDATE tasks SET project_id = ? WHERE id = ?").bind(b).bind(tid).execute(&db).await.unwrap();
        let err = consume_and_apply(&db, &test_root(), id, 2).await.unwrap_err().to_string();
        assert!(err.contains("no longer applies"), "{err}");
        assert!(ledger_rows(&db).await.is_empty(), "nothing applied");
        assert!(ganban_core::proposals::peek_meta(&db, id).await.unwrap().is_some(), "still listed, to be rejected");

        // A proposer who has left the project can't have their write land either.
        sqlx::query("UPDATE tasks SET project_id = ? WHERE id = ?").bind(a).bind(tid).execute(&db).await.unwrap();
        ganban_core::auth::remove_project_member(&db, a, 2).await.unwrap();
        let err = consume_and_apply(&db, &test_root(), id, 1).await.unwrap_err().to_string();
        assert!(err.contains("no longer a member"), "{err}");

        // Back in scope, it applies.
        seed_member(&db, 2, "alice", a).await;
        assert_eq!(consume_and_apply(&db, &test_root(), id, 2).await.unwrap()["ok"], true);
    }

    #[tokio::test]
    async fn failed_apply_reinserts_the_proposal_and_ledgers_nothing() {
        let db = test_db("retry").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Retry" }, "createdBy": 1 })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        let task = dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "T", "status": "To Do", "priority": "Low" }
        })).await.unwrap();
        let tid = task["id"].as_i64().unwrap();

        let pw = tools::prepare_write(&db, 1, pid, "update_task", &j!({ "task_id": tid, "title": "Renamed" })).await.unwrap();
        let id = ganban_core::proposals::register(&db, pid, 1, None, 9, pw.command, &pw.args, &pw.summary, &pw.details, None).await.unwrap();

        // Sabotage the target so apply fails (NotFound), then verify retryability.
        dispatch(&db, "permanently_delete_task", &j!({ "taskId": tid })).await.unwrap();
        assert!(consume_and_apply(&db, &test_root(), id, 1).await.is_err());
        assert!(ledger_rows(&db).await.is_empty(), "a failed apply must not be ledgered as applied");
        assert!(ganban_core::proposals::peek_meta(&db, id).await.unwrap().is_some(), "a failed apply must reinsert the proposal for retry");
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    use serde_json::json as j;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_routing_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn tool_loop_routes_to_the_configured_tier_and_falls_back_cleanly() {
        let db = test_db("route").await;
        let chat = ollama::ChatParams { model: "light:8b".into(), temperature: Some(0.7), max_tokens: None, num_ctx: None, endpoint: None };

        // No routing table → the conversation's own params.
        assert_eq!(resolve_task_params(&db, "tools", &chat).await.model, "light:8b");

        // Route "tools" at a strong tool-capable profile → the loop gets it.
        let strong = ops::upsert_model_profile(&db, None, "Tool runner", "qwen2.5:14b", None, Some(0.2), None, Some("tools"), None, None, None, None)
            .await
            .unwrap();
        ops::set_app_setting(&db, "ai_routing", &j!({ "tools": strong.id }).to_string()).await.unwrap();
        let routed = resolve_task_params(&db, "tools", &chat).await;
        assert_eq!(routed.model, "qwen2.5:14b");
        assert_eq!(routed.temperature, Some(0.2));

        // The conversation class is untouched by the table (only the tool loop routes).
        assert_eq!(resolve_task_params(&db, "conversation", &chat).await.model, "light:8b");

        // A stale pointer (profile deleted) must behave as unrouted, not error.
        ops::delete_model_profile(&db, strong.id).await.unwrap();
        assert_eq!(resolve_task_params(&db, "tools", &chat).await.model, "light:8b");
    }

    #[tokio::test]
    async fn routing_table_is_config_set_and_cleared_per_class() {
        let db = test_db("table").await;
        let p = ops::upsert_model_profile(&db, None, "T", "qwen2.5:14b", None, None, None, None, None, None, None, None).await.unwrap();

        assert_eq!(routed_profile_id(&db, "tools").await, None, "empty table");
        ops::set_app_setting(&db, "ai_routing", &j!({ "tools": p.id }).to_string()).await.unwrap();
        assert_eq!(routed_profile_id(&db, "tools").await, Some(p.id));
        ops::set_app_setting(&db, "ai_routing", "{}").await.unwrap();
        assert_eq!(routed_profile_id(&db, "tools").await, None, "cleared route");
        ops::set_app_setting(&db, "ai_routing", "not json").await.unwrap();
        assert_eq!(routed_profile_id(&db, "tools").await, None, "garbage config = unrouted, never a crash");
    }
}

#[cfg(test)]
mod inbox_tests {
    use super::*;
    use serde_json::json as j;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_inbox_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    #[tokio::test]
    async fn inbox_lists_only_the_callers_proposals_with_diff_details() {
        let db = test_db("list").await;
        let proj = dispatch(&db, "create_project", &j!({ "input": { "name": "Inbox" }, "createdBy": 1 })).await.unwrap();
        let pid = proj["id"].as_i64().unwrap();
        sqlx::query("INSERT INTO users (id, username, full_name) VALUES (2, 'other', 'Other')").execute(&db).await.unwrap();
        auth::add_project_member(&db, pid, 2, auth::ROLE_MEMBER).await.unwrap();
        let task = dispatch(&db, "create_task", &j!({
            "input": { "project_id": pid, "title": "Old title", "status": "To Do", "priority": "Low" }
        })).await.unwrap();
        let tid = task["id"].as_i64().unwrap();

        let upd = tools::prepare_write(&db, 1, pid, "update_task", &j!({ "task_id": tid, "title": "New title" })).await.unwrap();
        // The diff snapshots only the touched fields: before from the live row.
        assert_eq!(upd.details["before"]["title"], "Old title");
        assert_eq!(upd.details["after"]["title"], "New title");
        ganban_core::proposals::register(&db, pid, 1, None, 10, upd.command, &upd.args, &upd.summary, &upd.details, None).await.unwrap();
        let other = tools::prepare_write(&db, 2, pid, "create_task", &j!({ "title": "Someone else's" })).await.unwrap();
        ganban_core::proposals::register(&db, pid, 2, None, 11, other.command, &other.args, &other.summary, &other.details, None).await.unwrap();

        let mine = ganban_core::proposals::list_for_user(&db, 1, false).await.unwrap();
        assert_eq!(mine.len(), 1, "the inbox never shows another member's proposals");
        assert_eq!(mine[0].command, "update_task");
        assert_eq!(mine[0].details["before"]["title"], "Old title");
        assert_eq!(mine[0].chat_id, 10);

        // Resolving it empties the inbox.
        consume_and_reject(&db, mine[0].id, 1).await.unwrap();
        assert!(ganban_core::proposals::list_for_user(&db, 1, false).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn ledger_lists_per_project_and_globally_newest_first() {
        let db = test_db("ledger_list").await;
        let a = dispatch(&db, "create_project", &j!({ "input": { "name": "A" } })).await.unwrap()["id"].as_i64().unwrap();
        let b = dispatch(&db, "create_project", &j!({ "input": { "name": "B" } })).await.unwrap()["id"].as_i64().unwrap();
        for (pid, tool) in [(a, "create_task"), (b, "create_task"), (a, "delete_task")] {
            ops::record_agent_action(&db, ops::NewAgentAction {
                status: "applied", user_id: 1, profile_id: None, project_id: Some(pid), chat_id: None,
                routine_id: None, tool, summary: "s", args_json: "{}", result_json: None,
                model: None, prompt_tokens: None, completion_tokens: None, duration_ms: None,
                protocol_slug: None, protocol_version: None, content_hash: None, parent_action_id: None, approver_id: None,
            }).await.unwrap();
        }
        let on_a = ops::list_agent_actions(&db, Some(a), 100).await.unwrap();
        assert_eq!(on_a.len(), 2);
        assert_eq!(on_a[0].tool, "delete_task", "newest first");
        let all = ops::list_agent_actions(&db, None, 100).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(ops::list_agent_actions(&db, None, 2).await.unwrap().len(), 2, "limit respected");
    }
}

#[cfg(test)]
mod protocol_resolution_tests {
    use super::*;

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_protores_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        ganban_core::init_db(&path).await.unwrap()
    }

    fn manual_fm(task_class: &str, runner: &str, model: Option<&str>) -> String {
        json!({
            "protocol": 1, "task_class": task_class,
            "trigger": { "kind": "manual" },
            "engine": { "runner": runner, "model": model },
        })
        .to_string()
    }

    #[tokio::test]
    async fn table_wins_over_legacy_routing_and_carries_provenance() {
        let db = test_db("table_first").await;
        // Legacy setting says ollama; the table says pi. The table must win.
        ops::set_app_setting(&db, "ai_routing", r#"{"structure_toc": {"runner":"ollama"}}"#).await.unwrap();
        let (_, v, hash) = ganban_core::protocols::upsert_protocol_version(
            &db, "structure_toc", "ToC", &manual_fm("structure_toc", "pi", Some("claude-haiku-4-5")), "briefing", None, true,
        ).await.unwrap();

        let p = resolve_protocol(&db, "structure_toc").await;
        assert!(matches!(p.runner, Runner::Pi), "the table is authoritative");
        assert_eq!(p.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(p.slug.as_deref(), Some("structure_toc"), "provenance present");
        assert_eq!(p.version, Some(v));
        assert_eq!(p.content_hash.as_deref(), Some(hash.as_str()));

        // No table row for this class → legacy entry resolves, no provenance.
        ops::set_app_setting(&db, "ai_routing", r#"{"structure_toc": {"runner":"ollama"}, "tools": 7}"#).await.unwrap();
        let legacy = resolve_protocol(&db, "tools").await;
        assert!(matches!(legacy.runner, Runner::Ollama));
        assert_eq!(legacy.profile_id, Some(7));
        assert!(legacy.slug.is_none(), "legacy resolution carries no provenance");
    }

    #[tokio::test]
    async fn routing_migration_is_one_time_and_preserves_both_shapes() {
        let db = test_db("migration").await;
        ops::set_app_setting(
            &db,
            "ai_routing",
            r#"{"tools": 3, "structure_toc": {"runner":"pi","model":"glm-5.2"}}"#,
        )
        .await
        .unwrap();
        // Profile 3 doesn't exist in this fixture — the migration copies the
        // pointer as-is (resolution treats a stale pointer as unrouted, same
        // as the legacy path did).
        migrate_routing_to_protocols(&db).await;

        let (rec, ver) = ganban_core::protocols::active_protocol_for_task_class(&db, "tools").await.unwrap().unwrap();
        assert_eq!(rec.slug, "tools");
        assert_eq!(ver.version, 1);
        let fm = ganban_core::protocols::validate_frontmatter(&ver.frontmatter_json).unwrap();
        assert_eq!(fm.engine.runner, "ollama");
        assert_eq!(fm.engine.profile_id, Some(3));
        assert_eq!(fm.trigger.kind, "manual");

        let p = resolve_protocol(&db, "structure_toc").await;
        assert!(matches!(p.runner, Runner::Pi));
        assert_eq!(p.model.as_deref(), Some("glm-5.2"));

        // Re-running never creates version 2 (idempotent), and a deliberate
        // deactivation survives the next startup.
        migrate_routing_to_protocols(&db).await;
        let (_, ver) = ganban_core::protocols::active_protocol_for_task_class(&db, "tools").await.unwrap().unwrap();
        assert_eq!(ver.version, 1, "migration must be one-time, not a sync");
        ganban_core::protocols::deactivate_protocol(&db, "tools").await.unwrap();
        migrate_routing_to_protocols(&db).await;
        assert!(
            ganban_core::protocols::active_protocol_for_task_class(&db, "tools").await.unwrap().is_none(),
            "an explicit deactivation must not be resurrected by the legacy mirror"
        );
    }
}

#[cfg(test)]
mod tab_state_slot_tests {
    use super::tab_state_key_ok;

    #[test]
    #[cfg(feature = "tab-quiz")]
    fn slots_ride_on_a_compiled_in_tab() {
        assert!(tab_state_key_ok("quiz"), "the bare tab id is the default slot");
        assert!(tab_state_key_ok("quiz:history"), "a kebab slot on a known tab");
        assert!(!tab_state_key_ok("quiz:"), "empty slot");
        assert!(!tab_state_key_ok("quiz:History"), "slots are lowercase");
        assert!(!tab_state_key_ok("quiz:a/b"), "no path characters");
        assert!(!tab_state_key_ok("quiz:history:x"), "one level only");
        assert!(!tab_state_key_ok(&format!("quiz:{}", "x".repeat(25))), "short");
    }

    #[test]
    fn unknown_tabs_stay_unknown() {
        assert!(!tab_state_key_ok("no-such-tab"));
        assert!(!tab_state_key_ok("no-such-tab:trade"), "a slot never makes an unknown tab known");
    }
}

#[cfg(test)]
mod invoke_wiring_tests {
    //! The HTTP adapter over the one command table: `/invoke` through the real
    //! router, with the real auth extractors, in-process (no socket).
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    struct Host {
        db: Db,
        hub: events::EventHub,
    }

    impl Host {
        async fn new(tag: &str) -> Self {
            Host { db: commands::testkit::test_db(&format!("wiring_{tag}")).await, hub: events::EventHub::new() }
        }

        fn app(&self) -> Router {
            let root = std::env::temp_dir().join(format!("ganban_wiring_root_{}", std::process::id()));
            let rag: rag::SharedRag = Arc::new(tokio::sync::RwLock::new(None));
            let ollama: ollama::SharedOllama = Arc::new(tokio::sync::RwLock::new(None));
            router(self.db.clone(), Shares::default(), root, rag, ollama, self.hub.clone())
        }

        /// POST /invoke as `who`; returns (status, body, the traffic label).
        async fn invoke(&self, who: Who<'_>, command: &str, args: Value) -> (StatusCode, Value, Option<String>) {
            let mut req = Request::post("/invoke").header(header::CONTENT_TYPE, "application/json");
            if let Who::Device(token) = who {
                req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let mut req = req.body(Body::from(json!({ "command": command, "args": args }).to_string())).unwrap();
            let peer: SocketAddr = match who {
                Who::Loopback => ([127, 0, 0, 1], 50_000).into(),
                _ => ([100, 64, 0, 9], 50_000).into(),
            };
            req.extensions_mut().insert(ConnectInfo(peer));
            let res = self.app().oneshot(req).await.unwrap();
            let status = res.status();
            let label = res.extensions().get::<hostmon::InvokeLabel>().map(|l| l.0.clone());
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), label)
        }

        /// POST raw bytes to an upload route as `who`, declaring `declared` as the
        /// Content-Length (the body may stall: see the dropped-upload test).
        fn upload_request(&self, who: Who<'_>, path: &str, declared: u64, body: Body) -> Request<Body> {
            let mut req = Request::post(path).header(header::CONTENT_LENGTH, declared);
            if let Who::Device(token) = who {
                req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let mut req = req.body(body).unwrap();
            let peer: SocketAddr = match who {
                Who::Loopback => ([127, 0, 0, 1], 50_000).into(),
                _ => ([100, 64, 0, 9], 50_000).into(),
            };
            req.extensions_mut().insert(ConnectInfo(peer));
            req
        }

        /// Enrol a device for a new member of `project`; returns its bearer token.
        async fn member_device(&self, project: i64, name: &str) -> String {
            let invite = auth::create_enrollment_token(&self.db, "invite", None, Some(project), Some("member"), Some(name), auth::INVITE_TTL_SECS)
                .await
                .unwrap();
            auth::enroll(&self.db, &invite, Some("phone"), Some(name)).await.unwrap().device_token
        }
    }

    #[derive(Clone, Copy)]
    enum Who<'a> {
        /// The host machine itself: the owner, no token.
        Loopback,
        /// A tailnet device with this bearer token.
        Device(&'a str),
        /// A tailnet device without a token.
        Stranger,
    }

    /// What this thread logs, for as long as the guard lives.
    fn capture_logs() -> (tracing::subscriber::DefaultGuard, Arc<std::sync::Mutex<Vec<u8>>>) {
        // tracing-core caches each callsite's interest globally, and while only ONE
        // dispatcher is registered it asks the registering thread's default instead
        // of the list. A callsite first hit on another test's thread (no subscriber
        // there) was then cached as "never", and this capture missed its lines (a
        // flaky upload-log test, about 1 run in 6). A second, permanent dispatcher
        // keeps registration on the list path.
        static SECOND: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
        SECOND.get_or_init(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
        #[derive(Clone)]
        struct Buf(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Buf(logs.clone());
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || sink.clone()).finish();
        (tracing::subscriber::set_default(subscriber), logs)
    }

    /// GET or POST a route as `who`.
    async fn route(host: &Host, who: Who<'_>, method: &str, path: &str, body: Body) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(path).header(header::CONTENT_TYPE, "application/json");
        if let Who::Device(t) = who {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let mut req = req.body(body).unwrap();
        let peer: SocketAddr = match who {
            Who::Loopback => ([127, 0, 0, 1], 50_000).into(),
            _ => ([100, 64, 0, 9], 50_000).into(),
        };
        req.extensions_mut().insert(ConnectInfo(peer));
        let res = host.app().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn file_and_reaction_routes_respect_task_visibility() {
        let host = Host::new("vis_routes").await;
        let (_, project, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "P" } })).await;
        let pid = project["id"].as_i64().unwrap();
        let task = |title: &str| json!({ "input": { "project_id": pid, "title": title, "status": "To Do", "priority": "Low" } });
        let (_, open, _) = host.invoke(Who::Loopback, "create_task", task("Open")).await;
        let (_, secret, _) = host.invoke(Who::Loopback, "create_task", task("Reorg")).await;
        let (open, secret) = (open["id"].as_i64().unwrap(), secret["id"].as_i64().unwrap());
        host.invoke(Who::Loopback, "set_task_visibility", json!({ "taskId": secret, "visibility": "admins" })).await;
        let bo = host.member_device(pid, "Bo").await;

        // Shared files on both tasks, uploaded by the owner.
        let up = |t: i64| format!("/files/upload?task_id={t}&file_name=f.txt");
        let (_, on_open) = route(&host, Who::Loopback, "POST", &up(open), Body::from("bytes")).await;
        let (_, on_secret) = route(&host, Who::Loopback, "POST", &up(secret), Body::from("bytes")).await;
        let comment = |t: i64| json!({ "input": { "task_id": t, "content": "c" } });
        let (_, c_secret, _) = host.invoke(Who::Loopback, "create_comment", comment(secret)).await;
        host.invoke(Who::Loopback, "create_comment", comment(open)).await;

        let bo_sees = |status: StatusCode| status == StatusCode::OK;
        assert!(bo_sees(route(&host, Who::Device(&bo), "GET", &format!("/files/{}", on_open["id"]), Body::empty()).await.0));
        for (method, path, body) in [
            ("GET", format!("/files/{}", on_secret["id"]), Body::empty()),
            ("DELETE", format!("/files/{}", on_secret["id"]), Body::empty()),
            ("POST", format!("/files/upload?task_id={secret}&file_name=g.txt"), Body::from("x")),
            ("GET", format!("/tasks/{secret}/reactions"), Body::empty()),
            ("POST", format!("/comments/{}/react", c_secret["id"]), Body::from(r#"{"emoji":"👍"}"#)),
        ] {
            let (status, body) = route(&host, Who::Device(&bo), method, &path, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path} on a hidden task looks absent: {body}");
        }
        let (_, listed) = route(&host, Who::Device(&bo), "GET", &format!("/projects/{pid}/attachments"), Body::empty()).await;
        let listed: Vec<i64> = listed.as_array().unwrap().iter().map(|a| a["task_id"].as_i64().unwrap()).collect();
        assert_eq!(listed, vec![open], "the project's file list leaves out the hidden task's files");

        // Files stored only on the attaching device (is_shared = 0) list too, under the same rule.
        for t in [open, secret] {
            let local = json!({ "input": { "task_id": t, "file_path": "/Users/me/notes.md", "file_name": "notes.md" } });
            host.invoke(Who::Loopback, "create_file_attachment", local).await;
        }
        let local_on = |rows: &Value| -> Vec<i64> {
            let rows = rows.as_array().unwrap().iter().filter(|a| a["is_shared"] == false);
            rows.map(|a| a["task_id"].as_i64().unwrap()).collect()
        };
        let (_, owner_rows) = route(&host, Who::Loopback, "GET", &format!("/projects/{pid}/attachments"), Body::empty()).await;
        let mut both = local_on(&owner_rows);
        both.sort();
        assert_eq!(both, vec![open.min(secret), open.max(secret)], "the owner (local mode) gets both local files");
        let (_, bo_rows) = route(&host, Who::Device(&bo), "GET", &format!("/projects/{pid}/attachments"), Body::empty()).await;
        assert_eq!(local_on(&bo_rows), vec![open], "a local file on a hidden task stays absent");

        route(&host, Who::Loopback, "POST", &format!("/comments/{}/react", c_secret["id"]), Body::from(r#"{"emoji":"👍"}"#)).await;
        let (_, tallies) = route(&host, Who::Device(&bo), "GET", &format!("/projects/{pid}/reactions"), Body::empty()).await;
        assert!(tallies.as_array().unwrap().is_empty(), "no tallies for hidden comments: {tallies}");

        // The project's agent ledger: an action on the hidden task (its summary quotes it).
        for (t, summary) in [(open, "Retitled 'Open'"), (secret, "Retitled 'Reorg'")] {
            sqlx::query("INSERT INTO agent_actions (status, user_id, project_id, tool, summary, args_json) VALUES ('applied', 1, ?, 'update_task', ?, ?)")
                .bind(pid)
                .bind(summary)
                .bind(json!({ "task_id": t, "title": "x" }).to_string())
                .execute(&host.db)
                .await
                .unwrap();
        }
        let (_, ledger) = route(&host, Who::Device(&bo), "GET", &format!("/agent/actions?project_id={pid}"), Body::empty()).await;
        let summaries: Vec<&str> = ledger.as_array().unwrap().iter().map(|a| a["summary"].as_str().unwrap()).collect();
        assert_eq!(summaries, vec!["Retitled 'Open'"], "the ledger leaves out actions on hidden tasks");
    }

    #[tokio::test]
    async fn event_files_upload_for_admins_and_download_for_who_sees_the_event() {
        let host = Host::new("event_files").await;
        let (_, project, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "P" } })).await;
        let pid = project["id"].as_i64().unwrap();
        let (_, other, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "Q" } })).await;
        let event = |title: &str, project: i64| {
            json!({ "projectId": project, "input": { "title": title, "event_date": "2026-10-13T09:00:00Z", "all_day": true, "notification_enabled": false } })
        };
        let (_, ev, _) = host.invoke(Who::Loopback, "create_event", event("Launch", pid)).await;
        let (_, hidden, _) = host.invoke(Who::Loopback, "create_event", event("Elsewhere", other["id"].as_i64().unwrap())).await;
        let (ev, hidden) = (ev["id"].as_i64().unwrap(), hidden["id"].as_i64().unwrap());
        let mia = host.member_device(pid, "Mia").await;
        let invite = auth::create_enrollment_token(&host.db, "invite", None, Some(pid), Some("admin"), Some("Ana"), auth::INVITE_TTL_SECS)
            .await
            .unwrap();
        let ana = auth::enroll(&host.db, &invite, Some("phone"), Some("Ana")).await.unwrap().device_token;
        let up = |e: i64, rel: &str| format!("/event-files/upload?event_id={e}&file_name=a.txt&file_type=text/plain&rel_path={rel}");

        let (status, _) = route(&host, Who::Device(&mia), "POST", &up(ev, "Brief/a.txt"), Body::from("bytes")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a member reads an event's files, an admin adds them");
        let (status, _) = route(&host, Who::Device(&ana), "POST", &up(hidden, "a.txt"), Body::from("bytes")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "an event out of sight looks absent");
        let (status, _) = route(&host, Who::Device(&ana), "POST", &up(ev, "../a.txt"), Body::from("bytes")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "no path tricks");
        let (status, file) = route(&host, Who::Device(&ana), "POST", &up(ev, "Brief/a.txt"), Body::from("bytes")).await;
        assert_eq!(status, StatusCode::OK, "{file}");
        assert_eq!((file["rel_path"].as_str(), file["size_bytes"].as_i64()), (Some("Brief/a.txt"), Some(5)));
        let (status, _) = route(&host, Who::Device(&ana), "POST", &up(ev, "Brief/b.txt"), Body::from("bytes")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "the folder path ends in the file's own name");
        let (_, on_hidden) = route(&host, Who::Loopback, "POST", &up(hidden, "a.txt"), Body::from("other")).await;

        let get = |who: Who<'_>, id: &Value| {
            let mut req = Request::get(format!("/event-files/{id}"));
            if let Who::Device(t) = who {
                req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
            }
            let mut req = req.body(Body::empty()).unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 50_000))));
            host.app().oneshot(req)
        };
        let res = get(Who::Device(&mia), &file["id"]).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()[..], b"bytes");
        assert_eq!(get(Who::Device(&mia), &on_hidden["id"]).await.unwrap().status(), StatusCode::NOT_FOUND);
        assert_eq!(get(Who::Stranger, &file["id"]).await.unwrap().status(), StatusCode::UNAUTHORIZED);

        let (_, listed, _) = host.invoke(Who::Device(&mia), "get_event_files", json!({ "eventId": ev })).await;
        assert_eq!(listed["files"][0]["id"], file["id"]);
        let (status, _, _) = host.invoke(Who::Device(&mia), "delete_event_file", json!({ "fileId": file["id"] })).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = host.invoke(Who::Device(&ana), "delete_event_file", json!({ "fileId": file["id"] })).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(get(Who::Device(&mia), &file["id"]).await.unwrap().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn agent_task_results_are_the_owners_alone() {
        let host = Host::new("agent_task_auth").await;
        let (_, project, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "P" } })).await;
        let token = host.member_device(project["id"].as_i64().unwrap(), "Mia").await;
        let get = |who: Who<'_>| {
            let mut req = Request::get("/ai/agent-task/agent-1-1");
            if let Who::Device(t) = who {
                req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
            }
            let mut req = req.body(Body::empty()).unwrap();
            let peer: SocketAddr = match who {
                Who::Loopback => ([127, 0, 0, 1], 50_000).into(),
                _ => ([100, 64, 0, 9], 50_000).into(),
            };
            req.extensions_mut().insert(ConnectInfo(peer));
            host.app().oneshot(req)
        };
        assert_eq!(get(Who::Stranger).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(get(Who::Device(&token)).await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(get(Who::Loopback).await.unwrap().status(), StatusCode::NOT_FOUND, "the owner gets 'unknown agent task'");
    }

    #[tokio::test]
    async fn a_members_uploads_are_logged_with_who_where_and_how_they_ended() {
        let (_guard, logs) = capture_logs();
        let host = Host::new("upload_log").await;
        let (_, project, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "Brief" } })).await;
        let pid = project["id"].as_i64().unwrap();
        let token = host.member_device(pid, "Mia").await;
        let path = format!("/projects/{pid}/files/upload?file_name=brief.pdf");

        let stored = host.app().oneshot(host.upload_request(Who::Device(&token), &path, 3, Body::from("abc"))).await.unwrap();
        assert_eq!(stored.status(), StatusCode::OK);
        let too_big = host.upload_request(Who::Device(&token), &path, 1 << 40, Body::from("abc"));
        assert_eq!(host.app().oneshot(too_big).await.unwrap().status(), StatusCode::BAD_REQUEST);
        // A client that goes away mid-upload: the body stalls, and the request
        // is abandoned (axum drops the handler, as on a disconnect).
        let stalled = Body::from_stream(async_stream::stream! {
            yield Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"first chunk"));
            futures_util::future::pending::<()>().await;
        });
        let abandoned = host.app().oneshot(host.upload_request(Who::Device(&token), &path, 1_000_000, stalled));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(200), abandoned).await.is_err());

        let text = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| l.contains("upload ")).collect();
        let who = format!("→ project {pid}, 'brief.pdf'");
        assert!(lines.iter().filter(|l| l.contains("upload started: user") && l.contains("(device ") && l.contains(&who)).count() == 3, "{text}");
        assert!(lines.iter().any(|l| l.contains("upload stored:") && l.contains("— 3 B in")), "{text}");
        assert!(lines.iter().any(|l| l.contains("upload refused:") && l.contains("remaining storage")), "{text}");
        assert!(lines.iter().any(|l| l.contains("upload dropped:") && l.contains("disconnected")), "{text}");
    }

    #[tokio::test]
    async fn invoke_runs_table_commands_for_the_owner_and_pulses_writes() {
        let host = Host::new("owner").await;
        let mut pulses = host.hub.subscribe();
        let (status, project, label) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "Wired" } })).await;
        assert_eq!(status, StatusCode::OK, "{project}");
        assert_eq!(label.as_deref(), Some("create_project"), "the traffic window names the command");
        assert_eq!(pulses.try_recv().unwrap().1, "projects", "a write pulses its coarse kind");

        // Authorship is stamped from the signed-in caller: the owner became owner-member.
        let pid = project["id"].as_i64().unwrap();
        let owner = auth::ensure_owner(&host.db).await.unwrap();
        assert_eq!(auth::member_role(&host.db, pid, owner).await.unwrap().as_deref(), Some("owner"));

        let (status, _, _) = host.invoke(Who::Loopback, "get_projects", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(pulses.try_recv().is_err(), "reads never pulse");
    }

    #[tokio::test]
    async fn finance_writes_send_no_pulse_to_other_members() {
        let host = Host::new("finance_quiet").await;
        let (_, a, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "A" } })).await;
        let token = host.member_device(a["id"].as_i64().unwrap(), "Mia").await;
        // Every subscriber (the owner's and other members' streams) shares this channel.
        let mut pulses = host.hub.subscribe();
        let before = host.hub.current_id();
        let input = json!({ "input": { "kind": "current", "name": "Everyday", "currency": "EUR", "openingBalanceMinor": 1000 } });
        let (status, account, _) = host.invoke(Who::Device(&token), "fin_create_account", input).await;
        assert_eq!(status, StatusCode::OK, "{account}");
        let args = json!({ "accountId": account["id"], "input": { "name": "Daily" } });
        let (status, _, _) = host.invoke(Who::Device(&token), "fin_update_account", args).await;
        assert_eq!(status, StatusCode::OK);
        assert!(pulses.try_recv().is_err(), "a finance write pulses nobody");
        assert_eq!(host.hub.current_id(), before, "nor moves the pulse id others resume from");
    }

    #[tokio::test]
    async fn personal_chats_are_their_users_alone_even_to_the_owner() {
        let host = Host::new("personal_chats").await;
        let (_, a, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "A" } })).await;
        let token = host.member_device(a["id"].as_i64().unwrap(), "Mia").await;
        let (status, space, _) = host.invoke(Who::Device(&token), "ensure_personal_space", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        let personal = space["projectId"].as_i64().unwrap();
        let mia: i64 = sqlx::query_scalar("SELECT personal_user_id FROM projects WHERE id = ?").bind(personal).fetch_one(&host.db).await.unwrap();
        let chat = ops::create_chat(&host.db, personal, Some(mia), None, Some("Money")).await.unwrap().id;
        ops::append_message(&host.db, chat, "user", "how much did I spend?", None, None, None, None, None, None).await.unwrap();

        let (status, listed) = route(&host, Who::Device(&token), "GET", &format!("/chats?project_id={personal}"), Body::empty()).await;
        assert_eq!((status, listed.as_array().map(Vec::len)), (StatusCode::OK, Some(1)));
        // The owner's project bypass stops at someone else's Personal lane.
        for path in [format!("/chats?project_id={personal}"), format!("/chats/{chat}/messages"), format!("/chats/binned?project_id={personal}")] {
            let (status, _) = route(&host, Who::Loopback, "GET", &path, Body::empty()).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
        let (status, _) = route(&host, Who::Loopback, "POST", &format!("/chats/{chat}/bin"), Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let body = Body::from(json!({ "public": true }).to_string());
        let (status, _) = route(&host, Who::Loopback, "POST", &format!("/chats/{chat}/publish"), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Nor does Mia share it: a Personal chat has no team.
        let body = Body::from(json!({ "public": true }).to_string());
        let (status, _) = route(&host, Who::Device(&token), "POST", &format!("/chats/{chat}/publish"), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn invoke_applies_access_rules_and_result_filters_to_members() {
        let host = Host::new("member").await;
        let (_, a, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "A" } })).await;
        let (_, b, _) = host.invoke(Who::Loopback, "create_project", json!({ "input": { "name": "B" } })).await;
        let (a, b) = (a["id"].as_i64().unwrap(), b["id"].as_i64().unwrap());
        let token = host.member_device(a, "Mia").await;

        let (status, list, _) = host.invoke(Who::Device(&token), "get_projects", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(commands::testkit::ids(&list), vec![a], "the result filter trims to her projects");

        let (status, _, _) = host.invoke(Who::Device(&token), "get_areas", json!({ "projectId": b })).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "a project she isn't in looks absent");
        let (status, body, _) = host.invoke(Who::Device(&token), "create_project", json!({ "input": { "name": "C" } })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        let (status, body, _) = host.invoke(Who::Device(&token), "frobnicate", json!({})).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("Not found: unknown command 'frobnicate'")));
    }

    #[tokio::test]
    async fn invoke_refuses_the_desktops_own_file_operations_by_name() {
        let host = Host::new("desktop_only").await;
        for command in ["export_database", "import_database", "set_user_profile"] {
            let (status, body, _) = host.invoke(Who::Loopback, command, json!({ "exportPath": "/tmp/x" })).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(body["error"].as_str().unwrap().contains("desktop-only operation"), "{body}");
        }
    }

    #[tokio::test]
    async fn the_old_rest_crud_routes_are_gone() {
        let host = Host::new("rest_gone").await;
        for path in ["/projects", "/tasks"] {
            let mut req = Request::post(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "name": "Ghost", "project_id": 1, "title": "Ghost" }).to_string()))
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000))));
            let res = host.app().oneshot(req).await.unwrap();
            assert_ne!(res.status(), StatusCode::OK, "POST {path} must not be a write route any more");
        }
        let (_, projects, _) = host.invoke(Who::Loopback, "get_projects", json!({})).await;
        assert_eq!(projects, json!([]), "nothing was created");
    }

    #[tokio::test]
    async fn invoke_needs_a_device_token_off_the_host() {
        let host = Host::new("stranger").await;
        let (status, _, _) = host.invoke(Who::Stranger, "get_projects", json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = host.invoke(Who::Device("not-a-token"), "get_projects", json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
