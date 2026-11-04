// Quick-add a cash expense (the phone's Finance screen): the Cash account it posts to and the
// journal entry it makes. Pure, so scripts/test-finance-cash.mjs can check it.

/** The fields of a financial account this needs. */
export interface CashCandidate {
  id: number;
  ledger_account_id: number;
  kind: string;
  name: string;
  currency: string;
  archived: boolean;
}

/** The live cash account in `currency` to post to: one named "Cash" first, else the oldest. */
export function findCashAccount<T extends CashCandidate>(accounts: T[], currency: string): T | null {
  const live = accounts.filter((a) => a.kind === 'cash' && !a.archived && a.currency === currency).sort((a, b) => a.id - b.id);
  return live.find((a) => a.name.trim().toLowerCase() === 'cash') ?? live[0] ?? null;
}

/**
 * The entry for a cash expense of `amountMinor` (positive) on `date`: the category is debited and
 * the cash account credited, both in `currency`. The note is the description; without one, the
 * category's name.
 */
export function cashExpenseEntry(input: { amountMinor: number; categoryLedgerId: number; categoryName: string; cashLedgerId: number; currency: string; date: string; note: string }) {
  const amount = Math.abs(Math.round(input.amountMinor));
  if (!amount) throw new Error('Enter an amount.');
  const note = input.note.trim();
  return {
    date: input.date,
    description: note || input.categoryName,
    lines: [
      { ledgerAccountId: input.categoryLedgerId, amountMinor: amount, currency: input.currency },
      { ledgerAccountId: input.cashLedgerId, amountMinor: -amount, currency: input.currency },
    ],
  };
}
