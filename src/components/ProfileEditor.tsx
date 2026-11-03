import { useEffect, useState } from 'react';
import { getUser, setUserProfile, updateUser, setMyProfile, setMyDisplayName, setUserPin, verifyUserPin } from '../lib/api';
import { getMe, isDesktopOnline } from '../lib/daemon';
import {
  ABILITIES,
  CARD_BACKGROUNDS,
  CARD_BORDERS,
  DEFAULT_BACKGROUND,
  PROFILE_THEMES,
  blankProfile,
  imageToAvatarDataUrl,
  imageToEmojiDataUrl,
  parseProfile,
  serializeProfile,
  type AbilityScores,
  type Profile,
} from '../lib/profile';
import ProfileCard from './ProfileCard';

/** The profile-editing form + live preview, used inline by ProfileModal and the
 * Settings "Profile" section. Edits the display name (updateUser) and the
 * profile blob (setUserProfile) for `userId`. */
export default function ProfileEditor({ userId, onSaved }: { userId: number | null; onSaved?: () => void }) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [origName, setOrigName] = useState('');
  const [p, setP] = useState<Profile>(blankProfile());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    const online = isDesktopOnline();
    if (!online && !userId) return;
    let active = true;
    setLoading(true);
    setError(null);
    // Online: "me" is whoever the device token authenticates as on the host.
    const load = online
      ? getMe().then((me) => ({ id: me.user.id, full_name: me.user.full_name, username: me.user.username, profile_json: me.user.profile_json, has_pin: (me.user as { has_pin?: boolean }).has_pin }))
      : getUser(userId as number).then((u) => ({ id: u.id, full_name: u.full_name, username: u.username, profile_json: u.profile_json, has_pin: u.has_pin }));
    load
      .then((u) => {
        if (!active) return;
        setFullName(u.full_name);
        setOrigName(u.full_name);
        setUsername(u.username);
        setP(parseProfile(u.profile_json));
        setPinUserId(u.id);
        setHasPin(!!u.has_pin);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [userId]);

  // Profile PIN: gates switching INTO this profile (set/changed here; the
  // owner can clear a forgotten one from Settings → Profiles).
  const [pinUserId, setPinUserId] = useState<number | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [pinCurrent, setPinCurrent] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);

  const savePin = async () => {
    if (pinUserId == null) return;
    setPinMsg(null);
    try {
      if (hasPin && !(await verifyUserPin(pinUserId, pinCurrent))) {
        setPinMsg('Current PIN is wrong');
        return;
      }
      await setUserPin(pinUserId, pinNew || null);
      setHasPin(!!pinNew);
      setPinCurrent('');
      setPinNew('');
      setPinMsg(pinNew ? 'PIN set ✓' : 'PIN removed ✓');
    } catch (e) {
      setPinMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const set = (patch: Partial<Profile>) => setP((cur) => ({ ...cur, ...patch }));
  const setDnd = (patch: Partial<NonNullable<Profile['dnd']>>) => setP((cur) => ({ ...cur, dnd: { ...cur.dnd, ...patch } }));
  const setStat = (k: keyof AbilityScores, v: string) =>
    setP((cur) => ({ ...cur, dnd: { ...cur.dnd, stats: { ...cur.dnd?.stats, [k]: v } } }));
  const setCard = (patch: Partial<NonNullable<Profile['card']>>) => setP((cur) => ({ ...cur, card: { ...cur.card, ...patch } }));

  const pickAvatar = async (file: File) => {
    try {
      set({ avatar: await imageToAvatarDataUrl(file) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // My Custom Emojis (personal, travel with the profile). Saved with the rest of
  // the profile on "Save"; transparent PNG.
  const [emojiName, setEmojiName] = useState('');
  const addEmoji = async (file: File) => {
    const n = emojiName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!n) {
      setError('Give the emoji a name first (a-z, 0-9, _).');
      return;
    }
    try {
      const image = await imageToEmojiDataUrl(file, 64);
      setP((cur) => ({
        ...cur,
        customEmojis: [...(cur.customEmojis ?? []).filter((e) => e.name !== n), { name: n, image }],
      }));
      setEmojiName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const removeEmoji = (name: string) =>
    setP((cur) => ({ ...cur, customEmojis: (cur.customEmojis ?? []).filter((e) => e.name !== name) }));

  const save = async () => {
    const online = isDesktopOnline();
    if (!online && !userId) return;
    if (!fullName.trim()) {
      setError('Display name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (online) {
        // Self-service against the host: edits only the authenticated user.
        if (fullName.trim() !== origName) await setMyDisplayName(fullName.trim());
        await setMyProfile(serializeProfile(p));
      } else {
        if (fullName.trim() !== origName) await updateUser(userId as number, { full_name: fullName.trim() });
        await setUserProfile(userId as number, serializeProfile(p));
      }
      setOrigName(fullName.trim());
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 1500);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const input = 'g-field';
  const Label = ({ children }: { children: React.ReactNode }) => (
    <label className="g-flbl">{children}</label>
  );

  if (loading) return <div className="p-6 text-subtext-0">Loading…</div>;
  if (!userId && !isDesktopOnline()) return <div className="p-6 text-subtext-0">No user selected.</div>;

  return (
    <div className="flex flex-col md:flex-row gap-5">
      <div className="md:w-64 md:shrink-0">
        <div className="text-xs text-subtext-0 mb-2">Preview</div>
        <ProfileCard name={fullName || 'You'} username={username} profile={p} />
      </div>

      <div className="flex-1 space-y-4 min-w-0">
        <div>
          <Label>Card style</Label>
          <div className="grid grid-cols-2 gap-2">
            {PROFILE_THEMES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => set({ theme: t.key })}
                className={`g-chip justify-center rounded ${p.theme === t.key ? 'g-on' : 'shadow-[inset_0_0_0_1px_var(--color-surface-1)]'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label>Card background</Label>
          <div className="flex flex-wrap gap-2">
            {CARD_BACKGROUNDS.map((b) => {
              const active = (p.background || DEFAULT_BACKGROUND[p.theme]) === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => set({ background: b.key })}
                  title={b.label}
                  className={`w-10 h-10 rounded border-2 ${active ? 'border-gold' : 'border-surface-1'}`}
                  style={{ background: b.palette.bg }}
                />
              );
            })}
          </div>
        </div>

        <div>
          <Label>Border</Label>
          <div className="flex gap-2">
            {CARD_BORDERS.map((bd) => (
              <button
                key={bd.key}
                type="button"
                onClick={() => set({ border: bd.key })}
                className={`g-chip ${(p.border || 'soft') === bd.key ? 'g-on' : ''}`}
              >
                {bd.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label>Avatar</Label>
          <div className="flex items-center gap-3">
            {p.avatar ? (
              <img src={p.avatar} alt="avatar" className="w-16 h-16 rounded-full object-cover" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-surface-2" />
            )}
            <label className="px-3 py-2 rounded-lg bg-surface-1 text-text text-sm cursor-pointer hover:bg-surface-2">
              Choose image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickAvatar(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>
            {p.avatar && (
              <button onClick={() => set({ avatar: undefined })} className="text-error text-sm">
                Remove
              </button>
            )}
          </div>
        </div>

        <div>
          <Label>My custom emojis</Label>
          <p className="text-xs text-subtext-0 -mt-1 mb-2">
            Personal emojis (`:name:`) that follow your account across projects. Transparent PNGs work best.
            Save to keep them.
          </p>
          {(p.customEmojis ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {(p.customEmojis ?? []).map((e) => (
                <div key={e.name} className="flex items-center gap-1 bg-surface-1 border border-surface-2 rounded-lg px-2 py-1">
                  <img src={e.image} alt={e.name} className="w-5 h-5 object-contain" />
                  <span className="text-xs font-mono text-subtext-1">:{e.name}:</span>
                  <button onClick={() => removeEmoji(e.name)} className="text-error text-xs ml-1" title="Remove">×</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={emojiName}
              onChange={(e) => setEmojiName(e.target.value.toLowerCase())}
              placeholder="name (a-z, 0-9, _)"
              className="flex-1 px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-text text-sm font-mono"
            />
            <label className="px-3 py-2 rounded-lg bg-surface-1 text-text text-sm cursor-pointer hover:bg-surface-2 whitespace-nowrap">
              Choose image
              <input
                type="file"
                accept="image/png,image/gif,image/webp,image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) addEmoji(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Display name</Label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={input} />
          </div>
          <div>
            <Label>Title / role</Label>
            <input value={p.title ?? ''} onChange={(e) => set({ title: e.target.value })} className={input} />
          </div>
          <div>
            <Label>Organization</Label>
            <input value={p.organization ?? ''} onChange={(e) => set({ organization: e.target.value })} className={input} />
          </div>
          <div>
            <Label>Pronouns</Label>
            <input value={p.pronouns ?? ''} onChange={(e) => set({ pronouns: e.target.value })} className={input} />
          </div>
          <div>
            <Label>Email</Label>
            <input value={p.email ?? ''} onChange={(e) => set({ email: e.target.value })} className={input} />
          </div>
          <div>
            <Label>Phone</Label>
            <input value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} className={input} />
          </div>
          <div>
            <Label>Location</Label>
            <input value={p.location ?? ''} onChange={(e) => set({ location: e.target.value })} className={input} />
          </div>
          <div className="col-span-2">
            <Label>Website</Label>
            <input value={p.website ?? ''} onChange={(e) => set({ website: e.target.value })} className={input} />
          </div>
          <div className="col-span-2">
            <Label>{p.theme === 'character' ? 'Backstory' : 'Bio'}</Label>
            <textarea value={p.bio ?? ''} onChange={(e) => set({ bio: e.target.value })} rows={3} className={input} />
          </div>
        </div>

        {p.theme === 'character' && (
          <div className="space-y-3 border-t border-surface-2 pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Class</Label>
                <input value={p.dnd?.class ?? ''} onChange={(e) => setDnd({ class: e.target.value })} className={input} />
              </div>
              <div>
                <Label>Race</Label>
                <input value={p.dnd?.race ?? ''} onChange={(e) => setDnd({ race: e.target.value })} className={input} />
              </div>
              <div>
                <Label>Level</Label>
                <input value={p.dnd?.level ?? ''} onChange={(e) => setDnd({ level: e.target.value })} className={input} />
              </div>
              <div>
                <Label>Alignment</Label>
                <input value={p.dnd?.alignment ?? ''} onChange={(e) => setDnd({ alignment: e.target.value })} className={input} />
              </div>
            </div>
            <div className="grid grid-cols-6 gap-2">
              {ABILITIES.map((k) => (
                <div key={k}>
                  <Label>{k.toUpperCase()}</Label>
                  <input
                    value={p.dnd?.stats?.[k] ?? ''}
                    onChange={(e) => setStat(k, e.target.value)}
                    className={`${input} text-center px-1`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {p.theme === 'card' && (
          <div className="space-y-3 border-t border-surface-2 pt-3 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Tagline</Label>
              <input value={p.card?.tagline ?? ''} onChange={(e) => setCard({ tagline: e.target.value })} className={input} />
            </div>
            <div>
              <Label>Rarity</Label>
              <input value={p.card?.rarity ?? ''} onChange={(e) => setCard({ rarity: e.target.value })} className={input} />
            </div>
            <div>
              <Label>Power</Label>
              <input value={p.card?.power ?? ''} onChange={(e) => setCard({ power: e.target.value })} className={input} />
            </div>
            <div>
              <Label>Power label</Label>
              <input value={p.card?.powerLabel ?? ''} onChange={(e) => setCard({ powerLabel: e.target.value })} className={input} />
            </div>
          </div>
        )}

        {error && <div className="text-sm text-error">{error}</div>}
        <button
          onClick={save}
          disabled={saving}
          className="g-btn g-btn-pri"
        >
          {saving ? 'Saving…' : savedMsg ? 'Saved ✓' : 'Save profile'}
        </button>

        <div className="border-t border-surface-2 pt-3 space-y-2">
          <div className="text-sm font-medium text-text">Profile PIN</div>
          <p className="text-xs text-subtext-0">
            {hasPin
              ? 'A PIN is set — switching to this profile asks for it.'
              : 'No PIN — anyone on this machine can switch to this profile. Set 4–8 digits to lock it.'}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            {hasPin && (
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={pinCurrent}
                onChange={(e) => setPinCurrent(e.target.value.replace(/\D/g, ''))}
                placeholder="Current PIN"
                className="w-32 px-3 py-2 text-sm bg-surface-1 border border-surface-2 rounded-lg focus:outline-none focus:border-primary"
              />
            )}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={pinNew}
              onChange={(e) => setPinNew(e.target.value.replace(/\D/g, ''))}
              placeholder={hasPin ? 'New PIN (blank = remove)' : 'New PIN'}
              className="w-44 px-3 py-2 text-sm bg-surface-1 border border-surface-2 rounded-lg focus:outline-none focus:border-primary"
            />
            <button
              onClick={() => void savePin()}
              disabled={(hasPin ? pinCurrent.length < 4 : pinNew.length < 4) || (!hasPin && !pinNew)}
              className="px-3 py-2 text-sm bg-surface-2 text-text rounded-lg disabled:opacity-50"
            >
              {hasPin ? (pinNew ? 'Change PIN' : 'Remove PIN') : 'Set PIN'}
            </button>
            {pinMsg && <span className="text-xs text-subtext-1">{pinMsg}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
