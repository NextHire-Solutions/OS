import type { Address } from "./gmail-message.ts";
import { GmailAuthError, GmailError, type GmailSendAs } from "./gmail-api.ts";
import { parseMessage, type GmailMessage } from "./gmail-message.ts";
import { buildReply, isSendableAddress, replySubject, signatureText } from "./reply-mime.ts";
import { canSendFrom, scopeCanSend } from "./senders.ts";
import type { CopyRow, MailboxRow, MessageRow, TicketRow, TicketStore } from "./store.ts";
import { applyMessage } from "./ticket-rules.ts";

/*
 * TICKETS — REPLYING FROM A TICKET (24 Nov 2026, the user): "anyone that has access to Tickets page should be able to
 * reply to emails as the one who got email. like Amy got the email but eddy can reply to email as amy" — Gabriel too —
 * and "It's only for Amy and Eddy email".
 *
 * WHO IT GOES FROM: the inbox that received the client's latest email, when it is Amy's or Eddy's (senders.ts). If both
 * received it, the one the client wrote To is the default and the other can be picked. If neither did (it came to
 * someone else's inbox), the reply can't go from Tickets: that person answers in Gmail.
 * WHO IT GOES TO: the client who wrote that email (their exact, verified address — the only kind Tickets keeps), with
 * the other people on their email offered as Cc. The server decides both: the screen can only untick a Cc.
 * WHAT GOES: the teammate's words, the sending inbox's own Gmail signature, the client's email quoted underneath
 * (reply-mime.ts), into the same Gmail conversation (thread id + In-Reply-To/References), so it reads as an ordinary
 * reply from Amy and sits in Amy's Sent folder.
 * WHAT IS KEPT: the reply's text, who it went to, and who pressed Send (sent_by, migration 0055); the ticket moves to
 * Waiting, as when Amy replies in Gmail. The sync later finds it in Amy's Sent mail and only notes the copy.
 *
 * NEVER TWICE: Gmail's send is never retried (gmail-api.ts). Each draft carries a nonce, claimed in the database
 * (os_ticket_sends, migration 0055) BEFORE Gmail is asked: the same draft again — a double click, a retry after a lost
 * answer, a deploy restarting the server mid-send — finds its claim and never sends a second email. When it isn't known
 * whether it went (Gmail didn't confirm, or the server stopped mid-send), the answer is "look in Amy's Sent folder",
 * never "failed"; only a refusal that certainly sent nothing says "nothing was sent" (sent: false).
 * ANSWERING WHAT WAS SHOWN: the screen says which client email it answers (replyTo); if a newer one came in while the
 * reply was written, nothing is sent and the box reloads (review, 24 Nov: otherwise it could go to someone else).
 */

export interface ReplyData {
  ticket: TicketRow;
  /** The ticket's emails, oldest first. */
  messages: MessageRow[];
  copies: CopyRow[];
  mailboxes: MailboxRow[];
  /** Teammates' names by address ("amy@…" → "Amy Anderes-Damron"). */
  names: ReadonlyMap<string, string>;
}

export interface ReplySender {
  email: string;
  name: string;
  /** Can send right now. */
  ready: boolean;
  /** Why not, in words for the screen (who has to do what). */
  why: string | null;
  /** This inbox's Gmail conversation for the ticket. */
  threadId: string | null;
}

export interface ReplyPlan {
  /** Why nobody can reply from Tickets here, or null. */
  blocked: string | null;
  /** The client's email being answered (its stored id): the screen sends it back with the reply. */
  replyToId: string | null;
  senders: ReplySender[];
  defaultSender: string | null;
  to: Address | null;
  /** Everyone else on the client's email (the sending inbox itself is left out when sending). */
  cc: Address[];
  subject: string;
  inReplyTo: string | null;
  references: string[];
  quote: { at: string; from: Address; text: string } | null;
}

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const first = (name: string | null | undefined, email: string) => (name ?? "").trim().split(/\s+/)[0] || email.split("@")[0];

