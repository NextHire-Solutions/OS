/*
 * Several inbox pools at once (13 Oct: "allow us to select multiple groups of
 * inboxes when adding or removing").
 *
 * The dialog used to hold exactly one tag. Assigning "Zapmail" and "Nicole
 * Pool" to a campaign was two trips through it, and removing three pools three.
 *
 * Pure, so the arithmetic is tested without EmailBison:
 *
 *   · POOLS OVERLAP. An inbox carries several tags — its vendor and its pool —
 *     so "LeadGenJay" and "Nicole Pool" share most of their inboxes. Everything
 *     the dialog says ("N inboxes will start sending") is counted over the
 *     UNION of the ticked pools, never the sum of their sizes.
 *   · The write itself stays one pool at a time, in the order listed, through
 *     the same function that has always done it (inbox-assignment.ts). An inbox
 *     in two ticked pools is simply found "already on the campaign" by the
 *     second — an outcome that function already treats as success — and a
 *     remove only ever sends ids the campaign still holds.
 *   · One pool failing says nothing about the others: each pool's outcome is
 *     kept, and a campaign is "ok" only if every pool went through for it.
 */

/** Most pools one request may name. Far more than the estate has; a bound, not a target. */
export const MAX_POOLS = 20;

/** Trimmed, blanks dropped, one of each (exact — "Nicole Pool" is not "Nicole Pool 2"), capped. */
export function cleanPools(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const tag = t.trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_POOLS) break;
  }
  return out;
}

export function togglePool(picked: readonly string[], tag: string): string[] {
  return picked.includes(tag) ? picked.filter((t) => t !== tag) : cleanPools([...picked, tag]);
}

/** Each id once, across every list. */
export function unionIds<T extends string | number>(lists: ReadonlyArray<readonly T[]>): T[] {
  return [...new Set(lists.flat())];
}

export interface PoolPreview {
  /** Inboxes the write would send: connected ones on an attach, every tagged one on a remove. */
  willSend: number;
  /** Tagged but not connected — left out of an attach. */
  dead: number;
  /** Of `willSend`, how many are already on the campaign. Null when that is not known. */
  onAlready: number | null;
  /** What would actually change. Equals `willSend` when `onAlready` is not known. */
  changes: number;
}

/*
 * What ticking these pools would do, counted over their union.
 *
 * `assigned` is the campaign's current inbox ids — known only for a single
 * EmailBison campaign; null otherwise, and then nothing is claimed about what
 * is "already on".
 *
 * A REMOVE only changes what the campaign holds, so with `assigned` known its
 * `changes` is the overlap, not the pool size.
 */
export function poolPreview(input: {
  action: "attach" | "remove";
  all: readonly number[];
  connected: readonly number[];
  assigned: readonly number[] | null;
}): PoolPreview {
  const all = new Set(input.all);
  const connected = new Set(input.connected);
  const pool = input.action === "attach" ? connected : all;
  const dead = [...all].filter((id) => !connected.has(id)).length;
  if (!input.assigned) return { willSend: pool.size, dead, onAlready: null, changes: pool.size };
  const have = new Set(input.assigned);
  const onAlready = [...pool].filter((id) => have.has(id)).length;
  return {
    willSend: pool.size,
    dead,
    onAlready,
    changes: input.action === "attach" ? pool.size - onAlready : onAlready,
  };
}

export interface PoolResult {
  campaignId: string;
  platform: "emailbison" | "instantly";
  name: string;
  ok: boolean;
  applied: number;
  alreadyAttached?: number;
  error?: string;
}

export interface PoolSummary {
  batchId: string;
  tag: string;
  action: "attach" | "remove";
  inboxes: number;
  skippedDisconnected: number;
  results: PoolResult[];
}

export interface PoolsSummary {
  /** The first pool, so a caller written for one pool still reads a tag. */
  tag: string;
  tags: string[];
  action: "attach" | "remove";
  /** Distinct inboxes across the pools where known, else the sum of the pools. */
  inboxes: number;
  skippedDisconnected: number;
  /** One row per campaign: ok only if every pool went through for it. */
  results: PoolResult[];
  /** Each pool's own outcome, in the order they ran. */
  pools: PoolSummary[];
}

/** One summary for several pools run one after another. */
export function mergeAssignments(
  action: "attach" | "remove",
  pools: readonly PoolSummary[],
  /** Distinct counts over the union, when the caller could work them out. */
  distinct?: { inboxes: number; skippedDisconnected: number } | null,
): PoolsSummary {
  const byCampaign = new Map<string, PoolResult>();
  for (const pool of pools) {
    for (const r of pool.results) {
      const key = `${r.platform}:${r.campaignId}`;
      const hit = byCampaign.get(key);
      if (!hit) {
        byCampaign.set(key, { ...r, error: r.error ? `${pool.tag}: ${r.error}` : undefined });
        continue;
      }
      hit.ok = hit.ok && r.ok;
      hit.applied += r.applied;
      if (r.alreadyAttached != null) hit.alreadyAttached = (hit.alreadyAttached ?? 0) + r.alreadyAttached;
      if (r.error) hit.error = [hit.error, `${pool.tag}: ${r.error}`].filter(Boolean).join(" · ");
    }
  }
  return {
    tag: pools[0]?.tag ?? "",
    tags: pools.map((p) => p.tag),
    action,
    inboxes: distinct ? distinct.inboxes : pools.reduce((t, p) => t + p.inboxes, 0),
    skippedDisconnected: distinct ? distinct.skippedDisconnected : pools.reduce((t, p) => t + p.skippedDisconnected, 0),
    results: [...byCampaign.values()],
    pools: [...pools],
  };
}

/** "Zapmail", "Zapmail and Nicole Pool", "Zapmail, Nicole Pool and 2 more". */
export function poolNames(tags: readonly string[]): string {
  if (tags.length <= 1) return tags[0] ?? "";
  if (tags.length === 2) return `${tags[0]} and ${tags[1]}`;
  if (tags.length === 3) return `${tags[0]}, ${tags[1]} and ${tags[2]}`;
  return `${tags[0]}, ${tags[1]} and ${tags.length - 2} more`;
}
