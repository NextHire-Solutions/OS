/*
 * Lead and spend caps, end to end against the in-memory database, with the real lead count and the real billing
 * preview. The campaigns and the label are fakes that record what they were asked: nothing here can reach EmailBison.
 *
 * What is pinned:
 *   - without the switch it only says what it would do: no campaign touched, nothing written;
 *   - only a client billed live is ever acted on;
 *   - at the cap it pauses, and restarts only what it saw itself pause, never one a person paused by hand;
 *   - a read that fails is never "no cap";
 *   - a reply over the cap is not a lead: not billed, uses none of the cap; once it really goes, it is, from then.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

type Live = { platform: "bison" | "instantly"; id: string; int_id: number | null; name: string; status: string };
const campaigns = new Map<string, Live[]>();
const calls: string[] = [];
let failPause = false, failResume = false, unreachableOnResume = false, chFails = false, chMissing = false, labelFails = false;
const targets = new Map<string, unknown>();
const shared = new Map<string, string[]>();
const labelled: Array<{ threadId: string; labelId: string }> = [];

const sending = (s: string) => ["active", "queued", "launching"].includes(s);
const planPause = (chId: string) => {
  const all = campaigns.get(chId) ?? [];
  return { clientId: chId, clientName: chId, action: "pause", willChange: all.filter((c) => sending(c.status)), skipped: all.filter((c) => !sending(c.status)).map((c) => ({ campaign: c, reason: c.status })) };
};
mock.module("../../tools/client-health/campaign-toggle", {
  namedExports: {
    planToggle: async (chId: string) => planPause(chId),
    liveCampaigns: async (chId: string) => campaigns.get(chId) ?? [],
    isSending: (c: { status: string }) => sending(c.status),
    sharedWithOthers: async (_chId: string, list: Array<{ platform: string; id: string }>) => new Map(list.flatMap((c) => (shared.has(`${c.platform}:${c.id}`) ? [[`${c.platform}:${c.id}`, shared.get(`${c.platform}:${c.id}`)!] as [string, string[]]] : []))),
    pauseListed: async (chId: string, list: Array<{ id: string }>, actor: string) => {
      calls.push(`pause ${chId} ${list.map((c) => c.id).join(",")} by ${actor}`);
      const will = (campaigns.get(chId) ?? []).filter((c) => list.some((l) => l.id === c.id) && sending(c.status));
      if (failPause) return { plan: { willChange: will, skipped: [] }, outcomes: will.map((c) => ({ campaign: c, ok: false, error: "Bison said no" })), heldPaused: 0, held: [] };
      for (const c of will) c.status = "paused";
      return { plan: { willChange: will, skipped: [] }, outcomes: will.map((c) => ({ campaign: c, ok: true })), heldPaused: 0, held: [] };
    },
    resumeListed: async (chId: string, list: Array<{ id: string }>, actor: string) => {
      calls.push(`resume ${chId} ${list.map((c) => c.id).join(",")} by ${actor}`);
      const mine = (campaigns.get(chId) ?? []).filter((c) => list.some((l) => l.id === c.id));
      if (unreachableOnResume) return { plan: { willChange: [], skipped: mine.map((c) => ({ campaign: { ...c, status: "unreachable" }, reason: "platform could not be reached" })) }, outcomes: [], heldPaused: 0, held: [] };
      const will = mine.filter((c) => c.status === "paused");
      if (failResume) return { plan: { willChange: will, skipped: [] }, outcomes: will.map((c) => ({ campaign: c, ok: false, error: "Bison said no" })), heldPaused: 0, held: [] };
      for (const c of will) c.status = "active";
      return { plan: { willChange: will, skipped: mine.filter((c) => !will.includes(c)).map((c) => ({ campaign: c, reason: c.status })) }, outcomes: will.map((c) => ({ campaign: c, ok: true })), heldPaused: 0, held: [] };
    },
  },
});
mock.module("../../tools/client-health/supabase", {
  namedExports: {
    getSupabase: () => ({
      from: () => {
        let id = "";
        const b = {
          select: () => b,
          eq: (_k: string, v: string) => { id = v; return b; },
          maybeSingle: async () => (chFails ? { data: null, error: { message: "Client Health is down" } } : chMissing ? { data: null, error: null } : { data: { monthly_target: targets.get(id) ?? null }, error: null }),
        };
        return b;
      },
    }),
  },
});
mock.module("../../tools/master-inbox/inbox/apply-label", {
  namedExports: {
    applyLabelToThread: async (i: { threadId: string; labelId: string }) => {
      if (labelFails) return { ok: false, error: "label write failed" };
      labelled.push({ threadId: i.threadId, labelId: i.labelId });
      return { ok: true, labelName: null, isIntroduction: false, alreadyCarriedThisLabel: false, announced: false };
    },
  },
});

const caps = await import("./caps.ts");
const billing = await import("./billing.ts");
const leads = await import("./leads.ts");

const WS = "w1";
const HB = "20000000-0000-4000-8000-000000000001";
const PORTAL = "10000000-0000-4000-8000-000000000001";
const ON = { OS_LEAD_CAPS: "1" };
const OFF = {};
const IN_WINDOW = new Date("2026-11-05T15:00:00.000Z");
const CAMPAIGN_A: Live = { platform: "bison", id: "camp-a", int_id: 1, name: "Homebase + SoCal", status: "active" };
const CAMPAIGN_B: Live = { platform: "bison", id: "camp-b", int_id: 2, name: "Homebase + Boston", status: "paused" };

function seed(o: { status?: string; target?: unknown; settings?: Row; ch?: string | null } = {}) {
  db.reset();
  calls.length = 0;
  labelled.length = 0;
  failPause = false; failResume = false; unreachableOnResume = false; chFails = false; chMissing = false; labelFails = false;
  campaigns.clear();
  targets.clear();
  shared.clear();
  campaigns.set("ch-hb", [{ ...CAMPAIGN_A }, { ...CAMPAIGN_B }]);
  targets.set("ch-hb", o.target === undefined ? 2 : o.target);
  db.seed("os_clients", [{ id: HB, name: "Homebase", aliases: [], status: o.status ?? "active", mi_client_id: PORTAL, ch_client_id: o.ch === undefined ? "ch-hb" : o.ch }]);
  db.seed("clients", [{ id: PORTAL, name: "Homebase", slug: "homebase", aliases: [] }]);
  db.seed("os_campaign_portals", []);
  db.seed("os_usage_billing_settings", [{
    os_client_id: HB, enabled: true, test_only: false, price_cents: 25_000, every_days: 14, anchor_date: "2026-10-28", lead_source: "handoffs",
    stripe_customer_id: "cus_1", default_payment_method_id: "pm_1", card_label: "Visa", setup_session_id: null, spend_cap_cents: null, ...o.settings,
  }]);
  db.seed("os_usage_billing_periods", []);
  db.seed("os_cap_windows", []);
  db.seed("os_cap_held_leads", []);
  db.seed("os_notifications", []);
  db.seed("os_brokerage_relays", [{ id: "r0", workspace_id: WS, os_client_id: HB, thread_id: "t-other", status: "sent", kind: "handoff", practice: false }]);
  db.seed("labels", [{ id: "lab-int", workspace_id: WS, name: "Interested" }, { id: "lab-warm", workspace_id: WS, name: "Keep Warm" }, { id: "lab-no", workspace_id: WS, name: "Not Interested" }, { id: "lab-unsub", workspace_id: WS, name: "Unsubscribe" }]);
  db.seed("leads", []);
  db.seed("threads", []);
  db.seed("label_assignments", []);
  db.seed("label_history", []);
  db.seed("client_pipeline_entries", []);
}

/** An agent marked Interested at this moment, as the AI labeller and its trigger write it. */
function interested(name: string, at: string, thread = `t-${name}`) {
  db.rows("leads").push({ id: `l-${name}`, email: `${name}@x.test`, full_name: name });
  db.rows("threads").push({ id: thread, client_id: PORTAL, lead_id: `l-${name}`, status: "open" });
  db.rows("label_assignments").push({ label_id: "lab-int", target_type: "thread", target_id: thread, assigned_at: at });
  db.rows("label_history").push({ id: db.rows("label_history").length + 1, thread_id: thread, label_id: "lab-int", label_name: "Interested", assigned_at: at, client_id: PORTAL, lead_id: `l-${name}`, source: "trigger" });
  return thread;
}
const atCap = () => { interested("john", "2026-11-04T00:29:00.000Z"); interested("ram", "2026-11-04T04:07:00.000Z"); };
const bells = () => db.rows("os_notifications").map((n) => String(n.ref));
const capWrites = () => db.calls.filter((c) => !["GET", "HEAD"].includes(c.method) && c.table.startsWith("os_cap"));
const camp = (id: string) => campaigns.get("ch-hb")!.find((c) => c.id === id)!;
const run = (now: Date = IN_WINDOW, env: Record<string, string> = ON) => caps.runLeadCaps({ env, now });
const listedIds = (i = 0) => (db.rows("os_cap_windows")[i].paused as Row[]).map((c) => c.id);
const press = { env: ON, now: IN_WINDOW };

