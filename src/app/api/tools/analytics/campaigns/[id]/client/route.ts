import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAnalyticsSupabase as getSupabase } from "@/lib/tools/analytics/supabase";

export const dynamic = "force-dynamic";

const schema = z.object({
  // null unpins, returning the campaign to automatic matching.
  clientId: z.string().uuid().nullable(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PIN a campaign to a client.
 *
 * Writes match_method='manual', which the auto-matcher never overwrites. This
 * is deliberately NOT an alias: an alias changes the matching RULE and would
 * retroactively capture other campaigns, whereas a pin fixes exactly this one.
 * Aliases are edited on the client record itself, where their blast radius is
 * visible.
 *
 * ---------------------------------------------------------------------------
 * THE ONE ADDITION TO THIS ROUTE: INSTANTLY.
 *
 * The tool's version opens `Number(id)` and 400s on anything else, and there is
 * no `instantly_campaign_clients` write path anywhere in it. Its own Clients
 * page then LISTS Instantly campaigns in the unassigned queue — 84 of the 93
 * outstanding today, the first carrying 13,023 lifetime sends — and renders an
 * "Assign to client…" dropdown beside each one that answers
 * `400 Invalid campaign id`.
 *
 * That is not a cosmetic gap. `instantly_campaign_clients` is what
 * `analytics_instantly_client_rows` and `analytics_instantly_kpis` join
 * through, so an unassigned Instantly campaign's volume reaches the KPI band
 * and nobody's client row, permanently, with no way to fix it from the product.
 *
 * The two tables are the same shape — `campaign_id` primary key, `client_id`
 * nullable FK, `match_method`, `excluded` — so the branch below is the table
 * name and the id type, and nothing else. Both writes are scoped by
 * `.eq("campaign_id", …)`.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const instantly = UUID.test(id);
  const campaignId: string | number = instantly ? id : Number(id);
  if (!instantly && !Number.isInteger(campaignId as number)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch = {
    client_id: parsed.data.clientId,
    match_method: parsed.data.clientId ? "manual" : "auto",
    matched_on: parsed.data.clientId ? "manual pin" : null,
    // A pin resolves ambiguity by definition.
    ambiguous: false,
    resolved_at: new Date().toISOString(),
  };

  const sb = getSupabase();
  const { error, count } = await sb
    .from(instantly ? "instantly_campaign_clients" : "campaign_clients")
    .update(patch, { count: "exact" })
    .eq("campaign_id", campaignId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /*
   * The tool returns `{ok: true}` whether or not a row was touched, so pinning
   * a campaign the matcher has never seen reports success and changes nothing.
   * `count: "exact"` is one word and turns that into a 404 the screen can say
   * out loud.
   */
  if (count === 0) {
    return NextResponse.json(
      { error: "That campaign has no client mapping yet — run sync-entities first." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, updated: count ?? 0 });
}
