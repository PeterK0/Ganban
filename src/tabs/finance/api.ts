// The Finance client: one typed function per command in docs/design/FINANCE.md. Every command acts on
// the caller's own entity. Over HTTP the host stamps `userId` from the signed-in member; the desktop's
// local path names its acting profile, as the other personal commands do. Calls go through
// `invokePrivate`, so amounts and payees never reach the console log.
import { invokePrivate } from '../../lib/api';
import type { ImportStage } from './importJob.pure';
import { splitsToJournal } from './money.pure';

const actingUser = () => Number(localStorage.getItem('currentUserId')) || undefined;
const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  invokePrivate<T>(command, { userId: actingUser(), ...args });

// ── Shapes (rows come back snake_case, as every host row does) ───────────────

export type LedgerClass = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type AccountKind = 'current' | 'savings' | 'card' | 'cash' | 'loan';
export type EntryStatus = 'draft' | 'posted' | 'reversed';
export type PairStatus = 'auto' | 'review' | 'confirmed' | 'rejected';

export interface Entity {
  id: number;
  name: string;
  functional_currency: string;
}

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  class: LedgerClass;
  parent_id: number | null;
  currency: string | null;
  cash_flow_class: 'operating' | 'investing' | 'financing' | null;
  system_key: string | null;
  archived: boolean;
  position: number;
}

export interface FinAccount {
  id: number;
  ledger_account_id: number;
  kind: AccountKind;
  name: string;
  institution: string | null;
  currency: string;
  iban_mask: string | null;
  profile_key: string | null;
  archived: boolean;
  created_at: string;
  /** Posted balance in the account's currency. */
  balance_minor: number;
  /** What the drafts in the inbox would add. */
  draft_balance_minor: number;
  balance_functional_minor: number;
  draft_balance_functional_minor: number;
}

export interface Line {
  id: number;
  ledger_account_id: number;
  amount_minor: number;
  currency: string;
  functional_minor: number;
  rate: number;
  memo: string | null;
}

export interface PairRef {
  id: number;
  kind: 'transfer' | 'fx';
  status: PairStatus;
  other_entry_id: number;
}

export interface Entry {
  id: number;
  date: string;
  description: string;
  payee: string | null;
  status: EntryStatus;
  source_line_id: number | null;
  reverses_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  lines: Line[];
  pair: PairRef | null;
  /** Tied to a recognition schedule: its lines and date are fixed and it can't be deleted. */
  scheduled: boolean;
}

export interface EntryFilter {
  from?: string;
  to?: string;
  accountId?: number;
  ledgerAccountId?: number;
  status?: EntryStatus;
  uncategorised?: boolean;
  search?: string;
  /** One payee group of the inbox (`InboxGroup.key`). */
  groupKey?: string;
}

export interface TrialRow {
  ledger_account_id: number;
  code: string;
  name: string;
  class: LedgerClass;
  debit_minor: number;
  credit_minor: number;
}

export interface Profile {
  key: string;
  name: string;
  built_in: boolean;
  mapping: ProfileMapping;
}

/** A column: its header name, or its 0-based index. */
export type Col = string | number;

/** The mapping wizard's output (camelCase, as the host stores it): where each field sits in the file. */
export interface ProfileMapping {
  headerRow?: number;
  bookedDate: Col;
  valueDate?: Col;
  description: Col[];
  payee?: Col;
  amount?: Col;
  debit?: Col;
  credit?: Col;
  fee?: Col;
  currency?: Col;
  balance?: Col;
  bankCategory?: Col;
  dateFormat?: string;
  decimal: 'auto' | 'dot' | 'comma';
  invertSign: boolean;
  currencyDefault?: string;
  accountName?: string;
  accountKind?: AccountKind;
  institution?: string;
}

export type KindHint = 'card' | 'transfer' | 'exchange' | 'interest' | 'fee' | 'refund' | 'topup' | 'atm' | 'other';

export interface ParsedRow {
  line: number;
  booked_date: string;
  booked_at?: string | null;
  value_date?: string | null;
  description: string;
  payee?: string | null;
  /** Signed, without the fee. */
  amount_minor: number;
  fee_minor: number;
  currency: string;
  balance_minor?: number | null;
  bank_category?: string | null;
  kind_hint?: KindHint | null;
  account_guess: string;
  counterpart_guess?: string | null;
  fx_currency?: string | null;
  raw: unknown;
}

