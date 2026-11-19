/*
 * TICKETS — how a ticket's state moves. Pure: every function takes the ticket as it is and returns the change.
 *
 * Statuses (research, 20 Nov: Front, Hiver and Help Scout settle on three): OPEN — the client is waiting on us;
 * WAITING — we've answered, the client is up; DONE — finished. Plus IGNORED ("not a ticket": an FYI, a thank-you)
 * and a SNOOZE (Waiting until a time, then back to Open).
 *
 *  - A client's new email moves Waiting, Done, Ignored or Snoozed back to Open and KEEPS the assignee (every tool
 *    that doesn't do this loses client mail silently — Intercom's default is the cautionary tale).
 *  - A teammate's reply (synced from their Sent mail) moves Open to Waiting: the team answers in Gmail, so the
 *    queue keeps itself without anyone touching the ticket.
 *  - Automatic mail (out-of-office, mailing lists) never opens or reopens anything.
 *  - "Waiting since" = the client's oldest message we haven't answered (Help Scout's rule: notes don't reset it).
 *
 * Only the latest message decides: messages may be processed out of order (several mailboxes, a first fill), so
 * every rule compares send times instead of trusting arrival order.
 */

export type TicketStatus = "open" | "waiting" | "done" | "ignored";

export interface TicketState {
  status: TicketStatus;
  assignee: string | null;
  snoozed_until: string | null;
  first_message_at: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_activity_at: string | null;
  waiting_since: string | null;
  first_response_at: string | null;
  message_count: number;
  snippet: string | null;
  closed_at: string | null;
  closed_by: string | null;
}

export interface IncomingMessage {
  direction: "in" | "out";
  sentAt: string;
  auto: boolean;
  snippet: string;
  /** Who sent it, as people know them ("Amy", "Jane Roe"). */
  who: string;
}

export interface TicketEvent {
  kind: "status" | "assign" | "snooze" | "reopened" | "created" | "client" | "note" | "gmail";
  actor: string | null;
  body?: string | null;
  from_value?: string | null;
  to_value?: string | null;
}

export interface Change { patch: Partial<TicketState>; events: TicketEvent[] }

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const later = (a: string | null, b: string) => (a && t(a) >= t(b) ? a : b);
const earlier = (a: string | null, b: string) => (a && t(a) <= t(b) ? a : b);

/** A new ticket's starting state (before its first message is applied). */
export function blankTicket(): TicketState {
  return {
    status: "open", assignee: null, snoozed_until: null, first_message_at: null, last_message_at: null, last_inbound_at: null,
    last_outbound_at: null, last_activity_at: null, waiting_since: null, first_response_at: null, message_count: 0, snippet: null,
    closed_at: null, closed_by: null,
  };
}

/**
 * What one newly stored email does to its ticket. `importing`: the ticket is being filled from history (first
 * fill, or a conversation's earlier messages) — its status is settled once at the end (settleImported), so no
 * reopen/waiting events are written for messages from last month.
 */
export function applyMessage(s: TicketState, m: IncomingMessage, importing = false): Change {
  const patch: Partial<TicketState> = {
    message_count: s.message_count + 1,
    first_message_at: earlier(s.first_message_at, m.sentAt),
    last_message_at: later(s.last_message_at, m.sentAt),
    last_activity_at: later(s.last_activity_at, m.sentAt),
  };
  const newest = !s.last_message_at || t(m.sentAt) >= t(s.last_message_at);
  if (newest && m.snippet) patch.snippet = m.snippet.slice(0, 280);
  const events: TicketEvent[] = [];

  if (m.direction === "in") {
    patch.last_inbound_at = later(s.last_inbound_at, m.sentAt);
    if (m.auto) return { patch, events };
    const answeredAfter = s.last_outbound_at && t(s.last_outbound_at) >= t(m.sentAt);
    if (!answeredAfter) patch.waiting_since = earlier(s.waiting_since, m.sentAt);
    const afterOurs = !s.last_outbound_at || t(m.sentAt) > t(s.last_outbound_at);
    const afterClose = !s.closed_at || t(m.sentAt) > t(s.closed_at);
    if (!importing && afterOurs && afterClose && (s.status !== "open" || s.snoozed_until)) {
      patch.status = "open";
      patch.snoozed_until = null;
      patch.closed_at = null;
      patch.closed_by = null;
      events.push({ kind: "reopened", actor: null, from_value: s.snoozed_until ? "snoozed" : s.status, to_value: "open", body: `${m.who} wrote again` });
    }
    return { patch, events };
  }

  // Ours.
  patch.last_outbound_at = later(s.last_outbound_at, m.sentAt);
  const answers = !s.last_inbound_at || t(m.sentAt) >= t(s.last_inbound_at);
  if (s.last_inbound_at && t(m.sentAt) >= t(s.last_inbound_at)) {
    patch.waiting_since = null;
    // The earliest reply that answered the client (out-of-order history can leave it unset: the timeline still shows it).
    if (!s.first_response_at || t(m.sentAt) < t(s.first_response_at)) patch.first_response_at = m.sentAt;
  }
  if (!importing && answers && s.status === "open" && !s.snoozed_until) {
    patch.status = "waiting";
    events.push({ kind: "status", actor: null, from_value: "open", to_value: "waiting", body: `${m.who} replied from Gmail` });
  }
  return { patch, events };
}

