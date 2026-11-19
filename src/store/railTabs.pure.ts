// Pure helpers for the rail switches store (railTabs.ts), kept apart so a node suite can test them.

/** A load's switches, merged over what's on screen: a switch whose flip was saved after the load
 * started, or is still saving, keeps its on-screen value (`setAt[id]` is the load counter when the
 * save finished, Infinity while it runs). Without this, a reload that returned after a click
 * flipped the switch back. */
export function mergeLoadedSwitches(
  loaded: Record<string, boolean>,
  current: Record<string, boolean>,
  setAt: Record<string, number>,
  loadGen: number,
): Record<string, boolean> {
  const out = { ...loaded };
  for (const [id, gen] of Object.entries(setAt)) {
    if (gen >= loadGen && id in current) out[id] = current[id];
  }
  return out;
}
