# Finance keeps a double-entry ledger: source lines apart from journal entries, edit until close, then reverse

Finance records money as double-entry accounting on IFRS principles, not as a list of transactions with a category
field. Every journal entry balances in the functional currency, and a category is an income or expense ledger
account, so the same books give balances, a trial balance, and later the statements of IAS 1 and IAS 7 and foreign
currency under IAS 21. Everyday screens hide debits and credits: the app writes the journal underneath.

An imported bank row is kept verbatim as a source line, apart from the journal entry built from it. The source line
is the evidence and the dedupe key; the entry is the interpretation, which the user re-categorises, splits or pairs
freely. Deleting an entry keeps its source line, marked dismissed, so a re-import doesn't bring it back.

An entry in an open period can be edited or deleted. Once a month is closed it's locked, and a correction is a dated
reversal entry in an open period. Every change is written to the audit log.

## Considered options

- **Single-entry transactions with a category:** rejected. Transfers between own accounts, card debt, foreign currency
  and accruals would each need special cases, and the books couldn't be checked for balance.
- **The imported row as the entry itself:** rejected. Splitting, pairing and re-categorising would rewrite the
  evidence, and dedupe would drift with every edit.
- **Immutable entries from the start (reverse every mistake):** rejected. Correcting this month's categories by
  reversal would bury the inbox in noise; the lock matters only once a period is reported.

## Consequences

- Money is integer minor units with a currency code; a line's sign is debit positive, credit negative.
- A bank line in another currency is translated at the ECB spot rate of its date, unless the bank's own converted
  amount is known. The host caches the ECB rates.
- A transfer between own accounts posts both sides to a clearing account, so a matched pair nets to zero.
