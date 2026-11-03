// "Open in Project > Tasks": show a task at its place in its project's Tasks tab.
// In a window that runs the App, that's a history push here. From a task window
// or a pinned tab's window, the main window gets a message (a Tauri event aimed at
// its label, or a BroadcastChannel in a browser) and is brought forward.

import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import { isTauri } from './daemon';
import { getActiveWorkspaceId } from './workspaces';
import { useNav, taskPlace } from '../store/navHistory';
import { notify } from '../store/notifications';

const EVENT = 'ganban:goto-task';

export interface GotoTaskMsg {
  ws: string;
  projectId: number;
  taskId: number;
}

/** Whether this window runs the full App (not a `?pane=` window). */
export const hasApp = () => !new URLSearchParams(window.location.search).has('pane');

const unavailable = () => notify({ kind: 'info', title: 'That task is no longer available' });

/** Go to the task's place in Project > Tasks (here, or in the main window). */
export async function openInProjectTasks(task: Task): Promise<void> {
  const ws = task.workspaceId ?? getActiveWorkspaceId();
  if (hasApp()) {
    if (!(await useNav.getState().goto(taskPlace(task, ws)))) unavailable();
    return;
  }
  const msg: GotoTaskMsg = { ws, projectId: task.project_id, taskId: task.id };
  if (!isTauri()) {
    const ch = new BroadcastChannel(EVENT);
    ch.postMessage(msg);
    ch.close();
    return;
  }
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    if (!main) {
      notify({ kind: 'info', title: 'The main window is closed', body: 'Open Ganban\u2019s main window, then try again.' });
      return;
    }
    await emitTo('main', EVENT, msg);
    await main.unminimize().catch(() => {});
    await main.setFocus().catch(() => {});
  } catch (e) {
    console.warn('Open in Project > Tasks failed:', e);
  }
}

/** The App's side: act on "go to this task" from other windows. */
export function useGotoTaskMessages(): void {
  const busy = useRef(false);
  useEffect(() => {
    const go = async (m: GotoTaskMsg) => {
      if (busy.current || !m || typeof m.taskId !== 'number') return;
      busy.current = true;
      try {
        // A stub: goto re-reads the task from its host (and skips a hidden one).
        const stub = { id: m.taskId, project_id: m.projectId } as Task;
        if (!(await useNav.getState().goto(taskPlace(stub, m.ws)))) unavailable();
      } finally {
        busy.current = false;
      }
    };
    if (!isTauri()) {
      const ch = new BroadcastChannel(EVENT);
      ch.onmessage = (e) => void go(e.data as GotoTaskMsg);
      return () => ch.close();
    }
    let un: (() => void) | undefined;
    let dead = false;
    void (async () => {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const off = await getCurrentWebviewWindow().listen<GotoTaskMsg>(EVENT, (e) => void go(e.payload));
      if (dead) off();
      else un = off;
    })().catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);
}
