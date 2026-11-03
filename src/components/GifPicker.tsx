import { useEffect, useRef, useState } from "react";
import { GifsNotConfigured, searchGifs, type Gif } from "../lib/giphy";
import { Modal } from "./gilt";

/** A GIPHY search in a Gilt Modal (works on desktop + touch). Search runs through the
 * host's proxy — the owner saves ONE key in Settings → Plug-ins and every
 * member device gets GIFs; `onPick` receives the GIF URL to embed.
 *
 * Note: every button is type="button" and the search input swallows Enter — the
 * picker is often rendered inside a comment <form>, so a default submit would
 * close the comment instead of searching. */
export default function GifPicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const run = async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      setGifs(await searchGifs(query));
      setNotConfigured(false);
    } catch (e) {
      if (e instanceof GifsNotConfigured) setNotConfigured(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // The search box (focused on open) unmounts when GIFs aren't set up; keep
  // focus inside the dialog by moving it to the close button.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (notConfigured) closeRef.current?.focus();
  }, [notConfigured]);

  useEffect(() => {
    run("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A Gilt Modal: the scrim covers the whole window (top bar and tab bar
  // included) and the picker centres in it. The scrim and the panel are
  // siblings, so a text selection released outside the panel no longer lands a
  // click on the backdrop.
  return (
    <Modal onClose={onClose} title="GIFs" className={notConfigured ? "w-[640px]" : "w-[640px] h-[min(720px,82vh)]"}>
        <div className="-mt-2 pb-3 border-b border-gilt-b text-center text-xs text-subtext-0 flex-none">via GIPHY</div>
        <button ref={closeRef} type="button" onClick={onClose} className="g-iconbtn absolute right-3 top-3" aria-label="Close" title="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        {notConfigured ? (
          <div className="p-5">
            <p className="g-inset text-sm text-subtext-1">
              GIF search isn't set up on this host yet — the owner can add a free GIPHY API key under{" "}
              <span className="text-text">Settings → Plug-ins</span> (giphy.com → Developers → Create an App), and it
              works for everyone at once.
            </p>
          </div>
        ) : (
          <>
            <div className="px-5 pt-4 pb-3 flex gap-2 flex-none">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    run(q);
                  }
                }}
                placeholder="Search GIFs…"
                autoFocus
                aria-label="Search GIFs"
                className="g-field flex-1"
              />
              <button type="button" onClick={() => run(q)} className="g-btn g-btn-gilt">
                Search
              </button>
            </div>
            {error && <p className="px-5 pb-2 text-sm text-error">{error}</p>}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5" style={{ paddingBottom: "max(20px, env(safe-area-inset-bottom))" }}>
              {loading ? (
                <p className="text-center text-subtext-0 py-6">Loading…</p>
              ) : gifs.length === 0 ? (
                <p className="text-center text-subtext-0 py-6">No GIFs.</p>
              ) : (
                // Masonry: GIFs keep their aspect ratio with comfortable spacing.
                <div className="columns-2 sm:columns-3 gap-3">
                  {gifs.map((g) => (
                    <button
                      type="button"
                      key={g.id}
                      onClick={() => onPick(g.url)}
                      className="mb-3 block w-full overflow-hidden rounded bg-mantle border border-gilt-b break-inside-avoid hover:border-gold active:opacity-70"
                    >
                      <img src={g.preview} alt={g.title} className="w-full h-auto block" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
    </Modal>
  );
}
