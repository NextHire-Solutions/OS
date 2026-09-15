/*
 * The delete path, end to end, against the dev server and live tools.
 *
 * Creates a fixture, onboards it to Analytics + Client Health for real (never
 * Master Inbox), then deletes it everywhere and checks it is actually gone.
 */
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { mintSso, ALL_TOOLS } = await import("@/lib/bs-auth.ts");
const tok = await mintSso(env.BS_SSO_SECRET || env.AUTH_SECRET,
  { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const H = { cookie: `bs_sso=${tok}`, "Content-Type": "application/json" };
const B = "http://localhost:3210";
const NAME = `ZZ Delete Test ${Date.now()}`;

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// 1. adopt (idempotent)
const a1 = await (await fetch(`${B}/api/workspace/clients/adopt`, { method: "POST", headers: H, body: JSON.stringify({ name: NAME }) })).json();
const a2 = await (await fetch(`${B}/api/workspace/clients/adopt`, { method: "POST", headers: H, body: JSON.stringify({ name: NAME }) })).json();
check(a1.id === a2.id && a1.created === true && a2.created === false,
      "adopt is idempotent — a second press reaches the same record", a1.id.slice(0, 8));
const id = a1.id;

// 2. run the two reversible legs
const run = await (await fetch(`${B}/api/workspace/clients/onboard/execute`, {
  method: "POST", headers: H,
  body: JSON.stringify({ osClientId: id, confirm: NAME, stopBefore: "master_inbox",
                         name: NAME, plan: "production", weeklyTarget: 3 }) })).json();
check(run.legs.filter(l => l.status === "done").length === 2, "two legs ran",
      run.legs.map(l => `${l.leg}:${l.status}`).join(" "));

// 3. the delete plan is shown before asking
const plan = await (await fetch(`${B}/api/workspace/clients/delete?id=${id}&scope=tools`, { headers: H })).json();
check(Array.isArray(plan.willDelete) && plan.willDelete.length >= 2,
      "the plan lists what will go", plan.willDelete.join(" · "));
check(!plan.blocked, "not blocked for an ordinary client");

// 4. it refuses without the exact name
const noConfirm = await fetch(`${B}/api/workspace/clients/delete`, { method: "POST", headers: H, body: JSON.stringify({ id, scope: "tools" }) });
check(noConfirm.status === 400, "refuses with no confirmation", `HTTP ${noConfirm.status}`);
const wrong = await fetch(`${B}/api/workspace/clients/delete`, { method: "POST", headers: H, body: JSON.stringify({ id, scope: "tools", confirm: "something else" }) });
check(wrong.status === 400, "refuses with the wrong name", `HTTP ${wrong.status}`);

// 5. a protected row cannot be deleted
const { data: demo } = await (await import("@/lib/clients/os-db.ts")).osTable("os_clients")
  .select("id, name").ilike("name", "%Demo Portal%").maybeSingle();
if (demo) {
  const p = await (await fetch(`${B}/api/workspace/clients/delete?id=${demo.id}&scope=os`, { headers: H })).json();
  check(!!p.blocked, "the demo portal is protected", p.blocked ?? "");
} else {
  check(true, "demo portal not in os_clients — nothing to protect here");
}

// 6. delete for real
const del = await fetch(`${B}/api/workspace/clients/delete`, { method: "POST", headers: H, body: JSON.stringify({ id, scope: "tools", confirm: NAME }) });
const delBody = await del.json();
check(del.ok && delBody.failed.length === 0, "deleted", delBody.removed?.join(", "));

// 7. really gone
const anTok = await (await import("@/lib/connectors/upstream-auth/analytics-session.ts"))
  .mintAnalyticsSession(process.env.ANALYTICS_AUTH_SECRET, process.env.ANALYTICS_SERVICE_EMAIL || "command-center@brokerstaffer.com");
const an = await (await fetch(`${process.env.ANALYTICS_URL.replace(/\/$/, "")}/api/clients`, { headers: { cookie: `bsa_session=${anTok}` } })).json();
check(!(an.clients ?? []).some(c => c.name === NAME), "gone from Analytics");
const ch = await (await fetch(`${process.env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients`, { headers: { "x-admin-token": process.env.CLIENT_HEALTH_READ_TOKEN } })).json();
check(!(ch.clients ?? []).some(c => c.name === NAME), "gone from Client Health");
const roster = await (await fetch(`${B}/api/workspace/roster`, { headers: H })).json();
check(!roster.rows.some(r => r.client.name === NAME), "gone from the OS list");

console.log(`\n  ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
