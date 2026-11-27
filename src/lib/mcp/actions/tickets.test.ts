/*
 * ticket_update, ticket_note and ticket_reply (28 Nov) through runAction, against stand-ins for the Tickets service
 * (recorded, not run): the preview changes nothing and says what will happen; confirm does exactly that, once; a ticket
 * that changed after the preview is not acted on; the Tickets switch decides who may.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Row = Record<string, unknown>;
const calls: string[] = [];
const world = {
  ticket: null as null | Row,
  team: [] as Array<{ email: string; name: string }>,
  ctx: null as null | Row,
  ctxThrows: null as null | Error,
  send: { ok: true, sentAs: "amy@brokerstaffer.com", to: "jane@homebase.com", messageId: "g1" } as Row,
};

let core: typeof import("./core.ts");
let tk: typeof import("./tickets.ts");
const EDDY = { email: "eddy@brokerstaffer.com", admin: false, grants: ["tickets"] as string[] };

async function load() {
  if (tk) return;
  class TicketActionError extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/workspace/tool-paths", { namedExports: { grantsForRequest: (p: string) => (p.startsWith("/api/tools/tickets") ? ["tickets"] : null) } });
  mock.module("@/lib/tools/tickets/directory", { namedExports: { clientDirectory: async () => ({ clients: [{ id: "os-home", name: "Homebase", status: "active", internal: false, emails: [] }] }) } });
  mock.module("@/lib/tools/tickets/reply", { namedExports: { MAX_REPLY_CHARS: 10_000 } });
  mock.module("@/lib/tools/tickets/reply-service", {
    namedExports: {
      replyContext: async (id: string) => { if (world.ctxThrows) throw world.ctxThrows; calls.push(`(read reply box ${id})`); return world.ctx; },
      sendTicketReply: async (id: string, actor: string, input: Row) => {
        calls.push(`send ${id} by ${actor} ${JSON.stringify({ ...input, nonce: typeof input.nonce === "string" && input.nonce.length >= 8 ? "<nonce>" : input.nonce })}`);
        if (world.send.ok && world.ticket) world.ticket.last_outbound_at = "2026-11-28T10:00:00.000Z";
        return world.send;
      },
    },
  });
  mock.module("@/lib/tools/tickets/service", {
    namedExports: {
      TicketActionError,
      findTicket: async (ref: string) => (world.ticket && (String(world.ticket.number) === ref || world.ticket.id === ref) ? { ...world.ticket } : null),
      teamPeople: async () => world.team,
      changeTicket: async (ref: string, actor: string, change: Row) => {
        calls.push(`change ${ref} by ${actor} ${JSON.stringify(change)}`);
        const t = world.ticket!;
        if (change.type === "status") Object.assign(t, { status: change.to, snoozed_until: null });
        if (change.type === "assign") t.assignee = change.to;
        if (change.type === "snooze") Object.assign(t, change.until ? { snoozed_until: change.until, status: "waiting" } : { snoozed_until: null, status: "open" });
      },
      addNote: async (ref: string, actor: string, body: string, mentions: string[]) => { calls.push(`note ${ref} by ${actor} ${JSON.stringify(body)} @${mentions.join(",")}`); },
    },
  });
  core = await import("./core.ts");
  tk = await import("./tickets.ts");
}

function deps() {
  const claimed = new Set<string>(); let i = 0;
  return {
    sign: async (c: Row) => Buffer.from(JSON.stringify(c)).toString("base64url"),
    verify: async (t: string) => JSON.parse(Buffer.from(t, "base64url").toString()) as Row,
    audit: { used: async (n: string) => claimed.has(n), claim: async (r: { nonce: string }) => (claimed.has(r.nonce) ? false : (claimed.add(r.nonce), true)), finish: async () => {} },
    nonce: () => `n${++i}`,
  };
}
const run = (spec: unknown, args: Row, d = deps(), v: typeof EDDY = EDDY) => core.runAction(spec as never, args, v, d as never) as Promise<Row>;
const inADay = () => new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");

function reset() {
  calls.length = 0;
  world.ctxThrows = null;
  world.team = [
    { email: "admin@outreachify.io", name: "Admin" },
    { email: "eddy@brokerstaffer.com", name: "Eddy Smith" },
    { email: "gabriel@gmail.com", name: "Gabriel Castillo" },
  ];
  world.ticket = {
    id: "11111111-2222-3333-4444-555555555555", number: 42, subject: "Billing question", status: "open", assignee: null, snoozed_until: null,
    os_client_id: "os-home", contact_email: "jane@homebase.com", contact_name: "Jane Doe", last_outbound_at: null,
  };
  world.ctx = {
    blocked: null,
    senders: [{ email: "amy@brokerstaffer.com", name: "Amy Lee", ready: true, why: null, signature: "Amy Lee | BrokerStaffer" }],
    defaultSender: "amy@brokerstaffer.com",
    replyTo: "msg-in-3",
    to: { email: "jane@homebase.com", name: "Jane Doe" },
    cc: [{ email: "bob@homebase.com", name: "Bob" }, { email: "eddy@brokerstaffer.com", name: "Eddy Smith" }],
    subject: "Re: Billing question",
  };
  world.send = { ok: true, sentAs: "amy@brokerstaffer.com", to: "jane@homebase.com", messageId: "g1" };
}

/* ------------------------------------------------------------------------------------------- ticket_update --- */

