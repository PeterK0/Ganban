// Multi-window support (desktop only). Every extra window is the same built
// app booted with a `?pane=` query — main.tsx routes it to a standalone shell
// instead of the full App. All windows share the profile's localStorage, so
// the transport (active workspace, tokens, theme) is simply inherited.

import { isTauri, isWebClient } from './daemon';
import { pinWindowLabel, type Pin } from './pinnedTabs.pure';
import { TAB_MODULES } from '../tabs/modules';

/** macOS: the title bar is overlaid on the app (its own bar moves the window) and
 * the traffic lights centre in that bar: the full app's 60px top bar, or a task or
 * pinned tab's 44px strip. Other platforms ignore these. The title still names
 * the window in the Dock and Mission Control. */
async function overlayTitleBar(barHeight: 60 | 44) {
  const { LogicalPosition } = await import('@tauri-apps/api/dpi');
  return {
    titleBarStyle: 'overlay' as const,
    hiddenTitle: true,
    trafficLightPosition: new LogicalPosition(18, barHeight === 60 ? 23 : 15),
  };
}

/** Open a task in its own window (or focus it if it's already open).
 * Returns false when not running in the desktop app. */
export async function openTaskWindow(taskId: number, projectId: number, title?: string): Promise<boolean> {
  // A browser has windows too — the same ?pane= URL in a real popup.
  if (isWebClient()) {
    window.open(`?pane=task&project=${projectId}&task=${taskId}`, `task-${projectId}-${taskId}`,
      'width=820,height=860,noopener');
    return true;
  }
  if (!isTauri()) return false;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = `task-${projectId}-${taskId}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return true;
  }
  new WebviewWindow(label, {
    url: `index.html?pane=task&project=${projectId}&task=${taskId}`,
    title: title ? `${title} — Ganban` : `Task #${taskId} — Ganban`,
    width: 820,
    height: 860,
    ...(await overlayTitleBar(44)),
  });
  return true;
}

/** A pinned tab in its own window (the pin's "Open in new window"): the project page,
 * alone, opened at that tab. One window per pin; a second click focuses it. A tab module
 * may open its own window instead (`openPinWindow`, src/tabs/modules.ts). Like every extra
 * window, it uses the shared transport: the caller makes the pin's workspace the active one first. */
export async function openPinnedTabWindow(pin: Pin, title: string): Promise<boolean> {
  const own = TAB_MODULES.find((m) => m.id === pin.tab)?.openPinWindow?.(pin);
  if (own) return own;
  const q = new URLSearchParams({ pane: 'tab', ws: pin.ws, project: String(pin.project), tab: pin.tab });
  if (pin.sub) q.set('sub', pin.sub);
  const label = pinWindowLabel(pin);
  if (isWebClient()) return window.open(`?${q}`, label, 'width=1280,height=860') !== null;
  if (!isTauri()) return false;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return true;
  }
  new WebviewWindow(label, { url: `index.html?${q}`, title: `${title} \u2014 Ganban`, width: 1280, height: 860, minWidth: 800, minHeight: 560, ...(await overlayTitleBar(44)) });
  return true;
}

/** A whole second Ganban window — put the board in one, quizzes in another.
 * Labels are unique so any number can coexist. */
export async function openAppWindow(): Promise<boolean> {
  if (isWebClient()) {
    window.open(window.location.pathname, `ganban-${Date.now()}`, 'width=1280,height=820,noopener');
    return true;
  }
  if (!isTauri()) return false;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  new WebviewWindow(`extra-${Date.now()}`, {
    url: 'index.html',
    title: 'Ganban',
    width: 1280,
    height: 820,
    ...(await overlayTitleBar(60)),
  });
  return true;
}
