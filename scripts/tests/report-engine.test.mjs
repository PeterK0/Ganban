import assert from 'node:assert/strict';
import * as R from '../../.test-build/rg.mjs';

let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; } };
const D = (y, m, d) => new Date(y, m - 1, d);
const TODAY = D(2026, 9, 9); // Wednesday

// --- date grammar -----------------------------------------------------------
t('fmtRange: same month', () => assert.match(R.fmtRange(D(2026,9,7), D(2026,9,13)), /^7–13 Sept? 2026$/));
t('fmtRange: cross month', () => assert.match(R.fmtRange(D(2026,9,28), D(2026,10,4)), /^28 Sept? – 4 Oct 2026$/));
t('fmtRange: cross year', () => assert.match(R.fmtRange(D(2025,12,30), D(2026,1,5)), /^30 Dec 2025 – 5 Jan 2026$/));
t('fmtRange: single day = full date', () => assert.match(R.fmtRange(D(2026,9,9), D(2026,9,9)), /^Wed 9 Sept? 2026$/));
t('parseWhen: YYYY-MM-DD is LOCAL midnight', () => assert.equal(R.parseWhen('2026-09-09').getDate(), 9));

// --- periods ----------------------------------------------------------------
t('this-week starts MONDAY', () => {
  const { start, end } = R.resolveRange('this-week', TODAY);
  assert.equal(R.toYmd(start), '2026-09-07'); assert.equal(R.toYmd(end), '2026-09-13');
});
t('last-week', () => {
  const { start, end } = R.resolveRange('last-week', TODAY);
  assert.equal(R.toYmd(start), '2026-08-31'); assert.equal(R.toYmd(end), '2026-09-06');
});
t('last-month is the whole calendar month', () => {
  const { start, end } = R.resolveRange('last-month', TODAY);
  assert.equal(R.toYmd(start), '2026-08-01'); assert.equal(R.toYmd(end), '2026-08-31');
});
t('custom: missing dates fall back to this week, never an empty report', () => {
  const { start } = R.resolveRange('custom', TODAY, { start: '', end: '' });
  assert.equal(R.toYmd(start), '2026-09-07');
});
t('custom: reversed dates are swapped', () => {
  const { start, end } = R.resolveRange('custom', TODAY, { start: '2026-09-20', end: '2026-09-10' });
  assert.equal(R.toYmd(start), '2026-09-10'); assert.equal(R.toYmd(end), '2026-09-20');
});
t('titles follow the period shape', () => {
  assert.match(R.describeRange(D(2026,9,9), D(2026,9,9)).title, /^Daily report — Wed 9 Sept? 2026$/);
  assert.match(R.describeRange(D(2026,9,7), D(2026,9,13)).title, /^Weekly report — 7–13 Sept? 2026$/);
  assert.equal(R.describeRange(D(2026,9,1), D(2026,9,30)).title, 'Monthly report — September 2026');
  assert.match(R.describeRange(D(2026,8,1), D(2026,10,1)).title, /^Report — 1 Aug – 1 Oct 2026$/);
});

