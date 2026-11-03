import { useEffect, useRef, useState } from 'react';
import ScrollArea from './ScrollArea';
import { KnowledgeEngineEmpty, useKnowledgeEngine } from './KnowledgeEngine';
import { useAppStore } from '../store/appStore';
import { ASSISTANT_TREE_W } from '../lib/ui';
import {
  listIndexJobs,
  getIndexJob,
  cancelIndexJob,
  reindexProject,
  DaemonError,
  type IndexJob,
} from '../lib/daemon';

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-primary/20 text-primary',
  queued: 'bg-surface-2 text-subtext-1',
  succeeded: 'bg-success/20 text-success',
  failed: 'bg-error/20 text-error',
  cancelled: 'bg-surface-2 text-subtext-0',
};

// Sort so the live picture reads top-down: running → queued → newest finished.
const RANK: Record<string, number> = { running: 0, queued: 1, succeeded: 2, failed: 2, cancelled: 3 };

function whenText(j: IndexJob): string {
  const t = j.finished_at || j.started_at || j.created_at;
  if (!t) return '';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function durationText(j: IndexJob): string {
  if (!j.started_at) return '';
  const start = new Date(j.started_at).getTime();
  const end = j.finished_at ? new Date(j.finished_at).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '';
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The result counters worth showing, in report order. */
const RESULT_ROWS: [key: string, label: string][] = [
  ['total_files', 'Files seen'],
  ['processed', 'Processed'],
  ['skipped_unchanged', 'Unchanged (reused)'],
  ['deferred', 'Deferred'],
  ['skipped', 'Skipped'],
  ['failed', 'Failed'],
  ['chunks_total', 'Chunks'],
  ['pages_total', 'Pages'],
  ['issues', 'Issues'],
];

/** The ragrat indexing queue: jobs on the left, the selected job's controls,
 * live log and run data on the right. The worker pool runs different projects
 * concurrently; jobs for the SAME project serialize (one LanceDB writer per
 * collection). Cancelling a running job stops it after its current file. */
const HIDDEN_KEY = 'ganban:indexing-hidden';
function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
function saveHidden(h: Set<string>) {
  // Cap so the list can't grow unbounded across months of jobs.
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h].slice(-500)));
}
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'error', 'interrupted']);

