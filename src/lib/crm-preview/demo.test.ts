/*
 * The Demo Portal's saves (21 Oct): the Demo Portal's rows only, the live
 * portal's columns, and nothing set off outside — fake database only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { csvRowToAgent, csvRowToDnc, csvRowToPipeline, csvRowToTeam, parseCsv, type CsvRow } from "../tools/master-inbox/portals/csv.ts";
import { companyDomain, DEMO_MARKET_MLS, DEMO_PORTAL_ID, demoAction, isDemoPortal, MAX_IMPORT_ROWS, runDemoAction, type DemoAction } from "./demo.ts";

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

test("the current portal's Add and Edit extras (28 Oct): the introduction day at noon UTC, the replacement mark, a blanked field, notes edited and deleted", async () => {
  const s = seed();
  const added = await run({ type: "entry.add", lead_name: "Dana Reyes", introduced_at: "2026-09-15", needs_replacement: true });
  assert.equal(added.ok, true);
  const r = row("client_pipeline_entries", (added as { id: string }).id);
  assert.equal(r.introduced_at, "2026-09-15T12:00:00.000Z");
  assert.equal(r.needs_replacement, true);
  // Not a date, or not a real one: refused before anything is written.
  assert.equal(demoAction.safeParse({ type: "entry.add", lead_name: "X", introduced_at: "2026-02-30" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.add", lead_name: "X", introduced_at: "45212" }).success, false);
  // An edit that leaves the date out keeps it; the mark changes on its own.
  assert.equal((await run({ type: "entry.edit", id: r.id, lead_name: "Dana Reyes", needs_replacement: false })).ok, true);
  assert.equal(row("client_pipeline_entries", r.id as string).introduced_at, "2026-09-15T12:00:00.000Z");
  assert.equal(row("client_pipeline_entries", r.id as string).needs_replacement, false);
  // A blank value blanks the field (as the current portal); null takes the client's own value off.
  row("client_pipeline_entries", r.id as string).custom_fields_overrides = { Kept: "x", Gone: "y" };
  assert.equal((await run({ type: "entry.fields", id: r.id, fields: { "Sales Volume": "", Gone: null } })).ok, true);
  assert.deepEqual(row("client_pipeline_entries", r.id as string).custom_fields_overrides, { Kept: "x", "Sales Volume": "" });
  // Notes: edited and deleted on the Demo's own agents only.
  const note = await run({ type: "note.add", entry: r.id, body: "first" });
  const noteId = (note as { id: string }).id;
  assert.equal((await run({ type: "note.edit", entry: r.id, note: noteId, body: "second" })).ok, true);
  assert.equal(row("client_pipeline_notes", noteId).body, "second");
  const [theirNote] = fake.seed("client_pipeline_notes", [...fake.rows("client_pipeline_notes"), { entry_id: s.theirs.id, body: "theirs" }]).slice(-1);
  assert.deepEqual(await run({ type: "note.edit", entry: s.theirs.id, note: theirNote.id, body: "x" }), { ok: false, status: 404, error: "That agent is not on this portal." });
  assert.deepEqual(await run({ type: "note.delete", entry: r.id, note: theirNote.id }), { ok: false, status: 404, error: "That note is no longer there." });
  assert.equal(row("client_pipeline_notes", theirNote.id).body, "theirs");
  assert.equal((await run({ type: "note.delete", entry: r.id, note: noteId })).ok, true);
  assert.equal(fake.rows("client_pipeline_notes").some((n) => n.id === noteId), false);
  // The Demo never connects to Follow Up Boss.
  assert.deepEqual(await run({ type: "entry.push", id: r.id }), { ok: false, status: 400, error: "The Demo Portal never connects to Follow Up Boss." });
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

/* What the browser sends: the file read by the live portal's own parser and header matching. */
const fileRows = (text: string, map: (r: CsvRow) => object | null) => parseCsv(text).map(map);
const demoRows = (t: string) => fake.rows(t).filter((r) => r.client_id === DEMO_PORTAL_ID);

