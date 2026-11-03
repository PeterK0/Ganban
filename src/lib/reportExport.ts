// Report renderers beyond markdown — HTML, XLSX, PDF — all fed by the SAME
// ReportDoc (reportGenerator.ts::buildReport), so no format can disagree with
// another about what's in the report. Pure functions here; the only side
// effect lives in exportReport() (the download), and the heavy libraries
// (pdfmake) load lazily on first use.
//
// Glyphs: markdown/HTML use ✓ / ⚠ / 📍 (every renderer's font fallback has
// them). The PDF is set in Roboto, which lacks them — it uses typography
// instead: strikethrough for a completed task, red for overdue, "at <place>".

import { zipSync, strToU8 } from 'fflate';
import {
  fmtDay,
  formatDuration,
  eventWhen,
  type ReportDoc,
  type DocGroup,
  type DocTask,
  type DocEvent,
} from './reportGenerator';

export type ExportFormat = 'md' | 'html' | 'xlsx' | 'pdf';

export const EXPORT_FORMATS: { key: ExportFormat; label: string; hint: string }[] = [
  { key: 'md', label: 'Markdown', hint: 'Paste into Obsidian, GitHub, Notion, chat' },
  { key: 'html', label: 'HTML', hint: 'Self-contained page — email it, open anywhere' },
  { key: 'pdf', label: 'PDF', hint: 'Print-ready A4 with page numbers' },
  { key: 'xlsx', label: 'Excel', hint: 'One row per task — filter, sort, pivot' },
];

/** "Weekly report — 7–13 Sept 2026" → "Weekly report - 7-13 Sept 2026.pdf" */
export function exportFileName(doc: ReportDoc, format: ExportFormat): string {
  const base = doc.title.replace(/[—–]/g, '-').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return `${base}.${format}`;
}

// ---------------------------------------------------------------------------
// Shared: walk every task in document order (renderers must never re-derive order)
// ---------------------------------------------------------------------------

function* walkTasks(groups: DocGroup[]): Generator<DocTask> {
  for (const g of groups) {
    if (g.children) yield* walkTasks(g.children);
    else for (const t of g.tasks ?? []) yield t;
  }
}

// ---------------------------------------------------------------------------
// HTML — a self-contained document with its own (print-friendly) stylesheet
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const HTML_CSS = `
:root { color-scheme: light; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2328; max-width: 52em; margin: 2.5em auto; padding: 0 1.5em; }
h1 { font-size: 1.7em; margin: 0 0 .2em; }
h2 { font-size: 1.25em; margin: 1.6em 0 .4em; padding-bottom: .2em; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 1.05em; margin: 1.1em 0 .3em; }
h4 { font-size: .95em; margin: .8em 0 .2em; color: #57606a; text-transform: uppercase; letter-spacing: .04em; }
.summary { color: #57606a; margin: 0 0 1em; font-size: .92em; }
ul { padding-left: 1.3em; margin: .2em 0 .6em; }
li { margin: .18em 0; }
.t { font-weight: 600; }
.done .t { text-decoration: line-through; color: #57606a; font-weight: 500; }
.meta { color: #57606a; }
.overdue { color: #cf222e; font-weight: 600; }
.empty { color: #57606a; font-style: italic; }
@media print { body { margin: 0; max-width: none; font-size: 11pt; } h2 { break-after: avoid; } li { break-inside: avoid; } }
`.trim();

function taskHtml(t: DocTask, year: number): string {
  const head = `${t.mark ? '✓ ' : ''}${t.prefix ? `[${escapeHtml(t.prefix)}] ` : ''}<span class="t">${escapeHtml(t.title)}</span>`;
  const tail: string[] = [];
  if (t.description) tail.push(escapeHtml(t.description));
  if (t.assignees.length) tail.push(`<span class="meta">${escapeHtml(t.assignees.join(', '))}</span>`);
  if (t.due) {
    tail.push(
      t.overdue
        ? `<span class="overdue">⚠ overdue ${escapeHtml(fmtDay(t.due, year))}</span>`
        : `<span class="meta">due ${escapeHtml(fmtDay(t.due, year))}</span>`
    );
  }
  if (t.showCompleted && t.completedAt) tail.push(`<span class="meta">done ${escapeHtml(fmtDay(t.completedAt, year))}</span>`);
  if (t.trackedSeconds > 0) tail.push(`<span class="meta">${formatDuration(t.trackedSeconds)}</span>`);
  return `<li${t.mark ? ' class="done"' : ''}>${head}${tail.length ? ` — ${tail.join(' · ')}` : ''}</li>`;
}

