// Accounts: the user's bank, savings, card, cash and loan accounts. Create one with an opening balance
// (the host posts it against opening equity), and archive one that's closed.
import { useState } from 'react';
import { DecoHeading, Modal } from '../../components/gilt';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { parseMoney, todayIso } from './money.pure';
import { MUTED, Money, Empty, errText, useFinance } from './shared';

const KINDS: { id: fin.AccountKind; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'savings', label: 'Savings' },
  { id: 'card', label: 'Card' },
  { id: 'cash', label: 'Cash' },
  { id: 'loan', label: 'Loan' },
];

export default function Accounts() {
  const { accounts, reload, goto } = useFinance();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const shown = accounts.filter((a) => showArchived || !a.archived);

  const archive = async (a: fin.FinAccount) => {
    if (!(await confirmDialog(`Archive "${a.name}"? It leaves the lists and the import's choices; its history stays in the ledger.`))) return;
    try {
      await fin.archiveAccount(a.id);
      await reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button className="g-btn g-btn-pri" onClick={() => setCreating(true)}>
          New account
        </button>
        <label className={`ml-auto flex items-center gap-2 text-sm ${MUTED}`}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      <DecoHeading count={shown.length}>Accounts</DecoHeading>
      {shown.length === 0 ? (
        <Empty title="No accounts yet">Add your first one, or import a statement and let the import create them.</Empty>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {shown.map((a) => (
            <div key={a.id} className={`g-card p-5 space-y-2 ${a.archived ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-text font-medium truncate">{a.name}</div>
                  <div className={`text-xs ${MUTED} truncate`}>{[KINDS.find((k) => k.id === a.kind)?.label, a.institution, a.iban_mask].filter(Boolean).join(' · ')}</div>
                </div>
                {a.archived && <span className="g-tag">Archived</span>}
              </div>
              <Money minor={a.balance_minor} currency={a.currency} className="block text-2xl text-text" />
              <div className="flex gap-2 pt-1">
                <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => goto('transactions', { accountId: a.id })}>
                  Transactions
                </button>
                {!a.archived && (
                  <button className="g-btn g-btn-ghost g-btn-sm ml-auto" onClick={() => void archive(a)}>
                    Archive
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <NewAccount onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewAccount({ onClose }: { onClose: () => void }) {
  const { entity, reload, locale } = useFinance();
  const [kind, setKind] = useState<fin.AccountKind>('current');
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [currency, setCurrency] = useState(entity.functional_currency);
  const [ibanMask, setIbanMask] = useState('');
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cur = currency.trim().toUpperCase();
  const curOk = /^[A-Z]{3}$/.test(cur);
  const openingMinor = opening.trim() ? parseMoney(opening, curOk ? cur : 'EUR', locale) : 0;
  const canSave = name.trim() && curOk && openingMinor !== null && (!openingMinor || openingDate) && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setMsg(null);
    try {
      await fin.createAccount({
        kind,
        name: name.trim(),
        institution: institution.trim() || undefined,
        currency: cur,
        ibanMask: ibanMask.trim() || undefined,
        openingBalanceMinor: openingMinor || undefined,
        openingDate: openingMinor ? openingDate : undefined,
      });
      await reload();
      onClose();
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="New account" className="w-[min(520px,calc(100vw-32px))]">
      <form
        className="px-6 pt-1 pb-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <span className="g-flbl">Kind</span>
          <div className="g-seg" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} aria-pressed={kind === k.id} className="g-chip" onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          {(kind === 'card' || kind === 'loan') && <p className={`text-xs mt-1 ${MUTED}`}>A {kind} is money you owe: a balance you owe goes in as a negative number.</p>}
        </div>
        <label className="block">
          <span className="g-flbl">Name</span>
          <input className="g-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Everyday account" autoFocus />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="g-flbl">Bank</span>
            <input className="g-field" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Optional" />
          </label>
          <label className="block">
            <span className="g-flbl">Currency</span>
            <input className="g-field uppercase" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} aria-invalid={!curOk} />
          </label>
        </div>
        <label className="block">
          <span className="g-flbl">Account number (last digits)</span>
          <input className="g-field" value={ibanMask} onChange={(e) => setIbanMask(e.target.value)} placeholder="Optional, e.g. •••• 4821" />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="g-flbl">Opening balance</span>
            <input className="g-field tabular-nums" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" aria-invalid={openingMinor === null} />
          </label>
          <label className="block">
            <span className="g-flbl">On</span>
            <input type="date" className="g-field" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} disabled={!openingMinor} />
          </label>
        </div>
        {openingMinor === null && <p className="text-sm text-error">That isn't an amount in {curOk ? cur : 'this currency'}.</p>}
        {msg && <p className="text-sm text-error">{msg}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="g-btn g-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="g-btn g-btn-pri" disabled={!canSave}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
