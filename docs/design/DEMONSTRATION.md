# Demonstration — authoring protocols by showing, not wiring (design)

**Status: PHASE A BUILT 2026-07-02** (capture + recorder, typed narration, synthesizer, attended replay, drafts into the gate; B–D remain — see §9). Realizes the Oracle
north star (the Oracle mockups' click-authored locator: *replays deterministically,
self-heals via LLM only on a miss*). Companion to `docs/design/PROTOCOLS.md` — demonstration is
the **fourth authoring door** into the same artifact, not a new artifact type.

## 0. Load-bearing facts

- A demonstration produces a **protocol draft**: deterministic steps land in the
  enforced frontmatter, the narration becomes the briefing. The entire existing
  lifecycle — dry-run, activation gate, immutable versions, ledger provenance — applies
  unchanged. Nothing here invents a second execution or approval path.
- **Replay executes the protocol's steps, never the page's suggestions.** The action
  list is frozen at approval time. A hostile page can lie in its *content* (which
  arrives as untrusted text, standard treatment) but cannot add, reorder, or widen
  actions. This is why demonstration replay is categorically safer than a free-browsing
  agent, and why we build the former and not the latter.
- The model is the **fallback, not the per-run engine** (ToolRegistry §6 doctrine).
  Per-run cost is CPU + one browser page; tokens are spent only on a locator miss.

## 1. The authoring loop

```
open site → do the work while narrating → recorder captures steps
   → synthesizer drafts a protocol → REPLAY IT BACK, ATTENDED, NOW
   → user corrects/accepts → draft enters the normal gate (dry-run → activate)
```

**The demonstration is not done until it replays successfully while the user watches.**
The attended replay is part of authoring, not a later phase: it catches dynamic
content, consent banners, login walls, and engine mismatch at the desk instead of at
3 a.m. on run 40. It is also the trust moment for a non-technical user — she watches
the ghost do what she just did, and either nods or corrects the narration.

## 2. Capture — a desktop authoring surface

- **Not an iframe.** Most sites send `X-Frame-Options` / CSP `frame-ancestors` and
  refuse to render inside the React app. Capture opens a separate **Tauri
  WebviewWindow** at the URL with an injected recorder (Tauri 2 initialization script).
- **Desktop-only, and that's correct** — authoring is attended by nature. The parked
  "desktop-wide recording" stays parked: we record inside one browser window Ganban
  opened, nothing else, with a visible recording indicator and a hard stop button.
- **Narration** rides the existing `transcribe` path ,
  timestamp-aligned to steps. Narration is advisory — it can steer synthesis and become
  the briefing; it can never place anything in the enforced frontmatter except by way
  of the synthesizer *proposing* typed fields the human reviews.
- The recorder captures **semantic steps, never pixels or raw event streams**.

## 3. Steps & the locator bundle (the recorder's output)

```yaml
steps:
  - { op: navigate, url: "https://www.balticexchange.com/…" }
  - { op: wait_for, locator: L1, timeout_ms: 8000 }
  - { op: click,    locator: L2 }
  - { op: input,    locator: L3, value: "{input:vessel_class}" }   # lifted, see §5
  - { op: extract,  locator: L4, as: index_value, type: number }
  - { op: extract,  locator: L5, as: as_of_date,  type: date }
```

Each locator is a **redundant bundle**, recorded at click time and tried **in order,
deterministically** at replay:

```yaml
L4:
  css: "td.index-value:nth-child(3)"
  text: "BDI"                       # visible text of/near the target
  aria: { role: cell, label: null }
  xpath: "//table[@id='indices']//tr[2]/td[3]"
  neighbor: "Baltic Dry Index"      # text fingerprint of the nearest stable label
```

This is the answer to the hard half (deterministic extraction from a rendered DOM —
the ~31%-recall problem for freestyle agents): the human's click *is* the ground truth,
captured redundantly so ordinary DOM churn doesn't kill it.

## 4. The `web:` frontmatter extension (enforced)

Demonstration protocols carry one new enforced section:

