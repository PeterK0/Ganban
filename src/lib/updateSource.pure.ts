// Where this device's app updates from (docs/design/UPDATES.md § The update source): GitHub
// Releases or This server, chosen per device in Settings → Updates. The build's channel only sets
// the default. Pure, so scripts/test-update-source.mjs can test it: the choice, each source's
// availability, the desktop's host key pin, the phone's certificate match, and the Android
// version codes both kinds of build share.
import type { UpdateChannel } from './update.pure';

export type UpdateSource = 'github' | 'host';

/** The source a build updates from until the device chooses: its channel's. A dev build
 * (no channel) has none. */
export function defaultSource(channel: UpdateChannel): UpdateSource | null {
  if (channel.kind === 'host') return 'host';
  if (channel.kind === 'github' || channel.kind === 'github-broken') return 'github';
  return null;
}

/** The device's stored choice, else the channel's default. */
export function chosenSource(stored: string | null | undefined, channel: UpdateChannel): UpdateSource | null {
  const def = defaultSource(channel);
  if (!def) return null;
  return stored === 'github' || stored === 'host' ? stored : def;
}

/** Whether `source` is the other channel's (a host build on GitHub, or the reverse). The
 * desktop then accepts any different version, since the two kinds of number don't compare. */
export function isCrossSource(source: UpdateSource, channel: UpdateChannel): boolean {
  const def = defaultSource(channel);
  return !!def && source !== def;
}

/** One source as Settings shows it: whether it can be chosen, its latest version when
 * known, and why not when it can't. */
export interface SourceStatus {
  available: boolean;
  latest: string | null;
  why: string | null;
}

// ---- The desktop's key for This server ------------------------------------------
// The host advertises its updater public key (`get_client_builds().desktop.pubkey`). The
// device pins the first one it trusts; a different one later asks before it's trusted.

/** A minisign public key's id, as its comment says (`minisign public key: E2AABA5857DB92BF`),
 * the short fingerprint Settings shows. Null when it isn't a minisign key. */
export function keyFingerprint(pubkeyB64: string | null | undefined): string | null {
  const k = (pubkeyB64 ?? '').trim();
  if (!k) return null;
  let text: string;
  try {
    text = atob(k);
  } catch {
    return null;
  }
  const m = /minisign public key:?\s*([0-9A-F]{16})/i.exec(text);
  return m ? m[1].toUpperCase() : null;
}

export type PinDecision =
  /** The host advertises no key (an older host, or no desktop build yet). */
  | { kind: 'unknown' }
  /** Nothing pinned yet: trust it now and show its fingerprint. */
  | { kind: 'first'; key: string }
  | { kind: 'trusted'; key: string }
  /** It changed since the pin: ask before trusting it. */
  | { kind: 'changed'; key: string; was: string };

/** Decide about the host's advertised key. `pinned` is the device's pin, else the key a host
 * build was made with (it trusts its own host). */
export function decideHostKey(pinned: string | null | undefined, advertised: string | null | undefined): PinDecision {
  const adv = (advertised ?? '').trim();
  const pin = (pinned ?? '').trim();
  if (!adv) return pin ? { kind: 'trusted', key: pin } : { kind: 'unknown' };
  if (!pin) return { kind: 'first', key: adv };
  return pin === adv ? { kind: 'trusted', key: adv } : { kind: 'changed', key: adv, was: pin };
}

// ---- The phone's certificate match ------------------------------------------------
// An APK installs only over an app signed with the same certificate, so a source is
// offered only when its certificate is one the installed app is signed with.

/** A SHA-256 fingerprint as 64 lowercase hex digits (keytool's colons and spaces go), or null. */
export function normCert(s: string | null | undefined): string | null {
  const hex = (s ?? '').replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export type CertMatch = 'match' | 'mismatch' | 'unknown';

export function certMatch(own: readonly string[] | null | undefined, source: string | null | undefined): CertMatch {
  const src = normCert(source);
  const mine = (own ?? []).map(normCert).filter((c): c is string => !!c);
  if (!src || mine.length === 0) return 'unknown';
  return mine.includes(src) ? 'match' : 'mismatch';
}

/** Why a source's APK can't be offered, from the certificate match; null when it can. */
export function certReason(match: CertMatch, source: UpdateSource): string | null {
  const name = source === 'github' ? 'GitHub Releases' : 'this server';
  if (match === 'match') return null;
  if (match === 'unknown') {
    return source === 'github'
      ? "This build doesn't know GitHub Releases' signing certificate, so it can't tell whether its app installs over this one."
      : "The server doesn't say which certificate signs its app (update the server first), so it can't tell whether it installs over this one.";
  }
  return `The app from ${name} is signed with another certificate, so Android won't install it over this one. Switching needs a one-time reinstall: uninstall Ganban, then install the app from ${name}.`;
}

// ---- Android version codes ----------------------------------------------------------
// The same formulas as ops/version-code.mjs (the test checks both): a host build sorts between
// the release it follows and the next, so a phone can move either way when the codes allow.

export const FIRST_SCALED: readonly [number, number, number] = [1, 0, 10];

function vparts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A GitHub release's Android version code: (major·1000000 + minor·1000 + patch)·1000 from 1.0.10
 * on, without the ·1000 before. 0 for a tag that isn't a version. */
export function releaseVersionCode(version: string): number {
  const p = vparts(version);
  if (!p) return 0;
  const base = p[0] * 1_000_000 + p[1] * 1_000 + p[2];
  let scaled = true;
  for (let i = 0; i < 3; i++) {
    if (p[i] !== FIRST_SCALED[i]) {
      scaled = p[i] > FIRST_SCALED[i];
      break;
    }
  }
  return scaled ? base * 1000 : base;
}

/** A host build's code: the release it follows ·1000, plus the commits since (at most 999). */
export function hostVersionCode(releaseVersion: string, commits: number): number {
  const p = vparts(releaseVersion);
  if (!p) return 0;
  return (p[0] * 1_000_000 + p[1] * 1_000 + p[2]) * 1000 + Math.max(0, Math.min(999, Math.floor(commits)));
}

/** A source's Android build against the installed app's code: newer installs; older can't
 * (Android never installs a smaller code). */
export function compareCodes(installed: number, offered: number | null | undefined): 'no-build' | 'available' | 'up-to-date' | 'older' {
  if (!offered || !Number.isFinite(offered) || offered <= 0) return 'no-build';
  if (offered > installed) return 'available';
  return offered === installed ? 'up-to-date' : 'older';
}
