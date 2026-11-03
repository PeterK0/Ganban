/**
 * Host administration: pairing, invites, members, devices, Tailscale shares.
 * ON the host (desktop in local mode) these are Tauri `daemon_*` commands; from
 * any HOSTED client — the desktop in online mode OR a browser served by the
 * host — they go to the host's /invoke admin surface with this device's token.
 * The predicate is isHostedClient(), never "am I online": a browser has no
 * Tauri, and routing it to `invoke` was "Cannot read properties of undefined
 * (reading 'invoke')" on every owner action in the browser shell.
 */
import { invoke } from "@tauri-apps/api/core";
import { isHostedClient, daemonFetch } from "./daemon";

/** Route an owner action to the local daemon (Tauri invoke) when hosting, or to
 * the host's /invoke admin surface when this is a hosted client (online desktop
 * or browser). */
async function ownerInvoke<T>(localCmd: string, remoteCmd: string, args: Record<string, unknown>): Promise<T> {
  if (isHostedClient()) {
    return daemonFetch<T>("/invoke", { method: "POST", body: JSON.stringify({ command: remoteCmd, args }) });
  }
  return invoke<T>(localCmd, args);
}

export interface DaemonStatus {
  running: boolean;
  port: number | null;
  /** True while serving this machine only (the launch default). Hosting for
   * other devices = running && !loopback. */
  loopback: boolean;
  /** Reachable `http://host:port` URLs for clients, best first (Tailscale, LAN).
   * Empty while loopback-only. */
  urls: string[];
  /** Full host path of the build currently shared for each platform, or null. */
  android: string | null;
  windows: string | null;
  macos: string | null;
  linux: string | null;
  /** The standalone headless server build (self-host), if shared. */
  server: string | null;
}

export function daemonStatus(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("daemon_status");
}

/** Start (or widen to) tailnet/LAN hosting; `loopback: true` starts/keeps the
 * machine-only daemon the app itself uses. */
export function daemonStart(port?: number, loopback = false): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("daemon_start", { port, loopback });
}

export function daemonStop(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("daemon_stop");
}

/** Platform keys for shareable native builds. "server" = the standalone headless
 * self-host build (a download category, not a desktop auto-update target). */
export type BuildKind = "android" | "windows" | "macos" | "linux" | "server";

/** Per-platform FULL host path currently served at `/download` (null = not
 * shared). The full path, not just the file name, so the UI can match a
 * discovered build to the shared one without same-name collisions. */
export interface BuildShares {
  android: string | null;
  windows: string | null;
  macos: string | null;
  linux: string | null;
  server: string | null;
}

/** Share (path) or stop sharing (null) a native build for one platform, and
 * return what the host now serves. Dual-routed like createProjectInvite: local
 * invoke when hosting, the host's /invoke surface when this desktop is an online
 * client — so the owner can manage downloads from a remote machine too. The
 * build file always lives on the host; a remote owner picks from host-side
 * discovery (nothing is uploaded). */
export async function daemonSetBuild(kind: BuildKind, path: string | null): Promise<BuildShares> {
  if (isHostedClient()) {
    return daemonFetch<BuildShares>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "set_build", args: { kind, path } }),
    });
  }
  const s = await invoke<DaemonStatus>("daemon_set_build", { kind, path });
  return { android: s.android, windows: s.windows, macos: s.macos, linux: s.linux, server: s.server };
}

/** What the host currently serves at `/download`, per platform. Dual-routed so
 * a remote client reads the HOST's shares (not this laptop's local daemon). */
export async function sharedBuilds(): Promise<BuildShares> {
  if (isHostedClient()) {
    return daemonFetch<BuildShares>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "shared_builds", args: {} }),
    });
  }
  const s = await daemonStatus();
  return { android: s.android, windows: s.windows, macos: s.macos, linux: s.linux, server: s.server };
}

/** A build artifact found on disk (repo outputs + an optional folder). `kind` is
 * "" when the file's platform is ambiguous (a .zip, the server binary) and the
 * owner must assign it before it can be served. */
export interface DiscoveredBuild {
  kind: BuildKind | "";
  path: string;
  file_name: string;
  size: number;
}

/** Auto-discover built artifacts on the host (the host's standard Tauri output
 * dirs, plus an optional folder). Dual-routed: a remote client asks the host to
 * scan ITS disk (the only place the build files live). */
export async function daemonDiscoverBuilds(base?: string): Promise<DiscoveredBuild[]> {
  if (isHostedClient()) {
    return daemonFetch<DiscoveredBuild[]>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "discover_builds", args: { base } }),
    });
  }
  return invoke<DiscoveredBuild[]>("daemon_discover_builds", { base });
}

/** Owner mints a one-time token to enroll another of their own devices. Returns
 * the raw token. Works whether hosting locally OR connected to a remote daemon
 * (online), so you can pair a device from a laptop away from the host. */
