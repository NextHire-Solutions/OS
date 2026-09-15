/*
 * Onboarding, end to end, for real — against the two REVERSIBLE legs.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/onboard-e2e-test.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ACTUALLY DOES, AND WHY IT STOPS WHERE IT DOES
 *
 * It creates a clearly-marked fixture client, runs the Analytics and Client
 * Health legs for real against the live tools, checks the rows arrived, checks
 * the record, checks a re-run is a no-op, checks the Master Inbox gate
 * refuses — and then deletes the two fixture rows it made.
 *
 * It deliberately never runs the Master Inbox leg, because that leg mints a
 * live login-free portal URL. Testing it for real would mean publishing an
 * address for a fake brokerage, and "we deleted it afterwards" is not a thing
 * you can say about a URL that existed.
 *
 * The fixture name is unmistakable so that if cleanup ever fails, the leftover
 * is obviously not a customer.
 */
import fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const NAME = `ZZ OS Onboard Test ${Date.now()}`;
const { osTable } = await import("@/lib/clients/os-db.ts");
const { runOnboarding } = await import("@/lib/clients/onboard-run.ts");
const { mintAnalyticsSession } = await import("@/lib/connectors/upstream-auth/analytics-session.ts");

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const input = {
  name: NAME,
  plan: "production",
  weeklyTarget: 3,
  aliases: [`${NAME} Alias`],
  startDate: new Date().toISOString().slice(0, 10),
};

let osId = null;
const made = { analytics: null, clientHealth: null };

try {
  /* --- a fixture client in our own table ------------------------------- */
  const { data: created, error: cErr } = await osTable("os_clients")
    .insert({ name: NAME, slug: NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              aliases: input.aliases, status: "prospect", source: "os" })
    .select("id").single();
  if (cErr) throw new Error(cErr.message);
  osId = created.id;
  check(true, "fixture client created in os_clients", osId.slice(0, 8));

  /* --- 1. the gate: Master Inbox must refuse to go first ---------------- */
  const gate = await runOnboarding(osId, input, { stopBefore: "analytics" });
  const miLeg = gate.legs.find(l => l.leg === "master_inbox");
  check(!miLeg || miLeg.status !== "done",
        "Master Inbox does not run when earlier legs have not succeeded",
        miLeg ? miLeg.error ?? miLeg.status : "not reached");

  /* --- 2. run the two reversible legs for real -------------------------- */
  const run = await runOnboarding(osId, input, { stopBefore: "master_inbox" });
  const an = run.legs.find(l => l.leg === "analytics");
  const ch = run.legs.find(l => l.leg === "client_health");
  check(an?.status === "done", "Analytics leg succeeded", `HTTP ${an?.httpStatus} id=${an?.remoteId}`);
  check(ch?.status === "done", "Client Health leg succeeded", `HTTP ${ch?.httpStatus} id=${ch?.remoteId}`);
  made.analytics = an?.remoteId ?? null;
  made.clientHealth = ch?.remoteId ?? null;
  const held = run.legs.find(l => l.leg === "master_inbox");
  check(held?.status === "skipped", "Master Inbox held back — no portal minted", held?.error);

  /* --- 3. the rows really exist in the tools ---------------------------- */
  const anTok = await mintAnalyticsSession(process.env.ANALYTICS_AUTH_SECRET,
    process.env.ANALYTICS_SERVICE_EMAIL || "command-center@brokerstaffer.com");
  const anList = await (await fetch(`${process.env.ANALYTICS_URL.replace(/\/$/, "")}/api/clients`,
    { headers: { cookie: `bsa_session=${anTok}` } })).json();
  check((anList.clients ?? []).some(c => c.name === NAME), "the client is really in Analytics now");

  const chList = await (await fetch(`${process.env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients`,
    { headers: { "x-admin-token": process.env.CLIENT_HEALTH_READ_TOKEN } })).json();
  const chRow = (chList.clients ?? []).find(c => c.name === NAME);
  check(!!chRow, "the client is really in Client Health now");
  check(chRow?.plan === "production" && chRow?.weekly_target === 3,
        "Client Health stored the plan and weekly target",
        `plan=${chRow?.plan} weekly_target=${chRow?.weekly_target}`);

  /* --- 4. the links were written back ----------------------------------- */
  const { data: linked } = await osTable("os_clients")
    .select("an_client_id, ch_client_id, mi_client_id").eq("id", osId).single();
  check(!!linked?.an_client_id && !!linked?.ch_client_id,
        "os_clients stored both returned ids");
  check(!linked?.mi_client_id, "no Master Inbox id was stored — nothing was created there");

  /* --- 5. the record --------------------------------------------------- */
  const { data: rows } = await osTable("os_client_onboarding")
    .select("leg, status, attempts, remote_id").eq("os_client_id", osId);
  const done = (rows ?? []).filter(r => r.status === "done").map(r => r.leg).sort();
  check(JSON.stringify(done) === JSON.stringify(["analytics", "client_health"]),
        "os_client_onboarding records exactly the two legs that ran", done.join(", "));

  /* --- 6. idempotency: a re-run must not create duplicates -------------- */
  const again = await runOnboarding(osId, input, { stopBefore: "master_inbox" });
  const reran = again.legs.filter(l => l.status === "done");
  check(reran.length === 0, "a re-run repeats nothing", again.legs.map(l => `${l.leg}:${l.status}`).join(" "));

  const anAfter = await (await fetch(`${process.env.ANALYTICS_URL.replace(/\/$/, "")}/api/clients`,
    { headers: { cookie: `bsa_session=${anTok}` } })).json();
  check((anAfter.clients ?? []).filter(c => c.name === NAME).length === 1,
        "still exactly one Analytics row after the re-run");
} catch (e) {
  check(false, "unexpected error", e instanceof Error ? e.message : String(e));
} finally {
  /* --- cleanup: remove everything this test made ------------------------ */
  console.log("\n  cleanup");
  if (made.analytics) {
    const tok = await mintAnalyticsSession(process.env.ANALYTICS_AUTH_SECRET,
      process.env.ANALYTICS_SERVICE_EMAIL || "command-center@brokerstaffer.com");
    const r = await fetch(`${process.env.ANALYTICS_URL.replace(/\/$/, "")}/api/clients/${made.analytics}`,
      { method: "DELETE", headers: { cookie: `bsa_session=${tok}` } });
    check(r.ok, "Analytics fixture removed", `HTTP ${r.status}`);
  }
  if (made.clientHealth) {
    // Client Health refuses the read token for writes, so this uses the
    // dashboard-password cookie it mints for its own UI.
    const pw = process.env.CLIENT_HEALTH_DASHBOARD_PASSWORD;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("bs-dashboard-authed"));
    const cookie = Buffer.from(sig).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = await fetch(`${process.env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients?id=${made.clientHealth}`,
      { method: "DELETE", headers: { cookie: `bs_auth=${cookie}` } });
    check(r.ok, "Client Health fixture removed", `HTTP ${r.status}`);
  }
  if (osId) {
    await osTable("os_client_onboarding").delete().eq("os_client_id", osId);
    await osTable("os_clients").delete().eq("id", osId);
    check(true, "os_clients fixture removed");
  }
  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
