# Tabs — extending a project

A **tab** is an optional panel you add to a project: a focused surface for a kind
of work the base project view doesn't cover. Enable only the tabs a project
needs, so each project shows just its relevant gear.

There are two kinds:

- **Panel-only** — a UI surface with no agent involvement (a trainer, a viewer).
- **Tool-bundle** — also gives the project's **assistant** new gated tools (it
  can read/act through that tab, always via propose → approve).

## Available tabs

- **Atlas** — the workspace's shared knowledge collections, filtered for this
  project (saved facet filters; browse + search).
- **Email** — linked mail threads for the project; the assistant can read them and
  **draft** replies into your Drafts (Ganban never sends). *Tool-bundle.*
- **PDF Studio** — split, merge, and restructure the project's PDFs; outputs land
  in Project Files (and the knowledge base). *Tool-bundle.*
- **NATO Trainer** — the NATO phonetic alphabet, as a spelling/comprehension game.

(The last one is panel-only — surfaces, not agent tools.)

## Enabling tabs

Today, tabs are turned on **per project** (in the project's settings), so a
shipping project might run Email + PDF + Atlas while a study project runs the
trainers. A tab a project hasn't enabled contributes nothing — no panel, and its
tools aren't offered to that project's assistant.

> **Coming soon (roadmap): tab settings in Settings.** A tab's *configuration*
> will move into **Settings**, so it's set once and applies across your projects
> and devices — truly universal per user, instead of re-configured per project.
> Enablement stays per-project; the *setup* becomes yours, everywhere.

Every tab tool — like every other tool — rides the one gate: reads are scoped to
the project, writes are proposals you approve, and external data a tab pulls is
treated as untrusted.
