import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { marketContext, marketOptions, marketPage } from "@/lib/crm-preview/market";
import { parseMarketQuery } from "@/lib/crm-preview/market-model";

/*
 * GET /api/crm-preview/market?client=<portal id>&list=market|prospects&page=…
 *
 * One page of the redesign preview's Market or Prospects (src/app/crm-preview).
 * Owners only, as the page: anyone else gets a bare 404. Read-only: GET is
 * the only method, and everything it reads goes through the read-only guard
 * (lib/crm-preview/market.ts).
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });

  const params = request.nextUrl.searchParams;
  const client = params.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400 });
  try {
    const ctx = await marketContext(client);
    if (!ctx) return NextResponse.json({ error: "No such client portal." }, { status: 404 });
    const [page, options] = await Promise.all([
      marketPage(ctx, parseMarketQuery(params)),
      params.get("options") === "1" ? marketOptions(ctx) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ ...page, options, mls: ctx.mls, client: ctx.client?.name ?? null });
  } catch (err) {
    console.error("[crm-preview] market", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "The agent database could not be read." }, { status: 500 });
  }
}
