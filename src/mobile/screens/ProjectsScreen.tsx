import { useState } from "react";
import type { Task } from "../../types";
import { getAreas, getProjectEvents, getProjectStats, getProjects, getTasks } from "../../lib/api";
import { useNav } from "../nav";
import {
  EmptyState,
  ErrorBanner,
  Fab,
  RefreshBtn,
  Screen,
  Spinner,
  hhmm,
  useAsync,
} from "../ui";
import { StatusMark } from "../../components/comments/TaskTagPicker";
import { projectColorClass, projectInitial } from "../../lib/projectColor";
import ProjectForm from "../forms/ProjectForm";
import AskDonna from "./AskDonna";
import ProjectDetailScreen from "./ProjectDetailScreen";
import TaskDetailScreen from "./TaskDetailScreen";

interface Summary {
  taskCount: number;
  timeSeconds: number;
  upcoming: number;
}

export default function ProjectsScreen() {
  const nav = useNav();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, loading, error, reload } = useAsync(async () => {
    const projects = (await getProjects()).filter((p) => !p.archived);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const entries = await Promise.all(
      projects.map(async (p) => {
        const [stats, events] = await Promise.all([
          getProjectStats(p.id),
          getProjectEvents(p.id, false).catch(() => []),
        ]);
        const upcomingEvs = events.filter((e) => !e.done_at && new Date(e.event_date) >= startOfToday);
        const summary: Summary = { taskCount: stats.total_tasks, timeSeconds: stats.total_time_seconds, upcoming: upcomingEvs.length };
        return { id: p.id, summary, stats, upcomingEvs: upcomingEvs.map((e) => ({ title: e.title, date: e.event_date, project: p.name })) };
      })
    );
    const map = new Map(entries.map((e) => [e.id, e.summary] as const));
    const totals = {
      openTasks: entries.reduce(
        (s, e) => s + e.stats.tasks_by_status.todo + e.stats.tasks_by_status.in_progress + e.stats.tasks_by_status.blocked,
        0
      ),
      timeSeconds: entries.reduce((s, e) => s + e.stats.total_time_seconds, 0),
    };
    const upcomingEvents = entries
      .flatMap((e) => e.upcomingEvs)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(0, 5);
    return { projects, map, totals, upcomingEvents };
  }, []);

  const projects = (data?.projects ?? [])
    .slice()
    .sort((a, b) => (!!a.pinned === !!b.pinned ? a.name.localeCompare(b.name) : a.pinned ? -1 : 1));

  return (
    <Screen title="Projects" right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <EmptyState text="No projects yet. Tap + to create one." />
      ) : (
        <div className="pb-24">
          {data && <Dashboard projects={projects.length} totals={data.totals} upcoming={data.upcomingEvents} />}
          <div className="min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:items-start">
          {projects.map((p) => {
            const s = data!.map.get(p.id);
            const isOpen = expanded === p.id;
            return (
              <div key={p.id} className="border-b border-gilt-b min-w-0">
                <div className="flex items-stretch min-h-[60px]">
                  <button
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                    className="w-11 shrink-0 flex items-center justify-center text-gold/70 active:bg-surface-0"
                  >
                    <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-transform ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    onClick={() => nav.push(<ProjectDetailScreen project={p} onChanged={reload} />)}
                    className="flex-1 flex items-center gap-3 text-left py-2.5 pr-4 active:bg-surface-0 min-w-0"
                  >
                    <span className={`g-tile ${projectColorClass(p)}`} aria-hidden="true">{projectInitial(p.name)}</span>
                    <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-semibold truncate text-text">{p.name}</span>
                      {p.pinned && <span className="text-gold text-sm" aria-label="Pinned">★</span>}
                    </span>
                    <span className="block text-[13px] gm-mut mt-0.5 truncate">
                      {s
                        ? `${s.taskCount} task${s.taskCount === 1 ? "" : "s"} · ${hhmm(s.timeSeconds)} · ${s.upcoming} upcoming`
                        : "…"}
                    </span>
                    </span>
                  </button>
                </div>
                {isOpen && (
                  <ProjectTree
                    projectId={p.id}
                    onOpenTask={(t) => nav.push(<TaskDetailScreen task={t} onChanged={reload} />)}
                  />
                )}
              </div>
            );
          })}
          </div>
        </div>
      )}
      <Fab onClick={() => setCreating(true)} label="New project" />
      {creating && (
        <ProjectForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </Screen>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="g-card px-2 pt-3 pb-2.5 text-center">
      <div className="font-deco text-[24px] font-light leading-tight text-text tabular-nums">{value}</div>
      <div className="g-deco text-[10px] font-semibold gm-mut mt-1">{label}</div>
    </div>
  );
}

