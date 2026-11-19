#!/usr/bin/env node
// Unit test for "To sort", payees and rules (src/tabs/finance/sorting.pure.ts): the category
// picker, when filing asks about the payee's default, the toast, the views' filters, the bulk
// bar's scope, the tidy banner, the import result's links, accounts by bank and the rule words.
// node scripts/test-finance-sorting.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'finsort-')), 'sorting.mjs');
execSync(`npx esbuild src/tabs/finance/sorting.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(out);

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL: ${msg}\n  got  ${g}\n  want ${w}`); }
};

// The picker: spending and income only, no system or money accounts but Bank fees, most used first.
const la = (id, name, cls, extra = {}) => ({ id, name, class: cls, system_key: null, currency: null, archived: false, ...extra });
const ledger = [
  la(1, 'Groceries', 'expense'),
  la(2, 'Eating out', 'expense'),
  la(3, 'Salary', 'income'),
  la(4, 'Uncategorised spending', 'expense', { system_key: 'uncategorised_expense' }),
  la(5, 'FX gains', 'income', { system_key: 'fx_gain' }),
  la(6, 'Bank fees', 'expense', { system_key: 'bank_fees' }),
  la(7, 'Everyday', 'asset', { currency: 'EUR' }),
  la(8, 'Old', 'expense', { archived: true }),
  la(9, 'GBP balance', 'expense', { currency: 'GBP' }),
];
eq(m.pickerCategories(ledger).map((l) => l.name), ['Bank fees', 'Eating out', 'Groceries', 'Salary'], 'by name, spending first');
const uses = m.usesFromPayees([
  { default_ledger_account_id: 3, lines: 12 },
  { default_ledger_account_id: 2, lines: 30 },
  { default_ledger_account_id: 2, lines: 5 },
  { default_ledger_account_id: null, lines: 99 },
]);
eq([...uses.entries()].sort(), [[2, 35], [3, 12]], 'uses add up per category, payees without one skipped');
eq(m.pickerCategories(ledger, uses).map((l) => l.name), ['Eating out', 'Salary', 'Bank fees', 'Groceries'], 'most used first');

// Asking: only when the payee files elsewhere and doesn't ask every time.
eq(m.mustAsk(null, 'c:1'), false, 'no payee');
eq(m.mustAsk({ default_ledger_account_id: null, ask_every_time: false }, 'c:1'), false, 'the first category becomes the default');
eq(m.mustAsk({ default_ledger_account_id: 1, ask_every_time: false }, 'c:1'), false, 'the same as usual');
eq(m.mustAsk({ default_ledger_account_id: 1, ask_every_time: false }, 'c:2'), true, 'another category asks');
eq(m.mustAsk({ default_ledger_account_id: 1, ask_every_time: true }, 'c:2'), false, 'ask every time never changes the default');
eq(m.mustAsk({ default_ledger_account_id: null, default_account_id: 3, ask_every_time: false }, 'a:3'), false, 'the same move as usual');
eq(m.mustAsk({ default_ledger_account_id: null, default_account_id: 3, ask_every_time: false }, 'c:3'), true, 'a category where a move is usual asks');
eq(m.mustAsk({ default_ledger_account_id: 3, ask_every_time: false }, 'a:3'), true, 'a move where a category is usual asks');
eq(m.defaultTarget({ default_ledger_account_id: 5, default_account_id: 2, ask_every_time: false }), 'a:2', 'a move default wins');
eq(m.defaultToast('Wolt', 'Eating out', 0, 0), 'Wolt → Eating out from now on', 'the toast');
eq(m.defaultToast('Wolt', 'Eating out', 5, 23, 'en-GB'), 'Wolt → Eating out from now on. Also filed: 5 lines waiting in To sort and 23 in Unsorted history.', 'the toast says what else it filed');
eq(m.defaultToast('Wolt', 'Eating out', 1, 0), 'Wolt → Eating out from now on. Also filed: 1 line waiting in To sort.', 'one more line');
eq(m.defaultToast('Wolt', 'Eating out', 0, 4), 'Wolt → Eating out from now on. Also filed: 4 in Unsorted history.', 'history only');
eq(m.undoText('Gym Zone', 'Health', 12, true), 'Gym Zone no longer files under Health. The 12 lines it filed are back where they were. The line you picked stays under Health.', 'undo says what it did');
eq(m.undoText('Gym Zone', 'Health', 0, false), 'Gym Zone no longer files under Health.', 'undo of a default set on the page');
eq(m.nameDiff('Delta Kiosk Ltd', 'Delta Kiosk'), '“Ltd”', 'what differs');
eq(m.nameDiff('Golden Grill Athens', 'Golden Grill Patras'), '“Athens”, “Patras”', 'two branches');
eq(m.nameDiff('ALPHA SHOP', 'Alpha Shop'), 'only capitals or punctuation', 'case only');
eq(m.ruleFromForm({ text: '', outFrom: null, outTo: null, category: 2 }), null, 'a rule needs a condition');
eq(m.ruleFromForm({ text: 'x', outFrom: null, outTo: null, category: null }), null, 'and a category');
eq(m.ruleFromForm({ text: ' rent ', outFrom: 50000, outTo: 90000, category: 2 }), { conditions: { text: 'rent', maxAmountMinor: -50000, minAmountMinor: -90000 }, action: { ledgerAccountId: 2, splits: [] } }, 'words and a money-out range');
eq(m.formFromRule({ conditions: { text: 'rent', maxAmountMinor: -50000, minAmountMinor: -90000 }, action: { ledgerAccountId: 2 } }), { text: 'rent', outFrom: 50000, outTo: 90000, category: 2 }, 'and back');
eq(m.ruleFromForm(m.formFromRule({ conditions: { text: 'tfl', maxAmountMinor: 0 }, action: { ledgerAccountId: 3 } }))?.conditions, { text: 'tfl' }, 'a plain money-out bound reads as no range');
const ask = m.askChoices('Wolt', 'Eating out', 'Groceries');
eq([ask.title, ask.once, ask.change], ['Wolt usually goes to Eating out.', 'Just this one to Groceries', "Change Wolt's default to Groceries"], 'the two answers');

