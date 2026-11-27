import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { clientDirectory } from "@/lib/tools/tickets/directory";
import { MAX_REPLY_CHARS } from "@/lib/tools/tickets/reply";
import { replyContext, sendTicketReply } from "@/lib/tools/tickets/reply-service";
import { addNote, changeTicket, findTicket, teamPeople, TicketActionError } from "@/lib/tools/tickets/service";
import type { TicketRow } from "@/lib/tools/tickets/store";
import type { TicketStatus } from "@/lib/tools/tickets/ticket-rules";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";

/*
 * Tickets through Claude (28 Nov; the user's third group: "assign, status, snooze, note, reply as Amy/Eddy"). Exactly
 * what OS › Tickets does on a click — the same functions (tickets/service.ts changeTicket + addNote, reply-service.ts
 * sendTicketReply) — for the people who hold the Tickets switch, admins always. Every change is written in the person's
 * own name on the ticket's activity, as on the screen; os_mcp_actions records that it came through Claude.
 */

const needsOf = (path: string, method: string): ToolId[] => (grantsForRequest(path, method) ?? []) as ToolId[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "#42", "42" or the ticket's id → what findTicket takes. */
export function ticketRef(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/^#/, "");
  if (/^\d{1,12}$/.test(s)) return String(Number(s));
  return UUID.test(s) ? s.toLowerCase() : null;
}

const TICKET_ARG = { type: "string", description: "The ticket's number as the tickets tool shows it, e.g. #42." };

interface Found { t: TicketRow; client: string | null; line: string }

async function found(ref: string): Promise<Found | null> {
  const t = await findTicket(ref);
  if (!t) return null;
  let client: string | null = null;
  if (t.os_client_id) {
    const dir = await clientDirectory().catch(() => null);
    client = dir?.clients.find((c) => c.id === t.os_client_id)?.name ?? "a client no longer on the list";
  }
  const from = t.contact_name ? `${t.contact_name} <${t.contact_email ?? "?"}>` : t.contact_email ?? "an unknown sender";
  return { t, client, line: `#${t.number} "${t.subject || "no subject"}" from ${from} (${client ?? "Others, not a client"})` };
}

const STATUS_WORD: Record<TicketStatus, string> = { open: "Open", waiting: "Waiting", done: "Done", ignored: "Not a ticket" };
const eastern = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
const snoozed = (t: TicketRow) => !!t.snoozed_until && Date.parse(t.snoozed_until) > Date.now();
const stateLine = (t: TicketRow) =>
  `${snoozed(t) ? `snoozed until ${eastern(t.snoozed_until!)} Eastern` : STATUS_WORD[t.status]}, ${t.assignee ? `assigned to ${t.assignee}` : "unassigned"}`;

/** A teammate by email, full name or first name — exactly one, or why not. */
export function pickTeammate(team: ReadonlyArray<{ email: string; name: string }>, want: string): { email: string; name: string } | { error: string } {
  const w = want.trim().toLowerCase();
  const list = () => team.map((p) => `${p.name} (${p.email})`).join(", ");
  const byEmail = team.find((p) => p.email === w);
  if (byEmail) return byEmail;
  const byName = team.filter((p) => p.name.trim().toLowerCase() === w);
  const byFirst = byName.length ? byName : team.filter((p) => p.name.trim().toLowerCase().split(/\s+/)[0] === w);
  if (byFirst.length === 1) return byFirst[0];
  if (byFirst.length > 1) return { error: `More than one teammate is called "${want}": ${byFirst.map((p) => `${p.name} (${p.email})`).join(", ")}. Give the email.` };
  return { error: `"${want}" isn't on the team. Teammates: ${list() || "none found"}.` };
}

// ---------------------------------------------------------------------------------------------------------------------
// ticket_update — status, assignee or snooze: one change per call, as the screen's PATCH.
// ---------------------------------------------------------------------------------------------------------------------

type UpdateArgs =
  | { ticket: string; kind: "status"; status: TicketStatus }
  | { ticket: string; kind: "assign"; assignee: string }
  | { ticket: string; kind: "snooze"; until: string | null };
type UpdateBind = { status: TicketStatus; assignee: string | null; snoozedUntil: string | null; to: string | null };

const STATUS_IN: Record<string, TicketStatus> = { open: "open", waiting: "waiting", done: "done", not_a_ticket: "ignored" };

export const ticketUpdate: ActionSpec<UpdateArgs, UpdateBind> = {
  name: "ticket_update",
  title: "Change a ticket's status, assignee or snooze",
  description:
    "Change ONE thing on an OS › Tickets ticket, as the ticket's buttons do: its status (open, waiting = we replied and " +
    "wait on the client, done, not_a_ticket), who it is assigned to (a teammate's name or email, or \"nobody\"), or a " +
    "snooze (until a date-time; it comes back to Open then) or cancel_snooze. Give exactly one of status, assignee, " +
    "snooze_until, cancel_snooze. The ticket number comes from the tickets tool. A new email from the client reopens a " +
    "ticket whatever was set.",
  inputSchema: {
    type: "object",
    properties: {
      ticket: TICKET_ARG,
      status: { type: "string", enum: ["open", "waiting", "done", "not_a_ticket"] },
      assignee: { type: "string", description: "A teammate's name or email, or \"nobody\" to unassign." },
      snooze_until: { type: "string", description: "An ISO date-time with its time zone, e.g. 2026-12-01T09:00:00-05:00." },
      cancel_snooze: { type: "boolean", description: "true to end a snooze now (the ticket goes back to Open)." },
    },
    required: ["ticket"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  needs: needsOf("/api/tools/tickets/1", "PATCH"),
  parse(a) {
    const ticket = ticketRef(a.ticket);
    if (!ticket) return { error: "ticket must be a ticket number, e.g. #42 (from the tickets tool)." };
    const given = (["status", "assignee", "snooze_until", "cancel_snooze"] as const).filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== "" && a[k] !== false);
    if (given.length !== 1) return { error: "Give exactly one change: status, assignee, snooze_until or cancel_snooze." };
    if (given[0] === "status") {
      const status = STATUS_IN[String(a.status).trim().toLowerCase()];
      if (!status) return { error: "status must be open, waiting, done or not_a_ticket." };
      return { ticket, kind: "status", status };
    }
    if (given[0] === "assignee") {
      const assignee = String(a.assignee).trim();
      if (!assignee) return { error: "Assign to whom? A teammate's name or email, or \"nobody\"." };
      return { ticket, kind: "assign", assignee };
    }
    if (given[0] === "cancel_snooze") {
      if (a.cancel_snooze !== true) return { error: "cancel_snooze must be true." };
      return { ticket, kind: "snooze", until: null };
    }
    const raw = String(a.snooze_until).trim();
    const at = Date.parse(raw);
    if (Number.isNaN(at) || !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) return { error: "snooze_until must be a date-time with its time zone, e.g. 2026-12-01T09:00:00-05:00." };
    if (at <= Date.now() + 60_000) return { error: "snooze_until must be in the future." };
    if (at > Date.now() + 366 * 86_400_000) return { error: "Snooze for a year at most." };
    return { ticket, kind: "snooze", until: new Date(at).toISOString() };
  },
  async preview(a) {
    const f = await found(a.ticket);
    if (!f) return { ok: false, refusal: `There is no ticket ${/^\d+$/.test(a.ticket) ? `#${a.ticket}` : a.ticket} (it was removed, or never existed).` };
    const { t } = f;
    const bindBase = { status: t.status, assignee: t.assignee ?? null, snoozedUntil: snoozed(t) ? t.snoozed_until : null };
    const now = `It is ${stateLine(t)} now.`;

    if (a.kind === "status") {
      if (t.status === a.status && !snoozed(t)) return { ok: false, refusal: `${f.line} is already ${STATUS_WORD[a.status]}.` };
      const effect =
        a.status === "done" ? "It moves to Done." :
        a.status === "ignored" ? "It is marked Not a ticket and leaves every list but All." :
        a.status === "waiting" ? "It moves to Waiting (we answered; waiting on the client)." :
        "It goes back to Open (a client is waiting on us).";
      return {
        ok: true,
        preview: `Mark ${f.line} as ${STATUS_WORD[a.status]}. ${now} ${effect}${snoozed(t) ? " The snooze ends." : ""} If the client writes again it reopens.`,
        details: { ticket: `#${t.number}`, from: STATUS_WORD[t.status], to: STATUS_WORD[a.status] },
        bind: { ...bindBase, to: a.status },
      };
    }

    if (a.kind === "assign") {
      const nobody = /^(nobody|no one|none|unassign(ed)?)$/i.test(a.assignee);
      let to: { email: string; name: string } | null = null;
      if (!nobody) {
        const pick = pickTeammate(await teamPeople(), a.assignee);
        if ("error" in pick) return { ok: false, refusal: pick.error };
        to = pick;
      }
      const target = to?.email ?? null;
      if ((t.assignee ?? null) === target) return { ok: false, refusal: `${f.line} is already ${target ? `assigned to ${to!.name}` : "unassigned"}.` };
      return {
        ok: true,
        preview: to
          ? `Assign ${f.line} to ${to.name} (${to.email}). ${now} It shows in ${to.name.split(/\s+/)[0]}'s Mine view. Nobody is emailed.`
          : `Unassign ${f.line}. ${now} It shows under Unassigned.`,
        details: { ticket: `#${t.number}`, assignee: to ? `${to.name} <${to.email}>` : null },
        bind: { ...bindBase, to: target },
      };
    }

    if (a.until === null) {
      if (!snoozed(t)) return { ok: false, refusal: `${f.line} isn't snoozed.` };
      return {
        ok: true,
        preview: `Cancel the snooze on ${f.line}. ${now} It goes back to Open now.`,
        details: { ticket: `#${t.number}` },
        bind: { ...bindBase, to: null },
      };
    }
    return {
      ok: true,
      preview: `Snooze ${f.line} until ${eastern(a.until)} Eastern (${a.until}). ${now} Until then it is Waiting, under Snoozed; it comes back to Open then, or sooner if the client writes.`,
      details: { ticket: `#${t.number}`, until: a.until },
      bind: { ...bindBase, to: a.until },
    };
  },
  async execute(a, v, bind) {
    const change = a.kind === "status" ? { type: "status" as const, to: a.status } : a.kind === "assign" ? { type: "assign" as const, to: bind.to } : { type: "snooze" as const, until: a.until };
    await changeTicket(a.ticket, v.email, change);
    const after = await findTicket(a.ticket);
    console.info(`[mcp-action] ${v.email} via Claude: ticket ${a.ticket} ${a.kind} → ${bind.to ?? "none"}`);
    return { ticket: `#${after?.number ?? a.ticket}`, now: after ? stateLine(after) : null };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// ticket_note — an internal note, with @mentions.
// ---------------------------------------------------------------------------------------------------------------------

type NoteArgs = { ticket: string; note: string; mention: string[] };
type NoteBind = { mentions: string[] };

export const ticketNote: ActionSpec<NoteArgs, NoteBind> = {
  name: "ticket_note",
  title: "Add an internal note to a ticket",
  description:
    "Add an internal note to an OS › Tickets ticket, as the ticket's note box does. Only the team sees notes; the client " +
    "never does. mention: teammates (name or email) to @mention; the ticket then shows in their Mentions view (no email " +
    "or bell is sent). The note is written in your name.",
  inputSchema: {
    type: "object",
    properties: {
      ticket: TICKET_ARG,
      note: { type: "string", description: "The note, as it should read (5,000 characters at most)." },
      mention: { type: "array", items: { type: "string" }, description: "Teammates to @mention, by name or email." },
    },
    required: ["ticket", "note"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  needs: needsOf("/api/tools/tickets/1/notes", "POST"),
  parse(a) {
    const ticket = ticketRef(a.ticket);
    if (!ticket) return { error: "ticket must be a ticket number, e.g. #42 (from the tickets tool)." };
    const note = String(a.note ?? "").replace(/\r\n?/g, "\n").trim();
    if (!note) return { error: "Write the note first." };
    if (note.length > 5000) return { error: "Notes are 5,000 characters at most." };
    if (a.mention !== undefined && !Array.isArray(a.mention)) return { error: "mention must be a list of teammates." };
    const mention = [...new Set(((a.mention as unknown[] | undefined) ?? []).map((m) => String(m ?? "").trim()).filter(Boolean))].slice(0, 20);
    return { ticket, note, mention };
  },
  async preview(a, v) {
    const f = await found(a.ticket);
    if (!f) return { ok: false, refusal: `There is no ticket ${/^\d+$/.test(a.ticket) ? `#${a.ticket}` : a.ticket} (it was removed, or never existed).` };
    const team = await teamPeople();
    const picked: Array<{ email: string; name: string }> = [];
    for (const m of a.mention) {
      const p = pickTeammate(team, m);
      if ("error" in p) return { ok: false, refusal: p.error };
      if (p.email !== v.email.toLowerCase() && !picked.some((x) => x.email === p.email)) picked.push(p);
    }
    const names = picked.map((p) => p.name.split(/\s+/)[0]);
    return {
      ok: true,
      preview:
        `Add this internal note to ${f.line}, in your name:\n"${a.note}"\n` +
        `${picked.length ? `It @mentions ${names.join(" and ")}, so it shows in ${picked.length === 1 ? "their" : "each one's"} Mentions view (no email or bell). ` : ""}` +
        "Only the team sees notes; the client never does.",
      details: { ticket: `#${f.t.number}`, mentions: picked.map((p) => p.email) },
      bind: { mentions: picked.map((p) => p.email).sort() },
    };
  },
  async execute(a, v, bind) {
    await addNote(a.ticket, v.email, a.note, bind.mentions);
    console.info(`[mcp-action] ${v.email} via Claude: note on ticket ${a.ticket}${bind.mentions.length ? ` (@${bind.mentions.join(", @")})` : ""}`);
    return { ticket: a.ticket, noted: true, mentioned: bind.mentions };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// ticket_reply — a real email to the client, from the inbox they wrote to (Amy's or Eddy's), as the reply box does.
// ---------------------------------------------------------------------------------------------------------------------

type ReplyArgs = { ticket: string; text: string; from: string | null; cc: string[] | null };
type ReplyBind = { replyTo: string | null; lastOut: string | null; from: string; to: string; cc: string[]; subject: string };

export const ticketReply: ActionSpec<ReplyArgs, ReplyBind> = {
  name: "ticket_reply",
  title: "Reply to a ticket's email",
  description:
    "Send a reply to the client's latest email on an OS › Tickets ticket, as the ticket's reply box does: it goes from the " +
    "Gmail inbox the client wrote to (only Amy's or Eddy's inbox can send), in the same Gmail thread with that inbox's " +
    "signature and the client's email quoted below, to the client, copying the other people on their email unless cc " +
    "says otherwise. Read the ticket first (ticket_thread). This sends a REAL email that can't be unsent: show the full " +
    "text in the preview and wait for a clear yes.",
  inputSchema: {
    type: "object",
    properties: {
      ticket: TICKET_ARG,
      text: { type: "string", description: `The reply, as plain text (${MAX_REPLY_CHARS.toLocaleString("en-US")} characters at most). The signature and quote are added.` },
      from: { type: "string", description: "Which inbox sends it, when the client wrote to both: amy@brokerstaffer.com or eddy@brokerstaffer.com. Leave out for the one the screen picks." },
      cc: { type: "array", items: { type: "string" }, description: "Whom to copy, from the people on the client's email. Leave out to copy all of them (as the screen does); [] for nobody." },
    },
    required: ["ticket", "text"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  needs: needsOf("/api/tools/tickets/1/reply", "POST"),
  parse(a) {
    const ticket = ticketRef(a.ticket);
    if (!ticket) return { error: "ticket must be a ticket number, e.g. #42 (from the tickets tool)." };
    const text = String(a.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) return { error: "Write the reply first." };
    if (text.length > MAX_REPLY_CHARS) return { error: `Replies are ${MAX_REPLY_CHARS.toLocaleString("en-US")} characters at most.` };
    const from = typeof a.from === "string" && a.from.trim() ? a.from.trim().toLowerCase() : null;
    if (a.cc !== undefined && a.cc !== null && !Array.isArray(a.cc)) return { error: "cc must be a list of email addresses." };
    const cc = Array.isArray(a.cc) ? [...new Set(a.cc.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))].sort() : null;
    return { ticket, text, from, cc };
  },
  async preview(a) {
    const f = await found(a.ticket);
    if (!f) return { ok: false, refusal: `There is no ticket ${/^\d+$/.test(a.ticket) ? `#${a.ticket}` : a.ticket} (it was removed, or never existed).` };
    let ctx: Awaited<ReturnType<typeof replyContext>>;
    try {
      ctx = await replyContext(f.t.id);
    } catch (e) {
      if (e instanceof TicketActionError) return { ok: false, refusal: e.message };
      throw e;
    }
    if (ctx.blocked || !ctx.to) return { ok: false, refusal: `${ctx.blocked ?? "There's nobody to reply to on this ticket."} Nothing was sent.` };
    const fromEmail = a.from ?? ctx.defaultSender;
    const sender = ctx.senders.find((s) => s.email === fromEmail);
    if (!sender) {
      return { ok: false, refusal: `Replies to ${f.line} can go only from ${ctx.senders.map((s) => s.email).join(" or ") || "no inbox"}.` };
    }
    if (!sender.ready) return { ok: false, refusal: `${sender.why ?? "That inbox can't send right now."} Nothing was sent.` };
    const offered = new Map(ctx.cc.map((c) => [c.email, c]));
    const keep = a.cc ?? [...offered.keys()].sort();
    const stray = keep.filter((e) => !offered.has(e));
    if (stray.length) {
      return { ok: false, refusal: `Only people already on the client's email can be copied in (${[...offered.keys()].join(", ") || "nobody else is on it"}); not ${stray.join(", ")}.` };
    }
    const cc = keep.filter((e) => e !== sender.email && e !== ctx.to!.email);
    const team = await teamPeople().catch(() => []);
    const gone = !team.some((p) => p.email === sender.email);
    const who = (x: { email: string; name: string | null }) => (x.name ? `${x.name} <${x.email}>` : x.email);
    return {
      ok: true,
      preview:
        `Send this reply on ${f.line}\n` +
        `From: ${sender.name} <${sender.email}> (their Gmail${sender.signature ? ", with their signature" : ""})\n` +
        `To: ${who(ctx.to)}\n` +
        `Cc: ${cc.length ? cc.map((e) => who(offered.get(e)!)).join(", ") : "nobody"}\n` +
        `Subject: ${ctx.subject}\n` +
        `---\n${a.text}\n---\n` +
        "It goes in the same Gmail thread with the client's email quoted below, and the ticket moves to Waiting. " +
        `${gone ? `${sender.name.split(/\s+/)[0]} is no longer an active teammate in the OS; the email still goes from their inbox. ` : ""}` +
        "This sends a real email that can't be unsent.",
      details: { ticket: `#${f.t.number}`, from: sender.email, to: ctx.to.email, cc, subject: ctx.subject },
      // A newer client email, a reply sent meanwhile (from Gmail or Tickets) or a changed recipient list: refused, new preview.
      bind: { replyTo: ctx.replyTo, lastOut: f.t.last_outbound_at ?? null, from: sender.email, to: ctx.to.email, cc, subject: ctx.subject },
    };
  },
  async execute(a, v, bind) {
    const r = await sendTicketReply(a.ticket, v.email, { from: bind.from, text: a.text, cc: bind.cc, nonce: crypto.randomUUID(), replyTo: bind.replyTo });
    if (r.ok) {
      console.info(`[mcp-action] ${v.email} via Claude: ticket ${a.ticket} reply sent as ${r.sentAs} to ${r.to}`);
      return { ticket: a.ticket, sent: true, from: r.sentAs, to: r.to, ...(r.note ? { note: r.note } : {}) };
    }
    if (r.sent === false) throw new Error(`Nothing was sent: ${r.error}`);
    throw new Error(r.error);
  },
};
