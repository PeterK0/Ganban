// Transactions: "To sort" holds only the lines that need the user; picking a category files a line
// (categorised means done: there is no Post step). A payee learns its category the first time,
// with Undo, and filing a later line differently asks once. All, Transfers and Unsorted history
// are filters over the rest, "By payee" sorts a first import fast, a payee's page renames, merges
// and splits, and Payees & rules lists both. docs/design/FINANCE.md § Payees.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { checkSplits, evenSplit, formatDate, todayIso, journalToSplits, mergeSuggestions, parseMoney, pickSuggestable, toInput, type SplitDraft, type SuggestRow } from './money.pure';
import { correctionDate, formatMonth, isLocked, monthOf } from './reports.pure';
import { AccountPicker, Empty, MUTED, Money, errText, isUncategorised, splitEntry, useFinance, type TransactionsOpen } from './shared';
import SpreadDialog from './Spread';
import { useRailShell } from '../../components/RailViews';
import InboxGroups, { useLoadMore } from './InboxGroups';
import { count } from './inbox.pure';
import { bulkScope, narrows, nextStep, usualAmount, viewFilter, type SortView } from './sorting.pure';
import { HistoryPayees, MergeSuggestions, TidyBanner, useFiling } from './sortParts';
import PayeePage from './PayeePage';
import PayeesRules from './PayeesRules';

/** Only income and expense lines are categories; an opening balance or a transfer isn't re-sorted here. */
const isCategory = (l: fin.LedgerAccount | undefined) => !!l && (l.class === 'income' || l.class === 'expense');

const PAGE = 100;
type View = SortView | 'payees';

