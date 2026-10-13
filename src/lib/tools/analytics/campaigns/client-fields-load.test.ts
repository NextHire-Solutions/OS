/*
 * Client fields against a (fake) EmailBison — the two helpers that read and
 * write a live sequence. The properties that matter:
 *
 *   · a sequence with no client field is read once and NEVER written;
 *   · only the steps that changed are written, in the save route's own shape;
 *   · a placeholder stops a resume only when it has actually been seen.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Mod = typeof import("./client-fields-load.ts");
let mod: Mod | null = null;
const masters = new Map<string, { name: string; aliases: string[]; markets: { areas: string[] } }>();
const mappings: Record<string, { client_id: string | null; excluded: boolean } | null> = {};
let mappingError: string | null = null;

if (canMock) {
  mock.module("@/lib/clients/master-lookup", { namedExports: { masterByToolId: async () => masters } });
  mock.module("@/lib/tools/analytics/supabase", {
    namedExports: {
      analyticsTeamId: () => 2,
      getAnalyticsSupabase: () => ({
        from: (table: string) => {
          const q: { id?: unknown } = {};
          const b = {
            select: () => b,
            eq: (col: string, v: unknown) => { if (col === "campaign_id" || col === "id") q.id = v; return b; },
            maybeSingle: async () => {
              if (mappingError) return { data: null, error: { message: mappingError } };
              if (table === "clients") return { data: { name: "Analytics Only Co", aliases: ["AOC"] }, error: null };
              return { data: mappings[`${table}:${String(q.id)}`] ?? null, error: null };
            },
          };
          return b;
        },
      }),
    },
  });
  mod = (await import("./client-fields-load.ts")) as Mod;
}

const step = (id: number, subject: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, email_subject: subject, email_body: body, order: id, wait_in_days: 2, variant: false, thread_reply: false, ...extra,
});

function fakeEb(steps: ReturnType<typeof step>[], opts: { readFails?: boolean } = {}) {
  const calls = { reads: 0, updates: [] as Array<{ sequenceId: number; title: string; steps: Array<Record<string, unknown>> }> };
  return {
    calls,
    eb: {
      getCampaignSequenceSteps: async () => {
        calls.reads++;
        if (opts.readFails) throw new Error("EmailBison 500");
        return { data: { sequence_id: 77, sequence_steps: steps } };
      },
      updateSequenceSteps: async (sequenceId: number, title: string, s: Array<Record<string, unknown>>) => {
        calls.updates.push({ sequenceId, title, steps: s });
        return { data: { sequence_id: sequenceId, sequence_steps: [] } };
      },
    } as never,
  };
}

const WAGNER = { clientName: "Wagner Real Estate Group", area: "greater Seattle", alias: "Wagner" };

test("fill: a sequence with no client field is read once and never written", { skip }, async () => {
  const f = fakeEb([step(1, "Hi {FIRST_NAME}", "<p>{a|b}</p>")]);
  const out = await mod!.fillCampaignSequence(f.eb, 500, "Camp", WAGNER);
  assert.deepEqual(out, { steps: 1, filled: 0, missing: [] });
  assert.equal(f.calls.reads, 1);
  assert.equal(f.calls.updates.length, 0);
});

test("fill: only the steps that changed are written, in the save route's shape", { skip }, async () => {
  const f = fakeEb([
    step(1, "{CLIENT_ALIAS} is hiring", "<p>In {CLIENT_AREA}</p>"),
    step(2, "Re: Re: follow up", "<p>Still in {client area}?</p>", { thread_reply: true, wait_in_days: "3" }),
    step(3, "Unchanged", "<p>Nothing</p>"),
    step(4, "Variant", "<p>{CLIENT_ALIAS}</p>", { variant: true, variant_from_step_id: 1 }),
  ]);
  const out = await mod!.fillCampaignSequence(f.eb, 500, "Wagner — Seattle", WAGNER);
  assert.deepEqual(out, { steps: 4, filled: 4, missing: [] });
  assert.equal(f.calls.updates.length, 1);
  const u = f.calls.updates[0];
  assert.equal(u.sequenceId, 77);
  assert.equal(u.title, "Wagner — Seattle");
  assert.deepEqual(u.steps.map((s) => s.id), [1, 2, 4], "step 3 is not sent");
  assert.deepEqual(u.steps[0], { id: 1, email_subject: "Wagner is hiring", email_body: "<p>In greater Seattle</p>", order: 1, wait_in_days: 2, variant: false, thread_reply: false });
  assert.equal(u.steps[1].email_subject, "follow up", "EmailBison re-adds Re: itself");
  assert.equal(u.steps[1].wait_in_days, 3);
  assert.equal(u.steps[2].variant_from_step_id, 1);
});

test("fill: a field the client has no value for is reported and left; the rest is still written", { skip }, async () => {
  const f = fakeEb([step(1, "{CLIENT_ALIAS}", "<p>In {CLIENT_AREA}</p>")]);
  const out = await mod!.fillCampaignSequence(f.eb, 500, "X", { clientName: "Oz Group", area: null, alias: "Oz" });
  assert.deepEqual(out, { steps: 1, filled: 1, missing: ["area"] });
  assert.equal(f.calls.updates[0].steps[0].email_subject, "Oz");
  assert.equal(f.calls.updates[0].steps[0].email_body, "<p>In {CLIENT_AREA}</p>");
});

test("fill: a template with no client changes nothing and writes nothing", { skip }, async () => {
  const f = fakeEb([step(1, "{CLIENT_ALIAS}", "{CLIENT_AREA}")]);
  const out = await mod!.fillCampaignSequence(f.eb, 500, "T", { clientName: null, area: null, alias: null });
  assert.deepEqual(out, { steps: 1, filled: 0, missing: ["area", "alias"] });
  assert.equal(f.calls.updates.length, 0);
});

test("guard: placeholders still in the sequence are found, each once", { skip }, async () => {
  const f = fakeEb([step(1, "{CLIENT_ALIAS}", "{CLIENT_AREA} {CLIENT_AREA}"), step(2, "x", "{client_area}")]);
  assert.deepEqual((await mod!.unfilledClientFields(f.eb, 500)).sort(), ["alias", "area"]);
  assert.deepEqual(await mod!.unfilledClientFields(fakeEb([step(1, "Hi {FIRST_NAME}", "plain")]).eb, 500), []);
});

test("guard: a sequence that cannot be read is 'none found' — it never blocks a resume by itself", { skip }, async () => {
  assert.deepEqual(await mod!.unfilledClientFields(fakeEb([], { readFails: true }).eb, 500), []);
});

test("whose values: the campaign's client, from the master record", { skip }, async () => {
  masters.set("an-1", { name: "Wagner Real Estate Group", aliases: ["Wagner"], markets: { areas: ["greater Seattle", "Tacoma"] } });
  mappings["campaign_clients:359"] = { client_id: "an-1", excluded: false };
  assert.deepEqual(await mod!.clientFieldValuesForCampaign("emailbison", 359), { clientName: "Wagner Real Estate Group", area: "greater Seattle and Tacoma", alias: "Wagner" });
});

test("whose values: unassigned and excluded campaigns have no client", { skip }, async () => {
  mappings["campaign_clients:1"] = null;
  mappings["campaign_clients:2"] = { client_id: null, excluded: false };
  mappings["campaign_clients:3"] = { client_id: "an-1", excluded: true };
  for (const id of [1, 2, 3]) {
    assert.deepEqual(await mod!.clientFieldValuesForCampaign("emailbison", id), { clientName: null, area: null, alias: null }, String(id));
  }
});

test("whose values: an Instantly campaign reads its own mapping table, by uuid", { skip }, async () => {
  mappings["instantly_campaign_clients:0b1c2d3e-0000-4000-8000-000000000001"] = { client_id: "an-1", excluded: false };
  const v = await mod!.clientFieldValuesForCampaign("instantly", "0b1c2d3e-0000-4000-8000-000000000001");
  assert.equal(v.alias, "Wagner");
});

test("whose values: a client with no master record has its name and alias, and no area", { skip }, async () => {
  assert.deepEqual(await mod!.clientFieldValuesForClient("an-unlinked"), { clientName: "Analytics Only Co", area: null, alias: "AOC" });
});

test("whose values: a failed lookup throws — the caller refuses rather than write a placeholder", { skip }, async () => {
  mappingError = "connection reset";
  await assert.rejects(mod!.clientFieldValuesForCampaign("emailbison", 359), /could not read which client|Could not read which client/i);
  mappingError = null;
});
