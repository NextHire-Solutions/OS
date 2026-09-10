import { createServerSupabase } from "@/lib/supabase/server";

// Thread search shared by the top-bar dropdown and the full results page
// (/inbox/search). Matches a query against, in priority order:
//   1. lead name / email / company
//   2. thread subject
//   3. campaign name
//   4. client name  (so searching "54" finds the "54 Realty" client)
//   5. message body text  (so it finds matches inside the conversation)
//
// PostgREST can't `.or` across joins, so each field group is its own
// query; results are unioned and de-duplicated, first-match-wins ordering.

export interface SearchHit {
  id: string;
  subject: string | null;
  lead_full_name: string | null;
  lead_email: string | null;
  lead_company: string | null;
  campaign_name: string | null;
  client_name: string | null;
  last_message_at: string | null;
}

const SEL =
  "id, subject, last_message_at, campaign_name, leads:lead_id(full_name, email, company), clients:client_id(name)";

type RawRow = {
  id: string;
  subject: string | null;
  last_message_at: string | null;
  campaign_name: string | null;
  leads: { full_name: string | null; email: string | null; company: string | null } | { full_name: string | null; email: string | null; company: string | null }[] | null;
  clients: { name: string | null } | { name: string | null }[] | null;
};

function toHit(row: RawRow): SearchHit {
  const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
  const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
  return {
    id: row.id,
    subject: row.subject,
    lead_full_name: lead?.full_name ?? null,
    lead_email: lead?.email ?? null,
    lead_company: lead?.company ?? null,
    campaign_name: row.campaign_name,
    client_name: client?.name ?? null,
    last_message_at: row.last_message_at,
  };
}

export async function searchThreads(
  workspaceId: string,
  rawQuery: string,
  limit = 10,
): Promise<SearchHit[]> {
  const q = rawQuery.trim();
  if (q.length < 2) return [];

  const supabase = await createServerSupabase();
  const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
  const like = `%${escaped}%`;
  // Over-fetch each branch so the union still has `limit` good rows after
  // dedup; the page asks for a big limit, the dropdown a small one.
  const per = Math.min(Math.max(limit, 10), 200);

  // Resolve client ids + body-matching thread ids up front (separate
  // tables) so the main thread queries can filter by them.
  const [{ data: clientRows }, { data: bodyRows }] = await Promise.all([
    supabase.from("clients").select("id").ilike("name", like),
    supabase
      .from("messages")
      .select("thread_id")
      .eq("workspace_id", workspaceId)
      .ilike("body_text", like)
      .limit(400),
  ]);
  const clientIds = (clientRows ?? []).map((c) => c.id as string);
  const bodyThreadIds = Array.from(
    new Set((bodyRows ?? []).map((m) => m.thread_id as string)),
  );

  const base = () =>
    supabase
      .from("threads")
      .select(SEL)
      .eq("workspace_id", workspaceId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(per);

  const branches: Array<PromiseLike<{ data: RawRow[] | null }>> = [
    // lead name / email / company — needs !inner for the foreign-table .or
    supabase
      .from("threads")
      .select(SEL.replace("leads:lead_id(", "leads:lead_id!inner("))
      .eq("workspace_id", workspaceId)
      .or(
        `full_name.ilike.${like},email.ilike.${like},company.ilike.${like}`,
        { foreignTable: "leads" },
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(per) as unknown as PromiseLike<{ data: RawRow[] | null }>,
    // subject
    base().ilike("subject", like) as unknown as PromiseLike<{ data: RawRow[] | null }>,
    // campaign name
    base().ilike("campaign_name", like) as unknown as PromiseLike<{ data: RawRow[] | null }>,
  ];
  if (clientIds.length > 0) {
    branches.push(
      base().in("client_id", clientIds) as unknown as PromiseLike<{
        data: RawRow[] | null;
      }>,
    );
  }
  if (bodyThreadIds.length > 0) {
    branches.push(
      base().in("id", bodyThreadIds.slice(0, 200)) as unknown as PromiseLike<{
        data: RawRow[] | null;
      }>,
    );
  }

  const settled = await Promise.all(branches);

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const res of settled) {
    for (const row of res.data ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      hits.push(toHit(row));
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