test("CSV import, My Agents: the file's own headers, duplicates skipped by email, bad rows named — Demo rows only, nothing pushed", async () => {
  seed();
  fake.seed("client_agents", [...fake.rows("client_agents"), { client_id: DEMO_PORTAL_ID, name: "Already Here", email: "here@demo.test" }]);
  const csv = 'Full Name,Email Address,Phone Number\r\n"Lee, Jordan",Jordan@Coastal.test,555-0101\r\nAlready Again,HERE@demo.test,\r\nPat Kim,pat@x.test,\r\nPat Twice,pat@x.test,\r\n,nobody@x.test,\r\nBad Mail,not-an-email,\r\nkept@brokerage.test Owner,kept@brokerage.test,\r\n';
  const r = await run({ type: "agent.import", rows: fileRows(csv, csvRowToAgent) });
  assert.deepEqual(r, { ok: true, message: 'Imported 3 agents. 2 duplicates skipped. 2 rows skipped — row 6: no name; row 7: "not-an-email" is not a valid email.' });
  const mine = demoRows("client_agents");
  assert.deepEqual(mine.map((a) => a.email).sort(), ["here@demo.test", "jordan@coastal.test", "kept@brokerage.test", "pat@x.test"]);
  assert.equal(mine.find((a) => a.email === "jordan@coastal.test")!.name, "Lee, Jordan");
  assert.ok(mine.every((a) => a.pushed_to_instantly !== true && a.pushed_to_emailbison !== true));
  assert.equal(fake.rows("client_agents").filter((a) => a.client_id === OTHER).length, 1, "another client's list: untouched (its same email is no duplicate here)");
  assert.deepEqual(fake.blocked, []);
});

test("CSV import, DNC: companies by domain (or the email's), agents by email; nothing sent to a blocklist", async () => {
  seed();
  const csv = "Name,Email,Brokerage,Domain,Kind,Notes\nKeller Williams,,,https://www.KW.com/x,company,\nKW again,,,kw.com,company,\nAcme,info@acme.test,,,Company,from email\nJane Roe,Jane@Roe.test,Compass,,,\nBad Co,,,not a domain,company,\n";
  const r = await run({ type: "dnc.import", rows: fileRows(csv, csvRowToDnc) });
  assert.deepEqual(r, { ok: true, message: 'Imported 3 entries. 1 duplicate skipped. 1 row skipped — row 6: "not a domain" is not a website domain.' });
  const mine = demoRows("client_dnc_entries");
  assert.deepEqual(mine.map((d) => [d.kind, d.name, d.domain, d.email, d.brokerage, d.added_by]), [
    ["company", "Keller Williams", "kw.com", null, null, "client"],
    ["company", "Acme", "acme.test", "info@acme.test", null, "client"],
    ["agent", "Jane Roe", null, "jane@roe.test", "Compass", "client"],
  ]);
  assert.equal(fake.rows("client_dnc_entries").length, 4, "the other client's entry is still there");
  assert.deepEqual(fake.blocked, []);
});

test("CSV import, Team: name + email together decide a duplicate (a shared inbox is allowed, as live); never texted", async () => {
  seed();
  const csv = "Full Name,Email Address,Job Title,Mobile\nEddy,eddy@brokerstaffer.com,,\nSam Rivera,sam@demo.test,Recruiter,555-0100\nAlex Front,eddy@brokerstaffer.com,Front desk,\nNo Mail,,,\n";
  const r = await run({ type: "team.import", rows: fileRows(csv, csvRowToTeam) });
  assert.deepEqual(r, { ok: true, message: "Imported 2 team members. 1 duplicate skipped. 1 row skipped — row 5: needs a name and an email." });
  const added = demoRows("client_team_members").filter((m) => m.name !== "Eddy");
  assert.deepEqual(added.map((m) => [m.name, m.email, m.title, m.active, m.receives_sms]), [
    ["Sam Rivera", "sam@demo.test", "Recruiter", true, false],
    ["Alex Front", "eddy@brokerstaffer.com", "Front desk", true, false],
  ]);
});

