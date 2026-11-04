#!/usr/bin/env node
// Unit test for the Finance tab's money helpers (src/tabs/finance/money.pure.ts): minor units to
// display and back in several locales, split checks, and the debit/credit view.
// node scripts/test-finance-money.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finmoney-')), 'money.mjs');
execSync(`npx esbuild src/tabs/finance/money.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const norm = (s) => (typeof s === 'string' ? s.replace(/[\u00a0\u202f]/g, ' ') : s);
const eq = (got, want, msg) => {
  const g = JSON.stringify(norm(got)), w = JSON.stringify(norm(want));
  if (g === w) pass++;
  else { fail++; console.log(`FAIL: ${msg}\n  got  ${g}\n  want ${w}`); }
};

// Exponents
eq(m.exponent('EUR'), 2, 'EUR has 2 decimals');
eq(m.exponent('JPY'), 0, 'JPY has none');
eq(m.exponent('KWD'), 3, 'KWD has 3');
eq(m.exponent('NOPE'), 2, 'an unknown code falls back to 2');

// Display
eq(m.formatMoney(123456, 'EUR', 'en-IE'), '€1,234.56', 'en-IE euro');
eq(m.formatMoney(-123456, 'EUR', 'de-DE'), '-1.234,56 €', 'de-DE negative euro');
eq(m.formatMoney(-4200, 'EUR', 'el-GR'), '-42,00 €', 'el-GR euro');
eq(m.formatMoney(1500, 'JPY', 'en-US'), '¥1,500', 'yen has no minor digits');
eq(m.formatMoney(5, 'EUR', 'en-IE'), '€0.05', 'a few cents');
eq(m.formatMoney(4200, 'EUR', 'en-IE', { sign: true }), '+€42.00', 'signed display');
eq(m.formatMoney(0, 'EUR', 'en-IE', { sign: true }), '€0.00', 'zero carries no sign');
eq(m.formatMoneyShort(123456, 'EUR', 'en-IE'), '€1,235', 'short money rounds to whole units');
eq(m.formatMoneyShort(-123449, 'EUR', 'de-DE'), '-1.234 €', 'short money in de');
eq(m.formatAmount(-123450, 'USD', 'en-US'), '-1,234.50', 'number alone');

// Parsing
eq(m.parseMoney('12.50', 'EUR', 'en-IE'), 1250, 'en decimal point');
eq(m.parseMoney('1,234.56', 'EUR', 'en-IE'), 123456, 'en grouping');
eq(m.parseMoney('1.234,56', 'EUR', 'de-DE'), 123456, 'de grouping');
eq(m.parseMoney('12,5', 'EUR', 'de-DE'), 1250, 'de one decimal');
eq(m.parseMoney('12.5', 'EUR', 'de-DE'), 1250, 'a lone point on a comma locale is a decimal mark');
eq(m.parseMoney('1.250', 'EUR', 'de-DE'), 125000, 'three digits after the group mark are grouping');
eq(m.parseMoney('1,250', 'EUR', 'en-IE'), 125000, 'en: three digits after a comma are grouping');
eq(m.parseMoney('-42', 'EUR', 'en-IE'), -4200, 'leading minus');
eq(m.parseMoney('42-', 'EUR', 'en-IE'), -4200, 'trailing minus');
eq(m.parseMoney('\u221242,00', 'EUR', 'de-DE'), -4200, 'unicode minus');
eq(m.parseMoney('(42.00)', 'EUR', 'en-IE'), -4200, 'accounting parentheses');
eq(m.parseMoney('€ 9.99', 'EUR', 'en-IE'), 999, 'currency symbol');
eq(m.parseMoney('9,99 EUR', 'EUR', 'de-DE'), 999, 'currency code');
eq(m.parseMoney('1 234,56', 'EUR', 'fr-FR'), 123456, 'space grouping');
eq(m.parseMoney('1500', 'JPY', 'en-US'), 1500, 'yen');
eq(m.parseMoney('15.5', 'JPY', 'en-US'), null, 'yen refuses decimals');
eq(m.parseMoney('1.234', 'EUR', 'en-IE'), null, 'more decimals than the currency has is refused');
eq(m.parseMoney('abc', 'EUR', 'en-IE'), null, 'not a number');
eq(m.parseMoney('', 'EUR', 'en-IE'), null, 'empty');
eq(m.parseMoney('.5', 'EUR', 'en-IE'), 50, 'no integer part');
eq(m.parseMoney('0.1', 'EUR', 'en-IE') + m.parseMoney('0.2', 'EUR', 'en-IE'), 30, 'no float drift');

// Round trips
for (const [minor, cur, loc] of [[123456, 'EUR', 'de-DE'], [-5, 'EUR', 'en-IE'], [1500, 'JPY', 'ja-JP'], [-1000001, 'KWD', 'en-US'], [0, 'EUR', 'el-GR']]) {
  eq(m.parseMoney(m.toInput(minor, cur, loc), cur, loc), minor, `toInput round trip ${minor} ${cur} ${loc}`);
  eq(m.parseMoney(m.formatMoney(minor, cur, loc), cur, loc), minor, `formatMoney round trip ${minor} ${cur} ${loc}`);
}
eq(m.toInput(-1250, 'EUR', 'de-DE'), '-12,50', 'toInput uses the locale mark');

// Splits
eq(m.checkSplits(4200, [{ ledgerAccountId: 1, amountMinor: 4200 }]), { ok: true, remainder: 0, errors: [] }, 'one full split');
eq(m.checkSplits(-4200, [{ ledgerAccountId: 1, amountMinor: 3000 }, { ledgerAccountId: 2, amountMinor: 1200 }]).ok, true, 'a negative total is its plain size');
eq(m.checkSplits(4200, [{ ledgerAccountId: 1, amountMinor: 3000 }]).remainder, 1200, 'remainder left');
eq(m.checkSplits(4200, [{ ledgerAccountId: 1, amountMinor: 5000 }]).remainder, -800, 'over-assigned');
eq(m.checkSplits(4200, [{ ledgerAccountId: 1, amountMinor: 5000 }]).ok, false, 'over-assigned is refused');
eq(m.checkSplits(4200, [{ ledgerAccountId: null, amountMinor: 4200 }]).errors, ['Line 1 needs a category.'], 'a category is required');
eq(m.checkSplits(4200, [{ ledgerAccountId: 1, amountMinor: 4200 }, { ledgerAccountId: 2, amountMinor: 0 }]).ok, false, 'zero parts are refused');
eq(m.checkSplits(4200, []).ok, false, 'no parts');
eq(m.checkSplits(0, [{ ledgerAccountId: 1, amountMinor: 1 }]).ok, false, 'a zero line has nothing to split');
eq(m.evenSplit(1000, 3), [334, 333, 333], 'even split keeps every cent');
eq(m.evenSplit(-1000, 3).reduce((a, b) => a + b, 0), 1000, 'even split of a negative total is plain');
eq(m.evenSplit(100, 0), [], 'no parts');
eq(m.splitsToJournal(-4200, [3000, 1200]), [3000, 1200], 'money out: category lines are debits');
eq(m.splitsToJournal(4200, [4200]), [-4200], 'money in: category lines are credits');
eq(m.journalToSplits([-3000, -1200]), [3000, 1200], 'journal back to plain parts');

// Debits and credits
eq(m.debitCredit(500), { debit: 500, credit: null }, 'positive is a debit');
eq(m.debitCredit(-500), { debit: null, credit: 500 }, 'negative is a credit');
eq(m.debitCredit(0), { debit: null, credit: null }, 'zero is neither');
eq(m.fromDebitCredit(500, null), 500, 'debit column');
eq(m.fromDebitCredit(null, 500), -500, 'credit column');
eq(m.fromDebitCredit(500, 500), null, 'both columns is not a line');
eq(m.fromDebitCredit(null, null), null, 'neither column');
eq(m.journalBalance([1000, -600, -400]), { debits: 1000, credits: 1000, diff: 0, balanced: true }, 'balanced journal');
eq(m.journalBalance([1000, -600]).diff, 400, 'unbalanced by 4.00');
eq(m.journalBalance([0, null]).balanced, false, 'an empty journal does not balance');
eq(m.journalBalance([1000]).balanced, false, 'one line does not balance');

// Foreign currency (the host's rounding: half away from zero)
eq(m.convertMinor(10000, 'USD', 'EUR', 0.92), 9200, 'USD 100 at 0.92');
eq(m.convertMinor(-10000, 'USD', 'EUR', 0.92), -9200, 'a credit keeps its sign');
eq(m.convertMinor(1500, 'JPY', 'EUR', 1 / 160), 938, 'yen has no minor digits: 1500 JPY is 9.375 EUR, rounded up');
eq(m.convertMinor(-5, 'EUR', 'EUR', 0.5), -3, 'half away from zero on a negative');
eq(m.convertMinor(1000, 'EUR', 'KWD', 0.33), 3300, 'into a three-decimal currency');
eq(m.crossRate(1.1, 0.85), 0.85 / 1.1, 'USD to GBP through EUR');
eq(m.crossRate(1, 1.1), 1.1, 'EUR to USD is the ECB rate');
// Mixed currencies: the host posts the leftover to realised FX.
const F = (functional, foreign = false, pending = false) => ({ functional, foreign, pending });
eq(m.journalBalanceFx([F(9201, true), F(-9200)]), { debits: 9201, credits: 9200, diff: 1, balanced: true, fxDifference: 1, large: false, pending: false }, 'a foreign line may leave a difference, posted as FX');
eq(m.journalBalanceFx([F(9201), F(-9200)]).balanced, false, 'lines in the functional currency must balance exactly');
eq(m.journalBalanceFx([F(9200), F(-9200)]).fxDifference, 0, 'no FX without a foreign line');
eq(m.journalBalanceFx([F(null, true, true), F(-9200)]), { debits: 0, credits: 9200, diff: -9200, balanced: false, fxDifference: 0, large: false, pending: true }, 'a rate still loading');
eq(m.journalBalanceFx([F(5000), F(-5000), F(null)]).balanced, true, 'a blank line is ignored');
eq(m.journalBalanceFx([F(5000, true)]).balanced, false, 'one line does not post');
eq(m.journalBalanceFx([F(100000), F(-460, true)]).large, true, 'a difference past 2% is flagged');
eq(m.journalBalanceFx([F(10000), F(-9850, true)]).large, false, 'a 1.5% difference is not');

// Dates
eq(m.todayIso(new Date(2026, 10, 4, 23, 59)), '2026-11-04', 'local today');
eq(m.formatDate('2026-11-04', 'en-GB'), '4 Nov 2026', 'date in the locale');
eq(m.formatDate('garbage', 'en-GB'), 'garbage', 'a bad date passes through');

// Category suggestions
const rows = [
  { id: 1, draft: true, unsorted: true, single: true },
  { id: 2, draft: true, unsorted: false, single: true },
  { id: 3, draft: false, unsorted: true, single: true },
  { id: 4, draft: true, unsorted: true, single: false },
  { id: 5, draft: true, unsorted: true, single: true },
  { id: 6, draft: true, unsorted: true, single: true },
];
eq(m.pickSuggestable(rows, {}, 60), [1, 5, 6], 'only unsorted single-category drafts');
eq(m.pickSuggestable(rows, { 5: null }, 60), [1, 6], 'a line already answered is not asked again');
eq(m.pickSuggestable(rows, {}, 2), [1, 5], 'capped at the host limit');
eq(m.mergeSuggestions({ 1: 10 }, [{ entry_id: 5, ledger_account_id: 12 }, { entry_id: 6, ledger_account_id: null }]), { 1: 10, 5: 12, 6: null }, 'answers merge, nulls kept');

console.log(`finance money: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
