// The ONE confirm seam. Native window.confirm does not exist on the desktop:
// Tauri shims it to the dialog plugin and returns a PROMISE — so the classic
// `if (!confirm(...)) return` guard never blocks (a Promise is truthy) and the
// destructive action runs WITHOUT asking, plus an unhandled rejection when the
// capability is missing (the 2026-07-02 bug report). Every confirmation in the
// app goes through here and is awaited.
import { isTauri } from './daemon';

export async function confirmDialog(message: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      return await confirm(message, { kind: 'warning' });
    } catch {
      // Plugin unavailable (old build): fail CLOSED for destructive flows.
      return false;
    }
  }
  return window.confirm(message);
}
