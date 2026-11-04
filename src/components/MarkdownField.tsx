import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import MarkdownPreview from './MarkdownPreview';
import ScrollArea from './ScrollArea';
import { continueList, indentLines, type TextEdit } from '../lib/listEdit.pure';
import { SIDE_BY_SIDE_MIN, clampDrag, fieldHeight, parseHeight } from '../lib/composer.pure';

// Cosmetic, per-device preferences (TAB_SPEC: ok in localStorage). One
// remembered height serves every composer.
const HEIGHT_KEY = 'ganban:composer-height';
const PREVIEW_KEY = 'ganban:composer-preview';

/** Touch screens get 44px targets. */
export const TOUCH = '[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]';

/** A markdown text field with a formatting toolbar and a live (render-as-you-type)
 * preview. Used for comments and other markdown input so formatting is visible
 * immediately instead of as raw asterisks.
 *
 * The field grows with its text up to about 60% of the window, then scrolls;
 * its handle drags a height of your own (double-click resets it). The preview
 * sits beside the text when the field is wide and under it when narrow, and
 * can be hidden. Both choices are remembered on this device. */
export default function MarkdownField({
  value,
  onChange,
  placeholder,
  rows = 4,
  autoFocus,
  disabled,
  onPaste,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  const [manual, setManual] = useState<number | null>(() => parseHeight(localStorage.getItem(HEIGHT_KEY)));
  const [showPreview, setShowPreview] = useState(() => localStorage.getItem(PREVIEW_KEY) !== 'off');
  const drag = useRef<{ y: number; h: number; to: number | null } | null>(null);

  const hasText = value.trim().length > 0;
  const previewOn = showPreview && hasText;
  const side = previewOn && width >= SIDE_BY_SIDE_MIN;

  // The composer's own width (not the window's) decides side by side.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Size the field to its text: at least the default rows (or the dragged
  // height), at most the cap, then it scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const floor = rows * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = `${Math.round(manual ?? floor)}px`;
    el.style.height = `${fieldHeight({ content: el.scrollHeight, floor, manual, viewport: viewportH })}px`;
  }, [value, manual, rows, width, side, viewportH]);

  // The window's height moves the cap.
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const saveHeight = (h: number | null) => {
    if (h == null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, String(h));
  };

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    drag.current = { y: e.clientY, h: el.offsetHeight, to: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.to = clampDrag(d.h + e.clientY - d.y, window.innerHeight);
    setManual(d.to);
  };
  const onHandleUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.to != null) saveHeight(d.to);
  };
  const resetHeight = () => {
    setManual(null);
    saveHeight(null);
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const h = clampDrag(el.offsetHeight + (e.key === 'ArrowDown' ? 24 : -24), window.innerHeight);
      setManual(h);
      saveHeight(h);
    } else if (e.key === 'Escape' || e.key === 'Home') {
      e.preventDefault();
      resetHeight();
    }
  };

  const togglePreview = () => {
    localStorage.setItem(PREVIEW_KEY, showPreview ? 'off' : 'on');
    setShowPreview(!showPreview);
  };

  /** Wrap the current selection (or caret) in before/after markers. */
  const surround = (before: string, after = before) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, e + before.length);
    });
  };

  /** Prefix the caret's line (for lists / quotes). */
  const prefixLine = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + prefix.length, s + prefix.length);
    });
  };

  /** Apply a list edit and put the selection where it says. */
  const apply = (edit: TextEdit | null) => {
    const el = ref.current;
    if (!el || !edit) return false;
    onChange(edit.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.start, edit.end);
    });
    return true;
  };

  /** Indent (1) or outdent (-1) the selected list items. */
  const indent = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) apply(indentLines(value, el.selectionStart, el.selectionEnd, dir));
  };

  // Tab / Shift+Tab indent list items (elsewhere Tab still moves focus); Enter
  // continues a list.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.currentTarget;
    const edit =
      e.key === 'Tab'
        ? indentLines(value, el.selectionStart, el.selectionEnd, e.shiftKey ? -1 : 1)
        : e.key === 'Enter' && !e.shiftKey
          ? continueList(value, el.selectionStart, el.selectionEnd)
          : null;
    if (apply(edit)) e.preventDefault();
  };

  const Btn = ({ label, title, onClick }: { label: string; title: string; onClick: () => void }) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      className={`min-w-[32px] h-8 px-1.5 text-xs rounded text-subtext-0 hover:bg-surface-0 hover:text-text disabled:opacity-50 ${TOUCH}`}
    >
      {label}
    </button>
  );

  const preview = (
    <>
      <div className="g-flbl">Preview</div>
      <MarkdownPreview content={value} className="text-sm" />
    </>
  );

  return (
    <div ref={wrap} className={side ? 'grid grid-cols-2 gap-3' : 'space-y-2'}>
      <div className="min-w-0 rounded-[3px] border border-surface-1 bg-mantle focus-within:border-gold transition-colors">
        <div className="flex items-center flex-wrap gap-0.5 border-b border-gilt-b px-1 py-0.5">
          <Btn label="B" title="Bold" onClick={() => surround('**')} />
          <Btn label="I" title="Italic" onClick={() => surround('*')} />
          <Btn label="</>" title="Code" onClick={() => surround('`')} />
          <Btn label="🔗" title="Link" onClick={() => surround('[', '](url)')} />
          <Btn label="•" title="Bullet list" onClick={() => prefixLine('- ')} />
          <Btn label="“”" title="Quote" onClick={() => prefixLine('> ')} />
          <Btn label="⇥" title="Indent list item (Tab)" onClick={() => indent(1)} />
          <Btn label="⇤" title="Outdent list item (Shift+Tab)" onClick={() => indent(-1)} />
          <button
            type="button"
            onClick={togglePreview}
            aria-pressed={showPreview}
            title={showPreview ? 'Hide the preview' : 'Show the preview'}
            className={`ml-auto h-8 px-2 text-xs rounded hover:bg-surface-0 hover:text-text ${
              showPreview ? 'text-gold' : 'text-subtext-0'
            } ${TOUCH}`}
          >
            {showPreview ? '◉' : '○'} Preview
          </button>
        </div>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={rows}
          autoFocus={autoFocus}
          disabled={disabled}
          className="block w-full px-3 py-2.5 bg-transparent focus:outline-none text-text placeholder:text-overlay-0 resize-none font-mono text-sm leading-relaxed"
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the text field (double-click resets)"
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onLostPointerCapture={onHandleUp}
          onDoubleClick={resetHeight}
          onKeyDown={onHandleKey}
          className="group flex items-center justify-center h-3 [@media(pointer:coarse)]:h-11 cursor-ns-resize touch-none rounded-b-[3px] border-t border-gilt-b hover:bg-surface-0 focus-visible:outline-none focus-visible:bg-surface-0"
        >
          <span className="block w-10 h-[3px] rounded-full bg-surface-1 group-hover:bg-gold group-focus-visible:bg-gold" aria-hidden="true" />
        </div>
      </div>
      {previewOn &&
        (side ? (
          // Beside the text: as tall as the field, scrolling inside.
          <div className="relative min-w-0 min-h-0">
            <ScrollArea className="!absolute inset-0 g-inset !p-0" contentClassName="px-3.5 py-3">
              {preview}
            </ScrollArea>
          </div>
        ) : (
          <div className="g-inset !px-3.5 !py-3">{preview}</div>
        ))}
    </div>
  );
}
