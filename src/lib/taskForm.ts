// The task editor's form, as plain data: how it seeds from a task, whether it
// differs from the task it was seeded from, what a save sends, and the task as
// it will read once saved. Every save path in TaskEditor (Save, the switch to
// another task, closing the editor) goes through these, so they agree on what
// "edited" means.
import type { Task, UpdateTaskInput } from '../types';

export interface TaskForm {
  title: string;
  description: string;
  status: string;
  priority: string;
  prefix: string;
  cost: string;
  currency: string;
  /** `YYYY-MM-DD`, or '' for none. */
  deadline: string;
  areaId: number | undefined;
}

const dateOnly = (iso?: string | null): string => (iso ? new Date(iso).toISOString().split('T')[0] : '');

/** The form a task opens with. */
export function formFromTask(task: Task): TaskForm {
  return {
    title: task.title,
    description: task.description || '',
    status: task.status,
    priority: task.priority,
    prefix: task.prefix || '',
    cost: task.cost?.toString() || '',
    currency: task.currency || '',
    deadline: dateOnly(task.deadline),
    areaId: task.area_id || undefined,
  };
}

/** Two forms hold the same values. */
export function formsEqual(a: TaskForm, b: TaskForm): boolean {
  return (Object.keys(a) as (keyof TaskForm)[]).every((k) => a[k] === b[k]);
}

/** True when the form holds an edit to `task` (the task it was seeded from, or
 * last saved as). No base task counts as edited. */
export function isFormDirty(form: TaskForm, task: Task | null | undefined): boolean {
  return !task || !formsEqual(form, formFromTask(task));
}

/** A form that can be saved: a task needs a title. */
export const isFormSavable = (form: TaskForm): boolean => form.title.trim() !== '';

/** What a save sends. Text goes as typed and a cleared cost, deadline or area
 * as `null`, so clearing a field saves the clearing; `pinned` is left out (the
 * pin has its own save). */
export function formToUpdate(form: TaskForm): UpdateTaskInput {
  return {
    title: form.title,
    description: form.description,
    status: form.status as Task['status'],
    priority: form.priority as Task['priority'],
    prefix: form.prefix,
    cost: form.cost ? parseFloat(form.cost) : null,
    currency: form.currency,
    deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
    area_id: form.areaId || null,
  };
}

// ----- Saved copies --------------------------------------------------------
// A view hands the editor the task as it read it, and that copy can be older
// than a save this window just made: a detail pane's back stack, a list loaded
// before an editor saved on close, a history entry. The editor reopens from
// the newest copy this window knows, so it never shows (and later re-saves)
// the old text.

interface SavedCopy {
  task: Task;
  /** The `updated_at` the copy supersedes: a task read at this version or
   * earlier is older than the copy. */
  supersedes: number;
  /** When its save started (beginSave): a save's answer never replaces the
   * copy of a save that started after it. */
  seq: number;
}
const copies = new Map<string, SavedCopy>();
/** Enough for a session's edits; the oldest go first. */
const MAX_COPIES = 200;
let lastSeq = 0;
const keyOf = (t: Task) => `${t.workspaceId ?? ''}:${t.project_id}:${t.id}`;
const stamp = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};
function put(task: Task, supersedes: number, seq: number): void {
  const key = keyOf(task);
  const had = copies.get(key);
  if (had && had.seq > seq) return; // a later save's copy stays
  copies.delete(key); // re-insert: the map's order is the eviction order
  copies.set(key, { task, supersedes, seq });
  if (copies.size > MAX_COPIES) copies.delete(copies.keys().next().value as string);
}

/** Number a save as it starts. */
export function beginSave(): number {
  return ++lastSeq;
}

/** Save `seq` of `base` is on its way, and `pending` is how it will read. */
export function rememberPending(base: Task, pending: Task, seq: number): void {
  put(pending, stamp(base.updated_at), seq);
}

/** The host answered save `seq` of `base` with `saved`. Returns `saved` with
 * the client-only fields of `base` kept (the workspace tag). */
export function rememberSaved(base: Task, saved: Task, seq: number): Task {
  const task: Task = base.workspaceId === undefined ? saved : { ...saved, workspaceId: base.workspaceId };
  put(task, stamp(task.updated_at), seq);
  return task;
}

/** A save failed: stop showing it as saved. Only drops `pending` if it's still
 * the remembered copy. */
export function forgetPending(pending: Task): void {
  if (copies.get(keyOf(pending))?.task === pending) copies.delete(keyOf(pending));
}

/** The newest copy of `task` this window knows: a remembered save, unless
 * `task` was read after it. */
export function freshest(task: Task): Task {
  const key = keyOf(task);
  const c = copies.get(key);
  if (!c) return task;
  if (stamp(task.updated_at) > c.supersedes) {
    copies.delete(key); // read after our save: it already holds it (or a later edit)
    return task;
  }
  return c.task;
}

/** Tests only. */
export function forgetAllCopies(): void {
  copies.clear();
}

/** `task` with the form's values applied: what the host will return once the
 * save lands. Shown in the meantime, so an editor that reopens before the save
 * answers reads the edit, not the old copy. */
export function applyForm(task: Task, form: TaskForm): Task {
  const u = formToUpdate(form);
  return {
    ...task,
    title: u.title ?? task.title,
    description: u.description,
    status: u.status ?? task.status,
    priority: u.priority ?? task.priority,
    prefix: u.prefix,
    cost: u.cost ?? undefined,
    currency: u.currency,
    deadline: u.deadline ?? undefined,
    area_id: u.area_id ?? undefined,
  };
}