/* ------------------------------------------------------- off by default --- */

test("without the switch: says what it would do, touches no campaign, writes nothing", async () => {
  seed();
  atCap();
  const r = await run(IN_WINDOW, OFF);
  assert.equal(r.live, false);
  assert.equal(r.reached, 1);
  assert.match(r.notes.join(), /Homebase: 2 of 2 .* would pause Homebase \+ SoCal, restart 2026-11-25/);
  assert.deepEqual(calls, []);
  assert.deepEqual(capWrites(), []);
  assert.deepEqual(bells(), []);
  assert.equal(camp("camp-a").status, "active");
});

test("without the switch, before the migration: still only reads, and the run doesn't fail", async () => {
  seed();
  atCap();
  db.missingTables.add("os_cap_windows");
  db.missingTables.add("os_cap_held_leads");
  const r = await run(IN_WINDOW, OFF);
  assert.deepEqual(r.errors, []);
  assert.equal(r.reached, 1);
});

test("switched off with campaigns waiting: nothing restarts, and the log says so every time", async () => {
  seed();
  atCap();
  await run();
  const r = await run(ET_9AM, OFF);
  assert.equal(camp("camp-a").status, "paused");
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), []);
  assert.match(r.notes.join(), /caps are off, so nothing restarts by itself: Homebase \+ SoCal/);
});

/* ------------------------------------------------------ who it applies to --- */

test("a client still in test: its target pauses nothing, and its campaigns and replies are left alone", async () => {
  seed({ settings: { test_only: true } });
  atCap();
  const r = await run();
  assert.equal(r.reached, 0);
  assert.equal(r.clients, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(capWrites(), []);
  assert.deepEqual(bells(), []);
  assert.equal(await caps.relayCapHook().overCap(asked("t-john")), null);
});

test("a client billed live with its automatic charge off is still capped: going live is what counts", async () => {
  seed({ settings: { enabled: false } });
  atCap();
  await run();
  assert.equal(camp("camp-a").status, "paused");
});

test("a lead counted some other way (calls, introductions): there is no reply to hold, so the cap doesn't act", async () => {
  seed({ settings: { lead_source: "introductions" } });
  atCap();
  const r = await run();
  assert.equal(r.reached, 0);
  assert.deepEqual(calls, []);
});

test("a restart it owes is still owed if the client went back to test meanwhile", async () => {
  seed();
  atCap();
  await run();
  db.rows("os_usage_billing_settings")[0].test_only = true;
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active");
});

/* ------------------------------------------------------------ the pause --- */

test("under the cap: nothing happens", async () => {
  seed();
  interested("john", "2026-11-04T00:29:00.000Z");
  const r = await run();
  assert.equal(r.reached, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(db.rows("os_cap_windows"), []);
  assert.deepEqual(bells(), []);
});

test("at the cap: running campaigns pause, are listed to restart, and the team is told once", async () => {
  seed();
  atCap();
  const r = await run();
  assert.equal(r.paused, 1);
  assert.equal(camp("camp-a").status, "paused");
  const [w] = db.rows("os_cap_windows");
  assert.equal(w.window_start, "2026-10-28");
  assert.equal(w.window_end, "2026-11-25");
  assert.deepEqual((w.paused as Row[]).map((c) => [c.id, c.confirmed]), [["camp-a", true]], "only what it paused: camp-b was paused already");
  assert.deepEqual(bells(), [`cap_reached:${HB}:2026-10-28`]);
  assert.match(String(db.rows("os_notifications")[0].body), /2 of 2 leads .* Paused Homebase \+ SoCal\. Campaigns it paused restart on Nov 25/);

  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(calls.length, 1, "nothing running: no second pause");
  assert.equal(bells().length, 1, "and nothing new to say");
});

test("at the cap with nothing running: recorded and said, and nothing is paused", async () => {
  seed();
  camp("camp-a").status = "paused";
  atCap();
  await run();
  assert.deepEqual(calls, []);
  assert.deepEqual(db.rows("os_cap_windows")[0].paused, []);
  assert.match(String(db.rows("os_notifications")[0].body), /No linked campaign was running/);
});

test("Homebase's own case: at the cap with a campaign paused by hand, the first bell names it and what to do; on the day, it says so again", async () => {
  seed();
  camp("camp-a").status = "paused"; // both paused by a person
  atCap();
  await run();
  assert.match(String(db.rows("os_notifications").find((n) => n.ref === `cap_reached:${HB}:2026-10-28`)!.body), /Homebase \+ SoCal, Homebase \+ Boston was already paused by hand, so it won't restart then unless you add it on the Billing tab/);
  await run(ET_8AM);
  assert.equal(bells().some((b) => b.startsWith("cap_still_paused")), false, "not before 9am");
  await run(ET_9AM);
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), [], "and it isn't restarted");
  assert.match(String(db.rows("os_notifications").find((n) => n.ref === `cap_still_paused:${HB}:2026-11-25`)!.body), /is still paused and isn't on the restart list, so the new window didn't restart it\. If it should be running, restart it from Client Health/);
  await run(new Date(ET_9AM.getTime() + 15 * 60_000));
  assert.equal(bells().filter((b) => b.startsWith("cap_still_paused")).length, 1, "once");
  await run(new Date("2026-11-26T15:00:00.000Z"));
  assert.equal(bells().filter((b) => b.startsWith("cap_still_paused")).length, 1, "and not again the next day");
});

test("paused by hand later in the new window: nothing to say, it isn't what the new window was going to restart", async () => {
  seed();
  camp("camp-b").status = "active";
  atCap();
  await run();
  await run(ET_9AM);
  assert.equal(bells().some((b) => b.startsWith("cap_still_paused")), false, "everything restarted");
  camp("camp-a").status = "paused"; // a person, the next day
  await run(new Date("2026-11-26T15:00:00.000Z"));
  assert.equal(bells().some((b) => b.startsWith("cap_still_paused")), false);
});

test("the new window's own pause isn't called something else, and neither is what the cap paused before", async () => {
  seed();
  atCap();
  await run();
  camp("camp-b").status = "active"; // running when the new window starts, and that window is at its cap straight away
  interested("a2", "2026-11-25T06:00:00.000Z");
  interested("b2", "2026-11-25T07:00:00.000Z");
  await run(ET_9AM);
  assert.equal(camp("camp-b").status, "paused");
  assert.equal(bells().some((b) => b.startsWith("cap_still_paused")), false);
});

test("'Don't restart it' pressed: the bell on the day doesn't blame anyone's hand or say to press Play", async () => {
  seed();
  atCap();
  await run();
  await caps.removeFromRestart(HB, await settings(), { platform: "bison", id: "camp-a" }, press);
  await run(ET_9AM);
  const said = db.rows("os_notifications").find((n) => n.ref === `cap_still_paused:${HB}:2026-11-25`)!;
  assert.doesNotMatch(String(said.body), /by hand|Press Play/);
  assert.match(String(said.body), /If it should be running, restart it from Client Health/);
});

test("a new window with no capped one before it: nothing to say about what is paused", async () => {
  seed();
  camp("camp-a").status = "paused";
  await run(ET_9AM);
  assert.equal(bells().some((b) => b.startsWith("cap_still_paused")), false);
});

test("the list is written before anything pauses: if it can't be, nothing pauses", async () => {
  seed();
  atCap();
  db.failWhen = ({ method, table }) => method !== "GET" && table === "os_cap_windows";
  const r = await run();
  db.failWhen = null;
  assert.equal(r.errors.length, 1);
  assert.deepEqual(calls, []);
  assert.equal(camp("camp-a").status, "active");
});

test("a campaign someone restarts while at the cap is paused again, and listed, and the team is told", async () => {
  seed();
  atCap();
  await run();
  camp("camp-a").status = "active";
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(camp("camp-a").status, "paused");
  assert.ok(bells().includes(`cap_repaused:${HB}:2026-11-05`));
  assert.deepEqual(listedIds(), ["camp-a"], "once");
});

test("a pause that fails: stays listed but unconfirmed, tried again, and the team is told it is still running, not 'none running'", async () => {
  seed();
  atCap();
  failPause = true;
  await run();
  assert.ok(bells().includes(`cap_pause_failed:${HB}:2026-11-05`));
  assert.equal(camp("camp-a").status, "active");
  const said = db.rows("os_notifications").find((n) => n.ref === `cap_reached:${HB}:2026-10-28`)!;
  assert.doesNotMatch(String(said.body), /No linked campaign was running/);
  assert.match(String(said.body), /Homebase \+ SoCal could not be paused/);
  assert.deepEqual((db.rows("os_cap_windows")[0].paused as Row[]).map((c) => c.confirmed), [false]);
  failPause = false;
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(camp("camp-a").status, "paused");
  assert.deepEqual((db.rows("os_cap_windows")[0].paused as Row[]).map((c) => c.confirmed), [true], "seen to pause now");
});

test("a campaign linked to another client too is left running, and the team is told who: its cap isn't that client's", async () => {
  seed();
  campaigns.get("ch-hb")!.push({ platform: "bison", id: "camp-c", int_id: 3, name: "Homebase + Texas", status: "active" });
  shared.set("bison:camp-a", ["Wagner Realty"]);
  atCap();
  await run();
  assert.equal(camp("camp-a").status, "active");
  assert.equal(camp("camp-c").status, "paused");
  assert.deepEqual(listedIds(), ["camp-c"], "not listed either: it never paused");
  const said = db.rows("os_notifications").find((n) => n.ref === `cap_shared:${HB}:2026-10-28`)!;
  assert.match(String(said.body), /Homebase \+ SoCal is also linked to Wagner Realty\. It was left running/);
});

test("a campaign whose status can't be read may be running: the team is told, including a status nobody has a word for", async () => {
  seed();
  camp("camp-a").status = "status 4";
  atCap();
  await run();
  assert.ok(bells().includes(`cap_status_unknown:${HB}:2026-11-05`));
  assert.doesNotMatch(String(db.rows("os_notifications").find((n) => n.ref === `cap_reached:${HB}:2026-10-28`)!.body), /No linked campaign was running/);
});

test("a spend limit stops it too: $500 at $250 is 2 leads, with no target at all", async () => {
  seed({ target: null, settings: { spend_cap_cents: 50_000 } });
  atCap();
  await run();
  assert.equal(camp("camp-a").status, "paused");
});

test("whichever comes first: a target of 5 and $500 stops at 2", async () => {
  seed({ target: 5, settings: { spend_cap_cents: 50_000 } });
  atCap();
  await run();
  assert.equal(camp("camp-a").status, "paused");
});

test("the price raised past the limit: not a cap of none. Nothing stops, and the team is told", async () => {
  seed({ target: null, settings: { spend_cap_cents: 20_000 } });
  const r = await run();
  assert.equal(r.reached, 0);
  assert.deepEqual(calls, []);
  assert.ok(bells().includes(`cap_spend_invalid:${HB}:2026-10-28`));
  assert.equal(await caps.relayCapHook().overCap(asked("t")), null);
});

test("no cap at all: never paused, however many leads", async () => {
  for (const target of [0, null]) {
    seed({ target });
    atCap();
    interested("kim", "2026-11-04T05:00:00.000Z");
    const r = await run();
    assert.equal(r.reached, 0);
    assert.deepEqual(calls, []);
  }
});

test("a churned or paused client is never paused from here", async () => {
  for (const status of ["churned", "paused"]) {
    seed({ status });
    atCap();
    await run();
    assert.deepEqual(calls, [], status);
  }
});

test("onboarding and billed live: paused like any other", async () => {
  seed({ status: "onboarding" });
  atCap();
  await run();
  assert.equal(camp("camp-a").status, "paused");
});

test("a read that fails is never 'no cap': nothing is done, the error is reported, and the team is told once a day", async () => {
  seed();
  atCap();
  chFails = true;
  const r = await run();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Client Health is down/);
  assert.deepEqual(calls, []);
  assert.deepEqual(bells(), [`cap_run_failed:${HB}:2026-11-05`]);
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(bells().length, 1);
});

