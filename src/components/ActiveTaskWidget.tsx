import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import type { Task } from '../types';
import {
  useTimer,
  useAgentWork,
  liveTotal,
  liveToday,
  sessionSeconds,
  startTimerSync,
  startTimer,
  pauseTimer,
  stopTimer,
  makeActiveAndStart,
  loadRecentTimeTasks,
  taskKey,
  type RecentTimeTask,
} from '../lib/timer';
import { projectColorClass } from '../lib/projectColor';
import { DATA_PULSE_EVENT } from '../lib/livePulse';
import { LOCAL_ID } from '../lib/workspaces';

const pad = (n: number) => n.toString().padStart(2, '0');
function clock(seconds: number): string {
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
/** A total for a list row: "3h 12m", "12m", "40s". */
function short(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m`;
  return `${seconds}s`;
}

const PlayIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>;
const PauseIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1h2.5v8H1.5zM6 1h2.5v8H6z" fill="currentColor" /></svg>;
const StopIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" fill="currentColor" /></svg>;
const ClockIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

/** A click handler that ignores clicks while an action is in flight (the
 * dropdown's buttons stay focusable, so Esc and the arrows keep working). */
const idle = (f: () => Promise<void>) => () => {
  if (!useTimer.getState().busy) void f();
};

/** Ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [on]);
  return now;
}

/**
 * The top bar's timer: the trigger ("No active task", or the green pill) and
 * its dropdown (Now / Recent / Agents). The state lives in lib/timer.ts, which
 * keeps every window on the host's running entry.
 */
export default function ActiveTaskWidget({ onOpenTask }: { onOpenTask?: (task: Task) => void }) {
  const activeTask = useAppStore((s) => s.activeTask);
  const timer = useTimer();
  const running = !!timer.entry;
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => startTimerSync(), []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Outside click closes; Esc closes wherever focus is (it can land on <body>
  // when the control under it goes away).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close(rootRef.current?.contains(document.activeElement) || document.activeElement === document.body);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  // The pill shows my time on the task today; the dropdown adds this run and the task's total.
  const today = liveToday(timer, now);
  const ctl = 'w-8 h-8 grid place-items-center rounded text-success hover:bg-success/15 transition-colors disabled:opacity-50 shrink-0';

  let trigger;
  if (!activeTask) {
    trigger = (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="The timer: recent tasks and what's active"
        className={`inline-flex items-center gap-2 min-h-[38px] px-2.5 rounded text-[13px] text-subtext-0 hover:bg-surface-0 hover:text-text transition-colors shrink-0 ${open ? 'bg-surface-0 text-text' : ''}`}
      >
        <ClockIcon />
        No active task
      </button>
    );
  } else {
    trigger = (
      // The green timer pill (Gilt). min-w-0 chain: a long task title TRUNCATES
      // inside the pill; the top bar's fit check reads `data-topbar-title` and
      // gives up other things once it's cut below ~8 characters. The title and
      // time are the dropdown's trigger; the controls stay one click away.
      <div
        className={`inline-flex items-center min-h-[38px] min-w-0 pr-1 rounded bg-success/10 text-success ring-1 ring-inset ring-success/40 text-[13px] font-semibold ${open ? 'bg-success/20' : ''}`}
        title={activeTask.title}
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onTriggerKey}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Timer: ${activeTask.title}, ${running ? 'running' : 'paused'}, ${clock(today)} today`}
          className="inline-flex items-center gap-2.5 min-h-[38px] min-w-0 pl-3.5 pr-1.5 rounded hover:bg-success/10 transition-colors"
        >
          <span className={`w-[7px] h-[7px] rounded-full bg-success shrink-0 ${running ? 'g-pulse' : 'opacity-50'}`} aria-hidden="true" />
          <span data-topbar-title className="min-w-0 max-w-[clamp(220px,18vw,480px)] truncate">
            {activeTask.title}
          </span>
          <span className="tabular-nums shrink-0" title="Your time on this task today">{clock(today)}</span>
        </button>
        <span className="flex items-center shrink-0">
          {running ? (
            <button onClick={() => void pauseTimer()} disabled={timer.busy} className={ctl} title="Pause timer" aria-label="Pause timer">
              <PauseIcon />
            </button>
          ) : (
            <button onClick={() => void startTimer()} disabled={timer.busy} className={ctl} title={timer.totalBase ? 'Resume timer' : 'Start timer'} aria-label={timer.totalBase ? 'Resume timer' : 'Start timer'}>
              <PlayIcon />
            </button>
          )}
          <button onClick={() => void stopTimer()} disabled={timer.busy} className={`${ctl} hover:!text-error hover:!bg-error/15`} title="Stop timer and clear active task" aria-label="Stop timer">
            <StopIcon />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`relative flex ${activeTask ? 'min-w-0' : 'shrink-0'}`}>
      {trigger}
      {open && (
        <TimerDropdown
          now={now}
          onOpenTask={
            onOpenTask &&
            ((t) => {
              close(false);
              onOpenTask(t);
            })
          }
        />
      )}
    </div>
  );
}

