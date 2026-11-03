import { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import AtlasDocReader from './AtlasDocReader';
import { KnowledgeEngineEmpty, useKnowledgeEngine } from './KnowledgeEngine';
import {
  atlasDocument,
  atlasFacets,
  atlasManifest,
  atlasReport,
  atlasSearch,
  type AtlasManifest,
  listAtlasCollections,
  createAtlasCollection,
  setAtlasVisibility,
  deleteAtlasCollection,
  reingestAtlasCollection,
  hasDaemon,
  DaemonError,
  type AtlasCollection,
  type RagHit,
} from '../lib/daemon';

/**
 * Atlas browse (Epoch I): shared knowledge collections that no project owns —
 * facet tree on the left, hybrid search + document view on the right. The same
 * panel serves the top-level Atlas page (`manage` adds the owner's registry
 * controls) and the per-project Atlas tab (`fixedFilters` applies the
 * project's saved lens). The corpus convention that makes browse behave like
 * lookup: one entity = one markdown document.
 */
export default function AtlasPanel({
  manage = false,
  initialFilters,
  initialSlug,
  onLensChange,
}: {
  manage?: boolean;
  initialFilters?: Record<string, string>;
  initialSlug?: string;
  /** Fires when the slug/filters change, so the project tab can offer "save as this project's lens". */
  onLensChange?: (slug: string | null, filters: Record<string, string>) => void;
}) {
  const [collections, setCollections] = useState<AtlasCollection[]>([]);
  const [slug, setSlug] = useState<string | null>(initialSlug ?? null);
  const [facets, setFacets] = useState<Record<string, Record<string, number>>>({});
  const [filters, setFilters] = useState<Record<string, string>>(initialFilters ?? {});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [doc, setDoc] = useState<{ source: string; content: string } | null>(null);
  const [view, setView] = useState<'search' | 'contents'>('search');
  const [manifest, setManifest] = useState<AtlasManifest | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // false = the host has no knowledge engine: a calm "not set up" instead of every call's error.
  const engine = useKnowledgeEngine();

  // Owner registry form
  const [nSlug, setNSlug] = useState('');
  const [nName, setNName] = useState('');
  const [nDir, setNDir] = useState('');
  const [nOwnerOnly, setNOwnerOnly] = useState(false);

  const loadCollections = useCallback(async () => {
    try {
      const cols = await listAtlasCollections();
      setCollections(cols);
      setSlug((cur) => cur ?? cols[0]?.slug ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (hasDaemon()) void loadCollections();
  }, [loadCollections]);

  const loadFacets = useCallback(async (s: string) => {
    try {
      setFacets(await atlasFacets(s));
      setError(null);
    } catch (e) {
      setFacets({});
      setError(
        e instanceof DaemonError && e.status === 404
          ? e.message
          : e instanceof Error ? e.message : String(e),
      );
    }
  }, []);

  useEffect(() => {
    if (slug && hasDaemon() && engine !== false) {
      setHits(null);
      setDoc(null);
      setManifest(null);
      setReport(null);
      void loadFacets(slug);
    }
  }, [slug, loadFacets, engine]);

  // Contents view: what this collection is actually being fed.
  useEffect(() => {
    if (view !== 'contents' || !slug || engine === false) return;
    atlasManifest(slug)
      .then((m) => setManifest(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [view, slug, engine]);

  const announce = (s: string | null, f: Record<string, string>) => onLensChange?.(s, f);

  const runSearch = async (q: string, f: Record<string, string>) => {
    if (!slug || !q.trim()) return;
    setSearching(true);
    setDoc(null);
    try {
      setHits(await atlasSearch(slug, q.trim(), 10, Object.keys(f).length ? f : undefined));
      setError(null);
    } catch (e) {
      setHits(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const toggleFilter = (role: string, value: string) => {
    const next = { ...filters };
    if (next[role] === value) delete next[role];
    else next[role] = value;
    setFilters(next);
    announce(slug, next);
    const q = query.trim() || value;
    if (!query.trim()) setQuery(q);
    void runSearch(q, next);
  };

  const openDoc = async (source: string) => {
    if (!slug) return;
    try {
      setDoc(await atlasDocument(slug, source));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addCollection = async () => {
    try {
      const r = await createAtlasCollection(nSlug.trim(), nName.trim(), nDir.trim(), nOwnerOnly);
      setNotice(r.job_id ? `Registered — ingest started (job ${r.job_id}).` : 'Registered. Re-ingest once the knowledge engine is set up (Settings → AI Engines).');
      setNSlug('');
      setNName('');
      setNDir('');
      setNOwnerOnly(false);
      await loadCollections();
    } catch (e) {
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!hasDaemon()) {
    return <p className="p-5 text-sm text-subtext-0">Atlas lives on the host — connect to a daemon to browse it.</p>;
  }
  if (engine === false) {
    return (
      <KnowledgeEngineEmpty icon="map" title="Atlas isn't set up">
        <p>
          Atlas is a searchable library of your documents, shared across projects, with AI overviews the assistant
          can look things up in.
        </p>
        <p>
          It runs on the knowledge engine (ragrat), an optional part of Ganban that isn't set up on this host.
          Everything else works without it.
        </p>
      </KnowledgeEngineEmpty>
    );
  }

  const roles = Object.entries(facets).filter(([, values]) => Object.keys(values).length > 0);
  const current = collections.find((c) => c.slug === slug) ?? null;

  return (
    <div className="h-full min-h-0 flex flex-col sm:flex-row bg-mantle text-text">
      {/* LEFT: collections + facet tree (stacks on phone widths) */}
      <div className="w-full max-h-[45%] sm:max-h-none sm:w-72 shrink-0 border-b sm:border-b-0 sm:border-r border-gilt-b overflow-y-auto p-4 space-y-4 bg-crust">
        <select
          value={slug ?? ''}
          onChange={(e) => {
            const s = e.target.value || null;
            setSlug(s);
            setFilters({});
            announce(s, {});
          }}
          className="g-field g-field-sm w-full"
        >
          {collections.length === 0 && <option value="">No collections yet</option>}
          {collections.map((c) => (
            <option key={c.id} value={c.slug}>{c.owner_only ? '🔒 ' : ''}{c.name}</option>
          ))}
        </select>

        {roles.length === 0 && slug && (
          <p className="text-sm text-subtext-0 italic">No facets yet — this collection hasn't finished ingesting.</p>
        )}
        {roles.map(([role, values]) => (
          <div key={role}>
            <div className="g-deco text-[11px] font-semibold tracking-[0.22em] text-[color:var(--g-mut)] mb-1.5 px-2">{role}</div>
            <div className="space-y-0.5">
              {Object.entries(values)
                .sort((a, b) => b[1] - a[1])
                .map(([value, count]) => (
                  <button
                    key={value}
                    onClick={() => toggleFilter(role, value)}
                    className={`w-full flex items-center justify-between min-h-8 px-2 rounded text-sm ${
                      filters[role] === value ? 'g-sel text-text' : 'text-text hover:bg-surface-0'
                    }`}
                  >
                    <span className="truncate">{value}</span>
                    <span className="text-xs text-[color:var(--g-mut)] tabular-nums shrink-0 ml-2">{count}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}

        {manage && (
          <div className="border-t border-gilt-b pt-3 space-y-2">
            <div className="g-deco text-[11px] font-semibold text-gold">Manage (owner)</div>
            {current && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                <button
                  onClick={() => void reingestAtlasCollection(current.id).then((r) => setNotice(`Re-ingest started (job ${r.job_id}).`)).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
                  className="g-btn g-btn-ghost g-btn-sm"
                >
                  Re-ingest
                </button>
                <button
                  onClick={() => void setAtlasVisibility(current.id, !current.owner_only)
                    .then((r) => { setNotice(r.owner_only ? 'Now owner-private — members can’t see it on the Atlas page.' : 'Now visible to all members.'); return loadCollections(); })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))}
                  className="g-btn g-btn-ghost g-btn-sm"
                  title={current.owner_only ? 'Make this collection visible to all members' : 'Hide from members (reach them via a project Atlas tab instead)'}
                >
                  {current.owner_only ? '🔒 Make member-visible' : 'Make owner-private'}
                </button>
                <button
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete “${current.name}”? This removes the collection AND its indexed data from disk (the original source folder is untouched).`))) return;
                    void deleteAtlasCollection(current.id)
                      .then((r) => {
                        const freed = r.freed?.freed_bytes;
                        setNotice(
                          freed != null
                            ? `Deleted — freed ${(freed / (1024 * 1024)).toFixed(1)} MB (${r.freed?.doc_count ?? '?'} docs, ${r.freed?.chunk_count ?? '?'} chunks).`
                            : 'Unregistered. (Engine unreachable — its on-disk data was left behind.)'
                        );
                        setSlug(null);
                        return loadCollections();
                      })
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  className="g-btn g-btn-danger g-btn-sm"
                >
                  Unregister
                </button>
                <span className="text-subtext-0 self-center">
                  {current.last_ingest_at ? `ingested ${new Date(current.last_ingest_at).toLocaleString()}` : 'never ingested'}
                </span>
              </div>
            )}
            <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Name (e.g. Countries)" className="g-field g-field-sm w-full" />
            <input value={nSlug} onChange={(e) => setNSlug(e.target.value.toLowerCase())} placeholder="slug (a-z, 0-9, -)" className="g-field g-field-sm w-full !font-mono" />
            <input value={nDir} onChange={(e) => setNDir(e.target.value)} placeholder="Source folder on the host" className="g-field g-field-sm w-full !font-mono" />
            <label className="flex items-start gap-2 text-[11px] text-subtext-1">
              <input type="checkbox" checked={nOwnerOnly} onChange={(e) => setNOwnerOnly(e.target.checked)} className="mt-0.5 shrink-0" />
              <span>Owner-private — hidden from members; surface curated slices to a project via its Atlas tab.</span>
            </label>
            <button
              onClick={() => void addCollection()}
              disabled={!nSlug.trim() || !nName.trim() || !nDir.trim()}
              className="g-btn g-btn-pri g-btn-sm"
            >
              Add collection
            </button>
            <p className="text-[11px] text-subtext-0">
              Convention: one entity = one markdown file (one country/vessel/company per document, consistent headings) — that's what makes retrieval behave like lookup.
            </p>
          </div>
        )}
      </div>

      {/* RIGHT: the toggle row, then either the search surface or the
          Contents file browser (documents left, inference + reader right). */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex gap-1.5 p-4 pb-3 shrink-0">
          {(['search', 'contents'] as const).map((v) => (
            <button
              key={v}
              onClick={() => { setView(v); setDoc(null); }}
              aria-current={view === v ? 'true' : undefined}
              className={`g-btn g-btn-sm capitalize ${view === v ? 'g-btn-gilt' : 'g-btn-ghost'}`}
            >
              {v}
            </button>
          ))}
        </div>

        {view === 'contents' ? (
          <div className="flex-1 min-h-0 flex flex-col sm:flex-row px-4 pb-4 gap-3">
            {/* FILE BROWSER: every document the collection was fed */}
            <div className="g-card w-full sm:w-72 xl:w-80 min-[2400px]:w-96 shrink-0 max-h-[35%] sm:max-h-none flex flex-col min-h-0">
              <div className="g-h2 !mb-0 px-3 pt-4 pb-2 shrink-0">
                Documents <span className="n">{manifest?.documents.length ?? '…'}</span>
              </div>
              <div className="flex-1 overflow-y-auto px-2.5 pb-2.5 space-y-0.5">
                {!manifest && <p className="p-2 text-sm text-subtext-0">Loading inventory…</p>}
                {manifest?.documents.map((d) => {
                  const name = d.relative_path.split('/').pop() ?? d.relative_path;
                  const selected = doc?.source === d.relative_path || doc?.source === `${d.relative_path}.md`;
                  return (
                    <button
                      key={d.relative_path}
                      onClick={() => void openDoc(d.relative_path)}
                      aria-current={selected ? 'true' : undefined}
                      className={`w-full text-left rounded px-3 py-2.5 ${
                        selected ? 'g-sel' : 'hover:bg-surface-0'
                      }`}
                      title={d.relative_path}
                    >
                      <div className="text-sm font-medium text-text break-words line-clamp-2">{name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtext-0">
                        <span className="text-success">✓</span>
                        <span className="uppercase">{d.format ?? '?'}</span>
                        {d.size_bytes ? <span>· {(d.size_bytes / 1024).toFixed(0)} KB</span> : null}
                        {d.domains && d.domains.length > 0 && <span className="truncate">· {d.domains[0]}</span>}
                      </div>
                    </button>
                  );
                })}
                {manifest && manifest.documents.length === 0 && (
                  <p className="p-2 text-sm text-subtext-0 italic">
                    Nothing ingested yet — Re-ingest after pointing the collection at a folder with documents.
                  </p>
                )}
              </div>
            </div>

            {/* READER / COLLECTION OVERVIEW */}
            <div className="flex-1 min-w-0 min-h-0">
              {doc ? (
                <AtlasDocReader
                  source={doc.source}
                  content={doc.content}
                  inference={manifest?.documents.find(
                    (d) => d.relative_path === doc.source || `${d.relative_path}.md` === doc.source
                  )}
                  onBack={() => setDoc(null)}
                  backLabel="Overview"
                />
              ) : (
                <div className="h-full overflow-y-auto space-y-3">
                  {manifest && (
                    <>
                      <div className="g-card p-3 space-y-1 text-sm">
                        <div className="g-deco text-[11px] font-semibold text-gold">Last ingest</div>
                        <div className="text-subtext-1">
                          {manifest.run.finished_at ? new Date(manifest.run.finished_at).toLocaleString() : 'never'}
                          {manifest.run.figures ? ` · figures described: ${manifest.run.figures.described}/${manifest.run.figures.total}` : ''}
                          {manifest.run.enrichment ? ` · vision: ${manifest.run.enrichment.enabled ? manifest.run.enrichment.model || 'on' : 'off'}` : ''}
                          {manifest.run.embedding?.model ? ` · embedder: ${manifest.run.embedding.model}` : ''}
                        </div>
                        {manifest.run.enrichment && !manifest.run.enrichment.enabled && (
                          <div className="text-warning text-xs">
                            Figure description was OFF for this run — charts, maps and image-only slides indexed as blanks. Set the vision model under Settings → Models → Figure descriptions, then Re-ingest.
                          </div>
                        )}
                        {manifest.run.enrichment?.enabled && manifest.run.figures && manifest.run.figures.total > 0 && manifest.run.figures.described === 0 && (
                          <div className="text-warning text-xs">
                            Figures were found but none described — the vision endpoint didn't answer. Check it's reachable (Settings → Models → Figure descriptions → Check), then Re-ingest.
                          </div>
                        )}
                        <button
                          onClick={() => {
                            if (report) { setReport(null); return; }
                            if (!slug) return;
                            atlasReport(slug).then((r) => setReport(r.report)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                          }}
                          className="g-lnk text-xs"
                        >
                          {report ? 'Hide audit report' : 'View full audit report'}
                        </button>
                        {report && <pre className="text-xs text-subtext-1 whitespace-pre-wrap max-h-80 overflow-y-auto bg-mantle border border-surface-1 rounded p-3">{report}</pre>}
                      </div>

                      <div className="g-card p-3 text-xs text-subtext-0 space-y-0.5">
                        {manifest.stats?.total_bytes != null && (
                          <div className="text-subtext-1 pb-1">
                            On disk: <span className="text-text font-medium">{(manifest.stats.total_bytes / (1024 * 1024)).toFixed(1)} MB</span>
                            {' '}(corpus {((manifest.stats.corpus_bytes ?? 0) / (1024 * 1024)).toFixed(1)} MB · index {((manifest.stats.index_bytes ?? 0) / (1024 * 1024)).toFixed(1)} MB)
                            {manifest.stats.chunk_count != null ? ` · ${manifest.stats.chunk_count} chunks` : ''}
                          </div>
                        )}
                        <div><span className="text-subtext-1">Source folder:</span> <span className="font-mono break-all">{manifest.paths.source_dir}</span></div>
                        <div><span className="text-subtext-1">Corpus (.md files):</span> <span className="font-mono break-all">{manifest.paths.corpus_dir}</span></div>
                      </div>

                      <p className="text-xs text-subtext-0">
                        Pick a document on the left to read its analysed content — provenance and domains up top, the
                        normalized text below.
                      </p>
                    </>
                  )}
                  {!manifest && <p className="text-sm text-subtext-0">Loading inventory…</p>}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-3">
            {doc ? (
              <div className="h-full min-h-0">
                <AtlasDocReader
                  source={doc.source}
                  content={doc.content}
                  inference={manifest?.documents.find(
                    (d) => d.relative_path === doc.source || `${d.relative_path}.md` === doc.source
                  )}
                  onBack={() => setDoc(null)}
                  backLabel="Results"
                />
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void runSearch(query, filters)}
                    placeholder={current ? `Search ${current.name}…` : 'Search Atlas…'}
                    className="g-field g-field-sm flex-1"
                  />
                  <button
                    onClick={() => void runSearch(query, filters)}
                    disabled={!query.trim() || !slug || searching}
                    className="g-btn g-btn-pri g-btn-sm"
                  >
                    {searching ? 'Searching…' : 'Search'}
                  </button>
                </div>
                {Object.keys(filters).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 items-center">
                    <span className="text-xs text-subtext-0">Lens:</span>
                    {Object.entries(filters).map(([role, value]) => (
                      <button key={role} onClick={() => toggleFilter(role, value)} className="g-tag min-h-8 !bg-primary/15 !text-primary hover:!bg-primary/25" title="Click to remove">
                        {role}: {value} ✕
                      </button>
                    ))}
                  </div>
                )}
                {notice && <div className="g-plain text-sm text-subtext-1 px-3 py-2">{notice}</div>}
                {error && <div className="text-sm text-error bg-error/10 border border-error/40 rounded px-3 py-2">{error}</div>}
                {hits && hits.length === 0 && <p className="text-sm text-subtext-0 italic">No matches with this lens.</p>}
                {hits && hits.length > 0 && (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,34rem),1fr))] items-start">
                {hits.map((h, i) => (
                  <button key={i} onClick={() => void openDoc(h.source)} className="g-plain g-glint block w-full text-left p-3.5 hover:border-gilt-a">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-mono text-subtext-0 truncate">{h.source}</span>
                      <span className="g-tag !min-h-[20px] !px-2 !text-[11px] tabular-nums shrink-0">{h.score.toFixed(3)}</span>
                    </div>
                    <p className="text-sm text-text whitespace-pre-wrap max-w-[72ch]">{h.text}</p>
                  </button>
                ))}
                </div>
                )}
                {!hits && !error && collections.length > 0 && (
                  <p className="text-sm text-subtext-0">
                    Pick a facet on the left or type a query. Click a result to open its full document.
                  </p>
                )}
                {collections.length === 0 && !error && (
                  <p className="text-sm text-subtext-0">
                    No Atlas collections yet{manage ? ' — register one on the left: a folder of markdown files becomes shared, searchable knowledge.' : ' — the owner can add them on the Atlas page.'}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
