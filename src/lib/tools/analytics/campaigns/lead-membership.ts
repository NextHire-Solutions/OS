import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError, invalidIndices } from "@/lib/tools/analytics/emailbison/errors.ts";
import { getAnalyticsSupabase as getSupabase } from "@/lib/tools/analytics/supabase";
import { confirmOff, type CampaignSearch, type LeadLookup } from "./confirm-off.ts";

/*
 * Adding and removing a campaign's leads.
 *
 * Both directions change what real prospects receive, so both follow the rules
 * campaign actions already established: the caller is named in the audit log,
 * EmailBison is the authority, and nothing reports success it did not get.
 *
 * BATCHED, BECAUSE THE SELECTION CAN BE THOUSANDS. "Remove every lead that
 * never replied" on campaign 55 is ~6,000 ids. One request with 6,000 ids is a
 * request that times out halfway with no way to know what it did. Chunks are
 * small enough to succeed and are reported per chunk, so a partial failure
 * names exactly how far it got.
 *
 * SERIAL, NOT PARALLEL. These mutate one campaign's membership; firing chunks
 * concurrently at the same campaign invites the API to interleave them, and a
 * half-applied membership is not something you can diff afterwards.
 */

/**
 * Ids per request.
 *
 * EmailBison documents no cap. 500 is chosen to be obviously safe rather than
 * optimal: at 6,000 leads that is 12 calls, which costs a couple of seconds and
 * removes the failure mode where one oversized request dies and leaves the
 * campaign in a state nobody can describe.
 */
const CHUNK = 500;

export interface MembershipResult {
  ok: boolean;
  /** Ids we asked EmailBison to act on. */
  attempted: number;
  /**
   * What actually changed, measured as the campaign's own lead count before vs
   * after — NOT the number of ids we sent.
   *
   * EmailBison answers an attach with `success: true` and then silently drops
   * leads it will not accept. Verified: attaching three leads to a campaign
   * added two, because the third was `status: bounced`, and the response said
   * "Leads successfully added" either way. Reporting the requested count as the
   * applied count would mean telling someone 4,000 leads moved when 3,100 did.
   */
  applied: number;
  /** attempted − applied: ids EmailBison accepted the request for but did not act on. */
  skipped: number;
  chunks: Array<{ size: number; ok: boolean; message?: string; error?: string }>;
  batchId: string;
  /**
   * Removal only. Refused by EmailBison as not on the campaign AND confirmed
   * gone by two more EmailBison checks (confirm-off.ts) — now hidden here too.
   */
  alreadyOff?: number;
  /** Removal only. Refused as not on the campaign but not confirmed — left listed. */
  unconfirmed?: number;
}

/** Most refused ids double-checked in one removal; any beyond stay listed and are reported. */
const MAX_CONFIRM = 300;

/**
 * Of the ids EmailBison refused as "not on this campaign", the ones it
 * CONFIRMS are gone — see confirm-off.ts for the two checks and why. Reads
 * only. Every failure counts as unsure, so nothing is hidden on a guess.
 */
