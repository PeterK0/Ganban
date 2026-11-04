#!/usr/bin/env node
// Unit test for the Finance import job's progress (src/tabs/finance/importJob.pure.ts): how full the
// bar is and the stage label. node scripts/test-finance-import-job.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finjob-')), 'job.mjs');
execSync(`npx esbuild src/tabs/finance/importJob.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
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

const job = (stage, done = 0, total = 0, state = 'running') => ({ state, stage, done, total });

// The bar only grows through the stages.
const steps = [job('reading'), job('rates'), job('accounts'), job('rows', 0, 4000), job('rows', 2000, 4000), job('rows', 4000, 4000),
  job('pairing', 0, 4000), job('rules', 0, 4000), job('rules', 4000, 4000), job('done', 4000, 4000, 'done')];
const pcts = steps.map(m.progressPercent);
eq(pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), true, `the bar never shrinks: ${pcts}`);
eq([pcts[0], pcts[pcts.length - 1]], [0, 100], 'from empty to full');
eq(m.progressPercent(job('rows', 2000, 4000)), 44, 'half the rows: halfway through their span');
eq(m.progressPercent(job('rows', 9, 0)), 8, 'no total: the start of the span');
eq(m.progressPercent(job('rows', 50, 10)), 80, 'done past the total is capped');
eq(m.progressPercent(job('rows', 10, 10, 'done')), 100, 'a finished job is full');

// Labels.
eq(m.stageLabel(job('rows', 1200, 4475), (n) => n.toLocaleString('en-GB')), 'Importing lines: 1,200 of 4,475', 'rows with the locale');
eq(m.stageLabel(job('rates')), 'Fetching exchange rates…', 'rates');
eq(m.stageLabel(job('rules', 0, 0)), 'Applying rules…', 'rules without a total');
eq(m.stageLabel(job('rows', 1, 2, 'failed')), 'The import stopped', 'failed');

console.log(`finance import job: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
