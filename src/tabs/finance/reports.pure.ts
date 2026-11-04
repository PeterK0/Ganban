// Finance report helpers: months and periods, statement row trees with subtotals and comparatives,
// net worth by account, budget progress, the forecast band's geometry, and the PDF document of a
// statement. Pure (no React, no host), so scripts/test-finance-reports.mjs can test them. Amounts
// are integer minor units throughout.
import { formatAmount, formatDate } from './money.pure';

// ── Months and periods ──────────────────────────────────────────────────

/** A `YYYY-MM-DD` date's month, `YYYY-MM`. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

const parseMonth = (month: string): [number, number] => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`not a month: ${month}`);
  return [Number(m[1]), Number(m[2])];
};
const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-11` plus `n` months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = parseMonth(month);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** Days in a `YYYY-MM` month. */
export function daysInMonth(month: string): number {
  const [y, m] = parseMonth(month);
  return new Date(y, m, 0).getDate();
}

/** A month's first and last day. */
export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
}

/**
 * How much of `month` has gone by on `today` (a `YYYY-MM-DD` date): 0 before it starts, 1 after it
 * ends, and day / days within it (the whole of today counts).
 */
export function elapsedFraction(month: string, today: string): number {
  const t = monthOf(today);
  if (t < month) return 0;
  if (t > month) return 1;
  return Number(today.slice(8, 10)) / daysInMonth(month);
}

/** "November 2026" in the locale. */
export function formatMonth(month: string, locale?: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = parseMonth(month);
  return new Intl.DateTimeFormat(locale, { month: style, year: 'numeric' }).format(new Date(y, m - 1, 1));
}

/** A statement period: a month (`YYYY-MM`) or a year (`YYYY`). */
export type Period = { kind: 'month'; month: string } | { kind: 'year'; year: number };

export const periodKey = (p: Period): string => (p.kind === 'month' ? p.month : String(p.year));

export function periodLabel(p: Period, locale?: string, style: 'long' | 'short' = 'long'): string {
  return p.kind === 'month' ? formatMonth(p.month, locale, style) : String(p.year);
}