test("in a dry run, a failed read goes in the log and tells nobody", async () => {
  seed();
  chFails = true;
  const r = await run(IN_WINDOW, OFF);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(bells(), []);
});

test("linked to a Client Health row that isn't there: an error, never 'no target'", async () => {
  seed();
  atCap();
  chMissing = true;
  const r = await run();
  assert.match(r.errors.join(), /Client Health has no row/);
  assert.deepEqual(calls, []);
  await assert.rejects(() => caps.relayCapHook().overCap(asked("t-john")), /no row/);
});

test("not linked to Client Health: the team is told its campaigns couldn't be paused", async () => {
  seed({ ch: null, settings: { spend_cap_cents: 50_000 } });
  atCap();
  await run();
  assert.ok(bells().includes(`cap_no_link:${HB}:2026-10-28`));
});

/* ---------------------------------------------------------- overlapping --- */

test("two runs overlapping: one that saw nothing to pause never wipes the list the other just wrote", async () => {
  seed();
  camp("camp-a").status = "paused"; // run A has paused it; run B reads it as already paused, and read no row before A wrote one
  atCap();
  db.rows("os_cap_windows").push({ os_client_id: HB, window_start: "2026-10-28", window_end: "2026-11-25", reached_at: null, paused: [{ platform: "bison", id: "camp-a", name: "A", paused_at: "x", confirmed: true }], restarted_at: null, updated_at: "2026-11-05T14:59:00.000Z" });
  await run();
  assert.deepEqual(listedIds(), ["camp-a"]);
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active", "so it still restarts");
});

test("a write that loses the race reads again and merges: neither side's campaign is lost", async () => {
  seed();
  camp("camp-a").status = "paused";
  atCap();
  await run();
  const row = db.rows("os_cap_windows")[0];
  let raced = false;
  db.failWhen = ({ method, table }) => {
    if (method === "PATCH" && table === "os_cap_windows" && !raced) {
      raced = true;
      row.paused = [...(row.paused as Row[]), { platform: "bison", id: "camp-z", name: "Z", paused_at: "x", confirmed: true }];
      row.updated_at = "2099-01-01T00:00:00.000Z";
    }
    return false;
  };
  await caps.addToRestart(HB, await settings(), { platform: "bison", id: "camp-a" }, press);
  db.failWhen = null;
  assert.equal(raced, true);
  assert.deepEqual(listedIds().sort(), ["camp-a", "camp-z"]);
});

test("the row appearing between reading and writing: goes round again and keeps both", async () => {
  seed();
  atCap();
  let raced = false;
  db.failWhen = ({ method, table }) => {
    if (method === "POST" && table === "os_cap_windows" && !raced) {
      raced = true;
      db.rows("os_cap_windows").push({ os_client_id: HB, window_start: "2026-10-28", window_end: "2026-11-25", reached_at: "x", paused: [{ platform: "bison", id: "camp-z", name: "Z", paused_at: "x", confirmed: true }], restarted_at: null, updated_at: "2026-11-05T14:59:00.000Z" });
    }
    return false;
  };
  await run();
  db.failWhen = null;
  assert.equal(raced, true);
  assert.deepEqual(listedIds().sort(), ["camp-a", "camp-z"]);
  assert.equal(camp("camp-a").status, "paused");
});

test("a row that won't hold still: gives up in words, and nothing has paused", async () => {
  seed();
  atCap();
  db.rows("os_cap_windows").push({ os_client_id: HB, window_start: "2026-10-28", window_end: "2026-11-25", reached_at: null, paused: [], restarted_at: null, updated_at: "2026-11-05T14:59:00.000Z" });
  let n = 0;
  db.failWhen = ({ method, table }) => {
    if (method === "PATCH" && table === "os_cap_windows") db.rows("os_cap_windows")[0].updated_at = `2099-01-01T00:00:0${n++}.000Z`;
    return false;
  };
  const r = await run();
  db.failWhen = null;
  assert.match(r.errors.join(), /kept changing/);
  assert.deepEqual(calls, []);
});

