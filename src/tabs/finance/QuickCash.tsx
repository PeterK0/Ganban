// Quick-add a cash expense (the phone's Finance screen): amount, category and an optional note,
// posted to the Cash account, which is made on first use.
import { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/gilt/Modal';
import * as fin from './api';
import { cashExpenseEntry, findCashAccount } from './cashExpense.pure';
import { parseMoney, todayIso } from './money.pure';
import { isLocked } from './reports.pure';
import { MUTED, categories, errText, useFinance } from './shared';

export default function QuickCash({ onClose }: { onClose: () => void }) {
  const { entity, accounts, ledger, ledgerById, lockedThrough, locale, reload } = useFinance();
  const currency = entity.functional_currency;
  // A Cash account made by an earlier try whose entry failed, so a retry doesn't make another.
  const [made, setMade] = useState<fin.FinAccount | null>(null);
  const cash = findCashAccount(accounts, currency) ?? made;
  // Everyday spending: the expense categories, less the ones the app posts to itself (bank fees, FX).
  const expenses = useMemo(() => categories(ledger).filter((l) => l.class === 'expense' && !l.system_key), [ledger]);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const today = todayIso();
  const minor = parseMoney(amount, currency, locale);

  // Start on the category of the last cash expense, so a repeat is amount and Add.
  useEffect(() => {
    if (!cash) return;
    let live = true;
    fin.listEntries({ accountId: cash.id, status: 'posted' }, 1).then(
      (r) => {
        const last = r.entries[0]?.lines.find((l) => ledgerById.get(l.ledger_account_id)?.class === 'expense');
        if (live && last) setCategory((c) => c ?? last.ledger_account_id);
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cash?.id]);

  const chosen = category ?? expenses[0]?.id ?? null;
  const locked = isLocked(today, lockedThrough);
  const ok = minor != null && minor !== 0 && chosen != null && !locked && !busy;

  const add = async () => {
    if (!ok || chosen == null || minor == null) return;
    setBusy(true);
    setMsg(null);
    try {
      let account = cash;
      if (!account) {
        account = await fin.createAccount({ kind: 'cash', name: 'Cash', currency });
        setMade(account);
      }
      await fin.createEntry(
        cashExpenseEntry({ amountMinor: minor, categoryLedgerId: chosen, categoryName: ledgerById.get(chosen)?.name ?? 'Cash expense', cashLedgerId: account.ledger_account_id, currency, date: today, note }),
      );
      await reload();
      onClose();
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Cash expense" className="w-[min(440px,calc(100vw-24px))]">
      <form
        className="px-6 pt-3 pb-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="block">
          <span className={`text-xs ${MUTED}`}>Amount ({currency})</span>
          <input autoFocus className="g-field text-lg tabular-nums" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-invalid={amount !== '' && minor == null} />
        </label>
        <label className="block">
          <span className={`text-xs ${MUTED}`}>Category</span>
          <select className="g-field" value={chosen ?? ''} onChange={(e) => setCategory(Number(e.target.value))}>
            {expenses.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={`text-xs ${MUTED}`}>Note (optional)</span>
          <input className="g-field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it was for" />
        </label>
        <p className={`text-xs ${MUTED}`}>
          Today, from {cash ? cash.name : 'a new Cash account'}.
          {locked && ' This month is closed, so nothing can post to it.'}
        </p>
        {msg && <p className="text-sm text-error">{msg}</p>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" className="g-btn g-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="g-btn g-btn-gilt" disabled={!ok}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
