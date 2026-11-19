// Patch notes on screen: the list (Settings → Updates → Patch notes, "What's new", the update
// offers), and the "What's new" notice shown once after an update. The notes come from
// CHANGELOG.md (src/lib/patchNotes.pure.ts parses them; src/lib/patchNotes.ts bundles this build's).
import { useState, type ReactNode } from 'react';
import { Modal } from './gilt';
import ScrollArea from './ScrollArea';
import { inlineParts, entriesNotIn, onlyEntries, parsePatchNotes, type PatchRelease } from '../lib/patchNotes.pure';
import { BUNDLED_NOTES, THIS_RELEASE, markPatchNotesSeen, previewMode, useUnseenEntries } from '../lib/patchNotes';

/** An entry's text: bold leads, code, links as their label. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((p, i) =>
        p.kind === 'bold' ? (
          <strong key={i} className="font-semibold text-text">
            {p.text}
          </strong>
        ) : p.kind === 'code' ? (
          <code key={i} className="font-mono text-[0.92em]">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const releaseTitle = (r: PatchRelease) => (r.version === 'Unreleased' ? 'Since the last release' : `Ganban ${r.version}`);

/** Releases, newest first. `newIds` get a "New" mark; `current` (a release) a "This version" one. */
export function PatchNotesList({
  releases,
  newIds,
  current,
  empty = 'No patch notes.',
}: {
  releases: PatchRelease[];
  newIds?: readonly string[];
  current?: PatchRelease | null;
  /** What to say when there are none (null: nothing). */
  empty?: string | null;
}) {
  const fresh = new Set(newIds ?? []);
  const shown = releases.filter((r) => r.sections.some((s) => s.entries.length));
  if (!shown.length) return empty ? <p className="text-sm text-subtext-0">{empty}</p> : null;
  return (
    <div className="space-y-5">
      {shown.map((r, ri) => (
        <section key={`${r.version}-${ri}`} className="space-y-2">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-text">{releaseTitle(r)}</h3>
            {r.date && <span className="text-xs text-subtext-0 tabular-nums">{r.date}</span>}
            {current && r.version === current.version && <span className="g-tag g-tag-pri">This version</span>}
          </div>
          {r.intro && (
            <p className="text-sm text-subtext-1">
              <Inline text={r.intro} />
            </p>
          )}
          {r.sections
            .filter((s) => s.entries.length)
            .map((s, si) => (
              <div key={si} className="space-y-1">
                {s.kind && <div className="g-cap">{s.kind}</div>}
                <ul className="list-disc pl-5 space-y-1.5 text-sm text-subtext-1">
                  {s.entries.map((e) => (
                    <li key={e.id}>
                      {fresh.has(e.id) && <span className="g-tag g-tag-ok mr-1.5 align-[1px]">New</span>}
                      <Inline text={e.text} />
                      {e.sub.length > 0 && (
                        <ul className="list-[circle] pl-5 mt-1 space-y-1">
                          {e.sub.map((t, i) => (
                            <li key={i}>
                              <Inline text={t} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}

/** What an update brings: the offered notes' entries this build doesn't carry, else all of them.
 * `notes` is markdown (a release's section, or a host build's Unreleased and last release). */
export function offeredNotes(notes: string | PatchRelease[] | null | undefined, version: string): PatchRelease[] {
  const offered = typeof notes === 'string' || notes == null ? parsePatchNotes(notes, version) : notes;
  const fresh = entriesNotIn(offered, BUNDLED_NOTES);
  return fresh.length ? onlyEntries(offered, fresh) : offered;
}

/** A dialog with patch notes, scrolling, and the caller's buttons below. */
export function PatchNotesDialog({
  title,
  lead,
  releases,
  newIds,
  current,
  onClose,
  actions,
  empty,
}: {
  title: ReactNode;
  lead?: ReactNode;
  releases: PatchRelease[];
  newIds?: readonly string[];
  current?: PatchRelease | null;
  onClose: () => void;
  actions: ReactNode;
  /** With no notes: what to say (default "No patch notes."), or null to show no notes section. */
  empty?: string | null;
}) {
  const none = empty === null && !releases.some((r) => r.sections.some((s) => s.entries.length));
  return (
    <Modal onClose={onClose} title={title} className="w-[min(640px,calc(100vw-24px))] max-h-[min(80vh,720px)]">
      {lead && <div className="flex-none px-6 pt-1 text-sm text-subtext-0">{lead}</div>}
      {none ? (
        <div className="flex-none h-4" />
      ) : (
        <>
          <div className="flex-none px-6 pt-3 g-cap">Patch notes</div>
          <ScrollArea className="flex-1 min-h-0" contentClassName="px-6 py-3">
            <PatchNotesList releases={releases} newIds={newIds} current={current} empty={empty} />
          </ScrollArea>
        </>
      )}
      <div className="flex-none flex flex-wrap items-center justify-end gap-2 px-6 pt-3 pb-5 border-t border-gilt-b">{actions}</div>
    </Modal>
  );
}

/** Once after an update: a quiet "What's new" in the top bar. It opens the notes with the new
 * entries marked; either way it's dismissed for good. Never on a first install. */
export function WhatsNewNotice({ className = 'g-tag g-tag-ok shrink-0 inline-flex items-center gap-1.5' }: { className?: string }) {
  const unseen = useUnseenEntries();
  const preview = previewMode() === 'whats-new';
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const ids = preview ? THIS_RELEASE?.sections.flatMap((s) => s.entries.map((e) => e.id)) ?? [] : unseen;
  if (gone || (!ids.length && !open)) return null;
  const done = () => {
    setOpen(false);
    setGone(true);
    if (!preview) markPatchNotesSeen();
  };
  const fresh = new Set(ids);
  // The releases with something new, whole, so the new entries read in their context.
  const releases = BUNDLED_NOTES.filter((r) => r.sections.some((s) => s.entries.some((e) => fresh.has(e.id))));
  return (
    <>
      <span className={className} role="status">
        <button className="g-lnk font-semibold" onClick={() => setOpen(true)}>
          What's new
        </button>
        <button className="g-lnk" onClick={done} aria-label="Dismiss What's new" title="Dismiss">
          ✕
        </button>
      </span>
      {open && (
        <PatchNotesDialog
          title="What's new"
          lead={`${ids.length === 1 ? 'One change' : `${ids.length} changes`} since you last looked, marked New.`}
          releases={releases}
          newIds={ids}
          current={THIS_RELEASE}
          onClose={done}
          actions={
            <button className="g-btn g-btn-pri g-btn-sm" onClick={done}>
              Done
            </button>
          }
        />
      )}
    </>
  );
}
