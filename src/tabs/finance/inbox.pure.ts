// The inbox at scale, the words and sums the screens show (no React, so it's tested on its own):
// what "Select all" covers, the confirm texts of the bulk actions with their counts, a payee
// group's date range, and how far the local model's suggestion job has got.

/** A count in the user's locale (10,302). */
export const count = (n: number, locale?: string) => new Intl.NumberFormat(locale).format(n);

const lines = (n: number, locale?: string) => `${count(n, locale)} ${n === 1 ? 'transaction' : 'transactions'}`;

/** The "Select all" label: it ticks only the lines shown, and says so when there are more. */
export function selectLabel(selected: number, shown: number, total: number, locale?: string): string {
  if (selected) return `${count(selected, locale)} selected`;
  return shown < total ? `Select the ${count(shown, locale)} shown` : 'Select all';
}

/** The confirm before posting everything a filter matches. */
export function postAllConfirm(n: number, filtered: boolean, locale?: string): string {
  const which = filtered ? `matching these filters` : `in the inbox`;
  return `Post all ${lines(n, locale)} ${which}, not just the ones shown? Posted transactions stay editable until their month is closed, so you can still re-sort or delete any of them.`;
}

/** The confirm before giving a category to everything unsorted that a filter matches. */
export function categoriseAllConfirm(n: number, category: string, locale?: string): string {
  return `Sort ${lines(n, locale)} as ${category}? This covers every unsorted line matching these filters, not just the ones shown. Transfers are left as they are, and each line stays editable while it's a draft or its month is open.`;
}

/** The result line after a bulk post; `left` drafts stayed (a closed month, a transfer to review). */
export function postedText(posted: number, left: number, locale?: string): string {
  const head = `Posted ${lines(posted, locale)}.`;
  return left ? `${head} ${count(left, locale)} stayed in the inbox (a closed month, or a transfer to confirm).` : head;
}

/** The result line after a bulk categorise. */
export function categorisedText(done: number, skipped: number, category: string, locale?: string): string {
  const head = `Sorted ${lines(done, locale)} as ${category}.`;
  return skipped ? `${head} ${count(skipped, locale)} couldn't take it and stayed unsorted.` : head;
}

/** A group's dates: one day, or first – last. Dates are `YYYY-MM-DD`, formatted by `fmt`. */
export function dateRange(first: string, last: string, fmt: (iso: string) => string): string {
  return first === last ? fmt(first) : `${fmt(first)} – ${fmt(last)}`;
}

/** Whether any filter beyond the inbox itself is set (the confirm says "matching these filters"). */
export function isFiltered(f: { from?: string; to?: string; accountId?: number; search?: string; uncategorised?: boolean; groupKey?: string }): boolean {
  return !!(f.from || f.to || f.accountId || f.search || f.uncategorised || f.groupKey);
}

export interface JobView {
  state: 'running' | 'done' | 'failed';
  done: number;
  total: number;
  suggested: number;
  error: string | null;
}

/** What the suggestion job's progress line says. */
export function suggestJobText(job: JobView, locale?: string): string {
  if (job.state === 'running') return job.total ? `Suggesting… ${count(job.done, locale)} of ${count(job.total, locale)} payees` : 'Suggesting…';
  if (job.state === 'failed') return job.error ? `Suggestions stopped: ${job.error}.` : 'Suggestions stopped.';
  if (!job.total) return 'Every unsorted payee has a suggestion already.';
  return `Suggested a category for ${count(job.suggested, locale)} of ${count(job.total, locale)} payees. Take them payee by payee below.`;
}

/** A bulk action the client stopped waiting for: the host finishes it anyway, so the screen says
 * so instead of showing the transport's timeout text. */
export function bulkErrorText(text: string): string {
  return /^timed out/i.test(text.trim())
    ? 'Still working through them on the host. The list refreshes in a moment.'
    : text;
}
