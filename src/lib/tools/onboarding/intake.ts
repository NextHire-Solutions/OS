import "server-only";

import { getOnboardingDb } from "./db";
import { nowIso } from "./orch-client";
import { notifyIntakeSlack } from "./slack";
import { intakeQA, referralSalesperson, toClientRow, type TfPayload } from "./typeform";

/*
 * A Typeform submission becomes a client. The tool's
 * `app/api/webhooks/typeform/route.ts` body, as a function.
 *
 * Idempotent on typeform_response_id — Typeform retries the same event, and a
 * retry must never re-announce. The client emails are NOT sent from here in the
 * tool either: they go out from the Calendly webhook after the call is booked.
 */

/**
 * Step 3 — assign the salesperson by name: find-or-create, then attach. The
 * tool's server action, including its status move new -> assigned (the
 * screen's own edit in client-writes.ts deliberately leaves `status` alone;
 * the intake path is the automation's, so it keeps the tool's bookkeeping).
 */
export async function assignSalespersonFromIntake(clientId: string, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!name) return;
  const db = getOnboardingDb();
  const { data: existing } = await db.from("orch_salespeople").select("id").ilike("name", name).limit(1);
  let salespersonId = (existing as { id: string }[] | null)?.[0]?.id;
  if (!salespersonId) {
    const { data: created, error } = await db.from("orch_salespeople")
      .insert({ name, role: "salesperson", active: true }).select("id").single();
    if (error) throw new Error(error.message);
    salespersonId = (created as { id: string }).id;
  }
  await db.from("orch_clients")
    .update({ salesperson_id: salespersonId, status: "assigned", updated_at: nowIso() })
    .eq("id", clientId).eq("status", "new");
  await db.from("orch_clients")
    .update({ salesperson_id: salespersonId, updated_at: nowIso() })
    .eq("id", clientId);
}

export async function handleTypeformIntake(payload: TfPayload): Promise<{ clientId: string; isNew: boolean }> {
  const row = toClientRow(payload);
  const db = getOnboardingDb();

  // Already processed? (Typeform retries the same event — never re-announce on retries.)
  const { data: existing } = await db.from("orch_clients")
    .select("id").eq("typeform_response_id", row.typeform_response_id).maybeSingle();
  const isNew = !existing;

  const { data, error } = await db.from("orch_clients")
    .upsert(row, { onConflict: "typeform_response_id" }).select("id").single();
  if (error) throw new Error(error.message);
  const clientId = (data as { id: string }).id;

  // Step 3 — auto-assign the salesperson from "Who helped you get started?" (Ryan/Scott).
  const referral = referralSalesperson(payload);
  if (referral) {
    try { await assignSalespersonFromIntake(clientId, referral); } catch (e) { console.error("auto-assign failed", e); }
  }

  // Automated on FIRST intake only: Slack announcement to #corofy_onboarding.
  if (isNew) {
    try {
      await notifyIntakeSlack({ clientId, clientName: row.client_name ?? "New client", qa: intakeQA(payload) });
    } catch (e) { console.error("intake slack failed", e); }
  }

  return { clientId, isNew };
}
