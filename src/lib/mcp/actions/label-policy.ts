import { isHostileLabel } from "@/lib/tools/master-inbox/inbox/dnc";
import { isInterestedLabel } from "@/lib/tools/master-inbox/inbox/interest";
import { isStopContactLabel } from "@/lib/tools/master-inbox/portals/stop-person-plan";
import { TRIGGER_LABELS } from "@/lib/tools/master-inbox/relay/rules";

/*
 * Which label changes Claude may make in this first set (25 Nov) — only those that change nothing outside the OS
 * beyond EmailBison's own Interested flag, and nothing about money. Pure; the OS's own label tests decide what each
 * name is (interest.ts, dnc.ts, stop-person-plan.ts, relay/rules.ts), so this can't drift from what a click does.
 *  - TO Interested or Meetings Booked: starts the hand-off to new clients (relay TRIGGER_LABELS), the Slack alert and
 *    per-lead billing (Meetings Booked is also a billed "booked call").
 *  - TO Introduction: makes the client's portal entry, texts and notifies.
 *  - TO Hostile / Unsubscribe / Do Not Contact / Add to Blocklist: stops the person in every campaign.
 *  - FROM Introduction: the relabel deletes the client's portal entry.
 *  - ANY change to a conversation EVER marked Interested or Meetings Booked: per-lead billing counts it unless its label
 *    NOW is a correction (Not Interested, Not Qualified, …) — so relabelling it can add it to or take it off a client's
 *    bill (usage-billing/leads.ts). Those stay in the Master Inbox.
 */
const isTrigger = (name: string | null | undefined) => (TRIGGER_LABELS as readonly string[]).includes((name ?? "").trim().toLowerCase());

export function labelPolicy(current: string | null, target: string, everPositive = false): { ok: true } | { ok: false; reason: string } {
  const where = "Do it in the Master Inbox, where its effects are shown.";
  const t = target.trim().toLowerCase();
  if ((current ?? "").trim().toLowerCase() === t) return { ok: false, reason: `It is already labelled ${target}.` };
  if ((current ?? "").trim().toLowerCase() === "introduction") {
    return { ok: false, reason: `This conversation is an Introduction: changing its label removes the client's portal entry. ${where}` };
  }
  if (isInterestedLabel(target) || isTrigger(target)) {
    return { ok: false, reason: `${target} isn't available through Claude yet: it starts the hand-off to the client, the Slack alert and per-lead billing. ${where}` };
  }
  if (t === "introduction") return { ok: false, reason: `Introduction isn't available here: it messages the client (use the inbox's Introduce). ${where}` };
  if (isHostileLabel(target) || isStopContactLabel(target)) {
    return { ok: false, reason: `${target} isn't available through Claude yet: it stops the person in every campaign. ${where}` };
  }
  if (everPositive) {
    return { ok: false, reason: `This conversation was marked Interested (or Meetings Booked) before: its label decides whether a per-lead client is billed for it, so it isn't changed through Claude. ${where}` };
  }
  return { ok: true };
}
