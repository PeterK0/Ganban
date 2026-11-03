# Collaborative project model (design doc)

**Status: DESIGN — to be approved before any code.** Decision recorded
2026-06-13: "keep both" — a member joins someone else's project while keeping
their own private local projects. This doc designs that and costs it honestly.

## Goal

A member runs their own Ganban (private local projects) AND participates in
projects hosted by others, with shared-vs-private clearly denoted — without
abandoning one to use the other. Today, joining a host is a global
`local` XOR `online` switch: going online hides your local workspace entirely.

## The obstacle, stated plainly

The client is single-transport by construction:
- `getTransportMode()` is one global `'local' | 'online'` (daemon.ts).
- One `ganban-daemon-url` + one `ganban-device-token` in localStorage.
- `useHttpTransport()` (api.ts — "the ONE transport seam") picks local `invoke`
  XOR HTTP to that one URL, per call, globally.
- The zustand store holds one project list; SSE freshness is one stream to one
  host; identity (`/me`, user_id) is per-host; AI/ragrat/secretary are per-host.

"Keep both" means N simultaneous data sources. Every one of the above assumes one.

## Recommended design — multi-workspace client (option 1)

A **workspace registry** on the client:
- `local` — the always-present embedded daemon (the user's private projects).
- zero or more `remote` — each `{ id, label, url, deviceToken }`, added by the
  join flow (which stops being a global mode switch and becomes "add a workspace").

Projects are namespaced by workspace. The sidebar shows all projects, each
**badged by home** (local = "this machine"; remote = the host's label), with
shared/private denotation = which workspace it lives in. Owner + member list
come from that workspace's `/me`/members.

**Routing:** the transport seam becomes per-workspace. A call carries (or the
store resolves) which workspace its target project belongs to; `invoke` for
local, `daemonFetch(workspace.url, workspace.token)` for remote. This is the
load-bearing change and it touches every data path.

## Honest cost (why this is phased, not one leap)

The seam is global today; making it per-workspace is the bulk of the work:
- **api.ts / daemon.ts:** `daemonFetch` must take a workspace (url+token) rather
  than read the single global. Every caller either threads a workspace handle
  or the store tags each entity with its workspace and a resolver injects it.
- **store:** merge N project lists; keep selection, freshness, and per-workspace
  identity coherent. `currentUserId` is per-workspace (you're a different user
  row on each host).
- **SSE:** one `subscribeDataPulse` per remote workspace, fanned into the same
  debounced refetch, scoped to that workspace's entities.
- **Per-host features:** AI/secretary/ragrat/tabs are the host's, not yours —
  a remote project's Assistant talks to the host's models, its files to the
  host's ragrat. The UI must make "whose AI/storage is this" unambiguous.
- **Mobile:** already a pure thin client to one host; multi-workspace there is a
  separate, later question (out of scope for K1).

## Proposed phasing

- **K1 — attach + switch (the honest MVP of "keep both").** The registry holds
  local + remotes; a **workspace switcher** (top bar) flips the active
  workspace; each is full-fidelity while active; switching is instant and
  lossless (no re-enroll, no reload). This delivers "I keep my projects AND can
  jump into yours" without the N-way merge. Reuses today's single-transport
  machinery, just keyed and swappable instead of global. Smallest change that
  satisfies the decision.
- **K2 — merged view.** One project list spanning workspaces, home badges,
  cross-workspace search. Needs the per-workspace seam + store merge + N SSE.
  Build only if K1's switcher proves insufficient in real use.

## Schema / gate notes
- **approver ≡ proposer** is a single-`user_id` invariant; four-eyes/delegated
  approval needs a schema + `authorize_proposal` change. **K1/K2 do NOT require
  it** (each host still self-approves its own writes). Documented, not solved.
- A per-server license model would be unaffected — a guest workspace is still
  "one shared machine," consistent with node-sharing.

## Option 2 — peer federation: rejected on paper

Each member's instance syncing peer-to-peer with others. Rejected: laptops
sleep (no always-on authority), N×N auth, sync/conflict/merge semantics, and an
unclear backup story — the hard distributed-systems problems, for a small-team
tool whose whole pitch is "one owner's machine is the authority." Not now,
likely never. Written down so it's a decision, not an omission.

## Open questions
1. K1 switcher first (recommended), or straight to K2 merged view?
2. Active-workspace switch: full reload (simple, today's mechanism) or
   in-place (better UX, more store work)?
3. Badging vocabulary: "this machine" / host label — confirm the words.
4. Does any near-term use need four-eyes approval (forces the schema change)?
