// The desktop app updates itself (ADR 0007, ADR 0008, docs/design/UPDATES.md) from the
// device's update source: This server (the host it's connected to, which builds and signs
// the app) or GitHub Releases. Tauri's updater (driven by the Rust commands in
// src-tauri/src/app_update.rs) checks; a newer version is an offer with its patch notes, and
// only the user's "Download and install" downloads it (ADR 0012). The signature is verified,
// and the app swaps in on "Restart to finish". GitHub is asked only while "Check GitHub for new
// versions" is on; off, this device sends GitHub nothing. This server's updater key is
// pinned on the device the first time, and a different one waits for the user's word.
//
// It checks at launch, every 6 hours, when Settings → Updates opens and when the source
// changes. Only the installed desktop app takes part: the browser UI is served live by the
// host and the phone has its own path (src/lib/apkUpdate.ts).
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
import { githubChecksOn, githubRepoToAsk, pinHostKey, pinnedHostKey, setUpdateSource, updateSource } from './updateChannel';
import { createUpdateFlow, githubLatestReleaseApi, initialUpdateState, updateReducer, type CheckFound, type OfferAnswers, type UpdateEvent, type UpdateState } from './update.pure';
import { decideHostKey, keyFingerprint, type PinDecision, type SourceStatus, type UpdateSource } from './updateSource.pure';

export { describeUpdateState, downloadPercent, offerNoticeVisible, shownUpdateState } from './update.pure';
export type { OfferAnswers, UpdateState } from './update.pure';

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

interface UpdateCheck extends CheckFound {
  current: string;
}

type DownloadEvent = { event: 'progress'; data: { received: number; total: number | null } } | { event: 'finished' };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the Rust side knows about the update sources (`update_sources`). */
export interface UpdateSources {
  enabled: boolean;
  channel: 'host' | 'github';
  repo: string | null;
  githubReason: string | null;
  githubKey: string;
  buildKey: string | null;
}

let sourcesInfo: Promise<UpdateSources | null> | null = null;
export function updateSources(): Promise<UpdateSources | null> {
  if (!isDesktopApp()) return Promise.resolve(null);
  sourcesInfo ??= invoke<UpdateSources>('update_sources').catch(() => null);
  return sourcesInfo;
}

/** This server's key as the device sees it: its pin (else a host build's own key) against
 * what the host advertises. */
export async function hostKeyDecision(advertised: string | null | undefined): Promise<PinDecision> {
  const own = (await updateSources())?.buildKey ?? null;
  return decideHostKey(pinnedHostKey() ?? own, advertised);
}

/** A key change waiting for the user's word (Settings → Updates shows it). */
let keyChange: Extract<PinDecision, { kind: 'changed' }> | null = null;
export function pendingKeyChange() {
  return keyChange;
}

/** Trust the server's new key, then check it. */
export async function trustHostKey(): Promise<void> {
  if (!keyChange) return;
  const was = keyFingerprint(keyChange.was) ?? 'unknown';
  const now = keyFingerprint(keyChange.key) ?? 'unknown';
  const ok = await confirmDialog(
    `This server's update key changed from ${was} to ${now}. Trust the new key only if you changed the server's signing keys yourself. Trust it?`,
  );
  if (!ok) return;
  pinHostKey(keyChange.key);
  keyChange = null;
  dispatch({ type: 'reset' });
  await checkForUpdate();
}

/** Switch where this device updates from, then check there now. */
export async function switchUpdateSource(source: UpdateSource): Promise<void> {
  // A check or download under way belongs to the old source: Settings disables the choice meanwhile.
  if (state.kind === 'checking' || state.kind === 'downloading') return;
  setUpdateSource(source);
  keyChange = null;
  dispatch({ type: 'reset' });
  await checkForUpdate();
}

/** The checks and the download, over Tauri (the pure driver: update.pure.ts). */
const flow = createUpdateFlow(
  {
    // Off, GitHub gets nothing at all. A dev build has no source: Rust says it can't update itself.
    mayCheck: () => isDesktopApp() && !(updateSource() === 'github' && !githubChecksOn()),
    check: async () => invoke<UpdateCheck>('update_check', await checkArgs()),
    download: async (onProgress) => {
      const onEvent = new Channel<DownloadEvent>();
      onEvent.onmessage = (m) => {
        if (m.event === 'progress') onProgress(m.data.received, m.data.total);
      };
      return invoke<string>('update_download', { onEvent });
    },
  },
  { get: getUpdateState, dispatch },
);

/** What `update_check` needs for the device's source: This server's address, token and
 * pinned key (pinning it the first time), or nothing for GitHub. Throws with the reason
 * the source can't be asked. */
