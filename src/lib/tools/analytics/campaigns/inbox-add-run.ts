import { inboxesAdded } from "@/lib/tools/analytics/campaign-inboxes-load";
import { addToCampaign } from "@/lib/tools/analytics/campaigns/inbox-add.ts";
import { readAttachHealth, type AttachHealthRead } from "@/lib/tools/analytics/campaigns/attach-health-io";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { markInboxExtrasStale } from "@/lib/tools/analytics/inbox-extras-load";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

/*
 * Adds inboxes to ONE campaign (6 Nov — inbox-add.ts has the rules): the Inboxes page's "Add to campaigns" run
 * (campaigns/inboxes/add/run/route.ts), moved here unchanged (27 Nov) so the Claude connector's add-inboxes action runs
 * exactly the same: one campaign at a time, only healthy inboxes (attach-health.ts, judged here whatever was shown),
 * named in the audit log, honest about what happened. The answer is the route's own response, with its status.
 */

// The campaigns being given inboxes this moment. One process: Next builds this module more than once (see cache/ttl.ts `shared`).
const RUNNING = Symbol.for("os.analytics.inboxAddRunning");
function runningNow(): Set<number> {
  const g = globalThis as unknown as Record<symbol, Set<number> | undefined>;
  return (g[RUNNING] ??= new Set());
}

/*
 * The health verdict for one run of the window (its batchId and the same ids), judged once and used for every campaign
 * of it: one run gives every campaign the same inboxes, and pays for the reads once. Ten minutes, then judged again.
 */
const VERDICTS = Symbol.for("os.analytics.inboxAddHealth");
async function healthFor(batchId: string, ids: number[]): Promise<AttachHealthRead> {
  const g = globalThis as unknown as Record<symbol, Map<string, { at: number; read: Promise<AttachHealthRead> }> | undefined>;
  const memo = (g[VERDICTS] ??= new Map());
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at > 10 * 60_000) memo.delete(k);
  const key = `${batchId}:${[...ids].sort((a, b) => a - b).join(",")}`;
  const hit = memo.get(key);
  if (hit) return hit.read;
  const read = readAttachHealth(ids);
  memo.set(key, { at: now, read });
  // A failed read isn't kept: the next campaign tries again.
  void read.then((r) => { if (!r.ok) memo.delete(key); });
  return read;
}

export interface InboxAddInput {
  campaignId: number;
  inboxIds: number[];
  batchId: string;
  /** Who, as the audit log names them. */
  actor: string;
  /** Where it was done from, for the audit log ("inboxes page" when not said). */
  from?: string;
}

const ok = (body: Record<string, unknown>) => ({ status: 200 as const, body });

export async function runInboxAdd(input: InboxAddInput): Promise<{ status: 200 | 502; body: Record<string, unknown> }> {
  const { campaignId, inboxIds, batchId, actor } = input;
  // Two runs adding to one campaign at once would each count the other's: one at a time, said plainly.
  const running = runningNow();
  if (running.has(campaignId)) {
    return ok({ campaignId, name: `#${campaignId}`, ok: false, outcome: "failed", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0, error: "Someone else is adding inboxes to this campaign right now. Try it again in a moment." });
  }
  running.add(campaignId);

  const eb = createEmailBisonClient();
  const sb = getAnalyticsSupabase();
  let name = `#${campaignId}`;
  let statusBefore: string | null = null;
  try {
    // Only healthy inboxes go on (attach-health.ts), judged here whatever the window showed. Unreadable health: none.
    const health = await healthFor(batchId, inboxIds);
    if (!health.ok) {
      return ok({ campaignId, name, ok: false, outcome: "failed", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0, error: health.error });
    }
    const healthy = health.health.healthy;
    const leftOutUnhealthy = inboxIds.length - healthy.length;
    if (!healthy.length) {
      return ok({ campaignId, name, ok: true, outcome: "unhealthy", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0, leftOutUnhealthy });
    }
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
      { campaignId, inboxIds: healthy },
    );
    result.leftOutUnhealthy = leftOutUnhealthy;

    // Only what reached EmailBison is history: a finished campaign left alone changed nothing.
    if (result.outcome !== "finished") {
      const { error } = await sb.from("campaign_audit_log").insert({
        team_id: analyticsTeamId(),
        campaign_id: campaignId,
        platform: "emailbison",
        campaign_ref: String(campaignId),
        campaign_name: name,
        action: "attach-inboxes",
        actor,
        status: result.ok ? "ok" : "error",
        error: result.error ?? null,
        before_state: { from: input.from ?? "inboxes page", inbox_ids: healthy, left_out_by_health: leftOutUnhealthy ? health.health.leftOut.map((x) => ({ id: x.id, reasons: x.kinds })) : [], inboxes: result.before, status: statusBefore },
        after_state: result.after !== null ? { applied: result.added, already_on: result.alreadyOn, inboxes: result.after, dropped: result.dropped } : null,
        batch_id: batchId,
      });
      if (error) console.error("[campaigns/inbox-add-run] audit:", error.message);
    }
    if (result.added > 0 || result.outcome === "failed") {
      inboxesAdded(campaignId);
      markInboxExtrasStale();
    }
    return ok({ ...result, name });
  } catch (e) {
    console.error("[campaigns/inbox-add-run]", e);
    return { status: 502, body: { error: describeEmailBisonError(e) } };
  } finally {
    running.delete(campaignId);
  }
}
