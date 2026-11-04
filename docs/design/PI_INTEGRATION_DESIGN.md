# pi integration + agent runtime — design implications

Branch: `pdf-ai-structure`. The AI-structure button is the **vehicle**; the real
goal is laying the foundation for a configurable external-agent runtime, a
free-vs-paid model **protocol** layer, per-persona **budgets**, reusable **OCR**,
and (later) **agent workflow orchestration** + **executable Python blocks**.

This doc records the implications of that direction *before* we build, so
the first vertical slice (the structure button) is shaped to extend, not redo.

---

## 1. Where pi runs — the load-bearing decision

A typical setup is a **laptop connected as owner to a server**. pi + the
user's paid API keys live on a machine; the "host" is the server. Tension:

- ragrat/Ollama precedent = **server-side** spawn (`ai_engine.rs` supervises them).
- The user's `~/.pi/agent/auth.json` (Anthropic/OpenAI keys) is typically on the
  **laptop**, not the server.

The framing: *"determined and executed by the host machine, whose models
we're using… leaving room for leveraging the resources of the connected
machine."* → a **two-node execution model**:

- **Server (host)** = primary orchestrator + executor. Runs pi when pi+keys are
  present on the server.
- **Connected laptop** = an optional **compute node** that can volunteer pi (and
  its keys, and its CPU/GPU) for a task.

**Implication:** `pi_rpc` should be a **server-side module** (`crates/server/src/pi_rpc.rs`)
that resolves *where* to run pi (local vs a registered compute node) per a
**runner registry**, not a Tauri-only command. The structure button calls a
server endpoint; the server decides the runner. This keeps web/remote clients
able to trigger pi work, and matches "host executes."

**Open question to confirm:** is pi expected to be installed **on the server** in
production (so keys live there), or always proxied to the owner's laptop? This
decides whether the runner registry is needed on day 1 or can be deferred. My
lean: **day-1 = server-local pi only** (simplest), registry added when the
laptop-as-node feature lands. Confirm.

---

## 2. Protocol system = the missing policy/router layer

Ganban already has: `model_profiles` (personas), `loadouts` (tool bundles),
`agent_actions` ledger (cost per task), the rules engine, scoped project model
profiles. The missing piece is the one that **composes** them:

> *a protocol = when a free model is used, when a paid model is used; give
> personalities a budget; bundle loadouts + protocols + tools together.*

This is the **protocol index**, realized as a **router**:
given a *task class* (`pdf.structure`, `code.architect`, `ocr.scan`…), the
protocol picks **model tier** (local-Ollama-free vs external-pi-paid), **tools**,
**loadout**, **budget**, and **runner**. It sits in front of agent dispatch.

**Implication for this branch:** the structure button should not hardcode "call
pi." It should call a `dispatch_agent_task(task_class, payload)` that consults a
protocol (default: free-Ollama; override: paid-pi for hard cases). Even if v1
only has one protocol row (`pdf.structure → pi`), the **indirection** is the
deliverable — it's what every later feature reuses.

**Schema sketch (later epoch, not this branch):**
- `protocols(name, task_class, model_tier, runner, tools_json, loadout_id, budget_cents, ...)`
- `persona_budgets(profile_id, period, spent_cents, cap_cents)` — checked at the
  gate before a paid call; the `agent_actions` ledger already records per-task
  cost, so `spent` is a SUM.

---

## 3. OCR — ragrat already does it; don't reinvent

Open-source OCR: **ragrat already OCRs**: its ingest
pipeline runs **Docling + rapidocr + onnxruntime** (CPU) on every document,
including scanned PDFs. So "adding OCR to Ganban" is almost certainly
**exposing ragrat's OCR as a Ganban capability**, not bundling Tesseract.

**Implication for the structure button:** a scanned PDF has **no text layer**, so
`pdf.js getTextContent` returns nothing and the agent can't read the printed
Contents page. The pipeline becomes:

1. Ganban fetches page text via `pdf.js getTextContent`.
2. If empty (scanned) → call **ragrat's OCR** (it's already running, already has
   the models downloaded via `docling-tools models download`) for the Contents
   page(s) only.
