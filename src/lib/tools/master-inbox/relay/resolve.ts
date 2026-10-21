import { matchScore, tokenize } from "../clients/derive.ts";

/*
 * Which brokerage a conversation belongs to — from the CAMPAIGN the agent
 * replied to, never from the sender inbox (plan §4: "Our sender inboxes are
 * shared across brokerages, so the brokerage is taken from the campaign").
 * Pure: the caller loads the rows.
 *
 * In order, the first that answers wins:
 *
 *   1. the team's answer for this campaign, given on the held list
 *      (os_relay_campaigns) — or "not a brokerage campaign";
 *   2. the campaign's portal chosen in the OS for multi-portal clients
 *      (os_campaign_portals, 0025);
 *   3. the campaign NAME, matched to a portal exactly as Master Inbox files a
 *      reply (derive.ts's own tokenize/matchScore), then that portal to its
 *      client record. Stricter than the inbox in one way: a tie between two
 *      different clients is HELD, where the inbox takes whichever came first.
 *
 * Then a cross-check: the conversation is filed under a portal too (the
 * inbox's own guess, or a person's move). If that portal belongs to another
 * client, the two disagree and the conversation is HELD for the team rather
 * than sent to either. "Unknown" (and no portal at all) disagree with nobody.
 */

export interface PortalRow {
  id: string;
  name: string;
  slug?: string | null;
  aliases?: string[] | null;
}

export interface OsClientRef {
  id: string;
  name: string;
  aliases: string[];
  miClientId: string | null;
}

export interface CampaignPortalRow {
  platform: string;
  campaignId: string;
  osClientId: string;
  miClientId: string;
}

export interface TeamCampaignRow {
  platform: string;
  campaignId: string;
  osClientId: string | null;
  ignored: boolean;
}

export interface World {
  portals: PortalRow[];
  clients: OsClientRef[];
  campaignPortals: CampaignPortalRow[];
  teamCampaigns: TeamCampaignRow[];
}

export interface ThreadCampaign {
  platform: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** threads.client_id — the Master Inbox portal the conversation is filed under. */
  threadPortalId: string | null;
}

export type ResolvedBy = "team" | "campaign_portal" | "campaign_name";

export type Resolution =
  | { ok: true; osClientId: string; portalId: string | null; source: ResolvedBy }
  | {
      ok: false;
      outcome: "hold" | "skip";
      reason: "no_campaign" | "unknown_campaign" | "ambiguous_campaign" | "campaign_conflict" | "ignored_campaign" | "no_roster_record";
      detail?: string;
    };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** How a campaign is keyed on the held list: its id, or its name when the conversation has no id. */
export function campaignKey(c: Pick<ThreadCampaign, "platform" | "campaignId" | "campaignName">): { platform: string; campaignId: string } | null {
  const platform = (c.platform ?? "").trim() || "unknown";
  const id = (c.campaignId ?? "").trim();
  if (id) return { platform, campaignId: id };
  const name = (c.campaignName ?? "").trim();
  return name ? { platform, campaignId: `name:${name.toLowerCase()}` } : null;
}

function isUnknownPortal(p: PortalRow | undefined): boolean {
  return !!p && ((p.slug ?? "") === "unknown" || norm(p.name) === "unknown");
}

/** The client record a portal belongs to: its link, a campaign → portal choice, or its exact name/alias. */
export function osClientForPortal(portalId: string, world: World): string | null {
  const linked = world.clients.filter((c) => c.miClientId === portalId);
  if (linked.length === 1) return linked[0].id;
  if (linked.length > 1) return null;
  const viaRoute = [...new Set(world.campaignPortals.filter((r) => r.miClientId === portalId).map((r) => r.osClientId))];
  if (viaRoute.length === 1) return viaRoute[0];
  const portal = world.portals.find((p) => p.id === portalId);
  const want = norm(portal?.name);
  if (!want) return null;
  const byName = world.clients.filter((c) => [c.name, ...c.aliases].some((n) => norm(n) === want));
  return byName.length === 1 ? byName[0].id : null;
}

