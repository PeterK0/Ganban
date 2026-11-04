// Pure RRULE expansion: a practical subset of RFC 5545, enough for the
// EventEditor's Repeats control and common ICS/OneDrive feeds. No DOM/Tauri, so it
// unit-tests (scripts/test-recur.mjs), same pattern as invite.pure.ts.
//
// Supported:
//   FREQ=DAILY    INTERVAL, BYDAY (plain weekdays, as a filter)
//   FREQ=WEEKLY   INTERVAL, BYDAY (plain weekdays), WKST (default MO)
//   FREQ=MONTHLY  INTERVAL, BYMONTHDAY (incl. negatives), BYDAY (incl. ordinals: 2TU, -1FR)
//   FREQ=YEARLY   INTERVAL, BYMONTH and BYMONTHDAY (one value each)
//   and COUNT / UNTIL on all of them.
// Anything else (BYSETPOS, BYWEEKNO, BYHOUR…) is "can't expand": canExpand() is
// false, expandOccurrences() returns [] and the caller shows just the master.
//
// As in RFC 5545 (and python-dateutil), the occurrences are the dates that match the
// rule on or after the master's date; a master date that doesn't match (a "Mon–Fri"
// rule saved on a Saturday) isn't itself an occurrence. Every occurrence keeps the
// master's local time of day.

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
type Freq = (typeof FREQS)[number];
const KNOWN_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);

/** Parse "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE" into an upper-cased key→value map. */
export function parseRrule(rrule: string): Record<string, string> {
  return Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((kv) => kv.split('='))
      .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
      .map(([k, v]) => [k.trim().toUpperCase(), v.trim().toUpperCase()]),
  );
}

/** An ICS UNTIL → the last instant it allows. A date-only value (YYYYMMDD) covers
 * that whole local day; a UTC value (…Z) is exact; a floating value is local. */
function parseUntil(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se, z] = m;
    if (h == null) return new Date(+y, +mo - 1, +d, 23, 59, 59, 999);
    if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
    return new Date(+y, +mo - 1, +d, +h, +mi, +se);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

type ByDay = { ord: number; wd: number }; // ord 0 = every such weekday
function parseByDay(v: string | undefined): ByDay[] | null | undefined {
  if (v == null) return undefined;
  const out: ByDay[] = [];
  for (const raw of v.split(',')) {
    const m = raw.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!m) return null;
    out.push({ ord: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) });
  }
  return out;
}
function parseInts(v: string | undefined): number[] | null | undefined {
  if (v == null) return undefined;
  const out = v.split(',').map((x) => parseInt(x, 10));
  return out.some((n) => isNaN(n) || n === 0) ? null : out;
}

interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  until?: Date;
  byday?: ByDay[];
  bymonthday?: number[];
  bymonth?: number[];
  wkst: number;
}

/** The rule, or null when it's outside the subset we expand. */
function compile(rrule: string): Rule | null {
  const p = parseRrule(rrule);
  const freq = p.FREQ as Freq;
  if (!FREQS.includes(freq)) return null;
  if (Object.keys(p).some((k) => !KNOWN_PARTS.has(k))) return null;
  const interval = p.INTERVAL ? parseInt(p.INTERVAL, 10) : 1;
  if (!(interval >= 1)) return null;
  const count = p.COUNT ? parseInt(p.COUNT, 10) : undefined;
  if (count != null && !(count >= 1)) return null;
  const until = p.UNTIL ? parseUntil(p.UNTIL) : undefined;
  if (until === null) return null;
  const byday = parseByDay(p.BYDAY);
  const bymonthday = parseInts(p.BYMONTHDAY);
  const bymonth = parseInts(p.BYMONTH);
  if (byday === null || bymonthday === null || bymonth === null) return null;
  const wkst = p.WKST ? WEEKDAYS.indexOf(p.WKST) : 1;
  if (wkst < 0) return null;
  const ordinals = byday?.some((b) => b.ord !== 0);
  if (freq === 'DAILY' && (ordinals || bymonthday || bymonth)) return null;
  if (freq === 'WEEKLY' && (ordinals || bymonthday || bymonth)) return null;
  if (freq === 'MONTHLY' && bymonth) return null;
  if (freq === 'YEARLY' && (byday || (bymonth && bymonth.length > 1) || (bymonthday && bymonthday.length > 1))) return null;
  return { freq, interval, count, until: until ?? undefined, byday, bymonthday, bymonth, wkst };
}

