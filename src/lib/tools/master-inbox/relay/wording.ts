/*
 * How a hand-off reads on the conversation (plan §3.5: every send is recorded
 * on the conversation, "Sent to Angela at 10:42", so the team can always see
 * what reached whom) and on the Settings log. Pure and import-free, so the
 * browser component can use it too. Times are Eastern, the business's zone,
 * and never read from the clock.
 */

export type RelayStatus = "held" | "skipped" | "ready" | "practice" | "sending" | "sent" | "failed" | "bounced";

export interface RelayRecordView {
  id: string;
  kind: "handoff" | "follow_up";
  status: RelayStatus;
  reason: string | null;
  detail: string | null;
  brokerageName: string | null;
  campaignName: string | null;
  recipients: Array<{ name: string | null; email: string }>;
  practice: boolean;
  trigger: string | null;
  subject: string | null;
  pipelineAction: string | null;
  countsAsIntroduction: boolean;
  error: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  sentAt: string | null;
  bouncedAt: string | null;
  decidedBy: string | null;
}

export const REASON_TEXT: Record<string, string> = {
  evaluating: "Being checked.",
  later_replies_off: "Relaying the agent's later replies is switched off.",
  no_campaign: "The conversation has no campaign, so its brokerage cannot be known — never guessed from the inbox.",
  unknown_campaign: "The campaign does not match a brokerage — waiting for the team to assign it.",
  ambiguous_campaign: "The campaign name matches more than one brokerage — waiting for the team to assign it.",
  campaign_conflict: "The campaign points to one brokerage but the conversation is filed under another — waiting for the team.",
  no_roster_record: "The campaign's portal has no client record in the OS — waiting for the team to assign it.",
  ignored_campaign: "The team marked this campaign as not a brokerage campaign.",
  excluded: "Demo Portal is never sent to.",
  brokerage_not_active: "The brokerage is not active (paused, churned or onboarding).",
  billing_block: "The brokerage's portal is blocked for an unpaid invoice.",
  no_longer_interested: "The Interested label was taken off before it went.",
  stop_label: "The conversation carries a stop label.",
  already_introduced: "Already introduced to this brokerage by the team.",
  no_agent_reply: "There is no reply from the agent on this conversation to hand over.",
  auto_reply: "The reply is an out-of-office or automatic reply.",
  unsubscribe: "The agent asked to be removed.",
  no_agent_email: "The agent has no email address to reply to.",
  dnc: "The agent is on the brokerage's Do Not Contact list.",
  their_agent: "The agent is already on the brokerage's My Agents list.",
  their_staff: "One of the brokerage's own team — not handed to them.",
  no_recipients: "The brokerage has nobody with an email address to send to for this market — waiting for a contact.",
  hourly_cap: "The brokerage reached its hourly limit — it goes in the next hour.",
  hourly_cap_click: "Sent to brokerage was pressed, but the brokerage reached its hourly limit — it goes in the next hour.",
  already_delivered: "Already handed to this brokerage before — one delivery per agent per brokerage.",
  too_old: "Held too long to send now.",
  read_error: "Something could not be read, so it was held rather than guessed.",
  no_portal: "No client portal is linked to this brokerage, so its DNC and agent lists couldn't be checked — held rather than sent.",
  empty_reply: "The agent's reply has no text of its own.",
  stale_reply: "The agent's reply is more than two weeks older than the label — an old conversation labelled again, not handed off by itself. Introduce by hand if it should go.",
  send_failed: "Postmark refused it — nothing was sent.",
  send_unknown: "Postmark's answer did not come back, so it may have been sent — check Postmark's activity before sending again.",
  send_partial: "Postmark refused an address as inactive (an earlier bounce or spam report), so the others on it may have received it — check Postmark's activity before sending again.",
};

/** A send with no answer recorded after this long is reported as such (the record is never retried by itself). */
export const SENDING_STUCK_MS = 10 * 60 * 1000;

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "10:42 AM" — or "Oct 14, 10:42 AM" when given a different day to compare with. */
export function stamp(iso: string | null | undefined, sameDayAs?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  if (sameDayAs) {
    const a = DAY_TIME.format(new Date(t)).split(",")[0];
    const b = Number.isFinite(Date.parse(sameDayAs)) ? DAY_TIME.format(new Date(Date.parse(sameDayAs))).split(",")[0] : a;
    if (a !== b) return DAY_TIME.format(new Date(t));
  }
  return TIME.format(new Date(t));
}

