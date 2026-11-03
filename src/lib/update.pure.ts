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
// check → (up to date | downloading n% → ready | failed). A build without the
// updater key is "unsupported" for good. The browser and phone never use it.

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unsupported'; why: string }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'downloading'; version: string; received: number; total: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; why: string; version: string | null };

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'checked'; version: string | null; canUpdate: boolean; at: number; why?: string }
  | { type: 'progress'; received: number; total: number | null }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; why: string };

export const initialUpdateState: UpdateState = { kind: 'idle' };

/** Whether a check may start now: never twice at once, never over a download in
 * flight or a build waiting to restart, never on a build that can't update. */
export function canStartCheck(s: UpdateState): boolean {
  return s.kind === 'idle' || s.kind === 'up-to-date' || s.kind === 'failed';
}

export function updateReducer(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'check':
      return canStartCheck(s) ? { kind: 'checking' } : s;
    case 'checked':
      if (s.kind !== 'checking') return s;
      if (!e.canUpdate) return { kind: 'unsupported', why: e.why ?? "This build can't update itself." };
      if (!e.version) return { kind: 'up-to-date', checkedAt: e.at };
      return { kind: 'downloading', version: e.version, received: 0, total: null };
    case 'progress':
      if (s.kind !== 'downloading') return s;
      return { ...s, received: e.received, total: e.total };
    case 'downloaded':
      return s.kind === 'downloading' ? { kind: 'ready', version: e.version } : s;
    case 'error':
      if (s.kind === 'checking') return { kind: 'failed', why: e.why, version: null };
      if (s.kind === 'downloading') return { kind: 'failed', why: e.why, version: s.version };
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
    case 'downloading': {
      const pct = downloadPercent(s);
      return `Downloading ${s.version}${pct == null ? '…' : ` ${pct}%`}`;
    }
    case 'ready':
      return `${s.version} is ready. Restart to update.`;
    case 'failed':
      return `Update failed${s.version ? ` (${s.version})` : ''}: ${s.why}`;
  }
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
