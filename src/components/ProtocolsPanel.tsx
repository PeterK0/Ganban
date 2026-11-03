// Protocols (Epoch R): the artifact surface — list + lifecycle + the R.2
// dry-run harness, the schema-generated BUILDER (door 2: a form, YAML never
// appears) and the GALLERY (door 1: pre-built cards whose typed `inputs`
// declarations ARE the install wizard). All saves go through the same
// validated POST — there is no path where a hand-shaped protocol skips
// validation.
import { useEffect, useMemo, useState } from 'react';
import DemonstratePanel from './DemonstratePanel';
import { hasHostControls } from '../lib/shell';
import {
  listProtocols,
  dryRunProtocol,
  activateProtocol,
  deactivateProtocol,
  createProtocol,
  getProtocolGallery,
  getToolCatalog,
  type ProtocolInfo,
  type ProtocolVersionInfo,
  type GalleryEntry,
  type ModelProfile,
} from '../lib/daemon';
import { isTauri } from '../lib/daemon';

const SYSTEM_CLASSES = ['tools', 'librarian', 'structure_toc'];

interface BuilderDraft {
  name: string;
  slug: string;
  task_class: string;
  trigger: 'manual' | 'routine' | 'rule';
  runner: 'ollama' | 'pi';
  profile_id: number | null;
  model: string;
  tools: Set<string>;
  per_run_cents: string;
  period_cents: string;
  period: 'day' | 'week' | 'month';
  on_exceeded: 'downgrade' | 'refuse';
  wall_clock_s: string;
  max_rounds: string;
  briefing: string;
  activate: boolean;
}

