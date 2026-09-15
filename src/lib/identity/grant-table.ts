// Relative with the extension, not the "@/" alias: the store's tests run under
// `node --test`, which resolves neither.
import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

/*
 * Reading tool grants from the os_tool_grants table.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * store.ts was written against a GrantStore interface with a documented plan:
 * "the env-backed one ships today; the Postgres one lands later and brings the
 * admin UI." This is that Postgres side. Until it existed, the Team access
 * screen could only PRINT the BS_GRANTS value for someone to paste into
 * Railway and redeploy — nobody without deploy access could grant a colleague
 * a tool.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND DOES NOT OWN
 *
 * It owns TOOL ACCESS only — which of the five tools an address that can
 * already sign in gets to see. It does NOT own who may sign in or their
 * password; those stay in AUTH_USERS, the allow-list only a Railway operator
 * edits. So this table can never widen the set of people with access, only
 * narrow or shape what each existing person sees.
 *
 * A row's absence is meaningful and distinct from an empty row:
 *   · no row      → this address is not governed here; fall back to BS_GRANTS
 *                    (or, when that too is unset, the bootstrap fail-open).
 *   · empty tools → governed, and granted nothing. A deliberate lockout.
 */

export type GrantRow = { email: string; tools: ToolId[] };

/** Keep only real tool ids, so a stray value in the table grants nothing. */
export function coerceStoredTools(raw: unknown): ToolId[] {
  if (!Array.isArray(raw)) return [];
  const claimed = raw.map((t) => String(t).trim().toLowerCase());
  return ALL_TOOLS.filter((t) => claimed.includes(t));
}

/** Normalise a table read into a Map keyed by lowercased email. */
export function indexGrantRows(rows: Array<{ email?: unknown; tools?: unknown }>): Map<string, ToolId[]> {
  const out = new Map<string, ToolId[]>();
  for (const r of rows) {
    const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
    if (!email) continue;
    out.set(email, coerceStoredTools(r.tools));
  }
  return out;
}
