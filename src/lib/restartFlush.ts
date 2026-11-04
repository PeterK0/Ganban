// Save what's open when a window goes away without a React unmount: the app
// restarting into an update, a reload, a closed browser tab or desktop window.
// Editors register their save here (onBeforeRestart). "Restart" asks every
// window to run its saves and waits for them (briefly) before relaunching; a
// page going away runs them itself (installUnloadFlush).
import { isTauri, setUnloading } from './daemon';

/** A save that rejects when it fails. */
type Flush = () => Promise<void>;
const flushes = new Set<Flush>();

/** Register a save to run before an update restart. Returns the unregister. */
export function onBeforeRestart(fn: Flush): () => void {
  flushes.add(fn);
  return () => flushes.delete(fn);
}

/** How long a desktop window's close waits for its saves. */
const CLOSE_WAIT_MS = 3000;

/** Save open editors when this window goes away (call once per window, at boot),
 * silently, with no "unsaved changes" prompt:
 * - a browser tab reloading or closing (`pagehide`): the saves go out as
 *   keepalive requests, which the browser finishes after the page is gone;
 * - a desktop window closing: the close waits for the saves, at most
 *   CLOSE_WAIT_MS, then goes ahead. */
let unloadInstalled = false;
export async function installUnloadFlush(): Promise<void> {
  if (unloadInstalled) return;
  unloadInstalled = true;
  window.addEventListener('pagehide', () => {
    setUnloading(true);
    void runLocal();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setUnloading(false); // back from the back-forward cache
  });
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // The window closes once this resolves (the API destroys it then), so it
    // must always resolve: a throw here would leave the window open.
    await getCurrentWindow().onCloseRequested(async () => {
      try {
        await Promise.race([runLocal(), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
      } catch {
        /* close anyway */
      }
    });
  } catch {
    /* no window API: pagehide still runs the saves */
  }
}

/** Run this window's saves; resolves to how many failed. */
async function runLocal(): Promise<number> {
  // Called right away (on pagehide the requests must leave now); one that
  // throws synchronously counts as failed instead of stopping the rest.
  const start = (f: Flush): Promise<void> => {
    try {
      return f();
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const results = await Promise.allSettled([...flushes].map(start));
  return results.filter((r) => r.status === 'rejected').length;
}

const ASK = 'ganban:restart-flush';
const DONE = 'ganban:restart-flushed';
const WAIT_MS = 4000;

/** Every window answers the restart's call to save (call once per window, at boot). */
export async function installRestartFlushListener(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listen, emit } = await import('@tauri-apps/api/event');
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const me = getCurrentWebviewWindow().label;
    await listen<{ id: string; from: string }>(ASK, async (e) => {
      if (e.payload.from === me) return;
      const failed = await runLocal();
      await emit(DONE, { id: e.payload.id, label: me, failed });
    });
  } catch {
    /* no event API (a browser) — local saves still run */
  }
}

/** Run this window's saves, ask the other windows to run theirs, and wait until
 * they've all answered or WAIT_MS passes. Resolves to how many saves failed. */
export async function flushBeforeRestart(): Promise<number> {
  const local = runLocal();
  if (!isTauri()) return local;
  let failedElsewhere = 0;
  try {
    const { listen, emit } = await import('@tauri-apps/api/event');
    const { getAllWebviewWindows, getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const me = getCurrentWebviewWindow().label;
    const others = (await getAllWebviewWindows()).map((w) => w.label).filter((l) => l !== me);
    const id = `${me}-${Date.now()}`;
    const waiting = new Set(others);
    if (waiting.size) {
      let allIn = () => {};
      const answered = new Promise<void>((resolve) => (allIn = resolve));
      // Listen before asking, so no answer is missed.
      const unlisten = await listen<{ id: string; label: string; failed: number }>(DONE, (e) => {
        if (e.payload.id !== id) return;
        waiting.delete(e.payload.label);
        failedElsewhere += e.payload.failed || 0;
        if (!waiting.size) allIn();
      });
      try {
        await emit(ASK, { id, from: me });
        await Promise.race([answered, new Promise((r) => setTimeout(r, WAIT_MS))]);
      } finally {
        unlisten();
      }
    }
  } catch {
    /* fall through: at least this window saved */
  }
  return (await local) + failedElsewhere;
}
