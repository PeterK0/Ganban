// A tiny in-memory ring buffer of recent client-side errors, for the bug
// reporter (Settings → Report a bug). Captures window errors, unhandled
// promise rejections, and console.error/warn — plus anything code reports via
// `logClientError`. Never persisted, never auto-sent; the user copies/saves it.

export interface ClientLogEntry {
  t: string; // ISO timestamp
  level: 'error' | 'warn';
  message: string;
  stack?: string;
}

const CAP = 200;
const buffer: ClientLogEntry[] = [];
let installed = false;

function push(level: ClientLogEntry['level'], message: string, stack?: string) {
  buffer.push({
    t: new Date().toISOString(),
    level,
    message: redact(message).slice(0, 2000),
    stack: stack ? redact(stack).slice(0, 4000) : undefined,
  });
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

/** Report a caught error with a short context label (e.g. "chat send"). */
export function logClientError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  push('error', `[${context}] ${message}`, err instanceof Error ? err.stack : undefined);
}

/** A snapshot of the buffer (newest last). */
export function getClientLog(): ClientLogEntry[] {
  return buffer.slice();
}

export function clearClientLog(): void {
  buffer.length = 0;
}

function fmt(a: unknown): string {
  if (a instanceof Error) {
    // WebKit's (Safari, WKWebView) `stack` lists frames only, without the
    // message, so a report read "DaemonError@…" and never said why. Lead with
    // the name, message and, for host errors, the status and code.
    const e = a as Error & { status?: number; code?: string };
    const extra = [e.status != null ? `status ${e.status}` : '', e.code ? `code ${e.code}` : ''].filter(Boolean).join(', ');
    const head = `${e.name}: ${e.message}${extra ? ` (${extra})` : ''}`;
    return e.stack && !e.stack.includes(e.message) ? `${head}\n${e.stack}` : e.stack || head;
  }
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Strip obvious secrets (bearer tokens, long high-entropy keys) before a log
 * line is ever stored — defense-in-depth mirroring the server-side redaction. */
function redact(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1‹redacted›')
    .replace(/\b[A-Za-z0-9._-]{28,}\b/g, (w) => (/[A-Za-z]/.test(w) && /[0-9]/.test(w) ? '‹redacted›' : w));
}

/** Install global capture once. Safe to call multiple times. */
export function installErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    push('error', e.message || 'window error', e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    push(
      'error',
      r instanceof Error ? r.message : `unhandled rejection: ${String(r)}`,
      r instanceof Error ? r.stack : undefined,
    );
  });

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      push('error', args.map(fmt).join(' '));
    } catch {
      /* never let capture break logging */
    }
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    try {
      push('warn', args.map(fmt).join(' '));
    } catch {
      /* ignore */
    }
    origWarn(...args);
  };
}
