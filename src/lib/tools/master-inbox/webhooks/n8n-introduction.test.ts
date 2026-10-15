/*
 * Ported from the standalone Master Inbox (lib/webhooks/n8n-introduction.test.ts,
 * c4b6b77, and the portal-link tests of 3fd9d31). The standalone's tests are
 * unchanged apart from the OS's env prefix and import paths; the two marked
 * "the OS's own" are the OS's.
 *
 * What the Introduction webhooks actually POST, with SMS alerts off and on
 * (the team_sms_notifications flag, set from the Client Portals page) and
 * with the Team page's per-member SMS switches.
 *
 * The real notifyIntroduction runs against the in-memory PostgREST (see
 * test/fake-postgrest.ts for why nothing here may touch the real database),
 * and the two webhook hosts are captured instead of called:
 *   sms.test   = MASTER_INBOX_N8N_INTRODUCTION_WEBHOOK_URL (the LoopMessage SMS notifier)
 *   bison.test = MASTER_INBOX_BISON_INTRODUCTION_WEBHOOK_URL (the orchestrator)
 *
 * The headline guards: a client with SMS alerts off sends NOTHING to the
 * notifier, the notifier only ever gets approved bodies, and Bison's payload
 * never changes, whatever the SMS settings.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.CLIENT_PORTALS_ENABLED = "true"; // read at import by portals/flag.ts
process.env.MASTER_INBOX_N8N_INTRODUCTION_WEBHOOK_URL = "http://sms.test/webhooks/introduction";
process.env.MASTER_INBOX_BISON_INTRODUCTION_WEBHOOK_URL = "http://bison.test/api/webhooks/masterinbox";

type Post = {
  host: string;
  body: Record<string, unknown> & {
    team: { name: string; mobile: string }[];
    client: { id: string; name: string | null; portal_url?: string | null };
  };
};

const db = new FakePostgrest();
const posts: Post[] = [];
// Simulates PostgREST rejecting a query (e.g. a column that isn't migrated).
let rejectQuery: ((url: URL) => boolean) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host === "sms.test" || url.host === "bison.test") {
    posts.push({ host: url.host, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }
  if (rejectQuery?.(url)) {
    return new Response(
      JSON.stringify({ code: "42703", message: "column does not exist", details: null, hint: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { notifyIntroduction, notifyIntroductionForThreads } = await import("./n8n-introduction.ts");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";
const CLOSED = "33333333-3333-4333-8333-333333333333"; // portal switched off
const PORTALS: Record<string, { portal_token: string | null; portal_enabled: boolean }> = {
  [DEMO]: { portal_token: "demo-portal-token", portal_enabled: true },
  [OTHER]: { portal_token: "other-client-token", portal_enabled: true },
  [CLOSED]: { portal_token: "closed-client-token", portal_enabled: false },
};

function entry(id: string, clientId: string, clientName: string): Row {
  // FakePostgrest ignores select/embeds, so embedded rows ride inline.
  return {
    id,
    client_id: clientId,
    stage: "introduction",
    lead_name: "Laura Wilson",
    lead_email: "laura@example.com",
    lead_phone: "6652341234",
    current_brokerage: "Legacy Realty Group",
    thread_id: `thread-${id}`,
    introduced_at: "2026-10-08T00:00:00Z",
    leads: { company: "Legacy Realty Group", title: null, custom_fields: {} },
    clients: { id: clientId, name: clientName, slug: null, ...(PORTALS[clientId] ?? { portal_token: null, portal_enabled: true }) },
    assigned_team_member: null,
    threads: { campaign_name: null },
  };
}

function seed({ demoSmsOn = true, demoSwitches = { Eddy: true, Ryan: false, Amy: true }, othersSmsOn = false } = {}) {
  db.reset();
  posts.length = 0;
  rejectQuery = null;
  db.seed("clients", [
    {
      id: DEMO,
      name: "Demo Portal",
      feature_flags: demoSmsOn ? { manage_stages: true, team_sms_notifications: true } : { manage_stages: true },
    },
    { id: OTHER, name: "Other Client", feature_flags: othersSmsOn ? { team_sms_notifications: true } : { manage_stages: true } },
    { id: CLOSED, name: "Closed Portal Client", feature_flags: othersSmsOn ? { team_sms_notifications: true } : {} },
  ]);
  db.seed("client_team_members", [
    { client_id: DEMO, name: "Eddy", phone: "7184150537", active: true, receives_sms: demoSwitches.Eddy },
    { client_id: DEMO, name: "Ryan", phone: "+16475720433", active: true, receives_sms: demoSwitches.Ryan },
    { client_id: DEMO, name: "Amy", phone: "8173711939", active: true, receives_sms: demoSwitches.Amy },
    { client_id: DEMO, name: "Inactive Ivy", phone: "2125550100", active: false, receives_sms: true },
    { client_id: DEMO, name: "No-Phone Nia", phone: null, active: true, receives_sms: true },
    { client_id: OTHER, name: "Olivia", phone: "3105550111", active: true, receives_sms: true },
    { client_id: OTHER, name: "Oscar", phone: "3105550112", active: true, receives_sms: false },
    { client_id: CLOSED, name: "Cleo", phone: "3105550113", active: true, receives_sms: true },
  ]);
  db.seed("client_pipeline_entries", [
    entry("e-demo", DEMO, "Demo Portal"),
    entry("e-other", OTHER, "Other Client"),
    entry("e-closed", CLOSED, "Closed Portal Client"),
  ]);
}

const names = (p: Post | undefined) => p?.body.team.map((m) => m.name);
const post = (host: string, entryId: string) =>
  posts.find((p) => p.host === host && p.body.pipeline_entry_id === entryId);

test("SMS alerts off: nothing is sent to the SMS notifier", async () => {
  seed({ demoSmsOn: false });
  await notifyIntroduction(["e-demo", "e-other"], "portal_stage_change");
  assert.equal(posts.filter((p) => p.host === "sms.test").length, 0);
});

test("SMS alerts on: only members switched on, marked approved, same payload keys", async () => {
  seed();
  await notifyIntroduction(["e-demo"], "portal_stage_change");
  const sms = post("sms.test", "e-demo");
  assert.deepEqual(names(sms), ["Eddy", "Amy"], "Ryan off; inactive and phoneless never included");
  assert.equal(sms!.body.sms_enabled, true);
  assert.deepEqual(Object.keys(sms!.body), [
    "event", "occurred_at", "source", "pipeline_entry_id", "lead", "client", "team", "sms_enabled",
  ]);
  assert.deepEqual(sms!.body.team[0], { name: "Eddy", mobile: "7184150537" });
});

test("Bison never changes: full team, no approval mark", async () => {
  seed();
  await notifyIntroduction(["e-demo"], "inbox_label"); // inbox + lead email → Bison fires
  const sms = post("sms.test", "e-demo")!;
  const bison = post("bison.test", "e-demo")!;
  assert.deepEqual(names(bison), ["Eddy", "Ryan", "Amy"]);
  assert.equal("sms_enabled" in bison.body, false);
  // Apart from team and the mark, the SMS body is the exact n8n payload
  // Bison extends (Bison adds fields to lead and client, so those are skipped).
  for (const [k, v] of Object.entries(sms.body)) {
    if (["team", "sms_enabled", "lead", "client"].includes(k)) continue;
    assert.deepEqual(bison.body[k], v, `bison.${k}`);
  }
});

test("in a mixed batch, only the client with SMS on reaches the notifier", async () => {
  seed();
  await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
  assert.deepEqual(names(post("sms.test", "e-demo")), ["Eddy", "Amy"]);
  assert.equal(post("sms.test", "e-other"), undefined);
  assert.deepEqual(names(post("bison.test", "e-other")), ["Olivia", "Oscar"]);
});

test("everyone switched off: no SMS POST at all, Bison still fires", async () => {
  seed({ demoSwitches: { Eddy: false, Ryan: false, Amy: false } });
  await notifyIntroduction(["e-demo"], "inbox_label");
  assert.equal(post("sms.test", "e-demo"), undefined);
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
});

test("switches unreadable (column not migrated): no texts, Bison unchanged", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/client_team_members") && u.search.includes("receives_sms");
  await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
  assert.equal(posts.filter((p) => p.host === "sms.test").length, 0, "can't see who opted out → text nobody");
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
});

test("SMS settings unreadable: no texts for anyone, Bison unchanged", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/clients") && (u.searchParams.get("select") ?? "").includes("feature_flags");
  await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
  assert.equal(posts.filter((p) => p.host === "sms.test").length, 0);
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
  assert.deepEqual(names(post("bison.test", "e-other")), ["Olivia", "Oscar"]);
});

test("no SMS settings are read when the SMS webhook isn't configured", async () => {
  seed();
  const saved = process.env.MASTER_INBOX_N8N_INTRODUCTION_WEBHOOK_URL;
  delete process.env.MASTER_INBOX_N8N_INTRODUCTION_WEBHOOK_URL;
  try {
    await notifyIntroduction(["e-demo"], "inbox_label");
  } finally {
    process.env.MASTER_INBOX_N8N_INTRODUCTION_WEBHOOK_URL = saved;
  }
  assert.equal(post("sms.test", "e-demo"), undefined);
  assert.equal(db.calls.filter((c) => c.table === "clients").length, 0);
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
});

/*
 * ---------------------------------------------------------------------------
 * The OS's own two.
 *
 * In the OS the inbox does not call notifyIntroduction with entry ids: a label
 * goes through the outbox, which calls notifyIntroductionForThreads with the
 * THREAD id (outbox.ts). That is the path every Introduction made in the OS
 * inbox takes, so it is the one that has to obey the switches.
 */

