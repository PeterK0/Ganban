import { useState, useEffect } from 'react';
import { confirmDialog } from '../lib/confirm';
import { getTaskComments, createComment, updateComment, deleteComment, getUsers } from '../lib/api';
import { getTaskReactions, hasDaemon, type ReactionSummary } from '../lib/daemon';
import { refreshEmojiMap, injectCustomEmojis } from '../lib/emoji';
import CommentReactions from './CommentReactions';
import type { Comment, CreateCommentInput, User } from '../types';
import CommentEditor from './CommentEditor';
import MarkdownPreview from './MarkdownPreview';
import ProfileCardModal from './ProfileCardModal';
import Avatar from './Avatar';
import { parseProfile } from '../lib/profile';

interface CommentListProps {
  taskId: number;
}

export default function CommentList({ taskId }: CommentListProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [authorUser, setAuthorUser] = useState<User | null>(null);
  const [reactions, setReactions] = useState<ReactionSummary[]>([]);
  const [sortDesc, setSortDesc] = useState(false); // false = oldest-first (chronological)
  const [replyingTo, setReplyingTo] = useState<number | null>(null);

  const loadReactions = () => {
    if (!hasDaemon()) return;
    getTaskReactions(taskId)
      .then(setReactions)
      .catch(() => {/* host may be down — reactions are best-effort */});
  };

  useEffect(() => {
    loadComments();
    loadReactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    getUsers().then(setUsers).catch(() => {});
    // Populate the custom-emoji map (team + my personal emojis) so :name: renders
    // as its image in comment bodies and reaction tallies before any picker opens.
    if (hasDaemon()) refreshEmojiMap().catch(() => {});
  }, []);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const sortedComments = [...comments].sort((a, b) => {
    const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return sortDesc ? -d : d;
  });

  const loadComments = async () => {
    setIsLoading(true);
    try {
      const data = await getTaskComments(taskId);
      setComments(data);
    } catch (error) {
      console.error('Failed to load comments:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async (content: string, parentId: number | null = null) => {
    setIsSaving(true);
    try {
      // A reply lives on its thread's home task — which, for an update tagged
      // on several tasks, may not be the task this thread is shown under.
      const parentTask = parentId != null ? comments.find((c) => c.id === parentId)?.task_id : undefined;
      const input: CreateCommentInput = {
        task_id: parentTask ?? taskId,
        content,
        parent_id: parentId,
      };
      await createComment(input);
      await loadComments();
      setIsCreating(false);
      setReplyingTo(null);
    } catch (error) {
      console.error('Failed to create comment:', error);
      alert('Failed to create comment');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async (commentId: number, content: string) => {
    setIsSaving(true);
    try {
      await updateComment(commentId, { content });
      await loadComments();
      setEditingId(null);
    } catch (error) {
      console.error('Failed to update comment:', error);
      alert('Failed to update comment');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (commentId: number) => {
    const n = comments.find((c) => c.id === commentId)?.task_ids?.length ?? 1;
    const msg = n > 1
      ? `Delete this update? It's tagged on ${n} tasks and disappears from all of them.`
      : 'Are you sure you want to delete this comment?';
    if (!await confirmDialog(msg)) return;

    try {
      await deleteComment(commentId);
      await loadComments();
    } catch (error) {
      console.error('Failed to delete comment:', error);
      alert('Failed to delete comment');
    }
  };

  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Threading: roots are top-level (or orphaned) comments in the chosen sort;
  // replies hang off their parent in chronological order.
  const childrenOf = (id: number) =>
    comments
      .filter((c) => c.parent_id === id)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const isRoot = (c: Comment) => c.parent_id == null || !comments.some((p) => p.id === c.parent_id);
  const roots = sortedComments.filter(isRoot);

  const renderComment = (comment: Comment, depth: number) => {
    const author = comment.user_id != null ? userMap.get(comment.user_id) : undefined;
    // An agent-authored comment (approved proposal) wears the AGENT's face;
    // the approving human stays in user_id and is named in the byline.
    const agentName = comment.profile_name ?? null;
    const authorName = agentName ?? author?.full_name ?? 'Unknown';
    const avatarSrc = comment.profile_avatar ?? (author ? parseProfile(author.profile_json).avatar : undefined);
    const kids = childrenOf(comment.id);
    return (
      <div key={comment.id} className={depth > 0 ? 'g-upd g-upd-reply' : 'g-upd'}>
        <button
          type="button"
          onClick={() => author && setAuthorUser(author)}
          className="shrink-0 self-start rounded-full"
          title={author ? 'View profile' : undefined}
        >
          <Avatar name={authorName} src={avatarSrc} size={depth > 0 ? 24 : 28} />
        </button>
        <div className="flex-1 min-w-0">
          {editingId === comment.id ? (
            <CommentEditor
              comment={comment}
              taskId={taskId}
              users={users}
              onSave={(content) => handleUpdate(comment.id, content)}
              onCancel={() => setEditingId(null)}
              isSaving={isSaving}
            />
          ) : (
            <div>
              <div className="flex items-center justify-between gap-2 min-h-[28px]">
                <span className="text-[13px] text-subtext-0 flex items-baseline gap-2 min-w-0">
                  {agentName ? (
                    <span className="font-semibold text-text truncate" title={author ? `Agent run approved by ${author.full_name}` : undefined}>
                      🤖 {agentName}
                      {author && <span className="text-subtext-0 font-normal"> · approved by {author.full_name}</span>}
                    </span>
                  ) : author ? (
                    <button onClick={() => setAuthorUser(author)} className="font-semibold text-text hover:text-gold truncate" title="View profile">
                      {authorName}
                    </button>
                  ) : (
                    <span className="font-semibold text-text truncate">{authorName}</span>
                  )}
                  <span className="shrink-0 tabular-nums">
                    {formatTimestamp(comment.created_at)}
                    {comment.updated_at !== comment.created_at && <span className="ml-1">(edited)</span>}
                  </span>
                  {(comment.task_ids?.length ?? 1) > 1 && (
                    <span
                      className="g-tag !min-h-[20px] !px-2 shrink-0"
                      title="One update tagged on several tasks — retag it from the project's Comments board"
                    >
                      🏷 {comment.task_ids!.length} tasks
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setEditingId(comment.id)} className="g-iconbtn !w-8 !h-8" title="Edit" aria-label="Edit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button onClick={() => handleDelete(comment.id)} className="g-iconbtn !w-8 !h-8 hover:!text-error" title="Delete" aria-label="Delete">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="text-text">
                <MarkdownPreview content={injectCustomEmojis(comment.content)} />
              </div>
              <div className="flex items-center flex-wrap gap-2 mt-2">
                <CommentReactions
                  commentId={comment.id}
                  reactions={reactions.filter((r) => r.comment_id === comment.id)}
                  onChanged={loadReactions}
                />
                <button
                  onClick={() => { setReplyingTo((cur) => (cur === comment.id ? null : comment.id)); }}
                  className="g-lnk !text-subtext-0 hover:!text-gold"
                  aria-expanded={replyingTo === comment.id}
                >
                  Reply
                </button>
              </div>
              {replyingTo === comment.id && (
                <div className="g-card mt-3 p-3">
                  <CommentEditor
                    taskId={taskId}
                    users={users}
                    onSave={(content) => handleCreate(content, comment.id)}
                    onCancel={() => setReplyingTo(null)}
                    isSaving={isSaving}
                  />
                </div>
              )}
            </div>
          )}
          {kids.length > 0 && <div className="mt-1">{kids.map((k) => renderComment(k, depth + 1))}</div>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="pb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-bold text-text">
            Comments ({comments.length})
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSortDesc((s) => !s)}
              title="Sort by date"
              className="g-lnk"
            >
              {sortDesc ? 'Newest first ↓' : 'Oldest first ↑'}
            </button>
            {!isCreating && (
              <button
                onClick={() => setIsCreating(true)}
                className="g-btn g-btn-pri g-glint g-btn-sm"
              >
                + New
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1">
        {/* New Comment Form */}
        {isCreating && (
          <div className="g-card p-4 mb-4">
            <CommentEditor
              taskId={taskId}
              users={users}
              onSave={(content) => handleCreate(content)}
              onCancel={() => setIsCreating(false)}
              isSaving={isSaving}
            />
          </div>
        )}

        {/* Loading State */}
        {isLoading ? (
          <div className="text-center py-8 text-subtext-0">
            <p>Loading comments…</p>
          </div>
        ) : comments.length === 0 ? (
          <div className="text-center py-8 text-subtext-0">
            <p className="mb-1.5">No comments yet</p>
            {!isCreating && (
              <button
                onClick={() => setIsCreating(true)}
                className="g-lnk"
              >
                Add the first comment
              </button>
            )}
          </div>
        ) : (
          /* Threaded comments: roots in sort order, replies nested chronologically */
          roots.map((comment) => renderComment(comment, 0))
        )}
      </div>

      {authorUser && <ProfileCardModal user={authorUser} onClose={() => setAuthorUser(null)} />}
    </div>
  );
}
