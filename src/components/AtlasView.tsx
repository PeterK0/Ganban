import { useState } from 'react';
import AtlasPanel from './AtlasPanel';
import AtlasLibrary from './AtlasLibrary';
import AtlasFilesTab from './AtlasFilesTab';
import AtlasModels from './AtlasModels';
import { TabIcon, type TabIconName } from './icons/TabIcon';

type AtlasTab = 'knowledge' | 'library' | 'files' | 'models';
const TABS: { id: AtlasTab; label: string; icon: TabIconName }[] = [
  { id: 'knowledge', label: 'Knowledge', icon: 'map' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'models', label: 'My Models', icon: 'cube' },
];

/** Atlas as a tab host (phase 1): the workspace-level
 * surface for everything that belongs to YOU rather than to a project.
 * Knowledge = the collection browser (Epoch I, unchanged); Library = managed
 * document folders with on-demand indexing; Files = cross-project review;
 * My Models = a personal tab instance whose data lives in a hidden per-user
 * container project — immune to any project's lifecycle (Phase 2b). */
export default function AtlasView({ manage = true }: { manage?: boolean }) {
  const [tab, setTab] = useState<AtlasTab>('knowledge');
  return (
    <div className="h-full flex flex-col bg-mantle text-text">
      <header className="shrink-0 bg-mantle border-b border-gilt-b px-8 pt-6">
        <h1 className="g-ptitle text-text">Atlas</h1>
        <nav className="mt-3 -mx-4 flex items-center overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`min-h-[42px] px-4 inline-flex items-center whitespace-nowrap text-sm font-medium transition-colors shrink-0 ${
              tab === t.id ? 'text-gold shadow-[inset_0_-2px_0_var(--color-gold)]' : 'text-[color:var(--g-fg2)] hover:text-text'
            }`}
          >
            <TabIcon name={t.icon} className="w-4 h-4 mr-2" />
            {t.label}
          </button>
        ))}
        </nav>
      </header>
      <div className="flex-1 min-h-0">
        {tab === 'knowledge' && <AtlasPanel manage={manage} />}
        {tab === 'library' && <AtlasLibrary />}
        {tab === 'files' && <AtlasFilesTab />}
        {tab === 'models' && <AtlasModels />}
      </div>
    </div>
  );
}