export interface GuessedAccount {
  guess_key: string;
  name: string;
  institution?: string | null;
  currency: string;
  kind: AccountKind;
  iban_mask?: string | null;
  matched_account_id?: number | null;
}

export interface ImportPreview {
  format: 'csv' | 'xlsx';
  profile_key: string | null;
  confidence: number;
  header: string[];
  rows: ParsedRow[];
  accounts: GuessedAccount[];
  warnings: string[];
  /** The first 30 raw rows, for the mapping wizard. */
  sample: string[][];
}

export type AccountMapTarget = number | { create: { kind: AccountKind; name: string; institution?: string; currency: string } };

/** An import running on the host (`fin_import`, `fin_import_status`). */
export interface ImportJob {
  job_id: number;
  state: 'running' | 'done' | 'failed';
  stage: ImportStage;
  /** Rows done of the total, in the current stage. */
  done: number;
  total: number;
  file_name: string;
  started_at: string;
  finished_at: string | null;
  result: ImportResult | null;
  error: string | null;
}

export interface ImportResult {
  batch_id: number;
  created: number;
  duplicates: number;
  paired: number;
  review: number;
  categorised_by_rules: number;
  /** Refunds given the category of the expense they return. */
  refunds: number;
  /** Lines older than the chosen cut-off, posted straight away. */
  posted?: number;
  /** Rows skipped while parsing, and lines of accounts left out of the map. */
  warnings: string[];
}

export interface Pair {
  id: number;
  kind: 'transfer' | 'fx';
  status: PairStatus;
  score: number;
  entry_a: Entry;
  entry_b: Entry;
  adjust_entry_id: number | null;
  created_at: string;
  /** What "all like this" groups by: the kind, both accounts and the description patterns. */
  like_key: string;
}

