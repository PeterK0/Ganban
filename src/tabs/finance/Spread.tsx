// "Spread over months": a recognition schedule on an entry. One income or expense line is spread
// evenly over N months, through Prepayments or Deferred income when it's paid ahead, or Accrued
// expenses or Receivables when it's caught up later. Profit or loss and budgets then count a share
// each month; cash flow still sees the payment on its date.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/gilt';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { formatDate } from './money.pure';
import { formatMonth, isLocked, monthOf, scheduleKind, spreadPreview } from './reports.pure';
import { MUTED, Money, errText, isUncategorised, useFinance } from './shared';

export default function SpreadDialog({ entry, onClose, onDone }: { entry: fin.Entry; onClose: () => void; onDone: () => void }) {
  const { ledgerById, entity, locale, lockedThrough } = useFinance();
  const fun = entity.functional_currency;
  const candidates = useMemo(
    () => entry.lines.filter((l) => {
      const la = ledgerById.get(l.ledger_account_id);
      return !!la && (la.class === 'income' || la.class === 'expense') && !isUncategorised(la);
    }),
    [entry, ledgerById],
  );
  const [lineId, setLineId] = useState<number | null>(candidates[0]?.id ?? null);
  const [start, setStart] = useState(monthOf(entry.date));
  const [months, setMonths] = useState('12');
  const [existing, setExisting] = useState<fin.Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fin.listSchedules(entry.id).then(setExisting, () => setExisting([]));
  }, [entry.id]);

  const line = candidates.find((l) => l.id === lineId) ?? null;
  const la = line ? ledgerById.get(line.ledger_account_id) : undefined;
  const n = Number(months);
  const nOk = Number.isInteger(n) && n >= 2 && n <= 120;
  const preview = line && nOk && /^\d{4}-\d{2}$/.test(start) ? spreadPreview(line.functional_minor, n, start) : [];
  const kind = scheduleKind(entry.date, start);
  const via = la?.class === 'income' ? (kind === 'prepaid' ? 'Deferred income' : 'Receivables') : kind === 'prepaid' ? 'Prepayments' : 'Accrued expenses';
  const taken = new Set(existing.map((s) => s.ledger_account_id));
  const startLocked = isLocked(`${start}-01`, lockedThrough);
  const ok = !!line && nOk && preview.length > 0 && !startLocked && !taken.has(line.ledger_account_id) && !busy;

  const save = async () => {
    if (!ok || !line) return;
    setBusy(true);
    setMsg(null);
    try {
      await fin.createSchedule({ entryId: entry.id, ledgerAccountId: candidates.length > 1 ? line.ledger_account_id : undefined, startMonth: start, months: n });
      onDone();
      onClose();
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };
  const remove = async (s: fin.Schedule) => {
    if (!(await confirmDialog('Remove this spread? The entry counts in full in its own month again.'))) return;
    try {
      await fin.deleteSchedule(s.id);
      setExisting((l) => l.filter((x) => x.id !== s.id));
      onDone();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <Modal onClose={onClose} title="Spread over months" className="w-[min(560px,calc(100vw-32px))]">
      <form
        className="px-6 pt-1 pb-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className={`text-sm ${MUTED}`}>
          {entry.payee || entry.description} · {formatDate(entry.date, locale)}. Your budgets and profit or loss count a share each month; cash flow still shows the payment on its date.
        </p>
        {existing.length > 0 && (
          <div className="g-inset p-3 space-y-2">
            <div className="g-cap">Already spread</div>
            {existing.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate">
                  {ledgerById.get(s.ledger_account_id)?.name}: {s.months} months from {formatMonth(s.start_month, locale)}
                  <span className={MUTED}> · {s.rows.filter((r) => r.released).length} released</span>
                </span>
                {!s.rows.some((r) => r.released) && (
                  <button type="button" className="g-lnk text-xs" onClick={() => void remove(s)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {candidates.length === 0 ? (
          <p className="text-sm text-subtext-1">Only an entry with an income or expense category can be spread. Categorise it first.</p>
        ) : (
          <>
            {candidates.length > 1 && (
              <label className="block">
                <span className="g-flbl">Category to spread</span>
                <select className="g-field" value={lineId ?? ''} onChange={(e) => setLineId(Number(e.target.value))}>
                  {candidates.map((l) => (
                    <option key={l.id} value={l.id}>
                      {ledgerById.get(l.ledger_account_id)?.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="g-flbl">From</span>
                <input type="month" className="g-field" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
              </label>
              <label className="block">
                <span className="g-flbl">Months</span>
                <input type="number" min={2} max={120} className="g-field tabular-nums" value={months} onChange={(e) => setMonths(e.target.value)} aria-invalid={!nOk} />
              </label>
            </div>
            {startLocked && <p className="text-sm text-warning">{formatMonth(start, locale)} is closed: start the spread in an open month.</p>}
            {line && taken.has(line.ledger_account_id) && <p className="text-sm text-warning">This category is already spread; remove that spread first.</p>}
            {preview.length > 0 && la && (
              <div className="space-y-2">
                <p className="text-sm text-subtext-1">
                  <Money minor={Math.abs(line!.functional_minor)} currency={fun} /> of {la.name} {kind === 'prepaid' ? 'paid ahead' : 'caught up'}: it sits in {via} and moves to {la.name} at{' '}
                  <Money minor={Math.abs(preview[0].amount)} currency={fun} /> a month as each month closes.
                </p>
                <div className="g-inset p-3 grid gap-x-4 gap-y-1 text-xs tabular-nums" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                  {preview.map((p) => (
                    <span key={p.month} className="flex justify-between gap-2">
                      <span className={MUTED}>{formatMonth(p.month, locale, 'short')}</span>
                      <Money minor={Math.abs(p.amount)} currency={fun} />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {msg && <p className="text-sm text-error">{msg}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="g-btn g-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {candidates.length > 0 && (
            <button type="submit" className="g-btn g-btn-pri" disabled={!ok}>
              {busy ? 'Spreading…' : 'Spread'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
