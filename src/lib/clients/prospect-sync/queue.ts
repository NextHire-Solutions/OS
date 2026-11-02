import { osTable } from "@/lib/clients/os-db";
import { env } from "@/lib/env";
import { postSlackMessage } from "@/lib/tools/master-inbox/webhooks/slack";

import { chunks, prospectsSlackText, syncMode, type Env, type SyncMode } from "./rules.ts";

/*
 * A change to a portal's Prospects, recorded for the background run (run.ts) — one row per agent — and told to
 * #portal-update. Called by the portal's own saves (crm-preview/portal-save.ts) BEFORE the list itself changes (the
 * run checks the list as it is when it gets there, so a save that stops half way never leaves the two apart): an
 * agent moved onto Prospects ("add"), or off it ("remove" — to My Agents, the DNC List or no list).
 *
 * Recorded whatever the switch says (2 Nov audit: a pick made while it was off was otherwise lost for good — the run
 * applies it once it is on), never for the Demo Portal; Slack hears only when the change will be acted on.
 */

/** A campaign the portal showed the agent in when it was taken off Prospects (the agent database's v_agent_campaigns). */
export interface ShownCampaign {
  provider: string;
  id: string;
  name: string | null;
  /** EmailBison: the address(es) its lead in that campaign has (bison_client_leads) — searched even if the agent's changed. */
  emails?: string[];
}

export interface ChangedAgent {
  id: string;
  name: string | null;
  /** A removal: the campaigns that made it a prospect — the run looks in these too, whatever its mapping says by then. */
  inCampaigns?: readonly ShownCampaign[];
}

/** A change is not looked at before this — its save (which records first) is changing the list meanwhile. */
export const GRACE_MS = 90_000;

export interface RecordInput {
  portalId: string;
  isDemo: boolean;
  osClientId: string | null;
  clientName: string;
  action: "add" | "remove";
  source: "setup" | "prospects";
  agents: readonly ChangedAgent[];
  who: string;
  /** The client's Prospects campaign as it stands, for Slack (null: not known yet). */
  campaign?: string | null;
}

export async function recordProspectChanges(input: RecordInput, o: { env?: Env; now?: Date; slack?: (text: string) => Promise<unknown> } = {}): Promise<{ mode: SyncMode; recorded: number }> {
  const mode = syncMode(input.portalId, input.isDemo, o.env);
  const agents = [...new Map(input.agents.map((a) => [a.id, a])).values()];
  if (input.isDemo || !agents.length) return { mode, recorded: 0 };
  const now = (o.now ?? new Date()).toISOString();

  // Every change its own row, even one like a change still waiting: the run groups an agent's rows and does the newest
  // that matches the list (3 Nov audit: reusing a waiting row let the run judge it before this save had changed the
  // list — and the change was lost). Nothing waiting is set aside here either.
  for (const part of chunks(agents, 500)) {
    const r = await osTable("os_prospect_sync").insert(part.map((a) => ({
      portal_id: input.portalId, os_client_id: input.osClientId, agent_id: a.id, action: input.action, source: input.source,
      status: "pending", requested_by: input.who, test: mode === "test", created_at: now, updated_at: now,
      // Not before the save has changed the list (it records first): a moment's grace.
      next_try_at: new Date(Date.parse(now) + GRACE_MS).toISOString(),
      in_campaigns: input.action === "remove" && a.inCampaigns?.length ? a.inCampaigns : null,
    })));
    if (r.error) throw new Error(`os_prospect_sync: ${r.error.message}`);
  }

  if (mode === "off") return { mode, recorded: agents.length };
  const names = agents.map((a) => (a.name ?? "").trim() || "an agent");
  const text = prospectsSlackText({
    client: input.clientName, who: input.who, setup: input.source === "setup", campaign: input.campaign ?? null, test: mode === "test",
    added: input.action === "add" ? names : [], removed: input.action === "remove" ? names : [],
  });
  await (o.slack ?? postToPortalChannel)(text);
  return { mode, recorded: agents.length };
}

/** #portal-update — the portal posts' own channel (never throws; nothing when Slack is not set up). */
export async function postToPortalChannel(text: string): Promise<boolean> {
  return postSlackMessage({ channel: env.SLACK_CHANNEL_PORTAL, text });
}

/** A Prospects change the portal made but could not record: our team hears of it (the campaign may be out of step). */
export async function unrecordedAlert(o: { portalId: string; action: "add" | "remove"; agents: number; who: string; error: string }): Promise<void> {
  try {
    const n = o.agents.toLocaleString("en-US");
    await osTable("os_notifications").upsert({
      kind: "prospect_sync", severity: "error",
      title: `Prospects change not recorded — campaign may be out of step`,
      body: `${o.who} ${o.action === "add" ? "added" : "removed"} ${n} prospect${o.agents === 1 ? "" : "s"} on portal ${o.portalId}, but it could not be recorded for the client's campaign (${o.error.slice(0, 300)}). Their Prospects list did change.`,
      ref: `prospect_sync:unrecorded:${new Date().toISOString()}:${o.portalId}`,
    }, { onConflict: "ref", ignoreDuplicates: true });
  } catch (err) {
    console.error("[prospect-sync] unrecorded alert", err instanceof Error ? err.message : err);
  }
}
