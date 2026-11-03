// Report engine — a PURE module: config + data in, a STRUCTURED document out
// (buildReport), which renderers turn into markdown (here), HTML, XLSX and PDF
// (reportExport.ts). No fetching, no clocks read implicitly (today is a
// parameter), so it is testable and the preview can re-run on every keystroke.
//
// Grammar (the whole document obeys it — one locale, one date shape):
//   · dates read "Tue 9 Sep"; the header adds the year; weeks start Monday
//   · a date appears on a task line ONLY when it carries information the
//     heading doesn't: a deadline (future-facing), or a completion day on a
//     multi-day report. Creation dates are never shown — that was the old
//     "every line stamped with the same day" noise.
//   · headings nest project (##) → group (###) → sub-group (####); empty
//     groups are dropped; ✓ marks a done task only when its status ISN'T the
//     heading it sits under.
//   · a task is ONE line: title — description · assignee · due · time. A
//     description as its own paragraph inside the bullet rendered as an
//     indented mess; one line reads as one item.

import type { Task, Project, Event, Area, TaskStatus } from '../types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'custom';

export type ReportGrouping = 'none' | 'area' | 'status' | 'area-status' | 'status-area';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this-week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'custom', label: 'Custom' },
];

export const GROUPINGS: { key: ReportGrouping; label: string; hint: string }[] = [
  { key: 'none', label: 'None', hint: 'Tasks listed straight under each project.' },
  { key: 'area', label: 'Area', hint: 'Each project split into its areas, in the project’s own order.' },
  { key: 'status', label: 'Status', hint: 'Each project split by status: To Do → In Progress → Blocked → Done.' },
  { key: 'area-status', label: 'Area › Status', hint: 'Areas first, then each area’s tasks by status.' },
  { key: 'status-area', label: 'Status › Area', hint: 'Statuses first, then each status’s tasks by area.' },
];

/** The pipeline order — the same order the board reads in. */
export const STATUS_ORDER: TaskStatus[] = ['To Do', 'In Progress', 'Blocked', 'Done'];

export interface ReportConfig {
  projects: number[];
  /** Resolved period, inclusive, as YYYY-MM-DD (see resolveRange). */
  startDate: string;
  endDate: string;
  statuses: string[];
  grouping: ReportGrouping;
  /** Include task/event descriptions on the line. */
  verbose: boolean;
  /** Append tracked time to task lines that have any. */
  includeTime: boolean;
  /** Append who a task is assigned to. */
  includeAssignees: boolean;
  includeEvents: boolean;
  userName?: string;
}

/** task id → display names of everyone assigned. */
export type AssigneeMap = Record<number, string[]>;

// ---------------------------------------------------------------------------
// The document model — what every renderer consumes. Selection, grouping,
// ordering and the "does this date carry information" rules are resolved
// HERE, once, so markdown/HTML/XLSX/PDF can never disagree about content.
// ---------------------------------------------------------------------------

export interface DocTask {
  title: string;
  prefix?: string;
  status: TaskStatus;
  priority: string;
  done: boolean;
  /** Mark completion visibly — the task is done but sits under a heading that isn't "Done". */
  mark: boolean;
  /** One-line description; present only when the config includes descriptions. */
  description?: string;
  /** Present only when the config includes assignees. */
  assignees: string[];
  /** Open tasks only. */
  due?: Date;
  overdue: boolean;
  /** Done tasks: when. Shown on multi-day reports only (showCompleted). */
  completedAt?: Date;
  showCompleted: boolean;
  /** Seconds; 0 when not included or none. */
  trackedSeconds: number;
  project: string;
  area: string | null;
}

export interface DocGroup {
  /** '' for the ungrouped case. */
  label: string;
  depth: 3 | 4;
  isStatus: boolean;
  tasks?: DocTask[];
  children?: DocGroup[];
}

export interface DocProject { name: string; groups: DocGroup[] }

export interface DocEvent {
  date: Date;
  time?: string;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
}

