import { useMemo } from 'react';
import MarkdownPreview from './MarkdownPreview';

/** What the manifest knows about a document — the "inference" half. */
export interface DocInference {
  format?: string;
  size_bytes?: number;
  domains?: string[];
  ingested_at?: string;
}

/** Split a corpus document into its frontmatter facts and the body. The
 * frontmatter is ragrat provenance (source, format, category, tags) — useful
 * as chips, unreadable as a wall of YAML on top of the content. */
function splitFrontmatter(content: string): { facts: [string, string][]; body: string } {
  if (!content.startsWith('---\n')) return { facts: [], body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { facts: [], body: content };
  const head = content.slice(4, end);
  const body = content.slice(content.indexOf('\n', end + 4) + 1);
  const facts: [string, string][] = [];
  for (const line of head.split('\n')) {
    // top-level "key: value" only — nested tag maps stay out of the chips
    const m = /^([A-Za-z_][\w-]*):\s*(.+)$/.exec(line);
    if (m) facts.push([m[1], m[2].replace(/^"|"$/g, '')]);
  }
  return { facts, body };
}

/** The Atlas document reader: provenance + analysis status up top, the
 * normalized content RENDERED below (it used to be a raw <pre> dump). */
export default function AtlasDocReader({
  source,
  content,
  inference,
  onBack,
  backLabel,
}: {
  source: string;
  content: string;
  inference?: DocInference;
  onBack: () => void;
  backLabel: string;
}) {
  const { facts, body } = useMemo(() => splitFrontmatter(content), [content]);
  const name = source.split('/').pop() ?? source;
  const figureMentions = useMemo(
    () => (body.match(/<!-- image -->/g) ?? []).length,
    [body]
  );

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-2 pb-2 shrink-0">
        <button onClick={onBack} className="g-btn g-btn-ghost g-btn-sm shrink-0">
          ‹ {backLabel}
        </button>
        <span className="text-[15px] font-semibold text-text truncate" title={source}>
          {name}
        </span>
      </div>

      {/* Inference card: what the librarian knows about this document */}
      <div className="g-plain px-3 py-2 mb-3 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="g-tag g-tag-ok">✓ analysed</span>
          {inference?.ingested_at && (
            <span className="g-tag">
              {new Date(inference.ingested_at).toLocaleDateString()}
            </span>
          )}
          {facts
            .filter(([k]) => k !== 'source')
            .map(([k, v]) => (
              <span key={k} className="g-tag">
                {k}: {v}
              </span>
            ))}
          {inference?.size_bytes != null && (
            <span className="g-tag">
              {(inference.size_bytes / 1024).toFixed(0)} KB
            </span>
          )}
          {(inference?.domains ?? []).map((d) => (
            <span key={d} className="g-tag g-tag-pri">
              {d}
            </span>
          ))}
          {figureMentions > 0 && (
            <span className="g-tag g-tag-warn" title="Image placeholders without a vision description — re-ingest with the vision model to fill them.">
              {figureMentions} undescribed figure{figureMentions === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* The document itself — rendered, readable, scrolls on its own */}
      <div className="g-card g-corners flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <div className="max-w-[72ch] mx-auto">
          <MarkdownPreview content={body} />
        </div>
      </div>
    </div>
  );
}
