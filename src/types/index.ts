export interface Project {
  id: number;
  name: string;
  description?: string;
  archived: boolean;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
  storage_quota_bytes?: number;
  /** Default assistant personality for this project's chats (null = global active). */
  model_profile_id?: number | null;
  /** CLIENT-ONLY (K2): which workspace this project came from ('local' or a
   * remote id). Tagged after fetch, never sent to any server — ids collide
   * across hosts, so this disambiguates. Absent = 'local'. */
  workspaceId?: string;
}

export interface Area {
  id: number;
  project_id: number;
  name: string;
  description?: string;
  created_at: string;
  /** Only its area members (and those who always see) see it and its tasks. */
  restricted?: boolean;
}

/** Who may see a task (ADR 0002): its area's say, selected members, or admins only. */
export type TaskVisibility = 'area' | 'members' | 'admins';

/** Who can see a task: its setting, its area, the selected members, and everyone. */
export interface TaskAudience {
  visibility: TaskVisibility;
  area: { id: number; name: string; restricted: boolean } | null;
  /** The selected members (meaningful for 'members'). */
  selected: number[];
  /** Everyone who can see it, by user id: the owner, admins, assignees, and whoever the setting admits. */
  audience: number[];
}

export interface Task {
  id: number;
  project_id: number;
  /** CLIENT-ONLY (K2): the workspace this task's project lives in. Tagged by
   * cross-workspace aggregators (HomeBoard); absent = local. Never serialized. */
  workspaceId?: string;
  area_id?: number;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  prefix?: string;
  cost?: number;
  currency?: string;
  archived: boolean;
  pinned?: boolean;
  deadline?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  /** Who may see it; absent on older hosts (= follows its area). */
  visibility?: TaskVisibility;
}

export interface TimeEntry {
  id: number;
  task_id: number;
  start_time: string;
  end_time?: string;
  duration?: number;
  notes?: string;
  user_id?: number | null;
  created_at: string;
}

export interface MemberTaskTime {
  task_id: number;
  task_title: string;
  seconds: number;
}

/** One assignee on a task, with the optional advisory work brief. */
/** An assignee is a MEMBER (`kind: 'user'`) or a CONTACT (`kind: 'contact'`) —
 * a responsible party who isn't a Ganban user. Contacts carry no brief and
 * never dispatch or get notified; they are the named person, as data. */
export interface TaskAssignee {
  kind: 'user' | 'contact';
  user_id: number | null;
  contact_id: number | null;
  /** Empty for contacts. */
  username: string;
  display_name: string;
  assigned_by: number;
  assigned_at: string;
  brief: { protocol?: string; inputs?: Record<string, unknown>; notes?: string; acceptance?: string } | null;
}

/** A task assigned to me, shaped for an assignments surface. */
export interface MyAssignment {
  task_id: number;
  task_title: string;
  task_status: string;
  task_priority: string;
  task_deadline: string | null;
  task_updated_at: string;
  project_id: number;
  project_name: string;
  assigned_by: number;
  assigned_at: string;
  brief: TaskAssignee["brief"];
  /** Client-only: which workspace this assignment came from (K2). */
  workspaceId?: string;
}

/** One (task, assignee) pair — a project's assignments in one call. */
export interface ProjectAssignee {
  task_id: number;
  kind: 'user' | 'contact';
  user_id: number | null;
  contact_id: number | null;
  /** Empty for contacts. */
  username: string;
  display_name: string;
}

/** Stable React key / identity for an assignee of either kind. */
export const assigneeKey = (a: { kind: 'user' | 'contact'; user_id: number | null; contact_id: number | null }): string =>
  a.kind === 'user' ? `user:${a.user_id}` : `contact:${a.contact_id}`;

export interface ProjectMemberOverview {
  user_id: number;
  username: string;
  display_name: string;
  role: string;
  joined_at: string;
  last_seen_at?: string | null;
  total_seconds: number;
  by_task: MemberTaskTime[];
}

export type TaskStatus = 'To Do' | 'In Progress' | 'Done' | 'Blocked';
export type TaskPriority = 'Low' | 'Medium' | 'High';

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  pinned?: boolean;
}

export interface ProjectStats {
  total_tasks: number;
  tasks_by_status: {
    todo: number;
    in_progress: number;
    done: number;
    blocked: number;
  };
  total_time_seconds: number;
  total_files: number;
  total_cost: number;
}

