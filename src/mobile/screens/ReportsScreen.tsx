import { useState } from "react";
import type { Task } from "../../types";
import { getEvents, getProjects, getProjectStats, getTaskTotalTime, getTasks } from "../../lib/api";
import { formatDuration, generateReport, type ReportConfig, resolveRange, toYmd } from "../../lib/reportGenerator";
import { useNav } from "../nav";
import { projectColorClass, projectInitial } from "../../lib/projectColor";
import {
  Button,
  EmptyState,
  ErrorBanner,
  RefreshBtn,
  Screen,
  Select,
  Sheet,
  Spinner,
  Toggle,
  copyText,
  errMsg,
  useAsync,
} from "../ui";

/** Map over items with bounded concurrency — avoids firing one HTTP request per
 * task simultaneously when generating an all-projects report. */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type Range = "All time" | "This month" | "This week";

/** Same period grammar as the desktop report (Monday-start weeks, whole
 * calendar month); "All time" is the one range the engine has no preset for. */
function rangeDates(r: Range): { start: string; end: string } {
  const now = new Date();
  if (r === "This month") {
    const { start, end } = resolveRange("this-month", now);
    return { start: toYmd(start), end: toYmd(end) };
  }
  if (r === "This week") {
    const { start, end } = resolveRange("this-week", now);
    return { start: toYmd(start), end: toYmd(end) };
  }
  return { start: "1970-01-01", end: toYmd(now) };
}

export default function ReportsScreen({ projectId }: { projectId?: number } = {}) {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(async () => {
    const projects = (await getProjects()).filter((p) => !p.archived);
    const stats = await Promise.all(projects.map((p) => getProjectStats(p.id)));
    return projects.map((project, i) => ({ project, stats: stats[i] }));
  }, []);

  const [scope, setScope] = useState<number | "all">(projectId ?? "all");
  const [range, setRange] = useState<Range>("This month");
  const [verbose, setVerbose] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const rows = (data ?? []).filter((d) => scope === "all" || d.project.id === scope);
  const totals = rows.reduce(
    (acc, { stats }) => ({
      tasks: acc.tasks + stats.total_tasks,
      seconds: acc.seconds + stats.total_time_seconds,
      cost: acc.cost + stats.total_cost,
    }),
    { tasks: 0, seconds: 0, cost: 0 }
  );

  async function generateDetailed() {
    if (!data) return;
    setGenerating(true);
    try {
      const allProjects = data.map((d) => d.project);
      const inScope = scope === "all" ? allProjects : allProjects.filter((p) => p.id === scope);
      const taskArrays = await Promise.all(inScope.map((p) => getTasks(p.id, false)));
      const allTasks: Task[] = taskArrays.flat();
      const times: Record<number, number> = {};
      await mapLimit(allTasks, 6, async (t) => {
        times[t.id] = await getTaskTotalTime(t.id).catch(() => 0);
      });
      const events = await getEvents(undefined, undefined, false).catch(() => []);
      const { start, end } = rangeDates(range);
      const cfg: ReportConfig = {
        projects: inScope.map((p) => p.id),
        startDate: start,
        endDate: end,
        statuses: ["To Do", "In Progress", "Done", "Blocked"],
        grouping: "status",
        verbose,
        includeTime: true,
        includeAssignees: true,
        includeEvents: true,
      };
      setReport(generateReport(cfg, allTasks, inScope, times, events));
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setGenerating(false);
    }
  }

  const scopeOptions: { value: number | "all"; label: string }[] = [
    { value: "all", label: "All projects" },
    ...(data ?? []).map((d) => ({ value: d.project.id, label: d.project.name })),
  ];

  return (
    <Screen title="Reports" onBack={nav.pop} right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState text="No active projects to report on." />
      ) : (
        <div className="p-4 space-y-4 min-[700px]:space-y-0 min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:gap-4 min-[700px]:items-start">
          {/* Scope + generate */}
          <div className="space-y-4 min-[700px]:col-span-2">
          <Select value={scope} options={scopeOptions} onChange={setScope} />
          <Button full onClick={generateDetailed} disabled={generating}>
            {generating ? "Generating…" : "Detailed report"}
          </Button>
          </div>

          {/* Quick stats */}
          <div className="g-card g-corners p-4 min-[700px]:col-span-2">
            <div className="g-flbl mb-2">
              {scope === "all" ? "Across all projects" : "Project"}
            </div>
            <div className="flex gap-6">
              <div>
                <div className="font-deco text-2xl font-light tabular-nums">{totals.tasks}</div>
                <div className="text-xs gm-mut">Tasks</div>
              </div>
              <div>
                <div className="font-deco text-2xl font-light tabular-nums">{formatDuration(totals.seconds)}</div>
                <div className="text-xs gm-mut">Tracked</div>
              </div>
              <div>
                <div className="font-deco text-2xl font-light tabular-nums">{totals.cost.toFixed(0)}</div>
                <div className="text-xs gm-mut">Cost</div>
              </div>
            </div>
          </div>

          {rows.map(({ project, stats }) => (
            <div key={project.id} className="g-card p-4 min-w-0">
              <div className="flex items-center gap-2.5 mb-2 min-w-0">
                <span className={`g-tile ${projectColorClass(project)}`} aria-hidden="true">{projectInitial(project.name)}</span>
                <span className="font-semibold truncate">{project.name}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm gm-fg2">
                <span>To Do {stats.tasks_by_status.todo}</span>
                <span>In Progress {stats.tasks_by_status.in_progress}</span>
                <span>Done {stats.tasks_by_status.done}</span>
                <span>Blocked {stats.tasks_by_status.blocked}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm gm-mut mt-2">
                <span>{stats.total_tasks} tasks</span>
                <span>{formatDuration(stats.total_time_seconds)}</span>
                <span>{stats.total_files} files</span>
                {stats.total_cost > 0 && <span>cost {stats.total_cost.toFixed(2)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {report !== null && (
        <Sheet
          title="Report"
          onClose={() => setReport(null)}
          footer={
            <Button
              full
              onClick={async () => alert((await copyText(report)) ? "Report copied to clipboard" : "Could not copy")}
            >
              Copy
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {(["All time", "This month", "This week"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  aria-pressed={range === r}
                  className="gm-chip gm-chip-sm"
                >
                  {r}
                </button>
              ))}
            </div>
            <Toggle label="Include task descriptions" value={verbose} onChange={setVerbose} />
            <Button full variant="surface" onClick={generateDetailed} disabled={generating}>
              {generating ? "Generating…" : "Regenerate"}
            </Button>
            <pre className="g-inset text-xs whitespace-pre-wrap break-words text-text">
              {report || "No data for this range."}
            </pre>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}
