/** Emoji sets for comments: a compact quick-react bar and a broader palette for
 * the reaction picker grid and the composer's emoji button. */
import { listCustomEmojis } from './daemon';
import { getMyCustomEmojis } from './api';

/** Shown inline as the default one-tap reactions. */
export const QUICK_REACTIONS = ['👍', '❤️', '🎉', '😄', '🙌', '👀', '🤔', '✅'];

/** The full picker grid — significantly more than the quick bar. */
export const EMOJI_PALETTE = [
  '👍', '👎', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '🎉', '🙌', '👏',
  '✅', '❌', '⭐', '💯', '🚀', '✨', '⚡', '💡', '🧠', '👀', '🫡', '🤝',
  '😀', '😄', '😅', '😂', '🙂', '😉', '😍', '😎', '🤔', '😴', '😬', '😭',
  '😡', '🤯', '🥳', '🥲', '🙃', '🤩', '🙏', '💪', '👋', '🤞', '🫶', '🤙',
  '📌', '📝', '📈', '📉', '🐛', '🔧', '🛠️', '🧪', '🔒', '⏰', '🟢', '🔴',
];

// ---- Custom emojis (:name: -> image) -------------------------------------
// A module-level map so the markdown renderer can resolve :name: to an <img>
// without prop-drilling. Kept in sync by whoever fetches the custom emoji list.
let CUSTOM: Record<string, string> = {};

/** Replace the custom-emoji map (name -> data-URL) after a fetch. */
export function setCustomEmojiMap(list: { name: string; image: string }[]): void {
  CUSTOM = Object.fromEntries(list.map((e) => [e.name, e.image]));
}

/** The image data-URL for a custom emoji name, if known. */
export function customEmojiUrl(name: string): string | undefined {
  return CUSTOM[name];
}

/** Fetch the team's shared emojis + the current user's personal (profile) emojis,
 * set the render map (personal wins on a name clash), and return both sets for the
 * picker. Resilient: a missing host or profile just yields fewer emojis. */
export async function refreshEmojiMap(): Promise<{
  team: { id?: number; name: string; image: string }[];
  mine: { name: string; image: string }[];
}> {
  const [team, mine] = await Promise.all([
    listCustomEmojis().catch(() => [] as { id?: number; name: string; image: string }[]),
    getMyCustomEmojis().catch(() => [] as { name: string; image: string }[]),
  ]);
  setCustomEmojiMap([...team, ...mine]);
  return { team, mine };
}

/** Rewrite `:name:` for KNOWN custom emojis into a markdown image whose alt is
 * `emoji:<name>` — MarkdownPreview's img renderer turns that marker into a small
 * inline <img> (resolving the data-URL from the map, never through the markdown,
 * so it survives sanitization). Unknown `:tokens:` are left untouched. */
export function injectCustomEmojis(text: string): string {
  return text.replace(/:([a-z0-9_]{1,32}):/gi, (m, name: string) =>
    CUSTOM[name.toLowerCase()] ? `![emoji:${name.toLowerCase()}](custom-emoji)` : m
  );
}
