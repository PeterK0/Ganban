import { useEffect, useMemo, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import {
  listLoadouts,
  createLoadout,
  updateLoadout,
  deleteLoadout,
  listProfiles,
  getProfileLoadouts,
  setProfileLoadouts,
  getToolCatalog,
  DaemonError,
  type Loadout,
  type ModelProfile,
  type ToolInfo,
} from '../lib/daemon';

const field = 'g-field g-field-sm';

/** A loadout being edited (existing row or a blank draft). */
type Draft = {
  id?: number;
  name: string;
  description: string;
  prompt_fragment: string;
  routing_profile_id: number | null;
  tools: Set<string>;
};

const blank = (): Draft => ({ name: '', description: '', prompt_fragment: '', routing_profile_id: null, tools: new Set() });
const toDraft = (l: Loadout): Draft => ({
  id: l.id,
  name: l.name,
  description: l.description,
  prompt_fragment: l.prompt_fragment ?? '',
  routing_profile_id: l.routing_profile_id ?? null,
  tools: new Set(l.tools),
});

/** Owner-only: define loadouts (tool/prompt/sub-model bundles) and assign them
 * to personalities — the "character sheet". A personality with no loadout keeps
 * the full toolset; with loadouts, it's scoped to their union. */
export default function LoadoutsPanel() {
  const [loadouts, setLoadouts] = useState<Loadout[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [assign, setAssign] = useState<Record<number, Set<number>>>({}); // profileId → loadoutIds
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [los, pr, cat] = await Promise.all([listLoadouts(), listProfiles(), getToolCatalog()]);
      setLoadouts(los);
      setProfiles(pr.profiles);
      setTools(cat.tools);
      const entries = await Promise.all(pr.profiles.map(async (p) => [p.id, new Set(await getProfileLoadouts(p.id))] as const));
      setAssign(Object.fromEntries(entries));
    } catch (e) {
      setError(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // De-duplicated, sorted tool names (a name can appear from >1 source).
  const toolByName = useMemo(() => {
    const m = new Map<string, ToolInfo>();
    for (const t of tools) if (!m.has(t.name)) m.set(t.name, t);
    return m;
  }, [tools]);
  const toolNames = useMemo(() => [...toolByName.keys()].sort(), [toolByName]);

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        prompt_fragment: draft.prompt_fragment.trim() || null,
        routing_profile_id: draft.routing_profile_id,
        tools: [...draft.tools],
      };
      if (draft.id) await updateLoadout(draft.id, payload);
      else await createLoadout(payload);
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: Loadout) => {
    if (!(await confirmDialog(`Delete the loadout “${l.name}”? It will be unassigned from every personality.`))) return;
    await deleteLoadout(l.id).catch(() => {});
    await load();
  };

  // Toggle loadout L on personality P: recompute P's set and persist it.
  const toggleAssign = async (profileId: number, loadoutId: number) => {
    const next = new Set(assign[profileId] ?? []);
    if (next.has(loadoutId)) next.delete(loadoutId);
    else next.add(loadoutId);
    setAssign((a) => ({ ...a, [profileId]: next }));
    await setProfileLoadouts(profileId, [...next]).catch(() => void load());
  };

  const toggleTool = (name: string) =>
    setDraft((d) => {
      if (!d) return d;
      const t = new Set(d.tools);
      if (t.has(name)) t.delete(name);
      else t.add(name);
      return { ...d, tools: t };
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-subtext-0">
          A loadout bundles tools + a prompt fragment + an optional sub-model, and is assigned to a personality. No loadout
          ⇒ the personality keeps every tool; with loadouts ⇒ it's scoped to their union.
        </p>
        {!draft && (
          <button onClick={() => setDraft(blank())} className="g-btn g-btn-pri g-btn-sm shrink-0">
            + New loadout
          </button>
        )}
      </div>

      {error && <p className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</p>}

      {/* Editor */}
      {draft && (
        <div className="g-card p-5 space-y-3">
          <div className="font-medium text-text">{draft.id ? 'Edit loadout' : 'New loadout'}</div>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name (e.g. Researcher)" className={field} />
          <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description (optional)" className={field} />
          <div>
            <label className="block text-xs text-subtext-0 mb-1">Prompt fragment (appended to the personality's system prompt)</label>
            <textarea value={draft.prompt_fragment} onChange={(e) => setDraft({ ...draft, prompt_fragment: e.target.value })} rows={2} placeholder="e.g. Always cite your sources." className={`${field} resize-none`} />
          </div>
          <div>
            <label className="block text-xs text-subtext-0 mb-1">Tool-runner sub-model (optional — falls back to the global tool tier)</label>
            <select
              value={draft.routing_profile_id ?? ''}
              onChange={(e) => setDraft({ ...draft, routing_profile_id: e.target.value ? Number(e.target.value) : null })}
              className={field}
            >
              <option value="">— global tool tier —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.model}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-subtext-0 mb-1">Tools ({draft.tools.size} selected)</label>
            <div className="max-h-56 overflow-y-auto border border-surface-2 rounded-lg p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
              {toolNames.map((n) => {
                const t = toolByName.get(n)!;
                return (
                  <label key={n} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface-2 cursor-pointer">
                    <input type="checkbox" checked={draft.tools.has(n)} onChange={() => toggleTool(n)} />
                    <span className="font-mono text-xs text-text truncate">{n}</span>
                    <span className={`ml-auto shrink-0 text-[9px] px-1 rounded-full ${t.class === 'write' ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'}`}>{t.class}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(null)} disabled={busy} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
            <button onClick={save} disabled={busy || !draft.name.trim()} className="g-btn g-btn-pri g-btn-sm">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loadouts.length === 0 && !draft ? (
        <p className="text-sm text-subtext-0 italic">No loadouts yet.</p>
      ) : (
        <div className="space-y-2">
          {loadouts.map((l) => (
            <div key={l.id} className="g-card p-4 space-y-2">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text">{l.name}</div>
                  {l.description && <p className="text-xs text-subtext-0">{l.description}</p>}
                  <div className="text-[11px] text-subtext-0 mt-1">
                    {l.tools.length} tool{l.tools.length === 1 ? '' : 's'}
                    {l.routing_profile_id != null && ` · sub-model: ${profiles.find((p) => p.id === l.routing_profile_id)?.name ?? l.routing_profile_id}`}
                    {l.prompt_fragment ? ' · has prompt' : ''}
                  </div>
                </div>
                <button onClick={() => setDraft(toDraft(l))} className="shrink-0 text-xs text-primary hover:text-primary-hover">Edit</button>
                <button onClick={() => remove(l)} className="shrink-0 text-xs text-error/80 hover:text-error">Delete</button>
              </div>
              {profiles.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-surface-2">
                  <span className="text-[11px] text-subtext-0 mr-1">Carried by:</span>
                  {profiles.map((p) => {
                    const on = assign[p.id]?.has(l.id) ?? false;
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggleAssign(p.id, l.id)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${on ? 'bg-primary/20 text-primary border-primary/40' : 'bg-surface-0 text-subtext-0 border-surface-2 hover:text-text'}`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
