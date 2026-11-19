// "To sort", payees and rules: the choices and words the sorting screens show (no React, so it's
// tested on its own). Which categories the picker offers and in what order, when filing a line
// asks "just this one, or change the default?", the Undo toast, the tidy banner, the import
// result's links, the filters' meaning, and accounts grouped under their bank.

/** A count in the user's locale (10,302). */
const count = (n: number, locale?: string) => new Intl.NumberFormat(locale).format(n);
const plural = (n: number, one: string, many: string, locale?: string) => `${count(n, locale)} ${n === 1 ? one : many}`;

// ── The category picker ──────────────────────────────────────────────────────

export interface PickerAccount {
  id: number;
  name: string;
  class: string;
  system_key: string | null;
  currency: string | null;
  archived: boolean;
}

/**
 * What a line can be filed under: live spending and income categories, without the system
 * accounts (FX, Uncategorised, opening balance) or money accounts, but with Bank fees. The most
 * used first (`uses`: lines filed under each), then spending before income, then by name.
 */
export function pickerCategories<T extends PickerAccount>(ledger: T[], uses: Map<number, number> = new Map()): T[] {
  return ledger
    .filter((l) => (l.class === 'income' || l.class === 'expense') && !l.archived && !l.currency && (!l.system_key || l.system_key === 'bank_fees'))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || (a.class === b.class ? a.name.localeCompare(b.name) : a.class === 'expense' ? -1 : 1));
}

/** How much each category is used, read from the payees: the lines of the payees filed under it. */
export function usesFromPayees(payees: { default_ledger_account_id: number | null; lines: number }[]): Map<number, number> {
  const uses = new Map<number, number>();
  for (const p of payees) {
    if (p.default_ledger_account_id != null) uses.set(p.default_ledger_account_id, (uses.get(p.default_ledger_account_id) ?? 0) + p.lines);
  }
  return uses;
}

// ── Filing a line, and what it teaches its payee ─────────────────────────────

export interface PayeeDefaults {
  default_ledger_account_id: number | null;
  default_account_id?: number | null;
  ask_every_time: boolean;
}

/** Where a line goes, as one key: a category (`c:12`) or a move to one of his accounts (`a:3`). */
export type Target = `c:${number}` | `a:${number}`;

/** A payee's default as a target key, or null when it has none. */
export function defaultTarget(p: PayeeDefaults): Target | null {
  if (p.default_account_id != null) return `a:${p.default_account_id}`;
  if (p.default_ledger_account_id != null) return `c:${p.default_ledger_account_id}`;
  return null;
}

/**
 * Whether filing a line under `chosen` must ask "just this one, or change the default?": only
 * when its payee already files elsewhere and doesn't ask every time. With no default yet, the
 * host makes this the default (and the toast offers Undo).
 */
export function mustAsk(payee: PayeeDefaults | null | undefined, chosen: Target): boolean {
  if (!payee || payee.ask_every_time) return false;
  const d = defaultTarget(payee);
  return d != null && d !== chosen;
}

/** The toast after a payee learns a category: "Wolt → Eating out from now on", and what else it filed. */
export function defaultToast(payee: string, category: string, filedDrafts: number, filedHistory: number, locale?: string): string {
  const head = `${payee} → ${category} from now on`;
  const also: string[] = [];
  if (filedDrafts) also.push(`${plural(filedDrafts, 'line', 'lines', locale)} waiting in To sort`);
  if (filedHistory) also.push(`${count(filedHistory, locale)} in Unsorted history`);
  return also.length ? `${head}. Also filed: ${also.join(' and ')}.` : head;
}

/** What Undo took back: the default and the lines it filed; a line he picked himself stays. */
export function undoText(payee: string, category: string, filed: number, picked: boolean, locale?: string): string {
  const back = filed ? ` The ${plural(filed, 'line', 'lines', locale)} it filed ${filed === 1 ? 'is' : 'are'} back where ${filed === 1 ? 'it was' : 'they were'}.` : '';
  const kept = picked ? ` The line you picked stays under ${category}.` : '';
  return `${payee} no longer files under ${category}.${back}${kept}`;
}

