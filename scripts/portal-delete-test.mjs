/*
 * Deleting a client EVERYWHERE, portal included.
 *
 * This is the only test in the suite that creates a real Master Inbox client,
 * which means it mints a real portal token. It is named unmistakably, it is
 * deleted at the end, and it is never given a customer.
 *
 * Two things must both be true, and they pull in opposite directions:
 *
 *   · an EMPTY portal can be removed on the strength of the name alone
 *   · a portal with real content must be REFUSED without an explicit
 *     acknowledgement, however correctly the name was typed
 *
 * The second is the one that protects a trading client from a mis-click, so it
 * is tested by giving the fixture portal content and checking the refusal.
 */
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { osTable } = await import("@/lib/clients/os-db.ts");
const { runOnboarding } = await import("@/lib/clients/onboard-run.ts");
const { planDelete, deleteClient } = await import("@/lib/clients/delete.ts");
const { toSlug } = await import("@/lib/clients/slug.ts");

const NAME = `ZZ Portal Delete Test ${Date.now()}`;
let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const MI = process.env.MASTER_INBOX_SUPABASE_URL;
const KEY = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const miCount = async () => {
  const r = await fetch(`${MI}/rest/v1/clients?select=id`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  return Number((r.headers.get("content-range") || "/0").split("/")[1]);
};

let osId = null, miId = null, token = null;
const before = await miCount();
try {
  const { data } = await osTable("os_clients")
    .insert({ name: NAME, slug: toSlug(NAME), aliases: [], status: "prospect", source: "os" })
    .select("id").single();
  osId = data.id;

  // All three legs — this mints a real portal.
  const run = await runOnboarding(osId, { name: NAME, plan: "production", weeklyTarget: 3 }, {});
  const mi = run.legs.find(l => l.leg === "master_inbox");
  check(mi?.status === "done", "all three legs ran, portal minted", `HTTP ${mi?.httpStatus}`);
  miId = mi?.remoteId;
  check(await miCount() === before + 1, "Master Inbox gained exactly one client", `${before} → ${before + 1}`);

  const row = await (await fetch(`${MI}/rest/v1/clients?select=portal_token,portal_enabled&id=eq.${miId}`, { headers: H })).json();
  token = row[0]?.portal_token;
  check(!!token && row[0]?.portal_enabled, "the portal is live", String(token).slice(0, 20) + "…");
  const live = await fetch(`https://portal.brokerstaffer.com/portal/${token}`, { signal: AbortSignal.timeout(30000) });
  check(live.status === 200, "the portal URL actually serves", `HTTP ${live.status}`);

  // --- an EMPTY portal: plan says so ------------------------------------
  const p1 = await planDelete(osId, "everything");
  check(p1.destructive === false, "an empty portal is not flagged destructive");
  check(p1.willDelete.some(d => /portal URL/.test(d)), "the plan says the portal URL goes",
        p1.willDelete.find(d => /portal URL/.test(d)) ?? "");

  // --- give it content, and the guard must refuse ------------------------
  await fetch(`${MI}/rest/v1/client_agents`, {
    method: "POST", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ client_id: miId, name: "ZZ Test Agent", email: "zz-test@example.invalid" }),
  });
  const p2 = await planDelete(osId, "everything");
  check(p2.destructive === true, "a portal with content IS flagged destructive",
        `agents=${p2.cascade?.agents}`);

  let refused = null;
  try { await deleteClient(osId, { scope: "everything", confirm: NAME }); }
  catch (e) { refused = e.message; }
  check(!!refused, "REFUSED without the acknowledgement, despite the correct name",
        (refused ?? "").slice(0, 60) + "…");
  check(await miCount() === before + 1, "nothing was deleted by the refused attempt");

  // --- with the acknowledgement, it goes ---------------------------------
  const del = await deleteClient(osId, { scope: "everything", confirm: NAME, acceptDataLoss: true });
  check(del.failed.length === 0, "deleted everywhere", del.removed.join(", "));
  check(await miCount() === before, "Master Inbox back to its original count", String(before));

  const gone = await fetch(`https://portal.brokerstaffer.com/portal/${token}`, { signal: AbortSignal.timeout(30000) });
  check(gone.status !== 200, "the portal URL no longer serves", `HTTP ${gone.status}`);

  const agents = await (await fetch(`${MI}/rest/v1/client_agents?select=id&client_id=eq.${miId}`, { headers: H })).json();
  check(agents.length === 0, "the agent row cascaded away", `${agents.length} left`);
  osId = null; // fully removed
} catch (e) {
  check(false, "unexpected error", e instanceof Error ? e.message : String(e));
} finally {
  if (osId) {
    console.log("\n  cleaning up the fixture");
    try { await deleteClient(osId, { scope: "everything", confirm: NAME, acceptDataLoss: true }); }
    catch (e) { console.log("    cleanup failed:", e.message); }
  }
  const end = await miCount();
  check(end === before, "Master Inbox client count restored", `${before} → ${end}`);
  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
