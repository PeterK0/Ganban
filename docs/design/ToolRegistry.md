# Tools, the registry & loadouts

*Shipped 2026-06-17. The "give a personality skills, without programming each one"
layer — and the foundation for Oracle's "get data in".*

This is the agent-capability stack: what a model **can do**, how the owner
**adds capability as data** (not Rust), and how a personality **composes** that
capability. Everything here rides the one gate — propose → approve → execute →
ledger — and nothing bypasses it.

## Vocabulary (the distinction that drives the design)

- **Tool** — a single capability primitive: one named operation, typed args, a
  trust class. The unit of *execution*; the thing the gate guards. `get_tasks`,
  `search_corpus`, `web_search`, `web_fetch`.
- **Loadout** — a named bundle assigned to a personality: a *set* of tools + an
  optional system-prompt fragment + an optional routed sub-model. The unit of
  *composition* / identity, not execution. A loadout grants **no new raw power** —
  it only selects and configures already-vetted tools.
- **Personality** (`model_profiles` row) — the character; its loadouts are its
  character sheet.

The point: users get freedom by **composing loadouts from a vetted tool registry**,
never by writing code. "Add a skill" must never become "execute arbitrary code."

## 1. The catalog / inspector

`GET /tools/catalog` (`crates/server/src/lib.rs`) returns a read-only mirror of
exactly what `chat_handler` assembles: every tool (built-in reads, gated writes,
per-tab, and registry tools) with name, JSON-schema, trust class, `source`, and
what must be enabled to see it. The owner also gets the **knowledge engine**
card: ragrat's `/status` (version, mounts, embedder) **and its MCP tools**
(`RagClient::mcp_tools`, via a real MCP/Streamable-HTTP handshake) — so ragrat is
a *visible, brokered provider* under Ganban's roof, not a side door.

UI: **Assistant → Tools** and **Settings → AI → Tools** (`ToolsPanel.tsx`). The
panel header shows the connected host URL + version, so client/host skew is
obvious at a glance.

## 2. The declarative registry (`registry_tools`, host-only)

Tools defined as **data**, bound to a SAFE primitive. A registry tool can only
ever do what its binding's primitive already allows, under existing scoping.

| binding | what it does | class | gating |
|---|---|---|---|
| `ops` | a whitelisted read command (`REGISTRY_OPS_READ`), scope-forced to the chat's project | read | members |
| `rag` | a corpus search over the chat's own project (owner-preset limit/filters) | read | needs engine |
| `mcp` | a brokered call to a tool on a ragrat MCP mount (`tools/call`) | read | **owner-only** |
| `http` | a call to a FIXED owner-set https endpoint (templated query/headers, optional secret, `select` response shaping) | read | **owner-only** |
| `fetch` | GET a **model-supplied** URL, return readable text (HTML stripped) | read | **owner-only** |

**The seam:** new *binding kinds* (and new allowlisted `ops` commands) are a
compiled Rust change + review. That is what keeps "no dynamic code execution,
ever" intact while giving owners data-driven composition. Validation +
execution: `validate_new_registry_tool` / `execute_registry_tool`
(`crates/server/src/tools.rs`). Owner CRUD: `/tools/registry*`.

**Why `http` and `fetch` are different** (it matters): `http` is for APIs — the
owner fixes the host, so a secret can be injected safely. `fetch` is the page
intake — the **model** supplies the URL, so **no secret is ever injected**
(it could be exfiltrated), and HTML is reduced to text (`html_to_text`).

## 3. Connector secrets (`connector_secrets`, host-only)

API keys for `http` connectors, referenced by **name** from a binding. The value
is injected server-side and **never returned by any API** (names only), never
synced — same posture as the ragrat token. Owner-only `/ai/connector-secrets`.

## 4. Loadouts (`loadouts`, `loadout_tools`, `profile_loadouts`, host-only)

Assigned to a personality. Chat resolution (`chat_handler`):

