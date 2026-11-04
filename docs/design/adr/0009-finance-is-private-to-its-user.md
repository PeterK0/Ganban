# Finance is private to its user, and the owner bypass stops at Finance

A user's finances (accounts, statements, categories, the ledger) are theirs alone: no one else on the host sees them,
the host owner included. Everywhere else the owner sees everything (ADR 0002), because the owner runs the workspace
and its work belongs to it. A person's money doesn't. Every finance command acts on the caller's own entity, picked
by the command's authorship field, which the host stamps with the signed-in user for everyone, the owner too. No
command takes an entity id, and a row id from another entity is "not found", the way another project's rows look.

## Considered options

- **The owner sees every member's finances, as with tasks:** rejected. It would make Finance useless to anyone but
  the owner, and a member can't be expected to trust it.
- **Finance data inside the user's personal container project, guarded by project membership:** rejected. The
  owner's bypass applies to every project, so the guard would need an exception there anyway, and it would be less
  visible than one access rule.
- **Encrypting each user's rows with a key only they hold:** not now. The host owner runs the machine and its
  database file, so this ADR is about what the app shows, not about a host owner who reads the file directly.

## Consequences

- The access rule `OwnFinance` admits any signed-in member and checks nothing more: the core functions take the
  author's entity and reach only its rows, so the owner's skipped check gives the owner nothing extra.
- The desktop app runs commands in-process with the authorship it sends, as everywhere. Finance lives on the host
  and is never synced to a replica.
- Assistant tools that read finances (a later wave) are offered only in the user's own personal chats.
- Finance data stays out of logs, diagnostics and bug reports.
