/*
 * WHAT A CLIENT COVERS — Markets, MLS and Area, as the client data sheet has
 * them (30 Sep):
 *
 *   Markets  how many markets — a number ("6")
 *   MLS      the MLS boards — a list of codes ("CANOPY, realMLS, GGAR")
 *   Area     the areas — a list of names ("Jacksonville, Charleston, …")
 *
 * Three independent facts, not paired rows: a client can cover 6 markets
 * across 7 areas and 5 boards, and nothing here pretends otherwise.
 * Pure, so the rules are tested without a database.
 */

export interface Coverage {
  markets: number | null;
  mls: string[];
  areas: string[];
}

export const EMPTY_COVERAGE: Coverage = { markets: null, mls: [], areas: [] };

export const MAX_ITEMS = 40;
export const MAX_ITEM_LENGTH = 120;

/** A list from an array or from comma-separated text; trimmed, blanks and repeats (any case) dropped. */
export function cleanList(input: unknown): string[] {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out: string[] = [];
  for (const p of parts) {
    const v = String(p ?? "").trim().replace(/\s+/g, " ");
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/** Check and tidy a change. Only the keys present are changed. */
export function cleanCoverage(input: { markets?: unknown; mls?: unknown; areas?: unknown }):
  { value: Partial<Coverage>; problems: string[] } {
  const value: Partial<Coverage> = {};
  const problems: string[] = [];
  if (input.markets !== undefined) {
    if (input.markets === null || input.markets === "") value.markets = null;
    else {
      const n = Number(input.markets);
      if (!Number.isInteger(n) || n < 0 || n > 999) problems.push("Markets must be a whole number from 0 to 999.");
      else value.markets = n;
    }
  }
  for (const [key, label] of [["mls", "MLS"], ["areas", "Area"]] as const) {
    if (input[key] === undefined) continue;
    const list = cleanList(input[key]);
    if (list.length > MAX_ITEMS) problems.push(`${label} can list at most ${MAX_ITEMS}.`);
    const long = list.find((v) => v.length > MAX_ITEM_LENGTH);
    if (long) problems.push(`${label} “${long.slice(0, 30)}…” is longer than ${MAX_ITEM_LENGTH} characters.`);
    value[key] = list;
  }
  return { value, problems };
}

/** "BRIGHT, CVR · greater Richmond" — how coverage reads on one line. Null when empty. */
export function coverageLine(c: Coverage | null | undefined): string | null {
  if (!c) return null;
  const parts = [c.mls.join(", "), c.areas.join(", ")].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export const hasCoverage = (c: Coverage | null | undefined) =>
  !!c && (c.markets !== null || c.mls.length > 0 || c.areas.length > 0);
