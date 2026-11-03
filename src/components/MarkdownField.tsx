import { useRef } from 'react';
import MarkdownPreview from './MarkdownPreview';
import { continueList, indentLines, type TextEdit } from '../lib/listEdit.pure';

/** A markdown text field with a formatting toolbar and a live (render-as-you-type)
 * preview. Used for comments and other markdown input so formatting is visible
 * immediately instead of as raw asterisks. */
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
      className="min-w-[32px] h-8 px-1.5 text-xs rounded text-subtext-0 hover:bg-surface-0 hover:text-text disabled:opacity-50"
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="rounded-[3px] border border-surface-1 bg-mantle focus-within:border-gold transition-colors">
      <div className="flex items-center flex-wrap gap-0.5 border-b border-gilt-b px-1 py-0.5">
        <Btn label="B" title="Bold" onClick={() => surround('**')} />
        <Btn label="I" title="Italic" onClick={() => surround('*')} />
        <Btn label="</>" title="Code" onClick={() => surround('`')} />
        <Btn label="🔗" title="Link" onClick={() => surround('[', '](url)')} />
        <Btn label="•" title="Bullet list" onClick={() => prefixLine('- ')} />
        <Btn label="“”" title="Quote" onClick={() => prefixLine('> ')} />
        <Btn label="⇥" title="Indent list item (Tab)" onClick={() => indent(1)} />
        <Btn label="⇤" title="Outdent list item (Shift+Tab)" onClick={() => indent(-1)} />
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
        className="block w-full px-3 py-2.5 bg-transparent rounded-b-[3px] focus:outline-none text-text placeholder:text-overlay-0 resize-none font-mono text-sm leading-relaxed"
      />
      </div>
      {value.trim() && (
        <div className="g-inset !px-3.5 !py-3">
          <div className="g-flbl">Preview</div>
          <MarkdownPreview content={value} className="text-sm" />
        </div>
      )}
    </div>
  );
}
