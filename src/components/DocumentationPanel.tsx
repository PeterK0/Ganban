import { useState } from 'react';
import MarkdownPreview from './MarkdownPreview';
import { DOC_PAGES } from '../docs';

/** In-app documentation: a list of bundled help pages + the rendered page.
 * Rendered in Settings → Documentation, and reused as the welcome project's
 * content for new users. Pure reading — no daemon, works offline. */
export default function DocumentationPanel({ initialId }: { initialId?: string }) {
  const [id, setId] = useState(initialId && DOC_PAGES.some((p) => p.id === initialId) ? initialId : DOC_PAGES[0]?.id);
  const page = DOC_PAGES.find((p) => p.id === id) ?? DOC_PAGES[0];

  return (
    <div className="flex gap-4 min-h-0">
      {DOC_PAGES.length > 1 && (
        <nav className="shrink-0 w-52 space-y-1">
          {DOC_PAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => setId(p.id)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                p.id === page?.id ? 'bg-surface-2 text-text' : 'text-subtext-1 hover:bg-surface-1 hover:text-text'
              }`}
            >
              <div className="text-sm font-medium">{p.title}</div>
              <div className="text-[11px] text-subtext-0 leading-tight mt-0.5">{p.blurb}</div>
            </button>
          ))}
        </nav>
      )}
      <div className="flex-1 min-w-0">
        {page && <MarkdownPreview content={page.content} className="max-w-2xl" />}
      </div>
    </div>
  );
}
