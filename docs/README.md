# docs/: map

Ganban's documentation, grouped by who it's for. New here? Start with the [README](../README.md). Terms are in
[`GLOSSARY.md`](../GLOSSARY.md).

## Users: `user/`

| Doc | Contents |
|---|---|
| [GETTING_STARTED.md](user/GETTING_STARTED.md) | Install, the first run, where your data lives on each system, and a first project and task. |
| [FAQ.md](user/FAQ.md) | Short answers to the common questions, each with a screenshot. |
| [PHONES_AND_PAIRING.md](user/PHONES_AND_PAIRING.md) | Pairing a phone with your host and using Ganban from it. |
| [SHARING.md](user/SHARING.md) | Share links: sending a task's or a project's files to someone who doesn't use Ganban. |
| [UPDATES_AND_BACKUPS.md](user/UPDATES_AND_BACKUPS.md) | How in-app updates look, and how to back up and restore your data. |
| [TROUBLESHOOTING.md](user/TROUBLESHOOTING.md) | Fixes for problems you hit in the app. Host problems are in SELF_HOSTING. |

## Hosts: `host/`

| Doc | Contents |
|---|---|
| [SELF_HOSTING.md](host/SELF_HOSTING.md) | Running the headless host on macOS or Linux and connecting laptops and phones: install, updates, share links, backups. |
| [ENV_REFERENCE.md](host/ENV_REFERENCE.md) | Every environment variable the host reads, with its default. |
| [BUNDLING.md](host/BUNDLING.md) | Building and packaging, including the optional document engine (ragrat). |

## Contributors: `dev/`

| Doc | Contents |
|---|---|
| [BUILDING.md](dev/BUILDING.md) | Prerequisites, the desktop app in development, the server, Android and release builds. |
| [TESTING.md](dev/TESTING.md) | Every test suite (`npm run test:*`, `cargo test`) and the throwaway QA host. |
| [TAB_SPEC.md](dev/TAB_SPEC.md) | What a tab is made of, and what it must do to ship. |
| [TAB_TUTORIAL.md](dev/TAB_TUTORIAL.md) | Build a "Hello" tab step by step, then give it a tool the assistant can call. |
| [GILT.md](dev/GILT.md) | The style guide: the `g-…` classes, `Modal`, `ResizablePane`, how to style a new screen, and QA screenshots. |

`npm run test:doclinks` checks the links in these docs.

## Design: `design/`

| Doc | Contents |
|---|---|
| [Architecture.md](design/Architecture.md) | System overview: crates, server, clients, trust zones, the write gate, the routing funnel. |
| [SYNC.md](design/SYNC.md) | The split between the host and its thin clients. |
| [SECURITY_MODEL.md](design/SECURITY_MODEL.md) | The trust model: gate tests, sandbox posture, untrusted content. |
| [PROTOCOLS.md](design/PROTOCOLS.md) | The protocol artifact: enforced frontmatter, immutable versions, the one activation gate. |
| [DELEGATE.md](design/DELEGATE.md) | Agent-to-agent delegation: it narrows permissions, never widens them. |
| [MEMBER_AGENTS.md](design/MEMBER_AGENTS.md) | The machine boundary: agents never cross it; tasks and proposals do. |
| [DEMONSTRATION.md](design/DEMONSTRATION.md) | Authoring protocols by showing: recorder, locators, replay. |
| [ToolRegistry.md](design/ToolRegistry.md) | Declarative tool bindings and loadouts, with the model as the fallback. |
| [PI_INTEGRATION_DESIGN.md](design/PI_INTEGRATION_DESIGN.md) | The pi runner: RPC, sandboxing, the cost ledger. |
| [FINANCE.md](design/FINANCE.md) | Finance: the personal double-entry ledger, its tables, commands and import pipeline. |
| [SHARE_LINKS.md](design/SHARE_LINKS.md) | Share links: files for people outside the team, and the commands behind them. |
| [UPDATES.md](design/UPDATES.md) | Clients update from the host: versions, builds and the update flow. |
| [CommentBoard.md](design/CommentBoard.md) | The project's Comments board: one update tagged on several tasks. |
| [CollaborativeProjects.md](design/CollaborativeProjects.md) | Workspaces: joining someone else's project. |
| [TailscaleAutoShare.md](design/TailscaleAutoShare.md) | Invites that attach a Tailscale device share automatically. |

### Decision records: `design/adr/`

| ADR | Decision |
|---|---|
| [0001](design/adr/0001-one-command-table.md) | One command table; the desktop runs it in-process; no access rule means denied. |
| [0002](design/adr/0002-task-visibility.md) | Task visibility is enforced on the host; a hidden task is absent; areas are the lever. |
| [0006](design/adr/0006-share-links-go-public-through-a-separate-door.md) | Share links go public through a separate door, published with Tailscale Funnel. |
| [0007](design/adr/0007-clients-update-from-the-host.md) | Clients update from the host, which builds and signs them. |
| [0009](design/adr/0009-finance-is-private-to-its-user.md) | Finance is private to its user; the owner bypass stops at Finance. |
| [0010](design/adr/0010-the-double-entry-ledger.md) | A double-entry ledger: source lines apart from journal entries; edit until close, then reverse. |

### Diagrams and mockups

| File | Contents |
|---|---|
| [domain_core_class_diagram.md](design/diagrams/domain_core_class_diagram.md) | The agent core: how a model proposes, a person decides, and every applied change is recorded. |
| [knowledge_model_class_diagram.md](design/diagrams/knowledge_model_class_diagram.md) | The Atlas layer: documents, chunks, domains and tags. |
| [tool_call_lifecycle.svg](design/diagrams/tool_call_lifecycle.svg) | A tool call from proposal to ledger (embedded in Architecture). |
| [leonidas_funnel.svg](design/diagrams/leonidas_funnel.svg) | The routing funnel (embedded in Architecture). |
| [`mockups/`](design/mockups/) | HTML mockups for Oracle: node types, notebook import, Python nodes and workflows. |

## Images: `img/`

Screenshots for the docs: `hero.png` (the README), and the user guide's shots in `faq/` and `user/`.

## Elsewhere in the repo

| Doc | Contents |
|---|---|
| [GLOSSARY.md](../GLOSSARY.md) | Ganban's terms: commands, task visibility, pinned tabs, Gilt, share links and more. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to propose a change. |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability. |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release. |
| [AGENTS.md](../AGENTS.md) | Instructions for coding agents working in this repo. |
| [`src/docs/`](../src/docs/) | The help pages built into the app. |

## Conventions

- Design docs carry a **Status** line (DESIGN, BUILT or SHIPPED, with a date) at the top.
- A decision goes in the doc that owns it, or in an ADR when it's hard to reverse.
