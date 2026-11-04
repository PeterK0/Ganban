import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataPulse } from '../../lib/livePulse';
import { listWorkspaces, LOCAL_ID, type Workspace } from '../../lib/workspaces';
import { useAppStore } from '../../store/appStore';
import type { CommentBoard as BoardData, Project, Task, User } from '../../types';
import type { ReactionSummary } from '../../lib/daemon';
import CommentBoard, { BoardFeed, UpdateComposer, parseTs, toItems, type BoardContext } from './CommentBoard';
import { fmtSecs } from './TaskTagPicker';
import { todayStartIso, workspaceBoardApi, type BoardApi } from './boardApi';
import { CollapsedNote, FEED_COLUMN, SectionToggle, useCollapsed } from './collapse';
import { Card } from '../gilt';
import { projectColorClass } from '../../lib/projectColor';

/**
 * Home → Updates: the comment boards of every project, with a tab per project
 * (and All). Each project's board talks to that project's OWN workspace, so
 * posting from Home lands on the right host. Follows the sidebar's project
 * filter when one is set.
 */

const TAB_KEY = 'ganban:home-updates-tab'; // cosmetic preference (TAB_SPEC: ok in localStorage)
const pk = (p: { workspaceId?: string; id: number }) => `${p.workspaceId ?? LOCAL_ID}:${p.id}`;
const MUTED = 'text-[color:var(--g-mut)]';

function wsOf(p: Project): Workspace | undefined {
  return listWorkspaces().find((w) => w.id === (p.workspaceId ?? LOCAL_ID));
}

export default function HomeUpdates({
  projects,
  tasks,
  filterProjectKey,
  onOpenTask,
  onOpenBoard,
}: {
  /** Active projects (all workspaces), already in display order. */
  projects: Project[];
  /** Live tasks across workspaces (tagged with workspaceId). */
  tasks: Task[];
  /** The sidebar's Home project filter, if any. */
  filterProjectKey: string | null;
  onOpenTask: (task: Task) => void;
  onOpenBoard?: (project: Project, taskIds: number[]) => void;
}) {
  const [tab, setTabState] = useState<string>(() => localStorage.getItem(TAB_KEY) ?? 'all');
  const [collapsed, toggleCollapsed] = useCollapsed('home-updates');
  const setTab = (t: string) => {
    setTabState(t);
    localStorage.setItem(TAB_KEY, t);
  };
  const locked = filterProjectKey != null ? projects.find((p) => pk(p) === filterProjectKey) ?? null : null;
  const current = locked ?? (tab === 'all' ? null : projects.find((p) => pk(p) === tab) ?? null);
  const tasksOf = useCallback((p: Project) => tasks.filter((t) => `${t.workspaceId ?? LOCAL_ID}:${t.project_id}` === pk(p)), [tasks]);

  if (projects.length === 0) return null;
  const ws = current ? wsOf(current) : undefined;

  return (
    <Card as="section" className="px-[26px] pt-[22px] pb-4 min-w-0 col-span-full" aria-label="Updates">
      {/* The heading is the collapse toggle (remembered per surface). */}
      <SectionToggle
        label="Updates"
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        action={
          current && onOpenBoard ? (
            <button
              onClick={() => onOpenBoard(current, [])}
              title={`Open ${current.name}’s Comments tab`}
              className="g-lnk !gap-0 text-[13px] min-h-[32px] px-2 max-w-full whitespace-nowrap"
            >
              Open&nbsp;<span className="truncate min-w-0">{current.name}</span>’s Comments →
            </button>
          ) : undefined
        }
      />
      <div className={FEED_COLUMN}>
        {!collapsed && !locked && projects.length > 1 && (
          <div className="flex flex-wrap justify-center items-center gap-1.5 mb-4">
            {[{ key: 'all', label: 'All', p: null as Project | null }, ...projects.map((p) => ({ key: pk(p), label: p.name, p }))].map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`g-chip ${(current ? pk(current) : 'all') === t.key ? 'g-on' : ''}`}
              >
                {t.p && <span className={`g-gem ${projectColorClass(t.p)}`} aria-hidden="true" />}
                {t.label}
              </button>
            ))}
          </div>
        )}
        {collapsed ? (
          <CollapsedNote label="Updates" onShow={toggleCollapsed} />
        ) : current && ws ? (
          <CommentBoard
            key={pk(current)}
            api={workspaceBoardApi(ws)}
            projectId={current.id}
            tasks={tasksOf(current)}
            variant="compact"
            pageSize={6}
            onMore={onOpenBoard ? () => onOpenBoard(current, []) : undefined}
            onTaskClick={(id) => {
              const t = tasksOf(current).find((x) => x.id === id);
              if (t) onOpenTask(t);
            }}
          />
        ) : current ? (
          <p className={`text-center my-2 ${MUTED}`}>This project’s workspace isn’t connected.</p>
        ) : (
          <AllFeed projects={projects} tasksOf={tasksOf} onOpenTask={onOpenTask} onPickProject={(p) => setTab(pk(p))} />
        )}
      </div>
    </Card>
  );
}

interface Loaded {
  project: Project;
  api: BoardApi;
  board: BoardData;
  users: User[];
  reactions: ReactionSummary[];
}

