/*
 * The nine portal write-route families, exercised for real and verified in the
 * database.
 *
 *   node scripts/portal-routes-write-test.mjs [baseUrl]     (default :3390)
 *
 * WHY THE SECOND HALF OF EVERY CHECK MATTERS
 *
 * A route that answers 200 has proved nothing. This repo has already shipped 23
 * routes that returned 401 to everybody and a settings page whose every field
 * was read-only, and all of it looked finished. So every write below is followed
 * by a direct PostgREST read of the row it claimed to change, and the assertion
 * is on what the DATABASE says.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 * NOTHING TOUCHES A REAL CUSTOMER'S PORTAL.
 *
 * Every write targets "Test FUB" (slug test-fub), which started this run with
 * zero pipeline entries, zero custom stage rows and an empty
 * stage_label_overrides — so "my test data is gone" is provable by the fixture
 * returning to empty rather than asserted.
 *
 * Test FUB rather than Demo Portal because migration 0070 hardcodes an
 * exclusion for the demo client id (00ef116c-…): the no-show flow cannot fire
 * there at all, so a test using Demo would pass by doing nothing.
 *
 * Demo Portal is read ONLY as the far side of the cross-client scoping checks —
 * the script asserts its rows are byte-identical afterwards.
 *
 * TOKENS ARE NEVER PRINTED. A portal token is the credential — it opens a
 * client's data with no login. They are read from the database at runtime, held
 * in memory, and never logged, echoed or written to a file. This repo leaked 57
 * of them once already.
 *
 * SIDE EFFECTS THAT CANNOT BE UNDONE: a stage transition posts to Slack and a
 * move to "introduction" fires the n8n webhook. Entries are therefore created at
 * keep_warm (never introduction), and the only transitions performed are the
 * three the tests genuinely require.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3390";

const E = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
  if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const U = E.MASTER_INBOX_SUPABASE_URL;
const K = E.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;

const TEST_FUB = "95646033-277e-44cc-a0f9-d0ce0d0cb3c2";
const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31";
const NO_SHOW_LABEL_ID = "85c1ac6d-84a7-4ec1-91c6-62c57afeecf4";
const TAG = "ZZ Portal Route Test";
const STAGE_ORDER = ["introduction","phone_screen_scheduled","phone_screen","interview_scheduled",
                     "interview","hired","keep_warm","we_they_rejected","no_show"];

const { mintSso, ALL_TOOLS } = await import(
  "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os/src/lib/bs-auth.ts"
);
const COOKIE = `bs_sso=${await mintSso(E.BS_SSO_SECRET || E.AUTH_SECRET, {
  email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1,
})}`;

/* ----------------------------- the two halves ----------------------------- */

