import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal, mayWritePortal } from "@/lib/crm-preview/viewer-rules";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { campaignSaveLock, campaignsFailure, campaignsOn, saveCampaign } from "@/lib/crm-preview/campaigns";
import { isDemoPortal } from "@/lib/crm-preview/demo";
import { COPY_RULES } from "@/lib/crm-preview/campaign-copy";

/*
 * POST /api/crm-preview/campaign-save — { client, campaign, save }: one save of a campaign's emails from the portal's
 * Campaigns page (17 Nov 2026). On a real portal it is live in EmailBison at once, written to the campaign's history
 * and posted to #portal-update; on the Demo Portal it changes only its own sample rows (campaigns.ts).
 *
 * WHO, as every portal route: anyone who may not open the portal gets a bare 404 before anything is read; a client's
 * portal that is switched off or held serves them nothing; only the page's own fetch. Then the portal's write rule
 * (viewer-rules mayWritePortal) and, on a real portal, one its own save code would accept: switched on and not held
 * for an unpaid invoice (page.tsx `locked`, for staff too). A real portal only while OS_PORTAL_CAMPAIGNS has it on.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY = "Read-only preview — nothing here changes this client's campaigns.";

const text = (max: number) => z.string().max(max);
const saveBody = z.object({
  client: z.string().regex(UUID),
  campaign: z.string().regex(/^\d{1,12}$/),
  save: z.object({
    version: z.string().min(1).max(64),
    emails: z
      .array(
        z.object({
          id: z.number().int().positive().nullable(),
          // Checked against the rules in campaign-copy.ts; here only that it is a sane whole number.
          waitBefore: z.number().int().min(-1000).max(1000).nullable(),
          threadReply: z.boolean(),
          versions: z.array(z.object({ id: z.number().int().positive().nullable(), subject: text(1000), text: text(20000) })).min(1).max(20),
        }),
      )
      .min(1)
      .max(COPY_RULES.maxEmails + 5),
  }),
});

export async function POST(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const body = (await request.json().catch(() => null)) as { client?: unknown } | null;
  const client = typeof body?.client === "string" && UUID.test(body.client) ? body.client : null;
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  // A client's portal that is switched off or held serves them nothing, as their current portal (portal-open.ts).
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });
  const portal = client as string;
  if (!campaignsOn(portal)) return new NextResponse(null, { status: 404 });
  if (!mayWritePortal(viewer, portal)) return NextResponse.json({ error: READ_ONLY }, { status: 403, headers: NO_STORE_HEADERS });
  const gate = admit(who, role, "campaigns", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "campaign-save", who, client: portal, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  const parsed = saveBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "That change couldn't be read. Reload the page and try again." }, { status: 400, headers: NO_STORE_HEADERS });
  try {
    const lock = await campaignSaveLock(portal);
    if (lock) return NextResponse.json({ error: lock, code: "locked" }, { status: 409, headers: NO_STORE_HEADERS });
    const r = await saveCampaign(portal, parsed.data.campaign, parsed.data.save, who);
    console.info(JSON.stringify({ tag: "[crm-preview] save", kind: "campaign", who, role, client: portal, demo: isDemoPortal(portal), campaign: parsed.data.campaign, ok: r.ok, changes: r.ok ? r.value.summary.length : 0 }));
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.problems ? { problems: r.problems } : {}), ...(r.view ? { campaign: r.view } : {}) }, { status: r.status, headers: NO_STORE_HEADERS });
    return NextResponse.json({ ok: true, campaign: r.value.view, summary: r.value.summary }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const f = campaignsFailure(err, "save");
    console.error(JSON.stringify({ tag: "[crm-preview] campaign save failed", who, client: portal, campaign: parsed.data.campaign, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ error: f.error }, { status: f.status, headers: NO_STORE_HEADERS });
  }
}
