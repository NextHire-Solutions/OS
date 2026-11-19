import { backfillQueries, isTeamAddress, matchSender, type ClientIndex } from "./client-match.ts";
import { GmailError, GmailHistoryGone, type GmailClient } from "./gmail-api.ts";
import { htmlToText, parseBodies, parseMessage, type GmailMessage, type ParsedMessage } from "./gmail-message.ts";
import type { MailboxRow, TicketStore } from "./store.ts";
import { applyMessage, settleImported } from "./ticket-rules.ts";

/*
 * TICKETS — one mailbox's sync. Reads Gmail, keeps only client conversations.
 *
 * FIRST FILL: Gmail is searched for mail FROM clients in the last 30 days (client-match.ts backfillQueries — a
 * prefilter; every hit's From is matched again here). The history id is read BEFORE the search, so nothing that
 * arrives during the fill is missed: the next run continues from it.
 * AFTER THAT: users.history.list from the stored id, every minute. A 404 (Google keeps history "at least a week,
 * sometimes only hours") falls back to a fill covering the time since the last good run.
 *
 * ONLY EMAILS FROM CLIENT ADDRESSES ARE KEPT (the user, 20 Nov: "make sure we only see emails that came from
 * client's email addresses. no other emails should be shown here, this is very important"). For each new message
 * (headers only first — 20 units; the body only for what we keep — 60):
 *  - FROM A CLIENT ADDRESS (client-match.ts: an exact address we hold for a client): kept with its body. It joins
 *    the conversation it belongs to (this mailbox's Gmail thread, or the message it replies to), else it starts a
 *    new ticket — unless it is automatic mail (out-of-office, lists), which never starts one. The same email in
 *    a second teammate's inbox is stored once (its RFC Message-ID) and noted as received by both.
 *  - FROM US, inside a tracked client conversation, to someone outside the team: NOT kept as an email. Only the
 *    fact is kept — who replied and when, no subject, text or recipients — so the ticket moves to Waiting and
 *    shows "Amy replied in Gmail". Mail only between teammates (a forward) leaves no trace at all.
 *  - FROM ANYONE ELSE — a stranger, someone new at the client's company, a vendor replying inside a client's
 *    thread: never stored, never shown.
 *  - Drafts, spam, trash and chats are skipped.
 * When a client's email starts a ticket, the rest of that conversation in this mailbox is read the same way:
 * the client's earlier emails kept, our replies noted, everyone else's dropped.
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
}

export interface SyncReport {
  mode: "fill" | "refill" | "history";
  looked: number;
  stored: number;
  copies: number;
  created: number;
  skipped: number;
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

interface Run { deps: SyncDeps; mb: MailboxRow; report: SyncReport; created: Set<string>; importing: boolean }

const who = (deps: SyncDeps, p: ParsedMessage) => {
  const e = p.from?.email ?? "";
  const n = deps.names.get(e) ?? p.from?.name ?? e;
  return n.split(/\s+/)[0] || n;
};

async function concurrently<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** One message (headers) into the tickets, per the rules above. */
async function take(run: Run, meta: GmailMessage, viaThread = false): Promise<void> {
  const { deps, mb, report } = run;
  const { store } = deps;
  const p = parseMessage(meta);
  if (p.labels.some((l) => SKIP_LABELS.has(l))) { report.skipped++; return; }
  if (await store.findCopy(mb.email, p.gmailId)) return;
  const rfc = p.rfcId || `gmail:${mb.email}:${p.gmailId}`;

  if (await store.anyBlocked([`msg:${rfc}`, ...p.refs.map((r) => `msg:${r}`), `thread:${mb.email}:${p.threadId}`])) {
    await store.block([`msg:${rfc}`, `thread:${mb.email}:${p.threadId}`], null);
    report.skipped++;
    return;
  }

  const fromEmail = p.from?.email ?? null;
  const ours = isTeamAddress(fromEmail, deps.team) || fromEmail === mb.email;
  const client = ours ? null : matchSender(deps.index, fromEmail);
  // Neither a client address nor us: never stored, never shown.
  if (!ours && !client) { report.skipped++; return; }
  const direction: "in" | "out" = ours ? "out" : "in";
  if (ours) {
    const recipients = [...p.to, ...p.cc].map((a) => a.email);
    if (!recipients.length || recipients.every((e) => isTeamAddress(e, deps.team) || e === mb.email)) { report.skipped++; return; }
  }

  const stored = await store.messagesByRfc([rfc]);
  if (stored[0]) {
    await store.insertCopy({ mailbox: mb.email, gmail_id: p.gmailId, gmail_thread_id: p.threadId, message_id: stored[0].id, ticket_id: stored[0].ticket_id, labels: p.labels });
    report.copies++;
    return;
  }

  let ticketId = await store.ticketForThread(mb.email, p.threadId);
  if (!ticketId && p.refs.length) ticketId = (await store.messagesByRfc(p.refs))[0]?.ticket_id ?? null;

  // Our reply outside any tracked conversation (we wrote first, or to a non-client): nothing to note.
  if (!ticketId && ours) { report.skipped++; return; }

  let created = false;
  if (!ticketId) {
    if (p.autoSubmitted || !client) { report.skipped++; return; }
    const match = client;
    const t = await store.createTicket({
      os_client_id: match.clientId,
      match_method: match.method,
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
    const also = match.alsoOn.map((id) => deps.index.clients.get(id)?.name).filter(Boolean);
    await store.addEvents(t.id, [{
      kind: "created", actor: null,
      body: `${run.importing ? "Imported" : "New email"} from ${p.from?.name ?? fromEmail} in ${mbName.split(/\s+/)[0]}'s inbox${also.length ? `. The same address is also on ${also.join(", ")}` : ""}`,
    }]);
  }

  // A client's email is kept whole; our reply only as a dated marker (no subject, text, recipients or files).
  let content = { to_list: [] as typeof p.to, cc_list: [] as typeof p.cc, subject: null as string | null, snippet: null as string | null, body_html: null as string | null, body_text: null as string | null, attachments: [] as ReturnType<typeof parseBodies>["attachments"] };
  if (direction === "in") {
    const b = parseBodies(await deps.gmail.full(p.gmailId));
    const html = b.html && b.html.length <= MAX_HTML ? b.html : null;
    const text = (b.text ?? (b.html ? htmlToText(b.html) : "") ?? "").slice(0, MAX_TEXT) || null;
    content = { to_list: p.to, cc_list: p.cc, subject: p.subject || null, snippet: p.snippet || (text ? text.slice(0, 200) : null), body_html: html, body_text: text, attachments: b.attachments };
  }
  const ins = await store.insertMessage({
    ticket_id: ticketId,
    rfc_id: rfc,
    direction,
    from_email: fromEmail,
    from_name: direction === "out" ? deps.names.get(fromEmail ?? "") ?? p.from?.name ?? null : p.from?.name ?? null,
    ...content,
    in_reply_to: p.inReplyTo,
    refs: p.refs,
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

  const t = await store.getTicket(ticketId);
  if (t) {
    const c = applyMessage(t, { direction, sentAt: p.sentAt, auto: p.autoSubmitted, snippet: direction === "in" ? p.snippet : "", who: who(deps, p) }, run.importing || created || viaThread);
    await store.updateTicket(ticketId, c.patch);
    if (c.events.length) await store.addEvents(ticketId, c.events);
  }

  if (created) {
    // The rest of this conversation in this mailbox: the client's earlier emails and the team's replies.
    const th = await deps.gmail.thread(p.threadId);
    const rest = (th.messages ?? []).filter((m) => m.id !== p.gmailId).sort((a, b2) => Number(a.internalDate) - Number(b2.internalDate));
    for (const m of rest) await take(run, m, true);
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

async function fill(deps: SyncDeps, mb: MailboxRow, days: number, mode: "fill" | "refill"): Promise<SyncReport> {
  const report: SyncReport = { mode, looked: 0, stored: 0, copies: 0, created: 0, skipped: 0, historyId: null, units: 0 };
  const profile = await deps.gmail.profile();
  report.historyId = profile.historyId;
  const ids = new Map<string, string>();
  for (const q of backfillQueries(deps.index, days)) {
    let pageToken: string | undefined;
    do {
      const page = await deps.gmail.listMessages(q, pageToken);
      for (const m of page.messages ?? []) ids.set(m.id, m.threadId);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.size < MAX_FILL_MESSAGES);
    if (ids.size >= MAX_FILL_MESSAGES) break;
  }
  const todo: string[] = [];
  for (const id of ids.keys()) if (!(await deps.store.findCopy(mb.email, id))) todo.push(id);
  const metas: GmailMessage[] = [];
  await concurrently(todo, 4, async (id) => {
    try { metas.push(await deps.gmail.metadata(id)); } catch (e) { if (!(e instanceof GmailError && e.status === 404)) throw e; }
  });
  metas.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  report.looked = metas.length;
  const run: Run = { deps, mb, report, created: new Set(), importing: true };
  for (const m of metas) await take(run, m);
  await settle(run);
  report.units = deps.gmail.units ?? 0;
  return report;
}

async function fromHistory(deps: SyncDeps, mb: MailboxRow): Promise<SyncReport> {
  const report: SyncReport = { mode: "history", looked: 0, stored: 0, copies: 0, created: 0, skipped: 0, historyId: mb.history_id, units: 0 };
  const added = new Map<string, string[]>();
  let pageToken: string | undefined;
  do {
    const page = await deps.gmail.history(mb.history_id!, pageToken);
    for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) added.set(a.message.id, a.message.labelIds ?? []);
    if (page.historyId) report.historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  const run: Run = { deps, mb, report, created: new Set(), importing: false };
  const ids = [...added].filter(([, labels]) => !labels.some((l) => SKIP_LABELS.has(l))).map(([id]) => id);
  for (const id of ids) {
    if (await deps.store.findCopy(mb.email, id)) continue;
    let meta: GmailMessage;
    try { meta = await deps.gmail.metadata(id); } catch (e) { if (e instanceof GmailError && e.status === 404) continue; throw e; }
    report.looked++;
    await take(run, meta);
  }
  await settle(run);
  report.units = deps.gmail.units ?? 0;
  return report;
}

/** Bring one mailbox up to date. Throws GmailAuthError when Google has taken the access away. */
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