/** What tells two suggested payees apart: the words one name has and the other lacks ("Ltd"). */
export function nameDiff(a: string, b: string): string {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const wa = words(a), wb = words(b);
  const only = [...wa.filter((w) => !wb.includes(w)), ...wb.filter((w) => !wa.includes(w))];
  if (!only.length) return a === b ? 'the same name' : 'only capitals or punctuation';
  const orig = [...a.split(/\s+/), ...b.split(/\s+/)];
  return only.map((w) => orig.find((o) => o.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === w) ?? w).filter((w, i, l) => l.indexOf(w) === i).map((w) => `“${w}”`).join(', ');
}

export interface RuleForm {
  text: string;
  /** Money out between these plain amounts (minor units, positive); null for no bound. */
  outFrom: number | null;
  outTo: number | null;
  category: number | null;
}

/** A rule as the host takes it, from the form: words in the text, and a money-out range. */
export function ruleFromForm(f: RuleForm): { conditions: Record<string, unknown>; action: Record<string, unknown> } | null {
  if (f.category == null) return null;
  const conditions: Record<string, unknown> = {};
  if (f.text.trim()) conditions.text = f.text.trim();
  if (f.outFrom != null || f.outTo != null) {
    // Spending is negative: money out of 10 to 50 is -50 … -10.
    conditions.maxAmountMinor = f.outFrom != null ? -Math.abs(f.outFrom) : -1;
    if (f.outTo != null) conditions.minAmountMinor = -Math.abs(f.outTo);
  }
  if (!Object.keys(conditions).length) return null;
  return { conditions, action: { ledgerAccountId: f.category, splits: [] } };
}

/** The form from a rule, to edit it. */
export function formFromRule(r: RuleView): RuleForm {
  const c = r.conditions;
  const max = typeof c.maxAmountMinor === 'number' ? c.maxAmountMinor : null;
  const min = typeof c.minAmountMinor === 'number' ? c.minAmountMinor : null;
  return {
    text: typeof c.text === 'string' ? c.text : '',
    outFrom: max != null && max < -1 ? -max : null,
    outTo: min != null && min < 0 ? -min : null,
    category: typeof r.action.ledgerAccountId === 'number' ? r.action.ledgerAccountId : null,
  };
}

/** The two answers when a line goes somewhere other than its payee's usual. */
export function askChoices(payee: string, usual: string, chosen: string): { title: string; once: string; change: string } {
  return {
    title: `${payee} usually goes to ${usual}.`,
    once: `Just this one to ${chosen}`,
    change: `Change ${payee}'s default to ${chosen}`,
  };
}

// ── The views of Transactions ────────────────────────────────────────────────

/** To sort · All · Transfers · Unsorted history. */
export type SortView = 'tosort' | 'all' | 'transfers' | 'history';

export interface ViewFilter {
  status?: 'draft' | 'posted' | 'reversed';
  transfers?: boolean;
  unsorted?: boolean;
}

/** The host filter a view stands for. Unsorted history is listed by payee, so its lines view is
 * the history lines themselves. */
export function viewFilter(v: SortView): ViewFilter {
  switch (v) {
    case 'tosort':
      return { status: 'draft' };
    case 'transfers':
      return { transfers: true };
    case 'history':
      return { unsorted: true };
    default:
      return {};
  }
}

export interface Narrowing {
  from?: string;
  to?: string;
  search?: string;
  groupKey?: string;
  accountId?: number;
  payeeId?: number;
  importBatchId?: number;
  ids?: number[];
}

/** Whether a filter narrows to something picked, as the host requires for bulk filing. */
export function narrows(f: Narrowing): boolean {
  return !!((f.from && f.from.trim()) || (f.to && f.to.trim()) || (f.search && f.search.trim()) || f.groupKey || f.accountId != null || f.payeeId != null || f.importBatchId != null || (f.ids && f.ids.length));
}

/** What the bulk bar acts on: the ticked lines, else every line an active filter matches, else nothing. */
export function bulkScope(selected: number, filterActive: boolean, matching: number, locale?: string): { on: 'selection' | 'filter' | null; label: string } {
  if (selected) return { on: 'selection', label: `${plural(selected, 'line', 'lines', locale)} ticked` };
  if (filterActive && matching) return { on: 'filter', label: `All ${plural(matching, 'line', 'lines', locale)} this filter matches` };
  return { on: null, label: 'Tick lines, or filter by account, payee, date or search, to file many at once' };
}

