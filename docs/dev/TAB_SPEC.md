# TAB_SPEC: building a Ganban tab

A **tab** (a "stash tab" in the code) is an optional panel in a project's tab bar, next to Tasks, Comments and Files.
A project's admins turn tabs on and off per project. A tab can also give the AI assistant new tools.

This spec is the reference: what a tab is made of, the rules it follows, and how to check it. To build one step by
step, follow [TAB_TUTORIAL.md](TAB_TUTORIAL.md). For the look, follow [GILT.md](GILT.md).

## What ships

Tabs are compiled into the app. There is no plugin loader, no install step and no code fetched at run time: to add a
tab, you change the source and build. Seven tabs ship today:

| Id | Name | Tier | What it shows |
|---|---|---|---|
| `nato` | NATO Trainer | 1 | A phonetic-alphabet game |
| `email` | Email | 2 | Mail threads linked to the project; the assistant can draft replies |
| `kanban` | Kanban | 1 | The project's tasks as a status board |
| `models` | Models | 1 | Model-kit and army builds |
| `quiz` | Quizzes | 1 | A quiz bank with graded runs |
| `atlas` | Atlas | 1 | The workspace's knowledge collections, filtered for the project |
| `pdf` | PDF Studio | 2 | Split, merge and restructure the project's PDFs; the assistant can propose splits and merges |

- **Tier 1** is a panel only. It adds no assistant tools.
- **Tier 2** is a panel plus assistant tools. Every tool goes through the same gate as the built-in ones: reads run
  on their own, and writes become proposals the user approves.

The smallest real examples to read: **NATO** (`src/tabs/NatoTab.tsx`) for Tier 1, **PDF Studio** for Tier 2.

## Anatomy

| Part | Where | What it does |
|---|---|---|
| Feature flag | `crates/server/Cargo.toml`, `[features]` | `tab-<id> = []` (plus any `dep:` the tab needs). Listing it in `default` builds it in. |
| Descriptor | `crates/server/src/tabs.rs`, `available_tabs()` | A `TabDescriptor` behind `#[cfg(feature = "tab-<id>")]`: `id`, `name`, `icon`, `tier`, `description`, `has_tools`. The order of `available_tabs()` is the order in the ＋ popover. |
| Tools (Tier 2) | `crates/server/src/tabs.rs` | A `pub mod <id>` with the tool definitions and handlers, wired into the five dispatch points (below). |
| Panel | `src/tabs/<Name>Tab.tsx` (or a folder of its own: see Tab modules below) | A React component, the default export, taking `TabPanelProps`. |
| Registry | `src/tabs/registry.tsx` | `TAB_PANELS` maps the id to the lazy-loaded panel. `TAB_ICONS` maps it to an icon. |
| Icon | `src/components/icons/TabIcon.tsx` | The line-icon set. Pick a name from `ICONS`, or add one in the same style (24-unit box, 1.6 stroke, `currentColor`). |

How the pieces meet:

- The host reports the tabs it was built with at `GET /tabs`. A project's enabled tabs are rows in `project_tabs`.
- The desktop tab bar (`src/components/ProjectView.tsx`) shows a tab when it is enabled **and** has a panel in
  `TAB_PANELS`. An id the host reports without a panel shows nothing, and the reverse, so the server and the
  frontend never break each other.
- Phones and browsers use the same registry (`src/mobile/screens/StashTabScreen.tsx`), so a panel runs everywhere.
  Design it to work at phone width.
- The descriptor's `icon` emoji is kept only for older clients. The app draws the `TAB_ICONS` entry; a tab without
  one gets a neutral icon.
- A panel that throws is caught by `TabErrorBoundary`, so it can't take the project view down with it.

### Tab modules: a tab in its own folder

