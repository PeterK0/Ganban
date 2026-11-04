import { invoke } from "@tauri-apps/api/core";
import { logApi, logPerformance } from "./logger";
import { isMobilePlatform, isWebClient, isDesktopOnline, isTauri, daemonFetch, uploadSharedFile, hasDaemon, getDaemonBaseUrl, getMe, DaemonError } from "./daemon";
import { localErrorParts } from "./hostError.pure";
import { parseProfile } from "./profile";
import type { ProjectFile } from "./daemon";
import type {
  Project,
  Area,
  Task,
  TaskAudience,
  TaskVisibility,
  TimeEntry,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectStats,
  ProjectMemberOverview,
  TaskAssignee,
  MyAssignment,
  ProjectAssignee,
  CreateTaskInput,
  UpdateTaskInput,
  CreateAreaInput,
  UpdateAreaInput,
  FileAttachment,
  CreateFileAttachmentInput,
  UpdateFileAttachmentInput,
  Comment,
  CreateCommentInput,
  CommentBoard,
  Notification,
  Ticket,
  UpdateCommentInput,
  GlobalActiveTimeEntry,
  Event,
  EventAttachment,
  EventTask,
  EventProject,
  CreateEventInput,
  UpdateEventInput,
  Contact,
  TaskContact,
  CreateContactInput,
  UpdateContactInput,
  User,
  CreateUserInput,
  UpdateUserInput,
  ModelKit,
  ModelBoard,
  ModelSection,
  ModelKitFile,
  ModelKitDetail,
  ModelBuildLogEntry,
  ModelFileKind,
  CreateModelKitInput,
  UpdateModelKitInput,
  CreateModelBoardInput,
  UpdateModelBoardInput,
  CreateModelSectionInput,
  UpdateModelSectionInput,
  MarkModelPartInput,
} from "../types";

/**
 * Decide where data comes from. This is the ONE transport seam — components and
 * the Zustand store never learn whether a call went to a local `invoke` or the
 * daemon over HTTP.
 *
 * Mobile (the native thin client) and a plain browser served by the daemon over
 * the tailnet both have no local database, so they always use HTTP. The desktop
 * app defaults to local `invoke`, but in "online" mode (a client of a remote
 * host) it also routes the full command surface over HTTP to that host.
 */
function useHttpTransport(): boolean {
  return isMobilePlatform() || isWebClient() || isDesktopOnline();
}

/**
 * HTTP transport: forward the command + its (camelCase) args to the daemon's
 * `/invoke` RPC endpoint, which mirrors Tauri `invoke` 1:1 over the full command
 * surface. Returns the parsed JSON result (or null for unit commands).
 */
async function httpInvoke<T>(
  command: string,
  args?: Record<string, any>
): Promise<T> {
  // 20s, not the 8s default: a host mid-model-generation legitimately takes
  // 4-8s to answer (field: get_events timing out all day while Ollama ran) —
  // a timeout that fires exactly when the machine is busiest is just noise.
  return daemonFetch<T>("/invoke", {
    method: "POST",
    body: JSON.stringify({ command, args: args ?? {} }),
  }, undefined, 20000);
}

/** Local-mode writes go straight to SQLite via Tauri — the embedded daemon
 * never sees them, so subscribed phones would stay stale on the primary
 * writer's edits. Report them: fire-and-forget the command name to the
 * daemon's /events/pulse (loopback = owner, no token needed; the server maps
 * it to a coarse kind and pulses). Reads are filtered here only to skip the
 * fetch; the server filters again. No daemon listening = a silently failed
 * fetch, which is exactly right (nothing to notify). */
