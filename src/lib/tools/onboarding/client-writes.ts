import "server-only";

import { getOnboardingDb } from "./db";
import { validatePhoto } from "./people-types";
import { automationEnabled } from "./settings";
import { runSetupAutomation, type ChainReport } from "./step-actions";

/**
 * The profile edits on a client detail screen.
 *
 * Ported from the orchestrator's `app/actions.ts` (`assignSalespersonByName`,
 * `setTacName`, `setClientMls`, `setCopyStatus`) and `app/people-actions.ts`
 * (`setClientPhoto`).
 *
 * EVERY ONE OF THESE IS A LABEL. Between them they write nine columns on one
 * `orch_clients` row and, in one case, insert a person. Not one calls
 * EmailBison, Stripe, Gmail or the Client Portal, and not one causes the live
 * orchestrator to do anything — the things that DO are in `step-run.ts`, and
 * they refuse.
 *
 * Every statement below is scoped by `.eq("id", …)`. An `.update()` with no
 * filter rewrites every client in the table.
 */

type Result = { ok: boolean; error?: string };

const MAX_NAME = 120;

/**
 * Assign the salesperson by name: find-or-create, then attach.
 *
 * Covers the three things the tool's control does — pick an existing one, type
 * an existing one, type a new one — with a single call.
 *
 * The tool ALSO moved `status` from "new" to "assigned" here. That column is the
 * automation's own bookkeeping and deciding which clients its scheduler
 * considers; the workspace leaves it alone, the same choice the pipeline screen
 * already made when it started moving clients between stages.
 */
export async function assignSalespersonByName(clientId: string, rawName: string): Promise<Result> {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "give the salesperson a name" };
  if (name.length > MAX_NAME) return { ok: false, error: "that name is too long" };

  const db = getOnboardingDb();
  const { data: existing } = await db
    .from("orch_salespeople")
    .select("id")
    .ilike("name", name)
    .limit(1);

  let salespersonId = (existing?.[0]?.id as string | undefined) ?? null;
  if (!salespersonId) {
    const { data: created, error } = await db
      .from("orch_salespeople")
      // `role` explicitly, so a new person lands in the salesperson picker
      // rather than wherever the column default happens to put them.
      .insert({ name, role: "salesperson", active: true })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    salespersonId = created?.id as string;
  }

  const { error } = await db
    .from("orch_clients")
    .update({ salesperson_id: salespersonId, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * The Talent Acquisition Coordinator introduced in the "Meet Your Recruiting
 * Team" email. Free text with suggestions, like the tool: it is a name in an
 * email body, not a foreign key.
 */
export async function setTacName(clientId: string, tacName: string): Promise<Result> {
  const name = tacName.trim();
  if (name.length > MAX_NAME) return { ok: false, error: "that name is too long" };
  const { error } = await getOnboardingDb()
    .from("orch_clients")
    .update({ tac_name: name || null, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * The MLS the client recruits in.
 *
 * Editable because it genuinely changes: a client names one on the form and adds
 * a second once the team talks it through with them. Codes only, picked from the
 * `mls` table — free text would resolve to nothing and build an empty lead list
 * in silence.
 *
 * Nothing re-runs on save. Whoever changes it builds the lead list afterwards,
 * same as always — the "Build lead list" button on the client page.
 */
export async function setClientMls(clientId: string, codes: string[]): Promise<Result> {
  const clean = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (clean.some((c) => c.length > 40)) return { ok: false, error: "that does not look like an MLS code" };
  if (clean.length > 40) return { ok: false, error: "too many MLS codes" };
  const { error } = await getOnboardingDb()
    .from("orch_clients")
    .update({ mls: clean.join(", ") || null, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** The client's own photo — shown in place of their initials on the pipeline. */
export async function setClientPhoto(clientId: string, photo: string | null): Promise<Result> {
  const checked = validatePhoto(photo);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { error } = await getOnboardingDb()
    .from("orch_clients")
    .update({ photo_url: checked.value, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Copy approval — records the client's decision and, with the pipeline in
 * automatic mode, runs the set-up chain.
 *
 * The tool's `setCopyStatus(id, "approved")` flips the row and then, if the
 * automation master switch is on, calls `runSetupAutomation`: portal ->
 * onboarding emails -> team -> Health Dash -> campaign build -> lead list. That
 * chain is now ported (step-actions.ts) — with the four emails recorded as
 * pending enablement rather than sent — so the Settings "Pipeline mode" switch
 * means the same thing here as in the tool.
 *
 * The conditional `.neq("copy_status", "approved")` is the tool's own guard,
 * kept: it makes approval a one-shot, so a double-click or two teammates at once
 * cannot run the chain twice. Manual mode: approving records the approval and
 * stops there — the team runs each step from the buttons on the client page.
 */
export async function setCopyStatus(
  clientId: string,
  status: "approved" | "rejected",
): Promise<Result & { chain?: ChainReport["steps"] }> {
  const db = getOnboardingDb();
  if (status === "approved") {
    const { data: flipped, error } = await db
      .from("orch_clients")
      .update({ copy_status: "approved", status: "copy_approved", updated_at: new Date().toISOString() })
      .eq("id", clientId)
      .neq("copy_status", "approved")
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (flipped?.length && (await automationEnabled())) {
      const report = await runSetupAutomation(clientId);
      return { ok: true, chain: report.steps };
    }
    return { ok: true };
  }

  const { error } = await db
    .from("orch_clients")
    .update({ copy_status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
