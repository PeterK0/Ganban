// This build's patch notes, bundled from CHANGELOG.md at build time so they work offline
// (vite.config.ts also emits them as /patch-notes.json, which an open browser tab reads to see
// what a newer build on the host brings). The parser: patchNotes.pure.ts.
//
// "What's new" after an update is by entry, not by version (between two host builds the
// heading stays "Unreleased"): the device remembers which entries it has seen. That's a
// cosmetic preference, so localStorage. A device with no record is a first install: it
// records everything and shows nothing.
import { useSyncExternalStore } from 'react';
import changelog from '../../CHANGELOG.md?raw';
import { allEntryIds, currentRelease, hostBuildNotes, parsePatchNotes, unseenEntryIds, type PatchRelease } from './patchNotes.pure';

export const BUNDLED_NOTES: PatchRelease[] = parsePatchNotes(changelog);

/** This build's own release (Unreleased between releases). */
export const THIS_RELEASE = currentRelease(BUNDLED_NOTES);

const SEEN_KEY = 'ganban.patchNotes.seen';
/** Enough for years of entries; the oldest drop off first. */
const SEEN_MAX = 3000;

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return null;
  }
}

function writeSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-SEEN_MAX)));
  } catch {
    /* private mode: asked again next time */
  }
}

/** The bundled entries this device hasn't seen. A first install records them all, and gets none. */
function computeUnseen(): string[] {
  const seen = readSeen();
  if (seen == null) {
    writeSeen(allEntryIds(BUNDLED_NOTES));
    return [];
  }
  return unseenEntryIds(BUNDLED_NOTES, seen);
}

let unseen: string[] | null = null;
const listeners = new Set<() => void>();
const getUnseen = () => (unseen ??= computeUnseen());

/** The entries that are new to this device since its last "What's new", live. */
export function useUnseenEntries(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getUnseen,
    getUnseen,
  );
}

/** "What's new" was seen: never shown again for these entries. */
export function markPatchNotesSeen() {
  const seen = readSeen() ?? [];
  const have = new Set(seen);
  writeSeen([...seen, ...allEntryIds(BUNDLED_NOTES).filter((id) => !have.has(id))]);
  unseen = [];
  listeners.forEach((l) => l());
}

/** The QA preview (`?preview=update-offer` / `update-ready` / `whats-new`, docs/dev/TESTING.md):
 * shows the update offer (or its downloaded step) or "What's new" with sample data, without the updater. */
export function previewMode(): 'update-offer' | 'update-ready' | 'whats-new' | null {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search).get('preview');
  return p === 'update-offer' || p === 'update-ready' || p === 'whats-new' ? p : null;
}

/** Sample notes for the preview: what a host build made from this checkout would carry. */
export const SAMPLE_OFFER_NOTES = hostBuildNotes(changelog);

/** A newer build's notes, as the host serves them (`/patch-notes.json`, never cached), or null. */
export async function servedPatchNotes(origin: string): Promise<PatchRelease[] | null> {
  try {
    const res = await fetch(`${origin}/patch-notes.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const v = (await res.json()) as { releases?: PatchRelease[] };
    return Array.isArray(v.releases) ? v.releases : null;
  } catch {
    return null;
  }
}
