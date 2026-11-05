import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { inboxesTakenOff } from "@/lib/tools/analytics/campaign-inboxes-load";
import { removeFromCampaign } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { markInboxExtrasStale } from "@/lib/tools/analytics/inbox-extras-load";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

/*
 * Takes inboxes off ONE campaign (5 Nov — inbox-removal.ts has the rules). One request a campaign, sent one after
 * another by the page: it can say where it has got to and stop between two, and a run cut short has changed only what
 * it reported. Follows every campaign write here: session-auth, confirmed, named in the audit log, honest per item.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({
  campaignId: z.number().int().positive(),
  inboxIds: z.array(z.number().int().positive()).min(1).max(10_000),
  /** Off unless someone ticked it: pausing stops real sending for a moment. */
  pauseActive: z.boolean(),
  batchId: z.string().uuid(),
  /** Taking inboxes off changes who sends for a campaign: not reachable by a mis-wired fetch. */
  confirm: z.literal(true),
});

// The campaigns being changed this moment. One process: Next builds this module more than once (see cache/ttl.ts `shared`).
const RUNNING = Symbol.for("os.analytics.inboxRemovalRunning");
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
      { error: missingConfirm ? "Removing inboxes from a campaign must be confirmed." : "Invalid request" },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const { campaignId, inboxIds, pauseActive, batchId } = parsed.data;
  // One change to a campaign at a time: two runs each counting 4 inboxes and taking 2 could together leave it empty.
  const running = runningNow();
  if (running.has(campaignId)) {
    return NextResponse.json(
      {
        campaignId, name: `#${campaignId}`, ok: false, outcome: "failed", applied: 0, before: null, left: null, paused: false, stillPaused: false, removedIds: [],
        error: "Someone else is changing this campaign right now. Try it again in a moment.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  running.add(campaignId);

  const eb = createEmailBisonClient();
  const sb = getAnalyticsSupabase();
  const teamId = analyticsTeamId();
  let name = `#${campaignId}`;
  let statusBefore: string | null = null;
  let triedToPause = false;
  const row = (action: string, ok: boolean, error: string | null, before: Record<string, unknown>, after: Record<string, unknown> | null) => ({
    team_id: teamId,
    campaign_id: campaignId,
    platform: "emailbison",
    campaign_ref: String(campaignId),
    campaign_name: name,
    action,
    actor: session.email,
    status: ok ? "ok" : "error",
    error,
    before_state: before,
    after_state: after,
    batch_id: batchId,
  });
  const record = async (rows: Array<ReturnType<typeof row>>) => {
    const { error } = await sb.from("campaign_audit_log").insert(rows);
    if (error) console.error("[api/campaigns/inboxes/removal/run] audit:", error.message);
  };

  try {
    const result = await removeFromCampaign(
      {
        status: async (id) => {
          const c = await eb.getCampaign(id);
          if (c.name) name = String(c.name);
          const status = String(c.status);
          statusBefore ??= status;
          return status;
        },
        count: (id) => eb.getCampaignSenderEmailCount(id),
        remove: (id, ids) => eb.removeSenderEmails(id, ids),
        pause: (id) => eb.pauseCampaign(id),
        resume: (id) => eb.resumeCampaign(id),
        // On the record before it happens: a run cut off here must not leave a paused campaign nobody can trace.
        beforePause: async (_id, status) => {
          triedToPause = true;
          await record([row("pause", true, null, { status, reason: "to remove inboxes" }, { status: "paused" })]);
        },
      },
      { campaignId, inboxIds, pauseActive },
    );

    // Only what reached EmailBison is history: a campaign left alone changed nothing.
    if (triedToPause || result.removedIds.length > 0 || result.outcome === "failed") {
      const rows = [
        row(
          "remove-inboxes",
          result.ok,
          result.error ?? null,
          { from: "inboxes page", inbox_ids: inboxIds, inboxes: result.before, status: statusBefore },
          // The ids that really came off, so they could be put back; a failure part way has some too.
          result.removedIds.length || result.ok ? { applied: result.applied, left: result.left, removed_ids: result.removedIds } : null,
        ),
      ];
      if (triedToPause && !result.paused) rows.push(row("pause", false, result.error ?? null, { status: statusBefore, reason: "to remove inboxes" }, null));
      if (result.paused) rows.push(row("resume", !result.stillPaused, result.stillPaused ? "It could not be started again." : null, { status: "paused", reason: "after removing inboxes" }, result.stillPaused ? null : { status: "queued" }));
      await record(rows);
      /*
       * The cached status moves only if it really stayed paused. Started again, it is sending as before, and writing
       * "queued" would take it out of the active figures until the next sync, for a change of seconds.
       */
      if (result.stillPaused) await sb.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
    }

    if (result.removedIds.length) {
      inboxesTakenOff(campaignId, result.removedIds);
      markInboxExtrasStale();
    }
    return NextResponse.json({ ...result, name }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/campaigns/inboxes/removal/run]", e);
    return NextResponse.json({ error: describeEmailBisonError(e) }, { status: 502 });
  } finally {
    running.delete(campaignId);
  }
}