/** Every portal (Master Inbox client row) that belongs to a client record. */
export function portalsOfClient(osClientId: string, world: World): string[] {
  const client = world.clients.find((c) => c.id === osClientId);
  if (!client) return [];
  const out = new Set<string>();
  if (client.miClientId) out.add(client.miClientId);
  for (const r of world.campaignPortals) if (r.osClientId === osClientId) out.add(r.miClientId);
  const names = new Set([client.name, ...client.aliases].map(norm).filter(Boolean));
  for (const p of world.portals) if (names.has(norm(p.name))) out.add(p.id);
  return [...out];
}

/** The best-matching portals for a campaign name, ties included. */
export function portalsByCampaignName(campaignName: string, portals: PortalRow[]): { score: number; portals: PortalRow[] } {
  const tokens = tokenize(campaignName);
  let best = 0;
  let hits: PortalRow[] = [];
  for (const p of portals) {
    if (isUnknownPortal(p)) continue;
    let score = 0;
    for (const raw of [p.name, ...(p.aliases ?? [])]) {
      if (raw) score = Math.max(score, matchScore(tokenize(raw), tokens));
    }
    if (score <= 0) continue;
    if (score > best) {
      best = score;
      hits = [p];
    } else if (score === best) {
      hits.push(p);
    }
  }
  return { score: best, portals: hits };
}

export function resolveBrokerage(thread: ThreadCampaign, world: World): Resolution {
  const key = campaignKey(thread);
  // No campaign id AND no name: nothing to place it by, and nothing the team could assign.
  if (!key) return { ok: false, outcome: "skip", reason: "no_campaign" };

  let found: { osClientId: string; portalId: string | null; source: ResolvedBy } | null = null;

  const team = world.teamCampaigns.find((t) => t.platform === key.platform && t.campaignId === key.campaignId);
  if (team?.ignored) return { ok: false, outcome: "skip", reason: "ignored_campaign" };
  if (team?.osClientId && world.clients.some((c) => c.id === team.osClientId)) {
    found = { osClientId: team.osClientId, portalId: null, source: "team" };
  }

  if (!found && thread.campaignId) {
    const route = world.campaignPortals.find((r) => r.platform === key.platform && r.campaignId === key.campaignId);
    if (route && world.clients.some((c) => c.id === route.osClientId)) {
      found = { osClientId: route.osClientId, portalId: route.miClientId, source: "campaign_portal" };
    }
  }

  if (!found) {
    const name = (thread.campaignName ?? "").trim();
    if (!name) return { ok: false, outcome: "hold", reason: "unknown_campaign", detail: "no campaign name" };
    const { portals } = portalsByCampaignName(name, world.portals);
    if (!portals.length) return { ok: false, outcome: "hold", reason: "unknown_campaign" };
    const owners = [...new Set(portals.map((p) => osClientForPortal(p.id, world)))];
    if (owners.length > 1) {
      return { ok: false, outcome: "hold", reason: "ambiguous_campaign", detail: portals.map((p) => p.name).join(" / ") };
    }
    if (!owners[0]) return { ok: false, outcome: "hold", reason: "no_roster_record", detail: portals[0].name };
    const preferred = portals.find((p) => p.id === thread.threadPortalId) ?? portals[0];
    found = { osClientId: owners[0], portalId: preferred.id, source: "campaign_name" };
  }

  /*
   * The cross-check against where the conversation is filed — but not of the
   * team's own answer (21 Oct review): that answer is how a conflict is
   * settled, and checking it against the filing again held it forever.
   */
  const filed = thread.threadPortalId;
  const filedPortal = filed ? world.portals.find((p) => p.id === filed) : undefined;
  if (filed && !isUnknownPortal(filedPortal)) {
    const mine = portalsOfClient(found.osClientId, world);
    if (mine.includes(filed)) {
      if (!found.portalId) found.portalId = filed;
    } else if (found.source !== "team") {
      const other = osClientForPortal(filed, world);
      const otherName = (other && world.clients.find((c) => c.id === other)?.name) || filedPortal?.name || "another portal";
      return { ok: false, outcome: "hold", reason: "campaign_conflict", detail: otherName };
    }
  }
  if (!found.portalId) found.portalId = world.clients.find((c) => c.id === found!.osClientId)?.miClientId ?? null;

  return { ok: true, ...found };
}
