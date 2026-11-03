// The desktop app updates itself from its host (ADR 0007, docs/design/UPDATES.md). The
// host builds and signs the app; Tauri's updater (driven by the Rust commands in
// src-tauri/src/app_update.rs) checks, downloads in the background, verifies the
// signature and swaps the app in on "Restart". A build from GitHub Releases asks
// GitHub instead (ADR 0008), unless this device turned "Check GitHub for new
// versions" off; then it sends nothing at all.
//
// It checks at launch, every 6 hours, and when Settings → Updates opens. Only the
// installed desktop app takes part: the browser UI is served live by the host and
// the phone has its own path (src/mobile, lane upd-android).
//
// Also here: the host's client builds (`get_client_builds`) and the owner's
// "Update the server" (`start_host_update` / `get_host_update_status`), all against the
// host this desktop updates from (`updateHost()`).
import { useSyncExternalStore } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri, isMobilePlatform, isWebClient, invokeOnHost, getOnHost, getDeviceToken } from './daemon';
import { confirmDialog } from './confirm';
import { listWorkspaces, getActiveWorkspace } from './workspaces';
import { flushBeforeRestart } from './restartFlush';
import { UPDATE_CHANNEL, githubRepoToAsk } from './updateChannel';
import {
  GITHUB_BROKEN,
  canStartCheck,
  initialUpdateState,
  isGithubBuild,
  updateReducer,
  type UpdateEvent,
  type UpdateState,
} from './update.pure';

export { describeUpdateState, downloadPercent } from './update.pure';
export type { UpdateState } from './update.pure';

const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** The installed desktop app (not the browser UI, not the phone). */
export function isDesktopApp(): boolean {
  return isTauri() && !isWebClient() && !isMobilePlatform();
}

export interface UpdateHost {
  url: string;
  token: string | null;
  label: string;
}

/** The host this client updates from: the active workspace when it's a remote
 * host, else the first remote host it has joined, else this machine's own
 * daemon (the owner on the host's machine). A browser's host is its origin. */
export function updateHost(): UpdateHost | null {
  if (isWebClient()) return { url: window.location.origin, token: getDeviceToken(), label: 'This host' };
  const active = getActiveWorkspace();
  const pick =
    (active.kind === 'remote' && active.url ? active : null) ??
    listWorkspaces().find((w) => w.kind === 'remote' && !!w.url) ??
    (active.url ? active : null);
  return pick?.url ? { url: pick.url, token: pick.token, label: pick.label } : null;
}

// ---- The store ----------------------------------------------------------------

let state: UpdateState = initialUpdateState;
const listeners = new Set<() => void>();

