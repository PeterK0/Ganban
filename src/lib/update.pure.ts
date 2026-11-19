// Pure, dependency-free update logic (unit-tested in scripts/test-update.mjs):
// a version compare, the desktop updater's state machine, and the host update
// poll's restart grace. The version compare: dotted numeric versions only
// (e.g. "0.5.0"); a leading "v" and any -prerelease/+build suffix are ignored,
// missing trailing parts count as 0 (so "0.5" == "0.5.0").

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function cmpVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- The desktop updater's state machine (src/lib/update.ts drives it) -------
// check → (up to date | available) and, only on the user's "Download and install",
// available → downloading n% → ready → (the user's "Restart to finish"). A check never
// downloads (ADR 0012). A build without an updater key is "unsupported" for good;
// switching the update source starts over ('reset'). The browser and phone never use it.

export type UpdateState =
  | { kind: 'idle' }
  /** `offer`: the offer a re-check started over, kept on show until the answer, and kept if the re-check fails. */
  | { kind: 'checking'; offer?: UpdateOffer }
  | { kind: 'unsupported'; why: string }
  | { kind: 'up-to-date'; checkedAt: number }
  /** The source offers `version`; nothing is downloaded until the user says so. `notes`: its patch notes (markdown). */
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'downloading'; version: string; notes: string | null; received: number; total: number | null }
  | { kind: 'ready'; version: string; notes: string | null }
  | { kind: 'failed'; why: string; version: string | null; notes?: string | null };

export type UpdateOffer = Extract<UpdateState, { kind: 'available' }>;

/** The state as the screen shows it: a re-check over an offer still shows the offer. */
export function shownUpdateState(s: UpdateState): UpdateState {
  return s.kind === 'checking' && s.offer ? s.offer : s;
}

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'checked'; version: string | null; notes?: string | null; canUpdate: boolean; at: number; why?: string }
  /** The user chose "Download and install". */
  | { type: 'download' }
  | { type: 'progress'; received: number; total: number | null }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; why: string }
  /** The device switched its update source: start over, unless a download is under way. */
  | { type: 'reset' };

export const initialUpdateState: UpdateState = { kind: 'idle' };

/** Whether a check may start now: never twice at once, never over a download in
 * flight or a build waiting to restart, never on a build that can't update. An offer
 * may be checked over (a newer version may have come out since). */
export function canStartCheck(s: UpdateState): boolean {
  return s.kind === 'idle' || s.kind === 'up-to-date' || s.kind === 'failed' || s.kind === 'available';
}

/** Whether "Download and install" may start: on an offer, or to retry a failed download. */
export function canStartDownload(s: UpdateState): boolean {
  return s.kind === 'available' || (s.kind === 'failed' && !!s.version);
}

export function updateReducer(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'reset':
      return s.kind === 'downloading' || s.kind === 'checking' || s.kind === 'idle' ? s : initialUpdateState;
    case 'check':
      if (!canStartCheck(s)) return s;
      return s.kind === 'available' ? { kind: 'checking', offer: s } : { kind: 'checking' };
    case 'checked':
      if (s.kind !== 'checking') return s;
      if (!e.canUpdate) return { kind: 'unsupported', why: e.why ?? "This build can't update itself." };
      if (!e.version) return { kind: 'up-to-date', checkedAt: e.at };
      // An offer, never a download: that waits for the user's 'download'.
      return { kind: 'available', version: e.version, notes: e.notes ?? null };
    case 'download':
      if (s.kind === 'available' || (s.kind === 'failed' && s.version)) {
        return { kind: 'downloading', version: s.version as string, notes: s.notes ?? null, received: 0, total: null };
      }
      return s;
    case 'progress':
      if (s.kind !== 'downloading') return s;
      return { ...s, received: e.received, total: e.total };
    case 'downloaded':
      return s.kind === 'downloading' ? { kind: 'ready', version: e.version, notes: s.notes } : s;
    case 'error':
      // A re-check that fails keeps the offer it started over: it was offline, not withdrawn.
      if (s.kind === 'checking') return s.offer ?? { kind: 'failed', why: e.why, version: null };
      if (s.kind === 'downloading') return { kind: 'failed', why: e.why, version: s.version, notes: s.notes };
      // A failed install keeps the downloaded build: the restart can be retried.
      return s;
  }
}

