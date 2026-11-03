import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, User } from '../types';
import { attachPastedImage, getTaskAudience } from '../lib/api';
import { parseProfile } from '../lib/profile';
import Avatar from './Avatar';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import MarkdownField from './MarkdownField';

interface CommentEditorProps {
  comment?: Comment;
  taskId: number;
  onSave: (content: string) => void;
  onCancel: () => void;
  isSaving?: boolean;
  /** People available to @mention (autocomplete). */
  users?: User[];
  /** Submit button text (defaults to Add Comment / Update). */
  submitLabel?: string;
  /** When set, submitting is blocked and this explains why (e.g. "Tag a task"). */
  blockedReason?: string | null;
  /** Pasted images upload to the active host; off when this editor writes to
   * another workspace (the image would land on the wrong host). */
  allowImages?: boolean;
  placeholder?: string;
  rows?: number;
  /** Controlled text: the caller holds it (an update draft that outlives this
   * editor). Left out, the editor keeps its own. */
  value?: string;
  onChange?: (content: string) => void;
  /** Warn when an @mention names someone who can't see the task (task visibility). Off
   * when this editor writes to another workspace's host (the audience lives there). */
  checkAudience?: boolean;
}

export default function CommentEditor({
  comment,
  taskId,
  onSave,
  onCancel,
  isSaving = false,
  users = [],
  submitLabel,
  blockedReason = null,
  allowImages = true,
  placeholder,
  rows = 4,
  value,
  onChange,
  checkAudience = true,
}: CommentEditorProps) {
  const [ownContent, setOwnContent] = useState(comment?.content || '');
  const content = value ?? ownContent;
  // The latest text, for updates that land after an await (a pasted image).
  const latest = useRef(content);
  latest.current = content;
  const setContent = (next: string | ((c: string) => string)) => {
    if (!onChange) return setOwnContent(next);
    const v = typeof next === 'function' ? next(latest.current) : next;
    latest.current = v;
    onChange(v);
  };
  const [showGif, setShowGif] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);

  // @mention: when the text ends with an @token, offer matching people. Picking
  // one replaces the trailing token with @username (kept verbatim in the text).
  const mentionMatch = content.match(/(?:^|\s)@(\w{0,30})$/);
  const mentionHits =
    mentionMatch != null
      ? users
          .filter((u) => {
            const q = mentionMatch[1].toLowerCase();
            return u.username.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q);
          })
          .slice(0, 6)
      : [];
  // @mentions of people who can't see the task: they won't be notified, so say so.
  const mentioned = useMemo(
    () => [...content.matchAll(/(?:^|\s)@(\w{1,30})/g)].map((m) => m[1].toLowerCase()),
    [content]
  );
  const [audience, setAudience] = useState<{ taskId: number; ids: number[] } | null>(null);
  const wantsAudience = checkAudience && !!taskId && mentioned.length > 0;
  useEffect(() => {
    if (!wantsAudience || audience?.taskId === taskId) return;
    let cancelled = false;
    getTaskAudience(taskId)
      .then((a) => !cancelled && setAudience({ taskId, ids: a.audience }))
      .catch(() => {}); // an older host: no warning
    return () => {
      cancelled = true;
    };
  }, [wantsAudience, taskId, audience?.taskId]);
  const cantSee =
    audience?.taskId === taskId
      ? [...new Set(mentioned)]
          .map((name) => users.find((u) => u.username.toLowerCase() === name))
          .filter((u): u is User => !!u && !audience.ids.includes(u.id))
      : [];

  const pickMention = (u: User) => setContent((c) => c.replace(/@(\w{0,30})$/, `@${u.username} `));
  const insertEmoji = (e: string) => { setContent((c) => c + e); setShowEmoji(false); };

  const append = (snippet: string) =>
    setContent((c) => `${c}${c && !c.endsWith('\n') ? '\n' : ''}${snippet}\n`);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (content.trim() && !blockedReason) onSave(content);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item || !allowImages || !taskId) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    setUploading(true);
    try {
      const att = await attachPastedImage(taskId, file);
      append(`![image](/files/${att.id})`);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5">
      <div className="relative">
        <MarkdownField
          value={content}
          onChange={setContent}
          onPaste={handlePaste}
          placeholder={placeholder ?? 'Write a comment… (Markdown; @mention, emoji, paste an image, or add a GIF)'}
          rows={rows}
          autoFocus
          disabled={isSaving}
        />
        {mentionHits.length > 0 && (
          <div className="absolute z-20 left-2 bottom-2 w-60 bg-base border border-gilt-a rounded shadow-lg overflow-hidden">
            {mentionHits.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => pickMention(u)}
                className="w-full flex items-center gap-2 px-2.5 min-h-[36px] text-left text-sm hover:bg-gilt-b"
              >
                <Avatar name={u.full_name} src={parseProfile(u.profile_json).avatar} size={20} />
                <span className="truncate text-text">{u.full_name}</span>
                <span className="text-xs text-subtext-0 truncate">@{u.username}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 justify-end flex-wrap">
        <div className="mr-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { setShowEmoji((s) => !s); setShowGif(false); }}
            className="g-btn g-btn-ghost g-btn-sm"
            title="Insert emoji"
            aria-label="Insert emoji"
          >
            😊
          </button>
          <button
            type="button"
            onClick={() => setShowGif(true)}
            className="g-btn g-btn-ghost g-btn-sm"
            title="Insert a GIF"
          >
            GIF
          </button>
          {showEmoji && <EmojiPicker onPick={(t) => insertEmoji(t)} onClose={() => setShowEmoji(false)} />}
        </div>
        {cantSee.length > 0 && (
          <span className="text-xs text-warning" title="They're outside this task's audience, so they won't be notified">
            ⚠️ {cantSee.map((u) => `@${u.username}`).join(', ')} can’t see this task
          </span>
        )}
        {blockedReason && <span className="text-xs text-warning">{blockedReason}</span>}
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="g-btn g-btn-ghost g-btn-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!content.trim() || isSaving || uploading || !!blockedReason}
          className="g-btn g-btn-pri g-glint g-btn-sm"
        >
          {uploading ? 'Uploading…' : isSaving ? 'Saving…' : submitLabel ?? (comment ? 'Update' : 'Add Comment')}
        </button>
      </div>
      {showGif && (
        <GifPicker
          onClose={() => setShowGif(false)}
          onPick={(url) => {
            append(`![gif](${url})`);
            setShowGif(false);
          }}
        />
      )}
    </form>
  );
}
