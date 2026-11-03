import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/ganban-report-tests', { recursive: true });
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as R from '../../.test-build/rg.mjs';
import * as X from '../../.test-build/rx.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));

let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; } };
const D = (y, m, d) => new Date(y, m - 1, d);
const TODAY = D(2026, 9, 9);

// Fixture with a hostile title (escaping), a multi-line description, assignees, dates, time
const projects = [{ id: 1, name: 'Alpha & Co' }, { id: 2, name: 'Beta' }];
const areas = [{ id: 10, project_id: 1, name: 'Research' }, { id: 11, project_id: 1, name: 'Build' }];
const task = (o) => ({ project_id: 1, priority: 'Medium', archived: false, created_at: '2026-09-08T10:00:00Z', updated_at: '2026-09-08T10:00:00Z', ...o });
const tasks = [
  task({ id: 1, area_id: 10, title: 'Read <script>alert(1)</script> spec', status: 'In Progress', deadline: '2026-09-12', description: 'Chapter 3\n& appendix' }),
  task({ id: 2, area_id: 10, title: 'Survey OCR', status: 'Done', completed_at: '2026-09-08T15:00:00Z' }),
  task({ id: 3, area_id: 11, title: 'Wire parser', status: 'To Do', deadline: '2026-09-01', priority: 'High' }),
  task({ id: 6, project_id: 2, title: 'Beta task', status: 'To Do' }),
];
const events = [{ id: 1, title: 'Supervisor', event_date: '2026-09-09', start_time: '14:00', all_day: false, location: 'Room 3' }, { id: 2, title: 'Conf', event_date: '2026-09-16', all_day: true }];
const cfg = { projects: [1, 2], startDate: '2026-09-07', endDate: '2026-09-13', statuses: ['To Do','In Progress','Blocked','Done'], grouping: 'area-status', verbose: true, includeTime: true, includeAssignees: true, includeEvents: true, userName: 'Scott' };
const doc = R.buildReport(cfg, tasks, projects, { 1: 600, 2: 4800 }, events, areas, TODAY, { 1: ['Nikolai'], 3: ['Scott', 'Misha'] });

// --- filename ---------------------------------------------------------------------
t('filename from title, filesystem-safe', () => assert.match(X.exportFileName(doc, 'pdf'), /^Weekly report - 7-13 Sept? 2026\.pdf$/));