export interface CreateTaskInput {
  project_id: number;
  area_id?: number;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  prefix?: string;
  cost?: number;
  currency?: string;
  deadline?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  prefix?: string;
  cost?: number;
  currency?: string;
  area_id?: number;
  deadline?: string;
  pinned?: boolean;
}

export interface CreateAreaInput {
  project_id: number;
  name: string;
  description?: string;
}

export interface UpdateAreaInput {
  name?: string;
  description?: string;
}

export interface FileAttachment {
  id: number;
  task_id: number;
  file_path: string;
  file_name: string;
  file_type?: string;
  file_size?: number;
  notes?: string;
  created_at: string;
  last_verified_at?: string;
  is_valid: boolean;
  uploaded_by?: number;
  is_shared?: boolean;
  storage_size?: number;
  /** Its path under an uploaded folder ("Brief/maps/route.png"); null for a loose file. */
  rel_path?: string | null;
  /** Whether the AI overview (the project's knowledge base) may index it. New files start out. */
  ai_included: boolean;
}

export interface CreateFileAttachmentInput {
  task_id: number;
  file_path: string;
  file_name: string;
  file_type?: string;
  file_size?: number;
  notes?: string;
  uploaded_by?: number;
}

export interface UpdateFileAttachmentInput {
  file_path?: string;
  notes?: string;
}

export interface Comment {
  id: number;
  task_id: number;
  content: string;
  user_id?: number;
  /** The comment this replies to (same task), or null/undefined for top-level. */
  parent_id?: number | null;
  /** The AGENT (model profile) that authored it, when it arrived through an
   * approved proposal — name/avatar joined by the server for display. */
  profile_id?: number | null;
  profile_name?: string | null;
  profile_avatar?: string | null;
  created_at: string;
  updated_at: string;
  /** Every task this comment is tagged with — the home `task_id` first, then
   * extra tags (the project comment board). Absent from older hosts. */
  task_ids?: number[];
}

export interface CreateCommentInput {
  task_id: number;
  content: string;
  user_id?: number;
  parent_id?: number | null;
  /** Extra tasks (same project) to tag a top-level comment with. */
  task_ids?: number[];
}

/** A project's comment board (get_project_comment_board). */
export interface CommentBoard {
  /** Top-level comments newest first, then all their replies. */
  comments: Comment[];
  /** Top-level comments tagged with each task, whole project. */
  task_counts: { task_id: number; count: number }[];
  has_more: boolean;
  /** Seconds tracked per task since the requested instant (today). */
  time_since: { task_id: number; seconds: number }[];
}

export interface Notification {
  id: number;
  user_id: number;
  category: string;
  title: string;
  body?: string | null;
  link_task_id?: number | null;
  read: boolean;
  created_at: string;
}

/** An in-app ticket — a bug report or feature request. Host-served. */
export interface Ticket {
  id: number;
  user_id: number;
  kind: 'bug' | 'feature';
  title: string;
  body?: string | null;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  /** Submitter's name (resolved in the list query; absent on create). */
  submitter_name?: string | null;
}

export interface UpdateCommentInput {
  content: string;
}

export interface GlobalActiveTimeEntry {
  entry: TimeEntry;
  task: Task;
}

export interface Event {
  id: number;
  /** CLIENT-ONLY (K2): the workspace this event came from (cross-workspace
   * aggregation tags it; absent = local). Never serialized to a server. */
  workspaceId?: string;
  title: string;
  description?: string;
  location?: string;
  event_date: string;
  start_time?: string;
  end_time?: string;
  all_day: boolean;
  reminder_minutes?: number;
  notification_enabled: boolean;
  archived: boolean;
  /** Set when this event came from an imported calendar (else null/undefined). */
  calendar_id?: number | null;
  external_uid?: string | null;
  /** RFC 5545 recurrence rule on the master (e.g. "FREQ=WEEKLY;BYDAY=MO,WE").
   * Occurrences are expanded on the client; only the master is stored. */
  rrule?: string | null;
  /** When someone marked the event past by hand (null = not marked). It then
   * counts as past everywhere; for a recurring event, the whole series. */
  done_at?: string | null;
  /** A repeating event's skipped days: comma-separated local ISO dates. */
  exdates?: string | null;
  /** On a one-off copy that replaced one day of a series, that series' id. */
  series_id?: number | null;
  /** How many files are attached to the event (counted by the host on read). */
  file_count?: number;
  created_at: string;
  updated_at: string;
}

