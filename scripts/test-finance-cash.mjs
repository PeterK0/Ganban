#!/usr/bin/env node
// Unit test for the Finance quick-add of a cash expense (src/tabs/finance/cashExpense.pure.ts):
// which cash account it posts to, and the balanced entry it makes. Synthetic accounts only.
// node scripts/test-finance-cash.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'fincash-')), 'cash.mjs');
execSync(`npx esbuild src/tabs/finance/cashExpense.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`FAIL ${msg}\n  got  ${g}\n  want ${w}`);
  }
};

const acct = (id, kind, name, currency = 'EUR', archived = false) => ({ id, ledger_account_id: 100 + id, kind, name, currency, archived });

// Which cash account.
eq(m.findCashAccount([], 'EUR'), null, 'no accounts: none');
eq(m.findCashAccount([acct(1, 'current', 'Main')], 'EUR'), null, 'a bank account is not cash');
eq(m.findCashAccount([acct(1, 'cash', 'Cash', 'EUR', true)], 'EUR'), null, 'an archived cash account is skipped');
eq(m.findCashAccount([acct(1, 'cash', 'Cash', 'USD')], 'EUR'), null, 'another currency is skipped');
eq(m.findCashAccount([acct(3, 'cash', 'Wallet'), acct(2, 'cash', 'Vault')], 'EUR')?.id, 2, 'the oldest when none is named Cash');
eq(m.findCashAccount([acct(2, 'cash', 'Vault'), acct(5, 'cash', ' cash ')], 'EUR')?.id, 5, 'the one named Cash first');

// The entry.
const e = m.cashExpenseEntry({ amountMinor: 1250, categoryLedgerId: 7, categoryName: 'Groceries', cashLedgerId: 101, currency: 'EUR', date: '2026-11-04', note: '  market ' });
eq(e.description, 'market', 'the note is the description, trimmed');
eq(e.lines, [{ ledgerAccountId: 7, amountMinor: 1250, currency: 'EUR' }, { ledgerAccountId: 101, amountMinor: -1250, currency: 'EUR' }], 'category debited, cash credited');
eq(e.lines.reduce((s, l) => s + l.amountMinor, 0), 0, 'balanced');
eq(m.cashExpenseEntry({ amountMinor: -300, categoryLedgerId: 7, categoryName: 'Groceries', cashLedgerId: 101, currency: 'EUR', date: '2026-11-04', note: '' }).description, 'Groceries', 'no note: the category');
eq(m.cashExpenseEntry({ amountMinor: -300, categoryLedgerId: 7, categoryName: 'G', cashLedgerId: 101, currency: 'EUR', date: '2026-11-04', note: '' }).lines[0].amountMinor, 300, 'a negative amount is still spending');
let threw = false;
try {
  m.cashExpenseEntry({ amountMinor: 0, categoryLedgerId: 7, categoryName: 'G', cashLedgerId: 101, currency: 'EUR', date: '2026-11-04', note: '' });
} catch {
  threw = true;
}
eq(threw, true, 'a zero amount is refused');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
