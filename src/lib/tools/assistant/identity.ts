import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { osTable } from "@/lib/clients/os-db";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";
import { ttlCache } from "@/lib/cache/ttl";

/*
 * One client, across four databases that do not agree about its name.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE FIRST THING THE ASSISTANT NEEDED
 *
 * "Which client is performing badly" cannot be answered until a client can be
 * recognised in all four products. Measured on the live estate:
 *
 *   Master Inbox    clients                        59   the canonical roster
 *   Analytics       clients.portal_client_id     50/50   a real foreign key
 *   Client Health   clients (by name)            48/49
 *   Agent Search    orch_clients (by name)       32/42   ← the problem
 *
 * Agent Search keeps `db_client_id` NULL on every row, so only the name is
 * left, and the names differ: "Howe Realty" there is "Howe Realty Group" here,
 * "JPAR Ironhorse" is "JPAR Iron Horse", "Norvell & Co" is "Norvell&Co Real
 * Estate". Ten of forty-two miss.
 *
 * ---------------------------------------------------------------------------
 * A MISS MUST NEVER LOOK LIKE AN ANSWER
 *
 * This is the whole reason the resolver reports coverage instead of just
 * returning ids. Asked "what did we scrape for Howe Realty", a name-only
 * lookup finds nothing in Agent Search and the honest-looking answer is "no
 * scrapes" — confident, and wrong.
 *
 * So every resolution carries WHICH products it found the client in. A tool
 * that cannot see Agent Search says so, and the assistant reports a gap rather
 * than a zero. `linked: false` is information; a silent 0 is a lie.
 *
 * ---------------------------------------------------------------------------
 * NO FUZZY MATCHING. EVER.
 *
 * The temptation is a similarity score, and it is a trap: "Rise Realty Of
 * Florida LLC" and "Rise Loan Officers" share a word and are different
 * companies. A threshold loose enough to join "Howe Realty" to "Howe Realty
 * Group" also joins those two, and joining two clients' numbers is worse than
 * reporting a gap.
 *
 * Instead: exact match on a normalised name, plus `os_client_aliases` — rows a
 * person entered on purpose saying "this name means that client". Normalising
 * handles punctuation and spacing ("Norvell & Co" → "norvell co"); the alias
 * table handles everything a human has to decide.
 */

/** The canonical client, plus where it could be found. */
export interface ResolvedClient {
  /*
   * Master Inbox clients.id — the canonical identity.
   *
   * A STRING, because every one of the four products keys its clients with a
   * uuid. An earlier draft typed these as numbers and coerced with Number(),
   * which turns a uuid into NaN — and because Map compares NaN keys as equal,
   * all 59 clients collapsed into a single entry and the coverage check
   * reported a confident, meaningless 59/59. Never coerce an id here.
   */
  id: string;
  name: string;
  /** Per product: the id to query there, or null when it is not linked. */
  analyticsClientId: string | null;
  clientHealthId: string | null;
  agentSearchClientId: string | null;
  /** Products this client could NOT be found in, for the answer to disclose. */
  missing: ProductKey[];
}

export type ProductKey = "analytics" | "client_health" | "agent_search";

/**
 * Names compared without the noise people vary: case, punctuation, spacing,
 * and the trailing company words that one product writes and another omits.
 *
 * `&` becomes a space rather than vanishing, so "Norvell&Co" and "Norvell & Co"
 * both become "norvell co" instead of "norvellco" and "norvell co".
 */
export function normaliseName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The same name with trailing company words removed.
 *
 * ONLY used as a second pass, after exact normalised matching has failed for
 * every candidate — and only when it produces exactly ONE hit. "Howe Realty"
 * and "Howe Realty Group" both reduce to "howe", and so would a genuinely
 * different "Howe Partners"; requiring uniqueness is what keeps that safe.
 */
export function nameStem(raw: string | null | undefined): string {
  const stop = new Set([
    "group", "realty", "real", "estate", "team", "company", "co", "llc", "inc",
    "the", "of", "at", "partners", "properties", "brokerage", "homes",
  ]);
  const words = normaliseName(raw).split(" ").filter((w) => w && !stop.has(w));
  return words.join(" ");
}

interface Roster {
  clients: Array<{ id: string; name: string }>;
  analyticsByClientId: Map<string, string>;
  healthByName: Map<string, string>;
  searchByName: Map<string, string>;
  /** source → alias → canonical client id, from os_client_aliases. */
  aliases: Map<ProductKey, Map<string, string>>;
}

/*
 * Built once and held for ten minutes. Four round trips per question would
 * dominate the latency of a chat answer, and the roster changes when a client
 * is onboarded — not between two messages in a conversation.
 */
