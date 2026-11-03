// Multi-workspace registry (Epoch K / K2 — docs/design/CollaborativeProjects.md).
//
// The desktop app can hold MANY workspaces at once: its embedded local daemon
// ('local') plus N attached remote hosts. This is the data model under the
// merged project view. K2 is DESKTOP-ONLY — mobile and web are single-host
// thin clients (their host is the one they enrolled against / their origin) and
// never touch this registry.
//
// STAGE A keystone: the "active workspace" WRITES THROUGH to the legacy
// connection globals (ganban-daemon-url / ganban-device-token /
// ganban-transport-mode). So the ~90 existing call sites that resolve "which
// host?" from those globals keep working unchanged — switching workspace just
// repoints them. The registry is the durable list; the globals mirror whichever
// workspace is active. Per-workspace concurrent fan-out (Stage C) will use an
// explicit handle instead of the active pointer.

import {
  getDaemonBaseUrl,
  setDaemonBaseUrl,
  getDeviceToken,
  setDeviceToken,
  getTransportMode,
  setTransportMode,
  isTauri,
  isMobilePlatform,
  isWebClient,
} from './daemon';
import { LOCAL_ID, stableRemoteId, planMigration, type Workspace } from './workspaces.pure';

export { LOCAL_ID, planMigration, stableRemoteId };
export type { Workspace };

const REMOTES_KEY = 'ganban-workspaces'; // JSON array of remote Workspace
const ACTIVE_KEY = 'ganban-active-workspace'; // active workspace id
const LOCAL_URL_KEY = 'ganban-local-url'; // remembered loopback URL for 'local'
const MIGRATED_KEY = 'ganban-workspaces-migrated';

/** Multi-workspace only applies to the installed desktop app. */
export function workspacesEnabled(): boolean {
  return isTauri() && !isMobilePlatform() && !isWebClient();
}

function readRemotes(): Workspace[] {
  try {
    const raw = localStorage.getItem(REMOTES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((w): w is Workspace => w && typeof w.id === 'string' && w.kind === 'remote');
  } catch {
    return [];
  }
}

function writeRemotes(remotes: Workspace[]): void {
  localStorage.setItem(REMOTES_KEY, JSON.stringify(remotes));
}

/** The synthesized local workspace (its loopback URL is remembered separately
 * so it survives while a remote workspace owns the active globals). The
 * fallback to the live global only counts when it's actually a loopback
 * address — otherwise activating local would leave a REMOTE url in the global
 * (tokenless off-box pulse leak until loopback discovery heals it). */
function localWorkspace(): Workspace {
  // A browser client is SERVED by its host, so that host is its one workspace
  // — the page origin, not a remembered loopback from some other machine.
  if (isWebClient()) {
    const origin = typeof window !== 'undefined' ? window.location.origin : null;
    return { id: LOCAL_ID, label: 'This host', kind: 'local', url: origin, token: null };
  }
  const remembered = localStorage.getItem(LOCAL_URL_KEY);
  const live = getDaemonBaseUrl();
  const liveLoopback = live && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(live) ? live : null;
  return { id: LOCAL_ID, label: 'This machine', kind: 'local', url: remembered || liveLoopback, token: null };
}

/** All workspaces, local first. */
export function listWorkspaces(): Workspace[] {
  return [localWorkspace(), ...readRemotes()];
}

export function getWorkspace(id: string): Workspace | null {
  return listWorkspaces().find((w) => w.id === id) ?? null;
}

export function getActiveWorkspaceId(): string {
  return localStorage.getItem(ACTIVE_KEY) || LOCAL_ID;
}

export function getActiveWorkspace(): Workspace {
  return getWorkspace(getActiveWorkspaceId()) ?? localWorkspace();
}

/** Repoint the live connection globals at a workspace WITHOUT changing which
 * workspace is persistently "active". Used by setActiveWorkspace (and
 * removeWorkspace's fall-back to local). */
function applyWorkspaceTransport(ws: Workspace): void {
  if (ws.kind === 'remote') {
    setDaemonBaseUrl(ws.url ?? '');
    setDeviceToken(ws.token);
    setTransportMode('online');
  } else if (isWebClient()) {
    // A browser's "local" workspace IS its host (the page origin), and this
    // device's token is its only credential — leave it exactly where it is.
    // Clearing it here (the Tauri-loopback logic below) signed the browser
    // out the moment a project was opened: the next /invoke went out without
    // a bearer, 401'd, and the client dropped the token for good.
    setDaemonBaseUrl(ws.url ?? '');
  } else {
    // Local: data flows through Tauri invoke; the loopback URL still serves the
    // daemon-only surfaces (chat/AI/tabs/SSE). No token — loopback is owner.
    setDaemonBaseUrl(ws.url ?? '');
    setDeviceToken(null);
    setTransportMode('local');
  }
}

/** Point the live connection globals at a workspace AND make it the persistent
 * active workspace. Every existing call site reads those globals, so this is
 * what actually reroutes the app (e.g. on project selection). */
export function setActiveWorkspace(id: string): void {
  const ws = getWorkspace(id) ?? localWorkspace();
  localStorage.setItem(ACTIVE_KEY, ws.id);
  applyWorkspaceTransport(ws);
}

// (runInWorkspace removed in K2 Stage C — all cross-workspace work now uses
// explicit per-host handles via invokeOnHost/workspaceData, so nothing diverts
// the global transport. setActiveWorkspace remains the only intentional repoint,
// driven by selection.)

/** main.tsx feeds the discovered loopback URL here. Kept distinct from the
 * active globals so a remote-active session doesn't forget where local lives. */
export function setLocalUrl(url: string): void {
  localStorage.setItem(LOCAL_URL_KEY, url);
  if (getActiveWorkspaceId() === LOCAL_ID) setDaemonBaseUrl(url);
}

/** Register (or update) a remote workspace. Returns its id. De-dupes by URL. */
export function addRemoteWorkspace(opts: { url: string; token: string; label?: string }): string {
  const url = opts.url.replace(/\/+$/, '');
  const id = stableRemoteId(url);
  const remotes = readRemotes().filter((w) => w.id !== id);
  let label = opts.label?.trim();
  if (!label) {
    try {
      label = new URL(url).hostname;
    } catch {
      label = url;
    }
  }
  remotes.push({ id, label, kind: 'remote', url, token: opts.token });
  writeRemotes(remotes);
  return id;
}

/** Forget a remote workspace. If it was active, fall back to local. */
export function removeWorkspace(id: string): void {
  if (id === LOCAL_ID) return; // local is intrinsic
  writeRemotes(readRemotes().filter((w) => w.id !== id));
  if (getActiveWorkspaceId() === id) setActiveWorkspace(LOCAL_ID);
}

/** Run the one-time migration from the legacy single-connection globals into
 * the registry. Safe to call on every launch (idempotent). Desktop-only. */
export function migrateWorkspaces(): void {
  if (!workspacesEnabled()) return;
  const plan = planMigration({
    migrated: localStorage.getItem(MIGRATED_KEY) === '1',
    transportMode: getTransportMode(),
    daemonUrl: getDaemonBaseUrl(),
    token: getDeviceToken(),
  });
  if (!plan) return;
  if (plan.seedRemote) {
    const id = addRemoteWorkspace(plan.seedRemote);
    localStorage.setItem(ACTIVE_KEY, id);
  } else {
    localStorage.setItem(ACTIVE_KEY, plan.active);
    if (plan.localUrl) localStorage.setItem(LOCAL_URL_KEY, plan.localUrl);
  }
  localStorage.setItem(MIGRATED_KEY, '1');
}
