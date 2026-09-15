/*
 * Every control on the Onboarding client detail screen, exercised for real and
 * verified in the database — and every one of the fourteen step buttons proved
 * to REFUSE.
 *
 *   node scripts/onboarding-client-write-test.mjs [baseUrl]
 *
 * The point is the second half of each check. A route that answers 200 has
 * proved nothing; this project has already shipped a settings page whose every
 * field was read-only. So every write here is followed by a direct PostgREST
 * read of the row it claimed to change, and the assertion is on what the
 * DATABASE says.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 * NOTHING TOUCHES A REAL CLIENT. The script creates its own client row, its own
 * team/roster/DNC rows, its own lead links and its own delivery row, all named
 * or tagged "ZZ Client Page Test", uses them, and deletes them — and the last
 * assertions are that the deletes actually happened.
 *
 * The step tests are run against that same fixture. They cannot do damage even
 * if a step were wired up by mistake, because the fixture client has no email,
 * no portal and no campaign — but that is belt and braces: the assertion is that
 * every one of the seventeen actions answers 400 or 501 and never 200.
 *
 * Run scripts/onboarding-fingerprint.mjs before and after; it proves no real row
 * was lost while this was running.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3340";

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
async function db(query, init) {
  const res = await fetch(`${E.AGENT_SEARCH_SUPABASE_URL}/rest/v1/${query}`, {
    ...init,
    headers: {
      apikey: E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`db ${res.status} ${query}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

const TAG = `ZZ Client Page Test ${Date.now()}`;
let CLIENT = null;

async function cleanup() {
  if (!CLIENT) return;
  // Children first — orch_client_fields has no ON DELETE CASCADE guarantee we
  // rely on, so the script removes what it made rather than assuming.
  for (const t of ["orch_client_fields", "orch_client_leads", "orch_client_team", "orch_connector_deliveries"]) {
    await db(`${t}?client_id=eq.${CLIENT}`, { method: "DELETE" }).catch(() => {});
  }
  await db(`orch_clients?id=eq.${CLIENT}`, { method: "DELETE" }).catch(() => {});
}

try {
  /* ======================= the fixture ================================== */
  console.log(`\nFIXTURE  (everything below happens to "${TAG}", never a real client)`);

  const stages = await db("orch_stages?select=id,name&order=sort");
  const agents = await db("agents?select=id&limit=3");

  const made = await db("orch_clients", {
    method: "POST",
    body: JSON.stringify({
      client_name: TAG,
      brand: "ZZ Test Brokerage",
      office_name: "ZZ Test Office",
      status: "new",
      copy_status: "pending",
      // No email, no portal, no campaign: every step's precondition fails
      // closed, so even a wired step would have nothing to send to.
      primary_contact: {},
      location: "Testville, ZZ",
      timezone: "EST",
      filters: { sales_volume_min: 1000000, closed_transactions_min: 5 },
      stage_id: stages[0].id,
    }),
  });
  CLIENT = made[0].id;
  check("created a throwaway client to test against", !!CLIENT, CLIENT ?? "no id");

  await db("orch_client_team", {
    method: "POST",
    // PostgREST requires every object in a bulk insert to carry the same keys.
    body: JSON.stringify([
      { client_id: CLIENT, name: "ZZ Form Filler", email: "zz@example.invalid", phone: null, role: "Owner", source: "typeform", is_dnc: false },
      { client_id: CLIENT, name: "ZZ Their Agent", email: null, phone: null, role: "Agent", source: "db", is_dnc: true },
      { client_id: CLIENT, name: "ZZ Excluded Office", email: null, phone: null, role: null, source: "typeform", is_dnc: true },
    ]),
  });
  if (agents.length) {
    await db("orch_client_leads", {
      method: "POST",
      body: JSON.stringify(agents.map((a) => ({ client_id: CLIENT, agent_id: a.id }))),
    });
  }
  await db("orch_connector_deliveries", {
    method: "POST",
    body: JSON.stringify({
      client_id: CLIENT, target: "email", action: "welcome", status: "ok",
      request: { note: TAG }, response: null, error: null,
    }),
  });
  console.log(`      client ${CLIENT} · 3 team rows · ${agents.length} lead links · 1 delivery`);

  /* ============================ the read ================================= */
  console.log("\nREAD");
  {
    const { status, body } = await api(`/clients/${CLIENT}`);
    check("GET /clients/:id answers 200", status === 200, String(status));
    check("…and returns this client", body?.client?.id === CLIENT, body?.client?.id);
    check("…splits team / roster / DNC correctly",
      body?.team?.length === 1 && body?.roster?.length === 1 && body?.dnc?.length === 1,
      `team=${body?.team?.length} roster=${body?.roster?.length} dnc=${body?.dnc?.length}`);
    check("…counts the lead list", body?.leadCount === agents.length, String(body?.leadCount));
    check("…carries all 14 step states", Object.keys(body?.steps ?? {}).length === 14,
      String(Object.keys(body?.steps ?? {}).length));
    check("…marks the welcome email done from its delivery row", body?.steps?.["email:welcome"]?.done === true,
      JSON.stringify(body?.steps?.["email:welcome"]));
    check("…computes progress from the ticks", body?.progress?.done === 1 && body?.progress?.total === 14,
      JSON.stringify(body?.progress));
    check("…reads the delivery log", body?.deliveries?.length === 1, String(body?.deliveries?.length));
    check("…sends the server's clock, not the browser's", typeof body?.now === "string", String(body?.now));
  }
  {
    const { status } = await api(`/clients/00000000-0000-0000-0000-000000000000`);
    check("GET on a client that does not exist answers 404", status === 404, String(status));
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}/leads`);
    check("GET /clients/:id/leads answers 200", status === 200, String(status));
    check("…and returns the built list", body?.total === agents.length && body?.rows?.length === agents.length,
      `total=${body?.total} rows=${body?.rows?.length}`);
    check("…joined to the scraped agent details", body?.rows?.every?.((r) => "fullName" in r), "missing agent columns");
  }

  /* ========================== profile writes ============================= */
  console.log("\nPROFILE WRITES  (each one read back from Postgres)");

  const target = stages.find((s) => s.id !== stages[0].id) ?? stages[0];
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ stageId: target.id }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=stage_id`))[0];
    check(`stage → "${target.name}"`, status === 200 && row.stage_id === target.id, `${status} ${row.stage_id}`);
  }
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ tacName: "Sara" }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=tac_name`))[0];
    check("TAC → Sara", status === 200 && row.tac_name === "Sara", `${status} ${row.tac_name}`);
  }
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ mls: ["ZZTEST1", "ZZTEST2", "ZZTEST1"] }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=mls`))[0];
    check("MLS → two codes, de-duplicated", status === 200 && row.mls === "ZZTEST1, ZZTEST2", `${status} ${row.mls}`);
  }
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ mls: [] }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=mls`))[0];
    check("MLS → cleared", status === 200 && row.mls === null, `${status} ${row.mls}`);
  }
  {
    const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ photo: px }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=photo_url`))[0];
    check("photo → stored as a data URL", status === 200 && row.photo_url === px, `${status} ${(row.photo_url ?? "").slice(0, 24)}`);
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ photo: "javascript:alert(1)" }) });
    check("photo → a non-image is refused", status === 400, `${status} ${body?.error}`);
  }
  {
    const name = `ZZ Salesperson ${Date.now()}`;
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ salespersonName: name }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=salesperson_id`))[0];
    const person = row.salesperson_id ? (await db(`orch_salespeople?id=eq.${row.salesperson_id}&select=name,role`))[0] : null;
    check("salesperson → a new name creates the person and assigns them",
      status === 200 && person?.name === name && person?.role === "salesperson", `${status} ${JSON.stringify(person)}`);

    // Assigning an EXISTING name must reuse the row, not make a second one.
    const before = (await db(`orch_salespeople?name=eq.${encodeURIComponent(name)}&select=id`)).length;
    await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ salespersonName: name }) });
    const after = (await db(`orch_salespeople?name=eq.${encodeURIComponent(name)}&select=id`)).length;
    check("salesperson → an existing name is reused, not duplicated", before === 1 && after === 1, `${before} → ${after}`);

    // Made by this script, so it goes away with it.
    if (row.salesperson_id) {
      await db(`orch_clients?id=eq.${CLIENT}`, { method: "PATCH", body: JSON.stringify({ salesperson_id: null }) });
      await db(`orch_salespeople?id=eq.${row.salesperson_id}`, { method: "DELETE" });
      const gone = await db(`orch_salespeople?id=eq.${row.salesperson_id}&select=id`);
      check("…and the test salesperson is cleaned up", gone.length === 0, `${gone.length} left`);
    }
  }
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ copyStatus: "approved" }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=copy_status,status`))[0];
    check("copy approval → writes the flag", status === 200 && row.copy_status === "approved", `${status} ${row.copy_status}`);
    check("…and moves status out of the auto-email pool", row.status === "copy_approved", row.status);
  }
  {
    const { status } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ copyStatus: "rejected" }) });
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=copy_status,status`))[0];
    check("copy rejection → writes the flag and leaves status alone",
      status === 200 && row.copy_status === "rejected" && row.status === "copy_approved", `${status} ${row.copy_status} ${row.status}`);
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}`, { method: "PATCH", body: JSON.stringify({ nonsense: 1 }) });
    check("an unknown field is a 400, not a silent no-op", status === 400, `${status} ${body?.error}`);
  }

  /* ========================== custom fields ============================== */
  console.log("\nCUSTOM FIELDS");
  let fieldA = null, fieldB = null;
  {
    const { status, body } = await api(`/clients/${CLIENT}/fields`, {
      method: "POST", body: JSON.stringify({ label: "ZZ Website", type: "url", value: "example.invalid" }),
    });
    fieldA = body?.id;
    const rows = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id,label,type,value,sort`);
    check("add a field", status === 200 && rows.length === 1 && rows[0].label === "ZZ Website", `${status} ${JSON.stringify(rows)}`);
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}/fields`, {
      method: "POST", body: JSON.stringify({ label: "ZZ Contact", type: "email", value: "not-an-email" }),
    });
    check("a value that fails its type is refused", status === 400, `${status} ${body?.error}`);
  }
  {
    const { body } = await api(`/clients/${CLIENT}/fields`, {
      method: "POST", body: JSON.stringify({ label: "ZZ Second", type: "text", value: "" }),
    });
    fieldB = body?.id;
    const rows = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id,sort&order=sort`);
    check("a field can be added with no value yet", rows.length === 2, `${rows.length}`);
    check("…and lands after the first", rows[0].id === fieldA && rows[1].id === fieldB, JSON.stringify(rows));
  }
  {
    const { status } = await api(`/clients/${CLIENT}/fields/${fieldA}`, {
      method: "PATCH", body: JSON.stringify({ value: "https://example.invalid/contract" }),
    });
    const row = (await db(`orch_client_fields?id=eq.${fieldA}&select=value`))[0];
    check("edit a field's value", status === 200 && row.value === "https://example.invalid/contract", `${status} ${row.value}`);
  }
  {
    const { status } = await api(`/clients/${CLIENT}/fields/${fieldA}`, { method: "PATCH", body: JSON.stringify({ move: "down" }) });
    const rows = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id&order=sort`);
    check("move a field down", status === 200 && rows[0].id === fieldB && rows[1].id === fieldA, JSON.stringify(rows));
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}/fields/${fieldA}`, {
      method: "PATCH", body: JSON.stringify({ type: "email" }),
    });
    check("changing the type is accepted", status === 200, `${status} ${body?.error}`);
  }
  {
    // The client id is in every filter, so a field id from ANOTHER client
    // changes nothing rather than the wrong row.
    const { status } = await api(`/clients/00000000-0000-0000-0000-000000000000/fields/${fieldA}`, {
      method: "PATCH", body: JSON.stringify({ label: "HIJACKED" }),
    });
    const row = (await db(`orch_client_fields?id=eq.${fieldA}&select=label`))[0];
    check("a field cannot be edited through the wrong client id", row.label !== "HIJACKED", `${status} ${row.label}`);
  }
  {
    const { status } = await api(`/clients/${CLIENT}/fields/${fieldA}`, { method: "DELETE" });
    const rows = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id`);
    check("delete a field", status === 200 && rows.length === 1, `${status} ${rows.length}`);
  }

  /* ============================== the MLS ================================= */
  console.log("\nMLS LOOKUP  (reads Agent Search's table; may never write it)");
  {
    const { status, body } = await api(`/mls?q=mls`);
    check("MLS type-ahead answers 200", status === 200, String(status));
    check("…and returns options with a code and a name",
      Array.isArray(body?.options) && body.options.every((o) => o.code), JSON.stringify(body?.options?.slice(0, 2)));
    const short = await api(`/mls?q=m`);
    check("…and returns nothing for a single character", short.body?.options?.length === 0, String(short.body?.options?.length));
  }

  /* ==================== THE FOURTEEN STEPS: ALL REFUSE =================== */
  console.log("\nTHE STEP BUTTONS  (the whole point: not one of these may ever run)");
  const ACTIONS = [
    "email:welcome", "email:confirmations", "push:client_portal", "email:how_intros_work",
    "email:meet_team", "email:portal", "email:dnc_reminder", "build:team", "push:health_dash",
    "campaign:build", "build:leads", "campaign:launch", "email:campaign_launched",
    "email:followup_call", "campaign:pause", "payment:link", "setup:remaining",
  ];
  let ran = 0;
  for (const step of ACTIONS) {
    const { status, body } = await api(`/clients/${CLIENT}/steps`, { method: "POST", body: JSON.stringify({ step }) });
    const refused = status !== 200 && body?.enabled === false;
    if (!refused) ran++;
    check(`${step.padEnd(24)} → ${status} ${status === 501 ? "not enabled" : "refused"}`,
      refused, `status=${status} enabled=${body?.enabled}`);
  }
  check("NOT ONE of the 17 actions answered 200", ran === 0, `${ran} did`);
  {
    const { status, body } = await api(`/clients/${CLIENT}/steps`, { method: "POST", body: JSON.stringify({ step: "email:launch_nukes" }) });
    check("an unknown step key is rejected before anything is looked up", status === 400, `${status} ${body?.error}`);
  }
  {
    const { status } = await api(`/clients/00000000-0000-0000-0000-000000000000/steps`, {
      method: "POST", body: JSON.stringify({ step: "email:welcome" }),
    });
    check("a step on a client that does not exist is a 404", status === 404, String(status));
  }
  {
    // Preconditions are real, not decoration: this client has no email, so
    // every email step refuses with the reason the live action would give.
    const { status, body } = await api(`/clients/${CLIENT}/steps`, { method: "POST", body: JSON.stringify({ step: "email:meet_team" }) });
    check("a failed precondition gives the real action's own reason",
      status === 400 && /no email/i.test(body?.error ?? ""), `${status} ${body?.error}`);
  }
  {
    const { status, body } = await api(`/clients/${CLIENT}/steps`, { method: "POST", body: JSON.stringify({ step: "campaign:launch" }) });
    check("campaign:launch refuses because there is no campaign",
      status === 400 && /no campaign/i.test(body?.error ?? ""), `${status} ${body?.error}`);
  }
  {
    // A valid request with every precondition met — the one that reaches 501.
    const { status, body } = await api(`/clients/${CLIENT}/steps`, { method: "POST", body: JSON.stringify({ step: "push:client_portal" }) });
    check("a fully valid step reaches 501 and names what it would have called",
      status === 501 && /Client Portal/i.test(body?.target ?? ""), `${status} ${body?.target}`);
    check("…and says what that call does", /creates the client's portal account/i.test(body?.wouldDo ?? ""), body?.wouldDo);
    check("…and names the credential the workspace lacks", !!body?.credential, body?.credential);
  }
  {
    // Nothing the step route did may have changed the row.
    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=portal_url,bison_campaign_id,leads_inreview,bison_leads_exported,stripe_payment_url`))[0];
    check("after 17 step presses the client row is untouched",
      !row.portal_url && !row.bison_campaign_id && !row.leads_inreview && !row.bison_leads_exported && !row.stripe_payment_url,
      JSON.stringify(row));
    const deliveries = await db(`orch_connector_deliveries?client_id=eq.${CLIENT}&select=id`);
    check("…and no new delivery was logged", deliveries.length === 1, `${deliveries.length}`);
  }

  /* ============================== cleanup ================================ */
  console.log("\nCLEANUP");
  await cleanup();
  const leftClient = await db(`orch_clients?id=eq.${CLIENT}&select=id`);
  const leftTeam = await db(`orch_client_team?client_id=eq.${CLIENT}&select=id`);
  const leftFields = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id`);
  const leftLeads = await db(`orch_client_leads?client_id=eq.${CLIENT}&select=id`);
  const leftDeliv = await db(`orch_connector_deliveries?client_id=eq.${CLIENT}&select=id`);
  check(`the test client ${CLIENT} is gone`, leftClient.length === 0, `${leftClient.length} left`);
  check("…and its team, fields, leads and deliveries with it",
    leftTeam.length + leftFields.length + leftLeads.length + leftDeliv.length === 0,
    `team=${leftTeam.length} fields=${leftFields.length} leads=${leftLeads.length} deliveries=${leftDeliv.length}`);
  CLIENT = null;
} catch (e) {
  failures.push(`THREW: ${e?.message ?? e}`);
  console.error("\n  ✗ threw:", e);
} finally {
  // A failure part-way through must not leave a fixture behind.
  await cleanup().catch(() => {});
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`     ✗ ${f}`);
  process.exit(1);
}