```yaml
task_class: user.web-extract-…      # user-namespaced, like any user protocol
web:
  domains: [balticexchange.com]     # DERIVED FROM THE DEMO; the egress allowlist
  steps: [...]                      # §3 — executed by the replay engine, not a model
  session: null | <session name>    # §8 — a reference, never a value
  outputs:                          # typed, what extraction must yield
    - { name: index_value, type: number, required: true }
    - { name: as_of_date,  type: date }
heal:                               # §7
  allow: ask | auto | never         # default: auto; forced to ask when session ≠ null
  budget_cents: 20
```

`web.domains` is enforced **at the network layer** by the replay container's egress ACL
(SECURITY_MODEL.md §2), not merely checked in code. A protocol demonstrated on the Baltic
Exchange cannot wander to pastebin, whatever any page says.

## 5. Synthesis — recording → draft

The synthesizer (a routed task class; free tier by default) turns `(steps, narration)`
into a protocol **draft**:

- **Steps → `web.steps`**, verbatim; extractions get names/types inferred from
  narration ("copy the updated figures" → which extracts matter, and the acceptance).
- **Typed values → `inputs:`.** Text the user typed during the demo (a search term, a
  date) is detected and lifted to declared inputs — one demonstration becomes a
  parameterized protocol, not a macro.
