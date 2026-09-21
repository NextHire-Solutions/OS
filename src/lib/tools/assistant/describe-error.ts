/*
 * A database error, in words.
 *
 * `String(err)` on a PostgREST error object is "[object Object]" — so every
 * tool that said `could not be read: ${String(error)}` was returning a
 * sentence with no information in it, to a model whose whole job is to explain
 * what went wrong. The failures worth reading are exactly the ones this hid:
 * "invalid input value for enum reminder_status" is the difference between a
 * five-minute fix and a shrug.
 */
export function describeDbError(error: unknown): string {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [e.message, e.details, e.hint].filter((p): p is string => typeof p === "string" && p.length > 0);
    if (parts.length) return `${parts.join(" — ")}${e.code ? ` (${String(e.code)})` : ""}`;
    try {
      return JSON.stringify(error);
    } catch {
      return "unreadable error object";
    }
  }
  return String(error);
}
