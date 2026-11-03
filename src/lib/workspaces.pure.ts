// Dependency-free workspace logic (no browser/daemon imports) so it can be
// unit-tested directly. workspaces.ts re-exports these.

export const LOCAL_ID = 'local';

export interface Workspace {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  url: string | null;
  token: string | null;
}

/** Deterministic id from a URL so re-joining the same host de-dupes. */
export function stableRemoteId(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return `ws-${(h >>> 0).toString(36)}`;
}

/** The one-time migration decision from the legacy single-connection globals.
 * Idempotent: returns null once migrated. An online enrollment becomes a
 * registered remote (still active); otherwise stay on local, remembering a
 * loopback URL if present. */
export function planMigration(input: {
  migrated: boolean;
  transportMode: 'local' | 'online';
  daemonUrl: string | null;
  token: string | null;
}): { active: string; seedRemote?: { url: string; token: string }; localUrl?: string } | null {
  if (input.migrated) return null;
  if (input.transportMode === 'online' && input.daemonUrl && input.token) {
    return {
      active: stableRemoteId(input.daemonUrl.replace(/\/+$/, '')),
      seedRemote: { url: input.daemonUrl, token: input.token },
    };
  }
  const localUrl =
    input.daemonUrl && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(input.daemonUrl)
      ? input.daemonUrl
      : undefined;
  return { active: LOCAL_ID, localUrl };
}