- **Narration → `## Briefing`** (for any downstream model step, e.g. "draft a note
  comparing to last week") **and `## Acceptance`** (shown at review and dry-run).
- Output is a **draft**, opened in the builder for review. Demonstration authors
  drafts, never active protocols (PROTOCOLS.md invariant 6 applies: non-manual
  triggers still require a dry-run before activation).

## 6. Replay — attended on desktop, unattended in the sidecar

- **Attended (authoring, Phase A):** replays in the capture window while the user
  watches. Acceptable trust: owner present, desktop-only, nothing scheduled.
- **Unattended (Phase B):** replays in the **render sidecar** (the phase-1 render
  container; scout doctrine). Triangle audit: untrusted content (the web) + egress
  (browsing) → the container holds **zero private data**. Extracted values return to
  Ganban as untrusted content; every downstream write is a proposal; the R.2 dry-run
  ("what would have been extracted/proposed") works with no special cases.
- **Engine mismatch is accepted in v1** (capture in WKWebView, replay in sidecar
  Chromium) and mitigated by §1's mandatory attended replay. If it bites in practice,
  the fix is capturing against a live view streamed *from* the sidecar (CDP screencast
  into a Ganban panel) — unifying engines at the cost of plumbing. Decision deferred
  until the mismatch is observed, not assumed.

## 7. Self-heal — drift meets the gate

On a locator miss (all bundle strategies fail):

1. A **budgeted LLM heal** runs under the protocol's `heal` policy (page snapshot +
   the failed bundle + the step's intent → a candidate locator).
2. **Heal succeeds:** the run completes, **and a proposed version N+1 with the
   corrected locator is filed.** Versions are immutable — self-healing cannot silently
   mutate a protocol; it proposes, a human approves, and the ledger shows exactly when
   the site changed and what adapted. No drift without a fingerprint.
3. **Heal fails:** the run fails loudly with a **screenshot artifact** attached for
   diagnosis. Screenshots are run artifacts, stored locally with the diagnostics
   posture (show-before-share), pruned after 30 days by default (setting).

When a session is attached (§8), `heal.allow` is forced to `ask` — a model does not
get to improvise on a logged-in page without the owner tapping yes.

## 8. Sessions — your logins, your data, your call

The direction: users get freedom over their data, including bringing their own
cookies into the isolated environment for exactly the login-wall case. Design:

**A `web_sessions` registry** — named, domain-bound login sessions, referenced by
protocols the way tools reference `connector_secrets`: **by name, never by value.**

```
web_sessions(name, domains[], created_at, last_used_at, expires_hint)
```

- **Where the cookies actually live: in the sidecar's per-session browser profile,
  and nowhere else.** Ganban's database stores the row above — name, domains,
  timestamps — and **never a cookie value**. Import transits Ganban's memory once,
  forwards to the sidecar profile, and is not persisted. Same posture as connector
  secrets: never returned by any API, never synced, never exported with a protocol.
- **Import paths:**
  - **D1 (v1): paste/import** a `cookies.txt` or JSON export from a browser
    extension. Cookies for domains outside the declared list are **rejected at
    import** (validation rejects, never coerces).
  - **D2 (better): attended login.** The user logs in live inside a streamed view of
    the *sidecar's* browser — the session lands directly in the container profile and
    **never transits Ganban at all**. This is the end state; paste is the bridge.
- **Binding rule (enforced):** a protocol may reference a session only if
  `session.domains ⊆ protocol.web.domains` — validation error otherwise. Browser
  cookie scoping confines transmission to the cookies' own domains; the egress ACL
  confines everything else.
- **Expiry is a first-class failure**, not an error: a run that hits a login wall ends
  in state `session_expired`, which notifies and prompts re-import. **Never
  auto-refresh** — Ganban stores no passwords and refreshes nothing. Re-authenticating
  is always a human act.
- **Revocation UI:** Settings → Web Sessions lists names, domains, created/last-used —
  never values. Delete destroys the sidecar profile. The user can also revoke at the
  source (log the session out from their real browser) and Ganban degrades to
  `session_expired` on the next run.

**Honest triangle note (also recorded in SECURITY_MODEL.md):** an attached session re-adds a
sliver of the private-data leg — *that account's data* is now in the browsing context.
It is confined by three fences: the egress ACL (data can only go back to the site it
belongs to), deterministic replay (§0 — the page cannot add actions), and heal-on-ask
(§7 — no unattended model improvisation on logged-in pages). Stated plainly in the UI
at session-attach time, in the user's language, once.

## 9. Phases (each ships standalone)

| Phase | Ships | Gate |
|---|---|---|
| **A** | Capture window + recorder, narration, synthesizer, **attended** replay, drafts into the existing gate | transcribe path; PROTOCOLS.md schema landed |
| **B** | Sidecar replay + scheduling (unattended), egress ACL from `web.domains`, dry-run integration | render sidecar stood up |
| **C** | Self-heal + version-proposal flow, screenshot artifacts | B; escalation/budget plumbing |
| **D1** | Sessions: registry + paste import, binding rule, expiry state, revocation UI | B |
| **D2** | Attended login via streamed sidecar view (credentials never transit Ganban) | D1 + streamed view |

## Invariants

1. Demonstration produces drafts only; activation goes through the one gate.
2. Replay executes frozen steps; page content is untrusted and can never add, reorder,
   or widen actions.
3. `web.domains` is enforced at the network layer; sessions are domain-bound subsets
   of it.
4. Cookie values never persist in Ganban's database, never return from any API, never
   sync, never export. Names and metadata only.
5. Self-heal proposes version N+1 — no silent locator mutation, ever.
6. Sessions force `heal: ask`. No auto-refresh of any credential.
7. Recording is confined to the capture window, indicated visibly, stoppable
   instantly. Desktop-wide recording remains explicitly out of scope.

## Not in scope

Free-browsing agents (replay is not an agent); password storage or session
auto-refresh; desktop-wide or multi-window recording; captchas/2FA automation (a run
that meets one fails to `session_expired` — the human is the second factor, by
design); mobile capture (mobile stays a thin client).

## Decisions (recorded 2026-07-02)

1. **Sessions ship as D1 paste-import first, D2 attended-login as the end state** —
   user freedom now, best custody model as soon as the streamed view exists.
2. **`heal: auto` default without a session; forced `ask` with one.**
3. **Screenshot artifacts: local, diagnostics posture, 30-day prune (setting).**
4. **Engine unification (capture in the sidecar's browser) is deferred until the
   WKWebView↔Chromium mismatch is actually observed** — the attended-replay
   verification is the guard; don't build plumbing for a hypothesis.