test("CSV import, Pipeline: Client Entries; a stage by key or by name; a bad stage or date names its row; no Introduction texts", async () => {
  seed();
  const csv = "Candidate Name,Email,Company,Stage,Introduction Date,Needs Replacement\nJo Park,jo@x.test,Compass,Phone Screen,2026-10-01,yes\nRay Diaz,,,we/they rejected,,\nNew Lead,,,,,\nOdd Stage,,,Onboarding,,\nOdd Date,,,,not a date,\n";
  const r = await run({ type: "entry.import", rows: fileRows(csv, csvRowToPipeline) });
  assert.deepEqual(r, { ok: true, message: 'Imported 3 agents. 2 rows skipped — row 5: "onboarding" is not one of this portal\'s stages; row 6: "not a date" is not a date (use a date like 2026-10-01).' });
  const added = demoRows("client_pipeline_entries").filter((e) => e.lead_name !== "Demo Agent");
  assert.deepEqual(added.map((e) => [e.lead_name, e.stage, e.source, e.needs_replacement, e.current_brokerage]), [
    ["Jo Park", "phone_screen", "Client Entry", true, "Compass"],
    ["Ray Diaz", "we_they_rejected", "Client Entry", false, null],
    ["New Lead", "introduction", "Client Entry", false, null],
  ]);
  assert.equal(added[0].introduced_at, new Date("2026-10-01").toISOString());
  assert.ok(typeof added[2].introduced_at === "string", "no date: today, as live");
  assert.deepEqual(fake.blocked, []);
});

test("CSV import: a file where nothing can be saved says why; the size is bounded", async () => {
  seed();
  assert.deepEqual(await run({ type: "agent.import", rows: [null, { name: "", email: "x@x.test" }] }), { ok: false, status: 400, error: "Nothing was imported — row 2: no name; row 3: no name." });
  assert.equal(demoAction.safeParse({ type: "agent.import", rows: [] }).success, false);
  assert.equal(demoAction.safeParse({ type: "agent.import", rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ name: "A" })) }).success, false);
  assert.equal(demoAction.safeParse({ type: "dnc.import", rows: [{ name: { $ne: 1 } }] }).success, false, "cells are text, yes/no or empty — nothing else");
  assert.equal(demoRows("client_agents").length, 0);
  assert.match(fs.readFileSync("src/components/crm-preview/demo-save.ts", "utf8"), new RegExp(`const MAX_ROWS = ${MAX_IMPORT_ROWS};`), "the browser's limit is the server's");
});

/* The Demo Portal's stage list as it is on 22 Oct: the pipeline's nine (its own order) and one custom stage. */
const DEMO_STAGES = [
  ["phone_screen_scheduled", "Phone Screen Scheduled"], ["phone_screen", "Phone Screen"], ["introduction", "Introduction"], ["interview_scheduled", "Interview Scheduled"],
  ["interview", "Interview"], ["hired", "Hired"], ["keep_warm", "Nurture"], ["we_they_rejected", "Not a Fit"], ["no_show", "No Response"],
].map(([key, label]) => ({ key, label, color: null, kind: "canonical", canonical_stage: key, hidden: false }));
const CUSTOM = { key: "custom_apw2pau5", label: "Invited to sales meeting", color: "#e23a3a", kind: "custom", canonical_stage: null, hidden: false };
function seedStages() {
  const s = seed();
  fake.seed("client_pipeline_stages", [
    ...[...DEMO_STAGES, CUSTOM].map((r, i) => ({ client_id: DEMO_PORTAL_ID, sort_order: i, ...r })),
    { client_id: OTHER, key: "custom_theirs", label: "Theirs", kind: "custom", canonical_stage: null, hidden: false, sort_order: 0 },
  ]);
  return s;
}
const stagesOf = (c: string) => fake.rows("client_pipeline_stages").filter((r) => r.client_id === c).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

