import { after, NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { marketContext, marketFacet, marketOptions, marketPage, type FacetKind } from "@/lib/crm-preview/market";
import { parseMarketQuery } from "@/lib/crm-preview/market-model";
import { admit, NO_STORE_HEADERS, served } from "@/lib/crm-preview/data-guard";
import { recordUse } from "@/lib/portal-usage/usage";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * GET /api/crm-preview/market?client=<portal id>&list=market|prospects&page=…
 *   (&facet=brand|office|city|county&fq=<text>: a filter's choices with their counts)
 *
 * One page of the redesign preview's Market or Prospects (src/app/crm-preview).
 * Owners only, as the page: anyone else gets a bare 404. Read-only: GET is
 * the only method, and everything it reads goes through the read-only guard
 * (lib/crm-preview/market.ts). Bulk extraction is refused (lib/crm-preview/
 * data-guard.ts): only the page's own fetch, limits per person, a depth cap
 * per search, nothing cached or indexed, every request logged.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });

  const params = request.nextUrl.searchParams;
  const client = params.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400, headers: NO_STORE_HEADERS });
  const who = (me?.email ?? "").toLowerCase();
  const gate = admit(who, "staff", "market", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "market", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  try {
    const ctx = await marketContext(client);
    if (!ctx) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });
    const q = parseMarketQuery(params);
    // A filter's choices (brokerages, cities, counties) with their counts — names and numbers only.
    const facet = params.get("facet");
    if (facet === "brand" || facet === "office" || facet === "city" || facet === "county" || facet === "zip" || facet === "state") {
      const out = await marketFacet(ctx, q, facet as FacetKind, params.get("fq") ?? "");
      served(who, "market", 0);
      after(() => recordUse(createAdminSupabase(), { who, role: "staff", portalId: client, kind: "market", rows: 0, now: new Date() }));
      console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "facet", who, client, list: q.list, facet, fq: params.get("fq") ? "set" : "" }));
      return NextResponse.json(out, { headers: NO_STORE_HEADERS });
    }
    const [page, options] = await Promise.all([
      marketPage(ctx, q),
      params.get("options") === "1" ? marketOptions(ctx) : Promise.resolve(undefined),
    ]);
    const rows = "rows" in page && page.rows ? page.rows.length : 0;
    served(who, "market", rows);
    // Counted in the database; heavy or automated-looking CLIENT use rings the OS bell. Never refuses (usage.ts). Everyone here is our own team.
    after(() => recordUse(createAdminSupabase(), { who, role: "staff", portalId: client, kind: "market", rows, page: q.page, now: new Date() }));
    console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "market", who, client, list: q.list, page: q.page, per: q.per, rows, q: q.q ? "set" : "", sort: `${q.sort}:${q.dir}`, filters: [q.volume.min, q.volume.max, q.units.min, q.units.max, q.years.min, q.years.max].filter((v) => v !== null).length + q.titles.length + q.brokerages.length + q.offices.length + q.cities.length + q.counties.length + q.zips.length + q.states.length + Object.values(q.not).reduce((n, xs) => n + xs.length, 0) }));
    return NextResponse.json({ ...page, options, mls: ctx.mls, client: ctx.client?.name ?? null }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] market", err);
    // The reason is logged above; the browser gets the plain words, never a database message.
    return NextResponse.json({ error: "The agent database could not be read just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
