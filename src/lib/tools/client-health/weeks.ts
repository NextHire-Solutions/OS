import { addDays, weekKey } from "./derive.ts";

/**
 * The Monday `offset` weeks from `baseKey`, both as YYYY-MM-DD.
 *
 * Pass the bare date: derive.ts reads it as UTC midnight. Appending
 * "T00:00:00" made it LOCAL midnight — Sunday evening UTC for any browser east
 * of UTC — so "previous week" skipped a week in India (found 29 Sep 2026).
 */
export function shiftWeekKey(baseKey: string, offset: number): string {
  return offset === 0 ? baseKey : weekKey(addDays(baseKey, offset * 7));
}
