// A pinned tab in its own OS window (the pin's "Open in new window"). Booted by main.tsx
// for ?pane=tab&ws=..&project=..&tab=..[&sub=..]: the project page alone, opened at that
// tab. Transport comes from the shared localStorage like every extra window; the main
// window made the pin's workspace the active one before opening this.

import { useEffect, useState } from 'react';
import ThemeProvider from '../components/ThemeProvider';
import ProjectView from '../components/ProjectView';
import { isWebClient } from '../lib/daemon';
import { getActiveWorkspaceId, getWorkspace } from '../lib/workspaces';
import { wsGetProjects } from '../lib/workspaceData';
import { useAppStore } from '../store/appStore';
import { applySubView, labelOf, usePins } from '../store/pins';
import { useTitleBarInset } from '../lib/titleBar';

const ACTIVE_KEY = 'ganban-active-workspace';

export default function PinnedTabWindow({ ws, projectId, tab, sub }: { ws: string; projectId: number; tab: string; sub: string | null }) {
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  // Another window switched the shared transport to another workspace: this window would
  // be talking to the wrong host.
  const [elsewhere, setElsewhere] = useState(false);
  const catalog = usePins((s) => s.catalog);
  const titleInset = useTitleBarInset();

  useEffect(() => {
    void usePins.getState().loadCatalog();
    void usePins.getState().load(); // so the tab strip's pin control knows what's pinned
    const host = getWorkspace(ws);
    if (!host) {
      setState('missing');
      return;
    }
    void wsGetProjects(host)
      .then((list) => {
        const project = list.find((p) => p.id === projectId);
        if (!project) return setState('missing');
        applySubView(tab, sub);
        usePins.getState().setOpenIntent({ projectKey: `${ws}:${projectId}`, tab, remount: false });
        useAppStore.getState().selectProject(project);
        setState('ready');
      })
      .catch(() => setState('missing'));
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVE_KEY || e.key === null) setElsewhere(getActiveWorkspaceId() !== ws);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ws, projectId, tab, sub]);

  const project = useAppStore((s) => s.selectedProject);
  useEffect(() => {
    if (!project) return;
    const title = `${labelOf({ ws, project: projectId, tab, sub, position: 0 }, catalog)} \u2014 ${project.name}`;
    document.title = title;
    if (isWebClient()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(title);
      } catch {
        /* non-fatal */
      }
    })();
  }, [project?.name, catalog, ws, projectId, tab, sub]);

  return (
    <ThemeProvider>
      <div className="h-screen w-screen bg-mantle text-text flex flex-col min-h-0 min-w-0 overflow-hidden">
        {/* macOS overlays the title bar: a strip to move the window by, clear of
            the traffic lights. Other platforms keep their native title bar. */}
        {titleInset > 0 && (
          <div className="flex-none h-[44px] flex items-center justify-center px-4 bg-crust border-b border-gilt-b text-[13px] text-subtext-0 truncate" data-tauri-drag-region>
            {project?.name ?? ''}
          </div>
        )}
        {elsewhere ? (
          <div className="flex-1 grid place-items-center p-8">
            <p className="max-w-sm text-center text-sm text-subtext-0">
              Another window switched to a project on a different host. Close this window and open the pin again.
            </p>
          </div>
        ) : state === 'missing' ? (
          <div className="flex-1 grid place-items-center p-8">
            <p className="text-sm text-subtext-0">This project isn't available (deleted, or its host can't be reached).</p>
          </div>
        ) : state === 'ready' ? (
          <ProjectView />
        ) : null}
      </div>
    </ThemeProvider>
  );
}
