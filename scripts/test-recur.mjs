#!/usr/bin/env node
// Unit test for the pure RRULE expander (src/lib/recur.pure.ts). Transpiles the
// real source with esbuild and asserts against it.  node scripts/test-recur.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'rec-')), 'rec.mjs');
execSync(`npx esbuild src/lib/recur.pure.ts --format=esm --outfile=${out}`, { cwd: root, stdio: 'inherit' });

const { expandOccurrences, buildRrule, describeRrule, canExpand, rruleToModel, modelToRrule, isWorkweek, seriesOccurrences, nextOccurrence, parseExdates, addExdates, endRuleOn, ruleEnd, splitRule, isoWeek, weekStart, endRuleAt, monthGridRange } = await import(out);
let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));
const d = (s) => new Date(s);
const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

const rangeStart = d('2026-06-01T00:00:00');
const rangeEnd = d('2026-06-30T23:59:59');

// Daily, every 3 days from Jun 1.
let occ = expandOccurrences('FREQ=DAILY;INTERVAL=3', d('2026-06-01T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 10, `daily/3 → 10 in June, got ${occ.length}`);
ok(ymd(occ[0]) === '2026-06-01' && ymd(occ[1]) === '2026-06-04', `daily/3 dates ${ymd(occ[0])},${ymd(occ[1])}`);
ok(occ[0].getHours() === 9, 'occurrence keeps the 09:00 start time');

// Weekly on Mon+Wed (Jun 1 2026 is a Monday).
occ = expandOccurrences('FREQ=WEEKLY;BYDAY=MO,WE', d('2026-06-01T13:00:00'), rangeStart, rangeEnd);
const days = [...new Set(occ.map((o) => o.getDay()))].sort();
ok(days.length === 2 && days.includes(1) && days.includes(3), `weekly BYDAY=MO,WE only Mon/Wed, got days ${days}`);
ok(ymd(occ[0]) === '2026-06-01', `first MO,WE occ = Jun 1, got ${ymd(occ[0])}`);
ok(occ.length === 9, `Mon/Wed in June (1,3,8,10,15,17,22,24,29) = 9, got ${occ.length}`);

// COUNT bounds the series.
occ = expandOccurrences('FREQ=DAILY;COUNT=3', d('2026-06-10T08:00:00'), rangeStart, rangeEnd);
ok(occ.length === 3 && ymd(occ[2]) === '2026-06-12', `daily COUNT=3 → 3, got ${occ.length}`);

// UNTIL bounds the series.
occ = expandOccurrences('FREQ=WEEKLY;UNTIL=20260615', d('2026-06-01T08:00:00'), rangeStart, rangeEnd);
ok(occ.length === 3, `weekly UNTIL Jun15 from Jun1 → Jun1,8,15 = 3, got ${occ.length}`);

// Monthly keeps the day-of-month; only June occurrence in range.
occ = expandOccurrences('FREQ=MONTHLY', d('2026-06-20T10:00:00'), rangeStart, rangeEnd);
ok(occ.length === 1 && ymd(occ[0]) === '2026-06-20', `monthly → 1 in June, got ${occ.length}`);

// Unknown rule → [] (caller falls back to the master).
ok(expandOccurrences('FREQ=SECONDLY', d('2026-06-01T00:00:00'), rangeStart, rangeEnd).length === 0, 'unknown FREQ → []');

// Range filtering: a series starting before the window only yields in-window occurrences.
occ = expandOccurrences('FREQ=DAILY', d('2026-05-28T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 30 && ymd(occ[0]) === '2026-06-01', `daily from May28 → 30 June days, got ${occ.length}`);

// Builders.
ok(buildRrule({ freq: 'WEEKLY', interval: 2 }) === 'FREQ=WEEKLY;INTERVAL=2', 'buildRrule weekly/2');
ok(buildRrule({ freq: 'DAILY', until: '2026-09-01' }) === 'FREQ=DAILY;UNTIL=20260901', 'buildRrule daily until');
ok(describeRrule('FREQ=WEEKLY;INTERVAL=2') === 'Every 2 weeks', 'describeRrule');
ok(describeRrule('FREQ=DAILY') === 'Every day', 'describeRrule daily');

// ---- Weekday rules: "work 9–18, Mon–Fri" is one event -----------------------
const WORK = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
occ = expandOccurrences(WORK, d('2026-06-01T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 22, `Mon–Fri in June 2026 = 22, got ${occ.length}`);
ok(occ.every((o) => o.getDay() >= 1 && o.getDay() <= 5), 'Mon–Fri only weekdays');
ok(occ.every((o) => o.getHours() === 9), 'Mon–Fri keeps 09:00');
// Saved on a Saturday: the Saturday itself is not an occurrence (RFC 5545 / dateutil).
occ = expandOccurrences(WORK, d('2026-06-06T09:00:00'), rangeStart, rangeEnd);
ok(ymd(occ[0]) === '2026-06-08', `Mon–Fri from Sat Jun 6 starts Mon Jun 8, got ${ymd(occ[0])}`);
ok(occ.length === 17, `Mon–Fri from Jun 6 = 17 in June, got ${occ.length}`);
// Started mid-week before the window: the window gets every weekday in it.
occ = expandOccurrences(WORK, d('2026-03-04T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 22, `Mon–Fri from March = 22 in June, got ${occ.length}`);

// COUNT counts from the start, not the window: Mon–Fri ×10 from Wed May 27 → ends Tue Jun 9.
occ = expandOccurrences(WORK + ';COUNT=10', d('2026-05-27T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 7 && ymd(occ[occ.length - 1]) === '2026-06-09', `weekday COUNT=10 → 7 in June ending Jun 9, got ${occ.length} ${occ.length && ymd(occ[occ.length - 1])}`);
// UNTIL is inclusive of its whole (local) day, whatever the start time.
occ = expandOccurrences(WORK + ';UNTIL=20260610', d('2026-06-01T18:30:00'), rangeStart, rangeEnd);
ok(occ.length === 8 && ymd(occ[7]) === '2026-06-10', `weekday UNTIL Jun 10 (18:30) → 8, got ${occ.length}`);
// UTC UNTIL is exact.
const utc = (dt) => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
occ = expandOccurrences(`FREQ=DAILY;UNTIL=${utc(d('2026-06-03T09:00:00'))}`, d('2026-06-01T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 3, `daily UTC UNTIL at the 3rd occurrence's instant → 3, got ${occ.length}`);
occ = expandOccurrences(`FREQ=DAILY;UNTIL=${utc(d('2026-06-03T08:59:00'))}`, d('2026-06-01T09:00:00'), rangeStart, rangeEnd);
ok(occ.length === 2, `daily UTC UNTIL a minute before → 2, got ${occ.length}`);

// INTERVAL with BYDAY: every 2 weeks on Tue+Thu, weeks start Monday (WKST=MO default).
occ = expandOccurrences('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', d('2026-06-02T10:00:00'), rangeStart, rangeEnd);
ok(occ.map(ymd).join() === '2026-06-02,2026-06-04,2026-06-16,2026-06-18,2026-06-30', `biweekly TU,TH: ${occ.map(ymd).join()}`);
// Started on a Sunday with WKST=MO: Sunday closes week 0, so Monday is in week 1 (skipped).
occ = expandOccurrences('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU', d('2026-05-31T10:00:00'), rangeStart, rangeEnd);
ok(occ.map(ymd).join() === '2026-06-08,2026-06-14,2026-06-22,2026-06-28', `biweekly MO,SU from Sun: ${occ.map(ymd).join()}`);
// Weekly without BYDAY, every 3 weeks.
occ = expandOccurrences('FREQ=WEEKLY;INTERVAL=3', d('2026-05-20T10:00:00'), rangeStart, rangeEnd);
ok(occ.map(ymd).join() === '2026-06-10', `every 3 weeks from May 20: ${occ.map(ymd).join()}`);

// Daily with BYDAY as a filter.
occ = expandOccurrences('FREQ=DAILY;BYDAY=SA,SU', d('2026-06-01T10:00:00'), rangeStart, rangeEnd);
ok(occ.length === 8 && occ.every((o) => o.getDay() === 0 || o.getDay() === 6), `daily SA,SU → 8 weekend days, got ${occ.length}`);

// Monthly: the 31st skips short months; every 2 months; ordinal BYDAY.
const y = (s, e) => [d(s), d(e)];
let [a, b] = y('2026-01-01T00:00:00', '2026-12-31T23:59:59');
occ = expandOccurrences('FREQ=MONTHLY', d('2026-01-31T09:00:00'), a, b);
ok(occ.length === 7, `monthly on the 31st → 7 months in 2026, got ${occ.length}`);
occ = expandOccurrences('FREQ=MONTHLY;INTERVAL=2;COUNT=4', d('2026-01-15T09:00:00'), a, b);
ok(occ.map(ymd).join() === '2026-01-15,2026-03-15,2026-05-15,2026-07-15', `bimonthly ×4: ${occ.map(ymd).join()}`);
occ = expandOccurrences('FREQ=MONTHLY;BYDAY=2TU', d('2026-01-13T09:00:00'), a, d('2026-03-31T23:59:59'));
ok(occ.map(ymd).join() === '2026-01-13,2026-02-10,2026-03-10', `2nd Tuesday: ${occ.map(ymd).join()}`);
occ = expandOccurrences('FREQ=MONTHLY;BYDAY=-1FR', d('2026-01-30T09:00:00'), a, d('2026-03-31T23:59:59'));
ok(occ.map(ymd).join() === '2026-01-30,2026-02-27,2026-03-27', `last Friday: ${occ.map(ymd).join()}`);
occ = expandOccurrences('FREQ=MONTHLY;BYMONTHDAY=-1', d('2026-01-31T09:00:00'), a, d('2026-03-31T23:59:59'));
ok(occ.map(ymd).join() === '2026-01-31,2026-02-28,2026-03-31', `last day of month: ${occ.map(ymd).join()}`);

// Yearly on Feb 29 only lands in leap years; yearly COUNT.
occ = expandOccurrences('FREQ=YEARLY', d('2024-02-29T09:00:00'), d('2024-01-01T00:00:00'), d('2032-12-31T00:00:00'));
ok(occ.map(ymd).join() === '2024-02-29,2028-02-29,2032-02-29', `yearly Feb 29: ${occ.map(ymd).join()}`);

// Unsupported parts: not expandable (the caller shows the master).
ok(!canExpand('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1'), 'BYSETPOS unsupported');
ok(!canExpand('FREQ=WEEKLY;BYDAY=1MO'), 'ordinal BYDAY in WEEKLY unsupported');
ok(canExpand(WORK) && canExpand('FREQ=DAILY;COUNT=3'), 'supported rules expand');
// A rule that never matches terminates.
ok(expandOccurrences('FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=5MO', d('2026-01-01T00:00:00'), a, b).length >= 0, 'never-matching rule terminates');
// The cap bounds output.
ok(expandOccurrences('FREQ=DAILY', d('2026-01-01T00:00:00'), a, b, 50).length === 50, 'cap');

// ---- The Repeats control's model <-> RRULE ----------------------------------
let m = rruleToModel(WORK);
ok(m && m.freq === 'WEEKLY' && m.interval === 1 && m.byday.join() === 'MO,TU,WE,TH,FR' && m.end.kind === 'never', 'model of Mon–Fri');
ok(m && isWorkweek(m), 'isWorkweek');
ok(modelToRrule(m) === WORK, `Mon–Fri round-trips: ${modelToRrule(m)}`);
m = rruleToModel('FREQ=WEEKLY;BYDAY=WE,MO;INTERVAL=2;COUNT=5');
ok(m && m.byday.join() === 'MO,WE' && m.interval === 2 && m.end.kind === 'count' && m.end.count === 5, 'model weekly/2 count');
ok(modelToRrule(m) === 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5', `model → rrule: ${modelToRrule(m)}`);
m = rruleToModel('FREQ=DAILY;INTERVAL=3;UNTIL=20261231');
ok(m && m.end.kind === 'until' && m.end.date === '2026-12-31' && m.interval === 3, 'model daily until');
ok(modelToRrule(m) === 'FREQ=DAILY;INTERVAL=3;UNTIL=20261231', 'daily until round-trips');
ok(modelToRrule({ freq: 'MONTHLY', interval: 1, byday: ['MO'], end: { kind: 'never' } }) === 'FREQ=MONTHLY', 'BYDAY only written for weekly');
ok(rruleToModel('FREQ=MONTHLY;BYDAY=2TU') === null, 'monthly 2TU → custom (kept)');
ok(rruleToModel('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1') === null, 'yearly BYMONTH → custom (kept)');
ok(rruleToModel('FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1') === null, 'unknown part → custom (kept)');
ok(rruleToModel('') === null, 'empty → null');

ok(describeRrule(WORK) === 'Every weekday', `describe Mon–Fri: ${describeRrule(WORK)}`);
ok(describeRrule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4') === 'Every week on Mon, Wed, 4 times', `describe: ${describeRrule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')}`);

// ---- Skipped days (exdates) ----
const WORKDAYS = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
const work0 = d('2026-11-02T09:00:00'); // a Monday
occ = seriesOccurrences(WORKDAYS, work0, '2026-11-04', d('2026-11-02T00:00:00'), d('2026-11-08T23:59:59'));
ok(occ.map(ymd).join() === '2026-11-02,2026-11-03,2026-11-05,2026-11-06', `exdate drops Wed 4 Nov, got ${occ.map(ymd)}`);
ok(occ[0].getHours() === 9, 'a kept day keeps its time');
occ = seriesOccurrences('FREQ=DAILY;COUNT=3', d('2026-06-10T08:00:00'), '2026-06-11', rangeStart, rangeEnd);
ok(occ.map(ymd).join() === '2026-06-10,2026-06-12', `a skipped day still counts toward COUNT, got ${occ.map(ymd)}`);
ok(seriesOccurrences(WORKDAYS, work0, '', d('2026-11-02T00:00:00'), d('2026-11-08T23:59:59')).length === 5, 'no exdates = every day');
ok(seriesOccurrences(WORKDAYS, work0, null, d('2026-11-02T00:00:00'), d('2026-11-30T23:59:59'), 3).length === 3, 'cap still bounds');
ok(parseExdates(' 2026-11-10,bad,2026-11-03,2026-11-10').join() === '2026-11-03,2026-11-10', 'parseExdates sorts, dedupes, drops junk');
ok(addExdates(null, '2026-11-04') === '2026-11-04' && addExdates('2026-11-10', '2026-11-04', '2026-11-10') === '2026-11-04,2026-11-10', 'addExdates');
ok(ymd(nextOccurrence(WORKDAYS, work0, '2026-11-09', d('2026-11-07T12:00:00'))) === '2026-11-10', 'next skips the weekend and a skipped Monday');
ok(nextOccurrence('FREQ=DAILY;COUNT=2', work0, null, d('2026-12-01T00:00:00')) === null, 'an ended series has no next');

// ---- Ending and splitting a series ----
ok(endRuleOn('FREQ=DAILY;COUNT=5', '2026-11-20') === 'FREQ=DAILY;UNTIL=20261120', `endRuleOn drops COUNT: ${endRuleOn('FREQ=DAILY;COUNT=5', '2026-11-20')}`);
ok(endRuleOn('FREQ=WEEKLY;UNTIL=20270101;BYDAY=MO', '2026-11-20') === 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261120', 'endRuleOn replaces UNTIL');
ok(ruleEnd(WORKDAYS).kind === 'never', 'ruleEnd never');
ok(ruleEnd('FREQ=DAILY;COUNT=4').count === 4, 'ruleEnd count');
ok(ruleEnd('FREQ=DAILY;UNTIL=20261120').date === '2026-11-20', 'ruleEnd until');
let sp = splitRule(WORKDAYS, work0, '2026-11-11');
ok(sp.head === `${WORKDAYS};UNTIL=20261110` && sp.tail === WORKDAYS, `split a never-ending series: ${JSON.stringify(sp)}`);
occ = expandOccurrences(sp.head, work0, d('2026-11-01T00:00:00'), d('2026-11-30T23:59:59'));
ok(ymd(occ[occ.length - 1]) === '2026-11-10', 'the head ends the day before');
sp = splitRule('FREQ=DAILY;COUNT=10', d('2026-06-01T08:00:00'), '2026-06-05');
ok(sp.head === 'FREQ=DAILY;UNTIL=20260604' && sp.tail === 'FREQ=DAILY;COUNT=6', `COUNT shared out: ${JSON.stringify(sp)}`);
sp = splitRule('FREQ=MONTHLY', d('2026-01-15T10:00:00'), '2026-01-15');
ok(sp.head === null && sp.tail === 'FREQ=MONTHLY', 'splitting at the first day is the whole series');

// ---- "End today": a series that hasn't started has nothing left ----
ok(endRuleAt('FREQ=WEEKLY;BYDAY=MO;COUNT=5', d('2026-11-02T09:00:00'), '2026-11-04') === 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261104', 'a started series ends on the day');
ok(endRuleAt('FREQ=DAILY', d('2026-11-04T18:00:00'), '2026-11-04') === 'FREQ=DAILY;UNTIL=20261104', 'a series whose first day is today keeps today');
ok(endRuleAt('FREQ=DAILY', d('2026-11-05T09:00:00'), '2026-11-04') === null, 'a series starting tomorrow has nothing left');
ok(endRuleAt('FREQ=WEEKLY;BYDAY=FR', d('2026-11-02T09:00:00'), '2026-11-04') === null, 'a series whose first occurrence is after the day has nothing left');

// ---- ISO 8601 weeks ----
const wk = (s) => isoWeek(d(`${s}T12:00:00`));
ok(wk('2026-11-03').week === 45, `3 Nov 2026 is W45, got ${wk('2026-11-03').week}`);
ok(wk('2026-01-01').week === 1 && wk('2026-01-01').year === 2026, '1 Jan 2026 (Thu) is W1');
ok(wk('2027-01-01').week === 53 && wk('2027-01-01').year === 2026, '1 Jan 2027 (Fri) is W53 of 2026');
ok(wk('2024-12-30').week === 1 && wk('2024-12-30').year === 2025, '30 Dec 2024 (Mon) is W1 of 2025');
ok(wk('2026-11-08').week === 45 && wk('2026-11-09').week === 46, 'Sunday ends the week, Monday starts the next');
ok(ymd(weekStart(d('2026-11-08T12:00:00'))) === '2026-11-02' && ymd(weekStart(d('2026-11-02T00:00:00'))) === '2026-11-02', 'weekStart is the Monday');

// ---- The month grid's range, other months' days included ----
let g = monthGridRange(2026, 10); // November 2026: the 1st is a Sunday
ok(ymd(g.first) === '2026-10-26' && ymd(g.last) === '2026-12-06', `Nov 2026 grid ${ymd(g.first)}..${ymd(g.last)}`);
g = monthGridRange(2026, 5); // June 2026: the 1st is a Monday
ok(ymd(g.first) === '2026-06-01' && ymd(g.last) === '2026-07-12', `Jun 2026 grid ${ymd(g.first)}..${ymd(g.last)}`);
occ = seriesOccurrences('FREQ=WEEKLY;BYDAY=TU', d('2026-05-05T09:00:00'), null, g.first, new Date(g.last.getFullYear(), g.last.getMonth(), g.last.getDate(), 23, 59, 59));
ok(occ.some((o) => ymd(o) === '2026-07-07'), 'a trailing day of the grid gets its occurrence');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