1. **Tool scoping** — if the personality carries loadouts, the offered tools are
   restricted to the **union they grant** (∩ what's enabled). **No loadout = every
   enabled tool** (fully backward-compatible).
2. **Prompt fragments** — each loadout's fragment is appended after the base
   persona + grounding (the "skill voice").
3. **Routing** — a loadout's sub-model runs its tool loop (first set wins; else
   the global tool tier; else the personality's own model). This is what
   `ModelProfile.role`/`resolve_task_params("tools")` finally generalize into.

Owner CRUD: `/ai/loadouts*`; assignment: `/ai/profiles/:id/loadouts`. UI:
**Settings → AI → Loadouts** (`LoadoutsPanel.tsx`).

Knowledge scope stays **orthogonal** in v1 (loadouts don't carry a corpus scope).

## 5. Invariants (the guarantees that don't move)

1. Every tool — compiled, tab, or registry — routes through the one gate. Reads
   execute scope-forced; writes only ever create proposals.
2. **Owner-gating** for `mcp`/`http`/`fetch` is enforced **twice**: filtered out
   of a non-owner's assembled tool set *and* refused in execution (`is_owner`
   threaded `chat_handler → run_tool_loop → execute_tool → execute_registry_tool`).
3. **SSRF**: the guard (`crates/server/src/net_guard.rs`) refuses private,
   loopback, link-local, CGNAT (`100.64.0.0/10`, the tailnet), ULA and the IPv6
   forms that embed one of those IPv4 addresses. Guarded clients resolve through
   it at connect time, so the checked address is the one connected to (no DNS
   rebind window). `https`-only for `http`, `http(s)` for `fetch`; redirects on
   `fetch` are followed **manually and re-checked every hop**; size + time caps.
   Oracle's `fetch.http` and members' mailboxes go through the same guard.
   Calendar subscriptions and the owner's mailboxes, which only the owner can
   enter, may reach the owner's LAN, tailnet and machine, but never a cloud
   metadata endpoint (`Scope::OwnerNetwork`). *(A real browser would bypass this — see §6.)*
4. **Secrets** live host-only, referenced by name, never returned, never synced.
5. **Fetched/external content is maximally untrusted** — capped, collapsed, never
   authorizes a write. Prompt-injection from page content is the #1 agent risk.
6. **Finance reads** (`finance_*`) are offered only in the caller's own Personal chat on a local Ollama model, and
   checked again at execution (`docs/design/FINANCE.md` § Assistant, `SECURITY_MODEL.md` § 8). Registry tools can't
   take their names, and a delegation never carries them.
7. **Capability honesty**: with tools on, the model is told its tools are LIVE and
   override stale persona claims ("I have no live access") — call the tool instead
   of refusing. (A personality's static prompt can go *false* once you grant it a
   tool; fix the prompt at the source, the note is a backstop.)

Tests: `crates/server/src/net_guard.rs` (SSRF allow/deny, connect-time
pinning) and `crates/server/src/tools.rs` (registry validation/scope-forcing,
template substitution, response shaping, `html_to_text`),
`crates/core/tests/loadouts.rs`.

## 6. Web intake — decisions & phases

`fetch` (plain GET) and an `http` connector to a search API (Brave) work today
and cover static pages + APIs. The hard case is **JS-rendered** pages. Evaluated
2026-06-17; decisions:

- **Phase 0 — now: Firecrawl via the existing `http` connector.** A `read_page`
  tool pointing at Firecrawl's `/scrape` (secret = API key, `select` to shape) —
  renders JS, returns LLM-clean markdown/JSON, **zero new code, zero new in-house
  attack surface.** Chosen over Jina Reader for its render fleet + structured
  output. This is the 80% win.
- **Phase 1 — in-house: an isolated render sidecar** (Firecrawl-self-host /
  Browserless), reached by a registry connector over the tailnet, **egress-locked
  by ACL**. This *is* the **scout doctrine** and the Oracle
  "sandboxed webview" node — the browser, the most-owned component, quarantined in
  its own container, never in Ganban's process. The SSRF boundary moves to the
  network (a browser makes its own requests and bypasses `ssrf_check`).
- **Avoid:** embedding headless Chrome in `ganban-server` (no site-isolation by
  default — "expect it to get owned"; CVE/ops/footprint), and relying on the Tauri
  desktop webview as the primary path (desktop-only; the headless server has no
  webview; hard to lock down).

**Phase 0 → Phase 1 is a one-field swap.** Because the renderer is just a
registry `http` connector, going in-house never touches the agents or loadouts:
stand up a self-hosted Firecrawl/Browserless on the tailnet and **change the
`read_page` tool's `url`** from `api.firecrawl.dev` to the sidecar's address (and
lock its egress at the network). The model still calls `read_page` with a URL;
nothing downstream changes.

### Setup — the `read_page` connector (renders JS → markdown)

The `http` binding supports `method: POST` + a JSON `body` (string leaves are
templated after parsing, so a model arg is a value, never injected structure),
and `select` returns a single string field (e.g. `data.markdown`) as clean text.
Firecrawl drops straight in. On the host (loopback = owner):

```bash
H=http://127.0.0.1:8765

# 1) store the Firecrawl key (host-only, write-only, never synced)
curl -s -X PUT $H/ai/connector-secrets -H 'content-type: application/json' \
  -d '{"name":"firecrawl","value":"fc-YOUR_KEY"}'

# 2) define read_page (POST /scrape → markdown)
curl -s -X POST $H/tools/registry -H 'content-type: application/json' -d '{
  "name":"read_page",
  "description":"Read a web page (renders JavaScript). Use for current/live pages when a plain fetch returns nothing. Give the full URL.",
  "binding_kind":"http","class":"read",
  "params_json":"{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"The full URL of the page to read.\"}},\"required\":[\"query\"]}",
  "binding_json":"{\"method\":\"POST\",\"url\":\"https://api.firecrawl.dev/v2/scrape\",\"headers\":{\"Authorization\":\"Bearer {secret}\"},\"body\":{\"url\":\"{query}\",\"formats\":[\"markdown\"],\"onlyMainContent\":true},\"secret_name\":\"firecrawl\",\"select\":{\"path\":\"data.markdown\"}}"
}'
```

Then add `read_page` to a loadout next to `web_search` (Brave) and `web_fetch`
(plain GET), and nudge the loadout prompt: *try `web_fetch` first; if the page
is JS-heavy or returns little, use `read_page`; use `web_search` to find URLs.*
UI path: **Settings → AI → Tools** (secret + New tool) and **→ Loadouts**.

### North star — authoring by demonstration, not node-wiring

The intent for Oracle is that the owner **shows Ganban a workflow** ("go to this
site, check x/y/z, copy the updated figures, draft a report") rather than wiring
nodes by hand. This is the mockups' **click-authored locator that replays
deterministically and self-heals via an LLM only on a miss** (`docs/design/mockups/oracle_*.html`):
demonstrate once → a cheap, repeatable extraction; the model is the fallback, not
the per-run engine. Rendering (Phase 0/1) is the *easy, dangerous half*;
**deterministic extraction from the rendered DOM is the durable, harder half**
(2026 research: even SOTA agents hit ~31% recall on complex interactive sites) —
budget for it as the real work.

See also: `docs/design/Architecture.md` (trust zones, invariants), and the Oracle / Leonidas
/ Odysseus split — **Oracle** acquires, **Leonidas** is the
human-gated routing funnel (the secretary's role: "which project does this belong
to?"), **Odysseus** is the opportunity engine ("is this a *new* opportunity?").
