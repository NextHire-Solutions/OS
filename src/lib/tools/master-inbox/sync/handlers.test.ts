/*
 * The two webhook handlers, end to end, against a fake PostgREST.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAKE POSTGREST RATHER THAN A MOCKED MODULE
 *
 * The handlers reach the database through `createAdminSupabase()`, which is
 * a real supabase-js client whose only side effect is `fetch`. Stubbing
 * `globalThis.fetch` with a small in-memory PostgREST therefore exercises the
 * handlers EXACTLY as shipped — query building, `.maybeSingle()`, the
 * insert-or-update decision, the workspace scoping on every write — with no
 * network and no database. A module mock would test the mock.
 *
 * Any request to a host other than the fake Supabase is refused and recorded;
 * the last test asserts the list is empty. The provider clients are never
 * constructed because their API keys are unset, which is also the state the
 * tool's own tests run in.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SKIPS ITSELF UNDER `npm test`
 *
 * The sync modules import through `@/` and `server-only`, which plain
 * `node --test` cannot resolve. The rest of the suite avoids that by testing
 * pure helpers; the point of THIS file is the plumbing, so it needs the alias
 * hooks and loads the handlers dynamically, skipping when they are absent:
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/master-inbox/sync/handlers.test.ts
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Environment: point the singleton client at the fake, and make sure nothing
// can construct a provider client or reach for an AI key.
process.env.MASTER_INBOX_SUPABASE_URL = "http://supabase.test";
process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
for (const v of [
  "MASTER_INBOX_INSTANTLY_API_KEY",
  "MASTER_INBOX_EMAILBISON_API_KEY",
  "MASTER_INBOX_APP_ENCRYPTION_KEY",
  "MASTER_INBOX_CRON_ENABLED",
]) {
  delete process.env[v];
}

type Row = Record<string, unknown>;

class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly calls: Array<{ method: string; table: string; query: URLSearchParams; body: unknown }> = [];
  readonly blocked: string[] = [];
  private seq = 0;

  seed(table: string, rows: Row[]) {
    this.tables.set(table, rows.map((r) => ({ ...r })));
  }
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }
  reset(tables: string[]) {
    for (const t of tables) this.tables.set(t, []);
    this.calls.length = 0;
  }
  writes(table: string, method: "POST" | "PATCH") {
    return this.calls.filter((c) => c.table === table && c.method === method);
  }

  private matches(row: Row, query: URLSearchParams): boolean {
    for (const [k, v] of query) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      if (v.startsWith("eq.")) {
        if (String(row[k]) !== v.slice(3)) return false;
      } else if (v === "is.null") {
        if (row[k] !== null && row[k] !== undefined) return false;
      }
    }
    return true;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "supabase.test") {
      this.blocked.push(url.href);
      throw new Error(`network blocked: ${url.href}`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const parts = url.pathname.replace(/^\/rest\/v1\//, "").split("/");
    const table = parts[0] === "rpc" ? `rpc:${parts[1]}` : parts[0];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, table, query: url.searchParams, body });

    const respond = (rows: Row[], status = 200) => {
      const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
      if (wantsObject && rows.length !== 1) {
        return new Response(JSON.stringify({ code: "PGRST116", message: `${rows.length} rows` }), {
          status: 406,
          headers: { "content-type": "application/json" },
        });
      }
      if ((headers.get("prefer") ?? "").includes("return=minimal")) {
        return new Response("", { status: 204 });
      }
      return new Response(JSON.stringify(wantsObject ? rows[0] : rows), {
        status,
        headers: { "content-type": "application/json" },
      });
    };

    if (table.startsWith("rpc:")) return respond([]);
    const store = this.tables.get(table) ?? [];
    this.tables.set(table, store);

    if (method === "GET") {
      let rows = store.filter((r) => this.matches(r, url.searchParams));
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return respond(rows);
    }
    if (method === "POST") {
      const incoming: Row[] = Array.isArray(body) ? body : [body];
      const inserted = incoming.map((r) => ({ id: `${table}-${++this.seq}`, ...r }));
      store.push(...inserted);
      return respond(inserted, 201);
    }
    if (method === "PATCH") {
      const rows = store.filter((r) => this.matches(r, url.searchParams));
      for (const r of rows) Object.assign(r, body);
      return respond(rows);
    }
    return respond([]);
  };
}

const db = new FakePostgrest();
const WORKSPACE = "ws-1";
const UNKNOWN_CLIENT = "client-unknown";
const SERHANT_CLIENT = "client-serhant";
const MUTABLE = ["leads", "threads", "messages", "channels", "reply_agents", "label_assignments", "labels"];

db.seed("workspaces", [{ id: WORKSPACE, created_at: "2026-01-01T00:00:00.000Z" }]);
db.seed("clients", [
  { id: UNKNOWN_CLIENT, name: "Unknown", slug: "unknown", aliases: [] },
  { id: SERHANT_CLIENT, name: "SERHANT.", slug: "serhant", aliases: [] },
]);

/** Let the handlers' fire-and-forget pipeline finish against the fake. */
const settle = () => new Promise((r) => setTimeout(r, 25));

