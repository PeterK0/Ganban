import { useEffect, useMemo, useRef, useState } from 'react';
import { getTasks, updateTaskStatus, getAreas, getProjectAssignees, archiveTask, getProjectCommentBoard } from '../lib/api';
import { hasDaemon, listProjectAttachments } from '../lib/daemon';
import { useAppStore } from '../store/appStore';
import { useDataPulse } from '../lib/livePulse';
import DetailPane, { useDetailStack } from '../components/DetailPane';
import ScrollArea from '../components/ScrollArea';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import { openTaskWindow } from '../lib/windows';
import type { Task, TaskStatus, Area, ProjectAssignee } from '../types';
import { assigneeKey } from '../types';
import TaskVisibilityBadge from '../components/TaskVisibilityBadge';
import { ResizablePane } from '../components/gilt';
import { areaGem, dueTag, statusMark } from '../components/taskMarks';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'To Do', label: 'To Do' },
  { status: 'In Progress', label: 'In Progress' },
  { status: 'Blocked', label: 'Blocked' },
  { status: 'Done', label: 'Done' },
];

const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

type CardField = 'priority' | 'area' | 'prefix' | 'deadline' | 'cost' | 'assignees';
const FIELD_LABELS: Record<CardField, string> = {
  priority: 'Priority',
  area: 'Area',
  prefix: 'Prefix',
  deadline: 'Deadline',
  cost: 'Cost',
  assignees: 'Assignees',
};
const ALL_FIELDS: CardField[] = ['priority', 'area', 'prefix', 'deadline', 'cost', 'assignees'];
const CARD_FIELDS_KEY = 'ganban:kanban-card-fields';

function loadCardFields(): Set<CardField> {
  try {
    const raw = localStorage.getItem(CARD_FIELDS_KEY);
    if (raw) return new Set(JSON.parse(raw) as CardField[]);
  } catch { /* ignore */ }
  return new Set<CardField>(['priority', 'area', 'prefix', 'deadline', 'assignees']);
}
function saveCardFields(fields: Set<CardField>): void {
  localStorage.setItem(CARD_FIELDS_KEY, JSON.stringify([...fields]));
}

function fmtCost(cost?: number, currency?: string): string {
  if (cost == null) return '';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  return `${sym}${cost.toLocaleString()}`;
}

/** A Kanban board for one project's tasks. Drag a card between columns to
 * change its status; click a card to open it in a slide-out detail pane.
 *
 * Drag is pointer-based (pointerdown → pointermove → pointerup), NOT HTML5
 * draggable. HTML5 drag-and-drop is unreliable in Tauri's WKWebView —
 * onDragOver/onDrop silently don't fire, so the drop target never highlights
 * and the card never moves. Pointer events work identically in every webview
 * and also support touch. The trade-off is we build the drag affordance
 * ourselves (a floating ghost + drop detection via elementFromPoint). */
