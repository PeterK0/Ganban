// Payees & rules: every payee with its default category, lines, total and when it was last seen
// (sortable, searchable), and the rules with what each matches, what it sets and how many lines it
// has filed. A sub-view of Transactions for now.
import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { formatDate, formatMoney, parseMoney, toInput } from './money.pure';
import { moveLabel, formFromRule, ruleFromForm, ruleMatches, ruleSets, sortPayees, type PayeeSort, type RuleForm } from './sorting.pure';
import { AccountPicker, Empty, MUTED, Money, errText, useFinance } from './shared';
import { useRailShell } from '../../components/RailViews';

export default function PayeesRules({ onOpenPayee }: { onOpenPayee: (id: number) => void }) {
  const [part, setPart] = useState<'payees' | 'rules'>('payees');
  return (
    <div className="space-y-3">
      <div className="g-seg" role="tablist" aria-label="Payees or rules">
        <button role="tab" aria-selected={part === 'payees'} className="g-chip" onClick={() => setPart('payees')}>
          Payees
        </button>
        <button role="tab" aria-selected={part === 'rules'} className="g-chip" onClick={() => setPart('rules')}>
          Rules
        </button>
      </div>
      {part === 'payees' ? <Payees onOpenPayee={onOpenPayee} /> : <Rules />}
    </div>
  );
}

