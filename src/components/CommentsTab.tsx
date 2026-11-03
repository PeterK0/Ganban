import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { getAreas, getTasks, getTaskTotalTime } from '../lib/api';
import { useDataPulse } from '../lib/livePulse';
import { formatDuration } from '../lib/reportGenerator';
import { LOCAL_ID } from '../lib/workspaces';
import type { Area, Task } from '../types';
import MarkdownPreview from './MarkdownPreview';
import ScrollArea from './ScrollArea';
import CommentBoard from './comments/CommentBoard';
import { TaskChip, StatusMark } from './comments/TaskTagPicker';
import { DecoHeading } from './gilt';
import { activeBoardApi } from './comments/boardApi';

/**
 * Project "Comments" tab — the project's comment board. Every update across
 * the project's tasks in one feed, newest first; an update is tagged with the
 * tasks it covers (an end-of-day note on two tasks is ONE update, shown in
 * both). Click tasks on the left to filter (any of them); the composer
 * pre-tags new updates with the tasks you're looking at.
 */
export default function CommentsTab() {
  const { selectedProject, commentBoardIntent, setCommentBoardIntent } = useAppStore();
  const [areas, setAreas] = useState<Area[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<number[]>([]);
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [query, setQuery] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  const [showDescription, setShowDescription] = useState(true);
  const pid = selectedProject?.id;
  const pkey = selectedProject ? `${selectedProject.workspaceId ?? LOCAL_ID}:${selectedProject.id}` : null;

  const loadTasks = () => {
    if (pid == null) return;
    void Promise.all([getAreas(pid).catch(() => []), getTasks(pid, false).catch(() => [])]).then(([a, t]) => {
      setAreas(a);
      setTasks(t);
      // Drop filtered tasks that went to the Bin.
      setFilter((f) => f.filter((id) => t.some((x) => x.id === id)));
    });
  };
  useEffect(() => {
    // "Open the board" from Home lands here with its tasks pre-filtered.
    const intent = commentBoardIntent && commentBoardIntent.projectKey === pkey ? commentBoardIntent : null;
    setFilter(intent?.taskIds ?? []);
    if (intent) setCommentBoardIntent(null);
    setCounts(new Map());
    loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkey]);
  useDataPulse(loadTasks, ['tasks', 'areas']);

  const single = filter.length === 1 ? tasks.find((t) => t.id === filter[0]) ?? null : null;
  useEffect(() => {
    setSeconds(null);
    if (!single) return;
    getTaskTotalTime(single.id).then(setSeconds).catch(() => setSeconds(null));
  }, [single?.id]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (t: Task) => !q || t.title.toLowerCase().includes(q);
    const out = areas.map((a) => ({ name: a.name, tasks: tasks.filter((t) => t.area_id === a.id && hit(t)) }));
    const known = new Set(areas.map((a) => a.id));
    const rest = tasks.filter((t) => (!t.area_id || !known.has(t.area_id)) && hit(t));
    if (rest.length) out.push({ name: areas.length ? 'No area' : 'Tasks', tasks: rest });
    return out.filter((g) => g.tasks.length > 0);
  }, [areas, tasks, query]);

  if (!selectedProject) return null;

  const toggle = (id: number) => setFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  return (
    <div className="flex-1 flex min-h-0 bg-base">
      {/* Left: tasks — click to filter the board (multi-select). */}
      <div className="w-72 shrink-0 border-r border-gilt-b bg-mantle flex flex-col min-h-0">
        <div className="p-3 space-y-2 shrink-0 border-b border-gilt-b">
          <button
            onClick={() => setFilter([])}
            aria-pressed={filter.length === 0}
            className={`w-full flex items-center gap-2 px-3 min-h-[40px] rounded text-left text-sm font-medium ${
              filter.length === 0 ? 'g-on' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
            }`}
          >
            <span className="g-gem" aria-hidden="true" />
            <span className="flex-1">All updates</span>
          </button>
          {tasks.length > 10 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a task…"
              aria-label="Find a task"
              className="g-field g-field-sm"
            />
          )}
        </div>
        <ScrollArea className="flex-1 min-h-0" contentClassName="pb-3">
          {tasks.length === 0 ? (
            <p className="p-4 text-sm text-subtext-0">No tasks in this project yet.</p>
          ) : (
            groups.map((g) => (
              <div key={g.name}>
                <div className="g-flbl px-4 pt-4 !mb-1">{g.name}</div>
                {g.tasks.map((t) => {
                  const on = filter.includes(t.id);
                  const n = counts.get(t.id) ?? 0;
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggle(t.id)}
                      title={on ? 'Remove from the filter' : 'Add to the filter'}
                      aria-pressed={on}
                      className={`w-full flex items-center gap-2.5 px-4 min-h-[34px] text-left text-sm ${
                        on ? 'bg-gilt-b text-text' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center text-[9px] ${
                          on ? 'bg-gold border-gold text-base' : 'border-surface-1'
                        }`}
                      >
                        {on ? '✓' : ''}
                      </span>
                      <StatusMark status={t.status} />
                      <span className="truncate flex-1">{t.title}</span>
                      {n > 0 && <span className="text-[11px] text-subtext-0 tabular-nums shrink-0">{n}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {tasks.length > 0 && (
            <p className="px-4 pt-4 text-xs text-subtext-0">Click tasks to filter the board — any of the picked tasks.</p>
          )}
        </ScrollArea>
      </div>

      {/* Right: the board */}
      <ScrollArea className="flex-1 min-w-0">
        <div className="px-6 py-7 space-y-5">
          {single ? (
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <StatusMark status={single.status} size={14} />
                  <h1 className="text-xl font-bold text-text flex-1 min-w-0 truncate">{single.title}</h1>
                  <button onClick={() => setFilter([])} className="g-lnk shrink-0">
                    All updates
                  </button>
                </div>
                <div className="text-[13px] text-subtext-0 mt-1 tabular-nums">
                  {single.status}
                  {seconds != null && seconds > 0 ? ` · ${formatDuration(seconds)} tracked` : ''}
                  {single.description && (
                    <button onClick={() => setShowDescription((s) => !s)} className="g-lnk ml-1" aria-expanded={showDescription}>
                      {showDescription ? 'Hide description' : 'Show description'}
                    </button>
                  )}
                </div>
              </div>
              {single.description && showDescription && (
                <div className="g-card g-corners px-[18px] py-4" style={{ backgroundColor: 'var(--color-mantle)' }}>
                  <MarkdownPreview content={single.description} />
                </div>
              )}
            </div>
          ) : filter.length > 1 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-text flex-1">Updates on {filter.length} tasks</h1>
                <button onClick={() => setFilter([])} className="g-lnk">
                  All updates
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filter.map((id) => (
                  <TaskChip key={id} task={byId.get(id)} onRemove={() => toggle(id)} />
                ))}
              </div>
            </div>
          ) : (
            <div>
              <DecoHeading as="h1" className="!mb-2">Project updates</DecoHeading>
              <p className="text-[13px] text-subtext-0 text-center">
                Every comment across the project’s tasks, newest first. Tag an update with each task it covers — it shows in
                all of their threads.
              </p>
            </div>
          )}

          <CommentBoard
            key={pkey /* composite: same-id projects on two hosts must not share a board */}
            api={activeBoardApi}
            projectId={selectedProject.id}
            tasks={tasks}
            areas={areas}
            filter={filter}
            onTaskClick={(id) => setFilter([id])}
            onLoaded={(b) => setCounts(new Map(b.task_counts.map((c) => [c.task_id, c.count])))}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
