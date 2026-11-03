import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'katex/dist/katex.min.css';
import { getDaemonFileBlob } from '../lib/daemon';

// KaTeX renders to spans (with class/style) plus MathML; the default sanitize
// schema strips all of it. Run rehype-katex BEFORE sanitize and widen the schema
// to permit exactly KaTeX's output (class/style + the MathML tag set).
const KATEX_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'style'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'style'],
    path: ['d'],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'msup', 'msub',
    'msubsup', 'mfrac', 'msqrt', 'mroot', 'munder', 'mover', 'munderover', 'mtable',
    'mtr', 'mtd', 'mspace', 'mpadded', 'mphantom', 'menclose', 'mstyle', 'annotation',
    'annotation-xml', 'mlabeledtr', 'mglyph', 'svg', 'path', 'line', 'g',
  ],
};
import { customEmojiUrl } from '../lib/emoji';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  /** Called when a user clicks a `/files/<id>` link (a non-image reference to an
   * attached file). When unset, such links fall back to opening in a new tab.
   * Image refs (`![...](/files/<id>)`) are handled by DaemonImage, not this. */
  onFileOpen?: (attachmentId: number) => void;
}

/** Render a markdown image. External URLs (Giphy, etc.) and data/blob URLs load
 * directly; a daemon-hosted file ref (`/files/<id>`) is fetched with auth
 * (mobile/web) or read locally (desktop) into an object URL — a plain <img>
 * can't carry the Bearer token. */
function DaemonImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setUrl(src);
      return;
    }
    const m = src.match(/\/files\/(\d+)/);
    if (!m) {
      setUrl(src);
      return;
    }
    let active = true;
    let obj: string | null = null;
    setUrl(null);
    getDaemonFileBlob(Number(m[1]))
      .then((blob) => {
        if (!active) return;
        obj = URL.createObjectURL(blob);
        setUrl(obj);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [src]);

  if (failed) return <span className="text-xs text-error">[image unavailable]</span>;
  if (!url) return <span className="text-xs text-subtext-0">[image…]</span>;
  return <img src={url} alt={alt ?? ''} loading="lazy" className="rounded max-w-full max-h-80 my-2 border border-gilt-b" />;
}

// Hoisted + stable across renders. Recreating this object (and re-parsing the
// markdown) on every parent render made daemon images re-mount and refetch —
// the comment-page "flash + scroll to top" with gifs/images.
//
// NOTE: `a` is built per-MarkdownPreview call (not hoisted) so it can close over
// the optional `onFileOpen` callback — the only component that needs per-instance
// state. The rest are pure renderers and stay hoisted.
function buildComponents(onFileOpen?: (id: number) => void): Components {
  return {
  a: ({ node, ...props }: any) => {
    const href: string = props.href ?? '';
    // A link to /files/<id> is an in-app file reference. When the caller wired
    // onFileOpen, intercept the click and navigate within the app instead of
    // opening a broken new-tab URL (the webview has no /files/<id> route).
    const m = href.match(/^\/files\/(\d+)$/);
    if (m && onFileOpen) {
      return (
        <a
          {...props}
          href={undefined}
          onClick={(e) => { e.preventDefault(); onFileOpen(Number(m[1])); }}
          className="text-primary hover:underline break-all cursor-pointer"
        />
      );
    }
    return <a {...props} className="text-primary hover:underline break-all" target="_blank" rel="noopener noreferrer" />;
  },
  // Images: a custom-emoji marker (alt "emoji:<name>") renders as a small inline
  // image resolved from the JS emoji map; pasted/shared files load with auth;
  // GIFs/URLs load directly.
  img: ({ node, ...props }: any) => {
    const alt: string = props.alt ?? '';
    if (alt.startsWith('emoji:')) {
      const name = alt.slice(6);
      const url = customEmojiUrl(name);
      return url ? (
        <img src={url} alt={`:${name}:`} title={`:${name}:`} className="inline-block align-text-bottom" style={{ height: '1.35em', width: 'auto', margin: '0 1px' }} />
      ) : (
        <span>:{name}:</span>
      );
    }
    return <DaemonImage src={props.src} alt={props.alt} />;
  },
  code: ({ node, ...props }: any) =>
    props.inline ? (
      <code {...props} className="bg-surface-0 text-text px-1 py-0.5 rounded text-[0.9em]" />
    ) : (
      <code {...props} className="block bg-mantle border border-surface-0 text-text p-3 rounded text-sm overflow-x-auto" />
    ),
  // Markers hang in the padding, so a nested list (inside an <li>) is indented
  // a level. Tailwind's preflight zeroes list padding, and there's no
  // typography plugin behind `prose`.
  ul: ({ node, ...props }: any) => <ul {...props} className="list-disc pl-5 space-y-1 text-text [&_ul]:list-[circle] [&_ul]:mt-1 [&_ol]:mt-1" />,
  ol: ({ node, ...props }: any) => <ol {...props} className="list-decimal pl-5 space-y-1 text-text [&_ul]:mt-1 [&_ol]:mt-1" />,
  h1: ({ node, ...props }: any) => <h1 {...props} className="text-2xl font-bold text-text mt-4 mb-2 leading-snug" />,
  h2: ({ node, ...props }: any) => <h2 {...props} className="text-xl font-bold text-text mt-3 mb-2 leading-snug" />,
  h3: ({ node, ...props }: any) => <h3 {...props} className="text-lg font-semibold text-text mt-2 mb-1" />,
  p: ({ node, ...props }: any) => <p {...props} className="text-text mb-2.5 last:mb-0 leading-[1.7]" />,
  blockquote: ({ node, ...props }: any) => (
    <blockquote {...props} className="border-l-2 border-gold pl-4 italic text-subtext-1 my-2" />
  ),
  table: ({ node, ...props }: any) => (
    <div className="overflow-x-auto">
      <table {...props} className="min-w-full border-collapse border border-gilt-b text-text" />
    </div>
  ),
  th: ({ node, ...props }: any) => (
    <th {...props} className="border border-gilt-b bg-mantle px-4 py-2 text-left font-semibold" />
  ),
  td: ({ node, ...props }: any) => <td {...props} className="border border-gilt-b px-4 py-2" />,
  hr: ({ node, ...props }: any) => <hr {...props} className="border-gilt-b my-4" />,
  };
}

function MarkdownPreview({ content, className = '', onFileOpen }: MarkdownPreviewProps) {
  // Hold the callback in a ref so the `components` object can be built ONCE and
  // stay stable across re-renders, even if the caller passes a fresh inline
  // arrow each render. A new `components` object makes ReactMarkdown re-parse
  // and remount every DaemonImage — the "image flashes/reloads on every
  // keystroke" bug. The ref always reads the latest callback (the standard
  // latest-callback pattern), so onFileOpen identity churn never reaches the
  // markdown tree.
  const cbRef = useRef(onFileOpen);
  cbRef.current = onFileOpen;
  const components = useMemo(
    () => buildComponents((id: number) => cbRef.current?.(id)),
    [],
  );
  return (
    <div className={`prose prose-sm max-w-[72ch] prose-invert break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }], [rehypeSanitize, KATEX_SCHEMA]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Re-renders only when content/className change, so a comment's images don't
// reload when the surrounding list re-renders for unrelated reasons.
export default memo(MarkdownPreview);
