import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { notify } from '../store/notifications';

/**
 * The upload manager: every user-initiated upload goes through here, so the
 * app can show ONE place for all of them (the avatar pop-up's Uploads section
 * on desktop, the corner tray on mobile — UploadTray.tsx), cap how many run
 * at once (picking 200 files must not open 200 connections), throttle
 * progress updates (re-rendering on every progress event is its own lag), let
 * the user cancel, and drop ONE summary into the bell when a burst finishes —
 * not one notification per file.
 *
 * Transport-agnostic: callers pass `run`, which does the actual request and
 * reports bytes sent (see daemon.ts uploadBody).
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  sent: number;
  status: UploadStatus;
  /** Where it's going ("Chief Mate Prep", "Atlas · Library"). */
  target?: string;
  /** Lets a view pick out its own uploads (e.g. `project:local:7`). */
  group?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface UploadMeta {
  name: string;
  size: number;
  target?: string;
  group?: string;
  /** Tiny/background uploads (a pasted screenshot): no bar, no bell. */
  quiet?: boolean;
}

export type UploadRun<T> = (ctl: { onProgress: (sent: number) => void; signal: AbortSignal }) => Promise<T>;

interface UploadState {
  items: UploadItem[];
}

export const useUploads = create<UploadState>(() => ({ items: [] }));

const MAX_PARALLEL = 2;
const PROGRESS_FLUSH_MS = 150;

const controllers = new Map<string, AbortController>();
// A failed upload's way to run again (the same file, target and group).
const retries = new Map<string, () => void>();
const queue: { id: string; start: () => void; cancel: () => void }[] = [];
let running = 0;
let seq = 0;

// Progress is buffered and applied to the store in one batch per tick.
const pendingSent = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// What the current burst did (reset when the queue drains).
let burst = { done: 0, bytes: 0, names: [] as string[], targets: new Set<string>(), failed: [] as string[] };

const patch = (id: string, p: Partial<UploadItem>) =>
  useUploads.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

function flushProgress() {
  flushTimer = null;
  if (pendingSent.size === 0) return;
  const updates = new Map(pendingSent);
  pendingSent.clear();
  useUploads.setState((s) => ({
    items: s.items.map((i) => (updates.has(i.id) && i.status === 'uploading' ? { ...i, sent: updates.get(i.id)! } : i)),
  }));
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError';
}

export function abortError(): Error {
  const e = new Error('Upload cancelled');
  e.name = 'AbortError';
  return e;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) queue.shift()!.start();
  if (running === 0 && queue.length === 0) summarize();
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function summarize() {
  const b = burst;
  burst = { done: 0, bytes: 0, names: [], targets: new Set(), failed: [] };
  // A clean finish clears itself (the bell keeps the summary); failures stay
  // listed until the user dismisses them.
  if (clearTimer) clearTimeout(clearTimer);
  if (b.failed.length === 0) {
    clearTimer = setTimeout(() => {
      if (!useUploads.getState().items.some((i) => i.status === 'error')) clearFinishedUploads();
    }, 5000);
  }
  const where = b.targets.size === 1 ? ` to ${[...b.targets][0]}` : '';
  if (b.done > 0) {
    notify({
      kind: 'success',
      category: 'system',
      title: b.done === 1 ? `Uploaded ${b.names[0]}${where}` : `Uploaded ${b.done} files${where}`,
      body: fmtBytes(b.bytes),
    });
  }
  if (b.failed.length > 0) {
    notify({
      kind: 'error',
      category: 'system',
      title: `${b.failed.length} upload${b.failed.length === 1 ? '' : 's'} failed`,
      body: b.failed.slice(0, 5).join('\n') + (b.failed.length > 5 ? `\n…and ${b.failed.length - 5} more` : ''),
    });
  }
}

/** Run an upload under the manager: queued (≤2 at a time), shown in the
 * upload bar, cancellable, summarized in the bell. Resolves/rejects with the
 * upload's own result; a cancel rejects with an AbortError. */
