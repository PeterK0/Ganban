import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { getAreas, getProjectStats, getProjectStorage, getTasks, getProjectEvents, getTaskTotalTime, type ProjectStorage } from '../lib/api';
import { listProjectFiles, listProjectAttachments, listChats, hasDaemon, listAvailableTabs, getProjectTabs, setProjectTab, type ProjectFile, type ProjectAttachment, type Chat, type TabDescriptor } from '../lib/daemon';
import { Suspense } from 'react';
import { TAB_PANELS, stashTabIcon } from '../tabs/registry';
import { TabIcon, type TabIconName } from './icons/TabIcon';
import TabErrorBoundary from './TabErrorBoundary';
import type { Area, ProjectStats, Task, Event } from '../types';
import TaskList from './TaskList';
import FilesTab from './FilesTab';
import CalendarView from './CalendarView';
import ReportGenerator from './ReportGenerator';
import ChatView from './ChatView';
import CommentsTab from './CommentsTab';
import ScrollArea from './ScrollArea';
import DetailPane, { useDetailStack } from './DetailPane';
import { useNav, forgetTab } from '../store/navHistory';
import { PopoverShell, PopoverRow, STAT_CELL } from './HomePopover';
import MembersTab from './MembersTab';
import CommentBoard from './comments/CommentBoard';
import { activeBoardApi } from './comments/boardApi';
import { CollapsedNote, FEED_COLUMN, SectionToggle, useCollapsed } from './comments/collapse';
import { useContextMenu } from './ContextMenu';
import { PinGlyph } from './PinnedTabs';
import { BUILTIN_TABS, type BuiltinTab } from '../lib/projectTabs';
import { LOCAL_ID } from '../lib/workspaces';
import { openPinnedTabWindow } from '../lib/windows';
import { isPinned, labelOf, readSubView, usePins } from '../store/pins';
import { notify } from '../store/notifications';
import { ResizablePane } from './gilt';
import { dueTag, statusMark } from './taskMarks';
import { projectColorClass, projectInitial } from '../lib/projectColor';

/** A unified tab entry — built-in (TABS) and stash tabs merged so the user can
 * drag-reorder them as one set. */
interface TabEntry {
  id: string;
  label: string;
  icon: TabIconName;
  description?: string;
  stash?: boolean; // true = comes from the host's registry (not built-in)
}

/** localStorage key for per-project tab order. Client-side (per-device) for
 * now — a server-side per-project setting is a later schema addition. */
