import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { DEMO_PORTAL_ID, demoAction, isDemoPortal, moveAgents, runDemoAction, type DemoResult } from "@/lib/crm-preview/demo";
import { MAX_MOVE, marketAction, type MarketAction } from "@/lib/crm-preview/demo-market";
import { invalidatePortalLists, marketContext, matchingIds } from "@/lib/crm-preview/market";
import { parseMarketQuery } from "@/lib/crm-preview/market-model";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * POST /api/crm-preview/demo { client, action } — one save on the Demo Portal
 * (21 Oct; lib/crm-preview/demo.ts says what it writes and what it never sets
 * off).
 *
 * Owners and the named reviewers only, as the page: anyone else a bare 404.
 * Only the page's own fetch. Only the Demo Portal: any other client is
 * refused before anything is read — every other client in the preview stays
 * read-only. Every save is logged with who made it.
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });
  const who = (me?.email ?? "").toLowerCase();

  const body = (await request.json().catch(() => null)) as { client?: unknown; action?: unknown } | null;
  // A body that can't be read (a very large file is cut off on the way in) says so — not "only the Demo Portal" (22 Oct audit).
  if (!body) return NextResponse.json({ error: "That request couldn't be read. If it was a large file, split it into smaller files and import each one." }, { status: 400, headers: NO_STORE_HEADERS });
  if (!isDemoPortal(typeof body?.client === "string" ? body.client : null)) {
    return NextResponse.json({ error: "Only the Demo Portal can be changed from the preview. Every other portal here is read-only." }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const gate = admit(who, "staff", "demo", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "demo", who, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  // Market's "Move to" (23 Oct, demo-market.ts), else every other save (demo.ts).
  const market = marketAction.safeParse(body?.action);
  const parsed = market.success ? null : demoAction.safeParse(body?.action);
  if (!market.success && !parsed?.success) {
    return NextResponse.json({ error: parsed?.error?.issues[0]?.message ?? "That could not be saved." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const out = market.success ? await runMarketMove(market.data, who) : await runDemoAction(createAdminSupabase(), parsed!.data!, who);
    const a = market.success ? market.data : parsed!.data!;
    console.info(JSON.stringify({ tag: "[crm-preview] demo save", who, type: a.type, ids: "ids" in a ? a.ids.length : "rows" in a ? a.rows.length : 1, ok: out.ok }));
    // Any save can change a list the Market's pills read (kept 20 s): the next page reads them fresh.
    invalidatePortalLists(DEMO_PORTAL_ID);
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers: NO_STORE_HEADERS });
    return NextResponse.json({ ok: true, ...(out.id ? { id: out.id } : {}), ...(out.message ? { message: out.message } : {}) }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] demo save", err);
    return NextResponse.json({ error: "That could not be saved just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

/* Ticked agents, or every agent matching the page's filters (at most MAX_MOVE), to a list of the Demo Portal's. */
async function runMarketMove(a: MarketAction, who: string): Promise<DemoResult> {
  let ids: string[];
  if (a.type === "market.move") ids = a.ids;
  else {
    const ctx = await marketContext(DEMO_PORTAL_ID);
    if (!ctx) return { ok: false, status: 404, error: "The Demo Portal could not be found." };
    const found = await matchingIds(ctx, { ...parseMarketQuery(new URLSearchParams(a.query)), list: a.list }, MAX_MOVE);
    if ("unavailable" in found) return { ok: false, status: 409, error: found.unavailable };
    if (found.total > MAX_MOVE) {
      return { ok: false, status: 409, error: `That's ${found.total.toLocaleString("en-US")} agents — narrow the filters to ${MAX_MOVE.toLocaleString("en-US")} or fewer to move them all at once.` };
    }
    if (!found.ids.length) return { ok: false, status: 404, error: "No agents match these filters." };
    ids = found.ids;
  }
  return moveAgents(createAdminSupabase(), ids, a.to, who, { onlyUnlisted: a.onlyUnlisted });
}
