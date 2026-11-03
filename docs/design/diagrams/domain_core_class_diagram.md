# Domain core — class diagram

Ganban's agent core: how a model proposes, a human decides, and every applied
write lands in an append-only ledger — plus the deterministic (Rule) and scheduled
(Routine) paths that share the same invoke surface.

```mermaid
classDiagram
  direction TB
  class ModelProfile {
    +uuid id
    +string name
    +text persona
    +string endpoint
    +string model
    +string tier
    +string fallback
  }
  class Tool {
    +string name
    +json schema
    +string tool_class
    +string invoke_command
    +bool project_scoped
  }
  class ToolCall {
    +uuid id
    +json args
    +string status
    +int round
  }
  class Proposal {
    +uuid id
    +text description
    +json validated_args
    +string status
    +string idempotency_key
  }
  class LedgerEntry {
    +uuid id
    +datetime at
    +json args_and_result
    +int tokens
    +int latency_ms
  }
  class Routine {
    +uuid id
    +string name
    +int version
    +text prompt_template
    +string trigger
    +string queue
  }
  class Rule {
    +uuid id
    +string event
    +json condition
    +string action_command
  }
  class Project {
    +uuid id
    +string name
  }
  class User {
    +uuid id
    +string identity
  }
  ModelProfile "1" --> "0..*" Tool : toolset
  ModelProfile "0..*" --> "0..1" Project : bound to
  ToolCall "0..*" --> "1" ModelProfile : issued by
  ToolCall "0..*" --> "1" Tool : invokes
  ToolCall "1" --> "0..1" Proposal : write class spawns
  User "1" --> "0..*" Proposal : decides
  Proposal "1" --> "0..1" LedgerEntry : apply is logged
  Routine "0..*" --> "1" ModelProfile : runs as
  note for Rule "Deterministic. No model, no proposal. Actions are invoke commands, still ledgered."
  note for Proposal "0..1 ledger entry: rejected proposals apply nothing."
```

## What the shape encodes
The recurring trick: **decisions stored as data, enforced by structure.** The gate
is a multiplicity (a write-class `ToolCall` *must* spawn a `Proposal` before a
`LedgerEntry` exists); the audit trail is an append-only table everything passes
through; the sharing model is a filter; the budget is a threshold. These can be
violated only by changing the schema — not by forgetting an `if`.

## Reconciliation with the shipped code (read before trusting a line)
Planning-time draft, ahead of the schema in places:

- **`Proposal.idempotency_key` is not in the schema yet.** It belongs to the
  external-write design (e.g. the Sports/booking "retry can't double-book" guard);
  today's `agent_actions` have no such column.
- **`Routine.queue` (priority class) is not built.** The two-lane scheduler is an
  Leonidas funnel gate — routines run single-queue
  today.
- **`User --> Proposal : decides` understates the approver ≡ proposer invariant.**
  There is one `user_id` column; the schema cannot yet express four-eyes / delegated
  approval (the decider must equal the proposer). Changing that needs a schema +
  `authorize_proposal` change (a documented K deferral).
- **`ModelProfile.tier`** maps to the routing class in practice (`ROUTING_CLASSES`);
  `endpoint` + `fallback` are real.
- **`Rule`** matches the shipped native rules engine (2026-06-13).
