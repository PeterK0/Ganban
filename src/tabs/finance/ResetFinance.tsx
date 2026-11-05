// Finance → Settings, at the bottom: delete all finance data and start over (docs/design/FINANCE.md
// § Starting over). The confirmation lists what goes, with counts, and enables its final button only
// once DELETE is typed. The host deletes in the background; this follows it, then opens the empty
// overview.
import { useEffect, useState } from 'react';
import Modal from '../../components/gilt/Modal';
import * as fin from './api';
import { CONFIRM_WORD, confirmed, resetPercent, resetSummary, type ResetCounts } from './resetJob.pure';
import { MUTED, errText, useFinance } from './shared';

const POLL_MS = 600;

export default function ResetFinance() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<fin.ResetJob | null>(null);

  // A refreshed page finds a reset still running on the host.
  useEffect(() => {
    fin.resetStatus().then(
      (job) => {
        if (job?.state === 'running') {
          setRunning(job);
          setOpen(true);
        }
      },
      () => {},
    );
  }, []);

  return (
    <>
      <div className="g-card g-danger p-5 space-y-3">
        <div className="g-stitle text-error">Delete all finance data</div>
        <p className={`text-sm ${MUTED} g-read`}>
          Removes every account, transaction, imported statement, budget, planned and recurring item and closed month, and,
          unless you keep them, your categorisation rules and saved import layouts. Your settings here stay. This can't be
          undone.
        </p>
        <button className="g-btn g-btn-danger" onClick={() => setOpen(true)}>
          Delete all finance data…
        </button>
      </div>
      {open && <ResetDialog initialJob={running} onClose={() => { setOpen(false); setRunning(null); }} />}
    </>
  );
}

function ResetDialog({ initialJob, onClose }: { initialJob: fin.ResetJob | null; onClose: () => void }) {
  const { locale, reload, goto } = useFinance();
  const [counts, setCounts] = useState<ResetCounts | null>(null);
  const [keepRules, setKeepRules] = useState(false);
  const [typed, setTyped] = useState('');
  const [job, setJob] = useState<fin.ResetJob | null>(initialJob);
  const [msg, setMsg] = useState<string | null>(null);
  const fmt = (n: number) => new Intl.NumberFormat(locale).format(n);

  // The counts, again after a reset that stopped (some rows may be gone).
  const idle = job == null;
  useEffect(() => {
    if (!idle) return;
    fin.resetPreview().then(setCounts, (e) => setMsg(errText(e)));
  }, [idle]);

  // Follow the job until it's done, then show the empty overview.
  const runningId = job?.state === 'running' ? job.job_id : null;
  useEffect(() => {
    if (runningId == null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const tick = async () => {
      try {
        const j = await fin.resetStatus(runningId);
        if (stop) return;
        misses = 0;
        if (j?.state === 'running') {
          setJob(j);
          timer = setTimeout(tick, POLL_MS);
        } else if (j?.state === 'done') {
          setJob(j);
          await reload();
          onClose();
          goto('overview');
        } else {
          setJob(null);
          setMsg(j?.error ? `${j.error}.` : 'The reset stopped: run it again to finish it.');
        }
      } catch (e) {
        if (stop) return;
        if (++misses >= 5) {
          setJob(null);
          setMsg(errText(e));
        } else timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningId]);

  const start = async () => {
    setMsg(null);
    try {
      setJob(await fin.startReset(CONFIRM_WORD, keepRules));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const busy = job?.state === 'running' || job?.state === 'done';
  if (busy && job) {
    const pct = resetPercent(job);
    return (
      // Not closable while it runs: the host finishes it either way, and this screen reloads after.
      <Modal onClose={() => {}} closeOnScrim={false} title="Deleting finance data" className="w-[min(480px,calc(100vw-24px))]">
        <div className="px-6 pt-3 pb-6 space-y-3" aria-live="polite">
          <div className="g-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="text-sm text-text tabular-nums">
            {job.total > 0 ? `${fmt(job.done)} of ${fmt(job.total)} rows deleted` : 'Starting…'}
          </p>
          <p className={`text-xs ${MUTED}`}>This runs on the host. The rest of Ganban keeps working meanwhile.</p>
        </div>
      </Modal>
    );
  }

  const summary = counts ? resetSummary(counts, keepRules, fmt) : null;
  return (
    <Modal onClose={onClose} title="Delete all finance data?" className="w-[min(480px,calc(100vw-24px))]">
      <form
        className="px-6 pt-3 pb-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed(typed)) void start();
        }}
      >
        {!summary ? (
          <p className={`text-sm ${msg ? 'text-error' : MUTED}`}>{msg ?? 'Counting…'}</p>
        ) : (
          <>
            <div className="space-y-1">
              <span className="g-flbl">This deletes</span>
              <ul className="text-sm text-text list-disc pl-5 tabular-nums">
                {summary.goes.map((g) => (
                  <li key={g}>{g}</li>
                ))}
                <li>imported statements, budgets, planned and recurring items, closed months and the history of changes</li>
              </ul>
              {summary.stays.length > 0 && (
                <p className={`text-sm ${MUTED} tabular-nums`}>Kept: {summary.stays.join(' and ')}.</p>
              )}
            </div>
            <label className="flex items-start gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={keepRules} onChange={(e) => setKeepRules(e.target.checked)} />
              <span>Keep my categorisation rules and saved import layouts</span>
            </label>
            <label className="block">
              <span className="g-flbl">Type {CONFIRM_WORD} to confirm</span>
              <input
                className="g-field"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label={`Type ${CONFIRM_WORD} to confirm`}
              />
            </label>
            <p className={`text-xs ${MUTED}`}>Your finance settings and the exchange rates stay. This can't be undone.</p>
            {msg && <p className="text-sm text-error">{msg}</p>}
          </>
        )}
        <div className="flex flex-wrap gap-2 justify-end pt-1">
          <button type="button" className="g-btn g-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="g-btn g-btn-danger" disabled={!summary || !confirmed(typed)}>
            Delete everything
          </button>
        </div>
      </form>
    </Modal>
  );
}
