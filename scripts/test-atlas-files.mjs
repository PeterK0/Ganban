#!/usr/bin/env node
// Unit test for Atlas › Files' listing (src/lib/atlasFiles.pure.ts): which project
// files and task attachments show, and which carry the "this device" mark.
// Transpiles the real source with esbuild and asserts against it.  node scripts/test-atlas-files.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'atlas-files-')), 'atlasFiles.mjs');
execSync(`npx esbuild src/lib/atlasFiles.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const A = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

const pf = [{ id: 1, file_name: 'plan.pdf', rel_path: 'specs/plan.pdf', size_bytes: 10, created_at: '2026-01-01' }];
const shared = { id: 5, task_title: 'T', file_name: 'up.png', storage_size: 20, is_shared: true, file_path: '', created_at: '2026-01-02' };
const local = { id: 6, task_title: 'T', file_name: 'notes.md', storage_size: 30, is_shared: false, file_path: '/Users/me/notes.md', created_at: '2026-01-03' };
const pathless = { ...local, id: 7, file_path: '' };

// ----- served from this machine (local mode): local attachments show, marked
const here = A.atlasEntries(pf, [shared, local, pathless], true);
eq(here.map((e) => e.key), ['p-1', 'a-5', 'a-6'], 'project file, shared and local attachment (a pathless local row has nothing to open)');
eq(here.map((e) => !!e.onDevice), [false, false, true], 'only the local attachment is on this device');
eq(here[2].filePath, '/Users/me/notes.md', 'the local row keeps its path for Open');
eq(here[0].relPath, 'specs/plan.pdf', 'project files keep their folders');
eq(here[2].relPath, 'notes.md', 'attachments are flat');

// ----- a client of a host: local attachments live elsewhere, stay hidden
const remote = A.atlasEntries(pf, [shared, local], false);
eq(remote.map((e) => e.key), ['p-1', 'a-5'], 'only host-stored files on a client of a host');

// ----- is_shared missing (older host) counts as local
eq(A.atlasEntries([], [{ ...local, is_shared: undefined }], true).map((e) => e.onDevice), [true], 'missing is_shared = local');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