/** A file attached to an event, stored on the host (host-only, never synced). */
export interface EventAttachment {
  id: number;
  event_id: number;
  file_name: string;
  file_type?: string | null;
  /** Where it sits in an uploaded folder ("Brief/maps/route.png"), else null. */
  rel_path?: string | null;
  size_bytes: number;
  uploaded_by?: number | null;
  created_at: string;
}

export interface CalendarSubscription {
  id: number;
  name: string;
  url: string;
  color?: string | null;
  enabled: boolean;
  last_synced_at?: string | null;
  last_status?: string | null;
  last_event_count: number;
  created_at: string;
  updated_at: string;
}

/** Result of a sync/import run for one subscription. */
export interface CalendarSyncResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  total?: number;
}

export interface EventTask {
  id: number;
  event_id: number;
  task_id: number;
  created_at: string;
}

export interface EventProject {
  id: number;
  event_id: number;
  project_id: number;
  created_at: string;
}

export interface CreateEventInput {
  title: string;
  description?: string;
  location?: string;
  event_date: string;
  start_time?: string;
  end_time?: string;
  all_day: boolean;
  reminder_minutes?: number;
  notification_enabled: boolean;
  rrule?: string | null;
  exdates?: string | null;
  series_id?: number | null;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  location?: string;
  event_date?: string;
  start_time?: string;
  end_time?: string;
  all_day?: boolean;
  reminder_minutes?: number;
  notification_enabled?: boolean;
  /** Omit = leave unchanged; null = clear; string = set the recurrence rule. */
  rrule?: string | null;
  /** Omit = leave unchanged; null or '' = clear; else the skipped days. */
  exdates?: string | null;
}

