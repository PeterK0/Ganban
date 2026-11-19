// The desktop update offer (ADR 0012): a quiet notice in the top bar once a check finds a
// newer version, and a dialog with that version's patch notes and the user's three choices:
// Download and install, Later (until the next launch), Skip this version (silent until a
// newer one; Settings → Updates still shows it). Only "Download and install" downloads.
// Downloaded: Restart to finish, or Later. lib/update.ts runs the checks.
//
// `?preview=update-offer` (or `update-ready`, its downloaded step) shows the offer with sample notes and calls nothing (the QA host has
// no updater; docs/dev/TESTING.md).
import { useEffect, useState } from 'react';
import {
  downloadPercent,
  downloadUpdate,
  offerNoticeVisible,
  putOffUpdate,
  restartToUpdate,
  shownUpdateState,
  skipUpdate,
  startUpdateChecks,
  useOfferAnswers,
  useUpdateState,
  type UpdateState,
} from '../lib/update';
import { SAMPLE_OFFER_NOTES, previewMode } from '../lib/patchNotes';
import { PatchNotesDialog, offeredNotes } from './PatchNotes';

const PREVIEW: UpdateState = { kind: 'available', version: '9.9.9', notes: SAMPLE_OFFER_NOTES };
const PREVIEW_READY: UpdateState = { kind: 'ready', version: '9.9.9', notes: SAMPLE_OFFER_NOTES };

export default function UpdateNotice() {
  const live = useUpdateState();
  const answers = useOfferAnswers();
  const mode = previewMode();
  const preview = mode === 'update-offer' || mode === 'update-ready';
  const [open, setOpen] = useState(false);
  const [previewGone, setPreviewGone] = useState(false);

  // At launch and every 6 hours (a no-op off the desktop app). Checks only: see ADR 0012.
  useEffect(() => startUpdateChecks(), []);

  const st = preview ? (mode === 'update-ready' ? PREVIEW_READY : PREVIEW) : shownUpdateState(live);
  const hasDialog = st.kind === 'available' || st.kind === 'downloading' || st.kind === 'ready' || st.kind === 'failed';
  // The offer withdrawn under an open dialog (a re-check found nothing): close it, so it can't pop up again by itself.
  useEffect(() => {
    if (!hasDialog) setOpen(false);
  }, [hasDialog]);
  const visible = preview ? !previewGone : offerNoticeVisible(live, answers);
  if (!visible && !open) return null;
  if (st.kind !== 'available' && st.kind !== 'downloading' && st.kind !== 'ready' && st.kind !== 'failed') return null;
  const version = st.version ?? '';
  const pct = downloadPercent(st);
  const label =
    st.kind === 'available'
      ? `Ganban ${version} is available`
      : st.kind === 'downloading'
        ? `Downloading ${version}${pct == null ? '…' : ` ${pct}%`}`
        : st.kind === 'ready'
          ? 'Restart to finish the update'
          : 'Update failed';
  return (
    <>
      <span className={`g-tag ${st.kind === 'failed' ? 'g-tag-red' : 'g-tag-pri'} shrink-0 inline-flex items-center`} role="status">
        <button className="g-lnk font-semibold" onClick={() => setOpen(true)} title={st.kind === 'failed' ? st.why : undefined}>
          {label}
        </button>
      </span>
      {open && (
        <UpdateOfferDialog
          st={st}
          preview={preview}
          onClose={() => setOpen(false)}
          onLater={() => {
            setOpen(false);
            if (preview) setPreviewGone(true);
            else if (st.kind === 'available' || st.kind === 'failed') putOffUpdate(version);
          }}
          onSkip={() => {
            setOpen(false);
            if (preview) setPreviewGone(true);
            else skipUpdate(version);
          }}
        />
      )}
    </>
  );
}

/** The offer, live: available → downloading → ready (or failed). Settings → Updates opens it too. */
export function UpdateOfferDialog({
  st,
  preview = false,
  onClose,
  onLater,
  onSkip,
}: {
  st: UpdateState;
  preview?: boolean;
  onClose: () => void;
  onLater: () => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (st.kind !== 'available' && st.kind !== 'downloading' && st.kind !== 'ready' && st.kind !== 'failed') return null;
  const version = st.version ?? '';
  const pct = downloadPercent(st);
  const restart = async () => {
    setBusy(true);
    setErr(null);
    try {
      await restartToUpdate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const lead =
    st.kind === 'available'
      ? preview
        ? 'A preview with sample notes: nothing is downloaded.'
        : 'Nothing is downloaded until you choose Download and install.'
      : st.kind === 'downloading'
        ? `Downloading${pct == null ? '…' : ` ${pct}%`}. You can keep working.`
        : st.kind === 'ready'
          ? 'Downloaded and verified. Restarting saves your open task first.'
          : `Couldn't download: ${st.why}`;
  return (
    <PatchNotesDialog
      title={`Ganban ${version} is available`}
      lead={
        <>
          {lead}
          {st.kind === 'downloading' && (
            <div className="g-pbar mt-2" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct ?? 0}%` }} />
            </div>
          )}
          {err && <p className="text-xs text-error mt-1">Couldn't install: {err}</p>}
        </>
      }
      releases={offeredNotes(st.notes ?? null, version)}
      onClose={onClose}
      actions={
        st.kind === 'ready' ? (
          <>
            {/* The focus opens on Later, the one choice that commits to nothing: an Enter out of habit stays harmless. */}
            <button className="g-btn g-btn-ghost g-btn-sm" onClick={onClose} autoFocus>
              Later
            </button>
            <button className="g-btn g-btn-pri g-btn-sm" onClick={() => (preview ? onClose() : void restart())} disabled={busy}>
              {busy ? 'Restarting…' : 'Restart to finish'}
            </button>
          </>
        ) : st.kind === 'downloading' ? (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={onClose} autoFocus>
            Hide
          </button>
        ) : (
          <>
            <button className="g-btn g-btn-ghost g-btn-sm mr-auto" onClick={onSkip}>
              Skip this version
            </button>
            {/* Focus on Later, not Skip (first in the row): Enter must never hide an update for good. */}
            <button className="g-btn g-btn-ghost g-btn-sm" onClick={onLater} autoFocus>
              Later
            </button>
            <button className="g-btn g-btn-pri g-btn-sm" onClick={() => (preview ? onClose() : void downloadUpdate())}>
              {st.kind === 'failed' ? 'Try again' : 'Download and install'}
            </button>
          </>
        )
      }
    />
  );
}
