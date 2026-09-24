import "server-only";

import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { keyOf } from "./roster";

/*
 * A client's team, agents and do-not-contact list — §23's "open one system and
 * know ... their assigned team, their agents".
 *
 * The OS showed none of these. You had to open Master Inbox to find out how
 * many agents a client had, which is the opposite of the final principle.
 *
 * ---------------------------------------------------------------------------
 * READ FROM MASTER INBOX, NOT FROM CLIENT HEALTH'S MIRROR
 *
 * Client Health carries `agents_count` and `dnc_count` columns and they look
 * like the easy answer. Measured 2026-09-25, they are wrong for 11 of its 50
 * rows — all reading 0/0 while Master Inbox holds real data:
 *
 *     The Karp Group          0 / 0   vs   188 agents / 2158 dnc
 *     Front Range Collective  0 / 0   vs   330 agents /  327 dnc
 *     Simien Properties       0 / 0   vs    31 agents /  198 dnc
 *
 * Several of those are churned, so the sync worker likely skips hidden clients
 * — a reasonable thing for it to do, and a terrible number to put on screen.
 * Master Inbox owns these rows, so Master Inbox is asked.
 *
 * ---------------------------------------------------------------------------
 * SUMMED ACROSS EVERY PORTAL THE CLIENT HAS
 *
 * Master Inbox keeps ONE ROW PER PORTAL, and a client working several markets
 * has several. Counting only the portal that `mi_client_id` happens to point at
 * would report Properties & Estates' Boston agents and silently drop Florida's
 * — the same one-client-many-portals mistake the status feed used to make.
 *
 * So every portal the client is known by is resolved through its name AND its
 * aliases, exactly as the reconciler and the status feed do, and the per-portal
 * numbers are returned alongside the total. A client with two portals should be
 * able to see which is which.
 *
 * Counted with head requests rather than fetching rows: there are 11,305 agent
 * rows and 14,484 DNC rows across the platform, and this is a per-client
 * question asked when someone opens a client.
 */

export interface PortalPeople {
  portalId: string;
  portalName: string;
  portalEnabled: boolean;
  team: number;
  agents: number;
  dnc: number;
}

export interface ClientPeople {
  /** One entry per portal, so a multi-market client can be told apart. */
  portals: PortalPeople[];
  /** Summed across every portal — the client-level answer. */
  total: { team: number; agents: number; dnc: number };
  /** True when more than one portal contributed, so the UI can say so. */
  manyPortals: boolean;
  /** Set when Master Inbox could not be read. Counts are then meaningless. */
  error?: string;
}

export interface MiPortalRow {
  id: string;
  name: string;
  portal_enabled: boolean | null;
}

/**
 * Every Master Inbox portal this client is known by.
 *
 * Pure, and exported for the test: the matching rule is the interesting part,
 * not the counting. Matches on the client's name and every alias, using the
 * roster's own `keyOf` so a portal resolves here exactly as it does on the
 * Consistency screen.
 */
export function portalsFor(
  client: { name: string; aliases?: string[] | null },
  rows: MiPortalRow[],
): MiPortalRow[] {
  const keys = new Set(
    [client.name, ...(client.aliases ?? [])]
      .map((n) => keyOf((n ?? "").trim()))
      .filter(Boolean),
  );
  if (keys.size === 0) return [];
  const seen = new Set<string>();
  const out: MiPortalRow[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    if (!keys.has(keyOf(name))) continue;
    if (seen.has(row.id)) continue; // a row cannot be counted twice
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Sums the per-portal numbers into the client-level answer. */
export function totalOf(portals: PortalPeople[]): ClientPeople["total"] {
  return {
    team: portals.reduce((n, p) => n + p.team, 0),
    agents: portals.reduce((n, p) => n + p.agents, 0),
    dnc: portals.reduce((n, p) => n + p.dnc, 0),
  };
}

const TABLES = [
  ["client_team_members", "team"],
  ["client_agents", "agents"],
  ["client_dnc_entries", "dnc"],
] as const;

export async function readClientPeople(client: {
  name: string;
  aliases?: string[] | null;
}): Promise<ClientPeople> {
  const empty: ClientPeople = {
    portals: [],
    total: { team: 0, agents: 0, dnc: 0 },
    manyPortals: false,
  };

  let rows: MiPortalRow[];
  try {
    const db = getMasterInboxSupabase();
    const { data, error } = await db
      .from("clients")
      .select("id, name, portal_enabled")
      .limit(1000);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as MiPortalRow[];
  } catch (e) {
    // A number that is silently zero because a database was unreachable is
    // worse than no number, so the caller is told rather than shown zeroes.
    return { ...empty, error: e instanceof Error ? e.message : "Master Inbox unreadable" };
  }

  const matched = portalsFor(client, rows);
  if (matched.length === 0) return empty;

  const db = getMasterInboxSupabase();
  const portals: PortalPeople[] = [];
  for (const row of matched) {
    const counts: Record<string, number> = { team: 0, agents: 0, dnc: 0 };
    for (const [table, key] of TABLES) {
      const { count, error } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("client_id", row.id);
      if (error) {
        return {
          ...empty,
          error: `could not count ${table}: ${error.message}`,
        };
      }
      counts[key] = count ?? 0;
    }
    portals.push({
      portalId: row.id,
      portalName: row.name,
      portalEnabled: row.portal_enabled !== false,
      team: counts.team,
      agents: counts.agents,
      dnc: counts.dnc,
    });
  }

  return {
    portals,
    total: totalOf(portals),
    manyPortals: portals.length > 1,
  };
}
