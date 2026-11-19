// A payee's page: its name (renamed in place), totals and usual amount, its default category, "ask
// every time", the spellings the bank used (each can be split off) and "Merge with…". The lines
// themselves are the Transactions list below it, filtered to the payee.
import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { formatDate } from './money.pure';
import { AccountPicker, MUTED, Money, errText, useFinance } from './shared';
import type { Toast } from './sortParts';
import { defaultToast, splitText } from './sorting.pure';

export default function PayeePage({
  payeeId,
  usualMinor,
  lineAccounts,
  rev,
  onBack,
  onChanged,
  onOpenPayee,
  toast,
}: {
  payeeId: number;
  /** The usual amount of its lines (the median), from the list below; null while unknown. */
  usualMinor: number | null;
  /** The accounts its lines are in: a move there would mean nothing. */
  lineAccounts: number[];
  /** Changes when its lines or default may have changed: read the payee again. */
  rev: number;
  onBack: () => void;
  /** Its lines may have moved: reload the list. */
  onChanged: () => void;
  /** After a merge or split, the payee to show (it may be another one). */
  onOpenPayee: (id: number) => void;
  toast: (t: Toast) => void;
}) {
  const { entity, ledgerById, locale, reload, accounts } = useFinance();
  const [p, setP] = useState<fin.Payee | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    let stale = false;
    fin
      .getPayee(payeeId)
      .then((x) => {
        if (stale) return;
        setP(x);
        setName(x.name);
      })
      .catch((e) => setMsg(errText(e)));
    return () => {
      stale = true;
    };
  }, [payeeId, rev]);

  if (!p) return <p className={`text-sm ${msg ? 'text-error' : MUTED}`}>{msg ?? 'Loading…'}</p>;

  // Money from this payee comes in: a move reads "from Savings".
  const dir: 'in' | 'out' = p.total_minor > 0 ? 'in' : 'out';
  const fresh = async () => {
    const x = await fin.getPayee(p.id);
    setP(x);
    setName(x.name);
  };

  const rename = async () => {
    const n = name.trim();
    setRenaming(false);
    if (!n || n === p.name) return setName(p.name);
    try {
      setP(await fin.updatePayee(p.id, { name: n }));
      onChanged();
    } catch (e) {
      setMsg(errText(e));
      setName(p.name);
    }
  };

  const setDefault = async (pick: { ledgerAccountId: number } | fin.TransferTarget | null) => {
    try {
      let to: { ledgerAccountId: number } | { accountId: number } | null = null;
      let made: fin.FinAccount | null = null;
      if (pick && 'create' in pick) {
        made = await fin.createAccount({ kind: pick.create.kind ?? 'savings', name: pick.create.name, currency: entity.functional_currency });
        to = { accountId: made.id };
      } else to = pick;
      const c = await fin.setPayeeDefault(p.id, to);
      if (to) {
        const acc = 'accountId' in to ? (made ?? accounts.find((a) => a.id === (to as { accountId: number }).accountId)) : null;
        const what = 'accountId' in to ? `${dir === 'in' ? 'from' : 'to'} ${acc?.name ?? 'that account'}` : ledgerById.get(to.ledgerAccountId)?.name ?? 'that category';
        toast({ text: defaultToast(c.name, what, c.filed_drafts.length, c.filed_history.length, locale), undo: c, dir });
      }
      await fresh();
      onChanged();
      void reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const askEveryTime = async (on: boolean) => {
    try {
      setP(await fin.updatePayee(p.id, { askEveryTime: on }));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const splitOff = async (a: fin.PayeeAlias) => {
    if (!(await confirmDialog(`Split “${a.sample}” off ${p.name}? Its lines go with it, to the payee it came from or a new one.`))) return;
    try {
      const went = await fin.splitPayee(p.id, [a.key]);
      await fresh();
      const other = went.find((x) => x.id !== p.id);
      toast({ text: splitText(a.sample, p.name, other?.name ?? p.name, other?.lines ?? 0) });
      onChanged();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const merge = async (other: fin.Payee) => {
    if (!(await confirmDialog(`Merge ${other.name} into ${p.name}? Its ${other.lines} ${other.lines === 1 ? 'line' : 'lines'} and spellings move here. You can split them off again.`))) return;
    try {
      // Its spellings, so Undo can split exactly them off again.
      const keys = (await fin.getPayee(other.id)).aliases.map((a) => a.key);
      const x = await fin.mergePayees(p.id, [other.id]);
      setMerging(false);
      onOpenPayee(x.id);
      await fresh();
      toast({
        text: `${other.name} is now part of ${x.name}: its lines and spellings file as ${x.name}.`,
        undoAction: async () => {
          await fin.splitPayee(x.id, keys);
          await fresh();
          onChanged();
          return `${other.name} is its own payee again.`;
        },
      });
      onChanged();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const cur = entity.functional_currency;
  return (
    <div className="g-card g-corners p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="g-btn g-btn-ghost g-btn-sm" onClick={onBack}>
          ← Back
        </button>
        {renaming ? (
          <span className="flex flex-1 min-w-[200px] items-center gap-2">
            <input
              autoFocus
              onFocus={(e) => e.target.select()}
              className="g-field flex-1 min-w-0 text-lg"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setName(p.name);
                  setRenaming(false);
                }
              }}
              aria-label="New name for this payee"
            />
            <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => void rename()}>
              Save
            </button>
            <button
              className="g-btn g-btn-ghost g-btn-sm"
              onClick={() => {
                setName(p.name);
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex flex-1 min-w-[200px] items-center gap-3">
            <span className="g-subtitle text-text truncate">{p.name}</span>
            <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setRenaming(true)} title="Every spelling below keeps filing under the new name">
              Rename
            </button>
          </span>
        )}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <Stat label="Lines">{p.lines.toLocaleString(locale)}</Stat>
        <Stat label="Total">
          <Money minor={p.total_minor} currency={cur} colour />
        </Stat>
        <Stat label="Usual amount">{usualMinor == null ? '—' : <Money minor={usualMinor} currency={cur} colour />}</Stat>
        <Stat label="Last seen">{p.last_date ? formatDate(p.last_date, locale) : '—'}</Stat>
        {p.unsorted > 0 && <Stat label="Lines still in Unsorted history">{p.unsorted.toLocaleString(locale)}</Stat>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-text">
 <span className={MUTED}>New lines file under</span>
          <AccountPicker
            label="Default category"
            value={p.default_account_id != null ? null : p.default_ledger_account_id}
            placeholder="Pick a category…"
            onChange={(id) => void setDefault({ ledgerAccountId: id })}
            moves={{ current: p.default_account_id ?? null, exclude: lineAccounts, direction: dir, onMove: (t) => void setDefault(t) }}
            className="w-[240px]"
          />
        </label>
        {(p.default_ledger_account_id != null || p.default_account_id != null) && (
          <button className="g-lnk text-sm" onClick={() => void setDefault(null)}>
            Clear
          </button>
        )}
        <label className="flex items-center gap-2 text-sm text-text min-h-[32px]" title="Lines from this payee always wait in To sort, and it never learns a default">
          <input type="checkbox" checked={p.ask_every_time} onChange={(e) => void askEveryTime(e.target.checked)} />
          Ask every time
        </label>
      </div>
      <div className="space-y-1.5">
        <div className="g-flbl">How the bank writes it</div>
        <div className="flex flex-wrap gap-2">
          {p.aliases.map((a) => (
            <span key={a.key} className="g-tag !h-auto py-1 gap-1.5">
              {a.sample}
              {p.aliases.length > 1 && (
                <button className="g-lnk text-xs" onClick={() => void splitOff(a)} title="This is another payee">
                  split off
                </button>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {merging ? <PayeeSearch exclude={p.id} onPick={(o) => void merge(o)} onCancel={() => setMerging(false)} /> : (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setMerging(true)}>
            Merge with…
          </button>
        )}
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="g-inset px-3 py-2">
      <div className="text-lg text-text tabular-nums">{children}</div>
      <div className={`text-xs ${MUTED}`}>{label}</div>
    </div>
  );
}

/** A search over payees, to pick one. */
export function PayeeSearch({ exclude, onPick, onCancel }: { exclude?: number; onPick: (p: fin.Payee) => void; onCancel: () => void }) {
  const { locale } = useFinance();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<fin.Payee[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    const t = window.setTimeout(() => {
      fin
        .listPayees({ search: q.trim() || undefined }, 8)
        .then((r) => my === seq.current && setFound(r.payees.filter((x) => x.id !== exclude)))
        .catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [q, exclude]);
  const shown = useMemo(() => found.slice(0, 8), [found]);
  return (
    <div className="w-full max-w-[420px] space-y-1">
      <div className="flex gap-2">
        <input autoFocus className="g-field g-field-sm flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the other payee…" aria-label="Find a payee" onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
        <button className="g-btn g-btn-ghost g-btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="g-plain" role="listbox" aria-label="Payees">
        {shown.map((x) => (
          <button key={x.id} role="option" aria-selected={false} className="w-full flex items-center gap-2 min-h-[36px] px-2 text-left text-sm hover:bg-surface-0" onClick={() => onPick(x)}>
            <span className="flex-1 min-w-0 truncate text-text">{x.name}</span>
            <span className={`text-xs ${MUTED}`}>{x.lines.toLocaleString(locale)} lines</span>
          </button>
        ))}
        {!shown.length && <div className={`px-2 py-2 text-sm ${MUTED}`}>No payee found.</div>}
      </div>
    </div>
  );
}