/** Download progress in whole percent, or null while the size is unknown. */
export function downloadPercent(s: UpdateState): number | null {
  if (s.kind !== 'downloading' || !s.total) return null;
  return Math.min(100, Math.floor((s.received / s.total) * 100));
}

/** One line for Settings → Updates. `source` is what the build asks: "the host" or "GitHub". */
export function describeUpdateState(s: UpdateState, source = 'the host'): string {
  switch (s.kind) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return `Checking ${source}…`;
    case 'unsupported':
      return s.why;
    case 'up-to-date':
      return 'Up to date.';
    case 'available':
      return `Ganban ${s.version} is available.`;
    case 'downloading': {
      const pct = downloadPercent(s);
      return `Downloading ${s.version}${pct == null ? '…' : ` ${pct}%`}`;
    }
    case 'ready':
      return `Ganban ${s.version} is downloaded. Restart to finish.`;
    case 'failed':
      return `Update failed${s.version ? ` (${s.version})` : ''}: ${s.why}`;
  }
}

// ---- The driver: checks and downloads, over injected I/O ---------------------
// src/lib/update.ts wires it to Tauri; scripts/test-update.mjs to fakes, to prove that a
// check alone never downloads.

/** What a check found (`update_check`). */
export interface CheckFound {
  canUpdate: boolean;
  version: string | null;
  notes: string | null;
  reason: string | null;
}

export interface UpdaterIO {
  /** Whether to check at all now (GitHub with its switch off: no request, no state change). */
  mayCheck(): boolean;
  /** Ask the device's source. Throws with the reason a check failed. */
  check(): Promise<CheckFound>;
  /** Download what the last check found; resolves to its version. Throws with the reason. */
  download(onProgress: (received: number, total: number | null) => void): Promise<string>;
}

