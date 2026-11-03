import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { synthesizeDemo } from '../lib/daemon';

/** One recorded step (the recorder's §3 shape — kept opaque here except for
 * the fields the list renders). */
interface DemoStep {
  op: string;
  url?: string;
  value?: string;
  as?: string;
  type?: string;
  locator?: { text?: string | null; neighbor?: string | null; css?: string };
  timeout_ms?: number;
}

const OP_META: Record<string, { icon: string; color: string }> = {
  navigate: { icon: '🌐', color: 'var(--g-org)' },
  wait_for: { icon: '⏳', color: 'var(--color-medium)' },
  click: { icon: '👆', color: 'var(--g-teal)' },
  input: { icon: '⌨️', color: 'var(--g-teal)' },
  extract: { icon: '🎯', color: 'var(--color-primary)' },
};

function stepLabel(s: DemoStep): string {
  switch (s.op) {
    case 'navigate': return s.url ?? '';
    case 'input': return `${s.locator?.neighbor || s.locator?.text || s.locator?.css || ''} = “${s.value ?? ''}”`;
    case 'extract': return `${s.as} (${s.type}) ← ${s.locator?.text || s.locator?.neighbor || s.locator?.css || ''}`;
    default: return s.locator?.text || s.locator?.neighbor || s.locator?.css || '';
  }
}

/** Demonstration authoring (DEMONSTRATION.md Phase A, desktop-only): record a
 * browsing session in a dedicated capture window, narrate it, replay it back
 * ATTENDED, and synthesize a protocol DRAFT into the normal gate. The
 * demonstration is not done until it replays while you watch. */
