// Gilt task marks shared by the project screens (Home, Tasks, Kanban): the
// status mark (`g-st`), the due-date pill and a gem colour per area.
// docs/dev/GILT.md: lane `project` made this; the lead may promote it.

/** The `g-st` classes for a task status. */
export function statusMark(status: string): string {
  switch (status) {
    case 'In Progress':
      return 'g-st g-st-progress';
    case 'Done':
      return 'g-st g-st-done';
    case 'Blocked':
      return 'g-st g-st-blocked';
    default:
      return 'g-st';
  }
}

const DAY = 86_400_000;

/** A deadline as a short label with its pill class: red when overdue, warn
 * when due within three days, plain otherwise (and always plain once done).
 * Null when there is no usable deadline. */
export function dueTag(deadline: string | undefined, status?: string): { label: string; cls: string; late: boolean } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / DAY);
  const label =
    diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (status === 'Done') return { label, cls: 'g-tag', late: false };
  if (diff < 0) return { label, cls: 'g-tag g-tag-red', late: true };
  if (diff <= 3) return { label, cls: 'g-tag g-tag-warn', late: false };
  return { label, cls: 'g-tag', late: false };
}

const GEMS = ['c-pur', 'c-org', 'c-cyan', 'c-pink', 'c-grn', 'c-yel', 'c-teal', 'c-lav'];

/** A stable gem colour class for an area (areas carry no colour of their own). */
export function areaGem(areaId: number | null | undefined): string {
  if (areaId == null) return 'c-none';
  return GEMS[Math.abs(areaId) % GEMS.length];
}
