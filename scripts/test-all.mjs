// Runs every node test suite: each `test:*` script in package.json, in order, one at a time (several suites write
// to .test-build). CI runs this as `npm run test:all`. It doesn't stop at the first failure.
// A guard runs first: every scripts/test-*.mjs must have a `test:<name>` script. The files listed in .public-exclude
// are exempt: another suite runs them, where the tree carries them.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const names = Object.keys(scripts).filter((n) => n.startsWith('test:'));

// Guard: no suite file without a script.
const excluded = existsSync(path.join(root, '.public-exclude'))
  ? readFileSync(path.join(root, '.public-exclude'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];
const referenced = new Set(names.flatMap((n) => [...scripts[n].matchAll(/scripts\/(test-[\w.-]+\.mjs)/g)].map((m) => m[1])));
const files = readdirSync(path.join(root, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f) && f !== 'test-all.mjs');
const uncovered = files.filter((f) => !referenced.has(f) && !excluded.includes(`scripts/${f}`));
if (uncovered.length) {
  for (const f of uncovered) {
    console.error(`scripts/${f} is not covered: add a "test:${f.replace(/^test-|\.mjs$/g, '')}" script to package.json.`);
  }
  process.exit(1);
}

const jobs = names.map((n) => ({ label: n, cmd: ['npm', ['run', '-s', n]], file: scripts[n].match(/^node (scripts\/\S+)/)?.[1] }));

const results = [];
for (const job of jobs) {
  let skip = null;
  if (job.label === 'test:all') skip = 'this runner';
  else if (job.label === 'test:ops') skip = 'macOS host scripts; the macos CI job runs it';
  else if (job.file && !existsSync(path.join(root, job.file))) skip = 'not in this tree';
  if (skip) {
    console.log(`skipped  ${job.label}: ${skip}`);
    results.push({ label: job.label, status: 'skipped' });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(job.cmd[0], job.cmd[1], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, shell: process.platform === 'win32' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log(`${ok ? 'ok      ' : 'FAILED  '} ${job.label} (${secs}s)`);
  results.push({ label: job.label, status: ok ? 'ok' : 'failed' });
  if (!ok) console.log((r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : ''));
}

const count = (s) => results.filter((r) => r.status === s).length;
const failed = results.filter((r) => r.status === 'failed').map((r) => r.label);
console.log(`\n${count('ok')} ok, ${failed.length} failed, ${count('skipped')} skipped`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
