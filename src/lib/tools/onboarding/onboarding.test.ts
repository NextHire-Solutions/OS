/*
 * Onboarding — the pure logic the three new screens depend on.
 *
 * Everything checked here is a rule copied out of the orchestrator, and every
 * one of them is the kind that fails silently: a merge field that quietly does
 * not resolve, a photo cap that quietly does not apply, a name match that
 * quietly picks the wrong client. None of them would show up as a broken screen.
 *
 * The Supabase halves are deliberately not here — they are exercised against the
 * live database by scripts/onboarding-write-test.mjs, which is the only way to
 * prove a write actually landed.
 *
 *   node --test src/lib/tools/onboarding/onboarding.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  htmlBody,
  isSystemTemplate,
  mergeFieldsIn,
  render,
  renderTemplate,
  type Template,
} from "./template-types.ts";
import { initialsOf, isRole, validatePhoto, MAX_PHOTO } from "./people-types.ts";
import { stageOf, swapForMove, toneOf, STAGE_COLORS, type Stage } from "./stage-types.ts";
import { cleanStepLabels } from "./settings-pure.ts";
import { STEPS, labelFor } from "./steps.ts";
import { indexTheirs, matchClient, norm, stem } from "./health-match.ts";
import { ReadOnlyTableError, WRITE_METHODS, isWritable } from "./write-guard.ts";

/* ------------------------------- templates -------------------------------- */

test("merge fields tolerate the docs' inconsistent casing and spacing", () => {
  const vars = { firstName: "Dana" };
  // All four spellings appear in the onboarding docs; all must resolve.
  assert.equal(render("Hi {{firstName}},", vars), "Hi Dana,");
  assert.equal(render("Hi {{First Name}},", vars), "Hi Dana,");
  assert.equal(render("Hi {{FirstName}},", vars), "Hi Dana,");
  assert.equal(render("Hi {{  first_name  }},", vars), "Hi Dana,");
});

test("an unknown merge field is left visible rather than blanked", () => {
  // The team needs to SEE an unfilled placeholder. Replacing it with "" would
  // ship an email with a hole in it that nobody could spot.
  assert.equal(render("Hi {{nope}},", { firstName: "Dana" }), "Hi {{nope}},");
});

test("a null or undefined value renders as empty, not as the word null", () => {
  assert.equal(render("[{{a}}][{{b}}]", { a: null, b: undefined }), "[][]");
});

test("a numeric or boolean value is stringified", () => {
  assert.equal(render("{{n}} / {{b}}", { n: 12, b: true }), "12 / true");
});

test("renderTemplate fills subject and body, and tolerates a null subject", () => {
  const t = {
    id: "1", category: "email", key: null, name: "x",
    subject: "Welcome {{firstName}}", body: "Hi {{firstName}}",
    sort: 0, active: true, updated_at: "",
  } as Template;
  assert.deepEqual(renderTemplate(t, { firstName: "Dana" }), {
    subject: "Welcome Dana",
    body: "Hi Dana",
  });
  assert.equal(renderTemplate({ ...t, subject: null }, { firstName: "Dana" }).subject, "");
});

test("htmlBody escapes markup and turns newlines into breaks", () => {
  const out = htmlBody("a & b <script>\nnext");
  assert.match(out, /a &amp; b &lt;script&gt;<br>next/);
  assert.doesNotMatch(out, /<script>/);
});

test("htmlBody escapes the ampersand before the angle brackets", () => {
  // Order matters: escaping < first would turn "&lt;" into "&amp;lt;".
  assert.equal(
    htmlBody("<").includes("&lt;") && !htmlBody("<").includes("&amp;lt;"),
    true,
  );
});

test("mergeFieldsIn lists each field once, in first-seen order", () => {
  assert.deepEqual(
    mergeFieldsIn("{{firstName}} {{Brokerage Name}} {{First Name}} {{firstName}}"),
    ["firstName", "Brokerage Name"],
  );
  assert.deepEqual(mergeFieldsIn("no fields here"), []);
});

