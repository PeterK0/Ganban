// The top bar's quiet "Update ready" notice (desktop app only): shows once the
// host's newer build has downloaded and been verified; its button saves what's
// open and restarts into the update. lib/update.ts runs the checks.
import { useEffect, useState } from 'react';
import { restartToUpdate, startUpdateChecks, useUpdateState } from '../lib/update';

export default function UpdateReadyNotice() {
  const st = useUpdateState();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // At launch and every 6 hours (a no-op off the desktop app).
  useEffect(() => startUpdateChecks(), []);

  if (st.kind !== 'ready') return null;
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
  return (
    <span
      className="g-tag g-tag-pri shrink-0 inline-flex items-center gap-1.5"
      role="status"
      title={err ? `Couldn't install: ${err}` : `Ganban ${st.version} is downloaded. Restarting saves your open task first.`}
    >
      {err ? 'Update failed' : 'Update ready'}
      <button className="g-lnk font-semibold" onClick={() => void restart()} disabled={busy}>
        {busy ? 'Restarting…' : err ? 'Retry' : 'Restart'}
      </button>
    </span>
  );
}
