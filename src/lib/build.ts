// Which build am I, and is the host serving a newer one?
//
// `dist/` is not in git: `git pull` never changes the web UI, only `npm run
// build` does — and even then a browser (a Home Screen app above all) may keep
// yesterday's index.html for hours. Both failures look identical from the
// phone: "the feature you described isn't there". The stamp makes them
// visible; the check turns the second into a one-tap reload.

export const BUILD: { hash: string; at: string } =
  typeof __GANBAN_BUILD__ !== 'undefined' ? __GANBAN_BUILD__ : { hash: 'dev', at: '' };

/** "abc1234 · 10 Sep 2026" — for Settings footers and the Join screens. */
export function buildLabel(): string {
  const d = BUILD.at ? new Date(BUILD.at) : null;
  const when = d && !isNaN(d.getTime()) ? ` · ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}` : '';
  return `${BUILD.hash}${when}`;
}

/** The build the host is serving RIGHT NOW (bypassing every cache), or null
 * when it can't be read (old host without build.json, offline). Only
 * meaningful for a web client — a native app's bundle isn't served by the host. */
export async function servedBuild(origin: string): Promise<{ hash: string; at: string } | null> {
  try {
    const r = await fetch(`${origin.replace(/\/+$/, '')}/build.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { hash?: unknown; at?: unknown };
    return typeof j.hash === 'string' ? { hash: j.hash, at: typeof j.at === 'string' ? j.at : '' } : null;
  } catch {
    return null;
  }
}

/** True when the host serves a different build than the one running here. */
export async function isStale(origin: string): Promise<boolean> {
  if (BUILD.hash === 'dev') return false;
  const served = await servedBuild(origin);
  return !!served && served.hash !== BUILD.hash;
}
