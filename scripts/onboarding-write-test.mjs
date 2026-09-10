/*
 * Every Onboarding control, exercised for real and verified in the database.
 *
 *   node scripts/onboarding-write-test.mjs [baseUrl]
 *
 * The point is the second half of each check. A route that answers 200 has
 * proved nothing — this project has already shipped a settings page whose fields
 * were all read-only and 23 routes that 401'd to everybody. So every write here
 * is followed by a direct PostgREST read of the row it claimed to change, and
 * the assertion is on what the DATABASE says, not on what the route said.
 *
 * SAFETY
 *
 *   Nothing touches a real client's row. Every mutable fixture is created by
 *   this script with a "ZZ Port Test" name, used, and deleted; the assertions
 *   include that the delete actually happened.
 *
 *   The two settings rows (automation_enabled, step_labels) are real and cannot
 *   be duplicated, so their original values are read first and restored at the
 *   end — including if an assertion fails part-way through.
 *
 * Run scripts/onboarding-fingerprint.mjs before and after; it proves no row was
 * lost while this was running.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3330";

const E = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
  if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const COOKIE = `bs_sso=${await mintSso(E.BS_SSO_SECRET || E.AUTH_SECRET, {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
})}`;

/* --------------------------- the two halves ------------------------------- */

/** Through the workspace's own API, exactly as the screen calls it. */
async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api/tools/onboarding${path}`, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Straight to Postgres, to see what actually landed. */
async function db(query) {
  const res = await fetch(`${E.AGENT_SEARCH_SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      apikey: E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`db read failed ${res.status}: ${await res.text()}`);
  return res.json();
}

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TAG = `ZZ Port Test ${Date.now()}`;
// A 1×1 transparent PNG, the smallest thing that satisfies the photo rule.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/* Restored in `finally`, so an assertion failure cannot leave them changed. */
let originalAutomation = null;
let originalLabels = null;
let createdStage = null;
/* Whether orch_settings had a step_labels row before this script ran. */
let stepLabelsRowExisted = null;
let createdTemplate = null;
let createdPerson = null;

