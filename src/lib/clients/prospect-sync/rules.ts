/*
 * A portal's Prospects, kept in step with the client's campaign (2 Nov 2026 — Eddy: "1. Create campaign when they
 * setup portal 2. Add their selected prospects as leads 3. Have an automation to auto add/remove leads from campaigns
 * as they add/remove/edit their prospects lists on their portal"). The pure rules: whether it runs, for which
 * portals, what a client's first campaign is called, and what Slack is told. No I/O here.
 *
 * The user's decisions (2 Nov): an agent added goes into the client's Prospects campaign (a client with none gets a
 * DRAFT copy of the setup template when it finishes setup — never launched: the client approves its emails first);
 * an agent removed ALWAYS comes out of the client's own campaigns, never another client's; the database's own email,
 * no paid check; no limit on what a client selects at setup.
 */

export type Env = Record<string, string | undefined>;

export const SWITCH_ENV = "OS_PROSPECT_SYNC";
export const FENCE_ENV = "OS_PROSPECT_SYNC_ONLY";

/** "off", or on for this portal — "test" while the fence names test portals, "live" once it names none. */
export type SyncMode = "off" | "test" | "live";

/** The fence: the portals named in OS_PROSPECT_SYNC_ONLY (comma-separated), or null when it is unset or empty. */
export function fence(env: Env = process.env): ReadonlySet<string> | null {
  const raw = (env[FENCE_ENV] ?? "").trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether a portal's Prospects changes go to its campaigns. Off unless OS_PROSPECT_SYNC is exactly "1"; while the
 * fence is set, only its portals, and those as a test (Slack says TEST). The Demo Portal never: its campaigns are
 * nobody's.
 */
export function syncMode(portalId: string, isDemo: boolean, env: Env = process.env): SyncMode {
  if ((env[SWITCH_ENV] ?? "").trim() !== "1" || isDemo) return "off";
  const only = fence(env);
  if (only === null) return "live";
  return only.has(portalId.trim().toLowerCase()) ? "test" : "off";
}

/** An IANA time zone as the team's campaign names write it ("(EST)") — null for one they don't use. */
export function tzLabel(zone: string | null | undefined): string | null {
  const z = (zone ?? "").trim();
  if (!z) return null;
  // Central first: two of Indiana's zones (Knox, Tell_City) are Central, the rest Eastern.
  if (/^America\/(Chicago|Indiana\/(Knox|Tell_City)|Menominee|North_Dakota\/)/.test(z) || z === "US/Central") return "CST";
  if (/^America\/(New_York|Detroit|Indiana\/|Kentucky\/|Toronto)/.test(z) || z === "US/Eastern") return "EST";
  if (/^America\/(Denver|Boise|Phoenix)/.test(z) || z === "US/Mountain" || z === "US/Arizona") return "MST";
  if (/^America\/Los_Angeles/.test(z) || z === "US/Pacific") return "PST";
  return null;
}

/**
 * A client with several MLSs has a campaign per market (Keyes: West and East Florida), so its Prospects go to a campaign
 * per MLS — an agent into the one picked for its MLS (the user, 3 Nov). The MLSs are the agent database's codes, as the
 * portal resolves the client's (crm-preview market-model resolveMls), in the client's order.
 */
export const severalMarkets = (clientCodes: readonly string[]): boolean => clientCodes.length > 1;

export interface CampaignPick { id: string; name: string }

/** os_campaign_list_clients.prospects_by_mls as stored: { "<MLS code>": { id, name } } — anything else left out. */
export function parseByMls(v: unknown): Record<string, CampaignPick> {
  const out: Record<string, CampaignPick> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [code, pick] of Object.entries(v as Record<string, unknown>)) {
    const p = pick as { id?: unknown; name?: unknown } | null;
    const id = typeof p?.id === "string" || typeof p?.id === "number" ? String(p.id).trim() : "";
    if (code.trim() && id) out[code.trim()] = { id, name: typeof p?.name === "string" && p.name.trim() ? p.name.trim() : id };
  }
  return out;
}