export function reportLocalWrite(command: string): void {
  if (/^(get|list|verify|export)_/.test(command)) return;
  const base = getDaemonBaseUrl();
  if (!base) return;
  void fetch(`${base}/events/pulse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ what: command }),
  }).catch(() => {});
}

/** Desktop-only Tauri commands: they work on this machine's own files and
 * profiles, so they aren't commands of the host's table (ADR 0001) and the
 * local path calls them by name. Over HTTP the host refuses them. */
const DESKTOP_ONLY = new Set(["export_database", "import_database", "set_user_profile"]);

/**
 * Run a command against this desktop's own database: one generic Tauri
 * command runs any command of the host's command table in-process, as the
 * owner (ADR 0001). Authorship is the acting profile id the args carry.
 */
export function invokeLocal<T>(command: string, args?: Record<string, any>): Promise<T> {
  return invoke<T>("run_command", { command, args: args ?? {} }).catch((e: unknown) => {
    // A refusal with a code arrives as `{ error, code }`: rethrow it as the
    // DaemonError the HTTP path throws, so callers match `code` the same way.
    const parts = localErrorParts(e);
    throw parts?.code ? new DaemonError(parts.message, 400, parts.code) : e;
  });
}

/**
 * The same transport without the console log of the arguments: for commands whose data is
 * private to its user (Finance: amounts, payees, descriptions stay out of logs). A local write
 * isn't reported as a pulse either: a pulse reaches every member, and this data is no one else's.
 */
export function invokePrivate<T>(command: string, args?: Record<string, any>): Promise<T> {
  return useHttpTransport() ? httpInvoke<T>(command, args) : invokeLocal<T>(command, args);
}

/**
 * Wrapper for backend calls with automatic logging. Routes to the daemon (HTTP)
 * or the local Tauri backend (`invokeLocal`) per `useHttpTransport()`.
 */
async function invokeWithLogging<T>(
  command: string,
  args?: Record<string, any>
): Promise<T> {
  return logPerformance(
    command,
    async () => {
      logApi(command, 'API', args);
      let result: T;
      if (useHttpTransport()) {
        result = await httpInvoke<T>(command, args);
      } else {
        result = DESKTOP_ONLY.has(command) ? await invoke<T>(command, args) : await invokeLocal<T>(command, args);
        reportLocalWrite(command); // after success only — failed writes change nothing
      }
      return result;
    },
    'api'
  );
}

/**
 * Stamp the acting user (the desktop's selected user) into an input's author
 * field if not already set. On mobile this is ignored — the daemon overrides
 * authorship with the authenticated user — so it's safe on both.
 */
function withCurrentUser<T extends Record<string, any>>(input: T, field: string): T {
  if (input[field] != null) return input;
  const id = Number(localStorage.getItem("currentUserId"));
  return id ? ({ ...input, [field]: id } as T) : input;
}

// ============== Project API ==============

// ============== Model Assembly (Gundam + Warhammer) ==============

export async function listModelKits(projectId: number): Promise<ModelKit[]> {
  return await invokeWithLogging("list_model_kits", { projectId });
}
export async function createModelKit(input: CreateModelKitInput): Promise<ModelKit> {
  return await invokeWithLogging("create_model_kit", { input });
}
export async function updateModelKit(kitId: number, input: UpdateModelKitInput): Promise<ModelKit> {
  return await invokeWithLogging("update_model_kit", { kitId, input });
}
export async function deleteModelKit(kitId: number): Promise<void> {
  await invokeWithLogging("delete_model_kit", { kitId });
}
export async function getModelKitDetail(kitId: number): Promise<ModelKitDetail> {
  return await invokeWithLogging("get_model_kit_detail", { kitId });
}
export async function createModelBoard(input: CreateModelBoardInput): Promise<ModelBoard> {
  return await invokeWithLogging("create_model_board", { input });
}
export async function updateModelBoard(boardId: number, input: UpdateModelBoardInput): Promise<ModelBoard> {
  return await invokeWithLogging("update_model_board", { boardId, input });
}
export async function deleteModelBoard(boardId: number): Promise<void> {
  await invokeWithLogging("delete_model_board", { boardId });
}
export async function createModelSection(input: CreateModelSectionInput): Promise<ModelSection> {
  return await invokeWithLogging("create_model_section", { input });
}
export async function updateModelSection(sectionId: number, input: UpdateModelSectionInput): Promise<ModelSection> {
  return await invokeWithLogging("update_model_section", { sectionId, input });
}
export async function deleteModelSection(sectionId: number): Promise<void> {
  await invokeWithLogging("delete_model_section", { sectionId });
}
/** Returns `[marked, autoDuplicated]`. */
export async function markModelPart(input: MarkModelPartInput): Promise<[boolean, boolean]> {
  return await invokeWithLogging("mark_model_part", { input });
}
export async function unmarkModelPart(kitId: number, boardName: string, partNumber: number): Promise<boolean> {
  return await invokeWithLogging("unmark_model_part", { kitId, boardName, partNumber });
}
export async function linkModelKitFile(
  kitId: number, fileId: number, kind: ModelFileKind, caption?: string,
): Promise<ModelKitFile> {
  return await invokeWithLogging("link_model_kit_file", { kitId, fileId, kind, caption: caption ?? null });
}
export async function unlinkModelKitFile(linkId: number): Promise<void> {
  await invokeWithLogging("unlink_model_kit_file", { linkId });
}
export async function getModelBuildLog(kitId: number): Promise<ModelBuildLogEntry[]> {
  return await invokeWithLogging("get_model_build_log", { kitId });
}

export async function getProjects(): Promise<Project[]> {
  return await invokeWithLogging("get_projects");
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  return await invokeWithLogging("create_project", { input });
}

export async function deleteProject(projectId: number): Promise<void> {
  await invokeWithLogging("delete_project", { projectId });
}

export async function archiveProject(
  projectId: number,
  archived: boolean
): Promise<Project> {
  return await invokeWithLogging("archive_project", { projectId, archived });
}

export async function updateProject(
  projectId: number,
  input: UpdateProjectInput
): Promise<Project> {
  return await invokeWithLogging("update_project", { projectId, input });
}

export async function toggleProjectPin(
  projectId: number,
  pinned: boolean
): Promise<Project> {
  return await invokeWithLogging("update_project", {
    projectId,
    input: { pinned }
  });
}

export async function getProjectStats(projectId: number): Promise<ProjectStats> {
  return await invokeWithLogging("get_project_stats", { projectId });
}

export async function getProjectMemberOverview(projectId: number): Promise<ProjectMemberOverview[]> {
  return await invokeWithLogging("get_project_member_overview", { projectId });
}

// ----- Task assignment (MEMBER_AGENTS: "this task belongs to Alice", as data) -----

export async function getAssignees(taskId: number): Promise<TaskAssignee[]> {
  return await invokeWithLogging("get_assignees", { taskId });
}

/** Every assignment in a project on live tasks, one call — for board chips. */
export async function getProjectAssignees(projectId: number): Promise<ProjectAssignee[]> {
  return await invokeWithLogging("get_project_assignees", { projectId });
}

/** Assign a task to a CONTACT (a responsible party who isn't a member).
 * `assignedBy` is overridden server-side on the daemon path. */
export async function assignContact(taskId: number, contactId: number, assignedBy: number): Promise<void> {
  await invokeWithLogging("assign_contact", { taskId, contactId, assignedBy });
}

export async function unassignContact(taskId: number, contactId: number): Promise<void> {
  await invokeWithLogging("unassign_contact", { taskId, contactId });
}

/** Assign a task to a project member, optionally with an ADVISORY work brief
 * (`{protocol?, notes?, acceptance?}` — rendered on the assignee's side, never
 * executed). `assignedBy` is overridden server-side on the daemon path. */
export async function assignTask(
  taskId: number,
  userId: number,
  assignedBy: number,
  brief?: Record<string, unknown> | null
): Promise<void> {
  await invokeWithLogging("assign_task", { taskId, userId, assignedBy, brief: brief ?? null });
}

export async function unassignTask(taskId: number, userId: number): Promise<void> {
  await invokeWithLogging("unassign_task", { taskId, userId });
}

/** Live tasks assigned to this user, newest assignment first. On the daemon
 * path the server scopes to the AUTHENTICATED caller regardless of the arg. */
/** Human focus (timer) vs agent runtime (ledger) for a project: totals + a
 * 14-day series — the man-hours/AI-hours correlation surface. */
export interface TimeCorrelation {
  human_seconds: number;
  agent_seconds: number;
  days: { date: string; human_seconds: number; agent_seconds: number }[];
}
export async function getTimeCorrelation(projectId: number): Promise<TimeCorrelation> {
  return await invokeWithLogging("get_time_correlation", { projectId });
}

export async function myAssignments(userId: number): Promise<MyAssignment[]> {
  return await invokeWithLogging("get_my_assignments", { userId });
}

/** Set (or clear, with null) the project's default assistant personality. */
export async function setProjectModelProfile(projectId: number, profileId: number | null): Promise<void> {
  await invokeWithLogging("set_project_model_profile", { projectId, profileId });
}

// ============== Area API ==============

export async function getAreas(projectId: number): Promise<Area[]> {
  return await invokeWithLogging("get_areas", { projectId });
}

export async function createArea(input: CreateAreaInput): Promise<Area> {
  return await invokeWithLogging("create_area", { input });
}

export async function updateArea(
  areaId: number,
  input: UpdateAreaInput
): Promise<Area> {
  return await invokeWithLogging("update_area", { areaId, input });
}

export async function deleteArea(areaId: number): Promise<void> {
  await invokeWithLogging("delete_area", { areaId });
}

// ----- Task visibility (ADR 0002) -----

/** Restrict an area to its area members, or open it to the project (admins). */
export async function setAreaRestricted(areaId: number, restricted: boolean): Promise<void> {
  await invokeWithLogging("set_area_restricted", { areaId, restricted });
}

/** Replace an area's members (admins); they must be project members. */
export async function setAreaMembers(areaId: number, userIds: number[]): Promise<void> {
  await invokeWithLogging("set_area_members", { areaId, userIds });
}

export async function getAreaMembers(areaId: number): Promise<number[]> {
  return await invokeWithLogging("get_area_members", { areaId });
}

/** Who may see a task (admins): its area's say, selected members, or admins only. */
export async function setTaskVisibility(taskId: number, visibility: TaskVisibility, memberIds: number[] = []): Promise<TaskAudience> {
  return await invokeWithLogging("set_task_visibility", { taskId, visibility, memberIds });
}

/** Who can see a task (its 🔒 badge, the @mention warning). */
export async function getTaskAudience(taskId: number): Promise<TaskAudience> {
  return await invokeWithLogging("get_task_audience", { taskId });
}

// ============== Task API ==============

export async function getTasks(
  projectId: number,
  archived?: boolean
): Promise<Task[]> {
  return await invokeWithLogging("get_tasks", { projectId, archived });
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return await invokeWithLogging("create_task", { input });
}

export async function updateTask(
  taskId: number,
  input: UpdateTaskInput
): Promise<Task> {
  return await invokeWithLogging("update_task", { taskId, input });
}

export async function updateTaskStatus(
  taskId: number,
  status: string
): Promise<Task> {
  return await invokeWithLogging("update_task_status", { taskId, status });
}

export async function deleteTask(taskId: number): Promise<void> {
  await invokeWithLogging("delete_task", { taskId });
}

export async function restoreTask(taskId: number): Promise<Task> {
  return await invokeWithLogging("restore_task", { taskId });
}

export async function permanentlyDeleteTask(taskId: number): Promise<void> {
  await invokeWithLogging("permanently_delete_task", { taskId });
}

export async function archiveTask(
  taskId: number,
  archived: boolean
): Promise<Task> {
  return await invokeWithLogging("archive_task", { taskId, archived });
}

export async function toggleTaskPin(
  taskId: number,
  pinned: boolean
): Promise<Task> {
  return await invokeWithLogging("update_task", {
    taskId,
    input: { pinned }
  });
}

// ============== Time Tracking API ==============

export async function startTimeEntry(
  taskId: number,
  notes?: string
): Promise<TimeEntry> {
  // Attribute the time to the local current user; the daemon overrides this with
  // the authenticated user, so it's only trusted on the local desktop path.
  const userId = Number(localStorage.getItem("currentUserId")) || undefined;
  return await invokeWithLogging("start_time_entry", { taskId, notes, userId });
}

export async function stopTimeEntry(
  entryId: number,
  notes?: string
): Promise<TimeEntry> {
  return await invokeWithLogging("stop_time_entry", { entryId, notes });
}

export async function getTimeEntries(taskId: number): Promise<TimeEntry[]> {
  return await invokeWithLogging("get_time_entries", { taskId });
}

export async function getActiveTimeEntry(
  taskId: number
): Promise<TimeEntry | null> {
  return await invokeWithLogging("get_active_time_entry", { taskId });
}

export async function deleteTimeEntry(entryId: number): Promise<void> {
  await invokeWithLogging("delete_time_entry", { entryId });
}

export async function getTaskTotalTime(taskId: number): Promise<number> {
  return await invokeWithLogging("get_task_total_time", { taskId });
}

// ============== File Attachment API ==============

export async function getFileAttachments(
  taskId: number
): Promise<FileAttachment[]> {
  return await invokeWithLogging("get_file_attachments", { taskId });
}

export async function createFileAttachment(
  input: CreateFileAttachmentInput
): Promise<FileAttachment> {
  return await invokeWithLogging("create_file_attachment", { input: withCurrentUser(input, "uploaded_by") });
}

export async function updateFileAttachment(
  attachmentId: number,
  input: UpdateFileAttachmentInput
): Promise<FileAttachment> {
  return await invokeWithLogging("update_file_attachment", { attachmentId, input });
}

export async function deleteFileAttachment(
  attachmentId: number
): Promise<void> {
  await invokeWithLogging("delete_file_attachment", { attachmentId });
}

export async function verifyFileAttachment(
  attachmentId: number
): Promise<FileAttachment> {
  return await invokeWithLogging("verify_file_attachment", { attachmentId });
}

// ============== Comment API ==============

export async function getTaskComments(taskId: number): Promise<Comment[]> {
  return await invokeWithLogging("get_task_comments", { taskId });
}

export async function createComment(
  input: CreateCommentInput
): Promise<Comment> {
  return await invokeWithLogging("create_comment", { input: withCurrentUser(input, "user_id") });
}

export async function updateComment(
  commentId: number,
  input: UpdateCommentInput
): Promise<Comment> {
  return await invokeWithLogging("update_comment", { commentId, input });
}

export async function deleteComment(commentId: number): Promise<void> {
  await invokeWithLogging("delete_comment", { commentId });
}

/** Retag a top-level comment: `taskIds` becomes its full tag set (≥1, same project). */
export async function setCommentTags(commentId: number, taskIds: number[]): Promise<Comment> {
  return await invokeWithLogging("set_comment_tags", { commentId, taskIds });
}

/** The project comment board: newest top-level comments (optionally only those
 * tagged with ANY of `taskIds`), their replies, per-task counts, and the time
 * tracked per task since `since` (the client's midnight → "worked on today"). */
export async function getProjectCommentBoard(
  projectId: number,
  opts: { taskIds?: number[]; limit?: number; since?: string } = {}
): Promise<CommentBoard> {
  return await invokeWithLogging("get_project_comment_board", { projectId, ...opts });
}

// ============== Global Active Time Entry API ==============

export async function getGlobalActiveTimeEntry(): Promise<GlobalActiveTimeEntry | null> {
  return await invokeWithLogging("get_global_active_time_entry");
}

// ============== Event API ==============

export async function getEvents(
  startDate?: string,
  endDate?: string,
  archived?: boolean
): Promise<Event[]> {
  return await invokeWithLogging("get_events", { startDate, endDate, archived });
}

export async function getEvent(eventId: number): Promise<Event> {
  return await invokeWithLogging("get_event", { eventId });
}

export async function createEvent(input: CreateEventInput): Promise<Event> {
  return await invokeWithLogging("create_event", { input });
}

export async function updateEvent(
  eventId: number,
  input: UpdateEventInput
): Promise<Event> {
  return await invokeWithLogging("update_event", { eventId, input });
}

export async function deleteEvent(eventId: number): Promise<void> {
  await invokeWithLogging("delete_event", { eventId });
}

export async function archiveEvent(
  eventId: number,
  archived: boolean
): Promise<Event> {
  return await invokeWithLogging("archive_event", { eventId, archived });
}

export async function restoreEvent(eventId: number): Promise<Event> {
  return await invokeWithLogging("restore_event", { eventId });
}

export async function permanentlyDeleteEvent(eventId: number): Promise<void> {
  await invokeWithLogging("permanently_delete_event", { eventId });
}

/** Mark an event past by hand (`done`), or upcoming again. A recurring event's
 * whole series goes with it. */
export async function setEventDone(eventId: number, done: boolean): Promise<Event> {
  return await invokeWithLogging("set_event_done", { eventId, done });
}

/** An event's files, and whether the caller may upload and delete them (the
 * owner and the workspace admins). Uploads go through `uploadEventFile`. */
export async function getEventFiles(eventId: number): Promise<{ files: EventAttachment[]; canManage: boolean }> {
  return await invokeWithLogging("get_event_files", { eventId });
}

export async function deleteEventFile(fileId: number): Promise<void> {
  await invokeWithLogging("delete_event_file", { fileId });
}

export async function linkEventToTask(
  eventId: number,
  taskId: number
): Promise<EventTask> {
  return await invokeWithLogging("link_event_to_task", { eventId, taskId });
}

export async function unlinkEventFromTask(
  eventId: number,
  taskId: number
): Promise<void> {
  await invokeWithLogging("unlink_event_from_task", { eventId, taskId });
}

export async function getEventTasks(eventId: number): Promise<Task[]> {
  return await invokeWithLogging("get_event_tasks", { eventId });
}

/** IDs of every event linked to at least one task — the agenda's "hide events
 * connected to tasks" filter masks against this. */
export async function getTaskLinkedEventIds(): Promise<number[]> {
  return await invokeWithLogging("get_task_linked_event_ids");
}

export async function getTaskEvents(taskId: number): Promise<Event[]> {
  return await invokeWithLogging("get_task_events", { taskId });
}

export async function linkEventToProject(
  eventId: number,
  projectId: number
): Promise<EventProject> {
  return await invokeWithLogging("link_event_to_project", { eventId, projectId });
}

export async function unlinkEventFromProject(
  eventId: number,
  projectId: number
): Promise<void> {
  await invokeWithLogging("unlink_event_from_project", { eventId, projectId });
}

export async function getEventProjects(eventId: number): Promise<Project[]> {
  return await invokeWithLogging("get_event_projects", { eventId });
}

export async function getProjectEvents(
  projectId: number,
  archived?: boolean
): Promise<Event[]> {
  return await invokeWithLogging("get_project_events", { projectId, archived });
}

// ============ Contact functions ============

export async function getContacts(archived?: boolean): Promise<Contact[]> {
  return await invokeWithLogging("get_contacts", { archived });
}

export async function getContact(contactId: number): Promise<Contact> {
  return await invokeWithLogging("get_contact", { contactId });
}

export async function createContact(
  input: CreateContactInput
): Promise<Contact> {
  return await invokeWithLogging("create_contact", { input });
}

export async function updateContact(
  contactId: number,
  input: UpdateContactInput
): Promise<Contact> {
  return await invokeWithLogging("update_contact", { contactId, input });
}

export async function deleteContact(contactId: number): Promise<void> {
  await invokeWithLogging("delete_contact", { contactId });
}

export async function restoreContact(contactId: number): Promise<Contact> {
  return await invokeWithLogging("restore_contact", { contactId });
}

export async function permanentlyDeleteContact(contactId: number): Promise<void> {
  await invokeWithLogging("permanently_delete_contact", { contactId });
}

export async function linkContactToTask(
  taskId: number,
  contactId: number
): Promise<TaskContact> {
  return await invokeWithLogging("link_contact_to_task", { taskId, contactId });
}

export async function unlinkContactFromTask(
  taskId: number,
  contactId: number
): Promise<void> {
  await invokeWithLogging("unlink_contact_from_task", { taskId, contactId });
}

export async function getTaskContacts(taskId: number): Promise<Contact[]> {
  return await invokeWithLogging("get_task_contacts", { taskId });
}

export async function getContactTasks(contactId: number): Promise<Task[]> {
  return await invokeWithLogging("get_contact_tasks", { contactId });
}

// ============== User API ==============

export async function getUsers(): Promise<User[]> {
  return await invokeWithLogging("get_users", {});
}

export async function getActiveUsers(): Promise<User[]> {
  return await invokeWithLogging("get_active_users", {});
}

export async function getUser(userId: number): Promise<User> {
  return await invokeWithLogging("get_user", { userId });
}

export async function createUser(input: CreateUserInput): Promise<User> {
  return await invokeWithLogging("create_user", { input });
}

export async function updateUser(
  userId: number,
  input: UpdateUserInput
): Promise<User> {
  return await invokeWithLogging("update_user", { userId, input });
}

export async function deleteUser(userId: number): Promise<void> {
  await invokeWithLogging("delete_user", { userId });
}

/** Set/change a profile PIN (4–8 digits) or clear it with null. Self-or-owner. */
export async function setUserPin(userId: number, pin: string | null): Promise<User> {
  return await invokeWithLogging("set_user_pin", { userId, pin });
}

/** Check a PIN attempt for a profile. A profile with no PIN verifies trivially. */
export async function verifyUserPin(userId: number, pin: string): Promise<boolean> {
  return await invokeWithLogging("verify_user_pin", { userId, pin });
}

// ---- Self-service account (networked members, over the daemon) ----

/** Rename the authenticated account (the daemon edits only the caller's own user). */
export async function setMyDisplayName(fullName: string): Promise<void> {
  await invokeWithLogging("set_my_display_name", { fullName });
}

/** Replace the authenticated account's profile blob (theme, avatar, vCard). */
export async function setMyProfile(profileJson: string): Promise<User> {
  return await invokeWithLogging("set_my_profile", { profileJson });
}

/** The caller's notifications (most recent first). Online: the host scopes to the
 * authenticated user; local: the desktop's current user id. */
export async function getNotifications(): Promise<Notification[]> {
  const userId = Number(localStorage.getItem('currentUserId')) || 0;
  return await invokeWithLogging("get_notifications", { userId });
}

/** Mark all of the caller's notifications read (server-side, so they don't reappear). */
export async function markNotificationsRead(): Promise<void> {
  const userId = Number(localStorage.getItem('currentUserId')) || 0;
  await invokeWithLogging("mark_notifications_read", { userId });
}

/** File a ticket (bug report / feature request) against the host. The local
 * Tauri command needs the user id (the online /invoke path derives it from the
 * authenticated session and ignores this), like the notifications calls. */
export async function createTicket(kind: 'bug' | 'feature', title: string, body?: string): Promise<Ticket> {
  const userId = Number(localStorage.getItem('currentUserId')) || 0;
  return await invokeWithLogging("create_ticket", { userId, kind, title, body });
}

/** List tickets: the owner sees all; everyone else sees only their own (host scopes). */
export async function listTickets(): Promise<Ticket[]> {
  const userId = Number(localStorage.getItem('currentUserId')) || 0;
  return await invokeWithLogging("list_tickets", { userId });
}

/** Set a ticket's status (owner only, enforced host-side). */
export async function setTicketStatus(id: number, status: 'open' | 'closed'): Promise<void> {
  await invokeWithLogging("set_ticket_status", { id, status });
}

/** The current user's personal custom emojis (from their profile blob), in either
 * transport mode. Used to merge "my" emojis into the picker + render map. */
export async function getMyCustomEmojis(): Promise<{ name: string; image: string }[]> {
  let profileJson: string | null | undefined;
  if (isDesktopOnline()) {
    profileJson = (await getMe()).user.profile_json;
  } else {
    const id = Number(localStorage.getItem('currentUserId'));
    if (id) profileJson = (await getUser(id)).profile_json;
  }
  return parseProfile(profileJson).customEmojis ?? [];
}

/** Desktop/owner: replace any user's profile blob. */
export async function setUserProfile(userId: number, profileJson: string | null): Promise<User> {
  return await invokeWithLogging("set_user_profile", { userId, profileJson });
}

/** Leave a project the authenticated account is a member of. */
export async function leaveProject(projectId: number): Promise<void> {
  await invokeWithLogging("leave_project", { projectId });
}

// ---- Shared-file storage ----

export interface ProjectStorage {
  used: number;
  quota: number;
}

/** Used/quota bytes for a project's shared files (works on desktop + over HTTP). */
// Shared files + their quota live ONLY on the host. In desktop "local" mode the
// generic seam would hit this machine's replica (where files don't live), so a
// quota set there isn't the one enforced on upload — the symptom of "changing
// the limit does nothing". Route storage straight to the daemon whenever one is
// reachable, matching how the file list is served.
export async function getProjectStorage(projectId: number): Promise<ProjectStorage> {
  if (hasDaemon()) {
    return await daemonFetch<ProjectStorage>("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "get_project_storage", args: { projectId } }),
    });
  }
  return await invokeWithLogging("get_project_storage", { projectId });
}

/** Set a project's shared-storage allocation (admin/owner) — on the host. */
export async function setProjectQuota(projectId: number, bytes: number): Promise<void> {
  if (hasDaemon()) {
    await daemonFetch("/invoke", {
      method: "POST",
      body: JSON.stringify({ command: "set_project_quota", args: { projectId, bytes } }),
    });
    return;
  }
  await invokeWithLogging("set_project_quota", { projectId, bytes });
}

// ---- Share links (docs/design/SHARE_LINKS.md, ADR 0006) ----
// A task's or a project's files handed to someone outside the team through the share door.
// The links live only on the host, so like storage they go straight to the
// daemon whenever one is reachable.

export type ShareLinkStatus = "preparing" | "active" | "expired" | "revoked";

export interface ShareLink {
  id: number;
  /** The task it was made from; null for one made from the project's Files. */
  taskId: number | null;
  projectId: number;
  label: string;
  /** The public URL (publicUrl + path), or null when the host has no GANBAN_SHARE_URL. */
  url: string | null;
  /** "/s/<token>" */
  path: string;
  status: ShareLinkStatus;
  /** ISO time, or null for never. */
  expiresAt: string | null;
  hasPassword: boolean;
  fileCount: number;
  totalBytes: number;
  downloadCount: number;
  lastDownloadAt: string | null;
  revokedAt: string | null;
  createdBy: number | null;
  createdAt: string;
}

export interface ShareDoor {
  enabled: boolean;
  publicUrl: string | null;
}

/** Whose share links: a task's, or a project's (made from its Files or any of its tasks). */
export type ShareScope = { taskId: number } | { projectId: number };

export type CreateShareLinkInput = ShareScope & {
  /** Task attachments. Default (with projectFileIds left out too): every host-stored file of
   * the task, or every one of the project's own files. */
  attachmentIds?: number[];
  /** The project's own files. */
  projectFileIds?: number[];
  /** Default: the task's (or project's) title, or the folder's name when every file shares one top folder. */
  label?: string;
  /** Days until it expires, or null for never. Default 7. */
  expiresInDays?: number | null;
  password?: string;
};

async function hostInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (hasDaemon()) {
    return await daemonFetch<T>("/invoke", { method: "POST", body: JSON.stringify({ command, args }) });
  }
  return await invokeWithLogging<T>(command, args);
}

/** Make a share link for host-stored files of a task or a project (project admins and the owner). */
export async function createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
  return hostInvoke<ShareLink>("create_share_link", { ...input });
}

/** A task's or a project's share links, newest first, revoked and expired included. */
export async function listShareLinks(scope: ShareScope): Promise<ShareLink[]> {
  return hostInvoke<ShareLink[]>("list_share_links", { ...scope });
}

/** Revoke a share link: its page and downloads stop at once. */
export async function revokeShareLink(linkId: number): Promise<ShareLink> {
  return hostInvoke<ShareLink>("revoke_share_link", { linkId });
}

/** Whether the host has a share door, and its public URL. */
export async function getShareDoor(): Promise<ShareDoor> {
  return hostInvoke<ShareDoor>("get_share_door", {});
}

/** Which kind of file `setFileAiIncluded` names: a task attachment or a project file. */
export type AiFileKind = "attachment" | "project";

/**
 * Put a file in or out of the AI overview (the project's knowledge base); new files
 * start out. Project admins, the owner and the file's uploader may. Over the host's size
 * guard (GANBAN_AI_MAX_FILE_MB, default 50) including is refused unless `force` is true;
 * the refusal carries the code AI_FILE_TOO_LARGE (lib/hostError.pure.ts) so the UI can
 * ask whether to index it anyway. Runs on the host, where the index lives. Returns the
 * updated row: a FileAttachment or a ProjectFile.
 */
export async function setFileAiIncluded<T extends FileAttachment | ProjectFile = FileAttachment | ProjectFile>(
  kind: AiFileKind,
  id: number,
  included: boolean,
  force = false,
): Promise<T> {
  return hostInvoke<T>("set_file_ai_included", { kind, id, included, force });
}

// ---- Files: names, folders and where the bytes live (lane files-ui) ----

/** Where a file browser's folders live: a project's own files, or one task's. */
export interface FolderScope {
  projectId: number;
  /** A task's own files; left out for the project's. */
  taskId?: number;
}

/** Rename a task attachment or a project file in its folder. The host refuses `/`,
 * control and invisible characters, and a name already taken there. Returns the row. */
export async function renameFile(kind: AiFileKind, id: number, name: string): Promise<FileAttachment | ProjectFile> {
  return hostInvoke("rename_file", { kind, id, name });
}

/** A scope's explicit folders: empty ones exist only here (the rest come from file paths). */
export async function listFileFolders(scope: FolderScope): Promise<string[]> {
  return hostInvoke<string[]>("list_file_folders", { ...scope });
}

/** Create a folder ("a/b") that survives with nothing in it. Idempotent. */
export async function createFileFolder(scope: FolderScope, path: string): Promise<string> {
  return hostInvoke<string>("create_file_folder", { ...scope, path });
}

/** Remove a folder that holds no files. */
export async function deleteFileFolder(scope: FolderScope, path: string): Promise<void> {
  await hostInvoke("delete_file_folder", { ...scope, path });
}

/** Rename or move a folder: every file under `from` moves under `to`. */
export async function renameFileFolder(scope: FolderScope, from: string, to: string): Promise<{ moved: number }> {
  return hostInvoke("rename_folder", { ...scope, from, to });
}

/** Move files into a folder (`dir: ""` is the root): project files, or with `taskId` that task's attachments. */
export async function moveFilesTo(scope: FolderScope, ids: number[], dir: string): Promise<{ moved: number }> {
  return hostInvoke("move_files", { ...scope, ids, dir });
}

/** Where the host keeps file bytes (owner, or an admin of `projectId`). */
export interface StorageLocation {
  /** Attachments live here as `<root>/<id>`. */
  root: string;
  /** A project's own files: `<root>/pf/<id>`, shared by every project. */
  projectDir?: string | null;
  hostName: string;
  /** The caller runs in the host's own process (the desktop app). */
  isThisMachine: boolean;
}

export async function getStorageLocation(projectId?: number): Promise<StorageLocation> {
  return hostInvoke<StorageLocation>("get_storage_location", projectId == null ? {} : { projectId });
}

/** Global app settings (desktop/owner) — e.g. the default per-project quota. */
export async function getAppSetting(key: string): Promise<string | null> {
  return await invokeWithLogging("get_app_setting", { key });
}
export async function setAppSetting(key: string, value: string): Promise<void> {
  await invokeWithLogging("set_app_setting", { key, value });
}

// ---- Automations — rules engine (Epoch M(a)), owner-only ----
export interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  trigger_json: string;
  action_json: string;
  created_at: string;
  last_fired_at: string | null;
  fire_count: number;
}
export interface NewRule {
  name: string;
  trigger_json: string;
  action_json: string;
  enabled: boolean;
}
export async function listRules(): Promise<Rule[]> {
  return await invokeWithLogging("list_rules", {});
}
export async function createRule(input: NewRule): Promise<Rule> {
  return await invokeWithLogging("create_rule", { input });
}
export async function updateRule(ruleId: number, input: Partial<NewRule>): Promise<Rule> {
  return await invokeWithLogging("update_rule", { ruleId, input });
}
export async function deleteRule(ruleId: number): Promise<void> {
  await invokeWithLogging("delete_rule", { ruleId });
}

/** Copy a local attachment's bytes (on the machine running the command) into the project allocation. */
export async function shareFileAttachment(attachmentId: number): Promise<FileAttachment> {
  return await invokeWithLogging("share_file_attachment", { attachmentId });
}

/** Stop sharing (delete the server copy; keep the local file). */
export async function unshareFileAttachment(attachmentId: number): Promise<FileAttachment> {
  return await invokeWithLogging("unshare_file_attachment", { attachmentId });
}

/** Attach a pasted/clipboard image to a task as a shared file (so it embeds in a
 * comment or description and the team can see it). Transport-aware: a thin client
 * uploads over HTTP; the desktop hands the bytes to its local core. */
export async function attachPastedImage(taskId: number, file: File): Promise<FileAttachment> {
  // When a daemon is reachable (desktop-local to loopback, desktop-online to a
  // remote host, web, or mobile) upload over HTTP so the attachment lands on the
  // SAME host the markdown will later fetch it from. The Tauri invoke path is a
  // last-resort fallback for the no-daemon edge case — and critically, on an
  // ONLINE desktop it MUST NOT be used (it would store locally while rendering
  // fetches from the remote host, producing an unrenderable /files/<id> ref).
  if (hasDaemon()) {
    // quiet: a pasted screenshot shouldn't flash the upload bar or the bell.
    return (await uploadSharedFile(taskId, file, { quiet: true })) as FileAttachment;
  }
  if (!isTauri()) {
    throw new Error("Not connected to a daemon and not running in the desktop app");
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const uploadedBy = Number(localStorage.getItem("currentUserId") ?? "0") || null;
  return await invoke<FileAttachment>("attach_pasted_image", {
    taskId,
    fileName: file.name || "pasted.png",
    fileType: file.type || "image/png",
    bytes: Array.from(buf),
    uploadedBy,
  });
}

/** A user's setting: its value, or null when unset (the host returns the value alone). */
export async function getUserSetting(
  userId: number,
  settingKey: string
): Promise<string | null> {
  return await invokeWithLogging("get_user_setting", { userId, settingKey });
}

export async function setUserSetting(
  userId: number,
  settingKey: string,
  settingValue: string
): Promise<void> {
  await invokeWithLogging("set_user_setting", { userId, settingKey, settingValue });
}

// ============== Storage paths (desktop-only) ==============

export interface StoragePaths {
  /** App data root: holds gansty.db and the shared/ file store. */
  data_dir: string;
  /** Where logs are written (ganban-server.log*, *-engine.log). */
  log_dir: string;
  /** The local database file. */
  db_path: string;
}

/** Where Ganban keeps its data on this machine. Desktop-only (local dirs); call
 * a raw Tauri `invoke` directly — this never routes to a remote daemon. */
export async function getStoragePaths(): Promise<StoragePaths> {
  return invoke<StoragePaths>("get_storage_paths");
}

// ============== Database Backup/Restore API ==============

export async function exportDatabase(exportPath: string): Promise<void> {
  await invokeWithLogging("export_database", { exportPath });
}

export async function importDatabase(importPath: string): Promise<void> {
  await invokeWithLogging("import_database", { importPath });
}

// ── Quiz domain (QuizForge adoption) ─────────────────────────────────────────
import type {
  QuizSubject, QuizTopic, QuizTopicWithSubject, QuizQuestion, QuizDef, QuizAttempt,
} from '../types';

export async function getQuizSubjects(projectId: number): Promise<QuizSubject[]> {
  return invokeWithLogging('get_quiz_subjects', { projectId });
}
export async function createQuizSubject(projectId: number, name: string, color?: string, icon?: string): Promise<QuizSubject> {
  return invokeWithLogging('create_quiz_subject', { projectId, name, color, icon });
}
export async function updateQuizSubject(subjectId: number, patch: { name?: string; color?: string; icon?: string }): Promise<QuizSubject> {
  return invokeWithLogging('update_quiz_subject', { subjectId, ...patch });
}
export async function deleteQuizSubject(subjectId: number): Promise<void> {
  await invokeWithLogging('delete_quiz_subject', { subjectId });
}
export async function getQuizTopics(subjectId: number): Promise<QuizTopic[]> {
  return invokeWithLogging('get_quiz_topics', { subjectId });
}
export async function getAllQuizTopics(projectId: number): Promise<QuizTopicWithSubject[]> {
  return invokeWithLogging('get_all_quiz_topics', { projectId });
}
export async function createQuizTopic(subjectId: number, name: string, description?: string): Promise<QuizTopic> {
  return invokeWithLogging('create_quiz_topic', { subjectId, name, description });
}
export async function updateQuizTopic(topicId: number, patch: { name?: string; description?: string }): Promise<QuizTopic> {
  return invokeWithLogging('update_quiz_topic', { topicId, ...patch });
}
export async function deleteQuizTopic(topicId: number): Promise<void> {
  await invokeWithLogging('delete_quiz_topic', { topicId });
}
export async function getQuizQuestions(topicId: number): Promise<QuizQuestion[]> {
  return invokeWithLogging('get_quiz_questions', { topicId });
}
export async function createQuizQuestion(q: {
  topicId: number; questionType: string; questionText: string; explanation?: string;
  difficulty?: string; points?: number; source?: string; dataJson: string;
}): Promise<QuizQuestion> {
  return invokeWithLogging('create_quiz_question', q);
}
export async function updateQuizQuestion(questionId: number, patch: {
  questionText?: string; explanation?: string; difficulty?: string; points?: number; source?: string; dataJson?: string;
}): Promise<QuizQuestion> {
  return invokeWithLogging('update_quiz_question', { questionId, ...patch });
}
export async function deleteQuizQuestion(questionId: number): Promise<void> {
  await invokeWithLogging('delete_quiz_question', { questionId });
}
export async function getQuizzes(topicId: number): Promise<QuizDef[]> {
  return invokeWithLogging('get_quizzes', { topicId });
}
export async function createQuiz(q: {
  kind?: 'quiz' | 'exam'; topicIds?: number[]; topicId?: number; subjectId?: number; name: string; description?: string; questionCount?: number; timeLimitMinutes?: number;
  shuffleQuestions?: boolean; shuffleOptions?: boolean; showAnswersAfter?: string; passingScorePercent?: number;
}): Promise<QuizDef> {
  return invokeWithLogging('create_quiz', q);
}
export async function moveQuizQuestions(ids: number[], topicId: number): Promise<number> {
  return invokeWithLogging('move_quiz_questions', { ids, topicId });
}
export async function mergeQuizTopics(fromTopicId: number, intoTopicId: number): Promise<number> {
  return invokeWithLogging('merge_quiz_topics', { fromTopicId, intoTopicId });
}
export async function getSubjectQuizzes(subjectId: number): Promise<QuizDef[]> {
  return invokeWithLogging('get_subject_quizzes', { subjectId });
}
export async function getQuizExams(subjectId: number): Promise<QuizDef[]> {
  return invokeWithLogging('get_quiz_exams', { subjectId });
}
export async function getSubjectQuizQuestions(subjectId: number): Promise<QuizQuestion[]> {
  return invokeWithLogging('get_subject_quiz_questions', { subjectId });
}
export async function deleteQuiz(quizId: number): Promise<void> {
  await invokeWithLogging('delete_quiz', { quizId });
}
export async function getQuizAttempts(quizId: number): Promise<QuizAttempt[]> {
  return invokeWithLogging('get_quiz_attempts', { quizId });
}
export interface QuizLeaderboardRow {
  user_id: number;
  full_name: string;
  attempts: number;
  best_pct: number;
  avg_pct: number;
}
export async function getQuizLeaderboard(subjectId: number): Promise<QuizLeaderboardRow[]> {
  return invokeWithLogging('get_quiz_leaderboard', { subjectId });
}
export async function getQuizLeaderboardOptin(projectId: number, userId: number): Promise<boolean> {
  return invokeWithLogging('get_quiz_leaderboard_optin', { projectId, userId });
}
export async function setQuizLeaderboardOptin(projectId: number, userId: number, optIn: boolean): Promise<void> {
  await invokeWithLogging('set_quiz_leaderboard_optin', { projectId, userId, optIn });
}
export async function recordQuizAttempt(a: {
  quizId: number; userId?: number; score: number; maxScore: number; timeTakenSeconds?: number; answersJson: string;
}): Promise<QuizAttempt> {
  return invokeWithLogging('record_quiz_attempt', a);
}
