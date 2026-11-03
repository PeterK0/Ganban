// Save what's open before the app restarts into an update. A restart kills every
// window at once, with no React unmount, so the task editor's save-on-close never
// runs: editors register their save here instead, and "Restart" asks every window
// to run its saves and waits for them (briefly) before relaunching.
import { isTauri } from './daemon';

/** A save that rejects when it fails. */
type Flush = () => Promise<void>;
const flushes = new Set<Flush>();

/** Register a save to run before an update restart. Returns the unregister. */
export function onBeforeRestart(fn: Flush): () => void {
  flushes.add(fn);
  return () => flushes.delete(fn);
}

/** Run this window's saves; resolves to how many failed. */
async function runLocal(): Promise<number> {
  const results = await Promise.allSettled([...flushes].map((f) => f()));
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