/** The agent's MLSs among the client's, in the client's order — the first one with a campaign decides. */
export function agentMarkets(agentCodes: readonly string[], clientCodes: readonly string[]): string[] {
  const mine = new Set(agentCodes);
  return clientCodes.filter((c) => mine.has(c));
}

/**
 * A new client's first campaign: "<Client> + <Market> + Prospects (<TZ>)" — the team's convention (client first, so
 * replies land on its portal and every app gives the campaign to this client), the market its first area (else its
 * MLS codes), the time zone when known.
 */
export function setupCampaignName(client: string, market: { areas?: readonly string[] | null; mls?: readonly string[] | null }, zone: string | null | undefined): string {
  const area = (market.areas ?? []).map((a) => a.trim()).find(Boolean);
  const mls = (market.mls ?? []).map((m) => m.trim()).filter(Boolean);
  const where = area ?? (mls.length ? mls.join(", ") : null);
  const tz = tzLabel(zone);
  return [client.trim(), ...(where ? [where] : []), `Prospects${tz ? ` (${tz})` : ""}`].join(" + ");
}

/** A count in words: "1 agent", "1,204 agents". */
const agents = (n: number) => `${n.toLocaleString("en-US")} agent${n === 1 ? "" : "s"}`;

/** At most this many names in a Slack post; the rest are counted. */
export const SLACK_NAMES = 10;

/**
 * The #portal-update post for a change to a client's Prospects (Eddy, 2 Nov: "setup a slack notification when that
 * happens under the portal-update channel"), in the portal posts' own style. TEST while fenced.
 */
export function prospectsSlackText(o: {
  client: string;
  who: string;
  added: readonly string[];
  removed: readonly string[];
  setup: boolean;
  campaign: string | null;
  test: boolean;
}): string {
  const lines = [`${o.test ? "TEST — " : ""}🎯  *Prospects ${o.setup ? "chosen in setup" : "updated"} — ${o.client}*`];
  const list = (names: readonly string[]) => {
    const shown = names.slice(0, SLACK_NAMES).join(", ");
    return names.length > SLACK_NAMES ? `${shown} and ${(names.length - SLACK_NAMES).toLocaleString("en-US")} more` : shown;
  };
  if (o.added.length) lines.push(`   ➕ ${agents(o.added.length)} added: ${list(o.added)}`);
  if (o.removed.length) lines.push(`   ➖ ${agents(o.removed.length)} removed: ${list(o.removed)}`);
  lines.push(
    o.added.length && o.removed.length ? `   Campaign: added to ${o.campaign ?? "their Prospects campaign"}; the removed ones are taken out of ${o.client}'s campaigns.`
    : o.added.length ? `   Campaign: ${o.campaign ? `added to ${o.campaign}` : `they go into ${o.client}'s Prospects campaign${o.setup ? " (a client with none gets its first one, a draft, when it finishes setup)" : ""}`}.`
    : `   Campaign: taken out of ${o.client}'s campaigns.`,
  );
  lines.push(`   By ${o.who}`);
  return lines.join("\n");
}

/** The #portal-update post when a client's first campaign was made at setup. */
export function setupCampaignSlackText(o: { client: string; campaign: string; agents: number; test: boolean }): string {
  return [
    `${o.test ? "TEST — " : ""}🆕  *First campaign created — ${o.client}*`,
    `   ${o.campaign} (draft — not launched)`,
    `   ${agents(o.agents)} from their setup going in. Write the emails from their offer, get them approved, then launch it.`,
  ].join("\n");
}

/** Queued changes to work off for one portal: the latest wish per agent wins (an add then a remove = a remove). */
export function latestPerAgent<R extends { id: number; agent_id: string }>(rows: readonly R[]): { keep: R[]; superseded: R[] } {
  const last = new Map<string, R>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) last.set(r.agent_id, r);
  const keep = [...last.values()];
  const kept = new Set(keep.map((r) => r.id));
  return { keep, superseded: rows.filter((r) => !kept.has(r.id)) };
}

/** Items in groups of n (EmailBison takes 500 leads a request). */
export function chunks<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