/** The first and last day of a period. */
export function periodRange(p: Period): { from: string; to: string } {
  return p.kind === 'month' ? monthRange(p.month) : { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
}

/** The period `n` steps before `p` (the same length: months step by months, years by years). */
export function previousPeriod(p: Period, n = 1): Period {
  return p.kind === 'month' ? { kind: 'month', month: addMonths(p.month, -n) } : { kind: 'year', year: p.year - n };
}

/** `p` and the `count` periods before it, newest first: the columns of a statement with comparatives. */
export function comparativePeriods(p: Period, count: number): Period[] {
  return Array.from({ length: count + 1 }, (_, i) => previousPeriod(p, i));
}

// ── Statement row trees ──────────────────────────────────────────────────

/**
 * A node of a statement as the layout describes it. A **line** has its own values, one per column
 * (the current period first, then the comparatives). A **group** has children and shows a heading,
 * its children and a subtotal row with their sum. A **total** is a formula over other nodes' sums
 * (net worth = assets − liabilities), shown as a total row.
 */
export type StatementNode =
  | { key: string; label: string; values: number[] }
  | { key: string; label: string; children: StatementNode[]; totalLabel?: string }
  | { key: string; label: string; of: [key: string, sign: 1 | -1][] };

export type RowKind = 'heading' | 'line' | 'subtotal' | 'total';

export interface StatementRow {
  /** Unique within the statement; a group's heading and subtotal share its key with a suffix. */
  key: string;
  /** The node's key, for collapsing. */
  node: string;
  label: string;
  depth: number;
  kind: RowKind;
  /** One per column; a heading has none. */
  values: number[];
  /** The first column against the second (when there is one): the change and its fraction. */
  change: number | null;
  changePct: number | null;
  /** A collapsed group's row, shown as one line with its sum. */
  collapsed?: boolean;
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);
const add = (a: number[], b: number[], sign = 1) => a.map((v, i) => v + sign * (b[i] ?? 0));

/** Every node's sums, by key: a line's values, a group's children summed, a total's formula. */
export function statementSums(nodes: StatementNode[], columns: number): Map<string, number[]> {
  const sums = new Map<string, number[]>();
  const totals: Extract<StatementNode, { of: unknown }>[] = [];
  const walk = (n: StatementNode): number[] => {
    let v: number[];
    if ('values' in n) v = zeros(columns).map((_, i) => n.values[i] ?? 0);
    else if ('children' in n) v = n.children.reduce((acc, c) => add(acc, walk(c)), zeros(columns));
    else {
      totals.push(n);
      return zeros(columns); // totals don't add into a parent group
    }
    sums.set(n.key, v);
    return v;
  };
  nodes.forEach(walk);
  // A total may name another total, so resolve them in order; one it can't find counts as zero.
  for (const t of totals) sums.set(t.key, t.of.reduce((acc, [k, s]) => add(acc, sums.get(k) ?? zeros(columns), s), zeros(columns)));
  return sums;
}

/** The change of the first column against the second, and its fraction of the second's size. */
export function changeOf(values: number[]): { change: number | null; changePct: number | null } {
  if (values.length < 2) return { change: null, changePct: null };
  const change = values[0] - values[1];
  return { change, changePct: values[1] === 0 ? null : change / Math.abs(values[1]) };
}

export interface FlattenOptions {
  /** Group keys shown as one line with their sum. */
  collapsed?: ReadonlySet<string>;
  /** Leave out lines that are zero in every column (groups and totals stay). */
  hideZero?: boolean;
}

/**
 * The rows a statement table shows, in order: a group is its heading, its rows one level deeper,
 * then its subtotal; a collapsed group is one line. A group left empty by `hideZero` shows as a
 * plain zero line instead of an empty heading.
 */
export function flattenStatement(nodes: StatementNode[], columns: number, opts: FlattenOptions = {}): StatementRow[] {
  const sums = statementSums(nodes, columns);
  const rows: StatementRow[] = [];
  const row = (n: StatementNode, kind: RowKind, depth: number, key: string, label: string, values: number[], extra: Partial<StatementRow> = {}): StatementRow => ({
    key,
    node: n.key,
    label,
    depth,
    kind,
    values,
    ...(kind === 'heading' ? { change: null, changePct: null } : changeOf(values)),
    ...extra,
  });
  const isZero = (k: string) => (sums.get(k) ?? []).every((v) => v === 0);
  const walk = (n: StatementNode, depth: number) => {
    const values = sums.get(n.key) ?? zeros(columns);
    if ('values' in n) {
      if (!(opts.hideZero && isZero(n.key))) rows.push(row(n, 'line', depth, n.key, n.label, values));
    } else if ('children' in n) {
      const shown = opts.hideZero ? n.children.filter((c) => !('values' in c) || !isZero(c.key)) : n.children;
      if (opts.collapsed?.has(n.key) || shown.length === 0) {
        rows.push(row(n, 'line', depth, n.key, n.label, values, n.children.length ? { collapsed: true } : {}));
        return;
      }
      rows.push(row(n, 'heading', depth, `${n.key}:h`, n.label, []));
      shown.forEach((c) => walk(c, depth + 1));
      rows.push(row(n, 'subtotal', depth, `${n.key}:t`, n.totalLabel ?? `Total ${n.label.toLowerCase()}`, values));
    } else {
      rows.push(row(n, 'total', depth, n.key, n.label, values));
    }
  };
  nodes.forEach((n) => walk(n, 0));
  return rows;
}

/** A fraction as a signed percentage for a comparatives column: "+12%", "−3.5%", "—" for none. */
export function formatPct(fraction: number | null, locale?: string): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: Math.abs(fraction) < 0.1 ? 1 : 0, signDisplay: 'exceptZero' }).format(fraction);
}

// ── Net worth by account ─────────────────────────────────────────────────

export interface NetWorthAccount {
  id: number;
  name: string;
  kind: 'current' | 'savings' | 'card' | 'cash' | 'loan';
  currency: string;
  archived: boolean;
  /** Signed in the functional currency: an asset positive, a debt negative. */
  balance_functional_minor: number;
}

export interface NetWorthGroup<A extends NetWorthAccount = NetWorthAccount> {
  key: 'cash' | 'savings' | 'debt';
  label: string;
  total: number;
  accounts: A[];
}

