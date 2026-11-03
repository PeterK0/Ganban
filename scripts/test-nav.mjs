#!/usr/bin/env node
// Unit test for the app's back/forward history (src/lib/navHistory.pure.ts): pushes,
// amends and merges, tab and pane reports, skipped entries, the 50-entry cap, the
// shortcuts and the macOS title-bar inset. Transpiles the real source with esbuild.
//   node scripts/test-nav.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'nav-')), 'nav.mjs');
execSync(`npx esbuild src/lib/navHistory.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const N = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const task = (id, title = `T${id}`) => ({ kind: 'task', task: { id, project_id: 1, title } });
const where = (s) => s.entries.map((e) => `${e.view}${e.projectKey ? ':' + e.projectKey : ''}${e.tab ? '/' + e.tab : ''}${e.pane ? '#' + e.pane.scope + '=' + (e.pane.target.task?.id ?? '?') : ''}`);

// ----- views: a switch pushes, the same place doesn't
let s = N.emptyNav;
s = N.visitView(s, 'home', null, null);
s = N.visitView(s, 'home', null, null);
eq(where(s), ['home'], 'the same view twice is one entry');
s = N.visitView(s, 'projects', 'local:1', 'tasks');
eq(where(s), ['home', 'projects:local:1/tasks'], 'a project switch records the tab it shows');
eq([N.canBack(s), N.canForward(s)], [true, false], 'back enabled, forward disabled at the end');

// ----- tabs: the first report fills it in, a change pushes, another project's report waits
s = N.visitView(N.emptyNav, 'projects', 'local:1', null);
s = N.visitTab(s, 'local:1', 'home');
eq(where(s), ['projects:local:1/home'], 'the first tab report amends');
s = N.visitTab(s, 'local:1', 'tasks');
eq(where(s), ['projects:local:1/home', 'projects:local:1/tasks'], 'a tab change pushes');
eq(N.visitTab(s, 'local:2', 'files'), s, 'a report for another project is ignored');
eq(where(N.visitView(s, 'projects', null, null)).at(-1), 'projects', 'the overview has no tab');

// ----- panes: a click pushes, an auto-open or pane back/forward amends
s = N.openPane(s, { scope: 'tasks', target: task(5) }, 'amend');
eq(where(s).at(-1), 'projects:local:1/tasks#tasks=5', 'the auto-opened first task amends');
s = N.openPane(s, { scope: 'tasks', target: task(7) }, 'push');
eq(where(s).slice(-2), ['projects:local:1/tasks#tasks=5', 'projects:local:1/tasks#tasks=7'], 'opening another task pushes');
const same = N.openPane(s, { scope: 'tasks', target: task(7, 'renamed') }, 'push');
eq([same.entries.length, same.entries.at(-1).pane.target.task.title], [s.entries.length, 'renamed'], 'reopening the same task only refreshes its snapshot');
s = N.openPane(s, { scope: 'tasks', target: task(5) }, 'amend');
eq(where(s).slice(-2), ['projects:local:1/home', 'projects:local:1/tasks#tasks=5'], 'an amend that matches the entry before merges with it');

// ----- the search drawer: open pushes, close amends and merges
let d = N.visitView(N.emptyNav, 'home', null, null);
d = N.openPane(d, { scope: 'search', target: task(9) }, 'push');
eq(where(d), ['home', 'home#search=9'], 'search opens a new place');
d = N.closePane(d, 'search');
eq(where(d), ['home'], 'closing it merges back');
eq(N.closePane(N.openPane(d, { scope: 'home', target: task(1) }, 'push'), 'search').entries.length, 2, "closing a pane that isn't current changes nothing");

// ----- back then a new place drops the forward entries
let b = N.emptyNav;
for (const v of ['home', 'events', 'atlas']) b = N.visitView(b, v, null, null);
b = { ...b, index: 0 };
eq([N.canBack(b), N.canForward(b)], [false, true], 'at the start: back disabled');
b = N.visitView(b, 'reports', null, null);
eq(where(b), ['home', 'reports'], 'a new place after going back drops the forward history');

// ----- landing: skipped entries go
let l = N.emptyNav;
for (const v of ['home', 'events', 'atlas', 'reports']) l = N.visitView(l, v, null, null);
const landed = N.land(l, 0, l.entries[0], [2, 1]);
eq([where(landed), landed.index], [['home', 'reports'], 0], 'back over two gone entries lands on the first and forgets them');
const fwd = N.land({ ...l, index: 0 }, 3, l.entries[3], [1, 2]);
eq([where(fwd), fwd.index], [['home', 'reports'], 1], 'forward over gone entries');

// ----- the cap
let c = N.emptyNav;
for (let i = 0; i < 60; i++) c = N.visitView(c, `v${i}`, null, null);
eq([c.entries.length, c.entries[0].view, c.index], [50, 'v10', 49], 'keeps the newest 50');

// ----- shortcuts
const k = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
eq([N.navKey(k('[', { metaKey: true }), true), N.navKey(k(']', { metaKey: true }), true)], [-1, 1], 'Cmd+[ / Cmd+] on macOS');
eq(N.navKey(k('[', { metaKey: true, shiftKey: true }), true), 0, 'Cmd+Shift+[ is not back');
eq([N.navKey(k('ArrowLeft', { altKey: true }), false), N.navKey(k('ArrowRight', { altKey: true }), false)], [-1, 1], 'Alt+arrows elsewhere');
eq(N.navKey(k('ArrowLeft', { altKey: true }), true), 0, 'Alt+← is a text shortcut on macOS');
eq(N.navKey(k('[', { ctrlKey: true }), false), 0, 'Ctrl+[ is not back');

// ----- the macOS title-bar inset
const ins = (o) => N.titleBarInset({ tauri: true, mobile: false, mac: true, fullscreen: false, ...o });
eq(ins({}), N.TRAFFIC_LIGHTS_PX, 'macOS desktop app reserves the traffic lights');
eq(ins({ fullscreen: true }), 0, 'not in full screen');
eq([ins({ mac: false }), ins({ tauri: false }), ins({ mobile: true })], [0, 0, 0], 'not on Windows/Linux, in a browser or on mobile');
eq(ins({ tauri: false, mac: false, forced: true }), N.TRAFFIC_LIGHTS_PX, 'a forced preview in a browser');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