/** Cross-project home dashboard shown above the project list. */
function Dashboard({
  projects,
  totals,
  upcoming,
}: {
  projects: number;
  totals: { openTasks: number; timeSeconds: number };
  upcoming: { title: string; date: string; project: string }[];
}) {
  return (
    <div className="px-4 pt-3 pb-3 border-b border-gilt-a">
      {/* The secretary rides the phone's home screen — "so I wasn't stuck
          searching for it" (field). */}
      <AskDonna />
      <div className="grid grid-cols-3 gap-2">
        <Card label="Projects" value={String(projects)} />
        <Card label="Open tasks" value={String(totals.openTasks)} />
        <Card label="Tracked" value={hhmm(totals.timeSeconds)} />
      </div>
      {upcoming.length > 0 && (
        <div className="mt-3">
          <div className="g-deco flex items-center gap-2 text-[11px] font-semibold text-gold mb-2">
            <span className="g-gem w-1.5 h-1.5" aria-hidden="true" />
            Upcoming
          </div>
          <div className="space-y-1.5 min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:gap-2 min-[700px]:space-y-0">
            {upcoming.map((e, i) => {
              const d = new Date(e.date);
              return (
                <div key={i} className="g-plain flex items-center gap-3 px-3 py-2">
                  <div className="shrink-0 w-9 text-center">
                    <div className="g-deco text-[10px] text-gold">{d.toLocaleDateString(undefined, { month: "short" })}</div>
                    <div className="font-deco text-lg leading-none">{d.getDate()}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm truncate">{e.title}</div>
                    <div className="text-xs gm-mut truncate">{e.project}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const deadlineMs = (t: Task) => (t.deadline ? new Date(t.deadline).getTime() : Infinity);

/** Inline tree of a project's areas + tasks, tasks ordered by nearest deadline. */
function ProjectTree({ projectId, onOpenTask }: { projectId: number; onOpenTask: (t: Task) => void }) {
  const { data, loading } = useAsync(
    () => Promise.all([getAreas(projectId), getTasks(projectId, false)]),
    [projectId]
  );

  if (loading && !data) {
    return <div className="pl-11 py-3 text-sm gm-mut">Loading…</div>;
  }

  const areas = data?.[0] ?? [];
  const tasks = data?.[1] ?? [];

  const groups = areas.map((a) => ({
    name: a.name,
    tasks: tasks.filter((t) => t.area_id === a.id).sort((x, y) => deadlineMs(x) - deadlineMs(y)),
  }));
  const noArea = tasks.filter((t) => !t.area_id).sort((x, y) => deadlineMs(x) - deadlineMs(y));
  if (noArea.length) groups.push({ name: "No area", tasks: noArea });

  // Order branches by their nearest task deadline so the most urgent area is first.
  groups.sort((g1, g2) => (g1.tasks[0] ? deadlineMs(g1.tasks[0]) : Infinity) - (g2.tasks[0] ? deadlineMs(g2.tasks[0]) : Infinity));

  if (groups.length === 0) {
    return <div className="pl-11 py-3 text-sm gm-mut italic">No areas or tasks</div>;
  }

  return (
    <div className="bg-crust/50 border-t border-gilt-b pb-2">
      {groups.map((g) => (
        <div key={g.name} className="pl-11 pr-3">
          <div className="g-deco text-[10px] font-semibold gm-mut pt-3 pb-1">{g.name}</div>
          {g.tasks.length === 0 ? (
            <div className="text-xs gm-mut italic pb-1">No tasks</div>
          ) : (
            g.tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTask(t)}
                className="w-full flex items-center gap-3 min-h-[44px] text-left active:bg-surface-0"
              >
                <StatusMark status={t.status} size={12} />
                <span className="flex-1 truncate text-sm text-text">{t.title}</span>
                {t.deadline && (
                  <span className="text-xs gm-mut tabular-nums">
                    {new Date(t.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