export interface ReportDoc {
  title: string;
  /** "Scott · generated Wed 9 Sept 2026 · 2 projects · …" — as parts. */
  summary: string[];
  start: Date;
  end: Date;
  /** Year of the period end — dates in other years print their year. */
  year: number;
  eventSections: { heading: string; events: DocEvent[] }[];
  projects: DocProject[];
  /** Nothing to list — renderers say so plainly. */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Dates — ONE grammar
// ---------------------------------------------------------------------------

const LOCALE = 'en-GB';

/** 'YYYY-MM-DD' → LOCAL midnight (new Date('YYYY-MM-DD') is UTC midnight,
 * which lands on the previous day west of Greenwich); anything else → Date. */
export function parseWhen(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}

export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Monday-start week containing d. */
function mondayOf(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(x, -dow);
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Composed from parts, not from one toLocaleDateString call: en-GB punctuates
// "Wed, 9 Sept 2026" WITH the year but "Wed 9 Sept" without — two shapes in
// one document. Parts give one shape everywhere.
const part = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(LOCALE, o);
const dayMonth = (d: Date) => `${d.getDate()} ${part(d, { month: 'short' })}`;

/** "Tue 9 Sep" — adds the year only when it differs from `year`. */
export function fmtDay(d: Date, year?: number): string {
  const base = `${part(d, { weekday: 'short' })} ${dayMonth(d)}`;
  return year !== undefined && d.getFullYear() !== year ? `${base} ${d.getFullYear()}` : base;
}
/** "Tue 9 Sep 2026" */
export function fmtDayYear(d: Date): string {
  return `${part(d, { weekday: 'short' })} ${dayMonth(d)} ${d.getFullYear()}`;
}
/** "7–13 Sep 2026" · "28 Sep – 4 Oct 2026" · "30 Dec 2025 – 5 Jan 2026" · single day → fmtDayYear */
export function fmtRange(start: Date, end: Date): string {
  if (sameDay(start, end)) return fmtDayYear(start);
  const dmy = (d: Date) => `${dayMonth(d)} ${d.getFullYear()}`;
  if (start.getFullYear() !== end.getFullYear()) return `${dmy(start)} – ${dmy(end)}`;
  if (start.getMonth() !== end.getMonth()) return `${dayMonth(start)} – ${dmy(end)}`;
  return `${start.getDate()}–${end.getDate()} ${part(end, { month: 'short' })} ${end.getFullYear()}`;
}

/** Resolve a preset to an inclusive [start, end] pair of local midnights. A
 * custom range with missing/invalid dates falls back to this week — never to
 * an empty report with no explanation. */
export function resolveRange(
  preset: RangePreset,
  today: Date,
  custom?: { start: string; end: string }
): { start: Date; end: Date } {
  const t = startOfDay(today);
  switch (preset) {
    case 'today':
      return { start: t, end: t };
    case 'yesterday': {
      const y = addDays(t, -1);
      return { start: y, end: y };
    }
    case 'this-week': {
      const mon = mondayOf(t);
      return { start: mon, end: addDays(mon, 6) };
    }
    case 'last-week': {
      const mon = addDays(mondayOf(t), -7);
      return { start: mon, end: addDays(mon, 6) };
    }
    case 'this-month':
      return { start: new Date(t.getFullYear(), t.getMonth(), 1), end: new Date(t.getFullYear(), t.getMonth() + 1, 0) };
    case 'last-month':
      return { start: new Date(t.getFullYear(), t.getMonth() - 1, 1), end: new Date(t.getFullYear(), t.getMonth(), 0) };
    case 'custom': {
      if (custom?.start && custom?.end) {
        const s = parseWhen(custom.start);
        const e = parseWhen(custom.end);
        if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
          return s <= e ? { start: startOfDay(s), end: startOfDay(e) } : { start: startOfDay(e), end: startOfDay(s) };
        }
      }
      const mon = mondayOf(t);
      return { start: mon, end: addDays(mon, 6) };
    }
  }
}

/** What kind of period this is — drives the title. */
export function describeRange(start: Date, end: Date): { kind: 'day' | 'week' | 'month' | 'custom'; title: string } {
  if (sameDay(start, end)) return { kind: 'day', title: `Daily report — ${fmtDayYear(start)}` };
  const isMonday = (start.getDay() + 6) % 7 === 0;
  if (isMonday && sameDay(addDays(start, 6), end)) return { kind: 'week', title: `Weekly report — ${fmtRange(start, end)}` };
  const lastOfMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  if (start.getDate() === 1 && sameDay(end, lastOfMonth)) {
    return { kind: 'month', title: `Monthly report — ${start.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })}` };
  }
  return { kind: 'custom', title: `Report — ${fmtRange(start, end)}` };
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/** "2h 30m" · "45m" · "0m" (kept exported — CommentsTab uses it). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A description collapsed to ONE line — whitespace runs (including
 * newlines) become single spaces, so a multi-paragraph note still sits on
 * the task's own bullet. */
function oneLine(text: string | undefined): string | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

// ---------------------------------------------------------------------------
// Selection — what "in the period" means
// ---------------------------------------------------------------------------

interface Period {
  start: Date;
  endExclusive: Date; // start of the day AFTER end
}

function within(w: Period, iso?: string | null): boolean {
  if (!iso) return false;
  const t = parseWhen(iso).getTime();
  return !isNaN(t) && t >= w.start.getTime() && t < w.endExclusive.getTime();
}

/**
 * A DONE task belongs to the period only if it was completed in it — a task
 * finished months ago whose deadline happens to fall in range is not "done
 * this period" (the old generator listed it as such). An OPEN task belongs if
 * it was created, touched, or is due in the period.
 */
export function taskInPeriod(task: Task, w: Period): boolean {
  if (task.status === 'Done') return within(w, task.completed_at ?? task.updated_at);
  return within(w, task.created_at) || within(w, task.updated_at) || within(w, task.deadline);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

type Level = 'area' | 'status';

export interface Group {
  label: string;
  /** Set when this group IS a status — its tasks need no ✓. */
  status?: TaskStatus;
  tasks: Task[];
  children?: Group[];
}

function levelsFor(g: ReportGrouping): Level[] {
  switch (g) {
    case 'none': return [];
    case 'area': return ['area'];
    case 'status': return ['status'];
    case 'area-status': return ['area', 'status'];
    case 'status-area': return ['status', 'area'];
  }
}

const NO_AREA = 'No area';

function bucketByArea(tasks: Task[], areas: Area[]): Group[] {
  const groups: Group[] = areas.map((a) => ({ label: a.name, tasks: [] }));
  const idx = new Map(areas.map((a, i) => [a.id, i]));
  const none: Task[] = [];
  for (const t of tasks) {
    const i = t.area_id != null ? idx.get(t.area_id) : undefined;
    if (i === undefined) none.push(t);
    else groups[i].tasks.push(t);
  }
  if (none.length) groups.push({ label: NO_AREA, tasks: none });
  return groups.filter((g) => g.tasks.length > 0);
}

function bucketByStatus(tasks: Task[]): Group[] {
  return STATUS_ORDER
    .map((s) => ({ label: s, status: s, tasks: tasks.filter((t) => t.status === s) }))
    .filter((g) => g.tasks.length > 0);
}

/** Open tasks first (soonest deadline first, undated last, then title), then
 * done tasks (most recently completed first). */
function orderLeaf(tasks: Task[]): Task[] {
  const open = tasks.filter((t) => t.status !== 'Done');
  const done = tasks.filter((t) => t.status === 'Done');
  open.sort((a, b) => {
    const da = a.deadline ? parseWhen(a.deadline).getTime() : Infinity;
    const db = b.deadline ? parseWhen(b.deadline).getTime() : Infinity;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });
  done.sort((a, b) => parseWhen(b.completed_at ?? b.updated_at).getTime() - parseWhen(a.completed_at ?? a.updated_at).getTime());
  return [...open, ...done];
}

export function groupTasks(tasks: Task[], levels: Level[], areas: Area[]): Group[] {
  if (levels.length === 0) return [{ label: '', tasks: orderLeaf(tasks) }];
  const [head, ...rest] = levels;
  const groups = head === 'area' ? bucketByArea(tasks, areas) : bucketByStatus(tasks);
  return groups.map((g) =>
    rest.length ? { ...g, tasks: [], children: groupTasks(g.tasks, rest, areas) } : { ...g, tasks: orderLeaf(g.tasks) }
  );
}

// ---------------------------------------------------------------------------
// Building the document
// ---------------------------------------------------------------------------

interface BuildCtx {
  verbose: boolean;
  includeTime: boolean;
  includeAssignees: boolean;
  taskTimes: Record<number, number>;
  assignees: AssigneeMap;
  todayStart: Date;
  multiDay: boolean;
  project: string;
  areaName: Map<number, string>;
}

function docTask(t: Task, ctx: BuildCtx, statusIsHeading: boolean): DocTask {
  const done = t.status === 'Done';
  const due = !done && t.deadline ? parseWhen(t.deadline) : undefined;
  const tracked = ctx.includeTime ? ctx.taskTimes[t.id] || 0 : 0;
  return {
    title: t.title,
    prefix: t.prefix || undefined,
    status: t.status,
    priority: t.priority,
    done,
    mark: done && !statusIsHeading,
    description: ctx.verbose ? oneLine(t.description) ?? undefined : undefined,
    assignees: ctx.includeAssignees ? ctx.assignees[t.id] ?? [] : [],
    due,
    overdue: !!due && due < ctx.todayStart,
    // Same signal the selection trusts (completed_at, else updated_at) — a
    // task that qualified for the period must be able to say when.
    completedAt: done ? parseWhen(t.completed_at ?? t.updated_at) : undefined,
    showCompleted: done && ctx.multiDay,
    trackedSeconds: tracked,
    project: ctx.project,
    area: t.area_id != null ? ctx.areaName.get(t.area_id) ?? null : null,
  };
}

function docGroups(groups: Group[], depth: 3 | 4, ctx: BuildCtx, statusIsHeading = false): DocGroup[] {
  return groups.map((g) => {
    const isStatus = statusIsHeading || !!g.status;
    if (g.children) {
      return { label: g.label, depth, isStatus, children: docGroups(g.children, 4, ctx, isStatus) };
    }
    return { label: g.label, depth, isStatus, tasks: g.tasks.map((t) => docTask(t, ctx, isStatus)) };
  });
}

function docEvent(e: Event, verbose: boolean): DocEvent {
  return {
    date: parseWhen(e.event_date),
    time: e.start_time || undefined,
    allDay: !!e.all_day,
    title: e.title,
    location: e.location || undefined,
    description: verbose ? oneLine(e.description) ?? undefined : undefined,
  };
}

function eventSort(a: Event, b: Event): number {
  const d = parseWhen(a.event_date).getTime() - parseWhen(b.event_date).getTime();
  return d !== 0 ? d : (a.start_time ?? '').localeCompare(b.start_time ?? '');
}

export function buildReport(
  config: ReportConfig,
  allTasks: Task[],
  projects: Project[],
  taskTimes: Record<number, number>,
  allEvents: Event[] = [],
  allAreas: Area[] = [],
  today: Date = new Date(),
  assignees: AssigneeMap = {}
): ReportDoc {
  const start = startOfDay(parseWhen(config.startDate));
  const end = startOfDay(parseWhen(config.endDate));
  const w: Period = { start, endExclusive: addDays(end, 1) };
  const todayStart = startOfDay(today);
  const multiDay = !sameDay(start, end);

  const selectedProjects = projects
    .filter((p) => config.projects.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tasks = allTasks.filter(
    (t) => config.projects.includes(t.project_id) && config.statuses.includes(t.status) && taskInPeriod(t, w)
  );

  // Title + summary
  const { title } = describeRange(start, end);
  const done = tasks.filter((t) => t.status === 'Done').length;
  const tracked = config.includeTime ? tasks.reduce((s, t) => s + (taskTimes[t.id] || 0), 0) : 0;
  const summary = [
    config.userName?.trim() || null,
    `generated ${fmtDayYear(today)}`,
    plural(selectedProjects.length, 'project'),
    plural(tasks.length, 'task'),
    tasks.length ? `${done} done` : null,
    tracked > 0 ? `${formatDuration(tracked)} tracked` : null,
  ].filter((x): x is string => !!x);

  // Events — IN THE PERIOD, plus the week that follows it. Anchored to the
  // report's dates, not to the clock (the old generator showed the current
  // week's events on a last-month report).
  const eventSections: ReportDoc['eventSections'] = [];
  if (config.includeEvents) {
    const inPeriod = allEvents.filter((e) => within(w, e.event_date)).sort(eventSort);
    const after: Period = { start: w.endExclusive, endExclusive: addDays(w.endExclusive, 7) };
    const comingUp = allEvents.filter((e) => within(after, e.event_date)).sort(eventSort);
    if (inPeriod.length) eventSections.push({ heading: 'Events', events: inPeriod.map((e) => docEvent(e, config.verbose)) });
    if (comingUp.length) {
      eventSections.push({
        heading: `Coming up — ${fmtRange(after.start, addDays(after.endExclusive, -1))}`,
        events: comingUp.map((e) => docEvent(e, config.verbose)),
      });
    }
  }

  // Projects
  const levels = levelsFor(config.grouping);
  const docProjects: DocProject[] = [];
  for (const p of selectedProjects) {
    const mine = tasks.filter((t) => t.project_id === p.id);
    if (!mine.length) continue;
    const areas = allAreas.filter((a) => a.project_id === p.id);
    const ctx: BuildCtx = {
      verbose: config.verbose,
      includeTime: config.includeTime,
      includeAssignees: config.includeAssignees,
      taskTimes,
      assignees,
      todayStart,
      multiDay,
      project: p.name,
      areaName: new Map(areas.map((a) => [a.id, a.name])),
    };
    docProjects.push({ name: p.name, groups: docGroups(groupTasks(mine, levels, areas), 3, ctx) });
  }

  return { title, summary, start, end, year: end.getFullYear(), eventSections, projects: docProjects, empty: docProjects.length === 0 };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/** `- Title — description · Assignee · due Sat 12 Sept · 1h 20m` — every
 * optional part rides the same tail, so the shape never changes. */
export function taskLineMarkdown(t: DocTask, year: number): string {
  const head = `${t.mark ? '✓ ' : ''}${t.prefix ? `[${t.prefix}] ` : ''}${t.title}`;
  const tail: string[] = [];
  if (t.description) tail.push(t.description);
  if (t.assignees.length) tail.push(t.assignees.join(', '));
  if (t.due) tail.push(t.overdue ? `⚠ overdue ${fmtDay(t.due, year)}` : `due ${fmtDay(t.due, year)}`);
  if (t.showCompleted && t.completedAt) tail.push(`done ${fmtDay(t.completedAt, year)}`);
  if (t.trackedSeconds > 0) tail.push(formatDuration(t.trackedSeconds));
  return `- ${head}${tail.length ? ` — ${tail.join(' · ')}` : ''}`;
}

export function eventWhen(e: DocEvent, year: number): string {
  return e.allDay ? `${fmtDay(e.date, year)} (all day)` : `${fmtDay(e.date, year)}${e.time ? ` ${e.time}` : ''}`;
}

function eventLineMarkdown(e: DocEvent, year: number): string {
  return `- ${eventWhen(e, year)} — ${e.title}${e.location ? ` 📍 ${e.location}` : ''}${e.description ? ` · ${e.description}` : ''}`;
}

function renderGroupsMarkdown(groups: DocGroup[], year: number, out: string[]): void {
  for (const g of groups) {
    if (g.label) {
      out.push(`${'#'.repeat(g.depth)} ${g.label}`);
      out.push('');
    }
    if (g.children) renderGroupsMarkdown(g.children, year, out);
    else {
      for (const t of g.tasks ?? []) out.push(taskLineMarkdown(t, year));
      out.push('');
    }
  }
}

export function toMarkdown(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(`# ${doc.title}`);
  out.push(doc.summary.join(' · '));
  out.push('');
  for (const sec of doc.eventSections) {
    out.push(`## ${sec.heading}`);
    out.push('');
    for (const e of sec.events) out.push(eventLineMarkdown(e, doc.year));
    out.push('');
  }
  for (const p of doc.projects) {
    out.push(`## ${p.name}`);
    out.push('');
    renderGroupsMarkdown(p.groups, doc.year, out);
  }
  if (doc.empty) {
    out.push('_No tasks in this period._');
    out.push('');
  }
  // Collapse runs of blank lines; end with exactly one newline.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Entry point (markdown) — the mobile screen and the tests use this.
// ---------------------------------------------------------------------------

export function generateReport(
  config: ReportConfig,
  allTasks: Task[],
  projects: Project[],
  taskTimes: Record<number, number>,
  allEvents: Event[] = [],
  allAreas: Area[] = [],
  today: Date = new Date(),
  assignees: AssigneeMap = {}
): string {
  return toMarkdown(buildReport(config, allTasks, projects, taskTimes, allEvents, allAreas, today, assignees));
}
