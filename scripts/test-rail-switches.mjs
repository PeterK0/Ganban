#!/usr/bin/env node
// Unit test for the Plug-ins switches' reload merge (src/store/railTabs.pure.ts): a reload that
// started before a click never flips the switch back.
//   node scripts/test-rail-switches.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'railswitches-')), 'rs.mjs');
execSync(`npx esbuild src/store/railTabs.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const { mergeLoadedSwitches: merge } = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

// Load 3 read finance=off; meanwhile the user turned it on.
eq(merge({ finance: false }, { finance: true }, { finance: Infinity }, 3), { finance: true }, 'a save still running wins');
eq(merge({ finance: false }, { finance: true }, { finance: 3 }, 3), { finance: true }, 'saved during this load: the click wins');
eq(merge({ finance: true }, { finance: false }, { finance: 2 }, 3), { finance: true }, 'saved before the load began: the host wins');
eq(merge({ finance: false, quiz: true }, { finance: true, quiz: false }, { finance: Infinity }, 3), { finance: true, quiz: true }, 'other switches still take the load');
eq(merge({ finance: true }, {}, {}, 1), { finance: true }, 'no clicks: the load as it is');
eq(merge({}, { gone: true }, { gone: Infinity }, 2), { gone: true }, 'a flipped switch the load left out stays');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
