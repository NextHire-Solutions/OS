import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { listTeamMembers } from "@/lib/identity/team-directory";

import { CALLBACK_PATH, oauthConfig, tokenKeySet } from "./config";
import { clientDirectory } from "./directory";
import type { Address } from "./gmail-message";
import { revokeToken } from "./gmail-api";
import { viewers, viewersFor } from "./presence";
import type { MailboxRow, TicketRow } from "./store";
import { dbTicketStore } from "./store-db";
import { act, type Action } from "./ticket-rules";
import { openToken, sealToken } from "./token-crypto";
import type { MailboxesPage, MailboxView, Person, TicketDetail, TicketEventView, TicketList, TicketListItem, TicketMessageView } from "./types";
import { cleanQuery, ticketNumberIn, VIEWS, type View } from "./views";
import { publicOrigin } from "@/lib/mcp/oauth";

/*
 * TICKETS — what the screens read and the actions people take. Every write is attributed to the signed-in person
 * and logged on the ticket's timeline.
 */

const MISSING = /relation .* does not exist|could not find the table|schema cache/i;
const SETUP_MIGRATION = "Tickets needs its database tables: run migrations/0053_tickets.sql in the Master Inbox Supabase project.";

const PAGE = 100;

type Q = ReturnType<ReturnType<typeof osTable>["select"]>;

function applyView(q: Q, view: View, me: string): Q {
  switch (view) {
    case "open": return q.eq("status", "open");
    case "mine": return q.eq("assignee", me).in("status", ["open", "waiting"]);
    case "unassigned": return q.is("assignee", null).eq("status", "open");
    case "waiting": return q.eq("status", "waiting").is("snoozed_until", null);
    case "snoozed": return q.eq("status", "waiting").not("snoozed_until", "is", null);
    case "done": return q.eq("status", "done");
    case "mentions": return q;
    case "all": return q.neq("status", "ignored");
  }
}

function order(q: Q, view: View): Q {
  if (view === "open" || view === "unassigned" || view === "mine") return q.order("waiting_since", { ascending: true, nullsFirst: false }).order("last_activity_at", { ascending: false });
  if (view === "snoozed") return q.order("snoozed_until", { ascending: true });
  if (view === "done") return q.order("closed_at", { ascending: false, nullsFirst: false });
  return q.order("last_activity_at", { ascending: false });
}

async function mentionIds(me: string): Promise<string[]> {
  const { data } = await osTable("os_ticket_events").select("ticket_id").contains("mentions", [me]).order("created_at", { ascending: false }).limit(300);
  return [...new Set((data ?? []).map((r) => String((r as { ticket_id: string }).ticket_id)))];
}

async function teamPeople(): Promise<Person[]> {
  const members = await listTeamMembers().catch(() => []);
  return members.filter((m) => m.active !== false).map((m) => ({ email: m.email.toLowerCase(), name: m.name })).sort((a, b) => a.name.localeCompare(b.name));
}

function listItem(t: TicketRow, clients: Map<string, { id: string; name: string; status: string | null }>, received: string[], seenAt: string | undefined): TicketListItem {
  const lastIn = t.last_inbound_at ? Date.parse(t.last_inbound_at) : NaN;
  const lastOut = t.last_outbound_at ? Date.parse(t.last_outbound_at) : NaN;
  return {
    id: t.id,
    number: Number(t.number),
    subject: t.subject,
    status: t.status,
    snoozedUntil: t.snoozed_until,
    assignee: t.assignee,
    client: t.os_client_id ? clients.get(t.os_client_id) ?? { id: t.os_client_id, name: "Unknown client", status: null } : null,
    matchMethod: t.match_method,
    contact: { email: t.contact_email, name: t.contact_name },
    snippet: t.snippet,
    waitingSince: t.waiting_since,
    lastActivityAt: t.last_activity_at ?? t.updated_at,
    lastMessageAt: t.last_message_at,
    lastFrom: Number.isFinite(lastIn) || Number.isFinite(lastOut) ? (!Number.isFinite(lastOut) || lastIn > lastOut ? "client" : "team") : null,
    messageCount: t.message_count,
    receivedBy: received,
    unread: !seenAt || Date.parse(seenAt) < Date.parse(t.last_activity_at ?? t.updated_at),
    needsFirstResponse: t.status === "open" && !t.first_response_at,
  };
}