// Views and bulk.
eq(m.viewFilter('tosort'), { status: 'draft' }, 'to sort is the drafts');
eq(m.viewFilter('transfers'), { transfers: true }, 'transfers');
eq(m.viewFilter('history'), { unsorted: true }, 'unsorted history');
eq(m.viewFilter('all'), {}, 'all');
eq(m.narrows({}), false, 'nothing picked');
eq(m.narrows({ search: '  ' }), false, 'a blank search');
eq(m.narrows({ accountId: 3 }), true, 'an account');
eq(m.narrows({ importBatchId: 7 }), true, 'one import');
eq(m.narrows({ ids: [] }), false, 'an empty selection');
eq(m.bulkScope(3, true, 40).on, 'selection', 'ticked lines win');
eq(m.bulkScope(0, true, 40, 'en-GB'), { on: 'filter', label: 'All 40 lines this filter matches' }, 'an active filter');
eq(m.bulkScope(0, false, 400).on, null, 'no filter, no bulk');
eq(m.bulkScope(0, true, 0).on, null, 'a filter matching nothing');

// The tidy banner.
eq(m.tidyText({ filed: 0, history: 0, left: 9000 }, 90), null, 'nothing to tidy');
eq(m.tidyText({ filed: 1200, history: 8400, left: 375 }, 90, 'en-GB'),
  "Tidy up: 1,200 lines go under your payees' usual categories, and 8,400 lines older than 90 days move to Unsorted history. That leaves 375 lines for you to sort.", 'both');
eq(m.tidyText({ filed: 1, history: 0, left: 1 }, 90), "Tidy up: 1 line goes under your payees' usual categories. That leaves 1 line for you to sort.", 'one');

// The import result's links.
const items = m.resultItems({ created: 50, duplicates: 0, categorised_by_rules: 4, filed_by_payee: 8, refunds: 0, paired: 3, review: 0, history_unsorted: 0, history_suggested: 0, decisions: 6, transfer_pair_ids: [1, 2, 3] });
eq(items.map((i) => [i.n, i.label, i.link]), [[6, 'to sort', 'tosort'], [12, 'filed by your payees and rules', 'filed'], [3, 'transfers matched', 'transfers']], 'a weekly import');
eq(m.resultItems({ created: 0, duplicates: 50, categorised_by_rules: 0, paired: 0, review: 0, decisions: 0 }).map((i) => i.label), ['to sort', 'already imported'], 'a file seen before');
eq(m.nextStep(9625, 375), 'history', 'a first import points at the biggest payees');
eq(m.nextStep(0, 15), null, 'a weekly one does not');