/** Through the OS's own API, exactly as PipelineBoard calls it. */
async function api(token, path, init = {}) {
  const res = await fetch(`${BASE}/api/tools/master-inbox/portal/${token}${path}`, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** Straight to Postgres, to see what actually landed. */
async function db(query, init) {
  const res = await fetch(`${U}/rest/v1/${query}`, {
    ...init,
    headers: {
      apikey: K, Authorization: `Bearer ${K}`, "content-type": "application/json",
      Prefer: init?.method && init.method !== "GET" ? "return=representation" : "",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`db ${res.status} ${query}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

let pass = 0; const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

/* ------------------------------- fixtures --------------------------------- */

const tokens = Object.fromEntries(
  (await db(`clients?select=id,portal_token&id=in.(${TEST_FUB},${DEMO})`)).map((c) => [c.id, c.portal_token]),
);
const TF_TOKEN = tokens[TEST_FUB], DEMO_TOKEN = tokens[DEMO];
if (!TF_TOKEN || !DEMO_TOKEN) { console.log("missing a test token"); process.exit(1); }

const preEntries = await db(`client_pipeline_entries?select=id&client_id=eq.${TEST_FUB}`);
const preStages  = await db(`client_pipeline_stages?select=key&client_id=eq.${TEST_FUB}`);
const preLabels  = (await db(`clients?select=stage_label_overrides&id=eq.${TEST_FUB}`))[0].stage_label_overrides;
const preToken   = TF_TOKEN;
const demoEntry  = (await db(`client_pipeline_entries?select=id,stage,lead_name&client_id=eq.${DEMO}&limit=1`))[0];
const demoBefore = JSON.stringify(demoEntry);
const demoStagesBefore = (await db(`client_pipeline_stages?select=key&client_id=eq.${DEMO}`)).length;
const threadRow  = (await db(`threads?select=id,client_id&id=eq.${THREAD}`))[0];
const threadOwner = threadRow.client_id;

console.log(`  fixture: Test FUB — ${preEntries.length} entries, ${preStages.length} stage rows, overrides ${JSON.stringify(preLabels)}`);
console.log(`  cross-client subject: one Demo Portal entry (read-only)\n`);

const undo = [];
let created = [];   // every entry id this script creates
let noteId = null;  // module scope: `finally` is a sibling of `try`, not a child
let ok = true;

try {

/* ============================ 0. the gates ================================= */
section("0. Security gates — both of them");
{
  const noCookie = await fetch(`${BASE}/api/tools/master-inbox/portal/${TF_TOKEN}/pipeline`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", ids: ["00000000-0000-0000-0000-000000000000"] }),
  });
  check("no workspace session → 401 (proxy.ts, the OS's extra gate)", noCookie.status === 401, `got ${noCookie.status}`);

  const badToken = await api("not-a-real-token-at-all", "/pipeline", {
    method: "PATCH", body: JSON.stringify({ action: "delete", ids: ["00000000-0000-0000-0000-000000000000"] }),
  });
  check("unknown token → 404 (resolvePortalClient)", badToken.status === 404, `got ${badToken.status}`);

  const short = await api("abc", "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: {} }) });
  check("token shorter than 4 chars → 404, never a lookup", short.status === 404, `got ${short.status}`);

  /*
   * A REAL token belonging to a client whose portal is switched off
   * (portal_enabled = false). This is the gate that matters most: the token is
   * valid and resolves to a real client row, and the route must still refuse.
   * Read-only — a 404 writes nothing, which the row check below confirms.
   */
  const off = (await db(`clients?select=id,portal_token,name&portal_enabled=eq.false&portal_token=not.is.null&limit=1`))[0];
  if (off) {
    const r = await api(off.portal_token, "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: { hired: "SHOULD NEVER LAND" } }) });
    const row = (await db(`clients?select=stage_label_overrides&id=eq.${off.id}`))[0];
    check("valid token, portal_enabled=false → 404", r.status === 404, `got ${r.status}`);
    check("DB: that disabled client's row was not written", row.stage_label_overrides?.hired !== "SHOULD NEVER LAND", JSON.stringify(row.stage_label_overrides));
  }
}

/* ======================= 1. POST /pipeline (create) ======================== */
section("1. POST /pipeline — create an entry");
{
  const r = await api(TF_TOKEN, "/pipeline", {
    method: "POST",
    body: JSON.stringify({
      lead_name: `${TAG} Alpha`, lead_email: "zz-portal-alpha@example.invalid",
      lead_phone: "+15550000001", current_brokerage: "ZZ Brokerage",
      stage: "keep_warm",
    }),
  });
  check("route exists and answers", r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body?.id;
  if (id) created.push(id);
  const row = id ? (await db(`client_pipeline_entries?select=*&id=eq.${id}`))[0] : null;
  check("DB: row exists, scoped to Test FUB", !!row && row.client_id === TEST_FUB, row ? `client_id=${row.client_id.slice(0,8)}` : "no row");
  check("DB: fields landed verbatim", !!row && row.lead_name === `${TAG} Alpha` && row.lead_phone === "+15550000001", row ? row.lead_name : "");
  check("DB: stage is keep_warm (not the default)", row?.stage === "keep_warm", `stage=${row?.stage}`);
  check("DB: source='Client Entry' (pipeline_source_split is on for this client)", row?.source === "Client Entry", `source=${row?.source}`);
  check("response echoes the source the server actually wrote", r.body?.source === row?.source, `${r.body?.source}`);

  const bad = await api(TF_TOKEN, "/pipeline", { method: "POST", body: JSON.stringify({ lead_email: "not-an-email" }) });
  check("invalid email → 400, nothing written", bad.status === 400, `got ${bad.status}`);
}

/* ===================== 2. PATCH /pipeline/[id] (edit) ===================== */
section("2. PATCH /pipeline/[id] — edit one entry");
{
  const id = created[0];
  const r = await api(TF_TOKEN, `/pipeline/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ lead_name: `${TAG} Alpha renamed`, current_brokerage: "ZZ Renamed Brokerage" }),
  });
  check("answers 200", r.status === 200, `status ${r.status}`);
  let row = (await db(`client_pipeline_entries?select=*&id=eq.${id}`))[0];
  check("DB: lead_name changed", row.lead_name === `${TAG} Alpha renamed`, row.lead_name);
  check("DB: current_brokerage changed", row.current_brokerage === "ZZ Renamed Brokerage", row.current_brokerage);

  await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({ custom_fields: { "Sales Volume": "$5M", "MLS": "ZZ-MLS" } }) });
  row = (await db(`client_pipeline_entries?select=custom_fields_overrides&id=eq.${id}`))[0];
  check("DB: custom_fields merged into custom_fields_overrides JSONB",
    row.custom_fields_overrides?.["Sales Volume"] === "$5M" && row.custom_fields_overrides?.["MLS"] === "ZZ-MLS",
    JSON.stringify(row.custom_fields_overrides));

  await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({ custom_fields: { "Sales Volume": "$9M" } }) });
  row = (await db(`client_pipeline_entries?select=custom_fields_overrides&id=eq.${id}`))[0];
  check("DB: a second patch MERGES (does not replace) — MLS survived",
    row.custom_fields_overrides?.["Sales Volume"] === "$9M" && row.custom_fields_overrides?.["MLS"] === "ZZ-MLS",
    JSON.stringify(row.custom_fields_overrides));

  await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({ custom_fields_remove: ["MLS"] }) });
  row = (await db(`client_pipeline_entries?select=custom_fields_overrides&id=eq.${id}`))[0];
  check("DB: custom_fields_remove deleted only that key",
    row.custom_fields_overrides?.["MLS"] === undefined && row.custom_fields_overrides?.["Sales Volume"] === "$9M",
    JSON.stringify(row.custom_fields_overrides));

  const empty = await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({}) });
  check("empty patch → 400 'Nothing to update'", empty.status === 400, `got ${empty.status}`);
}