3. Send the extracted text → agent → structured ToC.

This reuses the ragrat sidecar we already supervise, costs nothing new, and
establishes **"ragrat-as-an-OCR-tool"** as a reusable Ganban service — which the
later Python-blocks and workflow features also want.

**Confirm:** reuse ragrat OCR (recommended) vs bundle a separate OCR engine?

---

## 4. The structure button as a vertical slice

To establish the core tech with a "simple task," the button cuts through every
new layer. Concrete v1 shape (smallest correct foundation):

```
[Contents view]  "Auto-build structure" button
        │
        ▼
extract page text (pdf.js)  ──►  (if empty) ragrat OCR
        │
        ▼
POST /ai/agent-task  { task_class: "pdf.structure", pdf_file_id, page_count }
        │
        ▼  (server) dispatch_agent_task → protocol lookup
        │     └─ model_tier: paid-pi  →  pi_rpc::run_once(prompt, schema, runner)
        │     └─ budget gate (agent_actions SUM < cap)
        │     └─ sandbox: pi cwd = tempdir, tools = [read] (no bash) for v1
        ▼
pi returns JSON: [{ title, printed_page, level }]
        │
        ▼  (server) reconcile printed↔physical (offset inference), clamp 1..N
        ▼
return FlatEntry[]  ──►  populate draftEntries (PROPOSAL, not auto-save)
```

Deliberate v1 constraints (to confirm):
- **Proposal only** — fills the existing StructureEditor; user reviews + saves.
  "Under his/her control" = never auto-write.
- **Infer levels** — agent returns `level`; user can re-indent.
- **One-shot** — `pi --mode rpc --no-session`, spawn → prompt → parse → kill. No
  long-lived session yet (matches "single command execute," keeps cost bounded).
- **Model = pi default** for v1; a per-task-model setting comes with protocols.
- **No live streaming UI** — spinner + final status; RPC events are logged but
  not surfaced (nice-to-have later).

---

## 5. pi_rpc module — the reusable scaffold

The decision: build a small reusable module, wire one button now. Shape:

```rust
// crates/server/src/pi_rpc.rs  (server-side; "host executes")
pub struct PiTask { prompt: String, schema: Value, runner: Runner, tools: Vec<String>, cwd: PathBuf, model: Option<String> }
pub enum Runner { Local, ComputeNode(NodeId) }   // ComputeNode deferred to the registry epoch
pub async fn run_once(task: PiTask) -> Result<Value>;  // spawn `pi --mode rpc --no-session`, prompt, collect events, return final JSON
```

- Spawns `pi` resolved from **settings** (`pi.binary_path`, configurable; PATH
  fallback). Hidden/disabled when not found.
- Credentials come from pi's own `~/.pi/agent/auth.json` — **not** Ganban's
  settings. Ganban never sees the keys. (Configurable per-project *model choice*
  lives in Ganban; the *keys* stay with pi.)
- `--no-session` = ephemeral; no session files littered.
- Result parsed from the final assistant message (JSON, per a schema in the
  prompt). Validate + clamp server-side before returning to the UI.

**Why server-side, not a Tauri command:** web/remote clients must be able to
trigger it; the server is the host that "executes"; and it parallels ragrat/Ollama
supervision. A Tauri command would lock it to the desktop.

---

## 6. Budgets + cost (already half-built)

`agent_actions` already records `model`, `prompt_tokens`, `completion_tokens`,
`duration_ms` per gated write; `chat_messages` has the same for chat turns. So
**cost-per-task is already a metric.** A "budget per personality" is just:
- a `persona_budgets` table (cap per period),
- a **gate** in `dispatch_agent_task` that SUMs spent-from-ledger and refuses
  (or downgrades to free-Ollama) when over cap.

