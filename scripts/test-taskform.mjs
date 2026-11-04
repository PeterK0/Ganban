#!/usr/bin/env node
// Unit test for the task editor's form and saved copies (src/lib/taskForm.ts):
// what counts as an edit, what a save sends, and why an editor that reopens from
// an older copy of a task shows the save it made on close (the lost-edit bug:
// Project > Tasks → Comments → Tasks showed the old text, and the next save
// wrote it back over the edit).
//   node scripts/test-taskform.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'taskform-')), 'tf.mjs');
execSync(`npx esbuild src/lib/taskForm.ts --bundle --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const F = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

const task = (over = {}) => ({
  id: 7, project_id: 2, title: 'Photograph the pieces', description: 'Notes', status: 'To Do', priority: 'Medium',
  prefix: undefined, cost: 12.5, currency: 'EUR', archived: false, pinned: false, deadline: '2026-11-08T00:00:00Z',
  area_id: 3, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', ...over,
});

// ----- the form and what counts as an edit
const t0 = task();
const f0 = F.formFromTask(t0);
eq(f0, { title: 'Photograph the pieces', description: 'Notes', status: 'To Do', priority: 'Medium', prefix: '',
  cost: '12.5', currency: 'EUR', deadline: '2026-11-08', areaId: 3 }, 'seeds from the task');
eq(F.isFormDirty(f0, t0), false, 'an unedited form is clean');
eq(F.isFormDirty(f0, null), true, 'no base task counts as edited');
for (const [k, v] of [['title', 'X'], ['description', 'Notes!'], ['status', 'Done'], ['priority', 'High'],
  ['prefix', 'FEAT'], ['cost', '3'], ['currency', 'GBP'], ['deadline', '2026-12-01'], ['areaId', undefined]]) {
  eq(F.isFormDirty({ ...f0, [k]: v }, t0), true, `an edit to ${k} is an edit`);
}
eq(F.isFormSavable({ ...f0, title: '  ' }), false, 'a blank title is not saved');

// ----- what a save sends: text goes as typed, so a cleared field saves
const u = F.formToUpdate({ ...f0, description: '', prefix: '' });
eq([u.description, u.prefix, u.title, u.cost, u.area_id], ['', '', 'Photograph the pieces', 12.5, 3], 'clearing text is sent');
eq('pinned' in u, false, 'the pin has its own save');
eq(Object.keys(u).sort().join(), [...F.FORM_FIELDS].sort().join(), 'FORM_FIELDS names what a form save writes');
eq(F.formToUpdate({ ...f0, deadline: '' }).deadline, null, 'no deadline clears it');

// ----- the task as it will read once saved
const edited = { ...f0, description: 'Notes, edited', title: 'New title' };
const pending = F.applyForm(t0, edited);
eq([pending.title, pending.description, pending.id, pending.pinned], ['New title', 'Notes, edited', 7, false], 'applies the form');
eq(F.isFormDirty(edited, pending), false, 'the pending copy matches the form (no second save)');

// ----- saved copies: the editor reopens from the newest one
F.forgetAllCopies();
eq(F.freshest(t0), t0, 'nothing remembered: the copy handed in');
const s1 = F.beginSave();
F.rememberPending(t0, pending, s1);
eq(F.freshest(task()).description, 'Notes, edited', 'a stale copy (same version) reopens with the pending save');
const saved = F.rememberSaved(t0, { ...pending, updated_at: '2026-11-03T22:00:00Z' }, s1);
eq(F.freshest(task()).updated_at, '2026-11-03T22:00:00Z', 'a stale copy reopens with the host answer');
eq(F.freshest(saved), saved, 'the host answer itself');
const later = task({ description: 'edited elsewhere', updated_at: '2026-11-04T09:00:00Z' });
eq(F.freshest(later), later, 'a copy read after the save wins');
eq(F.freshest(task()), task(), '…and the remembered copy is dropped');

// A failed save stops showing as saved; only the copy it remembered goes.
F.forgetAllCopies();
F.rememberPending(t0, pending, F.beginSave());
F.forgetPending(pending);
eq(F.freshest(t0), t0, 'a failed save is forgotten');
F.rememberPending(t0, pending, F.beginSave());
const pending2 = F.applyForm(t0, { ...edited, title: 'Newer' });
F.rememberPending(t0, pending2, F.beginSave());
F.forgetPending(pending);
eq(F.freshest(t0).title, 'Newer', 'forgetting an older save keeps a newer one');

// Answers out of order: an early save's answer never replaces a later save.
F.forgetAllCopies();
const early = F.beginSave();
const late = F.beginSave();
F.rememberPending(t0, F.applyForm(t0, { ...f0, title: 'Late' }), late);
F.rememberSaved(t0, { ...t0, title: 'Early', updated_at: '2026-11-03T22:00:00Z' }, early);
eq(F.freshest(task()).title, 'Late', 'a slow answer to an earlier save is ignored');

// A cleared cost, deadline or area is sent as null (the host clears it) and
// reads cleared.
const clearedForm = { ...f0, cost: '', deadline: '', areaId: undefined };
const cu = F.formToUpdate(clearedForm);
eq([cu.cost, cu.deadline, cu.area_id], [null, null, null], 'cleared numbers are sent as null');
const cleared = F.applyForm(t0, clearedForm);
eq([cleared.cost, cleared.deadline, cleared.area_id], [undefined, undefined, undefined], 'and read cleared');
eq(F.isFormDirty(clearedForm, cleared), false, 'the pending copy matches a cleared form');

// The map is bounded.
F.forgetAllCopies();
for (let i = 1; i <= 205; i++) F.rememberPending(task({ id: 1000 + i }), task({ id: 1000 + i, title: 'c' }), F.beginSave());
eq(F.freshest(task({ id: 1001 })).title, 'Photograph the pieces', 'the oldest copies are dropped past the cap');
eq(F.freshest(task({ id: 1205 })).title, 'c', 'the newest stay');

// Workspaces: the same ids on another host are another task.
F.forgetAllCopies();
F.rememberPending(t0, pending, F.beginSave());
eq(F.freshest(task({ workspaceId: 'ws-b' })).description, 'Notes', 'another workspace is not mixed in');
const tagged = task({ workspaceId: 'ws-b' });
eq(F.rememberSaved(tagged, { ...t0, updated_at: '2026-11-05T00:00:00Z' }, F.beginSave()).workspaceId, 'ws-b', 'the host answer keeps the workspace tag');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