async function clientMap() {
  const dir = await clientDirectory().catch(() => null);
  const m = new Map<string, { id: string; name: string; status: string | null }>();
  for (const c of dir?.clients ?? []) if (!c.internal) m.set(c.id, { id: c.id, name: c.name, status: c.status });
  return m;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listTickets(opts: { view: View; me: string; admin: boolean; client?: string | null; mailbox?: string | null; q?: string | null; offset?: number; limit?: number }): Promise<TicketList> {
  // A stale or hand-typed filter is ignored, never an error.
  if (opts.client && !UUID.test(opts.client)) opts = { ...opts, client: null };
  if (opts.mailbox && !/^[^\s@,()"]+@[^\s@,()"]+$/.test(opts.mailbox)) opts = { ...opts, mailbox: null };
  const pageSize = Math.max(1, Math.min(500, opts.limit ?? PAGE));
  const me = opts.me.toLowerCase();
  const empty: TicketList = { ready: true, view: opts.view, rows: [], total: 0, counts: {}, unread: {}, viewers: {}, team: [], clients: [], mailboxes: [], me, admin: opts.admin, myMailbox: null };
  const [team, clients, mbRes] = await Promise.all([teamPeople(), clientMap(), osTable("os_ticket_mailboxes").select("email, name, state")]);
  if (mbRes.error) return MISSING.test(mbRes.error.message) ? { ...empty, ready: false, setup: SETUP_MIGRATION, team } : Promise.reject(new Error(mbRes.error.message));
  const mailboxes = (mbRes.data ?? []) as Array<{ email: string; name: string | null; state: string }>;
  const base = { ...empty, team, clients: [...clients.values()].sort((a, b) => a.name.localeCompare(b.name)), mailboxes, myMailbox: mailboxes.find((m) => m.email.toLowerCase() === me) ?? null };

  // Filters that become id lists.
  let only: string[] | null = null;
  const narrow = (ids: string[]) => { only = only === null ? ids : only.filter((x) => ids.includes(x)); };
  if (opts.view === "mentions") narrow(await mentionIds(me));
  if (opts.mailbox) {
    const { data } = await osTable("os_ticket_copies").select("ticket_id").eq("mailbox", opts.mailbox.toLowerCase()).limit(5000);
    narrow([...new Set((data ?? []).map((r) => String((r as { ticket_id: string }).ticket_id)))]);
  }

  let q = osTable("os_tickets").select("*", { count: "exact" });
  q = applyView(q, opts.view, me);
  if (opts.client) q = q.eq("os_client_id", opts.client);
  const text = cleanQuery(opts.q);
  if (text) {
    const n = ticketNumberIn(text);
    const like = `"*${text}*"`;
    const parts = [`subject.ilike.${like}`, `contact_email.ilike.${like}`, `contact_name.ilike.${like}`, `snippet.ilike.${like}`];
    if (n !== null) parts.push(`number.eq.${n}`);
    const lc = text.toLowerCase();
    const named = [...clients.values()].filter((c) => c.name.toLowerCase().includes(lc)).map((c) => c.id);
    if (named.length) parts.push(`os_client_id.in.(${named.join(",")})`);
    const { data: bodyHits } = await osTable("os_ticket_messages").select("ticket_id").ilike("body_text", `%${text}%`).limit(300);
    const hitIds = [...new Set((bodyHits ?? []).map((r) => String((r as { ticket_id: string }).ticket_id)))];
    if (hitIds.length) parts.push(`id.in.(${hitIds.join(",")})`);
    q = q.or(parts.join(","));
  }
  if (only !== null) {
    if (!(only as string[]).length) return { ...base, ...(await countViews(me)) };
    q = q.in("id", (only as string[]).slice(0, 1000));
  }
  q = order(q, opts.view).range(opts.offset ?? 0, (opts.offset ?? 0) + pageSize - 1);
  const [{ data, error, count }, counts] = await Promise.all([q, countViews(me)]);
  if (error) {
    if (MISSING.test(error.message)) return { ...base, ready: false, setup: SETUP_MIGRATION };
    throw new Error(error.message);
  }
  const rows = (data ?? []) as TicketRow[];
  const ids = rows.map((r) => r.id);
  const [copies, reads] = ids.length
    ? await Promise.all([
        osTable("os_ticket_copies").select("ticket_id, mailbox").in("ticket_id", ids),
        osTable("os_ticket_reads").select("ticket_id, seen_at").eq("email", me).in("ticket_id", ids),
      ])
    : [{ data: [] }, { data: [] }];
  const recv = new Map<string, Set<string>>();
  for (const c of (copies.data ?? []) as Array<{ ticket_id: string; mailbox: string }>) {
    if (!recv.has(c.ticket_id)) recv.set(c.ticket_id, new Set());
    recv.get(c.ticket_id)!.add(c.mailbox.toLowerCase());
  }
  const seen = new Map(((reads.data ?? []) as Array<{ ticket_id: string; seen_at: string }>).map((r) => [r.ticket_id, r.seen_at]));
  return {
    ...base,
    rows: rows.map((t) => listItem(t, clients, [...(recv.get(t.id) ?? [])].sort(), seen.get(t.id))),
    total: count ?? rows.length,
    counts: counts.counts,
    unread: counts.unread,
    viewers: viewersFor(ids, me),
  };
}

/** How many tickets each view holds (Done and All aren't counted: they only grow). */
export async function countViews(me: string): Promise<{ counts: Partial<Record<View, number>>; unread: Partial<Record<View, number>> }> {
  const views: View[] = ["open", "mine", "unassigned", "waiting", "snoozed"];
  const res = await Promise.all(views.map((v) => applyView(osTable("os_tickets").select("id", { count: "exact", head: true }), v, me)));
  const counts: Partial<Record<View, number>> = {};
  views.forEach((v, i) => { if (!res[i].error) counts[v] = res[i].count ?? 0; });
  const mentions = await mentionIds(me).catch(() => []);
  const unread: Partial<Record<View, number>> = {};
  if (mentions.length) {
    const [{ data: tk }, { data: rd }] = await Promise.all([
      osTable("os_tickets").select("id, last_activity_at").in("id", mentions.slice(0, 300)),
      osTable("os_ticket_reads").select("ticket_id, seen_at").eq("email", me).in("ticket_id", mentions.slice(0, 300)),
    ]);
    const seen = new Map(((rd ?? []) as Array<{ ticket_id: string; seen_at: string }>).map((r) => [r.ticket_id, Date.parse(r.seen_at)]));
    unread.mentions = ((tk ?? []) as Array<{ id: string; last_activity_at: string }>).filter((t) => !(seen.get(t.id)! >= Date.parse(t.last_activity_at))).length;
  }
  counts.mentions = mentions.length;
  return { counts, unread };
}

/** "1042" or a uuid → the ticket row. */
async function findTicket(idOrNumber: string): Promise<TicketRow | null> {
  const n = /^\d{1,12}$/.test(idOrNumber) ? Number(idOrNumber) : null;
  const q = osTable("os_tickets").select("*");
  const { data, error } = await (n !== null ? q.eq("number", n) : q.eq("id", idOrNumber)).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TicketRow | null) ?? null;
}

