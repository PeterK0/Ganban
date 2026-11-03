/**
 * Shared touch-first UI primitives for the mobile app, in Gilt (docs/dev/GILT.md):
 * the shared g- classes at touch size (44px targets), plus a few gm-
 * helpers in ./mobile.css. Everything uses the theme's variables, so the
 * mobile UI follows the desktop theme and theme switching.
 */
import { type ReactNode, useEffect, useState, useRef } from "react";
import type { TaskStatus, TaskPriority } from "../types";
import { TopBar } from "./nav";
import "./mobile.css";

export const TASK_STATUSES: TaskStatus[] = ["To Do", "In Progress", "Done", "Blocked"];
export const TASK_PRIORITIES: TaskPriority[] = ["Low", "Medium", "High"];

export function statusColor(status: string): string {
  switch (status) {
    case "In Progress":
      return "bg-[color:var(--g-org)]"; // Gilt's in-progress orange, as g-st-progress
    case "Done":
      return "bg-success";
    case "Blocked":
      return "bg-error";
    default:
      return "bg-overlay-0";
  }
}

export function priorityClasses(priority: string): string {
  switch (priority) {
    case "High":
      return "g-tag-hi";
    case "Low":
      return "";
    default:
      return "g-tag-warn";
  }
}

// ---- Layout ----

/** Full-screen scroll view with a sticky Gilt header (./nav TopBar). Use for every screen. */
export function Screen({
  title,
  onBack,
  right,
  children,
  subtitle,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-mantle text-text">
      <TopBar title={title} subtitle={subtitle} onBack={onBack} right={right} />
      <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-10 text-gold">
      <span className="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 px-6 text-center">
      <span className="g-gem opacity-70" aria-hidden="true" />
      <p className="gm-mut">{text}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="m-3 rounded bg-error/10 border border-error/40 text-error text-sm pl-3 pr-1 py-1 min-h-[44px] flex items-center justify-between gap-3">
      <span className="min-w-0 break-words py-1.5">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 underline min-h-[44px] px-3">
          Retry
        </button>
      )}
    </div>
  );
}

/** A 44px square icon button for a header's right slot. */
export function IconBtn({
  onClick,
  label,
  children,
  disabled,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} className="g-iconbtn w-11 h-11 text-xl active:bg-surface-0">
      {children}
    </button>
  );
}

export function RefreshBtn({ onClick }: { onClick: () => void }) {
  return (
    <IconBtn onClick={onClick} label="Refresh">
      ↻
    </IconBtn>
  );
}

/** A section heading: a gold deco title after a diamond (or `mark`), a gilt hairline to the right. */
export function SectionHeader({ children, right, mark }: { children: ReactNode; right?: ReactNode; mark?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 pt-5 pb-2 min-h-[44px]">
      <h2 className="g-deco flex items-center gap-2 text-[12px] font-semibold text-gold shrink-0 pt-0.5" style={{ letterSpacing: "0.2em" }}>
        {mark ?? <span className="g-gem w-1.5 h-1.5" aria-hidden="true" />}
        {children}
      </h2>
      <span className="flex-1 h-px bg-gilt-b" aria-hidden="true" />
      {right}
    </div>
  );
}

// ---- Buttons ----

type BtnVariant = "primary" | "ghost" | "danger" | "surface" | "gilt";

