import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { inboxesAdded } from "@/lib/tools/analytics/campaign-inboxes-load";
import { addToCampaign } from "@/lib/tools/analytics/campaigns/inbox-add.ts";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { markInboxExtrasStale } from "@/lib/tools/analytics/inbox-extras-load";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

/*
 * Adds inboxes to ONE campaign (6 Nov — inbox-add.ts has the rules). One request a campaign, sent one after another by
 * the page, as the removal: it can say where it has got to and stop between two, and a run cut short has changed only
 * what it reported. Session-auth, confirmed, named in the audit log, honest per campaign.
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

// The campaigns being given inboxes this moment. One process: Next builds this module more than once (see cache/ttl.ts `shared`).
const RUNNING = Symbol.for("os.analytics.inboxAddRunning");
function runningNow(): Set<number> {
  const g = globalThis as unknown as Record<symbol, Set<number> | undefined>;
  return (g[RUNNING] ??= new Set());
}

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
  // Two runs adding to one campaign at once would each count the other's: one at a time, said plainly.
  const running = runningNow();
  if (running.has(campaignId)) {
    return NextResponse.json(
      { campaignId, name: `#${campaignId}`, ok: false, outcome: "failed", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0, error: "Someone else is adding inboxes to this campaign right now. Try it again in a moment." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  running.add(campaignId);

  const eb = createEmailBisonClient();
  const sb = getAnalyticsSupabase();
  let name = `#${campaignId}`;
  let statusBefore: string | null = null;
  try {
    const result = await addToCampaign(
      {
        status: async (id) => {
          const c = await eb.getCampaign(id);
          if (c.name) name = String(c.name);
          statusBefore = String(c.status);
          return statusBefore;
        },
        count: (id) => eb.getCampaignSenderEmailCount(id),
        attach: (id, ids) => eb.attachSenderEmails(id, ids),
      },
      { campaignId, inboxIds },
    );

    // Only what reached EmailBison is history: a finished campaign left alone changed nothing.
    if (result.outcome !== "finished") {
      const { error } = await sb.from("campaign_audit_log").insert({
        team_id: analyticsTeamId(),
        campaign_id: campaignId,
        platform: "emailbison",
        campaign_ref: String(campaignId),
        campaign_name: name,
        action: "attach-inboxes",
        actor: session.email,
        status: result.ok ? "ok" : "error",
        error: result.error ?? null,
        before_state: { from: "inboxes page", inbox_ids: inboxIds, inboxes: result.before, status: statusBefore },
        after_state: result.after !== null ? { applied: result.added, already_on: result.alreadyOn, inboxes: result.after, dropped: result.dropped } : null,
        batch_id: batchId,
      });
      if (error) console.error("[api/campaigns/inboxes/add/run] audit:", error.message);
    }
    if (result.added > 0 || result.outcome === "failed") {
      inboxesAdded(campaignId);
      markInboxExtrasStale();
    }
    return NextResponse.json({ ...result, name }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/campaigns/inboxes/add/run]", e);
    return NextResponse.json({ error: describeEmailBisonError(e) }, { status: 502 });
  } finally {
    running.delete(campaignId);
  }
}
