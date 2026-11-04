# Testing Ganban

Ganban has no test framework on the web side. Each suite bundles the real source with esbuild and checks it with
`node:assert`. The Rust side uses `cargo test`. CI (`.github/workflows/ci.yml`) runs the node suites,
`cargo test` for `ganban-core` and `ganban-server`, and a check of the desktop shell on every push and pull request.

Before you commit, run at least:

```bash
npx tsc --noEmit -p .
npx vite build
cargo test -p ganban-core -p ganban-server    # when you touched Rust
npm run test:<the suites for what you touched>
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
| `npm run test:taskform` | The task editor's form: what counts as an edit, what a save sends, and the saved copies that keep an edit made on close from showing (and being re-saved) as the old text. |
| `npm run test:update` | The version compare behind the host-served update check. |
| `npm run test:apkupdate` | The phone app's self-update decisions. |
| `npm run test:ops` | The host service scripts in `ops/` (install, backup, update), in a sandbox with fake system tools. They target macOS and launchd, so run this suite on a Mac. |
| `npm run test:doclinks` | Every link and `docs/…` path in the repo's Markdown, comments and scripts resolves. |

Three suites have no npm script yet; run them with node:

```bash
node scripts/test-statusfilter.mjs   # the multi-choice status filter
node scripts/test-workspaces.mjs     # the workspace migration logic
node scripts/test-invite.mjs         # invite and pairing payloads
```

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
