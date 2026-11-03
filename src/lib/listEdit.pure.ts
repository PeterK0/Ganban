/**
 * Markdown list editing for comment fields: Tab / Shift+Tab indent and outdent
 * list items, and Enter continues a list. Pure: each function takes the text
 * and selection and returns the edited text and selection, or null when the
 * key should keep its usual job (Tab moves focus outside a list).
 *
 * One level is 4 spaces: deep enough to nest under `- `, `1. ` and `10. `
 * alike, and short of an indented code block under any of them.
 */

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

const INDENT = '    ';

/** indent, marker, spacing, optional task box, content. A marker needs the
 * space after it: a bare "2024." or "1)" is text, not an empty item. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\](?:\s+|$))?(.*)$/;

/** `---`, `* * *`, `_ _ _`: a horizontal rule, not a list. */
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;

const isListLine = (line: string) => LIST_ITEM.test(line) && !THEMATIC_BREAK.test(line);

/** Indent (`dir` 1) or outdent (-1) every line the selection touches, if all of
 * them are list items. */
export function indentLines(value: string, start: number, end: number, dir: 1 | -1): TextEdit | null {
  const first = value.lastIndexOf('\n', start - 1) + 1;
  // A selection ending at a line start doesn't take that line along.
  const lastEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nl = value.indexOf('\n', lastEnd);
  const last = nl === -1 ? value.length : nl;
  const lines = value.slice(first, last).split('\n');
  if (!lines.every(isListLine)) return null;

  const deltas: number[] = [];
  const edited = lines.map((line) => {
    if (dir === 1) {
      deltas.push(INDENT.length);
      return INDENT + line;
    }
    const lead = line.startsWith('\t') ? 1 : Math.min(INDENT.length, line.length - line.trimStart().length);
    deltas.push(-lead);
    return line.slice(lead);
  });
  const total = deltas.reduce((a, b) => a + b, 0);
  // The selection start moves with its line's text, never before the line.
  const newStart = start === first ? start : Math.max(first, start + deltas[0]);
  const newEnd = start === end ? newStart : Math.max(newStart, end + total);
  return { value: value.slice(0, first) + edited.join('\n') + value.slice(last), start: newStart, end: newEnd };
}

/** Enter on a list item: start the next item (same indent, next number, an
 * unchecked box), carrying any text after the caret. An empty item outdents a
 * level, or ends the list at the top level. */
export function continueList(value: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', start);
  const lineEnd = nl === -1 ? value.length : nl;
  const line = value.slice(lineStart, lineEnd);
  const m = isListLine(line) ? LIST_ITEM.exec(line) : null;
  if (!m) return null;
  const [, indent, marker, spacing, box = '', content] = m;
  const contentAt = lineStart + indent.length + marker.length + spacing.length + box.length;
  if (start < contentAt) return null;

  if (content.trim() === '') {
    const replaced = indent.length > 0 ? indentLines(value, start, end, -1)! : null;
    if (replaced) return replaced;
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), start: lineStart, end: lineStart };
  }

  const num = /^(\d+)([.)])$/.exec(marker);
  const nextMarker = num ? `${Number(num[1]) + 1}${num[2]}` : marker;
  const insert = `\n${indent}${nextMarker}${spacing}${box ? '[ ] ' : ''}`;
  const caret = start + insert.length;
  return { value: value.slice(0, start) + insert + value.slice(start), start: caret, end: caret };
}
