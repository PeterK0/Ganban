# Finance: design and interfaces

Finance is a personal ledger for a user's money: accounts at several banks, imported statements, categories,
budgets and a forecast, kept as **double-entry accounting on IFRS principles**. The user is a personal reporting
entity, and the statements follow IAS 1 and IAS 7, and foreign currency IAS 21. It's an optional, top-level part of
Ganban (a tab module with a rail view). Its data never leaves the host, and only its own user sees it, the host owner
included.

This document is the contract the implementation follows. It covers the first wave (the ledger) in full and names
what later waves add.

## Principles

- **Private to its user.** Every finance command acts on the caller's own entity (the authorship field). No
  command takes an entity id, and every referenced row (account, entry, rule…) must belong to the caller's entity,
  else it's absent (`NotFound`). The host owner gets no bypass here. This is the one exception to ADR 0002's "the
  owner sees everything".
- **Double entry.** Every journal entry balances in the functional currency. Everyday screens hide debits and
  credits: a *category* is an income or expense ledger account, and the app writes the journal underneath.
- **Source lines are kept verbatim.** An imported row is stored as it came (with a hash for dedupe). The journal
  entry built from it can be re-categorised freely while its period is open.
- **Edit until close, then reverse.** Entries in an open period can be edited or deleted. A closed period (wave 2)
  is locked, and corrections post as dated reversal entries. Every change is written to the audit log.
- **Cash date for bank lines, accruals when asked.** A bank line posts on its booking (completed) date. A
  recognition schedule (wave 2) spreads an expense or income over months.
- **IAS 21.** The functional currency is the entity's (EUR by default). An entry in another currency is
  translated at the ECB spot rate of its date. A bank's own converted amount wins when the data has one.
  Month-end close (wave 2) retranslates foreign monetary balances at the closing rate and posts unrealised FX
  differences to profit or loss.
- **Money is integer minor units** (`i64`, cents for EUR) with an ISO 4217 currency code. Exponents come from a
  small table (most currencies 2, JPY 0, and so on). Rates are `f64`, stored as REAL.
- **Sign:** a journal line's `amount_minor` is positive for a debit and negative for a credit. An entry balances
  when its lines' `functional_minor` sum to 0.

## Data (SQLite, created in `crates/core/src/db.rs` → `finance` migrations)

All tables are prefixed `fin_`. They're host-only and never synced to offline replicas. Every per-user row carries
`entity_id`.