// Accounts by bank, pockets under their bank, no bank last.
const acc = (id, name, institution, kind) => ({ id, name, institution, kind, archived: false });
const groups = m.groupByBank([acc(1, 'Vault', 'Revo', 'savings'), acc(2, 'Wallet', null, 'cash'), acc(3, 'Main', 'Revo', 'current'), acc(4, 'Card', 'Alpha', 'card')]);
eq(groups.map((g) => [g.bank, g.accounts.map((a) => a.name)]), [['Alpha', ['Card']], ['Revo', ['Main', 'Vault']], ['Other', ['Wallet']]], 'grouped');

// Payees sorted.
const ps = [{ name: 'b', lines: 2, total_minor: -500, last_date: '2026-01-02' }, { name: 'a', lines: 9, total_minor: -100, last_date: null }, { name: 'c', lines: 1, total_minor: 900, last_date: '2026-03-01' }];
eq(m.sortPayees(ps, 'name').map((p) => p.name), ['a', 'b', 'c'], 'by name');
eq(m.sortPayees(ps, 'lines').map((p) => p.name), ['a', 'b', 'c'], 'most lines first');
eq(m.sortPayees(ps, 'total').map((p) => p.name), ['c', 'b', 'a'], 'largest amount first, either way');
eq(m.sortPayees(ps, 'last').map((p) => p.name), ['c', 'b', 'a'], 'latest first, never seen last');
eq(m.sortPayees(ps, 'name', true).map((p) => p.name), ['c', 'b', 'a'], 'flipped');

// Rules in words.
const names = (id) => ({ 1: 'Everyday', 2: 'Eating out', 3: 'Fees' })[id];
const money = (n) => (n / 100).toFixed(2);
eq(m.ruleMatches({ conditions: { text: 'wolt', accountId: 1, maxAmountMinor: 0 }, action: {} }, names, money), 'Text has “wolt” · on Everyday · money out', 'a learned rule');
eq(m.ruleMatches({ conditions: { minAmountMinor: -5000, maxAmountMinor: -100 }, action: {} }, names, money), 'Between -50.00 and -1.00', 'bounds');
eq(m.ruleMatches({ conditions: {}, action: {} }, names, money), 'Every line', 'no conditions');
eq(m.ruleSets({ conditions: {}, action: { ledgerAccountId: 2 } }, names), 'Eating out', 'one category');
eq(m.ruleSets({ conditions: {}, action: { splits: [{ ledgerAccountId: 2 }, { ledgerAccountId: 3 }] } }, names), 'Split: Eating out, Fees', 'a split');

// The usual amount is the median, so one odd line doesn't move it.
eq(m.usualAmount([]), null, 'no lines');
eq(m.usualAmount([-1200, -900, -100000]), -1200, 'odd count');
eq(m.usualAmount([-1000, -1200]), -1100, 'even count');

// The wizard starts from the host's guess.
const cols = ['Booked on', 'Text', 'Counterparty', 'Amount', 'Ccy'];
eq(m.columnsFromMapping({ bookedDate: 'Booked on', description: ['Text'], payee: 'counterparty', amount: 3, currency: 'Ccy', balance: 'Saldo' }, cols),
  { bookedDate: 0, payee: 2, amount: 3, currency: 4, description: 1 }, 'by header text or index; a column not in the file is left out');
eq(m.columnsFromMapping(null, cols), {}, 'no guess');

eq([m.moveLabel('My Savings', 'in'), m.moveLabel('My Savings', 'out')], ['From My Savings', 'To My Savings'], 'a move reads from the line');
eq(m.splitText('Harbor Cafe Ltd', 'Harbour Cafe', 'Harbor Cafe Ltd', 6), 'Split “Harbor Cafe Ltd” off Harbour Cafe: it is now the payee Harbor Cafe Ltd, with its 6 lines.', 'which spelling went where');
eq(m.splitText('Pearl Pubs', 'Pearl Pubs', 'Pearl Pubs', 1), 'Split “Pearl Pubs” off Pearl Pubs: it is now a payee of its own, with its 1 line.', 'same name');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
