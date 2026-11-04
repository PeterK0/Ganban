// Accounting: the double-entry view underneath. The journal with debit and credit columns, a manual
// journal form with a live balance check, period close, the trial balance and the chart of accounts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { convertMinor, crossRate, debitCredit, formatAmount, formatDate, formatMoney, fromDebitCredit, journalBalanceFx, parseMoney, toInput, todayIso } from './money.pure';
import { correctionDate, formatMonth, isLocked, monthOf, nextToClose } from './reports.pure';
import { AccountPicker, Empty, MUTED, errText, ledgerLabel, useFinance } from './shared';

type Sub = 'journal' | 'manual' | 'periods' | 'trial' | 'chart';
const SUBS: [Sub, string][] = [
  ['journal', 'Journal'],
  ['manual', 'New journal'],
  ['periods', 'Periods'],
  ['trial', 'Trial balance'],
  ['chart', 'Chart of accounts'],
];

export default function Accounting() {
  const [sub, setSub] = useState<Sub>('journal');
  return (
    <div className="space-y-4">
      <div className="g-seg" role="tablist" aria-label="Accounting">
        {SUBS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={sub === id} className="g-chip" onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </div>
      {sub === 'journal' && <Journal />}
      {sub === 'manual' && <ManualJournal onDone={() => setSub('journal')} />}
      {sub === 'periods' && <Periods />}
      {sub === 'trial' && <TrialBalance />}
      {sub === 'chart' && <Chart />}
    </div>
  );
}

/** A debit or credit cell: the number alone, in the functional currency. */
function Cell({ minor }: { minor: number | null }) {
  const { entity, locale } = useFinance();
  return <span className="w-[100px] sm:w-[120px] shrink-0 text-right tabular-nums">{minor ? formatAmount(minor, entity.functional_currency, locale) : ''}</span>;
}

function Journal() {
  const { ledgerById, locale, entity, lockedThrough, reload: reloadAll } = useFinance();
  const [entries, setEntries] = useState<fin.Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [drafts, setDrafts] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const r = await fin.listEntries(drafts ? {} : { status: 'posted' }, 100, offset);
      setEntries((prev) => (offset ? [...prev, ...r.entries] : r.entries));
      setTotal(r.total);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setLoading(false);
    }
  }, [drafts]);
  useEffect(() => {
    void load();
  }, [load]);

  const reverse = async (e: fin.Entry) => {
    const on = correctionDate(lockedThrough, todayIso());
    if (!(await confirmDialog(`Reverse this entry? A reversal dated ${formatDate(on, locale)} is posted, and both stay in the journal.`))) return;
    try {
      await fin.reverseEntry(e.id, on);
      await Promise.all([load(), reloadAll()]);
    } catch (err) {
      setMsg(errText(err));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className={`text-sm ${MUTED}`}>Amounts in {entity.functional_currency}</span>
        <label className={`ml-auto flex items-center gap-2 text-sm ${MUTED}`}>
          <input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} /> Include drafts
        </label>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {!loading && entries.length === 0 ? (
        <Empty title="No journal entries yet" />
      ) : (
        <div className="g-plain">
          <div className="flex items-center gap-3 px-1 min-h-[36px] border-b border-gilt-b">
            <span className="g-cap flex-1">Account</span>
            <span className="g-cap w-[100px] sm:w-[120px] text-right">Debit</span>
            <span className="g-cap w-[100px] sm:w-[120px] text-right">Credit</span>
          </div>
          {entries.map((e) => (
            <div key={e.id} className="border-b border-gilt-b py-2 px-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
                <span className={`text-xs ${MUTED} w-[96px]`}>{formatDate(e.date, locale)}</span>
                <span className="flex-1 min-w-0 truncate text-text text-sm">{e.payee || e.description}</span>
                {e.status !== 'posted' && <span className="g-tag">{e.status === 'draft' ? 'Draft' : 'Reversed'}</span>}
                {e.reverses_id && <span className="g-tag">Reversal</span>}
                {isLocked(e.date, lockedThrough) && <span className="g-tag" title="This month is closed: correct it with a reversal">Closed</span>}
                {e.status === 'posted' && !e.reverses_id && (
                  <button className="g-lnk text-xs" onClick={() => void reverse(e)}>
                    Reverse
                  </button>
                )}
              </div>
              {/* Debits first, as a journal reads. */}
              {[...e.lines].sort((a, b) => (b.functional_minor > 0 ? 1 : 0) - (a.functional_minor > 0 ? 1 : 0)).map((l) => {
                const dc = debitCredit(l.functional_minor);
                return (
                  <div key={l.id} className="flex items-center gap-3 text-sm">
                    <span className={`flex-1 min-w-0 truncate ${dc.credit ? 'pl-6' : ''} text-subtext-1`}>{ledgerLabel(ledgerById.get(l.ledger_account_id))}</span>
                    <Cell minor={dc.debit} />
                    <Cell minor={dc.credit} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className={`flex items-center gap-3 text-sm ${MUTED}`}>
        {loading ? 'Loading…' : `${entries.length} of ${total}`}
        {!loading && entries.length < total && (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void load(entries.length)}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

interface DraftLine {
  account: number | null;
  /** The line's currency when its account has none (a category or equity); else the account's. */
  currency: string | null;
  debit: string;
  credit: string;
  /** The user's own functional amount for a foreign line (a bank's converted amount), plain. */
  fx: string;
}
const blank = (): DraftLine => ({ account: null, currency: null, debit: '', credit: '', fx: '' });
const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

/**
 * A manual journal. Each line is in its own currency: a bank or card account's lines in its
 * currency, any other line in the one picked. A foreign line is translated at the ECB spot rate of
 * the date (shown as it will post), or at the functional amount the user sets. Lines all in the
 * functional currency must balance; with a foreign line, what's left over posts as a realised FX
 * gain or loss, and the form says how much.
 */
function ManualJournal({ onDone }: { onDone: () => void }) {
  const { ledger, ledgerById, accounts, entity, locale, lockedThrough, reload } = useFinance();
  const fun = entity.functional_currency;
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** ECB rates (units per EUR) by `currency@date`; null while loading, a string on failure. */
  const [rates, setRates] = useState<Record<string, number | string | null>>({});
  const options = useMemo(() => ledger.filter((l) => !l.archived).sort((a, b) => a.code.localeCompare(b.code)), [ledger]);
  const currencyChoices = useMemo(() => [...new Set([fun, ...accounts.filter((a) => !a.archived).map((a) => a.currency), ...COMMON_CURRENCIES])], [fun, accounts]);

  const curOf = (l: DraftLine) => (l.account != null ? ledgerById.get(l.account)?.currency : null) ?? l.currency ?? fun;
  const parsed = lines.map((l) => {
    const cur = curOf(l);
    const d = l.debit.trim() ? parseMoney(l.debit, cur, locale) : null;
    const c = l.credit.trim() ? parseMoney(l.credit, cur, locale) : null;
    const bad = !!((l.debit.trim() && d === null) || (l.credit.trim() && c === null) || (d ?? 0) < 0 || (c ?? 0) < 0);
    const amount = bad ? null : fromDebitCredit(d, c);
    const foreign = cur !== fun;
    // A set functional amount takes the line's sign; the user types it plain.
    const fxTyped = foreign && l.fx.trim() ? parseMoney(l.fx, fun, locale) : null;
    const fxBad = foreign && !!l.fx.trim() && (fxTyped === null || fxTyped <= 0);
    const override = fxTyped != null && fxTyped > 0 && amount != null ? Math.sign(amount) * fxTyped : null;
    const rFrom = rates[`${cur}@${date}`];
    const rTo = rates[`${fun}@${date}`];
    const rate = typeof rFrom === 'number' && typeof rTo === 'number' ? crossRate(rFrom, rTo) : null;
    const rateErr = typeof rFrom === 'string' ? rFrom : typeof rTo === 'string' ? rTo : null;
    const functional = amount == null ? null : !foreign ? amount : override ?? (rate != null ? convertMinor(amount, cur, fun, rate) : null);
    return { cur, amount, bad, foreign, override, fxBad, rate, rateErr, functional, pending: foreign && amount != null && override == null && rate == null && !rateErr };
  });
  const bal = journalBalanceFx(parsed.map((p) => ({ functional: p.functional, foreign: p.foreign, pending: p.pending })));
  const filled = lines.filter((l, i) => l.account != null || parsed[i].amount != null);
  const linesOk = filled.length >= 2 && lines.every((l, i) => (l.account == null && parsed[i].amount == null && !parsed[i].bad) || (l.account != null && parsed[i].amount != null && !parsed[i].fxBad));
  const rateErr = parsed.find((p) => p.amount != null && p.rateErr && p.override == null)?.rateErr ?? null;
  const dateLocked = !!date && isLocked(date, lockedThrough);
  const ok = !dateLocked && description.trim() && date && bal.balanced && linesOk && parsed.every((p) => p.amount == null || p.functional != null) && !busy;
  const set = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Fetch the ECB rates the foreign lines need for the date (the host fetches a missing day itself).
  const needed = [...new Set(parsed.filter((p) => p.foreign).flatMap((p) => [p.cur, fun]))].map((c) => `${c}@${date}`).filter((k) => !(k in rates)).join(',');
  useEffect(() => {
    if (!needed || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const keys = needed.split(',');
    setRates((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, null])) }));
    for (const k of keys) {
      const [cur, day] = k.split('@');
      fin.rate(cur, day).then(
        (r) => setRates((x) => ({ ...x, [k]: r.rate })),
        (e) => setRates((x) => ({ ...x, [k]: errText(e) })),
      );
    }
  }, [needed, date]);

  const save = async () => {
    if (!ok) return;
    if (bal.large && !(await confirmDialog(`The lines differ by ${formatMoney(Math.abs(bal.fxDifference), fun, locale)} after translation, which would post as a realised FX ${bal.fxDifference > 0 ? 'gain' : 'loss'}. Post it anyway?`))) return;
    setBusy(true);
    setMsg(null);
    try {
      await fin.createEntry({
        date,
        description: description.trim(),
        lines: lines.flatMap((l, i) => {
          const p = parsed[i];
          if (l.account == null || p.amount == null) return [];
          // A foreign line without the user's own amount is left for the host to translate.
          return [{ ledgerAccountId: l.account, amountMinor: p.amount, currency: p.cur, ...(p.override != null ? { functionalMinor: p.override } : {}) }];
        }),
      });
      await reload();
      onDone();
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };

  const AMT = 'w-[96px] sm:w-[120px]';
  return (
    <div className="g-card p-5 space-y-4 max-w-[940px]">
      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
        <label className="block">
          <span className="g-flbl">Date</span>
          <input type="date" className="g-field" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="g-flbl">Description</span>
          <input className="g-field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this entry records" />
        </label>
      </div>
      <div className="space-y-2">
        <div className="hidden sm:flex items-center gap-2">
          <span className="g-cap flex-1">Account</span>
          <span className="g-cap w-[72px]">Currency</span>
          <span className={`g-cap ${AMT} text-right`}>Debit</span>
          <span className={`g-cap ${AMT} text-right`}>Credit</span>
          <span className="w-8" />
        </div>
        {lines.map((l, i) => {
          const p = parsed[i];
          const fixed = l.account != null && !!ledgerById.get(l.account)?.currency;
          return (
            <div key={i} className="space-y-1">
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                <AccountPicker label={`Account ${i + 1}`} value={l.account} onChange={(id) => set(i, { account: id, fx: '' })} options={options} placeholder="Account…" showCode className="basis-full sm:basis-auto flex-1 min-w-0" />
                {fixed ? (
                  <span className={`w-[72px] text-sm ${MUTED} pl-2`} title="The account's currency">{p.cur}</span>
                ) : (
                  <select className="g-field g-field-sm !w-[72px]" value={p.cur} onChange={(e) => set(i, { currency: e.target.value, fx: '' })} aria-label={`Currency ${i + 1}`}>
                    {currencyChoices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                <input className="g-field g-field-sm flex-1 min-w-0 sm:flex-none sm:!w-[120px] text-right tabular-nums" inputMode="decimal" placeholder="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label={`Debit ${i + 1}`} aria-invalid={p.bad} />
                <input className="g-field g-field-sm flex-1 min-w-0 sm:flex-none sm:!w-[120px] text-right tabular-nums" inputMode="decimal" placeholder="Credit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label={`Credit ${i + 1}`} aria-invalid={p.bad} />
                <button className="g-iconbtn w-8" aria-label={`Remove line ${i + 1}`} title="Remove line" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
              {p.foreign && p.amount != null && (
                <div className={`flex flex-wrap items-center justify-end gap-2 text-xs ${MUTED} sm:pr-10`}>
                  {p.override == null &&
                    (p.rate != null ? (
                      <span className="tabular-nums">
                        ECB {p.cur}/{fun} {p.rate.toFixed(4)} → {formatMoney(p.functional ?? 0, fun, locale)}
                      </span>
                    ) : p.rateErr ? (
                      <span className="text-error">
                        No rate (
                        <button type="button" className="g-lnk" onClick={() => setRates((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v !== 'string')))}>
                          try again
                        </button>
                        ):
                      </span>
                    ) : (
                      <span>Fetching the rate…</span>
                    ))}
                  <label className="flex items-center gap-1">
                    <span>{p.override == null ? `or set the ${fun} amount` : `${fun} amount`}</span>
                    <input className="g-field g-field-sm !w-[96px] text-right tabular-nums" inputMode="decimal" value={l.fx} onChange={(e) => set(i, { fx: e.target.value })} placeholder={p.functional != null ? toInput(Math.abs(p.functional), fun, locale) : ''} aria-label={`${fun} amount of line ${i + 1}`} aria-invalid={p.fxBad} />
                  </label>
                </div>
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-2 border-t border-gilt-b pt-2 text-sm">
          <button className="g-btn g-btn-ghost g-btn-sm mr-auto" onClick={() => setLines((ls) => [...ls, blank()])}>
            Add line
          </button>
          <span className={`text-xs ${MUTED}`}>{fun}</span>
          <span className={`${AMT} text-right tabular-nums text-text`}>{formatAmount(bal.debits, fun, locale)}</span>
          <span className={`${AMT} text-right tabular-nums text-text`}>{formatAmount(bal.credits, fun, locale)}</span>
          <span className="w-8" />
        </div>
        <p className={`text-sm text-right ${bal.balanced ? (bal.large ? 'text-warning' : 'text-success') : MUTED}`} role="status">
          {rateErr && !bal.balanced
            ? `A rate couldn't be fetched: ${rateErr}`
            : bal.pending
              ? 'Fetching the rate…'
              : bal.balanced
                ? bal.fxDifference
                  ? `${formatMoney(Math.abs(bal.fxDifference), fun, locale)} posts as a realised FX ${bal.fxDifference > 0 ? 'gain' : 'loss'}${bal.large ? ': check the amounts' : ''}`
                  : 'Balanced'
                : bal.diff !== 0
                  ? `Off by ${formatAmount(Math.abs(bal.diff), fun, locale)} ${fun} (${bal.diff > 0 ? 'more debits' : 'more credits'})`
                  : 'Two lines or more, debits equal to credits.'}
        </p>
      </div>
      {dateLocked && <p className="text-sm text-warning">{formatMonth(monthOf(date), locale)} is closed. Date the entry in an open month.</p>}
      {msg && <p className="text-sm text-error">{msg}</p>}
      <div className="flex justify-end">
        <button className="g-btn g-btn-pri" disabled={!ok} onClick={() => void save()}>
          {busy ? 'Posting…' : 'Post entry'}
        </button>
      </div>
    </div>
  );
}

/**
 * Period close: the months from the first entry to now, the next one to close, and what blocks it.
 * Closing retranslates foreign balances at the month-end rate, posts the month's schedule releases
 * and locks the month; later corrections are reversals dated in an open month.
 */
function Periods() {
  const { periods, locale, reload, goto } = useFinance();
  const today = todayIso();
  const next = nextToClose(periods, today);
  const [result, setResult] = useState<fin.CloseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const blockers = result && !result.closed ? result.blockers : null;
  const blocked = blockers ? blockers.review_pairs.length + blockers.uncategorised.length + blockers.drafts.length : 0;

  const close = async (force: boolean) => {
    if (!next) return;
    if (force && !(await confirmDialog(`Close ${formatMonth(next, locale)} with these left as they are? Its entries lock; later corrections are reversals.`))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fin.closePeriod(next, force);
      setResult(r);
      if (r.closed) await reload();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...periods].sort((a, b) => b.month.localeCompare(a.month));
  return (
    <div className="space-y-4 max-w-[860px]">
      <p className={`text-sm ${MUTED} g-read`}>
        Closing a month retranslates your foreign-currency balances at the ECB rate of its last day, posts the month's share of any spread entries, and locks it. Months close in order. A
        locked entry is corrected by a reversal dated in an open month.
      </p>
      {next ? (
        <div className="g-card p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="g-stitle flex-1">Next to close: {formatMonth(next, locale)}</span>
            <button className="g-btn g-btn-pri" disabled={busy} onClick={() => void close(false)}>
              {busy ? 'Closing…' : `Close ${formatMonth(next, locale)}`}
            </button>
          </div>
          {blockers && blocked > 0 && (
            <div className="space-y-2" role="status">
              <p className="text-sm text-warning">Some things in this month aren't settled yet:</p>
              <ul className="text-sm space-y-1">
                {blockers.review_pairs.length > 0 && (
                  <li className="flex items-center gap-2">
                    <span className="g-tag g-tag-warn">{blockers.review_pairs.length}</span>
                    <span className="flex-1">{blockers.review_pairs.length === 1 ? 'possible transfer to confirm' : 'possible transfers to confirm'}</span>
                    <button className="g-lnk" onClick={() => goto('import')}>
                      Review
                    </button>
                  </li>
                )}
                {blockers.uncategorised.length > 0 && (
                  <li className="flex items-center gap-2">
                    <span className="g-tag g-tag-warn">{blockers.uncategorised.length}</span>
                    <span className="flex-1">posted {blockers.uncategorised.length === 1 ? 'entry' : 'entries'} without a category</span>
                    <button className="g-lnk" onClick={() => goto('transactions')}>
                      Sort
                    </button>
                  </li>
                )}
                {blockers.drafts.length > 0 && (
                  <li className="flex items-center gap-2">
                    <span className="g-tag g-tag-warn">{blockers.drafts.length}</span>
                    <span className="flex-1">{blockers.drafts.length === 1 ? 'draft' : 'drafts'} still in the inbox</span>
                    <button className="g-lnk" onClick={() => goto('transactions')}>
                      Inbox
                    </button>
                  </li>
                )}
              </ul>
              {blockers.drafts.length > 0 ? (
                <p className={`text-sm ${MUTED}`}>Drafts have to be posted or deleted first: once the month locks, they couldn't be.</p>
              ) : (
                <div className="flex justify-end">
                  <button className="g-btn g-btn-ghost g-btn-sm" disabled={busy} onClick={() => void close(true)}>
                    Close anyway
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className={`text-sm ${MUTED}`}>No month is ready to close: a month can close once it has ended.</p>
      )}
      {result?.closed && (
        <p className="text-sm text-success" role="status">
          {formatMonth(result.month, locale)} is closed.
          {result.retranslation_entry_id != null ? ' Foreign balances were retranslated.' : ''}
          {result.release_entry_ids.length > 0 ? ` ${result.release_entry_ids.length} spread ${result.release_entry_ids.length === 1 ? 'entry was' : 'entries were'} released.` : ''}
        </p>
      )}
      {msg && <p className="text-sm text-error">{msg}</p>}
      {sorted.length === 0 ? (
        <Empty title="No months yet" />
      ) : (
        <div className="g-plain">
          {sorted.map((p) => (
            <div key={p.month} className="g-frow !min-h-[42px] text-sm">
              <span className="flex-1 text-text">{formatMonth(p.month, locale)}</span>
              <span className={`text-xs ${MUTED} tabular-nums`}>
                {p.entries} {p.entries === 1 ? 'entry' : 'entries'}
                {p.drafts > 0 ? ` · ${p.drafts} in the inbox` : ''}
              </span>
              {p.status === 'closed' ? (
                <span className="g-tag g-tag-ok" title={p.closed_at ? `Closed ${formatDate(p.closed_at.slice(0, 10), locale)}` : undefined}>
                  Closed
                </span>
              ) : (
                <span className="g-tag">Open</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrialBalance() {
  const { ledgerById, entity } = useFinance();
  const [asOf, setAsOf] = useState(todayIso());
  const [rows, setRows] = useState<fin.TrialRow[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!asOf) return;
    fin.trialBalance(asOf).then((r) => {
      setRows(r);
      setMsg(null);
    }).catch((e) => setMsg(errText(e)));
  }, [asOf]);
  const sorted = useMemo(
    () => (rows ?? []).filter((r) => r.debit_minor || r.credit_minor).sort((a, b) => (ledgerById.get(a.ledger_account_id)?.code ?? '').localeCompare(ledgerById.get(b.ledger_account_id)?.code ?? '')),
    [rows, ledgerById],
  );
  const dr = sorted.reduce((s, r) => s + r.debit_minor, 0);
  const cr = sorted.reduce((s, r) => s + r.credit_minor, 0);

  return (
    <div className="space-y-3 max-w-[860px]">
      <label className="flex items-center gap-2 text-sm">
        <span className="g-cap">As of</span>
        <input type="date" className="g-field g-field-sm !w-auto" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        <span className={MUTED}>· {entity.functional_currency}</span>
      </label>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {rows && sorted.length === 0 ? (
        <Empty title="Nothing posted by this date" />
      ) : (
        <div className="g-plain">
          <div className="flex items-center gap-3 px-1 min-h-[36px] border-b border-gilt-b">
            <span className="g-cap flex-1">Account</span>
            <span className="g-cap w-[100px] sm:w-[120px] text-right">Debit</span>
            <span className="g-cap w-[100px] sm:w-[120px] text-right">Credit</span>
          </div>
          {sorted.map((r) => (
            <div key={r.ledger_account_id} className="g-frow !min-h-[38px] text-sm">
              <span className="flex-1 min-w-0 truncate text-subtext-1">{ledgerLabel(ledgerById.get(r.ledger_account_id))}</span>
              <Cell minor={r.debit_minor} />
              <Cell minor={r.credit_minor} />
            </div>
          ))}
          <div className="flex items-center gap-3 px-1 min-h-[42px] font-semibold text-text">
            <span className="flex-1">
              Total {dr === cr ? <span className="g-tag g-tag-ok ml-2">Balanced</span> : <span className="g-tag g-tag-red ml-2">Out of balance</span>}
            </span>
            <Cell minor={dr} />
            <Cell minor={cr} />
          </div>
        </div>
      )}
    </div>
  );
}

const CLASSES: fin.LedgerClass[] = ['asset', 'liability', 'equity', 'income', 'expense'];
const CLASS_LABEL: Record<fin.LedgerClass, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

function Chart() {
  const { ledger, reload } = useFinance();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState<{ cls: fin.LedgerClass; code: string; name: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setMsg(null);
      await reload();
      return true;
    } catch (e) {
      setMsg(errText(e));
      return false;
    }
  };

  const archive = async (l: fin.LedgerAccount) => {
    if (!(await confirmDialog(`Archive "${l.name}"? It leaves the pickers; its history stays.`))) return;
    void run(() => fin.archiveLedgerAccount(l.id));
  };

  return (
    <div className="space-y-4 max-w-[860px]">
      <div className="flex items-center">
        <p className={`text-sm ${MUTED} flex-1`}>Every account here can be renamed. The ones the app posts to itself (opening balances, transfers, FX) can't be archived.</p>
        <label className={`flex items-center gap-2 text-sm ${MUTED}`}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {CLASSES.map((cls) => {
        const rows = ledger.filter((l) => l.class === cls && (showArchived || !l.archived)).sort((a, b) => a.code.localeCompare(b.code));
        return (
          <section key={cls} className="g-card p-0">
            <div className="px-5 pt-4 flex items-center">
              <span className="g-stitle flex-1">{CLASS_LABEL[cls]}</span>
              <button className="g-lnk text-sm" onClick={() => setAdding({ cls, code: '', name: '' })}>
                Add
              </button>
            </div>
            <div className="px-4 pb-1">
              {rows.map((l) => (
                <div key={l.id} className={`g-frow !min-h-[40px] text-sm ${l.archived ? 'opacity-60' : ''}`}>
                  <span className={`w-[60px] tabular-nums ${MUTED}`}>{l.code}</span>
                  {editing === l.id ? (
                    <form
                      className="flex-1 flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => fin.updateLedgerAccount(l.id, { name: name.trim() })).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <input className="g-field g-field-sm flex-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Account name" />
                      <button type="submit" className="g-btn g-btn-gilt g-btn-sm" disabled={!name.trim()}>
                        Save
                      </button>
                      <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 truncate text-text">{l.name}</span>
                      {l.currency && <span className={`text-xs ${MUTED}`}>{l.currency}</span>}
                      {l.archived && <span className="g-tag">Archived</span>}
                      <button
                        className="g-lnk text-xs"
                        onClick={() => {
                          setEditing(l.id);
                          setName(l.name);
                        }}
                      >
                        Rename
                      </button>
                      {!l.system_key && !l.archived && (
                        <button className="g-lnk text-xs" onClick={() => void archive(l)}>
                          Archive
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
              {adding?.cls === cls && (
                <form
                  className="g-frow !min-h-[48px] gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!adding.name.trim() || !adding.code.trim()) return;
                    void run(() => fin.createLedgerAccount({ class: cls, code: adding.code.trim(), name: adding.name.trim() })).then((ok) => ok && setAdding(null));
                  }}
                >
                  <input className="g-field g-field-sm !w-[72px]" value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value })} placeholder="Code" aria-label="Code" autoFocus />
                  <input className="g-field g-field-sm flex-1" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Name" aria-label="Name" />
                  <button type="submit" className="g-btn g-btn-gilt g-btn-sm" disabled={!adding.name.trim() || !adding.code.trim()}>
                    Add
                  </button>
                  <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => setAdding(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
