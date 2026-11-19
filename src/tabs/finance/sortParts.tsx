// The parts the sorting screens share: filing a line (with "just this one, or change the
// default?" and the Undo toast), the tidy banner, the merge suggestions and unsorted history by
// payee. docs/design/FINANCE.md § Payees says what the host does underneath.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Modal from '../../components/gilt/Modal';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { askChoices, defaultTarget, defaultToast, moveLabel, mustAsk, nameDiff, TIDY_AT, tidyText, undoText, type Target } from './sorting.pure';
import { AccountPicker, Empty, MUTED, Money, errText, splitEntry, useFinance } from './shared';
import { useRailShell } from '../../components/RailViews';

/** Lines older than this go to unsorted history when tidying, as on import. */
const HISTORY_DAYS = 90;

export interface Toast {
  text: string;
  /** Set when the toast undoes a payee's new default. */
  undo?: fin.DefaultChange;
  /** With `undo`: the line he picked himself, which Undo leaves where he put it. */
  picked?: boolean;
  /** Which way the money went, for a move's words ("from Savings" or "to Savings"). */
  dir?: 'in' | 'out';
  /** Any other Undo (a merge): returns what to say after it. */
  undoAction?: () => Promise<string>;
}

/** How long a toast stays: about 8 s, held while the pointer or focus is on it. */
const TOAST_MS = 8000;

/** The toast at the foot of the section it came from (sticky, so it never covers the last rows):
 * a line of text and Undo, gone after a while. */
export function ToastBar({ toast, onUndo, onClose }: { toast: Toast | null; onUndo: (t: Toast) => void; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!toast || held) return;
    const t = window.setTimeout(onClose, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast, held, onClose]);
  if (!toast) return null;
  const canUndo = !!(toast.undo || toast.undoAction);
  return (
    <div className="sticky bottom-3 z-30 flex justify-center pointer-events-none pt-2">
      <div
        role="status"
        className="g-card pointer-events-auto max-w-full flex items-center gap-3 pl-4 pr-2 py-2 text-sm text-text shadow-lg"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
      >
        <span className="min-w-0">{toast.text}</span>
        {canUndo && (
          <button className="g-btn g-btn-ghost g-btn-sm flex-none" onClick={() => onUndo(toast)}>
            Undo
          </button>
        )}
        <button className="g-iconbtn flex-none" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}

interface Asking {
  payee: string;
  usual: string;
  chosen: string;
  resolve: (c: fin.DefaultChoice | null) => void;
}

/**
 * Filing lines: `file` categorises one line, asking first when it goes somewhere other than its
 * payee's usual; `fileGroup` sorts a payee group or a filter on the host. Both show the Undo
 * toast when a payee learns a category. Render `ui` once in the view.
 */
