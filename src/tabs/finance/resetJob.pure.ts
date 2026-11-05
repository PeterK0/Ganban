// Deleting all finance data (docs/design/FINANCE.md § Starting over): what the confirmation lists,
// when its final button is enabled, and how full the progress bar is. Pure, so
// scripts/test-finance-reset.mjs can check it.

/** The word the user types to confirm; the host refuses the reset without it. */
export const CONFIRM_WORD = 'DELETE';

/** What a reset would delete (`fin_reset_preview`). */
export interface ResetCounts {
  accounts: number;
  entries: number;
  rules: number;
  layouts: number;
}

/** The fields of a reset job this needs. */
export interface ResetProgress {
  state: 'running' | 'done' | 'failed';
  done: number;
  total: number;
}

/** The final button is enabled only once the word is typed exactly. */
export function confirmed(typed: string): boolean {
  return typed === CONFIRM_WORD;
}

const plural = (n: number, one: string, many: string, fmt: (n: number) => string) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The confirmation's list: what goes, and, when kept, what stays. */
export function resetSummary(c: ResetCounts, keepRules: boolean, fmt: (n: number) => string = String): { goes: string[]; stays: string[] } {
  const goes = [plural(c.accounts, 'account', 'accounts', fmt), plural(c.entries, 'transaction', 'transactions', fmt)];
  const kept = [plural(c.rules, 'categorisation rule', 'categorisation rules', fmt), plural(c.layouts, 'saved import layout', 'saved import layouts', fmt)];
  return keepRules ? { goes, stays: kept } : { goes: [...goes, ...kept], stays: [] };
}

/** How full the bar is, 0 to 100. */
export function resetPercent(job: ResetProgress): number {
  if (job.state === 'done') return 100;
  if (job.total <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, job.done / job.total)) * 100);
}
