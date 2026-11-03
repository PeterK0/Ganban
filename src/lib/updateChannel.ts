// This build's update channel (ADR 0008) and the device's "Check GitHub for new
// versions" switch. The channel is fixed at build time (VITE_UPDATE_CHANNEL,
// VITE_UPDATE_REPO; see update.pure.ts); the switch shows only on `github`
// builds, is on by default, and off means this device sends GitHub nothing.
import { useSyncExternalStore } from 'react';
import { mayAskGithub, parseUpdateChannel, type UpdateChannel } from './update.pure';

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

/** The GitHub repo to ask now, or null: not a `github` build, or the switch is off. */
export function githubRepoToAsk(): string | null {
  return mayAskGithub(UPDATE_CHANNEL, githubChecksOn()) ? UPDATE_CHANNEL.repo : null;
}
