# Working in this repo (agents)

Ganban is a local-first task and project manager with an optional local AI assistant. One Rust server
(`crates/server`, over the domain logic in `crates/core`) runs inside the desktop app (Tauri, `src-tauri`) or on its
own as `ganban-server`, and serves the React UI (`src/`) to the desktop, browsers and phones. Data is one SQLite
file. Read `GLOSSARY.md` before naming a new concept; `docs/README.md` maps the docs.

## Verify

Run what covers your change before you call it done:

- `npx tsc --noEmit -p .` and `npx vite build`: always.
- `cargo test -p ganban-core -p ganban-server`: when you touched Rust. `cargo check -p gansty` when you touched
  `src-tauri`. Prefix cargo with `nice -n 10`.
- The `npm run test:*` suite for the code you touched, and `npm run test:doclinks` when you touched docs.
  `docs/dev/TESTING.md` lists every suite.

Add tests next to the code you change: a pure module gets a `scripts/test-<name>.mjs`, a host rule gets a Rust test
beside its command.

## Rules of the code

- **Host commands** live in one command table (`crates/server/src/commands/`), and every command declares its access
  rule; one without is refused (`docs/design/adr/0001-one-command-table.md`). Add a client operation there, not as a
  new route or Tauri command; the ADR names the few exceptions.
- **Task visibility** is enforced on the host: a task outside the reader's audience is absent from every result
  (`docs/design/adr/0002-task-visibility.md`). Any new path that returns task data filters through it.
- **Assistant tools:** reads stay in the chat's project, and writes are proposals the user approves. Read
  `docs/design/SECURITY_MODEL.md` before adding or changing a tool.
- **Look:** `docs/dev/GILT.md`, § How to style a new screen: the `g-…` classes, `<Modal>`, `ResizablePane`, theme
  colours only.
- **Panels:** `docs/dev/TAB_SPEC.md` § Rules for the panel: `ScrollArea`, `confirmDialog`, `localStorage` only for
  cosmetic preferences, keys stay on the host.
- **A new tab:** follow `docs/dev/TAB_TUTORIAL.md`; `docs/dev/TAB_SPEC.md` is the reference.

## Data and QA

- Work on throwaway data. Never open, copy or query a real `gansty.db` (the app's database in its data folder).
  Debug from code and logs, and reproduce on a test database.
- Look at UI changes on a throwaway host: `scripts/qa-host.sh <port>` (`docs/dev/TESTING.md` § QA host). It serves
  your build on a seeded copy under `/tmp`.

## Commits

Conventional commits: `feat(scope): …`, `fix(…)`, `perf(…)`, `docs(…)`, `test(…)`, `chore(…)`. Keep the subject
readable and say why in the body. Split unrelated changes into separate commits.

If `../Ganban-internal/AGENTS.md` exists, read it too: it holds the maintainer's own rules.