function senderState(mb: MailboxRow | undefined, owner: string): { ready: boolean; why: string | null } {
  if (!mb || !mb.token_enc || mb.state === "paused") return { ready: false, why: `${owner}'s inbox isn't connected to Tickets. ${owner} connects it on Connected inboxes.` };
  if (mb.state === "reconnect") return { ready: false, why: `Google stopped Tickets using ${owner}'s inbox. ${owner} reconnects it on Connected inboxes.` };
  if (!scopeCanSend(mb.scope)) return { ready: false, why: `${owner} reconnects their inbox once, on Connected inboxes, to allow replies from Tickets.` };
  return { ready: true, why: null };
}

/** Who can reply, from which inbox, to whom: everything the screen shows and the send uses. Pure. */
export function planReply(d: ReplyData): ReplyPlan {
  const empty: ReplyPlan = { blocked: null, replyToId: null, senders: [], defaultSender: null, to: null, cc: [], subject: replySubject(d.ticket.subject), inReplyTo: null, references: [], quote: null };
  const latestIn = [...d.messages].reverse().find((m) => m.direction === "in" && m.from_email);
  if (!latestIn) return { ...empty, blocked: "There's no email from the client in this ticket to reply to." };
  const to: Address = { email: norm(latestIn.from_email), name: latestIn.from_name };

  // The inboxes that received the client's latest email; else any that hold the conversation.
  const holders = (msgId: string | null) => [...new Set(d.copies.filter((c) => msgId === null || c.message_id === msgId).map((c) => norm(c.mailbox)))];
  let received = holders(latestIn.id);
  if (!received.length) received = holders(null);
  const allowed = received.filter(canSendFrom);
  const nameOf = (email: string) => d.names.get(email) ?? d.mailboxes.find((m) => norm(m.email) === email)?.name ?? email;
  const base = {
    ...empty,
    replyToId: latestIn.id,
    to,
    subject: replySubject(latestIn.subject ?? d.ticket.subject),
    inReplyTo: latestIn.rfc_id && !latestIn.rfc_id.startsWith("gmail:") ? latestIn.rfc_id : null,
    references: [...(latestIn.refs ?? []), ...(latestIn.rfc_id && !latestIn.rfc_id.startsWith("gmail:") ? [latestIn.rfc_id] : [])].filter((r) => !r.startsWith("gmail:")),
    quote: { at: latestIn.sent_at, from: to, text: latestIn.body_text ?? latestIn.snippet ?? "" },
  };
  if (!isSendableAddress(to.email)) return { ...base, blocked: `This client's address (${to.email}) can't be used for a reply from Tickets. Reply in Gmail.` };
  if (!allowed.length) {
    const firstNames = received.map((e) => first(nameOf(e), e));
    return { ...base, blocked: received.length ? `This email came to ${firstNames.join(" and ")}. Replies from Tickets go only from Amy's or Eddy's inbox, so ${firstNames.length === 1 ? firstNames[0] : "they"} answer${firstNames.length === 1 ? "s" : ""} in Gmail.` : "No connected inbox holds this conversation." };
  }

  const toList = new Set((latestIn.to_list ?? []).map((a) => norm(a.email)));
  const senders: ReplySender[] = allowed.map((email) => {
    const owner = first(nameOf(email), email);
    const st = senderState(d.mailboxes.find((m) => norm(m.email) === email), owner);
    const copy = d.copies.find((c) => norm(c.mailbox) === email && c.message_id === latestIn.id) ?? d.copies.find((c) => norm(c.mailbox) === email);
    return { email, name: nameOf(email), ...st, threadId: copy?.gmail_thread_id ?? null };
  });
  // The client wrote To this one (else Cc'd both): it answers, unless it can't send right now and another can.
  senders.sort((a, b) => Number(toList.has(b.email)) - Number(toList.has(a.email)) || a.email.localeCompare(b.email));
  const defaultSender = (senders.find((s) => s.ready) ?? senders[0]).email;

  const seen = new Set([to.email]);
  const cc: Address[] = [];
  for (const a of [...(latestIn.to_list ?? []), ...(latestIn.cc_list ?? [])]) {
    const e = norm(a.email);
    if (!e || seen.has(e) || !isSendableAddress(e)) continue;
    seen.add(e);
    cc.push({ email: e, name: a.name ?? null });
  }
  return { ...base, senders, defaultSender, cc };
}

