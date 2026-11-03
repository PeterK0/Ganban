#!/usr/bin/env node
// Re-runnable unit test for the K2 workspace migration logic (the pure,
// dependency-free core of src/lib/workspaces.ts). Transpiles the REAL source
// with esbuild and asserts against the compiled output — no mirror, no drift.
//
//   node scripts/test-workspaces.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'wp-')), 'wp.mjs');
execSync(`npx esbuild src/lib/workspaces.pure.ts --format=esm --outfile=${out}`, { cwd: root, stdio: 'inherit' });

const { planMigration, stableRemoteId, LOCAL_ID } = await import(out);
let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));

ok(planMigration({ migrated: false, transportMode: 'local', daemonUrl: null, token: null })?.active === LOCAL_ID, 'fresh -> local');
ok(planMigration({ migrated: false, transportMode: 'local', daemonUrl: 'http://127.0.0.1:8765', token: null })?.localUrl === 'http://127.0.0.1:8765', 'local loopback remembered');
ok(!planMigration({ migrated: false, transportMode: 'local', daemonUrl: 'http://100.64.1.2:8765', token: 'x' })?.localUrl, 'non-loopback url not remembered as local');
{
  const p = planMigration({ migrated: false, transportMode: 'online', daemonUrl: 'http://100.64.1.2:8765', token: 'tok123' });
  ok(p?.seedRemote?.token === 'tok123' && p?.active === stableRemoteId('http://100.64.1.2:8765'), 'online -> seeded remote active');
}
ok(planMigration({ migrated: false, transportMode: 'online', daemonUrl: 'http://h:1', token: null })?.active === LOCAL_ID, 'online without token -> local');
ok(planMigration({ migrated: true, transportMode: 'online', daemonUrl: 'http://h:1', token: 't' }) === null, 'migrated -> null (idempotent)');
ok(stableRemoteId('http://h:1') === stableRemoteId('http://h:1') && stableRemoteId('http://a:1') !== stableRemoteId('http://b:1'), 'stableRemoteId deterministic + distinct');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
