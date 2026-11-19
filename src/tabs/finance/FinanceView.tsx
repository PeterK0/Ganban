// The Finance view: a page with nine sections (docs/design/FINANCE.md § The interface). Everyday
// sections speak plainly (money in, money out, categories); Accounting is where debits and credits are.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScrollArea from '../../components/ScrollArea';
import { useRailShell } from '../../components/RailViews';
import * as fin from './api';
import { lockedThrough } from './reports.pure';
import { FinanceContext, MUTED, errText, type FinanceData, type FinanceTab, type TransactionsOpen } from './shared';
import { usesFromPayees } from './sorting.pure';

const Overview = lazy(() => import('./Overview'));
const Transactions = lazy(() => import('./Transactions'));
const Accounts = lazy(() => import('./Accounts'));
const ImportView = lazy(() => import('./Import'));
const Accounting = lazy(() => import('./Accounting'));
const Budgets = lazy(() => import('./Budgets'));
const ForecastView = lazy(() => import('./Forecast'));
const Statements = lazy(() => import('./Statements'));
const Settings = lazy(() => import('./Settings'));
const QuickCash = lazy(() => import('./QuickCash'));

const TABS: { id: FinanceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'statements', label: 'Statements' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'import', label: 'Import' },
  { id: 'accounting', label: 'Accounting' },
  { id: 'settings', label: 'Settings' },
];

/** The last section, a cosmetic per-device preference. */
const TAB_KEY = 'ganban:finance-tab';

export default function FinanceView() {
  // In the phone shell the screen's own header carries the title and the back button; the sections
  // become a row of chips under it, beside a button that adds a cash expense.
  const touch = useRailShell() === 'touch';
  const [quickCash, setQuickCash] = useState(false);
  const chips = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<FinanceTab>(() => {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? (t as FinanceTab) : 'overview';
  });
  const [txOpen, setTxOpen] = useState<TransactionsOpen | undefined>(undefined);
  const [summary, setSummary] = useState<fin.InboxSummary | null>(null);
  const [categoryUses, setCategoryUses] = useState<Map<number, number>>(new Map());
  const [entity, setEntity] = useState<fin.Entity | null>(null);
  const [accounts, setAccounts] = useState<fin.FinAccount[]>([]);
  const [ledger, setLedger] = useState<fin.LedgerAccount[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [periods, setPeriods] = useState<fin.Period[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // The entity first: the host makes it and its chart on first use.
      const e = await fin.getEntity();
      const [acc, led, sum, review, per] = await Promise.all([
        fin.listAccounts(true),
        fin.listLedgerAccounts(true),
        fin.inboxSummary().catch(() => null),
        fin.listPairs('review').catch(() => [] as fin.Pair[]),
        fin.listPeriods().catch(() => [] as fin.Period[]),
      ]);
      setEntity(e);
      setAccounts(acc);
      setLedger(led);
      setSummary(sum);
      setInboxCount(sum ? sum.decisions : (await fin.listEntries({ status: 'draft' }, 1)).total);
      setReviewCount(review.length);
      setPeriods(per);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    // The picker's order: the categories the payees file most lines under. Read once per visit.
    fin.listPayees({}, 500).then((r) => setCategoryUses(usesFromPayees(r.payees))).catch(() => {});
  }, [reload]);

  // Keep the chosen section's chip in view (Finance reopens on the last section), also once the
  // count badges arrive and widen the chips before it.
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [tab, inboxCount, reviewCount]);

  const go = (t: FinanceTab, opts?: TransactionsOpen) => {
    setTab(t);
    setTxOpen(opts);
    localStorage.setItem(TAB_KEY, t);
  };

  const data: FinanceData | null = useMemo(() => {
    if (!entity) return null;
    return {
      entity,
      accounts,
      ledger,
      ledgerById: new Map(ledger.map((l) => [l.id, l])),
      accountByLedger: new Map(accounts.map((a) => [a.ledger_account_id, a])),
      inboxCount,
      reviewCount,
      summary,
      categoryUses,
      periods,
      lockedThrough: lockedThrough(periods),
      locale: undefined,
      reload,
      goto: go,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, accounts, ledger, inboxCount, reviewCount, summary, categoryUses, periods, reload]);

  const badge = (t: FinanceTab, cls = '') =>
    t === 'transactions' && inboxCount > 0 ? (
      <span className={`g-tag g-tag-pri !min-h-[18px] !px-1.5 text-[11px] ${cls}`}>{inboxCount}</span>
    ) : t === 'import' && reviewCount > 0 ? (
      <span className={`g-tag g-tag-warn !min-h-[18px] !px-1.5 text-[11px] ${cls}`}>{reviewCount}</span>
    ) : null;

  return (
    <div className="h-full flex flex-col bg-mantle">
      {touch ? (
        <div className="flex-none flex items-center border-b border-gilt-b">
          <ScrollArea direction="horizontal" autoHide thumbSize={4} className="flex-1 min-w-0" contentClassName="w-max">
            <div ref={chips} className="flex gap-1.5 px-3 py-2" role="tablist" aria-label="Finance sections">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)} className="g-chip">
                  {t.label}
                  {badge(t.id)}
                </button>
              ))}
            </div>
          </ScrollArea>
          <button className="g-btn g-btn-gilt flex-none mx-2 px-3" onClick={() => setQuickCash(true)} disabled={!data} aria-label="Add a cash expense">
            + Cash
          </button>
        </div>
      ) : (
      <div className="px-4 sm:px-8 pt-[30px] border-b border-gilt-b">
        <div className="g-deco text-xs text-gold">{entity ? `${entity.name} · ${entity.functional_currency}` : 'Personal ledger'}</div>
        <h1 className="g-ptitle text-text">Finance</h1>
        <ScrollArea direction="horizontal" autoHide thumbSize={4} className="mt-3 -mb-px" contentClassName="flex gap-1 w-max">
        <div className="flex gap-1" role="tablist" aria-label="Finance sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)} className="g-dtab">
              {t.label}
              {badge(t.id, 'ml-2')}
            </button>
          ))}
        </div>
        </ScrollArea>
      </div>
      )}
      <ScrollArea className="flex-1 min-h-0" contentClassName={touch ? 'px-3 pt-4 pb-10' : 'px-4 sm:px-8 pt-6 pb-16'}>
        {error ? (
          <div className="g-card p-5 space-y-3">
            <p className="text-error text-sm">Finance couldn't load: {error}</p>
            <button className="g-btn g-btn-ghost" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <p className={`text-sm ${MUTED}`}>Loading…</p>
        ) : (
          <FinanceContext.Provider value={data}>
            <Suspense fallback={<p className={`text-sm ${MUTED}`}>Loading…</p>}>
              {tab === 'overview' && <Overview />}
              {tab === 'transactions' && <Transactions key={JSON.stringify(txOpen ?? {})} open={txOpen} />}
              {tab === 'accounts' && <Accounts />}
              {tab === 'import' && <ImportView />}
              {tab === 'budgets' && <Budgets />}
              {tab === 'forecast' && <ForecastView />}
              {tab === 'statements' && <Statements />}
              {tab === 'accounting' && <Accounting />}
              {tab === 'settings' && <Settings />}
            </Suspense>
            {quickCash && (
              <Suspense fallback={null}>
                <QuickCash onClose={() => setQuickCash(false)} />
              </Suspense>
            )}
          </FinanceContext.Provider>
        )}
      </ScrollArea>
    </div>
  );
}