function TimerDropdown({ now, onOpenTask }: { now: number; onOpenTask?: (task: Task) => void }) {
  const activeTask = useAppStore((s) => s.activeTask);
  const projects = useAppStore((s) => s.projects);
  const timer = useTimer();
  const agentWork = useAgentWork((s) => s.work);
  const [recent, setRecent] = useState<RecentTimeTask[] | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const seq = useRef(0);
  const loadRecent = useCallback(() => {
    const n = ++seq.current;
    // Newest request wins; a closed dropdown (seq bumped on unmount) drops it.
    void loadRecentTimeTasks(8)
      .catch(() => [] as RecentTimeTask[])
      .then((r) => {
        if (n === seq.current) setRecent(r);
      });
  }, []);
  useEffect(
    () => () => {
      seq.current++;
    },
    []
  );
  useEffect(() => {
    loadRecent();
    // Totals move when time is tracked anywhere.
    const onPulse = (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: string }>).detail?.kind;
      if (!kind || kind === 'time' || kind === 'lagged' || kind === 'tasks') loadRecent();
    };
    window.addEventListener(DATA_PULSE_EVENT, onPulse);
    return () => window.removeEventListener(DATA_PULSE_EVENT, onPulse);
  }, [loadRecent]);
  // A start or stop here changes the list too (the pulse may lag or not come).
  const entryId = timer.entry?.id ?? null;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    loadRecent();
  }, [entryId, loadRecent]);

  // Focus the first control on open, and again when the focused one goes
  // away (Stop swaps the Now section out), so Esc and the arrows keep working.
  const activeKeyNow = taskKey(activeTask);
  useEffect(() => {
    const p = panelRef.current;
    if (p && !p.contains(document.activeElement)) p.querySelector<HTMLElement>('[data-timer-item]')?.focus();
  }, [activeKeyNow, entryId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-timer-item]') ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const projectOf = (t: Task) =>
    projects.find((p) => p.id === t.project_id && (p.workspaceId ?? LOCAL_ID) === (t.workspaceId ?? LOCAL_ID)) ?? null;
  const Gem = ({ t }: { t: Task }) => (
    <span className={`g-gem shrink-0 ${projectColorClass({ id: t.project_id, workspaceId: t.workspaceId })}`} aria-hidden="true" />
  );

  const activeKey = taskKey(activeTask);
  const recentRows = (recent ?? []).filter((r) => taskKey(r.task) !== activeKey).slice(0, 8);
  const agents = Object.values(agentWork);
  const running = !!timer.entry;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Timer"
      onKeyDown={onKeyDown}
      className="g-card absolute right-0 top-full mt-2 z-50 w-[24rem] max-w-[calc(100vw-1.5rem)] shadow-2xl p-3 space-y-3 whitespace-normal text-[13px] font-normal text-text"
    >
      {/* Now */}
      <section>
        <h3 className="g-cap px-1 mb-1.5">Now</h3>
        {activeTask ? (
          <div className="g-inset p-3 space-y-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className={`mt-1.5 w-[7px] h-[7px] rounded-full bg-success shrink-0 ${running ? 'g-pulse' : 'opacity-50'}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate" title={activeTask.title}>{activeTask.title}</div>
                <div className="flex items-center gap-1.5 text-[12px] text-subtext-0 min-w-0">
                  <Gem t={activeTask} />
                  <span className="truncate">{projectOf(activeTask)?.name ?? 'Project'}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="tabular-nums font-semibold text-success" title="Your time on this task today">{clock(liveToday(timer, now))} today</div>
                <div className="text-[11px] text-subtext-0 tabular-nums">
                  {running ? `this run ${clock(sessionSeconds(timer.entry!, now))}` : timer.totalBase ? 'paused' : 'not started'}
                </div>
                {liveTotal(timer, now) > 0 && (
                  <div className="text-[11px] text-subtext-0 tabular-nums" title="Everyone's time on this task, all days">
                    task total {short(liveTotal(timer, now))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <button data-timer-item type="button" onClick={idle(pauseTimer)} aria-disabled={timer.busy} className="g-btn g-btn-gilt g-btn-sm">
                  <PauseIcon /> Pause
                </button>
              ) : (
                <button data-timer-item type="button" onClick={idle(startTimer)} aria-disabled={timer.busy} className="g-btn g-btn-gilt g-btn-sm">
                  <PlayIcon /> {timer.totalBase ? 'Resume' : 'Start'}
                </button>
              )}
              <button data-timer-item type="button" onClick={idle(stopTimer)} aria-disabled={timer.busy} className="g-btn g-btn-ghost g-btn-sm" title="Stop the timer and clear the active task">
                <StopIcon /> Stop
              </button>
              {onOpenTask && (
                <button data-timer-item type="button" onClick={() => onOpenTask(activeTask)} className="g-btn g-btn-ghost g-btn-sm ml-auto">
                  Open
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="px-1 text-subtext-0">No active task. Pick one below, or double-click a task in any list.</p>
        )}
        {timer.error && <p className="px-1 mt-1.5 text-[12px] text-error">{timer.error}</p>}
      </section>

      {/* Recent */}
      <section>
        <h3 className="g-cap px-1 mb-1">Recent</h3>
        {recent === null ? (
          <p className="px-1 text-subtext-0">Loading…</p>
        ) : recentRows.length === 0 ? (
          <p className="px-1 text-subtext-0">{activeTask ? 'No other tracked tasks yet.' : 'No tracked time yet.'}</p>
        ) : (
          <ul>
            {recentRows.map((r) => (
              <li key={taskKey(r.task)} className="g-row flex items-center gap-2 min-h-[40px] px-1.5 rounded">
                <Gem t={r.task} />
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={r.task.title}>{r.task.title}</div>
                  <div className="truncate text-[11px] text-subtext-0">{projectOf(r.task)?.name ?? 'Project'}</div>
                </div>
                <span className="tabular-nums text-[12px] text-subtext-0 shrink-0" title="Total tracked">{short(r.total_seconds)}</span>
                <button
                  data-timer-item
                  type="button"
                  onClick={idle(() => makeActiveAndStart(r.task))}
                  aria-disabled={timer.busy}
                  className="g-btn g-btn-ghost g-btn-sm shrink-0"
                  title={`Make “${r.task.title}” active and start its timer`}
                >
                  Make active
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Agents: the tasks my assistants are working on right now (lib/timer). */}
      {agents.length > 0 && (
        <section>
          <h3 className="g-cap px-1 mb-1">Agents</h3>
          <ul>
            {agents.map((a) => (
              <li key={taskKey(a.task)} className="g-row flex items-center gap-2 min-h-[40px] px-1.5 rounded">
                <Gem t={a.task} />
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={a.task.title}>{a.task.title}</div>
                  <div className="truncate text-[11px] text-subtext-0" title={`Since ${new Date(a.since).toLocaleTimeString()}`}>
                    {a.who} · {short(Math.max(0, Math.floor((now - a.since) / 1000)))}
                  </div>
                </div>
                {onOpenTask && (
                  <button data-timer-item type="button" onClick={() => onOpenTask(a.task)} className="g-btn g-btn-ghost g-btn-sm shrink-0">
                    Open
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
