import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { TicketEvent } from "./ticket-rules";
import type { CopyRow, MailboxRow, MessageRow, NewMessage, NewTicket, TicketRow, TicketStore } from "./store";

/*
 * TICKETS — the TicketStore on the OS database (the Master Inbox Supabase project, service role, osTable). The
 * tables are migrations/0053_tickets.sql. Every write the sync makes is idempotent: a Message-ID is stored once
 * (unique index), a copy once per (mailbox, Gmail id), so a run cut short and run again converges.
 */

/** A database error, with Postgres's code (22… data, 23… constraint) so the sync can tell bad data from an outage. */
export class TicketsDbError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.name = "TicketsDbError"; this.code = code; }
}
const fail = (what: string, e: { message: string; code?: string } | null) => {
  if (e) throw new TicketsDbError(`tickets ${what}: ${e.message}`, String(e.code ?? ""));
};

/** Every string in a row without U+0000, which Postgres refuses in text and jsonb. */
function clean<T>(v: T): T {
  if (typeof v === "string") return (v.includes("\u0000") ? v.replace(/\u0000/g, "") : v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T;
  return v;
}

/*
 * supabase-js quotes `.in()` values holding commas or brackets but not a value holding a double quote or a
 * backslash: a Message-ID like that would silently match nothing (a removed conversation coming back). Those few
 * are looked up one by one with `.eq()`, which takes any value.
 */
async function byValues<R>(table: Parameters<typeof osTable>[0], column: string, select: string, values: readonly string[], limit?: number): Promise<R[]> {
  const ids = [...new Set(values.filter(Boolean))];
  const safe = ids.filter((v) => !/["\\]/.test(v));
  const odd = ids.filter((v) => /["\\]/.test(v));
  const out: R[] = [];
  for (const part of chunks(safe, 40)) {
    let q = osTable(table).select(select).in(column, part);
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    fail(`${table} lookup`, error);
    out.push(...((data ?? []) as R[]));
    if (limit && out.length >= limit) return out;
  }
  for (const v of odd) {
    const { data, error } = await osTable(table).select(select).eq(column, v);
    fail(`${table} lookup`, error);
    out.push(...((data ?? []) as R[]));
  }
  return out;
}

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

  async renewClaim(email, token) {
    const { error } = await osTable("os_ticket_mailboxes").update({ claimed_at: new Date().toISOString() }).eq("email", email).eq("claim_token", token);
    fail("renew claim", error);
  },

  async releaseMailbox(email, token, patch) {
    // The run's result, unless the mailbox was disconnected while it ran (then it stays disconnected)…
    const { error } = await osTable("os_ticket_mailboxes")
      .update({ ...clean(patch), updated_at: new Date().toISOString() })
      .eq("email", email)
      .eq("claim_token", token)
      .not("token_enc", "is", null)
      .neq("state", "paused");
    fail("release", error);
    // …and the claim ends either way.
    const { error: e2 } = await osTable("os_ticket_mailboxes").update({ claim_token: null, claimed_at: null }).eq("email", email).eq("claim_token", token);
    fail("release claim", e2);
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
    return byValues<{ id: string; rfc_id: string; ticket_id: string }>("os_ticket_messages", "rfc_id", "id, rfc_id, ticket_id", rfcIds);
  },

  async anyBlocked(keys) {
    return (await byValues<{ key: string }>("os_ticket_blocks", "key", "key", keys, 1)).length > 0;
  },

  async block(keys, by) {
    if (!keys.length) return;
    const { error } = await osTable("os_ticket_blocks").upsert(keys.map((key) => ({ key, removed_by: by })), { onConflict: "key", ignoreDuplicates: true });
    fail("block", error);
  },

  async createTicket(t: NewTicket) {
    const { data, error } = await osTable("os_tickets").insert(clean(t)).select("*").single();
    fail("create", error);
    return data as TicketRow;
  },

  async getTicket(id) {
    const { data, error } = await osTable("os_tickets").select("*").eq("id", id).maybeSingle();
    fail("ticket", error);
    return (data as TicketRow | null) ?? null;
  },

  async insertMessage(m: NewMessage) {
    const { data, error } = await osTable("os_ticket_messages").upsert(clean(m), { onConflict: "rfc_id", ignoreDuplicates: true }).select("id, ticket_id");
    fail("message", error);
    const row = (data ?? [])[0] as { id: string; ticket_id: string } | undefined;
    if (row) return { ...row, inserted: true };
    const { data: had, error: e2 } = await osTable("os_ticket_messages").select("id, ticket_id").eq("rfc_id", m.rfc_id).single();
    fail("message (stored)", e2);
    return { ...(had as { id: string; ticket_id: string }), inserted: false };
  },

  async updateMessage(id: string, patch: Partial<Omit<MessageRow, "id" | "ticket_id" | "rfc_id">>) {
    const { error } = await osTable("os_ticket_messages").update(clean(patch)).eq("id", id);
    fail("message (update)", error);
  },

  async insertCopy(c: CopyRow) {
    const { error } = await osTable("os_ticket_copies").upsert(c, { onConflict: "mailbox,gmail_id", ignoreDuplicates: true });
    fail("copy", error);
  },

  async updateTicket(id, patch, ifUpdatedAt) {
    let q = osTable("os_tickets").update({ ...clean(patch), updated_at: new Date().toISOString() }).eq("id", id);
    if (ifUpdatedAt !== undefined) q = q.eq("updated_at", ifUpdatedAt);
    const { data, error } = await q.select("id");
    fail("update", error);
    return (data ?? []).length === 1;
  },

  async addEvents(ticketId, events: ReadonlyArray<TicketEvent & { mentions?: string[] }>) {
    if (!events.length) return;
    const { error } = await osTable("os_ticket_events").insert(events.map((e) => ({
      ticket_id: ticketId, kind: e.kind, actor: e.actor, body: e.body ? clean(e.body) : null, mentions: e.mentions ?? [],
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