const NW_GROUPS: { key: NetWorthGroup['key']; label: string; kinds: NetWorthAccount['kind'][] }[] = [
  { key: 'cash', label: 'Cash and current accounts', kinds: ['current', 'cash'] },
  { key: 'savings', label: 'Savings', kinds: ['savings'] },
  { key: 'debt', label: 'Cards and loans', kinds: ['card', 'loan'] },
];

/**
 * Net worth from the accounts' functional balances: grouped (cash, savings, debts), each group
 * largest first, with what's owned, what's owed and the difference. Archived accounts with no
 * balance are left out.
 */
export function netWorth<A extends NetWorthAccount>(accounts: A[]): { groups: NetWorthGroup<A>[]; assets: number; liabilities: number; net: number } {
  const live = accounts.filter((a) => !a.archived || a.balance_functional_minor !== 0);
  const groups = NW_GROUPS.map((g): NetWorthGroup<A> => {
    const list = live.filter((a) => g.kinds.includes(a.kind)).sort((a, b) => Math.abs(b.balance_functional_minor) - Math.abs(a.balance_functional_minor) || a.name.localeCompare(b.name));
    return { key: g.key, label: g.label, accounts: list, total: list.reduce((s, a) => s + a.balance_functional_minor, 0) };
  }).filter((g) => g.accounts.length > 0);
  let assets = 0;
  let liabilities = 0;
  for (const a of live) {
    if (a.balance_functional_minor >= 0) assets += a.balance_functional_minor;
    else liabilities -= a.balance_functional_minor;
  }
  return { groups, assets, liabilities, net: assets - liabilities };
}

// ── Budgets ──────────────────────────────────────────────────────────────

export type BudgetState = 'none' | 'under' | 'pace' | 'warn' | 'over';

export interface BudgetProgress {
  /** Spent as a fraction of the target (may pass 1). */
  spentPct: number;
  /** Where the month's forecast lands, as a fraction of the target, when there is one. */
  projectedPct: number | null;
  /** How much of the month has gone by, for the pace marker. */
  elapsedPct: number;
  /** What's left to spend (negative: over by that much). */
  left: number;
  /**
   * `over`: spent more than the target. `warn`: the forecast passes the target (or, with no
   * forecast, the spending runs well ahead of the month's pace). `pace`: on track but past 85%.
   * `under`: fine. `none`: no target.
   */
  state: BudgetState;
}

/**
 * A budget's progress this month. Amounts are positive spending in minor units; `elapsed` is the
 * month's elapsed fraction (`elapsedFraction`).
 */
export function budgetProgress(spent: number, target: number, elapsed: number, projected?: number | null): BudgetProgress {
  if (target <= 0) return { spentPct: 0, projectedPct: null, elapsedPct: elapsed, left: -spent, state: 'none' };
  const spentPct = spent / target;
  const projectedPct = projected == null ? null : projected / target;
  let state: BudgetState = 'under';
  if (spent > target) state = 'over';
  else if (projectedPct != null ? projectedPct > 1 : elapsed > 0 && elapsed < 1 && spentPct > Math.min(1, elapsed * 1.25 + 0.1)) state = 'warn';
  else if (spentPct >= 0.85) state = 'pace';
  return { spentPct, projectedPct, elapsedPct: elapsed, left: target - spent, state };
}

// ── The forecast band ────────────────────────────────────────────────────

export interface Band {
  /** The balance now. */
  current: number;
  low: number;
  expected: number;
  high: number;
}

export interface BandGeometry {
  min: number;
  max: number;
  /** A value's position along the bar, 0..100 (%). */
  pos: (v: number) => number;
  /** Where zero sits, when it's inside the scale. */
  zero: number | null;
  /** The ticks to label: rounded values across the scale. */
  ticks: number[];
}

