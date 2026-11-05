// This build's update channel (ADR 0008), the device's update source (GitHub
// Releases or This server, docs/design/UPDATES.md § The update source), the
// desktop's pinned key for This server, and the "Check GitHub for new versions"
// switch. The channel is fixed at build time (VITE_UPDATE_CHANNEL,
// VITE_UPDATE_REPO; see update.pure.ts) and only sets the default source. The
// switch shows while the source is GitHub, is on by default, and off means this
// device sends GitHub nothing.
import { useSyncExternalStore } from 'react';
import { mayAskGithub, parseUpdateChannel, validRepo, type UpdateChannel } from './update.pure';
import { chosenSource, type UpdateSource } from './updateSource.pure';

export const UPDATE_CHANNEL: UpdateChannel = parseUpdateChannel(
  import.meta.env.VITE_UPDATE_CHANNEL as string | undefined,
  import.meta.env.VITE_UPDATE_REPO as string | undefined,
);

// A device setting, like the host address and the device token beside it in
// localStorage: it belongs to this install, not to any host's data.
const GITHUB_KEY = 'ganban.updates.github';
const listeners = new Set<() => void>();

/** The switch: on unless this device turned it off. */
export function githubChecksOn(): boolean {
  try {
    return localStorage.getItem(GITHUB_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setGithubChecksOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(GITHUB_KEY);
    else localStorage.setItem(GITHUB_KEY, 'off');
  } catch {
    /* private mode: the default stays */
  }
  listeners.forEach((l) => l());
}

export function useGithubChecksOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    githubChecksOn,
    githubChecksOn,
  );
}

/** The GitHub repo this build may update from: a `github` build's own, or the one a host
 * build was given (ops/build-clients.sh), or null. */
export const GITHUB_REPO: string | null = (() => {
  if (UPDATE_CHANNEL.kind === 'github') return UPDATE_CHANNEL.repo;
  const r = ((import.meta.env.VITE_UPDATE_REPO as string | undefined) ?? '').trim();
  return validRepo(r) ? r : null;
})();

/** The GitHub repo to ask now, or null: no repo, the device updates from This server (it
 * then never contacts GitHub), or the switch is off. */
export function githubRepoToAsk(): string | null {
  if (!GITHUB_REPO || updateSource() !== 'github') return null;
  return mayAskGithub({ kind: 'github', repo: GITHUB_REPO }, githubChecksOn()) ? GITHUB_REPO : null;
}

// ---- The update source: kept on the device, like the switch ----

const SOURCE_KEY = 'ganban.updates.source';
const HOST_KEY_PIN = 'ganban.updates.hostKey';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the default stays */
  }
  listeners.forEach((l) => l());
}

/** Where this device updates from: its choice, else the build's channel. Null on a dev build. */
export function updateSource(): UpdateSource | null {
  return chosenSource(read(SOURCE_KEY), UPDATE_CHANNEL);
}

export function setUpdateSource(source: UpdateSource): void {
  write(SOURCE_KEY, source);
}

export function useUpdateSource(): UpdateSource | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    updateSource,
    updateSource,
  );
}

/** The desktop's pinned updater key for This server (one pin: a different server's key asks too). */
export function pinnedHostKey(): string | null {
  return read(HOST_KEY_PIN);
}

export function pinHostKey(key: string): void {
  write(HOST_KEY_PIN, key.trim());
}
