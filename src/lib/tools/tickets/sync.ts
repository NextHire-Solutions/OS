import { backfillQueries, isTeamAddress, matchSender, type ClientIndex } from "./client-match.ts";
import { GmailAuthError, GmailError, GmailHistoryGone, type GmailClient } from "./gmail-api.ts";
import { parseBodies, parseMessage, senderVerified, type GmailMessage, type ParsedMessage } from "./gmail-message.ts";
import { trimEmail } from "./quote-trim.ts";
import type { MailboxRow, TicketStore } from "./store.ts";
import { applyMessage, settleImported, type IncomingMessage } from "./ticket-rules.ts";

/*
 * TICKETS — one mailbox's sync. Reads Gmail, keeps only client conversations.
 *
 * FIRST FILL: Gmail is searched for mail FROM clients in the last 30 days (client-match.ts backfillQueries — a
 * prefilter; every hit's From is matched again here). The history id is read BEFORE the search, so nothing that
 * arrives during the fill is missed: the next run continues from it.
 * AFTER THAT: users.history.list from the stored id, every minute. A 404 (Google keeps history "at least a week,
 * sometimes only hours") falls back to a fill covering the time since the last good run, Sent mail included.
 *
 * ONLY EMAILS FROM CLIENT ADDRESSES ARE KEPT (the user, 20 Nov: "make sure we only see emails that came from
 * client's email addresses. no other emails should be shown here, this is very important"). For each new message
 * (headers only first — 20 units; the body only for what we keep — 60):
 *  - FROM A CLIENT ADDRESS — the From header holds exactly one address, it is an exact address we hold for a
 *    client (client-match.ts), and Gmail verified the sender (DMARC, or DKIM/SPF for the From's domain: a forged
 *    "From: client" is not the client): kept, with ONLY the client's own words (quote-trim.ts cuts quoted replies
 *    and forwarded mail before storing). It joins its conversation (this mailbox's Gmail thread, or the message it
 *    replies to), else starts a new ticket — unless it is automatic mail (out-of-office, lists).
 *  - FROM US, inside a tracked client conversation, addressed to that client: NOT kept as an email. Only the fact
 *    is kept — who replied and when; no subject, text, recipients or files — so the ticket moves to Waiting. A
 *    forward to a vendor, or mail only between teammates, leaves no trace.
 *  - FROM ANYONE ELSE — a stranger, someone new at the client's company, a vendor inside a client's thread: never
 *    stored, never shown. Nothing about them is written anywhere.
 *  - Drafts, spam, trash and chats are skipped.
 *  - OTHERS (24 Nov, the user chose "Every other email" for Eddy's "a section called others"; `deps.others`): with it
 *    on, the "anyone else" mail above IS kept, whole, like a client's — in the conversation it belongs to when that is
 *    already a ticket (someone new at the client's company replying in the client's thread), else as a new ticket with
 *    no client (the Others view), automatic mail included. Our replies inside an Others conversation are noted like
 *    replies to a client. Unchanged: a forged client address is still refused, calendar invitations are still never
 *    tickets, our own mail between teammates still leaves no trace, and a forward to a vendor inside a CLIENT's
 *    conversation is still not a reply.
 * When a conversation first reaches this mailbox's thread (a new ticket, or a copy of an email another teammate
 * already received), the rest of that thread in this mailbox is read the same way — so a teammate's replies are seen
 * even when the client's email was first stored from someone else's inbox.
 *
 * ONE BAD MESSAGE NEVER STOPS A MAILBOX: an error that belongs to one message (bad data, a constraint) is counted and
 * skipped; only an outage (Gmail 429/5xx, the network, the database unreachable, Google's access gone) ends the run,
 * which then retries from the same place.
 */

export type GmailLike = Pick<GmailClient, "profile" | "listMessages" | "metadata" | "full" | "thread" | "history"> & { units?: number };

export interface SyncDeps {
  store: TicketStore;
  gmail: GmailLike;
  index: ClientIndex;
  /** Teammates' addresses outside our own domains (Gabriel's gmail) and every connected mailbox. */
  team: ReadonlySet<string>;
  /** "amy@brokerstaffer.com" → "Amy Anderes", for the timeline. */
  names: ReadonlyMap<string, string>;
  now?: () => number;
  /** Called now and then during a long run (keeps the mailbox's claim fresh). */
  heartbeat?: () => Promise<void>;
  /**
   * Others (24 Nov, others-switch.ts): also keep every email from anyone who is neither a client address nor our team —
   * a ticket with no client, or a message in the client conversation it was written in. Off: client addresses only.
   */
  others?: boolean;
}

