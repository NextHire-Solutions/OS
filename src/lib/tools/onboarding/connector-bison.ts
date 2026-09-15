import "server-only";

import { getOnboardingDb } from "./db";
import { onboardingEnv } from "./env";
import { hasDelivery, logDelivery, recordPendingEmail, type PendingRecord } from "./deliveries";
import { listTemplates } from "./templates";
import { CLIENT_SELECT, nowIso, type OrchClient } from "./orch-client";
import {
  bisonSequenceSteps, campaignName, isoWeekStart, PERSONA_FULL, PERSONA_POOL, scheduleIdFor,
} from "./connector-payloads";

/*
 * EmailBison connector (steps 12-15, 22, 23, 29). The tool's
 * `lib/connectors/bison.ts`. Base + key from ONBOARDING_BISON_BASE_URL /
 * ONBOARDING_BISON_API_KEY; auth `Authorization: Bearer <key>`. Bison stays
 * external — this is the one connector that still leaves the building.
 *
 * WHAT IS DIFFERENT FROM THE TOOL: the two places it emails the client — "your
 * campaign is live" on launch, and the intro_1/2/3 notifications — record a
 * pending-enablement delivery instead of sending (see deliveries.ts). The
 * campaign calls, the status writes, the intro records and the weekly-target
 * pause are all as the tool does them.
 */

type Json = Record<string, unknown>;

async function bison(path: string, init?: RequestInit): Promise<unknown> {
  const base = onboardingEnv("BISON_BASE_URL"), key = onboardingEnv("BISON_API_KEY");
  if (!base || !key) throw new Error("ONBOARDING_BISON_BASE_URL / ONBOARDING_BISON_API_KEY not set");
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", ...(init?.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Bison ${res.status} ${path}: ${JSON.stringify(json)?.slice(0, 300)}`);
  return json;
}
const data = (j: unknown): Json => {
  const o = (j ?? {}) as Json;
  return ("data" in o ? o.data : o) as Json;
};

const log = (clientId: string, action: string, status: string, request: unknown, response: unknown, error: string | null) =>
  logDelivery(clientId, "bison", action, status, request, response, error);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Steps 12-15 + 22 — create the campaign, add S1/S2/S3, schedule, sender pool, client tag. */
export async function buildBisonCampaign(c: OrchClient): Promise<{ ok: boolean; campaignId?: unknown; error?: string }> {
  const name = campaignName(c);
  const senderName = PERSONA_FULL; // locked — sole persona for all clients
  try {
    // 12 — create
    const campaign = data(await bison("/api/campaigns", { method: "POST", body: JSON.stringify({ name, type: "outbound" }) }));
    const campaignId = campaign.id;

    // 13 — sequences from the "campaign_copy" templates (Zillow Preferred by default)
    const copies = await listTemplates("campaign_copy");
    const vars = { brokerageName: c.client_name ?? "", brokerage: c.client_name ?? "", senderName };
    const steps = bisonSequenceSteps(copies, name, vars);
    if (steps.length) await bison(`/api/campaigns/v1.1/${campaignId}/sequence-steps`, { method: "POST", body: JSON.stringify({ title: `${c.client_name} sequence`, sequence_steps: steps }) });

    // 14 — schedule template by timezone
    const scheduleId = scheduleIdFor(c.timezone);
    await bison(`/api/campaigns/${campaignId}/create-schedule-from-template`, { method: "POST", body: JSON.stringify({ schedule_id: scheduleId }) });

    // 15 — attach the sender pool (locked to Nicole Pool; senders only returned when filtered by tag).
    const senders = (data(await bison(`/api/sender-emails?tag=${encodeURIComponent(PERSONA_POOL)}&per_page=200`)) as unknown as { id: unknown }[]) || [];
    const poolIds = Array.isArray(senders) ? senders.map((s) => s.id) : [];
    if (poolIds.length) await bison(`/api/campaigns/${campaignId}/attach-sender-emails`, { method: "POST", body: JSON.stringify({ sender_email_ids: poolIds }) });

    // 22 — client tag, attached to the campaign
    const tag = data(await bison("/api/tags", { method: "POST", body: JSON.stringify({ name: c.client_name }) }));
    if (tag?.id) await bison("/api/tags/attach-to-campaigns", { method: "POST", body: JSON.stringify({ tag_ids: [tag.id], campaign_ids: [campaignId] }) }).catch(() => {});

    await getOnboardingDb().from("orch_clients").update({
      bison_campaign_id: String(campaignId), bison_campaign_status: (campaign.status as string | undefined) ?? "draft",
      sender_name: c.sender_name ?? senderName, updated_at: nowIso(),
    }).eq("id", c.id);
    await log(c.id, "build_campaign", "ok", { name, scheduleId, senders: poolIds.length }, { campaignId }, null);
    return { ok: true, campaignId };
  } catch (e) {
    await log(c.id, "build_campaign", "error", { name }, null, msg(e));
    return { ok: false, error: msg(e) };
  }
}

/** Step 23 — launch (draft -> active via resume). */
export async function launchBisonCampaign(c: OrchClient): Promise<{ ok: boolean; error?: string; pending?: PendingRecord }> {
  if (!c.bison_campaign_id) return { ok: false, error: "no campaign built yet" };
  try {
    await bison(`/api/campaigns/${c.bison_campaign_id}/resume`, { method: "PATCH" });
    await getOnboardingDb().from("orch_clients").update({ bison_campaign_status: "active", status: "campaign_launched" }).eq("id", c.id);
    await log(c.id, "launch_campaign", "ok", { campaignId: c.bison_campaign_id }, null, null);
    // Step 24 — "Your campaign is live", once per client (resume after a pause must not re-send it).
    // Switched off in the OS: recorded as pending enablement rather than sent.
    let pending: PendingRecord | undefined;
    if (!(await hasDelivery(c.id, "bison", ["email:campaign_launched"]))) {
      pending = await recordPendingEmail(c.id, "campaign_launched", { target: "bison", action: "email:campaign_launched", via: "campaign launch" });
    }
    return { ok: true, pending };
  } catch (e) {
    await log(c.id, "launch_campaign", "error", { campaignId: c.bison_campaign_id }, null, msg(e));
    return { ok: false, error: msg(e) };
  }
}

