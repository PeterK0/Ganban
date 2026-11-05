#!/usr/bin/env node
// Unit test for deleting all finance data (src/tabs/finance/resetJob.pure.ts): the confirmation's
// list, the typed word, and the progress bar. node scripts/test-finance-reset.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finreset-')), 'reset.mjs');
execSync(`npx esbuild src/tabs/finance/resetJob.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`FAIL ${msg}\n  got  ${g}\n  want ${w}`);
  }
};

// The typed word.
eq(m.confirmed('DELETE'), true, 'the word');
eq([m.confirmed(''), m.confirmed('delete'), m.confirmed('DELET'), m.confirmed('DELETE!'), m.confirmed(' DELETE')], [false, false, false, false, false], 'anything else');

// The list.
const counts = { accounts: 3, entries: 10432, rules: 1, layouts: 0 };
const fmt = (n) => n.toLocaleString('en-GB');
eq(m.resetSummary(counts, false, fmt), {
  goes: ['3 accounts', '10,432 transactions', '1 categorisation rule', '0 saved import layouts'],
  stays: [],
}, 'everything goes');
eq(m.resetSummary(counts, true, fmt), {
  goes: ['3 accounts', '10,432 transactions'],
  stays: ['1 categorisation rule', '0 saved import layouts'],
}, 'rules and layouts stay');
eq(m.resetSummary({ accounts: 1, entries: 1, rules: 2, layouts: 1 }, false).goes, ['1 account', '1 transaction', '2 categorisation rules', '1 saved import layout'], 'singulars');

// The bar.
const job = (done, total, state = 'running') => ({ state, done, total });
eq(m.resetPercent(job(0, 0)), 0, 'no total yet');
eq(m.resetPercent(job(250, 1000)), 25, 'a quarter');
eq(m.resetPercent(job(2000, 1000)), 100, 'capped');
eq(m.resetPercent(job(0, 0, 'done')), 100, 'done is full');

console.log(`finance reset: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
