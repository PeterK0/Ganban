// Publish the native app builds the host serves at /download — the first-install
// page a new device gets its app from. Installed apps then update themselves from
// the host's own client builds (lib/update.ts, ADR 0007), not from these. Lives
// in Settings → Updates (moved
// out of Sync → Host: builds are an owner/publishing concern, not a per-host
// hosting toggle). Dual-routed like the rest: when this desktop hosts locally it
// scans its own disk + can pick files/folders; when it's a remote admin client
// the host scans ITS disk and we just toggle what it serves.
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  daemonStatus,
  daemonDiscoverBuilds,
  daemonSetBuild,
  sharedBuilds,
  type BuildKind,
  type BuildShares,
  type DaemonStatus,
  type DiscoveredBuild,
} from "../lib/host";
import { getDaemonBaseUrl, isDesktopOnline } from "../lib/daemon";

const KIND_OPTIONS: BuildKind[] = ["windows", "macos", "linux", "android", "server"];
const platformLabel = (k: string) =>
  (({ android: "Android", windows: "Windows", macos: "macOS", linux: "Linux", server: "Server (self-host)" }) as Record<string, string>)[k] ?? k;
const fmtSize = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** Best-guess platform for an ambiguous (kind="") build file so the dropdown
 * starts on a sensible default — server binaries by name, else Windows (.zip). */
const guessKind = (name: string): BuildKind => {
  const n = name.toLowerCase();
  if (n.startsWith("ganban-server") || n.includes("server")) return "server";
  return "windows";
};

