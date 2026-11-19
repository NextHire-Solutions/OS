import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { TicketEvent } from "./ticket-rules";
import type { CopyRow, MailboxRow, NewMessage, NewTicket, TicketRow, TicketStore } from "./store";

/*
 * TICKETS — the TicketStore on the OS database (the Master Inbox Supabase project, service role, osTable). The
 * tables are migrations/0053_tickets.sql. Every write the sync makes is idempotent: a Message-ID is stored once
 * (unique index), a copy once per (mailbox, Gmail id), so a run cut short and run again converges.
 */

const fail = (what: string, e: { message: string } | null) => {
  if (e) throw new Error(`tickets ${what}: ${e.message}`);
};

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export const dbTicketStore: TicketStore = {
  async listMailboxes() {
    const { data, error } = await osTable("os_ticket_mailboxes").select("*").order("connected_at", { ascending: true });
    fail("mailboxes", error);
    return (data ?? []) as MailboxRow[];
  },

  async claimMailbox(email, token, staleMs) {
    const stale = new Date(Date.now() - staleMs).toISOString();
    const { data, error } = await osTable("os_ticket_mailboxes")
      .update({ claim_token: token, claimed_at: new Date().toISOString() })
      .eq("email", email)
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
      .select("email");
    fail("claim", error);
    return (data ?? []).length === 1;
  },

  async releaseMailbox(email, token, patch) {
    const { error } = await osTable("os_ticket_mailboxes")
      .update({ ...patch, claim_token: null, claimed_at: null, updated_at: new Date().toISOString() })
      .eq("email", email)
      .eq("claim_token", token);
    fail("release", error);
  },

  async findCopy(mailbox, gmailId) {
    const { data, error } = await osTable("os_ticket_copies").select("*").eq("mailbox", mailbox).eq("gmail_id", gmailId).maybeSingle();
    fail("copy", error);
    return (data as CopyRow | null) ?? null;
  },

  async ticketForThread(mailbox, threadId) {
    const { data, error } = await osTable("os_ticket_copies").select("ticket_id").eq("mailbox", mailbox).eq("gmail_thread_id", threadId).limit(1);
    fail("thread", error);
    return (data?.[0] as { ticket_id: string } | undefined)?.ticket_id ?? null;
  },

  async messagesByRfc(rfcIds) {
    const ids = [...new Set(rfcIds.filter(Boolean))];
    const out: Array<{ id: string; rfc_id: string; ticket_id: string }> = [];
    for (const part of chunks(ids, 40)) {
      const { data, error } = await osTable("os_ticket_messages").select("id, rfc_id, ticket_id").in("rfc_id", part);
      fail("messages by id", error);
      out.push(...((data ?? []) as typeof out));
    }
    return out;
  },

  async anyBlocked(keys) {
    for (const part of chunks([...new Set(keys)], 40)) {
      const { data, error } = await osTable("os_ticket_blocks").select("key").in("key", part).limit(1);
      fail("blocks", error);
      if ((data ?? []).length) return true;
    }
    return false;
  },

  async block(keys, by) {
    if (!keys.length) return;
    const { error } = await osTable("os_ticket_blocks").upsert(keys.map((key) => ({ key, removed_by: by })), { onConflict: "key", ignoreDuplicates: true });
    fail("block", error);
  },

  async createTicket(t: NewTicket) {
    const { data, error } = await osTable("os_tickets").insert(t).select("*").single();
    fail("create", error);
    return data as TicketRow;
  },

  async getTicket(id) {
    const { data, error } = await osTable("os_tickets").select("*").eq("id", id).maybeSingle();
    fail("ticket", error);
    return (data as TicketRow | null) ?? null;
  },

  async insertMessage(m: NewMessage) {
    const { data, error } = await osTable("os_ticket_messages").upsert(m, { onConflict: "rfc_id", ignoreDuplicates: true }).select("id, ticket_id");
    fail("message", error);
    const row = (data ?? [])[0] as { id: string; ticket_id: string } | undefined;
    if (row) return { ...row, inserted: true };
    const { data: had, error: e2 } = await osTable("os_ticket_messages").select("id, ticket_id").eq("rfc_id", m.rfc_id).single();
    fail("message (stored)", e2);
    return { ...(had as { id: string; ticket_id: string }), inserted: false };
  },

  async insertCopy(c: CopyRow) {
    const { error } = await osTable("os_ticket_copies").upsert(c, { onConflict: "mailbox,gmail_id", ignoreDuplicates: true });
    fail("copy", error);
  },

  async updateTicket(id, patch) {
    if (!Object.keys(patch).length) return;
    const { error } = await osTable("os_tickets").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    fail("update", error);
  },

  async addEvents(ticketId, events: ReadonlyArray<TicketEvent & { mentions?: string[] }>) {
    if (!events.length) return;
    const { error } = await osTable("os_ticket_events").insert(events.map((e) => ({
      ticket_id: ticketId, kind: e.kind, actor: e.actor, body: e.body ?? null, mentions: e.mentions ?? [],
      from_value: e.from_value ?? null, to_value: e.to_value ?? null,
    })));
    fail("events", error);
  },

  async deleteTicket(id) {
    const { error } = await osTable("os_tickets").delete().eq("id", id);
    fail("delete", error);
  },

  async snoozeDue(nowIso) {
    const { data, error } = await osTable("os_tickets").select("*").not("snoozed_until", "is", null).lte("snoozed_until", nowIso).limit(200);
    fail("snoozed", error);
    return (data ?? []) as TicketRow[];
  },
};
