// Self-service device management for ANY signed-in user, over the daemon.
//
// Identity in Ganban is a device token, not a password (SELF_HOSTING.md
// "Security model"). A person is one user with MANY devices; each device
// enrols once. Losing a device — or iOS quietly giving a home-screen web app
// its own storage silo — must therefore never mean losing the ACCOUNT: from
// any device that's still signed in you mint a one-time pairing code for
// yourself, and the new device joins as the same user. The server pins the
// code to the caller's own user id, so it can never target anyone else.

import { daemonFetch, currentDaemonUrl } from "./daemon";
import { enrollQr, inviteLink } from "./invite.pure";

export interface DeviceInfo {
  id: number;
  device_label: string | null;
  created_at: string;
  last_seen_at: string | null;
  /** The device making this request. */
  current: boolean;
}

async function inv<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return daemonFetch<T>("/invoke", { method: "POST", body: JSON.stringify({ command, args }) });
}

export function listMyDevices(): Promise<DeviceInfo[]> {
  return inv<DeviceInfo[]>("list_my_devices");
}

export function revokeMyDevice(tokenId: number): Promise<void> {
  return inv<void>("revoke_device", { tokenId });
}

export interface PairingCode {
  /** The raw one-time token — paste into another device's Join screen. */
  code: string;
  /** Open on the other device's browser: enrols as you. */
  link: string;
  /** What the native phone app's scanner expects. */
  qr: string;
}

/** Mint a one-time code that enrols ANOTHER device as the caller. Single use,
 * expires (server TTL); the host is this client's own daemon. */
export async function pairAnotherDevice(): Promise<PairingCode> {
  const { token } = await inv<{ token: string }>("create_device_enrollment");
  const url = currentDaemonUrl() ?? (typeof window !== "undefined" ? window.location.origin : "");
  return { code: token, link: inviteLink(url, token), qr: enrollQr(url, token) };
}