test("Manage stages: rename, reorder, hide and a new tag — the Demo Portal's stage rows only", async () => {
  seedStages();
  const list = [DEMO_STAGES[2], DEMO_STAGES[0], { ...DEMO_STAGES[1], label: "Phone call", hidden: true }, ...DEMO_STAGES.slice(3), CUSTOM, { key: "custom_tag_ab12cd34", label: "Top producer", color: "#0f766e", kind: "custom", canonical_stage: null, hidden: false }];
  assert.deepEqual(await run({ type: "stages.save", stages: list }), { ok: true, message: "Saved on the Demo Portal." });
  const mine = stagesOf(DEMO_PORTAL_ID);
  assert.deepEqual(mine.map((r) => r.key), list.map((r) => r.key), "saved in the order given");
  assert.deepEqual(mine.map((r) => r.sort_order), list.map((_, i) => i));
  const phone = mine.find((r) => r.key === "phone_screen")!;
  assert.deepEqual([phone.label, phone.hidden, phone.kind, phone.canonical_stage], ["Phone call", true, "canonical", "phone_screen"]);
  assert.deepEqual(stagesOf(OTHER).map((r) => [r.key, r.label, r.sort_order]), [["custom_theirs", "Theirs", 0]], "another client's stages untouched");
  assert.equal(row("client_pipeline_entries", fake.rows("client_pipeline_entries").find((e) => e.client_id === DEMO_PORTAL_ID)!.id as string).stage, "introduction", "no entry's stage moved");
  assert.deepEqual(fake.blocked, []);
});

test("Manage stages: taking out a custom stage sends its agents back to their pipeline stage — the Demo's only", async () => {
  const s = seedStages();
  row("client_pipeline_entries", s.mine.id).custom_stage_key = "custom_apw2pau5";
  row("client_pipeline_entries", s.theirs.id).custom_stage_key = "custom_apw2pau5";
  const r = await run({ type: "stages.save", stages: DEMO_STAGES });
  assert.deepEqual(r, { ok: true, message: "Saved. 1 agent moved back to its pipeline stage." });
  assert.ok(!stagesOf(DEMO_PORTAL_ID).some((x) => x.key === "custom_apw2pau5"));
  assert.equal(row("client_pipeline_entries", s.mine.id).custom_stage_key, null);
  assert.equal(row("client_pipeline_entries", s.mine.id).stage, "introduction", "back at its own stage");
  assert.equal(row("client_pipeline_entries", s.theirs.id).custom_stage_key, "custom_apw2pau5", "another client's entry: untouched");
  assert.equal(stagesOf(OTHER).length, 1);
});

test("Manage stages: the live route's rules — every pipeline stage stays once; Introduction and Hired are always shown", async () => {
  seedStages();
  const without = DEMO_STAGES.filter((x) => x.key !== "keep_warm");
  assert.deepEqual(await run({ type: "stages.save", stages: without }), { ok: false, status: 400, error: "Every pipeline stage stays — keep_warm is missing." });
  assert.deepEqual(await run({ type: "stages.save", stages: DEMO_STAGES.map((x) => (x.key === "hired" ? { ...x, hidden: true } : x)) }), { ok: false, status: 400, error: '"Hired" is always shown.' });
  assert.deepEqual(await run({ type: "stages.save", stages: [...DEMO_STAGES, DEMO_STAGES[0]] }), { ok: false, status: 400, error: '"Phone Screen Scheduled" is in the list twice.' });
  assert.deepEqual(await run({ type: "stages.save", stages: [...DEMO_STAGES, { ...CUSTOM, key: "made-up" }] }), { ok: false, status: 400, error: '"Invited to sales meeting" is not a stage this portal can keep.' });
  assert.deepEqual(await run({ type: "stages.save", stages: [...DEMO_STAGES, { ...CUSTOM, kind: "custom", canonical_stage: "hired" }] }), { ok: false, status: 400, error: '"Invited to sales meeting" is not a stage this portal can keep.' });
  assert.deepEqual(await run({ type: "stages.save", stages: DEMO_STAGES.map((x) => (x.key === "interview" ? { ...x, key: "interview_x" } : x)) }), { ok: false, status: 400, error: '"Interview" is not a pipeline stage.' });
  assert.deepEqual(await run({ type: "stages.save", stages: [...DEMO_STAGES, { ...CUSTOM, color: "red" }] }), { ok: false, status: 400, error: `"Invited to sales meeting" has a colour that isn't one of the stage colours.` });
  assert.equal(demoAction.safeParse({ type: "stages.save", stages: [{ ...CUSTOM, label: "x".repeat(41) }] }).success, false, "names are 40 characters at most, as live");
  assert.equal(stagesOf(DEMO_PORTAL_ID).length, 10, "nothing changed");
  assert.equal(stagesOf(DEMO_PORTAL_ID).find((x) => x.key === "custom_apw2pau5")?.label, "Invited to sales meeting");
});

