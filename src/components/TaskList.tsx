import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { getTasks, createTask, getTaskTotalTime, getAreas } from '../lib/api';
import DetailPane, { useDetailStack, type DetailTarget } from './DetailPane';
import { useDataPulse } from '../lib/livePulse';
import { useNav } from '../store/navHistory';
import type { CreateTaskInput, Area, Task } from '../types';
import TaskVisibilityBadge, { isRestricted } from './TaskVisibilityBadge';
import ScrollArea from './ScrollArea';
import { ResizablePane } from './gilt';
import { areaGem, dueTag, statusMark } from './taskMarks';
import StatusChips from './StatusChips';
import { countByStatus, statusPasses, type Status } from './statusFilter';

// Status groups read top-down as "what's in flight, what's next, what's stuck,
// what's done" — the default grouping.
const STATUS_ORDER = ['In Progress', 'To Do', 'Blocked', 'Done'];

export default function TaskList() {
  const { selectedProject, tasks, setTasks, selectTask, addTask, setTaskTime, selectedAreaId, setSelectedAreaId, activeTask, setActiveTask } = useAppStore();
  const [isCreating, setIsCreating] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  // Status filter: multi-choice; the empty list is "All". Not persisted (as before).
  const [filterStatus, setFilterStatus] = useState<Status[]>([]);
  const [filterArea, setFilterArea] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('created');
  const [areas, setAreas] = useState<Area[]>([]);
  // Collapsed area sections (by area id; -1 = the "No area" bucket). Empty = all open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<'status' | 'area' | 'none'>(() => {
    const v = localStorage.getItem('taskList.groupBy');
    return v === 'area' || v === 'none' ? v : 'status';
  });
  const changeGroupBy = (v: 'status' | 'area' | 'none') => {
    setGroupBy(v);
    localStorage.setItem('taskList.groupBy', v);
    setCollapsed(new Set());
  };
  // The editor pane is collapsible: ✕ saves + hides it; the task list gets
  // the full width. Reopen via the edge tab.
  const [editorHidden, setEditorHidden] = useState(true);
  const detail = useDetailStack({
    scope: 'tasks',
    onShow: (show, target) => {
      setEditorHidden(!show);
      if (target?.kind === 'task') selectTask(target.task);
    },
  });
  // Host pulse → store-level refetch. Safe mid-edit: the editor's form state
  // seeds only on task-id change, and the detail stack holds its own snapshot.
  useDataPulse(() => void refreshTasks(), ['tasks', 'comments', 'time', 'files']);

  const openTask = (task: Task, record: 'push' | 'amend' | 'none' = 'push') => {
    detail.open({ kind: 'task', task }, { record });
    setEditorHidden(false); // show the editor when a task is opened
    selectTask(task); // keep the global selection in sync for other views
  };

  // A task from the project we just left: close it. The editor unmounts and
  // saves its draft to that task, before the new list arrives; it never
  // switches over to a task of this project carrying the old draft. A
  // back/forward landing opens its own task here instead; leave that be.
  const openElsewhere = (t: DetailTarget) => t.kind === 'task' && t.task.project_id !== selectedProject?.id;
  useEffect(() => {
    if (!selectedProject || !detail.current || !openElsewhere(detail.current)) return;
    const r = useNav.getState().restore;
    if (r && r.entry.pane?.scope === 'tasks' && Date.now() - r.at < 3000) return;
    detail.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

  // The rail+editor IS the view — entering a project's tasks auto-opens the
  // first task (display order) so there's never a dead landing page. Once per
  // project: closing (✕) or switching tasks must not snap back.
  const autoOpenedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedProject || tasks.length === 0) return;
    // Right after a project switch the list still holds the last project's tasks.
    if (tasks[0].project_id !== selectedProject.id) return;
    if (autoOpenedFor.current === selectedProject.id) return;
    autoOpenedFor.current = selectedProject.id;
    if (detail.current && !openElsewhere(detail.current)) return; // something is already open (e.g. via search)
    // A back/forward landing here reopens its own task, or leaves its entry as it was.
    const r = useNav.getState().restore;
    const restoring = !!r && r.entry.tab === 'tasks' && Date.now() - r.at < 3000;
    if (restoring && r.entry.pane?.scope === 'tasks') return;
    const first = groups[0]?.tasks[0];
    if (first) openTask(first, restoring ? 'none' : 'amend'); // nobody clicked it: not a new place in history
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, selectedProject?.id]);

  useEffect(() => {
    if (selectedProject) {
      loadTasks();
      loadAreas();
      // Clear area filter + collapse state when switching projects (the -1
      // "No area" key is shared across projects, so it must be reset too).
      setFilterArea('all');
      setSelectedAreaId(null);
      setCollapsed(new Set());
    }
  }, [selectedProject]);

  // Watch for selectedAreaId changes and apply filter
  useEffect(() => {
    if (selectedAreaId !== null) {
      setFilterArea(selectedAreaId.toString());
    } else {
      // When selectedAreaId is cleared, reset filter to 'all'
      setFilterArea('all');
    }
  }, [selectedAreaId]);

  // Handle manual filter change
  const handleAreaFilterChange = (value: string) => {
    setFilterArea(value);
    // Clear selectedAreaId when user manually changes filter to anything
    if (selectedAreaId !== null) {
      setSelectedAreaId(null);
    }
  };

  const loadAreas = async () => {
    if (!selectedProject) return;

    try {
      const data = await getAreas(selectedProject.id);
      setAreas(data);
    } catch (error) {
      console.error('Failed to load areas:', error);
    }
  };

  // Light refetch for after-edit refreshes (no per-task time calls — the editor
  // updates the store's time cache itself via setTaskTime).
  const refreshTasks = async () => {
    if (!selectedProject) return;
    try {
      setTasks(await getTasks(selectedProject.id, false));
    } catch (error) {
      console.error('Failed to refresh tasks:', error);
    }
  };

  const loadTasks = async () => {
    if (!selectedProject) return;

    console.log('Loading tasks for project:', selectedProject.id);
    try {
      const data = await getTasks(selectedProject.id, false);
      console.log('Tasks loaded:', data);
      setTasks(data);

      // Load time data for all tasks
      data.forEach(async (task) => {
        try {
          const totalTime = await getTaskTotalTime(task.id);
          setTaskTime(task.id, totalTime);
        } catch (error) {
          console.error(`Failed to load time for task ${task.id}:`, error);
        }
      });
    } catch (error) {
      console.error('Failed to load tasks:', error);
    }
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim() || !selectedProject) return;

    const input: CreateTaskInput = {
      project_id: selectedProject.id,
      title: newTaskTitle,
      status: 'To Do',
      priority: 'Medium',
    };

    try {
      const task = await createTask(input);
      addTask(task);
      setNewTaskTitle('');
      setIsCreating(false);
      openTask(task);
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  if (!selectedProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-subtext-0">
        <div className="text-center">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-overlay-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-lg">Select a project to view tasks</p>
        </div>
      </div>
    );
  }

  // Apply filters
  let filteredTasks = [...tasks];

  if (filterArea !== 'all') {
    if (filterArea === 'none') {
      filteredTasks = filteredTasks.filter((task) => !task.area_id);
    } else {
      filteredTasks = filteredTasks.filter((task) => task.area_id === Number(filterArea));
    }
  }
  // The status chips count what the area filter leaves.
  const statusCounts = countByStatus(filteredTasks.map((t) => t.status));
  if (filterStatus.length > 0) {
    filteredTasks = filteredTasks.filter((task) => statusPasses(filterStatus, task.status));
  }

  // Sort (pinned first, then the chosen order)
  filteredTasks.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    switch (sortBy) {
      case 'created':
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case 'title':
        return a.title.localeCompare(b.title);
      case 'priority': {
        const priorityOrder = { High: 0, Medium: 1, Low: 2 };
        return priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder];
      }
      case 'area': {
        const areaA = areas.find((ar) => ar.id === a.area_id)?.name || '';
        const areaB = areas.find((ar) => ar.id === b.area_id)?.name || '';
        return areaA.localeCompare(areaB);
      }
      default:
        return 0;
    }
  });

  // Group into collapsible sections — by status (default), by area, or flat.
  const groups = (
    groupBy === 'status'
      ? STATUS_ORDER.map((s) => ({ key: `s:${s}`, name: s, areaId: null as number | null, tasks: filteredTasks.filter((t) => t.status === s) }))
      : groupBy === 'area'
        ? [
            ...areas.map((a) => ({ key: `a:${a.id}`, name: a.name, areaId: a.id as number | null, tasks: filteredTasks.filter((t) => t.area_id === a.id) })),
            { key: 'a:none', name: 'No area', areaId: null as number | null, tasks: filteredTasks.filter((t) => !t.area_id) },
          ]
        : [{ key: 'all', name: 'All tasks', areaId: null as number | null, tasks: filteredTasks }]
  ).filter((g) => g.tasks.length > 0);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ONE view: the tree on the left, the task on the right — always. The old
  // full-width card list ("the old view") is gone; entering the tab opens the
  // first task so there is never a dead landing page.
  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0 overflow-hidden">
      {/* RAIL: slim tree that owns filtering and creation. Resizable (Gilt). */}
      <ResizablePane id="task-list" side="left" min={220} max={640} defaultWidth={300} className="border-r border-gilt-b bg-crust">
      <div className="h-full flex flex-col min-h-0">
        <div className="px-3 pt-3 pb-3 border-b border-gilt-b space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text truncate flex-1">{selectedProject.name}</span>
            <span className="text-xs text-[color:var(--g-mut)] tabular-nums shrink-0">{filteredTasks.length}</span>
            <button
              onClick={() => setEditorHidden((v) => !v)}
              className="g-iconbtn !w-8 !h-8"
              title={editorHidden ? 'Show the editor' : 'Hide the editor'}
            >
              {editorHidden ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              )}
            </button>
          </div>
          <div className="relative flex gap-2">
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className={`g-btn g-btn-ghost g-btn-sm flex-1 min-w-0 ${filtersOpen ? '!text-gold !shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M6 9h12M9 14h6m-4 5h2" />
              </svg>
              Filter & sort
              {(filterStatus.length > 0 || filterArea !== 'all') && <span className="g-gem !w-1.5 !h-1.5" aria-label="Filters on" />}
            </button>
            <button
              onClick={() => setIsCreating(true)}
              title="New task"
              aria-label="New task"
              className="g-btn g-btn-pri g-btn-sm !px-0 w-9 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {filtersOpen && (
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setFiltersOpen(false)} />
                <div className="g-card absolute left-0 top-full mt-2 z-20 w-72 shadow-xl px-4 pt-4 pb-4 space-y-3">
                  <div className="g-deco text-center text-[11px] font-semibold text-gold">Filter & sort</div>
                  <div>
                    <div className="g-flbl">Status</div>
                    <StatusChips
                      value={filterStatus}
                      onChange={setFilterStatus}
                      counts={statusCounts}
                    />
                  </div>
                  <div>
                    <label className="g-flbl">Area</label>
                    <select
                      value={filterArea}
                      onChange={(e) => handleAreaFilterChange(e.target.value)}
                      className="g-field"
                    >
                      <option value="all">All Areas</option>
                      <option value="none">No Area</option>
                      {areas.map((area) => (
                        <option key={area.id} value={area.id}>
                          {area.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="g-flbl">Sort by</label>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="g-field"
                    >
                      <option value="created">Created (Newest)</option>
                      <option value="title">Title (A-Z)</option>
                      <option value="priority">Priority (High-Low)</option>
                      <option value="area">Area (A-Z)</option>
                    </select>
                  </div>
                  <div>
                    <label className="g-flbl">Group by</label>
                    <select
                      value={groupBy}
                      onChange={(e) => changeGroupBy(e.target.value as 'status' | 'area' | 'none')}
                      className="g-field"
                    >
                      <option value="status">Status</option>
                      <option value="area">Area</option>
                      <option value="none">No grouping</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>

          {isCreating && (
            <div className="space-y-2">
              <input
                type="text"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateTask();
                  if (e.key === 'Escape') {
                    setIsCreating(false);
                    setNewTaskTitle('');
                  }
                }}
                placeholder="Task title…"
                className={`g-field placeholder:text-[color:var(--g-mut)]`}
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={handleCreateTask} className="g-btn g-btn-pri g-btn-sm flex-1">
                  Create
                </button>
                <button
                  onClick={() => {
                    setIsCreating(false);
                    setNewTaskTitle('');
                  }}
                  className="g-btn g-btn-ghost g-btn-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0" contentClassName="p-2 space-y-3">
          {groups.length === 0 && <p className="px-2 py-3 text-sm text-[color:var(--g-mut)]">No tasks match.</p>}
          {groups.map((g) => {
            const isOpen = !collapsed.has(g.key);
            return (
              <div key={g.key}>
                <button
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={isOpen}
                  className="group w-full flex items-center gap-2 min-h-8 px-2 mb-0.5 text-left g-deco text-[11px] font-semibold tracking-[0.22em] text-[color:var(--g-mut)] hover:text-[color:var(--g-fg2)]"
                >
                  <svg
                    className={`w-3 h-3 transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {groupBy === 'status' ? (
                    <span className={`${statusMark(g.name)} !w-3 !h-3`} aria-hidden="true" />
                  ) : (
                    <span className={`g-gem ${groupBy === 'area' ? areaGem(g.areaId) : ''}`} aria-hidden="true" />
                  )}
                  <span className="truncate pt-px">{g.name}</span>
                  <span className="ml-auto shrink-0 tracking-[0.04em] tabular-nums">{g.tasks.length}</span>
                </button>
                {isOpen && (
                  <div className="space-y-0.5">
                    {g.tasks.map((task) => {
                      const selected = detail.current?.kind === 'task' && detail.current.task.id === task.id;
                      const isActive = activeTask?.id === task.id;
                      const due = dueTag(task.deadline, task.status);
                      return (
                        <button
                          key={task.id}
                          onClick={() => openTask(task)}
                          onDoubleClick={(e) => { e.stopPropagation(); setActiveTask(isActive ? null : task); }}
                          title="Double-click to set as the active task"
                          aria-current={selected ? 'true' : undefined}
                          className={`w-full text-left flex items-start gap-2.5 px-3 py-2.5 rounded ${
                            selected ? 'bg-gilt-b' : 'hover:bg-surface-0'
                          } ${
                            isActive
                              ? selected
                                ? 'shadow-[inset_2px_0_0_var(--color-gold),inset_0_0_0_1px_var(--color-success)]'
                                : 'shadow-[inset_0_0_0_1px_var(--color-success)]'
                              : selected
                                ? 'shadow-[inset_2px_0_0_var(--color-gold),inset_0_0_0_1px_var(--color-gilt-a)]'
                                : ''
                          }`}
                        >
                          <span className={`${statusMark(task.status)} mt-[3px]`} title={task.status} />
                          <span className="sr-only">{task.status}: </span>
                          <span className="flex-1 min-w-0">
                            <span className={`block text-sm font-medium break-words line-clamp-2 ${task.status === 'Done' ? 'text-overlay-0 line-through' : 'text-text'}`}>
                              {task.title}
                            </span>
                            {(isActive || task.pinned || task.priority === 'High' || due || isRestricted(task, areas)) && (
                              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {isActive && <span className="g-tag g-tag-ok !min-h-[22px] !px-2 !text-[11px]">● active</span>}
                                {task.priority === 'High' && <span className="g-tag g-tag-hi !min-h-[22px] !px-2 !text-[11px]">High</span>}
                                {due && <span className={`${due.cls} !min-h-[22px] !px-2 !text-[11px]`}>{due.late ? `⚠ ${due.label}` : due.label}</span>}
                                {task.pinned && <span className="text-[11px]" title="Pinned">📌</span>}
                                <TaskVisibilityBadge task={task} areas={areas} />
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </ScrollArea>
      </div>
      </ResizablePane>

      {/* EDITOR: fills the window (the split is container-measured), overflow-
          contained so a wide pasted table can never push the app sideways.
          Collapsible: ✕ saves + hides it; the task list gets the full width. */}
      <div className={`flex-1 min-w-0 overflow-hidden bg-base transition-all duration-200 ${editorHidden ? 'w-0 flex-none' : ''}`}>
        <div className="h-full min-w-0">
          <DetailPane
            controller={detail}
            taskPage
            onChanged={refreshTasks}
            onClose={() => setEditorHidden(true)}
            emptyHint="Pick a task on the left — or create one with +."
          />
        </div>
      </div>
    </div>
  );
}
