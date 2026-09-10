/*
 * Removing the label must remove the person from the client's portal.
 *
 * Migration 0033 exists because it did not, for a while: an internal test
 * thread for sankalp@outreachify.io "kept appearing in Front Range Collective's
 * portal even after every label was cleared from the thread". A client was
 * looking at somebody who should not have been there.
 *
 * The fix is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, and the
 * deferral is the whole subtlety: the label picker implements a swap as
 * DELETE-then-INSERT, so a normal AFTER DELETE trigger would see "no labels
 * left" in the gap between the two statements and wrongly bin the pipeline row.
 * Deferring to commit time means it judges the FINAL state.
 *
 * That makes this worth testing rather than assuming, because both failure
 * modes are silent and opposite: too eager deletes live rows mid-swap; too lax
 * leaves strangers in a customer's portal.
 *
 * Demo client only.
 */
import fs from "node:fs";

const OS = process.argv[2] || "http://localhost:3210";
const API = `${OS}/api/tools/master-inbox`;
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const db = { apikey: K, Authorization: `Bearer ${K}` };
const dbw = { ...db, "content-type": "application/json", Prefer: "return=minimal" };
const get = async (q) => await (await fetch(`${U}/rest/v1/${q}`, { headers: db })).json();

const demo = (await get("clients?select=id,name&slug=eq.demo-portal"))[0];
const intro = (await get("labels?select=id,name&name=eq.Introduction"))[0];
const thread = (await get(`threads?select=id,client_id&id=eq.${THREAD}`))[0];
const originalClientId = thread.client_id;

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;
const H = { cookie, "content-type": "application/json" };

const startEntries = (await get(`client_pipeline_entries?select=id&client_id=eq.${demo.id}`)).length;
console.log(`  demo client starts with ${startEntries} entries\n`);

let ok = true;
const undo = [];
try {
  await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: demo.id }) });
  undo.push(() => fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: originalClientId }) }));

  // Label → entry appears.
  const r1 = await fetch(`${API}/threads/${THREAD}/labels`, { method: "POST", headers: H, body: JSON.stringify({ label_id: intro.id }) });
  await new Promise((s) => setTimeout(s, 2000));
  const afterLabel = await get(`client_pipeline_entries?select=id&thread_id=eq.${THREAD}&client_id=eq.${demo.id}`);
  console.log(`  ${r1.ok && afterLabel.length ? "✓" : "✗"} labelling created the entry (${r1.status}, ${afterLabel.length} entry)`);
  if (!r1.ok || !afterLabel.length) ok = false;
  for (const e of afterLabel) undo.push(() => fetch(`${U}/rest/v1/client_pipeline_entries?id=eq.${e.id}`, { method: "DELETE", headers: dbw }));

  // Unlabel THROUGH THE OS ROUTE → the cascade should remove it.
  // DELETE carries a JSON BODY (`{label_id}`), not a query param — the route
  // parses `await request.json()`. Guessing the query-param form returned
  // "Invalid input" and briefly looked like a broken cascade.
  const r2 = await fetch(`${API}/threads/${THREAD}/labels`, {
    method: "DELETE", headers: H, body: JSON.stringify({ label_id: intro.id }),
  });
  const b2 = await r2.text();
  console.log(`  ${r2.ok ? "✓" : "✗"} OS unlabel route → ${r2.status} ${b2.slice(0, 70)}`);
  if (!r2.ok) ok = false;

  await new Promise((s) => setTimeout(s, 2500));
  const afterUnlabel = await get(`client_pipeline_entries?select=id&thread_id=eq.${THREAD}&client_id=eq.${demo.id}`);
  const gone = afterUnlabel.length === 0;
  console.log(`  ${gone ? "✓" : "✗"} cascade removed it from the portal (${afterUnlabel.length} left)`);
  if (!gone) ok = false;
} finally {
  console.log("\n  cleaning up…");
  await fetch(`${U}/rest/v1/label_assignments?target_id=eq.${THREAD}&label_id=eq.${intro.id}`, { method: "DELETE", headers: dbw }).catch(() => {});
  for (const u of undo.reverse()) { try { await u(); } catch {} }
  const end = (await get(`client_pipeline_entries?select=id&client_id=eq.${demo.id}`)).length;
  const t = (await get(`threads?select=client_id&id=eq.${THREAD}`))[0];
  console.log(`  demo entries ${end} (started ${startEntries}) — ${end === startEntries ? "restored" : "MISMATCH"}`);
  console.log(`  thread client_id restored: ${t.client_id === originalClientId ? "yes" : "NO"}`);
  if (end !== startEntries || t.client_id !== originalClientId) ok = false;
}
console.log(`\n  ${ok ? "PASS — unlabelling removes the person from the portal" : "FAIL — see above"}`);
process.exit(ok ? 0 : 1);
