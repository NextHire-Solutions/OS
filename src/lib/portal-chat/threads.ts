import { osTable } from "@/lib/clients/os-db";

/*
 * A conversation with our team from the portal's chat (4 Nov; migration 0047). The client presses "Ask for a person",
 * our team hears on Slack with a link, opens that portal's chat and replies there (Amy: "I like number 1"). What was
 * said up to that moment comes along, so they can see what it's about; ordinary chats with the assistant are never kept.
 *
 * Who may see or do what is the route's (api/crm-preview/ask-person, person-chat). A client's address and our team's
 * never leave here for a client: `view` carries names only.
 */

export type ChatRole = "client" | "assistant" | "team" | "note";

export interface ThreadRow {
  id: string;
  portal_id: string;
  client_email: string;
  client_name: string | null;
  status: "open" | "closed";
  closed_by: string | null;
  closed_at: string | null;
  client_read_at: string | null;
  last_alert_at: string | null;
  alert_claimed_at: string | null;
  test: boolean;
  created_at: string;
}

interface MessageRow { id: number; thread_id: string; role: ChatRole; text: string; sender_name: string | null; emailed_at?: string | null; created_at: string }

export interface ChatMessageView { id: number; role: ChatRole; text: string; sender: string | null; at: string; emailed: boolean }
export interface ChatThreadView {
  id: string;
  status: "open" | "closed";
  person: string | null;
  test: boolean;
  /** A reply from our team the client hasn't seen yet. */
  unread: boolean;
  at: string;
  messages: ChatMessageView[];
}

/** What the database takes in one message; longer is clipped, never refused. */
export const MAX_MESSAGE_CHARS = 4_000;
/** What came before they asked: the last few turns, as the assistant itself is sent. */
export const MAX_HISTORY = 12;
/** Their next messages tell our team again, at most this often: a conversation isn't a Slack post per line. */
export const ALERT_EVERY_MS = 10 * 60_000;
/** A press telling our team that never finished (its server stopped mid-way) is taken over after this. Slack gives up after 5s. */
export const CLAIM_STALE_MS = 60_000;
/** New requests for a person, per person per portal, in an hour: each one is a Slack post. */
export const ASKS_PER_HOUR = 5;

const THREAD_COLUMNS = "id, portal_id, client_email, client_name, status, closed_by, closed_at, client_read_at, last_alert_at, alert_claimed_at, test, created_at";
const fail = (error: { message: string } | null, what: string) => { if (error) throw new Error(`${what}: ${error.message}`); };
const clip = (text: string) => text.trim().slice(0, MAX_MESSAGE_CHARS);

export function viewOf(row: ThreadRow, messages: readonly MessageRow[]): ChatThreadView {
  return {
    id: row.id,
    status: row.status,
    person: row.client_name,
    test: row.test,
    unread: messages.some((m) => m.role === "team" && (!row.client_read_at || Date.parse(m.created_at) > Date.parse(row.client_read_at))),
    at: row.created_at,
    messages: messages.map((m) => ({ id: Number(m.id), role: m.role, text: m.text, sender: m.sender_name, at: m.created_at, emailed: !!m.emailed_at })),
  };
}

export async function loadThread(id: string): Promise<ThreadRow | null> {
  const { data, error } = await osTable("os_portal_chat_threads").select(THREAD_COLUMNS).eq("id", id).maybeSingle();
  fail(error, "os_portal_chat_threads");
  return (data as ThreadRow | null) ?? null;
}

async function messagesOf(threadId: string): Promise<MessageRow[]> {
  // The newest 500, in order: a very long conversation loses its start, never its latest reply.
  const { data, error } = await osTable("os_portal_chat_messages").select("id, thread_id, role, text, sender_name, emailed_at, created_at").eq("thread_id", threadId).order("id", { ascending: false }).limit(500);
  fail(error, "os_portal_chat_messages");
  return ((data ?? []) as MessageRow[]).reverse();
}

export async function threadView(row: ThreadRow): Promise<ChatThreadView> {
  return viewOf(row, await messagesOf(row.id));
}

/** What a client is sent: whether a reply was emailed, and whether it's a test, are for our team. */
export function clientCopy(view: ChatThreadView): ChatThreadView {
  return { ...view, test: false, messages: view.messages.map((m) => ({ ...m, emailed: false })) };
}

