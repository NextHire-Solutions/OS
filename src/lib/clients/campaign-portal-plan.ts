/*
 * Which portal a campaign's leads go to — the pure rules (1 Oct).
 *
 * Only clients with MORE THAN ONE portal get a decision; a client with one
 * portal needs none. The automatic choice is made once per campaign and saved
 * (os_campaign_portals, source 'auto'); a person can change it afterwards
 * (source 'manual'), and a saved choice is never re-decided.
 *
 * THE AUTOMATIC RULE. A portal of a multi-portal client is named for its
 * market: "Properties & Estates Boston", "Properties & Estates Florida". The
 * words a portal's name has beyond the client's own name are its market
 * words ("boston", "florida"). In order:
 *
 *   1. the one portal whose market words appear in the campaign's name —
 *      "… Rutenberg 1 + South Florida …" → Florida;
 *   2. otherwise, the portal the campaign's replies already go to, so a
 *      campaign that is routed correctly today stays put (SERHANT. PA's
 *      "BRIGHT 10M+" feeds the 15M+ portal);
 *   3. otherwise, today's name guess, if it names one of this client's portals;
 *   4. otherwise the client's main portal (the one the record is linked to).
 */

export interface PortalRef {
  id: string;
  name: string;
}

export function tokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** A portal's market words: its name's words that the client's own names do not have. */
export function marketWords(portalName: string, clientNames: string[]): string[] {
  const own = new Set(clientNames.flatMap(tokens));
  return [...new Set(tokens(portalName).filter((t) => !own.has(t)))];
}

export interface AutoChoice {
  portalId: string;
  /** Why, in words the record can show. */
  reason: string;
}

export interface AutoHints {
  /** The portal most of this campaign's existing replies are in. */
  replies?: string | null;
  /** What the name guess (Master Inbox's derive) would pick today. */
  guess?: string | null;
}

export function autoPortal(
  campaignName: string | null | undefined,
  portals: PortalRef[],
  clientNames: string[],
  mainPortalId: string,
  hints: AutoHints = {},
): AutoChoice {
  const main = portals.find((p) => p.id === mainPortalId) ?? portals[0];
  const words = new Set(tokens(campaignName));
  let best: { portal: PortalRef; hits: string[] } | null = null;
  let tie = false;
  for (const p of portals) {
    const hits = marketWords(p.name, clientNames).filter((w) => words.has(w));
    if (!hits.length) continue;
    if (!best || hits.length > best.hits.length) { best = { portal: p, hits }; tie = false; }
    else if (hits.length === best.hits.length) tie = true;
  }
  if (best && !tie) return { portalId: best.portal.id, reason: `the campaign name mentions “${best.hits.join(" ")}”` };
  const mine = (id: string | null | undefined) => (id ? portals.find((p) => p.id === id) : undefined);
  const replies = mine(hints.replies);
  if (replies) return { portalId: replies.id, reason: "its replies already go there" };
  const guess = mine(hints.guess);
  if (guess) return { portalId: guess.id, reason: "that is where its replies would go today" };
  return { portalId: main.id, reason: tie ? "the name matches more than one portal, so the main portal" : "no market in the name, so the main portal" };
}

/** The portal most of a campaign's replies are in, or null when it has none. */
export function majority(portalIds: (string | null)[]): string | null {
  const n = new Map<string, number>();
  for (const id of portalIds) if (id) n.set(id, (n.get(id) ?? 0) + 1);
  let best: string | null = null, max = 0;
  for (const [id, c] of n) if (c > max) { best = id; max = c; }
  return best;
}
