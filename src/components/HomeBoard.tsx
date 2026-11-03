import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { useDataPulse } from '../lib/livePulse';
import { useAppStore } from '../store/appStore';
import { listWorkspaces, LOCAL_ID } from '../lib/workspaces';
import { wsGetTasks, wsGetEvents, wsGetProjectStats, wsGetProjectEvents, wsMyAssignments } from '../lib/workspaceData';
// data is fetched per-workspace via workspaceData (K2 cross-workspace).
import type { Task, Event, Project, ProjectStats, MyAssignment } from '../types';
import DetailPane, { useDetailStack } from './DetailPane';
import ScrollArea from './ScrollArea';
import { PopoverShell, PopoverRow, STAT_CELL } from './HomePopover';
import SecretaryWidget from './SecretaryWidget';
import HomeUpdates from './comments/HomeUpdates';
import { hasDaemon } from '../lib/daemon';
import { ResizablePane, Card, DecoHeading } from './gilt';
import { projectColorClass, projectInitial } from '../lib/projectColor';
import StatusChips from './StatusChips';
import { countByStatus, parseStatusSelection, statusBucket, statusPasses, type Status } from './statusFilter';

function fmtHours(seconds: number): string {
  if (!seconds) return '0h';
  const h = seconds / 3600;
  if (h < 1) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Gilt status marks (`g-st`) by task status. */
const statusMark: Record<string, string> = {
  'To Do': 'g-st',
  'In Progress': 'g-st g-st-progress',
  Done: 'g-st g-st-done',
  Blocked: 'g-st g-st-blocked',
};
const markOf = (status: string) => statusMark[status] ?? 'g-st';

/** Home's card grid: one column on a narrow window, two at a normal width,
 * up to four on an ultrawide (the min track grows to a quarter of the row, so
 * auto-fill never makes a fifth). */
const GRID =
  'grid gap-[26px] items-start grid-cols-[repeat(auto-fill,minmax(min(100%,max(460px,calc((100%-80px)/4))),1fr))]';
/** A row in a card: the prototype's `.arow` / `.prow`. */
const ROW = 'w-full flex items-center gap-3 min-h-[44px] px-3 rounded text-left';
const MUTED = 'text-[color:var(--g-mut)]';

type CardKey = 'projects' | 'tasks' | 'time' | 'events';

// "Assigned to you": cosmetic per-device preferences (TAB_SPEC: ok in localStorage).
const ASSIGNED_STATUS_KEY = 'ganban:home-assigned-status';
const ASSIGNED_EXPANDED_KEY = 'ganban:home-assigned-expanded';
/** Default status chips: everything except Done. */
const ASSIGNED_DEFAULT: Status[] = ['To Do', 'In Progress', 'Blocked'];
/** Rows the card shows before "Show all (N)". */
const ASSIGNED_PREVIEW = 6;

/** The face of a Home stat (the prototype's `.stat`): a big light deco
 * number over a muted label. */
function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-3 py-5">
      <div className="font-deco font-light text-[38px] leading-[1.1] tabular-nums text-text">{value}</div>
      <div className={`mt-1.5 text-xs tracking-[.04em] ${MUTED}`}>{label}</div>
    </div>
  );
}

/** Dividers between the four stats: two by two on a narrow window, one row from md. */
/** The app's landing dashboard: cross-project infographics whose tiles open
 * notification-style pop-ups; clicking any item drives the navigable right-hand
 * DetailPane while you stay on the Home screen. */
/** Compact relative time — "which of these moved recently?" at a glance. */
function agoLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days < 7 ? `${days}d ago` : d.toLocaleDateString();
}

