// Workspace-aware read helpers (K2 Stage C). These fetch a SPECIFIC
// workspace's data via an explicit transport handle — local through
// invokeLocal (the embedded SQLite, in-process), remote through invokeOnHost
// with that host's own URL + token. No active-transport globals are touched, so aggregating
// views can fan out across all workspaces CONCURRENTLY without the
// runInWorkspace global-divert races.
//
// The consumers (App sidebar/counts, HomeBoard, SearchBar) render in the
// desktop shell — which now also runs in a plain browser, where there is no
// Tauri `invoke` and the "local" workspace IS the host serving the page.
import { invokeLocal } from './api';
import { invokeOnHost, isWebClient, getDeviceToken } from './daemon';
import { LOCAL_ID, type Workspace } from './workspaces';
import type { HostPin } from './pinnedTabs.pure';
import type { Project, Task, Area, Event, ProjectStats, Comment, CommentBoard, CreateCommentInput, CreateTaskInput, MyAssignment, User, TimeEntry } from '../types';

async function call<T>(ws: Workspace, command: string, args?: Record<string, unknown>): Promise<T> {
  if (ws.id === LOCAL_ID) {
    // A browser has no embedded SQLite: its "local" host is the page's own
    // origin, reached with this device's token (loopback needs none).
    if (isWebClient()) return invokeOnHost<T>(window.location.origin, getDeviceToken(), command, args);
    return invokeLocal<T>(command, args);
  }
  return invokeOnHost<T>(ws.url ?? '', ws.token, command, args);
}

/** A project tagged with the workspace it came from (the client-only key). */
export const wsGetProjects = async (ws: Workspace): Promise<Project[]> =>
  (await call<Project[]>(ws, 'get_projects')).map((p) => ({ ...p, workspaceId: ws.id }));

export const wsGetTasks = async (ws: Workspace, projectId: number, archived = false): Promise<Task[]> =>
  (await call<Task[]>(ws, 'get_tasks', { projectId, archived })).map((t) => ({ ...t, workspaceId: ws.id }));

export const wsCreateTask = async (ws: Workspace, input: CreateTaskInput): Promise<Task> =>
  ({ ...(await call<Task>(ws, 'create_task', { input })), workspaceId: ws.id });

export const wsGetAreas = (ws: Workspace, projectId: number): Promise<Area[]> =>
  call<Area[]>(ws, 'get_areas', { projectId });

export const wsGetEvents = async (ws: Workspace, archived = false): Promise<Event[]> =>
  (await call<Event[]>(ws, 'get_events', { startDate: undefined, endDate: undefined, archived })).map((e) => ({ ...e, workspaceId: ws.id }));

export const wsGetProjectStats = (ws: Workspace, projectId: number): Promise<ProjectStats> =>
  call<ProjectStats>(ws, 'get_project_stats', { projectId });

export const wsGetTaskComments = (ws: Workspace, taskId: number): Promise<Comment[]> =>
  call<Comment[]>(ws, 'get_task_comments', { taskId });

export const wsGetUsers = (ws: Workspace): Promise<User[]> => call<User[]>(ws, 'get_users');

// The project comment board, routed to the project's OWN host (Home shows
// every workspace's boards side by side).
export const wsGetProjectCommentBoard = (
  ws: Workspace,
  projectId: number,
  opts: { taskIds?: number[]; limit?: number; since?: string } = {}
): Promise<CommentBoard> => call<CommentBoard>(ws, 'get_project_comment_board', { projectId, ...opts });
export const wsCreateComment = (ws: Workspace, input: CreateCommentInput): Promise<Comment> => {
  // A remote host stamps the authenticated author; the local path needs the
  // desktop's acting user (same as api.ts withCurrentUser).
  const userId = Number(localStorage.getItem('currentUserId')) || undefined;
  return call<Comment>(ws, 'create_comment', { input: { user_id: userId, ...input } });
};
export const wsUpdateComment = (ws: Workspace, commentId: number, content: string): Promise<Comment> =>
  call<Comment>(ws, 'update_comment', { commentId, input: { content } });
export const wsDeleteComment = (ws: Workspace, commentId: number): Promise<void> =>
  call<void>(ws, 'delete_comment', { commentId });
export const wsSetCommentTags = (ws: Workspace, commentId: number, taskIds: number[]): Promise<Comment> =>
  call<Comment>(ws, 'set_comment_tags', { commentId, taskIds });

export const wsGetProjectEvents = (ws: Workspace, projectId: number): Promise<Event[]> =>
  call<Event[]>(ws, 'get_project_events', { projectId, archived: false });

