import { useEffect, useRef, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import { EMOJI_PALETTE, refreshEmojiMap } from '../lib/emoji';
import { hasDaemon, createCustomEmoji, deleteCustomEmoji } from '../lib/daemon';
import { imageToEmojiDataUrl } from '../lib/profile';
import { Modal } from './gilt';

type EmojiItem = { id?: number; name: string; image: string };

/** An emoji grid in a Gilt Modal (the scrim covers the whole window): your personal ("Mine") emojis, the team's shared ones,
 * then the unicode palette. `onPick` receives a unicode char or a `:name:`
 * shortcode. The inline "Add" creates a TEAM emoji (shared, renders for everyone);
 * personal emojis are managed in Profile settings. Needs a daemon for custom sets. */
export default function EmojiPicker({ onPick, onClose }: { onPick: (token: string) => void; onClose: () => void }) {
  const [team, setTeam] = useState<EmojiItem[]>([]);
  const [mine, setMine] = useState<EmojiItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!hasDaemon()) return;
    refreshEmojiMap()
      .then(({ team, mine }) => {
        setTeam(team);
        setMine(mine);
      })
      .catch(() => {});
  };
  useEffect(load, []);

  const add = async () => {
    const n = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!n || !file) {
      setError('Name it and choose an image.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const image = await imageToEmojiDataUrl(file, 64); // transparent PNG
      await createCustomEmoji(n, image);
      setName('');
      setFile(null);
      setAdding(false);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeTeam = async (e: EmojiItem) => {
    if (e.id == null || !await confirmDialog(`Remove the team emoji :${e.name}:?`)) return;
    try {
      await deleteCustomEmoji(e.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const Grid = ({ items, onRemove }: { items: EmojiItem[]; onRemove?: (e: EmojiItem) => void }) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-0.5 max-h-28 overflow-y-auto">
      {items.map((e) => (
        <div key={(e.id ?? 'm') + e.name} className="relative group">
          <button type="button" onClick={() => onPick(`:${e.name}:`)} title={`:${e.name}:`} className="w-full h-9 flex items-center justify-center hover:bg-gilt-b rounded">
            <img src={e.image} alt={e.name} className="w-5 h-5 object-contain mx-auto" />
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(e)}
              title="Remove"
              className="absolute -top-1 -right-1 hidden group-hover:flex items-center justify-center bg-error text-white rounded-full w-3.5 h-3.5 text-[9px] leading-none"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <Modal onClose={onClose} title="Emoji" className="w-[420px]">
     <div className="px-5 pb-5 overflow-y-auto">
      {hasDaemon() && (
        <div className="mb-3 space-y-2">
          {mine.length > 0 && (
            <div>
              <div className="g-flbl !mb-1">Mine (in Profile settings)</div>
              <Grid items={mine} />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="g-flbl !mb-0">Team</span>
            <button type="button" onClick={() => setAdding((a) => !a)} className="g-lnk" aria-expanded={adding}>
              ＋ Add
            </button>
          </div>
          {adding && (
            <div className="g-inset !p-3 space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="name (a-z, 0-9, _)"
                aria-label="Emoji name"
                className="g-field g-field-sm font-mono"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/gif,image/webp,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-xs text-subtext-0"
              />
              {error && <p className="text-[11px] text-error">{error}</p>}
              <button type="button" onClick={add} disabled={busy} className="g-btn g-btn-pri g-btn-sm w-full">
                {busy ? 'Adding…' : `Add :${name || 'name'}: for the team`}
              </button>
            </div>
          )}
          {team.length > 0 && <Grid items={team} onRemove={removeTeam} />}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-0.5 max-h-64 overflow-y-auto">
        {EMOJI_PALETTE.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="text-lg h-9 hover:bg-gilt-b rounded">
            {e}
          </button>
        ))}
      </div>
     </div>
    </Modal>
  );
}