const loadRoster = ttlCache(async (): Promise<Roster> => {
  {
    const admin = createAdminSupabase();

    const [{ data: miRows }, aliasRows] = await Promise.all([
      admin.from("clients").select("id, name").order("name"),
      osTable("os_client_aliases").select("client_id, source, alias"),
    ]);

    const aliases = new Map<ProductKey, Map<string, string>>([
      ["analytics", new Map()],
      ["client_health", new Map()],
      ["agent_search", new Map()],
    ]);
    for (const row of aliasRows.data ?? []) {
      const bucket = aliases.get(row.source as ProductKey);
      if (bucket) bucket.set(normaliseName(row.alias as string), String(row.client_id));
    }

    /*
     * Each product is read independently and a failure in one does NOT fail the
     * roster. A dead Agent Search connection must degrade to "that product is
     * unlinked", which the answer then discloses — not to an error on a chat
     * message about Client Health.
     */
    const [analytics, health, search] = await Promise.all([
      safe(async () => {
        const { data } = await getAnalyticsSupabase()
          .from("clients")
          .select("id, name, portal_client_id");
        return data ?? [];
      }),
      safe(async () => {
        const { data } = await getClientHealthSupabase().from("clients").select("id, name");
        return data ?? [];
      }),
      safe(async () => {
        const { data } = await getAgentSearchSupabase()
          .from("orch_clients")
          .select("id, client_name");
        return data ?? [];
      }),
    ]);

    const analyticsByClientId = new Map<string, string>();
    const analyticsByName = new Map<string, string>();
    for (const row of analytics) {
      if (row.portal_client_id != null) {
        analyticsByClientId.set(String(row.portal_client_id), String(row.id));
      }
      analyticsByName.set(normaliseName(row.name as string), String(row.id));
    }

    const healthByName = new Map<string, string>();
    for (const row of health) healthByName.set(normaliseName(row.name as string), String(row.id));

    const searchByName = new Map<string, string>();
    for (const row of search) {
      searchByName.set(normaliseName(row.client_name as string), String(row.id));
    }

    // Analytics' FK wins; its name map only fills the three rows without one.
    const clients = (miRows ?? []).map((c) => ({ id: String(c.id), name: String(c.name) }));
    for (const c of clients) {
      if (!analyticsByClientId.has(c.id)) {
        const byName = analyticsByName.get(normaliseName(c.name));
        if (byName != null) analyticsByClientId.set(c.id, byName);
      }
    }

    return { clients, analyticsByClientId, healthByName, searchByName, aliases };
  }
}, { ttlMs: 10 * 60 * 1000 });

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.warn("[assistant] a product roster was unreadable", error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Every client, resolved across all four products.
 *
 * Returned whole rather than one at a time because the ranking tools need the
 * entire roster anyway, and resolving 59 clients one call at a time would be
 * 59 round trips per question.
 */
export async function resolveAll(): Promise<ResolvedClient[]> {
  const roster = await loadRoster();

  // Stems are only trusted when unique across the whole roster — see nameStem.
  const stemCounts = new Map<string, number>();
  for (const c of roster.clients) {
    const stem = nameStem(c.name);
    if (stem) stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  const lookup = (
    client: { id: string; name: string },
    source: ProductKey,
    byName: Map<string, string>,
  ): string | null => {
    // 1. an alias entered for this client, by the product's own spelling
    for (const [aliasName, id] of roster.aliases.get(source) ?? []) {
      if (id === client.id) {
        const hit = byName.get(aliasName);
        if (hit != null) return hit;
      }
    }
    // 2. exact, normalised
    const exact = byName.get(normaliseName(client.name));
    if (exact != null) return exact;
    // 3. stem, only when this client's stem is unique in the roster AND
    //    matches exactly one name on the other side
    const stem = nameStem(client.name);
    if (stem && stemCounts.get(stem) === 1) {
      const hits = [...byName.entries()].filter(([n]) => nameStem(n) === stem);
      if (hits.length === 1) return hits[0][1];
    }
    return null;
  };

  return roster.clients.map((client) => {
    const analyticsClientId = roster.analyticsByClientId.get(client.id) ?? null;
    const clientHealthId = lookup(client, "client_health", roster.healthByName);
    const agentSearchClientId = lookup(client, "agent_search", roster.searchByName);

    const missing: ProductKey[] = [];
    if (analyticsClientId == null) missing.push("analytics");
    if (clientHealthId == null) missing.push("client_health");
    if (agentSearchClientId == null) missing.push("agent_search");

    return { id: client.id, name: client.name, analyticsClientId, clientHealthId, agentSearchClientId, missing };
  });
}

/**
 * One client by however the person typed it.
 *
 * Returns candidates rather than a guess when the name is ambiguous: the
 * assistant should ask "which one" instead of picking, because picking wrong
 * means reporting another client's numbers under this client's name.
 */
export async function findClient(query: string): Promise<{
  match: ResolvedClient | null;
  candidates: ResolvedClient[];
}> {
  const all = await resolveAll();
  const q = normaliseName(query);
  if (!q) return { match: null, candidates: [] };

  const exact = all.find((c) => normaliseName(c.name) === q);
  if (exact) return { match: exact, candidates: [] };

  const stem = nameStem(query);
  const byStem = stem ? all.filter((c) => nameStem(c.name) === stem) : [];
  if (byStem.length === 1) return { match: byStem[0], candidates: [] };

  // Substring, which is how a person abbreviates ("54 realty", "keyes").
  const contains = all.filter(
    (c) => normaliseName(c.name).includes(q) || q.includes(normaliseName(c.name)),
  );
  if (contains.length === 1) return { match: contains[0], candidates: [] };

  return { match: null, candidates: (byStem.length ? byStem : contains).slice(0, 8) };
}