/** Adds one message; its id, for noting later that it was emailed. */
export async function addMessage(threadId: string, role: ChatRole, text: string, sender: { name: string | null; email: string } | null, now: Date): Promise<number | null> {
  const body = clip(text);
  if (!body) return null;
  const { data, error } = await osTable("os_portal_chat_messages").insert({ thread_id: threadId, role, text: body, sender_name: sender?.name ?? null, sender_email: sender?.email ?? null, created_at: now.toISOString() }).select("id").single();
  fail(error, "os_portal_chat_messages");
  const touched = await osTable("os_portal_chat_threads").update({ updated_at: now.toISOString() }).eq("id", threadId);
  fail(touched.error, "os_portal_chat_threads");
  return Number((data as { id: number }).id);
}

/**
 * One message the sender keyed (the chat window's own key for what was typed): sent again after a timeout, it's saved
 * once — `duplicate` says this was the second time, so nothing is posted or emailed again. The database's unique index
 * settles two at the same moment.
 */
export async function addOnce(threadId: string, role: ChatRole, text: string, sender: { name: string | null; email: string } | null, now: Date, key: string | null): Promise<{ id: number | null; duplicate: boolean }> {
  if (key) {
    const { data, error } = await osTable("os_portal_chat_messages").select("id").eq("thread_id", threadId).eq("client_key", key).maybeSingle();
    fail(error, "os_portal_chat_messages");
    if (data) return { id: Number((data as { id: number }).id), duplicate: true };
  }
  const body = clip(text);
  if (!body) return { id: null, duplicate: false };
  const { data, error } = await osTable("os_portal_chat_messages").insert({ thread_id: threadId, role, text: body, sender_name: sender?.name ?? null, sender_email: sender?.email ?? null, client_key: key, created_at: now.toISOString() }).select("id").single();
  if (error && (error as { code?: string }).code === "23505") return { id: null, duplicate: true };
  fail(error, "os_portal_chat_messages");
  const touched = await osTable("os_portal_chat_threads").update({ updated_at: now.toISOString() }).eq("id", threadId);
  fail(touched.error, "os_portal_chat_threads");
  return { id: Number((data as { id: number }).id), duplicate: false };
}

export async function markEmailed(messageId: number, now: Date): Promise<void> {
  const { error } = await osTable("os_portal_chat_messages").update({ emailed_at: now.toISOString() }).eq("id", messageId);
  fail(error, "os_portal_chat_messages");
}

async function openThreadOf(portalId: string, email: string): Promise<ThreadRow | null> {
  const { data, error } = await osTable("os_portal_chat_threads").select(THREAD_COLUMNS).eq("portal_id", portalId).eq("client_email", email).eq("status", "open").maybeSingle();
  fail(error, "os_portal_chat_threads");
  return (data as ThreadRow | null) ?? null;
}

/** Their open conversation, or a new one. Two presses at once can't make two (the database's one-open index): the second finds the first. */
export async function startThread(o: { portalId: string; email: string; name: string | null; test: boolean; now: Date }): Promise<ThreadRow> {
  const open = await openThreadOf(o.portalId, o.email);
  if (open) return open;
  const { data, error } = await osTable("os_portal_chat_threads")
    .insert({ portal_id: o.portalId, client_email: o.email, client_name: o.name, status: "open", test: o.test, created_at: o.now.toISOString(), updated_at: o.now.toISOString() })
    .select(THREAD_COLUMNS).single();
  if (error && (error as { code?: string }).code !== "23505") fail(error, "os_portal_chat_threads");
  const row = (data as ThreadRow | null) ?? (await openThreadOf(o.portalId, o.email));
  if (!row) throw new Error("os_portal_chat_threads: the conversation could not be started");
  return row;
}

/**
 * What was said before they asked, by the press that gets to tell our team (claimAsk): as it stands now, in place of
 * anything left by an earlier press whose Slack post failed. Our team reads it as it is, once.
 */
export async function setHistory(threadId: string, history: ReadonlyArray<{ role: "client" | "assistant"; text: string }>, now: Date): Promise<void> {
  const cleared = await osTable("os_portal_chat_messages").delete().eq("thread_id", threadId);
  fail(cleared.error, "os_portal_chat_messages");
  const rows = history.slice(-MAX_HISTORY).map((t, i) => ({ thread_id: threadId, role: t.role, text: clip(t.text), created_at: new Date(now.getTime() + i).toISOString() })).filter((t) => t.text);
  if (!rows.length) return;
  const { error } = await osTable("os_portal_chat_messages").insert(rows);
  fail(error, "os_portal_chat_messages");
}

export async function markAlerted(id: string, now: Date): Promise<void> {
  const { error } = await osTable("os_portal_chat_threads").update({ last_alert_at: now.toISOString() }).eq("id", id);
  fail(error, "os_portal_chat_threads");
}

