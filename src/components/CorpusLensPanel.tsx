import { useCallback, useEffect, useState } from "react";
import { getCorpusFacets, searchKnowledgeBase, hasDaemon, DaemonError, type RagHit } from "../lib/daemon";
import { useAppStore } from "../store/appStore";
import { ASSISTANT_TREE_W } from "../lib/ui";
import { KnowledgeEngineEmpty, useKnowledgeEngine } from "./KnowledgeEngine";

/**
 * The Knowledge base tab: makes a project's RAG layer legible instead of
 * invisible. A header states plainly what it is (what the assistant searches to
 * ground answers). Left: "Refine by" — the tags ragrat extracted at ingest
 * (role → value → count), click to filter. Right: semantic search returning the
 * exact passages the assistant would retrieve, so the user can see what it
 * knows. "Facets" is never shown to the user — it's framed as document tags.
 */
export default function CorpusLensPanel() {
  const { projects } = useAppStore();
  const active = projects.filter((p) => !p.archived);
  const [projectId, setProjectId] = useState<number | null>(active[0]?.id ?? null);
  const [facets, setFacets] = useState<Record<string, Record<string, number>>>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = useKnowledgeEngine(); // false = no knowledge engine on the host

  const loadFacets = useCallback(async (pid: number) => {
    try {
      setFacets(await getCorpusFacets(pid));
      setError(null);
    } catch (e) {
      setFacets({});
      setError(
        e instanceof DaemonError && e.status === 404
          ? "The knowledge base isn't enabled on this host — set up ragrat in Settings → AI Engines."
          : e instanceof Error ? e.message : String(e)
      );
    }
  }, []);

  useEffect(() => {
    if (projectId != null && hasDaemon() && engine !== false) {
      setFilters({});
      setHits(null);
      void loadFacets(projectId);
    }
  }, [projectId, loadFacets, engine]);

  const runSearch = async (q: string, f: Record<string, string>) => {
    if (projectId == null || !q.trim()) return;
    setSearching(true);
    try {
      setHits(await searchKnowledgeBase(q.trim(), projectId, 10, Object.keys(f).length ? f : undefined));
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
    // With no query yet, the clicked value is the most useful starting query.
    const q = query.trim() || value;
    if (!query.trim()) setQuery(q);
    void runSearch(q, next);
  };

  if (!hasDaemon()) {
    return <p className="p-5 text-sm text-subtext-0">The knowledge base lives on the host — connect to a daemon to browse it.</p>;
  }

  const roles = Object.entries(facets).filter(([, values]) => Object.keys(values).length > 0);

  if (engine === false) {
    return (
      <KnowledgeEngineEmpty icon="search" title="The knowledge base isn't set up">
        <p>The knowledge base is what the assistant searches to ground its answers: each project's notes, tasks and files.</p>
        <p>
          It runs on the knowledge engine (ragrat), an optional part of Ganban that isn't set up on this host. The
          assistant still chats without it.
        </p>
      </KnowledgeEngineEmpty>
    );
  }

  return (
    <div className="h-full flex flex-col bg-mantle">
      {/* Header — the tab explains itself: what this is, which project. */}
      <div className="px-8 pt-6 pb-4 border-b border-gilt-b flex items-end gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="g-subtitle text-text">Knowledge base</h2>
          <p className="text-sm text-[color:var(--g-fg2)] mt-2 max-w-[72ch]">
            The notes, tasks and files the assistant searches to ground its answers. Browse what's indexed, or search it the way the assistant does.
          </p>
        </div>
        <select
          value={projectId ?? ""}
          onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
          className="g-field g-field-sm shrink-0 !w-auto"
        >
          {active.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* LEFT: filters auto-extracted from the documents (was "facets") */}
        <div className={`${ASSISTANT_TREE_W} shrink-0 border-r border-gilt-b bg-crust overflow-y-auto p-4 space-y-4`}>
          <div>
            <div className="g-deco text-[11px] font-semibold text-gold">Refine by</div>
            <p className="text-[11px] text-subtext-0 mt-0.5">Tags pulled from your documents — click one to narrow the search.</p>
          </div>
          {roles.length === 0 && !error && (
            <p className="text-sm text-subtext-0 italic">
              Nothing indexed yet. Add tasks, notes or files to this project and index it from the{" "}
              <span className="text-text">Indexing</span> tab — its tags then appear here.
            </p>
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
                        filters[role] === value ? "g-sel text-text" : "text-text hover:bg-surface-0"
                      }`}
                    >
                      <span className="truncate">{value}</span>
                      <span className="text-xs text-[color:var(--g-mut)] tabular-nums shrink-0 ml-2">{count}</span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT: search → the exact passages the assistant would retrieve */}
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-3">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch(query, filters)}
              placeholder="Search this knowledge base…"
              className="g-field g-field-sm flex-1"
            />
            <button
              onClick={() => void runSearch(query, filters)}
              disabled={!query.trim() || searching}
              className="g-btn g-btn-pri g-btn-sm"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          {Object.keys(filters).length > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-xs text-subtext-0">Filters:</span>
              {Object.entries(filters).map(([role, value]) => (
                <button
                  key={role}
                  onClick={() => toggleFilter(role, value)}
                  className="g-tag min-h-8 !bg-primary/15 !text-primary hover:!bg-primary/25"
                  title="Click to remove"
                >
                  {role}: {value} ✕
                </button>
              ))}
            </div>
          )}
          {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2">{error}</div>}
          {hits && (
            <div className="text-xs text-subtext-0">
              {hits.length === 0
                ? "No matching passages."
                : `${hits.length} passage${hits.length === 1 ? "" : "s"} the assistant could cite${Object.keys(filters).length ? " (filtered)" : ""}.`}
            </div>
          )}
          {hits && hits.length > 0 && (
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,34rem),1fr))] items-start">
          {hits.map((h, i) => (
            <div key={i} className="g-plain p-3.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-mono text-subtext-0 truncate">{h.source}</span>
                <span className="g-tag !min-h-[20px] !px-2 !text-[11px] tabular-nums shrink-0" title="Relevance score (higher = closer match)">{h.score.toFixed(2)}</span>
              </div>
              <p className="text-sm text-text whitespace-pre-wrap max-w-[72ch]">{h.text}</p>
            </div>
          ))}
          </div>
          )}
          {!hits && !error && (
            <div className="text-sm text-subtext-0 pt-2">
              <p>Type a question above, or click a tag on the left.</p>
              <p className="text-xs mt-1">You'll see the exact passages the assistant retrieves to answer questions about this project — so you can tell what it does (and doesn't) know.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