**Implication:** every pi call must write an `agent_actions` row (even though
it's not a "gated write" in the propose→approve sense) so the budget meter sees
it. v1 can skip the gate (no cap) but **must log the cost row** — retrofitting
cost later is painful. Confirm: log pi cost to `agent_actions` from day 1?

---

## 7. Security / sandbox

pi with `read`+`bash` + the owner's filesystem is powerful. The
"virtualised environment + protocol as guide" = **constrain pi's cwd + toolset
per protocol**. pi SDK supports custom `cwd` and a `tools` allowlist — the
protocol encodes both. v1: `cwd = tempdir` (the PDF is written there), `tools =
[read]` (no bash). Later protocols can widen this inside a uv-managed sandbox
for the Python-blocks feature.

**Implication:** the protocol is the **sandbox boundary**. Never let a task
inherit a wider toolset than its protocol declares.

---

## 8. What this enables next

With `pi_rpc` + `dispatch_agent_task` + protocol indirection + ragrat-OCR + cost
logging in place:

- **Agent workflow orchestration** — a workflow = ordered `agent_task`s with
  outputs piped to inputs; the protocol picks each step's model/runner. The
  dispatch + ledger are already multi-step-ready.
- **Executable Python blocks** — a *second* sidecar runtime (uv-managed
  ephemeral envs). It reuses the same `dispatch_agent_task` shape (task_class =
  `python.exec`), the same sandbox discipline (cwd + tool allowlist), and the
  same cost logging. The `pi_rpc` module becomes the template for a
  `python_runner` module.
- **Loadout/protocol/tool bundling** — protocols compose the three; a workflow
  references a protocol per step. This is the "efficient workflow creation"
  surface.

So the structure button isn't just a feature — it's the **first task class** in
a task-dispatch system. Getting the indirection right now (don't hardcode pi)
is the whole point of the branch.

---

## Decisions (confirmed)

1. **pi location day 1**: server-local only (simplest). Registry deferred.
2. **OCR source**: reuse ragrat's Docling/rapidocr. ✅
3. **Cost logging from day 1**: write an `agent_actions` row per call. ✅
4. **v1 constraints**: proposal-only, infer levels, one-shot, default model,
   no live-stream UI. ✅
5. **Result reconciliation**: agent returns physical `startPage`; Ganban clamps
   to `[1, pageCount]`. ✅
6. **Keys boundary**: Ganban never stores pi API keys — pi owns its `auth.json`.
   ✅
7. **Default runner**: Ollama (free). pi is opt-in per protocol.
8. **Sandbox**: `sandbox-exec` on macOS (MVP). Linux/Windows before closing.

---

## Build status (this branch)

### Implemented

- **`pi_rpc.rs`** — one-shot RPC runner: spawns `pi --mode rpc --no-session`
  with `tools:["read"]`, sends a prompt, collects events until `agent_end`,
  returns `{text, model, prompt_tokens, completion_tokens, duration_ms}`. 5 unit
  tests (text extraction, sandbox profile, pi binary resolution).
- **Sandbox (macOS MVP, superseded by the deny-read sandbox below)**: `sandbox-exec` profile used `(allow default)` +
  `(deny file-write*)` + re-allow tempdir only. Network is allowed (pi must
  reach the LLM API). The defense against agent exfiltration is the read-only
  toolset (`tools:["read"]` — no bash), not the sandbox. The sandbox's job is
  preventing FILE WRITES outside the tempdir. Verified: pi runs, writes outside
  tempdir are blocked (`Operation not permitted`). One narrow carve-out: pi
  acquires a lockdir (`mkdir ~/.pi/agent/*.lock`) before reading its own
  settings/auth — with writes denied it reports "No API key found" — so the
  profile allows ONLY `~/.pi/agent/*.lock` (never the agent dir itself: a
  writable extensions dir would be a persistence vector).
- **Hermetic config (DELEGATE §9)**: Ganban-spawned runs pass `--no-extensions
  --no-skills` — the user's pi extensions (e.g. subagent, whose worker agents
  carry full tools) must never be discovered inside a `tools:["read"]` run.
- **✅ GATE TESTS PASSED LIVE (2026-07-02, laptop, model claude-haiku-4-5):**
  ```
  GANBAN_GATE_MODEL=claude-haiku-4-5 cargo test -p ganban-server --lib pi_rpc -- --ignored
  test pi_rpc::sandbox_gate::subagent_toolset_gate ... ok
  test pi_rpc::sandbox_gate::read_only_pi_cannot_write_or_fork ... ok
  ```
  A prompt-injected read-only run could not write outside cwd, could not fork
  a shell, and could not delegate to a full-tools subagent. **The python
  runner is unblocked** (its template inherits this harness).
- **`dispatch_agent_task`** — the indirection seam. Wraps `resolve_protocol` +
  runner selection (Ollama free / pi paid) + `record_agent_action` on every
  invocation. Mirrors `routines.rs::run_routine`.
- **Protocol schema (frozen)** — `ai_routing` JSON extended: entries are now
  `{ runner, profile_id, model }` objects (backward-compatible with legacy
  integer entries = Ollama). `Runner::{Ollama, Pi}`. `structure_toc` added to
  `ROUTING_CLASSES`. Default = Ollama (free).
- **`POST /ai/agent-task`** — owner-only endpoint. **Async**: spawns the task
  on a tokio task, returns `{ job_id, status: "running" }` immediately. The
  frontend polls `GET /ai/agent-task/:id` every 2s until `status: "done"`.
  This avoids HTTP connection timeouts on long model generations (Tailscale
  drops idle connections well before the model responds).
- **`POST /ai/ocr`** — takes raw PDF bytes, forwards to ragrat's `RagClient::ocr()`
  (Docling + rapidocr), returns `{ text, chars }`. Used as the scanned-PDF
  fallback when pdf.js `getTextContent` returns nothing.
- **ragrat `POST /ocr`** (ragrat `ocr-endpoint` branch) — standalone text
  extraction via Docling+rapidocr, no ingest overhead. 3 ragrat tests.
- **`pdfUtils.ts::extractPageText/extractPageRangeText`** — pdf.js
  `getTextContent` (not used before).
- **PdfTab "Auto-build" button** — extracts first 10 pages → (if empty, OCR
  via ragrat) → dispatches `structure_toc` → polls for result → parses JSON →
  clamps pages to `[1, pageCount]` → populates `draftEntries` as a **proposal**
  (user reviews in StructureEditor before "Save with structure"). Never
  auto-saves.
- **Settings UI** — Personalities → "Task routing (protocols)" section:
  toggle `structure_toc` between Ollama (free, pick a profile) and pi (paid,
  model pattern). pi binary path setting. Error messages guide the user when a
  model isn't pulled or pi isn't installed.

### Sandbox: deny-read by default (`pi_sandbox.rs`)

| Platform | Method | Profile |
|---|---|---|
| **macOS** | `sandbox-exec -p <profile> pi ...` | Deny every file read and write; allow the run's folder (read/write), pi's install and node runtime, system libraries, certificates and time zones (read). Outbound network: TLS on 443, DNS, and the chosen provider's explicit ports. No keychain or clipboard service. |
| **Linux** | `bwrap --unshare-all --share-net ... pi ...` | An empty root with only the system allowlist, pi's runtime and the run's folder bound in; `/tmp` is a fresh tmpfs. Network shared (bwrap has no port filter). No `bwrap`: the run is refused unless `GANBAN_PI_UNSANDBOXED=1`. |
| **Windows** | none yet | Runs are refused; route the task class to Ollama. |

Every run gets a clean environment and a staged pi config in its own folder
(`.ganban-pi/agent`, via `PI_CODING_AGENT_DIR`): model settings, and only the
chosen provider's `models.json` and `auth.json` entries. The owner's
`~/.pi/agent` (session transcripts, every key, extensions) is never readable
or writable from a run; an OAuth refresh inside a run is copied back. Gate
tests: `cargo test -p ganban-server --lib pi_ -- --ignored` with
`GANBAN_GATE_MODEL=anthropic/claude-haiku-4-5`.

### Update: protocols

The protocol schema is now frozen as the `Protocol` struct in `lib.rs`:
```rust
Protocol { runner: Runner, profile_id: Option<i64>, model: Option<String> }
```
Stored in `ai_routing` JSON (extended, backward-compatible). A later protocol-index
step will promote this to a dedicated `protocols` table when budgets,
loadout refs, and sandbox profiles need per-row validation. The **contract**
(task_class → runner + model, no keys in the record) is stable from day 1.
