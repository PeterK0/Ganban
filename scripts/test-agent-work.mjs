#!/usr/bin/env node
// Unit test for the timer's "Agents" merge (src/lib/agentWork.pure.ts): one row per task
// across workspaces, every personality named once, the earliest start kept, oldest first.
//   node scripts/test-agent-work.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'agentwork-')), 'agentWork.mjs');
execSync(`npx esbuild src/lib/agentWork.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const { mergeAgentWork } = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const tag = (t, workspaceId) => ({ ...t, workspaceId });
const keyOf = (t) => `${t.workspaceId}:${t.id}`;
const row = (id, who, since) => ({ task_id: id, task: { id, title: `T${id}` }, who, since });

eq(mergeAgentWork([], tag, keyOf), {}, 'nothing running');

const merged = mergeAgentWork(
  [
    { workspaceId: 'local', rows: [row(1, 'Critic', '2026-11-04T10:05:00Z'), row(1, 'Scout', '2026-11-04T10:00:00Z'), row(2, 'Scout', '2026-11-04T10:02:00Z')] },
    // The same id on another host is another task.
    { workspaceId: 'team', rows: [row(1, 'Scout', '2026-11-04T09:00:00Z'), row(1, 'Scout', '2026-11-04T09:30:00Z')] },
  ],
  tag,
  keyOf
);
eq(Object.keys(merged), ['team:1', 'local:1', 'local:2'], 'one row per task, oldest first, ids kept apart by workspace');
eq(merged['local:1'].who, 'Scout, Critic', 'both personalities, first to start first');
eq(merged['local:1'].since, Date.parse('2026-11-04T10:00:00Z'), 'the earliest start');
eq(merged['team:1'].who, 'Scout', 'a name shows once');
eq(merged['team:1'].task, { id: 1, title: 'T1', workspaceId: 'team' }, 'the task carries its workspace');

console.log(`agent-work: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