/** A "nice" step (1, 2 or 5 × 10ⁿ) for about `count` ticks over `span`. */
export function niceStep(span: number, count = 4): number {
  if (span <= 0) return 1;
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * The scale of a forecast band: wide enough for the current balance, the band and any `extra`
 * values (zero when the band nears it), padded to nice ticks, so low–high is a bar, expected a
 * mark and now a mark on one line.
 */
export function bandGeometry(band: Band, extra: number[] = []): BandGeometry {
  const lo0 = Math.min(band.low, band.expected, band.high, band.current, ...extra);
  const hi0 = Math.max(band.low, band.expected, band.high, band.current, ...extra);
  // Show zero when the band reaches within a fifth of its span of it: running out is the news.
  const span0 = Math.max(hi0 - lo0, Math.abs(hi0) * 0.1, 100);
  const lo1 = lo0 > 0 && lo0 - span0 * 0.25 <= 0 ? 0 : lo0;
  const hi1 = hi0 < 0 && hi0 + span0 * 0.25 >= 0 ? 0 : hi0;
  const step = niceStep(Math.max(hi1 - lo1, span0 * 0.5));
  const min = Math.floor(lo1 / step) * step;
  let max = Math.ceil(hi1 / step) * step;
  if (max === min) max = min + step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return { min, max, pos, zero: min <= 0 && max >= 0 ? pos(0) : null, ticks };
}

// ── PDF ──────────────────────────────────────────────────────────────────

export interface StatementDoc {
  /** "Profit or loss". */
  title: string;
  /** "Personal · EUR". */
  entity: string;
  currency: string;
  /** The column heads, the current period first. */
  columns: string[];
  rows: StatementRow[];
  /** Explanatory lines under the table (basis, notes). */
  notes?: string[];
  /** `YYYY-MM-DD`, for the footer. */
  generated: string;
}

const GREY = '#6b7280';

/**
 * A pdfmake document definition for a statement: A4, the title and entity, then one table with the
 * period columns and a change column when there are comparatives. Pure; the view renders it with
 * pdfmake, as the report generator does.
 */
export function statementPdf(doc: StatementDoc, locale?: string): Record<string, unknown> {
  const comp = doc.columns.length >= 2;
  const num = (v: number) => (v === 0 ? '–' : formatAmount(v, doc.currency, locale));
  const head = [{ text: '', style: 'th' }, ...doc.columns.map((c) => ({ text: c, style: 'th', alignment: 'right' })), ...(comp ? [{ text: 'Change', style: 'th', alignment: 'right' }] : [])];
  const body: Record<string, unknown>[][] = [head];
  for (const r of doc.rows) {
    const strong = r.kind === 'subtotal' || r.kind === 'total' || r.kind === 'heading';
    const cell = (text: string, alignment = 'right') => ({ text, alignment, bold: strong, ...(r.kind === 'total' ? { fillColor: '#f3f4f6' } : {}) });
    const label = { text: r.label, bold: strong, margin: [r.depth * 10, 0, 0, 0], ...(r.kind === 'total' ? { fillColor: '#f3f4f6' } : {}) };
    if (r.kind === 'heading') body.push([label, ...doc.columns.map(() => cell('')), ...(comp ? [cell('')] : [])]);
    else body.push([label, ...r.values.map((v) => cell(num(v))), ...(comp ? [{ ...cell(formatPct(r.changePct, locale)), color: GREY }] : [])]);
  }
  return {
    info: { title: `${doc.title} · ${doc.columns[0] ?? ''}`, creator: 'Ganban' },
    pageSize: 'A4',
    pageMargins: [50, 56, 50, 60],
    defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.2 },
    styles: {
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 2] },
      sub: { fontSize: 9, color: GREY, margin: [0, 0, 0, 14] },
      th: { bold: true, fontSize: 8.5, color: GREY },
      note: { fontSize: 8, color: GREY, margin: [0, 2, 0, 0] },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `${doc.title} · generated ${formatDate(doc.generated, locale)}`, fontSize: 8, color: GREY },
        { text: `${page} / ${pages}`, alignment: 'right', fontSize: 8, color: GREY },
      ],
      margin: [50, 20, 50, 0],
    }),
    content: [
      { text: doc.title, style: 'h1' },
      { text: `${doc.entity} · amounts in ${doc.currency}`, style: 'sub' },
      {
        table: { headerRows: 1, widths: ['*', ...doc.columns.map(() => 72), ...(comp ? [48] : [])], body },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 1 || i === node.table.body.length ? 0.8 : 0.3),
          vLineWidth: () => 0,
          hLineColor: () => '#d1d5db',
          paddingTop: () => 3,
          paddingBottom: () => 3,
        },
      },
      ...(doc.notes ?? []).map((n) => ({ text: n, style: 'note' })),
    ],
  };
}

