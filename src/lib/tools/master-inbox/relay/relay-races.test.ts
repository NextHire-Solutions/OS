/*
 * Races found by the 21 Oct review — fake database and fake transport only.
 *
 * A sweep works through its held re-checks from a list it read first. If the
 * same hand-off is sent meanwhile (a person's press, another server), the
 * sweep's stale copy used to write over "sent" — "ready" (one click: the next
 * press sent it AGAIN) or "held" by the cap (automatic: the next sweep sent it
 * AGAIN by itself). And a "Check again" held by the cap was later sent as if
 * Send had been pressed. Each must now leave exactly one send, or none.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest.ts";
configureFakeEnvironment("MASTER_INBOX_");
for (const v of ["OS_BROKERAGE_RELAY_LIVE_SEND", "POSTMARK_SERVER_TOKEN", "OS_BROKERAGE_RELAY_FROM", "OS_BROKERAGE_RELAY"]) delete process.env[v];

const db = new FakePostgrest();
type Row = Record<string, unknown>;
let hook: ((url: URL, init?: RequestInit) => void) | null = null;
let failing: ((url: URL) => boolean) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (failing?.(url)) return new Response(JSON.stringify({ message: "database unavailable" }), { status: 500, headers: { "content-type": "application/json" } });
  const res = await db.fetch(input, init);
  if (hook) hook(url, init);
  return res;
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const relay = await import("./relay.ts");

const WS = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-15T15:00:00.000Z");
const at = (min: number, base = NOW) => new Date(base.getTime() + min * 60_000).toISOString();
const LIVE = { OS_BROKERAGE_RELAY_LIVE_SEND: "1" };
const handed: unknown[] = [];
const transport = { async send(email: unknown) { handed.push(email); return { ok: true as const, messageId: `pm-${handed.length}`, submittedAt: null }; } };

function add(table: string, rows: Row[]) { const all = db.seed(table, [...db.rows(table), ...rows]); return all.slice(all.length - rows.length); }

function seed(settings: Row, jeffRelay: Row) {
  db.reset(); handed.length = 0; hook = null; failing = null;
  db.seed("workspaces", [{ id: WS }]);
  const [interested] = db.seed("labels", [{ workspace_id: WS, name: "Interested" }]);
  const [jeff] = db.seed("clients", [{ name: "Jeff Cook Real Estate", slug: "jeff-cook-real-estate", aliases: [] }]);
  const [cJeff] = db.seed("os_clients", [{
    name: "Jeff Cook Real Estate", aliases: [], status: "active", mi_client_id: jeff.id, brokerage: "Jeff Cook Real Estate",
    contact_name: "Angela Oakes", contact_role: "Recruiter", contact_email: "angela@jeffcook.test",
    more_contacts: [], intro_variants: [], relay_settings: jeffRelay, pipeline_entry: "introduction",
  }]);
  db.seed("os_relay_settings", [{ workspace_id: WS, enabled: true, practice_mode: false, mode: "automatic", forward_later_replies: false, counts_as_introduction: false, hourly_cap: 5, enabled_since: "2026-10-15T00:00:00.000Z", ...settings }]);
  for (const t of ["os_brokerage_relays", "os_brokerage_relay_agents", "os_relay_campaigns", "os_campaign_portals", "os_portal_blocks", "os_notifications",
    "leads", "threads", "messages", "label_assignments", "client_dnc_entries", "client_agents", "client_pipeline_entries"]) db.seed(t, []);
  const [lead] = add("leads", [{ full_name: "Jordan Ellis", email: "jordan@coastal.test" }]);
  const [thread] = add("threads", [{ workspace_id: WS, client_id: jeff.id, lead_id: lead.id, campaign_id: "101", campaign_name: "Jeff Cook Real Estate + Charleston", source_provider: "emailbison", subject: "Quick question" }]);
  add("messages", [
    { thread_id: thread.id, direction: "outbound", sender: "nicole@bs.test", sender_name: "Nicole", subject: "Quick question", body_text: "Hi", sent_at: at(-24 * 60) },
    { thread_id: thread.id, direction: "inbound", sender: "jordan@coastal.test", sender_name: "Jordan Ellis", subject: "Re: Quick question", body_text: "Sure, happy to chat.", sent_at: at(-50) },
  ]);
  add("label_assignments", [{ workspace_id: WS, label_id: interested.id, target_type: "thread", target_id: thread.id, assigned_at: at(-40) }]);
  const [rec] = add("os_brokerage_relays", [{
    workspace_id: WS, dedupe_key: `handoff:${thread.id}`, kind: "handoff", thread_id: thread.id, trigger: "Interested", triggered_at: at(-40),
    status: "held", reason: "evaluating", practice: true, created_at: at(-40), updated_at: at(-40), attempts: 0, recipients: [],
  }]);
  return { thread, rec, clientId: cJeff.id as string };
}

/** After the sweep has read its list of held rows, someone else sends that same hand-off (what a concurrent press / replica does). */
function someoneElseSendsAfterHeldRead(recId: string, clientId: string) {
  let done = false;
  hook = (url) => {
    if (done || !url.pathname.endsWith("/os_brokerage_relays")) return;
    if (url.searchParams.get("status") !== "eq.held" || !url.searchParams.get("reason")?.startsWith("in.")) return;
    done = true;
    const row = db.rows("os_brokerage_relays").find((r: Row) => r.id === recId)!;
    Object.assign(row, { status: "sent", attempts: 1, practice: false, os_client_id: clientId, decided_at: NOW.toISOString(), sent_at: NOW.toISOString(), provider_message_id: "pm-other", updated_at: NOW.toISOString() });
    add("os_brokerage_relay_agents", [{ workspace_id: WS, os_client_id: clientId, agent_email: "jordan@coastal.test", mode: "live", relay_id: recId, claimed_at: NOW.toISOString() }]);
    handed.push("the other process's send");
  };
}

