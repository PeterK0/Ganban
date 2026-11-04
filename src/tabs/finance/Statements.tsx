// Statements: financial position, profit or loss with OCI, cash flows (IAS 7, direct) and changes in
// net worth, for a month or a year with the previous one beside it. CSV comes from the host; the PDF
// is drawn here with pdfmake, as the report generator draws its PDFs.
import { useEffect, useMemo, useState } from 'react';
import { downloadBlob } from '../../lib/daemon';
import * as fin from './api';
import { todayIso } from './money.pure';
import { StatementTable } from './reportParts';
import { formatMonth, fromHostRows, monthOf, statementFileName, statementPdf } from './reports.pure';
import { MUTED, errText, useFinance } from './shared';

const KINDS: { id: fin.StatementKind; label: string; note: string }[] = [
  { id: 'position', label: 'Financial position', note: 'What you own and owe at the end of the period, and the net worth between them.' },
  { id: 'profit_loss', label: 'Profit or loss', note: 'Income and expenses by nature, counted in the month they belong to, then other comprehensive income.' },
  { id: 'cash_flow', label: 'Cash flows', note: 'Money in and out of cash, by the date it moved: operating, investing and financing.' },
  { id: 'equity', label: 'Changes in net worth', note: 'How net worth moved from the start of the period to its end.' },
];

const CHECK_LABEL: Record<string, string> = { balanced: 'Assets equal liabilities plus net worth', reconciles: 'Opening cash plus the movements equals closing cash' };

/** A host period (`YYYY-MM` or `YYYY`) in words. */
const periodWords = (p: string, locale?: string) => (/^\d{4}-\d{2}$/.test(p) ? formatMonth(p, locale) : p);

export default function Statements() {
  const { entity, locale } = useFinance();
  const today = todayIso();
  const [kind, setKind] = useState<fin.StatementKind>('position');
  const [yearly, setYearly] = useState(false);
  const [month, setMonth] = useState(monthOf(today));
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [comparatives, setComparatives] = useState(true);
  const [hideZero, setHideZero] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [st, setSt] = useState<fin.Statement | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const period = yearly ? String(year) : month;

  useEffect(() => {
    if (!/^\d{4}(-\d{2})?$/.test(period)) return;
    let live = true;
    fin.statement(kind, period, comparatives).then(
      (r) => live && (setSt(r), setMsg(null)),
      (e) => live && (setSt(null), setMsg(errText(e))),
    );
    return () => {
      live = false;
    };
  }, [kind, period, comparatives]);

  const comp = !!st?.comparative && comparatives;
  // The table may still show the previous choice while the next loads; export only what's shown.
  const current = !!st && st.kind === kind && st.period === period;
  const rows = useMemo(() => (st ? fromHostRows(st.rows, { collapsed, hideZero, comparative: comp }) : []), [st, collapsed, hideZero, comp]);
  const columns = st ? [periodWords(st.period, locale), ...(comp && st.comparative ? [periodWords(st.comparative.period, locale)] : [])] : [];
  const meta = KINDS.find((k) => k.id === kind)!;
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const exportCsv = async () => {
    setExporting('csv');
    try {
      const r = await fin.statementCsv(kind, period, comparatives);
      downloadBlob(r.file_name, new Blob([r.content], { type: 'text/csv;charset=utf-8' }));
      setMsg(null);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setExporting(null);
    }
  };
  const exportPdf = async () => {
    if (!st) return;
    setExporting('pdf');
    try {
      // Every row, unfolded: a document shouldn't depend on what's folded on screen.
      const all = fromHostRows(st.rows, { hideZero, comparative: comp });
      const def = statementPdf({ title: meta.label, entity: `${entity.name} · ${columns[0] ?? period}`, currency: st.currency, columns, rows: all, notes: [meta.note], generated: today }, locale);
      const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
      pdfMake.addVirtualFileSystem(vfs);
      downloadBlob(statementFileName(meta.label, columns[0] ?? period, 'pdf'), await pdfMake.createPdf(def).getBlob());
      setMsg(null);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setExporting(null);
    }
  };

  const years = Array.from({ length: 8 }, (_, i) => Number(today.slice(0, 4)) - i);
  const checks = Object.entries(st?.checks ?? {}).filter(([, v]) => typeof v === 'boolean') as [string, boolean][];

  return (
    <div className="space-y-4">
      <div className="g-seg flex-wrap" role="tablist" aria-label="Statement">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className="g-chip" onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="g-seg" role="radiogroup" aria-label="Period length">
          <button role="radio" aria-checked={!yearly} aria-pressed={!yearly} className="g-chip" onClick={() => setYearly(false)}>
            Monthly
          </button>
          <button role="radio" aria-checked={yearly} aria-pressed={yearly} className="g-chip" onClick={() => setYearly(true)}>
            Yearly
          </button>
        </div>
        {yearly ? (
          <select className="g-field g-field-sm !w-[110px]" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        ) : (
          <input type="month" className="g-field g-field-sm !w-[170px]" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
        )}
        <label className={`flex items-center gap-2 text-sm ${MUTED}`}>
          <input type="checkbox" checked={comparatives} onChange={(e) => setComparatives(e.target.checked)} /> Compare with the {yearly ? 'year' : 'month'} before
        </label>
        <label className={`flex items-center gap-2 text-sm ${MUTED}`}>
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} /> Hide empty lines
        </label>
        <span className="flex gap-2 ml-auto">
          <button className="g-btn g-btn-ghost g-btn-sm" disabled={!current || !!exporting} onClick={() => void exportCsv()}>
            {exporting === 'csv' ? 'Exporting…' : 'CSV'}
          </button>
          <button className="g-btn g-btn-ghost g-btn-sm" disabled={!current || !!exporting} onClick={() => void exportPdf()}>
            {exporting === 'pdf' ? 'Exporting…' : 'PDF'}
          </button>
        </span>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {st && (
        <div className="g-card p-4 sm:p-5 space-y-3 max-w-[960px]">
          <div>
            <div className="g-stitle">{meta.label}</div>
            <p className={`text-sm ${MUTED}`}>
              {meta.note} In {st.currency}.
            </p>
          </div>
          <StatementTable columns={columns} rows={rows} currency={st.currency} onToggle={toggle} caption={meta.label} />
          {checks.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {checks.map(([k, ok]) => (
                <span key={k} className={`g-tag ${ok ? 'g-tag-ok' : 'g-tag-red'}`}>
                  {ok ? '' : 'Not: '}
                  {CHECK_LABEL[k] ?? k.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
