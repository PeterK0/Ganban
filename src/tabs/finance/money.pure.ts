// Finance money helpers: integer minor units (cents for EUR) to display and back, split checks,
// and the debit/credit view of a signed journal amount. Pure, so scripts/test-finance-money.mjs
// can test them. Amounts are never floats in the app: a float only appears for the moment
// Intl formats one.

/** Decimal places for an ISO 4217 code (EUR 2, JPY 0, KWD 3), from Intl; 2 when it doesn't know. */
export function exponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Minor units to a major-unit number, for Intl only (exact for anything under 2^53 minor units). */
const toMajor = (minor: number, exp: number) => minor / 10 ** exp;

/** `-1234` EUR → "-€12.34" (en) or "-12,34 €" (de): the user's locale, with the currency. */
export function formatMoney(minor: number, currency: string, locale?: string, opts: { sign?: boolean } = {}): string {
  const exp = exponent(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    }).format(toMajor(minor, exp));
  } catch {
    return `${formatAmount(minor, currency, locale)} ${currency}`;
  }
}

/** Rounded to whole units, for axes and dense tables: "€1,235". */
export function formatMoneyShort(minor: number, currency: string, locale?: string): string {
  const exp = exponent(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(toMajor(minor, exp));
  } catch {
    return `${Math.round(toMajor(minor, exp))} ${currency}`;
  }
}

/** The number alone, in the locale (for journal columns that name the currency once): "1,234.50". */
export function formatAmount(minor: number, currency: string, locale?: string): string {
  const exp = exponent(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: exp, maximumFractionDigits: exp }).format(toMajor(minor, exp));
}

/** The locale's decimal and group separators. */
export function separators(locale?: string): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(12345.6);
  return {
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
  };
}

/**
 * What a user typed to minor units, or null when it isn't an amount. Takes the locale's separators
 * ("12,50" in de, "1,250.00" in en), a lone other decimal mark ("12.50" in de), a currency symbol or
 * code around it, a leading or trailing minus, and accounting parentheses. More decimals than the
 * currency has are refused rather than rounded: money doesn't round silently.
 */
