/*
 * The test that would have caught the last four bugs.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * Everything verified before this asked "does the app render correctly right
 * now": 35 screens, 122 filters, clipping, overlap, contrast. All of it passed,
 * and all of it missed four bugs a person hit within minutes of using the
 * feature:
 *
 *   · a newly onboarded client showed "missing" in all three tool columns,
 *     because the roster resolved names against a list compiled into the build.
 *     Invisible when testing the 37 seeded clients — every one of them is IN
 *     that list. Only a client created after the last deploy triggers it.
 *   · "Delete everywhere, including the portal" left the Analytics and Client
 *     Health rows behind.
 *   · the onboard dialog appeared to do nothing when the run finished.
 *   · the AI reply button returned "no API key configured" for an agent that
 *     had one.
 *
 * The common thread: nobody had ever driven the WORKFLOW end to end against a
 * client that did not already exist. This does exactly that — creates a
 * throwaway client, asserts every downstream surface a real client depends on,
 * then deletes it and asserts nothing is left behind.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 * The client name is unique per run and obviously disposable, so it can never
 * collide with a real client or absorb their campaigns — the thing that made
 * "OpsLabs" hoover up 9 live campaigns via matchMode "contains".
 *
 *   node scripts/lifecycle-test.mjs            full create → verify → delete
 *   node scripts/lifecycle-test.mjs --keep     leave it behind for inspection
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const KEEP = process.argv.includes("--keep");
const STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const NAME = `ZZ Lifecycle Test ${STAMP}`;

const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";
const raw = fs.readFileSync(`${B}/.env.local`, "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };

const { mintSso, ALL_TOOLS } = await import(`${B}/src/lib/bs-auth.ts`);
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"),
  { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;

const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const db = (url, key) => async (p) => {
  const r = await fetch(`${url}/rest/v1/${p}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  return r.ok ? r.json() : [{ __err: `HTTP ${r.status}` }];
};
const mi = db(pick("MASTER_INBOX_SUPABASE_URL"), pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY"));
const an = db(pick("ANALYTICS_SUPABASE_URL"), pick("ANALYTICS_SUPABASE_SERVICE_ROLE_KEY"));
const ch = db(pick("CLIENT_HEALTH_SUPABASE_URL"), pick("CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY"));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`);
};
const enc = encodeURIComponent;

console.log(`\nCLIENT LIFECYCLE — ${NAME}\n${"=".repeat(70)}\n`);

/* ---------------------------------------------------------- 1. CREATE */
console.log("1. Onboard\n");
const adopt = await api("/api/workspace/clients/adopt", {
  method: "POST", body: JSON.stringify({ name: NAME, aliases: [] }),
});
check("adopt creates the OS record", adopt.status === 200 && !!adopt.body?.id,
  `HTTP ${adopt.status} id=${adopt.body?.id ?? "-"}`);
const osId = adopt.body?.id;
if (!osId) { console.log("\n  cannot continue without an OS record"); process.exit(1); }

const run = await api("/api/workspace/clients/onboard/execute", {
  method: "POST",
  body: JSON.stringify({
    osClientId: osId, confirm: NAME, name: NAME, plan: "minimum",
    weeklyTarget: 5, aliases: [], billingInterval: "biweekly",
  }),
});
const legs = run.body?.legs ?? [];
check("all three legs run", legs.length === 3, `legs: ${legs.map((l) => `${l.leg}=${l.status}`).join(", ")}`);
check("no leg errored", legs.every((l) => l.status === "done" || l.status === "skipped"),
  legs.filter((l) => l.error).map((l) => `${l.leg}: ${l.error}`).join("; ") || "none");

/* ---------------------------------------------------------- 2. VERIFY */
console.log("\n2. Every downstream surface\n");
const osRow = (await mi(`os_clients?id=eq.${osId}`))[0];
check("OS record links all three tools", !!(osRow?.mi_client_id && osRow?.ch_client_id && osRow?.an_client_id),
  `mi=${osRow?.mi_client_id ? "set" : "NULL"} ch=${osRow?.ch_client_id ? "set" : "NULL"} an=${osRow?.an_client_id ? "set" : "NULL"}`);

const miRow = osRow?.mi_client_id ? (await mi(`clients?id=eq.${osRow.mi_client_id}`))[0] : null;
check("Master Inbox row exists with a portal", !!(miRow?.portal_token && miRow?.portal_enabled),
  `portal=${miRow?.portal_token ? miRow.portal_token.slice(0, 16) + "…" : "NONE"} enabled=${miRow?.portal_enabled}`);
/*
 * The FULL flag set, not just the three Master Inbox's own route seeds.
 *
 * This is the check that would have caught the missing product tour: a client
 * onboarded through the API launched with three flags while 52 of 60 live
 * clients carry nine, so its portal had no tour, no plan display, no CSV
 * upload, no source split, no integrations label and no interview stage.
 */