function eventHtml(e: DocEvent, year: number): string {
  return `<li><span class="meta">${escapeHtml(eventWhen(e, year))}</span> — <span class="t">${escapeHtml(e.title)}</span>${
    e.location ? ` 📍 ${escapeHtml(e.location)}` : ''
  }${e.description ? ` · ${escapeHtml(e.description)}` : ''}</li>`;
}

function groupsHtml(groups: DocGroup[], year: number, out: string[]): void {
  for (const g of groups) {
    if (g.label) out.push(`<h${g.depth}>${escapeHtml(g.label)}</h${g.depth}>`);
    if (g.children) groupsHtml(g.children, year, out);
    else out.push(`<ul>${(g.tasks ?? []).map((t) => taskHtml(t, year)).join('')}</ul>`);
  }
}

export function toHtml(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(`<h1>${escapeHtml(doc.title)}</h1>`);
  out.push(`<p class="summary">${escapeHtml(doc.summary.join(' · '))}</p>`);
  for (const sec of doc.eventSections) {
    out.push(`<h2>${escapeHtml(sec.heading)}</h2>`);
    out.push(`<ul>${sec.events.map((e) => eventHtml(e, doc.year)).join('')}</ul>`);
  }
  for (const p of doc.projects) {
    out.push(`<h2>${escapeHtml(p.name)}</h2>`);
    groupsHtml(p.groups, doc.year, out);
  }
  if (doc.empty) out.push(`<p class="empty">No tasks in this period.</p>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// XLSX — written directly (a zip of small XML parts). One row per task, real
// date cells, durations as Excel time so they sum, bold frozen header,
// autofilter. Inline strings, so no sharedStrings part is needed.
// ---------------------------------------------------------------------------

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Escape for XML text/attributes and drop the control chars XML 1.0 forbids. */
function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

/** Excel serial date (1900 system): days since 1899-12-30, local calendar day. */
function excelDate(d: Date): number {
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function colRef(i: number): string {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

export type Cell =
  | { kind: 'str'; v: string }
  | { kind: 'num'; v: number }
  | { kind: 'date'; v: Date }
  | { kind: 'duration'; seconds: number }
  | { kind: 'empty' };

const STYLE = { default: 0, header: 1, date: 2, duration: 3, wrap: 4 } as const;

function cellXml(ref: string, c: Cell, header = false): string {
  if (header) return `<c r="${ref}" s="${STYLE.header}" t="inlineStr"><is><t>${xml((c as { v: string }).v)}</t></is></c>`;
  switch (c.kind) {
    case 'empty':
      return '';
    case 'str': {
      const pad = /^\s|\s$/.test(c.v) ? ' xml:space="preserve"' : '';
      const style = c.v.includes('\n') ? ` s="${STYLE.wrap}"` : '';
      return `<c r="${ref}"${style} t="inlineStr"><is><t${pad}>${xml(c.v)}</t></is></c>`;
    }
    case 'num':
      return `<c r="${ref}"><v>${c.v}</v></c>`;
    case 'date':
      return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(c.v)}</v></c>`;
    case 'duration':
      return `<c r="${ref}" s="${STYLE.duration}"><v>${c.seconds / 86_400}</v></c>`;
  }
}

export interface Sheet {
  name: string;
  columns: { header: string; width: number }[];
  rows: Cell[][];
}

function sheetXml(sh: Sheet): string {
  const lastCol = colRef(sh.columns.length - 1);
  const rows: string[] = [];
  rows.push(
    `<row r="1">${sh.columns.map((c, i) => cellXml(`${colRef(i)}1`, { kind: 'str', v: c.header }, true)).join('')}</row>`
  );
  sh.rows.forEach((r, ri) => {
    const n = ri + 2;
    rows.push(`<row r="${n}">${r.map((c, ci) => cellXml(`${colRef(ci)}${n}`, c)).join('')}</row>`);
  });
  const cols = sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${sh.rows.length + 1}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A1:${lastCol}${Math.max(sh.rows.length + 1, 1)}"/>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="ddd d mmm yyyy"/><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookParts(sheets: Sheet[]): Record<string, Uint8Array> {
  const parts: Record<string, string> = {};
  parts['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;
  parts['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  parts['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;
  parts['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  parts['xl/styles.xml'] = STYLES_XML;
  sheets.forEach((s, i) => (parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s)));
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]));
}

