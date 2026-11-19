/** Text insertion at the caret of a textarea, kept pure so it can be tested without a DOM. */

export interface Inserted {
  /** The whole new text. */
  value: string;
  /** Where the caret goes: right after the inserted text. */
  caret: number;
}

const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len));

/** Replace `value[start..end]` (the selection, or an empty range at the caret) with `text`. */
export function insertAt(value: string, start: number, end: number, text: string): Inserted {
  const s = clamp(start, value.length);
  const e = clamp(Math.max(end, s), value.length);
  return { value: value.slice(0, s) + text + value.slice(e), caret: s + text.length };
}

/** Like `insertAt`, but keep `text` on a line of its own: a newline is added before it unless the caret is at the
 * start of a line, and after it unless the caret is at the end of a line. Used for a pasted image, which reads best
 * as its own paragraph. The caret lands after `text`, before any added newline. */
export function insertLineAt(value: string, start: number, end: number, text: string): Inserted {
  const s = clamp(start, value.length);
  const e = clamp(Math.max(end, s), value.length);
  const before = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
  const after = e < value.length && value[e] !== '\n' ? '\n' : '';
  const ins = insertAt(value, s, e, before + text + after);
  return { value: ins.value, caret: s + before.length + text.length };
}
