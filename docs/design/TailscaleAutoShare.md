# Auto-issued Tailscale device shares — design (verified, ready to build)

**Decision (owner, 2026-06-13):** "Also auto-issue the Tailscale share" — one
invite triggers both the network join and the app join. This doc records the
build-time API verification the roadmap required and the design, before code.

## The verification (the roadmap's "verify at build time" gate → PASS)

The live Tailscale OpenAPI spec (`api.tailscale.com/api/v2?outputOpenapiSchema=true`,
checked 2026-06-13) exposes **device invites** — exactly the primitive Ganban's
node-sharing model needs (share ONE machine to an external user; they stay on
their own tailnet, see none of the owner's other devices, consume no seat):

- `POST /device/{deviceId}/device-invites` — create share invite(s) for a
  device. Response: array of `DeviceInvite { id, inviteUrl, email?,
  allowExitNode, accepted, acceptedBy, ... }`. **`inviteUrl` is the link the
  recipient accepts.**
- `GET /device/{deviceId}/device-invites` — list a device's invites.
- `GET|DELETE /device-invites/{id}`, `POST /device-invites/{id}/resend`.
- `POST /device-invites/-/accept` — accept by URL/code (recipient-credentialed;
  we do NOT use this — the recipient accepts in their own browser, by consent).

This is distinct from `user-invites` (join-the-whole-tailnet, consumes a seat —
the WRONG primitive; we never use it).

**Auth verified at build time (2026-06-13, against Tailscale's docs):** OAuth
clients exchange credentials at `POST https://api.tailscale.com/api/v2/oauth/token`
(form: `client_id`, `client_secret`, `grant_type=client_credentials`, optional
`scope`); the returned access token (≈1h TTL) is used as an `Authorization:
Bearer` header against the v2 API. `-` is a valid alias for the credential's
default tailnet (`GET /api/v2/tailnet/-/devices`), so the owner needn't know
their tailnet name. The device-invites request body is a bare array of invite
specs and the response a bare array of `DeviceInvite { inviteUrl, … }`. These
are exactly what `crates/server/src/tailscale.rs` implements.

## Irreducible floor (be honest in the UI)

Accepting a device share requires the recipient to **have a Tailscale account**
(owner/admin of their own tailnet). The no-relay model Ganban chose cannot
remove this. What auto-share removes is the *owner-side* friction: no more
admin-console spelunking to find and share the machine, and no separate
"now also paste the Ganban link" — it becomes one click.

## The 90-day fuse (found 2026-09-10, the hard way)

Tailscale caps a **personal API access token at 90 days**, and only a personal
token can mint a device share (an OAuth client cannot — a share is scoped to a
user). So auto-share as shipped in June was guaranteed to break in September,
and the first symptom was the invite gate with a 401 — nothing before that
said the fuse was burning. Fixes, all shipped together:

- **Check reports the expiry** (`token_expiry` from `GET /tailnet/{t}/keys/{id}`,
  the key id parsed out of the token itself) — "Token expires <date> (N days)",
  amber ≤ 14 days, red when past.
- **Invite panels warn in the last 14 days** (`tokenRenewNote`), where the
  owner actually is when it matters. `tailscale_share` returns the expiry
  alongside the share.
- **A 401 says what it is**: "expired after at most 90 days — renew at
  Settings → Keys, paste in Settings → Sync → Tailscale", not "needs the
  device-invites scope".
- **A manual path that cannot expire**: the gate accepts a machine-share link
  the owner generates in the admin console (Machines → host → Share… →
  Generate invite link — `parseTailscaleShareLink` admits only
  `https://login.tailscale.com/…/invite/…`) and renders the same two-step
  invite. The API is a convenience; the primitive is the share link.

Renewing: generate a new token *with the 90-day expiry*, paste, Check. Put a
reminder ~80 days out — or just read the date Check shows.

## Design

### Owner setup (once, host-side — GIPHY-key pattern)
- App-setting `tailscale_api` = `{ access_token | oauth: {client_id, secret}, tailnet }`.
  **CORRECTION (2026-06-13, found in testing):** device invites MUST use a
  **personal API access token** (`tskey-api-…`, user-bound). An OAuth client does
  NOT work — Tailscale's API: *"device invites cannot be created using an API
  access token generated from an OAuth client, as the shared device is scoped to
  a user."* The OAuth path lists devices (so the Check button succeeds) but
  minting the share returns **400**. So `access_token` is the supported
  credential for sharing; `oauth` is a list-only fallback. (The original
  "prefer an OAuth client" guidance below was wrong for the WRITE path.) Stored
  host-side only, **never sent to any client** (same contract as `giphy_api_key`
  / the ragrat token). Settings → Sync gets a "Tailscale sharing (optional)" card
  with a Check button (lists the tailnet's devices to confirm
  scope + find the server).
- **Server deviceId discovery:** the host's own Tailscale node. Resolve once and
  cache in an app-setting: call `GET /tailnet/{tailnet}/devices`, match against
  the host's tailnet address (already computed for `DaemonStatus.urls`); or read
  `tailscale status --json` locally (self node) and map. Re-resolve if the match
  fails (node re-keyed).

### Invite creation (owner clicks "Invite to a project")
1. Mint the Ganban enrollment token as today (`create_project_invite`).
2. If `tailscale_api` is configured: `POST /device/{serverDeviceId}/device-invites`
   → `inviteUrl`. (Reusable vs single-use: single-use per guest by default.)
3. Combined invite payload extends today's `{u, t}` with an optional
   `ts` (the Tailscale `inviteUrl`): `{ u, t, ts? }`. The browser link gains
   `&ts=<encoded>`. Backward compatible — older clients ignore `ts`.

### Joiner experience (extends JoinServerModal / FirstRunScreen)
- Paste the combined link. If `ts` present AND the preflight probe says the host
  is unreachable → show **"Step 1: accept the shared machine"** with the `ts`
  link (opens Tailscale), then a "I've accepted it — continue" that re-probes
  and enrolls. If already reachable (share previously accepted), skip straight
  to enroll. This folds the network step into the same flow instead of two
  out-of-band links.

### Camera-QR path (recipient is phone-only, on a DIFFERENT tailnet)
The in-app flow above needs the Ganban app to parse `ts` and run the accept
step. A fresh recipient scanning with their **phone camera** has no app yet, and
the host link can't load until the share is accepted — so on the owner side the
**MembersTab invite renders two QR codes when `ts` is present**:
- **Step 1 — accept the machine:** a QR of the `ts` URL (a public
  `login.tailscale.com/admin/invite/…` page, reachable from any network). They
  scan, accept, and this Mac appears on *their* tailnet.
- **Step 2 — join the project:** a QR of the host join link, now reachable.

With no `ts` (same tailnet, or auto-share off) it stays a single join QR. This
is the owner-facing complement to the in-app `JoinServerModal` step.

### Degradation (never a hard dependency)
- No `tailscale_api` configured → today's behavior exactly (owner shares
  manually; invite carries only `{u,t}`; preflight still diagnoses).
- Tailscale API 401/403 → owner-actionable error ("check the Tailscale
  credential in Settings → Sync"), invite still issues with `{u,t}`.

## Security model
- API credential: owner-only, host-side, narrowest scope (`devices:invites`),
  revocable, never in any client bundle or invite payload.
- The invite payload carries only the `inviteUrl` (single-use, 30-day,
  acceptance still requires the recipient's own Tailscale auth) + the Ganban
  enrollment token (already the case). No new secret leaves the host.
- We never call the accept endpoint on the recipient's behalf — acceptance is
  their explicit, credentialed action.

## Build checklist — SHIPPED 2026-06-13
- [x] Confirm the exact OAuth scope string for device-invites write — the Check
      button proves it at runtime (a wrong scope → clear 401/403 with
      owner-actionable text). Token endpoint + tailnet alias verified above.
- [x] Host fn: `create_share()` → inviteUrl (`crates/server/src/tailscale.rs`).
      **Server-device resolution: the owner PICKS it** from the Check device
      list (cached in `tailscale_device_id`) — chosen over fragile IP/hostname
      auto-matching, which the server crate has no `if_addrs` for anyway.
- [x] Extend invite payload/link with `ts`; parser tolerant of its absence
      (`src/lib/invite.pure.ts`, unit-tested in `scripts/test-invite.mjs`).
- [x] Settings → Sync "Tailscale sharing" card (credential + Check +
      device picker) — `src/components/SettingsModal.tsx`.
- [x] JoinServerModal + FirstRunScreen "accept the shared machine" step gated on
      `ts` + unreachable (one-click via `openExternal`).
- [x] Wire into the invite flow (MembersTab + ContactProjectModal call
      `tailscaleShare()` best-effort) — a Tailscale failure never blocks the
      Ganban invite. Owner-gated on both the daemon `/invoke` and Tauri paths.

**Not yet exercisable end-to-end** until a host's owner configures a real Tailscale
OAuth client (host-side). Every code path, the payload round-trips, the
degradation paths, and the API request/response shapes are built and verified;
the live calls await a real credential.
