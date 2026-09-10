/*
 * Every Client Health write, exercised for real and verified in the database.
 *
 *   node scripts/client-health-write-test.mjs [baseUrl]
 *
 * These writes used to be forwarded to the live Client Health app. They are now
 * performed by the OS itself, against the same Supabase project — so "the route
 * returned 200" proves nothing at all. Each check below sends the request the
 * screen sends, then reads the row back through PostgREST and asserts on what
 * the DATABASE says.
 *
 * SAFETY
 *
 *   No real client is touched. Two throwaway clients are created by this script
 *   under a "ZZ Port Test" name, used, and deleted; two throwaway campaign cache
 *   rows and one weekly_metrics row are seeded the same way. A finally block
 *   removes anything still standing if an assertion throws part-way, and the
 *   last checks assert the cleanup actually happened.
 *
 *   The delete tests are the reason for the fixtures. A cascade cannot be
 *   verified by reasoning about it: you have to put a row on the other side of
 *   the foreign key and watch it go.
 *
 * Run scripts/client-health-fingerprint.mjs before and after. It proves no real
 * client and no real row was lost while this was running.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3310";

const E = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
  if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const COOKIE = `bs_sso=${await mintSso(E.AUTH_SECRET, {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
})}`;

const U = E.CLIENT_HEALTH_SUPABASE_URL;
const K = E.CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY;
const DB_HEADERS = { apikey: K, Authorization: `Bearer ${K}`, "content-type": "application/json" };

/* --------------------------- the two halves ------------------------------- */

/** Through the workspace's own API, exactly as the screen calls it. */
async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api/tools/client-health${path}`, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Straight to Postgres, to see what actually landed. */
async function db(query) {
  const res = await fetch(`${U}/rest/v1/${query}`, { headers: DB_HEADERS });
  if (!res.ok) throw new Error(`db read failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Fixtures only. Nothing under test writes through this. */
async function seed(table, row) {
  const res = await fetch(`${U}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...DB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seed ${table} failed ${res.status}: ${await res.text()}`);
  return (await res.json())[0];
}

