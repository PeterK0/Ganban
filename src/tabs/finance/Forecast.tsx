// Forecast: the cash balance at a month's end with its low–high band, explained line by line (the
// balance now, confirmed recurring items, planned one-offs and category medians), the projection per
// category, and the two inputs the user steers: recurring items (confirm or dismiss what the host
// detected) and planned one-offs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DecoHeading } from '../../components/gilt';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { formatDate, parseMoney, toInput, todayIso } from './money.pure';
import { ForecastBand } from './reportParts';
import { addMonths, formatMonth, monthOf } from './reports.pure';
import { AccountPicker, Empty, MUTED, Money, errText, useFinance } from './shared';

const KIND_LABEL: Record<fin.ForecastLine['kind'], string> = { opening: 'Now', actual: 'Actual', recurring: 'Recurring', planned: 'Planned', category: 'Typical' };
const CADENCE: Record<fin.Cadence, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

export default function Forecast() {
  const { entity, locale } = useFinance();
  const fun = entity.functional_currency;
  const today = todayIso();
  const thisMonth = monthOf(today);
  const [month, setMonth] = useState(thisMonth);
  const [f, setF] = useState<fin.Forecast | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const refresh = () => setSeq((n) => n + 1);

  useEffect(() => {
    let live = true;
    fin.forecast(month).then(
      (r) => live && (setF(r), setMsg(null)),
      (e) => live && (setF(null), setMsg(errText(e))),
    );
    return () => {
      live = false;
    };
  }, [month, seq]);

  const months = [thisMonth, addMonths(thisMonth, 1), addMonths(thisMonth, 2)];
  const past = f && f.month < thisMonth;
  const lines = f?.lines.filter((l) => l.kind !== 'opening') ?? [];

  return (
    <div className="space-y-8">
      <div className="g-seg" role="tablist" aria-label="Month">
        {months.map((m) => (
          <button key={m} role="tab" aria-selected={month === m} className="g-chip" onClick={() => setMonth(m)}>
            {formatMonth(m, locale)}
          </button>
        ))}
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {f && (
        <>
          <section className="g-card g-corners p-5 space-y-4">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="g-flbl !mb-0">Cash at the end of {formatMonth(f.month, locale)}</span>
              <Money minor={f.end_minor} currency={fun} className="text-3xl text-text" />
              {!past && (
                <span className={`text-sm ${MUTED} tabular-nums`}>
                  likely between <Money minor={f.low_minor} currency={fun} /> and <Money minor={f.high_minor} currency={fun} />
                </span>
              )}
            </div>
            {!past && <ForecastBand band={{ current: f.opening_minor, low: f.low_minor, expected: f.end_minor, high: f.high_minor }} currency={fun} />}
            <p className={`text-xs ${MUTED}`}>
              Cash is your current, savings and cash accounts, less what's on your cards, inbox included. As of {formatDate(f.as_of, locale)}.
            </p>
          </section>

          {f.warnings.length > 0 && (
            <div className="g-card p-4 border-l-2 border-warning space-y-1" role="status">
              <div className="text-sm font-semibold text-warning">Heading over budget</div>
              {f.warnings.map((w) => (
                <div key={w.ledger_account_id} className="text-sm text-subtext-1">
                  {w.name}: about <Money minor={w.projected_minor} currency={fun} /> against <Money minor={w.budget_minor} currency={fun} />, <Money minor={w.over_minor} currency={fun} /> over.
                </div>
              ))}
            </div>
          )}

          <section className="space-y-2 max-w-[900px]">
            <DecoHeading>How it adds up</DecoHeading>
            <div className="g-plain text-sm">
              <div className="g-frow !min-h-[40px]">
                <span className="g-tag w-[84px] justify-center hidden sm:inline-flex">{f.month === thisMonth ? KIND_LABEL.opening : 'Start'}</span>
                <span className="flex-1 text-text">{f.lines.find((l) => l.kind === 'opening')?.label ?? 'Cash now'}</span>
                <Money minor={f.opening_minor} currency={fun} className="w-[120px] text-right text-text" />
                <span className="hidden sm:block w-[200px]" />
              </div>
              {lines.length === 0 && <p className={`py-3 px-1 ${MUTED}`}>Nothing else expected this month.</p>}
              {lines.map((l, i) => (
                <div key={i} className="g-frow !min-h-[40px]">
                  <span className="g-tag w-[84px] justify-center hidden sm:inline-flex">{KIND_LABEL[l.kind] ?? l.kind}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-subtext-1">{l.label}</span>
                    {
                      <span className={`block text-xs ${MUTED} ${l.date ? '' : 'sm:hidden'}`}>
                        <span className="sm:hidden">{KIND_LABEL[l.kind] ?? l.kind}</span>
                        {l.date && <span className="sm:hidden"> · </span>}
                        {l.date && formatDate(l.date, locale)}
                      </span>
                    }
                  </span>
                  <Money minor={l.amount_minor} currency={fun} signed colour className="w-[120px] text-right" />
                  <span className={`hidden sm:block w-[200px] text-right text-xs ${MUTED} tabular-nums`}>
                    {l.low_minor !== l.high_minor && (
                      <>
                        <Money minor={l.low_minor} currency={fun} signed /> to <Money minor={l.high_minor} currency={fun} signed />
                      </>
                    )}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-3 px-1 min-h-[42px] border-t-2 border-gilt-b font-semibold text-text">
                <span className="w-[84px] hidden sm:block" />
                <span className="flex-1">End of month</span>
                <Money minor={f.end_minor} currency={fun} className="w-[120px] text-right" />
                <span className={`hidden sm:block w-[200px] text-right text-xs font-normal ${MUTED}`}>
                  {f.low_minor !== f.high_minor && (
                    <>
                      <Money minor={f.low_minor} currency={fun} /> to <Money minor={f.high_minor} currency={fun} />
                    </>
                  )}
                </span>
              </div>
            </div>
          </section>

          {f.categories.length > 0 && <Categories f={f} />}
        </>
      )}

      <Recurring onChange={refresh} />
      <PlannedItems onChange={refresh} />
    </div>
  );
}

/** Each category's projection: the typical month (median), what's happened, where it lands. */
function Categories({ f }: { f: fin.Forecast }) {
  const { entity } = useFinance();
  const fun = entity.functional_currency;
  const rows = [...f.categories].sort((a, b) => (a.class === b.class ? b.projected_minor - a.projected_minor : a.class === 'expense' ? -1 : 1));
  const COL = 'w-[84px] sm:w-[116px] shrink-0 text-right';
  return (
    <section className="space-y-2 max-w-[900px]">
      <DecoHeading>By category</DecoHeading>
      <p className={`text-sm ${MUTED} g-read`}>
        A category's typical month is the median of its last three to six complete months; the forecast adds what's still to come, never less than what's already happened.
      </p>
      <div className="g-plain text-sm">
        <div className="flex items-center gap-3 px-1 min-h-[36px] border-b border-gilt-b">
          <span className="g-cap flex-1">Category</span>
          <span className={`g-cap ${COL} hidden sm:block`}>Typical</span>
          <span className={`g-cap ${COL}`}>So far</span>
          <span className={`g-cap ${COL}`}>Forecast</span>
          <span className={`g-cap ${COL} hidden sm:block`}>Budget</span>
        </div>
        {rows.map((c) => {
          const over = c.budget_minor != null && c.projected_minor > c.budget_minor;
          return (
            <div key={c.ledger_account_id} className="g-frow !min-h-[38px]">
              <span className="flex-1 min-w-0">
                <span className="block break-words text-subtext-1">{c.name}</span>
                <span className={`block text-xs ${MUTED}`}>
                  {c.class === 'income' ? 'Income' : 'Spending'}
                  <span className="hidden sm:inline"> · {c.history_months} months of history</span>
                </span>
              </span>
              <Money minor={c.median_minor} currency={fun} className={`${COL} hidden sm:block ${MUTED}`} />
              <Money minor={c.actual_minor} currency={fun} className={`${COL} text-subtext-1`} />
              <Money minor={c.projected_minor} currency={fun} className={`${COL} ${over ? 'text-warning font-semibold' : 'text-text'}`} />
              <span className={`${COL} hidden sm:block ${MUTED}`}>{c.budget_minor != null ? <Money minor={c.budget_minor} currency={fun} /> : '–'}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Recurring({ onChange }: { onChange: () => void }) {
  const { entity, locale } = useFinance();
  const fun = entity.functional_currency;
  const [items, setItems] = useState<fin.Recurring[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fin.listRecurring().then(setItems, (e) => setMsg(errText(e)));
  }, []);

  const detect = async () => {
    setBusy(true);
    try {
      setItems(await fin.detectRecurring());
      setMsg(null);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (r: fin.Recurring, confirm: boolean) => {
    try {
      const u = await fin.resolveRecurring(r.id, confirm);
      setItems((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)));
      onChange();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const suggested = (items ?? []).filter((r) => r.status === 'suggested');
  const confirmed = (items ?? []).filter((r) => r.status === 'confirmed');
  const row = (r: fin.Recurring) => (
    <div key={r.id} className="g-frow !min-h-[48px] text-sm flex-wrap">
      <span className="flex-1 min-w-[180px]">
        <span className="block truncate text-text">{r.label}</span>
        <span className={`block text-xs ${MUTED}`}>
          {CADENCE[r.cadence] ?? r.cadence} · seen {r.occurrences} times since {formatDate(r.first_date, locale)} · next {formatDate(r.next_date, locale)}
        </span>
      </span>
      <span className="text-right">
        <Money minor={r.amount_minor} currency={fun} signed colour className="block" />
        {r.amount_low_minor !== r.amount_high_minor && (
          <span className={`block text-xs ${MUTED}`}>
            <Money minor={r.amount_low_minor} currency={fun} /> to <Money minor={r.amount_high_minor} currency={fun} />
          </span>
        )}
      </span>
      <span className="flex gap-2 w-full sm:w-auto justify-end">
        {r.status === 'suggested' ? (
          <>
            <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => void resolve(r, true)}>
              Confirm
            </button>
            <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void resolve(r, false)}>
              Dismiss
            </button>
          </>
        ) : (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void resolve(r, false)}>
            Stop counting
          </button>
        )}
      </span>
    </div>
  );

  return (
    <section className="space-y-2 max-w-[900px]">
      <div className="flex flex-wrap items-center gap-3">
        <DecoHeading>Recurring</DecoHeading>
        <button className="g-btn g-btn-ghost g-btn-sm ml-auto" disabled={busy} onClick={() => void detect()}>
          {busy ? 'Looking…' : 'Look for recurring payments'}
        </button>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {suggested.length > 0 && (
        <div className="space-y-1">
          <div className="g-cap">Found in your history: confirm the ones that will go on</div>
          <div className="g-plain">{suggested.map(row)}</div>
        </div>
      )}
      {items && confirmed.length === 0 && suggested.length === 0 ? (
        <Empty title="No recurring items">Look through your posted history for payments that repeat: rent, salary, subscriptions.</Empty>
      ) : (
        confirmed.length > 0 && (
          <div className="space-y-1">
            <div className="g-cap">Counted in the forecast</div>
            <div className="g-plain">{confirmed.map(row)}</div>
          </div>
        )
      )}
    </section>
  );
}

interface PlannedDraft {
  date: string;
  description: string;
  amount: string;
  out: boolean;
  category: number | null;
  /** Kept as it was: the form doesn't edit the account. */
  accountId: number | null;
}

function PlannedItems({ onChange }: { onChange: () => void }) {
  const { entity, locale, ledgerById } = useFinance();
  const fun = entity.functional_currency;
  const today = todayIso();
  const [items, setItems] = useState<fin.Planned[] | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<PlannedDraft>({ date: today, description: '', amount: '', out: true, category: null, accountId: null });
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => fin.listPlanned(today).then(setItems, (e) => setMsg(errText(e))), [today]);
  useEffect(() => {
    void load();
  }, [load]);

  const amount = draft.amount.trim() ? parseMoney(draft.amount, fun, locale) : null;
  const valid = !!draft.description.trim() && /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && amount != null && amount > 0;
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => a.date.localeCompare(b.date)), [items]);

  const start = (p?: fin.Planned) => {
    setMsg(null);
    if (p) {
      setEditing(p.id);
      setDraft({ date: p.date, description: p.description, amount: toInput(Math.abs(p.amount_minor), fun, locale), out: p.amount_minor < 0, category: p.ledger_account_id, accountId: p.account_id });
    } else {
      setEditing('new');
      setDraft({ date: today, description: '', amount: '', out: true, category: null, accountId: null });
    }
  };
  const save = async () => {
    if (!valid || amount == null) return;
    const input: fin.PlannedInput = { date: draft.date, description: draft.description.trim(), amountMinor: draft.out ? -amount : amount, ledgerAccountId: draft.category, accountId: draft.accountId };
    try {
      if (editing === 'new') await fin.createPlanned(input);
      else if (editing != null) await fin.updatePlanned(editing, input);
      setEditing(null);
      await load();
      onChange();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const remove = async (p: fin.Planned) => {
    if (!(await confirmDialog(`Delete the planned item "${p.description}"?`))) return;
    try {
      await fin.deletePlanned(p.id);
      await load();
      onChange();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const form = (
    <form
      className="g-inset p-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3">
        <label className="block">
          <span className="g-flbl">Date</span>
          <input type="date" className="g-field g-field-sm" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        </label>
        <label className="block">
          <span className="g-flbl">What</span>
          <input className="g-field g-field-sm" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Car service, annual insurance…" autoFocus />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="g-flbl">Direction</span>
          <div className="g-seg" role="radiogroup" aria-label="Direction">
            <button type="button" role="radio" aria-checked={draft.out} aria-pressed={draft.out} className="g-chip" onClick={() => setDraft({ ...draft, out: true })}>
              Money out
            </button>
            <button type="button" role="radio" aria-checked={!draft.out} aria-pressed={!draft.out} className="g-chip" onClick={() => setDraft({ ...draft, out: false })}>
              Money in
            </button>
          </div>
        </div>
        <label className="block">
          <span className="g-flbl">Amount ({fun})</span>
          <input className="g-field g-field-sm !w-[130px] text-right tabular-nums" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} aria-invalid={!!draft.amount.trim() && (amount == null || amount <= 0)} />
        </label>
        <div className="flex-1 min-w-[200px]">
          <span className="g-flbl">Category (optional)</span>
          <AccountPicker label="Category" value={draft.category} onChange={(id) => setDraft({ ...draft, category: id })} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <button type="submit" className="g-btn g-btn-gilt g-btn-sm" disabled={!valid}>
          {editing === 'new' ? 'Add' : 'Save'}
        </button>
      </div>
    </form>
  );

  return (
    <section className="space-y-2 max-w-[900px]">
      <div className="flex flex-wrap items-center gap-3">
        <DecoHeading>Planned</DecoHeading>
        {editing !== 'new' && (
          <button className="g-btn g-btn-ghost g-btn-sm ml-auto" onClick={() => start()}>
            Add a planned item
          </button>
        )}
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {editing === 'new' && form}
      {items && sorted.length === 0 && editing !== 'new' ? (
        <Empty title="Nothing planned">A one-off you know is coming, like a deposit or a yearly fee, makes the forecast sharper.</Empty>
      ) : (
        <div className="g-plain">
          {sorted.map((p) =>
            editing === p.id ? (
              <div key={p.id} className="py-2">
                {form}
              </div>
            ) : (
              <div key={p.id} className="g-frow !min-h-[48px] text-sm">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-text">{p.description}</span>
                  <span className={`block text-xs ${MUTED}`}>
                    {formatDate(p.date, locale)}
                    {p.ledger_account_id != null && ` · ${ledgerById.get(p.ledger_account_id)?.name ?? ''}`}
                  </span>
                </span>
                <Money minor={p.amount_minor} currency={fun} signed colour />
                <button className="g-lnk text-xs" onClick={() => start(p)}>
                  Edit
                </button>
                <button className="g-lnk text-xs" onClick={() => void remove(p)}>
                  Delete
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