export async function pairOwnerDevice(): Promise<string> {
  if (isHostedClient()) {
    const r = await daemonFetch<{ token: string }>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "create_device_enrollment", args: {} }),
    });
    return r.token;
  }
  return invoke<string>("pair_owner_device");
}

/** Mint a one-time invite to a project. Dual-routed: local invoke when hosting,
 * else the remote daemon's /invoke admin surface — so an owner/admin can invite
 * people to the server's projects from a laptop that isn't the host. The remote
 * returns {token}; the local command returns a raw string — normalized here. */
export async function createProjectInvite(projectId: number, role: string, displayName?: string): Promise<string> {
  if (isHostedClient()) {
    const r = await daemonFetch<{ token: string }>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "create_invite", args: { projectId, role, displayName } }),
    });
    return r.token;
  }
  return invoke<string>("create_project_invite", { projectId, role, displayName });
}

// ---- Member & device management (owner, local invoke) ----

export interface MemberInfo {
  user_id: number;
  username: string;
  display_name: string;
  role: string;
}

export interface DeviceInfo {
  id: number;
  device_label: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export function memberList(projectId: number): Promise<MemberInfo[]> {
  return ownerInvoke<MemberInfo[]>("member_list", "list_members", { projectId });
}

export function memberSetRole(projectId: number, userId: number, role: string): Promise<void> {
  return ownerInvoke<void>("member_set_role", "set_member_role", { projectId, userId, role });
}

export function memberRemove(projectId: number, userId: number): Promise<void> {
  return ownerInvoke<void>("member_remove", "remove_member", { projectId, userId });
}

export function deviceList(userId: number): Promise<DeviceInfo[]> {
  return ownerInvoke<DeviceInfo[]>("device_list", "list_devices", { userId });
}

export function deviceRevoke(tokenId: number): Promise<void> {
  return ownerInvoke<void>("device_revoke", "revoke_device", { tokenId });
}

/** Invite a contact to a project: mints a join link targeting their account
 * (created+linked if needed) so accepting reuses their identity. Returns the raw
 * token. Normalizes the local (raw String) vs remote ({token}) return shapes. */
export async function contactInvite(contactId: number, projectId: number, role: string): Promise<string> {
  if (isHostedClient()) {
    const r = await daemonFetch<{ token: string }>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "contact_invite", args: { contactId, projectId, role } }),
    });
    return r.token;
  }
  return invoke<string>("contact_invite", { contactId, projectId, role });
}

/** OWNER: mint a one-time code that enrols a new device as ANOTHER member —
 * recovery for someone with no signed-in device left. Enrolling resolves to
 * their existing account. Dual-routed like pairOwnerDevice. */
export async function pairMemberDevice(userId: number): Promise<string> {
  if (isHostedClient()) {
    const r = await daemonFetch<{ token: string }>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "create_member_device_enrollment", args: { userId } }),
    });
    return r.token;
  }
  return invoke<string>("pair_member_device", { userId });
}

/** Add an already-account-linked contact to a project directly (no re-invite). */
export function contactAddToProject(contactId: number, projectId: number, role: string): Promise<void> {
  return ownerInvoke<void>("contact_add_to_project", "contact_add_to_project", { contactId, projectId, role });
}

// The QR/link builders are pure (invite.pure.ts) so they unit-test; re-exported
// here so existing `from './host'` importers are unaffected. Both now take an
// optional Tailscale share url (auto-share).
export { enrollQr, inviteLink } from "./invite.pure";

/** Ask the host to mint a one-time Tailscale device-share invite (auto-share).
 * Owner-only, best-effort: returns the inviteUrl or null and NEVER throws (all
 * errors are caught here) — so a Tailscale problem can never block the Ganban
 * invite. The returned `ts` is a public single-use URL, never the credential.
 * Callers fold it into the invite link if present and otherwise proceed exactly
 * as before. Dual-routed like createProjectInvite (local host invoke vs. a
 * remote admin laptop's /invoke) so either can drive the host's share. */
export interface ShareResult {
  ts: string | null;
  error: string | null;
  /** Set when a share was minted with a raw token and Tailscale told us its expiry. */
  tokenExpiry: TokenExpiry | null;
}

export async function tailscaleShare(): Promise<ShareResult> {
  try {
    type Raw = { ts: string | null; error?: string; token_expiry?: TokenExpiry | null };
    const r = isHostedClient()
      ? await daemonFetch<Raw>("/invoke", {
          method: "POST",
          body: JSON.stringify({ command: "tailscale_share", args: {} }),
        })
      : await invoke<Raw>("tailscale_share");
    // ts present = share minted; error present = configured but the API rejected
    // it (an expired token above all). Both are surfaced so the owner sees why a
    // share didn't attach — never throws, so a Tailscale hiccup can't block the
    // Ganban invite.
    return { ts: r.ts ?? null, error: r.error ?? null, tokenExpiry: r.token_expiry ?? null };
  } catch (e) {
    return { ts: null, error: e instanceof Error ? e.message : String(e), tokenExpiry: null };
  }
}

