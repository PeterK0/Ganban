// Offline-first sync orchestrator (LOCAL-mode desktop only).
//
// A single sync_now run reconciles the local replica with the enrolled host:
//   PULL (HTTP) -> INGEST (local) -> persist cursor -> COLLECT (local)
//   -> PUSH (HTTP) -> ACK (local).
// HTTP uses the existing daemonFetch (8s timeout, Bearer token, 401 handling);
// the local steps are thin Tauri commands wrapping ganban_core::sync, so all
// SQL lives in core. The cursor advances to the PULL time only (never the push
// time — that would skip host changes made between pull and push).

import { invoke } from "@tauri-apps/api/core";
import { invokeLocal } from "./api";
import {
  daemonFetch,
  DaemonError,
  getDaemonBaseUrl,
  getDeviceToken,
  getTransportMode,
  isMobilePlatform,
  isTauri,
  isWebClient,
} from "./daemon";

const CURSOR_KEY = "sync_cursor";
const LAST_SYNC_KEY = "sync_last_at";

export interface SyncReport {
  ran: boolean;
  offline: boolean;
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  rejected: number;
  error?: string;
}

interface PullResponse {
  changes: IncomingChange[];
  cursor: string;
}
interface IncomingChange {
  entity: string;
  sync_uuid: string;
  op?: string;
  data?: Record<string, unknown>;
  fk_refs?: Record<string, unknown>;
  base_updated_at?: string | null;
  base?: Record<string, unknown> | null;
}
interface PushResponse {
  id_remap: Record<string, number>;
  conflicts: unknown[];
  applied: string[];
  rejected: unknown[];
  cursor: string;
}
interface IngestReport {
  applied: string[];
  conflicts: unknown[];
  rejected: unknown[];
}

export interface SyncConflict {
  sync_uuid: string;
  entity: string;
  base: Record<string, unknown>;
  local: Record<string, unknown>;
  server: Record<string, unknown>;
  clashing_cols: string[];
  created_at: string;
}

export interface SyncStatus {
  dirty_count: number;
  tombstone_count: number;
  conflict_count: number;
}

/**
 * True when this client can reconcile with a host: a desktop in LOCAL mode that
 * has paired with a host (URL + device token). Online/mobile/web clients are
 * live thin clients and never sync.
 */
export function canSyncNow(): boolean {
  return (
    isTauri() &&
    !isWebClient() &&
    !isMobilePlatform() &&
    getTransportMode() === "local" &&
    !!getDaemonBaseUrl() &&
    !!getDeviceToken()
  );
}

const empty = (over: Partial<SyncReport>): SyncReport => ({
  ran: false,
  offline: false,
  pulled: 0,
  applied: 0,
  pushed: 0,
  conflicts: 0,
  rejected: 0,
  ...over,
});

/** Run one full reconcile against the host. Safe to call when not paired (no-op). */
export async function syncNow(): Promise<SyncReport> {
  if (!canSyncNow()) return empty({});

  // 1. PULL — the only step that detects "offline"; abort before mutating.
  const cursor = ((await invokeLocal<string | null>("get_app_setting", { key: CURSOR_KEY })) ?? "").trim();
  let pulled: PullResponse;
  try {
    pulled = await daemonFetch<PullResponse>(
      `/sync/pull?since=${encodeURIComponent(cursor)}`,
      { method: "GET" }
    );
  } catch (e) {
    if (e instanceof DaemonError) {
      return empty({ offline: true, error: e.message });
    }
    throw e;
  }

  // 2. INGEST host changes locally (echo-guarded in the engine).
  const ingest = await invoke<IngestReport>("sync_ingest", { changes: pulled.changes });

  // 3. Persist the PULL cursor only after ingest commits. A crash before this
  //    just re-pulls + re-ingests (idempotent by sync_uuid).
  await invokeLocal("set_app_setting", { key: CURSOR_KEY, value: pulled.cursor });

  // 4. COLLECT the replica's pending changes (incl. ingest auto-merges left dirty).
  const pending = await invoke<IncomingChange[]>("sync_collect");

  // 5. PUSH to the host.
  let push: PushResponse = { id_remap: {}, conflicts: [], applied: [], rejected: [], cursor: "" };
  if (pending.length > 0) {
    push = await daemonFetch<PushResponse>("/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes: pending }),
    });
  }

  // 6. ACK confirmed rows (compare-and-clear) + persist host-reported conflicts.
  const appliedSet = new Set(push.applied);
  const acked = pending
    .filter((c) => appliedSet.has(c.sync_uuid))
    .map((c) => ({
      entity: c.entity,
      sync_uuid: c.sync_uuid,
      op: c.op ?? "upsert",
      pushed_updated_at: (c.data?.updated_at as string | undefined) ?? null,
    }));
  await invoke("sync_ack", { acked, conflicts: push.conflicts });

  // Mark "last synced at" with the host's pull-cursor (avoids a skewed local clock).
  await invokeLocal("set_app_setting", { key: LAST_SYNC_KEY, value: pulled.cursor });

  return {
    ran: true,
    offline: false,
    pulled: pulled.changes.length,
    applied: ingest.applied.length,
    pushed: acked.length,
    conflicts: ingest.conflicts.length + push.conflicts.length,
    rejected: ingest.rejected.length + push.rejected.length,
  };
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
  if (!isTauri()) return [];
  return invoke<SyncConflict[]>("get_sync_conflicts");
}

/** Apply the user's chosen field values for a conflict; it re-syncs next run. */
export async function resolveSyncConflict(
  syncUuid: string,
  resolved: Record<string, unknown>
): Promise<void> {
  await invoke("resolve_sync_conflict", { syncUuid, resolved });
}

export async function syncStatus(): Promise<SyncStatus> {
  if (!isTauri()) return { dirty_count: 0, tombstone_count: 0, conflict_count: 0 };
  return invoke<SyncStatus>("sync_status");
}

export async function lastSyncedAt(): Promise<string | null> {
  if (!isTauri()) return null;
  return invokeLocal<string | null>("get_app_setting", { key: LAST_SYNC_KEY });
}