/** Whether we understand this rule well enough to expand it. */
export function canExpand(rrule: string): boolean {
  return compile(rrule) != null;
}

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** The candidate days (local midnight) of the k-th period, ascending. */
function periodDays(r: Rule, start: Date, k: number): Date[] {
  const y0 = start.getFullYear();
  const m0 = start.getMonth();
  const d0 = start.getDate();
  const wds = r.byday?.map((b) => b.wd);
  if (r.freq === 'DAILY') {
    const d = new Date(y0, m0, d0 + k * r.interval);
    return !wds || wds.includes(d.getDay()) ? [d] : [];
  }
  if (r.freq === 'WEEKLY') {
    const back = (start.getDay() - r.wkst + 7) % 7;
    const ws = new Date(y0, m0, d0 - back + 7 * r.interval * k);
    const out: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i);
      if (wds ? wds.includes(d.getDay()) : d.getDay() === start.getDay()) out.push(d);
    }
    return out;
  }
  if (r.freq === 'MONTHLY') {
    const first = new Date(y0, m0 + k * r.interval, 1);
    const y = first.getFullYear();
    const m = first.getMonth();
    const n = daysIn(y, m);
    const days = new Set<number>();
    const monthDays = r.bymonthday
      ? new Set(r.bymonthday.map((x) => (x > 0 ? x : n + 1 + x)).filter((x) => x >= 1 && x <= n))
      : undefined;
    if (r.byday) {
      for (const b of r.byday) {
        const all: number[] = [];
        for (let d = 1; d <= n; d++) if (new Date(y, m, d).getDay() === b.wd) all.push(d);
        if (b.ord === 0) all.forEach((d) => days.add(d));
        else {
          const pick = b.ord > 0 ? all[b.ord - 1] : all[all.length + b.ord];
          if (pick != null) days.add(pick);
        }
      }
      if (monthDays) for (const d of [...days]) if (!monthDays.has(d)) days.delete(d);
    } else if (monthDays) {
      monthDays.forEach((d) => days.add(d));
    } else if (d0 <= n) {
      days.add(d0); // the 31st skips the shorter months, as RFC 5545 says
    }
    return [...days].sort((a, b) => a - b).map((d) => new Date(y, m, d));
  }
  // YEARLY
  const y = y0 + k * r.interval;
  const m = r.bymonth ? r.bymonth[0] - 1 : m0;
  if (m < 0 || m > 11) return [];
  const n = daysIn(y, m);
  const md = r.bymonthday ? r.bymonthday[0] : d0;
  const d = md > 0 ? md : n + 1 + md;
  return d >= 1 && d <= n ? [new Date(y, m, d)] : [];
}

/**
 * Expand a master event's recurrence into the occurrence start-Dates that fall
 * within [rangeStart, rangeEnd]. `start` is the master's event_date (its local
 * time of day is kept on every occurrence). Returns [] for a rule we don't
 * understand (see canExpand). `cap` bounds output; COUNT/UNTIL bound the series.
 */
