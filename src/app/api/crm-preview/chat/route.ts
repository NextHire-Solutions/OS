import { after, NextResponse, type NextRequest } from "next/server";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { answer, loadPortalChatData } from "@/lib/crm-preview/chat";
import { parseTurns, type MarketTotals } from "@/lib/crm-preview/chat-tools";
import { marketContext, marketReport } from "@/lib/crm-preview/market";
import { admit, NO_STORE_HEADERS, served } from "@/lib/crm-preview/data-guard";
import { recordUse } from "@/lib/portal-usage/usage";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * The portal assistant (19 Oct). POST { client, messages: [{ role, text }] }
 * → { reply }.
 *
 * The reviewers, or the portal's own signed-in client (27 Oct), as the
 * preview page: anyone else gets a bare 404.
 * Then the data guard (own page only, per-person limits). Then ONE portal's
 * data is loaded — the one named — and the assistant sees nothing else
 * (chat-tools.ts). It reads; it writes nothing anywhere.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET_WAIT_MS = 25_000;

export async function POST(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const body = (await request.json().catch(() => null)) as { client?: unknown; messages?: unknown } | null;
  const client = typeof body?.client === "string" ? body.client : "";
  const turns = parseTurns(body?.messages);
  if (!UUID.test(client) || !turns) {
    return NextResponse.json({ error: "A client and a conversation ending with your message are required." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  // A client opens only their own portals, and only those open to clients (viewer-rules.ts); staff any.
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  // A client's portal that is switched off or held serves them nothing, as their current portal (portal-open.ts).
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });

  const gate = admit(who, role, "chat", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ at: "[crm-preview] refused", who, kind: "chat", client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  try {
    const data = await loadPortalChatData(client);
    if (!data) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });

    // The same portal's market report the Reports page draws — group names and counts. Bounded as a whole
    // (finding the market included): a cold report still counting after MARKET_WAIT_MS says so, and finishes into the cache.
    const marketTotals = async (): Promise<MarketTotals> => {
      const report = marketContext(client).then(async (ctx): Promise<MarketTotals> => {
        if (!ctx) return { unavailable: "This portal has no market." };
        const r = await marketReport(ctx);
        return "unavailable" in r ? r : { total: r.total, groups: r.groups };
      });
      const wait = new Promise<MarketTotals>((done) => setTimeout(() => done({ unavailable: "The market totals are still being counted — ask again in a minute." }), MARKET_WAIT_MS));
      return Promise.race([report, wait]);
    };

    const out = await answer(turns, data, marketTotals);
    // Counted once answered (22 Oct audit: a failed answer counted too).
    served(who, "chat", 0);
    after(() => recordUse(createAdminSupabase(), { who, role, portalId: client, kind: "chat", rows: 0, now: new Date() }));
    console.info(JSON.stringify({ at: "[crm-preview] chat", who, client, turns: turns.length, tools: out.tools, tokens: out.tokens }));
    return NextResponse.json({ reply: out.reply }, { headers: NO_STORE_HEADERS });
  } catch (e) {
    console.error(JSON.stringify({ at: "[crm-preview] chat failed", who, client, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return NextResponse.json({ error: "The assistant couldn't answer just now. Please try again." }, { status: 502, headers: NO_STORE_HEADERS });
  }
}