export interface Rule {
  id: number;
  position: number;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
  learned: boolean;
  hits: number;
  created_at: string;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export const getEntity = () => call<Entity>('fin_get_entity');
export const updateEntity = (input: { name?: string; functionalCurrency?: string }) => call<Entity>('fin_update_entity', { input });

export const listLedgerAccounts = (includeArchived = false) => call<LedgerAccount[]>('fin_list_ledger_accounts', { includeArchived });
export interface LedgerAccountInput {
  code?: string;
  name?: string;
  class?: LedgerClass;
  parentId?: number | null;
  currency?: string | null;
  cashFlowClass?: string | null;
}
export const createLedgerAccount = (input: LedgerAccountInput) => call<LedgerAccount>('fin_create_ledger_account', { input });
export const updateLedgerAccount = (ledgerAccountId: number, input: LedgerAccountInput) =>
  call<LedgerAccount>('fin_update_ledger_account', { ledgerAccountId, input });
export const archiveLedgerAccount = (ledgerAccountId: number) => call<LedgerAccount>('fin_archive_ledger_account', { ledgerAccountId });

export const listAccounts = (includeArchived = false) => call<FinAccount[]>('fin_list_accounts', { includeArchived });
export interface AccountInput {
  kind: AccountKind;
  name: string;
  institution?: string;
  currency: string;
  ibanMask?: string;
  openingBalanceMinor?: number;
  openingDate?: string;
}
export const createAccount = (input: AccountInput) => call<FinAccount>('fin_create_account', { input });
export const updateAccount = (accountId: number, input: Partial<AccountInput>) => call<FinAccount>('fin_update_account', { accountId, input });
export const archiveAccount = (accountId: number) => call<FinAccount>('fin_archive_account', { accountId });

export const listEntries = (filter: EntryFilter, limit = 200, offset = 0) =>
  call<{ entries: Entry[]; total: number }>('fin_list_entries', { filter, limit, offset });

export interface JournalLineInput {
  ledgerAccountId: number;
  amountMinor: number;
  currency: string;
  functionalMinor?: number;
}
export const createEntry = (input: { date: string; description: string; payee?: string; lines: JournalLineInput[] }) =>
  call<Entry>('fin_create_entry', { input });
export const updateEntry = (entryId: number, input: { date?: string; description?: string; payee?: string | null; notes?: string | null }) =>
  call<Entry>('fin_update_entry', { entryId, input });

/**
 * Categorise a bank entry. `parts` are plain (positive) amounts per category; the journal sign is
 * worked out here, against the bank line, so the screens never deal in debits and credits.
 */
export const categorise = (entryId: number, bankMinor: number, parts: { ledgerAccountId: number; amountMinor: number }[]) => {
  const signed = splitsToJournal(bankMinor, parts.map((p) => p.amountMinor));
  return call<Entry>('fin_categorise', { entryId, splits: parts.map((p, i) => ({ ledgerAccountId: p.ledgerAccountId, amountMinor: signed[i] })) });
};
export const postEntries = (entryIds: number[]) => call<{ posted: number }>('fin_post_entries', { entryIds });
export const deleteEntry = (entryId: number) => call<Record<string, never>>('fin_delete_entry', { entryId });
export const reverseEntry = (entryId: number, date: string) => call<Entry>('fin_reverse_entry', { entryId, date });
export const trialBalance = (asOf: string) => call<TrialRow[]>('fin_trial_balance', { asOf });
export const rate = (currency: string, date: string) => call<{ rate: number; date: string; source: string }>('fin_rate', { currency, date });

// ── Import, pairing and rules ────────────────────────────────────────────────

export const listProfiles = () => call<Profile[]>('fin_list_profiles');
export const previewImport = (fileName: string, contentBase64: string, profileKey?: string) =>
  call<ImportPreview>('fin_preview_import', { fileName, contentBase64, profileKey });
/** Starts the import as a background job on the host; follow it with `importStatus`. */
export const runImport = (fileName: string, contentBase64: string, profileKey: string, accountMap: Record<string, AccountMapTarget>, postOlderThanDays?: number) =>
  call<ImportJob>('fin_import', { fileName, contentBase64, profileKey, accountMap, postOlderThanDays });
/** The job with this id, else the user's latest (null when there's none). */
export const importStatus = (jobId?: number) => call<ImportJob | null>('fin_import_status', jobId == null ? {} : { jobId });
export const saveProfile = (input: { key: string; name: string; mapping: ProfileMapping }) => call<Profile>('fin_save_profile', { input });
export const deleteProfile = (key: string) => call<Profile>('fin_delete_profile', { key });

export const listPairs = (status?: PairStatus) => call<Pair[]>('fin_list_pairs', { status });
export const resolvePair = (pairId: number, accept: boolean) => call<Pair>('fin_resolve_pair', { pairId, accept });
export const resolvePairs = (pairIds: number[], accept: boolean) =>
  call<{ resolved: number; skipped: number }>('fin_resolve_pairs', { pairIds, accept });
export const rescorePairs = () => call<{ confirmed: number; review: number }>('fin_rescore_pairs');
export const pairEntries = (entryA: number, entryB: number) => call<Pair>('fin_pair_entries', { entryA, entryB });

export const listRules = () => call<Rule[]>('fin_list_rules');
/** A rule as it's written (and as `fin_suggest_rule` drafts it), camelCase. */
export interface RuleInput {
  position?: number;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
  learned?: boolean;
}
export const createRule = (input: RuleInput) => call<Rule>('fin_create_rule', { input });
export const deleteRule = (ruleId: number) => call<Record<string, never>>('fin_delete_rule', { ruleId });
export const suggestRule = (entryId: number) => call<RuleInput | null>('fin_suggest_rule', { entryId });
export const applyRules = (entryIds?: number[]) => call<{ categorised: number }>('fin_apply_rules', { entryIds });

// ── Category suggestions from the host's local model ─────────────────────────

/** Whether the host has a local model for suggestions; "Suggest" is hidden when not. */
export const suggestAvailable = () => call<{ available: boolean; model: string | null }>('fin_suggest_available');
/** A category per line from the local model (null: nothing fits). It sends each line's description,
 * payee and amount and the chart's names; a suggestion is shown, never applied by the host. */
export const suggestCategories = (entryIds: number[]) =>
  call<{ entry_id: number; ledger_account_id: number | null }[]>('fin_suggest_categories', { entryIds });
/** The most lines one suggestion request takes (the host's cap). */
export const MAX_SUGGEST = 60;

// ── The inbox at scale: everything a filter matches, and payee groups ────────

/** Posts every draft the filter matches, on the host. Left: `closed` (their month is closed) and `review` (a transfer to confirm). */
export const postMatching = (filter: EntryFilter) => call<{ posted: number; closed: number; review: number }>('fin_post_matching', { filter });
export interface CategoriseMatching {
  categorised: number;
  skipped: number;
  /** The rule created with it, when asked. */
  rule: Rule | null;
  /** The rule for the same lines, offered as "remember as a rule" when not created. */
  rule_input: RuleInput | null;
}
/** Gives every matching draft that's still uncategorised (not a transfer leg) this category. */
export const categoriseMatching = (filter: EntryFilter, ledgerAccountId: number, createRule = false) =>
  call<CategoriseMatching>('fin_categorise_matching', { filter, ledgerAccountId, createRule });
export interface InboxGroup {
  key: string;
  label: string;
  direction: 'out' | 'in';
  count: number;
  /** In the functional currency. */
  total_minor: number;
  first_date: string;
  last_date: string;
  category_id: number | null;
  uncategorised: number;
  /** Transfer or exchange legs. */
  paired: number;
  suggested_ledger_account_id: number | null;
}
export const inboxGroups = (filter: EntryFilter, limit = 50, offset = 0) =>
  call<{ groups: InboxGroup[]; total_groups: number; total_lines: number }>('fin_inbox_groups', { filter, limit, offset });
export const dismissGroupSuggestion = (groupKey: string) => call<Record<string, never>>('fin_dismiss_group_suggestion', { groupKey });
export interface SuggestJob {
  job_id: number;
  state: 'running' | 'done' | 'failed';
  done: number;
  total: number;
  suggested: number;
  error: string | null;
}
/** Asks the local model about every uncategorised payee group, in the background. */
export const suggestGroups = () => call<SuggestJob>('fin_suggest_groups');
export const suggestGroupsStatus = () => call<SuggestJob | null>('fin_suggest_groups_status');

/** Uploads ride the command table as base64, capped at 1.5 MB by the host. */
export const MAX_IMPORT_BYTES = 1.5 * 1024 * 1024;

/** A file's bytes as base64, in chunks (a spread of a large array overflows the stack). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ── Wave 2: close, schedules, budgets, forecast, statements, settings ──────

export interface Period {
  month: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  entries: number;
  drafts: number;
}
export interface CloseResult {
  closed: boolean;
  month: string;
  blockers: { review_pairs: number[]; uncategorised: number[]; drafts: number[] };
  retranslation_entry_id: number | null;
  release_entry_ids: number[];
}
export const listPeriods = () => call<Period[]>('fin_list_periods');
export const closePeriod = (month: string, force = false) => call<CloseResult>('fin_close_period', { month, force });

export interface Schedule {
  id: number;
  entry_id: number;
  ledger_account_id: number;
  balance_account_id: number;
  kind: 'prepaid' | 'accrued';
  start_month: string;
  months: number;
  amount_minor: number;
  deferral_entry_id: number | null;
  created_at: string;
  rows: { month: string; amount_minor: number; released: boolean }[];
}
export const listSchedules = (entryId?: number) => call<Schedule[]>('fin_list_schedules', { entryId });
export const createSchedule = (input: { entryId: number; ledgerAccountId?: number; startMonth: string; months: number }) => call<Schedule>('fin_create_schedule', { input });
export const deleteSchedule = (scheduleId: number) => call<Record<string, never>>('fin_delete_schedule', { scheduleId });

export interface Budget {
  id: number;
  ledger_account_id: number;
  /** null: the standing target for every month. */
  month: string | null;
  amount_minor: number;
}
export interface BudgetProgressRow {
  ledger_account_id: number;
  name: string;
  budget_id: number;
  target_minor: number;
  actual_minor: number;
  remaining_minor: number;
}
export const listBudgets = () => call<Budget[]>('fin_list_budgets');
export const createBudget = (input: { ledgerAccountId: number; month?: string | null; amountMinor: number }) => call<Budget>('fin_create_budget', { input });
export const updateBudget = (budgetId: number, amountMinor: number) => call<Budget>('fin_update_budget', { budgetId, input: { amountMinor } });
export const deleteBudget = (budgetId: number) => call<Record<string, never>>('fin_delete_budget', { budgetId });
export const budgetProgress = (month: string) => call<BudgetProgressRow[]>('fin_budget_progress', { month });

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export interface Recurring {
  id: number;
  key: string;
  label: string;
  cadence: Cadence;
  /** Cash effect: positive in, negative out. */
  amount_minor: number;
  amount_low_minor: number;
  amount_high_minor: number;
  ledger_account_id: number | null;
  account_id: number | null;
  occurrences: number;
  first_date: string;
  last_date: string;
  next_date: string;
  status: 'suggested' | 'confirmed' | 'dismissed';
  created_at: string;
  updated_at: string;
}
export interface Planned {
  id: number;
  date: string;
  description: string;
  /** Cash effect: positive in, negative out. */
  amount_minor: number;
  ledger_account_id: number | null;
  account_id: number | null;
  created_at: string;
  updated_at: string;
}
export interface PlannedInput {
  date: string;
  description: string;
  amountMinor: number;
  ledgerAccountId?: number | null;
  accountId?: number | null;
}
export const detectRecurring = () => call<Recurring[]>('fin_detect_recurring');
export const listRecurring = (status?: Recurring['status']) => call<Recurring[]>('fin_list_recurring', { status });
export const resolveRecurring = (recurringId: number, confirm: boolean) => call<Recurring>('fin_resolve_recurring', { recurringId, confirm });
export const listPlanned = (from?: string, to?: string) => call<Planned[]>('fin_list_planned', { from, to });
export const createPlanned = (input: PlannedInput) => call<Planned>('fin_create_planned', { input });
export const updatePlanned = (plannedId: number, input: PlannedInput) => call<Planned>('fin_update_planned', { plannedId, input });
export const deletePlanned = (plannedId: number) => call<Record<string, never>>('fin_delete_planned', { plannedId });