test("the nine templates the automation sends are protected from deletion", () => {
  for (const key of [
    "welcome", "welcome_nobooking", "confirmations", "how_intros_work",
    "meet_team", "portal", "dnc_reminder", "campaign_launched", "followup_call",
  ]) {
    assert.equal(isSystemTemplate(key), true, `${key} must be protected`);
  }
  // The three Zillow sequences and the intro macro are the team's to remove.
  assert.equal(isSystemTemplate("zillow_seq_a"), false);
  assert.equal(isSystemTemplate("intro_macro"), false);
  assert.equal(isSystemTemplate(null), false);
  assert.equal(isSystemTemplate(undefined), false);
});

/* --------------------------------- people --------------------------------- */

test("a photo must be an image data URL or an https link", () => {
  assert.deepEqual(validatePhoto("data:image/png;base64,AAAA"), { ok: true, value: "data:image/png;base64,AAAA" });
  assert.deepEqual(validatePhoto("https://example.com/a.jpg"), { ok: true, value: "https://example.com/a.jpg" });
  assert.equal(validatePhoto("javascript:alert(1)").ok, false);
  assert.equal(validatePhoto("data:text/html;base64,AAAA").ok, false);
  assert.equal(validatePhoto("data:image/gif;base64,AAAA").ok, false);
});

test("no photo is not an error — it is simply null", () => {
  assert.deepEqual(validatePhoto(null), { ok: true, value: null });
  assert.deepEqual(validatePhoto(""), { ok: true, value: null });
  assert.deepEqual(validatePhoto(undefined), { ok: true, value: null });
});

test("an oversized photo is refused", () => {
  const big = "data:image/png;base64," + "A".repeat(MAX_PHOTO);
  assert.equal(validatePhoto(big).ok, false);
  const ok = "data:image/png;base64," + "A".repeat(1000);
  assert.equal(validatePhoto(ok).ok, true);
});

test("initials come from the first and last word", () => {
  assert.equal(initialsOf("Ryan Jagdeo"), "RJ");
  assert.equal(initialsOf("Eddy"), "E");
  assert.equal(initialsOf("  ada  b  lovelace "), "AL");
  assert.equal(initialsOf(""), "?");
  assert.equal(initialsOf(null), "?");
});

test("only the two known roles are accepted", () => {
  assert.equal(isRole("salesperson"), true);
  assert.equal(isRole("account_manager"), true);
  assert.equal(isRole("admin"), false);
  assert.equal(isRole(null), false);
});

/* --------------------------------- stages --------------------------------- */

const STAGES: Stage[] = [
  { id: "a", name: "New", sort: 10, color: "neutral" },
  { id: "b", name: "Assigned", sort: 20, color: "amber" },
  { id: "c", name: "Live", sort: 30, color: "green" },
];

test("moving a stage swaps sort values with its neighbour", () => {
  assert.deepEqual(swapForMove(STAGES, "b", "up"), {
    a: { id: "b", sort: 10 },
    b: { id: "a", sort: 20 },
  });
  assert.deepEqual(swapForMove(STAGES, "b", "down"), {
    a: { id: "b", sort: 30 },
    b: { id: "c", sort: 20 },
  });
});

test("moving past either end does nothing rather than erroring", () => {
  assert.equal(swapForMove(STAGES, "a", "up"), null);
  assert.equal(swapForMove(STAGES, "c", "down"), null);
  assert.equal(swapForMove(STAGES, "missing", "up"), null);
});

test("a client with no stage falls back to the first one", () => {
  assert.equal(stageOf(STAGES, null)?.id, "a");
  assert.equal(stageOf(STAGES, "c")?.id, "c");
  // A stage that was deleted out from under a client behaves the same way.
  assert.equal(stageOf(STAGES, "gone")?.id, "a");
  assert.equal(stageOf([], null), null);
});

test("every offered stage colour has a tint, and anything else falls back", () => {
  for (const c of STAGE_COLORS) {
    const tone = toneOf(c);
    assert.ok(tone.bg && tone.fg, `${c} needs a tint`);
    assert.doesNotMatch(tone.bg, /--blue-bg/, "must not use the token that does not exist");
  }
  assert.deepEqual(toneOf("chartreuse"), toneOf("neutral"));
  assert.deepEqual(toneOf(null), toneOf("neutral"));
});

/* -------------------------------- settings -------------------------------- */

