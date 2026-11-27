import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { clientDirectory } from "@/lib/tools/tickets/directory";
import { htmlToText } from "@/lib/tools/tickets/gmail-message";
import { replyContext } from "@/lib/tools/tickets/reply-service";
import { ticketDetail } from "@/lib/tools/tickets/service";

/*
 * The assistant's view of Tickets (20 Nov): client emails that reached the team's connected Gmail. Read-only.
 * Answers "any client emails waiting?", "what has Homebase emailed us about?", "what's assigned to Amy?",
 * "how many tickets are open?". Only ever client emails: the team's replies are stored as a time, never text.
 */

const STATUSES = new Set(["open", "waiting", "done", "ignored"]);

export async function ticketsTool(args: { client?: string; status?: string; assignee?: string; search?: string }) {
  const counts: Record<string, number> = {};
  const head = await Promise.all(["open", "waiting", "done"].map((s) => osTable("os_tickets").select("id", { count: "exact", head: true }).eq("status", s)));
  if (head.some((h) => h.error)) {
    return { ready: false, note: "Tickets isn't set up yet (migration 0053 has not run), so there are no tickets to read." };
  }
  ["open", "waiting", "done"].forEach((s, i) => { counts[s] = head[i].count ?? 0; });
  const { data: boxes } = await osTable("os_ticket_mailboxes").select("email, state, last_ok_at");

  const dir = await clientDirectory().catch(() => null);
  const names = new Map((dir?.clients ?? []).map((c) => [c.id, c.name]));
  let q = osTable("os_tickets").select("id, number, subject, status, assignee, snoozed_until, os_client_id, contact_email, contact_name, waiting_since, last_activity_at, last_inbound_at, last_outbound_at, message_count, snippet")
    .order("last_activity_at", { ascending: false }).limit(25);
  let clientNote: string | null = null;
  if (args.client) {
    const want = args.client.trim().toLowerCase();
    const hits = (dir?.clients ?? []).filter((c) => !c.internal && c.name.toLowerCase().includes(want));
    if (!hits.length) return { ready: true, counts, tickets: [], note: `No client is named like "${args.client}". Use find_client to check the name.` };
    q = q.in("os_client_id", hits.map((c) => c.id));
    clientNote = hits.map((c) => c.name).join(", ");
  }
  if (args.status && STATUSES.has(args.status)) q = q.eq("status", args.status);
  else q = q.neq("status", "ignored");
  if (args.assignee) q = q.ilike("assignee", `%${args.assignee.replace(/[%,()]/g, "")}%`);
  if (args.search) {
    const t = args.search.replace(/["\\,()*%:]/g, " ").trim().slice(0, 80);
    if (t) q = q.or(`subject.ilike."*${t}*",snippet.ilike."*${t}*",contact_email.ilike."*${t}*"`);
  }
  const { data, error } = await q;
  if (error) return { ready: true, counts, error: error.message };
  const now = Date.now();
  return {
    ready: true,
    product: "Tickets (OS › Tickets): emails FROM client addresses that reached the team's connected Gmail",
    counts,
    connectedInboxes: ((boxes ?? []) as Array<{ email: string; state: string; last_ok_at: string | null }>).filter((b) => b.state !== "paused").map((b) => ({ inbox: b.email, state: b.state, lastChecked: b.last_ok_at })),
    client: clientNote,
    tickets: ((data ?? []) as Array<Record<string, unknown>>).map((t) => ({
      ticket: `#${t.number}`,
      subject: t.subject,
      client: t.os_client_id ? names.get(String(t.os_client_id)) ?? "Unknown client" : "Others (not from a client)",
      from: t.contact_name ? `${t.contact_name} <${t.contact_email}>` : t.contact_email,
      status: t.snoozed_until && Date.parse(String(t.snoozed_until)) > now ? `snoozed until ${t.snoozed_until}` : t.status,
      assignee: t.assignee ?? "unassigned",
      clientWaitingSince: t.status === "open" ? t.waiting_since : null,
      lastClientEmail: t.last_inbound_at,
      teamLastReplied: t.last_outbound_at,
      emails: t.message_count,
      latestClientWords: t.snippet,
      link: `/tickets?t=${t.number}`,
    })),
    note: "Open = a client is waiting on us; Waiting = we replied; Done = finished. Client tickets hold only the client's own words; Others holds every other email to a connected inbox. A reply sent from Gmail is recorded as a time; one sent from Tickets is kept. ticket_thread reads one ticket in full.",
  };
}

/*
 * One ticket in full (28 Nov), for reading a client's email before acting on it through Claude: its emails (newest
 * last), the team's notes and activity, and who a reply from Tickets would go from and to — what the ticket pane shows.
 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${(s.length - n).toLocaleString("en-US")} more characters)` : s);

export async function ticketThreadTool(args: { ticket: string }) {
  const ref = String(args.ticket ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,12}$/.test(ref)) return { error: "Give the ticket's number, e.g. #42 (from the tickets tool)." };
  const d = await ticketDetail(ref, "", false);
  if (!d) return { error: `There is no ticket #${ref} (it was removed, or never existed).` };
  const t = d.ticket;
  const msgs = d.messages.slice(-12);
  let reply: Record<string, unknown>;
  try {
    const c = await replyContext(ref);
    reply = c.blocked
      ? { possible: false, why: c.blocked }
      : { possible: true, from: c.defaultSender, inboxes: c.senders.map((s) => ({ inbox: s.email, ready: s.ready, why: s.why })), to: c.to, cc: c.cc, subject: c.subject };
  } catch (e) {
    reply = { possible: false, why: e instanceof Error ? e.message : String(e) };
  }
  return {
    ticket: `#${t.number}`,
    subject: t.subject,
    client: t.client?.name ?? "Others (not from a client)",
    status: t.status === "ignored" ? "not a ticket" : t.status,
    snoozedUntil: t.snoozedUntil ?? null,
    assignee: t.assignee ?? "unassigned",
    clientWaitingSince: t.waitingSince ?? null,
    link: `/tickets?t=${t.number}`,
    emails: {
      shown: msgs.length,
      total: d.messages.length,
      list: msgs.map((m) => ({
        who: m.direction === "in" ? "them" : "team",
        from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
        to: m.to.map((a) => a.email),
        cc: m.cc.map((a) => a.email),
        sentAt: m.sentAt,
        text: clip((m.text ?? (m.html ? htmlToText(m.html) : "")).trim(), 4000) || (m.direction === "out" ? "(A reply sent from Gmail: Tickets keeps only when it was sent, not its words.)" : "(No text: see the attachments, or open it in Gmail.)"),
        quotedHistoryCut: m.trimmed,
        attachments: m.attachments.filter((x) => !x.inline).map((x) => x.filename).filter(Boolean),
        ...(m.sentBy ? { sentFromTicketsBy: m.sentBy } : {}),
      })),
    },
    notesAndActivity: d.events.slice(-25).map((e) => ({ kind: e.kind, by: e.actor ?? "Tickets", at: e.at, ...(e.body ? { text: clip(e.body, 1500) } : {}), ...(e.from || e.to ? { from: e.from, to: e.to } : {}), ...(e.mentions.length ? { mentions: e.mentions } : {}) })),
    replyFromTickets: reply,
    note: "Only client emails' own words are kept (quoted history is cut). Notes are internal. To act: ticket_update, ticket_note, ticket_reply where listed.",
  };
}