test("one click: a sweep's stale copy can no longer turn a SENT hand-off back into 'ready' — no second send", async () => {
  const { thread, rec, clientId } = seed({ mode: "one_click" }, { enabled: true });
  someoneElseSendsAfterHeldRead(rec.id, clientId);
  await relay.sweepBrokerageRelay(NOW, { ws: WS, transport, env: LIVE });
  const after = db.rows("os_brokerage_relays").find((r: Row) => r.id === rec.id)!;
  assert.equal(after.status, "sent", "the stale copy wrote nothing");
  hook = null;
  await assert.rejects(relay.sendToBrokerage(rec.id, thread.id, "amy@x.test", { ws: WS, transport, env: LIVE }, new Date(NOW.getTime() + 60_000)), /already sent/);
  assert.equal(handed.length, 1, "one send of one hand-off");
});

test("automatic, cap 1: the stale copy neither counts the hand-off against itself nor overwrites SENT — the next sweep sends nothing", async () => {
  const { rec, clientId } = seed({ mode: "automatic" }, { enabled: true, hourly_cap: 1 });
  someoneElseSendsAfterHeldRead(rec.id, clientId);
  await relay.sweepBrokerageRelay(NOW, { ws: WS, transport, env: LIVE });
  assert.equal(db.rows("os_brokerage_relays").find((r: Row) => r.id === rec.id)!.status, "sent");
  hook = null;
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 6 * 60_000), { ws: WS, transport, env: LIVE });
  assert.equal(db.rows("os_brokerage_relays").find((r: Row) => r.id === rec.id)!.status, "sent");
  assert.equal(handed.length, 1, "nothing sent by itself afterwards");
});

test("a 'Check again' held by the cap is never sent as if Send were pressed — after a switch to one click it waits for a press", async () => {
  const { thread, rec, clientId } = seed({ mode: "automatic" }, { enabled: true, hourly_cap: 1 });
  add("os_brokerage_relays", [{ workspace_id: WS, dedupe_key: "handoff:other", kind: "handoff", thread_id: "11111111-1111-4111-8111-111111111111", trigger: "Interested", status: "sent", practice: false, os_client_id: clientId, decided_at: at(-10), created_at: at(-10), updated_at: at(-10), attempts: 1 }]);
  const v = await relay.sendToBrokerage(rec.id, thread.id, "amy@x.test", { ws: WS, transport, env: LIVE }, NOW);
  assert.equal(v.status, "held");
  assert.equal(v.reason, "hourly_cap", "a Check again held by the cap is a re-check, not a Send");
  db.seed("os_relay_settings", db.rows("os_relay_settings").map((r: Row) => ({ ...r, mode: "one_click" })));
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 61 * 60_000), { ws: WS, transport, env: LIVE });
  assert.equal(db.rows("os_brokerage_relays").find((r: Row) => r.id === rec.id)!.status, "ready", "prepared, waiting for a press");
  assert.equal(handed.length, 0, "nothing sent without a Send press");
});

test("one failing step does not stop the others: the labels read fails, bounces are still recorded", async () => {
  const { rec, clientId } = seed({ mode: "automatic" }, { enabled: true });
  Object.assign(db.rows("os_brokerage_relays").find((r: Row) => r.id === rec.id)!, { status: "sent", practice: false, os_client_id: clientId, attempts: 1, decided_at: at(-30), sent_at: at(-30), provider_message_id: "pm-9", recipients: ["angela@jeffcook.test"] });
  failing = (url) => url.pathname.endsWith("/labels");
  const r = await relay.sweepBrokerageRelay(NOW, {
    ws: WS, transport, env: LIVE,
    bounces: async () => ({ ok: true as const, bounces: [{ ID: 7, Type: "HardBounce", MessageID: "pm-9", Email: "angela@jeffcook.test", Description: "Mailbox does not exist" }] }),
  });
  assert.ok(r.errors.some((e) => e.startsWith("new labels:")), "the failure is reported, by step");
  assert.equal(r.bounced, 1, "the bounce step still ran");
  assert.equal(db.rows("os_brokerage_relays").find((x: Row) => x.id === rec.id)!.status, "bounced");
  assert.equal(handed.length, 0);
});