export interface SyncReport {
  mode: "fill" | "refill" | "history";
  looked: number;
  stored: number;
  copies: number;
  created: number;
  skipped: number;
  /** From a client's address, but Gmail could not verify the sender: not kept. */
  unverified: number;
  /** Messages that failed on their own and were skipped (their errors are in `errors`). */
  failed: number;
  errors: string[];
  historyId: string | null;
  units: number;
}

export const FIRST_FILL_DAYS = 30;
const MAX_FILL_MESSAGES = 3_000;
const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);
const MAX_HTML = 512 * 1024;
const MAX_TEXT = 128 * 1024;

/** "Re: Fwd: RE: Invoice" → "Invoice". */
export function cleanSubject(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/^\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === out) break;
    out = next;
  }
  return out || "(no subject)";
}

interface Run { deps: SyncDeps; mb: MailboxRow; report: SyncReport; created: Set<string>; lastBeat: number }

const who = (deps: SyncDeps, p: ParsedMessage) => {
  const e = p.from?.email ?? "";
  const n = deps.names.get(e) ?? p.from?.name ?? e;
  return n.split(/\s+/)[0] || n;
};

/** An error that means "stop and retry the whole run later", not "skip this one message". */
function isOutage(e: unknown): boolean {
  if (e instanceof GmailAuthError) return true;
  if (e instanceof GmailError) return e.status === 429 || e.status >= 500 || e.status === 401 || e.status === 403;
  const code = String((e as { code?: unknown })?.code ?? "");
  if (/^(22|23|54)/.test(code)) return false; // Postgres: bad data / constraint / too large — this message only
  if (code === "PGRST116" || code === "PGRST204") return false;
  return true; // network, database unreachable, anything unknown: retry the run rather than lose mail
}

async function beat(run: Run) {
  if (!run.deps.heartbeat || Date.now() - run.lastBeat < 4 * 60_000) return;
  run.lastBeat = Date.now();
  await run.deps.heartbeat().catch(() => {});
}

/** Apply one message to its ticket, re-reading and retrying if someone changed the ticket meanwhile. */
async function applyToTicket(run: Run, ticketId: string, m: IncomingMessage) {
  const { store } = run.deps;
  for (let i = 0; i < 5; i++) {
    const t = await store.getTicket(ticketId);
    if (!t) return;
    const c = applyMessage(t, m, run.created.has(ticketId));
    if (await store.updateTicket(ticketId, c.patch, t.updated_at)) {
      if (c.events.length) await store.addEvents(ticketId, c.events);
      return;
    }
  }
  throw new Error("tickets: the ticket kept changing; will retry");
}

/** Read the rest of this mailbox's thread into the ticket (a new ticket, or the first copy reaching this thread). */
async function importThread(run: Run, threadId: string, exceptId: string) {
  const th = await run.deps.gmail.thread(threadId);
  const rest = (th.messages ?? []).filter((m) => m.id !== exceptId).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  for (const m of rest) await takeSafely(run, m);
}

/** Is this message in a conversation that is already a ticket with no client (Others)? */
async function inOthersTicket(run: Run, p: ParsedMessage): Promise<boolean> {
  const { store } = run.deps;
  const id = (await store.ticketForThread(run.mb.email, p.threadId)) ?? (p.refs.length ? (await store.messagesByRfc(p.refs))[0]?.ticket_id ?? null : null);
  if (!id) return false;
  const t = await store.getTicket(id);
  return !!t && !t.os_client_id;
}