const flags = miRow?.feature_flags ?? {};
const REQUIRED = ["manage_stages", "pipeline_kanban_view", "pipeline_board_enhanced",
  "portal_tour", "show_client_plan", "pipeline_csv_upload", "pipeline_source_split",
  "nav_integrations_label", "interview_scheduled_stage"];
const lacking = REQUIRED.filter((f) => flags[f] !== true);
check("portal launches with the full feature set (all 9 flags)", lacking.length === 0,
  lacking.length ? `missing: ${lacking.join(", ")}` : `all 9 set`);
check("run result reports what happened to the portal features",
  typeof run.body?.portalFeatures === "string" && !/could NOT/.test(run.body.portalFeatures),
  String(run.body?.portalFeatures ?? "(not reported)"));

const list = osRow?.mi_client_id ? await mi(`lists?client_id=eq.${osRow.mi_client_id}`) : [];
check("sidebar list created", list.length === 1, list.length ? `"${list[0].name}" shared=${list[0].shared}` : "none");

check("Analytics row exists", osRow?.an_client_id
  ? (await an(`clients?id=eq.${osRow.an_client_id}`)).length === 1 : false);
const chRow = osRow?.ch_client_id ? (await ch(`clients?id=eq.${osRow.ch_client_id}`))[0] : null;
check("Client Health row exists with the plan we asked for", chRow?.plan === "minimum" && chRow?.weekly_target === 5,
  `plan=${chRow?.plan} target=${chRow?.weekly_target}`);

// THE REGRESSION: a client created after the last deploy must resolve in the
// roster, which is what the compiled ROSTER array silently prevented.
const roster = await api("/api/workspace/roster");
const rows = roster.body?.rows ?? roster.body?.clients ?? [];
const mine = rows.find((r) => (r.client?.name ?? r.name) === NAME);
check("roster exposes a portal link for it",
  typeof mine?.portalUrl === "string" && /\/portal\//.test(mine.portalUrl),
  mine?.portalUrl ?? "(none)");
check("roster shows it as present in all three tools (not 'missing')",
  !!mine && mine.health?.present !== false && mine.inbox?.present !== false && mine.analytics?.present !== false,
  mine ? `health=${mine.health?.present} inbox=${mine.inbox?.present} analytics=${mine.analytics?.present}`
       : `not on the roster (${rows.length} rows)`);

if (KEEP) {
  console.log(`\n  --keep: leaving "${NAME}" in place (os id ${osId})`);
} else {
  /* -------------------------------------------------------- 3. DELETE */
  console.log("\n3. Delete everywhere, and prove nothing is left\n");
  const plan = await api(`/api/workspace/clients/delete?id=${enc(osId)}&scope=everything`);
  const willRemove = JSON.stringify(plan.body?.willDelete ?? []);
  check('the "everything" plan promises all three tool rows',
    /Analytics/i.test(willRemove) && /Client Health/i.test(willRemove) && /Master Inbox/i.test(willRemove),
    willRemove.slice(0, 200));

  const del = await api("/api/workspace/clients/delete", {
    method: "POST",
    body: JSON.stringify({ id: osId, scope: "everything", confirm: NAME, acceptDataLoss: true }),
  });
  check("delete succeeds", del.status === 200 && (del.body?.failed ?? []).length === 0,
    `HTTP ${del.status} removed=${JSON.stringify(del.body?.removed ?? [])} failed=${JSON.stringify(del.body?.failed ?? [])}`);

  check("OS record gone", (await mi(`os_clients?id=eq.${osId}`)).length === 0);
  check("Master Inbox row and portal gone", osRow?.mi_client_id
    ? (await mi(`clients?id=eq.${osRow.mi_client_id}`)).length === 0 : true);
  check("sidebar list gone", osRow?.mi_client_id
    ? (await mi(`lists?client_id=eq.${osRow.mi_client_id}`)).length === 0 : true);
  check("Analytics row gone", osRow?.an_client_id
    ? (await an(`clients?id=eq.${osRow.an_client_id}`)).length === 0 : true);
  check("Client Health row gone", osRow?.ch_client_id
    ? (await ch(`clients?id=eq.${osRow.ch_client_id}`)).length === 0 : true);
  check("no onboarding history orphaned",
    (await mi(`os_client_onboarding?os_client_id=eq.${osId}`)).length === 0);
}

console.log("\n" + "=".repeat(70));
const bad = results.filter((r) => !r.pass);
console.log(bad.length
  ? `  ${bad.length} of ${results.length} FAILED:\n${bad.map((b) => "      " + b.name).join("\n")}`
  : `  all ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
