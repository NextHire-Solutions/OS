/*
 * Editing a client, end to end, against the live tools.
 *
 * The check that matters most is the LAST one: Client Health's PATCH assigns
 * `instantly_campaign_ids` unconditionally from the request body, so a partial
 * update would clear the campaign links a sync took hours to establish. The
 * symptom would be a client's numbers quietly going to zero with nothing in any
 * log. So this edits a plan and then asserts the campaign links survived.
 */
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { osTable } = await import("@/lib/clients/os-db.ts");
const { runOnboarding } = await import("@/lib/clients/onboard-run.ts");
const { editClient } = await import("@/lib/clients/edit.ts");
const { deleteClient } = await import("@/lib/clients/delete.ts");
const { toSlug } = await import("@/lib/clients/slug.ts");

const NAME = `ZZ Edit Test ${Date.now()}`;
let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const chList = async () => {
  const r = await fetch(`${process.env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients`,
    { headers: { "x-admin-token": process.env.CLIENT_HEALTH_READ_TOKEN } });
  return (await r.json()).clients ?? [];
};

let osId = null;
try {
  const { data } = await osTable("os_clients").insert({
    name: NAME, slug: toSlug(NAME), aliases: ["ZZ Edit Alias One"],
    status: "prospect", source: "os",
  }).select("id").single();
  osId = data.id;

  const run = await runOnboarding(osId, { name: NAME, plan: "production", weeklyTarget: 3 },
    { stopBefore: "master_inbox" });
  check(run.legs.filter(l => l.status === "done").length === 2, "fixture onboarded to both tools");

  /*
   * Seed REAL campaign links first.
   *
   * An empty array surviving proves very little — the whole risk is a
   * POPULATED `instantly_campaign_ids` being cleared, because that is what a
   * sync established and what the client's numbers depend on. So the fixture
   * is given links before the edit, and they are compared afterwards.
   *
   * Written through the same full-field PATCH the edit path uses, for the same
   * reason: a partial one would clear the very fields being set up.
   */
  const seeded = (await chList()).find(c => c.name === NAME);
  const FAKE_LINKS = ["seed-campaign-a", "seed-campaign-b", "seed-campaign-c"];
  {
    const pw = process.env.CLIENT_HEALTH_DASHBOARD_PASSWORD;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("bs-dashboard-authed"));
    const cookie = Buffer.from(sig).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = await fetch(`${process.env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients`, {
      method: "PATCH", headers: { cookie: `bs_auth=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: seeded.id, name: NAME, plan: "production", weekly_target: 3,
                             start_date: "2026-09-01", instantly_campaign_ids: FAKE_LINKS }),
    });
    check(r.ok, "fixture seeded with campaign links", `HTTP ${r.status}`);
  }

  const before = (await chList()).find(c => c.name === NAME);
  check((before?.instantly_campaign_ids ?? []).length === 3,
        "three campaign links present before the edit",
        JSON.stringify(before?.instantly_campaign_ids));

  // --- the edit ---------------------------------------------------------
  const res = await editClient(osId, { plan: "partner", weeklyTarget: 5, status: "active" });
  check(res.failed.length === 0, "edit reported no failures", res.updated.join(", "));

  const after = (await chList()).find(c => c.name === NAME);
  check(after?.plan === "partner", "plan changed in Client Health", `now ${after?.plan}`);
  check(after?.weekly_target === 5, "weekly target changed", `now ${after?.weekly_target}`);
  check(after?.name === NAME, "name SURVIVED the partial patch", String(after?.name));
  check(JSON.stringify(after?.instantly_campaign_ids) === JSON.stringify(FAKE_LINKS),
        "all three campaign links SURVIVED the partial patch",
        JSON.stringify(after?.instantly_campaign_ids));
  check(after?.start_date === "2026-09-01", "start_date survived",
        `${before?.start_date} → ${after?.start_date}`);

  const { data: local } = await osTable("os_clients").select("status, aliases").eq("id", osId).single();
  check(local.status === "active", "status changed in the OS", local.status);

  // --- aliases ----------------------------------------------------------
  const aRes = await editClient(osId, { aliases: ["ZZ Edit Alias One", "ZZ Edit Alias Two"] });
  check(aRes.failed.length === 0, "aliases edit reported no failures", aRes.updated.join(", "));
  const { data: local2 } = await osTable("os_clients").select("aliases").eq("id", osId).single();
  check(local2.aliases.length === 2, "aliases stored in the OS", JSON.stringify(local2.aliases));

  // --- validation -------------------------------------------------------
  let threw = null;
  try { await editClient(osId, { weeklyTarget: -4 }); } catch (e) { threw = e.message; }
  check(!!threw, "a negative weekly target is refused", threw ?? "");
} catch (e) {
  check(false, "unexpected error", e instanceof Error ? e.message : String(e));
} finally {
  if (osId) {
    try {
      const d = await deleteClient(osId, { scope: "tools", confirm: NAME });
      check(d.failed.length === 0, "fixture cleaned up", d.removed.join(", "));
    } catch (e) {
      check(false, "cleanup failed", e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
