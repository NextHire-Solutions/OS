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
/** BrokerStaffer's own record lists every MLS it recruits in (the user, 3 Nov) — a sanity ceiling only (the agent database has 55). */
export const MAX_ITEMS_HOUSE = 500;
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

/** Check and tidy a change. Only the keys present are changed. `house`: BrokerStaffer's own record — no 40-MLS limit. */
export function cleanCoverage(input: { markets?: unknown; mls?: unknown; areas?: unknown }, opts: { house?: boolean } = {}):
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
    const max = key === "mls" && opts.house ? MAX_ITEMS_HOUSE : MAX_ITEMS;
    if (list.length > max) problems.push(`${label} can list at most ${max}.`);
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

/*
 * THE AREA FOR EACH MLS (os_clients.mls_areas, migration 0056 — the client's
 * request: "a field to the client's Record tab to configure the area name
 * associated with each MLS"). { "<MLS as the client's list spells it>": "<area>" }.
 * A client with several MLSs gets a campaign per MLS; its {CLIENT_AREA} is that
 * MLS's area. Paired only where someone sets it — the lists above stay as they are.
 */
export type MlsAreas = Record<string, string>;

/** An MLS code compared as the agent database matches one: case and punctuation aside ("MLS PIN" = "mlspin"). */
export const mlsKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Check and tidy the whole map. Only MLSs on the client's list are kept (spelt as the list spells them); a blank area
 * removes that MLS's entry.
 */
export function cleanMlsAreas(input: unknown, mls: readonly string[]): { value: MlsAreas; problems: string[] } {
  const problems: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { value: {}, problems: ["Area for each MLS must be a list of MLS and area pairs."] };
  const value: MlsAreas = {};
  for (const [code, raw] of Object.entries(input as Record<string, unknown>)) {
    const own = mls.find((m) => mlsKey(m) === mlsKey(code));
    if (!own) { problems.push(`${code.slice(0, 40)} isn't one of this client's MLSs.`); continue; }
    if (raw !== null && raw !== undefined && typeof raw !== "string") { problems.push(`The area for ${own} must be text.`); continue; }
    const area = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (area.length > MAX_ITEM_LENGTH) { problems.push(`The area for ${own} is longer than ${MAX_ITEM_LENGTH} characters.`); continue; }
    if (area) value[own] = area;
  }
  return { value, problems };
}

/** The area set for this MLS (its code or the client's spelling of it), or null. */
export function areaForMls(map: MlsAreas | null | undefined, code: string | null | undefined): string | null {
  if (!map || !code) return null;
  const k = mlsKey(code);
  if (!k) return null;
  for (const [m, area] of Object.entries(map)) if (mlsKey(m) === k && typeof area === "string" && area.trim()) return area.trim();
  return null;
}

/**
 * The area for a campaign's MLS code as the agent database spells it (os_setup_campaigns.mls_code is its canonical
 * code), when the client's list spells it by an alias ("Bright" for "BRIGHTMLS"): matched through the MLS rows.
 */
export function areaForMlsCode(
  map: MlsAreas | null | undefined,
  code: string | null | undefined,
  rows: ReadonlyArray<{ code: string; aliases: string[] | null }> = [],
): string | null {
  const direct = areaForMls(map, code);
  if (direct || !map || !code) return direct;
  const k = mlsKey(code);
  const row = rows.find((r) => mlsKey(r.code) === k || (r.aliases ?? []).some((a) => mlsKey(a) === k));
  if (!row) return null;
  const names = new Set([row.code, ...(row.aliases ?? [])].map(mlsKey).filter(Boolean));
  for (const [m, area] of Object.entries(map)) if (names.has(mlsKey(m)) && typeof area === "string" && area.trim()) return area.trim();
  return null;
}

/** A stored map, read defensively (anything that isn't { text: text } is dropped). */
export function readMlsAreas(v: unknown): MlsAreas {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: MlsAreas = {};
  for (const [k, a] of Object.entries(v as Record<string, unknown>)) if (typeof a === "string" && a.trim()) out[k] = a.trim();
  return out;
}
