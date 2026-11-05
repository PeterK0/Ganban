# Ganban

A self-hosted project workspace for small teams on a tailnet: a host serves projects, tasks and files to desktop, web
and phone clients, and runs the team's agents.

## Language

### Commands

**Command**:
A named operation a client asks the host to run, such as `create_task` or `get_project_comment_board`. Every client
reaches data through commands.
_Avoid_: endpoint, RPC, action

**Access rule**:
The declaration of who may run a command: the owner only, a project admin, a member of the project the arguments point
at, or any member with the results filtered. A few commands need more: an admin of any project (the shared calendar and
address book), or the user the arguments name, themselves (personal settings and PINs, which the owner may also reset).
On a task, or anything on one, the caller must also be in the task's audience. Finance commands reach only the caller's
own entity, with no owner bypass. A command without an access rule is refused.
_Avoid_: permission check, policy, authorize arm

**Result filter**:
What trims a command's result so a non-owner sees only rows from projects they belong to, and only tasks in their
audience.
_Avoid_: post-scope, scope

**Authorship field**:
The argument of a command that says who did it, such as a comment's author or a task's assigner. Over HTTP the host
overwrites it with the signed-in user; the desktop app sends the selected local profile.
_Avoid_: user id stamping, actor

### Visibility

**Task visibility**:
Who among a project's members may see a task: those its area allows (the default), selected members, or admins only.
A member outside a task's audience finds it absent: not listed, not counted, not found.
_Avoid_: privacy, permissions, task ACL

**Audience**:
Everyone who can see a task: the owner, the project's admins, the task's assignees, and whoever its visibility admits.
_Avoid_: viewers, readers

**Restricted area**:
An area only its area members (and the audience everyone always is in) can see, together with the tasks that follow it.
_Avoid_: private area, locked area

**Area member**:
A project member associated with an area. In a restricted area, area members are who its tasks are visible to.
_Avoid_: area user, area team

### Shell

**Pinned tab**:
A project's tab (with its sub-view, e.g. a game tab's practice mode) pinned by a user to the global top bar, to reach it
from any project in one click or open it in its own window. Per user, stored on the host that owns the project.
_Avoid_: favourite, bookmark, pinned project (the sidebar's project pins are a different thing)

**Gilt**:
Ganban's visual design from November 2026 (`docs/dev/GILT.md`): Josefin Sans deco headings over Figtree text, thin gold
edges and corner marks on cards, diamond markers, square-ish 3px corners. Every theme wears it; each theme supplies
its own gold.
_Avoid_: skin, theme (a theme is a colour set; Gilt is the design every theme is drawn in)

**Share link**:
A public link to a fixed set of a task's or a project's files (made from the task's Files tab or Project > Files), for someone outside the team: no account, an expiry, optionally a
password, revocable, with a download count (ADR 0006).
_Avoid_: public file, shared file (a "shared" file is one stored on the host, as opposed to a member's local copy)

**Share door**:
The host's second listener, which serves only share links and is the one part published to the internet (ADR 0006).
_Avoid_: public server, gateway

**Update channel**:
Where a build of the apps updates from, fixed when it's built: `host` (the host that built it), `github` (the repo's
GitHub Releases) or none (a dev build). Each channel signs with its own key (ADR 0008).
_Avoid_: update source, release track

**Side pane**:
The resizable panel on the right of Home, the calendar and a project's tasks that shows the selected task or event
in an editor. Its width is shared by every view and remembered per device.
_Avoid_: drawer, inspector, detail panel

### Calendar

**Series**:
A repeating event: one stored event (its master) with a repeat rule, the days it skips (`exdates`) and how it ends
(never, on a date, after N times). The Repeating view lists one row per series.
_Avoid_: recurring event row, master (except in code)

**Occurrence**:
One day of a series, worked out from the rule on the client, never stored. It is picked, copied and changed on its
own: a change asks "This event / This and following / All events". "This event" skips the day and, for an edit or a
past mark, puts a one-off copy in its place (`series_id` names the series). "This and following" ends the series the
day before and starts a new one.
_Avoid_: instance, recurrence (the rule)

### Tabs

**Save slot**:
One per-user `tab_user_state` row keyed `<tab>:<slot>`, with its own 128 KB wall. A tab with independent parts (a
game and its log, say) gives each its own slot, so one part's growth never pushes another's save over the cap.
_Avoid_: save file, blob

**Tab module**:
A tab in its own folder that registers itself through `src/tabs/<folder>/module.tsx` (`src/tabs/modules.ts`): panel,
icon, sub-views, pages and settings cards. A build without the folder has no such tab and nothing breaks.
_Avoid_: plugin (tabs are compiled in; nothing installs at run time)

### Finance

**Entity**:
The personal reporting entity whose books Finance keeps: one per user, private to them (ADR 0009). Its functional
currency, chart and entries belong to it alone.
_Avoid_: ledger, book, finance account

**Functional currency**:
The currency an entity's books balance in (euros unless the user picks another). Amounts in other currencies are
translated into it at the spot rate of their date.
_Avoid_: base currency, home currency

**Ledger account**:
One account of an entity's chart: an asset, a liability, equity, income or an expense. Every line of a journal entry
posts to one.
_Avoid_: GL account, account (alone, it means a financial account)

**Category**:
An income or expense ledger account, as everyday screens show it ("Groceries", "Salary"). Categorising a bank line
picks the ledger accounts on its other side.
_Avoid_: tag, label, bucket

**Financial account**:
A bank, savings, card, cash or loan account the user holds, with its own ledger account: an asset, or a liability
for a card or a loan.
_Avoid_: bank account (it may be a card or cash), wallet

**Source line**:
One row of an imported statement, kept as it came. It is the evidence a journal entry is built from, and how a
re-import knows the row is already in.
_Avoid_: transaction, statement row (in code), import row

**Journal entry**:
A dated set of lines, debits and credits, that balances in the functional currency. An imported one starts as a
draft in the inbox and is posted once the user has checked it.
_Avoid_: transaction, booking, posting (posting is the step from draft to posted)

**Transfer pair**:
Two journal entries that are the two sides of one move between the user's own financial accounts (or one currency
exchange), matched so the move nets to zero instead of counting as income and spending.
_Avoid_: match, link, internal transaction

**Payee group**:
The inbox's drafts from one merchant in one direction (money spent, or money received), as the host groups them
so one pick sorts them all. The merchant is the payee, else the description without digits and punctuation.
_Avoid_: merchant group, cluster, bucket

**Personal chat**:
A chat in the user's personal container, listed under "Personal" in the chat list. Only its user sees it, the host
owner included, and it's the one place the assistant may read their finances, on a local model.
_Avoid_: private chat (a project chat is private to its author until shared), finance chat

**Period close**:
Locking a month of an entity's books once it's reported. Entries in a closed period can't be edited or deleted; a
correction is a dated reversal in an open period.
_Avoid_: lock, freeze, month end (month end is the date; closing is the act)
