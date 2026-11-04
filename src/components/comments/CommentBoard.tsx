import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmDialog } from '../../lib/confirm';
import { useDataPulse } from '../../lib/livePulse';
import { injectCustomEmojis, refreshEmojiMap } from '../../lib/emoji';
import { hasDaemon, type ReactionSummary } from '../../lib/daemon';
import { parseProfile } from '../../lib/profile';
import { useAppStore } from '../../store/appStore';
import type { Area, Comment, CommentBoard as BoardData, Task, User } from '../../types';
import Avatar from '../Avatar';
import CommentEditor from '../CommentEditor';
import CommentReactions from '../CommentReactions';
import MarkdownPreview from '../MarkdownPreview';
import ProfileCardModal from '../ProfileCardModal';
import TaskTagPicker, { TaskChip, fmtSecs } from './TaskTagPicker';
import { boardError, tagsOf, todayStartIso, type BoardApi } from './boardApi';
import { discardUpdateDraft, openUpdateDraft, setUpdateDraftText, useUpdateDraft } from './draft';

/**
 * The project comment board — every comment in a project in one feed, each
 * tagged with the tasks it's about. One end-of-day update can cover several
 * tasks; it then also shows in each of those tasks' own threads. Used by the
 * Comments tab (full), Project Home and Home (compact).
 */

/** Everything an entry needs to act on its own project/host. */
export interface BoardContext {
  api: BoardApi;
  projectId: number;
  /** Shown on entries in a multi-project feed (Home → All). */
  projectName?: string;
  tasks: Task[];
  users: User[];
  reactions: ReactionSummary[];
  onChanged: () => void;
  /** The tag pickers' "Create task" (see useTaskCreator); left out, they
   * don't offer it. A board passes one shared creator, so a task made in
   * one picker shows in all of them. */
  createTask?: (title: string) => Promise<Task>;
}

export interface FeedItem {
  root: Comment;
  replies: Comment[];
  ctx: BoardContext;
}

export type Variant = 'full' | 'compact';

/** Server timestamps: RFC 3339, or SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). */
export function parseTs(iso: string): Date {
  return new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
}

function ago(iso: string): string {
  const d = parseTs(iso);
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(d: Date): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  const date = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
  return diff === 0 ? `Today · ${date}` : diff === 1 ? `Yesterday · ${date}` : date;
}

/** Load one project's board; reloads on comment/task pulses. */
export function useBoard(api: BoardApi, projectId: number, filter: number[], limit: number) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reactions, setReactions] = useState<ReactionSummary[]>([]);
  const seq = useRef(0);
  const filterKey = filter.join(',');
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const b = await api.load(projectId, {
        taskIds: filter.length ? filter : undefined,
        limit,
        since: todayStartIso(),
      });
      if (mine !== seq.current) return;
      setBoard(b);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(boardError(e));
    }
    if (api.reactions) {
      api
        .reactions(projectId)
        .then((r) => mine === seq.current && setReactions(r))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, filterKey, limit]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useDataPulse(() => void reload(), ['comments', 'tasks']);
  return { board, error, reactions, reload };
}

/** Users for avatars/@mentions, per host. */
export function useBoardUsers(api: BoardApi): User[] {
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    api.users().then(setUsers).catch(() => setUsers([]));
    if (hasDaemon()) refreshEmojiMap().catch(() => {});
  }, [api]);
  return users;
}

/** Split a board's flat list into roots (newest first) with their replies. */
export function toItems(board: BoardData | null, ctx: BoardContext): FeedItem[] {
  if (!board) return [];
  const roots = board.comments.filter((c) => c.parent_id == null);
  const ids = new Set(board.comments.map((c) => c.id));
  // Group every reply under its ROOT (walk up the parent chain).
  const parent = new Map(board.comments.map((c) => [c.id, c.parent_id ?? null]));
  const rootOf = (c: Comment) => {
    let id = c.id;
    let guard = 0;
    while (parent.get(id) != null && ids.has(parent.get(id)!) && guard++ < 50) id = parent.get(id)!;
    return id;
  };
  const replies = new Map<number, Comment[]>();
  for (const c of board.comments) {
    if (c.parent_id == null) continue;
    const r = rootOf(c);
    replies.set(r, [...(replies.get(r) ?? []), c]);
  }
  return roots.map((root) => ({ root, replies: replies.get(root.id) ?? [], ctx }));
}