export default function KanbanTab({ projectId }: { projectId: number }) {
  const { selectTask, setActiveTask, activeTask } = useAppStore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  // task_id → assignees, fetched in ONE call (never N+1 from the board).
  const [assigneesByTask, setAssigneesByTask] = useState<Map<number, ProjectAssignee[]>>(new Map());
  // Per-task counts for the card footers: updates tagged with the task (the
  // comment board's task_counts) and its attachments. One call each, best-effort.
  const [commentCounts, setCommentCounts] = useState<Map<number, number>>(new Map());
  const [fileCounts, setFileCounts] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const detail = useDetailStack({ scope: 'kanban', onShow: (show) => setDetailOpen(show) });
  const loadId = useRef(0);

  const [cardFields, setCardFields] = useState<Set<CardField>>(loadCardFields);
  const [showCardSettings, setShowCardSettings] = useState(false);
  const cardSettingsRef = useRef<HTMLDivElement | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const menu = useContextMenu();

  /** Right-click a card: everything you'd otherwise drag/double-click for. */
  const cardMenu = (task: Task): MenuItem[] => [
    { label: 'Open', icon: '↗', onClick: () => openTask(task) },
    { label: 'Open in new window', icon: '⧉', onClick: () => void openTaskWindow(task.id, task.project_id, task.title) },
    { label: 'Set as active task', icon: '⏱', onClick: () => setActiveTask(task) },
    {
      label: 'Move to', icon: '➜',
      children: COLUMNS.filter((c) => c.status !== task.status).map((c) => ({
        label: c.label,
        onClick: () => void moveTask(task.id, c.status),
      })),
    },
    { label: 'Archive', icon: '🗄', danger: true, divider: true, onClick: () => void archiveTask(task.id, true).then(load) },
  ];

  // Pointer-drag state. `drag` is null when idle; when set, a card is being
  // dragged and we track its position + the column under the cursor.
  const [drag, setDrag] = useState<{
    taskId: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    overStatus: TaskStatus | null;
  } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  dragRef.current = drag;
  // The board's scroll is now handled by the ScrollArea component (custom
  // themed scrollbar — native scrollbars are hidden globally because
  // WKWebView's ::-webkit-scrollbar-track is broken).
  const suppressClick = useRef(false);

  const load = async () => {
    const seq = ++loadId.current;
    try {
      const rows = await getTasks(projectId, false);
      if (seq === loadId.current) { setTasks(rows); setError(null); }
    } catch (e) {
      if (seq === loadId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadId.current) setLoading(false);
    }
    // Assignee chips ride the same load (older hosts: quietly none).
    try {
      const rows = await getProjectAssignees(projectId);
      if (seq === loadId.current) {
        const map = new Map<number, ProjectAssignee[]>();
        for (const r of rows) {
          const list = map.get(r.task_id) ?? [];
          list.push(r);
          map.set(r.task_id, list);
        }
        setAssigneesByTask(map);
      }
    } catch {
      if (seq === loadId.current) setAssigneesByTask(new Map());
    }
  };

  // Card footer counts: on mount and when comments/files change, not on every
  // reload. A failed read keeps the last counts rather than flashing zeros.
  const countsId = useRef(0);
  const loadCounts = () => {
    const seq = ++countsId.current;
    void getProjectCommentBoard(projectId, { limit: 1 })
      .then((b) => { if (seq === countsId.current) setCommentCounts(new Map(b.task_counts.map((c) => [c.task_id, c.count]))); })
      .catch(() => {});
    if (hasDaemon()) {
      void listProjectAttachments(projectId)
        .then((rows) => {
          if (seq !== countsId.current) return;
          const m = new Map<number, number>();
          for (const r of rows) m.set(r.task_id, (m.get(r.task_id) ?? 0) + 1);
          setFileCounts(m);
        })
        .catch(() => {});
    }
  };

  useEffect(() => {
    void load();
    setCommentCounts(new Map());
    setFileCounts(new Map());
    loadCounts();
    getAreas(projectId).then(setAreas).catch(() => setAreas([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useDataPulse(() => void load(), ['tasks', 'comments', 'time', 'files']);
  useDataPulse(() => loadCounts(), ['comments', 'files']);

  useEffect(() => {
    if (!showCardSettings) return;
    const onDown = (e: MouseEvent) => {
      if (cardSettingsRef.current && !cardSettingsRef.current.contains(e.target as Node)) setShowCardSettings(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showCardSettings]);

  const areaName = (id?: number) => areas.find((a) => a.id === id)?.name;

  const byColumn = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = { 'To Do': [], 'In Progress': [], Blocked: [], Done: [] };
    for (const t of tasks) map[t.status]?.push(t);
    for (const col of COLUMNS) {
      map[col.status].sort((a, b) => {
        const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
        if (pr !== 0) return pr;
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (da !== db) return da - db;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [tasks]);

  const moveTask = async (taskId: number, to: TaskStatus) => {
    const prev = tasks;
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status: to } : t)));
    try {
      const updated = await updateTaskStatus(taskId, to);
      setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status: updated.status } : t)));
    } catch (e) {
      setTasks(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Single click opens the task in the slide-out detail pane (the standard
  // Kanban UX — click a card to see/edit it). suppressClick guards against
  // the click that fires after a real drag (set in onCardPointerMove when the
  // threshold is crossed).
  const openTask = (task: Task) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    selectTask(task);
    detail.open({ kind: 'task', task });
    setDetailOpen(true);
  };

  const toggleField = (field: CardField) => {
    setCardFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field); else next.add(field);
      saveCardFields(next);
      return next;
    });
  };

  // --- Pointer-based drag with a movement threshold ---
  // A drag only starts after the pointer moves > DRAG_THRESHOLD pixels from
  // its down position. Below that, it's a click (select the task). Without the
  // threshold, every pointerdown immediately captures + suppresses the click,
  // so you can't select a task — and the OS text-selection drag fires too.
  // The down position is stashed in a ref; move computes the delta.
  const DRAG_THRESHOLD = 5;
  const downRef = useRef<{ taskId: number; x: number; y: number; offsetX: number; offsetY: number; pointerId: number; target: HTMLElement } | null>(null);

  const onCardPointerDown = (e: React.PointerEvent, task: Task) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Stash the down position; don't start the drag yet. Capture the pointer so
    // we get the move/up even if the cursor leaves the card.
    downRef.current = {
      taskId: task.id,
      x: e.clientX,
      y: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
      target: e.currentTarget as HTMLElement,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const down = downRef.current;
    const d = dragRef.current ?? down;
    if (!d) return;
    // If we have a down but not yet a drag, check the threshold.
    if (!dragRef.current) {
      const dx = e.clientX - down!.x;
      const dy = e.clientY - down!.y;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      // Crossed the threshold — commit to the drag. suppressClick so the
      // upcoming click (browsers fire click after pointerup) doesn't also open.
      suppressClick.current = true;
      // preventDefault on the move that commits stops the browser from starting
      // a native text-selection drag on the card's content.
      e.preventDefault();
      setDrag({
        taskId: down!.taskId,
        x: e.clientX,
        y: e.clientY,
        offsetX: down!.offsetX,
        offsetY: down!.offsetY,
        overStatus: tasks.find((t) => t.id === down!.taskId)?.status ?? null,
      });
      downRef.current = null;
    } else {
      // Active drag — preventDefault every move to keep killing the native
      // selection/scroll that WKWebView otherwise starts on pointer drags.
      e.preventDefault();
    }
    // Now drag is non-null — update the ghost + detect the column under cursor.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let status: TaskStatus | null = null;
    let node: Element | null = el;
    while (node) {
      if (node.getAttribute && node.getAttribute('data-col-status')) {
        status = node.getAttribute('data-col-status') as TaskStatus;
        break;
      }
      node = node.parentElement;
    }
    setDrag((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY, overStatus: status } : prev);
  };

  const onCardPointerUp = (e: React.PointerEvent) => {
    downRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const d = dragRef.current;
    if (!d) {
      // No drag started (movement stayed under threshold) → it was a click.
      // Don't suppress — let the onClick handler fire to select the task.
      return;
    }
    // A drag happened — commit the move.
    const task = tasks.find((t) => t.id === d.taskId);
    if (task && d.overStatus && d.overStatus !== task.status) {
      void moveTask(d.taskId, d.overStatus);
    }
    setDrag(null);
  };

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-subtext-0 text-sm">Loading board…</div>;
  }

  const draggedTask = drag ? tasks.find((t) => t.id === drag.taskId) : null;

  return (
    <div className={`flex-1 flex min-h-0 overflow-hidden relative ${drag ? 'select-none' : ''}`} style={drag ? { userSelect: 'none', WebkitUserSelect: 'none' } : undefined}>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Board toolbar */}
        {/* z-20: above the board (z-10) but below the header dropdowns (z-50). */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gilt-b bg-mantle shrink-0 relative z-20">
          <div className="relative" ref={cardSettingsRef}>
            <button
              onClick={() => setShowCardSettings((v) => !v)}
              aria-expanded={showCardSettings}
              className={`g-btn g-btn-ghost g-btn-sm ${showCardSettings ? '!text-gold !shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''}`}
              title="Choose which fields to show on cards"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
              Card fields
            </button>
            {showCardSettings && (
              <div className="g-card absolute left-0 top-full mt-1 w-52 shadow-xl z-50 p-3 space-y-0.5">
                <div className="g-deco px-2 pb-1.5 text-[11px] font-semibold text-gold">Show on cards</div>
                {ALL_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-2 px-2 min-h-8 rounded hover:bg-gilt-b cursor-pointer text-sm text-text">
                    <input type="checkbox" checked={cardFields.has(f)} onChange={() => toggleField(f)} />
                    {FIELD_LABELS[f]}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setDetailOpen((v) => !v)}
            className="g-btn g-btn-ghost g-btn-sm"
            title={detailOpen ? 'Hide the detail pane' : 'Show the detail pane'}
          >
            {detailOpen ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            )}
            {detailOpen ? 'Hide editor' : 'Show editor'}
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 px-3 py-2 bg-error/10 border border-error/30 text-error rounded text-sm">{error}</div>
        )}

        <ScrollArea direction="horizontal" className="flex-1 bg-mantle">
          {/* Four columns that share the width (wider on an ultrawide) and
              scroll sideways once they'd drop below 16rem each. */}
          <div
            className="grid gap-3.5 px-5 py-4 h-full"
            style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(16rem, 1fr))`, minWidth: `calc(${COLUMNS.length} * 16rem + ${COLUMNS.length - 1} * 0.875rem + 2.5rem)` }}
          >
            {COLUMNS.map((col) => {
              const rows = byColumn[col.status];
              const isDropTarget = drag?.overStatus === col.status;
              return (
                <section
                  key={col.status}
                  data-col-status={col.status}
                  aria-label={col.label}
                  className={`min-w-0 min-h-0 flex flex-col rounded border transition-colors ${isDropTarget ? 'border-gold bg-gilt-b' : 'border-gilt-b bg-crust'}`}
                >
                  <div className="flex items-center justify-center gap-2 px-3 pt-3 pb-2 g-deco text-xs font-semibold tracking-[0.18em] text-[color:var(--g-fg2)]">
                    <span className={statusMark(col.status)} aria-hidden="true" />
                    <h3 className="pt-px">{col.label}</h3>
                    <span className="tracking-normal tabular-nums text-[color:var(--g-mut)]">{rows.length}</span>
                  </div>
                  <ScrollArea className="flex-1 min-h-0" contentClassName="px-3 pb-3 pt-1 space-y-2.5">
                    {isDropTarget && rows.length === 0 && (
                      <div className="flex items-center justify-center py-8 border border-dashed border-gold/60 rounded text-gold text-xs">
                        Drop here
                      </div>
                    )}
                    {!isDropTarget && rows.length === 0 && (
                      <p className="text-center text-[13px] text-[color:var(--g-mut)] py-6">Drag a task here</p>
                    )}
                    {rows.map((task) => {
                      const isDragging = drag?.taskId === task.id;
                      const due = cardFields.has('deadline') ? dueTag(task.deadline, task.status) : null;
                      const selected = detailOpen && detail.current?.kind === 'task' && detail.current.task.id === task.id;
                      const people = cardFields.has('assignees') ? (assigneesByTask.get(task.id) ?? []) : [];
                      const nCom = commentCounts.get(task.id) ?? 0;
                      const nFiles = fileCounts.get(task.id) ?? 0;
                      const area = cardFields.has('area') && task.area_id ? areaName(task.area_id) : undefined;
                      const pri = cardFields.has('priority') && task.priority !== 'Medium';
                      const hasTags = pri || area || (cardFields.has('prefix') && task.prefix) || due || (cardFields.has('cost') && task.cost != null);
                      return (
                        <div
                          key={task.id}
                          onPointerDown={(e) => onCardPointerDown(e, task)}
                          onPointerMove={onCardPointerMove}
                          onPointerUp={onCardPointerUp}
                          onClick={() => openTask(task)}
                          onDoubleClick={() => setActiveTask(task)}
                          onContextMenu={(e) => menu.open(e, cardMenu(task))}
                          className={`flex flex-col gap-2.5 px-3.5 py-3 rounded bg-base border cursor-pointer transition-colors touch-none select-none ${
                            selected ? 'border-gilt-a outline outline-1 outline-gilt-b -outline-offset-[5px]' : 'border-surface-0 hover:border-surface-1'
                          } ${isDragging ? 'opacity-30' : ''} ${activeTask?.id === task.id ? 'shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-success)_45%,transparent)]' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            <p className={`text-sm font-medium leading-snug break-words flex-1 min-w-0 ${task.status === 'Done' ? 'text-overlay-0 line-through' : 'text-text'}`}>{task.title}</p>
                            <TaskVisibilityBadge task={task} areas={areas} />
                          </div>
                          {hasTags && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {pri && (
                                <span className={task.priority === 'High' ? 'g-tag g-tag-hi' : 'g-tag'} title={`Priority: ${task.priority}`}>{task.priority}</span>
                              )}
                              {area && (
                                <span className="g-tag"><span className={`g-gem !w-1.5 !h-1.5 ${areaGem(task.area_id)}`} aria-hidden="true" />{area}</span>
                              )}
                              {cardFields.has('prefix') && task.prefix && (
                                <span className="g-tag font-mono">{task.prefix}</span>
                              )}
                              {due && <span className={due.cls}>{due.late ? `⚠ ${due.label}` : due.label}</span>}
                              {cardFields.has('cost') && task.cost != null && (
                                <span className="g-tag">{fmtCost(task.cost, task.currency)}</span>
                              )}
                            </div>
                          )}
                          {(people.length > 0 || nCom > 0 || nFiles > 0) && (
                            <div className="flex items-center gap-2.5 text-xs text-[color:var(--g-mut)]">
                              {people.length > 0 && (
                                <span className="flex -space-x-1.5" title={people.map((a) => a.display_name || a.username).join(', ')}>
                                  {people.slice(0, 3).map((a) => (
                                    <span
                                      key={assigneeKey(a)}
                                      title={a.kind === 'contact' ? `${a.display_name} (contact)` : a.display_name}
                                      className={`g-av !w-[22px] !h-[22px] !text-[9px] ${a.kind === 'contact' ? '!text-[color:var(--g-fg2)] !border-surface-1' : ''}`}
                                    >
                                      {(a.display_name || a.username).slice(0, 2).toUpperCase()}
                                    </span>
                                  ))}
                                  {people.length > 3 && (
                                    <span className="g-av !w-[22px] !h-[22px] !text-[9px] !text-[color:var(--g-mut)]">+{people.length - 3}</span>
                                  )}
                                </span>
                              )}
                              <span className="flex-1" />
                              {nCom > 0 && <span title={`${nCom} update${nCom === 1 ? '' : 's'} tagged`}>✎ {nCom}</span>}
                              {nFiles > 0 && <span title={`${nFiles} file${nFiles === 1 ? '' : 's'}`}>⎘ {nFiles}</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </ScrollArea>
                </section>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {menu.element}
      {/* Floating drag ghost — renders above everything while dragging. */}
      {drag && draggedTask && (
        <div
          className="fixed pointer-events-none z-[100] px-3.5 py-3 rounded border bg-base border-gilt-a outline outline-1 outline-gilt-b -outline-offset-[5px] shadow-2xl opacity-90"
          style={{ left: drag.x - drag.offsetX, top: drag.y - drag.offsetY, width: 260 }}
        >
          <div className="flex items-start gap-2">
            <span className={`${statusMark(draggedTask.status)} mt-[3px]`} aria-hidden="true" />
            <p className="text-sm font-medium text-text leading-snug break-words flex-1 min-w-0">{draggedTask.title}</p>
          </div>
        </div>
      )}

      {/* Detail pane — slide-out, resizable (Gilt's side pane). */}
      <ResizablePane
        id="side-pane"
        side="right"
        min={340}
        max={900}
        defaultWidth={420}
        collapsible
        collapsed={!detailOpen}
        className="border-l border-surface-2 bg-surface-0"
      >
        <div className="h-full overflow-y-auto overflow-x-hidden">
          <DetailPane
            controller={detail}
            onChanged={load}
            onClose={() => setDetailOpen(false)}
            emptyHint="Click a card to view and edit it here. Drag cards between columns to change status."
          />
        </div>
      </ResizablePane>

    </div>
  );
}