/* ----------------------------------------------------------------------------------------------- sending --- */

export interface SendInput {
  /** The inbox to send from (one of the plan's senders). */
  from: string;
  text: string;
  /** The Cc addresses kept (a subset of the plan's cc). */
  cc: string[];
  /** One per draft: the same nonce never sends twice. */
  nonce: string;
  /** The client's email the box was answering (the plan's replyToId when it was shown). */
  replyTo: string | null;
}

export interface SendGmail {
  send(raw: string, threadId: string | null): Promise<{ id: string; threadId: string }>;
  metadata(id: string): Promise<GmailMessage>;
  sendAs(): Promise<{ sendAs?: GmailSendAs[] }>;
}

export type SendState = "sending" | "sent" | "unsure" | "refused";

/** The drafts' claims (os_ticket_sends): taken before Gmail is asked, settled after. */
export interface SendClaims {
  /** Claim this draft. A draft Gmail refused earlier may be claimed again; any other earlier claim is returned. */
  claim(c: { nonce: string; ticketId: string; mailbox: string; actor: string }): Promise<{ claimed: true } | { claimed: false; state: SendState; gmailId: string | null }>;
  finish(nonce: string, state: Exclude<SendState, "sending">, gmailId?: string | null): Promise<void>;
}

export interface SendDeps {
  store: TicketStore;
  gmail(mb: MailboxRow): SendGmail | null;
  claims: SendClaims;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export type SendResult =
  | { ok: true; sentAs: string; to: string; messageId: string; note?: string }
  /** Certainly not sent: the draft may be fixed and sent again. */
  | { ok: false; sent: false; status: number; error: string; code?: "not-ready" | "invalid" | "stale" }
  /** It may have gone: look in the Sent folder before sending again. */
  | { ok: false; sent: "unknown"; status: number; error: string; code: "unsure" };

export const MAX_REPLY_CHARS = 10_000;

/** Sends running in this process, by nonce (a double click joins the first; across processes the claim decides). */
const inFlight: Map<string, Promise<SendResult>> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("os.tickets.replyInFlight")] ??= new Map()) as Map<string, Promise<SendResult>>;

export function _forgetNonces(): void { inFlight.clear(); }

const refused = (status: number, error: string, code?: "not-ready" | "invalid" | "stale"): SendResult => ({ ok: false, sent: false, status, error, ...(code ? { code } : {}) });
const unsure = (owner: string): SendResult => ({ ok: false, sent: "unknown", status: 502, code: "unsure", error: `Gmail didn't confirm whether the reply was sent. Look in ${owner}'s Sent folder before sending it again.` });
const errText = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : String(e));