function HomeBoard({
  onOpenProject,
  isOwner,
}: { onOpenProject?: (p: Project) => void; isOwner?: boolean } = {}) {
  const { projects, homeBoardProjectFilter, setHomeBoardProjectFilter, setActiveTask, activeTask, setCommentBoardIntent } = useAppStore();
  /** Same task, same workspace (K2: bare ids collide across hosts). */
  const isActiveTask = (id: number, ws?: string) =>
    activeTask != null && activeTask.id === id && ((activeTask as { workspaceId?: string }).workspaceId ?? LOCAL_ID) === (ws ?? LOCAL_ID);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  // keyed by composite 'workspace:projectId' (ids collide across hosts).
  const [statsByProject, setStatsByProject] = useState<Record<string, ProjectStats>>({});
  const [loading, setLoading] = useState(true);
  const [openCard, setOpenCard] = useState<CardKey | null>(null);
  // Tasks assigned to ME, across every connected workspace (MEMBER_AGENTS).
  const [myAssign, setMyAssign] = useState<MyAssignment[]>([]);
  const [assignedStatus, setAssignedStatusState] = useState<Status[]>(() =>
    parseStatusSelection(localStorage.getItem(ASSIGNED_STATUS_KEY), ASSIGNED_DEFAULT)
  );
  const setAssignedStatus = (next: Status[]) => {
    setAssignedStatusState(next);
    localStorage.setItem(ASSIGNED_STATUS_KEY, JSON.stringify(next));
  };
  const [assignedExpanded, setAssignedExpandedState] = useState(() => localStorage.getItem(ASSIGNED_EXPANDED_KEY) === '1');
  const setAssignedExpanded = (v: boolean) => {
    setAssignedExpandedState(v);
    localStorage.setItem(ASSIGNED_EXPANDED_KEY, v ? '1' : '0');
  };
  // composite event keys 'workspace:eventId' for the filtered project.
  const [filterEventIds, setFilterEventIds] = useState<Set<string> | null>(null);
  const detail = useDetailStack({ scope: 'home', onShow: (show) => setDetailHidden(!show) });
  // The right-hand detail pane is collapsible (hidden by default — the Home
  // board gets the full width until the user opens something or toggles it).
  const [detailHidden, setDetailHidden] = useState(true);

  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);

  // K2 composite keys — ids collide across workspaces.
  const pk = (p: { workspaceId?: string; id: number }) => `${p.workspaceId ?? LOCAL_ID}:${p.id}`;
  const taskProjectKey = (t: Task) => `${t.workspaceId ?? LOCAL_ID}:${t.project_id}`;
  const taskKey = (t: Task) => `${t.workspaceId ?? LOCAL_ID}:${t.id}`;
  const eventKey = (e: Event) => `${e.workspaceId ?? LOCAL_ID}:${e.id}`;

  // When the sidebar single-clicks a project, the store sets this filter and we
  // scope the whole dashboard to that one project (clearable via the banner).
  const filterProject = useMemo(
    () => (homeBoardProjectFilter != null ? activeProjects.find((p) => pk(p) === homeBoardProjectFilter) ?? null : null),
    [homeBoardProjectFilter, activeProjects]
  );

  // Events aren't project-scoped in `events`, so resolve the filtered project's
  // event ids separately.
  useEffect(() => {
    if (filterProject == null) {
      setFilterEventIds(null);
      return;
    }
    let cancelled = false;
    setFilterEventIds(null); // clear the previous project's set while the new one loads
    const fws = listWorkspaces().find((w) => w.id === (filterProject.workspaceId ?? LOCAL_ID));
    (fws ? wsGetProjectEvents(fws, filterProject.id) : Promise.resolve([]))
      .then((evs) => !cancelled && setFilterEventIds(new Set(evs.map((e) => `${fws?.id ?? LOCAL_ID}:${e.id}`))))
      .catch(() => !cancelled && setFilterEventIds(new Set()));
    return () => {
      cancelled = true;
    };
  }, [filterProject]);

  const scopedTasks = useMemo(
    () => (filterProject ? allTasks.filter((t) => taskProjectKey(t) === pk(filterProject)) : allTasks),
    [allTasks, filterProject]
  );
  // While filtered, never fall back to all events (that would show cross-project
  // events under a "Filtered to X" banner). Empty until the project's ids load.
  const scopedEvents = useMemo(
    () => (filterProject ? (filterEventIds ? events.filter((e) => filterEventIds.has(eventKey(e))) : []) : events),
    [events, filterEventIds, filterProject]
  );
  // Assigned to you follows the project filter like every other card.
  const scopedAssign = useMemo(
    () =>
      filterProject
        ? myAssign.filter((a) => `${a.workspaceId ?? LOCAL_ID}:${a.project_id}` === pk(filterProject))
        : myAssign,
    [myAssign, filterProject]
  );
  const assignedCounts = useMemo(() => countByStatus(scopedAssign.map((a) => a.task_status)), [scopedAssign]);
  // Most recently touched first — "which of these is alive?" is the
  // prioritisation question this card answers.
  const shownAssign = useMemo(
    () =>
      scopedAssign
        .filter((a) => statusPasses(assignedStatus, a.task_status))
        .sort((x, y) => (y.task_updated_at ?? '').localeCompare(x.task_updated_at ?? '')),
    [scopedAssign, assignedStatus]
  );
  // The expanded overview: grouped by project (by name), newest first within.
  const assignGroups = useMemo(() => {
    const by = new Map<string, { key: string; name: string; workspaceId?: string; projectId: number; items: MyAssignment[] }>();
    for (const a of shownAssign) {
      const key = `${a.workspaceId ?? LOCAL_ID}:${a.project_id}`;
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, name: a.project_name, workspaceId: a.workspaceId, projectId: a.project_id, items: [] }));
      g.items.push(a);
    }
    return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [shownAssign]);
  const scopedProjects = useMemo(
    () => (filterProject ? [filterProject] : activeProjects),
    [filterProject, activeProjects]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  useDataPulse(() => void load(), ['tasks', 'events', 'projects', 'comments', 'time']); // host pulse → refetch in place

  // Spinner only before the FIRST data arrives — pulse refetches (which can
  // fire twice: the window event + the store's new projects identity) must
  // swap numbers in place, not blink every tile to "—".
  const loadedOnce = useRef(false);
  async function load() {
    if (!loadedOnce.current) setLoading(true);
    try {
      // K2 Stage C: aggregate across ALL workspaces via explicit per-host
      // handles (no global divert). Each workspace's tasks/events are tagged
      // with its id; stats are keyed by composite 'workspace:projectId'.
      const wss = listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);
      const perWs = await Promise.all(
        wss.map(async (ws) => {
          const wsProjects = projects.filter((p) => !p.archived && (p.workspaceId ?? LOCAL_ID) === ws.id);
          const [taskArrs, evs, statEntries, mine] = await Promise.all([
            Promise.all(
              wsProjects.map((p) =>
                wsGetTasks(ws, p.id)
                  .then((ts) => ts.map((t) => ({ ...t, workspaceId: ws.id })))
                  .catch(() => [] as Task[])
              )
            ),
            wsGetEvents(ws)
              .then((es) => es.map((e) => ({ ...e, workspaceId: ws.id })))
              .catch(() => [] as Event[]),
            Promise.all(
              wsProjects.map((p) =>
                wsGetProjectStats(ws, p.id)
                  .then((s) => [`${ws.id}:${p.id}`, s] as const)
                  .catch(() => null)
              )
            ),
            // Older hosts don't have the command — quietly no assignments.
            wsMyAssignments(ws).catch(() => [] as MyAssignment[]),
          ]);
          return { tasks: taskArrs.flat(), events: evs, stats: statEntries, mine };
        })
      );
      setAllTasks(perWs.flatMap((x) => x.tasks));
      setEvents(perWs.flatMap((x) => x.events));
      setMyAssign(perWs.flatMap((x) => x.mine));
      const map: Record<string, ProjectStats> = {};
      for (const x of perWs) for (const e of x.stats) if (e) map[e[0]] = e[1];
      setStatsByProject(map);
      loadedOnce.current = true;
    } finally {
      setLoading(false);
    }
  }

  const openTasks = useMemo(
    () =>
      [...scopedTasks]
        .filter((t) => t.status !== 'Done')
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [scopedTasks]
  );
  const totalSeconds = useMemo(
    () =>
      filterProject
        ? statsByProject[pk(filterProject)]?.total_time_seconds || 0
        : Object.values(statsByProject).reduce((s, st) => s + (st.total_time_seconds || 0), 0),
    [statsByProject, filterProject]
  );
  const upcoming = useMemo(() => {
    const today = startOfToday();
    return [...scopedEvents]
      .filter((e) => !e.done_at && new Date(e.event_date).getTime() >= today)
      .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
      .slice(0, 12);
  }, [scopedEvents]);
  const recentTask = useMemo(() => {
    const sorted = [...scopedTasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return sorted.find((t) => t.status === 'In Progress') ?? sorted[0] ?? null;
  }, [scopedTasks]);

  const sortedProjects = useMemo(
    () => [...scopedProjects].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name)),
    [scopedProjects]
  );
  // Projects ranked by tracked time (for the Tracked-time pop-up).
  const projectsByTime = useMemo(
    () =>
      [...scopedProjects]
        .map((p) => ({ p, secs: statsByProject[pk(p)]?.total_time_seconds || 0 }))
        .sort((a, b) => b.secs - a.secs)
        .filter((x) => x.secs > 0),
    [scopedProjects, statsByProject]
  );

  const tasksByKey = useMemo(() => new Map(allTasks.map((t) => [taskKey(t), t])), [allTasks]);
  const taskProjectName = (t: Task) => projects.find((p) => pk(p) === taskProjectKey(t))?.name ?? '';

  // Every click-through goes through the DetailPane stack so back/forward works.
  // Each also un-hides the detail pane so the user sees what they clicked.
  const openTask = (task: Task) => {
    detail.open({ kind: 'task', task });
    setDetailHidden(false);
    setOpenCard(null);
  };
  const openEvent = (event: Event) => {
    detail.open({ kind: 'event', event });
    setDetailHidden(false);
    setOpenCard(null);
  };
  const openProject = (project: Project) => {
    detail.open({ kind: 'project', project });
    setDetailHidden(false);
    setOpenCard(null);
  };

  const toggle = (k: CardKey) => setOpenCard((c) => (c === k ? null : k));

  /** One "Assigned to you" row. Clicking opens the task in the detail pane
   * when the board has it loaded; the project shows unless the row sits under
   * its project's heading or Home is filtered to that project. */
  const assignedRow = (a: MyAssignment, showProject: boolean) => {
    const t = tasksByKey.get(`${a.workspaceId ?? LOCAL_ID}:${a.task_id}`);
    const overdue = a.task_deadline != null && new Date(a.task_deadline).getTime() < Date.now() && statusBucket(a.task_status) !== 'Done';
    const active = isActiveTask(a.task_id, a.workspaceId);
    return (
      <button
        key={`${a.workspaceId ?? LOCAL_ID}:${a.task_id}`}
        onClick={() => { if (t) { detail.open({ kind: 'task', task: t }); setDetailHidden(false); } }}
        onDoubleClick={(e) => { e.stopPropagation(); if (t) setActiveTask(t); }}
        title={t ? 'Click to open · double-click to set as active task' : undefined}
        className={`${ROW} min-h-[48px] ${
          active ? 'bg-gilt-b shadow-[inset_0_0_0_1px_var(--color-success)]' : ''
        } ${t ? 'hover:bg-surface-0 transition-colors' : 'cursor-default'}`}
      >
        <span className={markOf(a.task_status)} title={a.task_status} />
        <span className="sr-only">{a.task_status}:</span>
        <span className="text-text font-medium truncate min-w-0 flex-1">{a.task_title}</span>
        {(a.task_priority === 'High' || a.task_priority === 'Urgent') && (
          <span className={`g-tag shrink-0 ${a.task_priority === 'Urgent' ? 'g-tag-red' : 'g-tag-hi'}`}>
            {a.task_priority}
          </span>
        )}
        {overdue && (
          <span className="g-tag g-tag-red shrink-0" title={`Deadline ${a.task_deadline?.slice(0, 10)}`}>
            overdue
          </span>
        )}
        {a.brief && (
          <span className="g-tag shrink-0" title={a.brief.notes ?? 'Work brief attached'}>
            brief
          </span>
        )}
        {showProject && (
          <>
            <span
              className={`g-gem ${projectColorClass({ workspaceId: a.workspaceId, id: a.project_id })}`}
              title={a.project_name}
            />
            <span className={`text-xs shrink-0 truncate max-w-[10rem] ${MUTED}`}>{a.project_name}</span>
          </>
        )}
        <span className={`text-xs shrink-0 tabular-nums ${MUTED}`} title={`Last edit ${a.task_updated_at}`}>
          {agoLabel(a.task_updated_at)}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full">
      <ScrollArea className="flex-1 bg-mantle">
        <div className="px-8 pt-[30px] pb-16 flex flex-col gap-[30px]">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            {/* Left: the Home title under today's date, or the filter badge
                when the sidebar scopes Home to one project. */}
            <div className="min-w-0">
              <div className="g-deco text-xs text-gold">
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              {filterProject ? (
                <div className="mt-2 inline-flex items-center gap-2.5 text-sm bg-gilt-b rounded-full pl-2 pr-3 min-h-[36px] shadow-[inset_0_0_0_1px_var(--color-gilt-a)]">
                  <span className={`g-gem ${projectColorClass(filterProject)} ml-1.5`} aria-hidden="true" />
                  <span className={MUTED}>Filtered to</span>
                  <span className="text-text font-semibold truncate max-w-[200px]">{filterProject.name}</span>
                  <button onClick={() => setHomeBoardProjectFilter(null)} className="g-lnk">
                    Show all
                  </button>
                </div>
              ) : (
                <h1 className="g-ptitle text-text">Home</h1>
              )}
            </div>
            {/* Right: Show/Hide editor toggle */}
            <button
              onClick={() => setDetailHidden((v) => !v)}
              className="g-btn g-btn-gilt"
              title={detailHidden ? 'Show the detail panel' : 'Hide the detail panel'}
            >
              {detailHidden ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              )}
              {detailHidden ? 'Show editor' : 'Hide editor'}
            </button>
          </div>

          {/* The secretary — owner-only, and only when there's a host to ground
              against (its own in-process daemon or a remote one). */}
          {isOwner && hasDaemon() && <SecretaryWidget />}

          {/* Infographics — each stat opens a notification-style pop-up */}
          <Card className="grid grid-cols-2 md:grid-cols-4">
            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'projects'}
              onToggle={() => toggle('projects')}
              onClose={() => setOpenCard(null)}
              title="Projects"
              empty={sortedProjects.length === 0}
              tile={<Tile value={loading ? '—' : String(scopedProjects.length)} label="Active projects" />}
            >
              {sortedProjects.map((p) => (
                <PopoverRow
                  key={pk(p)}
                  primary={`${p.pinned ? '★ ' : ''}${p.name}`}
                  secondary={statsByProject[pk(p)] ? `${statsByProject[pk(p)].total_tasks} tasks` : undefined}
                  mark={`g-gem ${projectColorClass(p)}`}
                  onClick={() => openProject(p)}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'tasks'}
              onToggle={() => toggle('tasks')}
              onClose={() => setOpenCard(null)}
              title="Open tasks"
              empty={openTasks.length === 0}
              tile={<Tile value={loading ? '—' : String(openTasks.length)} label="Open tasks" />}
            >
              {openTasks.slice(0, 30).map((t) => (
                <PopoverRow
                  key={taskKey(t)}
                  primary={t.title}
                  secondary={`${taskProjectName(t)} · ${t.status}`}
                  mark={markOf(t.status)}
                  onClick={() => openTask(t)}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'time'}
              onToggle={() => toggle('time')}
              onClose={() => setOpenCard(null)}
              title="Tracked time"
              empty={projectsByTime.length === 0}
              tile={<Tile value={loading ? '—' : fmtHours(totalSeconds)} label="Tracked time" />}
            >
              {projectsByTime.map(({ p, secs }) => (
                <PopoverRow
                  key={pk(p)}
                  primary={p.name}
                  secondary={fmtHours(secs)}
                  mark={`g-gem ${projectColorClass(p)}`}
                  onClick={() => openProject(p)}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'events'}
              onToggle={() => toggle('events')}
              onClose={() => setOpenCard(null)}
              title="Upcoming events"
              empty={upcoming.length === 0}
              tile={<Tile value={loading ? '—' : String(upcoming.length)} label="Upcoming events" />}
            >
              {upcoming.map((e) => (
                <PopoverRow
                  key={eventKey(e)}
                  primary={e.title}
                  secondary={new Date(e.event_date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                  onClick={() => openEvent(e)}
                />
              ))}
            </PopoverShell>
          </Card>

          {/* Pick up where you left off */}
          {recentTask && (
            <button
              onClick={() => { detail.open({ kind: 'task', task: recentTask }); setDetailHidden(false); }}
              onDoubleClick={(e) => { e.stopPropagation(); setActiveTask(recentTask); }}
              title="Double-click to set as the active task"
              className={`g-card g-glint w-full text-left flex items-center gap-4 px-6 py-4 transition-colors hover:bg-surface-0 ${
                isActiveTask(recentTask.id, (recentTask as { workspaceId?: string }).workspaceId) ? '!border-success' : ''
              }`}
            >
              <span className="g-deco text-xs font-semibold text-gold shrink-0">Pick up where you left off</span>
              <span className={markOf(recentTask.status)} title={recentTask.status} />
              <span className="text-text font-medium truncate min-w-0">{recentTask.title}</span>
              <span className={`ml-auto shrink-0 inline-flex items-center gap-2 text-[13px] ${MUTED}`}>
                <span className={`g-gem ${projectColorClass({ workspaceId: recentTask.workspaceId, id: recentTask.project_id })}`} />
                {taskProjectName(recentTask)} · {recentTask.status}
              </span>
            </button>
          )}

          <div className={GRID}>
            {/* Assigned to you — the member-side assignment surface (MEMBER_AGENTS):
                live tasks across every connected workspace, with the advisory
                brief flagged. Clicking opens the task in the detail pane when the
                board has it loaded. */}
            {scopedAssign.length > 0 && (
              <Card
                as="section"
                className={`px-3 pt-[22px] pb-3.5 min-w-0 ${assignedExpanded ? 'col-span-full' : ''}`}
                aria-labelledby="home-assigned-h"
              >
                <DecoHeading count={shownAssign.length}>
                  <span id="home-assigned-h">Assigned to you</span>
                </DecoHeading>
                <div className="flex justify-center mb-3">
                  <StatusChips
                    value={assignedStatus}
                    onChange={setAssignedStatus}
                    counts={assignedCounts}
                    label="Show assigned tasks by status"
                    className="justify-center"
                  />
                </div>
                {shownAssign.length === 0 ? (
                  <p className={`text-center mt-2 mb-2 ${MUTED}`}>Nothing assigned to you with these statuses.</p>
                ) : assignedExpanded ? (
                  // The overview: every assigned task, grouped by project, in
                  // newspaper columns across the full width (no gaps under
                  // short groups).
                  <div className="columns-[420px] gap-x-6">
                    {assignGroups.map((g) => (
                      <div key={g.key} className="min-w-0 break-inside-avoid pb-4" role="group" aria-label={g.name}>
                        <div className="flex items-center gap-2 px-3 pb-1.5 mb-1 border-b border-gilt-b">
                          <span className={`g-gem ${projectColorClass({ workspaceId: g.workspaceId, id: g.projectId })}`} aria-hidden="true" />
                          <span className="text-sm font-semibold text-text truncate">{g.name}</span>
                          <span className={`text-xs tabular-nums ${MUTED}`}>{g.items.length}</span>
                        </div>
                        <div className="space-y-0.5">{g.items.map((a) => assignedRow(a, false))}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-0.5">{shownAssign.slice(0, ASSIGNED_PREVIEW).map((a) => assignedRow(a, !filterProject))}</div>
                )}
                {(assignedExpanded || shownAssign.length > ASSIGNED_PREVIEW) && (
                  <div className="flex justify-center mt-2">
                    <button
                      onClick={() => setAssignedExpanded(!assignedExpanded)}
                      aria-expanded={assignedExpanded}
                      className="g-lnk text-[13px] min-h-[32px] px-2"
                    >
                      {assignedExpanded ? 'Show fewer' : `Show all (${shownAssign.length})`}
                    </button>
                  </div>
                )}
              </Card>
            )}

            {/* Projects (click a row to preview; "open →" opens the project) */}
            <Card as="section" className="px-5 pt-[22px] pb-3" aria-labelledby="home-projects-h">
              <DecoHeading count={sortedProjects.length || undefined}>
                <span id="home-projects-h">Projects</span>
              </DecoHeading>
              {sortedProjects.length === 0 ? (
                <p className={`text-center mt-2 mb-4 ${MUTED}`}>No projects yet.</p>
              ) : (
                <div className="space-y-0.5">
                  {sortedProjects.map((p) => {
                    const st = statsByProject[pk(p)];
                    const pct = st && st.total_tasks ? Math.round((st.tasks_by_status.done / st.total_tasks) * 100) : null;
                    return (
                      <div key={pk(p)} className={`${ROW} px-1 hover:bg-surface-0 transition-colors ${projectColorClass(p)}`}>
                        <span className="g-tile" aria-hidden="true">{projectInitial(p.name)}</span>
                        <button
                          onClick={() => { detail.open({ kind: 'project', project: p }); setDetailHidden(false); }}
                          className="text-text text-sm font-medium hover:underline truncate text-left min-w-0 shrink"
                          title={`Preview ${p.name}`}
                        >
                          {p.name}
                        </button>
                        {p.pinned && (
                          <span className="text-gold shrink-0 text-sm" title="Pinned">
                            ★
                          </span>
                        )}
                        <span className="flex-1 min-w-[40px] h-[3px] rounded-sm bg-surface-0 overflow-hidden" aria-hidden="true">
                          {pct != null && <span className="block h-full bg-[var(--pc)]" style={{ width: `${pct}%` }} />}
                        </span>
                        <span className={`text-xs shrink-0 tabular-nums ${MUTED}`}>
                          {st ? `${st.total_tasks} tasks` : ''}
                          {st && st.total_time_seconds ? ` · ${fmtHours(st.total_time_seconds)}` : ''}
                        </span>
                        {onOpenProject && (
                          <button
                            onClick={() => onOpenProject(p)}
                            className="g-lnk text-xs shrink-0 min-h-[32px] px-1"
                            title={`Open ${p.name}`}
                          >
                            open →
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Upcoming events */}
            <Card as="section" className="px-6 pt-[22px] pb-3.5" aria-labelledby="home-events-h">
              <DecoHeading>
                <span id="home-events-h">Upcoming events</span>
              </DecoHeading>
              {upcoming.length === 0 ? (
                <p className={`text-center mt-2 mb-4 ${MUTED}`}>Nothing scheduled.</p>
              ) : (
                <div>
                  {upcoming.slice(0, 6).map((e) => {
                    const d = new Date(e.event_date);
                    const active = detail.current?.kind === 'event' && eventKey(detail.current.event) === eventKey(e);
                    return (
                      <button
                        key={eventKey(e)}
                        onClick={() => { detail.open({ kind: 'event', event: e }); setDetailHidden(false); }}
                        className={`w-full flex items-center gap-4 min-h-[48px] px-2 border-t border-gilt-b text-left transition-colors hover:bg-surface-0 ${
                          active ? 'bg-gilt-b' : ''
                        }`}
                      >
                        <span className="g-deco shrink-0 w-[76px] text-gold tabular-nums tracking-[.08em] text-[15px]">
                          {d.toLocaleDateString('en-US', { month: 'short' })} {d.getDate()}
                        </span>
                        <span className="text-text font-medium truncate">{e.title}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Updates — every project's comment board (tab per project), or
                the filtered project's; a full-width row last on the page,
                collapsible. Task chips open the task on the right. */}
            <HomeUpdates
              projects={sortedProjects}
              tasks={allTasks}
              filterProjectKey={filterProject ? pk(filterProject) : null}
              onOpenTask={openTask}
              onOpenBoard={
                onOpenProject
                  ? (p, taskIds) => {
                      setCommentBoardIntent({ projectKey: pk(p), taskIds });
                      onOpenProject(p);
                    }
                  : undefined
              }
            />
          </div>
        </div>
        </ScrollArea>

      {/* Right panel — navigable detail of whatever was clicked. Collapsible:
          hidden by default; ✕ hides it, the header toggle reopens it. Clicking
          a tile/project/event un-hides it. */}
      <ResizablePane
        id="side-pane"
        side="right"
        min={340}
        max={900}
        defaultWidth={420}
        collapsible
        collapsed={detailHidden}
        className="border-l border-surface-2 bg-surface-0"
      >
        <DetailPane
          controller={detail}
          onChanged={() => void load()}
          onOpenProject={onOpenProject}
          onClose={() => setDetailHidden(true)}
          emptyHint="Click a tile above, a project, or an event to preview it here — linked tasks and events stay navigable with the ‹ › buttons."
        />
      </ResizablePane>
    </div>
  );
}

// Memoised: App re-renders (the top bar's fit, dialogs) don't reach it.
export default memo(HomeBoard);