test("OS inbox path (by thread): SMS on texts the switched-on members; SMS off posts nothing", async () => {
  seed();
  await notifyIntroductionForThreads(["thread-e-demo", "thread-e-other"], "inbox_label");
  const sms = post("sms.test", "e-demo");
  assert.deepEqual(names(sms), ["Eddy", "Amy"]);
  assert.equal(sms!.body.sms_enabled, true);
  assert.equal(sms!.body.source, "inbox_label");
  assert.equal(post("sms.test", "e-other"), undefined, "SMS alerts off: not even an unmarked post");
  assert.deepEqual(names(post("bison.test", "e-other")), ["Olivia", "Oscar"], "Bison still gets the full team");
});

test("the OS never sends the notifier an unapproved body, whatever the mix", async () => {
  // Before this port the OS posted EVERY introduction here unmarked, with the
  // full team's names and numbers; the notifier ignored them all.
  for (const demoSmsOn of [true, false]) {
    seed({ demoSmsOn });
    await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
    await notifyIntroduction(["e-demo", "e-other"], "portal_stage_change");
    for (const p of posts.filter((x) => x.host === "sms.test")) {
      assert.equal(p.body.sms_enabled, true);
      assert.equal((p.body.client as { id: string }).id, DEMO);
    }
    if (!demoSmsOn) assert.equal(posts.filter((x) => x.host === "sms.test").length, 0);
  }
});