async function checkArgs(): Promise<{ baseUrl: string; token: string | null; source: UpdateSource | null; hostKey: string | null }> {
  const source = updateSource();
  if (source === 'github') return { baseUrl: '', token: null, source, hostKey: null };
  const host = updateHost();
  if (!host) throw new Error('No host to update from. Connect to your host first.');
  // The key the host advertises, against the device's pin.
  let advertised: string | null = null;
  let buildsErr: string | null = null;
  try {
    advertised = (await getClientBuilds()).desktop?.pubkey ?? null;
  } catch (e) {
    buildsErr = why(e);
  }
  const d = await hostKeyDecision(advertised);
  if (d.kind === 'unknown' && buildsErr) throw new Error(`Couldn't ask the server for its build: ${buildsErr}`);
  if (d.kind === 'changed') {
    keyChange = d;
    throw new Error("This server's update key changed. Trust the new key in Settings → Updates before updating from it.");
  }
  if (d.kind === 'first') pinHostKey(d.key);
  return { baseUrl: host.url, token: host.token, source, hostKey: d.kind === 'unknown' ? null : d.key };
}

/** Check the device's update source. A newer version becomes an offer: the top bar's notice
 * and Settings show it, and nothing downloads until the user chooses "Download and install"
 * (ADR 0012). A no-op off the desktop app, while a check or download runs, or once a build
 * is waiting for its restart. */
export function checkForUpdate(): Promise<void> {
  return flow.check();
}

/** The user's "Download and install": download the offered version and verify it. The only
 * caller of `update_download`. */
export function downloadUpdate(): Promise<void> {
  return flow.download();
}

// ---- The user's answers to an offer --------------------------------------------
// "Later" hides the offer until the next launch (memory only); "Skip this version" hides
// it until a newer one comes (stored on the device). Settings → Updates still shows it.

const SKIP_KEY = 'ganban.updates.skip';
let answers: OfferAnswers = { later: null, skipped: readSkipped() };
const answerListeners = new Set<() => void>();

function readSkipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function setAnswers(next: OfferAnswers) {
  answers = next;
  answerListeners.forEach((l) => l());
}

/** "Later": not until the next launch. */
export function putOffUpdate(version: string) {
  setAnswers({ ...answers, later: version });
}

/** "Skip this version": silent until a newer one. */
export function skipUpdate(version: string) {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* private mode: skipped for this run only */
  }
  setAnswers({ ...answers, skipped: version });
}

const getAnswers = () => answers;
/** What the user said about offers, live. */
export function useOfferAnswers(): OfferAnswers {
  return useSyncExternalStore(
    (l) => {
      answerListeners.add(l);
      return () => answerListeners.delete(l);
    },
    getAnswers,
    getAnswers,
  );
}

/** GitHub's latest release tag (no token, no cookies), or null. Only while the switch is on. */
export async function githubLatestVersion(): Promise<string | null> {
  const repo = githubRepoToAsk();
  if (!repo) return null;
  const res = await fetch(githubLatestReleaseApi(repo), { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' });
  if (!res.ok) return null;
  const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? '';
  return tag.replace(/^v/i, '') || null;
}

/** Both sources as Settings → Updates shows them. */
export async function desktopSourceStatuses(builds: ClientBuilds | null, buildsErr: string | null): Promise<Record<UpdateSource, SourceStatus & { fingerprint?: string | null }>> {
  const info = await updateSources();
  const githubOn = githubChecksOn();
  const latestGh = info?.repo ? await githubLatestVersion().catch(() => null) : null;
  const chosen = updateSource() === 'github';
  const github: SourceStatus = info?.repo
    ? { available: true, latest: latestGh, why: !chosen ? 'Asked once you choose it.' : githubOn ? null : 'Checking GitHub is off.' }
    : { available: false, latest: null, why: info?.githubReason ?? "This build can't update itself." };
  let host: SourceStatus & { fingerprint?: string | null };
  if (!updateHost()) host = { available: false, latest: null, why: 'Not connected to a server.' };
  else if (buildsErr) host = { available: false, latest: null, why: buildsErr };
  else if (!builds?.desktop) host = { available: false, latest: null, why: builds ? 'The server has no desktop build yet.' : null };
  else {
    const d = await hostKeyDecision(builds.desktop.pubkey);
    const fp = d.kind === 'unknown' ? null : keyFingerprint(d.key);
    const fingerprint = fp && info && d.kind !== 'unknown' && d.key === info.githubKey.trim() ? `${fp} (the GitHub Releases key)` : fp;
    host =
      d.kind === 'unknown'
        ? { available: false, latest: builds.desktop.version, why: "The server doesn't advertise its update key yet (update the server first)." }
        : { available: true, latest: builds.desktop.version, why: d.kind === 'changed' ? "The server's update key changed." : null, fingerprint };
  }
  return { github, host };
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
  /** `pubkey`: the updater key the build is signed for (null on an older host). */
  desktop: { version: string; target: string; arch: string; pubDate: string; size: number; pubkey?: string | null } | null;
  /** `certSha256`: the APK's signing certificate (null on an older host). */
  android: { version: string; versionCode: number; pubDate: string; size: number; sha256: string; certSha256?: string | null } | null;
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

/** What "Update the server" would bring (`preview_host_update`, owner only): the host fetches
 * without pulling. `changelog`: the checkout's and the upstream's CHANGELOG.md, diffed here. */
export interface HostUpdatePreview {
  known: boolean;
  why: string | null;
  behind: number | null;
  changelog: { current: string | null; incoming: string | null } | null;
}
export const previewHostUpdate = () => onUpdateHost<HostUpdatePreview>('preview_host_update', 30000);

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