// ── Tidying an inbox from before payees ──────────────────────────────────────

/** When the banner shows: a large "To sort" the host could shrink by itself. */
export const TIDY_AT = 200;

export function tidyText(o: { filed: number; history: number; left: number }, historyDays: number, locale?: string): string | null {
  if (!o.filed && !o.history) return null;
  const parts: string[] = [];
  if (o.filed) parts.push(`${plural(o.filed, 'line goes', 'lines go', locale)} under your payees' usual categories`);
  if (o.history) parts.push(`${plural(o.history, 'line', 'lines', locale)} older than ${historyDays} days move to Unsorted history`);
  return `Tidy up: ${parts.join(', and ')}. That leaves ${plural(o.left, 'line', 'lines', locale)} for you to sort.`;
}

// ── The import result ────────────────────────────────────────────────────────

export interface ImportCounts {
  created: number;
  duplicates: number;
  categorised_by_rules: number;
  filed_by_payee?: number;
  paired: number;
  review: number;
  refunds?: number;
  history_unsorted?: number;
  history_suggested?: number;
  decisions?: number;
  transfer_pair_ids?: number[];
}

/** Where a number of the import result leads. */
export type ResultLink = 'tosort' | 'transfers' | 'filed' | 'history' | null;

/** The import result's numbers, each with what it opens. Zero counts are left out, but "to sort" always shows. */
export function resultItems(r: ImportCounts, locale?: string): { n: number; label: string; link: ResultLink }[] {
  const filed = r.categorised_by_rules + (r.filed_by_payee ?? 0) + (r.refunds ?? 0);
  const transfers = r.transfer_pair_ids?.length ?? r.paired;
  const items: { n: number; label: string; link: ResultLink }[] = [
    { n: r.decisions ?? r.created, label: 'to sort', link: 'tosort' },
    { n: filed, label: 'filed by your payees and rules', link: 'filed' },
    { n: transfers, label: transfers === 1 ? 'transfer matched' : 'transfers matched', link: 'transfers' },
    { n: r.history_unsorted ?? 0, label: 'older, in Unsorted history', link: 'history' },
    { n: r.history_suggested ?? 0, label: 'older, filed as suggested', link: 'filed' },
    { n: r.duplicates, label: 'already imported', link: null },
  ];
  void locale;
  return items.filter((i, k) => k === 0 || i.n > 0);
}