const blankDraft = (): BuilderDraft => ({
  name: '', slug: '', task_class: 'user.', trigger: 'manual', runner: 'ollama',
  profile_id: null, model: '', tools: new Set(), per_run_cents: '', period_cents: '',
  period: 'month', on_exceeded: 'downgrade', wall_clock_s: '', max_rounds: '',
  briefing: '', activate: true,
});

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export default function ProtocolsPanel({ profiles }: { profiles: ModelProfile[] }) {
  const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [view, setView] = useState<'list' | 'builder' | 'gallery' | 'demonstrate'>('list');
  const [draft, setDraft] = useState<BuilderDraft>(blankDraft());
  const [builderMsg, setBuilderMsg] = useState<string | null>(null);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [gallery, setGallery] = useState<GalleryEntry[]>([]);
  const [installing, setInstalling] = useState<GalleryEntry | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const reload = async () => {
    try { setProtocols((await listProtocols()).protocols); } catch { setProtocols([]); }
  };
  useEffect(() => { void reload(); }, []);

  const openBuilder = async () => {
    setDraft(blankDraft());
    setBuilderMsg(null);
    setView('builder');
    try {
      const cat = await getToolCatalog();
      setToolNames([...new Set(cat.tools.map((t) => t.name))].sort());
    } catch { setToolNames([]); }
  };
  const openGallery = async () => {
    setView('gallery');
    setInstalling(null);
    try { setGallery((await getProtocolGallery()).gallery); } catch { setGallery([]); }
  };

  const engineLabel = (v: ProtocolVersionInfo | null) => {
    if (!v?.engine) return '—';
    if (v.engine.runner === 'pi') return `pi · ${v.engine.model || 'default model'}`;
    const prof = v.engine.profile_id != null ? profiles.find((p) => p.id === v.engine!.profile_id) : null;
    return `ollama · ${prof ? `${prof.name} (${prof.model})` : 'active profile'}`;
  };
  const statusChip = (s: string) =>
    s === 'approved' ? 'bg-success/15 text-success' :
    s === 'dryrun' ? 'g-on' :
    s === 'retired' ? 'bg-surface-2 text-subtext-0' : 'bg-warning/15 text-warning';

  const saveBuilder = async () => {
    setBuilderMsg(null);
    try {
      const frontmatter: Record<string, unknown> = {
        protocol: 1,
        task_class: draft.task_class.trim(),
        trigger: { kind: draft.trigger },
        engine: {
          runner: draft.runner,
          profile_id: draft.runner === 'ollama' ? draft.profile_id : null,
          model: draft.runner === 'pi' ? (draft.model.trim() || null) : null,
        },
      };
      if (draft.tools.size > 0) frontmatter.tools = [...draft.tools].sort();
      const budget: Record<string, unknown> = {};
      if (draft.per_run_cents.trim()) budget.per_run_cents = Number(draft.per_run_cents);
      if (draft.period_cents.trim()) { budget.period_cents = Number(draft.period_cents); budget.period = draft.period; budget.on_exceeded = draft.on_exceeded; }
      if (Object.keys(budget).length > 0) frontmatter.budget = budget;
      const limits: Record<string, unknown> = {};
      if (draft.wall_clock_s.trim()) limits.wall_clock_s = Number(draft.wall_clock_s);
      if (draft.max_rounds.trim()) limits.max_rounds = Number(draft.max_rounds);
      if (Object.keys(limits).length > 0) frontmatter.limits = limits;

      const slug = draft.slug.trim() || slugify(draft.name);
      const r = await createProtocol({
        slug,
        name: draft.name.trim() || slug,
        frontmatter,
        briefing: draft.briefing,
        // Non-manual triggers cannot activate without a dry-run — save as draft.
        activate: draft.activate && draft.trigger === 'manual',
      });
      setBuilderMsg(`Saved ${r.slug} v${r.version} ✓${draft.trigger !== 'manual' ? ' (draft — a routine/rule protocol needs a passed dry-run before activation)' : ''}`);
      await reload();
      setView('list');
    } catch (e) {
      setBuilderMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const installFromGallery = async (entry: GalleryEntry) => {
    try {
      // The typed inputs become frontmatter values; `profile` answers land in
      // engine.profile_id. Same validated POST as the builder.
      const fm = JSON.parse(JSON.stringify(entry.frontmatter)) as Record<string, unknown> & { engine?: Record<string, unknown>; inputs?: unknown };
      for (const input of entry.frontmatter.inputs ?? []) {
        const raw = answers[input.name] ?? '';
        if (input.required && !raw) throw new Error(`"${input.label ?? input.name}" is required.`);
        if (input.type === 'profile' && raw) {
          fm.engine = { ...(fm.engine as Record<string, unknown>), profile_id: Number(raw) };
        }
      }
      delete fm.inputs; // answered — the installed version carries the values
      const r = await createProtocol({ slug: entry.slug, name: entry.name, frontmatter: fm, briefing: entry.briefing, activate: true });
      setMsg((m) => ({ ...m, [entry.slug]: `Installed v${r.version} ✓ — run a dry-run below to see it work before relying on it.` }));
      setInstalling(null);
      setAnswers({});
      await reload();
      setView('list');
      setExpanded(entry.slug);
    } catch (e) {
      setMsg((m) => ({ ...m, [entry.slug]: e instanceof Error ? e.message : String(e) }));
    }
  };

  const input = 'g-field g-field-sm';
  const label = 'text-xs text-subtext-0';

  const grouped = useMemo(() => {
    const system = protocols.filter((p) => SYSTEM_CLASSES.includes(p.task_class));
    const user = protocols.filter((p) => !SYSTEM_CLASSES.includes(p.task_class));
    return { system, user };
  }, [protocols]);

  return (
    <div className="g-plain p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text">Protocols</span>
        <span className="text-xs text-subtext-0">versions are immutable — every save creates one</span>
        <span className="ml-auto" />
        <button onClick={() => (view === 'gallery' ? setView('list') : void openGallery())}
          className={`g-chip ${view === 'gallery' ? 'g-on' : ''}`}>Gallery</button>
        {isTauri() && (
          <button onClick={() => setView(view === 'demonstrate' ? 'list' : 'demonstrate')}
            title="Author a protocol by showing: record a browsing session, replay it attended, draft it into the gate."
            className={`g-chip ${view === 'demonstrate' ? 'g-on' : ''}`}>🎬 Demonstrate</button>
        )}
        <button onClick={() => (view === 'builder' ? setView('list') : void openBuilder())}
          className={`g-chip ${view === 'builder' ? 'g-on' : ''}`}>+ New</button>
      </div>

      {view === 'demonstrate' && (
        <div className="g-card p-4">
          {/* The recorder drives a native webview window — desktop only. */}
          {hasHostControls() && <DemonstratePanel onDraftCreated={() => void reload()} />}
        </div>
      )}

      {view === 'builder' && (
        <div className="g-card p-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className={label}>Name</div>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, slug: draft.slug || '' })} placeholder="Summarize new PDFs" className={`${input} w-full`} />
            </div>
            <div className="space-y-1">
              <div className={label}>Slug (blank = from name)</div>
              <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder={slugify(draft.name) || 'my-protocol'} className={`${input} w-full font-mono`} />
            </div>
            <div className="space-y-1">
              <div className={label}>Task class (system, or user.*)</div>
              <input list="protocol-task-classes" value={draft.task_class} onChange={(e) => setDraft({ ...draft, task_class: e.target.value })} className={`${input} w-full font-mono`} />
              <datalist id="protocol-task-classes">
                {SYSTEM_CLASSES.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div className="space-y-1">
              <div className={label}>Trigger</div>
              <select value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as BuilderDraft['trigger'] })} className={`${input} w-full`}>
                <option value="manual">manual — a human presses the button</option>
                <option value="routine">routine — scheduled (draft until dry-run passes)</option>
                <option value="rule">rule — event-driven (draft until dry-run passes)</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="g-seg">
              <button onClick={() => setDraft({ ...draft, runner: 'ollama' })} className={`g-chip ${draft.runner === 'ollama' ? 'g-on' : ''}`}>Ollama (free)</button>
              <button onClick={() => setDraft({ ...draft, runner: 'pi' })} className={`g-chip ${draft.runner === 'pi' ? 'g-on' : ''}`}>pi (paid)</button>
            </div>
            {draft.runner === 'ollama' ? (
              <select value={draft.profile_id ?? ''} onChange={(e) => setDraft({ ...draft, profile_id: e.target.value ? Number(e.target.value) : null })} className={`${input} flex-1`}>
                <option value="">Active profile (default)</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}
              </select>
            ) : (
              <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="model pattern, e.g. claude-haiku-4-5 (blank = pi default)" className={`${input} flex-1`} />
            )}
          </div>
          {toolNames.length > 0 && (
            <div className="space-y-1">
              <div className={label}>Tool allowlist (unticked = the class default; ticking any restricts to the ticked set)</div>
              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                {toolNames.map((t) => (
                  <button key={t} onClick={() => setDraft((d) => { const s = new Set(d.tools); if (s.has(t)) { s.delete(t); } else { s.add(t); } return { ...d, tools: s }; })}
                    className={`px-1.5 py-0.5 text-xs rounded font-mono ${draft.tools.has(t) ? 'bg-primary/15 text-primary border border-primary/30' : 'bg-surface-0 text-subtext-0 border border-surface-2'}`}>{t}</button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <div className={label}>Budget / run (cents)</div>
              <input value={draft.per_run_cents} onChange={(e) => setDraft({ ...draft, per_run_cents: e.target.value })} placeholder="e.g. 10" className={`${input} w-full`} />
            </div>
            <div className="space-y-1">
              <div className={label}>Budget / period (cents)</div>
              <div className="flex gap-1">
                <input value={draft.period_cents} onChange={(e) => setDraft({ ...draft, period_cents: e.target.value })} placeholder="500" className={`${input} w-full min-w-0`} />
                <select value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as BuilderDraft['period'] })} className={`${input} !w-auto`}>
                  <option value="day">day</option><option value="week">week</option><option value="month">month</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <div className={label}>When over budget</div>
              <select value={draft.on_exceeded} onChange={(e) => setDraft({ ...draft, on_exceeded: e.target.value as BuilderDraft['on_exceeded'] })} className={`${input} w-full`}>
                <option value="downgrade">downgrade to free (recorded)</option>
                <option value="refuse">refuse to run</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className={label}>Wall clock limit (seconds, 1–3600)</div>
              <input value={draft.wall_clock_s} onChange={(e) => setDraft({ ...draft, wall_clock_s: e.target.value })} placeholder="120" className={`${input} w-full`} />
            </div>
            <div className="space-y-1">
              <div className={label}>Max tool rounds (1–64)</div>
              <input value={draft.max_rounds} onChange={(e) => setDraft({ ...draft, max_rounds: e.target.value })} placeholder="8" className={`${input} w-full`} />
            </div>
          </div>
          <div className="space-y-1">
            <div className={label}>Briefing — what the model is told (advisory; the settings above are what's enforced)</div>
            <textarea value={draft.briefing} onChange={(e) => setDraft({ ...draft, briefing: e.target.value })} rows={4} placeholder="The procedure, in prose…" className={`${input} w-full resize-y`} />
          </div>
          <div className="flex items-center gap-2">
            {draft.trigger === 'manual' && (
              <label className="flex items-center gap-1.5 text-xs text-subtext-1">
                <input type="checkbox" checked={draft.activate} onChange={(e) => setDraft({ ...draft, activate: e.target.checked })} />
                Activate on save
              </label>
            )}
            <span className="ml-auto" />
            <button onClick={() => setView('list')} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
            <button onClick={() => void saveBuilder()} className="g-btn g-btn-pri g-btn-sm">Save version</button>
          </div>
          {builderMsg && <div className="text-xs text-subtext-1 break-words">{builderMsg}</div>}
        </div>
      )}

      {view === 'gallery' && (
        <div className="space-y-2">
          {gallery.length === 0 && <p className="text-xs text-subtext-0 italic">Gallery unavailable.</p>}
          {gallery.map((g) => (
            <div key={g.slug} className="g-card p-4 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{g.name}</span>
                <span className="text-xs text-subtext-0 font-mono">{g.slug}</span>
                <span className="ml-auto" />
                {installing?.slug === g.slug ? (
                  <button onClick={() => setInstalling(null)} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
                ) : (
                  <button onClick={() => { setInstalling(g); setAnswers({}); }} className="g-btn g-btn-pri g-btn-sm">Install</button>
                )}
              </div>
              <p className="text-xs text-subtext-0">{g.description}</p>
              {installing?.slug === g.slug && (
                <div className="space-y-1.5 pt-1">
                  {(g.frontmatter.inputs ?? []).map((inp) => (
                    <div key={inp.name} className="space-y-0.5">
                      <div className={label}>{inp.label ?? inp.name}{inp.required ? ' *' : ''}</div>
                      {inp.type === 'profile' ? (
                        <select value={answers[inp.name] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [inp.name]: e.target.value }))} className={`${input} w-full`}>
                          <option value="">{inp.required ? 'Pick a personality…' : 'Active profile (default)'}</option>
                          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}
                        </select>
                      ) : (
                        <input value={answers[inp.name] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [inp.name]: e.target.value }))} className={`${input} w-full`} />
                      )}
                    </div>
                  ))}
                  <button onClick={() => void installFromGallery(g)} className="g-btn g-btn-pri g-btn-sm">Install & activate</button>
                </div>
              )}
              {msg[g.slug] && <div className="text-xs text-subtext-1">{msg[g.slug]}</div>}
            </div>
          ))}
        </div>
      )}

      {view === 'list' && (protocols.length === 0 ? (
        <p className="text-xs text-subtext-0 italic">No protocols yet — install one from the Gallery, build one with + New, or save a task routing above.</p>
      ) : (
        [...grouped.system, ...grouped.user].map((p) => {
          const active = p.versions.find((v) => v.version === p.active_version) ?? null;
          return (
            <div key={p.slug} className="g-plain p-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <button onClick={() => setExpanded(expanded === p.slug ? null : p.slug)} className="text-sm text-text font-medium hover:text-primary">
                  {expanded === p.slug ? '▾' : '▸'} {p.name}
                </button>
                <span className="text-xs text-subtext-0 font-mono">{p.task_class}</span>
                {p.active_version != null ? (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-success/15 text-success">v{p.active_version} active</span>
                ) : (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-2 text-subtext-0">inactive</span>
                )}
                <span className="text-xs text-subtext-1 ml-auto">{engineLabel(active)}</span>
                {p.active_version != null && (
                  <button onClick={async () => {
                    try { await deactivateProtocol(p.slug); await reload(); }
                    catch (e) { setMsg((m) => ({ ...m, [p.slug]: e instanceof Error ? e.message : String(e) })); }
                  }} className="g-btn g-btn-ghost g-btn-sm shrink-0">Deactivate</button>
                )}
              </div>
              {expanded === p.slug && (
                <div className="space-y-1">
                  {p.versions.map((v) => (
                    <div key={v.version} className="flex items-center gap-2 text-xs g-inset px-2 py-1">
                      <span className="font-mono text-text">v{v.version}</span>
                      <span className={`px-1.5 py-0.5 rounded ${statusChip(v.status)}`}>{v.status}</span>
                      {v.trigger && <span className="text-subtext-0">{v.trigger}</span>}
                      <span className="text-subtext-1">{engineLabel(v)}</span>
                      <span className="text-subtext-0 font-mono" title={v.content_hash}>{v.content_hash.replace('sha256:', '').slice(0, 8)}</span>
                      <span className="ml-auto" />
                      <button
                        disabled={busy === `${p.slug}:${v.version}`}
                        onClick={async () => {
                          setBusy(`${p.slug}:${v.version}`);
                          setMsg((m) => ({ ...m, [p.slug]: `Dry-running v${v.version}… (a real model call — can take a minute)` }));
                          try {
                            const r = await dryRunProtocol(p.slug, v.version);
                            const cost = r.prompt_tokens != null ? ` · ${r.prompt_tokens}+${r.completion_tokens ?? 0} tok · ${((r.duration_ms ?? 0) / 1000).toFixed(1)}s · ${r.model ?? ''}` : '';
                            setMsg((m) => ({ ...m, [p.slug]: `${r.passed ? '✓ PASSED' : '✗ FAILED'}: ${r.note}${cost}` }));
                            await reload();
                          } catch (e) {
                            setMsg((m) => ({ ...m, [p.slug]: e instanceof Error ? e.message : String(e) }));
                          } finally { setBusy(null); }
                        }}
                        className="g-btn g-btn-ghost g-btn-sm shrink-0"
                      >{busy === `${p.slug}:${v.version}` ? 'Running…' : 'Dry-run'}</button>
                      {v.version !== p.active_version && v.status !== 'retired' && (
                        <button onClick={async () => {
                          try {
                            await activateProtocol(p.slug, v.version);
                            await reload();
                            setMsg((m) => ({ ...m, [p.slug]: `v${v.version} activated ✓` }));
                          } catch (e) { setMsg((m) => ({ ...m, [p.slug]: e instanceof Error ? e.message : String(e) })); }
                        }} className="g-btn g-btn-pri g-btn-sm shrink-0">Activate</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg[p.slug] && <div className="text-xs text-subtext-1 break-words">{msg[p.slug]}</div>}
            </div>
          );
        })
      ))}
    </div>
  );
}