type Handlers = {
  handleInstantlyEvent: (e: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
  handleEmailBisonEvent: (e: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
};

async function loadHandlers(): Promise<Handlers | null> {
  try {
    const [instantly, emailbison] = await Promise.all([
      import("@/lib/tools/master-inbox/sync/instantly"),
      import("@/lib/tools/master-inbox/sync/emailbison"),
    ]);
    return { handleInstantlyEvent: instantly.handleInstantlyEvent, handleEmailBisonEvent: emailbison.handleEmailBisonEvent };
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const handlers = await loadHandlers();
const skip = handlers ? false : "needs the @/ alias hooks: node --import ./scripts/alias-hooks.mjs --test";

// The handlers log every receipt and drop; that is right in production and
// noise here.
for (const m of ["log", "warn", "error"] as const) mock.method(console, m, () => {});
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;

const instantlyEnvelope = {
  event_type: "reply_received",
  timestamp: "2026-09-15T14:03:00.000Z",
  email_id: "e-123",
  reply_subject: "Re: Quick question",
  reply_text: "Sure, let's talk.",
  reply_html: "<p>Sure, let's talk.</p>",
  email_account: "nicole@brokerstaffer.com",
  campaign_id: "c-9",
  campaign_name: "Some Campaign Nobody Configured",
  lead_email: "jane@example.com",
  firstName: "Jane",
  lastName: "Doe",
  companyName: "Doe Realty",
  jobTitle: "Broker",
  LicenseNumber: "10401234567",
};

test("instantly: a reply becomes lead + thread + message, tagged \"Unknown\" when no client matches", { skip }, async () => {
  db.reset(MUTABLE);
  const result = await handlers!.handleInstantlyEvent(instantlyEnvelope);
  await settle();
  assert.deepEqual(result, { ok: true });

  const [lead] = db.rows("leads");
  assert.equal(lead.workspace_id, WORKSPACE);
  assert.equal(lead.email, "jane@example.com");
  assert.equal(lead.full_name, "Jane Doe");
  assert.deepEqual(lead.custom_fields, { jobTitle: "Broker", LicenseNumber: "10401234567" });

  const [channel] = db.rows("channels");
  assert.equal(channel.provider, "instantly");
  assert.equal(channel.instantly_account_id, "nicole@brokerstaffer.com", "the OUR-side mailbox becomes a channel");

  const [thread] = db.rows("threads");
  assert.equal(thread.instantly_thread_id, "in:lead:jane@example.com:campaign:c-9");
  assert.equal(thread.client_id, UNKNOWN_CLIENT, "the Unknown fallback");
  assert.equal(thread.lead_id, lead.id);
  assert.equal(thread.channel_id, channel.id);
  assert.equal(thread.needs_reply, true);
  assert.equal(thread.seen, false);
  assert.equal(thread.outbound_sender_email, "nicole@brokerstaffer.com");

  const [message] = db.rows("messages");
  assert.equal(message.external_message_id, "in:email:e-123");
  assert.equal(message.direction, "inbound");
  assert.equal(message.thread_id, thread.id);
  assert.deepEqual(message.raw_payload, instantlyEnvelope, "the envelope is kept verbatim");
});

test("instantly: the same delivery twice updates in place — no second lead, thread or message", { skip }, async () => {
  db.reset(MUTABLE);
  await handlers!.handleInstantlyEvent(instantlyEnvelope);
  await settle();
  const firstInserts = db.writes("messages", "POST").length;
  await handlers!.handleInstantlyEvent({ ...instantlyEnvelope, reply_text: "Sure, let's talk. (edited)" });
  await settle();

  assert.equal(db.rows("leads").length, 1);
  assert.equal(db.rows("threads").length, 1);
  assert.equal(db.rows("messages").length, 1);
  assert.equal(db.rows("channels").length, 1);
  assert.equal(db.writes("messages", "POST").length, firstInserts, "no second insert");
  assert.ok(db.writes("messages", "PATCH").length >= 1, "the replay is an update");
  assert.equal(db.rows("messages")[0].body_text, "Sure, let's talk. (edited)");
  assert.deepEqual(db.rows("messages")[0].raw_payload, instantlyEnvelope, "raw_payload: first write wins");
});

test("instantly: a campaign that names a client is tagged with it; a later touch cannot retag", { skip }, async () => {
  db.reset(MUTABLE);
  await handlers!.handleInstantlyEvent({ ...instantlyEnvelope, campaign_name: "SERHANT. - NYC Agents" });
  await settle();
  assert.equal(db.rows("threads")[0].client_id, SERHANT_CLIENT);
  await handlers!.handleInstantlyEvent({ ...instantlyEnvelope, email_id: "e-124", campaign_name: "Renamed" });
  await settle();
  assert.equal(db.rows("threads").length, 1, "same (lead, campaign) is the same thread");
  assert.equal(db.rows("threads")[0].client_id, SERHANT_CLIENT, "first match wins");
  assert.equal(db.rows("threads")[0].campaign_name, "SERHANT. - NYC Agents", "first-set wins on campaign_name");
  assert.equal(db.rows("messages").length, 2);
});

test("instantly: every update is scoped to the workspace and the row", { skip }, async () => {
  db.reset(MUTABLE);
  await handlers!.handleInstantlyEvent(instantlyEnvelope);
  await settle();
  await handlers!.handleInstantlyEvent(instantlyEnvelope);
  await settle();
  const patches = db.calls.filter((c) => c.method === "PATCH");
  assert.ok(patches.length > 0);
  for (const p of patches) {
    assert.equal(p.query.get("workspace_id"), `eq.${WORKSPACE}`, `${p.table} update not scoped by workspace`);
    assert.ok(p.query.get("id")?.startsWith("eq."), `${p.table} update not scoped by id`);
  }
});

test("instantly: drops are explicit, other events are acknowledged and ignored", { skip }, async () => {
  db.reset(MUTABLE);
  assert.deepEqual(await handlers!.handleInstantlyEvent({}), { ok: false, reason: "missing event_type" });
  assert.deepEqual(await handlers!.handleInstantlyEvent({ event_type: "reply_received" }), { ok: false, reason: "missing email_id or lead_email" });
  assert.deepEqual(await handlers!.handleInstantlyEvent({ event_type: "lead_interested", email_id: "x", lead_email: "a@b.c" }), { ok: true, reason: "ignored event type: lead_interested" });
  assert.equal(db.rows("messages").length, 0);
});

const emailbisonEnvelope = {
  event: { type: "LEAD_REPLIED", name: "Lead replied", workspace_id: 7, workspace_name: "BrokerStaffer" },
  data: {
    lead: { id: 42, uuid: "u-42", email: "jane@example.com", first_name: "Jane", last_name: "Doe", company: "Doe Realty", custom_variables: [{ name: "City", value: "NYC" }] },
    campaign: { id: 5, name: "SERHANT. - Brooklyn" },
    sender_email: { id: 3, email: "nicole@brokerstaffer.com", name: "Nicole Collins" },
    reply: {
      id: 99,
      email_subject: "Re: Hello",
      html_body: "<p>Yes</p>",
      text_body: "Yes",
      from_name: "Jane Doe",
      from_email_address: "jane@example.com",
      to: [{ name: "Nicole", address: "nicole@brokerstaffer.com" }],
      date_received: "2026-09-15T14:03:00.000Z",
    },
  },
};

test("emailbison: a reply becomes lead + channel + thread + message", { skip }, async () => {
  db.reset(MUTABLE);
  const result = await handlers!.handleEmailBisonEvent(emailbisonEnvelope);
  await settle();
  assert.deepEqual(result, { ok: true });

  const [lead] = db.rows("leads");
  assert.equal(lead.emailbison_lead_id, "42");
  assert.deepEqual(lead.custom_fields, { City: "NYC" });

  const [channel] = db.rows("channels");
  assert.equal(channel.provider, "emailbison");
  assert.equal(channel.emailbison_sender_email_id, "3");
  assert.equal(channel.emailbison_team_id, 7, "the team is pinned on the channel");
  assert.equal(channel.display_name, "Nicole Collins");
  assert.equal(channel.external_account_id, "nicole@brokerstaffer.com");

  const [thread] = db.rows("threads");
  assert.equal(thread.emailbison_thread_id, "eb:lead:42:campaign:5");
  assert.equal(thread.client_id, SERHANT_CLIENT);
  assert.equal(thread.campaign_id, "5");
  assert.equal(thread.outbound_sender_email, "nicole@brokerstaffer.com");

  const [message] = db.rows("messages");
  assert.equal(message.external_message_id, "eb:reply:99");
  assert.equal(message.emailbison_reply_id, "99");
  assert.deepEqual(message.recipients, { to: ["nicole@brokerstaffer.com"], cc: [], bcc: [] });
  assert.deepEqual(message.raw_payload, emailbisonEnvelope);
});

test("emailbison: a replay updates in place and never touches raw_payload", { skip }, async () => {
  db.reset(MUTABLE);
  await handlers!.handleEmailBisonEvent(emailbisonEnvelope);
  await settle();
  const replay = { ...emailbisonEnvelope, data: { ...emailbisonEnvelope.data, reply: { ...emailbisonEnvelope.data.reply, text_body: "Yes!" } } };
  await handlers!.handleEmailBisonEvent(replay);
  await settle();

  assert.equal(db.rows("leads").length, 1);
  assert.equal(db.rows("threads").length, 1);
  assert.equal(db.rows("messages").length, 1);
  assert.equal(db.rows("channels").length, 1);
  const patch = db.writes("messages", "PATCH").at(-1);
  assert.ok(patch, "the replay is an update");
  assert.ok(!("raw_payload" in (patch!.body as Row)), "raw_payload is not in the update body");
  assert.equal(db.rows("messages")[0].body_text, "Yes!");
  assert.deepEqual(db.rows("messages")[0].raw_payload, emailbisonEnvelope, "first write wins");
});

test("emailbison: the wrapped (OpenAPI sample) envelope lands in the same rows", { skip }, async () => {
  db.reset(MUTABLE);
  await handlers!.handleEmailBisonEvent({ data: emailbisonEnvelope });
  await settle();
  assert.equal(db.rows("messages")[0]?.external_message_id, "eb:reply:99");
  assert.equal(db.rows("threads")[0]?.emailbison_thread_id, "eb:lead:42:campaign:5");
});

test("emailbison: no campaign → Unknown client and a campaign-less thread key", { skip }, async () => {
  db.reset(MUTABLE);
  const { campaign: _drop, ...data } = emailbisonEnvelope.data;
  void _drop;
  await handlers!.handleEmailBisonEvent({ event: emailbisonEnvelope.event, data });
  await settle();
  assert.equal(db.rows("threads")[0]?.emailbison_thread_id, "eb:lead:42:campaign:none");
  assert.equal(db.rows("threads")[0]?.client_id, UNKNOWN_CLIENT);
});

test("emailbison: malformed and irrelevant events write nothing", { skip }, async () => {
  db.reset(MUTABLE);
  assert.deepEqual(await handlers!.handleEmailBisonEvent({}), { ok: false, reason: "missing event type" });
  assert.deepEqual(await handlers!.handleEmailBisonEvent({ event: { type: "EMAIL_SENT" }, data: {} }), { ok: true, reason: "ignored event type: email_sent" });
  assert.deepEqual(await handlers!.handleEmailBisonEvent({ event: { type: "LEAD_REPLIED" }, data: { lead: emailbisonEnvelope.data.lead } }), { ok: false, reason: "missing lead or reply" });
  assert.equal(db.rows("messages").length, 0);
  assert.equal(db.rows("leads").length, 0);
});

test("nothing left the process: no request reached any host but the fake", { skip }, async () => {
  await settle();
  assert.deepEqual(db.blocked, []);
  globalThis.fetch = realFetch;
});
