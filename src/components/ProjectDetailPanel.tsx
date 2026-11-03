import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import { getAreas, createArea, updateArea, deleteArea, getProjectStats, getTasks } from '../lib/api';
import type { Area, Project, ProjectStats, Task } from '../types';
import ScrollArea from './ScrollArea';
import { areaGem, statusMark } from './taskMarks';
import { projectColorClass, projectInitial } from '../lib/projectColor';


const UNASSIGNED = -1; // expanded-set sentinel for the "no area" bucket

/** Right-pane project detail: summary + areas as collapsible sections whose
 * tasks expand inline (click a task to open it in the DetailPane). Inline area
 * editing (add / rename / delete) is preserved. */
export default function ProjectDetailPanel({
  project,
  onOpenProject,
  onOpenTask,
}: {
  project: Project;
  onOpenProject?: (p: Project) => void;
  onOpenTask?: (task: Task) => void;
}) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [newArea, setNewArea] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const cancelRename = useRef(false); // set on Escape so the unmount-blur doesn't save

  const load = () => {
    getAreas(project.id).then(setAreas).catch(() => {});
    getTasks(project.id, false).then(setTasks).catch(() => {});
    getProjectStats(project.id).then(setStats).catch(() => setStats(null));
  };
  useEffect(load, [project.id]);

  const groups = useMemo(() => {
    const out: { key: number; name: string; area: Area | null; tasks: Task[] }[] = areas.map((a) => ({
      key: a.id,
      name: a.name,
      area: a,
      tasks: tasks.filter((t) => t.area_id === a.id),
    }));
    const noArea = tasks.filter((t) => !t.area_id);
    if (noArea.length) out.push({ key: UNASSIGNED, name: 'Unassigned', area: null, tasks: noArea });
    return out;
  }, [areas, tasks]);

  const toggle = (key: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const add = async () => {
    if (!newArea.trim() || busy) return;
    setBusy(true);
    try {
      await createArea({ project_id: project.id, name: newArea.trim() });
      setNewArea('');
      load();
    } finally {
      setBusy(false);
    }
  };
  const rename = async (id: number) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await updateArea(id, { name: editName.trim() });
    } finally {
      setEditingId(null);
      load();
    }
  };
  const remove = async (a: Area) => {
    if (!await confirmDialog(`Delete area "${a.name}"? Tasks keep existing but lose the area.`)) return;
    await deleteArea(a.id).catch(() => {});
    load();
  };

  return (
    <ScrollArea className="h-full bg-surface-0" contentClassName="p-5">
      <div className="flex items-start justify-between gap-3">
        <span className={`g-tile mt-0.5 ${projectColorClass(project)}`} aria-hidden="true">{projectInitial(project.name)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-deco text-2xl font-light uppercase tracking-[0.12em] leading-tight text-text truncate">{project.name}</h2>
          {project.description && <p className="text-sm text-[color:var(--g-fg2)] mt-1 max-w-[72ch]">{project.description}</p>}
        </div>
        {onOpenProject && (
          <button onClick={() => onOpenProject(project)} className="g-lnk shrink-0">
            Open project →
          </button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2 mt-4">
          <Stat label="Tasks" value={String(stats.total_tasks)} />
          <Stat label="Files" value={String(stats.total_files)} />
          <Stat label="In progress" value={String(stats.tasks_by_status.in_progress)} />
        </div>
      )}

      <div className="mt-5">
        <h3 className="g-h2 !mb-3">Areas &amp; tasks</h3>
        <div className="space-y-1.5">
          {groups.length === 0 && <p className="text-sm text-subtext-0 italic">No areas or tasks yet.</p>}
          {groups.map((g) => {
            const isExpanded = expanded.has(g.key);
            const isEditing = g.area != null && editingId === g.area.id;
            return (
              <div key={g.key} className="g-plain overflow-hidden">
                {isEditing ? (
                  <div className="flex items-center gap-2 px-3 py-2">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        // Commit via blur (single path) so Enter can't double-save.
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') {
                          cancelRename.current = true;
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        if (cancelRename.current) {
                          cancelRename.current = false;
                          return; // Escape cancelled — don't save
                        }
                        rename(g.area!.id);
                      }}
                      className="g-field g-field-sm flex-1"
                    />
                  </div>
                ) : (
                  <div className="flex items-center">
                    <button onClick={() => toggle(g.key)} className="flex-1 flex items-center gap-2 px-3 py-2 text-left min-w-0">
                      <svg
                        className={`w-3.5 h-3.5 text-subtext-0 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <span className={`g-gem ${g.area ? areaGem(g.area.id) : 'c-none'}`} aria-hidden="true" />
                      <span className="truncate text-sm font-medium text-text">{g.name}</span>
                      <span className="ml-auto text-xs text-subtext-0 shrink-0 pl-2">{g.tasks.length}</span>
                    </button>
                    {g.area && (
                      <div className="flex items-center pr-2 gap-0.5 shrink-0">
                        <button
                          onClick={() => {
                            setEditingId(g.area!.id);
                            setEditName(g.area!.name);
                          }}
                          className="g-iconbtn !w-8 !h-8"
                          title="Rename area"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                          </svg>
                        </button>
                        <button onClick={() => remove(g.area!)} className="g-iconbtn !w-8 !h-8 hover:!text-error text-sm" title="Delete area">
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {isExpanded && !isEditing && (
                  <div className="border-t border-surface-0">
                    {g.tasks.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-subtext-0 italic">No tasks.</p>
                    ) : (
                      g.tasks.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => onOpenTask?.(t)}
                          disabled={!onOpenTask}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm border-t border-surface-0 first:border-t-0 ${
                            onOpenTask ? 'hover:bg-gilt-b cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          <span className={statusMark(t.status)} aria-hidden="true" />
                          <span className="truncate text-text">{t.title}</span>
                          <span className="ml-auto text-[10px] text-subtext-0 shrink-0 pl-2">{t.status}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2 mt-2">
          <input
            value={newArea}
            onChange={(e) => setNewArea(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="New area…"
            className="g-field flex-1 min-w-0"
          />
          <button
            onClick={add}
            disabled={!newArea.trim() || busy}
            className="g-btn g-btn-pri g-btn-sm"
          >
            Add
          </button>
        </div>
      </div>
    </ScrollArea>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="g-card px-2 py-3 text-center">
      <div className="font-deco font-light text-2xl leading-tight text-text tabular-nums">{value}</div>
      <div className="text-[11px] text-[color:var(--g-mut)]">{label}</div>
    </div>
  );
}
