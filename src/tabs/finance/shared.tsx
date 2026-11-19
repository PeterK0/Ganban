// Shared parts of the Finance view: the data every sub-view reads, the money display and the
// category picker.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Entity, Entry, FinAccount, InboxSummary, LedgerAccount, Period, TransferTarget } from './api';
import { formatMoney } from './money.pure';
import { moveLabel, pickerCategories } from './sorting.pure';
import ScrollArea from '../../components/ScrollArea';

/** Where Transactions opens: a view, and optionally one import's lines. */
export interface TransactionsOpen {
  accountId?: number;
  view?: 'tosort' | 'all' | 'transfers' | 'history' | 'payees';
  importBatchId?: number;
  /** With `importBatchId` on All: only what the import filed (posted, not a transfer, not history). */
  filedOnly?: boolean;
}

export type FinanceTab = 'overview' | 'transactions' | 'budgets' | 'forecast' | 'statements' | 'accounts' | 'import' | 'accounting' | 'settings';

export interface FinanceData {
  entity: Entity;
  accounts: FinAccount[];
  ledger: LedgerAccount[];
  ledgerById: Map<number, LedgerAccount>;
  /** Financial accounts by their ledger account, to find an entry's bank line. */
  accountByLedger: Map<number, FinAccount>;
  /** Lines that need the user ("To sort"), from the host's inbox summary. */
  inboxCount: number;
  reviewCount: number;
  /** The inbox summary (null until it loads, or on a host without it). */
  summary: InboxSummary | null;
  /** Lines filed per category, read from the payees: the picker lists the most used first. */
  categoryUses: Map<number, number>;
  /** The months from the first entry to now, open or closed. */
  periods: Period[];
  /** The latest closed month: dates in or before it are locked (corrections are reversals). */
  lockedThrough: string | null;
  /** The user's locale for numbers and dates (undefined: the browser's). */
  locale: string | undefined;
  reload: () => Promise<void>;
  goto: (tab: FinanceTab, opts?: TransactionsOpen) => void;
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

/** The categories a bank line can go to: live spending and income categories, without the system
 * accounts (Bank fees aside); the most used first when `uses` is given, else by name. */
export function categories(ledger: LedgerAccount[], uses?: Map<number, number>): LedgerAccount[] {
  return pickerCategories(ledger, uses);
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
  moves,
}: {
  value: number | null;
  onChange: (id: number) => void;
  options?: LedgerAccount[];
  placeholder?: string;
  label: string;
  className?: string;
  showCode?: boolean;
  /** Also offer "A move between my accounts": his accounts (not `exclude`, the line's own) and a new one. */
  moves?: {
    /** The accounts the line (or the payee's lines) are already in: a move there means nothing. */
    exclude?: number[];
    current?: number | null;
    /** Money coming in reads "From Savings"; going out, "To Savings". */
    direction?: 'in' | 'out';
    onMove: (t: TransferTarget) => void;
  };
}) {
  const { ledger, ledgerById, categoryUses, accounts } = useFinance();
  const list = useMemo(() => options ?? categories(ledger, categoryUses), [options, ledger, categoryUses]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  // "A new account…": the search box asks for its name instead.
  const [naming, setNaming] = useState(false);
  const [newKind, setNewKind] = useState<'savings' | 'current'>('savings');
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  type Item = { kind: 'c'; l: LedgerAccount } | { kind: 'a'; a: FinAccount } | { kind: 'new' };
  const shown = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const cats = (s ? list.filter((l) => l.name.toLowerCase().includes(s) || l.code.toLowerCase().startsWith(s)) : list).map((l): Item => ({ kind: 'c', l }));
    if (!moves) return cats;
    const own = accounts.filter((a) => !a.archived && !(moves.exclude ?? []).includes(a.id) && (!s || a.name.toLowerCase().includes(s))).map((a): Item => ({ kind: 'a', a }));
    return [...cats, ...own, { kind: 'new' }];
  }, [q, list, moves, accounts]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = Math.max(r.width, 260);
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

  const close = () => {
    setOpen(false);
    setQ('');
    setNaming(false);
    btn.current?.focus();
  };
  const choose = (it: Item) => {
    if (it.kind === 'new') {
      setNaming(true);
      setQ('');
      return;
    }
    if (it.kind === 'c') onChange(it.l.id);
    else moves?.onMove({ accountId: it.a.id });
    close();
  };
  const createNamed = () => {
    const name = q.trim();
    if (!name || !moves) return;
    moves.onMove({ create: { name, kind: newKind } });
    close();
  };

  const current = value != null ? ledgerById.get(value) : undefined;
  const currentMove = moves?.current != null ? accounts.find((a) => a.id === moves.current) : undefined;
  const dir = moves?.direction ?? 'out';
  const firstMove = shown.findIndex((it) => it.kind !== 'c');
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setHi(0);
          setNaming(false);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${currentMove ? moveLabel(currentMove.name, dir) : current ? current.name : 'none'}`}
        className={`g-field g-field-sm text-left truncate ${currentMove || (current && !isUncategorised(current)) ? '' : MUTED} ${className}`}
      >
        {currentMove ? moveLabel(currentMove.name, dir) : current ? (showCode ? ledgerLabel(current) : current.name) : placeholder}
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
              // On a touch screen the keyboard would cover the list: the search waits for a tap.
              autoFocus={!coarse || naming}
              key={naming ? 'naming' : 'search'}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (naming) {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    createNamed();
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setNaming(false);
                    setQ('');
                  }
                  return;
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHi((h) => Math.min(h + 1, shown.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHi((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter' && shown[hi]) {
                  e.preventDefault();
                  choose(shown[hi]);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  close();
                }
              }}
              placeholder={naming ? 'Name of the new account, then Enter' : 'Search…'}
              aria-label={naming ? 'Name of the new account' : `Search ${label.toLowerCase()}`}
              className="g-field g-field-sm mb-1"
            />
            {naming ? (
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
                <select className="g-field g-field-sm !w-auto" value={newKind} onChange={(e) => setNewKind(e.target.value as 'savings' | 'current')} aria-label="Kind of the new account">
                  <option value="savings">Savings</option>
                  <option value="current">Current account</option>
                </select>
                <span className={`flex-1 text-xs ${MUTED}`}>Money moved there counts as yours, not as spending. Import its statement later to see where it went.</span>
                <button type="button" className="g-btn g-btn-gilt g-btn-sm" disabled={!q.trim()} onClick={createNamed}>
                  Create
                </button>
              </div>
            ) : (
              <div role="listbox" aria-label={label} style={{ height: Math.min(Math.max(shown.length, 1) * 32 + 4 + (firstMove >= 0 ? 28 : 0), 300) }}>
                <ScrollArea className="h-full">
                  {shown.length === 0 && <div className={`px-2 py-2 text-sm ${MUTED}`}>No match.</div>}
                  {shown.map((it, i) => (
                    <div key={it.kind === 'c' ? `c${it.l.id}` : it.kind === 'a' ? `a${it.a.id}` : 'new'}>
                      {i === firstMove && <div className={`g-cap px-2 pt-2 pb-1 ${MUTED}`}>A move between my accounts</div>}
                      <button
                        type="button"
                        role="option"
                        aria-selected={it.kind === 'c' ? it.l.id === value : it.kind === 'a' ? it.a.id === moves?.current : false}
                        onMouseEnter={() => setHi(i)}
                        onClick={() => choose(it)}
                        className={`w-full flex items-center gap-2 min-h-[32px] px-2 rounded text-left text-sm ${i === hi ? 'bg-surface-0 text-text' : 'text-subtext-1'}`}
                      >
                        {it.kind === 'c' ? (
                          <>
                            {showCode && <span className={`tabular-nums text-xs ${MUTED}`}>{it.l.code}</span>}
                            <span className="flex-1 min-w-0 truncate">{it.l.name}</span>
                            <span className={`text-xs ${MUTED}`}>{it.l.class === 'income' ? 'money in' : it.l.class === 'expense' ? 'spending' : it.l.class}</span>
                          </>
                        ) : it.kind === 'a' ? (
                          <>
                            <span className="flex-1 min-w-0 truncate">{moveLabel(it.a.name, dir)}</span>
                            <span className={`text-xs ${MUTED}`}>{it.a.currency}</span>
                          </>
                        ) : (
                          <span className="flex-1 min-w-0 truncate">A new account…</span>
                        )}
                      </button>
                    </div>
                  ))}
                </ScrollArea>
              </div>
            )}
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
