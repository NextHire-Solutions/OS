/*
 * PORTAL → MASTER INBOX. The reverse direction.
 *
 * The forward flow (label "Introduction" in the inbox → a row appears in the
 * client's portal) is covered by demo-portal-test.mjs. This is the other way
 * round, and it is the one that is easy to forget exists: it is not application
 * code at all, it is migration 0070's trigger `pipeline_apply_no_show_label`.
 *
 * When a client moves someone to "No Show / No Response" in their portal, that
 * trigger writes a thread label back into the inbox so staff can see it. The
 * write happens in the DATABASE — grepping the portal's route handlers for
 * `label_assignments` finds nothing, which is exactly how this connection got
 * missed once already. Enumerate the triggers that WRITE a table, not only the
 * ones defined on it.
 *
 * WHAT THIS EXERCISES
 *
 *   a stage change on client_pipeline_entries   (what the portal's PATCH does)
 *        ↓
 *   trigger 0070                                inserts into label_assignments
 *        ↓
 *   the OS                                      renders it on the thread
 *
 * It sets the stage directly rather than calling
 * `PATCH https://portal.brokerstaffer.com/api/portal/<token>/pipeline/<id>`.
 * The trigger is the same either way — it is an AFTER UPDATE on the table — and
 * the alternative means issuing a write to a live production service serving 47
 * customers. If you want the HTTP path covered too, that is a separate, louder
 * decision.
 *
 * Run against "Test FUB": not a real customer, no Follow Up Boss key, and — the
 * part that matters — NOT the demo client, which migration 0070 hardcodes an
 * exclusion for (`00ef116c-…`). The demo portal cannot exercise this flow.
 */
import fs from "node:fs";

const OS = process.argv[2] || "http://localhost:3210";
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31";
const CLIENT_SLUG = "test-fub";
const NO_SHOW_LABEL = "No Show / No Response";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const db = { apikey: K, Authorization: `Bearer ${K}` };
const dbw = { ...db, "content-type": "application/json", Prefer: "return=minimal" };
const get = async (q) => await (await fetch(`${U}/rest/v1/${q}`, { headers: db })).json();

const client = (await get(`clients?select=id,name,portal_token&slug=eq.${CLIENT_SLUG}`))[0];
const label = (await get(`labels?select=id&name=eq.${encodeURIComponent(NO_SHOW_LABEL)}`))[0];
const thread = (await get(`threads?select=id,client_id&id=eq.${THREAD}`))[0];
if (!client || !label || !thread) { console.log("  missing client, label or thread"); process.exit(1); }

const originalClientId = thread.client_id;
console.log(`  client  ${client.name}   (not the demo client, so trigger 0070 applies)`);
console.log(`  thread  ${THREAD}\n`);

let ok = true;
const undo = [];

try {
  await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: client.id }) });
  undo.push(() => fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: originalClientId }) }));

  const ins = await fetch(`${U}/rest/v1/client_pipeline_entries`, {
    method: "POST",
    headers: { ...db, "content-type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      client_id: client.id, thread_id: THREAD, stage: "introduction",
      lead_name: "Sankalp (reverse-flow check)", lead_email: "sankalp@outreachify.io",
    }),
  });
  const entry = (await ins.json())[0];
  if (!entry) { console.log("  ✗ could not seed a pipeline entry"); process.exit(1); }
  undo.push(() => fetch(`${U}/rest/v1/client_pipeline_entries?id=eq.${entry.id}`, { method: "DELETE", headers: dbw }));
  console.log(`  ✓ seeded entry ${entry.id.slice(0, 8)} at stage=introduction`);

  // Clear the label first, or a pre-existing one would make the check meaningless.
  const pre = await get(`label_assignments?select=label_id&target_id=eq.${THREAD}&label_id=eq.${label.id}`);
  if (pre.length) {
    console.log("  ! label already present — clearing so the result means something");
    await fetch(`${U}/rest/v1/label_assignments?target_id=eq.${THREAD}&label_id=eq.${label.id}`, { method: "DELETE", headers: dbw });
  }

  // THE TEST: the stage change a portal performs.
  const r = await fetch(`${U}/rest/v1/client_pipeline_entries?id=eq.${entry.id}`, {
    method: "PATCH", headers: dbw, body: JSON.stringify({ stage: "no_show" }),
  });
  console.log(`  ${r.ok ? "✓" : "✗"} stage moved to no_show (${r.status}) — as the portal's PATCH does`);
  if (!r.ok) ok = false;

  await new Promise((s) => setTimeout(s, 2500));
  const got = await get(`label_assignments?select=label_id,assigned_by&target_id=eq.${THREAD}&label_id=eq.${label.id}`);
  console.log(`  ${got.length ? "✓" : "✗"} trigger 0070 wrote "${NO_SHOW_LABEL}" back${got[0] ? ` (assigned_by=${got[0].assigned_by})` : ""}`);
  if (!got.length) ok = false;
  undo.push(() => fetch(`${U}/rest/v1/label_assignments?target_id=eq.${THREAD}&label_id=eq.${label.id}`, { method: "DELETE", headers: dbw }));

  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;
  const page = await fetch(`${OS}/inbox/all-email/${THREAD}`, { headers: { cookie } });
  const text = (await page.text()).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const shown = text.includes("No Show");
  console.log(`  ${shown ? "✓" : "✗"} the OS renders it on the thread (page ${page.status})`);
  if (!shown) ok = false;
} finally {
  console.log("\n  cleaning up…");
  for (const u of undo.reverse()) { try { await u(); } catch (e) { console.log("    undo failed:", e.message); } }
  const t = (await get(`threads?select=client_id&id=eq.${THREAD}`))[0];
  const left = await get(`client_pipeline_entries?select=id&client_id=eq.${client.id}`);
  const lbl = await get(`label_assignments?select=label_id&target_id=eq.${THREAD}&label_id=eq.${label.id}`);
  console.log(`  thread client_id restored: ${t.client_id === originalClientId ? "yes" : "NO"}`);
  console.log(`  entries left on ${client.name}: ${left.length} (should be 0)`);
  console.log(`  no-show label removed: ${lbl.length === 0 ? "yes" : "NO"}`);
  if (t.client_id !== originalClientId || left.length !== 0 || lbl.length !== 0) ok = false;
}
console.log(`\n  ${ok ? "PASS — a portal stage change reaches the OS inbox" : "FAIL — see above"}`);
process.exit(ok ? 0 : 1);
