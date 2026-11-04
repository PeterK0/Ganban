// An automation's schedule ("every" on a schedule trigger) as the editor shows
// it: an interval ("30 min", "2 hours"), a daily time ("07:00"), or weekdays
// and a time ("Mon,Thu 09:00"). The host parses the string
// (crates/server/src/oracle_run.rs, parse_schedule); this module reads and
// writes the same forms. Pure, unit-tested (scripts/test-schedule-cadence.mjs).

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type CadenceMode = 'interval' | 'daily' | 'weekly';

export interface Cadence {
  mode: CadenceMode;
  /** For 'interval': "1 hour", "30 min". */
  interval: string;
  /** For 'daily' and 'weekly': "HH:MM". */
  time: string;
  /** For 'weekly': in week order, Monday first. */
  days: Weekday[];
}

const LONG: Record<string, Weekday> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

export const defaultCadence = (): Cadence => ({ mode: 'interval', interval: '1 hour', time: '09:00', days: ['Mon'] });

/** "9:5" → "09:05"; null unless it's a valid time of day. */
function hhmm(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

/** A weekday list ("mon, Thursday") in week order, or null if a name is unknown. */
function weekdays(s: string): Weekday[] | null {
  const out = new Set<Weekday>();
  for (const raw of s.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)) {
    const d = WEEKDAYS.find((w) => w.toLowerCase() === raw) ?? LONG[raw];
    if (!d) return null;
    out.add(d);
  }
  return out.size ? WEEKDAYS.filter((d) => out.has(d)) : null;
}

/** Read a stored schedule. Anything that isn't a daily or weekly form is an
 * interval, kept as typed, so the host's own parsing has the last word. */
export function parseCadence(every: string | null | undefined): Cadence {
  const s = (every ?? '').trim();
  const base = defaultCadence();
  const weekly = /^([A-Za-z][A-Za-z,\s]*?)\s+(\d{1,2}:\d{2})$/.exec(s);
  if (weekly) {
    const days = weekdays(weekly[1]);
    const time = hhmm(weekly[2]);
    if (days && time) return { ...base, mode: 'weekly', days, time };
  }
  const daily = hhmm(s);
  if (daily) return { ...base, mode: 'daily', time: daily };
  return { ...base, mode: 'interval', interval: s || base.interval };
}

/** The string the host stores: "1 hour", "07:00" or "Mon,Thu 09:00". */
export function formatCadence(c: Cadence): string {
  if (c.mode === 'daily') return c.time;
  if (c.mode === 'weekly') return `${WEEKDAYS.filter((d) => c.days.includes(d)).join(',')} ${c.time}`;
  return c.interval.trim();
}

/** Why the cadence can't be saved, or null. */
export function cadenceProblem(c: Cadence): string | null {
  if (c.mode === 'interval') return c.interval.trim() ? null : 'Say how often, e.g. 1 hour.';
  if (!hhmm(c.time)) return 'Pick a time.';
  if (c.mode === 'weekly' && c.days.length === 0) return 'Pick at least one day.';
  return null;
}

/** How a rule's list row says it: "every 1 hour", "daily at 07:00",
 * "weekly on Mon, Thu at 09:00". */
export function describeCadence(every: string | null | undefined): string {
  if (!every?.trim()) return 'every ?';
  const c = parseCadence(every);
  if (c.mode === 'daily') return `daily at ${c.time}`;
  if (c.mode === 'weekly') return `weekly on ${c.days.join(', ')} at ${c.time}`;
  return `every ${c.interval}`;
}