async function confirmGone(
  eb: ReturnType<typeof createEmailBisonClient>,
  campaignId: number,
  ids: number[],
): Promise<{ off: number[]; unsure: number[] }> {
  const off: number[] = [];
  const unsure: number[] = ids.slice(MAX_CONFIRM);
  const toCheck = ids.slice(0, MAX_CONFIRM);

  // Our copy of each lead's email, for a lead EmailBison has deleted outright.
  const known = new Map<number, string | null>();
  const sb = getSupabase();
  for (const part of chunk(toCheck, 500)) {
    const { data } = await sb.from("leads").select("id, email").in("id", part);
    for (const l of (data ?? []) as Array<{ id: number; email: string | null }>) known.set(Number(l.id), l.email);
  }

  // Eight at a time; the client's own gate paces EmailBison underneath.
  for (const part of chunk(toCheck, 8)) {
    await Promise.all(
      part.map(async (id) => {
        let lead: LeadLookup;
        try {
          const found = await eb.getLead(id);
          lead = found
            ? {
                status: "found",
                campaignIds: (found.lead_campaign_data ?? [])
                  .map((c) => Number(c.campaign_id))
                  .filter((n) => Number.isFinite(n)),
                email: found.email ?? null,
              }
            : { status: "deleted" };
        } catch {
          lead = { status: "error" };
        }
        const email = (lead.status === "found" ? lead.email : null) ?? known.get(id) ?? null;
        let search: CampaignSearch | null = null;
        if (email) {
          try {
            search = { ok: true, ...(await eb.searchCampaignLeads(campaignId, email)) };
          } catch {
            search = { ok: false };
          }
        }
        (confirmOff(campaignId, id, lead, search) === "off" ? off : unsure).push(id);
      }),
    );
  }
  return { off, unsure };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function audit(
  action: string,
  campaignId: number,
  teamId: number,
  actor: string,
  batchId: string,
  result: MembershipResult,
  extra: Record<string, unknown> = {},
) {
  const sb = getSupabase();
  const { data: campaign } = await sb
    .from("campaigns")
    .select("name")
    .eq("id", campaignId)
    .maybeSingle();

  await sb.from("campaign_audit_log").insert({
    team_id: teamId,
    campaign_id: campaignId,
    campaign_name: campaign?.name ?? `#${campaignId}`,
    action,
    actor,
    status: result.ok ? "ok" : "error",
    error: result.ok ? null : result.chunks.find((c) => !c.ok)?.error ?? "partial failure",
    before_state: { attempted: result.attempted, ...extra },
    after_state: { applied: result.applied },
    batch_id: batchId,
  });
}

/**
 * Removes leads from a campaign, then records it locally.
 *
 * THE LOCAL MARKER IS NOT OPTIONAL. campaign_leads is derived from send
 * history, so without `removed_at` the next sync recomputes every removed lead
 * straight back onto the screen — see migration 065. The send history itself is
 * deliberately left alone: removal stops future emails, it does not unsend the
 * ones already sent, and deleting those rows would rewrite the campaign's past.
 */
export async function removeLeads(
  campaignId: number,
  leadIds: number[],
  actor: string,
  teamId: number,
): Promise<MembershipResult> {
  const eb = createEmailBisonClient();
  const batchId = randomUUID();
  const result: MembershipResult = {
    ok: true,
    attempted: leadIds.length,
    applied: 0,
    skipped: 0,
    chunks: [],
    batchId,
  };

  // The count before, so `applied` can be measured rather than assumed.
  const before = await eb.getCampaignLeadCount(campaignId);
  const applied: number[] = [];
  // Ids EmailBison refused as not on this campaign — confirmed or not below.
  const refused: number[] = [];

  for (const part of chunk(leadIds, CHUNK)) {
    /*
     * ONE RETRY, WITHOUT THE IDS EMAILBISON NAMED.
     *
     * This DELETE is all-or-nothing: a single id that is not currently attached
     * refuses the whole batch and removes nothing. A selection made on screen
     * goes stale easily — someone else removed a lead, or a previous run
     * already did — and without this a 500-id chunk fails entirely because of
     * one. The 422 names the offending array indices, so they can be dropped
     * exactly and the remainder retried.
     *
     * Deliberately ONE retry, not a loop: the second attempt has already been
     * told every invalid index, so a second failure is a different problem and
     * retrying again would just be guessing.
     */
    let batch = part;
    let attempt = 0;

    for (;;) {
      try {
        const response = await eb.removeLeadsFromCampaign(campaignId, batch);
        result.chunks.push({
          size: batch.length,
          ok: true,
          message: response?.data?.message,
        });
        applied.push(...batch);
        break;
      } catch (error) {
        const bad = invalidIndices(error, "lead_ids");
        if (bad.length && attempt === 0 && bad.length < batch.length) {
          // Those ids are not on this campaign, which is the outcome the caller
          // wanted anyway. Drop them and remove the rest.
          const drop = new Set(bad);
          refused.push(...batch.filter((_, i) => drop.has(i)));
          batch = batch.filter((_, i) => !drop.has(i));
          attempt++;
          continue;
        }
        if (attempt === 0 && bad.length === batch.length && bad.every((i) => i < batch.length)) {
          // EmailBison says NONE of these are on the campaign, so there is
          // nothing to remove. Not a failure — but not taken on its word
          // either: confirmGone checks each one before anything is hidden.
          refused.push(...batch);
          result.chunks.push({ size: batch.length, ok: true, message: "None of these were on the campaign in EmailBison" });
          break;
        }
        result.ok = false;
        result.chunks.push({
          size: batch.length,
          ok: false,
          error: describeEmailBisonError(error),
        });
        // Keep going. A chunk refusing says nothing about the next, and stopping
        // would leave the caller unable to say which leads are still attached.
        break;
      }
    }
  }

  const after = await eb.getCampaignLeadCount(campaignId);
  result.applied = Math.max(0, before - after);
  result.skipped = Math.max(0, result.attempted - result.applied);

  const { off, unsure } = refused.length ? await confirmGone(eb, campaignId, refused) : { off: [], unsure: [] };
  result.alreadyOff = off.length;
  result.unconfirmed = unsure.length;

  /*
   * Marked only for the ids in chunks EmailBison accepted. Marking the whole
   * selection would claim a removal that did not happen, and the screen would
   * disagree with the campaign.
   */
  if (applied.length || off.length) {
    const sb = getSupabase();
    const stamp = new Date().toISOString();
    for (const part of chunk(applied, 1000)) {
      await sb
        .from("campaign_leads")
        .update({ removed_at: stamp, removed_by: actor })
        .eq("campaign_id", campaignId)
        .in("lead_id", part);
    }
    /*
     * Already off in EmailBison, confirmed three ways — hidden here so the list
     * matches the campaign and they cannot be picked again. Said so in
     * removed_by: this person did not remove them, EmailBison already had.
     */
    for (const part of chunk(off, 1000)) {
      await sb
        .from("campaign_leads")
        .update({ removed_at: stamp, removed_by: `${actor} (already off in EmailBison)` })
        .eq("campaign_id", campaignId)
        .in("lead_id", part);
    }
  }

  await audit("remove-leads", campaignId, teamId, actor, batchId, result, {
    alreadyOff: off.length,
    unconfirmed: unsure.length,
  });
  return result;
}

/**
 * Adds existing leads to a campaign.
 *
 * CLEARS `removed_at` for exactly the ids attached. A lead removed once and
 * legitimately added back would otherwise stay hidden behind the Removed facet
 * for ever, and the campaign would be sending to someone the screen says is
 * gone — the one disagreement between us and EmailBison that must not happen.
 */
export async function attachLeads(
  campaignId: number,
  leadIds: number[],
  actor: string,
  teamId: number,
  extra: Record<string, unknown> = {},
): Promise<MembershipResult> {
  const eb = createEmailBisonClient();
  const batchId = randomUUID();
  const result: MembershipResult = {
    ok: true,
    attempted: leadIds.length,
    applied: 0,
    skipped: 0,
    chunks: [],
    batchId,
  };

  const before = await eb.getCampaignLeadCount(campaignId);
  const applied: number[] = [];

  for (const part of chunk(leadIds, CHUNK)) {
    try {
      const response = await eb.attachLeadsToCampaign(campaignId, part);
      result.chunks.push({
        size: part.length,
        ok: true,
        message: response?.data?.message,
      });
      applied.push(...part);
    } catch (error) {
      result.ok = false;
      result.chunks.push({
        size: part.length,
        ok: false,
        error: describeEmailBisonError(error),
      });
    }
  }

  const after = await eb.getCampaignLeadCount(campaignId);
  result.applied = Math.max(0, after - before);
  result.skipped = Math.max(0, result.attempted - result.applied);

  if (applied.length) {
    const sb = getSupabase();
    for (const part of chunk(applied, 1000)) {
      await sb
        .from("campaign_leads")
        .update({ removed_at: null, removed_by: null })
        .eq("campaign_id", campaignId)
        .in("lead_id", part);
    }
  }

  await audit("attach-leads", campaignId, teamId, actor, batchId, result, extra);
  return result;
}
