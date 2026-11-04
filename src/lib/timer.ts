// The top bar's timer, one truth for every window (F1).
//
// The HOST holds the running time entry, so "is the timer running, and on
// what" is always asked of the host: on start-up, on every `time` pulse (other
// devices, other browser windows), on focus and on a slow poll. What only the
// client knows (a task that is active but not running, i.e. picked or paused)
// is shared between this profile's windows over a BroadcastChannel; a window
// that opens asks its peers for it. Nothing is persisted (TAB_SPEC: no
// non-cosmetic localStorage).
//
// Pause is real: it stops the host's entry (paused time isn't tracked) and
// keeps the task active; resume starts a new entry. Changing the active task
// from anywhere (the editor's switch, a double-click, "Make active") goes
// through the store, and the reconciler below carries a running timer over to
// the new task, or stops it when the active task is cleared.

import { create } from 'zustand';
import { useAppStore } from '../store/appStore';
import type { Task, TimeEntry } from '../types';
import { listWorkspaces, getWorkspace, getActiveWorkspaceId, LOCAL_ID, type Workspace } from './workspaces';
import {
  wsStartTimeEntry,
  wsStopTimeEntry,
  wsGetTaskTotalTime,
  wsGetMyTaskTimeSince,
  wsGetMyRunningTimer,
  wsGetRecentTimeTasks,
  wsGetAgentWork,
  type RecentTimeTask,
} from './workspaceData';
import { reportLocalWrite } from './api';
import { isWebClient } from './daemon';
import { DATA_PULSE_EVENT, type DataPulseDetail } from './livePulse';
import { localMidnight, todaySeconds } from './timerDay.pure';
import { mergeAgentWork, type AgentWorkRow, type MergedAgentWork } from './agentWork.pure';

/** A task's composite key: ids collide across hosts (K2). */
export const taskKey = (t: { id: number; workspaceId?: string } | null | undefined): string | null =>
  t ? `${t.workspaceId ?? LOCAL_ID}:${t.id}` : null;

const wsOf = (t: { workspaceId?: string }): Workspace | null => getWorkspace(t.workspaceId ?? LOCAL_ID);
/** The workspaces a timer can live on (local always; remotes with a URL). */
const timerWorkspaces = (): Workspace[] => listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);

interface TimerState {
  /** The running entry of the active task, or null (idle or paused). */
  entry: TimeEntry | null;
  /** The workspace the running entry lives on. */
  entryWs: string | null;
  /** The active task's finished seconds, everyone's (the running entry not included). */
  totalBase: number;
  /** My finished seconds on the active task since the local midnight `todayDay` (epoch ms). */
  todayBase: number;
  todayDay: number | null;
  busy: boolean;
  error: string | null;
}

export const useTimer = create<TimerState>(() => ({
  entry: null,
  entryWs: null,
  totalBase: 0,
  todayBase: 0,
  todayDay: null,
  busy: false,
  error: null,
}));

/** The active task's total right now: finished entries plus the running one. */
export function liveTotal(s: TimerState, now = Date.now()): number {
  return s.totalBase + (s.entry ? sessionSeconds(s.entry, now) : 0);
}
/** The pill's figure: my time on the active task today, the running entry included. */
export function liveToday(s: TimerState, now = Date.now()): number {
  return todaySeconds(s.todayBase, s.todayDay, s.entry ? Date.parse(s.entry.start_time) : null, now);
}
export function sessionSeconds(entry: TimeEntry, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(entry.start_time).getTime()) / 1000));
}

// ---------- cross-window (same profile) ----------

type Msg = { type: 'hello' } | { type: 'state'; active: Task | null };
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ganban-timer') : null;
const broadcast = (m: Msg) => channel?.postMessage(m);
const announce = () => broadcast({ type: 'state', active: useAppStore.getState().activeTask });

// ---------- the store's active task, and who changed it ----------

/** Set while the controller itself writes `activeTask`, so the reconciler
 * doesn't treat adoption (from the host or a peer) as the user's switch. */
let internal = false;
function adopt(task: Task | null) {
  const cur = useAppStore.getState().activeTask;
  if (taskKey(cur) === taskKey(task) && (cur?.title === task?.title || !task)) return;
  internal = true;
  try {
    useAppStore.getState().setActiveTask(task);
  } finally {
    internal = false;
  }
}

function noteWrite(ws: Workspace, command: string) {
  // Local writes run in-process; tell the loopback host so phones and browser
  // windows get the pulse (api.ts does the same for its own calls).
  if (ws.id === LOCAL_ID && !isWebClient()) reportLocalWrite(command);
}