const str = (v: string | undefined | null): Cell => (v ? { kind: 'str', v } : { kind: 'empty' });

/** The workbook's sheets — exported so tests can assert the table without unzipping. */
export function xlsxSheets(doc: ReportDoc): Sheet[] {
  const tasks: DocTask[] = [];
  for (const p of doc.projects) tasks.push(...walkTasks(p.groups));
  const any = (f: (t: DocTask) => boolean) => tasks.some(f);
  const withDesc = any((t) => !!t.description);
  const withWho = any((t) => t.assignees.length > 0);
  const withTime = any((t) => t.trackedSeconds > 0);

  const columns = [
    { header: 'Project', width: 22 },
    { header: 'Area', width: 16 },
    { header: 'Status', width: 12 },
    { header: 'Task', width: 44 },
    ...(withDesc ? [{ header: 'Description', width: 60 }] : []),
    ...(withWho ? [{ header: 'Assignees', width: 20 }] : []),
    { header: 'Due', width: 16 },
    { header: 'Completed', width: 16 },
    ...(withTime ? [{ header: 'Tracked', width: 10 }] : []),
    { header: 'Priority', width: 10 },
  ];
  const rows: Cell[][] = tasks.map((t) => [
    str(t.project),
    str(t.area),
    str(t.status),
    str(`${t.prefix ? `[${t.prefix}] ` : ''}${t.title}`),
    ...(withDesc ? [str(t.description)] : []),
    ...(withWho ? [str(t.assignees.join(', '))] : []),
    t.due ? { kind: 'date', v: t.due } : { kind: 'empty' },
    t.completedAt ? { kind: 'date', v: t.completedAt } : { kind: 'empty' },
    ...(withTime ? [t.trackedSeconds > 0 ? ({ kind: 'duration', seconds: t.trackedSeconds } as Cell) : ({ kind: 'empty' } as Cell)] : []),
    str(t.priority),
  ]);
  const sheets: Sheet[] = [{ name: 'Tasks', columns, rows }];

  const events = doc.eventSections.flatMap((s) => s.events.map((e) => ({ section: s.heading, e })));
  if (events.length) {
    sheets.push({
      name: 'Events',
      columns: [
        { header: 'Date', width: 16 },
        { header: 'Time', width: 9 },
        { header: 'Event', width: 40 },
        { header: 'Location', width: 22 },
        { header: 'Description', width: 50 },
        { header: 'Section', width: 26 },
      ],
      rows: events.map(({ section, e }) => [
        { kind: 'date', v: e.date },
        str(e.allDay ? 'all day' : e.time),
        str(e.title),
        str(e.location),
        str(e.description),
        str(section.replace(/ — .*$/, '')), // "Coming up — 14–20 Sept 2026" → "Coming up"
      ]),
    });
  }
  return sheets;
}

export function toXlsx(doc: ReportDoc): Uint8Array {
  return zipSync(workbookParts(xlsxSheets(doc)), { level: 6 });
}

// ---------------------------------------------------------------------------
// PDF — a pdfmake document definition (pure), rendered lazily
// ---------------------------------------------------------------------------

const GREY = '#6b7280';
const RED = '#b91c1c';

// pdfmake's content type is permissive; a local alias keeps this file honest
// without importing the (large) type package.
type PdfNode = Record<string, unknown> | string | Array<Record<string, unknown> | string>;