/* ---------------------------------------------------------- the restart --- */

const ET_8AM = new Date("2026-11-25T13:00:00.000Z"); // 8am Eastern, Nov 25
const ET_9AM = new Date("2026-11-25T14:00:00.000Z");

test("restart: on the new window's first day from 9am Eastern, and exactly what it paused", async () => {
  seed();
  atCap();
  await run();
  await run(ET_8AM);
  assert.equal(camp("camp-a").status, "paused", "not before 9am");
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active");
  assert.equal(camp("camp-b").status, "paused", "the one a person paused stays paused");
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), ["resume ch-hb camp-a by lead cap"]);
  assert.ok(db.rows("os_cap_windows")[0].restarted_at);
  assert.ok(bells().includes(`cap_restarted:${HB}:2026-11-25`));
  await run(new Date(ET_9AM.getTime() + 15 * 60_000));
  assert.equal(calls.filter((c) => c.startsWith("resume")).length, 1, "once");
});

test("restart: already at the cap in the new window, it waits for the next one and the list survives", async () => {
  seed();
  atCap();
  await run();
  interested("a2", "2026-11-25T06:00:00.000Z");
  interested("b2", "2026-11-25T07:00:00.000Z");
  await run(ET_9AM);
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), []);
  assert.equal(camp("camp-a").status, "paused");
  const next = db.rows("os_cap_windows").find((r) => r.window_start === "2026-11-25")!;
  assert.deepEqual((next.paused as Row[]).map((c) => [c.id, c.confirmed]), [["camp-a", true]], "carried, and still its to restart");
  assert.ok(next.reached_at);
  await run(new Date("2026-12-23T14:00:00.000Z"));
  assert.equal(camp("camp-a").status, "active");
});

test("restart: a client paused or churned since stays paused, and the team is told", async () => {
  seed();
  atCap();
  await run();
  db.rows("os_clients")[0].status = "churned";
  await run(ET_9AM);
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), []);
  assert.equal(camp("camp-a").status, "paused");
  assert.ok(bells().includes(`cap_not_restarted:${HB}:2026-11-25`));
  assert.ok(db.rows("os_cap_windows")[0].restarted_at, "closed: it does not come back by itself later");
});

test("restart that fails: kept, tried again, and the team is told", async () => {
  seed();
  atCap();
  await run();
  failResume = true;
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  assert.equal(db.rows("os_cap_windows")[0].restarted_at ?? null, null);
  assert.ok(bells().includes(`cap_restart_failed:${HB}:2026-11-25`));
  failResume = false;
  await run(new Date(ET_9AM.getTime() + 15 * 60_000));
  assert.equal(camp("camp-a").status, "active");
  assert.ok(db.rows("os_cap_windows")[0].restarted_at);
});

test("a campaign that finished or was restarted meanwhile: nothing to do, and the window closes", async () => {
  seed();
  atCap();
  await run();
  camp("camp-a").status = "completed";
  await run(ET_9AM);
  assert.ok(db.rows("os_cap_windows")[0].restarted_at);
  assert.equal(camp("camp-a").status, "completed");
});

test("the cap removed mid-window: the waiting campaigns still restart at the window, not sooner", async () => {
  seed();
  atCap();
  await run();
  targets.set("ch-hb", 0);
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(camp("camp-a").status, "paused");
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active");
});

test("back under the cap, a person presses Play: it is theirs again. Paused by hand later, it stays paused at the window", async () => {
  seed();
  atCap();
  await run();
  targets.set("ch-hb", 5);
  camp("camp-a").status = "active"; // Play on Client Health
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.deepEqual(listedIds(), [], "dropped when seen running");
  assert.equal(camp("camp-a").status, "active", "and left running");
  camp("camp-a").status = "paused"; // and a person pauses it by hand
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), []);
});

test("a pause that failed, then a person pausing it by hand as the bell said: not restarted, and the team is told it stayed paused", async () => {
  seed();
  atCap();
  failPause = true;
  await run();
  assert.match(String(db.rows("os_notifications").find((n) => n.ref === `cap_pause_failed:${HB}:2026-11-05`)!.body), /stays paused at the new window unless you add it/);
  failPause = false;
  camp("camp-a").status = "paused"; // by hand
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  assert.deepEqual(calls.filter((c) => c.startsWith("resume")), []);
  assert.ok(bells().includes(`cap_unconfirmed:${HB}:2026-11-25`));
  assert.ok(db.rows("os_cap_windows")[0].restarted_at);
});

test("paused, a person presses Play at the cap, the pause again fails, and a person pauses it by hand: it doesn't restart", async () => {
  seed();
  atCap();
  await run();
  camp("camp-a").status = "active";
  failPause = true;
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.deepEqual((db.rows("os_cap_windows")[0].paused as Row[]).map((c) => c.confirmed), [false], "running now: no longer confirmed paused");
  failPause = false;
  camp("camp-a").status = "paused";
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  assert.ok(bells().includes(`cap_unconfirmed:${HB}:2026-11-25`));
});

test("a confirmed campaign that can't be restarted for any other reason (unlinked, a status with no way back): the team is told, never a silent stay", async () => {
  for (const [status, words] of [["not linked", /is no longer linked to this client, so it wasn't restarted\. Check which client/], ["stopped", /\(stopped\) stays paused/]] as const) {
    seed();
    atCap();
    await run();
    const realSkip = camp("camp-a");
    realSkip.status = status;
    await run(ET_9AM);
    assert.equal(realSkip.status, status);
    const said = db.rows("os_notifications").find((n) => n.ref === `cap_restart_lost:${HB}:2026-11-25`);
    assert.ok(said, status);
    assert.match(String(said.body), /Homebase \+ SoCal/);
    assert.match(String(said.body), words);
    assert.ok(db.rows("os_cap_windows")[0].restarted_at, "closed");
  }
});

test("a confirmed campaign finished or deleted meanwhile: nothing to say", async () => {
  for (const status of ["completed", "deleted"]) {
    seed();
    atCap();
    await run();
    camp("camp-a").status = status;
    await run(ET_9AM);
    assert.equal(bells().some((b) => b.startsWith("cap_restart_lost")), false, status);
  }
});

test("the pause not recorded as seen (a crash after it went): same thing, never a silent restart or a silent stay", async () => {
  seed();
  atCap();
  let wrote = 0;
  db.failWhen = ({ method, table }) => method !== "GET" && table === "os_cap_windows" && ++wrote === 2;
  const r = await run();
  db.failWhen = null;
  assert.equal(r.errors.length, 1, "the confirming write failed");
  assert.equal(camp("camp-a").status, "paused");
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  assert.ok(bells().includes(`cap_unconfirmed:${HB}:2026-11-25`));
});

/* ------------------------------------------------- the hand-off's hook --- */

const asked = (thread: string, at = "2026-11-05T15:00:00.000Z", o: { now?: Date; pressed?: boolean } = {}) => ({ osClientId: HB, threadId: thread, at, now: o.now ?? new Date(at), pressed: o.pressed ?? false });

test("the third reply is over; the first two aren't", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  const hook = caps.relayCapHook();
  assert.equal(await hook.overCap(asked("t-john")), null);
  assert.equal(await hook.overCap(asked("t-ram")), null);
  const over = await hook.overCap(asked(third));
  assert.deepEqual(over, { cap: 2, used: 3, window: { start: "2026-10-28", end: "2026-11-25" } });
});

test("a held reply, asked about again, is still over. It isn't in the count, and that must never read as room", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: "x", released_at: null, agent_name: "Kim" });
  const over = await caps.relayCapHook().overCap(asked(third));
  assert.deepEqual(over, { cap: 2, used: 2, window: { start: "2026-10-28", end: "2026-11-25" } });
  targets.set("ch-hb", 0);
  assert.ok(await caps.relayCapHook().overCap(asked(third)), "even with the cap gone: only a person's press moves it");
  targets.set("ch-hb", 10);
  assert.ok(await caps.relayCapHook().overCap(asked(third, "2026-12-15T15:00:00.000Z")), "or a new window");
});

test("a client not on pay per lead: no cap, and nothing more is read", async () => {
  seed();
  db.calls.length = 0;
  assert.equal(await caps.relayCapHook().overCap({ ...asked("t"), osClientId: "20000000-0000-4000-8000-000000000999" }), null);
  assert.deepEqual([...new Set(db.calls.map((c) => c.table))], ["os_usage_billing_settings"]);
});