export default function Transactions({ open: init }: { open?: TransactionsOpen }) {
  const { accounts, ledgerById, accountByLedger, reload: reloadAll, inboxCount, summary, lockedThrough, locale } = useFinance();
  const [view, setView] = useState<View>(init?.view ?? (init?.accountId != null || init?.importBatchId != null ? 'all' : inboxCount > 0 ? 'tosort' : 'all'));
  const [payeeId, setPayeeId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | undefined>(init?.accountId);
  const [importBatchId, setImportBatchId] = useState<number | undefined>(init?.importBatchId);
  const [filedOnly, setFiledOnly] = useState(!!init?.filedOnly);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // "To sort" by payee (host-grouped), and one payee group's lines opened from it.
  const [byPayee, setByPayee] = useState(false);
  const [group, setGroup] = useState<{ key: string; label: string } | null>(null);
  const [entries, setEntries] = useState<fin.Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Category suggestions from the host's local model, by entry: a category id, or null for "nothing fits".
  const [canSuggest, setCanSuggest] = useState(false);
  const [suggested, setSuggested] = useState<Record<number, number | null>>({});
  const [asking, setAsking] = useState<Set<number>>(new Set());
  const [spreading, setSpreading] = useState<fin.Entry | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [folds, setFolds] = useState<fin.TransferGroup[]>([]);
  // On a phone the account, search and dates fold away behind one button.
  const touch = useRailShell() === 'touch';
  const [moreFilters, setMoreFilters] = useState(false);
  const seq = useRef(0);
  const shownRef = useRef(0);
  const loadRef = useRef<() => void>(() => {});
  // Bumped when lines or defaults change, so an open payee page reads itself again.
  const [rev, setRev] = useState(0);
  const filing = useFiling(() => {
    loadRef.current();
    setRev((r) => r + 1);
  });

  useEffect(() => {
    fin.suggestAvailable().then((r) => setCanSuggest(r.available)).catch(() => setCanSuggest(false));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const sortView: SortView = view === 'payees' ? 'all' : view;
  const filter = useMemo<fin.EntryFilter>(
    () => ({
      // A payee's page lists every line of the payee, whatever the view.
      ...(payeeId != null ? {} : viewFilter(sortView)),
      ...(filedOnly ? { status: 'posted' as const, transfers: false, unsorted: false } : {}),
      accountId,
      search: debounced || undefined,
      from: from || undefined,
      to: to || undefined,
      groupKey: group?.key,
      payeeId: payeeId ?? undefined,
      importBatchId,
    }),
    [sortView, payeeId, filedOnly, accountId, debounced, from, to, group, importBatchId],
  );
  /** Unsorted history is listed by payee until one is opened. */
  const showHistoryPayees = view === 'history' && payeeId == null && !narrows(filter);
  const showGroups = view === 'tosort' && byPayee && !group && payeeId == null;
  const listing = view !== 'payees' && !showGroups && !showHistoryPayees;

  const load = useCallback(
    async (append = false) => {
      if (!listing) return;
      const my = ++seq.current;
      setLoading(true);
      try {
        const r = await fin.listEntries(filter, PAGE, append ? shownRef.current : 0);
        if (my !== seq.current) return;
        setEntries((prev) => (append ? [...prev, ...r.entries] : r.entries));
        setTotal(r.total);
        if (!append) setSelected(new Set());
      } catch (e) {
        if (my === seq.current) setMsg(errText(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter, listing],
  );
  loadRef.current = () => void load();
  shownRef.current = entries.length;

  useEffect(() => {
    void load();
  }, [load]);

  // The Transfers filter folds the moves by kind: "Exchanged to GBP · 1,240 moves".
  useEffect(() => {
    if (view !== 'transfers' || payeeId != null) return setFolds([]);
    let stale = false;
    fin
      .transferGroups({ accountId, from: from || undefined, to: to || undefined, importBatchId })
      .then((g) => !stale && setFolds(g))
      .catch(() => !stale && setFolds([]));
    return () => {
      stale = true;
    };
  }, [view, payeeId, accountId, from, to, importBatchId]);

  const replace = (e: fin.Entry) => setEntries((list) => list.map((x) => (x.id === e.id ? e : x)));
  /** A line that left this view (filed, or now a transfer): drop it from the list. */
  const drop = (id: number) => {
    setEntries((l) => l.filter((x) => x.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const categorise = async (entry: fin.Entry, parts: { ledgerAccountId: number; amountMinor: number }[] | fin.TransferTarget) => {
    const r = await filing.file(entry, parts);
    if (r === null) return;
    if (typeof r === 'string') return setMsg(r);
    setMsg(null);
    forget(entry.id);
    if (payeeId != null) setRev((x) => x + 1);
    // Filed: it leaves "To sort" (and unsorted history); elsewhere it stays, re-sorted.
    if (view === 'tosort' && payeeId == null) drop(entry.id);
    else if (view === 'history' && payeeId == null && !r.unsorted) drop(entry.id);
    else replace(r);
  };

  /** File many at once: the ticked lines, or everything an active filter matches. */
  const scope = bulkScope(selected.size, narrows(filter), total, locale);
  const fileMany = async (ledgerAccountId: number) => {
    const name = ledgerById.get(ledgerAccountId)?.name ?? 'that category';
    const n = scope.on === 'selection' ? selected.size : total;
    if (!scope.on) return;
    if (!(await confirmDialog(`File the unsorted ones of these ${count(n, locale)} ${n === 1 ? 'line' : 'lines'} under ${name}? Lines that already have a category, and transfers, are left as they are. Each stays editable until its month is closed.`))) return;
    setBulkBusy(true);
    const target: fin.EntryFilter = scope.on === 'selection' ? { ...viewFilter(sortView), ids: [...selected].slice(0, 5000) } : filter;
    const r = await filing.fileGroup(view === 'history' ? { ...target, unsorted: true } : target, ledgerAccountId);
    if (typeof r === 'string') setMsg(r);
    setBulkBusy(false);
  };

  const notTransfer = async (entry: fin.Entry, accept: boolean) => {
    if (!entry.pair) return;
    try {
      await fin.resolvePair(entry.pair.id, accept);
      // Accepted, both legs are done; refused, both wait in To sort.
      if (view === 'transfers' || view === 'tosort') void load();
      void reloadAll();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const remove = async (entry: fin.Entry) => {
    if (!(await confirmDialog('Delete this transaction? The imported line is kept and marked dismissed, so a re-import won’t bring it back.'))) return;
    try {
      await fin.deleteEntry(entry.id);
      drop(entry.id);
      void reloadAll();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  /** What a line offers to suggestions: only an unsorted bank draft with one category line. */
  const suggestRow = (e: fin.Entry): SuggestRow => {
    const { bank, others } = splitEntry(e, accountByLedger, ledgerById);
    return {
      id: e.id,
      draft: e.status === 'draft',
      unsorted: others.some((l) => isUncategorised(ledgerById.get(l.ledger_account_id))),
      single: !!bank && others.length === 1,
    };
  };

  const suggest = async (ids: number[]) => {
    if (!ids.length) return;
    setAsking((a) => new Set([...a, ...ids]));
    try {
      const got = await fin.suggestCategories(ids);
      setSuggested((s) => mergeSuggestions(s, got));
      setMsg(got.some((g) => g.ledger_account_id !== null) ? null : 'The local model found no category that fits.');
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setAsking((a) => new Set([...a].filter((id) => !ids.includes(id))));
    }
  };

  function forget(id: number) {
    setSuggested((s) => {
      if (!(id in s)) return s;
      const n = { ...s };
      delete n[id];
      return n;
    });
  }

  /** A line's suggestion: one asked for here, else its payee group's waiting one. */
  const suggestionFor = (e: fin.Entry): number | null | undefined => (e.id in suggested ? suggested[e.id] : e.suggested_ledger_account_id ?? undefined);

  /** "Accept all N suggestions": every payee group's waiting suggestion on the host, and those asked for here. */
  const acceptAll = async () => {
    setBulkBusy(true);
    setMsg(null);
    let filed = 0;
    try {
      for (const e of entries.filter((x) => x.id in suggested && suggested[x.id] != null)) {
        const { bank, net } = splitEntry(e, accountByLedger, ledgerById);
        if (!bank) continue;
        await fin.categorise(e.id, net, [{ ledgerAccountId: suggested[e.id]!, amountMinor: Math.abs(net) }]);
        forget(e.id);
        filed++;
      }
      // Collect every group first: filing one drops it from the pages, so paging while filing skips some.
      const todo: fin.InboxGroup[] = [];
      for (let offset = 0, guard = 0; guard < 40; guard++) {
        const page = await fin.inboxGroups({ status: 'draft' }, 500, offset);
        todo.push(...page.groups.filter((g) => g.suggested_ledger_account_id != null && g.uncategorised > 0));
        offset += page.groups.length;
        if (!page.groups.length || offset >= page.total_groups) break;
      }
      for (const g of todo) {
        const r = await fin.categoriseMatching({ groupKey: g.key }, g.suggested_ledger_account_id!);
        filed += r.categorised;
      }
      setMsg(`Filed ${count(filed, locale)} ${filed === 1 ? 'line' : 'lines'} as suggested.`);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBulkBusy(false);
      await Promise.all([load(), reloadAll()]);
    }
  };

  const reverse = async (entry: fin.Entry) => {
    const on = correctionDate(lockedThrough, todayIso());
    if (!(await confirmDialog(`${formatMonth(monthOf(entry.date), locale)} is closed, so this entry can't change. Post a reversal dated ${formatDate(on, locale)}? Both stay in the journal, and you can then enter it again correctly.`))) return;
    try {
      await fin.reverseEntry(entry.id, on);
      setMsg('Reversed. Enter the correct version as a new transaction or journal.');
      await Promise.all([load(), reloadAll()]);
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const openPayee = (id: number) => {
    // A payee's page shows all its lines: the list's own filters would hide some.
    setAccountId(undefined);
    setSearch('');
    setDebounced('');
    setFrom('');
    setTo('');
    setImportBatchId(undefined);
    setFiledOnly(false);
    setPayeeId(id);
    setGroup(null);
    setOpen(null);
  };
  /** A payee group from By payee opens its payee's page, the same page as everywhere else. */
  const openGroup = async (g: fin.InboxGroup) => {
    const first = await fin.listEntries({ status: 'draft', groupKey: g.key }, 1).catch(() => null);
    const id = first?.entries[0]?.payee_id;
    if (id != null) openPayee(id);
    else setGroup({ key: g.key, label: g.label });
  };

  const pickView = (v: View) => {
    // A toast belongs to the view it came from.
    filing.toast(null);
    setView(v);
    setGroup(null);
    setPayeeId(null);
    setFiledOnly(false);
  };

  const toAsk = canSuggest && view === 'tosort' ? pickSuggestable(entries.filter((e) => suggestionFor(e) === undefined).map(suggestRow), suggested, fin.MAX_SUGGEST) : [];
  const waiting = (summary?.suggested ?? 0) + Object.values(suggested).filter((v) => v != null).length;
  const selectable = entries.filter((e) => e.status === 'draft' || e.unsorted);
  const allSelected = selectable.length > 0 && selectable.every((d) => selected.has(d.id));
  const more = !loading && entries.length < total;
  const sentinel = useLoadMore(more && listing, () => void load(true));
  const usual = useMemo(() => {
    if (payeeId == null) return null;
    return usualAmount(entries.map((e) => splitEntry(e, accountByLedger).bank?.functional_minor).filter((n): n is number => n != null));
  }, [payeeId, entries, accountByLedger]);
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const history = summary?.unsorted_history ?? 0;
  const filtersOn = !!(accountId != null || from || to || debounced);

  const VIEWS: [View, string][] = [
    ['tosort', `To sort${inboxCount ? ` · ${count(inboxCount, locale)}` : ''}`],
    ['all', 'All'],
    ['transfers', 'Transfers'],
    ['history', `Unsorted history${history ? ` · ${count(history, locale)}` : ''}`],
  ];

  return (
    <div className="space-y-3">
      {/* Views: one row, scrolling sideways on a phone; Payees & rules beside them. */}
      <div className="flex items-center gap-2">
        <div className={`g-seg ${touch ? 'flex-1 min-w-0 flex-wrap' : ''}`} role="tablist" aria-label="Which transactions">
          {VIEWS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v && payeeId == null} className="g-chip whitespace-nowrap" onClick={() => pickView(v)}>
              {label}
            </button>
          ))}
        </div>
        {touch ? (
          <button className="g-btn g-btn-ghost g-btn-sm flex-none min-h-[44px]" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
            {filtersOn ? 'Filters · on' : 'Filters'}
          </button>
        ) : (
          <button className="g-btn g-btn-ghost g-btn-sm ml-auto" aria-pressed={view === 'payees'} onClick={() => pickView(view === 'payees' ? 'tosort' : 'payees')}>
            Payees &amp; rules
          </button>
        )}
      </div>

      {view !== 'payees' && (!touch || moreFilters) && (
        <div className="flex flex-wrap items-end gap-3">
          {view === 'tosort' && payeeId == null && (
            <div className="g-seg" role="tablist" aria-label="How To sort is shown">
              <button role="tab" aria-selected={!byPayee} className="g-chip" onClick={() => setByPayee(false)}>
                Lines
              </button>
              <button
                role="tab"
                aria-selected={byPayee}
                className="g-chip"
                onClick={() => {
                  setByPayee(true);
                  setGroup(null);
                }}
              >
                By payee
              </button>
            </div>
          )}
          <select className="g-field g-field-sm !w-auto max-w-[220px]" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : undefined)} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <input className="g-field g-field-sm !w-auto flex-1 min-w-[160px]" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description or payee" aria-label="Search" />
          <span className={`flex items-center gap-1.5 text-sm ${MUTED}`}>
            From <DateFilter label="From" value={from} onChange={setFrom} />
          </span>
          <span className={`flex items-center gap-1.5 text-sm ${MUTED}`}>
            to <DateFilter label="To" value={to} onChange={setTo} />
          </span>
          {touch && (
            <button className="g-btn g-btn-ghost g-btn-sm min-h-[44px]" onClick={() => pickView('payees')}>
              Payees &amp; rules
            </button>
          )}
        </div>
      )}

      {importBatchId != null && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="g-tag">{filedOnly ? 'Filed by this import' : 'From this import'}</span>
          <button
            className="g-lnk"
            onClick={() => {
              setImportBatchId(undefined);
              setFiledOnly(false);
            }}
          >
            Show all
          </button>
        </div>
      )}

      {view === 'payees' ? (
        <PayeesRules onOpenPayee={(id) => {
          setView('all');
          openPayee(id);
        }} />
      ) : (
        <>
          {payeeId != null && (
            <PayeePage
              key={payeeId}
              payeeId={payeeId}
              usualMinor={usual}
              lineAccounts={[...new Set(entries.map((e) => splitEntry(e, accountByLedger).account?.id).filter((x): x is number => x != null))]}
              rev={rev}
              onBack={() => setPayeeId(null)}
              onChanged={() => void load()}
              onOpenPayee={openPayee}
              toast={filing.toast}
            />
          )}

          {view === 'tosort' && payeeId == null && inboxCount > 0 && (
            <p className="text-sm text-text">
              Give each line a category. A payee remembers the first one you give it, so its lines file themselves from then on.
            </p>
          )}
          {view === 'tosort' && payeeId == null && <TidyBanner decisions={inboxCount} onDone={() => void load()} />}
          {view === 'tosort' && payeeId == null && inboxCount === 0 && nextStep(history, 0) === 'history' && (
            <div className="g-card p-4 flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[220px] text-sm text-text">
                Nothing to sort. Next, if you like: give your biggest payees in Unsorted history a category, and next week's import files them by itself.
              </span>
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => pickView('history')}>
                Your biggest payees
              </button>
            </div>
          )}
          {(view === 'tosort' || view === 'history') && payeeId == null && <MergeSuggestions onMerged={() => void load()} toast={filing.toast} />}

          {group && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={MUTED}>Payee:</span>
              <span className="g-tag">{group.label || '(no description)'}</span>
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setGroup(null)}>
                Back to payees
              </button>
            </div>
          )}

          {view === 'tosort' && payeeId == null && (waiting > 0 || toAsk.length > 0 || asking.size > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {waiting > 0 && (
                <button className="g-btn g-btn-gilt g-btn-sm" disabled={bulkBusy} onClick={() => void acceptAll()}>
                  {bulkBusy ? 'Filing…' : `Accept all ${count(waiting, locale)} ${waiting === 1 ? 'suggestion' : 'suggestions'}`}
                </button>
              )}
              {canSuggest && (toAsk.length > 0 || asking.size > 0) && (
                <button
                  className="g-btn g-btn-ghost g-btn-sm"
                  disabled={asking.size > 0}
                  title="Ask the host's local model for a category for each line shown. Nothing is filed until you accept it."
                  onClick={() => void suggest(toAsk)}
                >
                  {asking.size > 0 ? 'Suggesting…' : `Suggest categories · ${toAsk.length}`}
                </button>
              )}
            </div>
          )}

          {showGroups && <InboxGroups filter={filter} canSuggest={canSuggest} onShowLines={(g) => void openGroup(g)} fileGroup={filing.fileGroup} />}
          {showHistoryPayees && <HistoryPayees onOpenPayee={openPayee} toast={filing.toast} />}

          {view === 'transfers' && payeeId == null && folds.length > 0 && (
            <div className="g-inset px-3 py-2 space-y-1">
              <div className={`text-sm ${MUTED}`}>Money moved between your own accounts. It isn't spending or income; tap "Not a transfer" on any line that's wrong.</div>
              {folds.slice(0, 6).map((g) => (
                <div key={`${g.account_id}-${g.key}`} className="flex items-center gap-3 text-sm">
                  <span className="flex-1 min-w-0 truncate text-text">
                    {g.label} <span className={MUTED}>· {accounts.find((a) => a.id === g.account_id)?.name ?? ''}</span>
                  </span>
                  <span className={MUTED}>
                    {count(g.count, locale)} {g.count === 1 ? 'move' : 'moves'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Bulk: the ticked lines, or everything an active filter matches. */}
          {listing && view !== 'transfers' && !filedOnly && (selected.size > 0 || (scope.on && payeeId == null)) && (
            <div className="g-inset flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="text-sm text-subtext-1">{scope.label}</span>
              <AccountPicker label="File them under" value={null} placeholder={bulkBusy ? 'Filing…' : 'File them under…'} onChange={(id) => void fileMany(id)} className="flex-1 min-w-[200px] max-w-[300px]" />
              {selected.size > 0 && (
                <button className="g-btn g-btn-ghost g-btn-sm ml-auto" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              )}
            </div>
          )}

          {msg && <p className="text-sm text-subtext-1">{msg}</p>}

          {!listing ? null : !loading && entries.length === 0 ? (
            <Empty title={view === 'tosort' && payeeId == null ? 'Nothing to sort' : 'No transactions'}>
              {view === 'tosort' && payeeId == null ? 'Lines your payees and rules can’t file wait here after an import.' : 'Nothing matches these filters.'}
            </Empty>
          ) : (
            <div className="g-plain" role="list">
              {selectable.length > 1 && view !== 'transfers' && (
                <label className={`flex items-center gap-2 px-3 py-1.5 border-b border-gilt-b text-xs ${MUTED}`}>
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((d) => d.id)))} aria-label="Tick every line shown" />
                  {selected.size ? `${count(selected.size, locale)} ticked` : `Tick the ${count(selectable.length, locale)} shown`}
                </label>
              )}
              {entries.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  mode={view === 'transfers' ? 'transfers' : view === 'tosort' ? 'tosort' : 'all'}
                  selected={selected.has(e.id)}
                  onSelect={view !== 'transfers' && (e.status === 'draft' || e.unsorted) ? () => toggle(e.id) : undefined}
                  open={open === e.id}
                  onOpen={() => setOpen(open === e.id ? null : e.id)}
                  onOpenPayee={e.payee_id != null && e.payee_id !== payeeId ? () => openPayee(e.payee_id!) : undefined}
                  onCategorise={(parts) => categorise(e, parts)}
                  onMove={(t) => void categorise(e, t)}
                  onPair={(accept) => void notTransfer(e, accept)}
                  onDelete={() => void remove(e)}
                  onReverse={() => void reverse(e)}
                  onSpread={() => setSpreading(e)}
                  suggestion={suggestionFor(e)}
                  asking={asking.has(e.id)}
                  onSuggest={canSuggest && pickSuggestable([suggestRow(e)], {}, 1).length > 0 ? () => void suggest([e.id]) : undefined}
                  onDismissSuggestion={() => setSuggested((s) => ({ ...s, [e.id]: null }))}
                />
              ))}
            </div>
          )}
          {spreading && <SpreadDialog entry={spreading} onClose={() => setSpreading(null)} onDone={() => void reloadAll()} />}
          {listing && (
            <div ref={sentinel} className={`flex items-center gap-3 text-sm ${MUTED}`}>
              {loading ? 'Loading…' : `${count(entries.length, locale)} of ${count(total, locale)}`}
              {more && (
                <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void load(true)}>
                  Show more
                </button>
              )}
            </div>
          )}
        </>
      )}
      {filing.ui}
    </div>
  );
}

/** A date filter that reads "Any date" while empty. An empty date field shows today's date in
 * WebKit (the desktop app, Safari), which looked like a today-to-today filter. */
function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    try {
      (ref.current as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* not every engine opens the picker from code */
    }
  }, [editing]);
  if (!value && !editing) {
    return (
      <button className="g-field g-field-sm !w-auto text-left" aria-label={`${label}: any date`} onClick={() => setEditing(true)}>
        Any date
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={ref}
        type="date"
        className="g-field g-field-sm !w-auto"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => !e.target.value && setEditing(false)}
      />
      {value && (
        <button
          className="g-iconbtn"
          aria-label={`Clear ${label}`}
          title="Any date"
          onClick={() => {
            onChange('');
            setEditing(false);
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}


/**
 * One line. In "To sort" the category picker files it (a suggestion shows greyed, one tap to
 * accept), and a transfer the matcher wasn't sure of asks "It's a transfer" or "Not a transfer".
 * In Transfers each line offers "Not a transfer". The payee's name opens its page.
 */
function EntryRow({
  entry,
  mode,
  selected,
  onSelect,
  open,
  onOpen,
  onOpenPayee,
  onCategorise,
  onMove,
  onPair,
  onDelete,
  onReverse,
  onSpread,
  suggestion,
  asking,
  onSuggest,
  onDismissSuggestion,
}: {
  entry: fin.Entry;
  mode: 'tosort' | 'all' | 'transfers';
  selected: boolean;
  onSelect?: () => void;
  open: boolean;
  onOpen: () => void;
  onOpenPayee?: () => void;
  onCategorise: (parts: { ledgerAccountId: number; amountMinor: number }[]) => Promise<void>;
  /** File it as a move to one of his own accounts. */
  onMove: (t: fin.TransferTarget) => void;
  /** Accept (true) or refuse (false) the transfer this line is part of. */
  onPair: (accept: boolean) => void;
  onDelete: () => void;
  onReverse: () => void;
  onSpread: () => void;
  /** A suggested category (null: nothing fits or dismissed; undefined: none asked). */
  suggestion: number | null | undefined;
  asking: boolean;
  onSuggest?: () => void;
  onDismissSuggestion: () => void;
}) {
  const { locale, entity, lockedThrough, ledgerById, accountByLedger } = useFinance();
  const touch = useRailShell() === 'touch';
  const locked = isLocked(entry.date, lockedThrough);
  const { bank, account, others, fee, net } = splitEntry(entry, accountByLedger, ledgerById);
  const single = others.length === 1 ? others[0] : null;
  const unsorted = others.some((l) => isUncategorised(ledgerById.get(l.ledger_account_id)));
  const journalSize = entry.lines.reduce((s, l) => s + Math.max(0, l.functional_minor), 0);
  const toConfirm = entry.pair?.status === 'review';
  const booked = !!entry.pair && !toConfirm;
  const suggestedName = suggestion != null ? ledgerById.get(suggestion)?.name : undefined;
  const pick = (id: number) => void onCategorise([{ ledgerAccountId: id, amountMinor: Math.abs(net) }]);
  const btn = `g-btn g-btn-sm ${touch ? 'min-h-[44px]' : ''}`;
  const name = entry.payee_name || entry.payee || entry.description;
  // What the bank wrote, when it says more than the payee's name.
  const raw = entry.payee && entry.payee !== name ? entry.payee : entry.description;

  let control: ReactNode = null;
  if (toConfirm && entry.status === 'draft') {
    control = (
      <span className="flex items-center gap-1.5 flex-1 min-w-0">
        <button className={`${btn} g-btn-gilt`} onClick={() => onPair(true)} title="Money moved between two of your accounts">
          It’s a transfer
        </button>
        <button className={`${btn} g-btn-ghost`} onClick={() => onPair(false)}>
          Not a transfer
        </button>
      </span>
    );
  } else if (booked) {
    control =
      mode === 'transfers' ? (
        <button className={`${btn} g-btn-ghost`} onClick={() => onPair(false)} title="Puts both sides back in To sort">
          Not a transfer
        </button>
      ) : (
        <span className={`text-sm truncate ${MUTED}`}>{entry.pair!.kind === 'fx' ? 'Exchange between your accounts' : 'Between your accounts'}</span>
      );
  } else if (bank && single && (locked || entry.scheduled || !isCategory(ledgerById.get(single.ledger_account_id)))) {
    control = <span className={`text-sm truncate ${MUTED}`}>{ledgerById.get(single.ledger_account_id)?.name ?? '—'}</span>;
  } else if (bank && single) {
    control = (
      <span className="flex items-center gap-1.5 flex-1 min-w-0">
        <AccountPicker
          label="Category"
          value={unsorted ? null : single.ledger_account_id}
          placeholder={unsorted && suggestedName ? suggestedName : unsorted ? 'Pick a category…' : 'Category…'}
          onChange={pick}
          moves={unsorted ? { exclude: account ? [account.id] : [], direction: bank.amount_minor > 0 ? 'in' : 'out', onMove } : undefined}
          className={`flex-1 min-w-0 ${unsorted && suggestedName ? 'italic' : ''}`}
        />
        {unsorted && suggestion != null && suggestedName && (
          <button className={`${btn} g-btn-gilt flex-none`} onClick={() => pick(suggestion)} title={`File under ${suggestedName}`} aria-label={`Accept ${suggestedName}`}>
            ✓
          </button>
        )}
      </span>
    );
  } else if (bank) {
    control = (
      <button className="g-field g-field-sm text-left flex-1 min-w-0 truncate" onClick={onOpen}>
        Split · {others.length}
      </button>
    );
  }

  return (
    <div role="listitem" className={`border-b border-gilt-b ${open ? 'bg-base' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-h-[52px] px-3 py-1.5">
        {onSelect && (
          <span className="w-5 flex justify-center">
            <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Tick ${entry.payee_name || entry.payee || entry.description}`} />
          </span>
        )}
        <span className="flex-1 min-w-[150px]">
          {onOpenPayee ? (
            <button className="block max-w-full text-left text-text truncate hover:underline" onClick={onOpenPayee} title="Open this payee">
              {name}
            </button>
          ) : (
            <span className="block text-text truncate">{name}</span>
          )}
          <button className={`block max-w-full text-left text-xs ${MUTED} truncate`} onClick={onOpen} aria-expanded={open} title="More about this line">
            {formatDate(entry.date, locale)}
            {account ? ` · ${account.name}` : ' · Journal entry'}
            {raw && raw !== name ? ` · ${raw}` : ''}
          </button>
        </span>
        <span className={`flex items-center gap-2 order-last sm:order-none w-full sm:w-[260px] ${onSelect ? 'pl-8' : ''} sm:pl-0`}>{control}</span>
        <span className="flex items-center gap-2 ml-auto">
          {onSuggest && suggestion === undefined && unsorted && !toConfirm && (
            <button className="g-btn g-btn-ghost g-btn-sm" disabled={asking} onClick={onSuggest} title="Ask the host's local model for a category">
              {asking ? 'Suggesting…' : 'Suggest'}
            </button>
          )}
          {entry.status === 'reversed' && <span className="g-tag">Reversed</span>}
          {locked && <span className="g-tag" title="This month is closed">Closed</span>}
          {bank ? <Money minor={bank.amount_minor} currency={bank.currency} colour className="w-[100px] text-right" /> : <Money minor={journalSize} currency={entity.functional_currency} className="w-[100px] text-right" />}
        </span>
      </div>
      {open && (
        <div className="pl-8 pr-1 pb-4 space-y-3">
          {locked && (
            <p className={`text-sm ${MUTED}`}>
              {formatMonth(monthOf(entry.date), locale)} is closed, so this entry can't change. A reversal undoes it in an open month.
            </p>
          )}
          {!locked && entry.scheduled && (
            <p className={`text-sm ${MUTED}`}>Part of a spread over months, so its categories and date are fixed and it can't be deleted. Remove the spread first (Spread over months… on the original transaction).</p>
          )}
          {!locked && !entry.scheduled && bank && !entry.pair && others.every((l) => isCategory(ledgerById.get(l.ledger_account_id))) && <SplitsEditor entry={entry} bank={bank} net={net} fee={fee} others={others} onSave={onCategorise} />}
          {entry.notes && <p className={`text-sm ${MUTED}`}>{entry.notes}</p>}
          <div className="flex flex-wrap gap-2">
            {suggestion != null && unsorted && (
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={onDismissSuggestion}>
                Not {suggestedName}
              </button>
            )}
            {entry.status === 'posted' && !entry.reverses_id && others.some((l) => isCategory(ledgerById.get(l.ledger_account_id)) && !isUncategorised(ledgerById.get(l.ledger_account_id))) && (
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={onSpread} disabled={locked} title={locked ? 'Its month is closed' : undefined}>
                Spread over months…
              </button>
            )}
            {entry.status !== 'reversed' && !locked && !entry.scheduled && (
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={onDelete}>
                Delete
              </button>
            )}
            {entry.status === 'posted' && locked && !entry.reverses_id && (
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={onReverse}>
                Reverse…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Split one bank line across categories: plain positive parts that must add up to the line. */
function SplitsEditor({
  entry,
  bank,
  net,
  fee,
  others,
  onSave,
}: {
  entry: fin.Entry;
  bank: fin.Line;
  net: number;
  fee: fin.Line | null;
  others: fin.Line[];
  onSave: (parts: { ledgerAccountId: number; amountMinor: number }[]) => Promise<void>;
}) {
  const { locale } = useFinance();
  const cur = bank.currency;
  const total = Math.abs(net);
  const initial = () => {
    const plain = journalToSplits(others.map((l) => l.amount_minor));
    return others.map((l, i) => ({ id: l.ledger_account_id as number | null, text: toInput(plain[i], cur, locale) }));
  };
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const linesKey = others.map((l) => `${l.ledger_account_id}:${l.amount_minor}`).join(',');
  useEffect(() => setRows(initial()), [entry.id, linesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const drafts: SplitDraft[] = rows.map((r) => ({ ledgerAccountId: r.id, amountMinor: parseMoney(r.text, cur, locale) }));
  const check = checkSplits(total, drafts);
  const set = (i: number, patch: Partial<{ id: number | null; text: string }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (!check.ok) return;
    setBusy(true);
    await onSave(drafts.map((d) => ({ ledgerAccountId: d.ledgerAccountId!, amountMinor: d.amountMinor! })));
    setBusy(false);
  };

  return (
    <div className="g-inset p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="g-cap flex-1">Split across categories</span>
        {fee && (
          <span className={`text-xs ${MUTED}`}>
            plus <Money minor={Math.abs(fee.amount_minor)} currency={cur} /> bank fee
          </span>
        )}
        <button
          className="g-lnk text-sm"
          onClick={() => {
            const parts = evenSplit(total, rows.length);
            setRows((rs) => rs.map((r, i) => ({ ...r, text: toInput(parts[i], cur, locale) })));
          }}
        >
          Even split
        </button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <AccountPicker label={`Category ${i + 1}`} value={r.id} onChange={(id) => set(i, { id })} className="flex-1 min-w-0" />
          <input
            className="g-field g-field-sm !w-[110px] text-right tabular-nums"
            inputMode="decimal"
            value={r.text}
            onChange={(e) => set(i, { text: e.target.value })}
            aria-label={`Amount ${i + 1}`}
            aria-invalid={drafts[i].amountMinor === null}
          />
          <button className="g-iconbtn" aria-label={`Remove line ${i + 1}`} title="Remove line" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="g-btn g-btn-ghost g-btn-sm"
          onClick={() => setRows((rs) => [...rs, { id: null, text: check.remainder > 0 ? toInput(check.remainder, cur, locale) : '' }])}
        >
          Add line
        </button>
        <span className={`text-sm ${check.remainder === 0 ? MUTED : 'text-error'}`}>
          {check.remainder === 0 ? (
            <>
              Adds up to <Money minor={total} currency={cur} />
            </>
          ) : check.remainder > 0 ? (
            <>
              <Money minor={check.remainder} currency={cur} /> left to assign
            </>
          ) : (
            <>
              <Money minor={-check.remainder} currency={cur} /> too much
            </>
          )}
        </span>
        <button className="g-btn g-btn-gilt g-btn-sm ml-auto" disabled={!check.ok || busy} onClick={() => void save()}>
          Save split
        </button>
      </div>
      {!check.ok && check.remainder === 0 && <p className="text-xs text-error">{check.errors[0]}</p>}
    </div>
  );
}
