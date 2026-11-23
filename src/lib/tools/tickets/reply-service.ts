import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { Address } from "./gmail-message";
import { planReply, sendReply, signaturePreview, type ReplyData, type SendClaims, type SendInput, type SendResult, type SendState } from "./reply";
import { gmailForMailbox } from "./runner";
import { findTicket, markSeen, teamPeople, TicketActionError } from "./service";
import type { CopyRow, MailboxRow, MessageRow } from "./store";
import { dbTicketStore } from "./store-db";

/*
 * TICKETS — replies from a ticket, wired to the OS database and Gmail (the rules: reply.ts). What the reply box shows
 * (replyContext) and the send itself (sendTicketReply). Nothing here is reachable without the Tickets switch
 * (route-auth.ts), and the send route also insists on the OS's own Origin.
 */

export interface ReplyContextView {
  /** Why nobody can reply from Tickets on this ticket (the screen keeps "Open in Gmail"). */
  blocked: string | null;
  senders: Array<{ email: string; name: string; ready: boolean; why: string | null; signature: string }>;
  defaultSender: string | null;
  /** The client's email being answered: sent back with the reply, so a newer one isn't answered unseen. */
  replyTo: string | null;
  to: Address | null;
  cc: Address[];
  subject: string;
}

const MIGRATION = "Replies from Tickets need migrations/0055_ticket_replies.sql run in the Master Inbox Supabase project first.";

/** Migration 0055 is in (the column a sent reply is recorded with, and the drafts' claims). */
async function migrated(): Promise<boolean> {
  for (const r of await Promise.all([osTable("os_ticket_messages").select("sent_by").limit(1), osTable("os_ticket_sends").select("nonce").limit(1)])) {
    if (!r.error) continue;
    if (/sent_by|os_ticket_sends|does not exist|schema cache|42703|42P01|PGRST20[45]/i.test(`${r.error.message} ${(r.error as { code?: string }).code ?? ""}`)) return false;
    throw new Error(r.error.message);
  }
  return true;
}

/** The drafts' claims in os_ticket_sends (reply.ts NEVER TWICE). */
const dbClaims: SendClaims = {
  async claim(c) {
    const ins = await osTable("os_ticket_sends").upsert({ nonce: c.nonce, ticket_id: c.ticketId, mailbox: c.mailbox, actor: c.actor, state: "sending" }, { onConflict: "nonce", ignoreDuplicates: true }).select("nonce");
    if (ins.error) throw new Error(ins.error.message);
    if ((ins.data ?? []).length) return { claimed: true };
    // Claimed before. A draft Gmail refused may go again (claimed back only if still refused: one winner).
    const again = await osTable("os_ticket_sends").update({ state: "sending", actor: c.actor, mailbox: c.mailbox, updated_at: new Date().toISOString() }).eq("nonce", c.nonce).eq("state", "refused").select("nonce");
    if (again.error) throw new Error(again.error.message);
    if ((again.data ?? []).length) return { claimed: true };
    const { data, error } = await osTable("os_ticket_sends").select("state, gmail_id").eq("nonce", c.nonce).maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { state: SendState; gmail_id: string | null } | null;
    return { claimed: false, state: row?.state ?? "sending", gmailId: row?.gmail_id ?? null };
  },
  async finish(nonce, state, gmailId) {
    const { error } = await osTable("os_ticket_sends").update({ state, ...(gmailId ? { gmail_id: gmailId } : {}), updated_at: new Date().toISOString() }).eq("nonce", nonce);
    if (error) throw new Error(error.message);
  },
};

async function loadReplyData(idOrNumber: string): Promise<ReplyData | null> {
  const ticket = await findTicket(idOrNumber);
  if (!ticket) return null;
  const [msgs, copies, mbs, team] = await Promise.all([
    osTable("os_ticket_messages").select("*").eq("ticket_id", ticket.id).order("sent_at", { ascending: true }),
    osTable("os_ticket_copies").select("*").eq("ticket_id", ticket.id),
    osTable("os_ticket_mailboxes").select("*"),
    teamPeople(),
  ]);
  for (const r of [msgs, copies, mbs]) if (r.error) throw new Error(r.error.message);
  return {
    ticket,
    messages: (msgs.data ?? []) as MessageRow[],
    copies: (copies.data ?? []) as CopyRow[],
    mailboxes: (mbs.data ?? []) as MailboxRow[],
    names: new Map(team.map((p) => [p.email, p.name])),
  };
}

/** Each sending inbox's signature preview, read from Gmail at most every 10 minutes. */
const signatures: Map<string, { at: number; text: string }> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("os.tickets.signatures")] ??= new Map()) as Map<string, { at: number; text: string }>;

async function signatureFor(mb: MailboxRow | undefined): Promise<string> {
  if (!mb) return "";
  const had = signatures.get(mb.email);
  if (had && Date.now() - had.at < 10 * 60_000) return had.text;
  try {
    const g = gmailForMailbox(mb);
    const text = g ? signaturePreview((await g.sendAs()).sendAs, mb.email) : "";
    signatures.set(mb.email, { at: Date.now(), text });
    return text;
  } catch {
    return had?.text ?? "";
  }
}

export async function replyContext(idOrNumber: string): Promise<ReplyContextView> {
  const data = await loadReplyData(idOrNumber);
  if (!data) throw new TicketActionError("No such ticket", 404);
  const plan = planReply(data);
  const ok = await migrated();
  const senders = await Promise.all(plan.senders.map(async (s) => ({
    email: s.email, name: s.name, ready: s.ready, why: s.why,
    signature: s.ready ? await signatureFor(data.mailboxes.find((m) => m.email.toLowerCase() === s.email)) : "",
  })));
  return { blocked: ok ? plan.blocked : MIGRATION, senders, defaultSender: plan.defaultSender, replyTo: plan.replyToId, to: plan.to, cc: plan.cc, subject: plan.subject };
}

export async function sendTicketReply(idOrNumber: string, actor: string, input: SendInput): Promise<SendResult> {
  // Everything before sendReply only reads: a failure here certainly sent nothing.
  let data: ReplyData | null;
  try {
    if (!(await migrated())) return { ok: false, sent: false, status: 409, code: "not-ready", error: MIGRATION };
    data = await loadReplyData(idOrNumber);
  } catch (e) {
    console.error(JSON.stringify({ at: "[tickets] reply: couldn't read the ticket", error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    return { ok: false, sent: false, status: 502, error: "Tickets couldn't read this ticket just now, so nothing was sent. Try again in a minute." };
  }
  if (!data) return { ok: false, sent: false, status: 404, error: "No such ticket" };
  const r = await sendReply({
    store: dbTicketStore,
    gmail: (mb) => gmailForMailbox(mb),
    claims: dbClaims,
    log: (line) => console.log(JSON.stringify(line)),
  }, data, input, actor);
  if (r.ok) await markSeen(data.ticket.id, actor).catch(() => {});
  return r;
}
