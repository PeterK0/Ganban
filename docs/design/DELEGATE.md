# Delegate — subagents under the one gate (design)

**Status: DESIGN — decisions recorded 2026-07-02.** Generalizes the shipped librarian
executor (`crates/server/src/librarian.rs`, the engine under `ask_atlas`) into a general
delegation primitive. Takes pi's subagent harness as the reference for ergonomics and
diverges from it deliberately where Ganban's multi-user trust model demands. Companion
to `docs/design/PROTOCOLS.md` (workflows own chaining) and `docs/design/SECURITY_MODEL.md` (the triangle).

## 0. Load-bearing facts

- **Ganban already shipped one subagent.** `ask_atlas` is the pattern complete: an
  executor running a bounded multi-search loop on its *own* model profile with its
  *own* clean context, returning a ≤250-word cited digest, billing its tokens into the
  calling turn. `delegate` is that module made generic — the target agent becomes a
  parameter instead of a constant.
- **Delegation narrows capability. It never widens it.** The single rule everything
  below follows from.
- **One gate, one inbox.** A subagent's write is a proposal like any other. There is
  no sub-approval surface and no exception path.

## 1. The tool

A **read-class built-in** (a new kind of power = a reviewed Rust change, per the
registry seam — this is not a registry binding):

```
delegate(agent: <personality slug>, task: string)                    — single
delegate(tasks: [{agent, task}, …])                                  — parallel fan-out
→ { digest, citations, agent, cost: {model, tokens, duration_ms} }
```

Execution: resolve the named personality + its loadouts, run `run_tool_loop` on *that
profile's* engine (per-profile endpoint), under the existing caps discipline
(bounded rounds, per-round timeout, truncated results). The caller receives a bounded
digest, never the subagent's transcript — context isolation is the point, not a
side effect.

## 2. Capability intersection — where Ganban is deliberately not pi

pi's `worker` carries full tools because pi is a **single-principal** harness:
everything in it is already you. Ganban is multi-user, so:

```
effective toolset = target's loadouts ∩ caller's toolset ∩ active protocol's allowlist
```

Owner-only bindings (`mcp`/`http`/`fetch`) **never cross into a non-owner's
delegation**, enforced at assembly AND execution — the same double-enforcement
discipline as the registry. Without the intersection rule, a member's chat delegating
to a profile that carries owner tools is a privilege escalator with an avatar.

## 3. Writes, attribution, and the ledger tree

- Subagent writes land in the same inbox, the proposal card carrying the chain:
  *"Donna → via Eratosthenes."*
- `agent_actions` gains **`parent_action_id` (nullable)**: every delegation is its own
  ledger row linked to the calling turn's row. Cost roll-up is a query over the
  existing capacity-meter columns — "this rundown cost 3 scout calls and one worker
  pass" is answerable, forever. The whole tree bills the calling protocol's budget;
  downgrades are recorded per node.

## 4. Depth 1, by structure

`delegate` is **excluded from every delegated agent's effective toolset** — a
structural rule in assembly, not a prompt instruction. A fan-out cannot fan out.
Deeper trees are a future decision to be made deliberately; recursion-off-by-default
is the difference between a fan-out and a fork bomb with token costs.

## 5. The digest contract

Capped (default 250 words, per-call override ceiling 500 — librarian precedent),
cited, findings-first, gaps stated. The compression is not a nicety: the default
orchestrator is an 8B-class model that drowns in raw context. Scout-compresses-for-
the-small-model matters *more* in Ganban than in pi, where the orchestrator is a
frontier model. A digest **inherits the trust status of its sources** — a subagent
that read the web or a corpus returns untrusted content; the digest can inform, never
authorize.

## 6. Concurrency — the hardware honesty clause

pi's "8 tasks, 4 concurrent" is underwritten by a datacenter; ours by whatever box
Ollama sits on. So:

- The parallel cap is **hardware-aware via the Model Advisor**. Over-cap tasks queue; they never thrash a fanless 8 GB
  machine into model-swap noise (limiting as a kindness).
- Real parallelism arrives through **per-profile endpoints**: scout on the local model,
  worker on the 4090 — "two computers beat one," made mechanical.
- Absolute ceiling 8 per fan-out regardless of hardware (matches pi; sanity bound).

## 7. Chaining lives in workflows, not in the tool

pi's chained mode and PROTOCOLS.md §6 workflows are the same idea; we already designed
the durable, suspend-on-the-gate version. `delegate` stays single-shot + parallel.
Sequential composition with human gates is a workflow. **One composition mechanism.**

## 8. UI

- Delegation is a **skill** ("Teamwork") — a loadout containing `delegate` plus a
  prompt fragment on when to use it. No Teamwork chip, no fan-outs: the default
  assistant never surprises anyone with a sub-crew.
- The team roster animates it: avatars flip idle → working during a fan-out,
  digests return, they flip back. The "🔧 Looked up" breadcrumb gains the chain; the
  digest renders collapsed, like "Used N references."

## 9. pi-runner hardening (adjacent, required before this ships)

A pi install may carry the subagent extension
(`~/.pi/agent/extensions/subagent/`) — which means it exists **inside our sandboxed
`pi_rpc` subprocess** too. A `worker.md` with full tools is a path for `bash` to walk
back into a `tools:["read"]` run: child processes inherit the Seatbelt sandbox (file
writes stay blocked), but the *toolset* restriction is pi-config-level, not
kernel-level. Actions:

1. RPC mode passes a **pinned config / extensions-off flag** — never inherit
   `~/.pi/agent/` extensions or agent definitions into a Ganban-spawned run.
2. New test alongside `sandbox_gate` and `read_exfiltration_gate`:
   **`subagent_toolset_gate`** — a prompt that tries to delegate to a full-tools agent
   from inside a read-only RPC run must fail.

The issue-log lesson generalizes: the sandbox profile must match the runtime's needs,
and the runtime just grew a new need.

## Conformance tests

| Test | Asserts |
|---|---|
| `delegation_narrows` | a member's delegation to an owner-tooled profile cannot reach owner-only bindings |
| `no_recursion` | `delegate` absent from every delegated toolset, at assembly and execution |
| `tree_ledgered` | each delegation writes a ledger row with `parent_action_id`; roll-up sums match |
| `budget_rollup` | fan-out cost bills the calling protocol; over-budget downgrades recorded per node |
| `digest_capped` | responses truncate at the budget; citations survive truncation |
| `subagent_toolset_gate` | §9 — pi RPC runs cannot reach pi-side subagents |

## Invariants

1. Delegation narrows capability — intersection, never union.
2. One gate, one inbox; subagent writes are proposals with the chain attributed.
3. Depth 1 by structure; the fan-out ceiling is hardware-aware with a hard bound.
4. Every delegation is ledgered with a parent link and billed to the calling budget.
5. Digests inherit their sources' trust status — inform, never authorize.

## Not in scope

Multi-level delegation trees; free agent-to-agent conversation (that rides the
inbox/comments); cross-principal delegation (that is MEMBER_AGENTS.md, and it crosses
as tasks, not calls); auto-created personalities (agents are rows a person made).

## Decisions (recorded 2026-07-02)

1. **Slugs, not ids, in the tool schema** — models handle names better, and slugs
   survive export/import.
2. **Digest budget 250 default / 500 ceiling**, inherited from the librarian.
3. **Delegation ships as the "Teamwork" skill**, off by default — capability arrives
   with the confidence-based onboarding, not on day one.
4. **`ask_atlas` remains** as-is — a named, purpose-built delegation the librarian
   answers; `delegate` generalizes beside it rather than breaking a shipped tool.