A bigger tab can live in a folder, `src/tabs/<folder>/`, and register itself with a `module.tsx` whose default
export is a `TabModule` (`src/tabs/modules.ts`): its panel, icon, pinnable sub-views, `?pane=` pages of its own,
its pin window and owner cards for Settings → Plug-ins. A module can also bring a `rail` view: a top-level view
with its own sidebar entry (and a row in the phone's More screen), shown when the host reports the tab and the user
turned it on in Settings → Plug-ins (a per-user host setting, `RAIL_SETTING`). A module with only a rail view has no
`panel` and isn't offered per project; Finance is one. `modules.ts` finds every `module.tsx` at build time with
`import.meta.glob`, so a build without the folder has no such tab, and nothing else imports from the folder. The
host side of such a tab can go in `crates/server/src/extra_tabs.rs`, which `build.rs` compiles in only when the file
exists (`cfg(extra_tabs)`). This is how a build carries a tab the public tree doesn't.

## The panel contract

```tsx
import type { TabPanelProps } from "./registry";   // { projectId: number }

export default function MyTab({ projectId }: TabPanelProps) { … }
```

The panel gets the project id and nothing else. Everything else comes from the host through the helpers in
`src/lib/daemon.ts`. They go through `daemonFetch`, which works on the desktop, in a browser and on a phone.

| Helper | Route | Who | Use it for |
|---|---|---|---|
| `getTabUserState(projectId, tabId)` / `setTabUserState(…, state)` | `/projects/:id/tabs/:tab/state` | each member, their own row | Saves, lists, stats: anything that should follow a user to their other devices. 128 KB of JSON per key. |
| `listTabScores(projectId, tabId)` / `postTabScore(…, kind, score, meta)` | `/projects/:id/tabs/:tab/scores` | members read all, post their own | A project leaderboard. `kind` is kebab-case, up to 24 characters; scores run from 0 to 100,000; `meta` is up to 1 KB of JSON. Client-reported: a friendly ranking, not anti-cheat. |
| `getProjectTabConfig(projectId, tabId)` / `setProjectTabConfig(…, config)` | `/projects/:id/tabs/:tab/config` | members read, admins write | Settings shared by the whole project (Atlas keeps its saved filters here). 8 KB of JSON. Saving needs the tab to be on. |

- **Save slots.** A tab with independent modules can keep several state rows: the key `<tab>:<slot>` (a slot is
  short kebab-case, up to 24 characters) is its own row with its own 128 KB limit. The Quizzes tab could keep its
  settings in `quiz` and a run in progress in `quiz:run`. The slot never widens access: the row is still the
  caller's own.
- **Per-project vs per-user.** Project config is the admins' word on shared behaviour. User state fills in where the
  project says nothing.
- **Live updates.** `useDataPulse(refetch, kinds)` (`src/lib/livePulse.ts`) calls `refetch` when the host says
  something changed. An approved assistant write pulses `entities`. Saving tab state never pulses: it's private.
- **New data shapes.** Data that doesn't fit these three (shared records many members edit, for example) needs host
  tables and commands. Those go through the command table ([ADR 0001](../design/adr/0001-one-command-table.md)):
  every command declares its access rule, and a command without one is refused. If it touches tasks, respect task
  visibility ([ADR 0002](../design/adr/0002-task-visibility.md)).

## Tier 1: a panel

Four edits; [TAB_TUTORIAL.md](TAB_TUTORIAL.md) walks through each with the code.

1. `crates/server/Cargo.toml`: add `tab-<id> = []` to `[features]` and to `default`.
2. `crates/server/src/tabs.rs`: push a `TabDescriptor` in `available_tabs()`, behind
   `#[cfg(feature = "tab-<id>")]`, with `tier: 1` and `has_tools: false`.
3. `src/tabs/<Name>Tab.tsx`: the panel, a default export taking `TabPanelProps`, with its content in a `ScrollArea`.
4. `src/tabs/registry.tsx`: add the panel to `TAB_PANELS` (`<id>: lazy(() => import("./<Name>Tab"))`) and an icon
   to `TAB_ICONS`.

Then rebuild the server and the web UI, open a project, press **＋** at the right end of the tab bar and tick the tab.

## Tier 2: assistant tools

A Tier-2 tab adds tools to the assistant's chat loop when the tab is on for the project. The chat loop
(`crates/server/src/tools.rs`) calls into `tabs.rs` at five points. Each one is a function with a
`#[cfg(feature = "tab-<id>")]` branch per tab:

| # | Function in `tabs.rs` | It answers | PDF Studio's branch |
|---|---|---|---|
| 1 | `tool_defs_for(enabled)` | Which tool definitions does the model see? Only enabled tabs' tools. | `pdf::tool_defs()`: `get_project_files`, `pdf_extract_pages`, `pdf_merge` |
| 2 | `is_tab_read_tool(name)` and `is_tab_write_tool(name)` | Is this name a read (runs at once) or a write (needs approval)? | `get_project_files` reads; `pdf_extract_pages` and `pdf_merge` write |
| 3 | `execute_read(db, project_id, name, args)` | Run a read and return text for the model. | `require_enabled(…, "pdf")`, then list the project's files |
| 4 | `prepare_write(db, user_id, project_id, name, args)` | Check a write and turn it into a proposal. Never writes. | Checks the page range and that each file is a PDF in this project; returns a `PreparedWrite` |
| 5 | `apply(db, root, command, args)` | Run a write after the user approved it. | Does the page work with lopdf and stores the result as a new project file |

A `PreparedWrite` has four fields:

- `command`: the tool name;
- `args`: everything `apply` needs, with the project id filled in by the server;
- `summary`: the one line the user approves;
- `details`: a `before`/`after` object for the diff in the Activity view.

Then, in the descriptor, set `tier: 2` and `has_tools: true`. The tools appear in the assistant's tool catalog
(`GET /tools/catalog`), and on the ＋ popover the tab gets an "agent tools" badge.

The rules for tools:

- **Check enablement in the handler.** Call `require_enabled(db, project_id, "<id>")` in branches 3 and 4. The model
  only sees enabled tabs' tools, but it can still name a tool it was never offered.
- **Stay in the project.** The chat loop passes the chat's project id; use it, and never a project id from the
  model's arguments. Check that every id the model gives you (a file, a thread) belongs to that project, as
  `require_project_pdf` does.
- **Writes are proposals.** `prepare_write` validates and describes; only `apply` changes anything, and it runs only
  after approval. The approval and the rejection both land in the action ledger.
- **Who approves.** By default the member who asked approves their own proposal (a project can require the host's owner
  instead). So a tool's write must be something that member may do anyway. Writing the proposer's own tab state or
  adding a project file is fine. Changing admin-only project config is not.
- **Reads get no viewer.** `execute_read` doesn't know which member is asking, so a tab tool must not return task data,
  because task visibility depends on the reader ([ADR 0002](../design/adr/0002-task-visibility.md)). Use the built-in
  task tools for that.
- **Write through the core.** Use the functions in `ganban_core` (`ops`, `storage`). Plain SQL is fine for a small
  read, as in `require_project_pdf`, but a write in tab code bypasses the checks those functions make.
- **External content is hostile.** Text from mail, the web or files can carry instructions aimed at the model. Cap
  it, collapse it, show it as inert text, and never let it authorize anything. The Email tab is the example: it
  reads only threads a user linked to the project, and its one write saves a draft. Ganban cannot send mail.
- **Name tools uniquely.** A tab tool's name must not match a built-in tool. Prefix it with the tab id
  (`hello_…`, `pdf_…`).

A test belongs next to the tools, in `tabs.rs`. Copy `pdf_tools_respect_enablement_scope_and_the_gate`: tools refuse
while the tab is off, reads work once it's on, a bad call fails in `prepare_write`, and `apply` does the work.

## Turning a tab on

- **Who:** the project's admins and the host's owner (the account that set the host up). Members see the enabled tabs but can't change them.
- **Where:** the **＋** at the right end of a project's tab bar opens "Tabs for this project", a checklist of every tab
  the host was built with. Project Settings → Tabs shows the same list.
- Only tabs the host was built with can be turned on. A host built without a tab's feature simply doesn't offer it.
- Turning a tab off hides it, removes its tools from the assistant and drops everyone's pins to it. It also drops the
  tab's project config, which lives on the enablement row. Members' saved state stays, so turning the tab back on
  restores their saves.

## Rules for the panel

These hold for every tab. Most come from the desktop app's webview (WKWebView on macOS).

1. **Look:** follow [GILT.md § How to style a new screen](GILT.md#how-to-style-a-new-screen). Use theme colours
   only, and check the panel in a dark theme and in Catppuccin Latte.
2. **Scrolling:** every scrolling region is a `ScrollArea` (`src/components/ScrollArea.tsx`). Native scrollbars are
   hidden app-wide. Put padding and spacing on `contentClassName`, not `className`.
3. **Talking to the host:** use the helpers in `src/lib/daemon.ts` or `src/lib/api.ts`. A raw `fetch` to a host URL
   breaks on the desktop and on phones.
4. **Confirmations:** `confirmDialog` (`src/lib/confirm.ts`), never `window.confirm`. Modals use `<Modal>`.
5. **Dragging:** pointer events (`setPointerCapture` and `elementFromPoint`, with a 5px threshold before a drag
   starts). HTML5 drag and drop doesn't work in WKWebView.
6. **Popovers:** portal them to `document.body`, or an ancestor with `overflow: hidden` clips them.
7. **Freshness:** `useDataPulse(refetch, kinds)` with the kinds you care about, not a polling loop.
8. **Storage:** `localStorage` is only for cosmetic, per-device preferences (a pane width, a collapsed section).
   Anything a user expects to follow them goes to tab state or project config.
9. **Secrets:** API keys and passwords stay on the host. A tab never puts one in its code, its config blob or the
   frontend.
10. **Maps:** load imagery through the host's tile proxy (`/tiles/…`). The host holds the provider's key and caches
    the tiles; a tab never calls a map provider itself.
11. **Never:** a tab doesn't start processes, open network listeners, embed web views, add sign-in or admin routes,
    or touch files outside the project's files.

Two gotchas: JSX text doesn't process `\u00b7`-style escapes (write the character), and the TypeScript lib has no
`Array.prototype.at`.

## Checking a tab

- `npx tsc --noEmit -p .` and `npx vite build` for the panel.
- `cargo test -p ganban-server tabs::` for the server side, with your own test in `tabs.rs`.
- Look at it on a throwaway host: `scripts/qa-host.sh <port>` ([TESTING.md § QA host](TESTING.md#qa-host)).
- Disable the tab's feature (`cargo build -p ganban-server --no-default-features --features tab-nato`, say) and
  check that the server still builds without it.

**Planned, not built:** a scaffold command that generates a new tab, and a conformance suite that checks every tab
against the rules above (tools refuse when disabled, writes are proposals, reads stay in the project, no raw `fetch`
or HTML5 drag and drop in panels). Until they exist, the tests in `tabs.rs` and review do that job.

## Review checklist

- Does the tab reuse what exists (tab state, scores, config, the tool gate, `ScrollArea`, the Gilt classes) instead
  of building its own?
- Does it work on a phone and in a browser? If something is desktop-only, is that deliberate and stated?
- Do its settings respect "project config first, user state fills in"?
- Can the user see where external content came from, and when?

## Not built: tabs you install without rebuilding

Every tab is compiled in, and code loaded at run time with the app's full trust is ruled out. If installable tabs
ever ship, they will run in a sandboxed iframe, with only the capabilities the host's owner granted, enforced by the
host.