export function useFiling(onChanged: () => void) {
  const { ledgerById, accountByLedger, reload, locale, accounts } = useFinance();
  const [toast, setToast] = useState<Toast | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  // The question waiting for an answer: a second filing meanwhile is refused, not queued.
  const pending = useRef(false);
  const name = (id: number | null | undefined) => (id != null ? ledgerById.get(id)?.name : undefined) ?? 'that category';
  const accountName = (id: number | null | undefined) => accounts.find((a) => a.id === id)?.name ?? 'your new account';
  /** A default in words: a category's name, or "a move to Savings". */
  const changeName = (c: { ledger_account_id: number | null; account_id?: number | null }, dir: 'in' | 'out' = 'out') =>
    c.account_id != null ? `${dir === 'in' ? 'from' : 'to'} ${accountName(c.account_id)}` : name(c.ledger_account_id);
  const targetName = (t: Target, dir: 'in' | 'out') => (t.startsWith('a:') ? moveLabel(accountName(Number(t.slice(2))), dir) : name(Number(t.slice(2))));
  // Read fresh each time: the payee page, merges and history picks change defaults too.
  const payeeOf = async (id: number | null | undefined) => (id == null ? null : fin.getPayee(id).catch(() => null));

  const learned = (c: fin.DefaultChange | null | undefined, picked = false, dir: 'in' | 'out' = 'out') => {
    if (!c || (c.ledger_account_id == null && c.account_id == null)) return;
    setToast({ text: defaultToast(c.name, changeName(c, dir), c.filed_drafts.length, c.filed_history.length, locale), undo: c, picked, dir });
  };

  /** Files one line; null when the user backed out or it failed (the error is returned as text). */
  const file = async (entry: fin.Entry, parts: { ledgerAccountId: number; amountMinor: number }[] | fin.TransferTarget): Promise<fin.Categorised | string | null> => {
    const { bank, net } = splitEntry(entry, accountByLedger, ledgerById);
    if (!bank) return null;
    let choice: fin.DefaultChoice = 'once';
    if (pending.current) return null;
    const dir: 'in' | 'out' = bank.amount_minor > 0 ? 'in' : 'out';
    const move = Array.isArray(parts) ? null : parts;
    const split = Array.isArray(parts) ? parts : [];
    // A new account can't be anyone's default yet, so it never asks.
    const chosen: Target | null = move ? ('accountId' in move ? `a:${move.accountId}` : null) : split.length === 1 ? `c:${split[0].ledgerAccountId}` : null;
    if (chosen) {
      const payee = await payeeOf(entry.payee_id);
      if (payee && mustAsk(payee, chosen)) {
        const usual = defaultTarget(payee)!;
        pending.current = true;
        const got = await new Promise<fin.DefaultChoice | null>((resolve) =>
          setAsking({ payee: payee.name, usual: targetName(usual, dir), chosen: targetName(chosen, dir), resolve }),
        );
        pending.current = false;
        setAsking(null);
        if (!got) return null;
        choice = got;
      }
    }
    try {
      const r = move ? await fin.categoriseTransfer(entry.id, move, choice) : await fin.categorise(entry.id, net, split, choice);
      learned(r.payee_default, true, dir);
      if (r.payee_default?.filed_drafts.length || r.payee_default?.filed_history.length) onChanged();
      void reload();
      return r;
    } catch (e) {
      return errText(e);
    }
  };

  /** Sorts every uncategorised line a (narrowed) filter matches; the payees it taught get the toast. */
  const fileGroup = async (filter: fin.EntryFilter, ledgerAccountId: number): Promise<fin.CategoriseMatching | string> => {
    try {
      const r = await fin.categoriseMatching(filter, ledgerAccountId);
      const taught = r.payee_defaults ?? [];
      if (taught.length === 1) learned(taught[0]);
      else if (taught.length > 1) setToast({ text: `${taught.length} payees file under ${name(ledgerAccountId)} from now on` });
      else setToast({ text: `${r.categorised} ${r.categorised === 1 ? 'line' : 'lines'} filed under ${name(ledgerAccountId)}` });
      onChanged();
      void reload();
      return r;
    } catch (e) {
      return errText(e);
    }
  };

  const undo = async (t: Toast) => {
    setToast(null);
    try {
      if (t.undoAction) {
        setToast({ text: await t.undoAction() });
      } else if (t.undo) {
        const c = t.undo;
        await fin.undoPayeeDefault(c);
        setToast({ text: undoText(c.name, changeName(c, t.dir), c.filed_drafts.length + c.filed_history.length, !!t.picked, locale) });
      }
      onChanged();
      void reload();
    } catch (e) {
      setToast({ text: errText(e) });
    }
  };

  const close = useCallback(() => setToast(null), []);
  const choices = asking ? askChoices(asking.payee, asking.usual, asking.chosen) : null;
  const ui = (
    <>
      <ToastBar toast={toast} onUndo={(t) => void undo(t)} onClose={close} />
      {asking && choices && (
        <Modal title={choices.title} onClose={() => asking.resolve(null)} className="w-[440px] max-w-[calc(100vw-24px)]">
          <div className="space-y-3 p-1">
            <p className={`text-sm ${MUTED}`}>File this line under {asking.chosen} only, or file {asking.payee} there from now on?</p>
            <div className="flex flex-col gap-2">
              <button className="g-btn g-btn-ghost justify-start" onClick={() => asking.resolve('once')}>
                {choices.once}
              </button>
              <button className="g-btn g-btn-gilt justify-start" onClick={() => asking.resolve('change')}>
                {choices.change}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
  return { file, fileGroup, toast: setToast, ui };
}

/**
 * An inbox from before payees: when "To sort" is large and the host could file part of it by
 * itself, one banner says what tidying would do, then asks, then does it.
 */
export function TidyBanner({ decisions, onDone }: { decisions: number; onDone: () => void }) {
  const { locale, reload, summary } = useFinance();
  const preparing = summary?.preparing ?? null;
  const busyHost = !!preparing;
  const [dry, setDry] = useState<fin.TidyOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const big = decisions >= TIDY_AT;

  useEffect(() => {
    if (!big || busyHost) return;
    let stale = false;
    fin
      .tidyInbox(HISTORY_DAYS, true)
      .then((r) => !stale && setDry(r))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [big, decisions, busyHost]);

  // While the host builds payees from the old books, the counts follow it.
  useEffect(() => {
    if (!preparing) return;
    const t = window.setTimeout(() => void reload(), 3000);
    return () => window.clearTimeout(t);
  }, [preparing, reload]);

  const text = dry ? tidyText(dry, HISTORY_DAYS, locale) : null;
  if (preparing) {
    const pct = preparing.total ? Math.min(100, Math.round((preparing.done / preparing.total) * 100)) : 0;
    return (
      <div className="g-card g-corners p-4 space-y-2" role="status" aria-live="polite">
        <p className="text-sm text-text">
          Ganban is still building your payees from your old lines ({preparing.done.toLocaleString(locale)} of {preparing.total.toLocaleString(locale)}). Sorting can wait until it's done: many lines will file themselves. Imports start again once it's finished.
        </p>
        <div className="g-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (!big || (!text && !msg)) return null;

  const run = async () => {
    if (!text || !(await confirmDialog(`${text}\n\nFiled lines stay editable until their month is closed.`))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fin.tidyInbox(HISTORY_DAYS, false);
      setMsg(`Tidied: ${r.filed.toLocaleString(locale)} filed, ${r.history.toLocaleString(locale)} moved to Unsorted history.`);
      setDry(null);
      await reload();
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="g-card g-corners p-4 flex flex-wrap items-center gap-3" role="status">
      <span className="flex-1 min-w-[220px] text-sm text-text">{msg ?? text}</span>
      {text && !msg && (
        <button className="g-btn g-btn-pri g-btn-sm" disabled={busy} onClick={() => void run()}>
          {busy ? 'Tidying…' : 'Tidy up'}
        </button>
      )}
    </div>
  );
}

/** "3 payees look like others": a quiet line that opens the pairs, each "Same payee" or "Different". */
export function MergeSuggestions({ onMerged, toast }: { onMerged: () => void; toast: (t: Toast) => void }) {
  const [list, setList] = useState<fin.PayeeSuggestion[] | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const touch = useRailShell() === 'touch';

  const load = useCallback(() => {
    fin
      .payeeSuggestions(50)
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  if (!list?.length) return null;
  const drop = (s: fin.PayeeSuggestion) => setList((l) => (l ?? []).filter((x) => x !== s));
  const same = async (s: fin.PayeeSuggestion) => {
    // The one with more lines keeps its name.
    const [keep, from] = s.a.lines >= s.b.lines ? [s.a, s.b] : [s.b, s.a];
    try {
      // Its spellings, so Undo can split exactly them off again.
      const keys = (await fin.getPayee(from.id)).aliases.map((a) => a.key);
      await fin.mergePayees(keep.id, [from.id]);
      setMsg(null);
      setList((l) => (l ?? []).filter((x) => x !== s && x.a.id !== from.id && x.b.id !== from.id));
      toast({
        text: `${from.name} is now part of ${keep.name}: its lines and spellings file as ${keep.name}.`,
        undoAction: async () => {
          await fin.splitPayee(keep.id, keys);
          load();
          return `${from.name} is its own payee again.`;
        },
      });
      onMerged();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const different = async (s: fin.PayeeSuggestion) => {
    try {
      await fin.dismissPayeeSuggestion(s.a.id, s.b.id);
      drop(s);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const n = list.length;
  const btn = `g-btn g-btn-sm ${touch ? 'min-h-[44px]' : ''}`;
  return (
    <div className="text-sm">
      <button className="g-lnk" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {n >= 50 ? '50 or more' : n} {n === 1 ? 'payee looks' : 'payees look'} like {n === 1 ? 'another' : 'others'}
        {open ? ' · hide' : ''}
      </button>
      {msg && <span className={`ml-3 ${MUTED}`}>{msg}</span>}
      {open && (
        <div className="g-plain mt-2">
          <div className={`flex items-center gap-3 px-3 py-2 border-b border-gilt-b ${MUTED}`}>
            <span className="flex-1">
              Same payee: one name, and a category you give one files both. Different: they stay apart and aren't suggested again. Answer the ones you're sure of; the rest can wait.
            </span>
            <button className="g-iconbtn flex-none" aria-label="Close the suggestions" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div role="list">
            {list.map((s) => (
              <div key={`${s.a.id}-${s.b.id}`} role="listitem" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gilt-b px-3 py-2">
                <span className="flex-1 min-w-[200px] text-text">
                  {s.a.name} <span className={MUTED}>({s.a.lines})</span> and {s.b.name} <span className={MUTED}>({s.b.lines})</span>
                  <span className={`block text-xs ${MUTED}`}>Differs by {nameDiff(s.a.name, s.b.name)}</span>
                </span>
                <button className={`${btn} g-btn-gilt`} onClick={() => void same(s)}>
                  Same payee
                </button>
                <button className={`${btn} g-btn-ghost`} onClick={() => void different(s)}>
                  Different
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Unsorted history by payee, the largest first: old lines nothing filed, to sort when he likes. */
export function HistoryPayees({ onOpenPayee, header, toast }: { onOpenPayee: (id: number) => void; header?: ReactNode; toast: (t: Toast) => void }) {
  const { entity, locale, ledgerById, reload, accounts, accountByLedger } = useFinance();
  const [page, setPage] = useState<{ payees: fin.Payee[]; total: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const touch = useRailShell() === 'touch';
  const load = useCallback(
    (offset = 0) =>
      fin
        .listPayees({ unsorted: true }, 50, offset)
        .then((r) => setPage((p) => (offset && p ? { payees: [...p.payees, ...r.payees], total: r.total } : r)))
        .catch((e) => setMsg(errText(e))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  /** One pick gives the payee its category: its history files, and so do its lines in every import from now on. */
  const give = async (p: fin.Payee, to: { ledgerAccountId: number } | { accountId: number } | { create: { name: string; kind?: fin.AccountKind } }) => {
    const dir: 'in' | 'out' = p.unsorted_total_minor > 0 ? 'in' : 'out';
    try {
      let target: { ledgerAccountId: number } | { accountId: number };
      if ('create' in to) {
        const a = await fin.createAccount({ kind: to.create.kind ?? 'savings', name: to.create.name, currency: entity.functional_currency });
        target = { accountId: a.id };
      } else target = to;
      if ('accountId' in target) {
        // A move to the account its lines are already in means nothing: say so instead of filing nothing.
        const first = await fin.listEntries({ payeeId: p.id }, 1).catch(() => null);
        const own = first?.entries[0] ? splitEntry(first.entries[0], accountByLedger).account : null;
        if (own?.id === target.accountId) return setMsg(`${p.name}'s lines are already in ${own.name}. Pick the account the money went to or came from.`);
      }
      const c = await fin.setPayeeDefault(p.id, target);
      const what = 'accountId' in target ? `${dir === 'in' ? 'from' : 'to'} ${accounts.find((x) => x.id === (target as { accountId: number }).accountId)?.name ?? 'your new account'}` : ledgerById.get(target.ledgerAccountId)?.name ?? 'that category';
      toast({ text: defaultToast(c.name, what, c.filed_drafts.length, c.filed_history.length, locale), undo: c, dir });
      setPage((pg) => (pg ? { payees: pg.payees.filter((x) => x.id !== p.id), total: pg.total - 1 } : pg));
      void reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <div className="space-y-3">
      <p className={`text-sm ${MUTED}`}>
        Lines older than {HISTORY_DAYS} days that no payee or rule could file. They count in your totals as unsorted. Sorting them is optional, but each payee you give a category here files its lines in every import from now on, so start with the biggest.
      </p>
      {header}
      {msg && <p className="text-sm text-error">{msg}</p>}
      {page && page.payees.length === 0 ? (
        <Empty title="No unsorted history">Every old line has a category.</Empty>
      ) : (
        <div className="g-plain" role="list">
          {page?.payees.map((p) => (
            <div key={p.id} role="listitem" className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gilt-b px-3 py-1.5 ${touch ? 'min-h-[52px]' : 'min-h-[44px]'}`}>
              <button className="flex-1 min-w-[150px] text-left" onClick={() => onOpenPayee(p.id)} title="Open this payee">
                <span className="block text-text truncate hover:underline">{p.name}</span>
                <span className={`block text-xs ${MUTED}`}>
                  {p.unsorted.toLocaleString(locale)} unsorted {p.unsorted === 1 ? 'line' : 'lines'}
                </span>
              </button>
              <span className="order-last sm:order-none w-full sm:w-[260px] flex">
                <AccountPicker
                  label={`Category for ${p.name}`}
                  value={null}
                  placeholder="Pick a category…"
                  onChange={(id) => void give(p, { ledgerAccountId: id })}
                  moves={{ direction: p.unsorted_total_minor > 0 ? 'in' : 'out', onMove: (t) => void give(p, t) }}
                  className="flex-1 min-w-0"
                />
              </span>
              <Money minor={p.unsorted_total_minor} currency={entity.functional_currency} colour className="w-[110px] text-right ml-auto sm:ml-0" />
            </div>
          ))}
        </div>
      )}
      {page && page.payees.length < page.total && (
        <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void load(page.payees.length)}>
          Show more ({(page.total - page.payees.length).toLocaleString(locale)} more payees)
        </button>
      )}
    </div>
  );
}