test("status: the preview says what changes and changes nothing; confirm changes it once, in the person's name", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(tk.ticketUpdate, { ticket: "#42", status: "done" }, d);
  assert.equal(p.preview, `Mark #42 "Billing question" from Jane Doe <jane@homebase.com> (Homebase) as Done. It is Open, unassigned now. It moves to Done. If the client writes again it reopens.`);
  assert.deepEqual(calls, []);
  const done = await run(tk.ticketUpdate, { ticket: "#42", status: "done", confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`change 42 by eddy@brokerstaffer.com {"type":"status","to":"done"}`]);
  assert.deepEqual(done.result, { ticket: "#42", now: "Done, unassigned" });
  const again = await run(tk.ticketUpdate, { ticket: "#42", status: "done", confirm: p.confirm }, d);
  assert.match(String(again.refused), /already used/);
  assert.equal(calls.length, 1, "never twice");
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", status: "done" })).refused), /is already Done/);
});

test("status: not_a_ticket is the screen's Not a ticket; a snoozed ticket's snooze ends; exactly one change per call", { skip }, async () => {
  await load(); reset();
  const p = await run(tk.ticketUpdate, { ticket: "42", status: "not_a_ticket" });
  assert.match(String(p.preview), /as Not a ticket\. .*leaves every list but All/);
  world.ticket!.status = "waiting"; world.ticket!.snoozed_until = inADay();
  const w = await run(tk.ticketUpdate, { ticket: "42", status: "waiting" });
  assert.match(String(w.preview), /It is snoozed until .* Eastern, unassigned now\. .* The snooze ends\./);
  for (const bad of [{ ticket: "42" }, { ticket: "42", status: "done", assignee: "Eddy" }, { ticket: "42", status: "closed" }, { ticket: "abc", status: "done" }]) {
    assert.ok((await run(tk.ticketUpdate, bad)).refused, JSON.stringify(bad));
  }
  assert.match(String((await run(tk.ticketUpdate, { ticket: "#99", status: "done" })).refused), /There is no ticket #99/);
  assert.deepEqual(calls, []);
});

test("assign: by first name, full name or email; nobody unassigns; an unknown or ambiguous name is refused with the team listed", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(tk.ticketUpdate, { ticket: "42", assignee: "gabriel" }, d);
  assert.equal(p.preview, `Assign #42 "Billing question" from Jane Doe <jane@homebase.com> (Homebase) to Gabriel Castillo (gabriel@gmail.com). It is Open, unassigned now. It shows in Gabriel's Mine view. Nobody is emailed.`);
  await run(tk.ticketUpdate, { ticket: "42", assignee: "gabriel", confirm: p.confirm }, d);
  assert.deepEqual(calls, [`change 42 by eddy@brokerstaffer.com {"type":"assign","to":"gabriel@gmail.com"}`]);
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", assignee: "Gabriel Castillo" })).refused), /already assigned to Gabriel Castillo/);
  const un = await run(tk.ticketUpdate, { ticket: "42", assignee: "nobody" });
  assert.match(String(un.preview), /^Unassign #42 .* It is Open, assigned to gabriel@gmail\.com now\. It shows under Unassigned\.$/);
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", assignee: "Amy" })).refused), /"Amy" isn't on the team\. Teammates: Admin \(admin@outreachify\.io\), Eddy Smith/);
  world.team.push({ email: "eddy2@x.com", name: "Eddy Brown" });
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", assignee: "eddy" })).refused), /More than one teammate is called "eddy"/);
});

test("snooze: a time zone and the future are required; cancel only a snoozed ticket; a ticket changed after the preview is not touched", { skip }, async () => {
  await load(); reset();
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", snooze_until: "2026-12-01T09:00:00" })).refused), /time zone/);
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", snooze_until: "2020-01-01T09:00:00Z" })).refused), /future/);
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", snooze_until: "2099-01-01T09:00:00Z" })).refused), /a year at most/);
  assert.match(String((await run(tk.ticketUpdate, { ticket: "42", cancel_snooze: true })).refused), /isn't snoozed/);
  const until = inADay();
  const d = deps();
  const p = await run(tk.ticketUpdate, { ticket: "42", snooze_until: until }, d);
  assert.match(String(p.preview), /^Snooze #42 .* until .* Eastern \(.*\)\. It is Open, unassigned now\. Until then it is Waiting, under Snoozed; it comes back to Open then, or sooner if the client writes\.$/);
  world.ticket!.assignee = "admin@outreachify.io"; // someone assigned it on the screen meanwhile
  const late = await run(tk.ticketUpdate, { ticket: "42", snooze_until: until, confirm: p.confirm }, d);
  assert.match(String(late.refused), /Things changed since the preview/);
  assert.deepEqual(calls, [], "nothing done");
  const ok = await run(tk.ticketUpdate, { ticket: "42", snooze_until: until, confirm: late.confirm }, d);
  assert.equal(ok.done, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /"type":"snooze","until":"/);
  const c = await run(tk.ticketUpdate, { ticket: "42", cancel_snooze: true });
  assert.match(String(c.preview), /^Cancel the snooze on #42 .* It goes back to Open now\.$/);
});

test("the Tickets switch decides who may: without it refused, nothing read; admins always", { skip }, async () => {
  await load(); reset();
  const r = await run(tk.ticketUpdate, { ticket: "42", status: "done" }, deps(), { email: "x@brokerstaffer.com", admin: false, grants: ["inbox"] });
  assert.match(String(r.refused), /isn't switched on for you/);
  assert.ok((await run(tk.ticketNote, { ticket: "42", note: "hi" }, deps(), { email: "a@outreachify.io", admin: true, grants: [] })).preview);
  assert.deepEqual(tk.ticketUpdate.needs, ["tickets"]);
  assert.deepEqual(tk.ticketReply.needs, ["tickets"]);
});

/* --------------------------------------------------------------------------------------------- ticket_note --- */

test("note: mentions by name become emails (you are never mentioned); the preview quotes the note; confirm adds it once", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const args = { ticket: "#42", note: "Jane wants the invoice resent.\nI'll do it Monday.", mention: ["Gabriel", "eddy@brokerstaffer.com"] };
  const p = await run(tk.ticketNote, args, d);
  assert.equal(p.preview, `Add this internal note to #42 "Billing question" from Jane Doe <jane@homebase.com> (Homebase), in your name:\n"Jane wants the invoice resent.\nI'll do it Monday."\nIt @mentions Gabriel, so it shows in their Mentions view (no email or bell). Only the team sees notes; the client never does.`);
  assert.deepEqual(calls, []);
  await run(tk.ticketNote, { ...args, confirm: p.confirm }, d);
  assert.deepEqual(calls, [`note 42 by eddy@brokerstaffer.com "Jane wants the invoice resent.\\nI'll do it Monday." @gabriel@gmail.com`]);
  assert.match(String((await run(tk.ticketNote, { ...args, confirm: p.confirm }, d)).refused), /already used/);
  assert.match(String((await run(tk.ticketNote, { ticket: "42", note: "x", mention: ["Amy"] })).refused), /"Amy" isn't on the team/);
  assert.match(String((await run(tk.ticketNote, { ticket: "42", note: "   " })).refused), /Write the note first/);
  assert.match(String((await run(tk.ticketNote, { ticket: "42", note: "x".repeat(5001) })).refused), /5,000 characters/);
  assert.equal(calls.length, 1);
});

/* -------------------------------------------------------------------------------------------- ticket_reply --- */

test("reply: the preview shows from, to, cc, subject and the whole text, and sends nothing; confirm sends it once from that inbox", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const args = { ticket: "42", text: "Hi Jane,\n\nResent just now.\n\nThanks" };
  const p = await run(tk.ticketReply, args, d);
  assert.equal(p.preview, [
    `Send this reply on #42 "Billing question" from Jane Doe <jane@homebase.com> (Homebase)`,
    "From: Amy Lee <amy@brokerstaffer.com> (their Gmail, with their signature)",
    "To: Jane Doe <jane@homebase.com>",
    "Cc: Bob <bob@homebase.com>, Eddy Smith <eddy@brokerstaffer.com>",
    "Subject: Re: Billing question",
    "---", "Hi Jane,", "", "Resent just now.", "", "Thanks", "---",
    "It goes in the same Gmail thread with the client's email quoted below, and the ticket moves to Waiting. Amy is no longer an active teammate in the OS; the email still goes from their inbox. This sends a real email that can't be unsent.",
  ].join("\n"));
  assert.ok(calls.every((c) => c.startsWith("(read")), "the preview sent nothing");
  calls.length = 0;
  const done = await run(tk.ticketReply, { ...args, confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls.filter((c) => !c.startsWith("(read")), [`send 42 by eddy@brokerstaffer.com {"from":"amy@brokerstaffer.com","text":"Hi Jane,\\n\\nResent just now.\\n\\nThanks","cc":["bob@homebase.com","eddy@brokerstaffer.com"],"nonce":"<nonce>","replyTo":"msg-in-3"}`]);
  assert.deepEqual(done.result, { ticket: "42", sent: true, from: "amy@brokerstaffer.com", to: "jane@homebase.com" });
  const again = await run(tk.ticketReply, { ...args, confirm: p.confirm }, d);
  assert.match(String(again.refused), /already used/);
  assert.equal(calls.filter((c) => c.startsWith("send")).length, 1, "never twice");
});

test("reply: cc [] copies nobody; only people on the client's email can be copied; an active teammate's inbox has no note", { skip }, async () => {
  await load(); reset();
  world.team.push({ email: "amy@brokerstaffer.com", name: "Amy Lee" });
  const p = await run(tk.ticketReply, { ticket: "42", text: "Done.", cc: [] });
  assert.match(String(p.preview), /\nCc: nobody\n/);
  assert.doesNotMatch(String(p.preview), /no longer an active teammate/);
  const one = await run(tk.ticketReply, { ticket: "42", text: "Done.", cc: ["BOB@homebase.com"] });
  assert.match(String(one.preview), /\nCc: Bob <bob@homebase\.com>\n/);
  const stray = await run(tk.ticketReply, { ticket: "42", text: "Done.", cc: ["boss@elsewhere.com"] });
  assert.match(String(stray.refused), /Only people already on the client's email can be copied in \(bob@homebase\.com, eddy@brokerstaffer\.com\); not boss@elsewhere\.com/);
  assert.equal(calls.filter((c) => c.startsWith("send")).length, 0);
});

test("reply: refused when the screen would refuse — blocked, an inbox that can't send, an inbox not on the email, too long", { skip }, async () => {
  await load(); reset();
  world.ctx!.blocked = "This email came to Gabriel. Replies from Tickets go only from Amy's or Eddy's inbox, so Gabriel answers in Gmail.";
  assert.match(String((await run(tk.ticketReply, { ticket: "42", text: "x" })).refused), /answers in Gmail\. Nothing was sent\./);
  reset();
  (world.ctx!.senders as Row[])[0].ready = false;
  (world.ctx!.senders as Row[])[0].why = "Amy reconnects their inbox once, on Connected inboxes, to allow replies from Tickets.";
  assert.match(String((await run(tk.ticketReply, { ticket: "42", text: "x" })).refused), /to allow replies from Tickets\. Nothing was sent\./);
  reset();
  assert.match(String((await run(tk.ticketReply, { ticket: "42", text: "x", from: "eddy@brokerstaffer.com" })).refused), /can go only from amy@brokerstaffer\.com/);
  assert.match(String((await run(tk.ticketReply, { ticket: "42", text: "x".repeat(10_001) })).refused), /10,000 characters/);
  assert.match(String((await run(tk.ticketReply, { ticket: "42", text: "  " })).refused), /Write the reply first/);
  assert.equal(calls.filter((c) => c.startsWith("send")).length, 0);
});

test("reply: a newer client email, or a reply sent meanwhile, after the preview — nothing sent, a new preview", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(tk.ticketReply, { ticket: "42", text: "Resent." }, d);
  world.ctx!.replyTo = "msg-in-4";
  const r1 = await run(tk.ticketReply, { ticket: "42", text: "Resent.", confirm: p.confirm }, d);
  assert.match(String(r1.refused), /Things changed since the preview/);
  world.ticket!.last_outbound_at = "2026-11-28T09:00:00.000Z"; // Amy answered in Gmail meanwhile
  const r2 = await run(tk.ticketReply, { ticket: "42", text: "Resent.", confirm: r1.confirm }, d);
  assert.match(String(r2.refused), /Things changed since the preview/);
  assert.equal(calls.filter((c) => c.startsWith("send")).length, 0);
});

test("reply: Gmail refusing says nothing was sent; an unconfirmed send says to look in the Sent folder", { skip }, async () => {
  await load(); reset();
  world.send = { ok: false, sent: false, status: 409, error: "Google refused the access." };
  const d = deps();
  const p = await run(tk.ticketReply, { ticket: "42", text: "Resent." }, d);
  const f = await run(tk.ticketReply, { ticket: "42", text: "Resent.", confirm: p.confirm }, d);
  assert.equal(f.done, false);
  assert.equal(f.failed, "Nothing was sent: Google refused the access.");
  world.send = { ok: false, sent: "unknown", status: 502, code: "unsure", error: "Gmail didn't confirm whether the reply was sent. Look in Amy's Sent folder before sending it again." };
  const p2 = await run(tk.ticketReply, { ticket: "42", text: "Resent again." }, d);
  const u = await run(tk.ticketReply, { ticket: "42", text: "Resent again.", confirm: p2.confirm }, d);
  assert.match(String(u.failed), /Look in Amy's Sent folder/);
});

test("ticketRef and pickTeammate", { skip }, async () => {
  await load();
  assert.equal(tk.ticketRef("#042"), "42");
  assert.equal(tk.ticketRef(" 7 "), "7");
  assert.equal(tk.ticketRef("11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
  assert.equal(tk.ticketRef("#4x"), null);
  const team = [{ email: "a@x.com", name: "Ann Lee" }, { email: "b@x.com", name: "Bo Lee" }];
  assert.deepEqual(tk.pickTeammate(team, "ann"), team[0]);
  assert.deepEqual(tk.pickTeammate(team, "BO LEE"), team[1]);
  assert.ok("error" in tk.pickTeammate(team, "lee"));
});