test("a churned client: no cap read as over, its replies go wherever the relay sends them", async () => {
  seed({ status: "churned" });
  atCap();
  interested("kim", "2026-11-05T14:00:00.000Z");
  assert.equal(await caps.relayCapHook().overCap(asked("t-kim")), null);
});

test("switched on before the SQL: the hand-off holds, in words, rather than reading 'nothing held'", async () => {
  seed();
  atCap();
  db.missingTables.add("os_cap_held_leads");
  await assert.rejects(() => caps.relayCapHook().overCap(asked("t-john")), /migration 0049 hasn't been run/);
});

test("a cap that can't be read throws, so the hand-off holds instead of sending", async () => {
  seed();
  atCap();
  chFails = true;
  await assert.rejects(() => caps.relayCapHook().overCap(asked("t-john")), /Client Health is down/);
});

test("holding a reply: recorded, moved to Keep Warm, the team told, once", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  const hook = caps.relayCapHook();
  const over = (await hook.overCap(asked(third)))!;
  const p = { osClientId: HB, clientName: "Homebase", relayId: "r1", threadId: third, agentName: "Kim", agentEmail: "kim@x.test", over, workspaceId: WS };
  await hook.hold(p);
  await hook.hold(p);
  assert.equal(db.rows("os_cap_held_leads").length, 1);
  assert.deepEqual(labelled[0], { threadId: third, labelId: "lab-warm" });
  assert.ok(db.rows("os_cap_held_leads")[0].labelled_at);
  assert.deepEqual(bells(), [`cap_held:${third}`]);
  assert.match(String(db.rows("os_notifications")[0].body), /Kim replied after Homebase reached its cap of 2 leads\. It was not sent to the client and not charged, and is in Keep Warm\. .* reopens on Nov 25/);
});

test("the label failing doesn't stop the hold; the team is told and the run tries again", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  const hook = caps.relayCapHook();
  const over = (await hook.overCap(asked(third)))!;
  labelFails = true;
  await hook.hold({ osClientId: HB, clientName: "Homebase", relayId: "r1", threadId: third, agentName: "Kim", agentEmail: "kim@x.test", over, workspaceId: WS });
  assert.equal(db.rows("os_cap_held_leads")[0].labelled_at ?? null, null);
  assert.ok(bells().some((b) => b.startsWith(`cap_label:${third}`)));
  labelFails = false;
  await run();
  assert.ok(db.rows("os_cap_held_leads")[0].labelled_at);
  assert.deepEqual(labelled.at(-1), { threadId: third, labelId: "lab-warm" });
});

test("a person has since given it another label: a retry never writes Keep Warm over their decision", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: null, released_at: null });
  db.seed("label_assignments", [...db.rows("label_assignments").filter((a) => a.target_id !== third), { label_id: "lab-unsub", target_type: "thread", target_id: third, assigned_at: "2026-11-05T14:30:00.000Z" }]);
  await run();
  assert.deepEqual(labelled, []);
  assert.ok(db.rows("os_cap_held_leads")[0].labelled_at, "and it stops trying");
});

test("a record held over the cap whose hold never finished: the run finishes it", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_brokerage_relays").push({ id: "r9", workspace_id: WS, os_client_id: HB, thread_id: third, status: "held", reason: "over_cap", kind: "handoff", agent_name: "Kim", agent_email: "kim@x.test", brokerage_name: "Homebase" });
  await run();
  assert.deepEqual(db.rows("os_cap_held_leads").map((h) => [h.thread_id, h.relay_id, h.window_start]), [[third, "r9", "2026-10-28"]]);
  assert.deepEqual(labelled, [{ threadId: third, labelId: "lab-warm" }]);
  assert.ok(bells().includes(`cap_held:${third}`));
});

test("a held reply stops counting; the press itself is let through", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  const fourth = interested("lee", "2026-11-05T15:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "2026-11-05T14:01:00.000Z", labelled_at: "x", released_at: null, agent_name: "Kim" });
  assert.ok(await caps.relayCapHook().overCap(asked(fourth)), "still over: two others are within the cap");
  db.rows("os_cap_held_leads")[0].released_at = "2026-11-25T15:00:00.000Z";
  assert.equal(await caps.relayCapHook().overCap(asked(third, "2026-11-05T14:00:00.000Z", { pressed: true, now: IN_WINDOW })), null);
});

test("pressed but not gone yet, looked at again: goes if there is room now, in whatever window it is now", async () => {
  seed();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: "x", released_at: "2026-11-05T14:30:00.000Z" });
  assert.equal(await caps.relayCapHook().overCap(asked(third, "2026-11-05T14:00:00.000Z", { now: IN_WINDOW })), null, "room");
  atCap();
  assert.deepEqual(await caps.relayCapHook().overCap(asked(third, "2026-11-05T14:00:00.000Z", { now: IN_WINDOW })), { cap: 2, used: 2, window: { start: "2026-10-28", end: "2026-11-25" } }, "filled up since");
  assert.equal(await caps.relayCapHook().overCap(asked(third, "2026-11-05T14:00:00.000Z", { now: new Date("2026-11-26T15:00:00.000Z") })), null, "a new window has room");
});

test("held again after a press: not released any more, back in Keep Warm, and the team is told what happened", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: "x", released_at: "2026-11-05T14:30:00.000Z", released_by: "amy@x.test" });
  const over = { cap: 2, used: 2, window: { start: "2026-10-28", end: "2026-11-25" } };
  await caps.relayCapHook().hold({ osClientId: HB, clientName: "Homebase", relayId: "r1", threadId: third, agentName: "Kim", agentEmail: "kim@x.test", over, workspaceId: WS });
  const h = db.rows("os_cap_held_leads")[0];
  assert.equal(h.released_at, null);
  assert.equal(h.released_by, null);
  assert.ok(h.labelled_at);
  assert.deepEqual(labelled.at(-1), { threadId: third, labelId: "lab-warm" });
  const said = db.rows("os_notifications").find((n) => String(n.ref).startsWith(`cap_reheld:${third}`))!;
  assert.match(String(said.body), /Kim's reply was pressed to send but couldn't go then, and Homebase has since reached its cap of 2 leads/);
});

test("a press that died partway and was left: back to waiting after ten minutes, where it shows and can be pressed. Not before", async () => {
  seed();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_brokerage_relays").push({ id: "r9", workspace_id: WS, os_client_id: HB, thread_id: third, status: "held", reason: "over_cap", kind: "handoff" });
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: "x", released_at: new Date(IN_WINDOW.getTime() - 60_000).toISOString(), released_by: "amy@x.test" });
  await run();
  assert.ok(db.rows("os_cap_held_leads")[0].released_at, "a press may be under way");
  await run(new Date(IN_WINDOW.getTime() + 15 * 60_000));
  assert.equal(db.rows("os_cap_held_leads")[0].released_at, null);
  assert.deepEqual(labelled.at(-1), { threadId: third, labelId: "lab-warm" });
});

test("holds are finished even when Client Health is down, since they don't need the cap", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_brokerage_relays").push({ id: "r9", workspace_id: WS, os_client_id: HB, thread_id: third, status: "held", reason: "over_cap", kind: "handoff", agent_name: "Kim", brokerage_name: "Homebase" });
  chFails = true;
  await run();
  assert.deepEqual(db.rows("os_cap_held_leads").map((h) => h.thread_id), [third]);
  assert.match(String(db.rows("os_notifications").find((n) => n.ref === `cap_held:${third}`)!.body), /Kim replied after Homebase reached its cap\. It was not sent/);
  const p = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-11-11T15:00:00.000Z"), periodStart: PERIOD_START });
  assert.equal(p.amountCents, 50_000);
});

test("a conversation with a Pipeline entry is held but keeps its label: a swap would delete the entry and the client's notes", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("client_pipeline_entries").push({ id: "e1", thread_id: third, client_id: PORTAL, lead_email: "kim@x.test" });
  const over = { cap: 2, used: 3, window: { start: "2026-10-28", end: "2026-11-25" } };
  await caps.relayCapHook().hold({ osClientId: HB, clientName: "Homebase", relayId: "r1", threadId: third, agentName: "Kim", agentEmail: "kim@x.test", over, workspaceId: WS });
  assert.deepEqual(labelled, []);
  assert.ok(db.rows("os_cap_held_leads")[0].labelled_at);
  assert.match(String(db.rows("os_notifications").find((n) => n.ref === `cap_held:${third}`)!.body), /not charged, and keeps the label it has/);
});