/**
 * Whoever gets this tells our team, once: two presses at once make one Slack post. False: another press is telling them
 * (awaitTold), or they've been told. Nobody sees the conversation until markAlerted, after the post has gone.
 */
export async function claimAsk(id: string, now: Date): Promise<string | null> {
  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const claim = now.toISOString();
  const { data, error } = await osTable("os_portal_chat_threads").update({ alert_claimed_at: claim }).eq("id", id).is("last_alert_at", null).or(`alert_claimed_at.is.null,alert_claimed_at.lt.${stale}`).select("id");
  fail(error, "os_portal_chat_threads");
  // The claim itself: only this press may let it go (releaseAsk).
  return ((data ?? []) as unknown[]).length > 0 ? claim : null;
}

/** Another press is telling our team: told, or not (it failed, or is taking too long — the client presses again). */
export async function awaitTold(id: string, ms = 8_000, every = 250): Promise<ThreadRow | null> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const row = await loadThread(id);
    if (!row || row.last_alert_at) return row?.last_alert_at ? row : null;
    if (!row.alert_claimed_at) return null;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

/** How many times this person asked for a person on this portal since then, and our team was told. */
export async function asksSince(portalId: string, email: string, since: Date): Promise<number> {
  const { data, error } = await osTable("os_portal_chat_threads").select("id").eq("portal_id", portalId).eq("client_email", email).not("last_alert_at", "is", null).gte("created_at", since.toISOString()).limit(ASKS_PER_HOUR + 1);
  fail(error, "os_portal_chat_threads");
  return ((data ?? []) as unknown[]).length;
}

/**
 * The post didn't go: this press lets go, so pressing again tries again. Nobody was shown it. Its own claim only: one
 * that stalled past CLAIM_STALE_MS and was taken over never lets go of the press that took it.
 */
export async function releaseAsk(id: string, claim: string): Promise<void> {
  const { error } = await osTable("os_portal_chat_threads").update({ alert_claimed_at: null }).eq("id", id).eq("alert_claimed_at", claim).is("last_alert_at", null);
  fail(error, "os_portal_chat_threads");
}

/** Has our team replied since it last heard from Slack about this? Then the client writing back is news, whatever the time. */
export function teamSpokeSince(view: ChatThreadView, alertAt: string): boolean {
  return view.messages.some((m) => m.role === "team" && Date.parse(m.at) > Date.parse(alertAt));
}

/** PostgREST's own codes: before migration 0047 there is simply no conversation to show. Anything else is a real failure. */
const tablesNotThere = (e: { code?: string | null } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/** A client's own: the conversation still open, else a closed one with a reply they haven't seen. Nothing our team wasn't told of. */
export async function clientThread(portalId: string, email: string): Promise<ChatThreadView | null> {
  const { data, error } = await osTable("os_portal_chat_threads").select(THREAD_COLUMNS).eq("portal_id", portalId).eq("client_email", email).not("last_alert_at", "is", null).order("created_at", { ascending: false }).limit(5);
  if (tablesNotThere(error)) return null;
  fail(error, "os_portal_chat_threads");
  const rows = (data ?? []) as ThreadRow[];
  const open = rows.find((r) => r.status === "open");
  if (open) return threadView(open);
  for (const r of rows) {
    const view = await threadView(r);
    if (view.unread) return view;
  }
  return null;
}

/** Our team's, on one portal: every conversation still open, oldest first; and the one a Slack link names, even closed. */
export async function teamThreads(portalId: string, named: string | null): Promise<ChatThreadView[]> {
  const { data, error } = await osTable("os_portal_chat_threads").select(THREAD_COLUMNS).eq("portal_id", portalId).eq("status", "open").not("last_alert_at", "is", null).order("created_at", { ascending: true }).limit(50);
  if (tablesNotThere(error)) return [];
  fail(error, "os_portal_chat_threads");
  const rows = (data ?? []) as ThreadRow[];
  if (named && !rows.some((r) => r.id === named)) {
    const row = await loadThread(named);
    if (row && row.portal_id === portalId && row.last_alert_at) rows.push(row);
  }
  return Promise.all(rows.map(threadView));
}

/** Ended, by our team or by the client going back to the assistant. Only an open one: "closed" happens once. */
export async function closeThread(id: string, by: string, now: Date): Promise<void> {
  const { error } = await osTable("os_portal_chat_threads").update({ status: "closed", closed_by: by, closed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", id).eq("status", "open");
  fail(error, "os_portal_chat_threads");
}

export async function markRead(id: string, now: Date): Promise<void> {
  const { error } = await osTable("os_portal_chat_threads").update({ client_read_at: now.toISOString() }).eq("id", id);
  fail(error, "os_portal_chat_threads");
}
