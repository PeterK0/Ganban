import { useEffect, useState } from 'react';
import {
  listProfiles,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  setSecretaryProfile,
  setRoutingProfile,
  getModelInfo,
  parseModelMeta,
  listOllamaModels,
  listLoadouts,
  getProfileLoadouts,
  setProfileLoadouts,
  listProtocols,
  DaemonError,
  type ModelProfile,
  type ModelMeta,
  type Loadout,
  type ProtocolInfo,
} from '../lib/daemon';
import { ASSISTANT_TREE_W } from '../lib/ui';

const input = 'g-field';

/** A role-assignment toggle chip (Chat / Daily assistant / Agent runner / Research). */
function RoleToggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
        on ? 'border-primary bg-primary/15 text-primary' : 'border-surface-2 text-text hover:bg-surface-1'
      }`}
    >
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

/** A personality's profile picture — the custom image, or initials as a fallback. */
export function ProfileAvatar({ avatar, name, size = 40 }: { avatar?: string | null; name: string; size?: number }) {
  if (avatar) {
    return <img src={avatar} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  const initials = name.trim().slice(0, 1).toUpperCase() || '🤖';
  return (
    <div
      className="rounded-full bg-surface-2 text-subtext-0 flex items-center justify-center shrink-0 font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </div>
  );
}

/** The "key facts" row of a model vCard: context window, size, family, tools. */
export function ModelCard({ meta }: { meta: ModelMeta | null }) {
  if (!meta) return null;
  const ctx = meta.context_length ? `${Math.round(meta.context_length / 1024)}K context` : null;
  const caps = (meta.capabilities ?? []).filter(Boolean);
  if (!ctx && !meta.parameter_size && !meta.family && caps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px]">
      {ctx && <span className="px-1.5 py-0.5 rounded bg-surface-2 text-subtext-1">{ctx}</span>}
      {meta.parameter_size && <span className="px-1.5 py-0.5 rounded bg-surface-2 text-subtext-1">{meta.parameter_size}</span>}
      {meta.family && <span className="px-1.5 py-0.5 rounded bg-surface-2 text-subtext-1">{meta.family}</span>}
      {caps.map((c) => (
        <span key={c} className="px-1.5 py-0.5 rounded bg-primary/15 text-primary">{c}</span>
      ))}
    </div>
  );
}

/** Manage AI personalities (model + system prompt + params + vCard). Self-contained:
 * loads its own profiles + model list. Owner-only on the host — non-owners see a
 * notice. Used by the Assistant's Models tab and by Settings → Personalities. */
export default function ModelProfilesPanel() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null);
  const [secretaryProfileId, setSecretaryProfileId] = useState<number | null>(null);
  const [toolProfileId, setToolProfileId] = useState<number | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [notOwner, setNotOwner] = useState(false);

  const [pName, setPName] = useState('');
  const [pModel, setPModel] = useState('');
  const [pPrompt, setPPrompt] = useState('');
  const [pTemp, setPTemp] = useState('0.7');
  const [pMax, setPMax] = useState('');
  const [pEditId, setPEditId] = useState<number | null>(null);
  const [pAvatar, setPAvatar] = useState<string | null>(null);
  const [pEndpoint, setPEndpoint] = useState('');
  const [pFallback, setPFallback] = useState('');
  const [pRemoteModels, setPRemoteModels] = useState<string[] | null>(null);
  const [pMeta, setPMeta] = useState<ModelMeta | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // The KIT: which loadouts (tool grants + prompt fragments) this agent
  // carries, and which protocols pin it. Tools are granted only through
  // loadouts — the kit is the one place an agent's capability is decided.
  const [loadouts, setLoadouts] = useState<Loadout[]>([]);
  const [kitIds, setKitIds] = useState<number[]>([]);
  const [kitBusy, setKitBusy] = useState(false);
  const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);

  const loadProfiles = async () => {
    try {
      const r = await listProfiles();
      setProfiles(r.profiles);
      setActiveProfileId(r.active_id);
      setSecretaryProfileId(r.secretary_id ?? null);
      setToolProfileId(r.routing?.tools ?? null);
      setLibrarianProfileId(r.routing?.librarian ?? null);
    } catch (e) {
      if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) setNotOwner(true);
      else setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadProfiles();
    listOllamaModels()
      .then(setModels)
      .catch(() => {/* Ollama may be down / not owner — fall back to a text field */});
    listLoadouts().then(setLoadouts).catch(() => setLoadouts([]));
    listProtocols().then((r) => setProtocols(r.protocols)).catch(() => setProtocols([]));
  }, []);

  // Live model card for the chosen model, before saving. Debounced so a
  // free-text model field doesn't probe /ai/model-info on every keystroke.
  useEffect(() => {
    if (!pModel.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getModelInfo(pModel.trim())
        .then((m) => !cancelled && setPMeta(m))
        .catch(() => {/* engine down / model not pulled — keep any cached meta */});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pModel]);

  const editProfile = (p: ModelProfile) => {
    setPEditId(p.id);
    setPName(p.name);
    setPModel(p.model);
    setPPrompt(p.system_prompt ?? '');
    setPTemp(p.temperature != null ? String(p.temperature) : '');
    setPMax(p.max_tokens != null ? String(p.max_tokens) : '');
    setPAvatar(p.avatar ?? null);
    setPEndpoint(p.endpoint ?? '');
    setPFallback(p.fallback_note ?? '');
    setPRemoteModels(null);
    setPMeta(parseModelMeta(p.model_meta));
    setMsg(null);
    setKitIds([]);
    getProfileLoadouts(p.id).then(setKitIds).catch(() => setKitIds([]));
  };
  const newProfile = () => {
    setPEditId(null);
    setPName('');
    setPModel(models[0] ?? '');
    setPPrompt('');
    setPTemp('0.7');
    setPMax('');
    setPAvatar(null);
    setPEndpoint('');
    setPFallback('');
    setPMeta(null);
    setMsg(null);
  };
  const onAvatarPick = (file: File | null) => {
    if (!file) return;
    if (file.size > 512 * 1024) {
      setMsg('Image is too large — pick one under 512 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPAvatar(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  };
  const saveProfile = async () => {
    if (!pName.trim() || !pModel.trim()) {
      setMsg('Name and model are required.');
      return;
    }
    try {
      const saved = await upsertProfile({
        id: pEditId ?? undefined,
        name: pName.trim(),
        model: pModel.trim(),
        system_prompt: pPrompt.trim() || undefined,
        temperature: pTemp.trim() ? Number(pTemp) : undefined,
        max_tokens: pMax.trim() ? Number(pMax) : undefined,
        avatar: pAvatar,
        endpoint: pEndpoint.trim() || undefined,
        fallback_note: pFallback.trim() || undefined,
      });
      setMsg('Saved.');
      setPEditId(saved.id);
      setPMeta(parseModelMeta(saved.model_meta) ?? pMeta);
      await loadProfiles();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const activateProfile = async (id: number) => {
    try {
      await setActiveProfile(id);
      setActiveProfileId(id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  // Toggle which personality is the Home "secretary" (null = use the active one).
  const designateSecretary = async (id: number | null) => {
    try {
      await setSecretaryProfile(id);
      setSecretaryProfileId(id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const [librarianProfileId, setLibrarianProfileId] = useState<number | null>(null);
  // Toggle which personality answers ask_atlas research (null = the tool runner / chat's own).
  const designateLibrarian = async (id: number | null) => {
    try {
      await setRoutingProfile('librarian', id);
      setLibrarianProfileId(id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  // Toggle which personality runs the agent tool loop (null = the chat's own).
  const designateToolRunner = async (id: number | null) => {
    try {
      await setRoutingProfile('tools', id);
      setToolProfileId(id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const removeProfile = async (id: number) => {
    try {
      await deleteProfile(id);
      if (pEditId === id) newProfile();
      await loadProfiles();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  /** Toggle one loadout on the selected agent's kit (persisted immediately). */
  const toggleKit = async (loadoutId: number) => {
    if (pEditId == null || kitBusy) return;
    const next = kitIds.includes(loadoutId) ? kitIds.filter((i) => i !== loadoutId) : [...kitIds, loadoutId];
    setKitBusy(true);
    try {
      await setProfileLoadouts(pEditId, next);
      setKitIds(next);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setKitBusy(false);
    }
  };

  if (notOwner) {
    return (
      <p className="text-sm text-subtext-0">
        Setting up assistants is done on the host. Ask the owner, or open Ganban on the host machine.
      </p>
    );
  }

  const ROLE_BADGES: { id: 'chat' | 'secretary' | 'tools' | 'librarian'; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'secretary', label: 'Daily assistant' },
    { id: 'tools', label: 'Agent runner' },
    { id: 'librarian', label: 'Research' },
  ];
  const rolesOf = (id: number) =>
    ROLE_BADGES.filter((r) =>
      (r.id === 'chat' && activeProfileId === id) ||
      (r.id === 'secretary' && secretaryProfileId === id) ||
      (r.id === 'tools' && toolProfileId === id) ||
      (r.id === 'librarian' && librarianProfileId === id)
    );

  return (
    <div className="h-full flex bg-base">
      {/* LEFT: personality list (one width with the other Assistant tabs) */}
      <div className={`${ASSISTANT_TREE_W} shrink-0 border-r border-surface-2 bg-surface-0 flex flex-col min-h-0`}>
        <div className="px-3 py-2.5 border-b border-surface-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-text">Agents</span>
          <button onClick={newProfile} className="g-btn g-btn-pri g-btn-sm">+ New</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {profiles.length === 0 && (
            <p className="px-2 py-2 text-sm text-subtext-0 italic">No agents yet — the chat uses the host's default model until you add one.</p>
          )}
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => editProfile(p)}
              className={`w-full text-left px-2.5 py-2 rounded-lg border flex items-center gap-2.5 ${
                pEditId === p.id ? 'border-gilt-a bg-gilt-b' : 'border-transparent hover:bg-surface-1'
              }`}
            >
              <ProfileAvatar avatar={p.avatar} name={p.name} size={32} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-text truncate">{p.name}</div>
                <div className="text-[11px] text-subtext-0 truncate font-mono">{p.model}</div>
                {rolesOf(p.id).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {rolesOf(p.id).map((r) => (
                      <span key={r.id} className="text-[10px] px-1 py-0.5 rounded bg-primary/15 text-primary">{r.label}</span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT: editor + role assignment for the selected personality */}
      <div className="flex-1 min-w-0 overflow-y-auto p-5">
        <div className="max-w-2xl space-y-4">
      <p className="text-xs text-subtext-0">
        An agent is a personality (model + system prompt + parameters) plus its <span className="text-text">kit</span> — the loadouts that
        decide which tools it may even propose. Assign it jobs below: <span className="text-text">Chat</span> answers
        in conversations, <span className="text-text">Daily assistant</span> powers the Home box + rundown, <span className="text-text">Agent runner</span> runs
        the tool loop (pick your strongest tool-capable model), <span className="text-text">Research</span> answers ask_atlas (ideally a strong remote model).
      </p>

      {/* Breakdown + stats — the selected personality at a glance */}
      {pEditId != null && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <ProfileAvatar avatar={pAvatar} name={pName || 'A'} size={56} />
            <div className="min-w-0">
              <div className="text-lg font-semibold text-text truncate">{pName || 'Untitled'}</div>
              <div className="text-xs text-subtext-0 font-mono truncate">{pModel || 'no model'}</div>
            </div>
          </div>
          <div className="g-card p-4 space-y-3">
            <div>
              <div className="g-flbl mb-1.5">Model breakdown</div>
              {pMeta ? <ModelCard meta={pMeta} /> : <p className="text-xs text-subtext-0">No model card — the engine is offline or this model isn't pulled yet.</p>}
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><div className="text-[11px] text-subtext-0">Temperature</div><div className="text-text">{pTemp || '—'}</div></div>
              <div><div className="text-[11px] text-subtext-0">Max tokens</div><div className="text-text">{pMax || 'default'}</div></div>
              <div><div className="text-[11px] text-subtext-0">Engine</div><div className="text-text truncate" title={pEndpoint || 'this host'}>{pEndpoint ? 'remote' : 'local'}</div></div>
            </div>
          </div>
        </div>
      )}

      {/* Role assignment — replaces the per-row button clutter */}
      {pEditId != null && (
        <div className="g-card p-4 space-y-2">
          <div className="g-flbl">Roles</div>
          <p className="text-[11px] text-subtext-0">Which jobs this personality handles (one personality per role).</p>
          <div className="flex flex-wrap gap-2">
            <RoleToggle on={activeProfileId === pEditId} onClick={() => activateProfile(pEditId)} label="Chat" hint="Answers in chats. There's always exactly one." />
            <RoleToggle on={secretaryProfileId === pEditId} onClick={() => designateSecretary(secretaryProfileId === pEditId ? null : pEditId)} label="Daily assistant" hint="Powers the Home daily-assistant box and grounds your rundown." />
            <RoleToggle on={toolProfileId === pEditId} onClick={() => designateToolRunner(toolProfileId === pEditId ? null : pEditId)} label="Agent runner" hint="Runs the agent tool loop when Tools mode is on — pick your strongest tool-capable model; the chat personality still writes the answer." />
            <RoleToggle on={librarianProfileId === pEditId} onClick={() => designateLibrarian(librarianProfileId === pEditId ? null : pEditId)} label="Research" hint="Answers ask_atlas research — ideally a strong profile with a remote endpoint; replies with cited digests from Atlas." />
          </div>
        </div>
      )}

      {/* KIT — what this agent carries. Loadouts are the ONE capability seam:
          each grants tools + a prompt fragment; the agent's effective toolset
          is the union of what's toggled on here (∩ what the run's protocol
          declares — a protocol can narrow, never widen). */}
      {pEditId != null && (
        <div className="g-card p-4 space-y-2">
          <div className="g-flbl">Kit — loadouts</div>
          <p className="text-[11px] text-subtext-0">
            What this agent carries into a run. Each loadout grants tools and a briefing fragment; toggling here changes what the agent
            can even <em>propose</em> (writes still cross the approval gate). Create and edit loadouts in Settings › Loadouts.
          </p>
          {loadouts.length === 0 ? (
            <p className="text-xs text-subtext-0 italic">No loadouts on this host yet — the agent runs with the default toolset.</p>
          ) : (
            <div className="space-y-1.5">
              {loadouts.map((l) => {
                const on = kitIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => toggleKit(l.id)}
                    disabled={kitBusy}
                    className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors disabled:opacity-60 ${
                      on ? 'border-gilt-a bg-gilt-b' : 'border-surface-2 hover:bg-surface-2'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold ${on ? 'text-primary' : 'text-text'}`}>{on ? '✓ ' : ''}{l.name}</span>
                      {l.description && <span className="text-[11px] text-subtext-0 truncate">{l.description}</span>}
                    </div>
                    {l.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {l.tools.map((t) => (
                          <span key={t} className={`g-tag min-h-[18px] px-1.5 text-[10px] font-mono ${on ? 'g-on' : ''}`}>{t}</span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {(() => {
            const effective = [...new Set(loadouts.filter((l) => kitIds.includes(l.id)).flatMap((l) => l.tools))];
            return effective.length > 0 ? (
              <div className="pt-1 border-t border-surface-2">
                <div className="text-[11px] text-subtext-0 mb-1">Granted tools ({effective.length}) — a run's protocol can narrow this, never widen it:</div>
                <div className="flex flex-wrap gap-1">
                  {effective.map((t) => (
                    <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-primary/15 text-primary font-mono">{t}</span>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {(() => {
            const used = protocols.filter((pr) => pr.versions.some((v) => v.version === pr.active_version && v.engine?.profile_id === pEditId));
            return used.length > 0 ? (
              <div className="pt-1 border-t border-surface-2 text-[11px] text-subtext-0">
                Pinned by protocol{used.length > 1 ? 's' : ''}: {used.map((u) => u.name || u.slug).join(', ')}
              </div>
            ) : null;
          })()}
        </div>
      )}

      {/* Editor */}
      <div className="g-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium text-text">{pEditId ? 'Edit personality' : 'New personality'}</div>
          {pEditId && <button onClick={() => removeProfile(pEditId)} className="g-btn g-btn-danger g-btn-sm">Delete</button>}
        </div>
        <div className="flex items-center gap-3">
          <ProfileAvatar avatar={pAvatar} name={pName || 'A'} size={56} />
          <div className="flex gap-2">
            <label className="px-2.5 py-1.5 text-xs bg-surface-2 text-text rounded-lg cursor-pointer hover:bg-overlay-0">
              {pAvatar ? 'Change picture' : 'Add picture'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  onAvatarPick(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </label>
            {pAvatar && <button onClick={() => setPAvatar(null)} className="g-btn g-btn-danger g-btn-sm">Remove</button>}
          </div>
        </div>
        <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Name (e.g. Project assistant)" className={input} />
        {models.length > 0 ? (
          <select value={pModel} onChange={(e) => setPModel(e.target.value)} className={input}>
            <option value="">Select a model…</option>
            {(pEndpoint.trim() && pRemoteModels ? pRemoteModels : models).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {pModel && !(pEndpoint.trim() && pRemoteModels ? pRemoteModels : models).includes(pModel) && <option value={pModel}>{pModel} (saved)</option>}
          </select>
        ) : (
          <input value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder="Model (e.g. llama3.1:8b)" className={input} />
        )}
        {pEditId == null && pMeta && (
          <div className="space-y-1">
            <div className="text-[11px] text-subtext-0">Model card</div>
            <ModelCard meta={pMeta} />
          </div>
        )}
        <textarea value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} rows={4} placeholder="System prompt / personality (how it should behave)…" className={input} />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-subtext-0 mb-1">Temperature</label>
            <input value={pTemp} onChange={(e) => setPTemp(e.target.value)} placeholder="0.7" className={input} />
          </div>
          <div>
            <label className="block text-xs text-subtext-0 mb-1">Max tokens (blank = default)</label>
            <input value={pMax} onChange={(e) => setPMax(e.target.value)} placeholder="—" className={input} />
          </div>
        </div>
        <div className="space-y-1 border-t border-surface-2 pt-2">
          <label className="block text-xs text-subtext-0">
            Remote engine (optional) — an Ollama URL on another machine, e.g. <span className="font-mono">http://100.x.y.z:11434</span>.
            Reached over the tailnet, never supervised; blank = this host's engine.
          </label>
          <div className="flex gap-2">
            <input value={pEndpoint} onChange={(e) => { setPEndpoint(e.target.value); setPRemoteModels(null); }} placeholder="http://… (blank = local)" className={input} />
            <button
              onClick={() => {
                setMsg('Testing…');
                listOllamaModels(pEndpoint)
                  .then((ms) => { setPRemoteModels(ms); setMsg(`Reachable ✓ — ${ms.length} model${ms.length === 1 ? '' : 's'}; pick one above.`); })
                  .catch((e) => { setPRemoteModels(null); setMsg(e instanceof Error ? e.message : String(e)); });
              }}
              disabled={!pEndpoint.trim()}
              className="g-btn g-btn-ghost shrink-0"
            >
              Test
            </button>
          </div>
          {pEndpoint.trim() && (
            <input
              value={pFallback}
              onChange={(e) => setPFallback(e.target.value)}
              placeholder="What to say when it's unreachable (e.g. “the librarian's box is asleep — answering from the project corpus only”)"
              className={input}
            />
          )}
        </div>
        <div className="flex gap-2 items-center">
          <button onClick={saveProfile} disabled={!pName.trim() || !pModel.trim()} className="g-btn g-btn-pri">Save</button>
          {msg && <span className="text-sm text-subtext-1">{msg}</span>}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}
