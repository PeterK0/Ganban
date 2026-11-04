// Pure rules behind the comment and update composer (MarkdownField,
// TaskTagPicker): how tall the text field is, and when the tag picker offers to
// create a task. Tested by scripts/test-composer.mjs.

/** Width (px) from which the composer puts its preview beside the text. */
export const SIDE_BY_SIDE_MIN = 720;
/** The field auto-grows up to this share of the viewport, then scrolls. */
export const AUTO_MAX_SHARE = 0.6;
/** A dragged height stays within these bounds. */
export const DRAG_MIN = 72;
export const DRAG_MAX_SHARE = 0.85;

/**
 * The text field's height. `content` is what the text needs (its scrollHeight
 * at the floor), `floor` the height of the default rows, `manual` a height the
 * user dragged (it replaces the floor and can lift the cap), `viewport` the
 * window's inner height.
 */
export function fieldHeight({
  content,
  floor,
  manual,
  viewport,
}: {
  content: number;
  floor: number;
  manual: number | null;
  viewport: number;
}): number {
  const base = manual ?? floor;
  const cap = Math.max(Math.round(viewport * AUTO_MAX_SHARE), base);
  return Math.round(Math.min(Math.max(content, base), cap));
}

/** A dragged height, kept within bounds. */
export function clampDrag(height: number, viewport: number): number {
  const max = Math.max(DRAG_MIN, Math.round(viewport * DRAG_MAX_SHARE));
  return Math.round(Math.min(Math.max(height, DRAG_MIN), max));
}

/** Read a remembered height (null when unset or garbage). */
export function parseHeight(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= DRAG_MIN ? Math.round(n) : null;
}

/**
 * The title the tag picker offers to create a task with, or null. Offered when
 * the search isn't empty and no task is already called exactly that (ignoring
 * case and surrounding spaces).
 */
export function createCandidate(query: string, titles: string[]): string | null {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const key = q.toLowerCase();
  return titles.some((t) => t.trim().replace(/\s+/g, ' ').toLowerCase() === key) ? null : q;
}

/** The tag picker's "Create task": create it, then add it to the tags as they are by
 * then (`current`, read after the await). A refusal tags nothing and gives back the
 * host's message for the picker to show. */
export async function createAndTag(
  create: (title: string) => Promise<{ id: number }>,
  title: string,
  current: () => number[]
): Promise<{ tags: number[] } | { error: string }> {
  try {
    const task = await create(title);
    const now = current();
    return { tags: now.includes(task.id) ? now : [...now, task.id] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Move a highlighted row by `delta`, wrapping; -1 when there are no rows. */
export function moveCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const from = cursor < 0 ? (delta > 0 ? -1 : 0) : cursor;
  return (((from + delta) % count) + count) % count;
}
