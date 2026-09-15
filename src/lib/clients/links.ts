import "server-only";

import { normaliseName } from "@/lib/reconcile/names";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getAnalyticsSupabase, analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { ROSTER, type CanonicalClient } from "./roster";
import { toSlug } from "./slug";

export { toSlug };

/*
 * Where each canonical client lives in each of the four tools.
 *
 * ---------------------------------------------------------------------------
 * WHY IDS AND NOT NAMES
 *
 * `lib/reconcile` already compares these lists, and it compares NAMES on
 * purpose: it is a diagnostic screen for a human deciding whether two spellings
 * are the same business. This is the other job — binding a canonical client to
 * the actual row the OS will read and write, which needs the row's key.
 *
 * Once a link is stored on `os_clients`, matching stops happening at all: the
 * id is the answer and a later rename in a tool cannot break it. This resolver
 * is how the links are found the FIRST time, and how a client the OS has not
 * seen before is placed.
 *
 * ---------------------------------------------------------------------------
 * MATCHING RULES, AND WHY THEY ARE STRICT
 *
 * Exact on normalised name, or exact on one of the roster's declared aliases.
 * Nothing fuzzy. A fuzzy match here would attach one client's campaigns,
 * billing and portal to another client's row, and — this is the part that
 * matters — nobody would ever see it happen. The reconcile screen exists for
 * the genuinely ambiguous cases, where a person decides.
 *
 * When two rows in one tool both match a client, that is reported as
 * `ambiguous` and NO link is made. Picking the first would be a coin flip with
 * a customer's data on it.
 *
 * READ ONLY. Nothing here writes to any tool.
 */

export type ToolKey = "masterInbox" | "clientHealth" | "analytics" | "onboarding";

export const TOOL_LABEL: Record<ToolKey, string> = {
  masterInbox: "Master Inbox",
  clientHealth: "Client Health",
  analytics: "Analytics",
  onboarding: "Onboarding",
};

interface ToolRow {
  id: string;
  name: string;
  /** Extra spellings the TOOL itself records, folded into matching. */
  aliases?: string[];
}

export interface ToolRoster {
  tool: ToolKey;
  rows: ToolRow[];
  /** Set when the tool could not be read. Never conflated with "no rows". */
  unavailable?: string;
}

export interface ClientLink {
  name: string;
  slug: string;
  aliases: string[];
  /** Tool → the row's id, or null when the client does not exist there. */
  links: Record<ToolKey, string | null>;
  /** Tools where more than one row matched, so no link was made. */
  ambiguous: ToolKey[];
  /** Tools this client is genuinely absent from. */
  missing: ToolKey[];
}

export interface LinkReport {
  clients: ClientLink[];
  /** Rows in a tool that no canonical client claims, with that tool's id. */
  unclaimed: Record<ToolKey, { id: string; name: string }[]>;
  unavailable: Partial<Record<ToolKey, string>>;
}

/* ------------------------------------------------------------------ readers */

async function readMasterInbox(): Promise<ToolRoster> {
  try {
    /*
     * No workspace filter, and that is not an oversight.
     *
     * Master Inbox's `clients` is a GLOBAL catalog — it has no `workspace_id`
     * column at all, which its own route states plainly: "The clients table is
     * a global catalog (no workspace_id) so we don't filter by workspace."
     * Adding the filter does not over-fetch, it throws 42703 and reports every
     * client as unreadable.
     */
    const { data, error } = await getMasterInboxSupabase()
      .from("clients")
      .select("id, name, aliases");
    if (error) throw new Error(error.message);
    return {
      tool: "masterInbox",
      rows: (data ?? []).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
        aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
      })),
    };
  } catch (e) {
    return { tool: "masterInbox", rows: [], unavailable: message(e) };
  }
}

async function readClientHealth(): Promise<ToolRoster> {
  try {
    const { data, error } = await getClientHealthSupabase().from("clients").select("id, name");
    if (error) throw new Error(error.message);
    return {
      tool: "clientHealth",
      rows: (data ?? []).map((r) => ({ id: String(r.id), name: String(r.name ?? "") })),
    };
  } catch (e) {
    return { tool: "clientHealth", rows: [], unavailable: message(e) };
  }
}

async function readAnalytics(): Promise<ToolRoster> {
  try {
    const { data, error } = await getAnalyticsSupabase()
      .from("clients")
      .select("id, name, aliases")
      .eq("team_id", analyticsTeamId());
    if (error) throw new Error(error.message);
    return {
      tool: "analytics",
      rows: (data ?? []).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
        aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
      })),
    };
  } catch (e) {
    return { tool: "analytics", rows: [], unavailable: message(e) };
  }
}