test("a conversation a person has cleared of labels isn't given Keep Warm by a retry", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: null, released_at: null });
  db.seed("label_assignments", db.rows("label_assignments").filter((a) => a.target_id !== third));
  await run();
  assert.deepEqual(labelled, []);
});

test("sending a held reply: refused at the cap, in words; allowed with room", async () => {
  seed();
  atCap();
  const hook = caps.relayCapHook();
  assert.match(String(await hook.roomFor({ osClientId: HB, now: IN_WINDOW })), /Homebase is at its cap \(2 of 2\) until Nov 25, so this wasn't sent/);
  targets.set("ch-hb", 3);
  assert.equal(await hook.roomFor({ osClientId: HB, now: IN_WINDOW }), null, "cap raised");
  targets.set("ch-hb", 2);
  assert.equal(await hook.roomFor({ osClientId: HB, now: new Date("2026-11-26T15:00:00.000Z") }), null, "the new window");
});

test("a press again, after one that died: stamped afresh, so the clean-up of dead presses leaves it alone", async () => {
  seed();
  db.rows("os_cap_held_leads").push({ thread_id: "t1", os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: null });
  const hook = caps.relayCapHook();
  await hook.markReleased({ threadId: "t1", who: "amy@x.test", now: new Date("2026-11-26T15:00:00.000Z") });
  await hook.markReleased({ threadId: "t1", who: "eddy@x.test", now: new Date("2026-11-27T15:00:00.000Z") });
  assert.equal(db.rows("os_cap_held_leads")[0].released_by, "eddy@x.test");
  assert.equal(db.rows("os_cap_held_leads")[0].released_at, "2026-11-27T15:00:00.000Z");
});

test("the clean-up of a dead press loses the race to a new press: the new press stands", async () => {
  seed();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_brokerage_relays").push({ id: "r9", workspace_id: WS, os_client_id: HB, thread_id: third, status: "held", reason: "over_cap", kind: "handoff" });
  const row = { thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", labelled_at: "x", released_at: new Date(IN_WINDOW.getTime() - 60 * 60_000).toISOString(), released_by: "amy@x.test" };
  db.rows("os_cap_held_leads").push(row);
  // Someone presses between the run reading the row and writing to it.
  db.failWhen = ({ method, table }) => {
    if (method === "PATCH" && table === "os_cap_held_leads" && row.released_by === "amy@x.test") { row.released_at = IN_WINDOW.toISOString(); row.released_by = "eddy@x.test"; }
    return false;
  };
  await run();
  db.failWhen = null;
  assert.equal(row.released_at, IN_WINDOW.toISOString());
  assert.equal(row.released_by, "eddy@x.test");
});

/* ------------------------------------------------------- what is billed --- */

const PERIOD_START = "2026-10-28";
const settings = async () => (await billing.loadSettings(HB))!;
const sentRecord = (thread: string, sent_at: string, status = "sent") => db.rows("os_brokerage_relays").push({ id: `rec-${thread}`, workspace_id: WS, os_client_id: HB, thread_id: thread, kind: "handoff", status, sent_at, practice: false });

test("billing: a held reply isn't on the invoice", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: null });
  const p = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-11-11T15:00:00.000Z"), periodStart: PERIOD_START });
  assert.deepEqual(p.leads.map((l) => l.name), ["john", "ram"]);
  assert.equal(p.amountCents, 50_000);
});

test("billing: a released reply is billed when it really went, in that period, never the closed one it was marked in", async () => {
  seed();
  atCap();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: "2026-11-25T15:00:00.000Z" });
  sentRecord(third, "2026-11-25T15:00:05.000Z");
  const early = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-11-11T15:00:00.000Z"), periodStart: PERIOD_START });
  assert.deepEqual(early.leads.map((l) => l.name), ["john", "ram"]);
  const later = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-12-10T15:00:00.000Z"), periodStart: "2026-11-25" });
  assert.deepEqual(later.leads.map((l) => l.name), ["kim"]);
  assert.equal(later.leads[0].at, "2026-11-25T15:00:05.000Z");
  assert.equal(later.leads[0].thread, third);
});

test("billing: pressed but it never went (the client's own agent, a hold, practice, a refusal): nothing to charge for", async () => {
  for (const status of ["skipped", "held", "practice", "ready", "failed", "sending"]) {
    seed();
    const third = interested("kim", "2026-11-05T14:00:00.000Z");
    db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: "2026-11-25T15:00:00.000Z" });
    sentRecord(third, "2026-11-25T15:00:05.000Z", status);
    const later = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-12-10T15:00:00.000Z"), periodStart: "2026-11-25" });
    assert.deepEqual(later.leads, [], status);
  }
});

test("billing: the hand-off record can't be read: stops the count, never read as 'never went'", async () => {
  seed();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: "2026-11-25T15:00:00.000Z" });
  db.failWhen = ({ table }) => table === "os_brokerage_relays";
  await assert.rejects(() => leads.billableLeads(HB, "2026-11-25", "2026-12-09", "handoffs", { startDate: "2026-10-28" }), /os_brokerage_relays/);
  db.failWhen = null;
});

test("billing: a released reply a person then corrected to a 'no' isn't billed", async () => {
  seed();
  const third = interested("kim", "2026-11-05T14:00:00.000Z");
  db.rows("os_cap_held_leads").push({ thread_id: third, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: "2026-11-25T15:00:00.000Z" });
  sentRecord(third, "2026-11-25T15:00:05.000Z");
  db.seed("label_assignments", [{ label_id: "lab-no", target_type: "thread", target_id: third, assigned_at: "2026-11-26T15:00:00.000Z" }]);
  const later = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-12-10T15:00:00.000Z"), periodStart: "2026-11-25" });
  assert.deepEqual(later.leads, []);
});

test("billing: an agent already billed uses none of a later window's cap", async () => {
  seed();
  db.rows("os_usage_billing_periods").push({ os_client_id: HB, period_start: "2026-10-28", period_end: "2026-11-11", status: "paid", test_mode: false, leads: [{ key: "john@x.test", name: "john", at: "2026-11-04T00:29:00.000Z", source: "interested" }] });
  interested("john", "2026-11-26T00:29:00.000Z", "t-john-again");
  interested("ram", "2026-11-26T04:07:00.000Z");
  const r = await run(new Date("2026-11-27T15:00:00.000Z"));
  assert.equal(r.reached, 0, "one new lead of two");
});

test("billing: before the migration the invoice reads as ever", async () => {
  seed();
  atCap();
  db.missingTables.add("os_cap_held_leads");
  const p = await billing.previewPeriod(HB, await settings(), { now: new Date("2026-11-11T15:00:00.000Z"), periodStart: PERIOD_START });
  assert.equal(p.count, 2);
});

test("billing: the table failing any other way stops the count, it is never read as 'none held'", async () => {
  seed();
  atCap();
  db.failWhen = ({ table }) => table === "os_cap_held_leads";
  await assert.rejects(() => leads.billableLeads(HB, "2026-10-28", "2026-11-11", "handoffs", { startDate: "2026-10-28" }), /os_cap_held_leads/);
  db.failWhen = () => false;
  db.failWhen = ({ table }) => (table === "os_cap_held_leads" ? { code: "55P03", message: 'could not obtain lock on relation "os_cap_held_leads"' } : false);
  await assert.rejects(() => leads.billableLeads(HB, "2026-10-28", "2026-11-11", "handoffs", { startDate: "2026-10-28" }), /could not obtain lock/);
  db.failWhen = null;
});

test("a lock on the window table isn't 'no rows': nothing is written over them", async () => {
  seed();
  atCap();
  db.failWhen = ({ method, table }) => (method === "GET" && table === "os_cap_windows" ? { code: "55P03", message: 'could not obtain lock on relation "os_cap_windows"' } : false);
  const r = await run();
  db.failWhen = null;
  assert.match(r.errors.join(), /could not obtain lock/);
  assert.deepEqual(calls, []);
});

/* ------------------------------------------------- what people press --- */

