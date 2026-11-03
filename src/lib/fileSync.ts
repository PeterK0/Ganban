/**
 * Desktop file sync: keep a local mirror of a project's files at
 * `<root>/<Project>/<server path>`. Preferences (root folder, which projects)
 * are per-DEVICE, so they live in localStorage, not the synced DB. The actual
 * download runs in the Rust `sync_project_files` command.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDaemonBaseUrl, getDeviceToken, isTauri, isMobilePlatform, hasDaemon } from "./daemon";
import type { Project } from "../types";

const ROOT_KEY = "ganban-sync-root";
const PROJECTS_KEY = "ganban-sync-projects";

export interface FileSyncSummary {
  downloaded: number;
  skipped: number;
  failed: number;
  total: number;
  dest: string;
}

/** Only the installed desktop app (not mobile, not a browser) can write to disk. */
export function canSyncFiles(): boolean {
  return isTauri() && !isMobilePlatform() && hasDaemon();
}

export function getSyncRoot(): string | null {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
}
export function setSyncRoot(path: string | null): void {
  try {
    if (path) localStorage.setItem(ROOT_KEY, path);
    else localStorage.removeItem(ROOT_KEY);
  } catch {
    /* ignore */
  }
}

function enabledSet(): Set<number> {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return new Set<number>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
export function isProjectSyncEnabled(projectId: number): boolean {
  return enabledSet().has(projectId);
}
export function setProjectSyncEnabled(projectId: number, on: boolean): void {
  const s = enabledSet();
  if (on) s.add(projectId);
  else s.delete(projectId);
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

/** Download a project's files into `<root>/<project>/<server rel_path>`. */
export async function syncProjectFiles(project: Project): Promise<FileSyncSummary> {
  const root = getSyncRoot();
  const base = getDaemonBaseUrl();
  const token = getDeviceToken();
  if (!root) throw new Error("Pick a sync folder first.");
  if (!base || !token) throw new Error("Not connected to a daemon.");
  return await invoke<FileSyncSummary>("sync_project_files", {
    baseUrl: base,
    token,
    projectId: project.id,
    projectName: project.name,
    root,
  });
}

/** Best-effort sync of every enabled project (e.g. on app launch). */
export async function syncEnabledProjects(projects: Project[]): Promise<void> {
  if (!canSyncFiles() || !getSyncRoot()) return;
  const enabled = enabledSet();
  for (const p of projects) {
    if (enabled.has(p.id)) {
      try {
        await syncProjectFiles(p);
      } catch {
        /* best-effort; surfaced in the Files tab when run manually */
      }
    }
  }
}