export interface Contact {
  id: number;
  full_name: string;
  occupation?: string;
  phone_numbers?: string; // JSON array stored as string
  emails?: string;        // JSON array stored as string
  birthday?: string;
  notes?: string;
  archived: boolean;
  /** Linked user account, if this contact is a collaborator (else null). */
  user_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskContact {
  id: number;
  task_id: number;
  contact_id: number;
  created_at: string;
}

export interface CreateContactInput {
  full_name: string;
  occupation?: string;
  phone_numbers?: string;
  emails?: string;
  birthday?: string;
  notes?: string;
}

export interface UpdateContactInput {
  full_name?: string;
  occupation?: string;
  phone_numbers?: string;
  emails?: string;
  birthday?: string;
  notes?: string;
}

export interface User {
  id: number;
  username: string;
  full_name: string;
  email?: string;
  is_active: boolean;
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  /** JSON profile blob (theme, avatar data-URL, vCard + flavor fields). */
  profile_json?: string;
  /** Whether a profile PIN is set (the hash never leaves the host). */
  has_pin?: boolean;
}

export interface UserSetting {
  id: number;
  user_id: number;
  setting_key: string;
  setting_value?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  username: string;
  full_name: string;
  email?: string;
}

export interface UpdateUserInput {
  full_name?: string;
  email?: string;
  is_active?: boolean;
}

// --------------------------------------------------------------------------- //
// Model Assembly domain (Gundam kits + Warhammer 40K / Age of Sigmar armies).
// --------------------------------------------------------------------------- //

export type ModelKind = 'gundam' | '40k' | 'aos' | 'other';
export type ModelStatus =
  | 'Backlog' | 'In Progress' | 'Assembled' | 'Painted' | 'Display' | 'Shelved';
export type ModelFileKind = 'photo' | 'manual' | 'paint';

export const MODEL_KINDS: ModelKind[] = ['gundam', '40k', 'aos', 'other'];
export const MODEL_STATUSES: ModelStatus[] = [
  'Backlog', 'In Progress', 'Assembled', 'Painted', 'Display', 'Shelved',
];

export interface ModelKit {
  id: number;
  project_id: number;
  name: string;
  kind: ModelKind;
  grade?: string | null;
  scale?: string | null;
  faction?: string | null;
  points?: number | null;
  status: ModelStatus;
  notes?: string | null;
  sort_order: number;
  /** Vertical focal point of the cover crop, 0 (top) .. 100 (bottom). */
  cover_focus?: number;
  /** Companion task for time tracking ("set kit active" targets it). */
  task_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ModelBoard {
  id: number;
  kit_id: number;
  name: string;
  max_parts: number;
  color?: string | null;
  sort_order: number;
}

export interface ModelPart {
  id: number;
  board_id: number;
  number: number;
  is_used: boolean;
}

export interface ModelSection {
  id: number;
  kit_id: number;
  name: string;
  start_step?: string | null;
  end_step?: string | null;
  sort_order: number;
}

export interface ModelKitFile {
  id: number;
  kit_id: number;
  file_id: number;
  kind: ModelFileKind;
  caption?: string | null;
  sort_order: number;
}

export interface ModelKitDetail {
  kit: ModelKit;
  boards: ModelBoard[];
  parts_by_board: Record<string, ModelPart[]>;
  sections: ModelSection[];
  used_by_section: Record<string, Record<string, number[]>>;
  files: ModelKitFile[];
  total_parts: number;
  used_parts: number;
  percent: number;
}

export interface ModelBuildLogEntry {
  id: number;
  used_at: string;
  section_id: number;
  section_name: string;
  board_id: number;
  board_name: string;
  part_number: number;
}

export interface CreateModelKitInput {
  project_id: number;
  name: string;
  kind: ModelKind;
  grade?: string | null;
  scale?: string | null;
  faction?: string | null;
  points?: number | null;
  status?: ModelStatus;
  notes?: string | null;
}

export interface UpdateModelKitInput {
  name?: string;
  kind?: ModelKind;
  grade?: string | null;
  scale?: string | null;
  faction?: string | null;
  points?: number | null;
  status?: ModelStatus;
  notes?: string | null;
  sort_order?: number;
  cover_focus?: number;
  task_id?: number;
}

export interface CreateModelBoardInput {
  kit_id: number;
  name: string;
  max_parts: number;
  color?: string | null;
  duplicates?: Record<string, number>;
}

export interface UpdateModelBoardInput {
  name?: string;
  max_parts?: number;
  color?: string | null;
  sort_order?: number;
}

export interface CreateModelSectionInput {
  kit_id: number;
  name: string;
  start_step?: string | null;
  end_step?: string | null;
}

export interface UpdateModelSectionInput {
  name?: string;
  start_step?: string | null;
  end_step?: string | null;
  sort_order?: number;
}

export interface MarkModelPartInput {
  kit_id: number;
  board_name: string;
  part_number: number;
  section_id: number;
}

// ── Quiz domain (QuizForge adoption) ─────────────────────────────────────────
export type QuizQuestionType =
  | 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'FILL_BLANK' | 'FILL_BLANK_MULTIPLE'
  | 'NUMERIC_INPUT' | 'MATCHING' | 'ORDERING' | 'IMAGE_IDENTIFICATION' | 'CALCULATION';
export type QuizDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

export interface QuizSubject {
  id: number;
  project_id: number;
  name: string;
  color?: string | null;
  icon?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface QuizTopic {
  id: number;
  subject_id: number;
  name: string;
  description?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface QuizTopicWithSubject {
  id: number;
  subject_id: number;
  name: string;
  subject_name: string;
}

export interface QuizQuestion {
  id: number;
  topic_id: number;
  question_type: QuizQuestionType;
  question_text: string;
  explanation?: string | null;
  difficulty: QuizDifficulty;
  points: number;
  source?: string | null;
  /** Type-specific structure in QuizForge's TS shapes (options/blanks/…). */
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface QuizDef {
  id: number;
  /** Topic-scoped quiz; exams leave this null and set subject_id. */
  topic_id?: number | null;
  /** Subject-scoped (draws from every topic under the subject). */
  subject_id?: number | null;
  /** Multi-topic scope: JSON array of topic ids; precedence over topic_id. */
  topic_ids_json?: string | null;
  /** 'quiz' | 'exam' — presets and runner behavior, independent of scope. */
  kind: 'quiz' | 'exam';
  name: string;
  description?: string | null;
  question_count: number;
  time_limit_minutes?: number | null;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  show_answers_after: 'EACH_QUESTION' | 'END_OF_QUIZ' | 'NEVER';
  passing_score_percent: number;
  created_at: string;
  updated_at: string;
}

export interface QuizAttempt {
  id: number;
  quiz_id: number;
  user_id?: number | null;
  started_at: string;
  completed_at?: string | null;
  score: number;
  max_score: number;
  percentage: number;
  time_taken_seconds?: number | null;
  answers_json: string;
}
