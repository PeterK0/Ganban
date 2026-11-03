// Standalone task window: the same TaskEditor, alone in its own OS window.
// Booted by main.tsx when the URL carries ?pane=task&project=..&task=..
// Transport is inherited via shared localStorage (active workspace, tokens).

import { useCallback, useEffect, useState } from 'react';
import { isWebClient } from '../lib/daemon';
import ThemeProvider from '../components/ThemeProvider';
import TaskEditor from '../components/TaskEditor';
import { getTasks } from '../lib/api';
import type { Task } from '../types';
import { ProjectTasksIcon } from '../components/DetailPane';
import { openInProjectTasks } from '../lib/gotoTask';
import { useTitleBarInset } from '../lib/titleBar';

export default function TaskWindow({ projectId, taskId }: { projectId: number; taskId: number }) {
  const [task, setTask] = useState<Task | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const titleInset = useTitleBarInset();

  const load = useCallback(async () => {
    try {
      const all = await getTasks(projectId);
      const t = all.find((x) => x.id === taskId) ?? null;
      if (!t) setErr('This task no longer exists (deleted or archived).');
      else {
        setTask(t);
        setErr(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, taskId]);

  useEffect(() => {
    void load();
    // Re-pull when the window regains focus — the cheap way to pick up edits
    // made in the main window without a dedicated pulse subscription.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Native window title tracks the task (via the Rust API — document.title
  // does not reach the NSWindow on macOS, the known wry gap). In a browser
  // popup there IS no native window: document.title is the whole story.
  useEffect(() => {
    if (!task) return;
    document.title = `${task.title} — Ganban`;
    if (isWebClient()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(`${task.title} — Ganban`);
      } catch {
        /* non-fatal */
      }
    })();
  }, [task?.title]);

  const closeSelf = async () => {
    if (isWebClient()) {
      window.close(); // script-opened popups may close themselves
      return;
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      /* non-fatal */
    }
  };

  return (
    <ThemeProvider>
      <div className="h-screen bg-mantle text-text flex flex-col min-h-0">
        {/* The window's own bar: it moves the window (the macOS title bar is
            overlaid, its buttons sit at the left) and holds the task's actions. */}
        <div
          className="flex-none h-[44px] flex items-center gap-2 px-2.5 bg-crust border-b border-gilt-b"
          style={titleInset ? { paddingLeft: titleInset } : undefined}
          data-tauri-drag-region
        >
          <span className="flex-1 min-w-0 truncate text-center text-[13px] text-subtext-0" data-tauri-drag-region>
            {task?.title ?? ''}
          </span>
          {task && (
            <button
              onClick={() => void openInProjectTasks(task)}
              title="Open in Project > Tasks"
              aria-label="Open in Project > Tasks"
              className="g-iconbtn"
            >
              <ProjectTasksIcon />
            </button>
          )}
        </div>
        {err ? (
          <div className="flex-1 grid place-items-center p-8">
            <div className="text-center space-y-2">
              <p className="text-sm text-subtext-0">{err}</p>
              <button onClick={() => void load()} className="g-btn g-btn-ghost g-btn-sm">
                Try again
              </button>
            </div>
          </div>
        ) : task ? (
          <div className="flex-1 min-h-0">
            <TaskEditor task={task} onSave={(t) => setTask(t)} onDelete={() => void closeSelf()} fill page />
          </div>
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-subtext-0">Loading task…</div>
        )}
      </div>
    </ThemeProvider>
  );
}