export function parseMoney(text: string, currency: string, locale?: string): number | null {
  const exp = exponent(currency);
  let s = text.trim().replace(/[\s\u00a0\u202f]/g, '').replace(/\u2212/g, '-');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^[^\d\-+.,]+|[^\d\-+.,]+$/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/^[^\d.,]+/, ''); // a symbol after the sign: "-€5"
  if (!/^[\d.,']+$/.test(s)) return null;

  const { decimal, group } = separators(locale);
  let intPart = s;
  let frac = '';
  const lastDec = s.lastIndexOf(decimal);
  if (lastDec >= 0) {
    intPart = s.slice(0, lastDec);
    frac = s.slice(lastDec + 1);
  } else {
    // No locale decimal mark: a single other mark followed by 1..exp digits is a decimal mark
    // ("12.5" typed on a German keyboard), anything else is grouping.
    const other = decimal === ',' ? '.' : ',';
    const i = s.lastIndexOf(other);
    if (i >= 0 && s.indexOf(other) === i && s.length - i - 1 >= 1 && s.length - i - 1 <= exp && s.length - i - 1 !== 3) {
      intPart = s.slice(0, i);
      frac = s.slice(i + 1);
    }
  }
  intPart = intPart.split(group).join('').replace(/[.,']/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  if (!intPart && !frac) return null;
  if (frac.length > exp) return null;
  const minor = Number(intPart || '0') * 10 ** exp + Number((frac + '0'.repeat(exp)).slice(0, exp) || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return neg ? -minor : minor;
}

/** Minor units to the text a field shows for editing: plain digits and the locale's decimal mark. */
export function toInput(minor: number, currency: string, locale?: string): string {
  const exp = exponent(currency);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 10 ** exp);
  const frac = exp ? (abs % 10 ** exp).toString().padStart(exp, '0') : '';
  return `${neg ? '-' : ''}${int}${exp ? separators(locale).decimal + frac : ''}`;
}

// ── Splits ────────────────────────────────────────────────────────────────

export interface SplitDraft {
  ledgerAccountId: number | null;
  amountMinor: number | null;
}

export interface SplitCheck {
  ok: boolean;
  /** What is left to assign (positive: too little assigned). */
  remainder: number;
  errors: string[];
}

/**
 * Check a split of `totalMinor` (the plain size of a bank line, always positive) into parts. Every
 * part needs a category and a positive amount, and the parts must add up to the total exactly.
 */
export function checkSplits(totalMinor: number, splits: SplitDraft[]): SplitCheck {
  const errors: string[] = [];
  if (totalMinor === 0) errors.push('There is no amount to split.');
  if (splits.length === 0) errors.push('Add at least one category.');
  let sum = 0;
  splits.forEach((s, i) => {
    if (s.ledgerAccountId == null) errors.push(`Line ${i + 1} needs a category.`);
    if (s.amountMinor == null || !Number.isSafeInteger(s.amountMinor) || s.amountMinor <= 0) errors.push(`Line ${i + 1} needs an amount above zero.`);
    else sum += s.amountMinor;
  });
  const remainder = Math.abs(totalMinor) - sum;
  if (remainder !== 0 && errors.length === 0) errors.push(remainder > 0 ? 'Some of the amount is still unassigned.' : 'The parts add up to more than the amount.');
  return { ok: errors.length === 0, remainder, errors };
}

/**
 * Split `totalMinor` evenly across `n` parts, the leftover cents on the first parts, so the parts
 * always add up to the total.
 */
export function evenSplit(totalMinor: number, n: number): number[] {
  if (n <= 0) return [];
  const abs = Math.abs(totalMinor);
  const base = Math.floor(abs / n);
  const extra = abs - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The journal amounts of a categorisation: a bank line of `bankMinor` (negative for money out) is
 * balanced by category lines of the opposite sign. Plain parts are always positive.
 */
export function splitsToJournal(bankMinor: number, parts: number[]): number[] {
  const sign = bankMinor < 0 ? 1 : -1;
  return parts.map((p) => sign * Math.abs(p));
}

/** The plain parts of a categorisation back from its journal amounts. */
export const journalToSplits = (amounts: number[]): number[] => amounts.map((a) => Math.abs(a));

// ── Debits and credits ────────────────────────────────────────────────────

/** A signed journal amount (debit positive) as the two columns the Accounting view shows. */
export function debitCredit(amountMinor: number): { debit: number | null; credit: number | null } {
  if (amountMinor > 0) return { debit: amountMinor, credit: null };
  if (amountMinor < 0) return { debit: null, credit: -amountMinor };
  return { debit: null, credit: null };
}

/** Debit and credit columns back to the signed amount; null when both or neither are filled. */
export function fromDebitCredit(debit: number | null, credit: number | null): number | null {
  const d = debit ?? 0;
  const c = credit ?? 0;
  if ((d === 0) === (c === 0)) return null;
  if (d < 0 || c < 0) return null;
  return d - c;
}

/** Totals of a manual journal's lines (functional minor units), and whether they balance. */
export function journalBalance(amounts: (number | null)[]): { debits: number; credits: number; diff: number; balanced: boolean } {
  let debits = 0;
  let credits = 0;
  let count = 0;
  for (const a of amounts) {
    if (a == null || a === 0) continue;
    count++;
    if (a > 0) debits += a;
    else credits -= a;
  }
  const diff = debits - credits;
  return { debits, credits, diff, balanced: diff === 0 && count >= 2 };
}

// ── Foreign currency ──────────────────────────────────────────────────────

/**
 * `amountMinor` of `from` at `rate` (units of `to` per unit of `from`) in `to`'s minor units,
 * rounded half away from zero, as the host's `rates::convert` does, so an estimate here matches
 * what the host posts.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  const v = amountMinor * rate * 10 ** (exponent(to) - exponent(from));
  const r = Math.round(Math.abs(v));
  return v < 0 ? -r : r;
}

/**
 * The cross rate from two ECB reference rates (units of each currency per 1 EUR): units of `to`
 * per unit of `from`.
 */
export const crossRate = (eurToFrom: number, eurToTo: number): number => eurToTo / eurToFrom;

export interface FxLine {
  /** The line's functional amount (debit positive), or null when it isn't known yet. */
  functional: number | null;
  /** In a currency other than the functional one. */
  foreign: boolean;
  /** Waiting for its rate (a foreign line with an amount and no functional amount of the user's). */
  pending: boolean;
}

/**
 * The balance check of a journal whose lines may be in several currencies. Lines all in the
 * functional currency must balance exactly. With a foreign line, the host posts what's left over
 * after translation to realised FX gains or losses, so the entry can post once every rate is known;
 * `fxDifference` is that leftover (positive: more debits, so a gain is credited), and `large` flags
 * one past 2% of the entry, for the form to question before it posts.
 */
export function journalBalanceFx(lines: FxLine[]): { debits: number; credits: number; diff: number; balanced: boolean; fxDifference: number; large: boolean; pending: boolean } {
  const base = journalBalance(lines.map((l) => l.functional));
  const known = lines.filter((l) => l.functional != null && l.functional !== 0).length;
  const pending = lines.some((l) => l.pending);
  const foreign = lines.some((l) => l.foreign && l.functional != null);
  const fxDifference = foreign ? base.diff : 0;
  // A difference past 2% of the entry is more likely a typo than an exchange gain or loss.
  const large = Math.abs(fxDifference) * 50 > Math.max(base.debits, base.credits);
  return { debits: base.debits, credits: base.credits, diff: base.diff, balanced: !pending && known >= 2 && (base.diff === 0 || foreign), fxDifference, large, pending };
}

/** Today in the local calendar as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A `YYYY-MM-DD` date in the user's locale ("4 Nov 2026"), without a timezone shift. */
export function formatDate(iso: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

// ── Category suggestions (the host's local model) ────────────────────────────

/** What the inbox knows about a line when asking for suggestions. */
export interface SuggestRow {
  id: number;
  draft: boolean;
  /** Its one category line is still uncategorised. */
  unsorted: boolean;
  /** A bank line with a single category line (a split isn't suggested for). */
  single: boolean;
}

/** The lines a bulk "Suggest" asks about: unsorted single-category drafts without a suggestion
 * yet, at most `max` of them. */
export function pickSuggestable(rows: SuggestRow[], have: Record<number, number | null>, max: number): number[] {
  return rows.filter((r) => r.draft && r.unsorted && r.single && !(r.id in have)).slice(0, max).map((r) => r.id);
}

/** Merge the host's answers into the shown suggestions. A line the host left out keeps what it had. */
export function mergeSuggestions(
  have: Record<number, number | null>,
  got: { entry_id: number; ledger_account_id: number | null }[],
): Record<number, number | null> {
  const next = { ...have };
  for (const g of got) next[g.entry_id] = g.ledger_account_id;
  return next;
}