/** One message (headers) into the tickets, per the rules above. */
async function take(run: Run, meta: GmailMessage): Promise<void> {
  const { deps, mb, report } = run;
  const { store } = deps;
  await beat(run);
  const p = parseMessage(meta);
  if (p.labels.some((l) => SKIP_LABELS.has(l))) { report.skipped++; return; }
  if (await store.findCopy(mb.email, p.gmailId)) return;

  // WHO SENT IT — decided first; nothing about anyone else is ever written.
  const fromEmail = p.from?.email ?? null;
  if (p.fromCount !== 1 || !fromEmail) { report.skipped++; return; }
  const ours = isTeamAddress(fromEmail, deps.team) || fromEmail === mb.email;
  const client = ours ? null : matchSender(deps.index, fromEmail);
  // Neither us nor a client: kept only with Others on (24 Nov).
  if (!ours && !client && !deps.others) { report.skipped++; return; }
  if (client && !senderVerified(fromEmail, p.auth)) { report.unverified++; report.skipped++; return; }
  if (ours) {
    // A reply counts only when it went to a client (a forward to a vendor, or mail between teammates, does not) —
    // or, with Others on, when it is in a conversation that is already an Others ticket (no client to address).
    const toClient = [...p.to, ...p.cc].some((a) => !isTeamAddress(a.email, deps.team) && a.email !== mb.email && matchSender(deps.index, a.email));
    if (!toClient && !(deps.others && (await inOthersTicket(run, p)))) { report.skipped++; return; }
  }

  const rfc = p.rfcId || `gmail:${mb.email}:${p.gmailId}`;
  if (await store.anyBlocked([`msg:${rfc}`, ...p.refs.map((r) => `msg:${r}`), `thread:${mb.email}:${p.threadId}`])) {
    if (!ours) await store.block([`msg:${rfc}`], null);
    report.skipped++;
    return;
  }

  // A calendar invitation or a reply to one: never a ticket, never added to one (23 Nov, the team).
  if (p.calendar) { report.skipped++; return; }

  // Already stored from another teammate's inbox: this mailbox has a copy. If this is the first time the conversation
  // reaches this mailbox's thread, read the thread too (this teammate's replies to the client).
  const stored = await store.messagesByRfc([rfc]);
  if (stored[0]) {
    const firstHere = !(await store.ticketForThread(mb.email, p.threadId));
    await store.insertCopy({ mailbox: mb.email, gmail_id: p.gmailId, gmail_thread_id: p.threadId, message_id: stored[0].id, ticket_id: stored[0].ticket_id, labels: p.labels });
    report.copies++;
    if (firstHere) await importThread(run, p.threadId, p.gmailId);
    return;
  }

  let ticketId = await store.ticketForThread(mb.email, p.threadId);
  const threadLinked = !!ticketId;
  if (!ticketId && p.refs.length) ticketId = (await store.messagesByRfc(p.refs))[0]?.ticket_id ?? null;
  // Our reply outside any tracked conversation (we wrote first): nothing to note.
  if (!ticketId && ours) { report.skipped++; return; }

  let created = false;
  if (!ticketId) {
    // A client's automatic mail (out-of-office, lists) starts nothing. Others keeps it (the user: every other email).
    if (client ? p.autoSubmitted : !deps.others) { report.skipped++; return; }
    const t = await store.createTicket({
      os_client_id: client?.clientId ?? null,
      match_method: client?.method ?? null,
      subject: cleanSubject(p.subject),
      contact_email: fromEmail,
      contact_name: p.from?.name ?? null,
      last_activity_at: p.sentAt,
    });
    ticketId = t.id;
    created = true;
    run.created.add(t.id);
    report.created++;
    const mbName = deps.names.get(mb.email) ?? mb.name ?? mb.email;
    const also = (client?.alsoOn ?? []).map((id) => deps.index.clients.get(id)?.name).filter(Boolean);
    await store.addEvents(t.id, [{
      kind: "created", actor: null,
      body: `${run.report.mode === "history" ? "New email" : "Imported"} from ${p.from?.name ?? fromEmail} in ${mbName.split(/\s+/)[0]}'s inbox${also.length ? `. The same address is also on ${also.join(", ")}` : ""}`,
    }]);
  }

  // Their email (a client's, or with Others on anyone else's): only the sender's own words. Ours: a dated marker (no
  // subject, text, recipients, files, ids).
  let content = { trimmed: false, to_list: [] as typeof p.to, cc_list: [] as typeof p.cc, subject: null as string | null, snippet: null as string | null, body_html: null as string | null, body_text: null as string | null, attachments: [] as ReturnType<typeof parseBodies>["attachments"], in_reply_to: null as string | null, refs: [] as string[] };
  let snippet = "";
  if (!ours) {
    const b = parseBodies(await deps.gmail.full(p.gmailId));
    const own = trimEmail(b.html, b.text);
    const html = own.html && own.html.length <= MAX_HTML ? own.html : null;
    const text = (own.text ?? "").slice(0, MAX_TEXT) || null;
    snippet = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    content = { trimmed: own.trimmed, to_list: p.to, cc_list: p.cc, subject: p.subject || null, snippet: snippet || null, body_html: html, body_text: text, attachments: b.attachments, in_reply_to: p.inReplyTo, refs: p.refs };
  }
  const ins = await store.insertMessage({
    ticket_id: ticketId,
    rfc_id: rfc,
    direction: ours ? "out" : "in",
    from_email: fromEmail,
    from_name: ours ? deps.names.get(fromEmail) ?? p.from?.name ?? null : p.from?.name ?? null,
    ...content,
    sent_at: p.sentAt,
  });
  await store.insertCopy({ mailbox: mb.email, gmail_id: p.gmailId, gmail_thread_id: p.threadId, message_id: ins.id, ticket_id: ins.ticket_id, labels: p.labels });
  if (!ins.inserted) {
    // Another mailbox stored it a moment ago: ours is a copy, and a ticket opened just for it goes.
    report.copies++;
    if (created) { await store.deleteTicket(ticketId); run.created.delete(ticketId); report.created--; }
    return;
  }
  report.stored++;
  await applyToTicket(run, ticketId, { direction: ours ? "out" : "in", sentAt: p.sentAt, auto: p.autoSubmitted, snippet, who: who(deps, p) });

  if (created || !threadLinked) await importThread(run, p.threadId, p.gmailId);
}

