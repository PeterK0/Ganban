// Pure, dependency-free invite/pairing payload helpers — so they unit-test
// without a DOM or Tauri (same pattern as workspaces.pure.ts). daemon.ts and
// host.ts re-export these, so importers are unaffected by the move.
//
// The invite link/QR carries the daemon URL (u) + a one-time enrollment token
// (t), and — when the host has Tailscale auto-share configured — an optional
// Tailscale device-share URL (ts) so one link folds the network join and the
// app join together. `ts` is always optional: older links/clients omit it and
// everything still works (the recipient shares the machine out-of-band).

/** Payload encoded in a desktop pairing/invite QR or link. */
export interface EnrollPayload {
  u: string; // daemon URL
  t: string; // one-time enrollment token
  ts?: string; // optional Tailscale device-share inviteUrl (auto-share)
}

/** A tailnet-only host address — either a Tailscale CGNAT IP (100.64.0.0/10) or a
 * MagicDNS name (`host.tailnet.ts.net`). Both are reachable only from a device
 * that is on, or has accepted a share of, the host's tailnet — so an invite using
 * either needs the recipient to join/accept first. (We now prefer the MagicDNS
 * FQDN in invites because it survives the host's tailnet IP changing, so the gate
 * and unreachable-diagnosis must recognise it too, not just the raw 100.x.) */
export function isTailnetUrl(url: string): boolean {
  const u = url.trim();
  return /^https?:\/\/100\./i.test(u) || /^https?:\/\/[^/:\s]+\.ts\.net(?::\d+)?(?:[/#?]|$)/i.test(u);
}

/** Turn "host unreachable" into actionable guidance instead of a bare timeout —
 * the "we spent 10 minutes and his device wasn't showing" problem. A tailnet
 * address that doesn't answer almost always means the recipient hasn't accepted
 * the shared machine yet. */
export function diagnoseUnreachable(url: string): string {
  const u = url.trim();
  if (isTailnetUrl(u)) {
    return `Can't reach the host at ${u}. That's a Tailscale (tailnet) address — this device has to accept the shared machine before anything there is reachable. Ask the host's owner to share the server with you (they get a Tailscale invite link to send), accept it on THIS device, then hit "Try again". This step is one-time.`;
  }
  if (/^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u)) {
    return `Can't reach the host at ${u}. That's a local-network address — it only works while you're on the same Wi-Fi/LAN as the host.`;
  }
  return `Can't reach the host at ${u}. Double-check the address and that the host's Ganban is running.`;
}

/** Build the QR payload the mobile app parses for enrollment. An optional
 * Tailscale share url rides alongside so one scan can fold the network join. */
export function enrollQr(url: string, token: string, ts?: string): string {
  const p: EnrollPayload = { u: url, t: token };
  if (ts) p.ts = ts;
  return JSON.stringify(p);
}

/** A Tailscale machine-share invite link, as the admin console (Machines → the
 * host → Share → Generate invite link) or the API hands it out. Accepting one
 * puts ONLY that machine on the recipient's tailnet — the primitive the whole
 * cross-tailnet invite rests on. Pasting one by hand needs no API token. */
export function parseTailscaleShareLink(raw: string): string | null {
  const s = raw.trim();
  if (!/^https:\/\/login\.tailscale\.com\/(admin\/)?invite\/[A-Za-z0-9_-]+/.test(s)) return null;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

/** What a person pastes into a Join screen is whatever they were GIVEN — a bare
 * code, the full invite/pairing link (`…/#invite=<code>&ts=…`), or the text of a
 * pairing QR (`{"u":…,"t":…}`). Accept all three and hand back the code. The
 * owner's UI produces LINKS; a field that only took the bare token made people
 * ask where the "code generator" was. */
export function extractEnrollToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const qr = parseEnrollPayload(s);
  if (qr) return qr.t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const fromHash = new URLSearchParams(u.hash.replace(/^#/, "")).get("invite");
      const fromQuery = u.searchParams.get("invite");
      const t = (fromHash ?? fromQuery ?? "").trim();
      return t || null;
    } catch {
      return null;
    }
  }
  // A bare code: one opaque token, no whitespace inside.
  return /\s/.test(s) ? null : s;
}

/** Build a browser invite link: open it on any device to join with no install
 * (the daemon serves the touch UI). The one-time token rides in the URL
 * *fragment* so it never reaches the daemon's access logs or a Referer header;
 * an optional Tailscale share url rides alongside it as `ts`. */
export function inviteLink(url: string, token: string, ts?: string): string {
  const base = `${url.replace(/\/+$/, "")}/#invite=${encodeURIComponent(token)}`;
  return ts ? `${base}&ts=${encodeURIComponent(ts)}` : base;
}

/** Parse a scanned QR into an enrollment payload, if it is one. */
export function parseEnrollPayload(raw: string): EnrollPayload | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.u === "string" && typeof obj.t === "string") {
      const p: EnrollPayload = { u: obj.u, t: obj.t };
      if (typeof obj.ts === "string" && obj.ts) p.ts = obj.ts;
      return p;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Parse either a pairing QR ({u,t,ts?}) or a pairing/invite LINK
 * (`http://host:port/#invite=TOKEN[&ts=URL]` or `?invite=`) into a payload. */
export function parseInviteLink(raw: string): EnrollPayload | null {
  const s = raw.trim();
  const fromQr = parseEnrollPayload(s);
  if (fromQr) return fromQr;
  const m = s.match(/^(https?:\/\/[^/\s]+)\/?[#?].*?invite=([^&\s]+)/i);
  if (!m) return null;
  const p: EnrollPayload = { u: m[1], t: decodeURIComponent(m[2]) };
  const tsm = s.match(/[#?&]ts=([^&\s]+)/i);
  if (tsm) p.ts = decodeURIComponent(tsm[1]);
  return p;
}