function dispatch(e: UpdateEvent) {
  const next = updateReducer(state, e);
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

export function getUpdateState(): UpdateState {
  return state;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The desktop updater's state, live. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getUpdateState, getUpdateState);
}

interface UpdateCheck {
  canUpdate: boolean;
  current: string;
  version: string | null;
  notes: string | null;
  reason: string | null;
}

type DownloadEvent = { event: 'progress'; data: { received: number; total: number | null } } | { event: 'finished' };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Check the host and, when it has a newer build, download it in the background.
 * A no-op off the desktop app, while a check or download runs, or once a build
 * is waiting for its restart. */
export async function checkForUpdate(): Promise<void> {
  if (!isDesktopApp() || !canStartCheck(state)) return;
  // A GitHub build asks GitHub (the Rust side picks the URL and sends no token),
  // and nothing at all while the switch is off.
  const github = isGithubBuild(UPDATE_CHANNEL);
  if (UPDATE_CHANNEL.kind === 'github-broken') {
    dispatch({ type: 'check' });
    dispatch({ type: 'checked', version: null, canUpdate: false, at: Date.now(), why: GITHUB_BROKEN });
    return;
  }
  if (github && !githubRepoToAsk()) return;
  dispatch({ type: 'check' });
  const host = github ? { url: '', token: null } : updateHost();
  if (!host) {
    dispatch({ type: 'error', why: 'No host to update from. Connect to your host first.' });
    return;
  }
  let found: UpdateCheck;
  try {
    found = await invoke<UpdateCheck>('update_check', { baseUrl: host.url, token: host.token });
  } catch (e) {
    dispatch({ type: 'error', why: why(e) });
    return;
  }
  dispatch({
    type: 'checked',
    version: found.version,
    canUpdate: found.canUpdate,
    at: Date.now(),
    why: found.reason ?? undefined,
  });
  if (!found.canUpdate || !found.version) return;
  try {
    const onEvent = new Channel<DownloadEvent>();
    onEvent.onmessage = (m) => {
      if (m.event === 'progress') dispatch({ type: 'progress', received: m.data.received, total: m.data.total });
    };
    const version = await invoke<string>('update_download', { onEvent });
    dispatch({ type: 'downloaded', version });
  } catch (e) {
    dispatch({ type: 'error', why: why(e) });
  }
}

/** Save what's open, swap the downloaded build in and relaunch. A save that
 * fails asks first. Throws when the owner keeps the app open, or the install
 * fails (the build stays downloaded, so it can be retried). */
export async function restartToUpdate(): Promise<void> {
  const failed = await flushBeforeRestart();
  if (failed > 0) {
    const go = await confirmDialog(
      `${failed === 1 ? 'An open task' : `${failed} open tasks`} couldn't be saved. Restart anyway and lose those edits?`,
    );
    if (!go) throw new Error('Restart cancelled: an open task has unsaved edits.');
  }
  await invoke('update_install_and_restart');
}

let started = false;
/** At launch and every 6 hours, from the main window only. */
export function startUpdateChecks(): () => void {
  if (!isDesktopApp() || started) return () => {};
  started = true;
  const first = setTimeout(() => void checkForUpdate(), 15_000); // let the app settle first
  const every = setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  return () => {
    started = false;
    clearTimeout(first);
    clearInterval(every);
  };
}

/** This app's version ('' off Tauri). */
export async function appVersion(): Promise<string> {
  return isTauri() ? getVersion().catch(() => '') : '';
}

// ---- The host's side ----------------------------------------------------------

export interface ClientBuilds {
  desktop: { version: string; target: string; arch: string; pubDate: string; size: number } | null;
  android: { version: string; versionCode: number; pubDate: string; size: number; sha256: string } | null;
}

export interface HostUpdateStatus {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  step: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  fromBuild: string | null;
  toBuild: string | null;
  clients: { desktop: string | null; android: string | null } | null;
  log: string;
  /** Which clients the host's update builds (`GANBAN_CLIENT_BUILDS` in its install.env):
   * 'none', 'desktop', 'android' or 'desktop,android'. null/absent: unknown (an older host). */
  clientBuilds?: string | null;
  /** Whether the `com.ganban.updater` job is installed (absent on an older host). */
  updaterInstalled?: boolean;
  /** When an update stopped without finishing: what launchd saw of the updater job. */
  launchd?: { lastExitCode: string | null; log: string } | null;
}

function onUpdateHost<T>(command: string, timeoutMs = 8000): Promise<T> {
  const host = updateHost();
  if (!host) return Promise.reject(new Error('No host connected.'));
  return invokeOnHost<T>(host.url, host.token, command, {}, timeoutMs);
}

export const getClientBuilds = () => onUpdateHost<ClientBuilds>('get_client_builds');
export const startHostUpdate = () => onUpdateHost<unknown>('start_host_update', 20000);
export const getHostUpdateStatus = () => onUpdateHost<HostUpdateStatus>('get_host_update_status', 5000);

/** Whether this device owns the update host AND that host can update itself
 * and build the clients (its /health lists 'client-updates'; older hosts don't). */
export async function canUpdateHost(): Promise<boolean> {
  const host = updateHost();
  if (!host) return false;
  try {
    const [me, health] = await Promise.all([
      getOnHost<{ user?: { is_owner?: boolean } }>(host.url, host.token, '/me'),
      getOnHost<{ capabilities?: string[] }>(host.url, host.token, '/health'),
    ]);
    return !!me?.user?.is_owner && !!health?.capabilities?.includes('client-updates');
  } catch {
    return false;
  }
}
