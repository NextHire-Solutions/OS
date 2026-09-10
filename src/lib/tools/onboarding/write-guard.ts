/**
 * Which tables Onboarding may write to.
 *
 * Pure and separate from `db.ts` so the rule can be tested: `db.ts` is
 * `server-only`, and a `server-only` import throws under `node --test`. A guard
 * nobody can exercise is a guard nobody knows still works.
 *
 * Ported from the orchestrator's own `lib/supabase.ts`.
 */

export const WRITE_ONLY_PREFIX = "orch_";

export const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

/** Thrown instead of writing, so the caller sees the table it got wrong. */
export class ReadOnlyTableError extends Error {
  readonly table: string;
  readonly method: string;

  constructor(table: string, method: string) {
    super(
      `[read-only guard] Blocked ${method.toUpperCase()} on "${table}". ` +
        `Onboarding may only write to ${WRITE_ONLY_PREFIX}* tables; ` +
        `Agent Search's scraped data is read-only.`,
    );
    this.name = "ReadOnlyTableError";
    this.table = table;
    this.method = method;
  }
}

/** True when writes to this table are permitted. */
export function isWritable(table: string): boolean {
  return table.startsWith(WRITE_ONLY_PREFIX);
}
