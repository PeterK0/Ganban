// A multi-choice task-status filter, shared by Home's "Assigned to you" and the
// project task list. The selection is a list of statuses; the empty list means
// "All". Pure, so scripts/test-statusfilter.mjs can check it.

/** The task statuses, in the order the chips show them. */
export const STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done'] as const;
export type Status = (typeof STATUSES)[number];

/** The bucket a task's status counts under. Unknown statuses from older or
 * other hosts count as Done when they read like it, else as To Do. */
export function statusBucket(status: string): Status {
  if ((STATUSES as readonly string[]).includes(status)) return status as Status;
  return /done|complete/i.test(status) ? 'Done' : 'To Do';
}

/** Whether a status passes the selection (empty = all). */
export function statusPasses(selection: readonly string[], status: string): boolean {
  return selection.length === 0 || selection.includes(statusBucket(status));
}

/** The selection with one status turned on or off, kept in chip order. All
 * four on collapses to "All" (the empty list). */
export function toggleStatus(selection: readonly string[], status: Status): Status[] {
  const on = new Set(selection);
  if (on.has(status)) on.delete(status);
  else on.add(status);
  const next = STATUSES.filter((s) => on.has(s));
  return next.length === STATUSES.length ? [] : next;
}

/** Read a stored selection: a JSON list, or an older single value ('all' or
 * one status). Anything unreadable gives `fallback`. */
export function parseStatusSelection(raw: string | null, fallback: Status[]): Status[] {
  if (raw == null) return fallback;
  let v: unknown = raw;
  try {
    v = JSON.parse(raw);
  } catch {
    // a bare old value such as `In Progress`
  }
  if (v === 'all' || v === '') return [];
  if (typeof v === 'string') v = [v];
  if (!Array.isArray(v)) return fallback;
  const known = new Set(v.filter((x): x is string => typeof x === 'string'));
  if (v.length > 0 && known.size === 0) return fallback;
  const next = STATUSES.filter((s) => known.has(s));
  if (v.length > 0 && next.length === 0) return fallback;
  return next.length === STATUSES.length ? [] : next;
}

/** Count tasks per status bucket. */
export function countByStatus(statuses: readonly string[]): Record<Status, number> {
  const n: Record<Status, number> = { 'To Do': 0, 'In Progress': 0, Blocked: 0, Done: 0 };
  for (const s of statuses) n[statusBucket(s)]++;
  return n;
}
