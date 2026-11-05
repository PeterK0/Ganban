#!/usr/bin/env node
// Unit test for the transfer review list's bulk actions (src/tabs/finance/reviewPairs.pure.ts): which pairs
// "all like this" and "all at ≥ N%" take. node scripts/test-finance-review-pairs.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finpairs-')), 'pairs.mjs');
execSync(`npx esbuild src/tabs/finance/reviewPairs.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
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

const pocket = 'transfer:1:pocket withdrawal|2:pocket withdrawal';
const pairs = [
  { id: 1, score: 0.85, like_key: pocket },
  { id: 2, score: 0.745, like_key: pocket },
  { id: 3, score: 0.7, like_key: 'transfer:1:transfer out|3:transfer in' },
  { id: 4, score: 0.6, like_key: pocket },
];
const ids = (xs) => xs.map((x) => x.id);

eq(ids(m.pairsLike(pairs, pairs[0])), [1, 2, 4], 'like this: the same key, whatever the score');
eq(ids(m.pairsLike(pairs, pairs[2])), [3], 'a pair on its own is only like itself');
eq(ids(m.pairsAtLeast(pairs, m.AUTO_PERCENT)), [1, 2], 'at the auto bar, as the list rounds (74.5 shows as 75)');
eq(ids(m.pairsAtLeast(pairs, 0)), [1, 2, 3, 4], 'at 0 every pair');
eq(ids(m.pairsAtLeast(pairs, 100)), [], 'at 100 none here');
eq(ids(m.pairsAtLeast(pairs, Number.NaN)), [], 'not a number takes none');
eq([m.clampPercent('80'), m.clampPercent('150'), m.clampPercent('-3'), m.clampPercent('')], [80, 100, 0, 75], 'the field stays 0–100');

// The client's bar is the host's.
const host = readFileSync(join(root, 'crates/core/src/finance/pairing.rs'), 'utf8').match(/pub const AUTO_SCORE: f64 = ([\d.]+);/);
eq(host && Math.round(Number(host[1]) * 100), m.AUTO_PERCENT, 'AUTO_PERCENT matches AUTO_SCORE in pairing.rs');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