function tabOrderKey(projectId: number | null): string {
  return projectId != null ? `ganban:tab-order:${projectId}` : 'ganban:tab-order:default';
}
function loadTabOrder(projectId: number | null): string[] {
  try {
    const raw = localStorage.getItem(tabOrderKey(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveTabOrder(projectId: number | null, order: string[]): void {
  localStorage.setItem(tabOrderKey(projectId), JSON.stringify(order));
}

type Tab = BuiltinTab;
const TABS = BUILTIN_TABS;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtHours(seconds: number): string {
  if (!seconds) return '0h';
  const h = seconds / 3600;
  if (h < 1) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

/** The tile face for a project stat card (label + icon on top, value, sub). */
function Tile({ label, value, sub, active }: { label: string; value: string; sub?: string; active?: boolean }) {
  return (
    <div className={`px-3 py-5 text-center h-full ${active ? 'bg-gilt-b shadow-[inset_0_-2px_0_var(--color-gold)]' : ''}`}>
      <span className={`block font-deco font-light text-[38px] leading-[1.1] tabular-nums ${active ? 'text-gold' : 'text-text'}`}>{value}</span>
      <span className="block mt-1.5 text-xs tracking-[0.04em] text-[color:var(--g-mut)]">
        {label}
        {sub && <> · {sub}</>}
      </span>
    </div>
  );
}

const STATUS_META: { key: keyof ProjectStats['tasks_by_status']; label: string; color: string }[] = [
  { key: 'todo', label: 'To Do', color: 'bg-overlay-0' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-primary' },
  { key: 'done', label: 'Done', color: 'bg-success' },
  { key: 'blocked', label: 'Blocked', color: 'bg-error' },
];

/** The Progress meter's segments (to-do is the empty track) and its legend. */
const PROGRESS_SEGMENTS: { key: keyof ProjectStats['tasks_by_status']; label: string; color: string }[] = [
  { key: 'done', label: 'Done', color: 'var(--color-success)' },
  { key: 'in_progress', label: 'In Progress', color: 'var(--g-org)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--color-error)' },
];
const LEGEND: { key: keyof ProjectStats['tasks_by_status']; label: string }[] = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];

type HomeCard = 'tasks' | 'files' | 'storage' | 'time';

/** Project landing summary: interactive infographics (each stat card opens a
 * notification-style pop-up), task health, recent tasks and upcoming events.
 * Clicking a task/event drives the navigable DetailPane on the right; files
 * jump to the Files tab. All scoped to the one project. */
function ProjectHome({ onGo }: { onGo: (t: Tab, chatId?: number) => void }) {
  const { selectedProject, setActiveTask, activeTask } = useAppStore();
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [storage, setStorage] = useState<ProjectStorage | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [upcoming, setUpcoming] = useState<Event[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [attachments, setAttachments] = useState<ProjectAttachment[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [openCard, setOpenCard] = useState<HomeCard | null>(null);
  const [updatesCollapsed, toggleUpdates] = useCollapsed('project-home-updates');
  const [timeByTask, setTimeByTask] = useState<Record<number, number> | null>(null);
  const [timeLoading, setTimeLoading] = useState(false);
  const detail = useDetailStack({ scope: 'project-home', onShow: (show) => setDetailHidden(!show) });
  // The right-hand detail pane is collapsible: clicking ✕ saves + hides it
  // (the stack is preserved, so reopening shows the same target). Persisted
  // per-session so the user's preference survives navigation.
  const [detailHidden, setDetailHidden] = useState(true);
  const pid = selectedProject?.id;
  // K2: ids collide across workspaces, so the reload effect must key on the
  // COMPOSITE (workspace:id) — otherwise switching between two hosts' project 5
  // wouldn't re-fire and we'd show the previous host's data on the new host's
  // transport. (selectProject already repointed the transport synchronously.)
  const pkey = selectedProject ? `${selectedProject.workspaceId ?? 'local'}:${selectedProject.id}` : null;

  const reload = () => {
    if (pid == null) return;
    void (async () => {
      try {
        const [s, st, ts, events, ar] = await Promise.all([
          getProjectStats(pid).catch(() => null),
          getProjectStorage(pid).catch(() => null),
          getTasks(pid).catch(() => [] as Task[]),
          getProjectEvents(pid, false).catch(() => [] as Event[]),
          getAreas(pid).catch(() => [] as Area[]),
        ]);
        setStats(s);
        setStorage(st);
        setTasks(ts);
        setAreas(ar);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        setUpcoming(
          [...events]
            .filter((e) => !e.done_at && new Date(e.event_date).getTime() >= today.getTime())
            .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
        );
      } catch {
        /* best-effort summary */
      }
      // Host-only (files + chats); quietly skipped without a daemon.
      if (hasDaemon()) {
        listProjectFiles(pid).then(setFiles).catch(() => setFiles([]));
        listProjectAttachments(pid).then(setAttachments).catch(() => setAttachments([]));
        listChats(pid).then(setChats).catch(() => setChats([]));
      } else {
        setFiles([]);
        setAttachments([]);
        setChats([]);
      }
    })();
  };

  useEffect(() => {
    setTimeByTask(null); // tracked-time is lazy-loaded per project on first open
    setOpenCard(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkey]);

  // Lazily fetch per-task tracked time the first time that pop-up is opened —
  // it's N calls, so we don't pay for it unless asked.
  useEffect(() => {
    if (openCard !== 'time' || timeByTask !== null || tasks.length === 0) return;
    let cancelled = false;
    setTimeLoading(true);
    void (async () => {
      const entries = await Promise.all(
        tasks.map((t) => getTaskTotalTime(t.id).then((secs) => [t.id, secs] as const).catch(() => [t.id, 0] as const))
      );
      if (cancelled) return;
      const map: Record<number, number> = {};
      for (const [id, secs] of entries) map[id] = secs;
      setTimeByTask(map);
      setTimeLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [openCard, timeByTask, tasks]);

  if (!selectedProject) return null;

  const byStatus = stats?.tasks_by_status;
  const total = stats?.total_tasks ?? 0;
  const toggle = (k: HomeCard) => setOpenCard((c) => (c === k ? null : k));
  const close = () => setOpenCard(null);

  const recent = [...tasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  // The "Recent tasks" panel groups by status (so clicking a task can't make it
  // jump around the flat list) and orders each group most-recent first. `recent`
  // is already updated_at-desc, so filtering it preserves that order per group.
  const RECENT_STATUS_ORDER = ['In Progress', 'To Do', 'Blocked', 'Done'];
  const groupedRecent = RECENT_STATUS_ORDER.map((status) => ({
    status,
    color: STATUS_META.find((s) => s.label === status)?.color ?? 'bg-overlay-0',
    items: recent.filter((t) => t.status === status).slice(0, 5),
  })).filter((g) => g.items.length > 0);

  // Combined file view: project files + shared task attachments, largest first.
  const fileRows = [
    ...files.map((f) => ({ key: `f${f.id}`, name: f.file_name, size: f.size_bytes, note: f.rel_path || undefined })),
    ...attachments.map((a) => ({ key: `a${a.id}`, name: a.file_name, size: a.storage_size, note: a.task_title })),
  ].sort((a, b) => b.size - a.size);

  const tasksByTime =
    timeByTask == null
      ? []
      : [...tasks]
          .map((t) => ({ t, secs: timeByTask[t.id] ?? 0 }))
          .filter((x) => x.secs > 0)
          .sort((a, b) => b.secs - a.secs);

  const openTaskDetail = (task: Task) => {
    detail.open({ kind: 'task', task });
    setDetailHidden(false); // show the pane when something is opened
    close();
  };

  return (
    <div className="flex-1 flex min-h-0">
      <ScrollArea className="flex-1 overflow-y-auto bg-mantle">
        <div className="px-8 pt-7 pb-16 flex flex-col gap-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex items-start gap-4">
              <span className={`g-tile lg mt-1.5 ${projectColorClass(selectedProject)}`} aria-hidden="true">
                {projectInitial(selectedProject.name)}
              </span>
              <div className="min-w-0">
              <h1 className="g-ptitle text-text break-words">{selectedProject.name}</h1>
              {selectedProject.description && (
                <p className="mt-2 max-w-[72ch] text-[color:var(--g-fg2)]">{selectedProject.description}</p>
              )}
              </div>
            </div>
            <button
              onClick={() => setDetailHidden((v) => !v)}
              className="g-btn g-btn-ghost g-btn-sm shrink-0"
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

          {/* Interactive infographics: one stats card, each stat opens its pop-up. */}
          <div className="g-card grid grid-cols-2 md:grid-cols-4">
            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'tasks'}
              onToggle={() => toggle('tasks')}
              onClose={close}
              title="Tasks"
              empty={tasks.length === 0}
              tile={
                <Tile
                  active={openCard === 'tasks'}
                  label="Tasks"
                  value={stats ? String(stats.total_tasks) : '—'}
                  sub={byStatus ? `${byStatus.in_progress} in progress` : undefined}
                />
              }
            >
              {recent.map((t) => (
                <PopoverRow
                  key={t.id}
                  primary={t.title}
                  secondary={t.status}
                  mark={statusMark(t.status)}
                  onClick={() => openTaskDetail(t)}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'files'}
              onToggle={() => toggle('files')}
              onClose={close}
              title="Files"
              empty={fileRows.length === 0}
              tile={<Tile active={openCard === 'files'} label="Files" value={stats ? String(stats.total_files) : '—'} />}
            >
              {fileRows.map((f) => (
                <PopoverRow
                  key={f.key}
                  primary={f.name}
                  secondary={`${formatBytes(f.size)}${f.note ? ` · ${f.note}` : ''}`}
                  onClick={() => {
                    onGo('files');
                    close();
                  }}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'storage'}
              onToggle={() => toggle('storage')}
              onClose={close}
              title="Largest files"
              empty={fileRows.length === 0}
              tile={
                <Tile
                  active={openCard === 'storage'}
                  label="Storage"
                  value={storage ? formatBytes(storage.used) : '—'}
                  sub={storage ? `of ${formatBytes(storage.quota)}` : undefined}
                />
              }
            >
              {fileRows.slice(0, 15).map((f) => (
                <PopoverRow
                  key={f.key}
                  primary={f.name}
                  secondary={formatBytes(f.size)}
                  onClick={() => {
                    onGo('files');
                    close();
                  }}
                />
              ))}
            </PopoverShell>

            <PopoverShell
              bare
              className={STAT_CELL}
              active={openCard === 'time'}
              onToggle={() => toggle('time')}
              onClose={close}
              title="Tracked time by task"
              empty={timeByTask !== null && tasksByTime.length === 0}
              tile={<Tile active={openCard === 'time'} label="Tracked time" value={stats ? fmtHours(stats.total_time_seconds) : '—'} />}
            >
              {timeLoading || timeByTask === null ? (
                <p className="px-3 py-4 text-sm text-subtext-0 text-center">Loading…</p>
              ) : (
                tasksByTime.map(({ t, secs }) => (
                  <PopoverRow key={t.id} primary={t.title} secondary={fmtHours(secs)} onClick={() => openTaskDetail(t)} />
                ))
              )}
            </PopoverShell>
          </div>

          {/* Task health */}
          {byStatus && total > 0 && (
            <section className="g-card g-corners px-7 pt-6 pb-5" aria-labelledby="ph-progress">
              <h2 id="ph-progress" className="g-h2">
                Progress <span className="n">{Math.round((byStatus.done / total) * 100)}%</span>
              </h2>
              <div className="flex h-2 rounded overflow-hidden bg-surface-0 gap-0.5">
                {PROGRESS_SEGMENTS.map((s) =>
                  byStatus[s.key] > 0 ? (
                    <span
                      key={s.key}
                      className="block h-full"
                      style={{ width: `${(byStatus[s.key] / total) * 100}%`, background: s.color }}
                      title={`${s.label}: ${byStatus[s.key]}`}
                    />
                  ) : null
                )}
              </div>
              <div className="flex flex-wrap justify-center gap-x-6 gap-y-1.5 mt-3.5 text-[13px] text-[color:var(--g-fg2)]">
                {LEGEND.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-2">
                    <span className={statusMark(s.label)} aria-hidden="true" />
                    {s.label} <span className="text-text tabular-nums">{byStatus[s.key]}</span>
                  </span>
                ))}
              </div>
            </section>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['tasks', 'files', 'events', 'chats'] as Tab[]).map((t) => {
              const meta = TABS.find((x) => x.id === t)!;
              return (
                <button key={t} onClick={() => onGo(t)} className="g-btn g-btn-gilt min-h-12">
                  <TabIcon name={meta.icon} />
                  Open {meta.label}
                </button>
              );
            })}
          </div>

          {/* Recent tasks, upcoming events and conversations: side by side,
              stacked when narrow, a third column on wide windows. */}
          <div className="grid gap-6 items-start grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))]">
            <section className="g-card px-3 pt-6 pb-3" aria-labelledby="ph-recent">
              <h2 id="ph-recent" className="g-h2">Recent tasks</h2>
              {groupedRecent.length === 0 ? (
                <p className="text-sm text-center text-[color:var(--g-mut)] mb-3">No tasks yet.</p>
              ) : (
                <div className="space-y-3">
                  {groupedRecent.map((g) => (
                    <div key={g.status}>
                      <div className="g-deco flex items-center gap-2 px-3.5 mb-1 text-[10px] font-semibold text-[color:var(--g-mut)]">
                        {g.status}
                        <span className="tracking-[0.04em]">{g.items.length}</span>
                      </div>
                      {g.items.map((t) => {
                        const due = dueTag(t.deadline, t.status);
                        return (
                          <button
                            key={t.id}
                            onClick={() => { detail.open({ kind: 'task', task: t }); setDetailHidden(false); }}
                            onDoubleClick={(e) => { e.stopPropagation(); setActiveTask(t); }}
                            title="Double-click to set as the active task"
                            className={`w-full text-left flex items-center gap-3 min-h-11 px-3.5 rounded hover:bg-surface-0 ${
                              activeTask?.id === t.id ? 'shadow-[inset_0_0_0_1px_var(--color-success)]' : ''
                            }`}
                          >
                            <span className={statusMark(t.status)} title={t.status} />
                            <span className={`flex-1 min-w-0 truncate text-sm font-medium ${t.status === 'Done' ? 'text-overlay-0 line-through' : 'text-text'}`}>
                              {t.title}
                            </span>
                            {due && (
                              <span className={`shrink-0 text-xs ${due.late ? 'text-error font-semibold' : 'text-[color:var(--g-mut)]'}`}>{due.label}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              <div className="text-center">
                <button onClick={() => onGo('tasks')} className="g-lnk">View all →</button>
              </div>
            </section>

            <section className="g-card px-6 pt-6 pb-3" aria-labelledby="ph-events">
              <h2 id="ph-events" className="g-h2">Upcoming events</h2>
              {upcoming.length === 0 ? (
                <p className="text-sm text-center text-[color:var(--g-mut)] mb-3">Nothing scheduled.</p>
              ) : (
                <div>
                  {upcoming.slice(0, 5).map((e) => {
                    const d = new Date(e.event_date);
                    return (
                      <button
                        key={e.id}
                        onClick={() => { detail.open({ kind: 'event', event: e }); setDetailHidden(false); }}
                        className="w-full text-left flex items-center gap-3.5 min-h-12 border-t border-gilt-b hover:bg-surface-0"
                      >
                        <span className="shrink-0 w-14 text-center">
                          <span className="g-deco block text-[10px] text-[color:var(--g-mut)]">
                            {d.toLocaleDateString('en-US', { month: 'short' })}
                          </span>
                          <span className="block font-deco text-xl leading-none text-text">{d.getDate()}</span>
                        </span>
                        <span className="flex-1 min-w-0 truncate text-sm font-medium text-text">{e.title}</span>
                        {!e.all_day && e.start_time && (
                          <span className="shrink-0 pr-2 text-[13px] tabular-nums text-[color:var(--g-mut)]">{e.start_time.slice(0, 5)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="text-center">
                <button onClick={() => onGo('events')} className="g-lnk">Calendar →</button>
              </div>
            </section>

            {/* Conversations with this project's assistant */}
            {hasDaemon() && (
              <section className="g-card px-6 pt-6 pb-3" aria-labelledby="ph-chats">
                <h2 id="ph-chats" className="g-h2">Conversations</h2>
                {chats.length === 0 ? (
                  <p className="text-sm text-center text-[color:var(--g-mut)] mb-3">No conversations yet.</p>
                ) : (
                  <div>
                    {chats.slice(0, 8).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => onGo('chats', c.id)}
                        className="w-full text-left flex items-center gap-3 min-h-11 px-1 border-t border-gilt-b hover:bg-surface-0"
                      >
                        <span className="text-base shrink-0" aria-hidden="true">🤖</span>
                        <span className="text-sm font-medium text-text truncate flex-1">{c.title || 'Untitled chat'}</span>
                        <span className="text-xs text-[color:var(--g-mut)] shrink-0 pr-1">
                          {new Date(c.updated_at).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-center">
                  <button onClick={() => onGo('chats')} className="g-lnk">Open assistant →</button>
                </div>
              </section>
            )}
          </div>

          {/* Updates — the project comment board, latest few. Collapsible
              (remembered); collapsed = not mounted = nothing fetched. */}
          <section className="g-card px-[26px] pt-[22px] pb-4" aria-label="Updates">
            <SectionToggle
              label="Updates"
              collapsed={updatesCollapsed}
              onToggle={toggleUpdates}
              action={
                <button onClick={() => onGo('comments')} className="g-lnk text-[13px] min-h-[32px] px-2">
                  Open the board →
                </button>
              }
            />
            <div className={FEED_COLUMN}>
              {updatesCollapsed ? <CollapsedNote label="Updates" onShow={toggleUpdates} /> : <CommentBoard
                key={pkey ?? 'none'}
                api={activeBoardApi}
                projectId={selectedProject.id}
                tasks={tasks}
                areas={areas}
                variant="compact"
                pageSize={5}
                onMore={() => onGo('comments')}
                onTaskClick={(id) => {
                  const t = tasks.find((x) => x.id === id);
                  if (t) openTaskDetail(t);
                }}
              />}
            </div>
          </section>
        </div>
      </ScrollArea>

      {/* Right panel — navigable detail of whatever was clicked. Collapsible:
          ✕ saves + hides the pane; a reopen tab on the right edge brings it
          back with the same stack. */}
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
          onChanged={reload}
          onClose={() => setDetailHidden(true)}
          emptyHint="Click a task or event to preview it here — linked items stay navigable with the ‹ › buttons."
        />
      </ResizablePane>
    </div>
  );
}

/** A project page with tabs. Wraps the existing board and the new Files tab. */
function ProjectView() {
  const { selectedProject, commentBoardIntent } = useAppStore();
  // K2 composite key — re-run project-scoped effects when switching across
  // same-id projects on different hosts (a bare id wouldn't change).
  const pkey = selectedProject ? `${selectedProject.workspaceId ?? 'local'}:${selectedProject.id}` : null;
  // Defaults to 'home' on first mount (i.e. when entering project view from
  // elsewhere). Deliberately NOT reset on selectedProject change, so switching
  // between projects in the sidebar keeps you on the same tab (e.g. Tasks).
  // A pending pin or back/forward intent for this project picks the first tab, so
  // the page doesn't flash Home (or record Home in the history) first.
  const [tab, setTab] = useState<string>(() => {
    const i = usePins.getState().openIntent;
    return i && i.projectKey === pkey ? i.tab : 'home';
  });
  // "Open the board" from Home → this project's Comments tab (CommentsTab
  // consumes the intent's task filter and clears it).
  useEffect(() => {
    if (commentBoardIntent && commentBoardIntent.projectKey === pkey) setTab('comments');
  }, [commentBoardIntent, pkey]);
  // A pinned tab opened from the top bar (or its own window) → that tab. When it is
  // already open but the pin switched its sub-view, remount the panel to pick it up.
  const openIntent = usePins((s) => s.openIntent);
  const [panelNonce, setPanelNonce] = useState(0);
  useEffect(() => {
    if (!openIntent || openIntent.projectKey !== pkey) return;
    if (openIntent.remount && openIntent.tab === tab) setPanelNonce((n) => n + 1);
    setTab(openIntent.tab);
    usePins.getState().setOpenIntent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIntent, pkey]);
  // Which tab is on screen, for the top bar's active pin.
  useEffect(() => {
    usePins.getState().setCurrentTab(pkey ? { projectKey: pkey, tab } : null);
    // The app's back/forward history (a no-op in a pinned tab's own window).
    if (pkey) useNav.getState().visitTab(pkey, tab);
  }, [pkey, tab]);
  useEffect(() => () => {
    usePins.getState().setCurrentTab(null);
    forgetTab();
  }, []);
  const pins = usePins((s) => s.pins);
  const catalog = usePins((s) => s.catalog);
  const wsId = selectedProject?.workspaceId ?? LOCAL_ID;
  const pinRef = (tabId: string) => ({ ws: wsId, project: selectedProject?.id ?? 0, tab: tabId });
  const togglePin = (tabId: string) => {
    if (!selectedProject) return;
    const ref = pinRef(tabId);
    if (isPinned(pins, ref)) void usePins.getState().unpin(ref);
    else void usePins.getState().pin(ref, readSubView(tabId));
  };
  const openTabWindow = async (tabId: string) => {
    if (!selectedProject) return;
    const pin = { ...pinRef(tabId), sub: readSubView(tabId), position: 0 };
    const ok = await openPinnedTabWindow(pin, `${labelOf(pin, catalog)} \u2014 ${selectedProject.name}`);
    if (!ok) notify({ kind: 'info', title: 'This client cannot open windows' });
  };
  const tabMenu = useContextMenu();
  // A chat to deep-link into when the user clicks a conversation on the Home tab.
  const [pendingChatId, setPendingChatId] = useState<number | undefined>(undefined);
  const goTab = (t: Tab, chatId?: number) => {
    setTab(t);
    if (chatId != null) setPendingChatId(chatId);
  };

  // Stash tabs: which exist is the host's compiled-in registry; which show
  // here is this project's enablement (Project Settings → Tabs).
  const [availableTabs, setAvailableTabs] = useState<TabDescriptor[]>([]);
  const [enabledTabIds, setEnabledTabIds] = useState<string[]>([]);
  // The project whose enablement `enabledTabIds` holds (null until the first answer), so
  // a tab opened before it arrives (a pin) isn't sent back to Home by the stale list.
  const [tabsFor, setTabsFor] = useState<string | null>(null);
  const [availableLoaded, setAvailableLoaded] = useState(!hasDaemon());
  useEffect(() => {
    if (hasDaemon()) listAvailableTabs().then(setAvailableTabs).catch(() => {}).finally(() => setAvailableLoaded(true));
  }, []);
  useEffect(() => {
    const k = pkey;
    if (selectedProject && hasDaemon()) {
      getProjectTabs(selectedProject.id)
        .then((ids) => { setEnabledTabIds(ids); setTabsFor(k); })
        .catch(() => { setEnabledTabIds([]); setTabsFor(k); });
    } else {
      setEnabledTabIds([]);
      setTabsFor(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkey]); // composite — re-fetch tabs when switching across same-id hosts
  const stashTabs = availableTabs.filter((t) => enabledTabIds.includes(t.id) && TAB_PANELS[t.id]);
  // The unified tab list (built-in + enabled stash), ordered by the user's
  // drag-reorder preference (localStorage). Tabs not in the saved order append
  // in their default position — so a newly-enabled tab appears at the end
  // without breaking the saved order.
  // Drag-to-reorder: bumping orderNonce forces allTabEntries to re-read the
  // saved tab order from localStorage after a drag.
  const [orderNonce, setOrderNonce] = useState(0);
  const allTabEntries: TabEntry[] = useMemo(() => {
    const builtins: TabEntry[] = TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon }));
    const stash: TabEntry[] = stashTabs.map((t) => ({ id: t.id, label: t.name, icon: stashTabIcon(t), description: t.description, stash: true }));
    const saved = loadTabOrder(selectedProject?.id ?? null);
    const all = [...builtins, ...stash];
    // Sort by saved order; unsaved tabs go last in their natural order.
    const orderIdx = (id: string) => {
      const i = saved.indexOf(id);
      return i >= 0 ? i : 999;
    };
    return [...all].sort((a, b) => orderIdx(a.id) - orderIdx(b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stashTabs, selectedProject?.id, orderNonce]);
  const reorderTab = (draggedId: string, targetId: string) => {
    const saved = loadTabOrder(selectedProject?.id ?? null);
    const order = saved.length ? [...saved] : allTabEntries.map((t) => t.id);
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, draggedId);
    saveTabOrder(selectedProject?.id ?? null, order);
    setOrderNonce((n) => n + 1); // force allTabEntries to re-read
  };
  // Tab bar scroll: arrows appear when the tab strip overflows.
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const updateScrollState = () => {
    const el = tabStripRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  useEffect(() => {
    updateScrollState();
  }, [allTabEntries.length]);
  // …and when the window (or the sidebar) resizes the strip, so the arrows
  // show whenever tabs are hidden, at any width.
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject == null]);
  const scrollTabs = (dir: 'left' | 'right') => {
    const el = tabStripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -200 : 200, behavior: 'smooth' });
  };
  // Drag-to-reorder state. Pointer-based (not HTML5 DnD) — WKWebView's
  // onDragOver/onDrop are unreliable. We track the dragged tab id + the tab
  // under the cursor; on pointerup we swap.
  const [dragTab, setDragTab] = useState<{ id: string; x: number } | null>(null);
  const dragTabRef = useRef<typeof dragTab>(null);
  dragTabRef.current = dragTab;
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  // Switching to a project without the currently open stash tab → back to Home.
  useEffect(() => {
    if (tabsFor !== pkey || !availableLoaded) return; // not known yet
    if (!TABS.some((t) => t.id === tab) && !stashTabs.some((t) => t.id === tab)) setTab('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledTabIds, availableTabs, availableLoaded, tabsFor]);
  const ActivePanel = stashTabs.some((t) => t.id === tab) ? TAB_PANELS[tab] : null;

  // The ＋ picker at the end of the tab bar: enable/disable tabs in place
  // (same data as Project Settings → Tabs). Optimistic, rolled back if the
  // host refuses (e.g. the caller isn't a project admin).
  const [showTabPicker, setShowTabPicker] = useState(false);
  const tabPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showTabPicker) return;
    const onDown = (e: MouseEvent) => {
      if (tabPickerRef.current && !tabPickerRef.current.contains(e.target as Node)) setShowTabPicker(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showTabPicker]);
  const toggleStashTab = async (tabId: string, enabled: boolean) => {
    if (!selectedProject) return;
    const prev = enabledTabIds;
    setEnabledTabIds(enabled ? [...prev, tabId] : prev.filter((t) => t !== tabId));
    try {
      await setProjectTab(selectedProject.id, tabId, enabled);
      // The host dropped everyone's pins to a disabled tab; forget ours here too.
      if (!enabled) usePins.getState().drop(wsId, selectedProject.id, tabId);
    } catch {
      setEnabledTabIds(prev);
      alert('Could not change tabs — only project admins can.');
    }
  };

  if (!selectedProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-subtext-0">
        Select a project to get started.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Tab bar — scrollable with arrows; drag to reorder; + pinned right */}
      {/* z-20: above the tab content (z-10) but BELOW the header dropdowns
          (search / notifications / calendar, all z-50 in the header's stacking
          context). The nav used to be z-50, which tied with the header dropdowns
          and — being later in the DOM — covered them when they opened downward. */}
      <nav className="flex items-stretch border-b border-gilt-b bg-mantle relative z-20">
        {canScrollLeft && (
          <button
            onClick={() => scrollTabs('left')}
            className="w-8 flex items-center justify-center text-[color:var(--g-mut)] hover:text-text shrink-0"
            title="Scroll tabs left"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        <div
          ref={tabStripRef}
          onScroll={updateScrollState}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-none"
        >
          {/* w-max + mx-auto: centred while the tabs fit, scrolled from the
              left edge (never clipped) once they don't. */}
          <div className="flex items-stretch gap-0.5 w-max mx-auto px-1">
          {allTabEntries.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              onContextMenu={(e) => {
                const pinned = isPinned(pins, pinRef(t.id));
                tabMenu.open(e, [
                  { label: pinned ? 'Unpin from the top bar' : 'Pin to the top bar', icon: <PinGlyph className="block w-4 h-4" />, onClick: () => togglePin(t.id) },
                  { label: 'Open in new window', icon: '↗', onClick: () => void openTabWindow(t.id) },
                ]);
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setDragTab({ id: t.id, x: e.clientX });
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = dragTabRef.current;
                if (!d) return;
                const el = document.elementFromPoint(e.clientX, e.clientY);
                const btn = el?.closest('button[data-tab-id]') as HTMLElement | null;
                const overId = btn?.getAttribute('data-tab-id');
                setDragOverTab(overId && overId !== d.id ? overId : null);
                setDragTab({ ...d, x: e.clientX });
              }}
              onPointerUp={(e) => {
                const d = dragTabRef.current;
                if (d && dragOverTab && d.id !== dragOverTab) reorderTab(d.id, dragOverTab);
                setDragTab(null);
                setDragOverTab(null);
                try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
              }}
              data-tab-id={t.id}
              title={t.description}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`min-h-[42px] px-4 inline-flex items-center whitespace-nowrap font-sans text-sm font-medium transition-colors shrink-0 cursor-grab active:cursor-grabbing touch-none select-none ${
                tab === t.id
                  ? 'text-gold shadow-[inset_0_-2px_0_var(--color-gold)]'
                  : 'text-[color:var(--g-fg2)] hover:text-text'
              } ${dragTab?.id === t.id ? 'opacity-40' : ''} ${dragOverTab === t.id ? 'bg-gilt-b' : ''}`}
            >
              <TabIcon name={t.icon} className="w-4 h-4 mr-2" />
              {t.label}
              {isPinned(pins, pinRef(t.id)) && (
                <PinGlyph filled className="inline-block w-3 h-3 ml-1 -mt-0.5 text-gold/80" title="Pinned to the top bar" />
              )}
            </button>
          ))}
          </div>
        </div>
        {canScrollRight && (
          <button
            onClick={() => scrollTabs('right')}
            className="w-8 flex items-center justify-center text-[color:var(--g-mut)] hover:text-text shrink-0"
            title="Scroll tabs right"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        )}
        {(() => {
          const pinned = isPinned(pins, pinRef(tab));
          const name = allTabEntries.find((t) => t.id === tab)?.label ?? tab;
          return (
            <button
              onClick={() => togglePin(tab)}
              title={pinned ? `Unpin ${name} from the top bar` : `Pin ${name} to the top bar, to reach it from any project`}
              aria-label={pinned ? `Unpin ${name} from the top bar` : `Pin ${name} to the top bar`}
              aria-pressed={pinned}
              className={`w-9 flex items-center justify-center shrink-0 ${pinned ? 'text-gold' : 'text-[color:var(--g-mut)] hover:text-text'}`}
            >
              <PinGlyph filled={pinned} className="w-4 h-4" />
            </button>
          );
        })()}
        {tabMenu.element}
        {hasDaemon() && availableTabs.length > 0 && (
          <div className="relative shrink-0 flex" ref={tabPickerRef}>
            <button
              onClick={() => setShowTabPicker((v) => !v)}
              title="Add or remove tabs for this project"
              aria-expanded={showTabPicker}
              className={`w-10 flex items-center justify-center text-sm ${showTabPicker ? 'text-gold' : 'text-[color:var(--g-mut)] hover:text-text'}`}
            >
              ＋
            </button>
            {showTabPicker && (
              <div className="g-card absolute right-0 top-full mt-1 w-80 max-h-[70vh] overflow-y-auto shadow-xl z-50 p-3 space-y-1">
                <div className="g-deco px-2 pt-1 pb-1 text-[11px] font-semibold text-gold">Tabs for this project</div>
                {availableTabs.map((t) => (
                  <label key={t.id} className="flex items-start gap-2.5 p-2 rounded hover:bg-gilt-b cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enabledTabIds.includes(t.id)}
                      onChange={(e) => toggleStashTab(t.id, e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="text-sm text-text">
                        <TabIcon name={stashTabIcon(t)} className="inline-block align-middle -mt-0.5 mr-1.5 w-4 h-4 text-[color:var(--g-mut)]" />
                        {t.name}
                        {t.has_tools && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">agent tools</span>}
                      </span>
                      <span className="block text-xs text-[color:var(--g-mut)]">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Active tab. z-10 so the nav (z-20) and its popover paint above it. */}
      <div className="flex-1 overflow-hidden flex relative z-10">
        {tab === 'home' && <ProjectHome onGo={goTab} />}
        {tab === 'tasks' && <TaskList />}
        {tab === 'comments' && <CommentsTab />}
        {tab === 'files' && <FilesTab />}
        {tab === 'events' && <CalendarView scopeProjectId={selectedProject.id} />}
        {tab === 'reports' && <ReportGenerator projectId={selectedProject.id} />}
        {tab === 'chats' && <ChatView scopeProjectId={selectedProject.id} initialChatId={pendingChatId} />}
        {tab === 'members' && <MembersTab projectId={selectedProject.id} />}
        {ActivePanel && (
          <TabErrorBoundary key={`${tab}:${pkey ?? selectedProject.id}:${panelNonce}`}>
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-subtext-0 text-sm">Loading…</div>}>
              <ActivePanel projectId={selectedProject.id} />
            </Suspense>
          </TabErrorBoundary>
        )}
      </div>
    </div>
  );
}

// Memoised: App re-renders (the top bar's fit, dialogs) don't reach it.
export default memo(ProjectView);
