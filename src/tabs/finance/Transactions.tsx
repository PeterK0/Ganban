// Transactions: the drafts inbox and the posted list. Sort a bank line into a category inline, split
// it across several, and post the sorted ones in bulk. After a correction the host may draft a rule
// ("file these under Groceries from now on"), offered once here. An entry in a closed month is
// locked: it offers a reversal instead. A posted entry can be spread over months. With a local model
// on the host, "Suggest" asks it for a category; a suggestion is only shown until the user takes it.
// A big inbox is worked on the host: "Post all N matching" and "Categorise all N matching as…" act on
// every draft the filters match, and "By payee" groups the drafts so one pick sorts a whole payee.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { checkSplits, evenSplit, formatDate, todayIso, journalToSplits, mergeSuggestions, parseMoney, pickSuggestable, toInput, type SplitDraft, type SuggestRow } from './money.pure';
import { correctionDate, formatMonth, isLocked, monthOf } from './reports.pure';
import { AccountPicker, Empty, MUTED, Money, errText, isUncategorised, splitEntry, useFinance } from './shared';
import SpreadDialog from './Spread';
import { useRailShell } from '../../components/RailViews';
import InboxGroups, { useLoadMore } from './InboxGroups';
import { bulkErrorText, categorisedText, categoriseAllConfirm, count, isFiltered, postAllConfirm, postedText, selectLabel } from './inbox.pure';

/** Only income and expense lines are categories; an opening balance or a transfer isn't re-sorted here. */
const isCategory = (l: fin.LedgerAccount | undefined) => !!l && (l.class === 'income' || l.class === 'expense');

const PAGE = 100;
type StatusView = 'draft' | 'posted' | 'all';