/* ================== 3. cross-client scoping — the big one ================= */
section("3. Cross-client scoping — 47 live portals depend on this");
{
  const r = await api(TF_TOKEN, `/pipeline/${demoEntry.id}`, {
    method: "PATCH", body: JSON.stringify({ lead_name: "SHOULD NEVER LAND" }),
  });
  check("PATCH another client's entry through this token → 404", r.status === 404, `got ${r.status}`);
  const after = (await db(`client_pipeline_entries?select=id,stage,lead_name&id=eq.${demoEntry.id}`))[0];
  check("DB: the Demo Portal row is byte-identical", JSON.stringify(after) === demoBefore, JSON.stringify(after));

  const d = await api(TF_TOKEN, `/pipeline/${demoEntry.id}`, { method: "DELETE" });
  const stillThere = (await db(`client_pipeline_entries?select=id&id=eq.${demoEntry.id}`)).length === 1;
  check("DELETE another client's entry → no rows affected, row survives", stillThere, `status ${d.status}`);

  const conv = await api(TF_TOKEN, `/conversation/${demoEntry.id}`);
  check("GET another client's conversation → 404 (no cross-client leak)", conv.status === 404, `got ${conv.status}`);

  const fub = await api(TF_TOKEN, `/pipeline/${demoEntry.id}/push-fub`, { method: "POST" });
  check("push-fub on another client's entry → refused, and never reaches FUB",
    fub.status !== 200 && fub.body?.reason !== "no_contact", `got ${fub.status} ${JSON.stringify(fub.body)}`);

  const bulk = await api(TF_TOKEN, "/pipeline", {
    method: "PATCH", body: JSON.stringify({ action: "delete", ids: [demoEntry.id] }),
  });
  const survived = (await db(`client_pipeline_entries?select=id&id=eq.${demoEntry.id}`)).length === 1;
  check("BULK delete of another client's id → row survives (.eq client_id holds)", survived, `status ${bulk.status}`);
}