// ---------------------------------------------------------------------------

/**
 * The tag picker's "Create task": makes the task on the board's host with the
 * app's usual defaults for a new task (To Do, Medium, no area) and keeps it in
 * this board's task list until the caller's own list catches up (a data pulse).
 */
function useTaskCreator(ctx: Pick<BoardContext, 'api' | 'projectId' | 'tasks'>) {
  const [made, setMade] = useState<Task[]>([]);
  const tasks = useMemo(() => {
    const have = new Set(ctx.tasks.map((t) => t.id));
    const extra = made.filter((t) => !have.has(t.id) && t.project_id === ctx.projectId);
    return extra.length ? [...ctx.tasks, ...extra] : ctx.tasks;
  }, [ctx.tasks, ctx.projectId, made]);
  const create = useCallback(
    async (title: string) => {
      try {
        const task = await ctx.api.createTask({ project_id: ctx.projectId, title, status: 'To Do', priority: 'Medium' });
        setMade((m) => [...m, task]);
        return task;
      } catch (e) {
        throw new Error(boardError(e));
      }
    },
    [ctx.api, ctx.projectId]
  );
  return { tasks, create };
}

/** Write an update and tag the tasks it covers. The text is the one update
 * draft (./draft.ts), so switching projects mid-sentence keeps it; the tags
 * start over, since tasks belong to one project. */