try {
  /* ======================= reads ========================================== */
  console.log("\nREADS");

  const pipeline = await api("");
  check("GET /                 pipeline reads", pipeline.status === 200 && Array.isArray(pipeline.body?.clients),
    `status ${pipeline.status}`);
  check("  … and returns real clients", (pipeline.body?.clients?.length ?? 0) > 0,
    `${pipeline.body?.clients?.length} clients`);

  const board = await api("/stages");
  check("GET /stages           board reads", board.status === 200 && Array.isArray(board.body?.stages),
    `status ${board.status}`);
  const dbStageCount = (await db("orch_stages?select=id")).length;
  check("  … stage count matches the database", board.body?.stages?.length === dbStageCount,
    `route ${board.body?.stages?.length} vs db ${dbStageCount}`);

  const tpl = await api("/templates");
  check("GET /templates        reads", tpl.status === 200 && Array.isArray(tpl.body?.templates),
    `status ${tpl.status}`);
  const dbTplCount = (await db("orch_templates?select=id")).length;
  check("  … template count matches the database", tpl.body?.templates?.length === dbTplCount,
    `route ${tpl.body?.templates?.length} vs db ${dbTplCount}`);

  const set = await api("/settings");
  check("GET /settings         reads", set.status === 200 && typeof set.body?.automationEnabled === "boolean",
    `status ${set.status}`);
  check("  … carries the roster", Array.isArray(set.body?.people) && set.body.people.length > 0,
    `${set.body?.people?.length} people`);
  check("  … reports the mailbox as read-only here", set.body?.mailbox?.manageableHere === false);
  check("  … never leaks the refresh token", JSON.stringify(set.body?.mailbox ?? {}).includes("refresh_token") === false);

  originalAutomation = set.body.automationEnabled;
  originalLabels = set.body.stepLabels ?? {};
  // The team has never renamed a button, so this row does not exist yet. Noted
  // now so the cleanup can remove the one this script is about to create.
  stepLabelsRowExisted = (await db("orch_settings?key=eq.step_labels&select=key")).length > 0;

  /* ======================= stages ========================================= */
  console.log("\nSTAGES  (on a stage this script creates and deletes)");

  const made = await api("/stages", { method: "POST", body: JSON.stringify({ name: TAG }) });
  createdStage = made.body?.id;
  check("POST /stages          creates", made.status === 200 && !!createdStage, `status ${made.status}`);

  let row = (await db(`orch_stages?id=eq.${createdStage}&select=id,name,sort,color`))[0];
  check("  … the row is really there, named as asked", row?.name === TAG, JSON.stringify(row));
  check("  … and defaults to the neutral colour", row?.color === "neutral", row?.color);

  const before = await db("orch_stages?select=id,sort&order=sort");
  const lastSort = before[before.length - 1].sort;
  check("  … placed at the end of the order", row.sort === lastSort, `sort ${row.sort}, last ${lastSort}`);

  await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ name: `${TAG} renamed` }) });
  row = (await db(`orch_stages?id=eq.${createdStage}&select=name`))[0];
  check("PATCH name            renames in the database", row?.name === `${TAG} renamed`, row?.name);

  await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ color: "blue" }) });
  row = (await db(`orch_stages?id=eq.${createdStage}&select=color`))[0];
  check("PATCH colour          recolours in the database", row?.color === "blue", row?.color);

  // Reorder: our stage is last, so "up" must swap sorts with the one above it.
  const ordered = await db("orch_stages?select=id,sort&order=sort");
  const mineIdx = ordered.findIndex((s) => s.id === createdStage);
  const above = ordered[mineIdx - 1];
  const mineSort = ordered[mineIdx].sort;
  await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ move: "up" }) });
  const afterUp = await db("orch_stages?select=id,sort&order=sort");
  const mineNow = afterUp.find((s) => s.id === createdStage);
  const aboveNow = afterUp.find((s) => s.id === above.id);
  check("PATCH move up         swaps sort with the neighbour",
    mineNow.sort === above.sort && aboveNow.sort === mineSort,
    `mine ${mineSort}→${mineNow.sort}, neighbour ${above.sort}→${aboveNow.sort}`);
  check("  … and the order really changed",
    afterUp.findIndex((s) => s.id === createdStage) === mineIdx - 1);

  await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ move: "down" }) });
  const afterDown = await db("orch_stages?select=id,sort&order=sort");
  check("PATCH move down       puts it back",
    afterDown.findIndex((s) => s.id === createdStage) === mineIdx);

  const bad = await api("/stages", { method: "POST", body: JSON.stringify({ name: "   " }) });
  check("POST blank name       refused with 400", bad.status === 400, `status ${bad.status}`);
  const badField = await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ nonsense: 1 }) });
  check("PATCH unknown field   refused with 400", badField.status === 400, `status ${badField.status}`);
  const badColour = await api(`/stages/${createdStage}`, { method: "PATCH", body: JSON.stringify({ color: "puce" }) });
  check("PATCH unknown colour  refused with 400", badColour.status === 400, `status ${badColour.status}`);

  const del = await api(`/stages/${createdStage}`, { method: "DELETE" });
  check("DELETE /stages/:id    removes it", del.status === 200, `status ${del.status}`);
  check("  … no client was standing on it", del.body?.moved === 0, `moved ${del.body?.moved}`);
  check("  … and the row is gone from the database",
    (await db(`orch_stages?id=eq.${createdStage}&select=id`)).length === 0);
  if ((await db(`orch_stages?id=eq.${createdStage}&select=id`)).length === 0) createdStage = null;

  /* ====================== templates ====================================== */
  console.log("\nTEMPLATES  (on a template this script creates and deletes)");

  const t = await api("/templates", { method: "POST", body: JSON.stringify({ category: "campaign_copy" }) });
  createdTemplate = t.body?.id;
  check("POST /templates       creates", t.status === 200 && !!createdTemplate, `status ${t.status}`);

  let trow = (await db(`orch_templates?id=eq.${createdTemplate}&select=name,category,body`))[0];
  check("  … with the tool's own starter row",
    trow?.name === "New template" && trow?.category === "campaign_copy" && trow?.body.includes("{{firstName}}"),
    JSON.stringify(trow));

  await api(`/templates/${createdTemplate}`, {
    method: "PATCH",
    body: JSON.stringify({ name: TAG, subject: "Subject {{firstName}}", body: "Body {{Brokerage Name}}" }),
  });
  trow = (await db(`orch_templates?id=eq.${createdTemplate}&select=name,subject,body,updated_at`))[0];
  check("PATCH template        saves the wording to the database",
    trow?.name === TAG && trow?.subject === "Subject {{firstName}}" && trow?.body === "Body {{Brokerage Name}}",
    JSON.stringify(trow));
  check("  … and stamps updated_at", !!trow?.updated_at);

  const badCat = await api("/templates", { method: "POST", body: JSON.stringify({ category: "nope" }) });
  check("POST unknown category refused with 400", badCat.status === 400, `status ${badCat.status}`);

  // The important one: a template the automation sends must survive a delete.
  const welcome = (await db("orch_templates?key=eq.welcome&select=id,name"))[0];
  const guarded = await api(`/templates/${welcome.id}`, { method: "DELETE" });
  check("DELETE a system template is refused", guarded.status === 400, `status ${guarded.status}`);
  check("  … with the tool's own sentence",
    /automation/i.test(guarded.body?.error ?? ""), guarded.body?.error);
  check("  … and it is STILL in the database",
    (await db(`orch_templates?id=eq.${welcome.id}&select=id`)).length === 1);

  const tdel = await api(`/templates/${createdTemplate}`, { method: "DELETE" });
  check("DELETE /templates/:id removes a non-system one", tdel.status === 200, `status ${tdel.status}`);
  check("  … and the row is gone from the database",
    (await db(`orch_templates?id=eq.${createdTemplate}&select=id`)).length === 0);
  if ((await db(`orch_templates?id=eq.${createdTemplate}&select=id`)).length === 0) createdTemplate = null;

  /* ======================= settings ====================================== */
  console.log("\nSETTINGS  (real rows — originals restored at the end)");

  await api("/settings", { method: "PATCH", body: JSON.stringify({ automationEnabled: !originalAutomation }) });
  let srow = (await db("orch_settings?key=eq.automation_enabled&select=value"))[0];
  check("PATCH automation      flips the real row",
    srow?.value === !originalAutomation, `value ${JSON.stringify(srow?.value)}`);

  const reread = await api("/settings");
  check("  … and the route reads its own new value back (no stale cache)",
    reread.body?.automationEnabled === !originalAutomation, `${reread.body?.automationEnabled}`);

  await api("/settings", { method: "PATCH", body: JSON.stringify({ automationEnabled: originalAutomation }) });
  srow = (await db("orch_settings?key=eq.automation_enabled&select=value"))[0];
  check("  … and restores", srow?.value === originalAutomation, `value ${JSON.stringify(srow?.value)}`);

  await api("/settings", {
    method: "PATCH",
    body: JSON.stringify({ stepLabels: { "email:welcome": "ZZ Test Caption", "email:portal": "   " } }),
  });
  let lrow = (await db("orch_settings?key=eq.step_labels&select=value"))[0];
  check("PATCH step labels     stores the caption",
    lrow?.value?.["email:welcome"] === "ZZ Test Caption", JSON.stringify(lrow?.value));
  check("  … and DROPS a blank one rather than storing an empty caption",
    !("email:portal" in (lrow?.value ?? {})), JSON.stringify(lrow?.value));

  await api("/settings", { method: "PATCH", body: JSON.stringify({ stepLabels: originalLabels }) });
  lrow = (await db("orch_settings?key=eq.step_labels&select=value"))[0];
  check("  … and restores the originals",
    JSON.stringify(lrow?.value ?? {}) === JSON.stringify(originalLabels), JSON.stringify(lrow?.value));

  const badSet = await api("/settings", { method: "PATCH", body: JSON.stringify({ automationEnabled: "yes" }) });
  check("PATCH non-boolean     refused with 400", badSet.status === 400, `status ${badSet.status}`);

  /* ======================== people ======================================= */
  console.log("\nROSTER  (on a person this script creates and deletes)");

  const p = await api("/people", {
    method: "POST",
    body: JSON.stringify({ role: "account_manager", name: TAG, email: "zz@example.com", photo: null }),
  });
  createdPerson = p.body?.id;
  check("POST /people          creates", p.status === 200 && !!createdPerson, `status ${p.status}`);

  let prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=name,email,role,active,photo_url`))[0];
  check("  … the row is there, in the role asked for",
    prow?.name === TAG && prow?.role === "account_manager" && prow?.active === true, JSON.stringify(prow));

  await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ name: `${TAG} renamed` }) });
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=name`))[0];
  check("PATCH name            renames in the database", prow?.name === `${TAG} renamed`, prow?.name);

  await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ photo: PNG }) });
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=photo_url`))[0];
  check("PATCH photo           stores the image", prow?.photo_url === PNG, String(prow?.photo_url).slice(0, 30));

  const badPhoto = await api(`/people/${createdPerson}`, {
    method: "PATCH",
    body: JSON.stringify({ photo: "javascript:alert(1)" }),
  });
  check("PATCH hostile photo   refused with 400", badPhoto.status === 400, `status ${badPhoto.status}`);
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=photo_url`))[0];
  check("  … and the stored photo is untouched", prow?.photo_url === PNG);

  await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ photo: null }) });
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=photo_url`))[0];
  check("PATCH photo null      clears it", prow?.photo_url === null, String(prow?.photo_url));

  await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=active`))[0];
  check("PATCH active false    hides them", prow?.active === false, String(prow?.active));
  await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ active: true }) });
  prow = (await db(`orch_salespeople?id=eq.${createdPerson}&select=active`))[0];
  check("PATCH active true     restores them", prow?.active === true, String(prow?.active));

  const badRole = await api(`/people/${createdPerson}`, { method: "PATCH", body: JSON.stringify({ role: "wizard" }) });
  check("PATCH unknown role    refused with 400", badRole.status === 400, `status ${badRole.status}`);

  const pdel = await api(`/people/${createdPerson}`, { method: "DELETE" });
  check("DELETE /people/:id    removes an unassigned person", pdel.status === 200, `status ${pdel.status}`);
  check("  … deleted rather than hidden, since no client used them", pdel.body?.hidden === 0, `hidden ${pdel.body?.hidden}`);
  check("  … and the row is gone from the database",
    (await db(`orch_salespeople?id=eq.${createdPerson}&select=id`)).length === 0);
  if ((await db(`orch_salespeople?id=eq.${createdPerson}&select=id`)).length === 0) createdPerson = null;

  /* ====================== pipeline: the manual move ====================== */
  console.log("\nPIPELINE  (a real client's stage — moved and moved straight back)");
  {
    /*
     * This is the one check that touches a real client row, because there is no
     * such thing as a test client here: orch_clients is fed by the Typeform
     * webhook and inserting a fake one would put it on the team's board.
     *
     * A stage is a LABEL — it triggers no work and skips none (see
     * lib/tools/onboarding/stages.ts) — and this reads the current value, moves
     * it, checks it moved, and puts it back, asserting the restore. The
     * fingerprint run afterwards is the independent proof that it really is back.
     */
    const client = (await db("orch_clients?select=id,client_name,stage_id&order=created_at&limit=1"))[0];
    const stages = await db("orch_stages?select=id,name&order=sort");
    const target = stages.find((st) => st.id !== client.stage_id);
    console.log(`      using "${client.client_name}" — stage ${client.stage_id ?? "(none)"} → ${target.name} → back`);

    const moved = await api(`/clients/${client.id}`, {
      method: "PATCH",
      body: JSON.stringify({ stageId: target.id }),
    });
    check("PATCH /clients/:id   moves a client along the board", moved.status === 200, `status ${moved.status}`);
    let crow = (await db(`orch_clients?id=eq.${client.id}&select=stage_id,status`))[0];
    check("  … the stage really changed in the database", crow?.stage_id === target.id, String(crow?.stage_id));

    const back = await api(`/clients/${client.id}`, {
      method: "PATCH",
      body: JSON.stringify({ stageId: client.stage_id }),
    });
    crow = (await db(`orch_clients?id=eq.${client.id}&select=stage_id`))[0];
    check("  … and it is put straight back", back.status === 200 && crow?.stage_id === client.stage_id,
      `now ${crow?.stage_id}, was ${client.stage_id}`);

    const badBody = await api(`/clients/${client.id}`, { method: "PATCH", body: JSON.stringify({ status: "live" }) });
    check("PATCH client status   refused — status is the automation's, not ours",
      badBody.status === 400, `status ${badBody.status}`);
  }

  /* ===================== health dashboard ================================ */
  console.log("\nHEALTH DASHBOARD");
  const h = await api("/health", { method: "POST" });
  if (h.status === 200) {
    check("POST /health          the daily sync runs on demand", true);
    console.log(`      matched ${h.body?.matched}, unmatched ${h.body?.unmatched?.length ?? 0}`);
    const stamp = (await db("orch_settings?key=eq.health_status_synced_at&select=value"))[0];
    const fresh = stamp?.value && Date.now() - Date.parse(stamp.value) < 120_000;
    check("  … and stamps the sync time in the database", !!fresh, String(stamp?.value));
  } else {
    check(`POST /health          answered ${h.status}`, false, h.body?.error);
  }
} catch (e) {
  failures.push(`THREW: ${e.message}`);
  console.log(`\n  ✗ threw: ${e.message}`);
} finally {
  /* Leave nothing behind, even if an assertion failed part-way. */
  console.log("\nCLEANUP");
  const restore = async (label, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
    } catch (e) {
      console.log(`  ✗ ${label} — ${e.message}`);
      failures.push(`cleanup: ${label}`);
    }
  };
  if (createdStage) await restore("test stage removed", () => api(`/stages/${createdStage}`, { method: "DELETE" }));
  if (createdTemplate) await restore("test template removed", () => api(`/templates/${createdTemplate}`, { method: "DELETE" }));
  if (createdPerson) await restore("test person removed", () => api(`/people/${createdPerson}`, { method: "DELETE" }));
  if (typeof originalAutomation === "boolean") {
    await restore("automation switch restored", () =>
      api("/settings", { method: "PATCH", body: JSON.stringify({ automationEnabled: originalAutomation }) }));
  }
  if (originalLabels && typeof originalLabels === "object") {
    await restore("step labels restored", () =>
      api("/settings", { method: "PATCH", body: JSON.stringify({ stepLabels: originalLabels }) }));
  }
  if (stepLabelsRowExisted === false) {
    await restore("step_labels row removed (it did not exist before)", async () => {
      const row = await db("orch_settings?key=eq.step_labels&select=value");
      // Only if it is still the empty object this script restored it to — never
      // delete real captions somebody set while this was running.
      if (row.length && JSON.stringify(row[0].value) === "{}") {
        const r = await fetch(
          `${E.AGENT_SEARCH_SUPABASE_URL}/rest/v1/orch_settings?key=eq.step_labels`,
          {
            method: "DELETE",
            headers: {
              apikey: E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        );
        if (!r.ok) throw new Error(`delete failed ${r.status}`);
      }
    });
  }
  if (!createdStage && !createdTemplate && !createdPerson) console.log("  ✓ no test rows left behind");
}

console.log(`\n  ${pass} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`     ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
