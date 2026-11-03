# Working with the assistant

You don't program the assistant — you **instruct** it, in plain language, and it
uses its tools to help. Here's how to get good results, and what it can (and
can't) do.

## How a turn works

1. The assistant is **grounded** in the current project — it's given relevant
   tasks, files, and notes automatically.
2. With **Tools** on (the 🔧 toggle), it can *act*: **reads** (look up tasks,
   search the corpus, search/fetch the web) run immediately; **writes** (create a
   task, draft an email, link an event) are turned into **proposals you approve**
   in the inbox. It never changes anything on its own.
3. It can **chain** tools in one turn — search, then read a page, then draft a
   summary — so you can ask for a small workflow, not just one step.

## Instructing it well

- **Turn on Tools** for anything beyond conversation.
- **Be specific about the target and the output.** "Summarise task #14's comments
  in 3 bullets" beats "what's going on with that task."
- **It's fine to ask for several steps.** "Search the web for X, read the best
  result, and propose a comment on task #14 with a 5-point summary."
- **Writes are proposals** — phrase it however you like ("draft…", "propose…",
  "create…"); you'll approve (or reject) each one. Bulk asks ("link all the
  lecture events") produce one proposal per item.
- **Pick the right personality.** @mention one whose **loadout** carries the tools
  you need — e.g. your web-research personality for anything online. If it says it
  can't do something, its loadout probably doesn't include that tool (Settings →
  AI → Loadouts).

## Example workflows

**Research → summary**
> *Search the web for the latest IMO 2026 fuel regulations, read the most relevant
> page, and give me a 5-bullet summary with the source links.*

Uses `web_search` → `read_page`/`web_fetch`. Add *"…and propose it as a comment on
task #14"* to land it via `create_comment` (you approve).

**Task triage**
> *Which tasks are blocked? Propose bumping the two most overdue to High priority.*

Uses `get_tasks` → `update_task` proposals — review each in the inbox.

**Calendar cleanup**
> *Find upcoming events not linked to any project that look like they belong here,
> and propose linking them.*

Uses `get_unlinked_events` → `link_event_to_project` proposals.

**Grounded answer**
> *What did we decide about the Panamax FFA hedge? Cite the file.*

Uses `search_corpus` over the project's own knowledge — no web, no guessing.

**Email (if the Email tab is on)**
> *Draft a reply to the latest thread from Jamie, attaching the syllabus.*

Uses the email tools to put a draft in your Drafts — Ganban never sends.

## What it can't do (and why)

The assistant can only do what its **tools** allow. By design there is **no tool**
for managing membership, identities/profiles, billing, or settings — those are
**yours** to do in the UI. Changing who has access or who you are is never
something an assistant should propose. If it claims it did something like that,
it's mistaken — there's no tool behind it.

## Extending it (owner)

If you *want* the assistant to do something it currently can't — expose a safe
read, call an internal API, fetch a specific dashboard — you add a **tool** in
Settings → AI → Tools (it's configuration, not code), put it in a **loadout**, and
assign it to a personality. Every new tool still rides the same gate: reads are
scoped, writes are proposals, secrets stay on the host. See *AI: tools, connectors
& loadouts*.