export function UpdateComposer({
  ctx,
  areas,
  defaultTags,
  suggestions,
  compact,
  leading,
}: {
  ctx: Pick<BoardContext, 'api' | 'projectId' | 'tasks' | 'users' | 'onChanged' | 'createTask'>;
  areas?: Area[];
  defaultTags: number[];
  suggestions: { taskId: number; hint: string }[];
  compact?: boolean;
  /** Rendered before the task picker (Home → All: the project picker). */
  leading?: ReactNode;
}) {
  const { open, text } = useUpdateDraft();
  const [tags, setTags] = useState<number[]>(defaultTags);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A board's ctx brings its shared creator; Home → All's doesn't, so the
  // composer keeps its own.
  const own = useTaskCreator(ctx);
  const tasks = ctx.createTask ? ctx.tasks : own.tasks;
  const createTask = ctx.createTask ?? own.create;
  const live = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);
  const defaultsKey = defaultTags.join(',');
  // Follow the filter while the composer is closed (opening it keeps them).
  useEffect(() => {
    if (!open) setTags(defaultTags.filter((id) => live.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsKey, open, live]);

  if (!open) {
    return (
      <button
        onClick={openUpdateDraft}
        className={`g-card w-full text-left flex items-center gap-2.5 hover:!border-gold transition-colors ${
          compact ? 'px-3.5 min-h-[44px] text-sm' : 'px-[18px] min-h-[52px]'
        }`}
      >
        <span>✍️</span>
        <span className="text-subtext-0">Write an update — tag the tasks it covers…</span>
      </button>
    );
  }

  const post = async (content: string) => {
    const valid = tags.filter((id) => live.has(id));
    if (!valid.length) return;
    setSaving(true);
    setError(null);
    try {
      await ctx.api.create({ task_id: valid[0], content, task_ids: valid.slice(1) });
      discardUpdateDraft();
      ctx.onChanged();
    } catch (e) {
      setError(boardError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="g-card g-corners p-4 space-y-3">
      {leading}
      <TaskTagPicker
        tasks={tasks}
        areas={areas}
        value={tags}
        onChange={setTags}
        suggestions={suggestions}
        onCreate={createTask}
      />
      <CommentEditor
        value={text}
        onChange={setUpdateDraftText}
        taskId={tags[0] ?? 0}
        users={ctx.users}
        onSave={post}
        onCancel={discardUpdateDraft}
        isSaving={saving}
        submitLabel="Post update"
        blockedReason={tags.some((id) => live.has(id)) ? null : 'Tag at least one task'}
        allowImages={ctx.api.images && tags.length > 0}
        checkAudience={ctx.api.images}
        rows={compact ? 4 : 6}
        placeholder="What moved today? Markdown, @mentions, emoji…"
      />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The feed: day headers, entries with task chips, replies, actions. */
export function BoardFeed({
  items,
  variant,
  filter = [],
  onTaskClick,
  onProjectClick,
  empty,
}: {
  items: FeedItem[];
  variant: Variant;
  filter?: number[];
  onTaskClick?: (ctx: BoardContext, taskId: number) => void;
  onProjectClick?: (ctx: BoardContext) => void;
  empty?: ReactNode;
}) {
  const [profile, setProfile] = useState<User | null>(null);
  if (items.length === 0) return <>{empty ?? null}</>;
  let lastDay = '';
  return (
    <div>
      {items.map((it) => {
        const day = dayLabel(parseTs(it.root.created_at));
        const header = day !== lastDay ? day : null;
        lastDay = day;
        return (
          <div key={`${it.ctx.api.id}:${it.ctx.projectId}:${it.root.id}`} className={header ? '' : 'border-t border-gilt-b'}>
            {header && (
              <div className={`g-rule ${variant === 'full' ? 'pt-3 pb-1' : 'pt-1.5'}`}>{header}</div>
            )}
            <Entry
              item={it}
              variant={variant}
              filter={filter}
              onTaskClick={onTaskClick}
              onProjectClick={onProjectClick}
              onProfile={setProfile}
            />
          </div>
        );
      })}
      {profile && <ProfileCardModal user={profile} onClose={() => setProfile(null)} />}
    </div>
  );
}

function Entry({
  item,
  variant,
  filter,
  onTaskClick,
  onProjectClick,
  onProfile,
}: {
  item: FeedItem;
  variant: Variant;
  filter: number[];
  onTaskClick?: (ctx: BoardContext, taskId: number) => void;
  onProjectClick?: (ctx: BoardContext) => void;
  onProfile: (u: User) => void;
}) {
  const { root, replies, ctx } = item;
  const [retagging, setRetagging] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskById = useMemo(() => new Map(ctx.tasks.map((t) => [t.id, t])), [ctx.tasks]);
  const tags = tagsOf(root);

  const saveTags = async () => {
    if (!retagging?.length) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.api.setTags(root.id, retagging);
      setRetagging(null);
      ctx.onChanged();
    } catch (e) {
      setError(boardError(e));
    } finally {
      setBusy(false);
    }
  };

  // Replies: nested under their parent, oldest first.
  const kids = (id: number) => replies.filter((r) => r.parent_id === id);

  return (
    <div className={variant === 'full' ? 'py-4' : 'py-3'}>
      <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
        {ctx.projectName && (
          <button
            onClick={() => onProjectClick?.(ctx)}
            className="g-deco text-[11px] font-semibold text-gold hover:underline mr-1"
            title={`Show only ${ctx.projectName}`}
          >
            {ctx.projectName}
          </button>
        )}
        {retagging ? null : (
          tags.map((id) => (
            <TaskChip
              key={id}
              task={taskById.get(id)}
              muted={!taskById.has(id)}
              active={filter.includes(id)}
              onClick={onTaskClick && taskById.has(id) ? () => onTaskClick(ctx, id) : undefined}
            />
          ))
        )}
      </div>
      {retagging && (
        <div className="g-card mb-3 p-3 space-y-2.5">
          <TaskTagPicker tasks={ctx.tasks} value={retagging} onChange={setRetagging} onCreate={ctx.createTask} />
          <div className="flex items-center gap-2 justify-end">
            {error && <span className="text-xs text-error mr-auto">{error}</span>}
            {!retagging.length && <span className="text-xs text-warning mr-auto">Keep at least one task</span>}
            <button onClick={() => setRetagging(null)} className="g-btn g-btn-ghost g-btn-sm">
              Cancel
            </button>
            <button
              onClick={saveTags}
              disabled={busy || !retagging.length}
              className="g-btn g-btn-pri g-btn-sm"
            >
              {busy ? 'Saving…' : 'Save tags'}
            </button>
          </div>
        </div>
      )}
      <CommentBody
        comment={root}
        ctx={ctx}
        depth={0}
        variant={variant}
        kids={kids}
        onProfile={onProfile}
        onRetag={() => setRetagging(tags.filter((id) => taskById.has(id)))}
      />
    </div>
  );
}

function CommentBody({
  comment,
  ctx,
  depth,
  variant,
  kids,
  onProfile,
  onRetag,
}: {
  comment: Comment;
  ctx: BoardContext;
  depth: number;
  variant: Variant;
  kids: (id: number) => Comment[];
  onProfile: (u: User) => void;
  onRetag?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const author = comment.user_id != null ? ctx.users.find((u) => u.id === comment.user_id) : undefined;
  const agentName = comment.profile_name ?? null;
  const name = agentName ?? author?.full_name ?? 'Unknown';
  const avatar = comment.profile_avatar ?? (author ? parseProfile(author.profile_json).avatar : undefined);
  const children = kids(comment.id);
  // Long updates fold in the compact widgets (Home, Project Home).
  const long = variant === 'compact' && (comment.content.length > 500 || comment.content.split('\n').length > 9);

  const run = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await fn();
      ctx.onChanged();
      return true;
    } catch (e) {
      alert(boardError(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`flex ${depth > 0 || variant === 'compact' ? 'gap-2.5' : 'gap-3.5'}`}>
      <button type="button" onClick={() => author && onProfile(author)} className="shrink-0 self-start rounded-full" title={author ? 'View profile' : undefined}>
        <Avatar name={name} src={avatar} size={depth > 0 || variant === 'compact' ? 22 : 28} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] text-subtext-0 min-h-[28px]">
          <span className="font-semibold text-text truncate">
            {agentName ? `🤖 ${agentName}` : name}
            {agentName && author && <span className="text-subtext-0 font-normal"> · approved by {author.full_name}</span>}
          </span>
          <span className="shrink-0 tabular-nums" title={parseTs(comment.created_at).toLocaleString()}>
            {ago(comment.created_at)}
            {comment.updated_at !== comment.created_at && ' (edited)'}
          </span>
          <span className="ml-auto flex items-center gap-0.5 shrink-0">
            {onRetag && (
              <IconBtn title="Change the tasks this is tagged with" onClick={onRetag}>
                🏷️
              </IconBtn>
            )}
            <IconBtn title="Edit" onClick={() => setEditing(true)}>
              ✎
            </IconBtn>
            <IconBtn
              title="Delete"
              danger
              onClick={async () => {
                const msg = comment.parent_id == null && tagsOf(comment).length > 1
                  ? `Delete this update? It disappears from all ${tagsOf(comment).length} tagged tasks.`
                  : 'Delete this comment?';
                if (await confirmDialog(msg)) await run(() => ctx.api.remove(comment.id));
              }}
            >
              🗑
            </IconBtn>
          </span>
        </div>
        {editing ? (
          <CommentEditor
            comment={comment}
            taskId={comment.task_id}
            users={ctx.users}
            allowImages={ctx.api.images}
            checkAudience={ctx.api.images}
            onSave={async (content) => {
              if (await run(() => ctx.api.update(comment.id, content))) setEditing(false);
            }}
            onCancel={() => setEditing(false)}
            isSaving={saving}
          />
        ) : (
          <>
            <div className={`relative ${long && !expanded ? 'max-h-48 overflow-hidden' : ''}`}>
              <div className="text-text">
                <MarkdownPreview content={injectCustomEmojis(comment.content)} />
              </div>
              {long && !expanded && (
                <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-base to-transparent pointer-events-none" />
              )}
            </div>
            {long && (
              <button onClick={() => setExpanded((x) => !x)} className="g-lnk !px-0 mt-1" aria-expanded={expanded}>
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </>
        )}
        <div className="flex items-center flex-wrap gap-2 mt-2">
          {ctx.api.reactions && (
            <CommentReactions
              commentId={comment.id}
              reactions={ctx.reactions.filter((r) => r.comment_id === comment.id)}
              onChanged={ctx.onChanged}
            />
          )}
          <button onClick={() => setReplying((r) => !r)} className="g-lnk !text-subtext-0 hover:!text-gold" aria-expanded={replying}>
            Reply
          </button>
        </div>
        {replying && (
          <div className="g-card mt-3 p-3">
            <CommentEditor
              taskId={comment.task_id}
              users={ctx.users}
              allowImages={ctx.api.images}
              checkAudience={ctx.api.images}
              rows={3}
              submitLabel="Reply"
              onSave={async (content) => {
                const ok = await run(() => ctx.api.create({ task_id: comment.task_id, content, parent_id: comment.id }));
                if (ok) setReplying(false);
              }}
              onCancel={() => setReplying(false)}
              isSaving={saving}
            />
          </div>
        )}
        {children.length > 0 && (
          <div className={`mt-3 space-y-3 ${depth < 3 ? 'pl-1 border-l border-gilt-a ml-0.5' : ''}`}>
            {children.map((k) => (
              <div key={k.id} className="pl-3">
                <CommentBody comment={k} ctx={ctx} depth={depth + 1} variant={variant} kids={kids} onProfile={onProfile} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`g-iconbtn !w-8 !h-8 text-[13px] opacity-70 hover:opacity-100 ${danger ? 'hover:!text-error' : ''}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

/**
 * One project's board: composer + feed. `filter` narrows to updates tagged
 * with ANY of those tasks (and pre-tags new updates with them).
 */
export default function CommentBoard({
  api,
  projectId,
  tasks,
  areas,
  filter = [],
  onTaskClick,
  variant = 'full',
  pageSize = 30,
  composer = true,
  onLoaded,
  empty,
  onMore,
}: {
  api: BoardApi;
  projectId: number;
  /** The project's live (not binned) tasks. */
  tasks: Task[];
  areas?: Area[];
  filter?: number[];
  onTaskClick?: (taskId: number) => void;
  variant?: Variant;
  pageSize?: number;
  composer?: boolean;
  /** Per-task counts etc., for a surrounding task list. */
  onLoaded?: (board: BoardData) => void;
  empty?: ReactNode;
  /** Compact widgets: "older" goes to the full board instead of paging here. */
  onMore?: () => void;
}) {
  const [limit, setLimit] = useState(pageSize);
  const filterKey = filter.join(',');
  useEffect(() => setLimit(pageSize), [filterKey, projectId, pageSize]);
  const { board, error, reactions, reload } = useBoard(api, projectId, filter, limit);
  const users = useBoardUsers(api);
  const creator = useTaskCreator({ api, projectId, tasks });
  const { activeTask } = useAppStore();
  useEffect(() => {
    if (board) onLoaded?.(board);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  const ctx: BoardContext = useMemo(
    () => ({ api, projectId, tasks: creator.tasks, users, reactions, onChanged: () => void reload(), createTask: creator.create }),
    [api, projectId, creator.tasks, creator.create, users, reactions, reload]
  );
  const items = useMemo(() => toItems(board, ctx), [board, ctx]);
  const suggestions = useMemo(() => {
    const out: { taskId: number; hint: string }[] = (board?.time_since ?? []).map((t) => ({
      taskId: t.task_id,
      hint: `⏱ ${fmtSecs(t.seconds)} today`,
    }));
    if (activeTask && activeTask.project_id === projectId && !out.some((s) => s.taskId === activeTask.id)) {
      out.unshift({ taskId: activeTask.id, hint: '▶ active' });
    }
    return out;
  }, [board, activeTask, projectId]);

  return (
    <div className={variant === 'full' ? 'space-y-4' : 'space-y-2.5'}>
      {composer && !error && (
        <UpdateComposer
          ctx={ctx}
          areas={areas}
          defaultTags={filter}
          suggestions={suggestions}
          compact={variant === 'compact'}
        />
      )}
      {error ? (
        <p className="g-inset text-sm text-warning !border-warning/40">{error}</p>
      ) : !board ? (
        <p className="text-sm text-subtext-0 px-1">Loading updates…</p>
      ) : (
        <BoardFeed
          items={items}
          variant={variant}
          filter={filter}
          onTaskClick={onTaskClick ? (_c, id) => onTaskClick(id) : undefined}
          empty={
            empty ?? (
              <p className="text-sm text-subtext-0 px-1">
                {filter.length ? 'No updates tagged with these tasks yet.' : 'No updates yet — write the first one and tag the tasks it covers.'}
              </p>
            )
          }
        />
      )}
      {board?.has_more && (
        <button
          onClick={() => (onMore ? onMore() : setLimit((l) => l + pageSize))}
          className="g-btn g-btn-ghost g-btn-sm w-full"
        >
          {onMore ? 'Older updates on the board →' : 'Show older updates'}
        </button>
      )}
    </div>
  );
}