// --- HTML ---------------------------------------------------------------------------
const html = X.toHtml(doc);
t('html: standalone document with title and stylesheet', () => {
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<title>Weekly report — 7–13 Sept? 2026<\/title>/);
  assert.ok(html.includes('<style>'));
});
t('html: user text is ESCAPED (no script injection through a task title)', () => {
  assert.ok(!html.includes('<script>'), 'raw <script> leaked');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Alpha &amp; Co'));
  assert.ok(html.includes('Chapter 3 &amp; appendix'), 'description collapsed to one line and escaped');
});
t('html: heading structure mirrors the markdown (h2 project, h3 area, h4 status)', () => {
  const hs = [...html.matchAll(/<h([234])>([^<]*)<\/h\1>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(hs.filter(h => !h.startsWith('2:Events') && !h.startsWith('2:Coming')), ['2:Alpha &amp; Co', '3:Research', '4:In Progress', '4:Done', '3:Build', '4:To Do', '2:Beta', '3:No area', '4:To Do']);
});
t('html: overdue is flagged, done under a non-Done heading is struck through', () => {
  assert.match(html, /<span class="overdue">⚠ overdue Tue 1 Sept?<\/span>/);
  // Survey OCR sits under "#### Done" → not marked; force a no-status grouping to see the mark
  const flat = X.toHtml(R.buildReport({ ...cfg, grouping: 'none' }, tasks, projects, {}, [], areas, TODAY));
  assert.match(flat, /<li class="done">✓ <span class="t">Survey OCR<\/span>/);
});
t('html: assignees + tracked time on the line', () => assert.match(html, /Nikolai<\/span> · <span class="meta">due Sat 12 Sept?<\/span> · <span class="meta">10m<\/span>/));

// --- XLSX ---------------------------------------------------------------------------
const sheets = X.xlsxSheets(doc);
t('xlsx: Tasks sheet has one row per task in DOCUMENT order, optional columns present only when used', () => {
  const s = sheets[0];
  assert.equal(s.name, 'Tasks');
  assert.deepEqual(s.columns.map((c) => c.header), ['Project','Area','Status','Task','Description','Assignees','Due','Completed','Tracked','Priority']);
  assert.deepEqual(s.rows.map((r) => r[3].v), ['Read <script>alert(1)</script> spec', 'Survey OCR', 'Wire parser', 'Beta task']);
  assert.equal(s.rows[0][6].kind, 'date'); assert.equal(s.rows[1][7].kind, 'date'); assert.equal(s.rows[1][8].kind, 'duration');
});
t('xlsx: Events sheet with section labels stripped of their date range', () => {
  assert.equal(sheets[1].name, 'Events');
  assert.deepEqual(sheets[1].rows.map((r) => r[5].v), ['Events', 'Coming up']);
});
t('xlsx: no Description/Assignees columns when the config excludes them', () => {
  const lean = X.xlsxSheets(R.buildReport({ ...cfg, verbose: false, includeAssignees: false, includeTime: false }, tasks, projects, {}, [], areas, TODAY));
  assert.deepEqual(lean[0].columns.map((c) => c.header), ['Project','Area','Status','Task','Due','Completed','Priority']);
});
const xlsxBytes = X.toXlsx(doc);
writeFileSync('/tmp/ganban-report-tests/out.xlsx', xlsxBytes);
const have = (cmd) => { try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = (name, why) => console.log(`~ SKIPPED ${name} — ${why}`);
if (!have('uv')) skip('xlsx openpyxl round-trip', 'uv not on PATH'); else
t('xlsx: independent reader (openpyxl) opens it and agrees on cells, dates and durations', () => {
  const py = `
import openpyxl, datetime
wb = openpyxl.load_workbook('/tmp/ganban-report-tests/out.xlsx')
assert wb.sheetnames == ['Tasks', 'Events'], wb.sheetnames
ws = wb['Tasks']
hdr = [c.value for c in ws[1]]
assert hdr == ['Project','Area','Status','Task','Description','Assignees','Due','Completed','Tracked','Priority'], hdr
assert ws.max_row == 5, ws.max_row
r = [c.value for c in ws[2]]
assert r[0] == 'Alpha & Co' and r[1] == 'Research' and r[2] == 'In Progress', r
assert r[3] == 'Read <script>alert(1)</script> spec', r[3]
assert r[4] == 'Chapter 3 & appendix', r[4]
assert r[5] == 'Nikolai', r[5]
assert isinstance(r[6], datetime.datetime) and r[6].date() == datetime.date(2026, 9, 12), r[6]
assert r[6].is_date if hasattr(r[6], 'is_date') else True
tr = ws.cell(row=3, column=9)
assert tr.number_format == '[h]:mm', tr.number_format
assert isinstance(tr.value, (datetime.time, datetime.timedelta)), (type(tr.value), tr.value)
secs = tr.value.hour*3600 + tr.value.minute*60 if isinstance(tr.value, datetime.time) else tr.value.total_seconds()
assert secs == 4800, secs
assert ws['A1'].font.b, 'header not bold'
assert ws.freeze_panes == 'A2', ws.freeze_panes
assert ws.auto_filter.ref == 'A1:J5', ws.auto_filter.ref
assert ws.column_dimensions['D'].width == 44, ws.column_dimensions['D'].width
ev = wb['Events']
assert ev['A2'].value.date() == datetime.date(2026, 9, 9) and ev['B2'].value == '14:00' and ev['D2'].value == 'Room 3'
print('openpyxl OK: %d task rows, %d event rows' % (ws.max_row-1, ev.max_row-1))
`;
  writeFileSync('/tmp/ganban-report-tests/check_xlsx.py', py);
  const out = execSync('uv run --quiet --with openpyxl python3 /tmp/ganban-report-tests/check_xlsx.py', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /openpyxl OK: 4 task rows, 2 event rows/);
});

// --- PDF ------------------------------------------------------------------------------
const def = X.toPdfDefinition(doc);
t('pdf: definition is pure and carries the structure', () => {
  assert.equal(def.pageSize, 'A4');
  const texts = def.content.filter((c) => c.style).map((c) => `${c.style}:${c.text}`);
  assert.ok(texts.includes('h1:' + doc.title));
  assert.ok(texts.includes('h2:Alpha & Co') && texts.includes('h3:Research') && texts.includes('h4:In Progress'));
});
if (!have('pdftotext')) skip('pdf pdftotext round-trip', 'poppler (pdftotext/pdfinfo) not on PATH'); else
await ta('pdf: renders with pdfmake, independent reader (pdftotext/pdfinfo) agrees; no unrenderable glyphs', async () => {
  const pdfmake = require('pdfmake');
  const vfs = require('pdfmake/build/vfs_fonts');
  for (const k of Object.keys(vfs)) pdfmake.virtualfs.writeFileSync(k, vfs[k], 'base64');
  pdfmake.addFonts({ Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } });
  const buf = await pdfmake.createPdf(def).getBuffer();
  writeFileSync('/tmp/ganban-report-tests/out.pdf', buf);
  assert.ok(buf.subarray(0, 5).toString() === '%PDF-');
  const info = execSync('pdfinfo /tmp/ganban-report-tests/out.pdf', { encoding: 'utf8' });
  assert.match(info, /Pages:\s+1/); assert.match(info, /Title:\s+Weekly report/);
  const text = execSync('pdftotext -layout /tmp/ganban-report-tests/out.pdf -', { encoding: 'utf8' });
  assert.ok(text.includes('Weekly report'));
  assert.ok(text.includes('Read <script>alert(1)</script> spec'), 'title verbatim (PDF is not HTML — no escaping)');
  assert.ok(text.includes('overdue Tue 1 Sept'), 'overdue in words');
  assert.ok(text.includes('Scott, Misha'));
  assert.match(text, /1\s*\/\s*1/, 'page footer');
  assert.ok(!/[✓⚠📍]/.test(text), 'no glyphs Roboto cannot draw');
  assert.ok(text.includes('at Room 3'), 'location in words');
});

console.log(`${n} export assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
