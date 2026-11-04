// The timer pill's "today": your time on the active task since local midnight (pure, so it
// unit-tests; scripts/test-timer-day.mjs covers it). The host sums your finished entries
// since midnight (`get_my_task_time_since`); the running entry is added here, live, from
// midnight on if it started before. Past midnight a base loaded yesterday no longer counts.

/** Local midnight (epoch ms) of the day `now` falls in. Follows the local clock across DST. */
export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Seconds today: `base` (finished seconds since the midnight `baseDay`) while `baseDay` is
 * still today, plus the running entry's part since midnight (`runStart` in epoch ms, or
 * null when nothing runs).
 */
export function todaySeconds(base: number, baseDay: number | null, runStart: number | null, now: number): number {
  const mid = localMidnight(now);
  const finished = baseDay === mid ? base : 0;
  const run = runStart == null ? 0 : Math.max(0, Math.floor((now - Math.max(runStart, mid)) / 1000));
  return finished + run;
}
