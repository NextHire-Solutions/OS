import "server-only";

import { getOnboardingDb } from "./db";

/**
 * The two reads the client screen makes into Agent Search's half of the shared
 * database: the MLS list a client can be assigned, and the lead list already
 * built for them.
 *
 * Ported from the orchestrator's `lib/db-agents.ts` (`searchMls`,
 * `getLeadPreview` from `lib/queries.ts`).
 *
 * BOTH ARE READS, and they are reads of tables this tool may not write: `mls`
 * and `agents` belong to Agent Search — 1.17M agent rows — and `db.ts`'s guard
 * throws before the network call on any insert/update/upsert/delete outside
 * `orch_*`. Nothing here attempts one; the guard is the backstop, not the plan.
 */

export type MlsOption = { code: string; name: string };

export type LeadPreview = {
  agentId: string;
  fullName: string | null;
  email: string | null;
  brand: string | null;
  officeName: string | null;
  officeCity: string | null;
  title: string | null;
  salesVolume: number | null;
  closedTransactions: number | null;
};

export interface LeadList {
  total: number;
  rows: LeadPreview[];
  error: string | null;
}

/*
 * PostgREST `.or()` and ilike patterns treat commas and parentheses specially —
 * strip them from anything a person typed, or a search for "Miami (South)"
 * becomes a malformed filter rather than a search.
 */
const clean = (s: string) => s.replace(/[(),]/g, " ").trim();

/**
 * MLS the team can pick from, matched on code or name.
 *
 * Picking from this list rather than typing is the point: a code that matches
 * nothing resolves to no MLS and would quietly build an empty lead list.
 */
export async function searchMls(term: string, limit = 20): Promise<MlsOption[]> {
  const t = clean(term);
  if (t.length < 2) return [];
  const { data, error } = await getOnboardingDb()
    .from("mls")
    .select("code, name")
    .or(`code.ilike.%${t}%,name.ilike.%${t}%`)
    .order("code")
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as MlsOption[]).filter((r) => !!r.code);
}

/**
 * Human-review view: the built lead list joined to the scraped agent details.
 *
 * Two queries rather than a join because the link table and the agent table sit
 * either side of the `orch_` line, and `.in()` is chunked to 200 ids at a time
 * to keep the request URL inside PostgREST's limit — a 500-lead client would
 * otherwise produce a URL nothing will accept.
 */
export async function getLeadPreview(clientId: string, limit = 500): Promise<LeadList> {
  try {
    const db = getOnboardingDb();
    const { count } = await db
      .from("orch_client_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);
    const total = count ?? 0;
    if (!total) return { total: 0, rows: [], error: null };

    const { data: linkRows, error } = await db
      .from("orch_client_leads")
      .select("agent_id")
      .eq("client_id", clientId)
      .limit(limit);
    if (error) throw new Error(error.message);
    const ids = ((linkRows ?? []) as { agent_id: string }[]).map((r) => r.agent_id);

    const rows: LeadPreview[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error: e } = await db
        .from("agents")
        .select(
          "id, full_name, preferred_email, brand, office_name, office_city, title, sales_volume, closed_transactions",
        )
        .in("id", ids.slice(i, i + 200));
      if (e) throw new Error(e.message);
      for (const a of (data ?? []) as Record<string, unknown>[]) {
        rows.push({
          agentId: a.id as string,
          fullName: (a.full_name as string | null) ?? null,
          email: (a.preferred_email as string | null) ?? null,
          brand: (a.brand as string | null) ?? null,
          officeName: (a.office_name as string | null) ?? null,
          officeCity: (a.office_city as string | null) ?? null,
          title: (a.title as string | null) ?? null,
          salesVolume: (a.sales_volume as number | null) ?? null,
          closedTransactions: (a.closed_transactions as number | null) ?? null,
        });
      }
    }
    rows.sort((a, b) => (b.salesVolume ?? 0) - (a.salesVolume ?? 0));
    return { total, rows, error: null };
  } catch (error) {
    return {
      total: 0,
      rows: [],
      error: error instanceof Error ? error.message : "Could not read the lead list",
    };
  }
}
