// Budgets: a monthly target per expense category, this month's progress against it (by recognition
// period, with the forecast's end of month as a dashed reach), and the last six months.
import { useCallback, useEffect, useMemo, useState } from 'react';
import ScrollArea from '../../components/ScrollArea';
import { DecoHeading } from '../../components/gilt';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { formatMoney, formatMoneyShort, parseMoney, toInput, todayIso } from './money.pure';
import { BudgetBar } from './reportParts';
import { addMonths, elapsedFraction, formatMonth, monthOf } from './reports.pure';
import { Empty, MUTED, categories, errText, useFinance } from './shared';

const HISTORY = 6;

export default function Budgets() {
  const { ledger, entity, locale } = useFinance();
  const fun = entity.functional_currency;
  const today = todayIso();
  const month = monthOf(today);
  const [budgets, setBudgets] = useState<fin.Budget[] | null>(null);
  const [progress, setProgress] = useState<Map<string, fin.BudgetProgressRow[]>>(new Map());
  const [forecast, setForecast] = useState<fin.Forecast | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  const months = useMemo(() => Array.from({ length: HISTORY }, (_, i) => addMonths(month, -i)), [month]);

  const load = useCallback(async () => {
    try {
      const [b, ...prog] = await Promise.all([fin.listBudgets(), ...months.map((m) => fin.budgetProgress(m))]);
      setBudgets(b);
      setProgress(new Map(months.map((m, i) => [m, prog[i]])));
      setMsg(null);
    } catch (e) {
      setMsg(errText(e));
    }
    fin.forecast(month).then(setForecast, () => setForecast(null));
  }, [months, month]);
  useEffect(() => {
    void load();
  }, [load]);

  const standing = useMemo(() => new Map((budgets ?? []).filter((b) => b.month == null).map((b) => [b.ledger_account_id, b])), [budgets]);
  const thisMonthOverride = useMemo(() => new Map((budgets ?? []).filter((b) => b.month === month).map((b) => [b.ledger_account_id, b])), [budgets, month]);
  const projected = useMemo(() => new Map((forecast?.categories ?? []).map((c) => [c.ledger_account_id, c.projected_minor])), [forecast]);
  const now = useMemo(() => new Map((progress.get(month) ?? []).map((p) => [p.ledger_account_id, p])), [progress, month]);
  // FX differences and the uncategorised bucket aren't spending anyone plans; bank fees are.
  const expenses = useMemo(() => categories(ledger).filter((l) => l.class === 'expense' && (!l.system_key || l.system_key === 'bank_fees')), [ledger]);
  const withTarget = expenses.filter((l) => standing.has(l.id) || now.has(l.id));
  const without = expenses.filter((l) => !standing.has(l.id) && !now.has(l.id));
  const elapsed = elapsedFraction(month, today);
  const totals = (progress.get(month) ?? []).reduce((t, p) => ({ target: t.target + p.target_minor, actual: t.actual + p.actual_minor }), { target: 0, actual: 0 });

  const parsed = text.trim() ? parseMoney(text, fun, locale) : null;
  const saveTarget = async (la: fin.LedgerAccount) => {
    const b = standing.get(la.id);
    try {
      if (!text.trim()) {
        if (!b) {
          setEditing(null);
          return;
        }
        if (!(await confirmDialog(`Remove the monthly target for ${la.name}?`))) return;
        await fin.deleteBudget(b.id);
      } else if (parsed == null || parsed <= 0) {
        setMsg("That isn't an amount above zero.");
        return;
      } else if (b) await fin.updateBudget(b.id, parsed);
      else await fin.createBudget({ ledgerAccountId: la.id, amountMinor: parsed });
      setEditing(null);
      await load();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const dropOverride = async (override: fin.Budget) => {
    try {
      await fin.deleteBudget(override.id);
      await load();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const editor = (la: fin.LedgerAccount) => (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void saveTarget(la);
      }}
    >
      <input className="g-field g-field-sm !w-[120px] text-right tabular-nums" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label={`Monthly target for ${la.name}`} aria-invalid={!!text.trim() && (parsed == null || parsed <= 0)} placeholder="0" />
      <span className={`text-xs ${MUTED}`}>{fun} a month</span>
      <button type="submit" className="g-btn g-btn-gilt g-btn-sm">
        Save
      </button>
      <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => setEditing(null)}>
        Cancel
      </button>
    </form>
  );
  const startEdit = (la: fin.LedgerAccount) => {
    const b = standing.get(la.id);
    setEditing(la.id);
    setText(b ? toInput(b.amount_minor, fun, locale) : '');
    setMsg(null);
  };

  if (!budgets) return msg ? <p className="text-sm text-error">{msg}</p> : <p className={`text-sm ${MUTED}`}>Loading…</p>;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-4">
          <DecoHeading>{formatMonth(month, locale)}</DecoHeading>
          {totals.target > 0 && (
            <span className={`text-sm ${MUTED} tabular-nums`}>
              {formatMoney(totals.actual, fun, locale)} of {formatMoney(totals.target, fun, locale)} spent · {Math.round(elapsed * 100)}% of the month gone
            </span>
          )}
        </div>
        {msg && <p className="text-sm text-error">{msg}</p>}
        {withTarget.length === 0 ? (
          <Empty title="No budgets yet">Set a monthly target on a category below. Spending counts by the month it belongs to, so a spread payment counts a share each month.</Empty>
        ) : (
          <div className="grid gap-x-8 gap-y-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))' }}>
            {withTarget.map((la) => {
              const p = now.get(la.id);
              const target = p?.target_minor ?? standing.get(la.id)?.amount_minor ?? 0;
              return (
                <div key={la.id} className="g-card px-4 py-3">
                  {editing === la.id ? (
                    <div className="space-y-2">
                      <div className="text-sm text-text">{la.name}</div>
                      {editor(la)}
                    </div>
                  ) : (
                    <>
                      <BudgetBar name={la.name} spent={p?.actual_minor ?? 0} target={target} elapsed={elapsed} projected={projected.get(la.id) ?? null} currency={fun} />
                      <div className="flex gap-3 text-xs">
                        <button className="g-lnk" onClick={() => startEdit(la)}>
                          Change target
                        </button>
                        {thisMonthOverride.has(la.id) && (
                          <>
                            <span className={MUTED}>This month has its own target.</span>
                            <button className="g-lnk" onClick={() => void dropOverride(thisMonthOverride.get(la.id)!)}>
                              Use the monthly one
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {forecast && forecast.warnings.length > 0 && (
          <p className="text-sm text-warning" role="status">
            The forecast goes over in {forecast.warnings.map((w) => `${w.name} (by ${formatMoney(w.over_minor, fun, locale)})`).join(', ')}.
          </p>
        )}
      </section>

      {without.length > 0 && (
        <section className="space-y-2 max-w-[720px]">
          <DecoHeading>Categories without a target</DecoHeading>
          <div className="g-plain">
            {without.map((la) => (
              <div key={la.id} className="g-frow !min-h-[44px] text-sm">
                <span className="flex-1 min-w-0 truncate text-subtext-1">{la.name}</span>
                {editing === la.id ? (
                  editor(la)
                ) : (
                  <button className="g-lnk text-xs" onClick={() => startEdit(la)}>
                    Set a target
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {withTarget.length > 0 && <History months={months} progress={progress} rows={withTarget} />}
    </div>
  );
}

/** The last months: spent against the target per category, over in red. */
function History({ months, progress, rows }: { months: string[]; progress: Map<string, fin.BudgetProgressRow[]>; rows: fin.LedgerAccount[] }) {
  const { entity, locale } = useFinance();
  const fun = entity.functional_currency;
  const cols = useMemo(() => [...months].reverse(), [months]);
  const by = useMemo(() => new Map(cols.map((m) => [m, new Map((progress.get(m) ?? []).map((p) => [p.ledger_account_id, p]))])), [cols, progress]);
  const short = (v: number) => formatMoneyShort(v, fun, locale);
  return (
    <section className="space-y-2">
      <DecoHeading>The last {cols.length} months</DecoHeading>
      <ScrollArea direction="horizontal" autoHide thumbSize={4}>
        <table className="text-sm min-w-[640px] w-full">
          <thead>
            <tr className="border-b border-gilt-b">
              <th className="g-cap text-left font-normal py-2 pr-3">Category</th>
              {cols.map((m) => (
                <th key={m} className="g-cap text-right font-normal py-2 px-2">
                  {formatMonth(m, locale, 'short')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((la) => (
              <tr key={la.id} className="border-b border-gilt-b">
                <td className="py-1.5 pr-3 text-subtext-1 truncate max-w-[220px]">{la.name}</td>
                {cols.map((m) => {
                  const p = by.get(m)?.get(la.id);
                  return (
                    <td key={m} className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                      {p ? (
                        <span title={`Target ${formatMoney(p.target_minor, fun, locale)}`} className={p.actual_minor > p.target_minor ? 'text-error' : 'text-text'}>
                          {short(p.actual_minor)}
                          <span className={`text-xs ${MUTED}`}> / {short(p.target_minor)}</span>
                        </span>
                      ) : (
                        <span className={MUTED}>–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </section>
  );
}