function Payees({ onOpenPayee }: { onOpenPayee: (id: number) => void }) {
  const { entity, ledgerById, locale, accounts } = useFinance();
  const touch = useRailShell() === 'touch';
  const [q, setQ] = useState('');
  const [page, setPage] = useState<{ payees: fin.Payee[]; total: number } | null>(null);
  const [sort, setSort] = useState<{ by: PayeeSort; asc: boolean }>({ by: 'lines', asc: false });
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    const t = window.setTimeout(() => {
      fin
        .listPayees({ search: q.trim() || undefined }, 500)
        .then((r) => my === seq.current && setPage(r))
        .catch((e) => setMsg(errText(e)));
    }, 200);
    return () => window.clearTimeout(t);
  }, [q]);

  const rows = useMemo(() => sortPayees(page?.payees ?? [], sort.by, sort.asc), [page, sort]);
  const head = (by: PayeeSort, label: string, cls = '') => (
    <button className={`g-cap text-left ${sort.by === by ? 'text-gold' : MUTED} ${cls}`} aria-pressed={sort.by === by} onClick={() => setSort((s) => ({ by, asc: s.by === by ? !s.asc : false }))}>
      {label}
      {sort.by === by ? (sort.asc ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <div className="space-y-3">
      <input className="g-field g-field-sm max-w-[360px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payees and spellings" aria-label="Search payees" />
      {msg && <p className="text-sm text-error">{msg}</p>}
      {page && page.payees.length === 0 ? (
        <Empty title="No payees">{q ? 'Nothing matches.' : 'Payees appear as you import statements.'}</Empty>
      ) : (
        <div className="g-plain" role="table" aria-label="Payees">
          {!touch && (
            <div role="row" className="flex items-center gap-3 px-3 py-2 border-b border-gilt-b">
              {head('name', 'Payee', 'flex-1')}
              <span className={`g-cap w-[180px] ${MUTED}`}>Files under</span>
              {head('lines', 'Lines', 'w-[64px] text-right')}
              {head('total', 'Total', 'w-[110px] text-right')}
              {head('last', 'Last seen', 'w-[100px] text-right')}
            </div>
          )}
          {touch && (
            <div className="flex gap-2 px-3 py-2 border-b border-gilt-b">
              {head('name', 'Name')}
              {head('lines', 'Lines')}
              {head('total', 'Total')}
              {head('last', 'Last')}
            </div>
          )}
          {rows.map((p) => (
            <button key={p.id} role="row" className="w-full flex flex-wrap items-center gap-x-3 gap-y-0.5 min-h-[44px] px-3 py-1.5 border-b border-gilt-b text-left hover:bg-surface-0" onClick={() => onOpenPayee(p.id)}>
              <span className="flex-1 min-w-[140px] truncate text-text">
                {p.name}
                {p.aliases.length > 1 && <span className={`ml-2 text-xs ${MUTED}`}>{p.aliases.length} spellings</span>}
              </span>
              <span className={`text-sm truncate ${touch ? `w-full order-last ${MUTED}` : 'w-[180px]'} ${p.default_ledger_account_id == null ? MUTED : 'text-subtext-1'}`}>
                {p.ask_every_time ? 'Asks every time' : p.default_account_id != null ? moveLabel(accounts.find((a) => a.id === p.default_account_id)?.name ?? 'an account', p.total_minor > 0 ? 'in' : 'out') : p.default_ledger_account_id != null ? ledgerById.get(p.default_ledger_account_id)?.name ?? '—' : 'No default'}
              </span>
              {!touch && <span className={`w-[64px] text-right tabular-nums text-sm ${MUTED}`}>{p.lines.toLocaleString(locale)}</span>}
              <Money minor={p.total_minor} currency={entity.functional_currency} colour className="w-[110px] text-right text-sm" />
              {!touch && <span className={`w-[100px] text-right text-sm ${MUTED}`}>{p.last_date ? formatDate(p.last_date, locale) : '—'}</span>}
            </button>
          ))}
        </div>
      )}
      {page && page.total > page.payees.length && (
        <p className={`text-sm ${MUTED}`}>
          The {page.payees.length} with the most lines of {page.total.toLocaleString(locale)}. Search to find the others.
        </p>
      )}
    </div>
  );
}

function Rules() {
  const { accounts, entity, ledgerById, locale } = useFinance();
  const [rules, setRules] = useState<fin.Rule[] | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    fin
      .listRules()
      .then(setRules)
      .catch((e) => setMsg(errText(e)));
  useEffect(() => {
    void load();
  }, []);

  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name;
  const categoryName = (id: number) => ledgerById.get(id)?.name;
  const amount = (minor: number) => formatMoney(minor, entity.functional_currency, locale);

  const remove = async (r: fin.Rule) => {
    if (!(await confirmDialog(`Delete this rule? "${ruleMatches(r, accountName, amount)}" stops filing lines under ${ruleSets(r, categoryName)}. Lines it already filed stay where they are.`))) return;
    try {
      await fin.deleteRule(r.id);
      setRules((l) => (l ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const save = async (r: fin.Rule | null, form: RuleForm) => {
    const built = ruleFromForm(form);
    if (!built) return setMsg('A rule needs a category, and words to look for or an amount range.');
    try {
      if (r) {
        // Keep what the form doesn't show (an account, the money-out sign) unless the form sets a range.
        const keep = { ...r.conditions };
        delete keep.text;
        if (form.outFrom != null || form.outTo != null) {
          delete keep.minAmountMinor;
          delete keep.maxAmountMinor;
        }
        const updated = await fin.updateRule(r.id, { position: r.position, conditions: { ...keep, ...built.conditions }, action: built.action, learned: r.learned });
        setRules((l) => (l ?? []).map((x) => (x.id === r.id ? updated : x)));
      } else {
        const made = await fin.createRule({ ...built, learned: false });
        setRules((l) => [...(l ?? []), made]);
        const n = await fin.applyRules().catch(() => null);
        // The new rule's "lines filed" counts what it just filed.
        const fresh = n?.categorised ? await fin.listRules().catch(() => null) : null;
        if (fresh) setRules(fresh);
        if (n?.categorised) setMsg(`Rule saved. It filed ${n.categorised} ${n.categorised === 1 ? 'line' : 'lines'} waiting in To sort.`);
      }
      setEditing(null);
      setMsg((m) => (m?.startsWith('A rule needs') ? null : m));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className={`flex-1 min-w-[240px] text-sm ${MUTED}`}>
          Most shops need only their payee's category. A rule is for lines a payee can't decide: words in the description (a rent reference, "TFL"), or an amount range (the same shop, a big order or a small one). Rules file before payees do.
        </p>
        {editing !== 'new' && (
          <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => setEditing('new')}>
            New rule
          </button>
        )}
      </div>
      {msg && <p className="text-sm text-subtext-1">{msg}</p>}
      {editing === 'new' && <RuleEditor rule={null} onSave={(f) => void save(null, f)} onCancel={() => setEditing(null)} />}
      {rules && rules.length === 0 && editing !== 'new' ? (
        <Empty title="No rules yet">Your payees file most lines by themselves. Add a rule when one payee's lines belong in different places.</Empty>
      ) : (
        <div className="g-plain" role="list">
          {rules?.map((r) =>
            editing === r.id ? (
              <RuleEditor key={r.id} rule={r} onSave={(f) => void save(r, f)} onCancel={() => setEditing(null)} />
            ) : (
              <div key={r.id} role="listitem" className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-[44px] px-3 py-1.5 border-b border-gilt-b">
                <span className="flex-1 min-w-[200px] text-sm text-text">{ruleMatches(r, accountName, amount)}</span>
                <span className="text-sm text-subtext-1">→ {ruleSets(r, categoryName)}</span>
                <span className={`w-[110px] text-right text-sm ${MUTED}`}>
                  {r.hits.toLocaleString(locale)} {r.hits === 1 ? 'line' : 'lines'} filed
                </span>
                <span className="flex gap-1">
                  <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setEditing(r.id)}>
                    Edit
                  </button>
                  <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void remove(r)}>
                    Delete
                  </button>
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function RuleEditor({ rule, onSave, onCancel }: { rule: fin.Rule | null; onSave: (f: RuleForm) => void; onCancel: () => void }) {
  const { entity, locale } = useFinance();
  const cur = entity.functional_currency;
  const init = rule ? formFromRule(rule) : { text: '', outFrom: null, outTo: null, category: null };
  const [text, setText] = useState(init.text);
  const [from, setFrom] = useState(init.outFrom != null ? toInput(init.outFrom, cur, locale) : '');
  const [to, setTo] = useState(init.outTo != null ? toInput(init.outTo, cur, locale) : '');
  const [cat, setCat] = useState<number | null>(init.category);
  const amount = (t: string) => (t.trim() ? parseMoney(t, cur, locale) : null);
  return (
    <div role="listitem" className="g-inset flex flex-wrap items-end gap-3 px-3 py-3">
      <label className="block flex-1 min-w-[180px]">
        <span className="g-flbl">Description or payee has</span>
        <input autoFocus className="g-field g-field-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="rent, TFL, salary…" />
      </label>
      <label className="block w-[120px]">
        <span className="g-flbl">Money out from</span>
        <input className="g-field g-field-sm text-right tabular-nums" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="any" />
      </label>
      <label className="block w-[120px]">
        <span className="g-flbl">to</span>
        <input className="g-field g-field-sm text-right tabular-nums" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} placeholder="any" />
      </label>
      <label className="block w-[220px]">
        <span className="g-flbl">Files under</span>
        <AccountPicker label="Files under" value={cat} onChange={setCat} className="w-full" />
      </label>
      <span className="flex gap-2">
        <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => onSave({ text, outFrom: amount(from), outTo: amount(to), category: cat })}>
          {rule ? 'Save' : 'Add rule'}
        </button>
        <button className="g-btn g-btn-ghost g-btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