async function scrub(query) {
  await fetch(`${U}/rest/v1/${query}`, { method: "DELETE", headers: DB_HEADERS }).catch(() => {});
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

const STAMP = Date.now();
const NAME_A = `ZZ Port Test A ${STAMP}`;
const NAME_B = `ZZ Port Test B ${STAMP}`;
const CAMP_I = `zz-os-port-test-instantly-${STAMP}`;
const CAMP_B = `zz-os-port-test-bison-${STAMP}`;

let idA = null;
let idB = null;

try {
  /* ------------------------------------------------------------ fixtures -- */

  console.log("\nFixtures");
  await seed("instantly_campaigns", {
    id: CAMP_I,
    name: `ZZ Port Test Instantly ${STAMP}`,
    status: "paused",
  });
  await seed("bison_campaigns", {
    id: CAMP_B,
    name: `ZZ Port Test Bison ${STAMP}`,
    status: "paused",
  });
  check("two throwaway campaign cache rows seeded", true);

  /* -------------------------------------------------------------- create -- */

  console.log("\nPOST /clients");
  const created = await api("/clients", {
    method: "POST",
    body: JSON.stringify({
      name: NAME_A,
      plan: "production",
      weekly_target: 5,
      monthly_target: 20,
      start_date: "2026-01-05",
      instantly_campaign_ids: [CAMP_I],
      bison_campaign_ids: [CAMP_B],
      billing_anchor_date: "2026-01-05",
      billing_interval: "custom",
      billing_interval_days: 21,
      time_zone: "America/New_York",
    }),
  });
  check("returns 201", created.status === 201, `got ${created.status} ${JSON.stringify(created.body)}`);
  idA = created.body?.client?.id ?? null;
  check("returns the new client's id", Boolean(idA));
  if (!idA) throw new Error("cannot continue without an id");

  const [rowA] = await db(`clients?id=eq.${idA}&select=*`);
  check("the row exists in the database", Boolean(rowA));
  check("name stored", rowA?.name === NAME_A, rowA?.name);
  check("plan stored", rowA?.plan === "production", rowA?.plan);
  check("weekly_target stored", rowA?.weekly_target === 5, String(rowA?.weekly_target));
  check("monthly_target stored", rowA?.monthly_target === 20, String(rowA?.monthly_target));
  check("start_date stored", rowA?.start_date === "2026-01-05", rowA?.start_date);
  check("billing_anchor_date stored", rowA?.billing_anchor_date === "2026-01-05", rowA?.billing_anchor_date);
  check("billing_interval stored", rowA?.billing_interval === "custom", rowA?.billing_interval);
  check("billing_interval_days stored", rowA?.billing_interval_days === 21, String(rowA?.billing_interval_days));
  check("instantly_campaign_ids stored", rowA?.instantly_campaign_ids?.[0] === CAMP_I, JSON.stringify(rowA?.instantly_campaign_ids));
  check("bison_campaign_ids stored", rowA?.bison_campaign_ids?.[0] === CAMP_B, JSON.stringify(rowA?.bison_campaign_ids));
  check("campaign_size defaults to 0", rowA?.campaign_size === 0, String(rowA?.campaign_size));
  check("hidden defaults to false", rowA?.hidden === false, String(rowA?.hidden));
  check("client_paused defaults to false", rowA?.client_paused === false, String(rowA?.client_paused));
  // The fix. The live tool's POST never reads body.time_zone, so this column
  // was null for every client added through its own modal.
  check(
    "time_zone stored — the field the live tool silently drops",
    rowA?.time_zone === "America/New_York",
    String(rowA?.time_zone),
  );

  console.log("\nPOST /clients — rejections");
  const badPlan = await api("/clients", {
    method: "POST",
    body: JSON.stringify({ name: `${NAME_A} bad`, plan: "enterprise", weekly_target: 5 }),
  });
  check("an unknown plan is refused", badPlan.status === 400, `got ${badPlan.status}`);
  const leaked = await db(`clients?name=eq.${encodeURIComponent(`${NAME_A} bad`)}&select=id`);
  check("and no row was written", leaked.length === 0);

  const noName = await api("/clients", {
    method: "POST",
    body: JSON.stringify({ name: "   ", plan: "production", weekly_target: 5 }),
  });
  check("a blank name is refused", noName.status === 400, `got ${noName.status}`);

  /* ------------------------------------------- second client + a metric --- */

  console.log("\nFixtures — a second client and one weekly metric");
  const createdB = await api("/clients", {
    method: "POST",
    body: JSON.stringify({
      name: NAME_B,
      plan: "minimum",
      weekly_target: 2,
      // Shares client A's Instantly campaign, so the orphan rule has something
      // to decline to delete.
      instantly_campaign_ids: [CAMP_I],
    }),
  });
  idB = createdB.body?.client?.id ?? null;
  check("second client created", createdB.status === 201 && Boolean(idB));
  check(
    "time_zone omitted becomes null, not an empty string",
    (await db(`clients?id=eq.${idB}&select=time_zone`))[0]?.time_zone === null,
  );

  await seed("weekly_metrics", {
    client_id: idA,
    week_key: "2026-01-05",
    emails_sent: 123,
    intros: 4,
  });
  const metricsBefore = await db(`weekly_metrics?client_id=eq.${idA}&select=week_key`);
  check("one weekly_metrics row seeded against client A", metricsBefore.length === 1);

  /* -------------------------------------------------------------- update -- */

  console.log("\nPATCH /clients");
  const renamed = await api("/clients", {
    method: "PATCH",
    body: JSON.stringify({
      id: idA,
      name: `${NAME_A} renamed`,
      plan: "partner",
      weekly_target: 12,
      monthly_target: 48,
      start_date: "2026-02-02",
      billing_interval: "monthly",
      billing_interval_days: null,
      time_zone: "Europe/London",
    }),
  });
  check("full edit returns 200", renamed.status === 200, `got ${renamed.status} ${JSON.stringify(renamed.body)}`);
  let [now] = await db(`clients?id=eq.${idA}&select=*`);
  check("name changed in the database", now?.name === `${NAME_A} renamed`, now?.name);
  check("plan changed", now?.plan === "partner", now?.plan);
  check("weekly_target changed", now?.weekly_target === 12, String(now?.weekly_target));
  check("monthly_target changed", now?.monthly_target === 48, String(now?.monthly_target));
  check("start_date changed", now?.start_date === "2026-02-02", now?.start_date);
  check("billing_interval changed", now?.billing_interval === "monthly", now?.billing_interval);
  check("billing_interval_days cleared", now?.billing_interval_days === null, String(now?.billing_interval_days));
  check("time_zone changed", now?.time_zone === "Europe/London", String(now?.time_zone));

  const paused = await api("/clients", {
    method: "PATCH",
    body: JSON.stringify({ id: idA, client_paused: true }),
  });
  check("pause returns 200", paused.status === 200, `got ${paused.status}`);
  [now] = await db(`clients?id=eq.${idA}&select=*`);
  check("client_paused is true in the database", now?.client_paused === true);
  check("and the pause left every other column alone", now?.name === `${NAME_A} renamed` && now?.plan === "partner");

  await api("/clients", { method: "PATCH", body: JSON.stringify({ id: idA, client_paused: false }) });
  [now] = await db(`clients?id=eq.${idA}&select=client_paused`);
  check("resume sets it back to false", now?.client_paused === false);

  await api("/clients", { method: "PATCH", body: JSON.stringify({ id: idA, hidden: true }) });
  [now] = await db(`clients?id=eq.${idA}&select=hidden`);
  check("churn sets hidden true", now?.hidden === true);
  await api("/clients", { method: "PATCH", body: JSON.stringify({ id: idA, hidden: false }) });
  [now] = await db(`clients?id=eq.${idA}&select=hidden`);
  check("restore sets hidden false", now?.hidden === false);

  console.log("\nPATCH /clients — what it refuses to do");
  const syncOwned = await api("/clients", {
    method: "PATCH",
    body: JSON.stringify({ id: idA, emails_today: 99999, portal_url: "https://nope.example", total_intros_corofy: 777 }),
  });
  [now] = await db(`clients?id=eq.${idA}&select=emails_today,portal_url,total_intros_corofy`);
  check(
    "a body of nothing but sync-owned columns is refused",
    syncOwned.status === 400,
    `got ${syncOwned.status}`,
  );
  check(
    "and none of them moved in the database",
    now?.emails_today === 0 && now?.portal_url === null && now?.total_intros_corofy === 0,
    JSON.stringify(now),
  );

  const badInterval = await api("/clients", {
    method: "PATCH",
    body: JSON.stringify({ id: idA, billing_interval: "fortnightly" }),
  });
  check("an unknown billing interval is refused", badInterval.status === 400, `got ${badInterval.status}`);
  [now] = await db(`clients?id=eq.${idA}&select=billing_interval`);
  check("and the stored interval is untouched", now?.billing_interval === "monthly", now?.billing_interval);

  const noSuchClient = await api("/clients", {
    method: "PATCH",
    body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", hidden: true }),
  });
  check("an id that is not there reads as 404", noSuchClient.status === 404, `got ${noSuchClient.status}`);

  const badId = await api("/clients", { method: "PATCH", body: JSON.stringify({ id: "all", hidden: true }) });
  check("an id that is not a uuid is refused", badId.status === 400, `got ${badId.status}`);

  /* -------------------------------------------------------------- delete -- */

  console.log("\nDELETE /clients");
  const noId = await api("/clients", { method: "DELETE" });
  check("a delete with no id is refused", noId.status === 400, `got ${noId.status}`);
  const notUuid = await api("/clients?id=all", { method: "DELETE" });
  check("a delete with a non-uuid id is refused", notUuid.status === 400, `got ${notUuid.status}`);
  check(
    "and both clients are still there",
    (await db(`clients?id=in.(${idA},${idB})&select=id`)).length === 2,
  );

  const deletedA = await api(`/clients?id=${idA}`, { method: "DELETE" });
  check("delete returns 200", deletedA.status === 200, `got ${deletedA.status} ${JSON.stringify(deletedA.body)}`);
  check(
    "one orphan reported — the Bison campaign only client A used",
    deletedA.body?.orphansRemoved === 1,
    String(deletedA.body?.orphansRemoved),
  );
  check("client A is gone", (await db(`clients?id=eq.${idA}&select=id`)).length === 0);
  // THE CASCADE. Nothing in the OS deletes this row; the foreign key does.
  check(
    "client A's weekly_metrics row went with it — the ON DELETE CASCADE",
    (await db(`weekly_metrics?client_id=eq.${idA}&select=week_key`)).length === 0,
  );
  check(
    "the Bison campaign cache row was evicted",
    (await db(`bison_campaigns?id=eq.${CAMP_B}&select=id`)).length === 0,
  );
  check(
    "the shared Instantly campaign was KEPT — client B still links to it",
    (await db(`instantly_campaigns?id=eq.${CAMP_I}&select=id`)).length === 1,
  );

  const deletedB = await api(`/clients?id=${idB}`, { method: "DELETE" });
  check("second delete returns 200", deletedB.status === 200, `got ${deletedB.status}`);
  check(
    "now the Instantly campaign is an orphan and is reported",
    deletedB.body?.orphansRemoved === 1,
    String(deletedB.body?.orphansRemoved),
  );
  check("client B is gone", (await db(`clients?id=eq.${idB}&select=id`)).length === 0);
  check(
    "and the Instantly campaign cache row went with it",
    (await db(`instantly_campaigns?id=eq.${CAMP_I}&select=id`)).length === 0,
  );
  idA = null;
  idB = null;

  const gone = await api(`/clients?id=${created.body.client.id}`, { method: "DELETE" });
  check("deleting an already-deleted client reads as 404", gone.status === 404, `got ${gone.status}`);
} finally {
  console.log("\nCleanup");
  if (idA) await scrub(`clients?id=eq.${idA}`);
  if (idB) await scrub(`clients?id=eq.${idB}`);
  await scrub(`instantly_campaigns?id=eq.${CAMP_I}`);
  await scrub(`bison_campaigns?id=eq.${CAMP_B}`);

  const strays = await db(`clients?name=like.ZZ%20Port%20Test*&select=id,name`).catch(() => []);
  check("no ZZ Port Test client remains", strays.length === 0, JSON.stringify(strays));
  const strayI = await db(`instantly_campaigns?id=like.zz-os-port-test*&select=id`).catch(() => []);
  const strayB = await db(`bison_campaigns?id=like.zz-os-port-test*&select=id`).catch(() => []);
  check("no test campaign cache row remains", strayI.length === 0 && strayB.length === 0);
}

console.log(`\n${pass} passed · ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
