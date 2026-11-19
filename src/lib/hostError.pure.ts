// Host refusals the client acts on carry a stable code next to the message
// (AppError::Refused on the host: `{ error, code }` over HTTP and from the
// desktop's run_command). Match the code, never the English text.

/** Including a file in the AI overview needs force: it's over the size guard. */
export const AI_FILE_TOO_LARGE = 'AI_FILE_TOO_LARGE';

/** A task save based on an older version was refused (409): the task changed
 * since it was loaded. The error carries the task as it is now (`current`). */
export const TASK_CHANGED = 'TASK_CHANGED';

/** The code of a host error: a DaemonError's `code`, or a local `{ error, code }`. */
export function hostErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** What a conflict carries: the row as it is now (a DaemonError's or a local
 * `{ error, code, current }`'s `current`). */
export function hostErrorCurrent(e: unknown): unknown {
  return e && typeof e === 'object' ? (e as { current?: unknown }).current : undefined;
}

/** A local run_command rejection as message + code (+ a conflict's current row):
 * a string, or `{ error, code, current }`. */
export function localErrorParts(e: unknown): { message: string; code?: string; current?: unknown } | null {
  if (typeof e === 'string') return { message: e };
  if (e && typeof e === 'object' && !(e instanceof Error) && typeof (e as { error?: unknown }).error === 'string') {
    const current = hostErrorCurrent(e);
    return { message: (e as { error: string }).error, code: hostErrorCode(e), ...(current !== undefined ? { current } : {}) };
  }
  return null;
}
