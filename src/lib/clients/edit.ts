import "server-only";

import { osTable } from "./os-db";
import { CLIENT_STATUSES, type ClientStatus } from "./client-status";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { updateClientRow } from "@/lib/tools/client-health/clientWrites";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";

/*
 * Editing a client from the workspace.
 *
 * ---------------------------------------------------------------------------
 * WHAT CAN BE EDITED, AND WHERE IT LANDS
 *
 *   aliases         os_clients + Analytics   the spellings the matchers use
 *   plan            Client Health            billing tier
 *   weeklyTarget    Client Health            introductions promised per week
 *   startDate       Client Health            drives the movement table
 *   billing*        Client Health            anchor date and interval
 *   status          os_clients               active / paused / churned / prospect
 *   notes           os_clients               ours alone
 *
 * ---------------------------------------------------------------------------
 * HOW THE CLIENT HEALTH LEG WRITES
 *
 * Through `clientWrites.ts` — the same `updateClientRow` the Client Health
 * screens use — straight into that tool's database. It used to PATCH the live
 * tool's /api/clients with a cookie derived from the dashboard password, and
 * that route had a trap: it assigned name / plan / weekly_target / start_date
 * / instantly_campaign_ids UNCONDITIONALLY, so a partial body cleared the
 * campaign links, and every write here had to read the row first and re-send
 * all five fields in full.
 *
 * `updateClientRow` has no such trap. Its `updateValues` applies only the keys
 * that are present, so `{ id, plan }` changes the plan and nothing else. The
 * read-then-resend is therefore gone, and with it the dependency on the live
 * tool and on CLIENT_HEALTH_URL / CLIENT_HEALTH_DASHBOARD_PASSWORD. One
 * validation path for every client write this workspace makes.
 *
 * ---------------------------------------------------------------------------
 * WHAT CANNOT BE EDITED FROM HERE
 *
 * Master Inbox's name and aliases. Its PATCH requires a signed-in browser
 * session, exactly like its DELETE, so the workspace cannot call it — and its
 * tables are off-limits to the guarded client by design. A rename there also
 * rewrites `slug`, which is the prefix of the live portal token's URL path.
 * Renaming is offered as the OS's DISPLAY name only, and the note on screen
 * says so.
 */

export const PLANS = ["minimum", "production", "partner"] as const;
export const BILLING_INTERVALS = ["biweekly", "28-days", "monthly", "custom"] as const;

export interface ClientEdit {
  name?: string;
  aliases?: string[];
  status?: ClientStatus;
  notes?: string | null;
  plan?: (typeof PLANS)[number];
  weeklyTarget?: number;
  startDate?: string | null;
  billingInterval?: (typeof BILLING_INTERVALS)[number];
  billingAnchorDate?: string | null;
}

