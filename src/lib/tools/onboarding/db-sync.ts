import "server-only";

import { getOnboardingDb } from "./db";
import { logDelivery } from "./deliveries";
import { getOrchClient, nowIso } from "./orch-client";
import { launchBisonCampaign } from "./connector-bison";
import { notifySlack, slackMention, esc } from "./slack";
import { automationEnabled } from "./settings";
import { flippedCampaignIds, LAUNCHED_STATUSES } from "./db-sync-pure";

/*
 * DB-only handshake with the DB app (their dev's design — no webhooks in either direction).
 *
 *   us -> them:  orch_clients.leads_inreview = true   (list human-confirmed; enrich it)
 *   them -> us:  bison_campaigns.leads_imported_campaign = true  (leads are in the campaign)
 *
 * This watcher reads their flips and marks the matching client
 * bison_leads_exported=true. With automation ON it then launches the campaign
 * too. In manual mode it stops after recording the import and pings Slack, so
 * the team knows the campaign is ready to launch from the client page. The
 * tool's `lib/db-sync.ts`. `bison_campaigns` is the DB app's table — read only.
 */

/** Manual mode: ping once per client — the delivery log is the dedupe. */
async function pingReadyToLaunch(clientId: string): Promise<void> {
  const db = getOnboardingDb();
  const { data: pinged } = await db.from("orch_connector_deliveries")
    .select("id").eq("client_id", clientId).eq("action", "campaign_ready_ping").limit(1);
  if (pinged?.length) return;
  const c = await getOrchClient(clientId);
  if (!c) return;
  const { count } = await db.from("orch_client_leads")
    .select("id", { count: "exact", head: true }).eq("client_id", clientId);
  await notifySlack({
    clientId, action: "campaign_ready_ping",
    text: `${slackMention()} :inbox_tray: The DB app finished importing leads for *${esc(c.client_name ?? "client")}*${count ? ` (${count} leads)` : ""} — the campaign is ready. Open the client page and hit *Launch campaign* when you want it live.`,
  }).catch(() => {});
}

async function autoLaunch(clientId: string): Promise<boolean> {
  const c = await getOrchClient(clientId);
  if (!c || LAUNCHED_STATUSES.includes(c.status ?? "")) return false;
  const r = await launchBisonCampaign(c); // sets status, logs, records the step-24 email as pending
  if (!r.ok) { console.error(`[db-sync] auto-launch failed for ${c.client_name}: ${r.error}`); return false; }
  const { count } = await getOnboardingDb().from("orch_client_leads")
    .select("id", { count: "exact", head: true }).eq("client_id", clientId);
  await notifySlack({
    clientId, action: "campaign_autolaunched",
    text: `:rocket: DB app finished importing leads for *${esc(c.client_name ?? "client")}* — campaign launched automatically${count ? ` (${count} leads)` : ""}.`,
  }).catch(() => {});
  return true;
}

export async function syncBisonImports(): Promise<{ updated: number }> {
  const auto = await automationEnabled();
  const db = getOnboardingDb();
  // Only clients still waiting on the export keep this cheap (usually 0 rows).
  const { data: waiting, error } = await db.from("orch_clients")
    .select("id, client_name, bison_campaign_id")
    .eq("leads_inreview", true).eq("bison_leads_exported", false)
    .not("bison_campaign_id", "is", null);

  let updated = 0;
  if (!error && waiting?.length) {
    const { data: done } = await db.from("bison_campaigns")
      .select("bison_campaign_id, raw").eq("leads_imported_campaign", true);
    const flipped = flippedCampaignIds((done ?? []) as { bison_campaign_id?: unknown; raw?: unknown }[]);
    for (const c of waiting as { id: string; bison_campaign_id: string }[]) {
      if (!flipped.has(String(c.bison_campaign_id))) continue;
      await db.from("orch_clients").update({ bison_leads_exported: true, updated_at: nowIso() }).eq("id", c.id);
      await logDelivery(c.id, "db_app", "bison_leads_exported", "ok",
        { via: "bison_campaigns.leads_imported_campaign", bison_campaign_id: c.bison_campaign_id }, null, null);
      if (auto) await autoLaunch(c.id); else await pingReadyToLaunch(c.id);
      updated++;
    }
  }

  // Exported earlier but not launched. Automation on: retry the launch (it may have failed
  // or the process died mid-way). Manual: make sure the "ready to launch" ping went out.
  const { data: stuck } = await db.from("orch_clients")
    .select("id").eq("bison_leads_exported", true)
    .not("bison_campaign_id", "is", null)
    .not("status", "in", `(${LAUNCHED_STATUSES.join(",")})`);
  for (const c of (stuck ?? []) as { id: string }[]) {
    if (auto) { if (await autoLaunch(c.id)) updated++; }
    else await pingReadyToLaunch(c.id);
  }

  return { updated };
}
