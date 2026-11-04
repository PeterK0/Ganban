#!/usr/bin/env node
// Unit test for the comment composer's rules (src/lib/composer.pure.ts): the text field's
// height (auto-grow, cap, dragged height) and when the tag picker offers "Create task".
// Transpiles the real source with esbuild and asserts against it.  node scripts/test-composer.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'composer-')), 'composer.mjs');
execSync(`npx esbuild src/lib/composer.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const { fieldHeight, clampDrag, parseHeight, createCandidate, moveCursor, DRAG_MIN } = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

// Height: grows with the text, never below the rows, capped at 60% of the window.
const vh = 900; // cap 540
eq(fieldHeight({ content: 50, floor: 111, manual: null, viewport: vh }), 111, 'short text keeps the default rows');
eq(fieldHeight({ content: 300, floor: 111, manual: null, viewport: vh }), 300, 'longer text grows the field');
eq(fieldHeight({ content: 2000, floor: 111, manual: null, viewport: vh }), 540, 'very long text stops at 60% and scrolls');
eq(fieldHeight({ content: 50, floor: 111, manual: 250, viewport: vh }), 250, 'a dragged height replaces the floor');
eq(fieldHeight({ content: 400, floor: 111, manual: 250, viewport: vh }), 400, 'text still grows past a dragged height');
eq(fieldHeight({ content: 2000, floor: 111, manual: 700, viewport: vh }), 700, 'a dragged height above the cap lifts it');
eq(fieldHeight({ content: 2000, floor: 111, manual: 300, viewport: vh }), 540, 'a small dragged height keeps the 60% cap');

// Dragging stays within bounds.
eq(clampDrag(10, vh), DRAG_MIN, 'drag has a minimum');
eq(clampDrag(5000, vh), 765, 'drag stops at 85% of the window');
eq(clampDrag(300.4, vh), 300, 'drag rounds');

// The remembered height.
eq(parseHeight(null), null, 'unset');
eq(parseHeight('abc'), null, 'garbage');
eq(parseHeight('5'), null, 'too small');
eq(parseHeight('240'), 240, 'a height');

// "Create task": only when the search has text and no title matches it exactly.
const titles = ['Fix login', 'Write docs'];
eq(createCandidate('', titles), null, 'empty search offers nothing');
eq(createCandidate('   ', titles), null, 'blank search offers nothing');
eq(createCandidate('fix login', titles), null, 'an exact title (any case) offers nothing');
eq(createCandidate('  Fix   login ', titles), null, 'spaces don\'t count');
eq(createCandidate('Fix', titles), 'Fix', 'a partial match still offers to create');
eq(createCandidate('  New  task ', titles), 'New task', 'the title is trimmed and its spaces collapsed');

// Arrow keys wrap through the rows.
eq(moveCursor(0, 1, 3), 1, 'down');
eq(moveCursor(2, 1, 3), 0, 'down wraps');
eq(moveCursor(0, -1, 3), 2, 'up wraps');
eq(moveCursor(-1, 1, 3), 0, 'down from nothing lands on the first row');
eq(moveCursor(0, 1, 0), -1, 'no rows');

console.log(`composer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
