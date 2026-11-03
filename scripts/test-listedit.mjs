#!/usr/bin/env node
// Unit test for the markdown list editing in comment fields (src/lib/listEdit.pure.ts):
// Tab / Shift+Tab indent list items, Enter continues a list. Transpiles the real
// source with esbuild and asserts against it.  node scripts/test-listedit.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'listedit-')), 'listedit.mjs');
execSync(`npx esbuild src/lib/listEdit.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const { indentLines, continueList } = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
/** A text with the caret (|) or selection ([…]) marked, as {value, start, end}. */
const at = (s) => {
  if (s.includes('|')) {
    const i = s.indexOf('|');
    return { value: s.slice(0, i) + s.slice(i + 1), start: i, end: i };
  }
  const a = s.indexOf('['), b = s.indexOf(']') - 1;
  return { value: s.replace('[', '').replace(']', ''), start: a, end: b };
};
const run = (fn, s, ...rest) => {
  const t = at(s);
  return fn(t.value, t.start, t.end, ...rest);
};

// ----- Tab indents a list item one level (4 spaces nests under bullets and numbers alike)
eq(run(indentLines, '- one\n- tw|o', 1), at('- one\n    - tw|o'), 'Tab indents the caret line');
eq(run(indentLines, '1. one\n2. tw|o', 1), at('1. one\n    2. tw|o'), 'Tab indents a numbered item');
eq(run(indentLines, '- one\n[- two\n- thr]ee', 1), at('- one\n[    - two\n    - thr]ee'), 'Tab indents every selected line');
eq(run(indentLines, '- one\n    - tw|o', 1), at('- one\n        - tw|o'), 'Tab nests deeper');
eq(run(indentLines, '- [ ] to|do', 1), at('    - [ ] to|do'), 'Tab indents a task-list item');

// ----- Shift+Tab outdents
eq(run(indentLines, '- one\n    - tw|o', -1), at('- one\n- tw|o'), 'Shift+Tab outdents');
eq(run(indentLines, '- one\n  - tw|o', -1), at('- one\n- tw|o'), 'Shift+Tab removes a shorter indent');
eq(run(indentLines, '- one\n\t- tw|o', -1), at('- one\n- tw|o'), 'Shift+Tab removes a tab');
eq(run(indentLines, '- o|ne', -1), at('- o|ne'), 'Shift+Tab on a top-level item changes nothing');

// ----- Not a list: Tab keeps its usual job (moving focus)
eq(run(indentLines, 'plain te|xt', 1), null, 'Tab outside a list is left alone');
eq(run(indentLines, '[- one\nplain]', 1), null, 'a selection with a non-list line is left alone');

// ----- Enter continues a list
eq(run(continueList, '- one|'), at('- one\n- |'), 'Enter starts the next bullet');
eq(run(continueList, '    * one|'), at('    * one\n    * |'), 'Enter keeps the indent and marker');
eq(run(continueList, '1. one|'), at('1. one\n2. |'), 'Enter numbers the next item');
eq(run(continueList, '9) nine|'), at('9) nine\n10) |'), 'Enter keeps the ) delimiter');
eq(run(continueList, '- [x] done|'), at('- [x] done\n- [ ] |'), 'Enter starts an unchecked task');
eq(run(continueList, '- sp|lit'), at('- sp\n- |lit'), 'Enter mid-item splits it');
eq(run(continueList, '- one\n- |'), at('- one\n|'), 'Enter on an empty bullet ends the list');
eq(run(continueList, '- one\n    - |'), at('- one\n- |'), 'Enter on an empty nested bullet outdents it');
eq(run(continueList, 'plain|'), null, 'Enter outside a list is left alone');
eq(run(continueList, '[- one]'), null, 'Enter over a selection is left alone');
eq(run(continueList, '|- one'), null, 'Enter before the marker is left alone');

// ----- Lines that only look like list markers
eq(run(continueList, 'Back in 2024.|'), null, 'a sentence ending in a number and a dot is not a list');
eq(run(continueList, '2024.|'), null, 'a bare number and dot is not an empty item (Enter must not delete it)');
eq(run(continueList, '1)|'), null, 'a bare 1) is not an empty item');
eq(run(continueList, '* * *|'), null, 'a thematic break is not a list');
eq(run(indentLines, '- - -|', 1), null, 'Tab on a thematic break is left alone');
eq(run(continueList, '- one\n- [ ]|'), at('- one\n|'), 'an empty task box (no trailing space) ends the list');

console.log(`listedit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
