import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { getTasks, getTaskTotalTime, getEvents, getAreas, getProjectAssignees } from '../lib/api';
import { getActiveWorkspaceId, LOCAL_ID } from '../lib/workspaces';
import {
  buildReport,
  toMarkdown,
  resolveRange,
  toYmd,
  fmtRange,
  RANGE_PRESETS,
  GROUPINGS,
  STATUS_ORDER,
  type RangePreset,
  type ReportGrouping,
  type AssigneeMap,
} from '../lib/reportGenerator';
import { EXPORT_FORMATS, exportBlob, exportFileName, type ExportFormat } from '../lib/reportExport';
import { downloadBlob } from '../lib/daemon';
import { notify, updateNotif } from '../store/notifications';
import MarkdownPreview from './MarkdownPreview';
import ScrollArea from './ScrollArea';
import { projectColorClass } from '../lib/projectColor';
import type { Task, Event, Area } from '../types';

// The report is LIVE: the engine is pure and cheap, so every option change
// re-renders the preview — no "Generate" button, nothing to forget to press.
// Data (tasks, areas, events) reloads only when the project selection changes.

const MICRO = 'g-deco text-[11px] font-semibold !tracking-[.2em] text-[color:var(--g-mut)]';
const MUTED = 'text-[color:var(--g-mut)]';

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`g-chip ${on ? 'g-on' : ''}`}
    >
      {children}
    </button>
  );
}

