#!/usr/bin/env node
// Unit test for the timer pill's "today" (src/lib/timerDay.pure.ts): local midnight, the
// finished base that only counts on its own day, and the running entry counted from midnight.
// Runs in two timezones, since midnight is local.  node scripts/test-timer-day.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.TZ_CHILD) {
  // Re-run this file under fixed timezones: UTC+2 (the owner's) and UTC-5.
  for (const tz of ['Europe/Athens', 'America/New_York']) {
    execSync(`node ${fileURLToPath(import.meta.url)}`, { stdio: 'inherit', env: { ...process.env, TZ: tz, TZ_CHILD: '1' } });
  }
  process.exit(0);
}
const out = join(mkdtempSync(join(tmpdir(), 'timerday-')), 'timerDay.mjs');
execSync(`npx esbuild src/lib/timerDay.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const { localMidnight, todaySeconds } = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, m) => (got === want ? pass++ : (fail++, console.log(`FAIL [${process.env.TZ}]: ${m}\n  got  ${got}\n  want ${want}`)));
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const H = 3600;

const now = local(2026, 11, 4, 9, 30);
const mid = local(2026, 11, 4);
eq(localMidnight(now), mid, 'midnight of the local day');
eq(localMidnight(mid), mid, 'midnight is its own day');
eq(localMidnight(mid - 1), local(2026, 11, 3), 'a millisecond before is yesterday');

// The owner's case: a task with 15 h of history, started at 09:00 today.
eq(todaySeconds(0, mid, local(2026, 11, 4, 9, 0), now), 30 * 60, 'only today counts: 30 min, not the history');
eq(todaySeconds(2 * H, mid, local(2026, 11, 4, 9, 0), now), 2 * H + 30 * 60, 'earlier runs today plus this run');
eq(todaySeconds(2 * H, mid, null, now), 2 * H, 'paused: frozen at the day so far');
eq(todaySeconds(0, mid, null, now), 0, 'not started today');

// A run started before midnight counts from midnight.
eq(todaySeconds(0, mid, local(2026, 11, 3, 23, 0), now), 9 * H + 30 * 60, 'a run from 23:00 counts from 00:00');
// Past midnight, a base loaded yesterday no longer counts.
const yday = local(2026, 11, 3);
eq(todaySeconds(5 * H, yday, local(2026, 11, 3, 23, 0), local(2026, 11, 4, 0, 10)), 10 * 60, 'rollover: yesterday\'s base drops');
eq(todaySeconds(5 * H, null, null, now), 0, 'no base (an older host): nothing finished counts');
// A clock behind the host (start in the future) never goes negative.
eq(todaySeconds(0, mid, now + 5000, now), 0, 'a start ahead of the clock shows 0');

console.log(`timer-day [${process.env.TZ}]: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