export async function ticketDetail(idOrNumber: string, me: string, admin: boolean): Promise<TicketDetail | null> {
  const meL = me.toLowerCase();
  const t = await findTicket(idOrNumber);
  if (!t) return null;
  const [msgs, copies, events, clients, read] = await Promise.all([
    osTable("os_ticket_messages").select("*").eq("ticket_id", t.id).order("sent_at", { ascending: true }),
    osTable("os_ticket_copies").select("mailbox, gmail_id, message_id").eq("ticket_id", t.id),
    osTable("os_ticket_events").select("*").eq("ticket_id", t.id).order("created_at", { ascending: true }),
    clientMap(),
    osTable("os_ticket_reads").select("seen_at").eq("ticket_id", t.id).eq("email", meL).maybeSingle(),
  ]);
  const byMsg = new Map<string, Array<{ mailbox: string; gmail_id: string }>>();
  for (const c of (copies.data ?? []) as Array<{ mailbox: string; gmail_id: string; message_id: string }>) {
    if (!byMsg.has(c.message_id)) byMsg.set(c.message_id, []);
    byMsg.get(c.message_id)!.push({ mailbox: c.mailbox.toLowerCase(), gmail_id: c.gmail_id });
  }
  const received = [...new Set([...byMsg.values()].flat().map((c) => c.mailbox))].sort();
  const messages: TicketMessageView[] = ((msgs.data ?? []) as Array<Record<string, unknown>>).map((m) => {
    const cs = byMsg.get(String(m.id)) ?? [];
    return {
      id: String(m.id),
      rfcId: String(m.rfc_id),
      direction: m.direction as "in" | "out",
      trimmed: m.trimmed === true,
      from: { email: String(m.from_email ?? ""), name: (m.from_name as string | null) ?? null },
      to: (m.to_list as Address[]) ?? [],
      cc: (m.cc_list as Address[]) ?? [],
      subject: (m.subject as string | null) ?? null,
      sentAt: String(m.sent_at),
      html: (m.body_html as string | null) ?? null,
      text: (m.body_text as string | null) ?? null,
      attachments: (m.attachments as TicketMessageView["attachments"]) ?? [],
      receivedBy: [...new Set(cs.map((c) => c.mailbox))].sort(),
      myGmailId: cs.find((c) => c.mailbox === meL)?.gmail_id ?? null,
    };
  });
  const ev: TicketEventView[] = ((events.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
    id: String(e.id), kind: e.kind as TicketEventView["kind"], actor: (e.actor as string | null) ?? null, body: (e.body as string | null) ?? null,
    mentions: (e.mentions as string[]) ?? [], from: (e.from_value as string | null) ?? null, to: (e.to_value as string | null) ?? null, at: String(e.created_at),
  }));
  const item = listItem(t, clients, received, (read.data as { seen_at: string } | null)?.seen_at);
  return {
    ticket: { ...item, closedAt: t.closed_at, closedBy: t.closed_by, firstResponseAt: t.first_response_at, createdAt: t.created_at },
    messages,
    events: ev,
    viewers: viewers(t.id, meL),
    canRemove: admin || received.includes(meL),
  };
}

