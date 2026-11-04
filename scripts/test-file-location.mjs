#!/usr/bin/env node
// Unit test for "Show in folder" (src/lib/fileLocation.pure.ts): when it's offered
// and what happens when the file isn't on this machine.
// Transpiles the real source with esbuild and asserts against it.  node scripts/test-file-location.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'file-location-')), 'fileLocation.mjs');
execSync(`npx esbuild src/lib/fileLocation.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const L = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

const uploaded = { kind: 'attachment', shared: true, localPath: undefined }; // create_shared_attachment: file_path ''
const fromDesktop = { kind: 'attachment', shared: true, localPath: '/Users/mia/report.pdf' };
const localOnly = { kind: 'attachment', shared: false, localPath: '/Users/me/notes.md' };
const pathless = { kind: 'attachment', shared: false, localPath: undefined };
const projectFile = { kind: 'project', shared: true };
const host = { hasPaths: true, onHost: true };
const client = { hasPaths: true, onHost: false };
const browser = { hasPaths: false, onHost: false };

// ----- offered
eq(L.showInFolderOffered(uploaded, host), true, 'a host upload is in the blob store on the host');
eq(L.showInFolderOffered(uploaded, client), false, 'a host upload has no folder on a client (Open downloads it)');
eq(L.showInFolderOffered(fromDesktop, client), true, 'a saved path is worth trying on a client');
eq(L.showInFolderOffered(localOnly, client), true, 'a local-only file keeps its path');
eq(L.showInFolderOffered(pathless, host), false, 'a pathless local row has nothing to show');
eq(L.showInFolderOffered(projectFile, host), true, 'a project file on the host');
eq(L.showInFolderOffered(projectFile, client), false, 'a project file on a client');
eq(L.showInFolderOffered(fromDesktop, browser), false, 'a browser shows no folders');

// ----- after the reveal
eq(L.afterReveal('file', fromDesktop), 'done', 'found');
eq(L.afterReveal('none', fromDesktop), 'open-host-copy', 'another machine’s path: open the host copy, no error');
eq(L.afterReveal('folder', fromDesktop), 'note', 'its folder is here but not the file: say so, offer the download');
eq(L.afterReveal('none', localOnly), 'note', 'a local-only file from another machine: say where it was saved');
eq(L.afterReveal('folder', localOnly), 'note', 'a moved local file: nearest folder');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
