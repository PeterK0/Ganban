import { isAbortError } from '../lib/uploads';
import { useEffect, useRef, useState } from 'react';
import {
  listAtlasCollections,
  createAtlasCollection,
  listAtlasFiles,
  uploadAtlasFile,
  deleteAtlasFile,
  setAtlasAutoIndex,
  reingestAtlasCollection,
  importProjectFileToAtlas,
  importAtlasFileToProject,
  listProjectFiles,
  daemonInvoke,
  DaemonError,
  type AtlasCollection,
  type AtlasLibraryListing,
  type ProjectFile,
} from '../lib/daemon';
import type { Project } from '../types';
import ScrollArea from './ScrollArea';
import { KnowledgeEngineSettingsLink, useKnowledgeEngine } from './KnowledgeEngine';

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Atlas › Library: managed document folders the owner dumps into — and
 * indexing that NEVER runs by itself. Upload freely (folders survive, so a
 * PDF broken up in PDF Studio lands as a tidy subtree), then press
 * “Index now” once the dust settles — or opt into auto-index, which waits
 * for a 90-second quiet period so a bulk dump costs exactly one ingest. */
export default function AtlasLibrary() {
  const [collections, setCollections] = useState<AtlasCollection[]>([]);
  // false = no knowledge engine on the host: collecting works, indexing waits for it.
  const engine = useKnowledgeEngine();
  const [selId, setSelId] = useState<number | null>(null);
  const [listing, setListing] = useState<AtlasLibraryListing | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [newName, setNewName] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Cross-surface flows: projects ⇄ library. Same daemon on both ends (the
  // pickers use daemonInvoke — the id-collision doctrine).
  const [projects, setProjects] = useState<Project[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importProject, setImportProject] = useState<number | ''>('');
  const [importFiles, setImportFiles] = useState<ProjectFile[] | null>(null);
  const [copyTarget, setCopyTarget] = useState<number | ''>('');

  const load = async () => {
    try {
      const cols = await listAtlasCollections();
      setCollections(cols);
      if (selId == null && cols.length > 0) setSelId(cols[0].id);
      setNotOwner(false);
    } catch (e) {
      if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) setNotOwner(true);
      else setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    daemonInvoke<Project[]>('get_projects').then((ps) => setProjects(ps.filter((p) => !p.archived))).catch(() => setProjects([]));
  }, []);

  const loadFiles = async (id: number) => {
    try {
      setListing(await listAtlasFiles(id));
    } catch (e) {
      setListing(null);
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (selId != null) void loadFiles(selId);
  }, [selId]);

  const selected = collections.find((c) => c.id === selId) ?? null;

  const createLibrary = async () => {
    const name = newName.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'library';
    try {
      // Empty source_dir = a MANAGED folder Ganban owns under the storage
      // root. Created empty and NOT ingested — dump documents first.
      const r = await createAtlasCollection(slug, name, '', false);
      setNewName('');
      await load();
      setSelId(r.collection.id);
      setMsg(`Library “${name}” created. Upload documents, then Index now.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (selId == null || !listing?.managed) return;
    const arr = [...files];
    // The upload manager queues + streams them (progress in the upload bar).
    setUploading(`${arr.length} file${arr.length === 1 ? '' : 's'} — see the upload bar`);
    const target = `Atlas · ${collections.find((c) => c.id === selId)?.name ?? 'library'}`;
    const results = await Promise.allSettled(
      arr.map((f) => {
        const rel = folder.trim() ? `${folder.trim().replace(/\/+$/, '')}/${f.name}` : f.name;
        return uploadAtlasFile(selId, f, rel, { target });
      })
    );
    setUploading(null);
    await loadFiles(selId);
    const done = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected' && !isAbortError(r.reason));
    const why = failed.length ? ` ${failed.length} failed — ${String((failed[0] as PromiseRejectedResult).reason?.message ?? (failed[0] as PromiseRejectedResult).reason)}.` : '';
    setMsg(`${done} file${done === 1 ? '' : 's'} uploaded — nothing is indexed until you press “Index now”${listing.auto_index ? ' (auto-index will pick them up after a quiet period)' : ''}.${why}`);
  };

  const indexNow = async () => {
    if (selId == null) return;
    try {
      const r = await reingestAtlasCollection(selId);
      setMsg(`Indexing started (job ${String((r as { job_id?: string }).job_id ?? '')}) — watch it in Assistant › Indexing.`);
      await loadFiles(selId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleAuto = async () => {
    if (selId == null || listing == null) return;
    try {
      await setAtlasAutoIndex(selId, !listing.auto_index);
      await loadFiles(selId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const pickImportProject = async (pid: number | '') => {
    setImportProject(pid);
    setImportFiles(null);
    if (pid !== '') {
      try { setImportFiles(await listProjectFiles(pid)); } catch { setImportFiles([]); }
    }
  };

  const importOne = async (f: ProjectFile) => {
    if (selId == null) return;
    try {
      const proj = projects.find((p) => p.id === importProject);
      const rel = `${(proj?.name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${f.rel_path || f.file_name}`;
      await importProjectFileToAtlas(selId, f.id, rel);
      await loadFiles(selId);
      setMsg(`Imported ${f.file_name} — index when ready.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const copyToProject = async (relPath: string) => {
    if (selId == null || copyTarget === '') return;
    try {
      await importAtlasFileToProject(copyTarget, selId, relPath);
      setMsg(`Copied ${relPath} to ${projects.find((p) => p.id === copyTarget)?.name ?? 'the project'}'s files.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  if (notOwner) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-subtext-0">The Library is managed on the host. Ask the owner, or open Ganban on the host machine.</p>
      </div>
    );
  }

  const dirty = listing?.dirty_at != null;

  return (
    <div className="h-full flex min-h-0">
      {/* LEFT: collections */}
      <div className="w-64 xl:w-72 shrink-0 border-r border-gilt-b bg-crust flex flex-col min-h-0">
        <div className="px-3 py-3 border-b border-gilt-b">
          <span className="g-deco text-[11px] font-semibold text-gold">Library</span>
          <p className="text-[11px] text-[color:var(--g-mut)] mt-1">Document collections for Atlas — indexed only when you say so.</p>
        </div>
        <div className="p-2 space-y-1.5 border-b border-gilt-b">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createLibrary()}
            placeholder="New library name…"
            className="g-field g-field-sm w-full"
          />
          <button onClick={() => void createLibrary()} disabled={!newName.trim()} className="g-btn g-btn-pri g-btn-sm w-full">
            ＋ Create managed library
          </button>
        </div>
        <ScrollArea className="flex-1" contentClassName="p-2 space-y-1">
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelId(c.id)}
              aria-current={selId === c.id ? 'true' : undefined}
              className={`w-full text-left px-3 py-2.5 rounded ${selId === c.id ? 'g-sel' : 'hover:bg-surface-0'}`}
            >
              <div className="text-sm font-medium text-text truncate">{c.name}</div>
              <div className="text-[11px] text-subtext-0 truncate">
                atlas-{c.slug}
                {c.last_ingest_at ? ` · indexed ${String(c.last_ingest_at).slice(0, 10)}` : ' · never indexed'}
              </div>
            </button>
          ))}
          {collections.length === 0 && <p className="p-2 text-xs text-subtext-0 italic">No collections yet — create a managed library above.</p>}
        </ScrollArea>
      </div>

      {/* RIGHT: the selected collection's folder */}
      <ScrollArea className="flex-1 min-w-0 bg-mantle" contentClassName="px-6 py-5 space-y-4">
        {selected == null || listing == null ? (
          <p className="text-sm text-subtext-0">Pick a collection.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-deco uppercase tracking-[0.16em] text-2xl font-light text-text">{selected.name}</h2>
              {dirty ? (
                <span className="g-tag g-tag-warn">changes not yet indexed</span>
              ) : listing.last_ingest_at ? (
                <span className="g-tag g-tag-ok">index up to date</span>
              ) : (
                <span className="g-tag">never indexed</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => void toggleAuto()}
                  className={`g-btn g-btn-sm g-btn-ghost ${listing.auto_index ? '!text-success !shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]' : ''}`}
                  title="When ON, changes are indexed automatically after a 90-second quiet period — a bulk dump still costs exactly one ingest. Default OFF: nothing indexes until you press Index now."
                >
                  {listing.auto_index ? 'auto-index: on' : 'auto-index: off'}
                </button>
                <button
                  onClick={() => void indexNow()}
                  disabled={engine === false}
                  title={engine === false ? 'Indexing needs the knowledge engine, which isn’t set up on this host' : undefined}
                  className="g-btn g-btn-pri g-btn-sm"
                >
                  ⚡ Index now
                </button>
              </div>
            </div>

            {engine === false && (
              <p className="g-inset !px-3 !py-2.5 text-xs text-[color:var(--g-fg2)]">
                Indexing needs the knowledge engine (ragrat), an optional part of Ganban that isn’t set up on this host.
                You can collect documents here now and index them once it’s set up in <KnowledgeEngineSettingsLink />.
              </p>
            )}

            {listing.managed ? (
              <div className="g-card p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Into folder (optional) — e.g. charters/2026"
                    className="g-field g-field-sm flex-1 min-w-48 !font-mono"
                  />
                  <button onClick={() => fileInput.current?.click()} disabled={uploading != null} className="g-btn g-btn-ghost g-btn-sm">
                    {uploading ? `Uploading ${uploading}…` : '⇪ Upload files'}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }}
                  />
                </div>
                <p className="text-[11px] text-subtext-0">
                  Dump freely — <span className="text-text">nothing is indexed on upload</span>. Break big PDFs apart in PDF Studio first,
                  upload the pieces into folders here, and index once the collection is ready.
                </p>
              </div>
            ) : (
              <p className="text-xs text-subtext-0">
                This collection points at <span className="font-mono">{selected.source_dir}</span> — a folder you own. Ganban never
                writes into user folders; manage its files there, then Index now.
              </p>
            )}

            {listing.managed && (
              <div className="g-card p-4 space-y-2">
                <button onClick={() => setImportOpen((v) => !v)} className="g-lnk text-xs min-h-8">
                  {importOpen ? '▾' : '▸'} Import from a project…
                </button>
                {importOpen && (
                  <>
                    <select
                      value={importProject}
                      onChange={(e) => void pickImportProject(e.target.value ? Number(e.target.value) : '')}
                      className="g-field g-field-sm w-full"
                    >
                      <option value="">Pick a project…</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {importFiles != null && (
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {importFiles.length === 0 ? (
                          <p className="text-xs text-subtext-0 italic">No host-stored files in this project.</p>
                        ) : (
                          importFiles.map((f) => (
                            <div key={f.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-surface-0">
                              <span className="truncate flex-1 font-mono">{f.rel_path || f.file_name}</span>
                              <span className="text-subtext-0 shrink-0">{fmtSize(f.size_bytes)}</span>
                              <button onClick={() => void importOne(f)} className="g-lnk min-h-8 shrink-0">add</button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    <p className="text-[11px] text-subtext-0">Copies the file into this library (server-side) under a folder named after the project. Nothing indexes until you say so.</p>
                  </>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="g-deco text-[11px] font-semibold text-gold flex-1">
                  Files <span className="text-[color:var(--g-mut)] tracking-[0.1em]">({listing.files.length})</span>
                </div>
                <span className="text-[11px] text-subtext-0">copy to:</span>
                <select
                  value={copyTarget}
                  onChange={(e) => setCopyTarget(e.target.value ? Number(e.target.value) : '')}
                  className="g-field g-field-sm max-w-44 !w-auto"
                  title="Pick a project, then use each file's → button to copy it into that project's files"
                >
                  <option value="">— pick a project —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              {listing.files.length === 0 ? (
                <p className="text-sm text-subtext-0 italic">Empty — upload documents above.</p>
              ) : (
                <div className="g-plain p-1.5 grid gap-x-3 gap-y-0.5 grid-cols-[repeat(auto-fill,minmax(min(100%,30rem),1fr))]">
                {listing.files.map((f) => (
                  <div key={f.rel_path} className="flex items-center gap-3 min-h-10 px-3 py-1.5 rounded hover:bg-surface-0">
                    <span className="g-gem c-none" aria-hidden="true" />
                    <span className="text-sm text-text truncate flex-1 font-mono">{f.rel_path}</span>
                    <span className="text-[11px] text-[color:var(--g-mut)] tabular-nums shrink-0">{fmtSize(f.size_bytes)}</span>
                    {copyTarget !== '' && (
                      <button
                        onClick={() => void copyToProject(f.rel_path)}
                        className="g-lnk min-h-8 text-[11px] shrink-0"
                        title="Copy this file into the selected project's files"
                      >
                        → copy
                      </button>
                    )}
                    {listing.managed && (
                      <button
                        onClick={() => selId != null && deleteAtlasFile(selId, f.rel_path).then(() => loadFiles(selId)).catch((e) => setMsg(String(e)))}
                        className="g-iconbtn !w-8 !h-8 hover:!text-error shrink-0"
                        title="Delete from the library (re-index to remove from search)"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                </div>
              )}
            </div>
            {msg && <p className="text-xs text-subtext-1">{msg}</p>}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
