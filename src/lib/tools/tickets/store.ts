import type { TicketEvent, TicketState, TicketStatus } from "./ticket-rules.ts";
import type { Attachment, Address } from "./gmail-message.ts";

/*
 * TICKETS — what the sync and the screens need from the database, as an interface: the real one is
 * store-db.ts (the OS database through osTable), tests use memory-store.ts.
 */

export interface MailboxRow {
  email: string;
  name: string | null;
  connected_by: string;
  token_enc: string | null;
  scope: string | null;
  state: "syncing" | "ok" | "reconnect" | "paused";
  history_id: string | null;
  backfill_done_at: string | null;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  error_count: number;
  connected_at: string;
}

export interface TicketRow extends TicketState {
  id: string;
  number: number;
  os_client_id: string | null;
  match_method: "address" | "domain" | "manual" | null;
  subject: string;
  contact_email: string | null;
  contact_name: string | null;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  ticket_id: string;
  rfc_id: string;
  direction: "in" | "out";
  from_email: string | null;
  from_name: string | null;
  to_list: Address[];
  cc_list: Address[];
  subject: string | null;
  snippet: string | null;
  body_html: string | null;
  body_text: string | null;
  attachments: Attachment[];
  in_reply_to: string | null;
  refs: string[];
  sent_at: string;
}

export interface CopyRow { mailbox: string; gmail_id: string; gmail_thread_id: string; message_id: string; ticket_id: string; labels: string[] }

export interface EventRow extends TicketEvent {
  id: string;
  ticket_id: string;
  mentions: string[];
  created_at: string;
}

export type NewTicket = Pick<TicketRow, "os_client_id" | "match_method" | "subject" | "contact_email" | "contact_name"> & Partial<TicketState>;
export type NewMessage = Omit<MessageRow, "id">;

export interface TicketStore {
  /* mailboxes */
  listMailboxes(): Promise<MailboxRow[]>;
  claimMailbox(email: string, token: string, staleMs: number): Promise<boolean>;
  releaseMailbox(email: string, token: string, patch: Partial<MailboxRow>): Promise<void>;

  /* the sync's lookups */
  findCopy(mailbox: string, gmailId: string): Promise<CopyRow | null>;
  ticketForThread(mailbox: string, threadId: string): Promise<string | null>;
  messagesByRfc(rfcIds: readonly string[]): Promise<Array<Pick<MessageRow, "id" | "rfc_id" | "ticket_id">>>;
  anyBlocked(keys: readonly string[]): Promise<boolean>;
  block(keys: readonly string[], by: string | null): Promise<void>;

  /* writes */
  createTicket(t: NewTicket): Promise<TicketRow>;
  getTicket(id: string): Promise<TicketRow | null>;
  /** Insert unless the Message-ID is stored already; either way, the stored row's id and ticket. */
  insertMessage(m: NewMessage): Promise<{ id: string; ticket_id: string; inserted: boolean }>;
  insertCopy(c: CopyRow): Promise<void>;
  updateTicket(id: string, patch: Partial<TicketRow>): Promise<void>;
  addEvents(ticketId: string, events: ReadonlyArray<TicketEvent & { mentions?: string[] }>): Promise<void>;
  deleteTicket(id: string): Promise<void>;
  /** Tickets whose snooze has ended. */
  snoozeDue(nowIso: string): Promise<TicketRow[]>;
}