export interface EditResult {
  updated: string[];
  failed: { what: string; error: string }[];
  /** Things the workspace deliberately did not change, and why. */
  untouched: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Row {
  id: string;
  name: string;
  an_client_id: string | null;
  ch_client_id: string | null;
  mi_client_id: string | null;
}

export function validateEdit(edit: ClientEdit): string[] {
  const errors: string[] = [];
  if (edit.name !== undefined && !edit.name.trim()) errors.push("Name cannot be empty.");
  if (edit.name !== undefined && edit.name.length > 80) {
    errors.push(`Name is ${edit.name.length} characters; Master Inbox allows 80.`);
  }
  if (edit.aliases && edit.aliases.length > 20) errors.push("At most 20 aliases.");
  if (edit.status !== undefined && !CLIENT_STATUSES.includes(edit.status)) {
    errors.push(`Status must be one of ${CLIENT_STATUSES.join(", ")}.`);
  }
  if (edit.plan !== undefined && !PLANS.includes(edit.plan)) {
    errors.push(`Plan must be one of ${PLANS.join(", ")}.`);
  }
  if (edit.weeklyTarget !== undefined &&
      (!Number.isInteger(edit.weeklyTarget) || edit.weeklyTarget < 0)) {
    errors.push("Weekly target must be a whole number of 0 or more.");
  }
  for (const [label, v] of [["Start date", edit.startDate], ["Billing anchor date", edit.billingAnchorDate]] as const) {
    if (v && !ISO_DATE.test(v)) errors.push(`${label} must be YYYY-MM-DD.`);
  }
  if (edit.billingInterval !== undefined && !BILLING_INTERVALS.includes(edit.billingInterval)) {
    errors.push(`Billing interval must be one of ${BILLING_INTERVALS.join(", ")}.`);
  }
  return errors;
}

export async function editClient(id: string, edit: ClientEdit): Promise<EditResult> {
  const errors = validateEdit(edit);
  if (errors.length) throw new Error(errors.join(" "));

  const { data, error } = await osTable("os_clients")
    .select("id, name, an_client_id, ch_client_id, mi_client_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the client: ${error.message}`);
  if (!data) throw new Error("No such client");
  const row = data as unknown as Row;

  const updated: string[] = [];
  const failed: EditResult["failed"] = [];
  const untouched: string[] = [];

  /* ---------------------------------------------------------- os_clients */
  const local: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (edit.name !== undefined) local.name = edit.name.trim();
  if (edit.aliases !== undefined) local.aliases = edit.aliases;
  if (edit.status !== undefined) local.status = edit.status;
  if (edit.notes !== undefined) local.notes = edit.notes;
  if (Object.keys(local).length > 1) {
    const { error: e } = await osTable("os_clients").update(local).eq("id", id);
    if (e) failed.push({ what: "the OS record", error: e.message });
    else updated.push("the OS record");
  }

  /* ----------------------------------------------------------- Analytics */
  if (edit.aliases !== undefined && row.an_client_id) {
    try {
      const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
      if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
      const token = await mintAnalyticsSession(
        secret,
        optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com",
      );
      const res = await fetch(`${baseUrlEnv("ANALYTICS_URL")}/api/clients/${row.an_client_id}`, {
        method: "PATCH",
        headers: { cookie: `bsa_session=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ aliases: edit.aliases }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      updated.push("Analytics aliases");
    } catch (e) {
      failed.push({ what: "Analytics aliases", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /* -------------------------------------------------------- Client Health */
  const touchesHealth =
    edit.plan !== undefined || edit.weeklyTarget !== undefined ||
    edit.startDate !== undefined || edit.billingInterval !== undefined ||
    edit.billingAnchorDate !== undefined;

  if (touchesHealth && row.ch_client_id) {
    try {
      // Only what was asked for. `updateClientRow` applies present keys and
      // leaves every other column alone — see the note at the top.
      const body: Record<string, unknown> = { id: row.ch_client_id };
      if (edit.plan !== undefined) body.plan = edit.plan;
      if (edit.weeklyTarget !== undefined) body.weekly_target = edit.weeklyTarget;
      if (edit.startDate !== undefined) body.start_date = edit.startDate;
      if (edit.billingInterval !== undefined) body.billing_interval = edit.billingInterval;
      if (edit.billingAnchorDate !== undefined) body.billing_anchor_date = edit.billingAnchorDate;

      const result = await updateClientRow(getClientHealthDb(), body);
      if (!result.ok) throw new Error(result.error);
      updated.push("Client Health plan and targets");
    } catch (e) {
      failed.push({ what: "Client Health", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /* ------------------------------------------------------- Master Inbox */
  if ((edit.name !== undefined || edit.aliases !== undefined) && row.mi_client_id) {
    untouched.push(
      "Master Inbox keeps its own name and aliases — its update endpoint needs a " +
        "signed-in browser session, and renaming there rewrites the slug that prefixes " +
        "the live portal URL. Change it in Master Inbox if it needs to match.",
    );
  }

  return { updated, failed, untouched };
}