async function readOnboarding(): Promise<ToolRoster> {
  try {
    const { data, error } = await getOnboardingDb()
      .from("orch_clients")
      .select("id, client_name");
    if (error) throw new Error(error.message);
    return {
      tool: "onboarding",
      rows: (data ?? []).map((r) => ({ id: String(r.id), name: String(r.client_name ?? "") })),
    };
  } catch (e) {
    return { tool: "onboarding", rows: [], unavailable: message(e) };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ----------------------------------------------------------------- matching */

const TOOLS: ToolKey[] = ["masterInbox", "clientHealth", "analytics", "onboarding"];

/**
 * Every spelling that should resolve to a canonical client: its name and its
 * declared aliases, normalised and de-duplicated.
 */
function keysFor(client: CanonicalClient): Set<string> {
  const keys = new Set<string>();
  const add = (s: string) => {
    const k = normaliseName(s);
    if (k) keys.add(k);
  };
  add(client.name);
  for (const a of client.aliases ?? []) add(a);
  return keys;
}

/**
 * Resolves every roster client against every tool.
 *
 * A tool that cannot be read leaves its links null and is recorded in
 * `unavailable`, rather than reporting 36 clients as missing from it — those
 * are very different statements and only one of them is actionable.
 */
export async function resolveLinks(
  roster: readonly CanonicalClient[] = ROSTER,
): Promise<LinkReport> {
  const rosters = await Promise.all([
    readMasterInbox(),
    readClientHealth(),
    readAnalytics(),
    readOnboarding(),
  ]);
  const byTool = new Map<ToolKey, ToolRoster>(rosters.map((r) => [r.tool, r]));

  const unavailable: Partial<Record<ToolKey, string>> = {};
  for (const r of rosters) if (r.unavailable) unavailable[r.tool] = r.unavailable;

  // Which canonical client, if any, claimed each tool row. Also the source of
  // the `unclaimed` buckets — a row nobody claims is either a fixture, a
  // churned client, or a genuine gap in the roster, and all three need seeing.
  const claimed = new Map<ToolKey, Set<string>>(TOOLS.map((t) => [t, new Set()]));

  const clients: ClientLink[] = roster.map((client) => {
    const keys = keysFor(client);
    const canonicalKey = normaliseName(client.name);
    const links: Record<ToolKey, string | null> = {
      masterInbox: null, clientHealth: null, analytics: null, onboarding: null,
    };
    const ambiguous: ToolKey[] = [];
    const missing: ToolKey[] = [];

    for (const tool of TOOLS) {
      const roster_ = byTool.get(tool);
      if (!roster_ || roster_.unavailable) continue;

      /*
       * Exact name first, aliases only as a fallback.
       *
       * This is what separates "SERHANT. PA" from "SERHANT. PA 15M+". Both
       * rows exist in Analytics and the roster names the second as an ALIAS of
       * the first, so a single pass matches two rows and gives up as
       * ambiguous — even though one of them is the client's actual name and is
       * obviously the right answer. Same for "Properties & Estates" against
       * "Properties & Estates Florida".
       *
       * So: if exactly one row carries the canonical NAME, that is the link.
       * Aliases decide only when the name itself matched nothing.
       */
      const exact = roster_.rows.filter((row) => normaliseName(row.name) === canonicalKey);
      const hits = exact.length > 0
        ? exact
        : roster_.rows.filter((row) => {
            if (keys.has(normaliseName(row.name))) return true;
            // The TOOL's own aliases count too: Master Inbox and Analytics
            // both maintain them, and ignoring them would report a client as
            // missing from a tool that already knows it by another name.
            return (row.aliases ?? []).some((a) => keys.has(normaliseName(a)));
          });

      if (hits.length === 1) {
        links[tool] = hits[0].id;
        claimed.get(tool)!.add(hits[0].id);
      } else if (hits.length > 1) {
        ambiguous.push(tool);
        for (const h of hits) claimed.get(tool)!.add(h.id);
      } else {
        missing.push(tool);
      }
    }

    return {
      name: client.name,
      slug: toSlug(client.name),
      aliases: [...(client.aliases ?? [])],
      links,
      ambiguous,
      missing,
    };
  });

  const unclaimed = {} as LinkReport["unclaimed"];
  for (const tool of TOOLS) {
    const r = byTool.get(tool);
    unclaimed[tool] = (r?.unavailable ? [] : (r?.rows ?? []))
      .filter((row) => !claimed.get(tool)!.has(row.id))
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { clients, unclaimed, unavailable };
}
