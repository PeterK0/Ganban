#!/usr/bin/env node
// Unit test for the multi-choice status filter (src/components/statusFilter.ts):
// toggling, "All" as the empty list, and reading old single stored values.
//   node scripts/test-statusfilter.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'statusfilter-')), 'sf.mjs');
execSync(`npx esbuild src/components/statusFilter.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const F = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const DEF = ['To Do', 'In Progress', 'Blocked'];

// ----- toggle: chip order kept, all four collapse to "All"
eq(F.toggleStatus([], 'Done'), ['Done'], 'from All, one chip');
eq(F.toggleStatus(['Done'], 'To Do'), ['To Do', 'Done'], 'kept in chip order');
eq(F.toggleStatus(['To Do', 'Done'], 'Done'), ['To Do'], 'off again');
eq(F.toggleStatus(DEF, 'Done'), [], 'all four = All');

// ----- passes: empty = all; unknown statuses bucket sensibly
eq(F.statusPasses([], 'Blocked'), true, 'All passes everything');
eq(F.statusPasses(['To Do', 'In Progress'], 'In Progress'), true, 'in the set');
eq(F.statusPasses(['To Do', 'In Progress'], 'Done'), false, 'not in the set');
eq(F.statusPasses(['Done'], 'Completed'), true, 'completed reads as Done');
eq(F.statusPasses(['To Do'], 'Backlog'), true, 'unknown reads as To Do');

// ----- parse: lists, old single values, junk
eq(F.parseStatusSelection(null, DEF), DEF, 'nothing stored = default');
eq(F.parseStatusSelection('[]', DEF), [], 'stored All');
eq(F.parseStatusSelection('["Done","To Do"]', DEF), ['To Do', 'Done'], 'stored list, reordered');
eq(F.parseStatusSelection('all', DEF), [], 'old single all');
eq(F.parseStatusSelection('In Progress', DEF), ['In Progress'], 'old bare single status');
eq(F.parseStatusSelection('"Blocked"', DEF), ['Blocked'], 'old JSON single status');
eq(F.parseStatusSelection('["Nope"]', DEF), DEF, 'unknown values = default');
eq(F.parseStatusSelection('{"a":1}', DEF), DEF, 'junk = default');
eq(F.parseStatusSelection('["To Do","In Progress","Blocked","Done"]', DEF), [], 'all four stored = All');

// ----- counts
eq(F.countByStatus(['To Do', 'Done', 'Done', 'Shipped complete', 'Blocked']), { 'To Do': 1, 'In Progress': 0, Blocked: 1, Done: 3 }, 'counts');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