/** `gen`: a sync's snapshot; an action since then makes this answer stale. */
async function loadTotal(task: Task | null, gen?: number) {
  if (!task) return useTimer.setState({ totalBase: 0, todayBase: 0, todayDay: null });
  const ws = wsOf(task);
  if (!ws) return;
  const day = localMidnight(Date.now());
  // An older host has no "today" command: the pill then counts only the running entry.
  const [n, today] = await Promise.all([
    wsGetTaskTotalTime(ws, task.id).catch(() => null),
    wsGetMyTaskTimeSince(ws, task.id, new Date(day).toISOString()).catch(() => null),
  ]);
  if (gen !== undefined && gen !== actionGen) return;
  if (taskKey(useAppStore.getState().activeTask) !== taskKey(task)) return;
  if (n != null) useTimer.setState({ totalBase: n });
  useTimer.setState(today != null ? { todayBase: today, todayDay: day } : { todayBase: 0, todayDay: null });
}

// ---------- reading the host ----------

let syncing: Promise<void> | null = null;
let syncAgain = false;
let resyncAfterAction = false;
/** Bumped by every action: a host answer that started before one is stale. */
let actionGen = 0;

/** Ask every workspace for my running timer and make this window agree. */
export function syncTimer(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      const gen = actionGen;
      // `undefined` = that host didn't answer: not the same as "no timer there".
      const wss = timerWorkspaces();
      const found = await Promise.all(wss.map((ws) => wsGetMyRunningTimer(ws).catch(() => undefined)));
      const running = found
        .filter((r): r is NonNullable<typeof r> => !!r)
        .sort((a, b) => Date.parse(b.entry.start_time) - Date.parse(a.entry.start_time))[0] ?? null;
      const { entryWs } = useTimer.getState();
      const entryHostSilent = wss.some((ws, i) => ws.id === entryWs && found[i] === undefined);
      if (useTimer.getState().busy) {
        // An action is mid-flight (a stop then a start): what the host said a
        // moment ago may already be stale. Look again once it lands.
        resyncAfterAction = true;
        break;
      }
      if (gen !== actionGen) {
        syncAgain = true;
        continue;
      }
      if (running) {
        adopt(running.task);
        useTimer.setState({ entry: running.entry, entryWs: running.task.workspaceId ?? LOCAL_ID });
      } else if (!entryHostSilent) {
        // Not running anywhere: an active task here is paused (it stays).
        // (If the running entry's host didn't answer, keep it: clearing it
        // would leave Stop with nothing to stop.)
        useTimer.setState({ entry: null, entryWs: null });
      }
      await loadTotal(useAppStore.getState().activeTask, gen);
    } while (syncAgain);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// ---------- actions ----------

// Actions run one at a time, in order: a quick A→B→C switch must stop A,
// start B, stop B, start C, never interleave.
let queue: Promise<void> = Promise.resolve();
let pending = 0;

function run(fn: () => Promise<void>): Promise<void> {
  actionGen++;
  pending++;
  useTimer.setState({ busy: true, error: null });
  const job = queue.then(async () => {
    try {
      await fn();
    } catch (e) {
      useTimer.setState({ error: e instanceof Error ? e.message : String(e) });
      resyncAfterAction = true;
    } finally {
      pending--;
      if (pending === 0) useTimer.setState({ busy: false });
    }
    if (pending === 0 && resyncAfterAction) {
      resyncAfterAction = false;
      await syncTimer().catch(() => {});
    }
  });
  queue = job;
  return job;
}

async function stopEntry() {
  const { entry, entryWs } = useTimer.getState();
  if (!entry) return;
  const ws = getWorkspace(entryWs ?? LOCAL_ID);
  useTimer.setState({ entry: null, entryWs: null });
  if (!ws) return;
  await wsStopTimeEntry(ws, entry.id).catch((e) => {
    // Already stopped elsewhere is fine: the host agrees with us.
    if (!/already stopped/i.test(String(e))) throw e;
  });
  noteWrite(ws, 'stop_time_entry');
}

async function startEntry(task: Task) {
  const ws = wsOf(task);
  if (!ws) throw new Error('That task’s workspace isn’t connected.');
  const entry = await wsStartTimeEntry(ws, task.id).catch(async (e) => {
    // Running already (another window got there first): use that one.
    if (!/already running/i.test(String(e))) throw e;
    const mine = await wsGetMyRunningTimer(ws);
    if (mine?.entry.task_id !== task.id) throw e;
    return mine.entry;
  });
  noteWrite(ws, 'start_time_entry');
  useTimer.setState({ entry, entryWs: entry ? ws.id : null });
}

/** Start (or resume) the active task's timer. */
export const startTimer = () =>
  run(async () => {
    const task = useAppStore.getState().activeTask;
    if (!task || useTimer.getState().entry) return;
    await startEntry(task);
    announce();
  });

/** Pause: stop the host's entry, keep the task active. */
export const pauseTimer = () =>
  run(async () => {
    await stopEntry();
    await loadTotal(useAppStore.getState().activeTask);
    announce();
  });

/** Stop: stop the entry and clear the active task. */
export const stopTimer = () =>
  run(async () => {
    await stopEntry();
    adopt(null);
    useTimer.setState({ totalBase: 0, todayBase: 0, todayDay: null });
    announce();
  });