test("the spend limit: saved alone, never moving the price or schedule", async () => {
  seed();
  const s = await settings();
  db.calls.length = 0;
  await caps.setSpendCap(HB, s, "1,000", "amy@x.test");
  const write = db.writes("os_usage_billing_settings", "PATCH")[0];
  assert.deepEqual(Object.keys(write.body as Row).sort(), ["spend_cap_cents", "updated_at", "updated_by"]);
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, 100_000);
  await caps.setSpendCap(HB, s, "", "amy@x.test");
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, null);
  await assert.rejects(() => caps.setSpendCap(HB, s, "100", "amy@x.test"), /less than one lead/);
});

test("the spend limit before the migration: says so, and the tab still reads", async () => {
  seed();
  db.failWhen = ({ table, query, method }) => table === "os_usage_billing_settings" && ((query.get("select") ?? "").includes("spend_cap_cents") || method === "PATCH") ? { code: "42703", message: "column os_usage_billing_settings.spend_cap_cents does not exist", status: 400 } : false;
  db.missingTables.add("os_cap_windows");
  db.missingTables.add("os_cap_held_leads");
  const v = await caps.capView(HB, await settings(), OFF, IN_WINDOW);
  assert.equal(v.canSaveSpend, false);
  assert.equal(v.cap, 2);
  await assert.rejects(() => caps.setSpendCap(HB, settingsSync(), "1000", "a"), /needs database migration 0049/);
  db.failWhen = null;
});
const settingsSync = () => db.rows("os_usage_billing_settings")[0] as never;

test("the settings read itself never asks for the new column: billing keeps working before the migration", async () => {
  seed();
  db.calls.length = 0;
  await billing.loadSettings(HB);
  assert.equal(db.calls.some((c) => (c.query.get("select") ?? "").includes("spend_cap_cents")), false);
});

test("the view: at the cap, what restarts, what a person paused, and who is held", async () => {
  seed();
  atCap();
  await run();
  db.rows("os_cap_held_leads").push({ thread_id: "t9", os_client_id: HB, window_start: "2026-10-28", held_at: "2026-11-05T14:01:00.000Z", released_at: null, agent_name: "Kim" });
  const v = await caps.capView(HB, await settings(), ON, IN_WINDOW);
  assert.equal(v.live, true);
  assert.equal(v.notActing, null);
  assert.equal(v.reached, true);
  assert.equal(v.used, 2);
  assert.equal(v.restartsToday, false);
  assert.deepEqual(v.window, { start: "2026-10-28", end: "2026-11-25", label: v.window!.label });
  assert.deepEqual(v.waiting.map((c) => c.id), ["camp-a"]);
  assert.deepEqual(v.pausedOtherwise.map((c) => c.id), ["camp-b"]);
  assert.deepEqual(v.held, [{ threadId: "t9", name: "Kim", at: "2026-11-05T14:01:00.000Z" }]);
  assert.equal(v.restartsByItself, true);
});

test("the view: says whether replies are held. Pause and resume only, they aren't", async () => {
  seed();
  atCap();
  assert.equal((await caps.capView(HB, await settings(), ON, IN_WINDOW)).holding, false);
  assert.equal((await caps.capView(HB, await settings(), { ...ON, OS_LEAD_CAPS_HOLD: "1" }, IN_WINDOW)).holding, true);
});

test("pause and resume only, a client not linked to Client Health: the bell doesn't claim replies are held", async () => {
  seed({ ch: null, settings: { spend_cap_cents: 50_000 } });
  atCap();
  await run();
  const said = String(db.rows("os_notifications").find((n) => n.ref === `cap_no_link:${HB}:2026-10-28`)!.body);
  assert.match(said, /still go to the client, and are billed/);
  assert.doesNotMatch(said, /held/);
});

test("the view: a held reply a person has since declined is decided, and no longer listed as waiting", async () => {
  seed();
  atCap();
  const kim = interested("kim", "2026-11-05T14:00:00.000Z");
  const lee = interested("lee", "2026-11-05T15:00:00.000Z");
  for (const t of [kim, lee]) db.rows("os_cap_held_leads").push({ thread_id: t, os_client_id: HB, window_start: "2026-10-28", held_at: "x", released_at: null, agent_name: t });
  db.seed("label_assignments", [...db.rows("label_assignments").filter((a) => a.target_id !== kim), { label_id: "lab-no", target_type: "thread", target_id: kim, assigned_at: "2026-11-05T16:00:00.000Z" }]);
  assert.deepEqual((await caps.capView(HB, await settings(), ON, IN_WINDOW)).held.map((h) => h.threadId), [lee]);
});

test("the view: no cap still shows how many, and what is waiting says whether it restarts by itself", async () => {
  seed({ target: 0 });
  atCap();
  assert.equal((await caps.capView(HB, await settings(), ON, IN_WINDOW)).used, 2);
  seed();
  atCap();
  await run();
  assert.equal((await caps.capView(HB, await settings(), OFF, IN_WINDOW)).restartsByItself, false, "switched off");
  db.rows("os_clients")[0].status = "paused";
  assert.equal((await caps.capView(HB, await settings(), ON, IN_WINDOW)).restartsByItself, false, "a paused client");
});

test("the view: an unconfirmed campaign isn't promised a restart; it shows as paused, for a person to add", async () => {
  seed();
  atCap();
  camp("camp-a").status = "paused";
  db.rows("os_cap_windows").push({ os_client_id: HB, window_start: "2026-10-28", window_end: "2026-11-25", reached_at: "x", paused: [{ platform: "bison", id: "camp-a", name: "A", paused_at: "x", confirmed: false }], restarted_at: null, updated_at: "x" });
  const v = await caps.capView(HB, await settings(), ON, IN_WINDOW);
  assert.deepEqual(v.waiting, []);
  assert.deepEqual(v.pausedOtherwise.map((c) => c.id).sort(), ["camp-a", "camp-b"]);
});

test("the view: a test client says why it isn't acting, and never says it's at its cap", async () => {
  seed({ settings: { test_only: true } });
  atCap();
  const v = await caps.capView(HB, await settings(), ON, IN_WINDOW);
  assert.match(String(v.notActing), /billing is still in test/);
  assert.equal(v.used, 2);
  assert.equal(v.reached, false);
});

test("the view: a churned client says so; a limit that can't be met says so", async () => {
  seed({ status: "churned" });
  assert.match(String((await caps.capView(HB, await settings(), ON, IN_WINDOW)).notActing), /is churned/);
  seed({ settings: { spend_cap_cents: 20_000 } });
  // loadSettings doesn't read the limit; capInputs does.
  assert.equal((await caps.capView(HB, await settings(), ON, IN_WINDOW)).spendInvalid, true);
});

test("the view: no cap and a count that can't be read: the panel stays, so a spend limit can still be set. With a cap, it's an error", async () => {
  seed({ target: 0 });
  db.rows("os_clients")[0].mi_client_id = null;
  db.seed("clients", []);
  const v = await caps.capView(HB, await settings(), ON, IN_WINDOW);
  assert.equal(v.used, null);
  assert.equal(v.reached, false);
  assert.equal(v.canSaveSpend, true);
  targets.set("ch-hb", 2);
  await assert.rejects(() => caps.capView(HB, settingsSync(), ON, IN_WINDOW));
});

test("the view: owed from an earlier window, it restarts today rather than promising the next window", async () => {
  seed();
  atCap();
  await run();
  const v = await caps.capView(HB, await settings(), ON, ET_8AM);
  assert.equal(v.restartsToday, true);
  assert.deepEqual(v.waiting.map((c) => c.id), ["camp-a"]);
});

test("adding a hand-paused campaign to the restart: Homebase's own case", async () => {
  seed();
  camp("camp-a").status = "paused";
  atCap();
  await run();
  await caps.addToRestart(HB, await settings(), { platform: "bison", id: "camp-a" }, press);
  assert.deepEqual(db.rows("os_cap_windows")[0].paused && (db.rows("os_cap_windows")[0].paused as Row[]).map((c) => [c.id, c.confirmed]), [["camp-a", true]]);
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active");
  assert.equal(camp("camp-b").status, "paused");
});

