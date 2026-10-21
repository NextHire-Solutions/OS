/*
 * The Demo Portal's saves (21 Oct): the Demo Portal's rows only, the live
 * portal's columns, and nothing set off outside — fake database only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { companyDomain, DEMO_MARKET_MLS, DEMO_PORTAL_ID, demoAction, isDemoPortal, runDemoAction, type DemoAction } from "./demo.ts";

const fake = new FakePostgrest();
globalThis.fetch = fake.fetch as typeof fetch;
const db = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: fake.fetch as typeof fetch } });
const OTHER = "11111111-1111-4111-8111-111111111111";

function seed() {
  fake.reset();
  const [mine, theirs] = fake.seed("client_pipeline_entries", [
    { client_id: DEMO_PORTAL_ID, stage: "introduction", lead_name: "Demo Agent", custom_stage_key: null, assigned_team_member_id: null },
    { client_id: OTHER, stage: "introduction", lead_name: "Real Client's Agent", custom_stage_key: null, assigned_team_member_id: null },
  ]);
  const [demoMember, otherMember] = fake.seed("client_team_members", [
    { client_id: DEMO_PORTAL_ID, name: "Eddy", email: "eddy@brokerstaffer.com", active: true },
    { client_id: OTHER, name: "Angela Oakes", email: "angela@brokerage.test", active: true },
  ]);
  const [otherAgent] = fake.seed("client_agents", [{ client_id: OTHER, name: "Kept", email: "kept@brokerage.test" }]);
  const [otherDnc] = fake.seed("client_dnc_entries", [{ client_id: OTHER, kind: "agent", name: "Kept", email: "kept@x.test" }]);
  for (const t of ["client_pipeline_notes", "client_pipeline_stages"]) fake.seed(t, []);
  return { mine, theirs, demoMember, otherMember, otherAgent, otherDnc };
}
const run = (a: unknown) => {
  const parsed = demoAction.safeParse(a);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return runDemoAction(db, parsed.data as DemoAction);
};
const row = (table: string, id: string) => fake.rows(table).find((r) => r.id === id)!;

test("only the Demo Portal: fixed on the server, by its id", () => {
  assert.equal(DEMO_PORTAL_ID, "00ef116c-646d-43b4-a323-680548ea7126");
  assert.equal(isDemoPortal(DEMO_PORTAL_ID), true);
  assert.equal(isDemoPortal(OTHER), false);
  assert.equal(isDemoPortal(""), false);
  assert.equal(isDemoPortal(null), false);
});

test("another client's rows never change — ids from another portal are filtered out of every update and delete", async () => {
  const s = seed();
  assert.deepEqual(await run({ type: "entry.stage", ids: [s.mine.id, s.theirs.id], stage: "phone_screen" }), { ok: true });
  assert.equal(row("client_pipeline_entries", s.mine.id).stage, "phone_screen");
  assert.equal(row("client_pipeline_entries", s.theirs.id).stage, "introduction", "the real client's agent is untouched");

  await run({ type: "entry.assign", ids: [s.theirs.id], member: s.demoMember.id });
  assert.equal(row("client_pipeline_entries", s.theirs.id).assigned_team_member_id, null);
  assert.deepEqual(await run({ type: "entry.assign", ids: [s.mine.id], member: s.otherMember.id }), { ok: false, status: 404, error: "That team member is not on this portal." });

  assert.equal((await run({ type: "entry.edit", id: s.theirs.id, lead_name: "Changed" })).ok, false);
  assert.equal(row("client_pipeline_entries", s.theirs.id).lead_name, "Real Client's Agent");

  assert.equal((await run({ type: "note.add", entry: s.theirs.id, body: "hi" })).ok, false, "no note on another client's agent");
  assert.equal(fake.rows("client_pipeline_notes").length, 0);

  await run({ type: "entry.delete", ids: [s.mine.id, s.theirs.id] });
  assert.ok(!fake.rows("client_pipeline_entries").some((r) => r.id === s.mine.id), "the Demo row is deleted");
  assert.ok(fake.rows("client_pipeline_entries").some((r) => r.id === s.theirs.id), "the real client's row is not");

  await run({ type: "agent.delete", ids: [s.otherAgent.id] });
  await run({ type: "dnc.delete", ids: [s.otherDnc.id] });
  await run({ type: "team.delete", ids: [s.otherMember.id] });
  assert.equal(fake.rows("client_agents").length, 1);
  assert.equal(fake.rows("client_dnc_entries").length, 1);
  assert.ok(fake.rows("client_team_members").some((r) => r.id === s.otherMember.id));
  assert.equal((await run({ type: "team.edit", id: s.otherMember.id, name: "X", email: "x@x.test" })).ok, false);
  assert.equal((await run({ type: "agent.edit", id: s.otherAgent.id, name: "X" })).ok, false);
  assert.equal((await run({ type: "dnc.edit", id: s.otherDnc.id, name: "X" })).ok, false);
  assert.deepEqual(fake.blocked, [], "nothing but the database was asked");
});

test("the live portal's rows: a manual add is a Client Entry at Introduction; a move clears a custom stage", async () => {
  seed();
  const added = await run({ type: "entry.add", lead_name: "Jordan Ellis", lead_email: "Jordan@Coastal.test" });
  assert.equal(added.ok, true);
  const r = row("client_pipeline_entries", (added as { id: string }).id);
  assert.equal(r.client_id, DEMO_PORTAL_ID);
  assert.equal(r.stage, "introduction");
  assert.equal(r.source, "Client Entry");
  assert.equal(r.lead_email, "jordan@coastal.test");
  assert.ok(typeof r.introduced_at === "string");
  r.custom_stage_key = "phone_screen_no_show";
  await run({ type: "entry.stage", ids: [r.id], stage: "keep_warm" });
  assert.equal(row("client_pipeline_entries", r.id as string).custom_stage_key, null);
  assert.equal(row("client_pipeline_entries", r.id as string).stage, "keep_warm");
  // A custom stage must exist on the Demo Portal (or be a global one).
  assert.deepEqual(await run({ type: "entry.customStage", ids: [r.id], key: "made-up" }), { ok: false, status: 400, error: "That stage no longer exists." });
  assert.deepEqual(await run({ type: "entry.customStage", ids: [r.id], key: "interview_no_show" }), { ok: true });
});

test("nothing is pushed anywhere: My Agents and DNC rows say not pushed; a new team member is never texted", async () => {
  seed();
  const a = await run({ type: "agent.add", name: "Pat Lee", email: "pat@x.test" });
  assert.deepEqual([row("client_agents", (a as { id: string }).id).pushed_to_instantly, row("client_agents", (a as { id: string }).id).pushed_to_emailbison], [false, false]);
  const d = await run({ type: "dnc.add", kind: "company", name: "Keller Williams", domain: "https://www.KW.com/offices" });
  const dr = row("client_dnc_entries", (d as { id: string }).id);
  assert.deepEqual([dr.domain, dr.kind, dr.added_by, dr.pushed_to_instantly, dr.pushed_to_emailbison, dr.brokerage], ["kw.com", "company", "client", false, false, null]);
  assert.deepEqual(await run({ type: "dnc.add", kind: "company", name: "Bad", domain: "not a domain" }), { ok: false, status: 400, error: "That doesn't look like a website domain (for example kw.com)." });
  const t = await run({ type: "team.add", name: "Sam Rivera", email: "sam@demo.test", phone: "555-0100" });
  const tr = row("client_team_members", (t as { id: string }).id);
  assert.deepEqual([tr.active, tr.receives_sms, tr.client_id], [true, false, DEMO_PORTAL_ID]);
  assert.deepEqual(await run({ type: "team.add", name: " sam rivera", email: "sam@demo.test" }), { ok: false, status: 409, error: "This person is already on the team." });
  assert.equal((await run({ type: "team.add", name: "Someone Else", email: "sam@demo.test" })).ok, true, "a different person on the same email is allowed, as live");
  assert.deepEqual(fake.blocked, []);
});

test("input is checked before anything is read", () => {
  assert.equal(demoAction.safeParse({ type: "client.delete" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: [], stage: "hired" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: ["not-a-uuid"], stage: "hired" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: [OTHER], stage: "made_up" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.delete", ids: Array.from({ length: 501 }, () => OTHER) }).success, false);
  assert.equal(demoAction.safeParse({ type: "team.add", name: "X", email: "not an email" }).success, false);
  assert.equal(demoAction.safeParse({ type: "agent.add", name: "" }).success, false);
  assert.equal(companyDomain("@kw.com"), "kw.com");
  assert.equal(companyDomain("kw"), null);
});

test("the save path imports nothing that reaches outside the database, and the route refuses any other portal first", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const files = ["src/lib/crm-preview/demo.ts", "src/app/api/crm-preview/demo/route.ts"];
  for (const f of files) {
    const src = read(f);
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const allowed = f.endsWith("demo.ts")
      ? ["zod", "@/lib/tools/master-inbox/portals/stages-shared", "@/lib/tools/master-inbox/portals/stage-config"]
      : ["next/server", "@/lib/bs-auth", "@/lib/identity/admin", "@/lib/crm-preview/access", "@/lib/crm-preview/data-guard", "@/lib/crm-preview/demo", "@/lib/supabase/admin"];
    assert.deepEqual(imports.filter((i) => !allowed.includes(i)), [], `${f}: only the database and the preview's own checks — no blocklist, stop, Slack, texts, Follow Up Boss`);
    assert.doesNotMatch(src, /\bfetch\(|import\(/, `${f}: no outside requests, no dynamic imports`);
  }
  const route = read("src/app/api/crm-preview/demo/route.ts");
  const refuse = route.indexOf("isDemoPortal(");
  assert.ok(refuse > route.indexOf("canSeeCrmPreview(") && refuse < route.indexOf("runDemoAction(") && refuse < route.indexOf("createAdminSupabase()"), "who first, then Demo-only, then the save");
});

test("the Demo Portal's sample market: the design's own (C21 Results' MLSs) — and never anyone's lists as Prospects", () => {
  assert.deepEqual([...DEMO_MARKET_MLS], ["FMLS", "GAMLS"]);
  const market = fs.readFileSync("src/lib/crm-preview/market.ts", "utf8");
  const at = market.indexOf("isDemoPortal(p.id)");
  assert.ok(at > 0 && market.indexOf("!client && isDemoPortal(p.id)") > 0, "only when the portal has no client record of its own");
  assert.match(market.slice(at, at + 400), /orchClientId: null/, "no client's lists in a demo");
});