/** After a first import the history is large: point at the payees that make next week short. */
export function nextStep(historyUnsorted: number, decisions: number): 'history' | null {
  return historyUnsorted >= 50 && historyUnsorted > decisions ? 'history' : null;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export interface GroupableAccount {
  id: number;
  name: string;
  institution: string | null;
  kind: string;
  archived: boolean;
}

/**
 * Accounts grouped under their bank, the banks by name and "Other" (no bank) last; inside a
 * bank, current accounts and cards first, then pockets and savings, each by name.
 */
export function groupByBank<T extends GroupableAccount>(accounts: T[]): { bank: string; accounts: T[] }[] {
  const order = (k: string) => (k === 'current' ? 0 : k === 'card' ? 1 : k === 'savings' ? 2 : 3);
  const by = new Map<string, T[]>();
  for (const a of accounts) {
    const bank = a.institution?.trim() || '';
    by.set(bank, [...(by.get(bank) ?? []), a]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([bank, list]) => ({ bank: bank || 'Other', accounts: list.sort((x, y) => order(x.kind) - order(y.kind) || x.name.localeCompare(y.name)) }));
}

export const UNCONFIRMED_NOTE = 'No statement imported for this account yet, so its balance is only what your other accounts sent it. Import its statement to see where the money went.';

// ── Payees & rules ───────────────────────────────────────────────────────────

export type PayeeSort = 'name' | 'lines' | 'total' | 'last';

export interface SortablePayee {
  name: string;
  lines: number;
  total_minor: number;
  last_date: string | null;
}

/** Payees sorted by a column: names A–Z, the rest largest (or latest) first; `asc` flips it. */
export function sortPayees<T extends SortablePayee>(list: T[], by: PayeeSort, asc = false): T[] {
  const cmp = (a: T, b: T): number => {
    switch (by) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'lines':
        return b.lines - a.lines;
      case 'total':
        return Math.abs(b.total_minor) - Math.abs(a.total_minor);
      case 'last':
        return (b.last_date ?? '').localeCompare(a.last_date ?? '');
    }
  };
  const sorted = [...list].sort(cmp);
  return asc ? sorted.reverse() : sorted;
}

export interface RuleView {
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
}

/** What a rule matches, in words: `Text has “wolt” · on Everyday · money out`. */
export function ruleMatches(r: RuleView, accountName: (id: number) => string | undefined, formatAmount: (minor: number) => string): string {
  const c = r.conditions;
  const parts: string[] = [];
  const str = (k: string) => (typeof c[k] === 'string' && (c[k] as string).trim() ? (c[k] as string).trim() : null);
  if (str('text')) parts.push(`text has “${str('text')}”`);
  if (str('payee')) parts.push(`payee has “${str('payee')}”`);
  if (str('description')) parts.push(`description has “${str('description')}”`);
  if (str('bankCategory')) parts.push(`bank's category “${str('bankCategory')}”`);
  if (typeof c.accountId === 'number') parts.push(`on ${accountName(c.accountId) ?? 'an account'}`);
  const min = typeof c.minAmountMinor === 'number' ? c.minAmountMinor : null;
  const max = typeof c.maxAmountMinor === 'number' ? c.maxAmountMinor : null;
  if (max !== null && max <= 0 && min === null) parts.push('money out');
  else if (min !== null && min >= 0 && max === null) parts.push('money in');
  else if (min !== null && max !== null) parts.push(`between ${formatAmount(min)} and ${formatAmount(max)}`);
  else if (min !== null) parts.push(`at least ${formatAmount(min)}`);
  else if (max !== null) parts.push(`at most ${formatAmount(max)}`);
  if (str('currency')) parts.push(`in ${str('currency')}`);
  const s = parts.join(' · ') || 'every line';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What a rule files lines under: one category, or a split. */
export function ruleSets(r: RuleView, categoryName: (id: number) => string | undefined): string {
  const a = r.action;
  if (typeof a.ledgerAccountId === 'number') return categoryName(a.ledgerAccountId) ?? 'a category';
  const splits = Array.isArray(a.splits) ? (a.splits as { ledgerAccountId?: number }[]) : [];
  if (splits.length) return `Split: ${splits.map((s) => (typeof s.ledgerAccountId === 'number' ? categoryName(s.ledgerAccountId) ?? '?' : '?')).join(', ')}`;
  return 'nothing';
}

/** A payee's usual amount: the median of its lines (null with none). */
export function usualAmount(amounts: number[]): number | null {
  if (!amounts.length) return null;
  const s = [...amounts].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ── The import's column wizard ───────────────────────────────────────────────

/** A column as a saved layout names it: its header text, or its index. */
export type ColRef = string | number;

/** The host's guess at the columns, as the wizard's choices: each field's column index in `cols`. */
export function columnsFromMapping(m: Record<string, unknown> | null | undefined, cols: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!m) return out;
  const at = (c: unknown): number | undefined => {
    if (typeof c === 'number') return c >= 0 && c < cols.length ? c : undefined;
    if (typeof c !== 'string') return undefined;
    const i = cols.findIndex((h) => (h ?? '').trim().toLowerCase() === c.trim().toLowerCase());
    return i >= 0 ? i : undefined;
  };
  for (const f of ['bookedDate', 'valueDate', 'payee', 'amount', 'debit', 'credit', 'fee', 'currency', 'balance', 'bankCategory']) {
    const i = at(m[f]);
    if (i !== undefined) out[f] = i;
  }
  const desc = Array.isArray(m.description) ? m.description[0] : m.description;
  const d = at(desc);
  if (d !== undefined) out.description = d;
  return out;
}

/** A move between his accounts, from the line's side: money in reads "From Savings", money out "To Savings". */
export function moveLabel(account: string, direction: 'in' | 'out'): string {
  return `${direction === 'in' ? 'From' : 'To'} ${account}`;
}

/** What a split says: which spelling went where, and with how many lines. */
export function splitText(spelling: string, from: string, to: string, lines: number): string {
  return `Split “${spelling}” off ${from}: it is now ${to === from ? 'a payee of its own' : `the payee ${to}`}${lines ? `, with its ${lines} ${lines === 1 ? 'line' : 'lines'}` : ''}.`;
}