/** Every project's latest updates merged into one feed, plus a composer that
 * posts to a chosen project. */
function AllFeed({
  projects,
  tasksOf,
  onOpenTask,
  onPickProject,
}: {
  projects: Project[];
  tasksOf: (p: Project) => Task[];
  onOpenTask: (task: Task) => void;
  onPickProject: (p: Project) => void;
}) {
  const PER_PROJECT = 8;
  const SHOWN = 10;
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const seq = useRef(0);
  const { activeTask } = useAppStore();
  const projectsKey = projects.map(pk).join('|');

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const usersByWs = new Map<string, Promise<User[]>>();
    const since = todayStartIso();
    const results = await Promise.all(
      projects.map(async (project): Promise<Loaded | string> => {
        const ws = wsOf(project);
        if (!ws) return project.name;
        const api = workspaceBoardApi(ws);
        if (!usersByWs.has(ws.id)) usersByWs.set(ws.id, api.users().catch(() => []));
        try {
          const [board, users, reactions] = await Promise.all([
            api.load(project.id, { limit: PER_PROJECT, since }),
            usersByWs.get(ws.id)!,
            api.reactions ? api.reactions(project.id).catch(() => []) : Promise.resolve([]),
          ]);
          return { project, api, board, users, reactions };
        } catch {
          return project.name; // older host, offline — say so, don't break the feed
        }
      })
    );
    if (mine !== seq.current) return;
    setLoaded(results.filter((r): r is Loaded => typeof r !== 'string'));
    setFailed(results.filter((r): r is string => typeof r === 'string'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsKey]);
  useEffect(() => {
    void load();
  }, [load]);
  useDataPulse(() => void load(), ['comments', 'tasks']);

  const contexts = useMemo(
    () =>
      (loaded ?? []).map((l) => ({
        l,
        ctx: {
          api: l.api,
          projectId: l.project.id,
          projectName: l.project.name,
          tasks: tasksOf(l.project),
          users: l.users,
          reactions: l.reactions,
          onChanged: () => void load(),
        } as BoardContext,
      })),
    [loaded, tasksOf, load]
  );
  const items = useMemo(
    () =>
      contexts
        .flatMap(({ l, ctx }) => toItems(l.board, ctx))
        .sort((a, b) => parseTs(b.root.created_at).getTime() - parseTs(a.root.created_at).getTime())
        .slice(0, SHOWN),
    [contexts]
  );

  // Where a new update goes: picked, else the active task's project, else
  // the project you tracked the most time on today, else the first.
  const defaultTarget = useMemo(() => {
    const byActive = activeTask ? contexts.find(({ l }) => l.project.id === activeTask.project_id && tasksOf(l.project).some((t) => t.id === activeTask.id)) : undefined;
    if (byActive) return pk(byActive.l.project);
    const busiest = [...contexts].sort(
      (a, b) => b.l.board.time_since.reduce((s, x) => s + x.seconds, 0) - a.l.board.time_since.reduce((s, x) => s + x.seconds, 0)
    )[0];
    return busiest ? pk(busiest.l.project) : null;
  }, [contexts, activeTask, tasksOf]);
  const chosen = contexts.find(({ l }) => pk(l.project) === (target ?? defaultTarget)) ?? contexts[0];

  if (!loaded) return <p className={`text-center my-2 ${MUTED}`}>Loading updates…</p>;

  const suggestions = chosen
    ? [
        ...(activeTask && activeTask.project_id === chosen.l.project.id ? [{ taskId: activeTask.id, hint: '▶ active' }] : []),
        ...chosen.l.board.time_since
          .filter((t) => !(activeTask && t.task_id === activeTask.id))
          .map((t) => ({ taskId: t.task_id, hint: `⏱ ${fmtSecs(t.seconds)} today` })),
      ]
    : [];

  return (
    <div className="space-y-2.5">
      {chosen && (
        <UpdateComposer
          key={pk(chosen.l.project)}
          ctx={chosen.ctx}
          defaultTags={[]}
          suggestions={suggestions}
          compact
          leading={
            contexts.length > 1 ? (
              <div className="flex items-center gap-2">
                <span className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)]">Project</span>
                <select
                  value={pk(chosen.l.project)}
                  onChange={(e) => setTarget(e.target.value)}
                  className="g-field g-field-sm w-auto"
                >
                  {contexts.map(({ l }) => (
                    <option key={pk(l.project)} value={pk(l.project)}>
                      {l.project.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null
          }
        />
      )}
      <BoardFeed
        items={items}
        variant="compact"
        onTaskClick={(ctx, id) => {
          const t = ctx.tasks.find((x) => x.id === id);
          if (t) onOpenTask(t);
        }}
        onProjectClick={(ctx) => {
          const p = contexts.find((c) => c.ctx === ctx)?.l.project;
          if (p) onPickProject(p);
        }}
        empty={<p className={`text-center my-2 ${MUTED}`}>No updates yet in any project.</p>}
      />
      {failed.length > 0 && (
        <p className={`text-xs px-1 ${MUTED}`}>
          Not shown (host offline or not updated yet): {failed.join(', ')}
        </p>
      )}
    </div>
  );
}