/** take(), with a failure that belongs to this one message counted and skipped (never stopping the mailbox). */
async function takeSafely(run: Run, meta: GmailMessage) {
  try {
    await take(run, meta);
  } catch (e) {
    if (isOutage(e)) throw e;
    run.report.failed++;
    if (run.report.errors.length < 5) run.report.errors.push(`${meta.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
}

/** Settle every ticket this run created: Open, Waiting, or Done when quiet for a week. */
async function settle(run: Run) {
  const now = run.deps.now?.() ?? Date.now();
  for (const id of run.created) {
    const t = await run.deps.store.getTicket(id);
    if (!t) continue;
    const c = settleImported(t, !!t.waiting_since, now);
    await run.deps.store.updateTicket(id, c.patch);
    if (c.events.length) await run.deps.store.addEvents(id, c.events);
  }
}

const blankReport = (mode: SyncReport["mode"], historyId: string | null): SyncReport =>
  ({ mode, looked: 0, stored: 0, copies: 0, created: 0, skipped: 0, unverified: 0, failed: 0, errors: [], historyId, units: 0 });

async function fill(deps: SyncDeps, mb: MailboxRow, days: number, mode: "fill" | "refill"): Promise<SyncReport> {
  const report = blankReport(mode, null);
  const profile = await deps.gmail.profile();
  report.historyId = profile.historyId;
  const queries = backfillQueries(deps.index, days);
  // Others: every email of the window, not only the client addresses' (spam, trash, drafts and chats never).
  if (deps.others) queries.push(`newer_than:${Math.max(1, Math.round(days))}d -in:sent -in:chats -in:drafts -in:spam -in:trash`);
  // A refill also reads our Sent mail of the gap: replies made while the history was lost.
  if (mode === "refill") queries.push(`in:sent newer_than:${Math.max(1, Math.round(days))}d`);
  const ids = new Map<string, string>();
  for (const q of queries) {
    let pageToken: string | undefined;
    do {
      const page = await deps.gmail.listMessages(q, pageToken);
      for (const m of page.messages ?? []) ids.set(m.id, m.threadId);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.size < MAX_FILL_MESSAGES);
    if (ids.size >= MAX_FILL_MESSAGES) break;
  }
  const run: Run = { deps, mb, report, created: new Set(), lastBeat: Date.now() };
  const metas: GmailMessage[] = [];
  for (const id of ids.keys()) {
    if (await deps.store.findCopy(mb.email, id)) continue;
    try { metas.push(await deps.gmail.metadata(id)); } catch (e) { if (!(e instanceof GmailError && e.status === 404)) throw e; }
    await beat(run);
  }
  metas.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  report.looked = metas.length;
  for (const m of metas) await takeSafely(run, m);
  await settle(run);
  report.units = deps.gmail.units ?? 0;
  return report;
}

async function fromHistory(deps: SyncDeps, mb: MailboxRow): Promise<SyncReport> {
  const report = blankReport("history", mb.history_id);
  const added = new Map<string, string[]>();
  let pageToken: string | undefined;
  do {
    const page = await deps.gmail.history(mb.history_id!, pageToken);
    for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) added.set(a.message.id, a.message.labelIds ?? []);
    if (page.historyId) report.historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  const run: Run = { deps, mb, report, created: new Set(), lastBeat: Date.now() };
  const ids = [...added].filter(([, labels]) => !labels.some((l) => SKIP_LABELS.has(l))).map(([id]) => id);
  for (const id of ids) {
    if (await deps.store.findCopy(mb.email, id)) continue;
    let meta: GmailMessage;
    try { meta = await deps.gmail.metadata(id); } catch (e) { if (e instanceof GmailError && e.status === 404) continue; throw e; }
    report.looked++;
    await takeSafely(run, meta);
  }
  await settle(run);
  report.units = deps.gmail.units ?? 0;
  return report;
}

/** Bring one mailbox up to date. Throws GmailAuthError when Google has taken the access away, or on an outage. */
export async function syncMailbox(deps: SyncDeps, mb: MailboxRow): Promise<SyncReport> {
  if (!mb.backfill_done_at || !mb.history_id) return fill(deps, mb, FIRST_FILL_DAYS, "fill");
  try {
    return await fromHistory(deps, mb);
  } catch (e) {
    if (!(e instanceof GmailHistoryGone)) throw e;
    const since = Date.parse(mb.last_ok_at ?? mb.backfill_done_at);
    const days = Number.isFinite(since) ? Math.ceil(((deps.now?.() ?? Date.now()) - since) / 86_400_000) + 1 : FIRST_FILL_DAYS;
    return fill(deps, mb, Math.min(FIRST_FILL_DAYS, Math.max(2, days)), "refill");
  }
}
