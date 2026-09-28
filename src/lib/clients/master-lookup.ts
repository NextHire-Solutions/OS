import "server-only";

import { osTable } from "./os-db";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import type { ClientStatus } from "./client-status";

/*
 * THE MASTER RECORD, LOOKED UP FROM ANY TOOL'S ROW.
 *
 * §5 and §7 of the architecture document: every tool shows the fields relevant
 * to it, "pulling those fields from the same underlying client record". The
 * tool views did not. Each read its own table — Onboarding's Salesperson came
 * from the Onboarding tool's copy, Client Health tagged an onboarding client
 * as active from its own booleans — so a field set once in the OS never
 * reached them, and most of what looked like "missing data" was data sitting
 * in the master record that no view read.
 *
 * One lookup, keyed by each tool's own row id (the links os_clients already
 * records), so every view reads the same facts the same way. The tool's own
 * copy remains the fallback where a view had one, never the other way round.
 *
 * Cached briefly: several views call this on one page load, and a status
 * change should show within seconds, not after a deploy.
 */

export type ToolKey = "masterInbox" | "clientHealth" | "analytics" | "database";

export interface MasterMarket {
  market: string;
  mls: string | null;
  area: string | null;
}

export interface MasterFacts {
  id: string;
  name: string;
  /** Other names this client goes by — how a second portal finds its client. */
  aliases: string[];
  status: ClientStatus;
  salesperson: string | null;
  accountManager: string | null;
  sender: string | null;
  contactName: string | null;
  contactEmail: string | null;
  brokerage: string | null;
  markets: MasterMarket[];
  /** When the client was added to the master record. */
  createdAt: string | null;
  /** When the current status was set (status history), or null. */
  statusSince: string | null;
  links: { masterInbox: string | null; clientHealth: string | null; analytics: string | null; database: string | null };
}

/** "Boston · MLS PIN, Florida" — how a client's markets read on one line. */
export function marketsLine(markets: MasterMarket[]): string | null {
  if (!markets.length) return null;
  return markets.map((m) => [m.market, m.mls].filter(Boolean).join(" · ")).join(", ");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function loadAll(): Promise<MasterFacts[]> {
  const [clients, markets, history] = await Promise.all([
    osTable("os_clients").select(
      "id, name, aliases, status, salesperson, account_manager, sender_name, contact_name, contact_email, " +
        "brokerage, created_at, mi_client_id, ch_client_id, an_client_id, orch_client_id",
    ),
    osTable("os_client_markets").select("client_id, market, mls, area"),
    osTable("os_client_status_history").select("os_client_id, changed_at").order("changed_at", { ascending: false }),
  ]);
  if (clients.error) throw new Error(`os_clients: ${clients.error.message}`);

  const byClient = new Map<string, MasterMarket[]>();
  for (const m of ((markets.data ?? []) as unknown as { client_id: string; market: string; mls: string | null; area: string | null }[])) {
    const list = byClient.get(m.client_id) ?? [];
    list.push({ market: m.market, mls: m.mls, area: m.area });
    byClient.set(m.client_id, list);
  }
  const since = new Map<string, string>();
  for (const h of ((history.data ?? []) as unknown as { os_client_id: string; changed_at: string }[])) {
    if (!since.has(h.os_client_id)) since.set(h.os_client_id, h.changed_at); // newest first
  }

  return ((clients.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).map(String) : [],
    status: (r.status as ClientStatus) ?? "active",
    salesperson: str(r.salesperson),
    accountManager: str(r.account_manager),
    sender: str(r.sender_name),
    contactName: str(r.contact_name),
    contactEmail: str(r.contact_email),
    brokerage: str(r.brokerage),
    markets: byClient.get(String(r.id)) ?? [],
    createdAt: str(r.created_at),
    statusSince: since.get(String(r.id)) ?? null,
    links: {
      masterInbox: str(r.mi_client_id),
      clientHealth: str(r.ch_client_id),
      analytics: str(r.an_client_id),
      database: str(r.orch_client_id),
    },
  }));
}

const cachedAll = ttlCache(loadAll, { ttlMs: 15_000, key: () => "all" });

/** Every master record, keyed by the given tool's own row id. */
export async function masterByToolId(tool: ToolKey): Promise<Map<string, MasterFacts>> {
  const all = await cachedAll();
  const out = new Map<string, MasterFacts>();
  for (const f of all) {
    const id = f.links[tool];
    if (id) out.set(id, f);
  }
  return out;
}

/**
 * The master record for a tool row that may not be linked by id — a client's
 * SECOND portal ("Properties & Estates Florida") is linked only through the
 * client's aliases. Id first, then the name or any alias, normalised the way
 * the status feed matches portals, so both agree on which client a row is.
 */
export function resolveByIdOrName(
  byId: Map<string, MasterFacts>,
  all: MasterFacts[],
  rowId: string,
  rowName: string,
): MasterFacts | null {
  const hit = byId.get(rowId);
  if (hit) return hit;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = norm(rowName);
  if (!key) return null;
  const matches = all.filter((f) => [f.name, ...f.aliases].some((n) => norm(n) === key));
  // Ambiguous names are not guessed — same rule as the status feed.
  return matches.length === 1 ? matches[0] : null;
}

/** Every master record, as a list. */
export async function masterAll(): Promise<MasterFacts[]> {
  return cachedAll();
}

/** Every master record, keyed by the master id. */
export async function masterById(): Promise<Map<string, MasterFacts>> {
  return new Map((await cachedAll()).map((f) => [f.id, f]));
}

/*
 * A portal's team, agents and do-not-contact list, counted per Master Inbox
 * client — §8 lists all three for the Portal and Onboarding views.
 *
 * PAGED: these tables hold thousands of rows (11k agents, 14k DNC entries on
 * 28 Sep) and PostgREST silently stops at 1,000. An unpaged count here read 11
 * clients with agents when the truth was 42.
 */
export interface PortalPeopleCounts {
  team: number;
  agents: number;
  dnc: number;
}

async function countByClient(table: string): Promise<Map<string, number>> {
  const db = getMasterInboxSupabase();
  const out = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select("client_id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of (data ?? []) as { client_id: string }[]) out.set(r.client_id, (out.get(r.client_id) ?? 0) + 1);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function loadPeopleCounts(): Promise<Map<string, PortalPeopleCounts>> {
  const [team, agents, dnc] = await Promise.all([
    countByClient("client_team_members"),
    countByClient("client_agents"),
    countByClient("client_dnc_entries"),
  ]);
  const ids = new Set([...team.keys(), ...agents.keys(), ...dnc.keys()]);
  const out = new Map<string, PortalPeopleCounts>();
  for (const id of ids) out.set(id, { team: team.get(id) ?? 0, agents: agents.get(id) ?? 0, dnc: dnc.get(id) ?? 0 });
  return out;
}

const cachedPeople = ttlCache(loadPeopleCounts, { ttlMs: 60_000, key: () => "people" });

/** Team / agents / DNC counts keyed by Master Inbox client id. Zeros when absent. */
export async function portalPeopleByMiId(): Promise<Map<string, PortalPeopleCounts>> {
  return cachedPeople();
}
