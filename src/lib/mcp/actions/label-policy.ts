import { isHostileLabel } from "@/lib/tools/master-inbox/inbox/dnc";
import { isInterestedLabel } from "@/lib/tools/master-inbox/inbox/interest";
import { isStopContactLabel } from "@/lib/tools/master-inbox/portals/stop-person-plan";
import { TRIGGER_LABELS } from "@/lib/tools/master-inbox/relay/rules";
import { CORRECTION_LABELS } from "@/lib/tools/analytics/inbox-positives";

/*
 * Label changes through Claude, and what each one sets off (25 Nov narrow set; 27 Nov the user: "almost everything except
 * billing changes"). Pure; the OS's own label tests decide what each name is (interest.ts, dnc.ts, stop-person-plan.ts,
 * relay/rules.ts, inbox-positives.ts), so this can't drift from what a click does. The preview SAYS every effect.
 *  - REFUSED: TO Introduction (use inbox_introduce: the label alone would announce to the client with no email) and
 *    FROM Introduction (the relabel deletes the client's portal entry).
 *  - TO Interested / Meetings Booked: the Slack Interested alert, the hand-off to direct-hand-off clients, per-lead billing.
 *  - TO a stop label: stops the person in every campaign (Hostile also blacklists in EmailBison).
 *  - On a conversation EVER Interested / Meetings Booked: a correction label (Not Interested, Not Qualified, …) takes it off
 *    a per-lead client's bill if not yet charged; leaving a correction puts it back (usage-billing/leads.ts).
 */
const isTrigger = (name: string | null | undefined) => (TRIGGER_LABELS as readonly string[]).includes((name ?? "").trim().toLowerCase());
const isCorrection = (name: string | null | undefined) => CORRECTION_LABELS.has((name ?? "").trim());

export function labelPolicy(current: string | null, target: string, everPositive = false): { ok: true; effects: string[] } | { ok: false; reason: string } {
  const t = target.trim().toLowerCase();
  if ((current ?? "").trim().toLowerCase() === t) return { ok: false, reason: `It is already labelled ${target}.` };
  if ((current ?? "").trim().toLowerCase() === "introduction") {
    return { ok: false, reason: "This conversation is an Introduction: changing its label removes the client's portal entry. Do it in the Master Inbox, where that is shown." };
  }
  if (t === "introduction") return { ok: false, reason: "Use the introduce action (inbox_introduce): it sends the introduction email and then labels it. The label alone would announce to the client with no email." };
  const effects: string[] = [];
  if (isInterestedLabel(target) || isTrigger(target)) {
    effects.push(
      "Within a minute: the Slack alert for an Interested lead (never for Demo Portal); if the client gets interested replies by direct hand-off, the reply is emailed to the client; a client billed per lead is billed for this lead." +
        (isTrigger(target) && !isInterestedLabel(target) ? " Meetings Booked also counts as a booked call." : ""),
    );
  }
  if (isHostileLabel(target)) effects.push("Hostile: the lead is blacklisted in EmailBison.");
  if (isStopContactLabel(target) || isHostileLabel(target)) effects.push("The person is stopped in every campaign, on EmailBison and Instantly.");
  if (everPositive && isCorrection(target) && !isCorrection(current)) effects.push("This lead was Interested before: this correction takes it off a per-lead client's bill if it hasn't been charged yet.");
  if (everPositive && isCorrection(current) && !isCorrection(target)) effects.push("This lead was Interested before and is corrected now: this label puts it back on a per-lead client's bill.");
  if (isInterestedLabel(current) && !isInterestedLabel(target)) effects.push("It is Interested now: EmailBison's Interested flag is cleared. A hand-off, Slack alert or billable lead already started is NOT undone.");
  if (/^not interested$/i.test(target.trim())) effects.push("EmailBison's Interested flag for this reply is cleared.");
  return { ok: true, effects };
}
