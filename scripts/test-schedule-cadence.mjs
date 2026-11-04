#!/usr/bin/env node
// Unit test for the automation schedule forms (src/lib/scheduleCadence.ts):
// interval, daily and weekly, read and written as the host parses them.
// node scripts/test-schedule-cadence.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'cad-')), 'cad.mjs');
execSync(`npx esbuild src/lib/scheduleCadence.ts --format=esm --outfile=${out} --log-level=warning`, { cwd: root, stdio: 'inherit' });
const { parseCadence, formatCadence, describeCadence, cadenceProblem, defaultCadence } = await import(out);

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// Reading each form.
eq(parseCadence('1 hour').mode, 'interval', 'interval');
eq(parseCadence('30 min').interval, '30 min', 'interval kept as typed');
eq([parseCadence('7:00').mode, parseCadence('7:00').time], ['daily', '07:00'], 'daily, padded');
let c = parseCadence('Mon 09:00');
eq([c.mode, c.days, c.time], ['weekly', ['Mon'], '09:00'], 'one weekday');
c = parseCadence('thu,Mon 9:30');
eq([c.mode, c.days, c.time], ['weekly', ['Mon', 'Thu'], '09:30'], 'weekdays in week order, any case');
c = parseCadence('Monday, Friday 18:00');
eq([c.mode, c.days], ['weekly', ['Mon', 'Fri']], 'long names and a space after the comma');
eq(parseCadence('Funday 09:00').mode, 'interval', 'an unknown day is left as typed for the host to judge');
eq(parseCadence('25:00').mode, 'interval', 'an impossible time is not daily');
eq(parseCadence('').interval, '1 hour', 'empty falls back to the default');

// Writing: the host's forms exactly.
eq(formatCadence({ ...defaultCadence(), mode: 'weekly', days: ['Thu', 'Mon'], time: '09:00' }), 'Mon,Thu 09:00', 'weekly string');
eq(formatCadence({ ...defaultCadence(), mode: 'daily', time: '07:00' }), '07:00', 'daily string');
eq(formatCadence({ ...defaultCadence(), interval: ' 2 hours ' }), '2 hours', 'interval trimmed');
for (const s of ['Mon 09:00', 'Mon,Thu 09:00', '07:00', '30 min']) eq(formatCadence(parseCadence(s)), s, `round trip ${s}`);

// What can't be saved.
ok(cadenceProblem({ ...defaultCadence(), mode: 'weekly', days: [] }) !== null, 'weekly needs a day');
ok(cadenceProblem({ ...defaultCadence(), mode: 'daily', time: '' }) !== null, 'daily needs a time');
ok(cadenceProblem({ ...defaultCadence(), interval: ' ' }) !== null, 'interval needs text');
ok(cadenceProblem(parseCadence('Mon,Thu 09:00')) === null, 'a full weekly cadence is fine');

// The list's words.
eq(describeCadence('Mon,Thu 09:00'), 'weekly on Mon, Thu at 09:00', 'weekly words');
eq(describeCadence('07:00'), 'daily at 07:00', 'daily words');
eq(describeCadence('2 hours'), 'every 2 hours', 'interval words');

console.log(`schedule cadence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