/** Step 29 — pause. */
export async function pauseBisonCampaign(c: OrchClient): Promise<{ ok: boolean; error?: string }> {
  if (!c.bison_campaign_id) return { ok: false, error: "no campaign" };
  await bison(`/api/campaigns/${c.bison_campaign_id}/pause`, { method: "PATCH" });
  await getOnboardingDb().from("orch_clients").update({ bison_campaign_status: "paused", status: "paused" }).eq("id", c.id);
  await log(c.id, "pause_campaign", "ok", { campaignId: c.bison_campaign_id }, null, null);
  return { ok: true };
}

// ---------- Introductions engine (steps 24-26, 29) — driven by the intro webhooks ----------

/** Pause the campaign once this ISO-week's introductions reach the client's weekly target. */
async function maybePauseOnTarget(c: OrchClient) {
  const target = c.weekly_target ?? 0;
  if (!target || !c.bison_campaign_id) return;
  const { count } = await getOnboardingDb().from("orch_introductions").select("id", { count: "exact", head: true })
    .eq("client_id", c.id).gte("created_at", isoWeekStart(new Date()).toISOString());
  if ((count ?? 0) >= target) await pauseBisonCampaign(c);
}

/**
 * Core introduction handler (source-agnostic — Masterinbox or Bison). Records
 * the intro, records the client email for the first 3 as pending enablement
 * (intro_1/2/3), pauses on weekly target.
 */
export async function recordIntroduction(
  client: OrchClient,
  lead: { name?: string | null; company?: string | null; email?: string | null; ref?: string | null },
) {
  const db = getOnboardingDb();
  const agentName = (lead.name ?? "").trim();
  const { count } = await db.from("orch_introductions")
    .select("id", { count: "exact", head: true }).eq("client_id", client.id);
  const introNumber = (count ?? 0) + 1;

  await db.from("orch_introductions").insert({
    client_id: client.id, bison_lead_id: lead.ref ?? lead.email ?? "", agent_name: agentName,
    agent_company: lead.company ?? null, agent_email: lead.email ?? null, intro_number: introNumber,
  });

  // Steps 25-26: the tool emails the client for the first three introductions.
  let pending: PendingRecord | null = null;
  if (introNumber <= 3) {
    pending = await recordPendingEmail(client.id, `intro_${introNumber}`, {
      target: "bison", action: `email:intro_${introNumber}`, via: "introduction",
      extra: { agentName, agentCompany: lead.company ?? "" },
    });
  }
  await maybePauseOnTarget(client);
  return { ok: true, introNumber, emailed: false, pending };
}

async function findClient(apply: (q: ReturnType<ReturnType<typeof getOnboardingDb>["from"]>) => unknown): Promise<OrchClient | null> {
  const q = getOnboardingDb().from("orch_clients");
  const { data } = await (apply(q) as PromiseLike<{ data: unknown }>);
  return (data ?? null) as OrchClient | null;
}

/**
 * Handle a Masterinbox introduction webhook (event = "lead.introduction").
 * Client is identified by client.portal_url (stored on the portal push), then slug, then name.
 */
export async function handleMasterinboxEvent(payload: Json) {
  const pc = (payload?.client ?? {}) as { portal_url?: string; slug?: string; name?: string };
  const { portal_url, slug, name } = pc;
  let client: OrchClient | null = null;
  if (portal_url) client = await findClient((q) => q.select(CLIENT_SELECT).eq("portal_url", portal_url).maybeSingle());
  if (!client && slug) client = await findClient((q) => q.select(CLIENT_SELECT).ilike("portal_url", `%${slug}%`).maybeSingle());
  if (!client && name) client = await findClient((q) => q.select(CLIENT_SELECT).ilike("client_name", name).maybeSingle());
  if (!client) return { ignored: "no matching client", portal_url: pc.portal_url ?? null, name: pc.name ?? null };

  const lead = (payload?.lead ?? {}) as { name?: string; company?: string; email?: string };
  const result = await recordIntroduction(client, {
    name: lead.name, company: lead.company, email: lead.email,
    ref: (payload?.pipeline_entry_id as string | undefined) ?? (payload?.thread_id as string | undefined) ?? lead.email ?? null,
  });
  return { client: client.client_name, ...result };
}

/** Handle an inbound Bison webhook event. lead_interested => an introduction. (Legacy trigger.) */
export async function handleBisonEvent(payload: Json) {
  const event = (payload?.event ?? {}) as { type?: string };
  const type = String(event.type ?? payload?.event_type ?? "").toLowerCase();
  const d = (payload?.data ?? {}) as { campaign?: { id?: unknown }; scheduled_email?: { campaign_id?: unknown }; lead?: Json };
  const campaignId = d.campaign?.id ?? d.scheduled_email?.campaign_id;
  if (!campaignId) return { ignored: "no campaign id" };

  const c = await findClient((q) => q.select(CLIENT_SELECT).eq("bison_campaign_id", String(campaignId)).maybeSingle());
  if (!c) return { ignored: "no client for campaign " + campaignId };
  if (type !== "lead_interested") return { ignored: type };

  const lead = d.lead ?? {};
  const agentName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
  return recordIntroduction(c, { name: agentName, company: lead.company as string, email: lead.email as string, ref: String(lead.id ?? "") });
}
