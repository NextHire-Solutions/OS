import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { runInboxAdd } from "@/lib/tools/analytics/campaigns/inbox-add-run";

/*
 * Adds inboxes to ONE campaign (6 Nov — inbox-add.ts has the rules). One request a campaign, sent one after another by
 * the page, as the removal: it can say where it has got to and stop between two, and a run cut short has changed only
 * what it reported. Session-auth, confirmed, named in the audit log, honest per campaign. The run itself is
 * campaigns/inbox-add-run.ts (moved there unchanged, 27 Nov, so the Claude connector runs the same).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({
  campaignId: z.number().int().positive(),
  inboxIds: z.array(z.number().int().positive()).min(1).max(10_000),
  batchId: z.string().uuid(),
  /** Adding inboxes changes who sends for a campaign: not reachable by a mis-wired fetch. */
  confirm: z.literal(true),
});

export async function POST(request: NextRequest) {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      { error: missingConfirm ? "Adding inboxes to a campaign must be confirmed." : "Invalid request" },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const { campaignId, inboxIds, batchId } = parsed.data;
  const r = await runInboxAdd({ campaignId, inboxIds, batchId, actor: session.email });
  return r.status === 200
    ? NextResponse.json(r.body, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json(r.body, { status: r.status });
}
