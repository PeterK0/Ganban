#!/usr/bin/env node
// Unit test for task saves that find the task changed underneath them
// (src/lib/taskConflict.ts): when the editor saves again by itself, when it asks
// the user, and that the edit is never lost or written over the other one.
//   node scripts/test-task-conflict.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'task-conflict-')), 'tc.mjs');
execSync(`npx esbuild src/lib/taskConflict.ts --bundle --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const C = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

const form = (over = {}) => ({
  title: 'Photograph the pieces', description: 'Notes', status: 'To Do', priority: 'Medium', prefix: '',
  cost: '12.5', currency: 'EUR', deadline: '2026-11-08', areaId: 3, ...over,
});
const task = (over = {}) => ({
  id: 7, project_id: 2, title: 'Photograph the pieces', description: 'Notes', status: 'To Do', priority: 'Medium',
  prefix: undefined, cost: 12.5, currency: 'EUR', archived: false, pinned: false, deadline: '2026-11-08T00:00:00.000Z',
  area_id: 3, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', ...over,
});

// ----- the decision
const base = form();
eq(C.resolveConflict(base, form({ title: 'A' }), form({ description: 'Theirs' })),
  { kind: 'resave', form: form({ title: 'A', description: 'Theirs' }), changed: ['title'] },
  'different fields: save mine again on theirs, keeping their field');
eq(C.resolveConflict(base, form({ description: 'Mine' }), form({ description: 'Theirs' })),
  { kind: 'conflict', form: form({ description: 'Mine' }), fields: ['description'] },
  'the same field, differently: ask, showing mine');
eq(C.resolveConflict(base, form({ title: 'A', status: 'Done' }), form({ title: 'B', priority: 'High' })),
  { kind: 'conflict', form: form({ title: 'A', status: 'Done', priority: 'High' }), fields: ['title'] },
  'only the shared field is named; their other change is taken');
eq(C.resolveConflict(base, form({ title: 'A' }), form({ title: 'A' })), { kind: 'saved' },
  'the same change on both sides: already saved');
eq(C.resolveConflict(base, form({ title: 'A' }), form({ title: 'A', priority: 'High' })), { kind: 'saved' },
  'mine landed and something else changed too (a resend after the first copy landed): nothing to do');
eq(C.resolveConflict(base, base, form({ title: 'B' })), { kind: 'saved' }, 'no edit: nothing to save');
eq(C.resolveConflict(base, form({ areaId: undefined }), form({ areaId: 5 })),
  { kind: 'conflict', form: form({ areaId: undefined }), fields: ['areaId'] }, 'clearing a field they set is a clash');
eq(C.resolveConflict(base, form({ cost: '' }), form({ currency: 'GBP' })),
  { kind: 'resave', form: form({ cost: '', currency: 'GBP' }), changed: ['cost'] }, 'a cleared field saves again as cleared');

// ----- the form the notice shows
eq(C.rebaseForm(form({ description: 'Mine, and more' }), form({ description: 'Mine' }), form({ description: 'Mine', title: 'T' })),
  form({ description: 'Mine, and more', title: 'T' }), 'what was typed after the save went out is kept');
eq(C.takeFields(form({ description: 'Mine', title: 'A' }), form({ description: 'Theirs' }), ['description']),
  form({ description: 'Theirs', title: 'A' }), 'take the other: only the clashing fields');

// ----- what a resave sends
eq(C.pickInput({ title: 'A', description: 'x', cost: null, area_id: null }, ['title', 'cost', 'areaId']),
  { title: 'A', cost: null, area_id: null }, 'only the fields still to write, cleared ones as null');

// ----- the save loop, against a fake host
function host(current) {
  const sent = [];
  let row = { ...current };
  let n = 0;
  return {
    sent,
    get row() { return row; },
    edit(over) { row = { ...row, ...over, updated_at: `2026-11-0${3 + n++}T10:00:00Z` }; },
    send: async (input, stamp) => {
      sent.push({ input, stamp });
      if (stamp && stamp !== row.updated_at) {
        throw Object.assign(new Error('Conflict: changed'), { code: 'TASK_CHANGED', current: { ...row } });
      }
      row = { ...row, ...input, updated_at: `2026-11-0${3 + n++}T10:00:00Z` };
      return { ...row };
    },
  };
}

{
  const t = task();
  const h = host(t);
  const saved = await C.saveFormChecked(t, form({ title: 'Mine' }), h.send);
  eq([saved.title, h.sent.length, h.sent[0].stamp], ['Mine', 1, t.updated_at], 'unchanged: one save, with the stamp');
}
{
  const t = task();
  const h = host(t);
  h.edit({ description: 'Theirs' }); // another device saved first
  const saved = await C.saveFormChecked(t, form({ title: 'Mine' }), h.send);
  eq([saved.title, saved.description], ['Mine', 'Theirs'], 'other fields: both edits kept, silently');
  eq(h.sent.length, 2, 'one refused save, one resave');
  eq(h.sent[1].input, { title: 'Mine' }, 'the resave sends only my field, not my stale description');
  eq(h.sent[1].stamp, '2026-11-03T10:00:00Z', 'the resave carries the new stamp');
}
{
  const t = task();
  const h = host(t);
  h.edit({ description: 'Theirs' });
  let err = null;
  try {
    await C.saveFormChecked(t, form({ description: 'Mine' }), h.send);
  } catch (e) {
    err = e;
  }
  eq(err instanceof C.TaskConflict, true, 'the same field: a TaskConflict');
  eq([err?.fields, err?.form.description, err?.fresh.description], [['description'], 'Mine', 'Theirs'],
    'it names the field, keeps my text and carries theirs');
  eq(h.row.description, 'Theirs', 'nothing was written over theirs');
}
{
  const t = task();
  const h = host(t);
  h.edit({ title: 'Mine' }); // my first copy landed; this is the resend
  const saved = await C.saveFormChecked(t, form({ title: 'Mine' }), h.send);
  eq([saved.title, h.sent.length], ['Mine', 1], 'a resend of a landed save settles as saved');
}
{
  const t = task();
  const h = host(t);
  let err = null;
  await C.saveFormChecked(t, form(), async () => { throw new Error('offline'); }).catch((e) => (err = e));
  eq(err?.message, 'offline', 'other errors pass through');
  const legacy = await C.saveFormChecked({ ...t, updated_at: undefined }, form({ title: 'X' }), h.send);
  eq([legacy.title, h.sent[0].stamp], ['X', undefined], 'no stamp known: saves without the check');
}
eq(C.conflictTask({ code: 'TASK_CHANGED', current: { id: 7 } }), { id: 7 }, 'the task a conflict carries');
eq(C.conflictTask({ code: 'OTHER', current: { id: 7 } }), null, 'another code is not a conflict');

// ----- drafts on the device
{
  const m = new Map();
  const s = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  const t = task({ workspaceId: 'w1' });
  eq(C.readDraft(t, s), null, 'no draft');
  C.keepDraft(t, { base: form(), mine: form({ title: 'Mine' }) }, s);
  eq(C.readDraft(t, s)?.mine.title, 'Mine', 'a kept draft reads back');
  eq(C.readDraft({ ...t, workspaceId: 'w2' }, s), null, 'per workspace');
  C.dropDraft(t, s);
  eq(C.readDraft(t, s), null, 'dropped');
  m.set('ganban.taskDraft.w1:2:7', '{not json');
  eq(C.readDraft(t, s), null, 'a broken draft is ignored');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