export function expandOccurrences(
  rrule: string,
  start: Date,
  rangeStart: Date,
  rangeEnd: Date,
  cap = 500,
): Date[] {
  const r = compile(rrule);
  if (!r || isNaN(start.getTime())) return [];
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const at = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), start.getHours(), start.getMinutes(), start.getSeconds());

  const out: Date[] = [];
  let emitted = 0; // toward COUNT: every occurrence counts, in range or not
  // Empty periods (a month with no 31st, a BYDAY that never matches) still
  // advance; the guard bounds a rule that can never produce anything.
  for (let k = 0, empty = 0; k < 50000 && empty < 400; k++) {
    const days = periodDays(r, start, k);
    empty = days.length ? 0 : empty + 1;
    for (const day of days) {
      if (day < startDay) continue;
      const occ = at(day);
      if (r.until && occ > r.until) return out;
      if (r.count != null && emitted >= r.count) return out;
      if (occ > rangeEnd) return out;
      emitted++;
      if (occ >= rangeStart) {
        out.push(occ);
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

// ---- The EventEditor's Repeats control ------------------------------------

export type RepeatFreq = Freq;
export type RepeatEnd = { kind: 'never' } | { kind: 'until'; date: string } | { kind: 'count'; count: number };

/** What the Repeats control can show and edit. */
export interface RepeatModel {
  freq: RepeatFreq;
  /** Every N days/weeks/months/years. */
  interval: number;
  /** WEEKLY only: the chosen days ("MO", "TU", …), Monday first. Empty = the start's day. */
  byday: string[];
  end: RepeatEnd;
}

export const WEEK_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const WORKWEEK = ['MO', 'TU', 'WE', 'TH', 'FR'];

const pad2 = (n: number) => String(n).padStart(2, '0');
const sortDays = (ds: string[]) => [...new Set(ds)].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));

/** The rule as the Repeats control's model, or null when the control can't show
 * it (an imported rule it would mangle: it stays "custom (kept)"). */
export function rruleToModel(rrule: string): RepeatModel | null {
  if (!rrule) return null;
  const p = parseRrule(rrule);
  const r = compile(rrule);
  if (!r) return null;
  if (r.bymonthday || r.bymonth) return null;
  if (r.byday && r.freq !== 'WEEKLY') return null;
  if (r.freq === 'WEEKLY' && r.wkst !== 1 && r.interval > 1) return null;
  if (r.count != null && r.until) return null;
  let end: RepeatEnd = { kind: 'never' };
  if (r.count != null) end = { kind: 'count', count: r.count };
  else if (p.UNTIL) {
    const u = r.until!;
    end = { kind: 'until', date: `${u.getFullYear()}-${pad2(u.getMonth() + 1)}-${pad2(u.getDate())}` };
  }
  return {
    freq: r.freq,
    interval: r.interval,
    byday: r.byday ? sortDays(r.byday.map((b) => WEEKDAYS[b.wd])) : [],
    end,
  };
}

/** The model as a standard RRULE ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"). */
export function modelToRrule(m: RepeatModel): string {
  const parts = [`FREQ=${m.freq}`];
  if (m.interval > 1) parts.push(`INTERVAL=${Math.floor(m.interval)}`);
  if (m.freq === 'WEEKLY' && m.byday.length) parts.push(`BYDAY=${sortDays(m.byday).join(',')}`);
  if (m.end.kind === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(m.end.date)) parts.push(`UNTIL=${m.end.date.replace(/-/g, '')}`);
  if (m.end.kind === 'count' && m.end.count >= 1) parts.push(`COUNT=${Math.floor(m.end.count)}`);
  return parts.join(';');
}

/** "Every weekday (Mon–Fri)": weekly, every week, exactly Monday to Friday. */
export function isWorkweek(m: RepeatModel): boolean {
  return m.freq === 'WEEKLY' && m.interval === 1 && sortDays(m.byday).join() === WORKWEEK.join();
}

/** Build a simple RRULE (kept for callers that only need a frequency). */
export function buildRrule(opts: { freq: RepeatFreq; interval?: number; until?: string }): string {
  return modelToRrule({
    freq: opts.freq,
    interval: opts.interval ?? 1,
    byday: [],
    end: opts.until ? { kind: 'until', date: opts.until } : { kind: 'never' },
  });
}

const DAY_NAME: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

/** A short human label for an rrule ("Every weekday", "Every 2 weeks on Mon, Wed, 10 times"…).
 * `{ end: false }` leaves out how it ends (", until 3 Nov 2026", ", 10 times"). */
export function describeRrule(rrule: string, opts: { end?: boolean } = {}): string {
  const p = parseRrule(rrule);
  const freq = p.FREQ;
  const n = Math.max(1, parseInt(p.INTERVAL || '1', 10) || 1);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[freq];
  if (!unit) return 'Repeats';
  const m = rruleToModel(rrule);
  let s: string;
  if (m && isWorkweek(m)) s = 'Every weekday';
  else {
    s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
    if (freq === 'WEEKLY' && p.BYDAY) {
      const days = p.BYDAY.split(',').map((d) => DAY_NAME[d.slice(-2)] ?? d);
      s += ` on ${days.join(', ')}`;
    }
  }
  if (opts.end === false) return s;
  if (p.COUNT) s += `, ${p.COUNT} times`;
  else if (p.UNTIL) {
    const u = parseUntil(p.UNTIL);
    if (u) s += `, until ${u.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return s;
}

// ---- One day of a series at a time ------------------------------------------
// A series' skipped days (`exdates`) are local ISO dates ("2026-11-03"),
// comma-separated, as the host stores them.

/** The local ISO date of a Date ("2026-11-03"). */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayAt = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** The skipped days, sorted, valid and once each. */
export function parseExdates(exdates: string | null | undefined): string[] {
  const days = (exdates ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  return [...new Set(days)].sort();
}

/** `exdates` plus `days`, as stored ('' when there are none). */
export function addExdates(exdates: string | null | undefined, ...days: string[]): string {
  return parseExdates([exdates ?? '', ...days].join(',')).join(',');
}

/**
 * The occurrences of a series in [rangeStart, rangeEnd], without its skipped days.
 * A skipped day still counts toward COUNT, as EXDATE does in RFC 5545.
 */
export function seriesOccurrences(
  rrule: string,
  start: Date,
  exdates: string | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
  cap = 500,
): Date[] {
  const skip = new Set(parseExdates(exdates));
  const all = expandOccurrences(rrule, start, rangeStart, rangeEnd, skip.size ? cap + skip.size : cap);
  return (skip.size ? all.filter((o) => !skip.has(isoDay(o))) : all).slice(0, cap);
}

/** The first occurrence on or after `from` (skipped days left out), or null. */
export function nextOccurrence(rrule: string, start: Date, exdates: string | null | undefined, from: Date): Date | null {
  // Ten years ahead is far enough for "next"; COUNT/UNTIL end it sooner.
  const far = new Date(from.getFullYear() + 10, from.getMonth(), from.getDate());
  return seriesOccurrences(rrule, start, exdates, from, far, 1)[0] ?? null;
}

/** The rule with a part set (value) or dropped (null), keeping the others' order. */
function withPart(rrule: string, key: string, value: string | null): string {
  const parts = rrule.replace(/^RRULE:/i, '').split(';').filter((p) => p.trim() && p.split('=')[0].trim().toUpperCase() !== key);
  if (value != null) parts.push(`${key}=${value}`);
  return parts.join(';');
}

/** The rule ending on `day` (its last possible occurrence), COUNT dropped. */
export function endRuleOn(rrule: string, day: string): string {
  return withPart(withPart(rrule, 'COUNT', null), 'UNTIL', day.replace(/-/g, ''));
}

/**
 * The rule ending on `day`, or null when the series has no day on or before it
 * (it starts later), so ending it there leaves nothing. Skipped days count as
 * days here: a one-off copy may stand in for them.
 */
export function endRuleAt(rrule: string, start: Date, day: string): string | null {
  const end = dayAt(day);
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const through = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, 0, 0, 0, -1);
  return expandOccurrences(rrule, start, from, through, 1).length ? endRuleOn(rrule, day) : null;
}

/** How the series ends: never, on a date (YYYY-MM-DD), or after N times. */
export function ruleEnd(rrule: string): RepeatEnd {
  const p = parseRrule(rrule);
  const count = p.COUNT ? parseInt(p.COUNT, 10) : NaN;
  if (count >= 1) return { kind: 'count', count };
  const u = p.UNTIL ? parseUntil(p.UNTIL) : null;
  return u ? { kind: 'until', date: isoDay(u) } : { kind: 'never' };
}

/**
 * Split a series at the occurrence on `day` ("This and following"). `head` is the
 * series' rule ending the day before (null when nothing comes before `day`, so the
 * whole series is "this and following"); `tail` is the rule for a new series that
 * starts on `day`: the same rule, its COUNT less the occurrences the head keeps.
 */
export function splitRule(rrule: string, start: Date, day: string): { head: string | null; tail: string } {
  const split = dayAt(day);
  const before = expandOccurrences(rrule, start, new Date(start.getFullYear(), start.getMonth(), start.getDate()), new Date(split.getTime() - 1), 100000).length;
  if (before === 0) return { head: null, tail: rrule };
  const prev = new Date(split.getFullYear(), split.getMonth(), split.getDate() - 1);
  const head = endRuleOn(rrule, isoDay(prev));
  const count = parseInt(parseRrule(rrule).COUNT ?? '', 10);
  const tail = count >= 1 ? withPart(rrule, 'COUNT', String(Math.max(1, count - before))) : rrule;
  return { head, tail };
}

/** The ISO 8601 week of a date (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // the Thursday of this week
  const jan4 = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { year: t.getFullYear(), week };
}

/** The Monday that starts `d`'s week (local midnight). */
export function weekStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

/** The month grid's six Monday-to-Sunday rows from the week that holds the 1st:
 * its first and last days (local midnight), the other months' days included.
 * `month` is 0-based. */
export function monthGridRange(year: number, month: number): { first: Date; last: Date } {
  const first = weekStart(new Date(year, month, 1));
  return { first, last: new Date(first.getFullYear(), first.getMonth(), first.getDate() + 41) };
}
