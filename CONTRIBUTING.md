# Contributing to Ganban

Thanks for helping. This page covers how to build, test and send a change. Ganban is licensed under the
[AGPL-3.0](LICENSE); by sending a change, you agree to license it under the same terms.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Settings → Report a bug collects a
  redacted diagnostics bundle you can attach.
- **Security problems** go through a private advisory instead: see [SECURITY.md](SECURITY.md).
- **Larger changes** (a new feature, a new host command, a change to how data is stored or shared): open an issue
  first so we can agree on the shape before you write it.

## Build and run

[docs/dev/BUILDING.md](docs/dev/BUILDING.md) has the prerequisites and every build. In short:

```bash
npm ci
scripts/qa-host.sh 8823         # a throwaway host on sample data, at http://127.0.0.1:8823/
npm run tauri dev               # the desktop app; it opens the real app data folder (see BUILDING.md)
```

## Test

Run what covers your change ([docs/dev/TESTING.md](docs/dev/TESTING.md) lists every suite):

```bash
npx tsc --noEmit -p .
npx vite build
cargo test -p ganban-core -p ganban-server    # when you touched Rust
npm run test:<suite>                          # for the code you touched
npm run test:doclinks                         # when you touched docs
```

Add a test with your change: a pure TypeScript module gets a `scripts/test-<name>.mjs`, and a host rule gets a Rust
test next to the code it guards. CI runs the same checks on every pull request.

## Where things go

| You're adding | Read first |
|---|---|
| A tab (a panel in a project, optionally with assistant tools) | [TAB_TUTORIAL.md](docs/dev/TAB_TUTORIAL.md), then [TAB_SPEC.md](docs/dev/TAB_SPEC.md) |
| A screen, or a restyle | [GILT.md](docs/dev/GILT.md), § How to style a new screen |
| A command the clients call | [ADR 0001](docs/design/adr/0001-one-command-table.md): one command table, every command with an access rule |
| Anything that returns tasks | [ADR 0002](docs/design/adr/0002-task-visibility.md): task visibility is enforced on the host |
| An assistant tool | [SECURITY_MODEL.md](docs/design/SECURITY_MODEL.md): reads are scoped to the project, writes are proposals the user approves |

The [docs map](docs/README.md) lists the rest, and [GLOSSARY.md](GLOSSARY.md) explains Ganban's terms.

## Commits

Use [conventional commits](https://www.conventionalcommits.org/): `feat(scope): …`, `fix(…)`, `perf(…)`,
`docs(…)`, `test(…)`, `chore(…)`. Keep the subject short and readable, and say *why* in the body. Keep unrelated
changes in separate commits.

## Pull requests

- Branch from `main` and keep the pull request to one change.
- Say what it changes and why, and how you checked it. For UI changes, add screenshots in a dark theme and in
  Catppuccin Latte.
- Make sure CI passes.
- Update the docs your change touches, and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user would notice.
- Use fictional data in screenshots, tests and examples, such as the sample data `scripts/qa-host.sh` serves. Never
  include a real database or real people's data.

## Working with a coding agent

[AGENTS.md](AGENTS.md) holds the instructions for coding agents. Point yours at it; the rules there are the same as
the ones here.