export interface UpdateStore {
  get(): UpdateState;
  dispatch(e: UpdateEvent): void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createUpdateFlow(io: UpdaterIO, store: UpdateStore) {
  /** Check the source. A newer version becomes an offer ('available'); nothing downloads. */
  async function check(): Promise<void> {
    if (!canStartCheck(store.get()) || !io.mayCheck()) return;
    store.dispatch({ type: 'check' });
    let found: CheckFound;
    try {
      found = await io.check();
    } catch (e) {
      store.dispatch({ type: 'error', why: reason(e) });
      return;
    }
    store.dispatch({ type: 'checked', version: found.version, notes: found.notes, canUpdate: found.canUpdate, at: Date.now(), why: found.reason ?? undefined });
  }

  /** The user's "Download and install": the only way a download starts. */
  async function download(): Promise<void> {
    if (!canStartDownload(store.get())) return;
    store.dispatch({ type: 'download' });
    try {
      const version = await io.download((received, total) => store.dispatch({ type: 'progress', received, total }));
      store.dispatch({ type: 'downloaded', version });
    } catch (e) {
      store.dispatch({ type: 'error', why: reason(e) });
    }
  }

  return { check, download };
}

/** What the user said about an offer: "Later" (until the next launch, kept in memory) and
 * "Skip this version" (kept on the device). */
export interface OfferAnswers {
  later: string | null;
  skipped: string | null;
}

/** Whether the top bar shows the update: an offer the user hasn't put off or skipped, and
 * everything after "Download and install" (its progress, "Restart to finish", a failure).
 * Settings → Updates shows the state whatever the answers. */
export function offerNoticeVisible(state: UpdateState, a: OfferAnswers): boolean {
  const s = shownUpdateState(state);
  if (s.kind === 'available') return s.version !== a.later && s.version !== a.skipped;
  if (s.kind === 'failed') return !!s.version && s.version !== a.later && s.version !== a.skipped;
  return s.kind === 'downloading' || s.kind === 'ready';
}

// ---- The host update's live log (Settings → Updates, owner only) -------------
// Polling keeps going through the host's own restart: a connection error counts
// as "restarting…" for up to RESTART_GRACE_MS, then it's a failure.

export const HOST_POLL_MS = 2000;
export const RESTART_GRACE_MS = 3 * 60_000;

export type HostPoll =
  | { kind: 'ok' }
  | { kind: 'restarting'; since: number }
  | { kind: 'lost'; since: number };

/** Fold one poll result into the poll's connection state. */
export function nextHostPoll(prev: HostPoll, ok: boolean, now: number): HostPoll {
  if (ok) return { kind: 'ok' };
  const since = prev.kind === 'ok' ? now : prev.since;
  return now - since > RESTART_GRACE_MS ? { kind: 'lost', since } : { kind: 'restarting', since };
}

/** Whether to keep polling: while the update runs, or the host is restarting. */
export function keepPolling(state: string | null, poll: HostPoll): boolean {
  if (poll.kind === 'lost') return false;
  if (poll.kind === 'restarting') return true;
  return state === 'running';
}

/** The client apps a host's update builds, from its `clientBuilds` setting
 * (`GANBAN_CLIENT_BUILDS`): none for 'none'; both when the host doesn't say (an
 * older host, or one whose install.env can't be read). */
export function hostClientApps(clientBuilds: string | null | undefined): Array<'desktop' | 'android'> {
  if (clientBuilds == null) return ['desktop', 'android'];
  const parts = clientBuilds.split(',').map((p) => p.trim());
  return (['desktop', 'android'] as const).filter((k) => parts.includes(k));
}

/** What "Desktop app built X" on the "Update the server" card means for this device. The host builds
 * the desktop app as an update bundle, so only a desktop app that updates from this server picks it up.
 * Null when there's nothing to say (not a desktop app, no build yet). `offerSwitch`: show the button that
 * switches "Updates from" to This server. */
export function hostDesktopBuildNote(o: {
  desktop: boolean;
  source: 'github' | 'host' | null;
  /** This app's version. */
  version: string;
  /** The card's desktop line, e.g. "built 1.0.1229". */
  line: string | null | undefined;
  /** This app has downloaded an update and waits for its restart. */
  ready: boolean;
}): { text: string; offerSwitch: boolean } | null {
  const built = /^built (\S+)/.exec(o.line ?? '')?.[1];
  if (!o.desktop || !built || !o.source) return null;
  if (o.source === 'github') {
    return { text: "This app updates from GitHub Releases, so it won't pick this build up.", offerSwitch: true };
  }
  if (o.version === built) return { text: 'This app runs this build.', offerSwitch: false };
  if (o.ready) return { text: 'This app has downloaded an update: restart it to finish (This app, above).', offerSwitch: false };
  return { text: 'This app updates from this server and offers this build at its next check.', offerSwitch: false };
}

// ---- The update channel (ADR 0008) -------------------------------------------
// Fixed at build time: `host` (the host's ops/build-clients.sh), `github` (the
// release workflow, with the repo it builds from) or none (dev builds). A build
// only ever asks its own channel; the Rust side (src-tauri/src/app_update.rs)
// reads the same two variables and holds only that channel's key.

export type UpdateChannel =
  | { kind: 'host' }
  | { kind: 'github'; repo: string }
  /** `github` without a usable repo: it can't update, and never falls back to the host. */
  | { kind: 'github-broken' }
  | { kind: 'none' };

/** `owner/name` with GitHub's characters only, so it can't steer a URL elsewhere. */
export function validRepo(repo: string): boolean {
  const parts = repo.split('/');
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== '.' && p !== '..');
}

/** The channel from the build's `VITE_UPDATE_CHANNEL` and `VITE_UPDATE_REPO`. */
export function parseUpdateChannel(channel: string | undefined, repo: string | undefined): UpdateChannel {
  const c = (channel ?? '').trim();
  if (c === 'host') return { kind: 'host' };
  if (c !== 'github') return { kind: 'none' };
  const r = (repo ?? '').trim();
  return validRepo(r) ? { kind: 'github', repo: r } : { kind: 'github-broken' };
}

/** Whether the build is on the GitHub channel, usable or not: it never asks the host. */
export function isGithubBuild(channel: UpdateChannel): boolean {
  return channel.kind === 'github' || channel.kind === 'github-broken';
}

export const GITHUB_BROKEN = "This build can't update itself: it was built without its GitHub repository.";

/** What the desktop updater asks on the GitHub channel (the Rust side builds the same URL). */
export function githubLatestJsonUrl(repo: string): string {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}

/** What the phone asks on the GitHub channel: the latest release, unauthenticated. */
export function githubLatestReleaseApi(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** Whether this device may contact GitHub now: only on a `github` build, and only
 * while the "Check GitHub for new versions" switch is on (it is by default). */
export function mayAskGithub(channel: UpdateChannel, switchOn: boolean): channel is { kind: 'github'; repo: string } {
  return channel.kind === 'github' && switchOn;
}
