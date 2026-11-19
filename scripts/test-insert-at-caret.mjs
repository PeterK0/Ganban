#!/usr/bin/env node
// Unit test for inserting text at a textarea's caret (src/lib/insertAtCaret.ts): a pasted image and a `/file`
// link land where the caret is, not at the end of the description.
//   node scripts/test-insert-at-caret.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'insertcaret-')), 'ic.mjs');
execSync(`npx esbuild src/lib/insertAtCaret.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const F = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const IMG = '![image](/files/7)';

// ----- insertAt: inline, replaces the selection
eq(F.insertAt('abcdef', 3, 3, 'X'), { value: 'abcXdef', caret: 4 }, 'at the caret');
eq(F.insertAt('abcdef', 1, 4, 'X'), { value: 'aXef', caret: 2 }, 'replaces the selection');
eq(F.insertAt('', 0, 0, 'X'), { value: 'X', caret: 1 }, 'empty text');
eq(F.insertAt('ab', 9, 9, 'X'), { value: 'abX', caret: 3 }, 'caret past the end is clamped');
eq(F.insertAt('see /fi more', 4, 7, '[a](/files/1)'), { value: 'see [a](/files/1) more', caret: 17 }, '/file token replaced');

// ----- insertLineAt: the pasted image goes on its own line, at the caret
eq(F.insertLineAt('first\nsecond\nthird', 6, 6, IMG),
  { value: `first\n${IMG}\nsecond\nthird`, caret: 6 + IMG.length }, 'start of a middle line: not at the bottom');
eq(F.insertLineAt('first\nsecond', 5, 5, IMG),
  { value: `first\n${IMG}\nsecond`, caret: 6 + IMG.length }, 'end of a line');
eq(F.insertLineAt('abcdef', 3, 3, IMG),
  { value: `abc\n${IMG}\ndef`, caret: 4 + IMG.length }, 'mid-line splits it');
eq(F.insertLineAt('', 0, 0, IMG), { value: IMG, caret: IMG.length }, 'empty description');
eq(F.insertLineAt('abc', 3, 3, IMG), { value: `abc\n${IMG}`, caret: 4 + IMG.length }, 'end of text');
eq(F.insertLineAt('abc\n', 4, 4, IMG), { value: `abc\n${IMG}`, caret: 4 + IMG.length }, 'after a trailing newline');
eq(F.insertLineAt('a\nSEL\nb', 2, 5, IMG), { value: `a\n${IMG}\nb`, caret: 2 + IMG.length }, 'replaces a selected line');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
