import { useEffect, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import { daemonInvoke, DaemonError } from '../lib/daemon';
import type { Project } from '../types';
import ModelsTab from '../tabs/ModelsTab';

/** Atlas › My Models (Phase 2b): the Models tab as a PERSONAL surface. Data
 * lives in a hidden per-user container project — same tables, same commands,
 * same gate as the project tab, but immune to any project's lifecycle:
 * archive a project and your collection is exactly where you left it, here.
 * The import control moves kits wholesale out of a project (rows re-pointed,
 * builds/boards/marks ride along on kit_id). */
export default function AtlasModels() {
  const [personalId, setPersonalId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [importFrom, setImportFrom] = useState<number | ''>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Remount ModelsTab after an import so it refetches the collection.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    daemonInvoke<{ projectId: number }>('ensure_personal_space')
      .then((r) => setPersonalId(r.projectId))
      .catch((e) => setErr(e instanceof DaemonError && (e.status === 404 || e.status === 400)
        ? 'This host does not support personal spaces yet — update it.'
        : e instanceof Error ? e.message : String(e)));
    daemonInvoke<Project[]>('get_projects')
      .then((ps) => setProjects(ps.filter((p) => !p.archived)))
      .catch(() => setProjects([]));
  }, []);

  const adopt = async () => {
    if (importFrom === '' || busy) return;
    const proj = projects.find((p) => p.id === importFrom);
    if (!await confirmDialog(`Move ALL model kits from “${proj?.name ?? 'that project'}” into your personal collection? The project's Models tab will be empty afterwards.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await daemonInvoke<{ moved: number }>('adopt_model_kits', { projectId: importFrom });
      setMsg(`${r.moved} kit${r.moved === 1 ? '' : 's'} moved into your collection.`);
      setImportFrom('');
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (err) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <p className="text-sm text-error max-w-md text-center">{err}</p>
      </div>
    );
  }
  if (personalId == null) {
    return <div className="h-full flex items-center justify-center"><p className="text-sm text-subtext-0">Loading your collection…</p></div>;
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-mantle">
      <div className="shrink-0 px-6 py-2 border-b border-gilt-b bg-base flex items-center gap-2 flex-wrap">
        <span className="text-xs text-subtext-0">
          Your personal collection — independent of any project's lifecycle.
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={importFrom}
            onChange={(e) => setImportFrom(e.target.value ? Number(e.target.value) : '')}
            className="g-field g-field-sm max-w-52 !w-auto"
          >
            <option value="">Move kits from a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button
            onClick={() => void adopt()}
            disabled={importFrom === '' || busy}
            className="g-btn g-btn-pri g-btn-sm"
          >
            {busy ? 'Moving…' : 'Move here'}
          </button>
        </div>
        {msg && <span className="w-full text-xs text-success">{msg}</span>}
      </div>
      <div className="flex-1 min-h-0">
        <ModelsTab key={nonce} projectId={personalId} />
      </div>
    </div>
  );
}