export function trackUpload<T>(meta: UploadMeta, run: UploadRun<T>): Promise<T> {
  if (meta.quiet) return run({ onProgress: () => {}, signal: new AbortController().signal });
  const id = `u${Date.now().toString(36)}_${seq++}`;
  const item: UploadItem = { id, name: meta.name, size: meta.size, sent: 0, status: 'queued', target: meta.target, group: meta.group };
  useUploads.setState((s) => ({ items: [...s.items, item] }));

  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      const ctl = new AbortController();
      controllers.set(id, ctl);
      patch(id, { status: 'uploading', startedAt: Date.now() });
      run({
        signal: ctl.signal,
        onProgress: (sent) => {
          pendingSent.set(id, Math.min(sent, meta.size));
          if (!flushTimer) flushTimer = setTimeout(flushProgress, PROGRESS_FLUSH_MS);
        },
      })
        .then((value) => {
          pendingSent.delete(id);
          patch(id, { status: 'done', sent: meta.size, finishedAt: Date.now() });
          burst.done++;
          burst.bytes += meta.size;
          burst.names.push(meta.name);
          if (meta.target) burst.targets.add(meta.target);
          resolve(value);
        })
        .catch((e) => {
          pendingSent.delete(id);
          if (isAbortError(e) || ctl.signal.aborted) {
            patch(id, { status: 'cancelled', finishedAt: Date.now() });
            reject(abortError());
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            retries.set(id, () => void trackUpload(meta, run).catch(() => {}));
            patch(id, { status: 'error', error: msg, finishedAt: Date.now() });
            burst.failed.push(`${meta.name}: ${msg}`);
            reject(e);
          }
        })
        .finally(() => {
          controllers.delete(id);
          running--;
          pump();
        });
    };
    const cancel = () => {
      patch(id, { status: 'cancelled', finishedAt: Date.now() });
      reject(abortError());
    };
    queue.push({ id, start, cancel });
    pump();
  });
}

/** Cancel one upload — queued (never starts) or in flight (aborted). */
export function cancelUpload(id: string) {
  const qi = queue.findIndex((q) => q.id === id);
  if (qi >= 0) {
    const [q] = queue.splice(qi, 1);
    q.cancel();
    if (running === 0 && queue.length === 0) summarize();
    return;
  }
  controllers.get(id)?.abort();
}

export function cancelAllUploads() {
  for (const q of queue.splice(0)) q.cancel();
  for (const c of controllers.values()) c.abort();
}

/** Drop finished rows (done / cancelled / failed) from the bar. */
export function clearFinishedUploads() {
  useUploads.setState((s) => ({ items: s.items.filter((i) => i.status === 'queued' || i.status === 'uploading') }));
  const live = new Set(useUploads.getState().items.map((i) => i.id));
  for (const id of [...retries.keys()]) if (!live.has(id)) retries.delete(id);
}

/** Run the failed uploads again (one group's, or all): each failed row is
 * replaced by a fresh queued one. Returns how many restarted. */
export function retryFailedUploads(group?: string): number {
  const failed = useUploads
    .getState()
    .items.filter((i) => i.status === 'error' && retries.has(i.id) && (group == null || i.group === group));
  if (failed.length === 0) return 0;
  const ids = new Set(failed.map((i) => i.id));
  useUploads.setState((s) => ({ items: s.items.filter((i) => !ids.has(i.id)) }));
  for (const i of failed) {
    const again = retries.get(i.id)!;
    retries.delete(i.id);
    again();
  }
  return failed.length;
}

/** Whether a failed upload can run again. */
export const canRetry = (i: UploadItem) => i.status === 'error' && retries.has(i.id);

export const isActive = (i: UploadItem) => i.status === 'queued' || i.status === 'uploading';

/** Where a batch of uploads stands, in whole percent. */
export interface UploadSummary {
  /** Queued or uploading. */
  active: number;
  done: number;
  /** Files that are (or will be) on the host: not cancelled or failed. */
  total: number;
  pct: number;
  /** The file uploading now (else the next queued one). */
  name: string | null;
}

export function summarizeUploads(items: UploadItem[]): UploadSummary {
  const counted = items.filter((i) => i.status !== 'cancelled' && i.status !== 'error');
  const running = counted.filter(isActive);
  const size = counted.reduce((n, i) => n + i.size, 0);
  const sent = counted.reduce((n, i) => n + (i.status === 'done' ? i.size : i.sent), 0);
  const current = running.find((i) => i.status === 'uploading') ?? running[0];
  return {
    active: running.length,
    done: counted.filter((i) => i.status === 'done').length,
    total: counted.length,
    pct: size ? Math.floor((sent / size) * 100) : 0,
    name: current?.name ?? null,
  };
}

/** The summary of every upload, or one group's. Re-renders only when a field
 * changes (about a hundred times for a big file), not on every progress tick:
 * re-rendering a whole view several times a second is its own lag. */
export function useUploadSummary(group?: string): UploadSummary {
  return useUploads(useShallow((s) => summarizeUploads(group ? s.items.filter((i) => i.group === group) : s.items)));
}

// Leaving the page mid-upload loses it — say so (web client; harmless in the app).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (useUploads.getState().items.some(isActive)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
