# Testing Ganban

Ganban has no test framework on the web side. Each suite bundles the real source with esbuild and checks it with
`node:assert`. The Rust side uses `cargo test`. CI (`.github/workflows/ci.yml`) runs the node suites,
`cargo test` for `ganban-core` and `ganban-server`, and a check of the desktop shell on every push and pull request.

Before you commit, run at least:

```bash
npx tsc --noEmit -p .
npx vite build
cargo fmt --all                               # when you touched Rust (CI checks it)
cargo test -p ganban-core -p ganban-server    # when you touched Rust
npm run test:<the suites for what you touched>   # or test:all for every suite
npm run test:doclinks                         # when you touched docs
```

## The node suites

None needs a running server, a browser or network access.

| Command | What it checks |
|---|---|
| `npm run test:reports` | The report engine and its exports, invite parsing, quiz grading. It also checks the XLSX and PDF bytes with outside readers (`openpyxl` through `uv`, poppler's `pdftotext`) and says SKIP when they're missing. |
| `npm run test:listedit` | List editing in comment fields: Tab, Shift+Tab and Enter. |
| `npm run test:composer` | The comment composer's field height and the tag picker's "Create task" row. |
| `npm run test:pins` | Pinned tabs: merging across workspaces, order, moves and the top bar's fit. |
| `npm run test:nav` | Back and forward history, its shortcuts and its limits. |
| `npm run test:recur` | The repeat-rule (RRULE) expander behind recurring events. |
| `npm run test:atlasfiles` | Atlas › Files' listing: which files show, and which are marked as stored only on this device. |
| `npm run test:filelocation` | "Show in folder": when it's offered for a file, and opening the host copy when the file isn't on this machine. |
| `npm run test:hosterror` | Host error codes: the client matches a refusal by its code (`AI_FILE_TOO_LARGE`), over HTTP and in local mode. |
| `npm run test:taskform` | The task editor's form: what counts as an edit, what a save sends, and the saved copies that keep an edit made on close from showing (and being re-saved) as the old text. |
| `npm run test:taskconflict` | A task save that finds the task changed elsewhere: when it saves again by itself (the edits touch different fields), when it asks, what a resave sends, and the draft kept on the device. |
| `npm run test:inflight` | The editors' in-flight saves: a save still on its way when the page goes is sent again (as keepalive), once, and only until it lands. |
| `npm run test:timerday` | The timer pill's "today": local midnight, and the running entry counted from it. |
| `npm run test:agentwork` | The timer's "Agents": every workspace's live agent work merged into one row per task. |
| `npm run test:finmoney` | Finance money: minor units to display and back in several locales, split checks, debits and credits. |
| `npm run test:finreports` | Finance reports: months and periods, statement rows with subtotals and comparatives, net worth, budget progress, the forecast band's scale and a statement's PDF. |
| `npm run test:fincash` | Finance quick-add of a cash expense: which cash account it posts to and the balanced entry it makes. |
| `npm run test:finimport` | Finance import job progress: how full the bar is through the stages, and the stage labels. |
| `npm run test:finreset` | Deleting all finance data: the confirmation's list, the typed word that enables it, and the progress bar. |
| `npm run test:fininbox` | Finance inbox at scale: what "Select all" covers, the bulk confirm texts with their counts, group date ranges and the suggestion job's progress line. |
| `npm run test:finpairs` | Finance transfer review: which waiting pairs "all like this" and "all at ≥ N%" take. |
| `npm run test:pdfsections` | PDF Studio's section kinds (front matter, chapters, back matter) and the chapter numbering in extracted file names. |
| `npm run test:cadence` | An automation's schedule: interval, daily and weekly (`Mon,Thu 09:00`), read and written as the host parses them. |
| `npm run test:update` | The desktop updater: the version compare, the state machine and its driver (a check never downloads; Later and Skip), and that nothing else calls the download. |
| `npm run test:patchnotes` | Patch notes: the parser on the real `CHANGELOG.md` and on odd input, which entries are new, a release's and a host build's notes, and `scripts/patch-notes.mjs`. |
| `npm run test:apkupdate` | The phone app's self-update decisions. |
| `npm run test:appimage` | `scripts/appimage-system-graphics.sh`: the AppImage loses its bundled graphics libraries and its forced X11 backend, and keeps the rest ([LINUX_PACKAGING.md](LINUX_PACKAGING.md)). |
| `npm run test:updatesource` | The update source: the choice, the desktop's host key pin, the phone's certificate match, and the Android version codes (against `ops/version-code.mjs`). |
| `npm run test:ops` | The host service scripts in `ops/` (install, backup, update), in a sandbox with fake system tools. They target macOS and launchd, so run this suite on a Mac. |
| `npm run test:doclinks` | Every link and `docs/…` path in the repo's Markdown, comments and scripts resolves. |
| `npm run test:statusfilter` | The multi-choice status filter. |
| `npm run test:workspaces` | The workspace migration logic. |
| `npm run test:invite` | Invite and pairing payloads. |
| `npm run test:insertcaret` | Inserting a pasted image or a `/file` link at the description's caret. |
| `npm run test:railswitches` | A Plug-ins switch flipped while the switches reload keeps its new value. |

`npm run test:all` runs every `test:*` suite in turn, as CI does, and reports each one. It skips `test:ops` (a Mac's
host scripts; CI's macos job runs it). A new `scripts/test-<name>.mjs` needs a `test:<name>` script: `test:all` and CI
pick it up, and `test:all` fails if it's missing.

The suites test the `*.pure.ts` modules and other code with no React or browser dependencies. To make new logic
testable, put it in such a module and add a `scripts/test-<name>.mjs` modelled on `scripts/test-nav.mjs`.

## The Rust tests

```bash
cargo test -p ganban-core       # the data model, migrations, business rules
cargo test -p ganban-server     # the HTTP layer, the command table, the assistant's tool gate, the tabs
cargo test --workspace          # all of it, including the desktop shell
```

- The tests make their own databases in the system temp folder. They never open your data.
- `cargo test --workspace` builds the desktop shell (`gansty`), which needs the desktop prerequisites
  ([BUILDING.md](BUILDING.md#prerequisites)). On Linux without them, test the two crates above, and check the shell
  with `cargo check -p gansty` on a machine that has them.
- On a busy machine, `nice -n 10 cargo test …` keeps your desktop responsive.
- A tab's server tests live in `crates/server/src/tabs.rs` ([TAB_SPEC.md § Checking a tab](TAB_SPEC.md#checking-a-tab)).
  A rule about who may see or do what belongs next to the command it guards.

## QA host

To look at your changes in a browser, run a throwaway host: your build, on a copy of a seeded database, on a port of
your choice.

```bash
scripts/qa-host.sh 8823            # then open http://127.0.0.1:8823/
scripts/qa-host.sh 8823 --build    # rebuild the server and dist/ first
```

What it does:

1. Builds what's missing: `target/debug/ganban-server` and `dist/`. With `--build` it rebuilds both, so the host runs
   your latest code. Without it, an existing build is used as it is.
2. Seeds `/tmp/gilt-qa/seed.db` with `scripts/gilt-qa-seed.mjs` the first time. The seed is fictional: 5 projects,
   about 40 tasks across every status and priority, comments, events and contacts. Its dates are relative to the
   day you seed, so delete the folder to get a fresh week.
3. Copies the seed to `/tmp/ganban-qa-<port>/` and serves it on `127.0.0.1:<port>`. Every run starts from a clean copy.

Good to know:

- A browser on the same machine counts as the host's **owner**: the account that set up the host and may do
  everything. So there's no sign-in.
- It refuses a port something already answers on. Several hosts can run side by side on different ports.
- Run it in its own terminal; Ctrl-C stops it.
- `GILT_QA_DIR=/tmp/<folder>` keeps a separate seed (the folder must sit directly under `/tmp`). The seed script
  starts its own short-lived host on port 8799; set `GILT_SEED_PORT` if that's taken.
- It only touches files under `/tmp`. Never point a test host at a real `gansty.db`: debug from logs and code, and
  reproduce on a throwaway database.

For screenshots (themes, sizes, what to look at), see [GILT.md § Looking at your screens](GILT.md#looking-at-your-screens-qa).

## Smoke run

The suites above test logic; the smoke run opens the app. `scripts/qa-smoke.mjs` starts a QA host, drives a headless
browser through the paths the owner uses every day and reports each one. Run it when your change shows on screen,
and before a release.

```bash
cargo build -p ganban-server && npx vite build   # it serves your build, and never builds
npm run qa:smoke                                 # a host of its own on port 8814, then every path
npm run qa:smoke -- --only filter                # one path (repeat --only, or name several: a,b)
npm run qa:smoke -- --full                       # adds finance-large, a 6,000-line import
npm run qa:smoke -- --url http://127.0.0.1:8823  # a QA host you already run
npm run qa:smoke -- --port 8830 --headed         # another port, and a visible window
npm run qa:smoke -- --list                       # the paths
```

It prints one line per path, `ok` or `FAILED` with the seconds it took, then a summary, and exits 1 if any path
failed. A path fails on a wrong result, a console error, a page error or a React key warning (React logs that one
only in a development build), and is called hung after two minutes. A failed path leaves a screenshot and its
console in `/tmp/ganban-smoke/<run>/`, and the run goes on.

The paths, at 1440×900 unless said, on the QA seed:

| Path | What it checks |
|---|---|
| `load` | The app opens and Home shows the seeded projects. |
| `task-create` | A new task appears in its project's list. |
| `task-autosave` | A title and description edit survives switching to another task and a reload. |
| `task-fields` | Status, priority and deadline set in the detail pane show on the task's row in the list. |
| `comment` | A comment is added and shows below the description. |
| `file-link` | A file uploaded to a task: `/file` lists it, and picking it puts a link at the caret. |
| `paste-image` | A PNG pasted with the caret mid-text: the image's markdown lands at the caret. |
| `filter` | Two statuses in Filter & sort narrow the list; the popover stays inside the window at list widths 300 and 220. |
| `event` | A new event shows on its day in the month. |
| `finance-import` | Finance switched on in Settings › Plug-ins; a 300-line statement of the last 90 days imported through the column-mapping wizard; the To sort count; one payee sorted By payee, which leaves To sort and shows its "from now on" toast with Undo; one line filed from the Lines view; an overlapping file reports its duplicates and files the sorted payee's new lines; that number opens them; Payees & rules lists the payee with its category. |
| `finance-large` | `--full` only: 6,000 lines import in under 60 s with old lines kept in To sort, and To sort opens in under 2 s. |
| `patch-notes` | Settings › Updates › Patch notes marks this version and opens up to every version; the update offer (focus on Later), its downloaded step (focus on Later) and "What's new" previews open their notes and close (§ Previews of the update screens). |
| `narrow` | At 800×900 no two items of the top bar overlap. |
| `phone` | At 390×844 as a phone: Home loads, a task opens, Finance opens. |

How it runs:

- **Host.** It runs `scripts/qa-host.sh <port>` on a fresh seed in `/tmp/ganban-smoke-seed-<port>/`, so every run
  starts from the same fictional data. The statements it imports are generated, with made-up payees. Nothing it
  does touches a real `gansty.db`.
- **Browser.** `SMOKE_BROWSER` if set, else the first of Brave, Chrome and Chromium at their usual places on macOS
  and Linux, driven through `puppeteer-core` (no browser download). Only one browser runs at a time on a shared
  machine: it takes the lock folder `/tmp/gilt-qa.lock` and waits while another run holds it. It takes over a lock
  that a smoke run killed outright left behind, never one taken by hand. `--browser-url` drives a browser you started
  yourself (you hold the lock then).
- **Your own host.** `--url` writes test tasks, events and Finance data into the host it's given, so give it a QA
  host only. It refuses the usual ports of a real one (8765, 8770).
- **Clean-up.** On every exit, Ctrl-C included, it stops the host and the browser, and deletes the browser's profile,
  the host's data and the lock.

### Previews of the update screens

A QA host has no updater, so two URL parameters show the update screens with sample data and call nothing:

- `/?preview=update-offer`: the desktop's top-bar offer, "Ganban 9.9.9 is available", whose dialog shows the patch
  notes a host build of your checkout would carry. Its buttons only close it. `/?preview=update-ready` shows its
  downloaded step (Restart to finish, Later). Both open with the focus on Later.
- `/?preview=whats-new`: the "What's new" notice, with this build's own release marked New. Closing it records
  nothing.

The phone's offer has its stub already: `/?mobile=1&apkstub=1` (`src/lib/apkUpdate.ts`), with **See what
changed** in the banner. The browser's "A newer Ganban is on the host" shows when the served `build.json` differs from the
page's build: rebuild while a tab is open.

To add a path, add a function to `PATHS` in `scripts/qa-smoke.mjs`. Its name is the path's name, and its comment
says what it checks. It gets a page at 1440×900 in a browser context of its own (no storage carries over from the
path before), starts from `openHome(ctx)` or `openProjectTasks(ctx, name)`,
and fails with `expect(cond, message)` or `until(fn, message)`, saying what the owner would have seen. Find elements
the way a person does: `byRole(page, 'button', 'Save changes')`, `byLabel(page, 'Status')`, `byText(page, …)`.
Add a `data-testid` only when nothing visible names the element. Make the data a path needs inside the path, with
`ctx.stamp` in its names, so paths don't depend on each other or on the order they run in; read only what the seed
makes (`scripts/gilt-qa-seed.mjs`). Add a row to the table above.
