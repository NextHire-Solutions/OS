import { randomUUID } from "node:crypto";

import { blankTicket } from "./ticket-rules.ts";
import type { CopyRow, EventRow, MailboxRow, MessageRow, NewMessage, NewTicket, TicketRow, TicketStore } from "./store.ts";

/** The TicketStore in memory, for tests. Behaves like the database: Message-IDs unique, copies keyed by (mailbox, gmail id). */
export class MemoryTicketStore implements TicketStore {
  mailboxes = new Map<string, MailboxRow & { claim_token?: string | null; claimed_at?: string | null }>();
  tickets = new Map<string, TicketRow>();
  messages = new Map<string, MessageRow>();
  copies = new Map<string, CopyRow>();
  events: EventRow[] = [];
  blocks = new Set<string>();
  private seq = 1000;

  addMailbox(email: string, extra: Partial<MailboxRow> = {}) {
    this.mailboxes.set(email, {
      email, name: null, connected_by: email, token_enc: "v1.x", scope: "gmail.readonly", state: "syncing", history_id: null,
      backfill_done_at: null, last_sync_at: null, last_ok_at: null, last_error: null, error_count: 0, connected_at: new Date().toISOString(), ...extra,
    });
  }

  async listMailboxes() { return [...this.mailboxes.values()].map((m) => ({ ...m })); }
  async claimMailbox(email: string, token: string, staleMs: number) {
    const m = this.mailboxes.get(email);
    if (!m) return false;
    if (m.claim_token && m.claimed_at && Date.now() - Date.parse(m.claimed_at) < staleMs) return false;
    m.claim_token = token;
    m.claimed_at = new Date().toISOString();
    return true;
  }
  async renewClaim(email: string, token: string) {
    const m = this.mailboxes.get(email);
    if (m && m.claim_token === token) m.claimed_at = new Date().toISOString();
  }
  async releaseMailbox(email: string, token: string, patch: Partial<MailboxRow>) {
    const m = this.mailboxes.get(email);
    if (!m || m.claim_token !== token) return;
    if (m.token_enc && m.state !== "paused") Object.assign(m, patch);
    Object.assign(m, { claim_token: null, claimed_at: null });
  }

  async findCopy(mailbox: string, gmailId: string) { return this.copies.get(`${mailbox}|${gmailId}`) ?? null; }
  async ticketForThread(mailbox: string, threadId: string) {
    for (const c of this.copies.values()) if (c.mailbox === mailbox && c.gmail_thread_id === threadId) return c.ticket_id;
    return null;
  }
  async messagesByRfc(rfcIds: readonly string[]) {
    return [...this.messages.values()].filter((m) => rfcIds.includes(m.rfc_id)).map((m) => ({ id: m.id, rfc_id: m.rfc_id, ticket_id: m.ticket_id }));
  }
  async anyBlocked(keys: readonly string[]) { return keys.some((k) => this.blocks.has(k)); }
  async block(keys: readonly string[], _by?: string | null) { for (const k of keys) this.blocks.add(k); }

  async createTicket(t: NewTicket) {
    const now = new Date().toISOString();
    const row: TicketRow = { ...blankTicket(), last_activity_at: now, ...t, id: randomUUID(), number: ++this.seq, created_at: now, updated_at: now } as TicketRow;
    this.tickets.set(row.id, row);
    return { ...row };
  }
  async getTicket(id: string) { const t = this.tickets.get(id); return t ? { ...t } : null; }
  async insertMessage(m: NewMessage) {
    for (const x of this.messages.values()) if (x.rfc_id === m.rfc_id) return { id: x.id, ticket_id: x.ticket_id, inserted: false };
    const id = randomUUID();
    this.messages.set(id, { ...m, id });
    return { id, ticket_id: m.ticket_id, inserted: true };
  }
  async insertCopy(c: CopyRow) { const k = `${c.mailbox}|${c.gmail_id}`; if (!this.copies.has(k)) this.copies.set(k, { ...c }); }
  /** Updates seen so far, so a test can force a conflict on the next conditional one. */
  conflictOnce = false;
  private clock = 0;
  async updateTicket(id: string, patch: Partial<TicketRow>, ifUpdatedAt?: string) {
    const t = this.tickets.get(id);
    if (!t) return false;
    if (ifUpdatedAt !== undefined && (t.updated_at !== ifUpdatedAt || this.conflictOnce)) {
      if (this.conflictOnce) { this.conflictOnce = false; t.updated_at = new Date(Date.now() + ++this.clock).toISOString(); }
      return false;
    }
    Object.assign(t, patch, { updated_at: new Date(Date.now() + ++this.clock).toISOString() });
    return true;
  }
  async addEvents(ticketId: string, events: ReadonlyArray<Partial<EventRow>>) {
    for (const e of events) this.events.push({ id: randomUUID(), ticket_id: ticketId, mentions: [], created_at: new Date().toISOString(), actor: null, kind: "status", ...e } as EventRow);
  }
  async deleteTicket(id: string) {
    this.tickets.delete(id);
    for (const [k, m] of this.messages) if (m.ticket_id === id) this.messages.delete(k);
    for (const [k, c] of this.copies) if (c.ticket_id === id) this.copies.delete(k);
    this.events = this.events.filter((e) => e.ticket_id !== id);
  }
  async snoozeDue(nowIso: string) {
    return [...this.tickets.values()].filter((t) => t.snoozed_until && Date.parse(t.snoozed_until) <= Date.parse(nowIso)).map((t) => ({ ...t }));
  }
}
