# Protocols — the repeatability artifact (design)

**Status: DESIGN — decisions recorded 2026-07-02, ready to build.** Realizes the protocol index on top of the
frozen v1 contract (`Protocol { runner, profile_id, model }` in `ai_routing` JSON,
`docs/design/PI_INTEGRATION_DESIGN.md`). This doc is the promotion plan: from routing config to a
first-class, versioned, reviewable artifact. Written 2026-07-02.

## Vocabulary (the four concepts a user ever holds)

- **Personality** — *who*. A `model_profiles` row: name, prompt, avatar, engine binding.
- **Loadout** — *what they can do*. A bundle of vetted tools (`docs/design/ToolRegistry.md`).
- **Protocol** — *how a specific job is done*, repeatably. This doc.
- **Engine** — *where the thinking happens*: this machine (Ollama), a remote box
  (per-profile endpoint), or pi (paid, user's own keys). Surfaced as engine cards, never as
  feature lists.

## 0. The load-bearing invariant

A protocol has two natures, and only one of them is trusted:

- **The enforced part (frontmatter):** task class, trigger, engine, tool allowlist,
  loadout, budget, sandbox profile, inputs, limits. Schema-validated, typed, executed
  *by the system*.
- **The advisory part (body):** the briefing the model reads — the procedure in prose.

**A protocol's guarantees come only from the enforced part. The prose steers; the
frontmatter binds.** If a protocol's safety depends on the model obeying the briefing, it
is not a protocol, it is a hope. Nothing in the body can widen capability, name a tool the
frontmatter didn't grant, raise a budget, or touch a path the sandbox denies.

## 1. Format: Markdown + YAML frontmatter — but the file is not the UI

On disk / in transit a protocol is one `.md` file: YAML frontmatter (enforced) + Markdown
body (advisory). It diffs in git, reads as a document, and matches the format the
coding-agent ecosystem already converges on — savvy users and their agents author it
natively.

**The canonical store is the database, not the file.** The file is the
import/export/interchange format. Import re-validates through the same schema as the
builder UI — there is no path where hand-written YAML skips validation. Validation
**rejects, never coerces** (webhook doctrine applies): unknown fields, unknown tools,
out-of-range budgets → refused with a reason, not silently dropped.

### Frontmatter schema (v1)

```yaml
protocol: 1                        # format version (of this schema, not the protocol)
name: "Summarize new PDFs into a comment"
slug: summarize-new-pdfs           # stable id; user protocols namespace as user.<slug>
task_class: pdf.summarize          # system classes stay a Rust-reviewed allowlist
                                   # (ROUTING_CLASSES); user protocols use user.* freely

trigger:                           # enforced — how a run starts
  kind: manual | routine | rule    # routine → schedule fields; rule → event + condition
  # schedule: { every: "1d", catch_up: true }        (routine)
  # event: task.created  condition: {...}            (rule; rules-engine condition shape)

engine:                            # enforced — where it runs
  runner: ollama | remote | pi     # Runner enum, extended
  profile: <personality slug>      # resolves model + endpoint
  model: <optional pattern>        # pi model pattern; ignored for ollama/remote

escalation:                        # enforced — the "too hard for free" policy
  allow: none | ask | auto
  runner: pi
  budget_cents: 200
  period: month

tools: [get_tasks, search_corpus, read_page]   # enforced allowlist; see invariant 3
loadout: <slug>                    # optional; tools ∩ loadout if both present

inputs:                            # declared, typed parameters — validated at dispatch
  - { name: folder, type: folder_path, required: true }
  - { name: max_pages, type: int, default: 20 }

budget:
  per_run_cents: 10                # paid runners; local runners meter tokens instead
  period_cents: 500
  period: month
  on_exceeded: downgrade | refuse  # downgrade = fall to engine.runner: ollama, RECORDED

sandbox:                           # exec-class task_classes only (python.exec, pi)
  profile: no-net-tempdir          # a named profile from SECURITY_MODEL.md §3 — never inline

env:                               # python.exec only — the nix-shell move
  python: "3.12"
  dependencies: [pandas==2.2.1, openpyxl==3.1.2]
  lock: sha256:…                   # written by the first build; pinned thereafter

limits:
  wall_clock_s: 120
  max_rounds: 8                    # tool-loop cap for this protocol
on_reject: stop | continue        # what a rejected mid-run proposal does (see §6)
```

Body convention: `## Briefing` (what the model is told), optional `## Acceptance`
(what a good result looks like — advisory, shown to the human at review/dry-run, useful
to R.4 demonstration synthesis).

## 2. Storage & versioning — the pinning discipline

```
protocols          (id, slug, name, task_class, active_version, created_at, …)
protocol_versions  (id, protocol_id, version, frontmatter_json, briefing_md,
                    content_hash, status: draft|dryrun|approved|retired,
                    created_by, created_at)
```

- **Versions are immutable.** Editing creates version N+1 as `draft`. Rollback is moving
  `active_version`. Nothing is ever edited in place.
- **Every run records provenance in the ledger**: `protocol_slug`, `protocol_version`,
  `content_hash` (+ the existing model/tokens/duration columns) on `agent_actions`.
  This is the lockfile property: "what exactly produced this result" is answerable
  forever. Ledger columns land in the same migration as the tables — retrofitting
  provenance is miserable; we don't.
- v1 `ai_routing` entries migrate as version-1 protocols with `trigger: manual` and the
  legacy `{runner, profile_id, model}` mapped into `engine`. `resolve_task_params`
  reads through the new table; the frozen contract holds.

## 3. Activation is a gate, not a save

```
draft ──(dry-run: R.2 harness)──► dryrun ──(owner/author approves)──► approved/active
```

- Any protocol with a **non-manual trigger** MUST pass a dry-run before activation.
  Manual protocols may activate directly (the human is the trigger and the reviewer).
- **Dry-run semantics:** execute against fixtures or a replay window of real project
  data with the gate in preview mode — collect the proposals that *would* have fired,
  the tools that *would* have been called, and the estimated token/cost burn. Nothing
  applies. The result renders as: *"Last week, this protocol would have: commented on 3
  tasks, flagged 1 event, spent ~£0.04."*
- That preview **is the trust feature** for non-technical users — worth more than any
  sandboxing prose — and it is the same harness QC needs. Build R.2 before R.3 (the
  library): a shelf of unreviewable protocols is a liability.

## 4. Four doors into one artifact

1. **Gallery** (R.3) — pre-built protocols as cards with plain-language names. Install →
   answer 2–3 typed questions (the `inputs` declarations ARE the install wizard) →
   dry-run preview → active. The no-code surface; the future community-sharing surface.
2. **Builder** — a form generated from the frontmatter schema: trigger dropdown, tool
   checkboxes drawn from the vetted registry (a user can only tick what is already
   safe — the registry seam does the security work), budget slider, one big text box
   for the briefing. YAML never appears.
3. **Text view** — the same protocol as its `.md`, for git, sharing, and power users.
   Import/export round-trips; import re-validates (§1).
4. **Demonstration** (R.4, the long pole) — record → synthesized protocol *draft* →
   review in the builder. Demonstration authors drafts, never active protocols.
   Full design: `docs/design/DEMONSTRATION.md` (capture, locator bundles, the `web:`
   frontmatter extension, sessions, self-heal-as-version-proposal).

## 5. Environments — nix-shell semantics without the Nix dependency

For `python.exec` protocols, the `env` block is realized in two phases:

- **Build (network ON):** `uv` resolves `dependencies` against a lockfile; the resulting
  env is cached, **content-addressed by the lock hash**. Same lock → same env, byte for
  byte, forever. First build writes `lock:` back into the draft.
- **Execute (network OFF):** the run gets the cached env inside its sandbox profile with
  **no egress**. Install-time and run-time never coexist — this closes the exfiltration
  hole and the supply-chain hole in one move (SECURITY_MODEL.md §2).

Nix itself is explicitly **not** a dependency: this buys ~90% of the reproducibility with
zero onboarding cliff. Written down so it's a decision, not an omission.

## 6. Workflows (the composition layer — designed here, built later)

A workflow is an ordered list of steps, each `{task_class → protocol, input_mapping,
on_reject}`. The one hard design decision, made now:

**A gated write mid-workflow SUSPENDS the run.** The step's proposal parks the run in
`waiting_approval`; approval resumes it; rejection takes the step's declared `on_reject`
(stop, or continue past). Workflows never bypass the gate, and therefore workflow run
state MUST be durable:

```
workflow_runs      (id, workflow_id, version, status: running|waiting_approval|done|failed, …)
workflow_step_runs (id, run_id, step, status, agent_action_id, …)
```

One `record_agent_action` row per step (the budget meter covers multi-step cost for
free) plus a summarizing run row. The moment a step's side effect lives outside our
database (a booking through an outside service, for example), the **idempotency key** becomes mandatory — it
lands with the runs tables, not with the booking tab.

## Invariants

1. Guarantees come only from the frontmatter; the briefing can never widen capability.
2. Versions are immutable; every run is ledgered with `slug + version + content_hash`.
3. A protocol's effective tool set is `frontmatter.tools ∩ loadout ∩ what the executing
   user may hold`. **Owner-only bindings (`mcp`/`http`/`fetch`) stay owner-only even if
   a protocol names them** — a member installing an owner's protocol gets a validation
   error, not a privilege.
4. No secrets in protocol files, ever. Tools may reference secret *names*; values live
   in `connector_secrets`, host-only, never exported with a protocol.
5. Import validation rejects, never coerces.
6. Non-manual triggers require a passed dry-run before activation.
7. A task never inherits a wider toolset, budget, or sandbox than its protocol declares
   (carried forward verbatim from PI_INTEGRATION_DESIGN §7).
8. Budget downgrades are recorded in the run's ledger row — which tier produced an
   output is always answerable.

## Not in scope (v1)

Multi-step workflow *builder* UI (schema + runner first, single-step protocols prove the
artifact); protocol marketplace/signing (R.3+, needs the OSS trust story); per-protocol
custom binding kinds (never — the registry seam holds); demonstration capture (R.4).

## Decisions (recorded 2026-07-02)

1. **Budget units: two honest columns** — cents for paid runners, tokens for local. No
   synthetic "work unit": an invented currency hides cost instead of stating it, and
   the ledger already speaks both languages.
2. **`user.*` task classes appear in the routing UI**, sectioned separately from system
   classes. System classes remain a Rust-reviewed allowlist; user classes are
   freeform-namespaced and cannot shadow a system class.
3. **Dry-run inputs: both.** Fixtures for authoring/tests, plus opt-in replay over real
   project data (read-only, gate in preview). Real-data replay is the convincing one
   and is what the gallery's install wizard runs by default.
4. **Authoring: members draft, owner activates** — mirrors the gate's shape. Activation
   staying with the owner is what makes the gallery safe to open to a whole team.