/** A Gilt button (g-btn) at touch size. */
export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
}) {
  const styles: Record<BtnVariant, string> = {
    primary: "g-btn-pri active:bg-primary-hover",
    surface: "active:bg-surface-1",
    ghost: "g-btn-ghost active:bg-surface-0",
    danger: "g-btn-danger",
    gilt: "g-btn-gilt active:bg-gilt-b",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`g-btn ${styles[variant]} min-h-[44px] py-2 text-[15px] whitespace-normal text-center ${full ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}

/** The floating add button: a primary Gilt square with a gold outline. It sits
 * in the screen's area (absolute, not fixed), so the bars between the screen and
 * the tab bar (the running timer, the app-update banner) push it up instead of
 * hiding under it. */
export function Fab({ onClick, label = "Add" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="g-btn g-btn-pri absolute right-5 bottom-5 z-20 w-14 h-14 p-0 rounded-2xl text-3xl font-light leading-none shadow-lg outline outline-1 outline-offset-[3px] outline-gilt-a active:bg-primary-hover"
    >
      +
    </button>
  );
}

// ---- Lists ----

/** A list row like the prototype's task rows: a gilt hairline under it, a gold chevron when it opens something. */
export function ListRow({
  title,
  subtitle,
  left,
  right,
  onClick,
  onDelete,
  deleteLabel = "Delete",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  return (
    <div className="flex items-stretch border-b border-gilt-b">
      <button onClick={onClick} className="flex-1 flex items-center gap-3 px-4 py-2.5 min-h-[56px] text-left active:bg-surface-0 min-w-0">
        {left}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium truncate text-text">{title}</div>
          {subtitle && <div className="text-[13px] gm-mut truncate">{subtitle}</div>}
        </div>
        {right}
        {onClick && <Chevron />}
      </button>
      {onDelete && (
        <button onClick={onDelete} aria-label={deleteLabel} className="min-w-[48px] px-4 text-error active:bg-surface-0">
          ✕
        </button>
      )}
    </div>
  );
}

/** The row chevron, in muted gold. */
export function Chevron() {
  return (
    <svg viewBox="0 0 24 24" className="shrink-0 w-4 h-4 text-gold/60" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A pill (g-tag). A className adds a g-tag- variant or replaces its colours. */
export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`g-tag shrink-0 ${className}`}>{children}</span>;
}

/** A small diamond marker in the given background colour. */
export function Dot({ className }: { className: string }) {
  return <span className={`shrink-0 inline-block w-2 h-2 rotate-45 ${className}`} aria-hidden="true" />;
}

// ---- Bottom sheet ----

/** A bottom sheet on a g-scrim (a centred dialog from 700px wide), in the g-card look. */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="g-scrim z-30 flex flex-col justify-end min-[700px]:justify-center min-[700px]:items-center min-[700px]:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="g-card g-corners text-text rounded-b-none border-b-0 max-h-[92vh] w-full flex flex-col min-[700px]:max-w-[600px] min-[700px]:rounded min-[700px]:border-b"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pl-5 pr-3 pt-2 pb-1.5 border-b border-gilt-b">
          <h3 className="g-deco text-[13px] font-semibold text-gold truncate pt-0.5">{title}</h3>
          <button onClick={onClose} className="gm-mut min-h-[44px] px-3 active:opacity-60">
            Close
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gilt-a bg-mantle space-y-2">{footer}</div>}
      </div>
    </div>
  );
}

// ---- Form fields ----

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="g-flbl">{label}</span>
      {children}
    </label>
  );
}

/** The Gilt field (g-field) at touch size; size it with the gm-field variants (mobile.css), which outrank utilities. */
export const inputClass = "g-field gm-field";

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  inputMode?: "text" | "url" | "numeric" | "decimal" | "email" | "tel";
}) {
  return (
    <input
      type={props.type ?? "text"}
      inputMode={props.inputMode}
      value={props.value}
      autoFocus={props.autoFocus}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      autoCapitalize={props.type === "url" || props.inputMode === "url" ? "off" : undefined}
      autoCorrect={props.type === "url" || props.inputMode === "url" ? "off" : undefined}
      className={inputClass}
    />
  );
}

export function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  onPaste?: (e: any) => void;
}) {
  return (
    <textarea
      value={props.value}
      rows={props.rows ?? 4}
      onChange={(e) => props.onChange(e.target.value)}
      onPaste={props.onPaste}
      placeholder={props.placeholder}
      className={inputClass}
    />
  );
}

/** Segmented control / chip group for choosing one option (Gilt chips: the pick is gold). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns = 2,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  columns?: number;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((opt) => (
        <button key={opt} type="button" onClick={() => onChange(opt)} aria-pressed={value === opt} className="gm-chip">
          {opt}
        </button>
      ))}
    </div>
  );
}

/** A switch row (g-tog): label left, switch right, the whole row the target. */
export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-full flex items-center justify-between gap-3 min-h-[48px] py-1 text-left"
      type="button"
      role="switch"
      aria-checked={value}
    >
      <span className="text-sm gm-fg2">{label}</span>
      <span className="g-tog" aria-checked={value} aria-hidden="true">
        <span className="g-tog-k" />
      </span>
    </button>
  );
}

/** A native <select> in the Gilt field look; handy for long option lists. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        const match = options.find((o) => String(o.value) === raw);
        if (match) onChange(match.value);
      }}
      className={inputClass}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---- Data loading hook ----

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Run an async loader, exposing data/loading/error + a reload(). Also answers
 * the host's freshness pulse (see Shell) with a SILENT background re-run: data
 * is replaced when the new copy arrives, with no loading flip — so screens
 * stay fresh without spinner flashes, and edit forms (which seed local state
 * once, on mount) are never clobbered. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [bgNonce, setBgNonce] = useState(0);
  // Epoch guard: a bg reload started under old deps (e.g. the calendar's
  // previous period) must not overwrite data the primary effect fetched for
  // the new deps. The primary effect bumps the epoch; stale bg results drop.
  const epoch = useRef(0);

  useEffect(() => {
    const h = () => setBgNonce((n) => n + 1);
    window.addEventListener('ganban:data-changed', h);
    return () => window.removeEventListener('ganban:data-changed', h);
  }, []);

  useEffect(() => {
    if (bgNonce === 0) return;
    const myEpoch = epoch.current;
    let cancelled = false;
    loader()
      .then((d) => {
        if (!cancelled && epoch.current === myEpoch) setData(d);
      })
      .catch(() => {
        /* silent — transient staleness beats an error banner over good data */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgNonce]);

  useEffect(() => {
    epoch.current += 1; // invalidate any in-flight background reload
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Format a duration in seconds as `H:MM`. */
export function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Convert a `<input type="date">` value ("yyyy-mm-dd") to an ISO timestamp at
 * LOCAL midnight — matching the desktop event editor, so dates round-trip in the
 * user's timezone instead of shifting a day across UTC.
 */
export function dateInputToIso(s: string): string | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).toISOString();
}

/** Inverse of dateInputToIso: ISO -> "yyyy-mm-dd" using LOCAL date parts. */
export function isoToDateInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