function firstName(r: { name: string | null; email: string }): string {
  const n = (r.name ?? "").trim();
  return n ? n.split(/\s+/)[0] : r.email;
}

/** "Angela", "Angela and Lance", "Angela, Lance and Stan", "Angela and 3 others". */
export function recipientsPhrase(recipients: RelayRecordView["recipients"]): string {
  const names = recipients.map(firstName);
  if (!names.length) return "nobody";
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

export type LineTone = "sent" | "practice" | "waiting" | "stopped" | "problem";

/**
 * One line for the conversation, e.g. "Sent to Angela at 10:42 AM" — or "at
 * Oct 14, 10:42 AM" when it was not today. Pass `today` (the server's now):
 * without it there is no date at all, and a hand-off from last week reads as
 * if it were this morning. Times are Eastern, as everywhere in the OS.
 */
export function relayLine(r: RelayRecordView, today?: string | null): { tone: LineTone; text: string } {
  const who = recipientsPhrase(r.recipients);
  const at = (iso: string | null) => (iso ? ` at ${stamp(iso, today)}` : "");
  const what = r.kind === "follow_up" ? "Later reply" : "Hand-off";
  const reason = (r.reason && REASON_TEXT[r.reason]) || r.reason || "";
  const extra = r.detail ? ` (${r.detail})` : "";
  switch (r.status) {
    case "sent":
      return { tone: "sent", text: `${r.kind === "follow_up" ? "Later reply sent" : "Sent"} to ${who}${at(r.sentAt ?? r.decidedAt)}` };
    case "practice":
      return { tone: "practice", text: `Practice — would have gone to ${who}${at(r.decidedAt)}. Nothing was sent.` };
    case "ready":
      return {
        tone: "waiting",
        text: `${what} ready for ${r.brokerageName ?? "the brokerage"}: ${who}${r.practice ? " (practice — nothing will be sent)" : ""}`,
      };
    case "sending": {
      const since = Date.parse(r.decidedAt ?? "");
      const now = Date.parse(today ?? "");
      if (Number.isFinite(since) && Number.isFinite(now) && now - since > SENDING_STUCK_MS) {
        return { tone: "problem", text: `Sending to ${who}${at(r.decidedAt)} — no answer was recorded. Check Postmark's activity; it is never sent again by itself.` };
      }
      return { tone: "waiting", text: `Sending to ${who}…` };
    }
    case "held":
      return { tone: "waiting", text: `${what} held — ${reason}${extra}` };
    case "skipped":
      return { tone: "stopped", text: `Not handed to ${r.brokerageName ?? "the brokerage"} — ${reason}${extra}` };
    case "failed":
      return {
        tone: "problem",
        text:
          r.reason === "send_unknown"
            ? `Not confirmed — ${REASON_TEXT.send_unknown}`
            : r.reason === "send_partial"
              ? `Not confirmed — ${REASON_TEXT.send_partial}${r.error ? ` ${r.error}` : ""}`
              : `Not delivered — ${r.error ?? REASON_TEXT.send_failed}`,
      };
    case "bounced":
      // With several people on it, the others may well have received it: say whose address failed.
      return { tone: "problem", text: `${r.recipients.length > 1 ? "Did not reach everyone" : "Bounced"}${at(r.bouncedAt)} — ${r.error ?? who}` };
  }
}

/** The DB row → the view (snake_case → camelCase, defensive about types). */
export function recordView(row: Record<string, unknown>): RelayRecordView {
  const s = (k: string) => (typeof row[k] === "string" && (row[k] as string)) || null;
  const recipients = Array.isArray(row.recipients)
    ? (row.recipients as unknown[])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ name: typeof x.name === "string" ? x.name : null, email: String(x.email ?? "") }))
        .filter((x) => x.email)
    : [];
  return {
    id: String(row.id ?? ""),
    kind: row.kind === "follow_up" ? "follow_up" : "handoff",
    status: (s("status") ?? "held") as RelayStatus,
    reason: s("reason"),
    detail: s("detail"),
    brokerageName: s("brokerage_name"),
    campaignName: s("campaign_name"),
    recipients,
    practice: row.practice !== false,
    trigger: s("trigger"),
    subject: s("subject"),
    pipelineAction: s("pipeline_action"),
    countsAsIntroduction: row.counts_as_introduction === true,
    error: s("error"),
    createdAt: s("created_at"),
    decidedAt: s("decided_at"),
    sentAt: s("sent_at"),
    bouncedAt: s("bounced_at"),
    decidedBy: s("decided_by"),
  };
}
