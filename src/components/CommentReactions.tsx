import { useState } from 'react';
import { hasDaemon, toggleCommentReaction, type ReactionSummary } from '../lib/daemon';
import { customEmojiUrl } from '../lib/emoji';
import EmojiPicker from './EmojiPicker';

/** Render a reaction's glyph: a custom `:name:` emoji as its image, else the
 * unicode char verbatim. */
function ReactionGlyph({ emoji }: { emoji: string }) {
  const m = emoji.match(/^:([a-z0-9_]+):$/i);
  const url = m ? customEmojiUrl(m[1].toLowerCase()) : undefined;
  if (url) return <img src={url} alt={emoji} className="inline-block w-4 h-4 object-cover align-text-bottom" />;
  return <>{emoji}</>;
}

/** Emoji reactions on a comment. `reactions` is the tally for THIS comment;
 * onChanged refetches after a toggle. Reactions are host-served, so this is a
 * no-op when there's no daemon connection. */
export default function CommentReactions({
  commentId,
  reactions,
  onChanged,
}: {
  commentId: number;
  reactions: ReactionSummary[];
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!hasDaemon()) return null;

  const toggle = async (emoji: string) => {
    if (busy) return;
    setBusy(true);
    setPicking(false);
    try {
      await toggleCommentReaction(commentId, emoji);
      onChanged();
    } catch {
      /* surfaced elsewhere; keep the UI quiet */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center flex-wrap gap-1.5">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => toggle(r.emoji)}
          disabled={busy}
          aria-pressed={r.mine > 0}
          className={`g-tag g-hit !min-h-[26px] !px-2 tabular-nums transition-colors disabled:opacity-50 ${
            r.mine > 0 ? '!bg-gilt-b !text-gold shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : 'hover:!text-text'
          }`}
          title={r.mine > 0 ? 'Remove your reaction' : 'React'}
        >
          <ReactionGlyph emoji={r.emoji} /> {r.count}
        </button>
      ))}
      <button
        onClick={() => setPicking((p) => !p)}
        disabled={busy}
        className="g-tag g-hit !min-h-[26px] !px-2 !bg-transparent shadow-[inset_0_0_0_1px_var(--color-surface-1)] hover:!text-text disabled:opacity-50"
        title="Add a reaction"
        aria-label="Add a reaction"
      >
        🙂+
      </button>
      {picking && <EmojiPicker onPick={(t) => toggle(t)} onClose={() => setPicking(false)} />}
    </div>
  );
}