/** Live tasks assigned to ME on this workspace (MEMBER_AGENTS: the assignment
 * surface). The remote server scopes to the authenticated caller; the local
 * path passes the desktop's acting user. Tagged with the workspace id. */
export const wsMyAssignments = async (ws: Workspace): Promise<MyAssignment[]> => {
  const userId = Number(localStorage.getItem('currentUserId')) || 1;
  return (await call<MyAssignment[]>(ws, 'get_my_assignments', { userId })).map((a) => ({ ...a, workspaceId: ws.id }));
};

// --- mutations (explicit handle = no global divert; replaces runInWorkspace) ---
export const wsToggleProjectPin = (ws: Workspace, projectId: number, pinned: boolean): Promise<Project> =>
  call<Project>(ws, 'update_project', { projectId, input: { pinned } });

// Pinned tabs (the global top bar). Each lives on its project's host; a remote host
// stamps the signed-in user, the local path names the desktop's acting user.
const actingUser = () => Number(localStorage.getItem('currentUserId')) || undefined;
export const wsListTabPins = (ws: Workspace): Promise<HostPin[]> =>
  call<HostPin[]>(ws, 'list_tab_pins', { userId: actingUser() });
export const wsSetTabPin = (ws: Workspace, projectId: number, tabId: string, subView: string | null, position: number): Promise<HostPin> =>
  call<HostPin>(ws, 'set_tab_pin', { userId: actingUser(), projectId, tabId, subView, position });
export const wsUnpinTab = (ws: Workspace, projectId: number, tabId: string): Promise<void> =>
  call<void>(ws, 'unpin_tab', { userId: actingUser(), projectId, tabId });

export const wsArchiveProject = (ws: Workspace, projectId: number, archived: boolean): Promise<Project> =>
  call<Project>(ws, 'archive_project', { projectId, archived });

export const wsDeleteProject = (ws: Workspace, projectId: number): Promise<void> =>
  call<void>(ws, 'delete_project', { projectId });

// Bin lifecycle (restore / permanent delete) routed to the item's OWN host, so
// the merged Bin can't delete a colliding-id row on the wrong workspace.
export const wsRestoreEvent = (ws: Workspace, eventId: number): Promise<Event> =>
  call<Event>(ws, 'restore_event', { eventId });
export const wsPermanentlyDeleteEvent = (ws: Workspace, eventId: number): Promise<void> =>
  call<void>(ws, 'permanently_delete_event', { eventId });
export const wsRestoreTask = (ws: Workspace, taskId: number): Promise<Task> =>
  call<Task>(ws, 'restore_task', { taskId });
export const wsPermanentlyDeleteTask = (ws: Workspace, taskId: number): Promise<void> =>
  call<void>(ws, 'permanently_delete_task', { taskId });

// --- the timer (lib/timer.ts): routed to the task's OWN host ---
// Tracked time belongs to whoever ran the timer: a remote host stamps the
// signed-in user, the local path passes the desktop's acting user.

export const wsStartTimeEntry = (ws: Workspace, taskId: number): Promise<TimeEntry> =>
  call<TimeEntry>(ws, 'start_time_entry', { taskId, userId: actingUser() });
export const wsStopTimeEntry = (ws: Workspace, entryId: number): Promise<TimeEntry> =>
  call<TimeEntry>(ws, 'stop_time_entry', { entryId });
export const wsGetTaskTotalTime = (ws: Workspace, taskId: number): Promise<number> =>
  call<number>(ws, 'get_task_total_time', { taskId });

/** My running timer on this workspace, its task tagged with the workspace. */
export const wsGetMyRunningTimer = async (ws: Workspace): Promise<{ entry: TimeEntry; task: Task } | null> => {
  // The host serializes Option<(TimeEntry, Task)> as [entry, task].
  const r = await call<[TimeEntry, Task] | null>(ws, 'get_global_active_time_entry', { userId: actingUser() });
  return Array.isArray(r) && r.length === 2 ? { entry: r[0], task: { ...r[1], workspaceId: ws.id } } : null;
};

export interface RecentTimeTask {
  task_id: number;
  task: Task;
  total_seconds: number;
  last_tracked_at: string;
}
/** The tasks I tracked time on lately on this workspace, newest first. */
export const wsGetRecentTimeTasks = async (ws: Workspace, limit = 8): Promise<RecentTimeTask[]> =>
  (await call<RecentTimeTask[]>(ws, 'get_recent_time_tasks', { userId: actingUser(), limit })).map((r) => ({
    ...r,
    task: { ...r.task, workspaceId: ws.id },
  }));