/* =========================== 4. notes ==================================== */
section("4. POST/PATCH/DELETE /pipeline/[id]/notes");
{
  const id = created[0];
  const r = await api(TF_TOKEN, `/pipeline/${id}/notes`, { method: "POST", body: JSON.stringify({ body: `${TAG} first note` }) });
  check("POST note answers 200", r.status === 200, `status ${r.status}`);
  noteId = r.body?.note?.id;
  let row = noteId ? (await db(`client_pipeline_notes?select=*&id=eq.${noteId}`))[0] : null;
  check("DB: note row exists, linked to the entry", !!row && row.entry_id === id, row ? `entry_id=${row.entry_id.slice(0,8)}` : "no row");
  check("DB: body stored trimmed", row?.body === `${TAG} first note`, row?.body);

  const e = await api(TF_TOKEN, `/pipeline/${id}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ body: `${TAG} edited note` }) });
  row = (await db(`client_pipeline_notes?select=*&id=eq.${noteId}`))[0];
  check("DB: PATCH changed the body", e.status === 200 && row.body === `${TAG} edited note`, row.body);

  const blank = await api(TF_TOKEN, `/pipeline/${id}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ body: "" }) });
  check("empty body → 400", blank.status === 400, `got ${blank.status}`);

  const wrong = await api(TF_TOKEN, `/pipeline/${demoEntry.id}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ body: "x" }) });
  check("note reached via the wrong entry id → 404", wrong.status === 404, `got ${wrong.status}`);

  const d = await api(TF_TOKEN, `/pipeline/${id}/notes/${noteId}`, { method: "DELETE" });
  const gone = (await db(`client_pipeline_notes?select=id&id=eq.${noteId}`)).length === 0;
  check("DB: DELETE removed the note row", d.status === 200 && gone, gone ? "gone" : "STILL PRESENT");
  if (gone) noteId = null;
}

/* =========================== 5. push-fub ================================== */
section("5. POST /pipeline/[id]/push-fub");
{
  const r = await api(TF_TOKEN, `/pipeline/${created[0]}/push-fub`, { method: "POST" });
  check("route is reached and returns the helper's real verdict (not a 404 route-miss)",
    r.status === 400 && r.body?.reason === "no_key", `status ${r.status} ${JSON.stringify(r.body)}`);
  const row = (await db(`client_pipeline_entries?select=fub_pushed_at,fub_last_error&id=eq.${created[0]}`))[0];
  check("DB: a no_key refusal writes nothing (no fub_pushed_at, no fub_last_error)",
    row.fub_pushed_at === null && row.fub_last_error === null, JSON.stringify(row));
}

/* =========================== 6. CSV import =============================== */
section("6. POST /pipeline/csv");
{
  const r = await api(TF_TOKEN, "/pipeline/csv", {
    method: "POST",
    body: JSON.stringify({ rows: [
      { lead_name: `${TAG} Bravo`, lead_email: "zz-portal-bravo@example.invalid", lead_phone: null, current_brokerage: "ZZ CSV Co", agent_profile_url: null, introduced_at: null, stage: "keep_warm", needs_replacement: false },
      { lead_name: `${TAG} Charlie`, lead_email: null, lead_phone: null, current_brokerage: null, agent_profile_url: null, introduced_at: null, stage: "keep_warm", needs_replacement: false },
      { lead_name: "", lead_email: null, lead_phone: null, current_brokerage: null, agent_profile_url: null, introduced_at: null, stage: "keep_warm", needs_replacement: false },
      { lead_name: `${TAG} BadStage`, lead_email: null, lead_phone: null, current_brokerage: null, agent_profile_url: null, introduced_at: null, stage: "not_a_stage", needs_replacement: false },
    ] }),
  });
  check("answers 200", r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  check("reports 2 inserted, 2 skipped", r.body?.inserted === 2 && r.body?.skipped?.length === 2, JSON.stringify(r.body));
  const rows = await db(`client_pipeline_entries?select=id,lead_name,source,stage&client_id=eq.${TEST_FUB}&lead_name=like.*Portal Route Test*&order=lead_name`);
  const names = rows.map((x) => x.lead_name).sort();
  created = [...new Set([...created, ...rows.map((x) => x.id)])];
  check("DB: exactly the two valid rows landed", rows.length === 3, `${rows.length} test rows on the client (1 from step 1 + 2 from CSV): ${names.join(", ")}`);
  check("DB: the blank-name row was NOT inserted", !names.some((n) => n === TAG), names.join(", "));
  check("DB: the bad-stage row was NOT inserted", !names.some((n) => n.includes("BadStage")), names.join(", "));
  check("DB: CSV rows carry source='Client Entry'", rows.filter((x) => x.lead_name.includes("Bravo") || x.lead_name.includes("Charlie")).every((x) => x.source === "Client Entry"), "");
}

/* ======================= 7. bulk PATCH /pipeline ========================== */
section("7. PATCH /pipeline — bulk stage / assign / delete");
{
  const ids = created.slice(0, 2);
  const r = await api(TF_TOKEN, "/pipeline", { method: "PATCH", body: JSON.stringify({ action: "stage", ids, stage: "phone_screen" }) });
  check("bulk stage answers 200", r.status === 200, `status ${r.status}`);
  let rows = await db(`client_pipeline_entries?select=id,stage&id=in.(${ids.join(",")})`);
  check("DB: both rows moved to phone_screen", rows.length === 2 && rows.every((x) => x.stage === "phone_screen"), rows.map((x) => x.stage).join(", "));

  const noStage = await api(TF_TOKEN, "/pipeline", { method: "PATCH", body: JSON.stringify({ action: "stage", ids }) });
  check("bulk stage with no stage → 400", noStage.status === 400, `got ${noStage.status}`);

  const a = await api(TF_TOKEN, "/pipeline", { method: "PATCH", body: JSON.stringify({ action: "assign", ids, assigned_team_member_id: null }) });
  rows = await db(`client_pipeline_entries?select=id,assigned_team_member_id&id=in.(${ids.join(",")})`);
  check("DB: bulk assign(null) cleared the assignment", a.status === 200 && rows.every((x) => x.assigned_team_member_id === null), "");

  const missing = await api(TF_TOKEN, "/pipeline", { method: "PATCH", body: JSON.stringify({ action: "assign", ids }) });
  check("bulk assign with the field omitted → 400 (null must be explicit)", missing.status === 400, `got ${missing.status}`);

  const third = created[2];
  const d = await api(TF_TOKEN, "/pipeline", { method: "PATCH", body: JSON.stringify({ action: "delete", ids: [third] }) });
  const gone = (await db(`client_pipeline_entries?select=id&id=eq.${third}`)).length === 0;
  check("DB: bulk delete removed the row", d.status === 200 && gone, gone ? "gone" : "STILL PRESENT");
  if (gone) created = created.filter((x) => x !== third);
}

/* =========================== 8. stage-labels ============================= */
section("8. PATCH /stage-labels — the only write to `clients`");
{
  const r = await api(TF_TOKEN, "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: { hired: "ZZ Signed", keep_warm: "  ZZ Nurture  " } }) });
  check("answers 200", r.status === 200, `status ${r.status}`);
  let row = (await db(`clients?select=stage_label_overrides,portal_token,portal_enabled,slug&id=eq.${TEST_FUB}`))[0];
  check("DB: clients.stage_label_overrides written", row.stage_label_overrides?.hired === "ZZ Signed", JSON.stringify(row.stage_label_overrides));
  check("DB: values trimmed server-side", row.stage_label_overrides?.keep_warm === "ZZ Nurture", JSON.stringify(row.stage_label_overrides));
  check("DB: portal_token UNCHANGED by a write to clients", row.portal_token === preToken, row.portal_token === preToken ? "identical" : "*** CHANGED ***");
  check("DB: portal_enabled and slug untouched", row.portal_enabled === true && row.slug === "test-fub", `${row.portal_enabled} / ${row.slug}`);

  const unknown = await api(TF_TOKEN, "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: { not_a_stage: "x" } }) });
  check("unknown stage key → 400, nothing written", unknown.status === 400, `got ${unknown.status}`);

  const blank = await api(TF_TOKEN, "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: { hired: "   " } }) });
  row = (await db(`clients?select=stage_label_overrides&id=eq.${TEST_FUB}`))[0];
  check("DB: whitespace-only override is DROPPED, not stored", blank.status === 200 && row.stage_label_overrides?.hired === undefined, JSON.stringify(row.stage_label_overrides));

  await api(TF_TOKEN, "/stage-labels", { method: "PATCH", body: JSON.stringify({ overrides: preLabels || {} }) });
  row = (await db(`clients?select=stage_label_overrides&id=eq.${TEST_FUB}`))[0];
  check("restored to the pre-test value", JSON.stringify(row.stage_label_overrides) === JSON.stringify(preLabels), JSON.stringify(row.stage_label_overrides));
}

/* ============================== 9. stages ================================ */
section("9. PATCH /stages — custom stage overlay (manage_stages)");
{
  const canonical = STAGE_ORDER.map((s) => ({ key: s, label: s, kind: "canonical", canonical_stage: s, hidden: false }));
  const withCustom = [...canonical, { key: "zz_route_test_stage", label: "ZZ Route Test Stage", kind: "custom", color: "#3b82f6", hidden: false }];

  const r = await api(TF_TOKEN, "/stages", { method: "PATCH", body: JSON.stringify({ stages: withCustom }) });
  check("answers 200", r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  let rows = await db(`client_pipeline_stages?select=key,kind,label,color,sort_order&client_id=eq.${TEST_FUB}&order=sort_order`);
  check("DB: overlay rows written for this client", rows.length === withCustom.length, `${rows.length} rows`);
  check("DB: the custom stage landed with its colour", rows.some((x) => x.key === "zz_route_test_stage" && x.color === "#3b82f6"), "");

  const missing = await api(TF_TOKEN, "/stages", { method: "PATCH", body: JSON.stringify({ stages: canonical.filter((s) => s.key !== "hired") }) });
  check("a payload that drops a canonical stage → 400 (they can be hidden, never removed)", missing.status === 400, `got ${missing.status} ${JSON.stringify(missing.body)}`);

  // placing an entry on the custom stage sets the overlay pointer, never the enum
  const id = created[0];
  const before = (await db(`client_pipeline_entries?select=stage&id=eq.${id}`))[0].stage;
  const place = await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({ custom_stage_key: "zz_route_test_stage" }) });
  let row = (await db(`client_pipeline_entries?select=stage,custom_stage_key&id=eq.${id}`))[0];
  check("DB: custom_stage_key set AND the canonical stage is untouched",
    place.status === 200 && row.custom_stage_key === "zz_route_test_stage" && row.stage === before,
    `stage=${row.stage} (was ${before}), custom=${row.custom_stage_key}`);

  const bogus = await api(TF_TOKEN, `/pipeline/${id}`, { method: "PATCH", body: JSON.stringify({ custom_stage_key: "zz_does_not_exist" }) });
  check("unknown custom stage key → 400", bogus.status === 400, `got ${bogus.status}`);

  // removing the custom stage must first clear the pointer on its entries
  const back = await api(TF_TOKEN, "/stages", { method: "PATCH", body: JSON.stringify({ stages: canonical }) });
  row = (await db(`client_pipeline_entries?select=custom_stage_key&id=eq.${id}`))[0];
  rows = await db(`client_pipeline_stages?select=key&client_id=eq.${TEST_FUB}&key=eq.zz_route_test_stage`);
  check("DB: deleting the custom stage cleared custom_stage_key on its entries (no orphan pointer)",
    back.status === 200 && row.custom_stage_key === null && rows.length === 0, `custom=${row.custom_stage_key}, stage rows=${rows.length}`);

  /*
   * The "flag off -> 404" branch is deliberately NOT exercised. Every one of the
   * 47 live clients has manage_stages on, so the only way to reach that branch
   * would be to flip a real customer's feature_flags — a write to `clients` on a
   * live portal, to test a gate. Not worth it. The gate is the tool's own line,
   * copied byte-for-byte, and it is the same clientHasFeature() call the CSV
   * route uses.
   *
   * Demo Portal is NOT used here either: it already carries 10 real overlay rows,
   * and an upsert followed by a cleanup delete would have destroyed them.
   */
}

/* ============================ 10. conversation =========================== */
section("10. GET /conversation/[entryId]");
{
  const r = await api(TF_TOKEN, `/conversation/${created[0]}`);
  check("entry with no thread → ok:true, reason no_thread", r.status === 200 && r.body?.reason === "no_thread", `status ${r.status} ${JSON.stringify(r.body).slice(0,120)}`);
  const bogus = await api(TF_TOKEN, `/conversation/00000000-0000-0000-0000-000000000000`);
  check("unknown entry id → 404", bogus.status === 404, `got ${bogus.status}`);
}

/* ================= 11. trigger 0070 — portal → inbox ===================== */
section("11. Migration 0070 — a stage move to no_show writes back to the inbox");
{
  await db(`threads?id=eq.${THREAD}`, { method: "PATCH", body: JSON.stringify({ client_id: TEST_FUB }) });
  undo.push(() => db(`threads?id=eq.${THREAD}`, { method: "PATCH", body: JSON.stringify({ client_id: threadOwner }) }));

  const seeded = (await db(`client_pipeline_entries`, {
    method: "POST",
    body: JSON.stringify({ client_id: TEST_FUB, thread_id: THREAD, stage: "keep_warm", lead_name: `${TAG} NoShow`, lead_email: "zz-portal-noshow@example.invalid" }),
  }))[0];
  created.push(seeded.id);

  const pre = await db(`label_assignments?select=label_id&target_id=eq.${THREAD}&label_id=eq.${NO_SHOW_LABEL_ID}`);
  if (pre.length) await db(`label_assignments?target_id=eq.${THREAD}&label_id=eq.${NO_SHOW_LABEL_ID}`, { method: "DELETE" });
  const hadLabelBefore = pre.length > 0;

  const conv = await api(TF_TOKEN, `/conversation/${seeded.id}`);
  check("conversation of a thread-backed entry returns its messages",
    conv.status === 200 && Array.isArray(conv.body?.messages) && conv.body.messages.length > 0,
    `${conv.body?.messages?.length ?? 0} messages`);

  // THE TEST: the stage change, driven through the route this task built.
  const r = await api(TF_TOKEN, `/pipeline/${seeded.id}`, { method: "PATCH", body: JSON.stringify({ stage: "no_show" }) });
  check("PATCH stage → no_show answers 200", r.status === 200, `status ${r.status}`);
  await new Promise((s) => setTimeout(s, 2500));
  const got = await db(`label_assignments?select=label_id,assigned_by&target_id=eq.${THREAD}&label_id=eq.${NO_SHOW_LABEL_ID}`);
  check("DB: trigger 0070 wrote 'No Show / No Response' onto the thread",
    got.length === 1, got[0] ? `assigned_by=${got[0].assigned_by}` : "NO LABEL — the route did not reach the trigger");
  if (!hadLabelBefore) undo.push(() => db(`label_assignments?target_id=eq.${THREAD}&label_id=eq.${NO_SHOW_LABEL_ID}`, { method: "DELETE" }));
}

} catch (err) {
  ok = false;
  console.log(`\n  !! threw: ${err.message}`);
} finally {
/* ============================== teardown ================================= */
  section("Teardown — and the proof it worked");
  for (const u of undo.reverse()) { try { await u(); } catch (e) { console.log(`    undo failed: ${e.message}`); } }
  if (created.length) {
    await db(`client_pipeline_entries?client_id=eq.${TEST_FUB}&id=in.(${created.join(",")})`, { method: "DELETE" });
  }
  /*
   * Section 9 leaves the canonical overlay written. Put the overlay back to
   * whatever it was before this run — for this fixture that is no rows at all,
   * which is what makes the portal fall back to the default stage set.
   */
  {
    const want = new Set(preStages.map((r) => r.key));
    const now = await db(`client_pipeline_stages?select=key&client_id=eq.${TEST_FUB}`);
    const extra = now.map((r) => r.key).filter((k) => !want.has(k));
    if (extra.length) {
      await db(`client_pipeline_stages?client_id=eq.${TEST_FUB}&key=in.(${extra.map((k) => `"${k}"`).join(",")})`, { method: "DELETE" });
    }
  }

  const leftEntries = await db(`client_pipeline_entries?select=id,lead_name&client_id=eq.${TEST_FUB}`);
  const leftStages  = await db(`client_pipeline_stages?select=key&client_id=eq.${TEST_FUB}`);
  const leftNotes   = noteId ? await db(`client_pipeline_notes?select=id&id=eq.${noteId}`) : [];
  const cl          = (await db(`clients?select=stage_label_overrides,portal_token,portal_enabled,slug&id=eq.${TEST_FUB}`))[0];
  const th          = (await db(`threads?select=client_id&id=eq.${THREAD}`))[0];
  const lbl         = await db(`label_assignments?select=label_id&target_id=eq.${THREAD}&label_id=eq.${NO_SHOW_LABEL_ID}`);
  const demoAfter   = (await db(`client_pipeline_entries?select=id,stage,lead_name&id=eq.${demoEntry.id}`))[0];
  const demoCount   = (await db(`client_pipeline_entries?select=id&client_id=eq.${DEMO}`)).length;
  const demoStages  = await db(`client_pipeline_stages?select=key&client_id=eq.${DEMO}`);

  console.log(`  created ${created.length} entries during this run`);
  check("every test entry is gone (Test FUB back to its pre-test count)", leftEntries.length === preEntries.length, `${leftEntries.length} entries, was ${preEntries.length}${leftEntries.length ? ` — LEFTOVER: ${leftEntries.map(e=>e.lead_name).join(", ")}` : ""}`);
  check("no test notes left", leftNotes.length === 0, `${leftNotes.length}`);
  check("stage overlay restored", leftStages.length === preStages.length, `${leftStages.length} rows, was ${preStages.length}`);
  check("Demo Portal overlay untouched (still its own 10 rows)", demoStages.length === demoStagesBefore, `${demoStages.length} rows, was ${demoStagesBefore}`);
  check("stage_label_overrides restored", JSON.stringify(cl.stage_label_overrides) === JSON.stringify(preLabels), JSON.stringify(cl.stage_label_overrides));
  check("PORTAL TOKEN IDENTICAL", cl.portal_token === preToken, cl.portal_token === preToken ? "identical" : "*** CHANGED ***");
  check("portal_enabled / slug identical", cl.portal_enabled === true && cl.slug === "test-fub", `${cl.portal_enabled} / ${cl.slug}`);
  check("test thread returned to its original client", th.client_id === threadOwner, th.client_id === threadOwner ? "restored" : "NOT RESTORED");
  check("no-show label removed from the test thread", lbl.length === 0, `${lbl.length}`);
  check("Demo Portal entry untouched throughout", JSON.stringify(demoAfter) === demoBefore, JSON.stringify(demoAfter));
  check("Demo Portal entry count unchanged (15)", demoCount === 15, `${demoCount}`);

/* ================== the acceptance test: the live portal ================= */
  section("The acceptance test — a real customer's page still renders");
  try {
    const live = await fetch(`https://portal.brokerstaffer.com/portal/${TF_TOKEN}`, { redirect: "follow" });
    const html = await live.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    check("live portal (the client we wrote to) responds 200", live.status === 200, `status ${live.status}`);
    check("its pipeline is present on the page", /Pipeline|Introduction|Keep Warm|Hired/i.test(text), text.slice(0, 90));
    check("no leftover test data visible to the client", !text.includes("Portal Route Test"), text.includes("Portal Route Test") ? "*** TEST DATA VISIBLE ***" : "clean");
  } catch (e) {
    check("live portal reachable", false, e.message);
  }
}

console.log(`\n  ${failures.length === 0 && ok ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`     ✗ ${f}`);
process.exit(failures.length === 0 && ok ? 0 : 1);
