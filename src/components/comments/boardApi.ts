import {
  createComment,
  deleteComment,
  getProjectCommentBoard,
  getUsers,
  setCommentTags,
  updateComment,
} from '../../lib/api';
import { getProjectReactions, hasDaemon, type ReactionSummary } from '../../lib/daemon';
import { getActiveWorkspaceId, type Workspace } from '../../lib/workspaces';
import {
  wsCreateComment,
  wsDeleteComment,
  wsGetProjectCommentBoard,
  wsGetUsers,
  wsSetCommentTags,
  wsUpdateComment,
} from '../../lib/workspaceData';
import type { Comment, CommentBoard, CreateCommentInput, User } from '../../types';

/**
 * Where a comment board reads and writes. Project views talk to the ACTIVE
 * host (selecting a project already pointed the transport at its workspace);
 * Home shows every workspace's projects side by side, so each board there is
 * bound to its project's OWN workspace — writes can't land on the wrong host.
 */
export interface BoardApi {
  /** Stable id for React keys / effect deps. */
  id: string;
  load(projectId: number, opts: { taskIds?: number[]; limit?: number; since?: string }): Promise<CommentBoard>;
  create(input: CreateCommentInput): Promise<Comment>;
  update(commentId: number, content: string): Promise<Comment>;
  remove(commentId: number): Promise<void>;
  setTags(commentId: number, taskIds: number[]): Promise<Comment>;
  users(): Promise<User[]>;
  /** Reactions are host-served via the active daemon; null = not shown here. */
  reactions: ((projectId: number) => Promise<ReactionSummary[]>) | null;
  /** Pasted images upload through the active transport — only safe when that
   * IS this board's host. */
  images: boolean;
}

export const activeBoardApi: BoardApi = {
  id: 'active',
  load: getProjectCommentBoard,
  create: createComment,
  update: (id, content) => updateComment(id, { content }),
  remove: deleteComment,
  setTags: setCommentTags,
  users: getUsers,
  reactions: (pid) => (hasDaemon() ? getProjectReactions(pid) : Promise.resolve([])),
  images: true,
};

const cache = new Map<string, BoardApi>();

/** A board bound to one workspace (memoized so effect deps stay stable). */
export function workspaceBoardApi(ws: Workspace): BoardApi {
  const active = ws.id === getActiveWorkspaceId();
  const key = `${ws.id}|${ws.url ?? ''}|${active}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const api: BoardApi = {
    id: `ws:${ws.id}`,
    load: (pid, opts) => wsGetProjectCommentBoard(ws, pid, opts),
    create: (input) => wsCreateComment(ws, input),
    update: (id, content) => wsUpdateComment(ws, id, content),
    remove: (id) => wsDeleteComment(ws, id),
    setTags: (id, taskIds) => wsSetCommentTags(ws, id, taskIds),
    users: () => wsGetUsers(ws),
    reactions: active ? activeBoardApi.reactions : null,
    images: active,
  };
  cache.set(key, api);
  return api;
}

/** The client's local midnight, for "worked on today". */
export function todayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** A friendlier message for a host that predates the board. */
export function boardError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unknown command|get_project_comment_board/i.test(msg)) {
    return 'This host doesn’t have the comment board yet — update and restart it (git pull, then rebuild the server).';
  }
  return msg;
}

/** The tags of a comment; older hosts don't send task_ids. */
export const tagsOf = (c: Comment): number[] => (c.task_ids && c.task_ids.length ? c.task_ids : [c.task_id]);
