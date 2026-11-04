// Overview: net worth by account, this month against the budgets, the forecast band for the month's
// end, and what needs the user (the inbox and the review list).
import { useEffect, useState } from 'react';
import { DecoHeading } from '../../components/gilt';
import * as fin from './api';
import { todayIso } from './money.pure';
import { BudgetBar, ForecastBand } from './reportParts';
import { elapsedFraction, formatMonth, monthOf, netWorth } from './reports.pure';
import { MUTED, Money, Empty, useFinance } from './shared';

const KIND_LABEL: Record<string, string> = { current: 'Current', savings: 'Savings', card: 'Card', cash: 'Cash', loan: 'Loan' };

export default function Overview() {
  const { accounts, entity, inboxCount, reviewCount, goto, locale } = useFinance();
  const today = todayIso();
  const month = monthOf(today);
  const [budgets, setBudgets] = useState<fin.BudgetProgressRow[] | null>(null);
  const [forecast, setForecast] = useState<fin.Forecast | null>(null);
  useEffect(() => {
    // Either may fail on its own (no history yet); the overview shows what it has.
    fin.budgetProgress(month).then(setBudgets, () => setBudgets(null));
    fin.forecast(month).then(setForecast, () => setForecast(null));
  }, [month, accounts]);
  const nw = netWorth(accounts);
  const projected = new Map((forecast?.categories ?? []).map((c) => [c.ledger_account_id, c.projected_minor]));
  const live = nw.groups.flatMap((g) => g.accounts);
  const fun = entity.functional_currency;

  return (
    <div className="space-y-6">
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        <button className="g-card g-corners p-5 text-left hover:bg-surface-0 transition-colors" onClick={() => goto('transactions')}>
          <div className="g-flbl">Inbox</div>
          <div className="text-3xl text-text tabular-nums">{inboxCount}</div>
          <div className={`text-sm ${MUTED}`}>{inboxCount === 1 ? 'transaction to sort and post' : 'transactions to sort and post'}</div>
        </button>
        <button className="g-card p-5 text-left hover:bg-surface-0 transition-colors" onClick={() => goto('import')}>
          <div className="g-flbl">To review</div>
          <div className="text-3xl text-text tabular-nums">{reviewCount}</div>
          <div className={`text-sm ${MUTED}`}>{reviewCount === 1 ? 'possible transfer to confirm' : 'possible transfers to confirm'}</div>
        </button>
        <div className="g-card p-5">
          <div className="g-flbl">Net worth</div>
          <Money minor={nw.net} currency={fun} className="text-3xl text-text" />
          <div className={`text-sm ${MUTED}`}>
            <Money minor={nw.assets} currency={fun} /> owned, <Money minor={nw.liabilities} currency={fun} /> owed, across your accounts
          </div>
        </div>
      </div>

      {(forecast || (budgets && budgets.length > 0)) && (
        <div className="grid gap-6 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
          {forecast && (
            <section className="g-card p-5 space-y-3">
              <div className="flex items-baseline gap-3">
                <span className="g-stitle flex-1">End of {formatMonth(month, locale)}</span>
                <button className="g-lnk text-sm" onClick={() => goto('forecast')}>
                  Forecast
                </button>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <Money minor={forecast.end_minor} currency={fun} className="text-2xl text-text" />
                <span className={`text-sm ${MUTED}`}>
                  expected cash, <Money minor={forecast.low_minor} currency={fun} /> to <Money minor={forecast.high_minor} currency={fun} />
                </span>
              </div>
              <ForecastBand band={{ current: forecast.opening_minor, low: forecast.low_minor, expected: forecast.end_minor, high: forecast.high_minor }} currency={fun} compact />
            </section>
          )}
          {budgets && budgets.length > 0 && (
            <section className="g-card p-5 space-y-2">
              <div className="flex items-baseline gap-3">
                <span className="g-stitle flex-1">This month against budgets</span>
                <button className="g-lnk text-sm" onClick={() => goto('budgets')}>
                  Budgets
                </button>
              </div>
              {forecast && forecast.warnings.length > 0 && (
                <p className="text-sm text-warning" role="status">
                  The forecast goes over in {forecast.warnings.map((w) => w.name).join(', ')}.
                </p>
              )}
              {[...budgets]
                .sort((a, b) => b.actual_minor / Math.max(1, b.target_minor) - a.actual_minor / Math.max(1, a.target_minor))
                .slice(0, 6)
                .map((b) => (
                  <BudgetBar
                    key={b.ledger_account_id}
                    name={b.name}
                    spent={b.actual_minor}
                    target={b.target_minor}
                    elapsed={elapsedFraction(month, today)}
                    projected={projected.get(b.ledger_account_id) ?? null}
                    currency={fun}
                  />
                ))}
              {budgets.length > 6 && <p className={`text-xs ${MUTED}`}>and {budgets.length - 6} more on Budgets</p>}
            </section>
          )}
        </div>
      )}

      <section>
        <DecoHeading>Net worth by account</DecoHeading>
        {live.length === 0 ? (
          <Empty title="No accounts yet">
            <button className="g-lnk" onClick={() => goto('accounts')}>
              Add one
            </button>{' '}
            or{' '}
            <button className="g-lnk" onClick={() => goto('import')}>
              import a statement
            </button>
          </Empty>
        ) : (
          <div className="space-y-4">
            {nw.groups.map((g) => (
              <div key={g.key} className="g-plain">
                <div className="flex items-center gap-3 px-4 min-h-[34px] border-b border-gilt-b">
                  <span className="g-cap flex-1">{g.label}</span>
                  <Money minor={g.total} currency={fun} className="g-cap" />
                </div>
                {g.accounts.map((a) => (
                  <button key={a.id} className="g-frow w-full text-left hover:bg-surface-0 !px-4" onClick={() => goto('transactions', { accountId: a.id })}>
                    <span className="flex-1 min-w-0">
                      <span className="block text-text truncate">{a.name}</span>
                      <span className={`block text-xs ${MUTED} truncate`}>
                        {[KIND_LABEL[a.kind] ?? a.kind, a.institution, a.iban_mask, a.archived ? 'archived' : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money minor={a.balance_minor} currency={a.currency} className="block text-text" />
                      {a.currency !== fun && <Money minor={a.balance_functional_minor} currency={fun} className={`block text-xs ${MUTED}`} />}
                      {!!a.draft_balance_minor && (
                        <span className={`block text-xs ${MUTED}`}>
                          <Money minor={a.draft_balance_minor} currency={a.currency} signed /> in the inbox
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
