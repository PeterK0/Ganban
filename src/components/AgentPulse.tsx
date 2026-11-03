import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listOracleWorkflows,
  runOracleWorkflow,
  cancelOracleRun,
  hasDaemon,
  type OracleWorkflow,
} from '../lib/daemon';
import { refreshActiveRuns, useActiveRuns, useHostStats } from '../lib/hostPoll';
import { notify, updateNotif } from '../store/notifications';

/**
 * The Bridge dropdown — ONE popover for the whole bridge section of the hot
 * bar (unified 2026-07-26; two side-by-side popovers was counterintuitive).
 * Trigger: the ring strip (one ring per automation) + the host vitals dot.
 * Dropdown: automation TILES (click = run / stop) on the left, host vitals
 * on the right, "Go to the Bridge" across the bottom — per the user's sketch.
 * The Bridge tab remains the full deck; this is the wheelhouse repeater.
 */

function fmtBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Minimal chip glyph for the vitals rows (the sketch's icon). */
function Chip({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={`w-3 h-3 ${className}`}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <rect x="10" y="10" width="4" height="4" rx="0.5" />
      <path d="M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3" />
    </svg>
  );
}

/** `compact` hides the vitals' numbers in the trigger (the top bar is short of
 * room); the status diamond and the popover stay. */
export default function AgentPulse({ onOpenBridge, compact = false }: { onOpenBridge?: () => void; compact?: boolean }) {
  const [workflows, setWorkflows] = useState<OracleWorkflow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Shared pollers (lib/hostPoll): one request stream however many views
  // show the same state; idle = slow, a live run = fast, hidden = paused.
  const runs = useActiveRuns(20_000);
  const stats = useHostStats(15_000);
  const activeIds = useMemo(() => new Set(Object.keys(runs).map(Number)), [runs]);

  useEffect(() => {
    if (!hasDaemon()) return;
    let stop = false;
    const loadWfs = async () => {
      try {
        const r = await listOracleWorkflows();
        if (!stop) setWorkflows(r.workflows);
        return true;
      } catch {
        return false; // not owner / host not up yet
      }
    };
    // Startup race: the app often launches before the host — retry a few
    // times quickly, then settle into the slow refresh.
    let tries = 0;
    const boot = async () => {
      if (!(await loadWfs()) && ++tries < 6 && !stop) setTimeout(() => void boot(), 5000);
    };
    void boot();
    const iv = setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadWfs();
    }, 60000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const fire = (w: OracleWorkflow) => {
    const nid = notify({ kind: 'progress', category: 'system', title: `Running “${w.name}”…` });
    setBusy(w.id);
    const run = runOracleWorkflow(w.id);
    setTimeout(() => void refreshActiveRuns(), 400); // show it as running right away
    run
      .then((res) => {
        if (res.status === 'aborted') return updateNotif(nid, { kind: 'info', title: `“${w.name}” aborted` });
        const failed = Object.values(res.nodes).filter((n) => n.status === 'failed').length;
        // 'partial' = the run DELIVERED despite failed nodes — not a failure.
        updateNotif(nid, {
          kind: res.status === 'failed' ? 'error' : res.status === 'partial' ? 'info' : 'success',
          title:
            res.status === 'partial'
              ? `“${w.name}” completed with ${failed} error${failed === 1 ? '' : 's'}`
              : res.status === 'failed'
                ? `“${w.name}” failed`
                : `“${w.name}” completed`,
        });
      })
      .catch((e) => updateNotif(nid, { kind: 'error', title: `“${w.name}” failed`, body: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        setBusy((b) => (b === w.id ? null : b));
        void refreshActiveRuns();
      });
  };

  if (workflows.length === 0 && !stats) return null;

  const ringColor = (w: OracleWorkflow) =>
    activeIds.has(w.id) ? 'border-primary animate-pulse' : w.status === 'live' ? 'border-success' : 'border-overlay-0';

  // Host condition rollup for the trigger dot + Status row.
  const memPct = stats && stats.now.mem_total > 0 ? (stats.now.mem_used / stats.now.mem_total) * 100 : 0;
  const lowDisk = stats != null && stats.now.disk_free < 10 * 1024 ** 3;
  const gpu = stats?.now.gpu_pct ?? null;
  const red = stats != null && (stats.now.cpu_pct > 85 || (gpu ?? 0) > 90 || memPct > 90 || lowDisk);
  const amber = stats != null && !red && (stats.now.cpu_pct > 60 || (gpu ?? 0) > 70 || memPct > 75 || stats.requests.slow_1s > 20);
  const hostDot = red ? 'bg-error' : amber ? 'bg-warning' : 'bg-success';
  const hostText = red ? 'text-error' : amber ? 'text-warning' : 'text-success';
  const hostWord = red ? 'struggling' : amber ? 'busy' : 'ok';

  const vitals: { label: string; value: string; warn?: boolean }[] = stats
    ? [
        { label: 'CPU', value: `${Math.round(stats.now.cpu_pct)}%`, warn: stats.now.cpu_pct > 85 },
        // "—" when the host has no readable GPU — never a fabricated 0.
        { label: 'GPU', value: gpu == null ? '—' : `${Math.round(gpu)}%`, warn: (gpu ?? 0) > 90 },
        { label: 'RAM', value: `${Math.round(memPct)}%`, warn: memPct > 90 },
        { label: 'Disk', value: fmtBytes(stats.now.disk_free), warn: lowDisk },
        { label: 'DB', value: fmtBytes(stats.now.db_bytes) },
        { label: 'Req', value: `${stats.requests.avg_ms}ms`, warn: stats.requests.slow_1s > 20 },
        { label: 'Uptime', value: fmtUptime(stats.uptime_seconds) },
      ]
    : [];

  return (
    <div ref={ref} className="relative shrink-0 flex items-center">
      {/* Trigger: rings per automation + the host vitals dot, one cluster. */}
      {workflows.slice(0, 5).map((w) => (
        <button
          key={w.id}
          onClick={() => setOpen((v) => !v)}
          title={`${w.name} — ${activeIds.has(w.id) ? 'running now' : w.status === 'live' ? 'live (scheduled)' : 'paused'}`}
          aria-label={`${w.name}, automations`}
          aria-expanded={open}
          className="w-8 h-[38px] grid place-items-center rounded hover:bg-surface-0 transition-colors"
        >
          <span className={`w-3.5 h-3.5 rounded-full border-2 ${ringColor(w)}`} />
        </button>
      ))}
      {stats && (
        <button
          onClick={() => setOpen((v) => !v)}
          title={`Host ${hostWord}: CPU ${Math.round(stats.now.cpu_pct)}%${gpu != null ? ` · GPU ${Math.round(gpu)}%` : ''} · RAM ${Math.round(memPct)}%`}
          aria-expanded={open}
          className={`flex items-center gap-1.5 min-h-[38px] px-2 rounded text-xs text-subtext-0 tabular-nums hover:bg-surface-0 hover:text-text transition-colors whitespace-nowrap ${open ? 'bg-surface-0 text-text' : ''}`}
        >
          <span className={`${hostText} ${red ? 'g-pulse' : ''}`} aria-hidden="true">◆</span>
          {!compact && (
            <span>
              CPU {Math.round(stats.now.cpu_pct)}%{gpu != null && ` · GPU ${Math.round(gpu)}%`}
            </span>
          )}
        </button>
      )}

      {open && (
        <div className="g-card g-corners absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-[24rem] shadow-2xl p-4 space-y-3 whitespace-normal">
          <div className="flex gap-3">
            {/* LEFT: automation tiles — click runs (or stops) it. */}
            <div className="flex-1 min-w-0">
              <div className="g-deco text-[11px] font-semibold text-subtext-0 mb-1.5">Automations</div>
              <div className="grid grid-cols-3 gap-1.5">
                {workflows.map((w) => {
                  const running = activeIds.has(w.id);
                  return (
                    <button
                      key={w.id}
                      onClick={() => (running ? void cancelOracleRun(w.id).finally(() => void refreshActiveRuns()) : fire(w))}
                      disabled={busy === w.id}
                      title={`${w.name} — ${running ? 'running · click to stop' : w.status === 'live' ? 'live · click to run now' : 'paused · click to run now'}`}
                      className={`h-14 rounded border p-1 flex flex-col items-center justify-center gap-1 transition-colors disabled:opacity-50 min-w-0 ${
                        running
                          ? 'border-primary/60 bg-primary/10 hover:bg-error/10 hover:border-error/50'
                          : 'border-gilt-b bg-mantle hover:bg-surface-0 hover:border-gilt-a'
                      }`}
                    >
                      <span className={`w-2.5 h-2.5 rounded-full border-2 shrink-0 ${ringColor(w)}`} />
                      <span className="text-[9px] leading-tight text-subtext-1 truncate w-full text-center">{w.name}</span>
                    </button>
                  );
                })}
                {/* the sketch's "+" tile: build a new automation */}
                <button
                  onClick={() => { setOpen(false); onOpenBridge?.(); }}
                  title="Build a new automation (Oracle)"
                  className="h-14 rounded border border-dashed border-gilt-a text-gold hover:bg-gilt-b grid place-items-center text-lg"
                >
                  +
                </button>
              </div>
            </div>

            {/* RIGHT: host vitals (owner-only; absent otherwise). */}
            {stats && (
              <div className="w-32 shrink-0">
                <div className="g-deco text-[11px] font-semibold text-subtext-0 mb-1.5">Host</div>
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${hostDot}`} />
                    <span className="text-subtext-0 flex-1">Status</span>
                    <span className={red ? 'text-error' : amber ? 'text-warning' : 'text-text'}>{hostWord}</span>
                  </div>
                  {vitals.map((v) => (
                    <div key={v.label} className="flex items-center gap-1.5 text-[11px]">
                      <Chip className="text-subtext-0 shrink-0" />
                      <span className="text-subtext-0 flex-1">{v.label}</span>
                      <span className={`tabular-nums ${v.warn ? 'text-error' : 'text-text'}`}>{v.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM: the full deck. */}
          {onOpenBridge && (
            <button
              onClick={() => { setOpen(false); onOpenBridge(); }}
              className="g-btn g-btn-gilt g-btn-sm w-full"
            >
              Go to the Bridge
            </button>
          )}
        </div>
      )}
    </div>
  );
}