export function ShareBuildsPanel() {
  const online = isDesktopOnline();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredBuild[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [buildsFolder, setBuildsFolder] = useState<string>(() => localStorage.getItem("ganban-builds-folder") ?? "");
  const [served, setServed] = useState<BuildShares | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Files the owner picked manually (outside the scanned dirs) — rendered as
  // unassigned rows alongside discovered ones.
  const [manual, setManual] = useState<DiscoveredBuild[]>([]);
  // Owner's platform choice for an ambiguous/unassigned file, keyed by path.
  const [assignKind, setAssignKind] = useState<Record<string, BuildKind>>({});

  const hosting = !!(status?.running && !status.loopback);
  // The host's reachable address for /download: the connected host (online) or
  // this machine's best advertised address while hosting locally.
  const hostUrl = online ? getDaemonBaseUrl() ?? "" : status?.urls?.[0] ?? "";
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    daemonStatus().then(setStatus).catch(() => {});
  }, []);

  const rescan = async (folder = buildsFolder) => {
    setDiscovering(true);
    setError(null);
    try {
      // A remote client can't browse the host's disk, so it never sends a local
      // folder path — the host scans its own standard build-output dirs.
      setDiscovered(await daemonDiscoverBuilds(online ? undefined : folder || undefined));
    } catch (e) {
      fail(e);
    } finally {
      setDiscovering(false);
    }
  };

  // Auto-discover + read the host's current shares once there's a host to publish
  // to (hosting locally, or connected to one).
  useEffect(() => {
    if (hosting || online) {
      void rescan();
      sharedBuilds().then(setServed).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosting, online]);

  const servedPath = (kind: BuildKind): string | null =>
    (served as unknown as Record<string, string | null> | null)?.[kind] ?? null;
  // The platform slot a given file is currently served under, if any (so an
  // ambiguous file shows "Available as X" + a Stop control regardless of kind).
  const servedAs = (path: string): BuildKind | null => KIND_OPTIONS.find((k) => servedPath(k) === path) ?? null;
  // The kind to use when serving an unassigned file: the owner's pick, else a guess.
  const chosenKind = (b: DiscoveredBuild): BuildKind =>
    b.kind || assignKind[b.path] || guessKind(b.file_name);

  const chooseFolder = async () => {
    setError(null);
    try {
      const sel = await open({ directory: true, multiple: false });
      if (typeof sel !== "string") return;
      localStorage.setItem("ganban-builds-folder", sel);
      setBuildsFolder(sel);
      void rescan(sel);
    } catch (e) {
      fail(e);
    }
  };

  const clearFolder = () => {
    localStorage.removeItem("ganban-builds-folder");
    setBuildsFolder("");
    void rescan("");
  };

  // Make a build available under `kind` (or stop serving it). For ambiguous files
  // the owner assigns the platform first (chosenKind).
  const serveAs = async (path: string, kind: BuildKind) => {
    try {
      setServed(await daemonSetBuild(kind, path));
    } catch (e) {
      fail(e);
    }
  };
  const stopServing = async (kind: BuildKind) => {
    try {
      setServed(await daemonSetBuild(kind, null));
    } catch (e) {
      fail(e);
    }
  };

  // Pick a build file the scan missed (e.g. a Windows .zip or the server binary
  // outside the watched folder). It's added as an unassigned row to classify.
  const addManual = async () => {
    setError(null);
    try {
      const sel = await open({ multiple: false, directory: false });
      if (typeof sel !== "string") return;
      const file_name = sel.split(/[\\/]/).pop() || sel;
      setManual((m) => (m.some((b) => b.path === sel) ? m : [...m, { kind: "", path: sel, file_name, size: 0 }]));
    } catch (e) {
      fail(e);
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  // Nothing to publish to unless we're hosting or connected to a host.
  if (!hosting && !online) {
    return (
      <p className="text-sm text-subtext-0">
        Start hosting (Settings → Sync → Host this device) or connect to a host to publish app builds for first installs.
      </p>
    );
  }

  const anyServed = !!(served?.android || served?.windows || served?.macos || served?.linux || served?.server);
  // Discovered (scanned) files + manually-picked ones, deduped by path.
  const builds = [...discovered, ...manual.filter((m) => !discovered.some((d) => d.path === m.path))];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-text">First-install downloads</div>
        <button onClick={() => void rescan()} disabled={discovering} className="text-xs text-primary disabled:opacity-50">
          {discovering ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <p className="text-xs text-subtext-0 -mt-2">
        Make a build available at /download (auto-matched to each visitor's OS) so a new device can install Ganban.
        Installed apps update themselves, from GitHub Releases or the host's builds.
        Ambiguous files (a Windows .zip, the server build) ask you to pick the platform first.
      </p>

      {!online && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-subtext-0 shrink-0">Builds folder:</span>
          {buildsFolder ? (
            <>
              <span className="font-mono text-subtext-1 truncate min-w-0" title={buildsFolder}>{buildsFolder}</span>
              <button onClick={chooseFolder} className="text-primary shrink-0">Change</button>
              <button onClick={clearFolder} className="text-error shrink-0">Clear</button>
            </>
          ) : (
            <button onClick={chooseFolder} className="text-primary">Choose a folder to watch…</button>
          )}
        </div>
      )}

      {builds.length === 0 ? (
        <p className="text-xs text-subtext-0">
          {online ? (
            <>No builds found on the host. Build there (<span className="font-mono">npm run build:all</span>), then Rescan.</>
          ) : (
            <>
              No builds found. Run <span className="font-mono">npm run build:all</span>, drop installers (incl. the Windows
              .zip / server build) in a watched folder above, then Rescan —{" "}
              <button onClick={addManual} className="text-primary underline">or pick a file</button>.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-1.5">
          {builds.map((b) => {
            const servedKind = servedAs(b.path);
            const unassigned = b.kind === "" && !servedKind;
            return (
              <div key={b.path} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-surface-2">
                <div className="min-w-0">
                  <div className="text-sm truncate">{b.file_name}</div>
                  <div className="text-xs text-subtext-0">
                    {servedKind ? platformLabel(servedKind) : b.kind ? platformLabel(b.kind) : "Pick a platform"}
                    {b.size ? ` · ${fmtSize(b.size)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {unassigned && (
                    <select
                      value={chosenKind(b)}
                      onChange={(e) => setAssignKind((m) => ({ ...m, [b.path]: e.target.value as BuildKind }))}
                      className="bg-surface-0 border border-surface-2 rounded-lg px-2 py-1 text-xs text-text"
                    >
                      {KIND_OPTIONS.map((k) => <option key={k} value={k}>{platformLabel(k)}</option>)}
                    </select>
                  )}
                  {servedKind ? (
                    <button onClick={() => void stopServing(servedKind)} className="g-btn g-btn-pri g-btn-sm">
                      Available ✓
                    </button>
                  ) : (
                    <button onClick={() => void serveAs(b.path, chosenKind(b))} className="g-btn g-btn-ghost g-btn-sm">
                      Make available
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!online && (
            <button onClick={addManual} className="text-xs text-subtext-0 underline">or pick a file manually</button>
          )}
        </div>
      )}

      {anyServed && hostUrl && (
        <div className="pt-1">
          {showQr ? (
            <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
              <div className="bg-white p-3 rounded-xl self-center shrink-0">
                <QRCodeSVG value={`${hostUrl}/download`} size={160} />
              </div>
              <div className="flex-1 min-w-0 space-y-1 text-sm">
                <p className="text-subtext-1">Scan or browse to the install page:</p>
                <div className="font-mono text-subtext-0 break-all">{hostUrl}/download</div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => void copyLink(`${hostUrl}/download`)} className="g-btn g-btn-ghost g-btn-sm">
                    {copied ? "Copied ✓" : "Copy link"}
                  </button>
                  <button onClick={() => setShowQr(false)} className="g-btn g-btn-ghost g-btn-sm">Hide</button>
                </div>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowQr(true)} className="g-btn g-btn-ghost">Show download QR</button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