// --- fixtures ----------------------------------------------------------------
const projects = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
const areas = [
  { id: 10, project_id: 1, name: 'Research' }, { id: 11, project_id: 1, name: 'Build' }, { id: 12, project_id: 1, name: 'Empty area' },
];
const task = (o) => ({ project_id: 1, priority: 'Medium', archived: false, created_at: '2026-09-08T10:00:00Z', updated_at: '2026-09-08T10:00:00Z', ...o });
const tasks = [
  task({ id: 1, area_id: 10, title: 'Read spec', status: 'In Progress', deadline: '2026-09-12' }),
  task({ id: 2, area_id: 10, title: 'Survey OCR', status: 'Done', completed_at: '2026-09-08T15:00:00Z' }),
  task({ id: 3, area_id: 11, title: 'Wire parser', status: 'To Do', deadline: '2026-09-01' }), // overdue
  task({ id: 4, title: 'Orphan', status: 'Blocked' }),
  // Done LONG ago, deadline in period — must NOT appear as done this period
  task({ id: 5, area_id: 11, title: 'Ancient', status: 'Done', deadline: '2026-09-10', completed_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', created_at: '2026-02-01T00:00:00Z' }),
  task({ id: 6, project_id: 2, title: 'Beta task', status: 'To Do', description: 'line one\nline two' }),
];
const events = [
  { id: 1, title: 'Supervisor', event_date: '2026-09-09', start_time: '14:00', all_day: false, location: 'Room 3' },
  { id: 2, title: 'Next week thing', event_date: '2026-09-16', all_day: true },
  { id: 3, title: 'Far future', event_date: '2026-10-30', all_day: true },
];
const base = { projects: [1, 2], startDate: '2026-09-07', endDate: '2026-09-13', statuses: ['To Do','In Progress','Blocked','Done'], grouping: 'none', verbose: false, includeTime: true, includeAssignees: true, includeEvents: true };
const assignees = { 1: ['Nikolai'], 6: ['Scott', 'Misha'] };
const gen = (over = {}, times = {}) => R.generateReport({ ...base, ...over }, tasks, projects, times, events, areas, TODAY, assignees);

// --- selection --------------------------------------------------------------
t('done-by-deadline-only is EXCLUDED; open-by-deadline is included', () => {
  const md = gen();
  assert.ok(!md.includes('Ancient'), 'Ancient must not appear');
  assert.ok(md.includes('Wire parser'));
});

// --- per-line dates -------------------------------------------------------------
t('no creation dates anywhere; deadline reads due/overdue; done date on multi-day', () => {
  const md = gen();
  assert.ok(!/\[\d{2}\.\d{2}\.\d{4}\]/.test(md), 'old [DD.MM.YYYY] stamps are gone');
  assert.match(md, /Read spec — Nikolai · due Sat 12 Sept?/);
  assert.match(md, /Wire parser — ⚠ overdue Tue 1 Sept?/);
  assert.match(md, /✓ Survey OCR — done Tue 8 Sept?/);
});
t('single-day report drops the done date (it would repeat the heading)', () => {
  const md = gen({ startDate: '2026-09-08', endDate: '2026-09-08' });
  assert.ok(md.includes('✓ Survey OCR'));
  assert.ok(!md.includes('done Tue 8'), md);
});
t('tracked time appended; summary totals it', () => {
  const md = gen({}, { 2: 4800, 1: 600 });
  assert.match(md, /Survey OCR — done Tue 8 Sept? · 1h 20m/);
  assert.match(md, /Read spec — Nikolai · due Sat 12 Sept? · 10m/);
  assert.match(md, /1h 30m tracked/);
});

// --- groupings ----------------------------------------------------------------
const headings = (md) => md.split('\n').filter((l) => /^#{2,4} /.test(l));
t('grouping none: project h2, tasks directly, open before done', () => {
  const md = gen();
  assert.deepEqual(headings(md).filter(h => !h.startsWith('## Events') && !h.startsWith('## Coming')), ['## Alpha', '## Beta']);
  const alpha = md.slice(md.indexOf('## Alpha'), md.indexOf('## Beta'));
  assert.ok(alpha.indexOf('Wire parser') < alpha.indexOf('Read spec'), 'overdue (soonest) first');
  assert.ok(alpha.indexOf('Read spec') < alpha.indexOf('Orphan'), 'undated after dated');
  assert.ok(alpha.indexOf('Orphan') < alpha.indexOf('✓ Survey'), 'done last');
});
t('grouping area: project order of areas, empty area dropped, No area last', () => {
  const md = gen({ grouping: 'area' });
  const alpha = md.slice(md.indexOf('## Alpha'), md.indexOf('## Beta'));
  assert.deepEqual(headings(alpha).filter(h => h.startsWith('### ')), ['### Research', '### Build', '### No area']);
  assert.ok(!md.includes('### Empty area'));
});
t('grouping status: pipeline order, empty statuses dropped, no ✓ under Done', () => {
  const md = gen({ grouping: 'status' });
  const alpha = md.slice(md.indexOf('## Alpha'), md.indexOf('## Beta'));
  assert.deepEqual(headings(alpha), ['## Alpha', '### To Do', '### In Progress', '### Blocked', '### Done']);
  assert.ok(alpha.includes('- Survey OCR'), 'no ✓ when Done is the heading');
  assert.ok(!alpha.includes('✓'));
});
t('grouping area›status: h3 areas, h4 statuses', () => {
  const md = gen({ grouping: 'area-status' });
  const alpha = md.slice(md.indexOf('## Alpha'), md.indexOf('## Beta'));
  assert.deepEqual(headings(alpha), ['## Alpha', '### Research', '#### In Progress', '#### Done', '### Build', '#### To Do', '### No area', '#### Blocked']);
});
t('grouping status›area: h3 statuses, h4 areas', () => {
  const md = gen({ grouping: 'status-area' });
  const alpha = md.slice(md.indexOf('## Alpha'), md.indexOf('## Beta'));
  assert.deepEqual(headings(alpha), ['## Alpha', '### To Do', '#### Build', '### In Progress', '#### Research', '### Blocked', '#### No area', '### Done', '#### Research']);
});
t('status filter removes whole groups', () => {
  const md = gen({ grouping: 'status', statuses: ['Done'] });
  assert.ok(!md.includes('### To Do')); assert.ok(md.includes('### Done'));
  assert.ok(!md.includes('## Beta'), 'Beta has no Done tasks → no section at all');
});

// --- events ------------------------------------------------------------------
t('events anchored to the PERIOD; coming up = 7 days after; far future excluded', () => {
  const md = gen();
  assert.match(md, /## Events\n\n- Wed 9 Sept? 14:00 — Supervisor 📍 Room 3/);
  assert.match(md, /## Coming up — 14–20 Sept? 2026\n\n- Wed 16 Sept? \(all day\) — Next week thing/);
  assert.ok(!md.includes('Far future'));
});
t('last-month report shows NO current-week events', () => {
  const md = gen({ startDate: '2026-08-01', endDate: '2026-08-31' });
  assert.ok(!md.includes('Supervisor'), 'Sept 9 event must not appear in an August report');
});

// --- one line per task ------------------------------------------------------------
t('title, description and assignees on ONE line; newlines collapsed', () => {
  const md = gen({ verbose: true });
  assert.match(md, /^- Beta task — line one line two · Scott, Misha$/m);
  assert.ok(!/^\s{2,}\S/m.test(md), 'no indented continuation lines anywhere');
});
t('description first, then assignee, then dates, then time — fixed tail order', () => {
  const md = R.generateReport({ ...base, verbose: true }, [tasks[0]].map(x => ({ ...x, description: 'Chapter 3.' })), projects, { 1: 600 }, [], areas, TODAY, assignees);
  assert.match(md, /^- Read spec — Chapter 3\. · Nikolai · due Sat 12 Sept? · 10m$/m);
});
t('assignees off → no names', () => {
  const md = gen({ includeAssignees: false });
  assert.ok(!md.includes('Nikolai'));
});
t('event description rides the same line', () => {
  const md = R.generateReport({ ...base, verbose: true }, [], projects, {}, [{ ...events[0], description: 'Bring the\nslides.' }], areas, TODAY);
  assert.match(md, /^- Wed 9 Sept? 14:00 — Supervisor 📍 Room 3 · Bring the slides\.$/m);
});

// --- empty --------------------------------------------------------------------
t('empty period is said plainly', () => {
  const md = gen({ startDate: '2020-01-01', endDate: '2020-01-02' });
  assert.ok(md.includes('_No tasks in this period._'));
  assert.match(md, /0 tasks/);
});
t('summary line', () => assert.match(gen({ userName: 'Scott' }), /^# Weekly report — 7–13 Sept? 2026\nScott · generated Wed 9 Sept? 2026 · 2 projects · 5 tasks · 1 done\n/));

console.log(`${n} assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
