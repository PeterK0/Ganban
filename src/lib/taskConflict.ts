// A task save that finds the task changed underneath it. The editor sends the
// `updated_at` its edit is based on, and the host refuses the save (TASK_CHANGED,
// carrying the task as it is now) when someone saved it since. Then:
// - the other save touched other fields, or the same ones to the same values:
//   save again on the new version, and the user sees nothing;
// - both changed the same field differently: keep the user's text and ask which
//   one stays (the editor's notice). Never a silent overwrite, never a lost edit.
// An edit whose save couldn't be settled (the page went away, the editor
// closed) is kept on the device as a draft and settled the next time the task
// opens.
import type { Task, UpdateTaskInput } from '../types';
import { formFromTask, formToUpdate, type TaskForm } from './taskForm';
import { TASK_CHANGED, hostErrorCode, hostErrorCurrent } from './hostError.pure';

export type FormField = keyof TaskForm;

const FIELDS: FormField[] = ['title', 'description', 'status', 'priority', 'prefix', 'cost', 'currency', 'deadline', 'areaId'];

/** The fields as the notice names them. */
export const FIELD_LABELS: Record<FormField, string> = {
  title: 'Title', description: 'Description', status: 'Status', priority: 'Priority', prefix: 'Prefix',
  cost: 'Cost', currency: 'Currency', deadline: 'Deadline', areaId: 'Area',
};

/** The save's key for each form field. */
const INPUT_KEY: Record<FormField, keyof UpdateTaskInput> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority', prefix: 'prefix',
  cost: 'cost', currency: 'currency', deadline: 'deadline', areaId: 'area_id',
};

export type Resolution =
  /** The task already holds every change of the edit: nothing to save. */
  | { kind: 'saved' }
  /** The edits don't touch the same field: save `changed` again on the new version. */
  | { kind: 'resave'; form: TaskForm; changed: FormField[] }
  /** Both changed `fields`, differently: ask. */
  | { kind: 'conflict'; form: TaskForm; fields: FormField[] };

/** Settle an edit (`mine`, made on `base`) against the task as it is now (`fresh`).
 * The `form` returned is `fresh` with the edit's changes on top. */
export function resolveConflict(base: TaskForm, mine: TaskForm, fresh: TaskForm): Resolution {
  const changed = FIELDS.filter((k) => mine[k] !== base[k]);
  const pending = changed.filter((k) => mine[k] !== fresh[k]);
  if (pending.length === 0) return { kind: 'saved' };
  const form: TaskForm = { ...fresh };
  for (const k of changed) (form as unknown as Record<string, unknown>)[k] = mine[k];
  const clashes = pending.filter((k) => fresh[k] !== base[k]);
  return clashes.length ? { kind: 'conflict', form, fields: clashes } : { kind: 'resave', form, changed: pending };
}

/** The form to show after a conflict: `merged` (the task as it is now, with the
 * sent edit on top), keeping what the user typed since the save went out
 * (`latest` where it differs from `sent`). */
export function rebaseForm(latest: TaskForm, sent: TaskForm, merged: TaskForm): TaskForm {
  const form: TaskForm = { ...merged };
  for (const k of FIELDS) if (latest[k] !== sent[k]) (form as unknown as Record<string, unknown>)[k] = latest[k];
  return form;
}

/** `form` with `fields` set back to `other`'s values: "take the other". */
export function takeFields(form: TaskForm, other: TaskForm, fields: FormField[]): TaskForm {
  const next: TaskForm = { ...form };
  for (const k of fields) (next as unknown as Record<string, unknown>)[k] = other[k];
  return next;
}

/** Only `fields` of a save. */
export function pickInput(input: UpdateTaskInput, fields: FormField[]): UpdateTaskInput {
  const out: Record<string, unknown> = {};
  for (const k of fields) {
    const key = INPUT_KEY[k];
    if (key in input) out[key] = input[key];
  }
  return out as UpdateTaskInput;
}

/** The task a TASK_CHANGED refusal carries, or null for any other error. */
export function conflictTask(e: unknown): Task | null {
  if (hostErrorCode(e) !== TASK_CHANGED) return null;
  const current = hostErrorCurrent(e);
  return current && typeof current === 'object' ? (current as Task) : null;
}

/** A save the user has to settle: both sides changed `fields`. */
export class TaskConflict extends Error {
  constructor(
    /** The task as it is now. */
    readonly fresh: Task,
    /** The form the edit started from. */
    readonly base: TaskForm,
    /** The edit as it was sent. */
    readonly mine: TaskForm,
    /** `fresh` with the edit on top: what the editor shows. */
    readonly form: TaskForm,
    readonly fields: FormField[],
  ) {
    super('this task was changed somewhere else');
    this.name = 'TaskConflict';
  }
}

export type SendTask = (input: UpdateTaskInput, expectedUpdatedAt: string | undefined) => Promise<Task>;

/** Save `form`, an edit of `base`, through `send`, checked against `base.updated_at`.
 * A conflict the edits don't share is saved again on the new version; one they
 * share rejects with a TaskConflict. Resolves with the task as saved. */
export async function saveFormChecked(
  base: Task,
  form: TaskForm,
  send: SendTask,
  toInput: (f: TaskForm) => UpdateTaskInput = formToUpdate,
): Promise<Task> {
  const baseForm = formFromTask(base);
  let input = toInput(form);
  let stamp = base.updated_at;
  for (let tries = 0; ; tries++) {
    try {
      return await send(input, stamp);
    } catch (e) {
      const fresh = conflictTask(e);
      if (!fresh || tries >= 3) throw e; // three races in a row: give up as an error
      const r = resolveConflict(baseForm, form, formFromTask(fresh));
      if (r.kind === 'saved') return fresh;
      if (r.kind === 'conflict') throw new TaskConflict(fresh, baseForm, form, r.form, r.fields);
      input = pickInput(toInput(r.form), r.changed);
      stamp = fresh.updated_at;
    }
  }
}

// ----- Drafts kept on the device --------------------------------------------
// An edit that couldn't be settled before the page went away. In localStorage,
// not memory: it has to survive a reload or a closed window, and it's deleted
// as soon as the edit is saved or the user picks a side.

export interface TaskDraft {
  /** The form the edit started from. */
  base: TaskForm;
  /** The edit. */
  mine: TaskForm;
}

type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): DraftStore | null => {
  try {
    return (globalThis as { localStorage?: DraftStore }).localStorage ?? null;
  } catch {
    return null;
  }
};
const draftKey = (t: Pick<Task, 'id' | 'project_id' | 'workspaceId'>) =>
  `ganban.taskDraft.${t.workspaceId ?? ''}:${t.project_id}:${t.id}`;

export function keepDraft(task: Pick<Task, 'id' | 'project_id' | 'workspaceId'>, draft: TaskDraft, s = store()): void {
  try {
    s?.setItem(draftKey(task), JSON.stringify(draft));
  } catch {
    /* full or blocked: the notice, if shown, still holds the edit */
  }
}

export function readDraft(task: Pick<Task, 'id' | 'project_id' | 'workspaceId'>, s = store()): TaskDraft | null {
  try {
    const raw = s?.getItem(draftKey(task));
    const d = raw ? (JSON.parse(raw) as TaskDraft) : null;
    return d && d.base && d.mine ? d : null;
  } catch {
    return null;
  }
}

export function dropDraft(task: Pick<Task, 'id' | 'project_id' | 'workspaceId'>, s = store()): void {
  try {
    s?.removeItem(draftKey(task));
  } catch {
    /* nothing to drop */
  }
}