/** Send a reply from a ticket (see the top of this file). `actor`: who pressed Send. */
export async function sendReply(deps: SendDeps, data: ReplyData, input: SendInput, actor: string): Promise<SendResult> {
  const nonce = String(input.nonce ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return refused(400, "Reload the page and try again.", "invalid");
  const running = inFlight.get(nonce);
  if (running) return running;
  const p = sendOnce(deps, data, { ...input, nonce }, actor).finally(() => inFlight.delete(nonce));
  inFlight.set(nonce, p);
  return p;
}

async function sendOnce(deps: SendDeps, data: ReplyData, input: SendInput, actor: string): Promise<SendResult> {
  const plan = planReply(data);
  if (plan.blocked || !plan.to) return refused(409, plan.blocked ?? "There's nobody to reply to.", "not-ready");
  if ((input.replyTo ?? null) !== plan.replyToId) {
    const who = plan.to.name ?? plan.to.email;
    return refused(409, `A newer email from ${who} came in while you were writing. Read it, then send your reply (your draft is kept).`, "stale");
  }
  const from = norm(input.from);
  const sender = plan.senders.find((x) => x.email === from);
  if (!sender) return refused(400, "Replies to this ticket can't go from that inbox.", "invalid");
  const owner = first(sender.name, from);
  if (!sender.ready) return refused(409, sender.why ?? "That inbox can't send right now.", "not-ready");
  const text = String(input.text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return refused(400, "Write your reply first.", "invalid");
  if (text.length > MAX_REPLY_CHARS) return refused(400, `Replies are ${MAX_REPLY_CHARS.toLocaleString("en-US")} characters at most.`, "invalid");
  const offered = new Map(plan.cc.map((a) => [a.email, a]));
  const keep = [...new Set((input.cc ?? []).map(norm))];
  if (keep.some((e) => !offered.has(e))) return refused(400, "Only people already on the client's email can be copied in.", "invalid");
  const cc = keep.filter((e) => e !== from && e !== plan.to!.email).map((e) => offered.get(e)!);

  const mb = data.mailboxes.find((m) => norm(m.email) === from)!;
  const gmail = deps.gmail(mb);
  if (!gmail) return refused(409, `${owner}'s inbox can't be used right now. ${owner} reconnects it on Connected inboxes.`, "not-ready");

  // The inbox's own name and signature, as Gmail would add them. If they can't be read, the reply still goes, unsigned.
  let signatureHtml: string | null = null;
  let displayName = sender.name;
  try {
    const sa = (await gmail.sendAs()).sendAs ?? [];
    const mine = sa.find((x) => norm(x.sendAsEmail) === from) ?? sa.find((x) => x.isPrimary);
    if (mine?.signature?.trim()) signatureHtml = mine.signature;
    if (mine?.displayName?.trim()) displayName = mine.displayName.trim();
  } catch (e) {
    deps.log?.({ at: "[tickets] reply: signature unreadable", mailbox: from, error: errText(e) });
  }

  let built: ReturnType<typeof buildReply>;
  try {
    built = buildReply({ from: { email: from, name: displayName }, to: [plan.to], cc, subject: plan.subject, inReplyTo: plan.inReplyTo, references: plan.references, text, signatureHtml, quote: plan.quote });
  } catch (e) {
    return refused(409, `An address on this email can't be used for a reply from Tickets (${errText(e)}). Reply in Gmail.`, "not-ready");
  }

  // Claimed before Gmail is asked: whatever happens next, this draft never sends twice.
  const by = norm(actor);
  let claim: Awaited<ReturnType<SendClaims["claim"]>>;
  try {
    claim = await deps.claims.claim({ nonce: input.nonce, ticketId: data.ticket.id, mailbox: from, actor: by });
  } catch (e) {
    deps.log?.({ at: "[tickets] reply: couldn't claim the draft", error: errText(e) });
    return refused(503, "Tickets couldn't start sending just now, so nothing was sent. Try again in a minute.");
  }
  if (!claim.claimed) {
    if (claim.state === "sent") return { ok: true, sentAs: from, to: plan.to.email, messageId: claim.gmailId ?? "", note: "This reply was already sent." };
    return unsure(owner);
  }

  let sent: { id: string; threadId: string };
  try {
    sent = await gmail.send(built.raw, sender.threadId);
  } catch (e) {
    // A 4xx (not a 408 timeout) and Google refusing the access are refusals before anything was sent.
    const definite = e instanceof GmailAuthError || (e instanceof GmailError && e.status >= 400 && e.status < 500 && e.status !== 408);
    await deps.claims.finish(input.nonce, definite ? "refused" : "unsure").catch((x) => deps.log?.({ at: "[tickets] reply: couldn't settle the claim", error: errText(x) }));
    if (!definite) {
      deps.log?.({ at: "[tickets] reply: Gmail didn't confirm", mailbox: from, error: errText(e) });
      return unsure(owner);
    }
    deps.log?.({ at: "[tickets] reply refused by Gmail", mailbox: from, status: e instanceof GmailError ? e.status : "auth", error: errText(e) });
    if (e instanceof GmailAuthError) return refused(409, `Google stopped Tickets using ${owner}'s inbox, so nothing was sent. ${owner} reconnects it on Connected inboxes.`, "not-ready");
    const ge = e as GmailError;
    if (ge.status === 429) return refused(503, "Gmail is busy right now, so nothing was sent. Try again in a minute.");
    if (ge.status === 403 && /insufficient|scope|permission/i.test(ge.message)) return refused(409, `${owner}'s inbox isn't allowed to send yet, so nothing was sent. ${owner} reconnects it once, on Connected inboxes.`, "not-ready");
    if (ge.status === 404) return refused(409, `Gmail couldn't find this conversation in ${owner}'s inbox (deleted from Gmail?), so nothing was sent. Reply from Gmail instead.`);
    return refused(502, `Gmail refused this email, so nothing was sent (${ge.status}).`);
  }
  await deps.claims.finish(input.nonce, "sent", sent.id).catch((x) => deps.log?.({ at: "[tickets] reply: sent, couldn't settle the claim", error: errText(x) }));

  // Sent. Everything below only records it; a failure here never makes the screen think it wasn't sent.
  const sentAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const byName = first(data.names.get(by), by);
  deps.log?.({ at: "[tickets] reply sent", ticket: data.ticket.number, as: from, by, to: plan.to.email, cc: cc.length, gmailId: sent.id });
  try {
    let rfc = `gmail:${from}:${sent.id}`;
    let at = sentAt;
    try {
      const p = parseMessage(await gmail.metadata(sent.id));
      if (p.rfcId) rfc = p.rfcId;
      if (p.sentAt) at = p.sentAt;
    } catch { /* the Gmail id stands in; the sync matches the copy by it */ }
    const snippet = text.replace(/\s+/g, " ").slice(0, 200);
    const content = { from_email: from, from_name: sender.name, to_list: [plan.to], cc_list: cc, subject: plan.subject, snippet, body_text: text, sent_by: by };
    const ins = await deps.store.insertMessage({ ticket_id: data.ticket.id, rfc_id: rfc, direction: "out", trimmed: false, body_html: null, attachments: [], in_reply_to: plan.inReplyTo, refs: plan.references, sent_at: at, ...content });
    if (!ins.inserted) {
      // The sync stored it first (from the Sent mail, a bare marker): give it the reply's text and sender. The ticket
      // was already moved on by the sync, so it isn't counted again.
      await deps.store.updateMessage(ins.id, content);
    }
    await deps.store.insertCopy({ mailbox: from, gmail_id: sent.id, gmail_thread_id: sent.threadId || sender.threadId || "", message_id: ins.id, ticket_id: ins.ticket_id, labels: ["SENT"] });
    if (ins.inserted) {
      const note = by === from ? `${owner} replied from Tickets` : `${byName} replied as ${owner} from Tickets`;
      for (let i = 0; i < 5; i++) {
        const t = await deps.store.getTicket(data.ticket.id);
        if (!t) break;
        const c = applyMessage(t, { direction: "out", sentAt: at, auto: false, snippet, who: byName, replyNote: note });
        if (await deps.store.updateTicket(t.id, c.patch, t.updated_at)) {
          if (c.events.length) await deps.store.addEvents(t.id, c.events);
          break;
        }
      }
    }
  } catch (e) {
    deps.log?.({ at: "[tickets] reply sent, but recording it failed", ticket: data.ticket.number, error: errText(e) });
    return { ok: true, sentAs: from, to: plan.to.email, messageId: sent.id, note: "Sent. It may take a minute to show in the ticket." };
  }
  return { ok: true, sentAs: from, to: plan.to.email, messageId: sent.id };
}

/** The signature preview the screen shows under the reply box (plain text: never rendered as HTML). */
export function signaturePreview(sa: GmailSendAs[] | undefined, email: string): string {
  const mine = (sa ?? []).find((s) => norm(s.sendAsEmail) === norm(email)) ?? (sa ?? []).find((s) => s.isPrimary);
  return signatureText(mine?.signature ?? null);
}