export class TicketActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Status, assignee, snooze or client — one change, logged. */
export async function changeTicket(idOrNumber: string, actor: string, change: Action | { type: "client"; to: string | null }): Promise<void> {
  const t = await findTicket(idOrNumber);
  if (!t) throw new TicketActionError("No such ticket", 404);
  const who = actor.toLowerCase();
  if (change.type === "client") {
    if (change.to) {
      const clients = await clientMap();
      if (!clients.has(change.to)) throw new TicketActionError("That client isn't on the client list");
    }
    if ((t.os_client_id ?? null) === change.to) return;
    const clients = await clientMap();
    await dbTicketStore.updateTicket(t.id, { os_client_id: change.to, match_method: change.to ? "manual" : null } as Partial<TicketRow>);
    await dbTicketStore.addEvents(t.id, [{ kind: "client", actor: who, from_value: t.os_client_id ? clients.get(t.os_client_id)?.name ?? null : null, to_value: change.to ? clients.get(change.to)?.name ?? null : null }]);
    return;
  }
  if (change.type === "assign" && change.to) {
    const team = await teamPeople();
    if (!team.some((p) => p.email === change.to!.toLowerCase())) throw new TicketActionError("Only a teammate can be assigned");
  }
  // Re-read and retry if the sync changed the ticket in between (nobody's change is overwritten).
  for (let i = 0, cur: TicketRow | null = t; i < 4 && cur; i++, cur = await dbTicketStore.getTicket(t.id)) {
    const c = act(cur, change, who);
    if (!c) return;
    if (await dbTicketStore.updateTicket(cur.id, { ...c.patch, last_activity_at: new Date().toISOString() } as Partial<TicketRow>, cur.updated_at)) {
      await dbTicketStore.addEvents(cur.id, c.events);
      await markSeen(cur.id, who);
      return;
    }
  }
  throw new TicketActionError("The ticket changed while saving. Try again.", 409);
}

