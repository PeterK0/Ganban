#!/usr/bin/env node
// Unit test for the Finance inbox's bulk wording (src/tabs/finance/inbox.pure.ts): what "Select all"
// covers, the confirm texts with their counts, date ranges and the suggestion job's progress.
// node scripts/test-finance-inbox.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'fininbox-')), 'inbox.mjs');
execSync(`npx esbuild src/tabs/finance/inbox.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL: ${msg}\n  got  ${g}\n  want ${w}`); }
};
const has = (s, part, msg) => eq(s.includes(part), true, `${msg}: "${part}" in "${s}"`);

// "Select all" says whether it means the page or everything.
eq(m.selectLabel(0, 100, 10302, 'en-GB'), 'Select the 100 shown', 'a page of a big inbox');
eq(m.selectLabel(0, 12, 12, 'en-GB'), 'Select all', 'everything is shown');
eq(m.selectLabel(3, 100, 10302, 'en-GB'), '3 selected', 'a selection');

// The confirms show the count and say a post is reversible.
const post = m.postAllConfirm(10302, false, 'en-GB');
has(post, '10,302 transactions', 'post count');
has(post, 'in the inbox', 'unfiltered');
has(post, 'stay editable until their month is closed', 'reversible');
has(m.postAllConfirm(1, true, 'en-GB'), '1 transaction matching these filters', 'one, filtered');
const cat = m.categoriseAllConfirm(312, 'Groceries', 'en-GB');
has(cat, 'Sort 312 transactions as Groceries', 'categorise count');
has(cat, 'Transfers are left', 'transfers');

eq(m.postedText(40, 0, 'en-GB'), 'Posted 40 transactions.', 'posted');
eq(m.postedText(40, 2, 'en-GB'), 'Posted 40 transactions. 2 stayed in the inbox (a closed month, or a transfer to confirm).', 'posted, some closed');
eq(m.categorisedText(1, 0, 'Rent', 'en-GB'), 'Sorted 1 transaction as Rent.', 'sorted one');
has(m.categorisedText(5, 1, 'Rent', 'en-GB'), "1 couldn't take it", 'skipped');

eq(m.dateRange('2026-01-02', '2026-01-02', (d) => d), '2026-01-02', 'one day');
eq(m.dateRange('2026-01-02', '2026-03-04', (d) => d), '2026-01-02 – 2026-03-04', 'a range');

eq(m.isFiltered({}), false, 'no filter');
eq(m.isFiltered({ search: 'x' }), true, 'search');
eq(m.isFiltered({ groupKey: 'out:x' }), true, 'group');

const job = (o) => ({ state: 'running', done: 0, total: 0, suggested: 0, error: null, ...o });
eq(m.suggestJobText(job({}), 'en-GB'), 'Suggesting…', 'starting');
eq(m.suggestJobText(job({ done: 30, total: 1200 }), 'en-GB'), 'Suggesting… 30 of 1,200 payees', 'progress');
has(m.suggestJobText(job({ state: 'done', total: 40, suggested: 31 }), 'en-GB'), '31 of 40 payees', 'done');
eq(m.suggestJobText(job({ state: 'done' }), 'en-GB'), 'Every unsorted payee has a suggestion already.', 'nothing to do');
eq(m.suggestJobText(job({ state: 'failed', error: 'the local model took too long to answer' })), 'Suggestions stopped: the local model took too long to answer.', 'failed');

// A timeout while the host works is not an error to show.
has(m.bulkErrorText('Timed out after 20s reaching daemon at http://x'), 'Still working', 'timeout');
eq(m.bulkErrorText('closed period: reverse it instead'), 'closed period: reverse it instead', 'other errors as they are');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
