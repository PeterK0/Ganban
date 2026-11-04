// Host refusals the client acts on carry a stable code next to the message
// (AppError::Refused on the host: `{ error, code }` over HTTP and from the
// desktop's run_command). Match the code, never the English text.

/** Including a file in the AI overview needs force: it's over the size guard. */
export const AI_FILE_TOO_LARGE = 'AI_FILE_TOO_LARGE';

/** The code of a host error: a DaemonError's `code`, or a local `{ error, code }`. */
export function hostErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** A local run_command rejection as message + code: a string, or `{ error, code }`. */
export function localErrorParts(e: unknown): { message: string; code?: string } | null {
  if (typeof e === 'string') return { message: e };
  if (e && typeof e === 'object' && !(e instanceof Error) && typeof (e as { error?: unknown }).error === 'string') {
    return { message: (e as { error: string }).error, code: hostErrorCode(e) };
  }
  return null;
}
