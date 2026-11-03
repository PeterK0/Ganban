import { useState } from "react";
import YourDevices from "../../components/YourDevices";
import { confirmDialog } from '../../lib/confirm';
import { getMe, type MeResponse } from "../../lib/daemon";
import { leaveProject, setMyDisplayName, setMyProfile } from "../../lib/api";
import {
  ABILITIES,
  CARD_BACKGROUNDS,
  CARD_BORDERS,
  DEFAULT_BACKGROUND,
  PROFILE_THEMES,
  imageToAvatarDataUrl,
  parseProfile,
  serializeProfile,
  type AbilityScores,
  type Profile,
  type ProfileTheme,
} from "../../lib/profile";
import ProfileCard from "../../components/ProfileCard";
import { useNav } from "../nav";
import { Badge, Button, Field, Screen, SectionHeader, Spinner, TextInput, errMsg, useAsync } from "../ui";

/** The authenticated account: a themed profile card you can edit (avatar, vCard,
 * theme + flavor fields), your projects, rename, and sign out. */
export default function AccountScreen({ onDisconnect }: { onDisconnect: () => void }) {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync<MeResponse>(() => getMe(), []);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);

  const user = data?.user;
  const memberships = data?.memberships ?? [];
  const profile = parseProfile(user?.profile_json);

  const startEdit = () => {
    setName(user?.full_name ?? "");
    setEditingName(true);
  };

  const saveName = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await setMyDisplayName(name.trim());
      setEditingName(false);
      reload();
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = async (projectId: number, projectName: string) => {
    if (!await confirmDialog(`Leave "${projectName}"? You'll lose access until you're invited again.`)) return;
    try {
      await leaveProject(projectId);
      reload();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  return (
    <Screen title="Account" onBack={nav.pop}>
      {loading && !data && <Spinner />}
      {error && <p className="px-4 py-2 text-sm text-error">{error}</p>}

      {user && (
        <>
          <div className="p-4">
            <ProfileCard name={user.full_name} username={user.username} profile={profile} />
          </div>

          <div className="px-4 flex flex-wrap gap-2">
            <Button
              variant="surface"
              onClick={() => nav.push(<ProfileEditorScreen profile={profile} onSaved={reload} />)}
            >
              Edit profile
            </Button>
            {!editingName ? (
              <Button variant="surface" onClick={startEdit}>
                Rename
              </Button>
            ) : null}
            {user.is_owner && (
              <span className="self-center">
                <Badge className="bg-gilt-b text-gold">owner</Badge>
              </span>
            )}
          </div>

          {editingName && (
            <div className="px-4 pt-3">
              <Field label="Display name">
                <TextInput value={name} onChange={setName} placeholder="Your name" />
              </Field>
              <div className="flex gap-2 mt-2">
                <Button onClick={saveName} disabled={busy || !name.trim()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button variant="surface" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <SectionHeader>Projects</SectionHeader>
          {memberships.length === 0 ? (
            <p className="px-4 py-2 text-sm gm-mut italic">Not a member of any project.</p>
          ) : (
            memberships.map((m) => (
              <div
                key={m.project_id}
                className="flex items-center justify-between gap-2 pl-4 pr-2 py-2 min-h-[56px] border-b border-gilt-b"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-medium truncate text-text">{m.project_name}</div>
                  <div className="text-sm gm-mut">{m.role}</div>
                </div>
                {m.role !== "owner" && (
                  <button onClick={() => leave(m.project_id, m.project_name)} className="g-btn g-btn-danger g-btn-sm min-h-[44px] shrink-0">
                    Leave
                  </button>
                )}
              </div>
            ))
          )}

          <SectionHeader>Your devices</SectionHeader>
          <p className="px-4 pb-1 text-sm gm-mut">
            Every browser or app you sign in from is a device on this account. Pair another one to use Ganban there as you.
          </p>
          <YourDevices compact onSignedOutHere={onDisconnect} />

          <div className="p-4 pt-6">
            <Button
              full
              variant="danger"
              onClick={async () => {
                if (await confirmDialog("Sign out of this device?")) onDisconnect();
              }}
            >
              Sign out
            </Button>
          </div>
        </>
      )}
      <div className="h-8" />
    </Screen>
  );
}

/** Full-screen profile editor: theme, avatar, vCard fields, and theme flavor. */
function ProfileEditorScreen({ profile: initial, onSaved }: { profile: Profile; onSaved: () => void }) {
  const nav = useNav();
  const [p, setP] = useState<Profile>(initial);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<Profile>) => setP((cur) => ({ ...cur, ...patch }));
  const setDnd = (patch: Partial<NonNullable<Profile["dnd"]>>) => setP((cur) => ({ ...cur, dnd: { ...cur.dnd, ...patch } }));
  const setStat = (k: keyof AbilityScores, v: string) =>
    setP((cur) => ({ ...cur, dnd: { ...cur.dnd, stats: { ...cur.dnd?.stats, [k]: v } } }));
  const setCard = (patch: Partial<NonNullable<Profile["card"]>>) => setP((cur) => ({ ...cur, card: { ...cur.card, ...patch } }));

  const pickAvatar = async (file: File) => {
    try {
      set({ avatar: await imageToAvatarDataUrl(file) });
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await setMyProfile(serializeProfile(p));
      onSaved();
      nav.pop();
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Edit profile"
      onBack={nav.pop}
      right={
        <button onClick={save} disabled={busy} className="g-btn g-btn-gilt g-btn-sm min-h-[44px] mr-1">
          {busy ? "…" : "Save"}
        </button>
      }
    >
      <div className="p-4 space-y-5">
        {/* Live preview */}
        <ProfileCard name="Preview" profile={p} />

        <Field label="Card style">
          <div className="grid grid-cols-2 gap-2">
            {PROFILE_THEMES.map((t) => (
              <button
                key={t.key}
                onClick={() => set({ theme: t.key as ProfileTheme })}
                aria-pressed={p.theme === t.key}
                className="gm-chip"
              >
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Card background">
          <div className="flex flex-wrap gap-2">
            {CARD_BACKGROUNDS.map((b) => {
              const active = (p.background || DEFAULT_BACKGROUND[p.theme]) === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => set({ background: b.key })}
                  aria-label={b.label}
                  aria-pressed={active}
                  className={`w-11 h-11 rounded border-2 ${active ? "border-gold" : "border-surface-1"}`}
                  style={{ background: b.palette.bg }}
                />
              );
            })}
          </div>
        </Field>

        <Field label="Border">
          <div className="flex gap-2">
            {CARD_BORDERS.map((bd) => (
              <button
                key={bd.key}
                type="button"
                onClick={() => set({ border: bd.key })}
                aria-pressed={(p.border || "soft") === bd.key}
                className="gm-chip"
              >
                {bd.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Avatar">
          <div className="flex items-center gap-3">
            {p.avatar ? (
              <img src={p.avatar} alt="avatar" className="w-16 h-16 rounded-full object-cover" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-surface-0 border border-gilt-a" />
            )}
            <label className="g-btn g-btn-ghost min-h-[44px] px-3 text-sm cursor-pointer">
              Choose image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickAvatar(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
            {p.avatar && (
              <button onClick={() => set({ avatar: undefined })} className="text-error text-sm min-h-[44px] px-2">
                Remove
              </button>
            )}
          </div>
        </Field>

        <Field label="Title / role">
          <TextInput value={p.title ?? ""} onChange={(v) => set({ title: v })} placeholder="e.g. Designer" />
        </Field>
        <Field label="Organization">
          <TextInput value={p.organization ?? ""} onChange={(v) => set({ organization: v })} />
        </Field>
        <Field label="Pronouns">
          <TextInput value={p.pronouns ?? ""} onChange={(v) => set({ pronouns: v })} placeholder="e.g. they/them" />
        </Field>
        <Field label="Email">
          <TextInput value={p.email ?? ""} onChange={(v) => set({ email: v })} type="email" />
        </Field>
        <Field label="Phone">
          <TextInput value={p.phone ?? ""} onChange={(v) => set({ phone: v })} />
        </Field>
        <Field label="Location">
          <TextInput value={p.location ?? ""} onChange={(v) => set({ location: v })} />
        </Field>
        <Field label="Website">
          <TextInput value={p.website ?? ""} onChange={(v) => set({ website: v })} type="url" />
        </Field>
        <Field label={p.theme === "character" ? "Backstory" : "Bio"}>
          <textarea
            value={p.bio ?? ""}
            onChange={(e) => set({ bio: e.target.value })}
            rows={3}
            className="g-field gm-field"
          />
        </Field>

        {p.theme === "character" && (
          <div className="space-y-3">
            <SectionHeader>Character</SectionHeader>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Class">
                <TextInput value={p.dnd?.class ?? ""} onChange={(v) => setDnd({ class: v })} placeholder="Wizard" />
              </Field>
              <Field label="Race">
                <TextInput value={p.dnd?.race ?? ""} onChange={(v) => setDnd({ race: v })} placeholder="Elf" />
              </Field>
              <Field label="Level">
                <TextInput value={p.dnd?.level ?? ""} onChange={(v) => setDnd({ level: v })} placeholder="5" />
              </Field>
              <Field label="Alignment">
                <TextInput value={p.dnd?.alignment ?? ""} onChange={(v) => setDnd({ alignment: v })} placeholder="Chaotic Good" />
              </Field>
            </div>
            <div className="grid grid-cols-6 gap-1.5">
              {ABILITIES.map((k) => (
                <div key={k}>
                  <div className="g-flbl text-center mb-1" style={{ letterSpacing: "0.1em" }}>{k}</div>
                  <input
                    value={p.dnd?.stats?.[k] ?? ""}
                    onChange={(e) => setStat(k, e.target.value)}
                    inputMode="numeric"
                    className="g-field gm-field gm-field-tight"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {p.theme === "card" && (
          <div className="space-y-3">
            <SectionHeader>Card</SectionHeader>
            <Field label="Tagline">
              <TextInput value={p.card?.tagline ?? ""} onChange={(v) => setCard({ tagline: v })} placeholder="Ships it." />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Rarity">
                <TextInput value={p.card?.rarity ?? ""} onChange={(v) => setCard({ rarity: v })} placeholder="Legendary" />
              </Field>
              <Field label="Power">
                <TextInput value={p.card?.power ?? ""} onChange={(v) => setCard({ power: v })} placeholder="9000" />
              </Field>
            </div>
            <Field label="Power label">
              <TextInput value={p.card?.powerLabel ?? ""} onChange={(v) => setCard({ powerLabel: v })} placeholder="Focus" />
            </Field>
          </div>
        )}
      </div>
      <div className="h-8" />
    </Screen>
  );
}