/** An internal note, with @mentions of teammates. */
export async function addNote(idOrNumber: string, actor: string, body: string, mentions: string[]): Promise<void> {
  const t = await findTicket(idOrNumber);
  if (!t) throw new TicketActionError("No such ticket", 404);
  const text = body.trim();
  if (!text) throw new TicketActionError("Write something first");
  if (text.length > 5000) throw new TicketActionError("Notes are 5,000 characters at most");
  const team = new Set((await teamPeople()).map((p) => p.email));
  const valid = [...new Set(mentions.map((m) => m.toLowerCase()))].filter((m) => team.has(m) && m !== actor.toLowerCase());
  await dbTicketStore.addEvents(t.id, [{ kind: "note", actor: actor.toLowerCase(), body: text, mentions: valid }]);
  await dbTicketStore.updateTicket(t.id, { last_activity_at: new Date().toISOString() } as Partial<TicketRow>);
  await markSeen(t.id, actor);
}

/** "Opened in Gmail by Eddy" — a soft signal to the team that someone is replying (research: no locks). */
export async function logGmailOpen(idOrNumber: string, actor: string): Promise<void> {
  const t = await findTicket(idOrNumber);
  if (!t) return;
  const { data } = await osTable("os_ticket_events").select("created_at").eq("ticket_id", t.id).eq("kind", "gmail").eq("actor", actor.toLowerCase()).gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1);
  if ((data ?? []).length) return;
  await dbTicketStore.addEvents(t.id, [{ kind: "gmail", actor: actor.toLowerCase() }]);
}

export async function markSeen(idOrNumber: string, email: string): Promise<void> {
  const id = /^[0-9a-f-]{36}$/i.test(idOrNumber) ? idOrNumber : (await findTicket(idOrNumber))?.id;
  if (!id) return;
  await osTable("os_ticket_reads").upsert({ ticket_id: id, email: email.toLowerCase(), seen_at: new Date().toISOString() }, { onConflict: "ticket_id,email" });
}

/** Remove a conversation from Tickets for good: its stored emails go, and it is never imported again. */
export async function removeTicket(idOrNumber: string, actor: string, admin: boolean): Promise<void> {
  const t = await findTicket(idOrNumber);
  if (!t) throw new TicketActionError("No such ticket", 404);
  const [{ data: copies }, { data: msgs }] = await Promise.all([
    osTable("os_ticket_copies").select("mailbox, gmail_thread_id").eq("ticket_id", t.id),
    osTable("os_ticket_messages").select("rfc_id").eq("ticket_id", t.id),
  ]);
  const cs = (copies ?? []) as Array<{ mailbox: string; gmail_thread_id: string }>;
  if (!admin && !cs.some((c) => c.mailbox.toLowerCase() === actor.toLowerCase())) {
    throw new TicketActionError("Only an admin, or a teammate whose inbox holds this conversation, can remove it", 403);
  }
  const keys = [
    ...((msgs ?? []) as Array<{ rfc_id: string }>).map((m) => `msg:${m.rfc_id}`),
    ...cs.map((c) => `thread:${c.mailbox.toLowerCase()}:${c.gmail_thread_id}`),
  ];
  await dbTicketStore.block([...new Set(keys)], actor.toLowerCase());
  await dbTicketStore.deleteTicket(t.id);
}

/* ------------------------------------------------------------------ mailboxes --- */