function taskPdf(t: DocTask, year: number): PdfNode {
  const parts: Record<string, unknown>[] = [];
  parts.push({
    text: `${t.prefix ? `[${t.prefix}] ` : ''}${t.title}`,
    bold: !t.mark,
    ...(t.mark ? { decoration: 'lineThrough', color: GREY } : {}),
  });
  const tail: Record<string, unknown>[] = [];
  if (t.description) tail.push({ text: t.description });
  if (t.assignees.length) tail.push({ text: t.assignees.join(', '), color: GREY });
  if (t.due) tail.push(t.overdue ? { text: `overdue ${fmtDay(t.due, year)}`, color: RED, bold: true } : { text: `due ${fmtDay(t.due, year)}`, color: GREY });
  if (t.showCompleted && t.completedAt) tail.push({ text: `done ${fmtDay(t.completedAt, year)}`, color: GREY });
  if (t.trackedSeconds > 0) tail.push({ text: formatDuration(t.trackedSeconds), color: GREY });
  if (tail.length) {
    parts.push({ text: ' — ' });
    tail.forEach((p, i) => {
      if (i) parts.push({ text: ' · ', color: GREY });
      parts.push(p);
    });
  }
  return { text: parts, margin: [0, 1, 0, 1] };
}

function eventPdf(e: DocEvent, year: number): PdfNode {
  const parts: Record<string, unknown>[] = [{ text: eventWhen(e, year), color: GREY }, { text: ' — ' }, { text: e.title, bold: true }];
  if (e.location) parts.push({ text: ` at ${e.location}`, color: GREY });
  if (e.description) parts.push({ text: ' · ', color: GREY }, { text: e.description });
  return { text: parts, margin: [0, 1, 0, 1] };
}

function groupsPdf(groups: DocGroup[], year: number, out: PdfNode[]): void {
  for (const g of groups) {
    if (g.label) out.push({ text: g.label, style: g.depth === 3 ? 'h3' : 'h4' });
    if (g.children) groupsPdf(g.children, year, out);
    else out.push({ ul: (g.tasks ?? []).map((t) => taskPdf(t, year)), margin: [0, 0, 0, 6] });
  }
}

/** The document definition — pure and inspectable; pdfmake renders it. */
export function toPdfDefinition(doc: ReportDoc): Record<string, unknown> {
  const content: PdfNode[] = [];
  content.push({ text: doc.title, style: 'h1' });
  content.push({ text: doc.summary.join(' · '), style: 'summary' });
  for (const sec of doc.eventSections) {
    content.push({ text: sec.heading, style: 'h2' });
    content.push({ ul: sec.events.map((e) => eventPdf(e, doc.year)), margin: [0, 0, 0, 6] });
  }
  for (const p of doc.projects) {
    content.push({ text: p.name, style: 'h2' });
    groupsPdf(p.groups, doc.year, content);
  }
  if (doc.empty) content.push({ text: 'No tasks in this period.', italics: true, color: GREY });

  return {
    info: { title: doc.title, creator: 'Ganban' },
    pageSize: 'A4',
    pageMargins: [50, 56, 50, 60],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 20, bold: true, margin: [0, 0, 0, 2] },
      summary: { fontSize: 9, color: GREY, margin: [0, 0, 0, 14] },
      h2: { fontSize: 14, bold: true, margin: [0, 14, 0, 6] },
      h3: { fontSize: 11.5, bold: true, margin: [0, 8, 0, 3] },
      h4: { fontSize: 9.5, bold: true, color: GREY, margin: [0, 6, 0, 2], characterSpacing: 0.4 },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: doc.title, fontSize: 8, color: GREY },
        { text: `${page} / ${pages}`, alignment: 'right', fontSize: 8, color: GREY },
      ],
      margin: [50, 20, 50, 0],
    }),
    content,
  };
}

export async function renderPdf(doc: ReportDoc): Promise<Blob> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMake.addVirtualFileSystem(vfs);
  return pdfMake.createPdf(toPdfDefinition(doc)).getBlob();
}

// ---------------------------------------------------------------------------
// The one side effect
// ---------------------------------------------------------------------------

export async function exportBlob(doc: ReportDoc, markdown: string, format: ExportFormat): Promise<Blob> {
  switch (format) {
    case 'md':
      return new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    case 'html':
      return new Blob([toHtml(doc)], { type: 'text/html;charset=utf-8' });
    case 'xlsx':
      return new Blob([toXlsx(doc) as BlobPart], { type: XLSX_MIME });
    case 'pdf':
      return renderPdf(doc);
  }
}
