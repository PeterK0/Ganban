#!/usr/bin/env node
// Unit test for pinned tabs' pure logic (src/lib/pinnedTabs.pure.ts): merge across
// workspaces, order, moves, drops, labels and the top bar's fit. Transpiles the real
// source with esbuild and asserts against it.  node scripts/test-pins.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'pins-')), 'pins.mjs');
execSync(`npx esbuild src/lib/pinnedTabs.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const P = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const keys = (pins) => pins.map(P.pinKey);
const pin = (ws, project, tab, position, sub = null) => ({ ws, project, tab, sub, position });

// ----- merge: hosts interleave by position; a failed host keeps what we had
const prev = [pin('ws-a', 1, 'tasks', 2), pin('local', 3, 'nato', 9)];
const merged = P.mergeLoad(prev, [
  { ws: 'local', pins: [{ project_id: 1, tab_id: 'chess', sub_view: 'puzzles', position: 3 }] },
  { ws: 'ws-a', pins: null },
]);
eq(keys(merged), ['ws-a:1:tasks', 'local:1:chess'], 'a failed host keeps its pins; a loaded one replaces its own');
eq(merged[1].sub, 'puzzles', 'sub-view carried');
eq(keys(P.sortPins([pin('b', 1, 'x', 1), pin('a', 1, 'x', 1)])), ['a:1:x', 'b:1:x'], 'ties break on the key');

// ----- add / remove / drop
let pins = [pin('local', 1, 'tasks', 1), pin('local', 1, 'files', 2)];
let r = P.addPin(pins, { ws: 'local', project: 2, tab: 'chess' }, 'puzzles');
eq(r.pin.position, 3, 'a new pin goes last');
eq(P.addPin(r.pins, { ws: 'local', project: 2, tab: 'chess' }, 'play').pins.length, 3, 're-pinning re-targets, no duplicate');
eq(P.addPin(r.pins, { ws: 'local', project: 2, tab: 'chess' }, 'play').pin.position, 3, 're-pinning keeps the place');
eq(P.endPosition([]), 1, 'first pin at 1');
eq(keys(P.removePin(r.pins, { ws: 'local', project: 1, tab: 'files' })), ['local:1:tasks', 'local:2:chess'], 'unpin');
eq(keys(P.dropPins(r.pins, 'local', 1)), ['local:2:chess'], 'a deleted project drops all its pins');
eq(keys(P.dropPins(r.pins, 'local', 1, 'files')), ['local:1:tasks', 'local:2:chess'], 'a disabled tab drops only its pins');
eq(P.dropPins(r.pins, 'ws-x', 1).length, 3, 'same id on another workspace is untouched');

// ----- moves
pins = [pin('l', 1, 'a', 1), pin('l', 1, 'b', 2), pin('l', 1, 'c', 3)];
r = P.movePin(pins, 'l:1:c', 0);
eq(keys(r.pins), ['l:1:c', 'l:1:a', 'l:1:b'], 'move to the front');
eq(r.changed.map((p) => p.position), [0], 'only the moved pin is rewritten');
r = P.movePin(pins, 'l:1:a', 1);
eq(keys(r.pins), ['l:1:b', 'l:1:a', 'l:1:c'], 'move one right');
eq(r.changed[0].position, 2.5, 'midpoint of the new neighbours');
eq(keys(P.movePin(pins, 'l:1:a', 99).pins), ['l:1:b', 'l:1:c', 'l:1:a'], 'clamped to the end');
eq(P.movePin(pins, 'l:1:a', 0).changed, [], 'no-op move writes nothing');
eq(P.movePin(pins, 'nope', 0).changed, [], 'unknown key writes nothing');
eq(keys(P.nudgePin(pins, 'l:1:b', -1).pins), ['l:1:b', 'l:1:a', 'l:1:c'], 'nudge left');
eq(keys(P.nudgePin(pins, 'l:1:c', 1).pins), ['l:1:a', 'l:1:b', 'l:1:c'], 'nudge past the end is a no-op');
const tight = [pin('l', 1, 'a', 1), pin('l', 1, 'b', 1 + 1e-7), pin('l', 1, 'c', 3)];
r = P.movePin(tight, 'l:1:c', 1);
eq(keys(r.pins), ['l:1:a', 'l:1:c', 'l:1:b'], 'a worn-thin gap still moves');
eq(r.pins.map((p) => p.position), [1, 2, 3], 'and renumbers 1..n');
eq(r.changed.length, 2, 'writing back only the pins that changed');

// ----- fit
eq(P.fitCount([100, 100, 100], 320, 4, 40), 3, 'all fit');
eq(P.fitCount([100, 100, 100], 240, 4, 40), 1, 'room for one plus "more"');
eq(P.fitCount([100, 100, 100], 250, 4, 40), 2, 'two plus "more"');
eq(P.fitCount([100, 100, 100], 30, 4, 40), 0, 'nothing fits: all in "more"');
eq(P.fitCount([], 0, 4, 40), 0, 'no pins');

// ----- labels
eq(P.pinLabel('Chess Club', 'chess', 'puzzles'), 'Chess Club', 'no registered sub-views: the tab name');
P.registerSubView('chess', { storageKey: 'ganban.chess.mode', short: 'Chess', labels: { play: 'Play', puzzles: 'Puzzles' } });
eq(P.pinLabel('Chess Club', 'chess', 'puzzles'), 'Chess · Puzzles', 'sub-view label');
eq(P.pinLabel('Chess Club', 'chess', 'nope'), 'Chess Club', 'an unknown sub-view: the tab name');
eq(P.pinLabel('Chess Club', 'chess', null), 'Chess Club', 'no sub-view: the tab name');
eq(P.pinLabel('Tasks', 'tasks', 'puzzles'), 'Tasks', 'a sub-view on a tab without them is ignored');
eq(P.prettyTabId('model-kits'), 'Model kits', 'fallback name');
eq(P.pinWindowLabel({ ws: 'ws-1a', project: 4, tab: 'chess' }), 'pin-ws-1a-4-chess', 'window label');
eq(P.pinWindowLabel({ ws: 'w s', project: 4, tab: 'a:b' }), 'pin-w_s-4-a_b', 'window label sanitised');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