/* The portal link in each text (standalone 3fd9d31, Akeesh, 15 Oct). */

test("each SMS carries the portal link of the lead's own client", async () => {
  seed({ othersSmsOn: true });
  await notifyIntroduction(["e-demo", "e-other"], "portal_stage_change");
  assert.equal(post("sms.test", "e-demo")!.body.client.portal_url, "https://portal.brokerstaffer.com/portal/demo-portal-token");
  assert.equal(post("sms.test", "e-other")!.body.client.portal_url, "https://portal.brokerstaffer.com/portal/other-client-token");
});

test("no portal link when that client's portal is switched off", async () => {
  seed({ othersSmsOn: true });
  await notifyIntroduction(["e-closed"], "portal_stage_change");
  const sms = post("sms.test", "e-closed")!;
  assert.deepEqual(names(sms), ["Cleo"], "the text still goes");
  assert.equal(sms.body.client.portal_url, null);
});

test("Bison's payload is unchanged by the SMS portal link", async () => {
  seed({ othersSmsOn: true });
  await notifyIntroduction(["e-demo", "e-closed"], "inbox_label");
  const bison = post("bison.test", "e-demo")!.body.client as Record<string, unknown>;
  assert.deepEqual(Object.keys(bison), ["id", "name", "slug", "portal_url"]);
  assert.equal(bison.portal_url, "https://portal.brokerstaffer.com/portal/demo-portal-token");
  // As before: built from the token, whether or not the portal is on.
  assert.equal(
    (post("bison.test", "e-closed")!.body.client as Record<string, unknown>).portal_url,
    "https://portal.brokerstaffer.com/portal/closed-client-token",
  );
});

test("the OS inbox path (by thread) sends the link too", async () => {
  seed({ othersSmsOn: true });
  await notifyIntroductionForThreads(["thread-e-other", "thread-e-closed"], "inbox_label");
  assert.equal(post("sms.test", "e-other")!.body.client.portal_url, "https://portal.brokerstaffer.com/portal/other-client-token");
  assert.equal(post("sms.test", "e-closed")!.body.client.portal_url, null);
});