export async function mailboxesPage(me: string, admin: boolean): Promise<MailboxesPage> {
  const meL = me.toLowerCase();
  const cfg = oauthConfig();
  const missing = [...(cfg ? [] : ["TICKETS_GOOGLE_CLIENT_ID", "TICKETS_GOOGLE_CLIENT_SECRET"]), ...(tokenKeySet() ? [] : ["OS_TICKETS_TOKEN_KEY"])];
  const base: MailboxesPage = {
    ready: true, googleConfigured: !missing.length, missing, callback: `${publicOrigin()}${CALLBACK_PATH}`, mailboxes: [], team: [], me: meL, admin,
  };
  const [team, res] = await Promise.all([teamPeople(), osTable("os_ticket_mailboxes").select("email, name, connected_by, state, connected_at, last_ok_at, last_error, backfill_done_at")]);
  if (res.error) return MISSING.test(res.error.message) ? { ...base, ready: false, setup: SETUP_MIGRATION, team: team.map((p) => ({ ...p, connected: false })) } : Promise.reject(new Error(res.error.message));
  const rows = (res.data ?? []) as Array<Record<string, string | null>>;
  const counts = await Promise.all(rows.map((r) => osTable("os_ticket_copies").select("ticket_id", { count: "exact", head: true }).eq("mailbox", String(r.email))));
  const mailboxes: MailboxView[] = rows.map((r, i) => ({
    email: String(r.email).toLowerCase(),
    name: r.name,
    connectedBy: String(r.connected_by ?? "").toLowerCase(),
    state: (r.state as MailboxView["state"]) ?? "syncing",
    connectedAt: String(r.connected_at),
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    backfilled: !!r.backfill_done_at,
    tickets: counts[i].count ?? 0,
    mine: String(r.email).toLowerCase() === meL || String(r.connected_by ?? "").toLowerCase() === meL,
  }));
  const connected = new Set(mailboxes.filter((m) => m.state !== "paused").map((m) => m.email));
  return { ...base, mailboxes, team: team.map((p) => ({ ...p, connected: connected.has(p.email) })) };
}

/** Store (or replace) a connected mailbox. A reconnect keeps its place in the history, so nothing is fetched twice. */
export async function saveMailbox(input: { email: string; name: string | null; refreshToken: string; scope: string; connectedBy: string }): Promise<void> {
  const email = input.email.toLowerCase();
  const { data: had } = await osTable("os_ticket_mailboxes").select("email, history_id, backfill_done_at").eq("email", email).maybeSingle();
  const row = {
    email,
    name: input.name,
    connected_by: input.connectedBy.toLowerCase(),
    token_enc: sealToken(input.refreshToken, email),
    scope: input.scope,
    state: (had as MailboxRow | null)?.backfill_done_at ? "ok" : "syncing",
    last_error: null,
    error_count: 0,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await osTable("os_ticket_mailboxes").upsert(row, { onConflict: "email" });
  if (error) throw new Error(MISSING.test(error.message) ? SETUP_MIGRATION : error.message);
}

/** Disconnect: Google is told to drop the access, the stored token is erased. The tickets already shared stay. */
export async function disconnectMailbox(email: string, actor: string, admin: boolean): Promise<void> {
  const e = email.toLowerCase();
  const { data } = await osTable("os_ticket_mailboxes").select("email, connected_by, token_enc").eq("email", e).maybeSingle();
  const row = data as { email: string; connected_by: string; token_enc: string | null } | null;
  if (!row) throw new TicketActionError("That inbox isn't connected", 404);
  if (!admin && e !== actor.toLowerCase() && row.connected_by.toLowerCase() !== actor.toLowerCase()) {
    throw new TicketActionError("Only the inbox's owner or an admin can disconnect it", 403);
  }
  const token = openToken(row.token_enc, e);
  if (token) await revokeToken(token);
  const { error } = await osTable("os_ticket_mailboxes").update({ token_enc: null, state: "paused", updated_at: new Date().toISOString() }).eq("email", e);
  if (error) throw new Error(error.message);
}

export { VIEWS };