export interface ForecastLine {
  kind: 'opening' | 'actual' | 'recurring' | 'planned' | 'category';
  label: string;
  date: string | null;
  amount_minor: number;
  low_minor: number;
  high_minor: number;
  ledger_account_id: number | null;
  ref_id: number | null;
}
export interface CategoryProjection {
  ledger_account_id: number;
  name: string;
  class: 'income' | 'expense';
  actual_minor: number;
  projected_minor: number;
  median_minor: number;
  history_months: number;
  budget_minor: number | null;
}
export interface Overshoot {
  ledger_account_id: number;
  name: string;
  budget_minor: number;
  projected_minor: number;
  over_minor: number;
}
export interface Forecast {
  month: string;
  as_of: string;
  opening_minor: number;
  end_minor: number;
  low_minor: number;
  high_minor: number;
  lines: ForecastLine[];
  categories: CategoryProjection[];
  warnings: Overshoot[];
}
export const forecast = (month: string) => call<Forecast>('fin_forecast', { month });

export type StatementKind = 'position' | 'profit_loss' | 'cash_flow' | 'equity';
export interface StatementRowData {
  key: string;
  label: string;
  level: number;
  style: 'header' | 'line' | 'subtotal' | 'total';
  ledger_account_id: number | null;
  amount_minor: number;
  comparative_minor: number | null;
}
export interface Statement {
  kind: StatementKind;
  period: string;
  from: string;
  to: string;
  currency: string;
  comparative: { period: string; from: string; to: string } | null;
  rows: StatementRowData[];
  checks: Record<string, unknown>;
}
export const statement = (kind: StatementKind, period: string, comparatives = true) => call<Statement>('fin_statement', { kind, period, comparatives });
export const statementCsv = (kind: StatementKind, period: string, comparatives = true) =>
  call<{ file_name: string; content: string }>('fin_statement_csv', { kind, period, comparatives });

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export interface FinSettings {
  reminder: { enabled: boolean; weekday: Weekday; time: string };
  /** Import option: post lines older than `post_older_days` days straight away. */
  import: { post_older: boolean; post_older_days: number };
}
export const getSettings = () => call<FinSettings>('fin_get_settings');
export const updateSettings = (reminder: Partial<FinSettings['reminder']>) => call<FinSettings>('fin_update_settings', { input: { reminder } });
export const updateImportSettings = (input: { postOlder?: boolean; postOlderDays?: number }) =>
  call<FinSettings>('fin_update_settings', { input: { import: input } });
