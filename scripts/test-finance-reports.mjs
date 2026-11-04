#!/usr/bin/env node
// Unit test for the Finance tab's report helpers (src/tabs/finance/reports.pure.ts): months and
// periods, statement row trees with subtotals and comparatives, net worth, budget progress, the
// forecast band's scale and a statement's PDF definition.
// node scripts/test-finance-reports.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finreports-')), 'reports.mjs');
execSync(`npx esbuild src/tabs/finance/reports.pure.ts --bundle --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const norm = (s) => (typeof s === 'string' ? s.replace(/[\u00a0\u202f]/g, ' ') : s);
const eq = (got, want, msg) => {
  const g = JSON.stringify(norm(got)), w = JSON.stringify(norm(want));
  if (g === w) pass++;
  else { fail++; console.log(`FAIL: ${msg}\n  got  ${g}\n  want ${w}`); }
};
const ok = (cond, msg) => eq(!!cond, true, msg);

// ── Months and periods
eq(m.monthOf('2026-11-04'), '2026-11', 'month of a date');
eq(m.addMonths('2026-11', 2), '2027-01', 'across a year end');
eq(m.addMonths('2026-01', -1), '2025-12', 'back across a year start');
eq(m.addMonths('2026-03', -14), '2025-01', 'more than a year back');
eq(m.daysInMonth('2028-02'), 29, 'a leap February');
eq(m.daysInMonth('2026-02'), 28, 'a plain February');
eq(m.monthRange('2026-04'), { from: '2026-04-01', to: '2026-04-30' }, 'a month range');
eq(m.elapsedFraction('2026-11', '2026-10-31'), 0, 'before the month');
eq(m.elapsedFraction('2026-11', '2026-11-15'), 0.5, 'half way');
eq(m.elapsedFraction('2026-11', '2026-12-01'), 1, 'after the month');
eq(m.formatMonth('2026-11', 'en-GB'), 'November 2026', 'month label');
eq(m.periodLabel({ kind: 'year', year: 2026 }), '2026', 'year label');
eq(m.periodRange({ kind: 'year', year: 2026 }), { from: '2026-01-01', to: '2026-12-31' }, 'year range');
eq(m.comparativePeriods({ kind: 'month', month: '2026-01' }, 2).map(m.periodKey), ['2026-01', '2025-12', '2025-11'], 'monthly comparatives, newest first');
eq(m.comparativePeriods({ kind: 'year', year: 2026 }, 1).map(m.periodKey), ['2026', '2025'], 'yearly comparatives');

// ── Statement trees: a small position with two columns (this month, last month)
const position = [
  { key: 'assets', label: 'Assets', children: [
    { key: 'cash', label: 'Cash and cash equivalents', children: [
      { key: 'a1', label: 'Current account', values: [120000, 100000] },
      { key: 'a2', label: 'Wallet', values: [0, 0] },
    ] },
    { key: 'prepay', label: 'Prepayments', values: [30000, 0] },
  ] },
  { key: 'liabilities', label: 'Liabilities', children: [{ key: 'card', label: 'Credit card', values: [25000, 40000] }] },
  { key: 'net', label: 'Net worth', of: [['assets', 1], ['liabilities', -1]] },
];
const sums = m.statementSums(position, 2);
eq(sums.get('cash'), [120000, 100000], 'a group sums its lines');
eq(sums.get('assets'), [150000, 100000], 'a group sums its subgroups');
eq(sums.get('net'), [125000, 60000], 'a total applies its formula');

const rows = m.flattenStatement(position, 2);
eq(rows.map((r) => `${r.kind}:${r.depth}:${r.label}`), [
  'heading:0:Assets',
  'heading:1:Cash and cash equivalents',
  'line:2:Current account',
  'line:2:Wallet',
  'subtotal:1:Total cash and cash equivalents',
  'line:1:Prepayments',
  'subtotal:0:Total assets',
  'heading:0:Liabilities',
  'line:1:Credit card',
  'subtotal:0:Total liabilities',
  'total:0:Net worth',
], 'rows in reading order with headings and subtotals');
eq(new Set(rows.map((r) => r.key)).size, rows.length, 'row keys are unique');
const net = rows.find((r) => r.key === 'net');
eq([net.change, net.changePct], [65000, 65000 / 60000], 'a total carries its change against the comparative');
const prepay = rows.find((r) => r.key === 'prepay');
eq([prepay.change, prepay.changePct], [30000, null], 'no percentage against a zero comparative');
eq(rows[0].values, [], 'a heading has no values');

const hidden = m.flattenStatement(position, 2, { hideZero: true });
ok(!hidden.some((r) => r.key === 'a2'), 'hideZero drops a zero line');
ok(hidden.some((r) => r.key === 'net'), 'hideZero keeps totals');
const collapsed = m.flattenStatement(position, 2, { collapsed: new Set(['cash']) });
const cashRow = collapsed.find((r) => r.node === 'cash');
eq([cashRow.kind, cashRow.collapsed, cashRow.values], ['line', true, [120000, 100000]], 'a collapsed group is one line with its sum');
ok(!collapsed.some((r) => r.key === 'a1'), 'a collapsed group hides its children');
const emptyGroup = m.flattenStatement([{ key: 'g', label: 'Investments', children: [{ key: 'x', label: 'Fund', values: [0] }] }], 1, { hideZero: true });
eq(emptyGroup.map((r) => `${r.kind}:${r.label}`), ['line:Investments'], 'a group emptied by hideZero is one zero line');
eq(m.flattenStatement([{ key: 'l', label: 'One', values: [5] }], 1)[0].change, null, 'no change without a comparative');
eq(m.statementSums([{ key: 't', label: 'T', of: [['missing', 1]] }], 2).get('t'), [0, 0], 'a total over an unknown key is zero');
eq(m.statementSums([{ key: 'l', label: 'Short', values: [7] }], 3).get('l'), [7, 0, 0], 'missing columns count as zero');

eq(m.formatPct(0.123, 'en'), '+12%', 'a rise');
eq(m.formatPct(-0.035, 'en'), '-3.5%', 'a small fall keeps a decimal');
eq(m.formatPct(null), '—', 'no comparison');

// ── Net worth
const nw = m.netWorth([
  { id: 1, name: 'Current', kind: 'current', currency: 'EUR', archived: false, balance_functional_minor: 150000 },
  { id: 2, name: 'Vault', kind: 'savings', currency: 'EUR', archived: false, balance_functional_minor: 500000 },
  { id: 3, name: 'Card', kind: 'card', currency: 'EUR', archived: false, balance_functional_minor: -30000 },
  { id: 4, name: 'Cash', kind: 'cash', currency: 'EUR', archived: false, balance_functional_minor: 4000 },
  { id: 5, name: 'Old', kind: 'current', currency: 'GBP', archived: true, balance_functional_minor: 0 },
]);
eq([nw.assets, nw.liabilities, nw.net], [654000, 30000, 624000], 'owned, owed and net');
eq(nw.groups.map((g) => [g.key, g.total, g.accounts.map((a) => a.id)]), [['cash', 154000, [1, 4]], ['savings', 500000, [2]], ['debt', -30000, [3]]], 'grouped, largest first, an empty archived account left out');

// ── Budgets
eq(m.budgetProgress(5000, 10000, 0.5).state, 'under', 'half spent half way through');
eq(m.budgetProgress(9000, 10000, 0.95).state, 'pace', 'near the target late in the month');
eq(m.budgetProgress(9000, 10000, 0.3).state, 'warn', 'far ahead of the pace with no forecast');
eq(m.budgetProgress(4000, 10000, 0.3, 12000).state, 'warn', 'the forecast passes the target');
eq(m.budgetProgress(4000, 10000, 0.3, 9000).state, 'under', 'the forecast stays under');
const over = m.budgetProgress(12500, 10000, 0.6, 15000);
eq([over.state, over.left, over.spentPct, over.projectedPct], ['over', -2500, 1.25, 1.5], 'over the target');
eq(m.budgetProgress(100, 0, 0.5).state, 'none', 'no target');

// ── The forecast band
eq(m.niceStep(1000, 4), 500, 'a nice step of 5');
eq(m.niceStep(90, 4), 50, 'rounded up to 5 × 10');
const g = m.bandGeometry({ current: 180000, low: 120000, expected: 150000, high: 170000 });
ok(g.min <= 120000 && g.max >= 180000, 'the scale holds the band and now');
ok(g.pos(g.min) === 0 && g.pos(g.max) === 100, 'ends map to 0 and 100');
ok(g.pos(120000) < g.pos(150000) && g.pos(150000) < g.pos(170000), 'low, expected, high in order');
eq(g.ticks[0], g.min, 'ticks start at the minimum');
const z = m.bandGeometry({ current: 40000, low: 5000, expected: 20000, high: 30000 });
eq([z.min, z.zero], [0, 0], 'a band near zero shows zero');
const neg = m.bandGeometry({ current: 20000, low: -15000, expected: 2000, high: 10000 });
ok(neg.min < 0 && neg.zero > 0 && neg.zero < 100, 'a band crossing zero puts zero inside the bar');
const flat = m.bandGeometry({ current: 0, low: 0, expected: 0, high: 0 });
ok(flat.max > flat.min, 'a flat band still has a scale');
ok(m.bandGeometry({ current: 100, low: 50, expected: 80, high: 90 }, [500]).max >= 500, 'extra values widen the scale');

// ── PDF
const doc = m.statementPdf({
  title: 'Financial position',
  entity: 'Personal',
  currency: 'EUR',
  columns: ['Nov 2026', 'Oct 2026'],
  rows,
  notes: ['Foreign balances at the ECB closing rate.'],
  generated: '2026-11-04',
}, 'en-GB');
const table = doc.content.find((c) => c.table).table;
eq(table.body.length, rows.length + 1, 'one table row per statement row, plus the head');
eq(table.body[0].map((c) => c.text), ['', 'Nov 2026', 'Oct 2026', 'Change'], 'period columns and a change column');
const netPdf = table.body[rows.findIndex((r) => r.key === 'net') + 1];
eq(netPdf.map((c) => c.text), ['Net worth', '1,250.00', '600.00', '+108%'], 'a total row in the locale');
eq(table.body[rows.findIndex((r) => r.key === 'a2') + 1][1].text, '–', 'zero shows as a dash');
eq(doc.content[doc.content.length - 1].text, 'Foreign balances at the ECB closing rate.', 'notes follow the table');
eq(m.statementFileName('Profit or loss', 'November 2026', 'pdf'), 'Profit or loss - November 2026.pdf', 'file name');

// ── The host's statement rows
const host = [
  { key: 'assets', label: 'Assets', level: 0, style: 'header', amount_minor: 0, comparative_minor: null },
  { key: 'cash', label: 'Current account', level: 1, style: 'line', amount_minor: 120000, comparative_minor: 100000 },
  { key: 'wallet', label: 'Wallet', level: 1, style: 'line', amount_minor: 0, comparative_minor: 0 },
  { key: 'assets_total', label: 'Total assets', level: 0, style: 'subtotal', amount_minor: 120000, comparative_minor: 100000 },
  { key: 'net', label: 'Net worth', level: 0, style: 'total', amount_minor: 120000, comparative_minor: null },
];
const hr = m.fromHostRows(host, { comparative: true });
eq(hr.map((r) => `${r.kind}:${r.depth}:${r.values.join('/')}`), ['heading:0:', 'line:1:120000/100000', 'line:1:0/0', 'subtotal:0:120000/100000', 'total:0:120000/0'], 'host rows map to table rows, a missing comparative as zero');
eq(hr[1].change, 20000, 'the change against the comparative');
eq(m.fromHostRows(host).map((r) => r.values.length), [0, 1, 1, 1, 1], 'one column without comparatives');
eq(m.fromHostRows(host, { hideZero: true }).some((r) => r.key === 'wallet'), false, 'hideZero drops a zero line');
const folded = m.fromHostRows(host, { collapsed: new Set(['assets']) });
eq(folded.map((r) => r.key), ['assets', 'assets_total', 'net'], 'a folded header hides its rows, its subtotal stays');
eq(folded[0].collapsed, true, 'the folded header says so');

// ── Periods and close
const periods = [
  { month: '2026-08', status: 'closed', entries: 10 },
  { month: '2026-09', status: 'closed', entries: 12 },
  { month: '2026-10', status: 'open', entries: 9 },
  { month: '2026-11', status: 'open', entries: 2 },
];
eq(m.lockedThrough(periods), '2026-09', 'the latest closed month');
eq(m.lockedThrough([]), null, 'nothing closed');
eq([m.isLocked('2026-09-30', '2026-09'), m.isLocked('2026-10-01', '2026-09'), m.isLocked('2026-01-01', null)], [true, false, false], 'dates in or before it are locked');
eq(m.correctionDate('2026-09', '2026-11-04'), '2026-11-04', 'a correction is dated today when today is open');
eq(m.correctionDate('2026-11', '2026-11-04'), '2026-12-01', 'or the first open day');
eq(m.nextToClose(periods, '2026-11-04'), '2026-10', 'the earliest ended open month closes next');
eq(m.nextToClose(periods, '2026-10-20'), null, 'a month that has not ended cannot close');
eq(m.nextToClose([{ month: '2026-09', status: 'open', entries: 0 }, ...periods.slice(2)], '2026-11-04'), '2026-10', 'an empty month needs no close');

// ── Recognition schedules
eq(m.scheduleKind('2026-11-04', '2026-11'), 'prepaid', 'spread from the entry month on: paid ahead');
eq(m.scheduleKind('2026-11-04', '2026-06'), 'accrued', 'spread before it: accrued');
eq(m.spreadPreview(10000, 3, '2026-11'), [{ month: '2026-11', amount: 3333 }, { month: '2026-12', amount: 3333 }, { month: '2027-01', amount: 3334 }], 'even, the rounding in the last month');
eq(m.spreadPreview(-1000, 2, '2026-01').map((r) => r.amount), [-500, -500], 'a credit keeps its sign');
eq(m.spreadPreview(1000, 0, '2026-01'), [], 'no months, no rows');

// ── The weekly reminder
eq(m.weekdayName('Mon', 'en-GB'), 'Monday', 'weekday name');
eq(m.weekdayName('Sun', 'en-GB'), 'Sunday', 'the last weekday');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
