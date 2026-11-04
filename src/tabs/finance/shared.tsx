// Shared parts of the Finance view: the data every sub-view reads, the money display and the
// category picker.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Entity, Entry, FinAccount, LedgerAccount, Period } from './api';
import { formatMoney } from './money.pure';
import ScrollArea from '../../components/ScrollArea';

export type FinanceTab = 'overview' | 'transactions' | 'budgets' | 'forecast' | 'statements' | 'accounts' | 'import' | 'accounting' | 'settings';

export interface FinanceData {
  entity: Entity;
  accounts: FinAccount[];
  ledger: LedgerAccount[];
  ledgerById: Map<number, LedgerAccount>;
  /** Financial accounts by their ledger account, to find an entry's bank line. */
  accountByLedger: Map<number, FinAccount>;
  inboxCount: number;
  reviewCount: number;
  /** The months from the first entry to now, open or closed. */
  periods: Period[];
  /** The latest closed month: dates in or before it are locked (corrections are reversals). */
  lockedThrough: string | null;
  /** The user's locale for numbers and dates (undefined: the browser's). */
  locale: string | undefined;
  reload: () => Promise<void>;
  goto: (tab: FinanceTab, opts?: { accountId?: number }) => void;
}

export const FinanceContext = createContext<FinanceData | null>(null);

export function useFinance(): FinanceData {
  const d = useContext(FinanceContext);
  if (!d) throw new Error('useFinance outside the Finance view');
  return d;
}

export const MUTED = 'text-[color:var(--g-mut)]';

/** An error message from a failed call, for the screen (never logged: it may name a payee). */
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An amount in its currency; money in is green, money out plain. */
export function Money({ minor, currency, signed = false, colour = false, className = '' }: { minor: number; currency: string; signed?: boolean; colour?: boolean; className?: string }) {
  const { locale } = useFinance();
  const tone = colour && minor > 0 ? 'text-success' : '';
  return <span className={`tabular-nums whitespace-nowrap ${tone} ${className}`}>{formatMoney(minor, currency, locale, { sign: signed })}</span>;
}

/**
 * The bank side of an entry and its other lines (categories, or the journal's other side). An
 * imported line's fee is a Bank fees line the host keeps with the bank side when it re-sorts the
 * entry, so it isn't a category here; `net` is what the categories add up to (the bank line less
 * its fee). The entry doesn't carry the fee, so a Bank fees line counts as the fee only beside
 * another category line.
 */
export function splitEntry(entry: Entry, accountByLedger: Map<number, FinAccount>, ledgerById?: Map<number, LedgerAccount>) {
  const bank = entry.lines.find((l) => accountByLedger.has(l.ledger_account_id)) ?? null;
  let others = entry.lines.filter((l) => l !== bank);
  let fee: Entry['lines'][number] | null = null;
  if (bank && entry.source_line_id != null && ledgerById && others.length >= 2) {
    fee = others.find((l) => ledgerById.get(l.ledger_account_id)?.system_key === 'bank_fees') ?? null;
    if (fee) others = others.filter((l) => l !== fee);
  }
  const net = bank ? bank.amount_minor + (fee?.amount_minor ?? 0) : 0;
  return { bank, account: bank ? accountByLedger.get(bank.ledger_account_id) ?? null : null, others, fee, net };
}

/** Is this ledger account one of the "not sorted yet" buckets? */
export const isUncategorised = (la: LedgerAccount | undefined) => !!la && (la.system_key === 'uncategorised_expense' || la.system_key === 'uncategorised_income');

/** The categories a bank line can go to: income and expense accounts, live, by name. */
export function categories(ledger: LedgerAccount[]): LedgerAccount[] {
  return ledger
    .filter((l) => (l.class === 'income' || l.class === 'expense') && !l.archived)
    .sort((a, b) => (a.class === b.class ? a.name.localeCompare(b.name) : a.class === 'expense' ? -1 : 1));
}

/** A ledger account's label: its code and name. */
export const ledgerLabel = (l: LedgerAccount | undefined) => (l ? `${l.code} ${l.name}` : '—');

/**
 * A searchable list of ledger accounts in a popover (portalled: the lists sit in clipped panes).
 * `options` defaults to the categories.
 */
export function AccountPicker({
  value,
  onChange,
  options,
  placeholder = 'Category…',
  label,
  className = '',
  showCode = false,
}: {
  value: number | null;
  onChange: (id: number) => void;
  options?: LedgerAccount[];
  placeholder?: string;
  label: string;
  className?: string;
  showCode?: boolean;
}) {
  const { ledger, ledgerById } = useFinance();
  const list = useMemo(() => options ?? categories(ledger), [options, ledger]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? list.filter((l) => l.name.toLowerCase().includes(s) || l.code.toLowerCase().startsWith(s)) : list;
  }, [q, list]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = Math.max(r.width, 240);
    const up = r.bottom + 320 > window.innerHeight && r.top > 320;
    setPos({ left: Math.min(r.left, window.innerWidth - width - 8), top: up ? r.top - 4 : r.bottom + 4, width, up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const pick = (id: number) => {
    onChange(id);
    setOpen(false);
    setQ('');
    btn.current?.focus();
  };

  const current = value != null ? ledgerById.get(value) : undefined;
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setHi(0);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current ? current.name : 'none'}`}
        className={`g-field g-field-sm text-left truncate ${current && !isUncategorised(current) ? '' : MUTED} ${className}`}
      >
        {current ? (showCode ? ledgerLabel(current) : current.name) : placeholder}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            className="fixed z-[70] g-card p-1.5 shadow-xl flex flex-col"
            style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          >
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHi((h) => Math.min(h + 1, shown.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHi((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter' && shown[hi]) {
                  e.preventDefault();
                  pick(shown[hi].id);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                  btn.current?.focus();
                }
              }}
              placeholder="Search…"
              aria-label={`Search ${label.toLowerCase()}`}
              className="g-field g-field-sm mb-1"
            />
            <div role="listbox" aria-label={label} style={{ height: Math.min(Math.max(shown.length, 1) * 32 + 4, 260) }}>
              <ScrollArea className="h-full">
              {shown.length === 0 && <div className={`px-2 py-2 text-sm ${MUTED}`}>No match.</div>}
              {shown.map((l, i) => (
                <button
                  key={l.id}
                  type="button"
                  role="option"
                  aria-selected={l.id === value}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(l.id)}
                  className={`w-full flex items-center gap-2 min-h-[32px] px-2 rounded text-left text-sm ${i === hi ? 'bg-surface-0 text-text' : 'text-subtext-1'}`}
                >
                  {showCode && <span className={`tabular-nums text-xs ${MUTED}`}>{l.code}</span>}
                  <span className="flex-1 min-w-0 truncate">{l.name}</span>
                  <span className={`g-cap !tracking-[.12em] ${MUTED}`}>{l.class}</span>
                </button>
              ))}
              </ScrollArea>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** A quiet empty state inside a panel. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="g-plain px-5 py-8 text-center">
      <p className="g-deco text-[15px] text-text mb-1">{title}</p>
      {children && <div className={`text-sm ${MUTED}`}>{children}</div>}
    </div>
  );
}
