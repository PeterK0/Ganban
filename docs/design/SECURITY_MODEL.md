# SECURITY — the model, the invariants, and the tests that hold them

**Audience:** contributors and auditors, ahead of the MIT release. Ganban is local-first;
the tailnet is the perimeter; there is no public exposure and no plan for any. This doc
states the trust model in one rule, audits every execution context against it, and pairs
each invariant with the test that enforces it — because open source erodes architecture
through a thousand reasonable-looking PRs, and executable invariants are the only review
process that scales. Written 2026-07-02.

## 0. Invariant zero — the triangle

**No execution context may combine all three of:**

```
        private data
           /    \
          /  ✕   \
   untrusted ---- egress
    content      channel
```

1. **access to private data** (the DB, project files, the user's filesystem, secrets),
2. **exposure to untrusted content** (fetched pages, PDFs, email bodies, RAG hits,
   member messages, API responses — anything a stranger could have written),
3. **an egress channel** (network, or any write that leaves the machine).

Two legs are workable. Three is an exfiltration machine waiting for its prompt. Every
feature request is triaged with one question: *which leg does this add, and which leg do
we therefore remove?*

## 1. Context audit

| Context | Data | Untrusted | Egress | Leg removed / mitigation |
|---|---|---|---|---|
| Member chat agent | ✓ | ✓ | — | `mcp`/`http`/`fetch` are owner-only, enforced at assembly AND execution |
| Owner chat + `fetch` | ✓ | ✓ | ⚠ | The known tension. Egress is constrained (model-supplied GET, no secrets injected, `ssrf_check`, https, size/time caps) but **a URL is an egress channel for context data** — a prompt-injected model can encode data into query params. Mitigations: owner-only opt-in; fetched URLs logged to the ledger; the gate backstops all writes. Residual risk, stated honestly. |
| pi runner | ⚠ cut | ✓ | ✓ | The data leg is cut by a **deny-read-by-default sandbox** (`pi_sandbox.rs`): the run reads its own folder, pi's runtime and system libraries, and gets a staged copy of only its provider's config and key. The read-only toolset is NOT the defense — `read` + network **is** the exfiltration primitive; content exits inside the API request at read-time. |
| `python.exec` | ⚠ | ✓ | — | **No network at execution, ever.** Deps install in a separate build phase (network on, uv lockfile), then run with egress denied (PROTOCOLS.md §5). Filesystem: tempdir only. |
| Scout / render sidecar | — | ✓ | ✓ | Holds zero private data; one write-only door (the quarantine webhook); own container, own blast radius; rebuildable. Sacrificial ≠ trusted: the server validates as if it were hostile. |
| Rules engine | ✓ | — | — | Deterministic, no model, no external input; actions are existing `ops`, ledgered. |
| Member-agent output (MEMBER_AGENTS.md) | — | ✓ | — | Arrives at the host as a proposal; treated as untrusted external content; never authorization. |
| Web replay (DEMONSTRATION.md) | ⚠ session only | ✓ | ✓ browsing | Deterministic frozen steps — the page can lie but cannot add actions; egress ACL = the protocol's `web.domains`; sessions live sidecar-only, domain-bound, force `heal: ask`; cookie values never enter Ganban's DB. |
| Tabs | ✓ | varies | via registry only | TAB_SPEC invariants 5–7, 15. |
| Finance tools in a Personal chat | ✓ own finances | ⚠ own bank text | — | Local Ollama models only, read-only, the caller's own entity (§ 8) |

## 2. Egress is a network decision first, an application decision second

Application-level checks (`ssrf_check`, redirect re-checks) are the **second** layer.
The first layer is the network itself:

- Sandboxed runners get their allowed endpoints (the model API and nothing else)
  enforced by the **sandbox profile** — a network namespace/deny on Linux, the Seatbelt
  profile on macOS — with **tailnet ACLs as the outer wall**.
- A real browser (render sidecar) makes its own requests and bypasses `ssrf_check`
  entirely — which is exactly why it lives in its own egress-locked container and never
  in Ganban's process (`ToolRegistry.md` §6).
- Nothing is ever enforced by prompt.

## 3. Sandbox profiles — typed records, named, referenced

A profile is a row a protocol *references*, never an inline blob (referential integrity
on security config is the trigger for the `protocols` table promotion):

```
sandbox_profiles(name,
  fs_read:  allowlist[],   fs_write: allowlist[],
  network:  none | endpoints[] | full,
  wall_clock_s, max_mem_mb, max_pids, max_output_bytes)
```

Resource caps are isolation too: a fork bomb or a 2 GB stdout is a sandbox failure with
no filesystem involved.

**Platform matrix (honest):**

| Platform | Mechanism | Status |
|---|---|---|
| macOS | `sandbox-exec` (Seatbelt) — deprecated-but-functional; deny-read-by-default profile pending (§5) | MVP shipped (write-deny); read-deny REQUIRED before python runner |
| Linux | `bwrap` + rlimits; Landlock as a no-privilege addition; netns for `network: none` | planned, before branch close |
| Windows | **Code execution requires WSL** for v1 — a documented constraint beats a half-trusted AppContainer | decision |

## 4. Executable invariants — the table that IS the review process

| Invariant | Enforcing test | Status |
|---|---|---|
| A model write cannot exist except as a proposal | proposal consume-once + gate tests, `crates/server/src/lib.rs:2637+` | ✅ exists |
| Apply AND reject are ledgered | proposal tests | ✅ exists |
| Owner-only bindings refused for members at assembly and execution | `crates/server/src/tools.rs` tests | ✅ exists |
| SSRF: private/loopback/link-local/CGNAT (tailnet)/ULA refused; address pinned at connect; redirects re-checked per hop | `net_guard.rs` tests | ✅ exists |
| Sandbox blocks writes outside cwd under a malicious prompt | `pi_rpc::sandbox_gate` (`--ignored`, needs pi + key) | ✅ exists — run before unblocking the python runner |
| Sandbox blocks reads outside the allowlist under a malicious prompt | `pi_rpc::sandbox_gate::read_exfiltration_gate` (`--ignored`, needs pi + key) — prompt asks for `~/.ssh/*`, a `gansty.db`, `~/.pi/agent/auth.json`; all denied. `pi_sandbox::live` (`--ignored`, no pi) probes the same paths plus the data folder, `~/Documents`, `~/Dev`, keychains, shared temp and plain HTTP | ✅ exists — run before any cloud-model change |
| Every mutating route publishes a pulse and can be ledger-attributed | middleware allowlist test | ❌ add |
| Live agent work (the timer's "Agents") reaches only the chat's own user, only for tasks of the chat's project they can see; its `agents` pulse carries no payload | `commands::tasks` `agent_work_is_mine_and_follows_task_visibility` | ✅ exists |
| Registry bindings are a closed enum (no dynamic kinds) | exhaustive-match compile guarantee + validation test | ✅ structural |
| Secrets never returned by any API | connector-secrets tests (names-only responses) | ✅ exists |
| `python.exec` has no route to the network at run time | profile test: env resolves, then a run attempting egress fails | ❌ lands with the runner |
| Finance tools only in the caller's own Personal chat on a local Ollama model; never another user's books | `finance_tools.rs` tests | ✅ exists |
| Protocol briefing cannot widen capability | dispatch test: tools ∩ frontmatter enforced server-side | ❌ lands with protocols |

A PR that adds a capability adds a row here, or it isn't done.

## 5. Known gaps (kept honest)

- **pi read boundary — closed for reads, narrowed for network.** A pi run reads only its own folder, pi's
  install and node runtime, and system libraries and certificates (`pi_sandbox.rs`). The owner's `~/.pi/agent`
  is not readable: Ganban stages the run's model settings, and only the chosen provider's `models.json` and
  `auth.json` entries, into the run's folder. The Ganban database and data folder, `~/Documents`, `~/Dev`, SSH
  keys, keychains and the shared temp folders are unreadable (`pi_sandbox::live`, `read_exfiltration_gate`).
  On macOS outbound network is TLS on 443, DNS and the provider's explicit ports only. A Linux host without
  `bwrap` refuses pi runs unless the owner sets `GANBAN_PI_UNSANDBOXED=1`. What remains:
  - The run holds its own provider's key, as pi must. A result that repeats it verbatim is refused; an encoded
    copy is not caught.
  - Egress is filtered by port, not host: Seatbelt can't name hosts, so any host on 443 is reachable from pi's
    process (the agent has no tool to make requests; this is the pi runtime's reach), and DNS lookups stay
    open as a narrow channel. On Linux bwrap shares the network unfiltered, including loopback services and
    abstract sockets. A host allowlist needs a proxy in front of the run.
  - A model pattern without a provider (`sonnet`, not `anthropic/sonnet`) stages every configured provider's key
    from `auth.json` (and none from the environment). Name the provider to narrow it.
  - A `models.json` key given as a `!command` runs inside the sandbox, so one that reads a keychain fails there.
- `sandbox-exec` is deprecated (functional, undocumented). Acceptable now; do not build
  features that assume it forever.
- Owner `fetch` residual (URL-as-egress) — logged, not eliminated. Revisit if fetch
  ever widens beyond owner opt-in.
- SSE reconnect has no backoff/jitter (known debt).
- In-memory ProposalStore: restart/eviction loses pending approvals — promotion to a
  table is required before multi-producer proposals (rules at scale, Leonidas, member
  agents).

## 6. Untrusted content — the standard treatment (restated once, referenced everywhere)

Capped in size. Collapsed by default. Rendered inert (no markdown structure injection —
`safeLinkText` precedent). Provenance shown. **Never authorization**: no instruction
inside external content can approve, widen, or trigger anything; only the frontmatter
of an approved protocol and the human at the gate hold authority.

## 7. Reporting

Reporting a vulnerability: see `SECURITY.md` at the repository root. Anything
security-adjacent jumps every queue.

## 8. Finance

A user's finances are theirs alone (ADR 0009, `FINANCE.md`), and the assistant keeps it that way.

- **Personal-container scope.** The finance tools exist only in a chat whose project is the caller's own personal
  container, and they read only the caller's own entity. Someone else's Personal chats are "not found" on every
  chat route, the host owner included.
- **Ollama only.** Finance data goes to a local model or nowhere: the Ollama runner, the host's engine or an Ollama
  endpoint the owner configured, never a pi (cloud) runner, an Ollama cloud tag or `ollama.com`. Category
  suggestions ask the host's own engine. The host enforces this when it assembles the tools and again when one runs;
  a delegation never carries them. A Personal chat itself runs on a local model only, since its history may hold
  figures.
- **Read-only.** There are no finance write tools. A suggestion is shown, and only the user applies it.
- **The least data.** A suggestion prompt holds a line's description, payee and amount and the chart's names. A tool
  returns compact figures, capped like every tool result.
- **No finance data in logs.** Tool calls, suggestion errors and the client's finance calls (`invokePrivate`) never
  log amounts, payees or descriptions, and errors name what failed, not with what.

Tests: `crates/server/src/finance_tools.rs` (the gate at offer and execution, another user's books, the prompt's
contents, reply matching), the personal-chat routes in `crates/server/src/lib.rs`, and
`crates/server/src/commands/finance_suggest.rs`.
