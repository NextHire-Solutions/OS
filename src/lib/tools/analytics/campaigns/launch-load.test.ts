/*
 * Launching, against a fake EmailBison and an in-memory cache. What has to
 * hold: a campaign that fails the checks is NEVER sent to EmailBison; a launch
 * that goes through is audited and the new status written; a refusal upstream
 * is audited as an error and nothing claims success.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Row = Record<string, unknown>;
const cache: { campaign: Row | null; mapping: Row | null; audits: Row[]; statusWrites: Row[] } = { campaign: null, mapping: null, audits: [], statusWrites: [] };
let clientName: string | null = "Wagner Real Estate Group";

type Mod = typeof import("./launch-load.ts");
let mod: Mod | null = null;
if (canMock) {
  mock.module("@/lib/tools/analytics/supabase", {
    namedExports: {
      analyticsTeamId: () => 2,
      getAnalyticsSupabase: () => ({
        from: (table: string) => {
          const b = {
            select: () => b,
            eq: () => b,
            is: () => b,
            maybeSingle: async () => ({ data: table === "campaigns" ? cache.campaign : cache.mapping, error: null }),
            insert: async (row: Row) => { cache.audits.push(row); return { error: null }; },
            update: (patch: Row) => ({ eq: async () => { cache.statusWrites.push(patch); return { error: null }; } }),
          };
          return b;
        },
      }),
    },
  });
  mock.module("./client-fields-load", {
    namedExports: { clientFieldValuesForCampaign: async () => ({ clientName, area: "greater Seattle", alias: "Wagner" }) },
  });
  mod = (await import("./launch-load.ts")) as Mod;
}

interface Upstream {
  status?: string;
  steps?: Array<{ email_subject: string; email_body: string }> | "none" | "down";
  leads?: number | "down";
  inboxes?: number | "down";
  resume?: "ok" | "refuse";
}

function fakeEb(u: Upstream = {}) {
  const calls = { resume: 0 };
  const down = () => { throw new Error("EmailBison 500"); };
  return {
    calls,
    eb: {
      getCampaign: async () => ({ id: 500, status: u.status ?? "draft" }),
      getCampaignSequenceSteps: async () => {
        if (u.steps === "down") down();
        if (u.steps === "none") throw new Error("Sequence steps do not exist");
        return { data: { sequence_id: 9, sequence_steps: u.steps ?? [{ email_subject: "Hi {FIRST_NAME}", email_body: "<p>Hello</p>" }] } };
      },
      getCampaignLeadCount: async () => (u.leads === "down" ? down() : (u.leads ?? 1200)),
      getCampaignSenderEmailCount: async () => (u.inboxes === "down" ? down() : (u.inboxes ?? 1272)),
      resumeCampaign: async () => {
        calls.resume++;
        if (u.resume === "refuse") throw new Error("Campaign cannot be launched without a schedule");
        return { data: { id: 500, status: "Queued" } };
      },
    } as never,
  };
}

function reset(status = "draft") {
  cache.campaign = { id: 500, name: "Wagner — Seattle", status, max_emails_per_day: 1000, max_new_leads_per_day: 500 };
  cache.mapping = { client_id: "an-1", excluded: false };
  cache.audits = [];
  cache.statusWrites = [];
  clientName = "Wagner Real Estate Group";
}

test("facts are read live: steps, leads, inboxes, client, limits", { skip }, async () => {
  reset();
  const read = await mod!.launchFacts(500, 2, fakeEb().eb);
  assert.equal(read!.name, "Wagner — Seattle");
  assert.deepEqual(read!.facts, {
    status: "draft", steps: 1, leads: 1200, inboxes: 1272, unfilled: [], clientName: "Wagner Real Estate Group",
    excluded: false, dailyLimit: 1000, newLeadsPerDay: 500,
  });
});

test("EmailBison's own status wins over the cache's", { skip }, async () => {
  reset("draft");
  assert.equal((await mod!.launchFacts(500, 2, fakeEb({ status: "Active" }).eb))!.facts.status, "active");
});

test("no sequence yet is zero steps; an unreadable one is unknown — and so are its client fields", { skip }, async () => {
  reset();
  const none = (await mod!.launchFacts(500, 2, fakeEb({ steps: "none" }).eb))!.facts;
  assert.equal(none.steps, 0);
  assert.deepEqual(none.unfilled, []);
  const down = (await mod!.launchFacts(500, 2, fakeEb({ steps: "down", leads: "down", inboxes: "down" }).eb))!.facts;
  assert.deepEqual([down.steps, down.unfilled, down.leads, down.inboxes], [null, null, null, null]);
});

test("a placeholder left in the sequence is found", { skip }, async () => {
  reset();
  const f = (await mod!.launchFacts(500, 2, fakeEb({ steps: [{ email_subject: "{CLIENT_ALIAS}", email_body: "in {client area}" }] }).eb))!.facts;
  assert.deepEqual([...(f.unfilled ?? [])].sort(), ["alias", "area"]);
});

test("a campaign not in the cache is not launched", { skip }, async () => {
  reset();
  cache.campaign = null;
  const f = fakeEb();
  assert.deepEqual(await mod!.launchCampaign(500, "amy@x", 2, f.eb), { ok: false, error: "Unknown campaign — not in the local cache. Run Sync campaigns." });
  assert.equal(f.calls.resume, 0);
});

test("a launch that passes the checks: one call, audited, status written", { skip }, async () => {
  reset();
  const f = fakeEb();
  const out = await mod!.launchCampaign(500, "amy@x", 2, f.eb);
  assert.deepEqual(out, { ok: true, status: "queued" });
  assert.equal(f.calls.resume, 1);
  assert.equal(cache.audits.length, 1);
  assert.equal(cache.audits[0].action, "launch");
  assert.equal(cache.audits[0].status, "ok");
  assert.equal(cache.audits[0].actor, "amy@x");
  assert.deepEqual(cache.audits[0].before_state, { status: "draft", steps: 1, leads: 1200, inboxes: 1272 });
  assert.deepEqual(cache.statusWrites, [{ status: "queued" }]);
});

test("a paused campaign is audited as a resume", { skip }, async () => {
  reset("paused");
  await mod!.launchCampaign(500, "amy@x", 2, fakeEb({ status: "paused" }).eb);
  assert.equal(cache.audits[0].action, "resume");
});

test("failing a check: EmailBison is never called, nothing is audited or written", { skip }, async () => {
  for (const u of [{ leads: 0 }, { inboxes: 0 }, { steps: "none" as const }, { steps: [{ email_subject: "x", email_body: "{CLIENT_AREA}" }] }, { leads: "down" as const }, { status: "active" }]) {
    reset();
    const f = fakeEb(u);
    const out = await mod!.launchCampaign(500, "amy@x", 2, f.eb);
    assert.equal(out.ok, false, JSON.stringify(u));
    assert.equal(f.calls.resume, 0, JSON.stringify(u));
    assert.equal(cache.audits.length, 0);
    assert.equal(cache.statusWrites.length, 0);
    assert.ok(out.error);
  }
});

test("EmailBison refusing the launch is an error, audited as one, with its own words", { skip }, async () => {
  reset();
  const f = fakeEb({ resume: "refuse" });
  const out = await mod!.launchCampaign(500, "amy@x", 2, f.eb);
  assert.deepEqual(out, { ok: false, error: "Campaign cannot be launched without a schedule" });
  assert.equal(cache.audits.length, 1);
  assert.equal(cache.audits[0].status, "error");
  assert.equal(cache.statusWrites.length, 0, "the cache keeps saying draft");
});

test("no client is a warning, not a stop", { skip }, async () => {
  reset();
  clientName = null;
  assert.equal((await mod!.launchCampaign(500, "amy@x", 2, fakeEb().eb)).ok, true);
});
