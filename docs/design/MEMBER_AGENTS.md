# Member Agents — delegation across the machine boundary (design)

**Status: BUILT — boundary shipped 2026-07-02** (task_assignees + briefs, `submit_proposal`
return path, origin attribution, policy-gated inbox). Remaining: member-side automation
(a local “draft my assignments” routine needs a local one-shot endpoint).
Answers the standing question:
*can members use their own Ganban's agents to carry their share of a shared project?*
Yes — with one principle that preserves every invariant we have. Written 2026-07-02.

## 0. The principle

**Agents never cross the machine boundary. Tasks and proposals do.**

The host never executes anything on a member's machine; a member's machine never
executes anything on the host. What crosses is data with a human-shaped review point on
each side. The hand-off point is the *assignment*.

## 1. Same-principal vs cross-principal (do not conflate these)

| | Same principal | Cross principal |
|---|---|---|
| Case | The owner's laptop volunteering compute to the owner's server (PI_INTEGRATION_DESIGN §1) | Alice's Ganban working on the owner's project |
| Mechanism | Runner registry (deferred) — push execution is fine; it's one person's two boxes | **Tasks + proposals through the gate. Never a runner.** |
| Credentials | One person's keys, one trust domain | Never shared, never proxied, never stored for each other |

Keeping these separate is what prevents accidentally building a distributed execution
system nobody wants (peer federation was rejected for the same class of reasons —
CollaborativeProjects.md).

## 2. The flow

```mermaid
sequenceDiagram
  participant H as Host (owner's Ganban)
  participant A as Alice's Ganban (her machine, her models, her keys)
  Note over H: Task assigned to Alice (task_assignees)<br/>+ optional work brief attached
  H-->>A: SSE pulse; Alice's client sees the assignment (K2 multi-workspace)
  Note over A: Alice's LOCAL agent acts on her assigned tasks<br/>(her routine, her engine, her budget)
  A->>H: Result submitted as a PROPOSAL on the host
  Note over H: Host gate: untrusted external content;<br/>approved per the project's approval setting;<br/>ledgered with proposer + approver
```

1. **Assignment.** A task is assigned to Alice (`task_assignees`), optionally carrying a **work brief**. A host agent may *propose* the assignment
   and brief — gated, like everything.
2. **Local action.** Alice's own Ganban already sees the host workspace (K2). Her
   *local* agents act on her assignments — e.g. a routine "draft responses to tasks
   assigned to me on connected workspaces." Compute happens where her keys, models, and
   hardware live; her budget pays; her ledger records her side.
3. **Return.** Her agent's output arrives on the host **as a proposal on the host**,
   reviewed under the host's gate. On the host's ledger: proposer = Alice('s agent,
   attributed to Alice), approver = per §4.

## 3. The work brief

A structured attachment on the assignment — **advisory on both sides, executable
authority on neither**:

```yaml
brief: 1
protocol: user.summarize-charter-docs   # a protocol SLUG Alice may have/install — a
                                        # suggestion, never an injected capability
inputs: { folder: "/charters/panamax", deadline: 2026-07-10 }
notes: "Compare against last week's fixtures; flag deltas over 5%."
acceptance: "One comment per document, ≤200 words, cites sources."
```

Symmetric hostility: the brief is untrusted *inbound content on Alice's side* too (a
compromised host must not be able to program her agent). Her Ganban renders it with the
standard treatment; her protocols and her gate decide what actually runs.

## 4. Approval on the host — who signs

This is the feature that finally forces the known schema gap: **`approver ≡ proposer`
cannot express "Alice's agent proposed, Alice approved, the owner can see both."**
Prerequisites (ordered):

1. **Durable proposals** — ProposalStore → table (restart/eviction must not eat a
   member's pending work; multi-producer proposals arrive with this feature anyway).
2. **`approver_id` (nullable)** on proposals + ledger, default = proposer — the minimal
   schema move; four-eyes becomes a policy choice, not a migration.
3. A **per-project approval setting**: `assignee approves own returns` (default —
   Alice reviews her agent's draft before it lands) vs `owner approves all` (stricter
   desks). Either way both identities are on the ledger row.

## 5. What this design refuses (the guarantees)

- No push execution across principals; no host-held member credentials; no
  member-held host credentials beyond the existing device token.
- No agent-to-agent channel that bypasses the gate — inter-persona addressing rides the inbox/comments, and cross-machine it rides *this* flow.
- Member-agent output never auto-applies, regardless of how good it looks. It is
  external content: capped, collapsed, never authorization (SECURITY_MODEL.md §6).
- Pull, not push: members' clients subscribe to assignments over the existing SSE
  stream. A sleeping laptop just means Alice's agent works when she opens her lid —
  which is the correct semantic for "her agent, her machine."

## 6. Dependencies

`task_assignees` (Priority 2) · durable proposals + `approver_id` (§4) · K2
multi-workspace (✅ shipped) · assignment pulse kind (`tasks` suffices; add an
assignee-filtered predicate client-side) · protocols (PROTOCOLS.md) for briefs that
reference one.

## 7. Test story

On the host, assign a task to Alice with a brief. On Alice's machine (a second install
joined via the invite link), her rundown flags "1 task assigned to you"; she runs her
"draft my assignments" routine on her own local model; a proposal appears — on the host
— with the draft; per the project setting she (or the owner) approves; the host ledger
shows proposer *and* approver; the host's model columns are NULL (no host model ran);
nothing on the host executed anything on her machine, and pulling her network cable
mid-run breaks nothing on the host.

## Not in scope

Cross-principal runner registry (never, by principle) · host-driven scheduling of
member agents · shared budgets (each principal pays for their own compute) ·
mobile-originated agent runs (mobile stays a thin client).

## Decisions (recorded 2026-07-02)

1. **Default approval policy: assignee approves own returns.** Alice reviews her
   agent's draft before it lands on the host; `owner approves all` remains available as
   the stricter per-project setting for confidentiality-bound desks. Both identities
   sit on the ledger row either way.
2. **Briefs reference a protocol slug, plain.** One-click gallery install of a
   referenced protocol arrives with R.3's signing/review — convenience never precedes
   the trust story.
3. **Attribution wording: "Alice (via agent)"** on proposal cards and comments; the
   persona's name and protocol provenance live in the detail view and the ledger row,
   not the headline.
