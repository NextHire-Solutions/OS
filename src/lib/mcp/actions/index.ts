import "server-only";

import { signToken, verifyToken } from "@/lib/mcp/tokens";

import { actionTool, mayUse, runAction, type ActionDeps, type ActionSpec, type ActionViewer } from "./core.ts";
import { auditStore } from "./audit.ts";
import { clientCampaigns } from "./campaigns.ts";
import { campaignLimits, campaignPause, campaignStart } from "./campaign-one.ts";
import { campaignAddInboxes } from "./campaign-inboxes.ts";
import { campaignEditCopy } from "./campaign-edit.ts";
import { campaignCreate } from "./campaign-create.ts";
import { campaignAddAgents, campaignAddAgentsStop } from "./campaign-agents.ts";
import { inboxSetLabel, inboxSnooze } from "./inbox.ts";
import { inboxIntroduce, inboxReply } from "./outreach.ts";
import { enabledActions, type ActionName } from "./switch.ts";

/* The connector's actions (core.ts): which exist (switch.ts), who may (the screen's own switch), and their runner. */

const ALL: Record<ActionName, ActionSpec> = {
  inbox_set_label: inboxSetLabel as unknown as ActionSpec,
  inbox_snooze: inboxSnooze as unknown as ActionSpec,
  client_campaigns: clientCampaigns as unknown as ActionSpec,
  inbox_introduce: inboxIntroduce as unknown as ActionSpec,
  inbox_reply: inboxReply as unknown as ActionSpec,
  campaign_pause: campaignPause as unknown as ActionSpec,
  campaign_start: campaignStart as unknown as ActionSpec,
  campaign_limits: campaignLimits as unknown as ActionSpec,
  campaign_add_inboxes: campaignAddInboxes as unknown as ActionSpec,
  campaign_edit_copy: campaignEditCopy as unknown as ActionSpec,
  campaign_create: campaignCreate as unknown as ActionSpec,
  campaign_add_agents: campaignAddAgents as unknown as ActionSpec,
  campaign_add_agents_stop: campaignAddAgentsStop as unknown as ActionSpec,
};

/** The actions switched on (OS_MCP_ACTIONS) that this person may take. */
export function actionsFor(v: ActionViewer, env: Record<string, string | undefined> = process.env): ActionSpec[] {
  return [...enabledActions(env)].map((n) => ALL[n]).filter((s) => mayUse(s, v));
}

export const actionTools = (v: ActionViewer) => actionsFor(v).map(actionTool);

function deps(): ActionDeps {
  const secret = process.env.AUTH_SECRET ?? "";
  return {
    sign: (claims) => signToken(secret, "action", claims),
    verify: (token) => verifyToken(secret, "action", token),
    audit: auditStore,
    nonce: () => crypto.randomUUID(),
  };
}

/** Runs an action this person may take, or says it isn't available to them. */
export async function runConnectorAction(name: string, args: Record<string, unknown>, v: ActionViewer): Promise<unknown> {
  const spec = actionsFor(v).find((s) => s.name === name);
  if (!spec) return { done: false, refused: "That action isn't available to you through Claude." };
  return runAction(spec, args, v, deps());
}

export const isActionName = (name: string): boolean => Object.prototype.hasOwnProperty.call(ALL, name);
