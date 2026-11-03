import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import DecoHeading from './DecoHeading';

interface ModalProps {
  onClose: () => void;
  /** Rendered as a deco heading at the top, and names the dialog. */
  title?: ReactNode;
  children?: ReactNode;
  /** Extra classes on the panel, e.g. a size: `w-[560px]`, `h-[600px]`. */
  className?: string;
  /** Close when the scrim is clicked (default true). */
  closeOnScrim?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Gilt's modal: a `g-scrim` over the whole window (top bar included) with a
 * `g-modal` panel on top. Closes on Esc, traps Tab focus inside the panel and
 * gives focus back to whatever had it when it closes. */
export default function Modal({ onClose, title, children, className, closeOnScrim = true }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keep the latest onClose without re-running the effect (and re-focusing)
  // on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return createPortal(
    <>
      <div className="g-scrim" aria-hidden="true" onClick={closeOnScrim ? () => onCloseRef.current() : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={className ? `g-modal ${className}` : 'g-modal'}
      >
        {title && (
          <div id={titleId} className="flex-none px-6 pt-6">
            <DecoHeading as="div">{title}</DecoHeading>
          </div>
        )}
        {children}
      </div>
    </>,
    document.body,
  );
}