function Section({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="py-4 border-b border-gilt-b last:border-b-0">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className={MICRO}>{label}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function ReportGenerator({ projectId }: { projectId?: number } = {}) {
  const {
    projects: allProjects,
    taskTimes,
    setTaskTime,
    reportSelectedProjects,
    reportRange,
    reportStartDate,
    reportEndDate,
    reportSelectedStatuses,
    reportGrouping,
    reportVerbose,
    reportIncludeTime,
    reportIncludeAssignees,
    reportIncludeEvents,
    reportUserName,
    setReportSelectedProjects,
    setReportRange,
    setReportStartDate,
    setReportEndDate,
    setReportSelectedStatuses,
    setReportGrouping,
    setReportVerbose,
    setReportIncludeTime,
    setReportIncludeAssignees,
    setReportIncludeEvents,
    setReportUserName,
  } = useAppStore();

  // The store's `projects` is the K2 merge of EVERY workspace — a laptop whose
  // local DB is a copy of the host's lists each project twice, same numeric
  // id. This report fetches through the ACTIVE transport, so it can only speak
  // for the active workspace's projects; matching by bare id pulled the same
  // tasks twice (field: every task duplicated, 2026-09-09).
  // Memoized: a fresh array every render fed the scoped effect below, which
  // set the store, which re-rendered, which filtered again — "Maximum update
  // depth exceeded" on every project's Reports tab (field, 2026-09-09).
  const activeWs = getActiveWorkspaceId();
  const projects = useMemo(
    () => allProjects.filter((p) => (p.workspaceId ?? LOCAL_ID) === activeWs),
    [allProjects, activeWs]
  );

  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allEvents, setAllEvents] = useState<Event[]>([]);
  const [allAreas, setAllAreas] = useState<Area[]>([]);
  const [assignees, setAssignees] = useState<AssigneeMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'rendered' | 'markdown'>('rendered');
  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [exportOpen]);

  // Scoped to a project tab → just that project. Otherwise select all by default.
  const scoped = projectId != null;
  useEffect(() => {
    if (scoped) {
      // Idempotent: only write when the selection isn't already exactly this
      // project — a store write is a new array reference, hence a re-render.
      if (reportSelectedProjects.length !== 1 || reportSelectedProjects[0] !== projectId) {
        setReportSelectedProjects([projectId]);
      }
    } else if (projects.length > 0 && reportSelectedProjects.length === 0) {
      setReportSelectedProjects(projects.map((p) => p.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectId]);

  const selectedKey = [...reportSelectedProjects].sort().join(',');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const chosen = projects.filter((p) => reportSelectedProjects.includes(p.id));
        const [taskArrays, areaArrays, assigneeArrays, events] = await Promise.all([
          Promise.all(chosen.map((p) => getTasks(p.id, false))),
          // One project's areas/assignees failing must not sink the report — it just loses that detail there.
          Promise.all(chosen.map((p) => getAreas(p.id).catch(() => [] as Area[]))),
          Promise.all(chosen.map((p) => getProjectAssignees(p.id).catch(() => []))),
          getEvents(undefined, undefined, false).catch(() => [] as Event[]),
        ]);
        if (cancelled) return;
        const tasks = taskArrays.flat();
        setAllTasks(tasks);
        setAllAreas(areaArrays.flat());
        const byTask: AssigneeMap = {};
        for (const a of assigneeArrays.flat()) (byTask[a.task_id] ??= []).push(a.display_name || a.username);
        setAssignees(byTask);
        setAllEvents(events);
        // Tracked time, only for tasks we haven't priced yet.
        for (const t of tasks) {
          if (taskTimes[t.id] === undefined) {
            getTaskTotalTime(t.id).then((s) => { if (!cancelled) setTaskTime(t.id, s); }).catch(() => {});
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Period — resolved fresh every render so "this week" is THIS week.
  const today = new Date();
  const range = resolveRange(reportRange, today, { start: reportStartDate, end: reportEndDate });

  const doc = useMemo(() => {
    if (reportSelectedProjects.length === 0) return null;
    return buildReport(
      {
        projects: reportSelectedProjects,
        startDate: toYmd(range.start),
        endDate: toYmd(range.end),
        statuses: reportSelectedStatuses,
        grouping: reportGrouping,
        verbose: reportVerbose,
        includeTime: reportIncludeTime,
        includeAssignees: reportIncludeAssignees,
        includeEvents: reportIncludeEvents,
        userName: reportUserName.trim() || undefined,
      },
      allTasks,
      projects,
      taskTimes,
      allEvents,
      allAreas,
      today,
      assignees
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reportSelectedProjects, range.start.getTime(), range.end.getTime(), reportSelectedStatuses, reportGrouping,
    reportVerbose, reportIncludeTime, reportIncludeAssignees, reportIncludeEvents, reportUserName, allTasks, allEvents, allAreas,
    assignees, taskTimes, projects,
  ]);
  const report = useMemo(() => (doc ? toMarkdown(doc) : null), [doc]);

  // Every format from the same document — the download is the only side
  // effect, and its failure is LOUD (a silent export is a lost report).
  const doExport = async (format: ExportFormat) => {
    if (!doc || !report) return;
    setExportOpen(false);
    setExporting(format);
    const name = exportFileName(doc, format);
    const nid = notify({ kind: 'progress', category: 'system', title: `Exporting ${name}…` });
    try {
      const blob = await exportBlob(doc, report, format);
      downloadBlob(name, blob);
      updateNotif(nid, { kind: 'success', title: `Exported ${name}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateNotif(nid, { kind: 'error', title: 'Export failed', body: `${name}: ${msg}` });
    } finally {
      setExporting(null);
    }
  };

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      alert(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggleIn = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const sortedProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const groupingHint = GROUPINGS.find((g) => g.key === reportGrouping)?.hint;

  return (
    <div className="flex-1 flex flex-col bg-mantle h-full overflow-hidden">
      <div className="px-8 pt-[30px] pb-5 border-b border-gilt-b flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="g-deco text-xs text-gold">{fmtRange(range.start, range.end)}</div>
          <h1 className="g-ptitle text-text">Reports</h1>
          <p className={`text-sm mt-2 ${MUTED}`}>
            Tasks created, touched, completed or due in the period
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Options */}
        <ScrollArea className="w-80 shrink-0 border-r border-gilt-b bg-base" contentClassName="px-5">
          <Section label="Period">
            <div className="flex flex-wrap gap-1.5">
              {RANGE_PRESETS.map((p) => (
                <Chip key={p.key} on={reportRange === p.key} onClick={() => setReportRange(p.key as RangePreset)}>{p.label}</Chip>
              ))}
            </div>
            {reportRange === 'custom' && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                <label className="block">
                  <span className={`block text-[11px] mb-1 ${MUTED}`}>From</span>
                  <input type="date" value={reportStartDate} onChange={(e) => setReportStartDate(e.target.value)}
                    className={`g-field !px-2 !text-sm`} />
                </label>
                <label className="block">
                  <span className={`block text-[11px] mb-1 ${MUTED}`}>To</span>
                  <input type="date" value={reportEndDate} onChange={(e) => setReportEndDate(e.target.value)}
                    className={`g-field !px-2 !text-sm`} />
                </label>
              </div>
            )}
          </Section>

          {!scoped && (
            <Section
              label={`Projects · ${reportSelectedProjects.length}/${projects.length}`}
              aside={
                <div className="flex gap-1">
                  <button onClick={() => setReportSelectedProjects(projects.map((p) => p.id))} className="g-lnk !text-xs !min-h-[32px]">All</button>
                  <button onClick={() => setReportSelectedProjects([])} className="g-lnk !text-xs !min-h-[32px]">None</button>
                </div>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {sortedProjects.map((p) => (
                  <Chip key={p.id} on={reportSelectedProjects.includes(p.id)}
                    onClick={() => setReportSelectedProjects(toggleIn(reportSelectedProjects, p.id))}>
                    <span className={`g-gem !w-[7px] !h-[7px] ${projectColorClass(p)}`} aria-hidden="true" />
                    {p.name}
                  </Chip>
                ))}
              </div>
            </Section>
          )}

          <Section label="Grouping">
            <div className="flex flex-wrap gap-1.5">
              {GROUPINGS.map((g) => (
                <Chip key={g.key} on={reportGrouping === g.key} onClick={() => setReportGrouping(g.key as ReportGrouping)} title={g.hint}>
                  {g.label}
                </Chip>
              ))}
            </div>
            {groupingHint && <p className={`text-xs mt-2 ${MUTED}`}>{groupingHint}</p>}
          </Section>

          <Section label="Statuses">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_ORDER.map((s) => (
                <Chip key={s} on={reportSelectedStatuses.includes(s)}
                  onClick={() => setReportSelectedStatuses(toggleIn(reportSelectedStatuses, s))}>
                  {s}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label="Include">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={reportVerbose} onClick={() => setReportVerbose(!reportVerbose)} title="Task and event descriptions, on the same line">Descriptions</Chip>
              <Chip on={reportIncludeAssignees} onClick={() => setReportIncludeAssignees(!reportIncludeAssignees)} title="Who each task is assigned to">Assignees</Chip>
              <Chip on={reportIncludeTime} onClick={() => setReportIncludeTime(!reportIncludeTime)} title="Tracked time on tasks that have any">Tracked time</Chip>
              <Chip on={reportIncludeEvents} onClick={() => setReportIncludeEvents(!reportIncludeEvents)} title="Events in the period, plus the week after">Events</Chip>
            </div>
          </Section>

          <Section label="Header">
            <input
              type="text"
              value={reportUserName}
              onChange={(e) => setReportUserName(e.target.value)}
              placeholder="Your name (optional)"
              className="g-field"
            />
          </Section>
        </ScrollArea>

        {/* Preview */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-6 py-2.5 border-b border-gilt-b flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <button onClick={() => setView('rendered')} aria-pressed={view === 'rendered'}
                className={`g-chip ${view === 'rendered' ? 'g-on' : ''}`}>Rendered</button>
              <button onClick={() => setView('markdown')} aria-pressed={view === 'markdown'}
                className={`g-chip ${view === 'markdown' ? 'g-on' : ''}`}>Markdown</button>
              {isLoading && <span className={`ml-2 animate-pulse ${MUTED}`}>Loading…</span>}
              {loadError && <span className="ml-2 text-error" title={loadError}>Couldn't load tasks</span>}
            </div>
            <div className="flex items-center gap-2.5">
              {report && <span className={`text-xs tabular-nums ${MUTED}`}>{report.split('\n').length} lines · {report.length} chars</span>}
              <button
                onClick={copy}
                disabled={!report}
                className={`g-btn g-btn-sm ${copied ? 'g-btn-ghost !text-success' : 'g-btn-ghost'}`}
                title="Copy the markdown to the clipboard"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <div className="relative" ref={exportRef}>
                <button
                  onClick={() => setExportOpen((o) => !o)}
                  disabled={!report || !!exporting}
                  className="g-btn g-btn-pri g-btn-sm"
                  aria-expanded={exportOpen}
                >
                  {exporting ? `Exporting ${exporting.toUpperCase()}…` : 'Export'}
                  {!exporting && <span aria-hidden className="text-[10px] opacity-80">▾</span>}
                </button>
                {exportOpen && (
                  <div className="g-card absolute right-0 top-full mt-1.5 w-64 z-30 p-1.5 shadow-lg overflow-hidden">
                    {EXPORT_FORMATS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => void doExport(f.key)}
                        className="w-full text-left px-3 py-2 rounded hover:bg-gilt-b border-b border-gilt-b last:border-b-0"
                      >
                        <div className="text-sm text-text font-medium">{f.label} <span className={`text-xs ${MUTED}`}>.{f.key}</span></div>
                        <div className={`text-xs ${MUTED}`}>{f.hint}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <ScrollArea className="flex-1" contentClassName="p-8">
            {!report ? (
              <p className={`text-sm ${MUTED}`}>Pick at least one project.</p>
            ) : (
              <div className="g-card g-corners px-10 py-8 max-w-[calc(72ch+5rem)]">
                {view === 'rendered' ? (
                  <MarkdownPreview content={report} className="max-w-[72ch]" />
                ) : (
                  <pre className="text-xs font-mono text-text whitespace-pre-wrap break-words max-w-[72ch]">{report}</pre>
                )}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
