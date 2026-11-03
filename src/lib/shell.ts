// WHICH SHELL, and WHAT CAN IT DO — two separate questions that used to be
// answered by one boolean ("are we in Tauri?"), which is why a browser on a
// 32-inch monitor got the phone UI.
//
//  · SHELL is about the INPUT DEVICE and the VIEWPORT: a touch screen wants
//    MobileApp, a mouse and a wide window want the full App. The runtime has
//    nothing to do with it — every command already routes over HTTP for web
//    clients (api.ts::useHttpTransport), so the full App works in a browser.
//  · CAPABILITY is about the RUNTIME: only the installed app can open native
//    file dialogs, resolve filesystem paths, run engines, or own a local DB.
//
// Keeping them apart is what lets a member open the real Ganban in a tab.

import { isMobilePlatform, isTauri } from './daemon';

export type Shell = 'desktop' | 'touch';

const SHELL_KEY = 'ganban:shell'; // 'desktop' | 'touch' — user override

/** The user's explicit shell choice, if they made one. */
export function shellOverride(): Shell | null {
  try {
    const v = localStorage.getItem(SHELL_KEY);
    return v === 'desktop' || v === 'touch' ? v : null;
  } catch {
    return null;
  }
}

/** Pin the shell (or clear the pin with null). Takes effect on reload — the
 * choice is deliberately not live, so a stray window resize can't swap the
 * whole UI mid-task. */
export function setShellOverride(shell: Shell | null): void {
  try {
    if (shell) localStorage.setItem(SHELL_KEY, shell);
    else localStorage.removeItem(SHELL_KEY);
  } catch {
    /* private mode — the default heuristic still applies */
  }
}

/** Narrow enough that the desktop shell's sidebar + panes can't breathe. */
const MIN_DESKTOP_WIDTH = 760;

/**
 * Which shell to boot. Evaluated ONCE at startup (main.tsx) — never reactive.
 *
 * Order: explicit override → native mobile app → coarse pointer / narrow
 * viewport → desktop. `?shell=desktop` on a phone is honoured (and is the
 * escape hatch for a tablet user who wants the real thing).
 */
export function preferredShell(): Shell {
  try {
    const param = new URLSearchParams(window.location.search).get('shell');
    if (param === 'desktop' || param === 'touch') return param;
  } catch {
    /* no window/search — fall through */
  }
  const pinned = shellOverride();
  if (pinned) return pinned;

  // The native mobile app ships the touch UI, full stop.
  if (isMobilePlatform()) return 'touch';

  // A browser: decide by how it's being pointed at and how much room there is.
  try {
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const narrow = window.innerWidth > 0 && window.innerWidth < MIN_DESKTOP_WIDTH;
    if (coarse || narrow) return 'touch';
  } catch {
    /* matchMedia unavailable — assume a real desktop browser */
  }
  return 'desktop';
}

// --- capability predicates (runtime, not viewport) --------------------------

/**
 * Can this client name files by PATH — native pickers, "open in Finder",
 * linking a folder? Browsers upload and download bytes perfectly well, but a
 * path means nothing to them, so path-shaped features hide instead of
 * pretending.
 */
/** Launched from a Home Screen / installed-app icon rather than a browser tab.
 * On iOS this is a SEPARATE app with its own storage — it does not share the
 * Safari tab's sign-in — so the Join screen leads with how to pair it. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
}

export function hasFilePaths(): boolean {
  return isTauri();
}

/** Where "Show in folder" landed (see file_sync::reveal_local_path). */
export interface RevealResult {
  /** file = revealed with the file selected · folder = not at its saved
   * path, the nearest existing folder opened · none = not on this machine. */
  outcome: 'file' | 'folder' | 'none';
  opened?: string | null;
}

/** Show a saved local path in Finder / Explorer on THIS machine (desktop). */
export async function revealLocalPath(path: string): Promise<RevealResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RevealResult>('reveal_local_path', { path });
}

/**
 * Can this client drive THIS MACHINE — start/stop engines, export the local
 * database, pick a storage root, record a demo, install app updates? A browser
 * member is a guest of someone else's host and owns none of that.
 */
export function hasHostControls(): boolean {
  return isTauri();
}
