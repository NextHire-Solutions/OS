import { NextResponse, type NextRequest } from "next/server";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal, mayWritePortal } from "@/lib/crm-preview/viewer-rules";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { DEMO_PORTAL_ID, demoAction, isDemoPortal, moveAgents, runDemoAction, type DemoResult } from "@/lib/crm-preview/demo";
import { MAX_MOVE, marketAction, type MarketAction } from "@/lib/crm-preview/demo-market";
import { invalidatePortalLists, marketContext, matchingIds } from "@/lib/crm-preview/market";
import { parseMarketQuery } from "@/lib/crm-preview/market-model";
import { runPortalAction } from "@/lib/crm-preview/portal-save";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * POST /api/crm-preview/save — one save from the new portal (28 Oct; /api/crm-preview/demo forwards here).
 *
 *   JSON { client, action }   a button's save; a CSV import is the file's rows, read in the browser with the
 *                             current portal's own parser (portals/csv.ts)
 *
 * WHO (viewer-rules.ts): anyone who may not open the portal gets a bare 404 before anything is read; someone who may
 * open it but not change it is told it is read-only (no one, since staff may change every portal — 29 Oct — but the
 * check stays). Only the page's own fetch (data-guard admit). Every save is logged with who made it.
 *
 * WHAT: the Demo Portal — demo.ts / demo-market.ts, its own rows and nothing outside, as before. A real portal —
 * portal-save.ts: the current portal's own save code, with everything it sets off (blocklists, Slack, texts, Follow
 * Up Boss), so a client's save here does exactly what it does in their current portal.
 */

export const dynamic = "force-dynamic";
// A CSV of a few thousand rows, each pushed to the providers, takes longer than one save (the current portal allows 60 s).
export const maxDuration = 120;

const READ_ONLY = "Read-only preview — nothing here changes this client's portal.";

export async function POST(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const body = (await request.json().catch(() => null)) as { client?: unknown; action?: unknown } | null;
  // A body that can't be read (a very large file is cut off on the way in) says so (22 Oct audit).
  if (!body) return NextResponse.json({ error: "That request couldn't be read. If it was a large file, split it into smaller files and import each one." }, { status: 400, headers: NO_STORE_HEADERS });
  const client = typeof body.client === "string" ? body.client : null;
  const action = body.action;

  // Who: a portal they may not open — nothing; one they may open but not change — read-only.
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  if (!mayWritePortal(viewer, client)) return NextResponse.json({ error: READ_ONLY }, { status: 403, headers: NO_STORE_HEADERS });
  const portal = client as string;

  const gate = admit(who, role, "demo", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "save", who, client: portal, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  try {
    let out: DemoResult;
    let type: string;
    if (isDemoPortal(portal)) {
      // Market's "Move to" (23 Oct, demo-market.ts), else every other save (demo.ts).
      const market = marketAction.safeParse(action);
      const parsed = market.success ? null : demoAction.safeParse(action);
      if (!market.success && !parsed?.success) return NextResponse.json({ error: parsed?.error?.issues[0]?.message ?? "That could not be saved." }, { status: 400, headers: NO_STORE_HEADERS });
      const a = market.success ? market.data : parsed!.data!;
      type = a.type;
      out = market.success ? await runDemoMarketMove(market.data, who) : await runDemoAction(createAdminSupabase(), parsed!.data!, who);
    } else {
      type = typeof (action as { type?: unknown } | null)?.type === "string" ? (action as { type: string }).type : "?";
      out = await runPortalAction(portal, action, who, role);
    }
    console.info(JSON.stringify({ tag: "[crm-preview] save", who, role, client: portal, demo: isDemoPortal(portal), type, ok: out.ok }));
    // Any save can change a list the Market's pills read (kept 20 s): the next page reads them fresh.
    invalidatePortalLists(portal);
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers: NO_STORE_HEADERS });
    return NextResponse.json({ ok: true, ...(out.id ? { id: out.id } : {}), ...(out.message ? { message: out.message } : {}) }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] save", err);
    return NextResponse.json({ error: "That could not be saved just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

/* Ticked agents, or every agent matching the page's filters (at most MAX_MOVE), to a list of the Demo Portal's. */
async function runDemoMarketMove(a: MarketAction, who: string): Promise<DemoResult> {
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