/** Lifecycle of a minted invite/pairing token, for the QR diagnostics panel. */
export interface InviteStatus {
  /** "pending" (live, unredeemed), "joined", "expired", or "unknown". */
  state: "pending" | "joined" | "expired" | "unknown";
  kind?: string | null;
  project_id?: number | null;
  created_at?: string | null;
  expires_at?: string | null;
  consumed_at?: string | null;
  /** Display name of whoever completed the join, when resolvable. */
  joined_name?: string | null;
}

/** Poll an invite/pairing token's lifecycle so the inviter can see "pending →
 * joined" instead of guessing. Owner/admin-only (gated host-side). Dual-routed:
 * local invoke when hosting, the host's /invoke surface when an online client. */
export async function inviteStatus(token: string): Promise<InviteStatus> {
  if (isHostedClient()) {
    return daemonFetch<InviteStatus>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "invite_status", args: { token } }),
    });
  }
  return invoke<InviteStatus>("invite_status", { token });
}

/** One row of the pending-invites list (an enrollment token + resolved names). */
export interface InviteSummary {
  id: number;
  kind: string;
  state: "pending" | "joined" | "expired";
  project_id?: number | null;
  project_name?: string | null;
  role?: string | null;
  display_name?: string | null;
  joined_name?: string | null;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
}

/** List enrollment tokens for review/revoke — global (owner) or scoped to one
 * project (that project's admin). Dual-routed (local invoke vs the host's
 * /invoke). Owner/admin-gated host-side; callers should tolerate a 403. */
export async function listInvites(projectId?: number): Promise<InviteSummary[]> {
  if (isHostedClient()) {
    return daemonFetch<InviteSummary[]>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "list_invites", args: { projectId } }),
    });
  }
  return invoke<InviteSummary[]>("list_invites", { projectId });
}

/** Revoke (delete) a pending invite token so it can't be redeemed. Already-joined
 * members keep their access (their device token is separate). Dual-routed. */
export async function revokeInvite(id: number): Promise<void> {
  if (isHostedClient()) {
    await daemonFetch<null>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "revoke_invite", args: { id } }),
    });
    return;
  }
  await invoke<void>("revoke_invite", { id });
}

/** One tailnet device as returned by the Settings "Check" button. */
export interface TailscaleDevice {
  id: string;
  name: string | null;
  hostname: string | null;
  os: string | null;
  addresses: string[] | null;
}

/** Result of the Settings "Check": the tailnet's devices, plus the WRITE-path
 * verdict — `share_capable` is false (with a `share_detail` reason) when the
 * credential can list devices but can't mint a device share (an OAuth client),
 * so the UI can flag that misconfig instead of letting it pass silently and only
 * fail later at invite time. `share_capable` is absent on older hosts; callers
 * must treat only an explicit `false` as a warning. */
/** When the Tailscale access token runs out. Tailscale caps personal API
 * tokens at 90 days; without this the first sign was a 401 at invite time. */
export interface TokenExpiry {
  expires: string;
  days_left: number;
}

export interface TailscaleCheckResult {
  tailnet: string;
  devices: TailscaleDevice[];
  share_capable?: boolean;
  share_detail?: string | null;
  token_expiry?: TokenExpiry | null;
}

/** Days ≤ this → invite panels and Settings warn to renew. */
export const TOKEN_RENEW_WARN_DAYS = 14;

/** A one-line renewal note when the token is in its last weeks, else null. */
export function tokenRenewNote(exp: TokenExpiry | null | undefined): string | null {
  if (!exp) return null;
  if (exp.days_left < 0) return 'The Tailscale access token has expired — renew it in Settings → Sync → Tailscale.';
  if (exp.days_left > TOKEN_RENEW_WARN_DAYS) return null;
  const when = exp.days_left === 0 ? 'today' : exp.days_left === 1 ? 'tomorrow' : `in ${exp.days_left} days`;
  return `The Tailscale access token expires ${when} — after that, invites can't carry a machine-share until you renew it in Settings → Sync → Tailscale.`;
}

/** Validate the Tailscale credential and list the tailnet's devices so the
 * owner can pick which one is this server (owner-only). Dual-routed. Throws on a
 * bad/unconfigured credential so the Settings card can show the reason. */
export async function tailscaleCheck(): Promise<TailscaleCheckResult> {
  if (isHostedClient()) {
    return daemonFetch<TailscaleCheckResult>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "tailscale_check", args: {} }),
    });
  }
  return invoke<TailscaleCheckResult>("tailscale_check");
}
