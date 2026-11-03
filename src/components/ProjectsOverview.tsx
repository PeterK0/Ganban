import { useEffect, useMemo, useRef, useState } from 'react';
import ScrollArea from './ScrollArea';
import { useAppStore } from '../store/appStore';
import { listWorkspaces, LOCAL_ID } from '../lib/workspaces';
import { wsGetProjectStats, wsGetTasks } from '../lib/workspaceData';
import type { Project, Task, ProjectStats } from '../types';
import { Card, DecoHeading } from './gilt';
import { projectColorClass, projectInitial } from '../lib/projectColor';

// The Projects landing: a scannable, triage-first overview of every project
// across all workspaces (local + attached hosts). Selecting a project drills
// into its detail tabs (the parent swaps ProjectView in once selectedProject is
// set). Data is read per-host via the K2 explicit handles and keyed by the
// composite 'workspace:projectId' (ids collide across hosts).

type SortKey = 'activity' | 'name' | 'open' | 'deadline';
type ViewMode = 'cards' | 'table';

const MUTED = 'text-[color:var(--g-mut)]';
/** Project cards add columns as the window widens. */
const CARD_GRID = 'grid gap-[18px] grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]';

const pk = (p: Project) => `${p.workspaceId ?? LOCAL_ID}:${p.id}`;

/** Stable color per remote workspace (local = none), matching the sidebar dot. */
function wsMeta(id: string): { label: string | null; color: string | null } {
  if (!id || id === LOCAL_ID) return { label: null, color: null };
  const label = listWorkspaces().find((w) => w.id === id)?.label ?? 'remote';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { label, color: `hsl(${h}, 65%, 60%)` };
}

