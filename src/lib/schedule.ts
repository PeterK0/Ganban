// Schedule DISPLAY helpers — a client-side mirror of the server's strict
// cadence parser (crates/server/src/oracle_run.rs). The server is the only
// thing that RUNS schedules; this only renders "next run in 26m" honestly,
// for Oracle automations and scheduled rules alike.

export function parseEveryMs(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d{1,2}:\d{2}$/.test(t)) return null; // daily — handled separately
  const m = t.match(/^(\d+)\s+(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2][0] === 'm' ? 60_000 : m[2][0] === 'h' ? 3_600_000 : 86_400_000;
  const ms = n * unit;
  return ms >= 5 * 60_000 ? ms : null; // server floor: 5 minutes
}

/** Human next-run label for a cadence string, or null when there's nothing to
 * say (no cadence at all). `active` = would the host actually fire it
 * (live/enabled); `lastRunAt` = SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or null. */
export function nextRunLabel(every: string | undefined, active: boolean, lastRunAt: string | null | undefined): string | null {
  const cadence = (every ?? '').trim();
  if (!cadence) return 'schedule not set';
  if (!active) return 'paused — enable to schedule';
  const daily = cadence.match(/^(\d{1,2}):(\d{2})$/);
  if (daily) {
    const h = parseInt(daily[1], 10), m = parseInt(daily[2], 10);
    if (h > 23 || m > 59) return 'invalid cadence';
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    return `daily ${cadence} · next ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  const ms = parseEveryMs(cadence);
  if (ms == null) return `“${cadence}” won't parse (try “30 min”, “2 hours”, “07:00”)`;
  const last = lastRunAt ? Date.parse(lastRunAt.replace(' ', 'T') + 'Z') : null;
  const inMs = (last ?? 0) + ms - Date.now();
  if (last == null || inMs <= 0) return 'due — runs within a minute';
  const mins = Math.round(inMs / 60_000);
  return `next run in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`;
}