test("adding to the restart: only a linked, paused campaign, only at the cap", async () => {
  seed();
  const s = await settings();
  await assert.rejects(() => caps.addToRestart(HB, s, { platform: "bison", id: "camp-b" }, press), /isn't at its cap/);
  atCap();
  await assert.rejects(() => caps.addToRestart(HB, s, { platform: "bison", id: "someone-elses" }, press), /isn't linked/);
  await assert.rejects(() => caps.addToRestart(HB, s, { platform: "bison", id: "camp-a" }, press), /is active, not paused/);
});

test("'Don't restart it': off the list, and it stays paused at the window", async () => {
  seed();
  atCap();
  await run();
  await caps.removeFromRestart(HB, await settings(), { platform: "bison", id: "camp-a" }, press);
  assert.deepEqual(listedIds(), []);
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "paused");
  await assert.rejects(() => caps.removeFromRestart(HB, settingsSync(), { platform: "bison", id: "camp-a" }, press), /isn't waiting to restart/);
});

test("restart now: refused at the cap; once the cap is raised, exactly what is listed", async () => {
  seed();
  atCap();
  await run();
  const s = await settings();
  await assert.rejects(() => caps.restartNow(HB, s, "amy@x.test", press), /at its cap/);
  assert.equal(camp("camp-a").status, "paused");
  targets.set("ch-hb", 4);
  assert.deepEqual(await caps.restartNow(HB, s, "amy@x.test", press), { restarted: 1 });
  assert.equal(camp("camp-a").status, "active");
  assert.equal(camp("camp-b").status, "paused");
  assert.ok(db.rows("os_cap_windows")[0].restarted_at);
  // Reached again later in the same window: paused and listed afresh, not the old list.
  interested("c3", "2026-11-06T00:00:00.000Z");
  interested("c4", "2026-11-06T01:00:00.000Z");
  await run(new Date("2026-11-06T15:00:00.000Z"));
  assert.equal(camp("camp-a").status, "paused");
  assert.equal(db.rows("os_cap_windows")[0].restarted_at, null);
});

test("restart now with a campaign that can't be reached: not closed, says so, and tried again", async () => {
  seed();
  atCap();
  await run();
  targets.set("ch-hb", 4);
  unreachableOnResume = true;
  await assert.rejects(() => caps.restartNow(HB, settingsSync(), "amy@x.test", press), /could not be restarted/);
  assert.equal(db.rows("os_cap_windows")[0].restarted_at ?? null, null);
  assert.deepEqual(listedIds(), ["camp-a"]);
  unreachableOnResume = false;
  await run(ET_9AM);
  assert.equal(camp("camp-a").status, "active");
});

test("restart now across two windows: what can't be reached stays on the older row, the one the run comes back to, and the newer closes", async () => {
  seed();
  atCap();
  targets.set("ch-hb", 4);
  const listed = (id: string) => [{ platform: "bison", id, int_id: 1, name: id, paused_at: "x", confirmed: true }];
  db.rows("os_cap_windows").push(
    { os_client_id: HB, window_start: "2026-10-28", window_end: "2026-11-25", reached_at: "x", paused: listed("camp-b"), restarted_at: null, updated_at: "x" },
    { os_client_id: HB, window_start: "2026-09-30", window_end: "2026-10-28", reached_at: "x", paused: listed("camp-a"), restarted_at: null, updated_at: "x" },
  );
  unreachableOnResume = true;
  await assert.rejects(() => caps.restartNow(HB, settingsSync(), "amy@x.test", press), /Press Restart now again, or it restarts with the new window/);
  const older = db.rows("os_cap_windows").find((r) => r.window_start === "2026-09-30")!;
  const newer = db.rows("os_cap_windows").find((r) => r.window_start === "2026-10-28")!;
  assert.deepEqual((older.paused as Row[]).map((c) => c.id).sort(), ["camp-a", "camp-b"]);
  assert.equal(older.restarted_at ?? null, null);
  assert.ok(newer.restarted_at);
  assert.match(String(db.rows("os_notifications").find((n) => String(n.ref).startsWith("cap_restart_failed"))!.body), /Press Restart now again/);
});

test("what moves a campaign is refused on the server when the cap isn't acting, not just greyed out", async () => {
  for (const [why, seedWith, env, msg] of [
    ["switched off", {}, OFF, /aren't switched on/],
    ["a test client", { settings: { test_only: true } }, ON, /still in test/],
    ["a churned client", { status: "churned" }, ON, /is churned/],
  ] as const) {
    seed(seedWith);
    atCap();
    camp("camp-a").status = "paused";
    const s = await settings();
    const o = { env, now: IN_WINDOW };
    await assert.rejects(() => caps.restartNow(HB, s, "a", o), msg, `${why} restart`);
    await assert.rejects(() => caps.addToRestart(HB, s, { platform: "bison", id: "camp-a" }, o), msg, `${why} add`);
    await assert.rejects(() => caps.removeFromRestart(HB, s, { platform: "bison", id: "camp-a" }, o), msg, `${why} remove`);
    assert.deepEqual(calls, []);
    assert.deepEqual(capWrites(), []);
  }
});

test("once restarted, a campaign is off the list: paused by hand later, it stays paused when the next restart comes", async () => {
  seed();
  atCap();
  await run();
  targets.set("ch-hb", 4);
  await caps.restartNow(HB, await settings(), "amy@x.test", press);
  // A person pauses it by hand, and another campaign is the one running when the cap is reached again.
  camp("camp-a").status = "paused";
  camp("camp-b").status = "active";
  interested("c3", "2026-11-06T00:00:00.000Z");
  interested("c4", "2026-11-06T01:00:00.000Z");
  await run(new Date("2026-11-06T15:00:00.000Z"));
  assert.deepEqual(listedIds(), ["camp-b"]);
  await run(ET_9AM);
  assert.equal(camp("camp-b").status, "active");
  assert.equal(camp("camp-a").status, "paused");
});

test("the leads of two portals of one client count together, and another client's don't count at all", async () => {
  seed();
  interested("john", "2026-11-04T00:29:00.000Z");
  db.rows("clients").push({ id: "p2", name: "Homebase East", slug: "homebase-east", aliases: [] });
  db.rows("os_campaign_portals").push({ os_client_id: HB, portal_id: "p2", campaign_id: "x" });
  db.rows("clients").push({ id: "p3", name: "Someone Else", slug: "someone-else", aliases: [] });
  db.rows("leads").push({ id: "l-x", email: "x@x.test", full_name: "x" });
  db.rows("threads").push({ id: "t-x", client_id: "p3", lead_id: "l-x", status: "open" });
  db.rows("label_assignments").push({ label_id: "lab-int", target_type: "thread", target_id: "t-x", assigned_at: "2026-11-04T05:00:00.000Z" });
  db.rows("label_history").push({ id: 99, thread_id: "t-x", label_id: "lab-int", label_name: "Interested", assigned_at: "2026-11-04T05:00:00.000Z", client_id: "p3", lead_id: "l-x", source: "trigger" });
  const r = await run();
  assert.equal(r.reached, 0, "1 of 2: the other client's lead didn't count");
});

test("nothing here left the process", () => {
  assert.deepEqual(db.blocked, []);
});

/* ------------------------------------------- not billed (0050, 6 Nov) --- */

test("a lead not billed uses none of the cap: John and Ram with Ram not billed is under the cap, and nothing pauses", async () => {
  seed();
  atCap();
  db.seed("os_usage_billing_waivers", [{ os_client_id: HB, test_mode: false, lead_key: "ram@x.test", lead_name: "ram", reason: "sent over the cap", waived_by: "amy@brokerstaffer.com", waived_at: "2026-11-05T20:00:00.000Z" }]);
  const r = await run();
  assert.deepEqual(r.errors, []);
  assert.equal(r.reached, 0);
  assert.deepEqual(calls, [], "no campaign paused");
  assert.equal(camp("camp-a").status, "active");
});

test("Homebase's case: John, Ram and Daniel with Daniel not billed is still 2 of 2, so it stays at its cap", async () => {
  seed();
  atCap();
  interested("daniel", "2026-11-05T19:19:19.000Z");
  db.seed("os_usage_billing_waivers", [{ os_client_id: HB, test_mode: false, lead_key: "daniel@x.test", lead_name: "daniel", reason: "sent over the cap", waived_by: "amy@brokerstaffer.com", waived_at: "2026-11-05T20:00:00.000Z" }]);
  const r = await run(IN_WINDOW, OFF);
  assert.equal(r.reached, 1);
  assert.match(r.notes.join(), /Homebase: 2 of 2/);
});

test("before 0050 runs the cap counts as before", async () => {
  seed();
  atCap();
  db.missingTables.add("os_usage_billing_waivers");
  const r = await run(IN_WINDOW, OFF);
  assert.deepEqual(r.errors, []);
  assert.match(r.notes.join(), /Homebase: 2 of 2/);
});
