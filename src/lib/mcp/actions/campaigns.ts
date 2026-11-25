import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { applyToggle, planToggle, type PlannedCampaign, type ToggleAction } from "@/lib/tools/client-health/campaign-toggle";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";

/*
 * Pause or resume ALL of one client's campaigns through Claude (25 Nov) — Client Health's Play/Pause
 * (clients/campaigns POST), the same planToggle / applyToggle, for the people who hold the Client Health switch.
 * The preview is the toggle's own plan (live statuses; nothing is sent). The confirmation is bound to the exact
 * campaigns it listed: if that set changed (a campaign launched or stopped meanwhile), nothing is done and a new
 * preview is shown. Recorded in the toggle's log as "<email> via Claude".
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const line = (c: PlannedCampaign) => `${c.name} (${c.platform === "bison" ? "EmailBison" : "Instantly"}, ${c.status})`;

type Args = { client: string; action: ToggleAction };
type Bind = { clientId: string; campaigns: string[] };

async function resolveClient(name: string): Promise<{ id: string; name: string } | { error: string }> {
  const { data, error } = await getClientHealthDb().from("clients").select("id, name").order("name");
  if (error) return { error: `Client Health could not be read: ${error.message}` };
  const rows = (data ?? []) as Array<{ id: string; name: string }>;
  const n = norm(name);
  const exact = rows.filter((r) => norm(r.name) === n);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((r) => norm(r.name).includes(n));
  if (partial.length === 1) return partial[0];
  if (!partial.length) return { error: `No client called "${name}" in Client Health.` };
  return { error: `"${name}" matches several clients: ${partial.map((r) => r.name).join(", ")}. Which one?` };
}

export const clientCampaigns: ActionSpec<Args, Bind> = {
  name: "client_campaigns",
  title: "Pause or resume a client's campaigns",
  description:
    "Pause, or resume, ALL of one client's sending campaigns on EmailBison and Instantly, as Client Health's " +
    "Play/Pause does. Pausing stops their emails going out until resumed; resuming restarts only the campaigns this " +
    "pause stopped. The preview lists exactly which campaigns change and which are skipped, from their live statuses.",
  inputSchema: {
    type: "object",
    properties: {
      client: { type: "string", description: "The client's name." },
      action: { type: "string", enum: ["pause", "resume"] },
    },
    required: ["client", "action"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  needs: (grantsForRequest("/api/tools/client-health/clients/campaigns", "POST") ?? []) as ToolId[],
  parse(a) {
    const client = String(a.client ?? "").trim();
    const action = a.action === "pause" || a.action === "resume" ? a.action : null;
    if (!client) return { error: "Which client?" };
    if (!action) return { error: "action must be pause or resume." };
    return { client, action };
  },
  async preview(a) {
    const c = await resolveClient(a.client);
    if ("error" in c) return { ok: false, refusal: c.error };
    const plan = await planToggle(c.id, a.action);
    if (!plan.willChange.length) {
      const shown = plan.skipped.slice(0, 5).map((s) => `${line(s.campaign)}: ${s.reason}`);
      const more = plan.skipped.length > 5 ? `; and ${plan.skipped.length - 5} more` : "";
      const why = plan.skipped.length ? ` (${shown.join("; ")}${more})` : "";
      return { ok: false, refusal: `Nothing to ${a.action} for ${plan.clientName}${why}.` };
    }
    const verb = a.action === "pause" ? "Pause" : "Resume";
    return {
      ok: true,
      preview:
        `${verb} ${plan.willChange.length} campaign${plan.willChange.length === 1 ? "" : "s"} of ${plan.clientName}: ` +
        `${plan.willChange.map(line).join("; ")}.` +
        (plan.skipped.length ? ` Left as they are: ${plan.skipped.map((s) => `${line(s.campaign)} (${s.reason})`).join("; ")}.` : "") +
        (a.action === "pause" ? " Their emails stop going out until resumed." : " They start sending again."),
      details: { client: plan.clientName, willChange: plan.willChange, skipped: plan.skipped },
      bind: { clientId: c.id, campaigns: plan.willChange.map((x) => `${x.platform}:${x.id}`).sort() },
    };
  },
  async execute(a, v, bind) {
    const result = await applyToggle(bind.clientId, a.action, `${v.email} via Claude`);
    getWeekly.invalidate();
    console.info(`[mcp-action] ${v.email} via Claude: ${a.action} ${result.plan.clientName}: ${result.outcomes.filter((o) => o.ok).length}/${result.outcomes.length} ok`);
    return {
      client: result.plan.clientName,
      action: a.action,
      changed: result.outcomes.filter((o) => o.ok).map((o) => line(o.campaign)),
      failed: result.outcomes.filter((o) => !o.ok).map((o) => `${line(o.campaign)}: ${o.error ?? "failed"}`),
      stillHeldPaused: result.heldPaused,
    };
  },
};