| Table | Columns (main) | Notes |
|---|---|---|
| `fin_entities` | id, user_id UNIQUE, project_id (the user's personal container), name, functional_currency, created_at | Created on first use, with the default chart. v1 has one per user; the model allows more. |
| `fin_ledger_accounts` | id, entity_id, code, name, class (`asset` `liability` `equity` `income` `expense`), parent_id, currency NULL (monetary accounts), cash_flow_class NULL (`operating` `investing` `financing`), system_key NULL, archived, position | `system_key` marks the accounts the app posts to: `opening_equity`, `transfers_clearing`, `fx_realised_gain`, `fx_realised_loss`, `fx_unrealised_gain`, `fx_unrealised_loss`, `bank_fees`, `uncategorised_expense`, `uncategorised_income`. |
| `fin_accounts` | id, entity_id, ledger_account_id UNIQUE, kind (`current` `savings` `card` `cash` `loan`), name, institution, currency, iban_mask NULL, profile_key NULL, archived, unconfirmed, created_at | A bank, vault, card, cash or loan account the user holds. Its ledger account is an asset (current, savings, cash) or a liability (card, loan) in its currency. `institution` is the bank, so a pocket groups under it. `unconfirmed`: made by an import for the other side of a move, with no statement of its own imported yet (§ Payees, Savings moves). |
| `fin_import_batches` | id, entity_id, file_name, profile_key, imported_at, rows_total, rows_new, rows_duplicate, status (`running` `done`) | One per import. `running` until its import finishes, so a rerun finishes an interrupted one. |
| `fin_source_lines` | id, entity_id, account_id, batch_id, hash, dedupe_key, occurred_at NULL, booked_date, value_date NULL, description, payee NULL, amount_minor, currency, fee_minor, balance_minor NULL, bank_category NULL, kind_hint NULL (`card` `transfer` `exchange` `interest` `fee` `refund` `topup` `atm` `other`), raw_json, dismissed_at NULL, created_at; UNIQUE(entity_id, account_id, hash) | Verbatim imported rows. Manual entries have none. Deleting an entry marks its source line dismissed, so a re-import doesn't bring it back. |
| `fin_entries` | id, entity_id, date, description, payee NULL, status (`draft` `posted` `reversed`), source_line_id NULL, reverses_id NULL, notes NULL, group_key NULL, payee_id NULL, payee_key NULL, unsorted, created_at, updated_at | One source line makes at most one entry. An import posts what it can file and leaves the rest as `draft`: the inbox, which holds decisions only (§ Payees). `group_key` is a draft's payee group (§ The inbox at scale). `payee_id` and `payee_key` are its payee and the alias it came by (`''` once looked at without one). `unsorted`: posted as unsorted history. |
| `fin_lines` | id, entry_id, ledger_account_id, amount_minor, currency, functional_minor, rate, memo NULL | At least two lines per entry, balanced on `functional_minor`. |
| `fin_pairs` | id, entity_id, kind (`transfer` `fx`), entry_a, entry_b, adjust_entry_id NULL, status (`auto` `review` `confirmed` `rejected`), score, created_at | A transfer between own accounts. Both bank entries post their counter line to `transfers_clearing`, so a matched pair nets to 0. An FX pair adds an adjusting entry for the realised difference. |
| `fin_rules` | id, entity_id, position, conditions_json, action_json, learned, hits, created_at | Conditions: description or payee pattern, amount range, account, bank category, kind hint. Action: one category, or splits by fixed amount or percentage. |
| `fin_payees` | id, entity_id, name, default_ledger_account_id NULL, ask_every_time, merged_into NULL, renamed, created_at | A payee (§ Payees). One merged into another keeps its row, so a split can bring it back. |
| `fin_payee_aliases` | entity_id, key, payee_id, origin_payee_id NULL, sample, loose_key; PK(entity_id, key) | A payee's spellings by certain key. `origin_payee_id`: the payee it belonged to before a merge. `sample`: the first raw text seen. |
| `fin_payee_dismissed` | entity_id, payee_a, payee_b, created_at; PK(entity_id, payee_a, payee_b) | Merge suggestions the user dismissed. |
| `fin_profiles` | id, entity_id NULL (NULL = built in), key, name, mapping_json | The wizard saves user profiles. Built-in formats ship in code (a registry, empty in the public tree) and are listed with them. |
| `fin_rates` | currency, date, rate (units of currency per 1 EUR, as ECB), source; PK(currency, date) | Global (not per user): ECB reference rates, fetched daily by the host and cached. |
| `fin_periods` | entity_id, month (`YYYY-MM`), status (`open` `closed`), closed_at NULL; PK(entity_id, month) | A month closes in order; a date in or before the latest closed month is locked (§ Wave 2, Period close). |
| `fin_audit` | id, entity_id, at, user_id, action, kind, row_id, before_json NULL, after_json NULL | Every mutation. |

Wave 2 adds `fin_budgets`, `fin_planned`, `fin_recurring`, `fin_schedules` (recognition) and `fin_settings`
(§ Wave 2).

## Default chart (by nature; every entry is editable)

- **Assets:** one per financial account (under *Cash and cash equivalents*, or *Savings*), *Prepayments*,
  *Receivables*.
- **Liabilities:** one per card or loan, and *Accrued expenses*.
- **Equity:** *Opening balance equity*, *Accumulated surplus*, *OCI reserve*.
- **Income:** Salary, Interest, Other income, Realised FX gains, Unrealised FX gains.
- **Expenses:** Housing, Utilities, Groceries, Eating out, Transport, Health, Shopping, Entertainment,
  Subscriptions, Travel, Education, Gifts, Bank fees, Taxes, Realised FX losses, Unrealised FX losses,
  Uncategorised.

Cash-flow classes: savings and vault moves, and investments later, are *investing*; loans are *financing*;
everything else is *operating*.

## Commands (`crates/server/src/commands/finance.rs`, `finance_import.rs`)

Every finance command is declared with `.access(Access::OwnFinance)` and `.author(Author::Arg("userId"))`.
`OwnFinance` admits any signed-in member, and the core functions take the author's entity, so a caller only ever
reaches their own rows. Arguments and inputs are camelCase, with inputs under `input` (a saved profile's mapping
too). Returned rows are snake_case, as Ganban's models are. Amounts in JSON are integers in minor units, and dates
are `YYYY-MM-DD`.

**Ledger (lane A):**

| Command | Args | Returns |
|---|---|---|
| `fin_get_entity` | — | `Entity {id, name, functional_currency}`. Creates the entity and its default chart on first call. |
| `fin_update_entity` | `input {name?, functionalCurrency?}` | `Entity`. The currency can change only while nothing is posted. |
| `fin_list_ledger_accounts` | `includeArchived?` | `LedgerAccount[]` |
| `fin_create_ledger_account` / `fin_update_ledger_account` / `fin_archive_ledger_account` | `input` / `ledgerAccountId, input` / `ledgerAccountId` | `LedgerAccount` |
| `fin_list_accounts` | `includeArchived?` | `FinAccount[]` with `balance_minor` (account currency, posted and draft separately) and `balance_functional_minor` |
| `fin_create_account` | `input {kind, name, institution?, currency, ibanMask?, openingBalanceMinor?, openingDate?}` | `FinAccount`. Creates its ledger account and posts the opening balance against `opening_equity`. |
| `fin_update_account` / `fin_archive_account` | `accountId, input` / `accountId` | `FinAccount` |
| `fin_list_entries` | `filter {from?, to?, accountId?, ledgerAccountId?, status?, uncategorised?, search?, groupKey?, payeeId?, unsorted?, transfers?, importBatchId?, ids?}, limit?, offset?` | `{entries: Entry[], total}`; `Entry` includes its `lines`, `pair`, `scheduled` (tied to a recognition schedule, so its lines, date and deletion are refused), `payee_id`, `payee_name` (the payee's own name; `payee` is the bank's text), `unsorted` and, on a draft, `suggested_ledger_account_id` (its payee group's waiting suggestion). `transfers: true` lists the legs of booked pairs (the Transfers filter) and `false` everything else; `importBatchId` narrows to one import's lines; `ids` (≤ 5000) is a selection. |
| `fin_create_entry` | `input {date, description, payee?, lines: [{ledgerAccountId, amountMinor, currency, functionalMinor?}]}` | `Entry` (a manual journal, posted, which must balance) |
| `fin_update_entry` | `entryId, input` | `Entry`. Open periods only; a closed period answers `InvalidInput("closed period: reverse it instead")`. |
| `fin_categorise` | `entryId, splits: [{ledgerAccountId, amountMinor}], payeeDefault?: once\|change` | `Entry` with `payee_default: DefaultChange \| null`. Replaces the non-bank side of a bank entry, and a draft posts (categorised means done). Splits carry the debit sign, the opposite of the bank line, so a −4200 card payment takes splits summing to +4200; the bank line's sign is accepted too. A single category teaches the payee (§ Payees, Default categories). |
| `fin_post_entries` | `entryIds` | `{posted}` (draft → posted). Kept for the screens of before § Payees; nothing needs it now. |
| `fin_delete_entry` | `entryId` | `{}`. Drafts or open-period entries only; its source line stays and is marked dismissed. |
| `fin_reverse_entry` | `entryId, date` | `Entry` (the reversal) |
| `fin_trial_balance` | `asOf` | `[{ledgerAccountId, debitMinor, creditMinor}]` in the functional currency, with the totals equal |
| `fin_rate` | `currency, date` | `{rate, date, source}` (the latest ECB rate on or before `date`) |

**Import, pairing and rules (lane B):**

| Command | Args | Returns |
|---|---|---|
| `fin_list_profiles` | — | `Profile[] {key, name, builtIn, mapping}` |
| `fin_preview_import` | `fileName, contentBase64, profileKey?` | `{format: "csv"\|"xlsx", profileKey?, confidence, header: string[], rows: ParsedRow[] (first 50), accounts: [{guess_key, name, institution?, currency, kind, iban_mask?, matched_account_id?}], sample: string[][] (the first 30 raw rows, for the wizard), warnings: string[], suggested_mapping: Mapping \| null}`. Without `profileKey`, a built-in format is detected, else a saved layout whose named columns are all in the file's header row (the one naming the most columns when several fit). When neither fits, `suggested_mapping` is the wizard's guess from the header names (date, description, amount or debit and credit, currency, balance, payee, fee). |
| `fin_import` | `fileName, contentBase64, profileKey, accountMap: {[guessKey]: accountId \| {create: {kind, name, institution, currency}}}, postOlderThanDays?` (the history cut-off, § Payees, Filing: 1–3650 days, 0 for none; without it, the user's setting, on at 90 days by default) | `ImportJob`, running: the import goes on in the background (§ Import pipeline, Large imports). Refused while the user has one running. A wrong profile or another user's account is refused here; anything else ends the job `failed`. Lines of accounts left out of `accountMap` are skipped with a warning |
| `fin_interrupted_imports` | | `[{batch_id, file_name, imported_at, lines}]`: the user's batches cut short (`running` or `failed`) with lines in, none while an import of theirs runs. |
| `fin_import_status` | `jobId?` | `ImportJob \| null`: that job (another user's is not found), else the user's latest. `ImportJob {job_id, state: running\|done\|failed, stage: reading\|rates\|accounts\|rows\|pairing\|rules\|done, done, total (rows, in the stage), file_name, started_at, finished_at?, result?: {batch_id, created, duplicates, paired, review, categorised_by_rules, refunds, posted, filed_by_payee, history_unsorted, history_suggested, decisions, transfer_pair_ids, warnings}, error?}` |
| `fin_save_profile` / `fin_delete_profile` | `input {key, name, mapping}` / `key` | `Profile` |
| `fin_list_pairs` | `status?` | `Pair[]` with both entries and `like_key` (the kind, both bank accounts and each side's description pattern: what "all like this" groups by) |
| `fin_resolve_pair` | `pairId, accept` | `Pair`. Accepting posts both legs. Rejecting a booked pair is "Not a transfer": both legs go back to uncategorised drafts, in the inbox, with their payees. |
| `fin_resolve_pairs` | `pairIds (at most 1000), accept` | `{resolved, skipped}`: each pair as `fin_resolve_pair`, in its own transaction; one that's gone, another user's or has an entry categorised since is skipped. The review list's "Same money for all like this" and "Accept all at ≥ N%" (N defaults to the auto bar, 75) call it after confirming the count |
| `fin_rescore_pairs` | — | `{confirmed, review}`: the pairs waiting for review, scored again with the current rules (§ Import pipeline, Pairing rules); the ones that now qualify are booked. The review list calls it when it opens, and the host runs it once at startup after the rules change. Running it again changes nothing |
| `fin_pair_entries` | `entryA, entryB` | `Pair` (a manual match) |
| `fin_list_rules` / `fin_create_rule` / `fin_update_rule` / `fin_delete_rule` | — / `input` / `ruleId, input` / `ruleId` | `Rule[]` / `Rule` / `Rule` / `{}`. The rules screen lists, edits and deletes with these. |
| `fin_suggest_rule` | `entryId` | `Rule \| null`: a rule drafted from this entry's correction, offered after the second identical fix; its `conditions` and `action` come back in `fin_create_rule`'s input shape |
| `fin_apply_rules` | `entryIds?` (all drafts by default) | `{categorised}` |

Uploads go through the command table as base64. A file is capped at 1.5 MB, which fits `/invoke`'s body limit; a year of bank lines is a few hundred KB, and six years of a busy current account about 500 KB.

## Import pipeline

1. **Sniff the content, not the extension.** The zip magic means XLSX (a bank's export may be XLSX named
   `.csv`); otherwise CSV, with the delimiter and encoding detected (UTF-8 or UTF-16, else a legacy code page:
   Western, Central European, Cyrillic or Greek).
2. **Decode:** Excel serial dates become dates. Repair mojibake: text that is UTF-8 read as cp1252 (a bank's
   "Î¦Î‘Î¡ÎŸÎ£" for "ΦΑΡΟΣ") is re-decoded when that yields valid UTF-8. Decimal commas and thousands separators follow
   the profile.
3. **Profile:** each profile finds its header row (an export may start with preamble rows: the bank, the title,
   the account with its IBAN, the period) and maps the columns to a `ParsedRow`.
   A `ParsedRow` carries `line, booked_date, booked_at?, value_date?, description, payee?, amount_minor` (signed,
   excluding the fee), `fee_minor` (≥ 0), `currency, balance_minor?, bank_category?, kind_hint?, account_guess,
   counterpart_guess?` (a pocket), `fx_currency?` and `raw`. A wizard mapping is
   `{headerRow?, bookedDate, valueDate?, description: [col], payee?, amount? | debit? + credit?, fee?, currency?,
   balance?, bankCategory?, dateFormat?, decimal: auto|dot|comma, invertSign, currencyDefault?, accountName?,
   accountKind?, institution?}`, where a `col` is a header name or a 0-based index.
   - **Built-in formats** (`import/profiles`): a registry of formats, each a key, a name, a detect and a parse
     function, and the raw columns that keep the bank's timestamp and booking time (dedupe and FX pairing read
     them on stored lines). The public tree ships none, so any bank goes through the wizard once; a build may add
     formats at compile time. The key a format stores on accounts and batches never changes, and a key the running
     build doesn't know is just not built in: its accounts list as usual and its file goes to the wizard. What a
     built-in format may do beyond a mapping:
     - Skip lines the bank hasn't completed, booking on the completion date with the start as the value date.
     - Pick the account from a product column (current or savings).
     - Read pocket moves ("To/From EUR … <pocket name>") as transfers to or from a savings account of that name,
       created on first sight. When the pocket's own side isn't in the file, the pipeline writes the counterpart
       entry itself.
     - Mark "Exchanged to XXX" rows as FX legs, paired with the other currency account's leg, or, when that leg
       isn't in the file, booked to the user's account in that currency (§ Payees, Savings moves).
     - Split a fee into a `bank_fees` line in the same entry.
     - Take the account and its IBAN from a preamble, and keep the bank's category as a rule hint. Kind hints come
       from keywords (`profiles::kind_from_words`, which the wizard's category column uses too); a build may add
       words in other languages.
4. **Dedupe** (`import/dedupe.rs`): a line's group (`dedupe_key`) is a hash of (account, booked date, amount,
   currency, normalised description); the lines of one group look identical. Within a group, the file's lines
   match the stored ones by the strongest thing both sides have: the bank's timestamp to the second
   (`occurred_at`), else the running balance (a file with dates only), else nothing, when the file adds
   only as many lines as it has beyond those stored. So the same file twice, overlapping exports, the same data as
   CSV and as XLSX, and a file with the balance masked all add nothing twice; two identical coffees on one day stay
   two; and a day two exports cut at different points is told apart by the timestamp or the balance. The `hash`
   (unique per account) only guards against a double insert. Lines stored before groups existed get theirs
   backfilled at startup, so they match the same way.
5. **Draft entries:** each bank line is drafted against `uncategorised_*`. Then, in this order:
   - **Transfer and FX pairing:** the same amount and currency with opposite signs within 3 days across the user's
     accounts. An FX pair matches "Exchanged to" legs by time and the bank's amounts. See Pairing rules below.
   - **Pocket counterparts:** a pocket's side, when the file lacks it, is written in, and taken over by the real
     line in a later import.
   - **Payees:** each unpaired line resolves to its payee (§ Payees).
   - **Rules,** on unpaired entries only, so a rule can't grab a transfer leg.
   - **Payee defaults:** what no rule filed takes its payee's default category.
   - **Refund matching:** a positive line whose payee matches an earlier expense goes to that expense's category.
   - **Filing:** what has a category posts; old uncategorised lines become unsorted history; the rest is the inbox
     (§ Payees, Filing).

   Uncertain matches go to `review`. A foreign-currency line needs an ECB rate for its date: the import works out
   the (currency, date) pairs the file needs and fetches the missing ones before it writes anything.

**Pairing rules** (`finance/pairing.rs`). A transfer match scores 0.5, plus 0.2 for the same day (0.1 a day
apart), plus 0.15 when both legs are transfers, plus 0.3 when the bank names the other account (a pocket), plus 0.05
when both descriptions have the same pattern (lower case, without a leading "to"/"from" or words with digits, so "To
pocket Rent" and "From pocket Rent" agree), capped at 1.0. Two legs the bank stamped within a minute of each other
(`occurred_at`) score 1.0 outright. A match at 0.75 or more is booked without asking unless a
rival (another match for one of its legs) scores within 0.1, with two exceptions: a match stamped at the same moment
isn't held up by rivals without that, and a rival that only swaps a leg for an identical one (the same account,
amount, currency and day) gives the same books, so it doesn't count. Such legs pair in time order, by the bank's
timestamp, else by line order (a leg whose description matches goes first). Rivals that differ (another account, another day) still send the match to review.

**Large imports.** `fin_import` starts a background job and answers at once; `fin_import_status` reports the stage,
rows done of the total, and the result. One import per user at a time, kept in the host's memory. The job writes in
short transactions, so the rest of the host keeps working: the accounts and the batch in one, the new lines in
batches of 250, then the final pass (pairing, pocket counterparts, rules, refunds) in batches of 100, with a short
pause after each so other writers get the lock. An interrupted import is safe to run again: dedupe skips the lines it
stored, and the lines of every batch still `running` or `failed` go through the rerun's final pass (a pocket's side
is written only for the lines the rerun's file holds). A host restart ends the job: at startup every batch still
`running` is marked `failed`, and `fin_interrupted_imports` lists the user's cut-short batches that hold lines, so the
Import screen asks for the file again. The database runs in WAL mode
with a 15 s busy timeout (`crates/core/src/db.rs`), and per-request bookkeeping such as a device's last-seen stamp
waits for the lock in the background rather than holding up or failing the request.

## Payees

Phase F1 ("sort less"): a payee is a row, an import files what it can and posts it, and the inbox holds only the
lines that need the user. Code: `crates/core/src/finance/payees/` (the keys in `keys.rs` are pure functions with
table tests), commands in `crates/server/src/commands/finance_payees.rs`.

### Keys and resolution

- **The certain key** merges spellings without asking: case and Latin accents (and Greek tonos) folded, punctuation
  dropped (an apostrophe joins), a `*` tail holding a digit dropped (`WOLT*ORDER 128`), trailing words holding a
  digit or starting with `#` dropped (`#4471`, `P1A2B3`), a glued run of three or more digits dropped, and in a word
  that is mostly Latin, Greek or Cyrillic letters read as Latin (look-alikes as their twin, the rest by sound:
  "WOΛT" is `wolt`). A word all in another script stays as it is.
- **The loose key** only suggests: the certain key with every Greek and Cyrillic letter transliterated by sound and
  filler words dropped (`order`, `payment`, `ltd`, `card`, …). Two payees are suggested as one when their loose keys
  are equal, a small edit distance apart (1 from five letters, 2 from nine; never on shorter names), or the same
  name of two words or more with another last word (a branch or a city). The certain key also drops a company's
  legal-form ending when something is left ("Delta Kiosk Ltd" is `delta kiosk`; Ltd, LLC, Inc, PLC, GmbH, AG, SA,
  SRL, BV, AB, Oy, s.r.o., Sp. z o.o., AE, IKE and the like). "Bolt" and "Bolt Food", or "Golden Bakery"
  and "Golden Grill", are not suggested.
- **Resolution.** A line's payee is read from the bank's payee, else its description. Its certain key finds the
  alias, and the alias the payee; an unknown key makes a payee named after the text without its tails, title-cased when the bank wrote it all in
  capitals ("CORNER BAKERY" is "Corner Bakery"; words of three letters or fewer and words with a digit or `&` stay).
  Names from before were retitled once; a payee the user renamed (`renamed`) keeps its name. Exchange legs
  and moves between the user's own accounts (booked pairs) have none. The raw text stays on the source line.

### Default categories

- A payee's **default category** files its lines on import. It is set the first time the user categorises one of
  its lines with a single category (`fin_categorise`), unless the payee **asks every time**; setting it also files
  the payee's other uncategorised drafts and its unsorted history, and the answer (`DefaultChange {payee_id, name,
  ledger_account_id, previous_ledger_account_id, filed_drafts, filed_history}`) is what the Undo toast needs.
- Filing a later line under another category changes nothing unless the call says `payeeDefault: "change"`: the
  client asks "just this one, or change the default?".
- A default is an income or expense category, not a system account (bank fees aside). The category picker leaves
  out what `fin_list_ledger_accounts` marks with a `system_key` (FX gains and losses, Uncategorised, opening balance)
  or a `currency` (monetary accounts), and keeps `bank_fees`.

### Filing (categorised means done)

An import's final pass, per line, after transfer and FX pairing and the pocket and exchange sides: the payee, then
the **rules** (unpaired lines), then the payee's **default**, then refund matching. A line filed by any of them, by
the bank-fee rule or by a confident pair is **posted** at once. Then:

- **History:** a line dated before the cut-off (`postOlderThanDays`, 90 by default) that is still uncategorised
  takes the local model's suggestion for its payee group when there is one, else posts to Uncategorised marked
  `unsorted`: **unsorted history**, out of the inbox, listed by payee (`fin_list_payees` with `unsorted`), the
  largest first.
- **The inbox** is what's left: drafts with no category, and legs of a pair to review. Confident pairs post and are
  listed under the Transfers filter (`transfers: true`); "Not a transfer" (`fin_resolve_pair` with `accept: false`)
  puts both legs back in the inbox. The result's `transfer_pair_ids` back "45 transfers matched".
- Posted entries stay editable until their month is closed. Categorising a draft posts it, so the client never
  needs a Post step.

### Savings moves and exchange legs

- **An exchange leg** whose other side isn't in the file ("Exchanged to GBP" on the euro account) is a move to the
  user's own balance in that currency, never spending and never an inbox line. A built-in format names the account
  (the same product in the other currency, made on first sight like a pocket, kind current), and the import writes
  its side at the ECB rate of the day, noted as an estimate, and books the two as an FX pair. (A row carrying the
  bank's converted amount would win over the rate; the formats seen so far carry none.) When that account's statement comes in, its line (the same day ± 3, the amount
  within 5%) replaces the estimate, and the difference books as realised FX.
- **Unconfirmed accounts.** An account the import made for the other side of a move, with no lines of its own in the
  file, is `unconfirmed`: its balance is only what the other side sent. The first statement imported into it
  confirms it. Screens say "import this account's statement to see where the money went".
- A built-in format may name **savings moves** by wording: money back from (or into) the bank's savings account in
  the row's currency, one per bank and currency, when no pocket is named. The word lists are a line to extend.
- **Folded lists.** `fin_transfer_groups` folds booked moves by account and description pattern: "Exchanged to GBP:
  1,240 moves, €612".

### Moves by the user's say-so

`fin_categorise` takes `transferTo: {accountId} | {create: {name, kind?, institution?}}` instead of `splits`: the line
is a move to one of the user's own accounts. Its other side is written on that account (an FX estimate in another
currency) and the two pair as a booked transfer, posted, listed under Transfers; "Not a transfer" undoes it. A new
account takes the line's currency and is unconfirmed until its own statement comes in, whose line takes over the
written side. A payee's default can be such a move (`default_account_id`; `fin_set_payee_default` with
`accountId`), learned the first time as a category is, and filing next week's lines by it.

### Rename, merge, split, suggestions

A merge moves a payee's aliases and lines to the target and marks the merged payee `merged_into`; each alias keeps
`origin_payee_id`, so a split sends it, with its lines, back to that payee (or to a new one). Future imports follow
the aliases. Suggestions skip pairs the user dismissed. A split keeps the payee's name; an alias that goes back to the
payee it came from names it from its own spelling unless the user had renamed it (`renamed`). In the unsorted
history list a payee's `last_date` is its last unsorted line's (`unsorted_last_date`).

### Commands

| Command | Args | Returns |
|---|---|---|
| `fin_list_payees` | `filter {search?, unsorted?}, limit? (100, ≤ 500), offset?` | `{payees: Payee[], total}`; `Payee {id, name, default_ledger_account_id, ask_every_time, aliases: [{key, sample, origin_payee_id}], lines, total_minor, last_date, unsorted, unsorted_total_minor}`, the most lines first (with `unsorted`, the largest unsorted total first) |
| `fin_get_payee` | `payeeId` | `Payee` |
| `fin_update_payee` | `payeeId, input {name?, askEveryTime?}` | `Payee` (rename) |
| `fin_set_payee_default` | `payeeId, ledgerAccountId \| null, file? (true)` | `DefaultChange` |
| `fin_undo_payee_default` | `payeeId, previousLedgerAccountId?, filedDrafts?, filedHistory?` | `Payee`: the default back, and the filed lines still under it back in the inbox or unsorted history |
| `fin_merge_payees` | `targetId, payeeIds` | `Payee` |
| `fin_split_payee` | `payeeId, aliasKeys` (a payee keeps one) | `Payee[]`: where the aliases went |
| `fin_payee_suggestions` | `limit? (50)` | `[{a: {id, name, lines}, b, reason: same name\|spelled alike\|another branch}]`, the most lines first |
| `fin_dismiss_payee_suggestion` | `payeeA, payeeB` | `{}` |
| `fin_inbox_summary` | — | `{decisions, uncategorised, review, suggested, unsorted_history, transfers}` |
| `fin_transfer_groups` | `filter` | `[{key, label, account_id, count, total_minor, first_date, last_date}]` |
| `fin_tidy_inbox` | `historyDays?, dryRun?` | `{filed, history, left}`: an inbox from before payees filed by the defaults, and with `historyDays` its old uncategorised drafts posted as unsorted history. `dryRun` counts only. |

### From the books of before

The migration only adds the tables, columns and indexes; startup never waits on a book's size. Once the host is up, a
background job (`payees::backfill`, spawned beside the interrupted-import check) works through every entity whose
`payees_learned` is unset: each stored bank line gets its payee, 250 entries a write transaction with a 50 ms pause
after each. Then it learns from the books: a payee without a default whose categorised lines went two in three to
one category takes it; a rule that matches one payee only, by text with one category (a sign bound aside), gives
that payee its category as the default, and the rule stays; drafts already categorised post. `payees_learned` is set
last. Every step is idempotent, so a restart halfway goes on where it stopped and a second run changes nothing.

While it runs, Finance answers as usual, `fin_inbox_summary` carries `preparing: {done, total}` (entries), and
`fin_import` is refused with "still sorting your existing lines into payees (N of M)". An older build run on a
half-done database (a rollback) ignores the new tables and columns; it sees the categorised drafts the job already
posted as posted, and its rules as they were. Back on this build, the job picks up the lines left, including any the
older build imported. It doesn't file uncategorised drafts or post old ones: the Finance screen offers that as
`fin_tidy_inbox`, with the counts first. A reset deletes payees with the lines.

## The inbox at scale

A full bank history puts ten thousand drafts in the inbox. The host does the bulk work, so the screen never loads or
groups them all (`crates/core/src/finance/inbox.rs`).

- **Everything a filter matches.** `fin_post_matching` and `fin_categorise_matching` take the inbox's filter (as
  `fin_list_entries`; drafts only, whatever `status` says) and act on every draft it matches, not just the page
  shown. They write in short `BEGIN IMMEDIATE` transactions of 200 entries with a short pause after each, as the
  import does, and audit each entry. A posted entry stays editable until its month is closed, so a bulk post is
  undone entry by entry. Drafts dated in a closed month, or waiting in a transfer pair to review, are left and
  counted.
- **Categorising** gives the category to every matching draft whose whole counter side is still uncategorised
  (beside the bank's fee) and that isn't a transfer or exchange leg. It returns the rule that would file such lines
  (a payee group's merchant pattern and direction, else the search text, with the account), or creates it with
  `createRule`.
- **Payee groups.** Each draft gets a `group_key`: its direction (`out` for money spent, `in` for money received)
  and its payee, as `out:#12`, so every spelling of a payee is one row; a line without a payee falls back to its
  merchant (`rules::merchant_key`: the description without digits and punctuation), as `out:green market`. A
  payee group's label is the payee's name. Keys are filled when the inbox first groups (and again after an entry's text changes).
  `fin_inbox_groups` returns a page of groups, the most drafts first. A `groupKey` filter narrows any of these
  commands to one group.
- **Suggestions per group.** `fin_suggest_groups` starts a background job (one per user, in the host's memory)
  that asks the local model about every group with uncategorised drafts that it hasn't asked about yet, 15 groups a
  prompt, on the same terms as § Category suggestions (a group's latest description, payee and amount). It stores one
  suggestion per group in `fin_group_suggestions`; the user takes it group by group. Taking or dismissing it ends
  it. Without a local model the job is refused and the button hidden.
- **Import option.** The Import screen offers "Post lines older than [90] days straight away", on by default and
  remembered per user (`fin_settings.import_post_older`, `import_post_older_days`). It is the history cut-off of
  § Payees, Filing.
- **Bulk categorising needs a narrowing filter.** `fin_categorise_matching` refuses a filter without a payee, a
  payee group, a search, an account, dates or `ids`: one category for every unsorted line is how a salary gets
  filed under Shopping. With `unsorted: true` it acts on unsorted history instead of drafts. What it files posts.
- **Indexes:** `fin_entries(entity_id, status, date)` and `(entity_id, status, group_key)`, and `fin_pairs(entry_a)`
  and `(entry_b)` for the transfer-leg checks.

| Command | Args | Returns |
|---|---|---|
| `fin_post_matching` | `filter` | `{posted, closed, review}` (drafts left: their month is closed, or they wait in a pair to review) |
| `fin_categorise_matching` | `filter` (narrowed, see above), `ledgerAccountId, createRule?` | `{categorised, skipped, rule: Rule \| null, rule_input: RuleInput \| null, payee_defaults: DefaultChange[]}`. Sorting by a payee group or a payee teaches each payee without a default this category, as `fin_categorise` does. The category must be an income or expense account (not uncategorised). `createRule` without a group or search to match on is refused. |
| `fin_inbox_groups` | `filter, limit? (50, ≤ 500), offset?` | `{groups: [{key, label, direction: out\|in, count, total_minor (functional), first_date, last_date, category_id, uncategorised, paired, suggested_ledger_account_id}], total_groups, total_lines}` |
| `fin_dismiss_group_suggestion` | `groupKey` | `{}` |
| `fin_suggest_groups` / `fin_suggest_groups_status` | — | `SuggestJob {job_id, state: running\|done\|failed, done, total (groups), suggested, started_at, finished_at?, error?}` / the latest, or `null` |

## The interface (lane C)

- `src/tabs/finance/module.tsx` registers the tab module, with `rail: {label: "Finance", icon, view}`.
  `modules.ts` gains the optional `rail` field, and the shell shows a rail button and a top-level view for each
  module that has one. This happens only when the host reports `finance` in `GET /tabs` and the user has turned
  Finance on (Settings → Plug-ins, a per-user host setting).
- Sub-views:
  - **Overview:** wave 1 shows accounts with balances, the inbox count and the review count. Wave 2 adds budgets,
    the forecast and net worth.
  - **Transactions** (phase F1, `Transactions.tsx`, `sortParts.tsx`, the pure rules in `sorting.pure.ts`): four
    filters, **To sort · N** (the inbox summary's `decisions`), **All**, **Transfers** and **Unsorted history**.
    - *To sort* lists only drafts. A row shows the payee's name, the date and account, the amount and a category
      picker; picking files the line and it leaves the list (no Post step). A waiting suggestion (`Entry.
      suggested_ledger_account_id`, the local model's for the line's payee group) shows greyed in the picker with
      ✓ to accept, and "Accept all N suggestions" takes every one. A transfer to review asks "It's a transfer" or
      "Not a transfer". **By payee** shows the host's groups with the same picker. A payee's first category shows
      the toast "Wolt → Eating out from now on · Undo"; filing a later line elsewhere asks "Just this one" or
      "Change Wolt's default". The picker lists spending and income categories without system or money
      accounts (Bank fees kept), the most used first (by the payees' lines).
    - Bulk filing acts on the ticked lines or on everything a narrowing filter matches, after a confirm.
    - When To sort holds 200 lines or more, `fin_tidy_inbox`'s dry run becomes one banner and "Tidy up" runs it
      after a confirm. While the host builds payees from old books, the banner shows its `preparing` progress
      instead. "N payees look like others" opens the merge suggestions: "Same payee" or "Different".
    - *Transfers* folds the moves by kind (`fin_transfer_groups`) and lists the lines, each with "Not a transfer".
      *Unsorted history* lists payees by their unsorted total, each with a picker that sets the payee's default
      (which files its history).
    - A payee's name opens **its page**: rename in place, lines, total, usual amount (the median), default
      category, "Ask every time", the spellings with "split off", and "Merge with…". **Payees & rules** lists the
      payees (sortable, searchable) and the rules (what each matches and sets, the lines it filed; edit, delete).
    - The import result's numbers open their lines: "N filed by your payees and rules" opens All filtered to the
      import (`importBatchId` with `transfers: false`), "N transfers matched" opens Transfers likewise. After a
      first import with a large unsorted history it points at "your biggest payees". The date filters read "Any
      date" while empty (WebKit draws an empty date field with today's date).
  - **Accounts:** grouped under their bank, create with an opening balance, archive. An `unconfirmed` account says
    that no statement has come in for it, so its balance is only what the other side sent.
  - **Import:** file, preview, profile (or the mapping wizard), account mapping, import with a progress bar (a
    refreshed page finds the running import), and the result with the review list.
  - **Accounting:** the journal with debit and credit columns, a manual journal form, the trial balance and the
    chart of accounts editor.
- Styling per `docs/dev/GILT.md`. Amounts use `Intl.NumberFormat` in the user's locale with the currency.
- **On the phone** (wave 3): the touch shell opens the same view from More → Finance, inside its own header (one
  title, a back button). The sections become a row of chips, controls are 44 px, and a **+ Cash** button beside the
  chips adds a cash expense (amount, category, note), posted to the Cash account, which it makes if there's none.
  A statement with less than 520 px of room (a phone, a narrow pane) stacks the comparative period and the
  change under each amount. The Finance switch is also in the phone's Settings → Sections, and the phone's bell
  shows the same host notifications as the desktop's, so the import reminder below opens Finance from there.

## Wave 2: close, schedules, budgets, forecast, statements

The same conventions hold: every command is `OwnFinance` with the `userId` author, arguments are camelCase, rows are
snake_case, and amounts are integer minor units, in the functional currency unless a row names its currency.
Months are `YYYY-MM`. The commands live in `crates/server/src/commands/finance_reports.rs`.

### Tables

| Table | Columns (main) | Notes |
|---|---|---|
| `fin_schedules` | id, entity_id, entry_id, ledger_account_id (the income or expense account spread), balance_account_id, kind (`prepaid` `accrued`), start_month, months, amount_minor, deferral_entry_id, created_at | A recognition schedule. `amount_minor` is the spread line's functional total, debit positive. |
| `fin_schedule_releases` | schedule_id, month, entry_id; PK(schedule_id, month) | One release entry per schedule and month, posted at close. |
| `fin_budgets` | id, entity_id, ledger_account_id, month NULL, amount_minor, created_at, updated_at; UNIQUE(entity_id, ledger_account_id, month) | A monthly target for an expense account. `month` NULL is the standing target for every month; a row with a month overrides it. No carry-over. |
| `fin_planned` | id, entity_id, date, description, amount_minor, ledger_account_id NULL, account_id NULL, created_at, updated_at | A planned one-off. `amount_minor` is its cash effect: positive in, negative out. |
| `fin_recurring` | id, entity_id, key, label, cadence (`weekly` `monthly` `quarterly` `yearly`), amount_minor, amount_low_minor, amount_high_minor, ledger_account_id NULL, account_id NULL, occurrences, first_date, last_date, next_date, status (`suggested` `confirmed` `dismissed`), created_at, updated_at; UNIQUE(entity_id, key) | A detected recurring payment or receipt. `key` is the normalised payee; the amounts are cash effects like `fin_planned`'s. |
| `fin_settings` | entity_id PK, reminder_enabled (default 1), reminder_weekday (default `Mon`), reminder_time (default `09:00`), reminder_last_at NULL, import_post_older (default 0), import_post_older_days (default 30) | Per-user finance settings. The reminder time is host-local. |

The chart gains three system keys, `prepayments`, `accrued_expenses` and `receivables` (the existing accounts, found by
code on older entities), and one account, *Deferred income* (liability, `deferred_income`), created when first needed.

### Period close

- A month closes after it ends, in order: an earlier month with entries must be closed first. A date in or before
  the latest closed month is locked: creating, editing, categorising, posting or deleting an entry there answers
  `InvalidInput("closed period: reverse it instead")`, and a correction is `fin_reverse_entry` dated in an open month.
- Closing first looks for **blockers**: pairs in `review` with an entry in the month, posted entries in the month
  with a line on `uncategorised_*`, and drafts in the month. With blockers and no `force`, nothing is written.
  Drafts hold even a forced close, since a draft in a locked month could never be posted or deleted.
- Then, in one transaction:
  1. **IAS 21 retranslation.** For every ledger account with a currency other than the functional one: its posted
     balance at month-end in its currency, translated at the closing rate (the last ECB rate on or before the
     month-end), against its carrying amount (the sum of its functional amounts). The difference posts in one entry
     dated the month-end, with `amount_minor` 0 and the difference as `functional_minor` on the account, against
     `fx_unrealised_gain` or `fx_unrealised_loss`.
  2. **Schedule releases** due up to the month, one entry each, dated at its own month's end (an earlier month
     with no entries never closes on its own, so its release posts here).
  3. **The lock:** `fin_periods` gets the month as `closed`.

### Recognition schedules

A schedule spreads one income or expense line of a posted entry over `months` months from `startMonth`, evenly,
with the rounding in the last month. Creating it posts a **deferral** entry on the entry's date that moves the line's
amount from its account to a balance account; each month's **release** moves its share back.

| Spread line | `startMonth` from the entry's month on (`prepaid`) | `startMonth` before it (`accrued`) |
|---|---|---|
| Expense | `Prepayments` (paid ahead) | `Accrued expenses` |
| Income | `Deferred income` (received ahead) | `Receivables` |

Every month of the schedule and the entry's own month must be open. While an entry has a schedule, its lines and
date are fixed and it can't be deleted: delete the schedule first. Reversing it reverses its deferral and posted
releases on the same date and ends the schedule. Profit or loss and budgets go by recognition period: a release not
yet posted (its month is still open) counts in its month as if posted. Cash flow goes by cash date and ignores
deferrals and releases.

### Forecast

`fin_forecast` projects the **cash balance** at a month's end. Cash here is every current, savings, cash and card
account (cards negative), posted and draft, since a draft is a real bank line. A draft counts as uncategorised until
it's categorised. The projection is the sum of its
lines, each explained:

- `opening`: the actual balance today (for the current month), or the previous month's projected end.
- `actual`: for a month that's over, what happened; it has no other lines and no band.
- `recurring`: each confirmed recurring item's occurrences after today in the month, at its typical amount, with its
  low–high band.
- `planned`: planned items dated after today in the month.
- `category`: for every income or expense account with at least 3 months of history, the median of its last 3–6
  complete months (cash, by entry date, leaving out entries a confirmed recurring item covers), less what's already
  happened this month, never past zero. Its band is the lowest and highest of those months.

The low and high ends add the lines' lows and highs. A past month returns its actual end with no band. The same
inputs give the same forecast.

### Statements

`fin_statement` returns structured rows for the UI, which renders them and makes the PDF. The period is a month
(`YYYY-MM`) or a year (`YYYY`); the comparative is the period before it (on by default). Every row is `{key, label,
level, style: header|line|subtotal|total, ledger_account_id?, amount_minor, comparative_minor?}`, with amounts in
their natural sign (assets, liabilities, income and expenses positive). `checks` holds the identities the host
verified.

- `position` (IAS 1, at the period's end): assets, liabilities and net worth (equity accounts plus the surplus to
  date). `checks.balanced`: assets = liabilities + net worth.
- `profit_loss` (by nature, by recognition period): income, expenses, the surplus or deficit, other comprehensive
  income (movements in the OCI reserve) and total comprehensive income.
- `cash_flow` (IAS 7, direct): cash is the accounts under *Cash and cash equivalents*. Each cash movement is classed
  by its counter account's `cash_flow_class` (a transfer's by the other side's account), giving operating,
  investing and financing sections, the net change, the effect of exchange rates (retranslation), the opening
  balances recorded (against opening balance equity, outside the three sections), and opening and closing cash.
  `checks.reconciles`: opening + net change + FX effect + opening balances recorded = closing.
- `equity` (changes in net worth): opening net worth, the surplus or deficit, OCI, opening balances recorded,
  other movements, closing net worth.

### The weekly import reminder

A host check runs every minute. For each user with a finance entity and the reminder on, it finds the latest
weekly instant (`reminder_weekday` at `reminder_time`, host-local, parsed as the `"Mon 09:00"` schedule form) and,
if that's later than both the last reminder and the entity's creation, creates one notification (category
`finance`, "Time to import your bank statements", no amounts) and stamps `reminder_last_at`. A host that was down
catches up once. Changing the day or time counts from the change, so it doesn't fire at once. The bell shows it
on the desktop and on the phone (`src/lib/notificationFeed.ts`) while the app is open.

### Commands

| Command | Args | Returns |
|---|---|---|
| `fin_list_periods` | — | `Period[] {month, status, closed_at, entries, drafts}` from the first month with an entry to the current month |
| `fin_close_period` | `month, force?` | `{closed, month, blockers: {review_pairs: pairId[], uncategorised: entryId[], drafts: entryId[]}, retranslation_entry_id, release_entry_ids}` |
| `fin_list_schedules` | `entryId?` | `Schedule[]` with `rows: [{month, amount_minor, released}]` |
| `fin_create_schedule` | `input {entryId, ledgerAccountId?, startMonth, months}` | `Schedule`. `ledgerAccountId` picks the line when the entry has more than one income or expense line. |
| `fin_delete_schedule` | `scheduleId` | `{}`. Only while none of its releases has posted; removes its deferral entry. |
| `fin_list_budgets` | — | `Budget[] {id, ledger_account_id, month, amount_minor}` |
| `fin_create_budget` / `fin_update_budget` / `fin_delete_budget` | `input {ledgerAccountId, month?, amountMinor}` / `budgetId, input {amountMinor}` / `budgetId` | `Budget` / `Budget` / `{}` |
| `fin_budget_progress` | `month` | `[{ledger_account_id, name, budget_id, target_minor, actual_minor, remaining_minor}]`, `actual_minor` spent by recognition period |
| `fin_detect_recurring` | — | `Recurring[]`, after refreshing the suggestions from posted history. Dismissed items stay dismissed; confirmed ones get fresh figures. |
| `fin_list_recurring` | `status?` | `Recurring[]` |
| `fin_resolve_recurring` | `recurringId, confirm` | `Recurring` (confirmed, or dismissed) |
| `fin_list_planned` | `from?, to?` | `Planned[]` |
| `fin_create_planned` / `fin_update_planned` / `fin_delete_planned` | `input {date, description, amountMinor, ledgerAccountId?, accountId?}` / `plannedId, input` / `plannedId` | `Planned` / `Planned` / `{}` |
| `fin_forecast` | `month` | `{month, as_of, opening_minor, end_minor, low_minor, high_minor, lines: [{kind, label, date?, amount_minor, low_minor, high_minor, ledger_account_id?, ref_id?}], categories: [{ledger_account_id, name, class, actual_minor, projected_minor, median_minor, history_months, budget_minor?}], warnings: [{ledger_account_id, name, budget_minor, projected_minor, over_minor}]}`. Category amounts are natural (spent or received, positive). |
| `fin_statement` | `kind (position\|profit_loss\|cash_flow\|equity), period, comparatives?` | `{kind, period, from, to, currency, comparative: {period, from, to}\|null, rows, checks}` |
| `fin_statement_csv` | as `fin_statement` | `{file_name, content}`: one row per statement row, amounts in major units |
| `fin_get_settings` / `fin_update_settings` | — / `input {reminder?: {enabled?, weekday?, time?}, import?: {postOlder?, postOlderDays?}}` | `{reminder: {enabled, weekday, time}, import: {post_older, post_older_days}}`. `weekday` is `Mon`…`Sun`, `time` is `HH:MM`, `postOlderDays` 1–3650 (30 by default). |

### Wave 1 changes

- A manual journal may mix currencies: each line is translated at the spot rate of its date, and what's left over
  after translation posts to `fx_realised_gain` or `fx_realised_loss`.
- Fee kinds (a plan's monthly fee and other `fee` lines) draft against `bank_fees` instead of uncategorised.
- A refund and the expense it nets against don't count as the same fix for the rule offer.
- An import skips lines dated in a closed month, with a warning; they're corrected in an open month.

## Starting over

Finance → Settings ends with a danger zone, **Delete all finance data**, for a user who wants to import their history
again from scratch (`crates/core/src/finance/reset.rs`). Its confirmation lists what goes with counts (accounts,
transactions, rules, saved layouts), offers "Keep my categorisation rules and saved import layouts" (off by default),
and enables its button only once `DELETE` is typed. Then it shows the job's progress and opens the empty overview.
The phone shell shows the same Settings section.

- **What goes:** everything in the caller's entity: accounts and their ledger accounts, entries and lines, source
  lines and import batches, pairs, payee-group suggestions, budgets, planned and recurring items, schedules and their
  releases, periods and the audit trail, and the rules and saved import layouts unless `keepRules`.
- **What stays:** the entity row (its name and functional currency), its `fin_settings` (the reminder and the import
  option), and the global `fin_rates`. The default chart is created again, as on first use, and one `reset` audit row records
  the counts.
- **Kept rules** are pointed at the new chart: a category by its system key, else its code and class, and a category
  of the user's own is created again with its name. A rule's account condition goes with the accounts, and a rule
  left with no condition is dropped, since it would match everything.
- **Writes:** a background job, one per user in the host's memory, deleting in `BEGIN IMMEDIATE` transactions of 500
  rows with a short pause after each, as the import writes, so a reset of ten thousand entries holds no long lock.
  Indexes on the columns that point at an entry (`reverses_id`, a pair's `adjust_entry_id`, a schedule's entry and
  deferral, a release's entry) keep each entry's delete from scanning those tables. A write that slips in meanwhile
  is swept up in the last transaction, which also replaces the chart.
- **Refused** while the user's import, a bulk action (`fin_post_matching`, `fin_categorise_matching`) or the
  suggestions job runs; and those, and another reset, are refused while it runs. The host log gets one line with the
  user id and the counts, nothing else.

| Command | Args | Returns |
|---|---|---|
| `fin_reset_preview` | — | `{accounts, entries, rules, layouts}`: what a reset would delete |
| `fin_reset` | `confirm` (exactly `"DELETE"`), `keepRules?` | `ResetJob`, running |
| `fin_reset_status` | `jobId?` | `ResetJob \| null`: that job (another user's is not found), else the user's latest. `ResetJob {job_id, state: running\|done\|failed, done, total (rows), started_at, finished_at?, result?: {removed: {accounts, entries, rules, layouts}, kept_rules}, error?}` |

## Assistant (wave 4)

Finance data reaches a model only on the host's own terms: a local Ollama model, the caller's own books, read-only.
`SECURITY_MODEL.md` § 8 states the rules; the code is `crates/server/src/finance_tools.rs`.

### Personal chats

The chat list has a **Personal** section: chats in the caller's personal container (`ensure_personal_space`). Every
chat route treats someone else's container as absent (`require_chat_project`), so the host owner's project bypass
stops there, as it does at Finance (ADR 0009). Personal chats can't be shared with a team, and they run on local
models only, tools on or off, because their history may hold figures the tools returned.

### Finance tools

With Tools on, a chat turn offers six read tools when all of these hold, and the tool loop checks them again before
each call:

- the chat's project is the caller's own personal container (not someone else's, not a project);
- the tool tier's runner is Ollama (a pi runner never gets them), and neither the tool model nor the answering model
  is an Ollama cloud tag (`…-cloud`, `…:cloud`), and neither engine (a profile's endpoint, else the host's) is on
  `ollama.com`; an Ollama endpoint the owner configured counts as local;
- the caller already has a finance entity (a chat never sets Finance up).

A personality's loadouts still scope them like any other tool (a call to one the turn didn't offer is refused), a
registry tool can't take their names, and a delegation never carries them.

| Tool | Args | Returns (amounts in major units) |
|---|---|---|
| `finance_balances` | — | each account's balance (posted and inbox) and the total in the functional currency |
| `finance_by_category` | `period` or `from`/`to`, `category?` | spending and income by category over the period, by entry date, drafts included (`category_totals`) |
| `finance_transactions` | `search?`, `period` or `from`/`to`, `category?`, `limit?` (≤ 30) | the matching entries, newest first |
| `finance_statement` | `kind`, `period` | a statement's rows with the previous period |
| `finance_forecast` | `month?` | the month-end cash projection, its range, drivers and budget overshoots |
| `finance_budgets` | `month?` | each budget's target, spending and what's left |

A `period` is `this_month`, `last_month`, `this_year`, `last_year`, `YYYY-MM` or `YYYY`. When the tools are offered,
the system prompt gets today's date and says the figures come from the tools.

### Category suggestions

In the Transactions inbox, **Suggest** (per line, and in bulk for the unsorted lines shown) asks the host's local
model for a category. The model is the active personality's when it runs on the host's engine, else the chat
default, and it must be installed there and not a cloud tag; without one, the button is hidden.

| Command | Args | Returns |
|---|---|---|
| `fin_suggest_available` | — | `{available, model}` |
| `fin_suggest_categories` | `entryIds` (≤ 60) | `[{entry_id, ledger_account_id \| null}]` |

The prompt holds each line's description, payee and amount and the names of the chart's income and expense
categories, nothing else. The reply is matched to the user's own names on the right side (a payment takes an
expense, money in an income category); anything else is `null`. A suggestion is shown until the user takes it
("Use it", or "Use n suggestions") or dismisses it; the host never applies one.
