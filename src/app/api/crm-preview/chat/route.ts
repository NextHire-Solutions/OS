import { after, NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
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
 * Owners and Eddy only, as the preview page: anyone else gets a bare 404.
 * Then the data guard (own page only, per-person limits). Then ONE portal's
 * data is loaded — the one named — and the assistant sees nothing else
 * (chat-tools.ts). It reads; it writes nothing anywhere.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET_WAIT_MS = 25_000;

export async function POST(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });
  const who = me!.email.toLowerCase();

  const body = (await request.json().catch(() => null)) as { client?: unknown; messages?: unknown } | null;
  const client = typeof body?.client === "string" ? body.client : "";
  const turns = parseTurns(body?.messages);
  if (!UUID.test(client) || !turns) {
    return NextResponse.json({ error: "A client and a conversation ending with your message are required." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const gate = admit(who, "staff", "chat", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ at: "[crm-preview] refused", who, kind: "chat", client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  try {
    const data = await loadPortalChatData(client);
    if (!data) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });
    served(who, "chat", 0);
    // Counted in the database; heavy or automated-looking CLIENT use rings the OS bell. Never refuses (usage.ts). Everyone here is our own team.
    after(() => recordUse(createAdminSupabase(), { who, role: "staff", portalId: client, kind: "chat", rows: 0, now: new Date() }));

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
    console.info(JSON.stringify({ at: "[crm-preview] chat", who, client, turns: turns.length, tools: out.tools, tokens: out.tokens }));
    return NextResponse.json({ reply: out.reply }, { headers: NO_STORE_HEADERS });
  } catch (e) {
    console.error(JSON.stringify({ at: "[crm-preview] chat failed", who, client, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return NextResponse.json({ error: "The assistant couldn't answer just now. Please try again." }, { status: 502, headers: NO_STORE_HEADERS });
  }
}
