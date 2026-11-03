import { useEffect, useRef, useState } from "react";
import AtlasPanel from "../components/AtlasPanel";
import { getProjectTabConfig, setProjectTabConfig } from "../lib/daemon";

/**
 * The per-project Atlas tab: the same browse panel as the Atlas page, opened
 * through the project's saved lens (a collection + facet filters stored in
 * the tab's config — a query, never copies, so it's always current). Anyone
 * can wander off the lens; saving the new lens back is admin-gated server-side.
 */
export default function AtlasTab({ projectId }: { projectId: number }) {
  const [loaded, setLoaded] = useState(false);
  const [savedLens, setSavedLens] = useState<{ slug?: string; filters?: Record<string, string> }>({});
  const liveLens = useRef<{ slug: string | null; filters: Record<string, string> }>({ slug: null, filters: {} });
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getProjectTabConfig(projectId, "atlas")
      .then((cfg) => {
        if (!alive) return;
        setSavedLens(cfg as { slug?: string; filters?: Record<string, string> });
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true)); // older host — open unlensed
    return () => {
      alive = false;
    };
  }, [projectId]);

  const saveLens = async () => {
    try {
      await setProjectTabConfig(projectId, "atlas", {
        slug: liveLens.current.slug ?? undefined,
        filters: liveLens.current.filters,
      });
      setMsg("Saved as this project's lens.");
      setDirty(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e)); // non-admins get the server's refusal
    }
  };

  if (!loaded) return <div className="flex-1 p-6 text-sm text-[color:var(--g-mut)]">Loading…</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {(dirty || msg) && (
        <div className="px-4 py-1.5 border-b border-gilt-b bg-crust flex items-center gap-3 text-xs">
          {dirty && (
            <button onClick={() => void saveLens()} className="g-btn g-btn-pri g-btn-sm">
              Save as project lens
            </button>
          )}
          {msg && <span className="text-[color:var(--g-fg2)]">{msg}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <AtlasPanel
          initialSlug={savedLens.slug}
          initialFilters={savedLens.filters}
          onLensChange={(slug, filters) => {
            liveLens.current = { slug, filters };
            setDirty(true);
            setMsg(null);
          }}
        />
      </div>
    </div>
  );
}