/** Conversations quiet this long when first imported start as Done, so the first fill isn't a wall of old "Open". */
export const STALE_IMPORT_DAYS = 7;

/** A just-imported ticket's status, from its latest message: the client's → Open, ours → Waiting, old → Done. */
export function settleImported(s: TicketState, lastWasClient: boolean, now = Date.now()): Change {
  const quietDays = (now - t(s.last_message_at)) / 86_400_000;
  if (Number.isFinite(quietDays) && quietDays >= STALE_IMPORT_DAYS) {
    return {
      patch: { status: "done", closed_at: new Date(now).toISOString(), closed_by: null, waiting_since: null },
      events: [{ kind: "status", actor: null, from_value: null, to_value: "done", body: `Imported as Done: no new email for ${Math.floor(quietDays)} days` }],
    };
  }
  return { patch: { status: lastWasClient ? "open" : "waiting" }, events: [] };
}

/* ---------------------------------------------------------------- people's actions --- */

export type Action =
  | { type: "status"; to: TicketStatus }
  | { type: "assign"; to: string | null }
  | { type: "snooze"; until: string | null };

/** What a teammate's action changes, or null when it changes nothing. */
export function act(s: TicketState, a: Action, actor: string, now = Date.now()): Change | null {
  const iso = new Date(now).toISOString();
  if (a.type === "assign") {
    const to = a.to ? a.to.toLowerCase() : null;
    if ((s.assignee ?? null) === to) return null;
    return { patch: { assignee: to }, events: [{ kind: "assign", actor, from_value: s.assignee, to_value: to }] };
  }
  if (a.type === "snooze") {
    if (a.until === null) {
      if (!s.snoozed_until) return null;
      return { patch: { snoozed_until: null, status: "open" }, events: [{ kind: "snooze", actor, from_value: s.snoozed_until, to_value: null, body: "Snooze cancelled" }] };
    }
    if (!(t(a.until) > now)) return null;
    return {
      patch: { snoozed_until: a.until, status: "waiting", closed_at: null, closed_by: null },
      events: [{ kind: "snooze", actor, from_value: s.snoozed_until, to_value: a.until }],
    };
  }
  if (s.status === a.to && !s.snoozed_until) return null;
  const patch: Partial<TicketState> = { status: a.to, snoozed_until: null };
  if (a.to === "done" || a.to === "ignored") { patch.closed_at = iso; patch.closed_by = actor; }
  else { patch.closed_at = null; patch.closed_by = null; }
  return { patch, events: [{ kind: "status", actor, from_value: s.snoozed_until ? "snoozed" : s.status, to_value: a.to }] };
}

/** A snooze whose time has come: back to Open. */
export function wake(s: TicketState, now = Date.now()): Change | null {
  if (!s.snoozed_until || t(s.snoozed_until) > now) return null;
  return { patch: { snoozed_until: null, status: "open" }, events: [{ kind: "snooze", actor: null, from_value: s.snoozed_until, to_value: null, body: "Snooze ended" }] };
}

/* ----------------------------------------------------------------------- display --- */

export type WaitTone = "fresh" | "warn" | "late";

/** How long the client has waited, as a tone: under 4 hours, under a day, a day or more. */
export function waitTone(waitingSince: string | null, now = Date.now()): WaitTone | null {
  if (!waitingSince) return null;
  const h = (now - t(waitingSince)) / 3_600_000;
  if (!Number.isFinite(h)) return null;
  return h < 4 ? "fresh" : h < 24 ? "warn" : "late";
}

/** "12m", "3h", "2d", "5w" — compact, for a chip. */
export function shortAge(iso: string | null, now = Date.now()): string {
  const ms = now - t(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}
