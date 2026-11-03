import { useEffect, useState } from 'react';
import {
  listOracleWorkflows,
  updateOracleWorkflow,
  listOracleRuns,
  listRoutines,
  runRoutine,
  runOracleWorkflow,
  cancelOracleRun,
  DaemonError,
  type OracleWorkflow,
  type RoutineInfo,
} from '../lib/daemon';
import { notify, updateNotif } from '../store/notifications';
import { listRules, updateRule, type Rule } from '../lib/api';
import { nextRunLabel } from '../lib/schedule';
import ScrollArea from './ScrollArea';
import { lazy, Suspense } from 'react';
import { type HostStats } from '../lib/daemon';
import { refreshActiveRuns, useActiveRuns, useHostHistory, useHostStats } from '../lib/hostPoll';

const HostHealthChart = lazy(() => import('./HostHealthChart'));

function fmtBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** A window count as a per-minute rate (1 decimal under 10). */
function perMin(count: number, windowSecs: number): string {
  const r = (count / Math.max(1, windowSecs)) * 60;
  return r < 10 ? r.toFixed(1) : String(Math.round(r));
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Live host load/space/traffic — "is the machine struggling?" answered here
 * instead of a second SSH session. Polls only while Bridge is visible. */
function HostHealth() {
  // Shared pollers: live tiles every 5 s while this is visible, the 8-hour
  // series once a minute (it's sampled every 30 s anyway).
  const live = useHostStats(5000);
  const history = useHostHistory();
  const stats: HostStats | null = live ? { ...live, history } : null;
  if (!stats) return null;
  const memPct = stats.now.mem_total > 0 ? (stats.now.mem_used / stats.now.mem_total) * 100 : 0;
  const gpu = stats.now.gpu_pct ?? null;
  const tiles: { label: string; value: string; warn?: boolean }[] = [
    { label: 'CPU', value: `${Math.round(stats.now.cpu_pct)}%`, warn: stats.now.cpu_pct > 85 },
    { label: 'GPU', value: gpu == null ? '—' : `${Math.round(gpu)}%`, warn: (gpu ?? 0) > 90 },
    { label: 'Memory', value: `${Math.round(memPct)}%`, warn: memPct > 90 },
    { label: 'Disk free', value: fmtBytes(stats.now.disk_free), warn: stats.now.disk_free < 10 * 1024 ** 3 },
    { label: 'Database', value: fmtBytes(stats.now.db_bytes) },
    { label: 'Uptime', value: fmtUptime(stats.uptime_seconds) },
    // A since-boot total only ever grows ("insane number of requests"); the
    // rate is what tells you whether something is hammering the host.
    {
      label: 'Requests',
      value: stats.requests.traffic
        ? `${stats.requests.traffic.per_min}/min`
        : `${stats.requests.count} · ${stats.requests.avg_ms}ms`,
      warn: stats.requests.slow_1s > 20 || (stats.requests.traffic?.per_min ?? 0) > 600,
    },
  ];
  const traffic = stats.requests.traffic;
  return (
    <div className="g-card g-corners px-6 py-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="g-deco text-[13px] font-semibold text-gold">Host health</h2>
        <span className="text-[10px] text-subtext-0">sampled every 30s · kept 7 days</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="g-plain px-2 py-1.5 text-center min-w-0"
            title={
              t.label === 'Requests'
                ? `${stats.requests.count.toLocaleString()} since the host started · avg ${stats.requests.avg_ms} ms${stats.requests.slow_1s ? ` · ${stats.requests.slow_1s} over 1 s` : ''}`
                : undefined
            }
          >
            <div className={`text-sm font-semibold truncate ${t.warn ? 'text-error' : 'text-text'}`}>{t.value}</div>
            <div className="text-[10px] text-subtext-0">{t.label}</div>
          </div>
        ))}
      </div>
      {traffic && traffic.top_calls.length > 0 && (
        <details className="group text-[11px]">
          <summary className="cursor-pointer select-none min-h-8 text-[color:var(--g-mut)] hover:text-text list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform">▸</span>
            Who’s calling — {traffic.window_count.toLocaleString()} requests in the last {Math.round(traffic.window_secs / 60) || 1} min
            · {stats.requests.count.toLocaleString()} since the host started
          </summary>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 mt-2">
            <div>
              <div className="g-deco text-[10px] font-semibold text-gold mb-1">Busiest calls</div>
              {traffic.top_calls.map((c) => (
                <div key={c.key} className="flex justify-between gap-2">
                  <span className="truncate text-text font-mono" title={c.key}>{c.key}</span>
                  <span className="tabular-nums text-subtext-0 shrink-0">{perMin(c.count, traffic.window_secs)}/min</span>
                </div>
              ))}
            </div>
            <div>
              <div className="g-deco text-[10px] font-semibold text-gold mb-1">By device</div>
              {traffic.top_clients.map((c) => (
                <div key={c.key} className="flex justify-between gap-2">
                  <span className="truncate text-text font-mono">{c.key}</span>
                  <span className="tabular-nums text-subtext-0 shrink-0">{perMin(c.count, traffic.window_secs)}/min</span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}
      {stats.history.length > 1 && (
        <Suspense fallback={<div className="h-[140px]" />}>
          <HostHealthChart history={stats.history} />
        </Suspense>
      )}
      {stats.history.length > 1 && (
        <div className="text-[10px] text-subtext-0 -mt-1">
          <span className="text-primary">— CPU</span> · <span className="text-success">— GPU</span> · <span className="text-warning">— memory</span> · last 8 hours
        </div>
      )}
    </div>
  );
}

// The Bridge — where every kind of automation is watched and steered from.
// (The ship's bridge: you don't row from there, you command from there.)
// Three animals, one deck:
//   · Oracle automations (node workflows; schedule triggers on the host clock)
//   · Rules (Settings › Automations; domain events + scheduled notifies)
//   · Routines (the built-in catch-up jobs, e.g. the daily rundown)
// Plus the monitoring feed: recent workflow runs. Editing stays where it
// lives (Oracle canvas, Settings) — the Bridge steers: live/pause, enable/
// disable, run-now, and honest next-run times.

type RunRow = {
  id: number; name: string; status: string; created_at: string; updated_at: string;
  workflow_id?: number | null;
  results?: Record<string, NodeRes> | null;
};
type NodeRes = { status: string; preview?: string; note?: string };

const NODE_STATUS_CHIP: Record<string, string> = {
  done: 'bg-success/15 text-success',
  failed: 'bg-error/15 text-error',
  aborted: 'bg-warning/15 text-warning',
  running: 'bg-primary/15 text-primary animate-pulse',
  skipped: 'bg-surface-0 text-subtext-0',
  frozen: 'bg-info/15 text-info',
};

/** A node's human label for run logs: what it fetches/reads/does. */
function nodeLabel(n: { type: string; params?: Record<string, string> }): string {
  const p = n.params ?? {};
  if (p.url) return p.url.replace(/^https?:\/\//, '');
  if (p.instruction) return p.instruction.slice(0, 60);
  if (p.file_id) return `file #${p.file_id}`;
  return n.type;
}

/** The per-node log block shared by automation cards and Recent-runs rows.
 * Ordered by the workflow's node list when the definition is still around;
 * a deleted workflow's log falls back to the raw entries. */
function NodeLog({ log, def, isLive }: {
  log: Record<string, NodeRes> | null;
  def?: OracleWorkflow['definition'];
  isLive: boolean;
}) {
  if (!log || Object.keys(log).length === 0) {
    return (
      <p className="text-[11px] text-subtext-0 italic px-1">
        {isLive ? 'Starting…' : 'No run log recorded for this run.'}
      </p>
    );
  }
  const entries: { key: string; node?: { type: string; params?: Record<string, string> }; r?: NodeRes }[] = def
    ? def.nodes.map((n) => ({ key: n.id, node: n, r: log[n.id] }))
    : Object.entries(log).map(([key, r]) => ({ key, r }));
  return (
    <div className="space-y-1">
      {entries.map(({ key, node, r }) => {
        if (!r && !isLive) return null;
        const st = r?.status ?? 'queued';
        return (
          <div key={key} className="flex items-start gap-2 px-1 py-0.5">
            <span className={`shrink-0 mt-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${NODE_STATUS_CHIP[st] ?? 'bg-surface-0 text-subtext-0'}`}>
              {st === 'running' ? '● run' : st}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-text truncate">{node ? `${node.type} · ${nodeLabel(node)}` : key}</div>
              {r?.preview && (
                <div className={`text-[11px] break-words ${st === 'failed' ? 'text-error' : 'text-subtext-0'}`} title={r.preview}>
                  {r.preview.slice(0, 300)}
                </div>
              )}
              {r?.note && <div className="text-[10px] text-subtext-0 italic">{r.note}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function scheduleOf(w: OracleWorkflow): string | undefined {
  return w.definition.nodes.find((n) => n.type === 'trigger.schedule')?.params?.every;
}

function ruleSchedule(r: Rule): string | null {
  try {
    const t = JSON.parse(r.trigger_json) as { kind?: string; every?: string };
    return t.kind === 'schedule' ? (t.every ?? '') : null;
  } catch {
    return null;
  }
}

const RUN_CHIP: Record<string, string> = {
  done: 'bg-success/15 text-success',
  running: 'bg-primary/15 text-primary',
  waiting_approval: 'bg-warning/15 text-warning',
  // Finished AND delivered, but some nodes failed — errors worth reading,
  // not a failure (field: "accepted afterwards, still says failed").
  partial: 'bg-warning/15 text-warning',
  failed: 'bg-error/15 text-error',
  interrupted: 'bg-warning/15 text-warning',
};

export default function BridgePanel() {
  const [workflows, setWorkflows] = useState<OracleWorkflow[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [notOwner, setNotOwner] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  // Per-node results streamed while a Bridge-fired run is in flight; the
  // durable last_results from the server take over once it lands.
  const [liveResults, setLiveResults] = useState<Map<number, Record<string, { status: string; preview?: string; note?: string }>>>(new Map());
  // Workflow ids with a run active ON THE SERVER (any client, any trigger).
  const [activeIds, setActiveIds] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const [wf, rs] = await Promise.all([listOracleWorkflows(), listOracleRuns()]);
      setWorkflows(wf.workflows);
      setRuns(rs.runs);
      setNotOwner(false);
    } catch (e) {
      if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) setNotOwner(true);
      else setMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    listRules().then(setRules).catch(() => setRules([]));
    listRoutines().then(setRoutines).catch(() => setRoutines([]));
  };

  useEffect(() => {
    void load();
    // The deck stays current — but not while the window is hidden.
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // Reattach to server-side runs: the live view must not depend on the
  // component instance that fired the run (or on it being fired here at all —
  // scheduled runs show up too). Shared poller (lib/hostPoll): 10 s while
  // nothing runs, 2.5 s the moment something does (and right after you start
  // one here), paused when the window is hidden, one stream with the header
  // chip instead of two.
  useActiveRuns(10_000, (runs) => {
    const ids = new Set(Object.keys(runs).map(Number));
    setActiveIds((prev) => {
      // A run just ENDED → refresh the lists so last_results/last_run land.
      if ([...prev].some((id) => !ids.has(id))) void load();
      return ids;
    });
    setLiveResults((m) => {
      const next = new Map(m);
      for (const [id, snap] of Object.entries(runs)) {
        next.set(Number(id), snap.nodes as Record<string, { status: string; preview?: string; note?: string }>);
      }
      // Drop live entries for runs that are gone (durable log takes over).
      for (const id of [...next.keys()]) {
        if (!ids.has(id)) next.delete(id);
      }
      return next;
    });
  });

  const toggleWorkflow = async (w: OracleWorkflow) => {
    setBusy(`wf-${w.id}`);
    try {
      await updateOracleWorkflow(w.id, { status: w.status === 'live' ? 'paused' : 'live' });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleRule = async (r: Rule) => {
    setBusy(`rule-${r.id}`);
    try {
      await updateRule(r.id, { enabled: !r.enabled });
      setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Run an Oracle automation NOW. The run can take many minutes on local
   * models, so the Bridge doesn't block on it: the bell carries progress and
   * the verdict; the runs feed refreshes when it lands. */
  const fireWorkflow = (w: OracleWorkflow) => {
    const nid = notify({ kind: 'progress', category: 'system', title: `Running “${w.name}”…` });
    setBusy(`run-${w.id}`);
    setExpanded(w.id); // watching the run IS the point
    setLiveResults((m) => new Map(m).set(w.id, {}));
    runOracleWorkflow(w.id, (partial) => {
      setLiveResults((m) => new Map(m).set(w.id, partial.nodes as Record<string, { status: string; preview?: string; note?: string }>));
    })
      .then((res) => {
        if (res.status === 'aborted') {
          updateNotif(nid, { kind: 'info', title: `“${w.name}” aborted` });
          return;
        }
        const failed = Object.values(res.nodes).filter((n) => n.status === 'failed').length;
        updateNotif(nid, {
          kind: res.status === 'failed' ? 'error' : res.status === 'partial' ? 'info' : 'success',
          title: res.status === 'partial'
            ? `“${w.name}” completed with ${failed} error${failed === 1 ? '' : 's'}`
            : failed
            ? `“${w.name}” finished — ${failed} node${failed === 1 ? '' : 's'} failed`
            : `“${w.name}” completed`,
        });
      })
      .catch((e) => updateNotif(nid, { kind: 'error', title: `“${w.name}” failed`, body: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        setBusy((b) => (b === `run-${w.id}` ? null : b));
        void load(); // the active-runs poll retires the live entry itself
        void refreshActiveRuns();
      });
    setTimeout(() => void refreshActiveRuns(), 400); // others see it running right away
  };

  const fireRoutine = async (r: RoutineInfo) => {
    setBusy(`routine-${r.id}`);
    setMsg(`Running “${r.name}”…`);
    try {
      await runRoutine(r.id);
      setMsg(`“${r.name}” ran — see Activity for the ledger row.`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (notOwner) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-subtext-0">The Bridge is the host owner's deck. Ask the owner, or open Ganban on the host machine.</p>
      </div>
    );
  }

  // Upcoming = everything the host's clock will actually fire.
  const upcoming: { key: string; name: string; label: string; kind: string }[] = [
    ...workflows
      .filter((w) => w.status === 'live' && scheduleOf(w) != null)
      .map((w) => ({ key: `wf-${w.id}`, name: w.name, label: nextRunLabel(scheduleOf(w), true, w.last_run_at) ?? '', kind: 'automation' })),
    ...rules
      .filter((r) => r.enabled && ruleSchedule(r) != null)
      .map((r) => ({ key: `rule-${r.id}`, name: r.name, label: nextRunLabel(ruleSchedule(r) ?? '', true, r.last_fired_at ?? null) ?? '', kind: 'rule' })),
  ];

  const section = 'g-h2 !mb-2';

  return (
    <ScrollArea className="h-full">
      <div className="px-8 pt-7 pb-16 grid gap-x-8 gap-y-7 grid-cols-[repeat(auto-fill,minmax(min(100%,40rem),1fr))] items-start">
        <div className="col-span-full">
          <h1 className="g-subtitle text-text">Bridge</h1>
          <p className="mt-2 text-sm text-[color:var(--g-fg2)] leading-relaxed max-w-[72ch]">
            Every automation on this host, watched and steered from one deck: Oracle workflows, rules, and routines. Editing
            stays where it lives (the Oracle canvas, Settings › Automations) — here you see what will fire, flip things
            live/paused, and read the run feed. Writes still cross the approval gate, always.
          </p>
        </div>
        {msg && <p className="col-span-full text-xs text-[color:var(--g-fg2)]">{msg}</p>}

        <div className="col-span-full"><HostHealth /></div>

        {/* Upcoming — the honest answer to “will this actually run?” */}
        <section className="space-y-1.5">
          <h2 className={section}>Upcoming {upcoming.length > 0 && <span className="n">({upcoming.length})</span>}</h2>
          {upcoming.length === 0 ? (
            <p className="text-sm text-subtext-0 italic">Nothing scheduled — go live on an Oracle automation with a Schedule trigger, or add an “on a schedule” rule in Settings › Automations.</p>
          ) : (
            upcoming.map((u) => (
              <div key={u.key} className="g-plain !border-success/25 flex items-center gap-3 min-h-10 px-3 py-2">
                <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                <span className="text-sm text-text truncate">{u.name}</span>
                <span className="g-tag !min-h-[20px] !px-2 !text-[10px] shrink-0">{u.kind}</span>
                <span className="ml-auto text-xs text-success shrink-0">{u.label}</span>
              </div>
            ))
          )}
        </section>

        {/* Oracle automations */}
        <section className="space-y-1.5">
          <h2 className={section}>Automations (Oracle)</h2>
          {workflows.length === 0 ? (
            <p className="text-sm text-subtext-0 italic">None yet — build one in Assistant › Oracle (the template library is a good start).</p>
          ) : (
            workflows.map((w) => {
              const sched = scheduleOf(w);
              return (
                <div key={w.id} className="g-plain px-3 py-2">
                <div className="flex items-center gap-3 cursor-pointer" onClick={() => setExpanded((e) => (e === w.id ? null : w.id))}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${w.status === 'live' ? 'bg-success' : 'bg-overlay-0'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text truncate">{w.name}</div>
                    <div className="text-[11px] text-subtext-0 truncate">
                      {w.definition.nodes.length} nodes
                      {w.last_run_at ? ` · ran ${w.last_run_at.slice(5, 16).replace(' ', ' ')}` : ' · never run'}
                      {sched != null && <span> · ⏱ {nextRunLabel(sched, w.status === 'live', w.last_run_at)}</span>}
                    </div>
                  </div>
                  <span className="text-subtext-0 text-xs shrink-0">{expanded === w.id ? '▾' : '▸'}</span>
                  {busy === `run-${w.id}` || activeIds.has(w.id) ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); void cancelOracleRun(w.id).finally(() => void refreshActiveRuns()); }}
                      title="Abort this run — remaining nodes are skipped, the in-flight model call is cut"
                      className="g-btn g-btn-danger g-btn-sm shrink-0"
                    >
                      ■ Stop
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); fireWorkflow(w); }}
                      title="Execute this automation now (regardless of schedule or live/paused)"
                      className="g-btn g-btn-ghost g-btn-sm shrink-0"
                    >
                      ▶ Run now
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); void toggleWorkflow(w); }}
                    disabled={busy === `wf-${w.id}`}
                    className={`g-btn g-btn-sm g-btn-ghost shrink-0 ${w.status === 'live' ? '!text-success !shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]' : ''}`}
                  >
                    {w.status === 'live' ? '● live' : '⏸ paused'}
                  </button>
                </div>

                {expanded === w.id && (
                  <div className="mt-2 pt-2 border-t border-surface-1">
                    <NodeLog
                      log={liveResults.get(w.id) ?? w.last_results ?? null}
                      def={w.definition}
                      isLive={liveResults.has(w.id) || activeIds.has(w.id)}
                    />
                  </div>
                )}
                </div>
              );
            })
          )}
        </section>

        {/* Rules */}
        <section className="space-y-1.5">
          <h2 className={section}>Rules</h2>
          {rules.length === 0 ? (
            <p className="text-sm text-subtext-0 italic">None yet — create them in Settings › Automations (“when X happens, do Y” — or “on a schedule, notify me”).</p>
          ) : (
            rules.map((r) => (
              <div key={r.id} className="g-plain flex items-center gap-3 px-3 py-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${r.enabled ? 'bg-success' : 'bg-overlay-0'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text truncate">{r.name}</div>
                  <div className="text-[11px] text-subtext-0 truncate">
                    {ruleSchedule(r) != null ? `⏱ ${ruleSchedule(r)}` : 'on domain events'}
                    {r.last_fired_at ? ` · fired ${r.last_fired_at.slice(5, 16)}` : ' · never fired'}
                  </div>
                </div>
                <button
                  onClick={() => void toggleRule(r)}
                  disabled={busy === `rule-${r.id}`}
                  className={`g-btn g-btn-sm g-btn-ghost shrink-0 ${r.enabled ? '!text-success !shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]' : ''}`}
                >
                  {r.enabled ? '● on' : '⏸ off'}
                </button>
              </div>
            ))
          )}
        </section>

        {/* Routines */}
        <section className="space-y-1.5">
          <h2 className={section}>Routines</h2>
          {routines.length === 0 ? (
            <p className="text-sm text-subtext-0 italic">No routines on this host.</p>
          ) : (
            routines.map((r) => (
              <div key={r.id} className="g-plain flex items-center gap-3 px-3 py-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${r.enabled ? 'bg-success' : 'bg-overlay-0'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text truncate">{r.name}</div>
                  <div className="text-[11px] text-subtext-0 truncate">
                    {r.kind}
                    {r.last_run_at ? ` · ran ${r.last_run_at.slice(5, 16).replace('T', ' ')}` : ' · never run'}
                  </div>
                </div>
                <button
                  onClick={() => void fireRoutine(r)}
                  disabled={busy === `routine-${r.id}`}
                  className="g-btn g-btn-ghost g-btn-sm shrink-0"
                >
                  {busy === `routine-${r.id}` ? 'running…' : '▶ Run now'}
                </button>
              </div>
            ))
          )}
        </section>

        {/* Recent runs — the feed */}
        <section className="space-y-1.5">
          <h2 className={section}>Recent runs</h2>
          {runs.length === 0 ? (
            <p className="text-sm text-subtext-0 italic">No workflow runs yet.</p>
          ) : (
            runs.slice(0, 20).map((r) => {
              const wfId = r.workflow_id ?? null;
              const isActive = wfId != null && activeIds.has(wfId) && r.status === 'running';
              // 'running' with no active run behind it = a zombie from before
              // the boot reconcile (or a just-started poll gap).
              const shownStatus = r.status === 'running' && !isActive ? 'interrupted' : r.status;
              const wf = wfId != null ? workflows.find((w) => w.id === wfId) : undefined;
              return (
                <div key={r.id} className="g-plain px-3 py-1.5">
                  <div className="flex items-center gap-3 cursor-pointer" onClick={() => setExpandedRun((e) => (e === r.id ? null : r.id))}>
                    <span className="text-sm text-text truncate flex-1">{r.name}</span>
                    {isActive && (
                      <button
                        onClick={(e) => { e.stopPropagation(); if (wfId != null) void cancelOracleRun(wfId).finally(() => void refreshActiveRuns()); }}
                        title="Abort this run — remaining nodes are skipped, the in-flight call is cut"
                        className="g-btn g-btn-danger g-btn-sm shrink-0"
                      >
                        ■ Stop
                      </button>
                    )}
                    <span
                      className={`g-tag !min-h-[22px] !px-2 !text-[11px] shrink-0 ${RUN_CHIP[shownStatus] ?? ''}`}
                      title={shownStatus === 'interrupted' ? 'The host restarted while this run was in flight' : undefined}
                    >
                      {shownStatus}
                    </span>
                    <span className="text-[11px] text-subtext-0 shrink-0">{r.created_at.slice(5, 16)}</span>
                    <span className="text-subtext-0 text-xs shrink-0">{expandedRun === r.id ? '▾' : '▸'}</span>
                  </div>
                  {expandedRun === r.id && (
                    <div className="mt-2 pt-2 border-t border-surface-1">
                      <NodeLog
                        log={(isActive && wfId != null ? liveResults.get(wfId) : null) ?? r.results ?? null}
                        def={wf?.definition}
                        isLive={isActive}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
