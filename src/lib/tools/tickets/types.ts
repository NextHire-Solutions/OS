/*
 * TICKETS — what the API hands the screen. No server imports: the screen imports these types.
 */

import type { Attachment, Address } from "./gmail-message";
import type { TicketStatus } from "./ticket-rules";
import type { View } from "./views";

export interface Person { email: string; name: string }

export interface TicketListItem {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  snoozedUntil: string | null;
  assignee: string | null;
  client: { id: string; name: string; status: string | null } | null;
  matchMethod: "address" | "domain" | "manual" | null;
  contact: { email: string | null; name: string | null };
  snippet: string | null;
  waitingSince: string | null;
  lastActivityAt: string;
  lastMessageAt: string | null;
  /** Who wrote last: the client side or us. */
  lastFrom: "client" | "team" | null;
  messageCount: number;
  receivedBy: string[];
  unread: boolean;
  needsFirstResponse: boolean;
}

export interface TicketList {
  ready: boolean;
  /** Why the screen can't work yet (the migration, the Google client). */
  setup?: string;
  view: View;
  rows: TicketListItem[];
  total: number;
  counts: Partial<Record<View, number>>;
  /** Unread tickets per view, for the dots. */
  unread: Partial<Record<View, number>>;
  viewers: Record<string, string[]>;
  team: Person[];
  clients: Array<{ id: string; name: string; status: string | null }>;
  mailboxes: Array<{ email: string; name: string | null; state: string }>;
  me: string;
  admin: boolean;
  /** The viewer's own mailbox, when connected, and whether it needs attention. */
  myMailbox: { email: string; state: string } | null;
}

export interface TicketMessageView {
  id: string;
  rfcId: string;
  direction: "in" | "out";
  /** Quoted or forwarded history was cut before storing: only the client's own words are here. */
  trimmed: boolean;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string | null;
  sentAt: string;
  html: string | null;
  text: string | null;
  attachments: Attachment[];
  receivedBy: string[];
  /** The viewer's own Gmail copy, for Open in Gmail; null when it isn't in their mailbox. */
  myGmailId: string | null;
}

export interface TicketEventView {
  id: string;
  kind: "note" | "status" | "assign" | "snooze" | "created" | "reopened" | "client" | "gmail";
  actor: string | null;
  body: string | null;
  mentions: string[];
  from: string | null;
  to: string | null;
  at: string;
}

export interface TicketDetail {
  ticket: TicketListItem & { closedAt: string | null; closedBy: string | null; firstResponseAt: string | null; createdAt: string };
  messages: TicketMessageView[];
  events: TicketEventView[];
  viewers: string[];
  /** Whether this viewer may remove the conversation from Tickets (an admin, or someone whose inbox holds it). */
  canRemove: boolean;
}

export interface MailboxView {
  email: string;
  name: string | null;
  connectedBy: string;
  state: "syncing" | "ok" | "reconnect" | "paused";
  connectedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  backfilled: boolean;
  /** Distinct tickets this inbox received (not those marked Not a ticket). */
  tickets: number;
  /** Email copies this inbox holds: client emails and the team's reply markers. */
  emails: number;
  mine: boolean;
}

export interface MailboxesPage {
  ready: boolean;
  setup?: string;
  /** The Tickets Google client and the token key are set on the OS. */
  googleConfigured: boolean;
  /** The environment settings still missing (admins see them). */
  missing: string[];
  callback: string;
  mailboxes: MailboxView[];
  team: Array<Person & { connected: boolean }>;
  me: string;
  admin: boolean;
}