test("a blank button name is dropped so the default caption returns", () => {
  assert.deepEqual(cleanStepLabels({ a: "Go", b: "   ", c: "" }), { a: "Go" });
  assert.deepEqual(cleanStepLabels({ a: "  Padded  " }), { a: "Padded" });
  assert.deepEqual(cleanStepLabels({}), {});
});

test("a custom caption overrides the default, and a blank one does not", () => {
  const step = STEPS[0];
  assert.equal(labelFor(step, {}), "Send welcome email");
  assert.equal(labelFor(step, { [step.key]: "Say hello" }), "Say hello");
  assert.equal(labelFor(step, { [step.key]: "   " }), "Send welcome email");
});

test("the step catalogue is the tool's fourteen, with unique keys", () => {
  assert.equal(STEPS.length, 14);
  assert.equal(new Set(STEPS.map((s) => s.key)).size, 14);
});

/* ---------------------------- health matching ----------------------------- */

test("names are normalised to letters and digits", () => {
  assert.equal(norm("Norvell & Co"), "norvellco");
  assert.equal(norm("norvell&co"), "norvellco");
  assert.equal(stem("The Discover Flag Team"), "discoverflagteam");
});

test("a stored dashboard id beats the name", () => {
  const theirs = [
    { id: "x1", name: "Renamed Over There", status: "active" },
    { id: "x2", name: "Howe Realty", status: "paused" },
  ];
  const hit = matchClient({ client_name: "Howe Realty", health_client_id: "x1" }, theirs, indexTheirs(theirs));
  // The id wins, so a rename on either side does not silently detach a client.
  assert.equal(hit?.id, "x1");
});

test("an exact normalised name matches", () => {
  const theirs = [{ id: "x2", name: "Norvell & Co", status: "churned" }];
  assert.equal(matchClient({ client_name: "norvellco" }, theirs)?.id, "x2");
});

test("one name containing the other matches only when it is unambiguous", () => {
  const one = [{ id: "y1", name: "Howe Realty Group", status: "active" }];
  assert.equal(matchClient({ client_name: "Howe Realty" }, one)?.id, "y1");

  // Two candidates fit, so a guess could pick the wrong client: refuse.
  const two = [
    { id: "y1", name: "Howe Realty Group", status: "active" },
    { id: "y2", name: "Howe Realty Partners", status: "paused" },
  ];
  assert.equal(matchClient({ client_name: "Howe Realty" }, two), null);
});

test("short names never match by containment", () => {
  // "Ace" would otherwise match every name beginning with it.
  const theirs = [{ id: "z1", name: "Ace Realty", status: "active" }];
  assert.equal(matchClient({ client_name: "Ace" }, theirs), null);
});

test("a client with no counterpart is unmatched rather than mismatched", () => {
  const theirs = [{ id: "z1", name: "Somebody Else", status: "active" }];
  assert.equal(matchClient({ client_name: "Nobody Here" }, theirs), null);
});

/* ------------------------------ write guard ------------------------------- */

test("only orch_ tables are writable", () => {
  // The half of the database Onboarding owns.
  for (const t of ["orch_clients", "orch_stages", "orch_templates", "orch_settings", "orch_salespeople"]) {
    assert.equal(isWritable(t), true, `${t} must be writable`);
  }
  // Agent Search's half — 1.17M agents — shares this Supabase project and the
  // same service-role key. An unguarded write here would be catastrophic and
  // completely silent.
  for (const t of ["agents", "offices", "mls", "agent_mls", "saved_lists"]) {
    assert.equal(isWritable(t), false, `${t} must be read-only`);
  }
});

test("the guard names the table and the method it refused", () => {
  const e = new ReadOnlyTableError("agents", "delete");
  assert.equal(e.table, "agents");
  assert.equal(e.method, "delete");
  assert.match(e.message, /Blocked DELETE on "agents"/);
  assert.match(e.message, /orch_\* tables/);
});

test("the four write methods are the ones guarded", () => {
  assert.deepEqual([...WRITE_METHODS].sort(), ["delete", "insert", "update", "upsert"]);
  // `select` must pass through: reads on Agent Search's tables are allowed.
  assert.equal(WRITE_METHODS.has("select"), false);
});