/** A file name for a statement export: "Profit or loss - November 2026.pdf". */
export function statementFileName(title: string, period: string, ext: string): string {
  return `${`${title} - ${period}`.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()}.${ext}`;
}

// ── The host's statement rows ────────────────────────────────────────────

/** A statement row as the host sends it (`fin_statement`). */
export interface HostRow {
  key: string;
  label: string;
  level: number;
  style: 'header' | 'line' | 'subtotal' | 'total';
  amount_minor: number;
  comparative_minor: number | null;
}

const STYLE_KIND: Record<HostRow['style'], RowKind> = { header: 'heading', line: 'line', subtotal: 'subtotal', total: 'total' };

/**
 * The host's rows as table rows: the period's amount and, with a comparative, the previous one and
 * the change. A collapsed header hides the rows under it (deeper levels) up to the next row at its
 * own level or above, so its subtotal still shows the sum.
 */
export function fromHostRows(rows: HostRow[], opts: { collapsed?: ReadonlySet<string>; hideZero?: boolean; comparative?: boolean } = {}): StatementRow[] {
  const out: StatementRow[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow != null) {
      if (r.level > hideBelow) continue;
      hideBelow = null;
    }
    const values = opts.comparative ? [r.amount_minor, r.comparative_minor ?? 0] : [r.amount_minor];
    if (opts.hideZero && r.style === 'line' && values.every((v) => v === 0)) continue;
    const kind = STYLE_KIND[r.style] ?? 'line';
    const collapsed = kind === 'heading' && !!opts.collapsed?.has(r.key);
    if (collapsed) hideBelow = r.level;
    out.push({
      key: r.key,
      node: r.key,
      label: r.label,
      depth: r.level,
      kind,
      values: kind === 'heading' ? [] : values,
      ...(kind === 'heading' ? { change: null, changePct: null } : changeOf(values)),
      ...(collapsed ? { collapsed: true } : {}),
    });
  }
  return out;
}

// ── Periods and close ────────────────────────────────────────────────────

export interface PeriodLike {
  month: string;
  status: 'open' | 'closed';
  entries: number;
}

/** The latest closed month: every date in or before it is locked. */
export function lockedThrough(periods: PeriodLike[]): string | null {
  let last: string | null = null;
  for (const p of periods) if (p.status === 'closed' && (last == null || p.month > last)) last = p.month;
  return last;
}

export const isLocked = (date: string, through: string | null): boolean => through != null && monthOf(date) <= through;

/** The date a correction of a locked entry takes: today when it's open, else the first open day. */
export function correctionDate(through: string | null, today: string): string {
  if (!isLocked(today, through)) return today;
  return `${addMonths(through!, 1)}-01`;
}

/**
 * The month that can close next: the earliest open month with entries that has ended (before
 * today's month). Months with entries close in order; an empty month needs no close.
 */
export function nextToClose(periods: PeriodLike[], today: string): string | null {
  const now = monthOf(today);
  const open = periods.filter((p) => p.status === 'open' && p.entries > 0 && p.month < now).map((p) => p.month).sort();
  return open[0] ?? null;
}

// ── Recognition schedules ────────────────────────────────────────────────

/** Paid (or received) ahead when the spread starts in the entry's month or later; accrued before it. */
export const scheduleKind = (entryDate: string, startMonth: string): 'prepaid' | 'accrued' => (startMonth < monthOf(entryDate) ? 'accrued' : 'prepaid');

/** A schedule's months and amounts as the host spreads them: evenly, the rounding in the last month. */
export function spreadPreview(amountMinor: number, months: number, startMonth: string): { month: string; amount: number }[] {
  if (!Number.isInteger(months) || months < 1) return [];
  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);
  const base = Math.floor(abs / months);
  return Array.from({ length: months }, (_, i) => ({
    month: addMonths(startMonth, i),
    amount: sign * (i === months - 1 ? abs - base * (months - 1) : base),
  }));
}

// ── The weekly reminder ──────────────────────────────────────────────────

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** A weekday code in the locale ("Monday"), from a known Monday. */
export function weekdayName(code: (typeof WEEKDAYS)[number], locale?: string): string {
  const i = WEEKDAYS.indexOf(code);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2026, 10, 2 + Math.max(0, i)));
}