export default function IndexingPanel() {
  const { projects } = useAppStore();
  const [jobs, setJobs] = useState<IndexJob[]>([]);
  // Dismissed entries (this device only — the engine keeps its own history;
  // running/queued jobs can never be dismissed, only cancelled).
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IndexJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false); // RAG not configured (the queue answered 404)
  const engine = useKnowledgeEngine(); // false = no knowledge engine on the host
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const projectName = (id?: number | null) =>
    id == null ? 'Unknown project' : projects.find((p) => p.id === id)?.name ?? `Project ${id}`;

  // What a job is indexing FOR — projects today, Atlas collections too, and a
  // sane fallback as more data sources land (feeds, email, …).
  const jobLabel = (j: IndexJob) => {
    const tags = ((j.params as Record<string, unknown> | null | undefined)?.tags ?? {}) as Record<string, unknown>;
    if (typeof tags.atlas === 'string') return `Atlas — ${tags.atlas}`;
    if (j.project_id != null) return projectName(j.project_id);
    return 'Workspace';
  };

  const refresh = async () => {
    try {
      const js = await listIndexJobs();
      setJobs(js);
      setError(null);
      setDisabled(false);
      // The detail poll rides the same tick — one cadence, no second timer.
      const sel = selectedRef.current;
      if (sel && js.some((j) => j.id === sel)) {
        try {
          setDetail(await getIndexJob(sel));
        } catch {
          setDetail(js.find((j) => j.id === sel) ?? null); // fall back to the list row
        }
      }
    } catch (e) {
      if (e instanceof DaemonError && e.status === 404) setDisabled(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), 3000); // live-ish poll
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the log tail while a run narrates itself.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.log?.length]);

  const select = (id: string) => {
    setSelectedId(id);
    setDetail(jobs.find((j) => j.id === id) ?? null); // instant, log fills on next tick
    void getIndexJob(id).then(setDetail).catch(() => {});
  };

  const onCancel = async (id: string) => {
    try {
      await cancelIndexJob(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onReindex = async (projectId: number) => {
    try {
      await reindexProject(projectId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Restart = cancel whatever is in flight and queue a fresh run. The new job
  // queues behind the draining one (same collection ⇒ serialized), so this is
  // safe to fire while the old job is still stopping.
  const onRestart = async (j: IndexJob) => {
    try {
      if (j.status === 'running' || j.status === 'queued') await cancelIndexJob(j.id);
      if (j.project_id != null) await reindexProject(j.project_id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const dismiss = (ids: string[]) => {
    setHidden((h) => {
      const next = new Set(h);
      for (const id of ids) next.add(id);
      saveHidden(next);
      return next;
    });
    if (selectedId && ids.includes(selectedId)) { setSelectedId(null); setDetail(null); }
  };

  const visible = jobs.filter((j) => !hidden.has(j.id));
  const finished = visible.filter((j) => TERMINAL.has(j.status));
  const sorted = [...visible].sort((a, b) => {
    const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    if (r !== 0) return r;
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });
  const running = visible.filter((j) => j.status === 'running').length;
  const queued = visible.filter((j) => j.status === 'queued').length;

  // Nothing picked yet → show the most interesting job (the running one, else newest).
  useEffect(() => {
    if (!selectedId && sorted.length > 0) select(sorted[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.length]);

  if (disabled || engine === false) {
    return (
      <KnowledgeEngineEmpty icon="layers" title="Indexing isn't set up">
        <p>Indexing reads each project's notes, tasks and files into the knowledge base the assistant searches.</p>
        <p>
          It runs on the knowledge engine (ragrat), an optional part of Ganban that isn't set up on this host. The
          assistant still chats without it.
        </p>
      </KnowledgeEngineEmpty>
    );
  }

  const d = detail; // the selected job, freshest copy we have
  const params = (d?.params ?? {}) as Record<string, unknown>;
  const result = (d?.result ?? {}) as Record<string, unknown>;
  const figTotal = result.figures_total as number | undefined;
  const figDone = result.figures_described as number | undefined;
  const prog = d?.progress;
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : null;

  return (
    <div className="flex-1 min-h-0 flex bg-base">
      {/* LEFT: the queue — same width as the other Assistant tabs */}
      <div className={`${ASSISTANT_TREE_W} shrink-0 border-r border-surface-2 bg-surface-0 flex flex-col min-h-0`}>
        <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
          <div>
            <h2 className="g-h2 justify-start mb-1">Indexing</h2>
            <p className="text-xs text-subtext-0">
              {running > 0 ? `${running} running` : 'Idle'}
              {queued > 0 ? ` · ${queued} queued` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {finished.length > 0 && (
              <button
                onClick={() => dismiss(finished.map((j) => j.id))}
                title="Remove all finished/failed entries from this list (this device only — the engine keeps its history)"
                className="g-btn g-btn-ghost g-btn-sm"
              >
                Clear finished ({finished.length})
              </button>
            )}
            <button onClick={() => void refresh()} className="g-btn g-btn-ghost g-btn-sm">
              Refresh
            </button>
          </div>
        </div>
        {error && <div className="m-3 px-3 py-2 bg-error/10 border border-error/30 text-error rounded-lg text-sm">{error}</div>}
        <ScrollArea className="flex-1" contentClassName="p-2 space-y-1">
          {loading && jobs.length === 0 ? (
            <p className="p-3 text-sm text-subtext-0">Loading…</p>
          ) : sorted.length === 0 ? (
            <p className="p-3 text-sm text-subtext-0">Nothing indexed yet. Hit “Update AI database” on a project's Files tab to queue one.</p>
          ) : (
            sorted.map((j) => (
              <button
                key={j.id}
                onClick={() => select(j.id)}
                className={`w-full flex items-center gap-2.5 text-left rounded-lg px-3 py-2.5 border ${
                  selectedId === j.id ? 'border-gilt-a bg-gilt-b' : 'border-transparent hover:bg-surface-1'
                }`}
              >
                {j.status === 'running' && (
                  <span className="shrink-0 inline-block w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text truncate">{jobLabel(j)}</div>
                  <div className="text-xs text-subtext-0 truncate">
                    {j.status === 'running' && j.progress ? `${j.progress.done}/${j.progress.total} files · ` : ''}
                    {whenText(j)}
                  </div>
                </div>
                <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${STATUS_STYLE[j.status] ?? 'bg-surface-2 text-subtext-0'}`}>
                  {j.status === 'running' && j.cancel_requested ? 'stopping…' : j.status}
                </span>
                {TERMINAL.has(j.status) && (
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); dismiss([j.id]); }}
                    title="Remove from this list (this device only)"
                    className="shrink-0 text-subtext-0 hover:text-error px-0.5"
                  >
                    ×
                  </span>
                )}
              </button>
            ))
          )}
        </ScrollArea>
      </div>

      {/* RIGHT: the selected job — controls, progress, data, live log */}
      <ScrollArea className="flex-1 min-w-0" contentClassName="p-4 space-y-3">
        {!d ? (
          <p className="text-sm text-subtext-0 p-4">Pick a job on the left to see its progress, run data and log.</p>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-lg font-semibold text-text break-words min-w-0">{jobLabel(d)}</h3>
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${STATUS_STYLE[d.status] ?? 'bg-surface-2 text-subtext-0'}`}>
                {d.status === 'running' && d.cancel_requested ? 'stopping…' : d.status}
              </span>
              <div className="ml-auto flex gap-2">
                {(d.status === 'queued' || (d.status === 'running' && !d.cancel_requested)) && (
                  <button
                    onClick={() => void onCancel(d.id)}
                    title={d.status === 'running' ? 'Stops after the file currently converting; nothing is applied.' : undefined}
                    className="g-btn g-btn-danger g-btn-sm"
                  >
                    Cancel
                  </button>
                )}
                {(d.status === 'queued' || d.status === 'running') && d.project_id != null && !d.cancel_requested && (
                  <button
                    onClick={() => void onRestart(d)}
                    title="Cancel this run and queue a fresh one from the project's current files."
                    className="px-3 py-1.5 text-sm bg-surface-1 text-primary rounded-lg hover:bg-surface-2"
                  >
                    Restart
                  </button>
                )}
                {(d.status === 'succeeded' || d.status === 'failed' || d.status === 'cancelled') && d.project_id != null && (
                  <button
                    onClick={() => void onReindex(d.project_id!)}
                    className="g-btn g-btn-pri g-btn-sm"
                  >
                    Re-index
                  </button>
                )}
              </div>
            </div>

            {d.status === 'running' && prog && (
              <div className="g-plain p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text">
                    File {prog.done} of {prog.total}
                  </span>
                  {pct != null && <span className="text-subtext-0">{pct}%</span>}
                </div>
                <div className="w-full h-2 bg-surface-2 rounded overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${pct ?? 0}%` }} />
                </div>
                <div className="text-xs text-subtext-0 font-mono truncate">{prog.current}</div>
              </div>
            )}

            {d.error && (
              <div className="px-3 py-2 bg-error/10 border border-error/30 text-error rounded-lg text-sm break-words">{d.error}</div>
            )}

            {/* General data: when, where, what came out */}
            <div className="g-plain p-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <div>
                <div className="text-xs text-subtext-0">Queued</div>
                <div className="text-text">{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-subtext-0">Started</div>
                <div className="text-text">{d.started_at ? new Date(d.started_at).toLocaleString() : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-subtext-0">{d.finished_at ? 'Duration' : 'Running for'}</div>
                <div className="text-text">{durationText(d) || '—'}</div>
              </div>
              {typeof params.folder === 'string' && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-xs text-subtext-0">Source folder (on the host)</div>
                  <div className="text-text font-mono text-xs break-all">{params.folder}</div>
                </div>
              )}
              {typeof result.output_dir === 'string' && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-xs text-subtext-0">Collection output</div>
                  <div className="text-text font-mono text-xs break-all">{result.output_dir}</div>
                </div>
              )}
            </div>

            {d.result && (
              <div className="g-plain p-3">
                <div className="g-flbl mb-2">Run result</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                  {RESULT_ROWS.filter(([k]) => typeof result[k] === 'number').map(([k, label]) => (
                    <div key={k}>
                      <div className="text-xs text-subtext-0">{label}</div>
                      <div className={`${k === 'failed' && (result[k] as number) > 0 ? 'text-error' : 'text-text'}`}>
                        {result[k] as number}
                      </div>
                    </div>
                  ))}
                  {typeof figTotal === 'number' && figTotal > 0 && (
                    <div>
                      <div className="text-xs text-subtext-0">Figures described</div>
                      <div className={figDone === 0 ? 'text-warning' : 'text-text'}>
                        {figDone ?? 0} / {figTotal}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* The worker's narration — what it's doing, file by file */}
            <div className="g-plain p-3 space-y-2">
              <div className="g-flbl">Log</div>
              {d.log && d.log.length > 0 ? (
                <pre ref={logRef} className="text-xs text-subtext-1 font-mono whitespace-pre-wrap bg-surface-1 rounded-lg p-3 max-h-80 overflow-y-auto">
                  {d.log.join('\n')}
                </pre>
              ) : (
                <p className="text-sm text-subtext-0 italic">
                  {d.status === 'queued'
                    ? 'Waiting for a worker — the log starts with the first file.'
                    : 'No log for this job — ragrat keeps the trail in memory, so it clears when the engine restarts (history rows keep their result data).'}
                </p>
              )}
            </div>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