/** "Make active" from the dropdown: this task becomes active and its timer runs. */
export const makeActiveAndStart = (task: Task) =>
  run(async () => {
    await stopEntry();
    adopt(task);
    await loadTotal(task);
    await startEntry(task);
    announce();
  });

// ---------- the reconciler: the active task changed somewhere else in this window ----------

let started = false;

/** Wire the controller once (the top bar's widget calls it). */
export function startTimerSync(): () => void {
  if (started) return () => {};
  started = true;

  const unsubStore = useAppStore.subscribe((s, prev) => {
    if (internal || s.activeTask === prev.activeTask) return;
    let next = s.activeTask;
    const before = prev.activeTask;
    // Project views load tasks over the active workspace's transport, untagged.
    // The same task coming back from an edit (updateTask) keeps its workspace;
    // a newly picked one belongs to the workspace that's active now.
    if (next && !next.workspaceId) {
      const wsId = before && before.id === next.id ? before.workspaceId : getActiveWorkspaceId();
      if (wsId && wsId !== LOCAL_ID) {
        next = { ...next, workspaceId: wsId };
        adopt(next);
      }
    }
    if (taskKey(next) === taskKey(before)) return;
    void run(async () => {
      // Stop the old task's entry; a running timer carries over below. A
      // failed stop aborts the switch (run() resyncs with the host).
      const wasRunning = !!useTimer.getState().entry;
      await stopEntry();
      useTimer.setState({ totalBase: 0, todayBase: 0, todayDay: null });
      await loadTotal(next);
      // A running timer carries over to the newly active task.
      if (wasRunning && next) await startEntry(next);
      announce();
    });
  });

  const onMsg = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m?.type === 'hello') {
      if (useAppStore.getState().activeTask) announce();
    } else if (m?.type === 'state') {
      adopt(m.active);
      if (!m.active) useTimer.setState({ entry: null, entryWs: null, totalBase: 0, todayBase: 0, todayDay: null });
      void syncTimer();
    }
  };
  channel?.addEventListener('message', onMsg);

  const onPulse = (e: Event) => {
    const kind = (e as CustomEvent<DataPulseDetail>).detail?.kind;
    if (!kind || kind === 'time' || kind === 'tasks' || kind === 'lagged') void syncTimer();
  };
  window.addEventListener(DATA_PULSE_EVENT, onPulse);
  const onFocus = () => {
    if (document.visibilityState !== 'hidden') void syncTimer();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  // The fallback when no pulse arrives (a desktop with no loopback host).
  const iv = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void syncTimer();
  }, 15_000);

  broadcast({ type: 'hello' });
  void syncTimer();

  return () => {
    started = false;
    unsubStore();
    channel?.removeEventListener('message', onMsg);
    window.removeEventListener(DATA_PULSE_EVENT, onPulse);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.clearInterval(iv);
  };
}

// ---------- the dropdown's lists ----------

/** The last `n` distinct tasks I tracked time on, across workspaces, newest first. */
export async function loadRecentTimeTasks(n = 8): Promise<RecentTimeTask[]> {
  const all = await Promise.all(timerWorkspaces().map((ws) => wsGetRecentTimeTasks(ws, n + 1).catch(() => [])));
  return all
    .flat()
    .sort((a, b) => Date.parse(b.last_tracked_at) - Date.parse(a.last_tracked_at))
    .slice(0, n + 1);
}

/** Tasks my assistants are working on right now: the "Agents" section. A chat
 * turn's tools (and its delegates') put each task they touch on the host's board
 * until the turn ends; the host pulses `agents` on every change, and the app calls
 * `refreshAgentWork` then, so every window of the user shows the same. The host
 * returns only tasks the reader can see. */
export type AgentWork = MergedAgentWork<Task>;
export const useAgentWork = create<{ work: Record<string, AgentWork> }>(() => ({ work: {} }));
let agentSeq = 0;
/** Each workspace's last answer: a host that fails to answer once keeps its rows. */
const lastAgentRows = new Map<string, AgentWorkRow<Task>[]>();
export async function refreshAgentWork(): Promise<void> {
  const n = ++agentSeq;
  const wss = timerWorkspaces();
  const rows = await Promise.all(
    wss.map((ws) => wsGetAgentWork(ws).catch(() => lastAgentRows.get(ws.id) ?? []))
  );
  if (n !== agentSeq) return; // a newer refresh is on its way
  wss.forEach((ws, i) => lastAgentRows.set(ws.id, rows[i]));
  const work = mergeAgentWork(
    wss.map((ws, i) => ({ workspaceId: ws.id, rows: rows[i] })),
    (task, workspaceId) => ({ ...task, workspaceId }),
    (t) => taskKey(t)!
  );
  useAgentWork.setState({ work });
}

export type { RecentTimeTask };