function fmtH(secs: number): string {
  if (!secs) return '0h';
  const h = secs / 3600;
  return h >= 1 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${Math.round(secs / 60)}m`;
}

/** Relative day phrasing: negative = "ago", positive = "in", 0 = today. */
function rel(d: Date | null): string {
  if (!d) return '—';
  const days = Math.round((d.getTime() - Date.now()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}

interface Row {
  project: Project;
  wsId: string;
  done: number;
  inProgress: number;
  todo: number;
  blocked: number;
  total: number;
  open: number;
  trackedSeconds: number;
  nextDeadline: Date | null;
  overdue: number;
  lastActivity: Date | null;
  attention: string[];
}

export default function ProjectsOverview({
  onCreateProject,
  onJoin,
}: {
  onCreateProject: (name: string) => Promise<void>;
  onJoin: () => void;
}) {
  const { projects, selectProject } = useAppStore();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const doCreate = async () => {
    if (!newName.trim() || createBusy) return;
    setCreateBusy(true);
    try {
      await onCreateProject(newName); // succeeds → parent drills into the new project
    } catch (e) {
      alert(`Failed to create project: ${e}`);
      setCreateBusy(false);
    }
  };
  const [stats, setStats] = useState<Record<string, ProjectStats>>({});
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  const [q, setQ] = useState('');
  const [hostFilter, setHostFilter] = useState<string>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('activity');
  const [view, setView] = useState<ViewMode>('cards');

  // Per-host stats + tasks (mirrors HomeBoard's aggregation). Re-runs when the
  // merged project list changes (which also covers the pulse-driven reloads).
  useEffect(() => {
    let cancelled = false;
    if (!loadedOnce.current) setLoading(true);
    (async () => {
      const wss = listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);
      const perWs = await Promise.all(
        wss.map(async (ws) => {
          const wsProjects = projects.filter((p) => (p.workspaceId ?? LOCAL_ID) === ws.id);
          const [statEntries, taskEntries] = await Promise.all([
            Promise.all(
              wsProjects.map((p) =>
                wsGetProjectStats(ws, p.id)
                  .then((s) => [`${ws.id}:${p.id}`, s] as const)
                  .catch(() => null)
              )
            ),
            Promise.all(
              wsProjects.map((p) =>
                wsGetTasks(ws, p.id)
                  .then((ts) => [`${ws.id}:${p.id}`, ts] as const)
                  .catch(() => [`${ws.id}:${p.id}`, [] as Task[]] as const)
              )
            ),
          ]);
          return { statEntries, taskEntries };
        })
      );
      if (cancelled) return;
      const sm: Record<string, ProjectStats> = {};
      const tm: Record<string, Task[]> = {};
      for (const x of perWs) {
        for (const e of x.statEntries) if (e) sm[e[0]] = e[1];
        for (const e of x.taskEntries) tm[e[0]] = e[1];
      }
      setStats(sm);
      setTasksByProject(tm);
      loadedOnce.current = true;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const rows: Row[] = useMemo(() => {
    const now = Date.now();
    return projects
      .filter((p) => showArchived || !p.archived)
      .map((p) => {
        const key = pk(p);
        const s = stats[key];
        const ts = tasksByProject[key] ?? [];
        const done = s?.tasks_by_status.done ?? 0;
        const inProgress = s?.tasks_by_status.in_progress ?? 0;
        const todo = s?.tasks_by_status.todo ?? 0;
        const blocked = s?.tasks_by_status.blocked ?? 0;
        const total = s?.total_tasks ?? 0;
        const open = Math.max(0, total - done);
        const deadlines = ts
          .filter((t) => t.deadline && t.status !== 'Done')
          .map((t) => new Date(t.deadline as string).getTime())
          .filter((n) => !Number.isNaN(n));
        const overdue = deadlines.filter((n) => n < now).length;
        const upcoming = deadlines.filter((n) => n >= now).sort((a, b) => a - b);
        const nextDeadline = upcoming.length ? new Date(upcoming[0]) : null;
        const lastActivity = p.updated_at ? new Date(p.updated_at) : null;
        const staleDays = lastActivity ? Math.floor((now - lastActivity.getTime()) / 86400000) : null;
        const attention: string[] = [];
        if (overdue) attention.push(`${overdue} overdue`);
        if (blocked) attention.push(`${blocked} blocked`);
        if (nextDeadline && nextDeadline.getTime() - now < 7 * 86400000) attention.push(`due ${rel(nextDeadline)}`);
        if (open > 0 && staleDays != null && staleDays >= 14) attention.push(`stale ${staleDays}d`);
        return { project: p, wsId: p.workspaceId ?? LOCAL_ID, done, inProgress, todo, blocked, total, open, trackedSeconds: s?.total_time_seconds ?? 0, nextDeadline, overdue, lastActivity, attention };
      });
  }, [projects, stats, tasksByProject, showArchived]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = rows;
    if (needle) r = r.filter((x) => x.project.name.toLowerCase().includes(needle));
    if (hostFilter !== 'all') r = r.filter((x) => x.wsId === hostFilter);
    if (pinnedOnly) r = r.filter((x) => x.project.pinned);
    const sorted = [...r];
    sorted.sort((a, b) => {
      // Pinned always float to the top within any sort.
      if (!!a.project.pinned !== !!b.project.pinned) return a.project.pinned ? -1 : 1;
      switch (sortKey) {
        case 'name':
          return a.project.name.localeCompare(b.project.name);
        case 'open':
          return b.open - a.open;
        case 'deadline': {
          const av = a.nextDeadline?.getTime() ?? Infinity;
          const bv = b.nextDeadline?.getTime() ?? Infinity;
          return av - bv;
        }
        case 'activity':
        default:
          return (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0);
      }
    });
    return sorted;
  }, [rows, q, hostFilter, pinnedOnly, sortKey]);

  const attentionRows = useMemo(() => rows.filter((r) => r.attention.length > 0), [rows]);
  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const dueThisWeek = rows.filter((r) => r.nextDeadline && r.nextDeadline.getTime() - Date.now() < 7 * 86400000).length;
  const remoteWss = listWorkspaces().filter((w) => w.id !== LOCAL_ID);

  const progressBar = (r: Row) => {
    if (r.total === 0) return <div className="h-1.5 rounded-sm bg-surface-0" />;
    const seg = (n: number, cls: string) =>
      n > 0 ? <div className={cls} style={{ width: `${(n / r.total) * 100}%` }} /> : null;
    return (
      <div className="h-1.5 rounded-sm bg-surface-0 overflow-hidden flex">
        {seg(r.done, 'bg-success')}
        {seg(r.inProgress, 'bg-info')}
        {seg(r.blocked, 'bg-error')}
        {seg(r.todo, 'bg-overlay-0')}
      </div>
    );
  };

  /** The prototype's progress ring, segmented by status like the bar; the
   * centre shows the share done. */
  const progressRing = (r: Row) => {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    let at = 0;
    const stops: string[] = [];
    const add = (n: number, colour: string) => {
      if (n <= 0 || !r.total) return;
      const end = at + (n / r.total) * 100;
      stops.push(`${colour} ${at}% ${end}%`);
      at = end;
    };
    add(r.done, 'var(--color-success)');
    add(r.inProgress, 'var(--color-info)');
    add(r.blocked, 'var(--color-error)');
    add(r.todo, 'var(--color-overlay-0)');
    const bg = stops.length ? `conic-gradient(${stops.join(', ')})` : 'var(--color-surface-0)';
    return (
      <span className="relative shrink-0 w-16 h-16 rounded-full" style={{ background: bg }} aria-hidden="true">
        <span className="absolute inset-[5px] rounded-full bg-base" />
        <b className="absolute inset-0 flex items-center justify-center font-deco font-normal text-[15px] tabular-nums pt-0.5">
          {r.total ? `${pct}%` : '—'}
        </b>
      </span>
    );
  };

  const hostDot = (wsId: string) => {
    const { label, color } = wsMeta(wsId);
    if (!color) return null;
    return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} title={`Remote · ${label}`} />;
  };

  /** Overdue and blocked read red; a near deadline or a stale project warns. */
  const attentionTag = (a: string) => (/overdue|blocked/.test(a) ? 'g-tag g-tag-red' : 'g-tag g-tag-warn');

  const projectCard = (r: Row) => (
    <button
      key={pk(r.project)}
      onClick={() => selectProject(r.project)}
      className={`g-card g-glint text-left p-5 flex flex-col gap-3.5 min-w-0 transition-colors hover:border-gold/55 ${projectColorClass(r.project)}`}
    >
      <span className="flex items-center gap-2.5 w-full">
        <span className="g-tile lg">{projectInitial(r.project.name)}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            {hostDot(r.wsId)}
            <span className="block font-bold text-base text-text truncate">{r.project.name}</span>
          </span>
          <span className={`block text-xs ${MUTED}`}>
            {wsMeta(r.wsId).label ? `${wsMeta(r.wsId).label} · ` : ''}active {rel(r.lastActivity)}
          </span>
        </span>
        {r.project.pinned && (
          <span className="text-gold shrink-0 self-start" title="Pinned">★</span>
        )}
      </span>
      <span className="flex items-center gap-4">
        {progressRing(r)}
        <span className="flex flex-col gap-0.5 text-[13px]">
          <span><b className="tabular-nums">{r.open}</b> <span className={MUTED}>open</span></span>
          <span><b className="tabular-nums">{r.done}/{r.total}</b> <span className={MUTED}>done</span></span>
          <span><b className="tabular-nums">{fmtH(r.trackedSeconds)}</b> <span className={MUTED}>tracked</span></span>
        </span>
      </span>
      <span className="block pt-3 border-t border-gilt-b text-[13px]">
        {r.nextDeadline ? (
          <>
            <span className={MUTED}>Next deadline · </span>
            {rel(r.nextDeadline)}
          </>
        ) : (
          <span className={MUTED}>No deadline</span>
        )}
      </span>
      {r.attention.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {r.attention.map((a) => (
            <span key={a} className={attentionTag(a)}>{a}</span>
          ))}
        </span>
      )}
    </button>
  );

  // Cards view: pinned projects get their own shelf above the rest.
  const pinnedRows = filtered.filter((r) => r.project.pinned);
  const otherRows = filtered.filter((r) => !r.project.pinned);

  return (
    // h-full (not flex-1): the parent content area is a block overflow-hidden box,
    // so flex-1 had no height and the page couldn't scroll. h-full fills it; the
    // inner overflow-y-auto then scrolls.
    <ScrollArea className="h-full bg-mantle">
      <div className="px-8 pt-[30px] pb-16 flex flex-col gap-[30px]">
        {/* Header + roll-up */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="g-deco text-xs text-gold">
              {rows.length} project{rows.length === 1 ? '' : 's'} · {totalOpen} open
              {dueThisWeek > 0 && ` · ${dueThisWeek} due this week`}
              {attentionRows.length > 0 && (
                <span className="text-error"> · {attentionRows.length} need attention</span>
              )}
            </div>
            <h1 className="g-ptitle text-text">Projects</h1>
          </div>
          {creating ? (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doCreate();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                placeholder="Project name…"
                className={`g-field w-64`}
              />
              <button onClick={() => void doCreate()} disabled={!newName.trim() || createBusy} className="g-btn g-btn-pri">
                {createBusy ? 'Creating…' : 'Create'}
              </button>
              <button onClick={() => { setCreating(false); setNewName(''); }} className="g-btn g-btn-ghost">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <button onClick={onJoin} className="g-btn g-btn-gilt">Join a project</button>
              <button onClick={() => setCreating(true)} className="g-btn g-btn-pri g-glint">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                New Project
              </button>
            </div>
          )}
        </div>

        {/* Needs attention */}
        {attentionRows.length > 0 && (
          <Card as="section" className="px-5 pt-[22px] pb-5" aria-label="Needs attention">
            <DecoHeading count={attentionRows.length}>Needs attention</DecoHeading>
            <div className="flex flex-wrap justify-center gap-2">
              {attentionRows.map((r) => (
                <button
                  key={pk(r.project)}
                  onClick={() => selectProject(r.project)}
                  className={`flex items-center gap-2.5 min-h-[36px] px-3 rounded bg-mantle border border-surface-0 hover:border-gold/55 text-left transition-colors ${projectColorClass(r.project)}`}
                >
                  <span className="g-gem" aria-hidden="true" />
                  {hostDot(r.wsId)}
                  <span className="text-sm font-medium text-text max-w-[14rem] truncate">{r.project.name}</span>
                  <span className="text-xs">
                    {r.attention.map((a, i) => (
                      <span key={a} className={/overdue|blocked/.test(a) ? 'text-error' : 'text-medium'}>
                        {i > 0 && ' · '}
                        {a}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className={`g-field flex-1 min-w-[12rem]`}
          />
          {remoteWss.length > 0 && (
            <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)} className="g-field w-auto" aria-label="Host">
              <option value="all">All hosts</option>
              <option value={LOCAL_ID}>This machine</option>
              {remoteWss.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          )}
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="g-field w-auto" aria-label="Sort">
            <option value="activity">Recent activity</option>
            <option value="name">Name</option>
            <option value="open">Most open tasks</option>
            <option value="deadline">Soonest deadline</option>
          </select>
          <button onClick={() => setPinnedOnly((v) => !v)} aria-pressed={pinnedOnly} className={`g-chip ${pinnedOnly ? 'g-on' : ''}`} title="Pinned only">★ Pinned</button>
          <button onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived} className={`g-chip ${showArchived ? 'g-on' : ''}`}>Archived</button>
          <div className="flex gap-1">
            <button onClick={() => setView('cards')} aria-pressed={view === 'cards'} className={`g-iconbtn ${view === 'cards' ? '!bg-gilt-b !text-gold' : ''}`} title="Cards">▦</button>
            <button onClick={() => setView('table')} aria-pressed={view === 'table'} className={`g-iconbtn ${view === 'table' ? '!bg-gilt-b !text-gold' : ''}`} title="Table">≣</button>
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <p className={`text-center py-12 ${MUTED}`}>Loading projects…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-text font-medium mb-1">{rows.length === 0 ? 'No projects yet' : 'No projects match'}</p>
            <p className={MUTED}>{rows.length === 0 ? 'Create one or join a teammate’s host to get started.' : 'Try clearing the search or filters.'}</p>
          </div>
        ) : view === 'cards' ? (
          <>
            {pinnedRows.length > 0 && (
              <section aria-label="Pinned projects">
                <DecoHeading count={pinnedRows.length}>Pinned</DecoHeading>
                <div className={CARD_GRID}>{pinnedRows.map(projectCard)}</div>
              </section>
            )}
            {otherRows.length > 0 && (
              <section aria-label={pinnedRows.length > 0 ? 'All other projects' : 'All projects'}>
                <DecoHeading count={otherRows.length}>{pinnedRows.length > 0 ? 'All other projects' : 'All projects'}</DecoHeading>
                <div className={CARD_GRID}>{otherRows.map(projectCard)}</div>
              </section>
            )}
          </>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    ['Project', ''],
                    ['Host', 'w-32'],
                    ['Open', 'w-20 text-right'],
                    ['Progress', 'w-40'],
                    ['Next due', 'w-28'],
                    ['Active', 'w-28'],
                  ].map(([h, w]) => (
                    <th
                      key={h}
                      scope="col"
                      className={`g-deco text-left text-[11px] font-semibold tracking-[.2em] px-3.5 py-2.5 border-b border-gilt-a ${MUTED} ${w}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const { label } = wsMeta(r.wsId);
                  return (
                    <tr
                      key={pk(r.project)}
                      onClick={() => selectProject(r.project)}
                      className={`h-[58px] border-b border-gilt-b last:border-b-0 hover:bg-surface-0 cursor-pointer ${projectColorClass(r.project)}`}
                    >
                      <td className="px-3.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="g-tile" aria-hidden="true">{projectInitial(r.project.name)}</span>
                          <span className="text-text font-medium truncate">{r.project.name}</span>
                          {r.project.pinned && <span className="text-gold shrink-0" title="Pinned">★</span>}
                          {r.attention.length > 0 && <span className="text-xs text-medium shrink-0">{r.attention.join(' · ')}</span>}
                        </div>
                      </td>
                      <td className="px-3.5">
                        <span className={`flex items-center gap-1.5 ${MUTED}`}>{hostDot(r.wsId)}{label ?? 'Local'}</span>
                      </td>
                      <td className="px-3.5 text-right text-text tabular-nums">{r.open}</td>
                      <td className="px-3.5"><div className="w-28">{progressBar(r)}</div></td>
                      <td className={`px-3.5 ${MUTED}`}>{r.nextDeadline ? rel(r.nextDeadline) : '—'}</td>
                      <td className={`px-3.5 ${MUTED}`}>{rel(r.lastActivity)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}
