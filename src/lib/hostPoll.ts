import { useEffect, useState } from 'react';
import { DaemonError, getHostStats, hasDaemon, listActiveOracleRuns, type HostStats } from './daemon';

/**
 * Shared, polite polling for the host's live state. Each piece of state is
 * fetched by ONE poller no matter how many components show it (the header
 * chip and the Bridge used to poll the same endpoints side by side), at the
 * fastest rate any visible subscriber asked for:
 *
 * - paused while the window is hidden (and caught up when it shows again);
 * - after an owner-only refusal (401/403 — a member's client) it stops for
 *   10 minutes instead of retrying every few seconds forever;
 * - `adapt` lets a poller speed up only while something is happening
 *   (active runs: 20 s idle → 2.5 s while a run is live).
 */
class SharedPoll<T> {
  private subs = new Map<number, { ms: number; cb: (v: T) => void }>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: T | undefined;
  private lastAt = 0;
  private deniedUntil = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private fetcher: () => Promise<T>,
    private adapt?: (last: T | undefined, ms: number) => number
  ) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.clear();
        else this.schedule();
      });
    }
  }

  subscribe(ms: number, cb: (v: T) => void): () => void {
    const id = ++this.seq;
    this.subs.set(id, { ms, cb });
    if (this.last !== undefined) cb(this.last);
    this.schedule();
    return () => {
      this.subs.delete(id);
      this.schedule();
    };
  }

  /** Fetch now (e.g. right after starting a run), then resume the cadence. */
  refresh(): Promise<void> {
    return this.tick();
  }

  private interval(): number | null {
    if (this.subs.size === 0 || Date.now() < this.deniedUntil) return null;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
    let ms = Math.min(...[...this.subs.values()].map((s) => s.ms));
    if (this.adapt) ms = this.adapt(this.last, ms);
    return ms;
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clear();
    const ms = this.interval();
    if (ms == null) {
      // Denied: look again when the back-off ends (if anyone still cares).
      if (this.subs.size && Date.now() < this.deniedUntil) {
        this.timer = setTimeout(() => this.schedule(), this.deniedUntil - Date.now());
      }
      return;
    }
    const due = Math.max(0, ms - (Date.now() - this.lastAt));
    this.timer = setTimeout(() => void this.tick(), due);
  }

  private tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.clear();
    if (!hasDaemon()) {
      this.schedule();
      return Promise.resolve();
    }
    this.inflight = this.fetcher()
      .then((v) => {
        this.last = v;
        this.lastAt = Date.now();
        for (const s of this.subs.values()) s.cb(v);
      })
      .catch((e) => {
        this.lastAt = Date.now(); // a failure waits a full interval too
        if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) {
          this.deniedUntil = Date.now() + 10 * 60_000;
        }
      })
      .finally(() => {
        this.inflight = null;
        this.schedule();
      });
    return this.inflight;
  }
}

export type ActiveRuns = Awaited<ReturnType<typeof listActiveOracleRuns>>;

const activeRuns = new SharedPoll<ActiveRuns>(listActiveOracleRuns, (last, ms) =>
  last && Object.keys(last).length > 0 ? Math.min(ms, 2500) : ms
);

/** The host's in-flight agent runs. `ms` = how fresh you need it while idle;
 * any live run speeds everyone up to 2.5 s until it ends. */
export function useActiveRuns(ms: number, onUpdate?: (runs: ActiveRuns) => void): ActiveRuns {
  const [runs, setRuns] = useState<ActiveRuns>({});
  useEffect(
    () =>
      activeRuns.subscribe(ms, (r) => {
        setRuns(r);
        onUpdate?.(r);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ms]
  );
  return runs;
}

/** Look now — call right after starting or cancelling a run. */
export const refreshActiveRuns = () => activeRuns.refresh();

// The live tiles only need `now` + counters; the 8-hour series is fetched
// separately, rarely (see useHostHistory).
const hostNow = new SharedPoll<HostStats>(() => getHostStats({ history: false }));

/** Live host vitals + traffic (owner-only; quietly absent for members). */
export function useHostStats(ms: number): HostStats | null {
  const [stats, setStats] = useState<HostStats | null>(null);
  useEffect(() => hostNow.subscribe(ms, setStats), [ms]);
  return stats;
}

const hostHistory = new SharedPoll<HostStats>(() => getHostStats({ history: true }));

/** The 8-hour series behind the charts — sampled every 30 s on the host, so
 * once a minute is plenty. */
export function useHostHistory(): HostStats['history'] {
  const [h, setH] = useState<HostStats['history']>([]);
  useEffect(() => hostHistory.subscribe(60_000, (s) => setH(s.history)), []);
  return h;
}