export default function DemonstratePanel({ onDraftCreated }: { onDraftCreated: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [narration, setNarration] = useState('');
  const [steps, setSteps] = useState<DemoStep[]>([]);
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayStatus, setReplayStatus] = useState<Record<number, { ok: boolean; error?: string; value?: unknown }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [draftInfo, setDraftInfo] = useState<string | null>(null);
  // StrictMode double-mount guard: dedupe identical consecutive steps.
  const lastStepJson = useRef<string>('');

  useEffect(() => {
    const un = listen<Record<string, unknown>>('demo://message', (e) => {
      const m = e.payload;
      if (m.kind === 'step' && m.step) {
        const j = JSON.stringify(m.step);
        if (j === lastStepJson.current) return;
        lastStepJson.current = j;
        setSteps((s) => [...s, m.step as DemoStep]);
      } else if (m.kind === 'stopped') {
        setRecording(false);
        setMsg('Recording stopped. Review the steps, then replay them back before creating the draft.');
      } else if (m.kind === 'result' && typeof m.seq === 'number') {
        setReplayStatus((r) => ({ ...r, [m.seq as number]: { ok: !!m.ok, error: m.error as string | undefined, value: m.value } }));
      }
    });
    return () => { void un.then((f) => f()); };
  }, []);

  const start = async () => {
    if (!url.trim()) { setMsg('Enter the URL to demonstrate on.'); return; }
    setSteps([]);
    setReplayStatus({});
    setDraftInfo(null);
    setMsg(null);
    lastStepJson.current = '';
    try {
      await invoke('demo_start', { url: url.trim() });
      setRecording(true);
      setMsg('Recording — work in the new window. Alt-click any value you want EXTRACTED (it outlines purple).');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    try { await invoke('demo_stop'); } catch { /* window already gone */ }
    setRecording(false);
  };

  const replay = async () => {
    if (steps.length === 0) return;
    setReplaying(true);
    setReplayStatus({});
    setMsg('Attended replay — watch the ghost do what you did.');
    try {
      const results = await invoke<Array<{ ok: boolean }>>('demo_replay', { steps });
      const failed = results.filter((r) => !r.ok).length;
      setMsg(failed === 0
        ? '✓ Replay succeeded end to end — this demonstration is trustworthy. Create the draft.'
        : `Replay hit ${failed} failing step${failed === 1 ? '' : 's'} — fix the flow (re-record, or remove brittle steps) before drafting.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setReplaying(false);
      try { await invoke('demo_stop'); } catch { /* leave open? no — tidy up */ }
    }
  };

  const createDraft = async () => {
    if (!name.trim()) { setMsg('Name the protocol first.'); return; }
    try {
      const d = await synthesizeDemo(name.trim(), steps as unknown[], narration);
      setDraftInfo(`Draft saved: ${d.slug} v${d.version} — review it in the protocol list, dry-run it, then activate.`);
      setMsg(null);
      onDraftCreated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtext-0 leading-relaxed">
        Author a protocol by <span className="text-text">showing</span>: record yourself doing the work once in a
        dedicated window (your clicks become deterministic locators; <span className="text-text">alt-click</span> marks
        a value to extract), narrate what matters, replay it back attended, and the recording becomes a
        <span className="text-text"> draft</span> in the normal gate. Replay executes your frozen steps — a page can
        never add, reorder, or widen actions.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Protocol name (e.g. Baltic index pull)"
          className="g-field g-field-sm !w-auto"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https:// — where the demonstration starts"
          className="g-field g-field-sm !font-mono !w-auto"
        />
      </div>

      <div className="flex items-center gap-2">
        {!recording ? (
          <button onClick={() => void start()} className="g-btn g-btn-pri g-btn-sm">
            ⏺ Start recording
          </button>
        ) : (
          <button onClick={() => void stop()} className="g-btn g-btn-danger g-btn-sm">
            ⏹ Stop recording
          </button>
        )}
        <button
          onClick={() => void replay()}
          disabled={steps.length === 0 || recording || replaying}
          className="g-btn g-btn-ghost g-btn-sm"
          title="Replays your frozen steps in a fresh window while you watch. The demonstration is not done until this succeeds."
        >
          {replaying ? 'Replaying…' : '▶ Replay (attended)'}
        </button>
        <button
          onClick={() => void createDraft()}
          disabled={steps.length === 0 || recording || replaying}
          className="g-btn g-btn-ghost g-btn-sm"
        >
          ✍ Create draft
        </button>
        {recording && <span className="text-xs text-error animate-pulse">● recording</span>}
      </div>

      {steps.length > 0 && (
        <div className="g-plain p-1.5 space-y-0.5 max-h-72 overflow-y-auto">
          {steps.map((s, i) => {
            const meta = OP_META[s.op] ?? { icon: '·', color: 'var(--color-overlay-0)' };
            const rr = replayStatus[i];
            return (
              <div key={i} className="flex items-center gap-2 text-xs min-h-9 px-2.5 py-1.5 rounded hover:bg-surface-0">
                <span>{meta.icon}</span>
                <span className="font-mono font-semibold" style={{ color: meta.color }}>{s.op}</span>
                <span className="text-subtext-1 truncate flex-1">{stepLabel(s)}</span>
                {rr && (
                  <span className={rr.ok ? 'text-success' : 'text-error'} title={rr.error ?? (rr.value != null ? `= ${rr.value}` : '')}>
                    {rr.ok ? (rr.value != null ? `✓ ${String(rr.value).slice(0, 24)}` : '✓') : `✗ ${rr.error ?? ''}`}
                  </span>
                )}
                <button
                  onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}
                  disabled={recording || replaying}
                  className="g-iconbtn !w-8 !h-8 hover:!text-error disabled:opacity-30"
                  title="Remove this step"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div>
        <label className="g-flbl">
          Narration — what are you doing, and what must a successful run yield? (becomes the draft's briefing)
        </label>
        <textarea
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          rows={3}
          placeholder="e.g. Pull the BDI after filtering to capesize; a run is good if it yields today's index value and date."
          className="g-field g-field-sm w-full resize-y"
        />
      </div>

      {msg && <p className="text-xs text-subtext-1">{msg}</p>}
      {draftInfo && <p className="text-xs text-success">{draftInfo}</p>}
    </div>
  );
}