test("input is checked before anything is read", () => {
  assert.equal(demoAction.safeParse({ type: "client.delete" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: [], stage: "hired" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: ["not-a-uuid"], stage: "hired" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.stage", ids: [OTHER], stage: "made_up" }).success, false);
  assert.equal(demoAction.safeParse({ type: "entry.delete", ids: Array.from({ length: 5001 }, () => OTHER) }).success, false);
  assert.equal(demoAction.safeParse({ type: "team.add", name: "X", email: "not an email" }).success, false);
  assert.equal(demoAction.safeParse({ type: "agent.add", name: "" }).success, false);
  assert.equal(companyDomain("@kw.com"), "kw.com");
  assert.equal(companyDomain("kw"), null);
});

test("the Demo's save path imports nothing that reaches outside the database; the save route checks who, the portal and the right to change it before any save, and keeps the Demo off the real-portal path (28 Oct)", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const importsOf = (src: string) => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  // demo.ts — the Demo's one writer: the database and the preview's own helpers, never a blocklist, Slack, texts or Follow Up Boss.
  const demo = read("src/lib/crm-preview/demo.ts");
  // 23 Oct: Market's Move to reads the agent database (demo-market.ts, read-only).
  const demoAllowed = ["zod", "@/lib/crm-preview/model", "@/lib/tools/master-inbox/db/paginated-select", "@/lib/tools/master-inbox/portals/stages-shared", "@/lib/tools/master-inbox/portals/stage-config", "@/lib/crm-preview/demo-market", "@/lib/crm-preview/market-model"];
  assert.deepEqual(importsOf(demo).filter((i) => !demoAllowed.includes(i)), [], "demo.ts: only the database and the preview's own checks");
  assert.doesNotMatch(demo, /\bfetch\(|import\(/, "demo.ts: no outside requests, no dynamic imports");
  const dm = read("src/lib/crm-preview/demo-market.ts");
  assert.deepEqual(importsOf(dm).filter((i) => !["server-only", "zod", "@/lib/tools/assistant/read-only", "@/lib/tools/corofy/supabase", "./demo", "./market-model"].includes(i)), [], "demo-market.ts: the agent database read-only, nothing else");
  assert.match(dm, /const agentDb = \(\) => readOnly\(getCorofySupabase\(\)\);/, "the agent database only through the read-only wrapper");

  // The save route: who first; a portal they may not open — nothing; may not change — read-only; then the save.
  const route = read("src/app/api/crm-preview/save/route.ts");
  assert.doesNotMatch(route, /\bfetch\(|import\(/, "the route: no outside requests, no dynamic imports");
  const at = (needle: string, from = 0) => { const i = route.indexOf(needle, from); assert.ok(i > 0, `the route has ${needle}`); return i; };
  const who = at("crmViewerOf(request)");
  const open = at("if (!mayOpenPortal(viewer, client))");
  const write = at("if (!mayWritePortal(viewer, client))");
  const gate = at("admit(who, role,");
  const demoBranch = at("if (isDemoPortal(portal)) {");
  const realBranch = at("} else {", demoBranch);
  assert.ok(who < open && open < write && write < gate && gate < demoBranch, "who, then the portal is theirs, then they may change it, then the guard, then the save");
  assert.ok(at("runDemoAction(") > demoBranch && route.indexOf("runDemoAction(") < realBranch, "the Demo's saves are the Demo's own (demo.ts)");
  // On the Demo nothing reaches the real-portal path (portal-save.ts sets off blocklists, Slack, texts, Follow Up Boss).
  assert.doesNotMatch(route.slice(demoBranch, realBranch), /runPortal/, "the Demo branch never calls portal-save");
  assert.ok(at("runPortalAction(") > realBranch);
  assert.equal(route.match(/runPortalAction\(/g)?.length, 1, "one call, in the real-portal branch");
  // The first address only forwards.
  const old = read("src/app/api/crm-preview/demo/route.ts");
  assert.deepEqual(importsOf(old), ["../save/route"]);
  assert.match(old, /export \{ POST \} from "\.\.\/save\/route";/);
});

test("the Demo Portal's sample market: the design's own (C21 Results' MLSs) — and never anyone's lists as Prospects", () => {
  assert.deepEqual([...DEMO_MARKET_MLS], ["FMLS", "GAMLS"]);
  const market = fs.readFileSync("src/lib/crm-preview/market.ts", "utf8");
  const at = market.indexOf("isDemoPortal(p.id)");
  assert.ok(at > 0 && market.indexOf("!client && isDemoPortal(p.id)") > 0, "only when the portal has no client record of its own");
  assert.match(market.slice(at, at + 400), /orchClientId: null/, "no client's lists in a demo");
});

/* ---------------------------------------------------------- 22 Oct audit --- */

/* A database client whose requests pass `hook` first (it may answer one itself), for one test. */
function hooked(hook: (url: string, init: RequestInit | undefined) => Response | null) {
  const wrapped = (async (url: string | URL | Request, init?: RequestInit) => hook(String(url), init) ?? fake.fetch(url as never, init)) as typeof fetch;
  const client = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: wrapped } });
  return (a: unknown) => {
    const parsed = demoAction.safeParse(a);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    return runDemoAction(client, parsed.data as DemoAction);
  };
}

test("a long list is written in chunks of 200 — 450 deletes are three requests, all done, none of another client's", async () => {
  seed();
  const many = fake.seed("client_agents", [...fake.rows("client_agents"), ...Array.from({ length: 450 }, (_, i) => ({ client_id: DEMO_PORTAL_ID, name: `A${i}`, email: `a${i}@x.test` }))]).filter((r) => r.client_id === DEMO_PORTAL_ID);
  let deletes = 0;
  const counted = hooked((url, init) => { if (init?.method === "DELETE" && url.includes("/client_agents")) deletes++; return null; });
  assert.deepEqual(await counted({ type: "agent.delete", ids: many.map((r) => r.id) }), { ok: true });
  assert.equal(deletes, 3);
  assert.equal(demoRows("client_agents").length, 0);
  assert.equal(fake.rows("client_agents").filter((r) => r.client_id === OTHER).length, 1);
});

test("a spreadsheet's date number or a NUL character no longer sinks the import: the date names its row, the NUL is dropped", async () => {
  seed();
  const r = await run({ type: "entry.import", rows: [{ lead_name: "Serial Date", introduced_at: "45212" }, { lead_name: "Nul\u0000Name", introduced_at: "2026-10-01" }, { lead_name: "Fine" }], lines: [2, 4, 5] });
  assert.deepEqual(r, { ok: true, message: 'Imported 2 agents. 1 row skipped — row 2: "45212" is not a date (use a date like 2026-10-01).' });
  assert.ok(demoRows("client_pipeline_entries").some((e) => e.lead_name === "NulName"));
  // The row numbers are the spreadsheet's own (the browser counts blank lines the parser drops).
  const bad = await run({ type: "agent.import", rows: [{ name: "Ok", email: "ok@x.test" }, { name: "Bad", email: "nope" }], lines: [2, 7] });
  assert.equal(bad.ok && bad.message, 'Imported 1 agent. 1 row skipped — row 7: "nope" is not a valid email.');
});

test("an export imports back: the portal's own stage names, renamed and custom", async () => {
  seed();
  fake.seed("client_pipeline_stages", [
    { client_id: DEMO_PORTAL_ID, key: "keep_warm", label: "Nurture", kind: "canonical", canonical_stage: "keep_warm", hidden: false, sort_order: 0 },
    { client_id: DEMO_PORTAL_ID, key: "custom_apw2pau5", label: "Invited to sales meeting", kind: "custom", canonical_stage: null, hidden: false, sort_order: 1 },
    { client_id: OTHER, key: "custom_theirs", label: "Theirs Only", kind: "custom", canonical_stage: null, hidden: false, sort_order: 0 },
  ]);
  const r = await run({ type: "entry.import", rows: [{ lead_name: "A", stage: "Nurture" }, { lead_name: "B", stage: "Invited to sales meeting" }, { lead_name: "C", stage: "Interview no show" }, { lead_name: "D", stage: "Theirs Only" }] });
  assert.equal(r.ok && r.message, 'Imported 3 agents. 1 row skipped — row 5: "Theirs Only" is not one of this portal\'s stages.');
  const by = (n: string) => demoRows("client_pipeline_entries").find((e) => e.lead_name === n)!;
  assert.deepEqual([by("A").stage, by("A").custom_stage_key], ["keep_warm", null]);
  assert.deepEqual([by("B").stage, by("B").custom_stage_key], ["introduction", "custom_apw2pau5"]);
  assert.deepEqual([by("C").stage, by("C").custom_stage_key], ["introduction", "interview_no_show"]);
});

test("a duplicate the database refuses mid-import is skipped, not a failed file; on its own it says 'already on the list'", async () => {
  seed();
  const dupe = (url: string, init: RequestInit | undefined) => {
    if (init?.method !== "POST" || !url.includes("/client_agents")) return null;
    const body = JSON.parse(String(init.body));
    const rows = Array.isArray(body) ? body : [body];
    return rows.some((x: { email?: string }) => x.email === "taken@x.test") ? new Response(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }), { status: 409, headers: { "content-type": "application/json" } }) : null;
  };
  const runDupe = hooked(dupe);
  const r = await runDupe({ type: "agent.import", rows: [{ name: "One", email: "one@x.test" }, { name: "Taken", email: "taken@x.test" }, { name: "Two", email: "two@x.test" }] });
  assert.deepEqual(r, { ok: true, message: "Imported 2 agents. 1 duplicate skipped." });
  assert.deepEqual(await runDupe({ type: "agent.add", name: "Taken", email: "taken@x.test" }), { ok: false, status: 409, error: "That's already on the list." });
  assert.deepEqual(demoRows("client_agents").map((a) => a.email).sort(), ["one@x.test", "two@x.test"]);
});

test("editing a DNC company keeps its email and phone; a Demo team edit keeps texts off", async () => {
  seed();
  const [co] = fake.seed("client_dnc_entries", [...fake.rows("client_dnc_entries"), { client_id: DEMO_PORTAL_ID, kind: "company", name: "Acme", email: "info@acme.test", phone: "555-0100", domain: "acme.test" }]).slice(-1);
  assert.deepEqual(await run({ type: "dnc.edit", id: co.id, name: "Acme Realty", domain: "acme.test" }), { ok: true });
  assert.deepEqual([row("client_dnc_entries", co.id).name, row("client_dnc_entries", co.id).email, row("client_dnc_entries", co.id).phone], ["Acme Realty", "info@acme.test", "555-0100"]);
  const s = seed();
  row("client_team_members", s.demoMember.id).receives_sms = true;
  await run({ type: "team.edit", id: s.demoMember.id, name: "Eddy", email: "eddy@brokerstaffer.com", phone: "555-0199" });
  assert.equal(row("client_team_members", s.demoMember.id).receives_sms, false);
  row("client_team_members", s.demoMember.id).receives_sms = true;
  await run({ type: "team.active", id: s.demoMember.id, active: true });
  assert.equal(row("client_team_members", s.demoMember.id).receives_sms, false);
});

test("the wizard's offer (22 Oct): saved for the Demo Portal only, once per portal, with who saved it", async () => {
  seed();
  fake.seed("os_portal_offers", [{ portal_id: OTHER, offers: ["Path to leadership"], why_join: "Theirs", never_say: null }]);
  const first = await runDemoAction(db, demoAction.parse({ type: "offer.save", offers: ["Transaction coordinator", "Coaching and training", "Transaction coordinator"], why_join: " Steady leads from day one. ", never_say: "" }) as DemoAction, "eddy@brokerstaffer.com");
  assert.deepEqual(first, { ok: true, message: "Your offer is saved." });
  const mine = () => fake.rows("os_portal_offers").filter((r) => r.portal_id === DEMO_PORTAL_ID);
  assert.equal(mine().length, 1);
  assert.deepEqual([mine()[0].offers, mine()[0].why_join, mine()[0].never_say, mine()[0].updated_by], [["Transaction coordinator", "Coaching and training"], "Steady leads from day one.", null, "eddy@brokerstaffer.com"]);
  // Saved again: the same row, changed.
  await runDemoAction(db, demoAction.parse({ type: "offer.save", offers: ["Path to leadership"], why_join: "Leadership track.", never_say: "No splits." }) as DemoAction, "amy@brokerstaffer.com");
  assert.equal(mine().length, 1);
  assert.deepEqual([mine()[0].offers, mine()[0].never_say, mine()[0].updated_by], [["Path to leadership"], "No splits.", "amy@brokerstaffer.com"]);
  assert.deepEqual(fake.rows("os_portal_offers").find((r) => r.portal_id === OTHER)!.why_join, "Theirs", "another portal's offer: untouched");
  // Only the design's choices, and a reason.
  assert.equal(demoAction.safeParse({ type: "offer.save", offers: ["Free yachts"], why_join: "x" }).success, false);
  assert.equal(demoAction.safeParse({ type: "offer.save", offers: [], why_join: "x" }).success, false);
  assert.equal(demoAction.safeParse({ type: "offer.save", offers: ["Path to leadership"], why_join: "  " }).success, false);
  assert.equal(demoAction.safeParse({ type: "offer.save", offers: ["Path to leadership"], why_join: "x".repeat(1001) }).success, false);
  assert.deepEqual(fake.blocked, []);
});

test("migration 0039 only adds — one new table; the OS reads it behind the Client Portals switch, GET only", () => {
  const sql = fs.readFileSync("migrations/0039_portal_offers.sql", "utf8").replace(/--.*$/gm, "");
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((x) => x[1]), ["os_portal_offers"]);
  assert.doesNotMatch(sql.replace(/ON DELETE CASCADE/g, ""), /\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
  for (const a of sql.matchAll(/ALTER TABLE\s+public\.(\w+)/gi)) assert.equal(a[1], "os_portal_offers");
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  const route = fs.readFileSync("src/app/api/tools/master-inbox/portals/offer/route.ts", "utf8");
  assert.deepEqual([...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]), ["GET"]);
  assert.match(route, /if \(!s \|\| !\(s\.grants\.includes\("portals"\) \|\| \(await isAdminUser\(s\.email\)\)\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.ok(route.indexOf("Forbidden") < route.indexOf("os_portal_offers"), "who first, then the read");
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(/);
});
