// The optional knowledge engine (ragrat) behind Atlas, the AI overview and project indexing.
// Without it those calls fail; these pieces let a screen say "not set up" calmly instead.

import { useEffect, useState, type ReactNode } from 'react';
import { getKnowledgeEngineSetUp, hasDaemon, KNOWLEDGE_ENGINE_CHANGED } from '../lib/daemon';
import { hasHostControls } from '../lib/shell';
import { openSettings } from '../lib/settingsNav';
import { TabIcon, type TabIconName } from './icons/TabIcon';

// One question per page, shared by every screen that asks; asked again after an AI Engines change.
let answer: Promise<boolean> | null = null;
const ask = () =>
  (answer ??= getKnowledgeEngineSetUp().catch((e) => {
    answer = null;
    throw e;
  }));

/** Whether the host has the knowledge engine set up: `null` while unknown (still asking,
 * no host, or a host too old to say), so callers keep their old behaviour then. */
export function useKnowledgeEngine(): boolean | null {
  const [setUp, setSetUp] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hasDaemon()) return;
    let live = true;
    // A failed ask keeps the last answer.
    const update = () => void ask().then((v) => live && setSetUp(v), () => {});
    const changed = () => {
      answer = null;
      update();
    };
    update();
    window.addEventListener(KNOWLEDGE_ENGINE_CHANGED, changed);
    return () => {
      live = false;
      window.removeEventListener(KNOWLEDGE_ENGINE_CHANGED, changed);
    };
  }, []);
  return setUp;
}

/** Where to set it up: a link on the machine that has the AI Engines section, words elsewhere. */
export function KnowledgeEngineSettingsLink({ className = 'g-lnk !px-0 !min-h-0' }: { className?: string }) {
  if (hasHostControls()) {
    return (
      <button onClick={() => openSettings('connections')} className={className}>
        Settings → AI Engines
      </button>
    );
  }
  return <span className="text-text">Settings → AI Engines in the desktop app on the host</span>;
}

/** The calm empty state of a screen that needs the knowledge engine. */
export function KnowledgeEngineEmpty({ icon, title, children }: { icon: TabIconName; title: string; children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center p-8 bg-mantle">
      <div className="max-w-md text-center">
        <TabIcon name={icon} className="w-10 h-10 mx-auto mb-4 text-[color:var(--g-mut)]" />
        <p className="g-h2">{title}</p>
        <div className="text-sm text-[color:var(--g-fg2)] space-y-2">{children}</div>
        {hasHostControls() ? (
          <button onClick={() => openSettings('connections')} className="g-btn g-btn-ghost mt-5">
            Open Settings → AI Engines
          </button>
        ) : (
          <p className="text-xs text-[color:var(--g-mut)] mt-4">
            It's set up in Settings → AI Engines, in the desktop app on the host.
          </p>
        )}
      </div>
    </div>
  );
}
