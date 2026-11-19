// "The host has a newer Ganban than the one you're looking at." Shown only to
// WEB clients (their bundle comes from the host); checks at boot and whenever
// the page becomes visible again after ≥ 10 min away — a Home Screen app that
// was left open overnight. One tap reloads past the cache; "See what changed" first shows the
// new build's patch notes (its /patch-notes.json), what the reload brings. Never reloads by itself.
import { useEffect, useState } from 'react';
import { isWebClient } from '../lib/daemon';
import { isStale } from '../lib/build';
import { servedPatchNotes } from '../lib/patchNotes';
import type { PatchRelease } from '../lib/patchNotes.pure';
import { PatchNotesDialog, offeredNotes } from './PatchNotes';

export default function StaleBuildBanner() {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // The new build's notes: undefined until asked, null when the host couldn't say.
  const [notes, setNotes] = useState<PatchRelease[] | null | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isWebClient()) return;
    const origin = window.location.origin;
    let last = 0;
    const check = async () => {
      last = Date.now();
      if (await isStale(origin)) setStale(true);
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60_000) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!stale || dismissed) return null;
  return (
    <div
      className="fixed left-0 right-0 z-[90] flex items-center justify-center gap-3 px-4 py-2 text-sm bg-crust text-text border-b border-gilt-a shadow-lg"
      style={{ top: 'env(safe-area-inset-top)' }}
      role="status"
    >
      <span>A newer Ganban is on the host.</span>
      <button
        className="g-lnk"
        onClick={() => {
          setOpen(true);
          void servedPatchNotes(window.location.origin).then(setNotes);
        }}
      >
        See what changed
      </button>
      <button
        onClick={() => window.location.reload()}
        className="g-btn g-btn-gilt g-btn-sm"
      >
        Reload
      </button>
      <button onClick={() => setDismissed(true)} className="g-iconbtn" style={{ width: 32, height: 32 }} aria-label="Dismiss">
        ✕
      </button>
      {open && (
        <PatchNotesDialog
          title="A newer Ganban is on the host"
          lead={
            notes === undefined
              ? 'Loading its patch notes…'
              : notes === null
                ? "Couldn't load its patch notes. Reload to get it anyway."
                : 'What reloading brings:'
          }
          releases={notes ? offeredNotes(notes, 'Unreleased') : []}
          empty={notes ? 'No patch notes for this build.' : null}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setOpen(false)}>
                Later
              </button>
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
