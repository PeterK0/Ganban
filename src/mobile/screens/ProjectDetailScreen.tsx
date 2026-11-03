import { useEffect, useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { Area, Project, ProjectStats, Event } from "../../types";
import { getProjectTabs, listAvailableTabs, type TabDescriptor } from "../../lib/daemon";
import { TAB_PANELS, stashTabIcon } from "../../tabs/registry";
import { TabIcon } from "../../components/icons/TabIcon";
import {
  archiveProject,
  createArea,
  deleteArea,
  deleteProject,
  getAreas,
  getProjectEvents,
  getProjectStats,
  getTasks,
  toggleProjectPin,
  updateArea,
} from "../../lib/api";
import { formatDuration } from "../../lib/reportGenerator";
import { useNav } from "../nav";
import {
  Badge,
  Button,
  Chevron,
  EmptyState,
  ErrorBanner,
  Fab,
  Field,
  ListRow,
  Screen,
  SectionHeader,
  Sheet,
  Spinner,
  TASK_STATUSES,
  TextArea,
  TextInput,
  errMsg,
  priorityClasses,
  statusColor,
  useAsync,
} from "../ui";
import { StatusMark } from "../../components/comments/TaskTagPicker";
import TaskForm from "../forms/TaskForm";
import ProjectForm from "../forms/ProjectForm";
import TaskDetailScreen from "./TaskDetailScreen";
import { ProjectChatsScreen } from "./AssistantScreen";
import ProjectFilesScreen from "./ProjectFilesScreen";
import ReportsScreen from "./ReportsScreen";
import StashTabScreen from "./StashTabScreen";
import { isRestricted } from '../../components/TaskVisibilityBadge';

export default function ProjectDetailScreen({
  project: initial,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const nav = useNav();
  const [project, setProject] = useState(initial);
  // Stash tabs enabled for this project (intersected with the panels this
  // bundle ships, same rule as the desktop tab bar). Enabling/disabling stays
  // a desktop Project Settings affair — here they just open.
  const [stashTabs, setStashTabs] = useState<TabDescriptor[]>([]);
  useEffect(() => {
    let alive = true;
    Promise.all([listAvailableTabs(), getProjectTabs(initial.id)])
      .then(([avail, enabled]) => {
        if (alive) setStashTabs(avail.filter((t) => enabled.includes(t.id) && TAB_PANELS[t.id]));
      })
      .catch(() => {}); // older host or no daemon — just no tab rows
    return () => {
      alive = false;
    };
  }, [initial.id]);
  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        getAreas(project.id),
        getTasks(project.id, false),
        getProjectStats(project.id),
        getProjectEvents(project.id, false).catch(() => [] as Event[]),
      ]),
    [project.id]
  );
  const [creatingTask, setCreatingTask] = useState(false);
  const [editing, setEditing] = useState(false);
  const [actions, setActions] = useState(false);
  const [addingArea, setAddingArea] = useState(false);
  const [editingArea, setEditingArea] = useState<Area | null>(null);

  const areas: Area[] = data?.[0] ?? [];
  const tasks = data?.[1] ?? [];
  const stats = data?.[2];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const upcoming = (data?.[3] ?? [])
    .filter((e) => !e.done_at && new Date(e.event_date) >= startOfToday)
    .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
    .slice(0, 5);

  const refresh = () => {
    reload();
    onChanged();
  };

  const removeArea = async (id: number) => {
    if (!await confirmDialog("Delete this area? Tasks keep existing but lose the area.")) return;
    try {
      await deleteArea(id);
      reload();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  return (
    <Screen
      title={project.name}
      onBack={nav.pop}
      subtitle={project.description || undefined}
      right={
        <button onClick={() => setActions(true)} className="g-iconbtn w-11 h-11 text-xl active:bg-surface-0" aria-label="Actions">
          ⋯
        </button>
      }
    >
      {error && <ErrorBanner message={error} onRetry={reload} />}

      {stats && (
        <div className="flex gap-2 px-4 pt-3">
          <Stat label="Tasks" value={String(stats.total_tasks)} />
          <Stat label="Time" value={formatDuration(stats.total_time_seconds)} />
          <Stat label="Cost" value={stats.total_cost ? stats.total_cost.toFixed(0) : "0"} />
        </div>
      )}

      {stats && <HealthBar s={stats.tasks_by_status} />}

      {/* Quick links: Files + Assistant */}
      <div className="mt-3 border-t border-gilt-b min-[700px]:grid min-[700px]:grid-cols-2">
        <button
          onClick={() => nav.push(<ProjectFilesScreen project={project} />)}
          className="gm-row"
        >
          <span className="w-7 flex justify-center gm-mut"><TabIcon name="files" className="w-[18px] h-[18px]" /></span>
          <span className="flex-1 text-[15px] font-medium">Files</span>
          <Chevron />
        </button>
        <button
          onClick={() => nav.push(<ProjectChatsScreen project={project} />)}
          className="gm-row"
        >
          <span className="w-7 flex justify-center gm-mut"><TabIcon name="chats" className="w-[18px] h-[18px]" /></span>
          <span className="flex-1 text-[15px] font-medium">Chat with assistant</span>
          <Chevron />
        </button>
        <button
          onClick={() => nav.push(<ReportsScreen projectId={project.id} />)}
          className="gm-row"
        >
          <span className="w-7 flex justify-center gm-mut"><TabIcon name="reports" className="w-[18px] h-[18px]" /></span>
          <span className="flex-1 text-[15px] font-medium">Reports</span>
          <Chevron />
        </button>
        {stashTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => nav.push(<StashTabScreen tab={t} projectId={project.id} />)}
            className="gm-row"
          >
            <span className="w-7 flex justify-center gm-mut"><TabIcon name={stashTabIcon(t)} className="w-[18px] h-[18px]" /></span>
            <span className="flex-1 text-[15px] font-medium">{t.name}</span>
            <Chevron />
          </button>
        ))}
      </div>

      {/* Upcoming events */}
      {upcoming.length > 0 && (
        <>
          <SectionHeader>Upcoming events</SectionHeader>
          {upcoming.map((e) => {
            const d = new Date(e.event_date);
            return (
              <div key={e.id} className="gm-row">
                <div className="shrink-0 w-9 text-center">
                  <div className="g-deco text-[10px] text-gold">{d.toLocaleDateString(undefined, { month: "short" })}</div>
                  <div className="font-deco text-lg leading-none">{d.getDate()}</div>
                </div>
                <span className="text-sm truncate">{e.title}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Areas */}
      <SectionHeader right={<button onClick={() => setAddingArea(true)} className="g-lnk min-h-[44px] px-2 text-sm">+ Add</button>}>
        Areas
      </SectionHeader>
      {areas.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No areas</p>
      ) : (
        <div className="flex flex-wrap gap-2 px-4 py-1">
          {areas.map((a) => (
            <span key={a.id} className="flex items-center rounded-full bg-surface-0 shadow-[inset_0_0_0_1px_var(--color-gilt-b)] text-sm">
              <button onClick={() => setEditingArea(a)} className="min-h-[44px] pl-4 pr-1 active:opacity-60" aria-label={`Edit ${a.name}`}>
                {a.restricted ? `🔒 ${a.name}` : a.name}
              </button>
              <button onClick={() => removeArea(a.id)} className="min-h-[44px] min-w-[40px] px-2 text-error" aria-label={`Delete ${a.name}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Tasks grouped by status (kanban as stacked sections) */}
      {loading && !data ? (
        <Spinner />
      ) : tasks.length === 0 ? (
        <EmptyState text="No tasks yet. Tap + to add one." />
      ) : (
        <div className="pb-24 min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:gap-x-4 min-[700px]:items-start">
          {TASK_STATUSES.map((status) => {
            const group = tasks.filter((t) => t.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status} className="min-w-0">
                <SectionHeader mark={<StatusMark status={status} size={12} />}>
                  {status} <span className="gm-mut">· {group.length}</span>
                </SectionHeader>
                {group.map((t) => (
                  <ListRow
                    key={t.id}
                    title={isRestricted(t, areas) ? `🔒 ${t.title}` : t.title}
                    subtitle={areas.find((a) => a.id === t.area_id)?.name}
                    right={<Badge className={priorityClasses(t.priority)}>{t.priority}</Badge>}
                    left={t.pinned ? <span className="text-gold" aria-label="Pinned">★</span> : undefined}
                    onClick={() => nav.push(<TaskDetailScreen task={t} onChanged={refresh} />)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      <Fab onClick={() => setCreatingTask(true)} label="New task" />

      {creatingTask && (
        <TaskForm
          projectId={project.id}
          areas={areas}
          onClose={() => setCreatingTask(false)}
          onSaved={() => {
            setCreatingTask(false);
            refresh();
          }}
        />
      )}

      {editing && (
        <ProjectForm
          existing={project}
          onClose={() => setEditing(false)}
          onSaved={(p) => {
            setProject(p);
            setEditing(false);
            onChanged();
          }}
        />
      )}

      {addingArea && <AreaSheet projectId={project.id} onClose={() => setAddingArea(false)} onSaved={() => { setAddingArea(false); reload(); }} />}
      {editingArea && (
        <AreaSheet
          projectId={project.id}
          area={editingArea}
          onClose={() => setEditingArea(null)}
          onSaved={() => {
            setEditingArea(null);
            reload();
          }}
        />
      )}

      {actions && (
        <Sheet title="Project" onClose={() => setActions(false)}>
          <Button full variant="surface" onClick={() => { setActions(false); setEditing(true); }}>
            Edit project
          </Button>
          <Button
            full
            variant="surface"
            onClick={async () => {
              setActions(false);
              try {
                const p = await toggleProjectPin(project.id, !project.pinned);
                setProject(p);
                onChanged();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          >
            {project.pinned ? "Unpin project" : "Pin project"}
          </Button>
          <Button
            full
            variant="surface"
            onClick={async () => {
              setActions(false);
              try {
                await archiveProject(project.id, true);
                onChanged();
                nav.pop();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          >
            Archive project
          </Button>
          <Button
            full
            variant="danger"
            onClick={async () => {
              if (!await confirmDialog(`Delete "${project.name}"? This cannot be undone.`)) return;
              setActions(false);
              try {
                await deleteProject(project.id);
                onChanged();
                nav.pop();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          >
            Delete project
          </Button>
        </Sheet>
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="g-card flex-1 min-w-0 px-3 pt-2.5 pb-2 text-center">
      <div className="font-deco text-[20px] font-light leading-tight truncate tabular-nums">{value}</div>
      <div className="g-deco text-[10px] font-semibold gm-mut mt-0.5">{label}</div>
    </div>
  );
}

/** Proportional task-health bar (To Do / In Progress / Done / Blocked). */
function HealthBar({ s }: { s: ProjectStats["tasks_by_status"] }) {
  const total = s.todo + s.in_progress + s.done + s.blocked;
  if (total === 0) return null;
  const segs = [
    { label: "To Do", n: s.todo, c: statusColor("To Do") },
    { label: "In Progress", n: s.in_progress, c: statusColor("In Progress") },
    { label: "Done", n: s.done, c: statusColor("Done") },
    { label: "Blocked", n: s.blocked, c: statusColor("Blocked") },
  ];
  return (
    <div className="px-4 pt-3">
      <div className="flex gap-0.5 h-2 rounded overflow-hidden bg-surface-0">
        {segs
          .filter((x) => x.n > 0)
          .map((x) => (
            <div key={x.label} className={x.c} style={{ width: `${(x.n / total) * 100}%` }} title={`${x.label}: ${x.n}`} />
          ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {segs.map((x) => (
          <div key={x.label} className="flex items-center gap-1.5 text-xs gm-mut">
            <StatusMark status={x.label} size={10} />
            {x.label} <span className="text-text">{x.n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AreaSheet({ projectId, area, onClose, onSaved }: { projectId: number; area?: Area; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(area?.name ?? "");
  const [description, setDescription] = useState(area?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (area) {
        await updateArea(area.id, { name: name.trim(), description: description || undefined });
      } else {
        await createArea({ project_id: projectId, name: name.trim(), description: description || undefined });
      }
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={area ? "Edit area" : "New area"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} autoFocus />
      </Field>
      <Field label="Description">
        <TextArea value={description} onChange={setDescription} rows={2} />
      </Field>
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}