export default function Transactions({ initialAccountId }: { initialAccountId?: number }) {
  const { accounts, ledgerById, accountByLedger, reload: reloadAll, inboxCount, lockedThrough, locale } = useFinance();
  const [view, setView] = useState<StatusView>(initialAccountId ? 'all' : inboxCount > 0 ? 'draft' : 'posted');
  const [accountId, setAccountId] = useState<number | undefined>(initialAccountId);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [uncategorised, setUncategorised] = useState(false);
  // The inbox by payee (host-grouped), and one payee group's lines opened from it.
  const [byPayee, setByPayee] = useState(false);
  const [group, setGroup] = useState<{ key: string; label: string } | null>(null);
  // Unsorted drafts matching the filters, over every page: the "Categorise all N matching" count.
  const [unsortedTotal, setUnsortedTotal] = useState(0);
  const [entries, setEntries] = useState<fin.Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ entry: fin.Entry; rule: fin.RuleInput } | null>(null);
  // Category suggestions from the host's local model, by entry: a category id, or null for "nothing fits".
  const [canSuggest, setCanSuggest] = useState(false);
  const [suggested, setSuggested] = useState<Record<number, number | null>>({});
  const [asking, setAsking] = useState<Set<number>>(new Set());
  const [spreading, setSpreading] = useState<fin.Entry | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // On a phone the dates and "unsorted only" fold away behind one button.
  const touch = useRailShell() === 'touch';
  const [moreFilters, setMoreFilters] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    fin.suggestAvailable().then((r) => setCanSuggest(r.available)).catch(() => setCanSuggest(false));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const filter = useMemo<fin.EntryFilter>(
    () => ({
      status: view === 'all' ? undefined : view,
      accountId,
      search: debounced || undefined,
      from: from || undefined,
      to: to || undefined,
      uncategorised: uncategorised || undefined,
      groupKey: group?.key,
    }),
    [view, accountId, debounced, from, to, uncategorised, group],
  );

  const load = useCallback(
    async (append = false) => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const countUnsorted = !append && filter.status === 'draft' && !filter.uncategorised;
        const [r, u] = await Promise.all([
          fin.listEntries(filter, PAGE, append ? entries.length : 0),
          countUnsorted ? fin.listEntries({ ...filter, uncategorised: true }, 1, 0).then((x) => x.total) : Promise.resolve(null),
        ]);
        if (my !== seq.current) return;
        setEntries((prev) => (append ? [...prev, ...r.entries] : r.entries));
        setTotal(r.total);
        if (!append) {
          setSelected(new Set());
          setUnsortedTotal(u ?? (filter.uncategorised ? r.total : 0));
        }
      } catch (e) {
        if (my === seq.current) setMsg(errText(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (e: fin.Entry) => setEntries((list) => list.map((x) => (x.id === e.id ? e : x)));

  const categorise = async (entry: fin.Entry, parts: { ledgerAccountId: number; amountMinor: number }[]) => {
    const { bank, net } = splitEntry(entry, accountByLedger, ledgerById);
    if (!bank) return;
    try {
      const updated = await fin.categorise(entry.id, net, parts);
      replace(updated);
      setMsg(null);
      const rule = await fin.suggestRule(entry.id).catch(() => null);
      setSuggestion(rule ? { entry: updated, rule } : null);
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const post = async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const r = await fin.postEntries(ids);
      setMsg(`Posted ${r.posted} ${r.posted === 1 ? 'transaction' : 'transactions'}.`);
      await Promise.all([load(), reloadAll()]);
    } catch (e) {
      setMsg(errText(e));
    }
  };

  /** Everything the filters match, not just the page: confirmed with the count, done on the host. */
  const postAll = async () => {
    if (!(await confirmDialog(postAllConfirm(total, isFiltered(filter), locale)))) return;
    setBulkBusy(true);
    try {
      const r = await fin.postMatching(filter);
      setMsg(postedText(r.posted, r.closed + r.review, locale));
      await Promise.all([load(), reloadAll()]);
    } catch (e) {
      setMsg(bulkErrorText(errText(e)));
      window.setTimeout(() => void Promise.all([load(), reloadAll()]), 8000);
    } finally {
      setBulkBusy(false);
    }
  };

  const categoriseAll = async (ledgerAccountId: number) => {
    const name = ledgerById.get(ledgerAccountId)?.name ?? 'that category';
    if (!(await confirmDialog(categoriseAllConfirm(unsortedTotal, name, locale)))) return;
    setBulkBusy(true);
    try {
      const r = await fin.categoriseMatching(filter, ledgerAccountId);
      setMsg(categorisedText(r.categorised, r.skipped, name, locale));
      await Promise.all([load(), reloadAll()]);
    } catch (e) {
      setMsg(bulkErrorText(errText(e)));
      window.setTimeout(() => void Promise.all([load(), reloadAll()]), 8000);
    } finally {
      setBulkBusy(false);
    }
  };

  const remove = async (entry: fin.Entry) => {
    if (!(await confirmDialog('Delete this transaction? The imported line is kept and marked dismissed, so a re-import won\u2019t bring it back.'))) return;
    try {
      await fin.deleteEntry(entry.id);
      setEntries((l) => l.filter((x) => x.id !== entry.id));
      setTotal((t) => t - 1);
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

  const forget = (id: number) =>
    setSuggested((s) => {
      const n = { ...s };
      delete n[id];
      return n;
    });

  /** The user takes a suggestion: categorise the line as if they had picked it. */
  const takeSuggestion = async (entry: fin.Entry) => {
    const id = suggested[entry.id];
    if (id == null) return;
    const { net } = splitEntry(entry, accountByLedger, ledgerById);
    await categorise(entry, [{ ledgerAccountId: id, amountMinor: Math.abs(net) }]);
    forget(entry.id);
  };

  const takeAllSuggestions = async () => {
    const take = entries.filter((e) => suggested[e.id] != null);
    for (const e of take) {
      const { bank, net } = splitEntry(e, accountByLedger, ledgerById);
      if (!bank) continue;
      try {
        replace(await fin.categorise(e.id, net, [{ ledgerAccountId: suggested[e.id]!, amountMinor: Math.abs(net) }]));
        forget(e.id);
      } catch (err) {
        setMsg(errText(err));
        return;
      }
    }
    setMsg(`Sorted ${take.length} ${take.length === 1 ? 'line' : 'lines'} as suggested.`);
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

  const acceptRule = async () => {
    if (!suggestion) return;
    try {
      await fin.createRule({ ...suggestion.rule, learned: true });
      const r = await fin.applyRules();
      setSuggestion(null);
      setMsg(r.categorised ? `Rule saved. It sorted ${r.categorised} more in the inbox.` : 'Rule saved.');
      if (r.categorised) void load();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const drafts = entries.filter((e) => e.status === 'draft');
  const toAsk = canSuggest ? pickSuggestable(entries.map(suggestRow), suggested, fin.MAX_SUGGEST) : [];
  const ready = entries.filter((e) => suggested[e.id] != null).length;
  const allSelected = drafts.length > 0 && drafts.every((d) => selected.has(d.id));
  const showGroups = view === 'draft' && byPayee && !group;
  const more = !loading && entries.length < total;
  const sentinel = useLoadMore(more && !showGroups, () => void load(true));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="g-seg" role="tablist" aria-label="Which transactions">
          {(
            [
              ['draft', `Inbox${inboxCount ? ` · ${inboxCount}` : ''}`],
              ['posted', 'Posted'],
              ['all', 'All'],
            ] as [StatusView, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className="g-chip"
              onClick={() => {
                setView(v);
                setGroup(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {view === 'draft' && (
          <div className="g-seg" role="tablist" aria-label="How the inbox is shown">
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
        {touch && (
          <button className="g-btn g-btn-ghost g-btn-sm" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
            {moreFilters ? 'Fewer filters' : `More filters${from || to || uncategorised ? ' · on' : ''}`}
          </button>
        )}
        {(!touch || moreFilters) && (
        <>
        <span className={`flex items-center gap-1.5 text-sm ${MUTED}`}>
          From <DateFilter label="From" value={from} onChange={setFrom} />
        </span>
        <span className={`flex items-center gap-1.5 text-sm ${MUTED}`}>
          to <DateFilter label="To" value={to} onChange={setTo} />
        </span>
        <label className={`flex items-center gap-2 text-sm ${MUTED} ${touch ? 'min-h-[44px]' : 'min-h-[32px]'}`}>
          <input type="checkbox" checked={uncategorised} onChange={(e) => setUncategorised(e.target.checked)} /> Unsorted only
        </label>
        </>
        )}
      </div>

      {group && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={MUTED}>Payee:</span>
          <span className="g-tag">{group.label || '(no description)'}</span>
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setGroup(null)}>
            {byPayee ? 'Back to payees' : 'Show all lines'}
          </button>
        </div>
      )}

      {showGroups && <InboxGroups filter={filter} canSuggest={canSuggest} onShowLines={(g) => setGroup({ key: g.key, label: g.label })} />}

      {/* Bulk actions */}
      {!showGroups && drafts.length > 0 && (
        <div className="g-inset flex flex-wrap items-center gap-3 px-3 py-2">
          <label className="flex items-center gap-2 text-sm text-subtext-1">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(drafts.map((d) => d.id)))} aria-label="Select every draft shown" />
            {selectLabel(selected.size, drafts.length, view === 'draft' ? total : drafts.length, locale)}
          </label>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {canSuggest && (toAsk.length > 0 || asking.size > 0) && (
              <button
                className="g-btn g-btn-ghost g-btn-sm"
                disabled={asking.size > 0}
                title="Ask the host's local model for a category for each unsorted line shown. Nothing is applied until you take it."
                onClick={() => void suggest(toAsk)}
              >
                {asking.size > 0 ? 'Suggesting…' : `Suggest categories · ${toAsk.length}`}
              </button>
            )}
            {ready > 0 && (
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => void takeAllSuggestions()}>
                Use {ready} {ready === 1 ? 'suggestion' : 'suggestions'}
              </button>
            )}
            <button className="g-btn g-btn-pri g-btn-sm" disabled={!selected.size} onClick={() => void post([...selected])}>
              Post {selected.size || ''}
            </button>
          </span>
          {view === 'draft' && (
            <span className="w-full flex flex-wrap items-center gap-2 border-t border-gilt-b pt-2">
              <span className={`text-sm ${MUTED}`}>Everything matching, not just the {count(drafts.length, locale)} shown:</span>
              {unsortedTotal > 0 && (
                <AccountPicker
                  label="Categorise all matching"
                  value={null}
                  placeholder={bulkBusy ? 'Working…' : `Categorise all ${count(unsortedTotal, locale)} unsorted as…`}
                  onChange={(id) => void categoriseAll(id)}
                  className="flex-1 min-w-[220px] max-w-[320px]"
                />
              )}
              <button className="g-btn g-btn-ghost g-btn-sm ml-auto" disabled={bulkBusy} onClick={() => void postAll()}>
                Post all {count(total, locale)} matching
              </button>
            </span>
          )}
        </div>
      )}

      {suggestion && (
        <div className="g-card p-4 flex flex-wrap items-center gap-3" role="status">
          <span className="flex-1 min-w-[200px] text-sm text-text">
            Same fix twice. File transactions like <b>{suggestion.entry.payee || suggestion.entry.description}</b> this way from now on?
          </span>
          <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => void acceptRule()}>
            Make it a rule
          </button>
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setSuggestion(null)}>
            Not now
          </button>
        </div>
      )}

      {msg && <p className="text-sm text-subtext-1">{msg}</p>}

      {showGroups ? null : !loading && entries.length === 0 ? (
        <Empty title={view === 'draft' ? 'The inbox is empty' : 'No transactions'}>{view === 'draft' ? 'Imported lines land here to be sorted and posted.' : 'Nothing matches these filters.'}</Empty>
      ) : (
        <div className="g-plain" role="list">
          {entries.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              selected={selected.has(e.id)}
              onSelect={() => toggle(e.id)}
              open={open === e.id}
              onOpen={() => setOpen(open === e.id ? null : e.id)}
              onCategorise={(parts) => categorise(e, parts)}
              onPost={() => void post([e.id])}
              onDelete={() => void remove(e)}
              onReverse={() => void reverse(e)}
              onSpread={() => setSpreading(e)}
              ledgerById={ledgerById}
              accountByLedger={accountByLedger}
              suggestion={suggested[e.id]}
              asking={asking.has(e.id)}
              onSuggest={canSuggest && pickSuggestable([suggestRow(e)], {}, 1).length > 0 ? () => void suggest([e.id]) : undefined}
              onUseSuggestion={() => void takeSuggestion(e)}
              onDismissSuggestion={() => forget(e.id)}
            />
          ))}
        </div>
      )}
      {spreading && <SpreadDialog entry={spreading} onClose={() => setSpreading(null)} onDone={() => void reloadAll()} />}
      {!showGroups && (
      <div ref={sentinel} className={`flex items-center gap-3 text-sm ${MUTED}`}>
        {loading ? 'Loading…' : `${count(entries.length, locale)} of ${count(total, locale)}`}
        {more && (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void load(true)}>
            Show more
          </button>
        )}
      </div>
      )}
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

function EntryRow({
  entry,
  selected,
  onSelect,
  open,
  onOpen,
  onCategorise,
  onPost,
  onDelete,
  onReverse,
  onSpread,
  ledgerById,
  accountByLedger,
  suggestion,
  asking,
  onSuggest,
  onUseSuggestion,
  onDismissSuggestion,
}: {
  entry: fin.Entry;
  selected: boolean;
  onSelect: () => void;
  open: boolean;
  onOpen: () => void;
  onCategorise: (parts: { ledgerAccountId: number; amountMinor: number }[]) => Promise<void>;
  onPost: () => void;
  onDelete: () => void;
  onReverse: () => void;
  onSpread: () => void;
  ledgerById: Map<number, fin.LedgerAccount>;
  accountByLedger: Map<number, fin.FinAccount>;
  /** The local model's category for this line (null: nothing fits; undefined: not asked). */
  suggestion: number | null | undefined;
  asking: boolean;
  /** Set when this line can be suggested for. */
  onSuggest?: () => void;
  onUseSuggestion: () => void;
  onDismissSuggestion: () => void;
}) {
  const { locale, entity, lockedThrough } = useFinance();
  const locked = isLocked(entry.date, lockedThrough);
  const { bank, account, others, fee, net } = splitEntry(entry, accountByLedger, ledgerById);
  const draft = entry.status === 'draft';
  const single = others.length === 1 ? others[0] : null;
  const unsorted = others.some((l) => isUncategorised(ledgerById.get(l.ledger_account_id)));
  const journalSize = entry.lines.reduce((s, l) => s + Math.max(0, l.functional_minor), 0);

  return (
    <div role="listitem" className={`border-b border-gilt-b ${open ? 'bg-base' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-h-[52px] px-3 py-1.5">
        <span className="w-5 flex justify-center">
          {draft && <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${entry.description}`} />}
        </span>
        <button className="flex-1 min-w-[160px] text-left" onClick={onOpen} aria-expanded={open}>
          <span className="block text-text truncate">{entry.payee || entry.description}</span>
          <span className={`block text-xs ${MUTED} truncate`}>
            {formatDate(entry.date, locale)}
            {account ? ` · ${account.name}` : ' · Journal entry'}
            {entry.payee && entry.description !== entry.payee ? ` · ${entry.description}` : ''}
          </span>
        </button>
        <span className="flex items-center gap-2 order-last sm:order-none w-full sm:w-[220px] pl-8 sm:pl-0">
          {bank && single && (locked || entry.scheduled || !isCategory(ledgerById.get(single.ledger_account_id))) ? (
            <span className={`text-sm truncate ${MUTED}`}>{ledgerById.get(single.ledger_account_id)?.name ?? '—'}</span>
          ) : bank && (single ? (
            <AccountPicker
              label="Category"
              value={single.ledger_account_id}
              onChange={(id) => void onCategorise([{ ledgerAccountId: id, amountMinor: Math.abs(net) }])}
              className="flex-1 min-w-0"
            />
          ) : (
            <button className="g-field g-field-sm text-left flex-1 min-w-0 truncate" onClick={onOpen}>
              Split · {others.length}
            </button>
          ))}
        </span>
        <span className="flex items-center gap-2 ml-auto">
          {entry.pair && <span className={`g-tag ${entry.pair.status === 'review' ? 'g-tag-warn' : ''}`} title="Matched with a transfer between your accounts">{entry.pair.kind === 'fx' ? 'Exchange' : 'Transfer'}</span>}
          {onSuggest && suggestion === undefined && (
            <button className="g-btn g-btn-ghost g-btn-sm" disabled={asking} onClick={onSuggest} title="Ask the host's local model for a category">
              {asking ? 'Suggesting…' : 'Suggest'}
            </button>
          )}
          {draft && unsorted && <span className="g-tag g-tag-pri">Unsorted</span>}
          {entry.status === 'reversed' && <span className="g-tag">Reversed</span>}
          {locked && <span className="g-tag" title="This month is closed">Closed</span>}
          {bank ? <Money minor={bank.amount_minor} currency={bank.currency} colour className="w-[110px] text-right" /> : <Money minor={journalSize} currency={entity.functional_currency} className="w-[110px] text-right" />}
        </span>
      </div>
      {suggestion !== undefined && (
        <div className="flex flex-wrap items-center gap-2 pl-11 pr-3 pb-2 text-sm" role="status">
          {suggestion === null ? (
            <span className={`flex-1 ${MUTED}`}>No category fits, says the local model.</span>
          ) : (
            <>
              <span className={MUTED}>Suggested:</span>
              <span className="g-tag">{ledgerById.get(suggestion)?.name ?? '—'}</span>
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={onUseSuggestion}>
                Use it
              </button>
            </>
          )}
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={onDismissSuggestion}>
            Dismiss
          </button>
        </div>
      )}
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
          {!locked && !entry.scheduled && bank && others.every((l) => isCategory(ledgerById.get(l.ledger_account_id))) && <SplitsEditor entry={entry} bank={bank} net={net} fee={fee} others={others} onSave={onCategorise} />}
          {entry.notes && <p className={`text-sm ${MUTED}`}>{entry.notes}</p>}
          <div className="flex flex-wrap gap-2">
            {draft && !locked && (
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={onPost}>
                Post
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
