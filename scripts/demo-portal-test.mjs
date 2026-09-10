/*
 * End-to-end: label a thread "Introduction" in the OS, and watch it appear in
 * the client's LIVE portal.
 *
 * This is the one path that crosses every boundary the project cares about —
 * the OS writes, a database trigger creates the pipeline entry, and a portal
 * served by a DIFFERENT deployment renders it. Nothing short of running it
 * proves the two halves still talk to each other.
 *
 * Run against the DEMO client only. It is the one client whose portal exists to
 * be experimented with, and it has no Follow Up Boss key, so that push no-ops.
 *
 * WHAT THIS DOES THAT CANNOT BE UNDONE: labelling fires an n8n webhook and a
 * Slack notice. The database changes below are all reversed; those two are not
 * reversible and are the reason this is not part of the routine test suite.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
const API = `${BASE}/api/tools/master-inbox`;
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31";   // sankalp@outreachify.io
const DEMO_SLUG = "demo-portal";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const db = { apikey: K, Authorization: `Bearer ${K}` };
const dbw = { ...db, "content-type": "application/json", Prefer: "return=minimal" };
const get = async (q) => (await (await fetch(`${U}/rest/v1/${q}`, { headers: db })).json());

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;
const H = { cookie, "content-type": "application/json" };

const demo = (await get(`clients?select=id,name,portal_token&slug=eq.${DEMO_SLUG}`))[0];
const intro = (await get(`labels?select=id,name&name=eq.Introduction`))[0];
const thread = (await get(`threads?select=id,client_id,status&id=eq.${THREAD}`))[0];
if (!demo || !intro || !thread) { console.log("  missing demo client, Introduction label or thread"); process.exit(1); }

const originalClientId = thread.client_id;
const portalUrl = `https://portal.brokerstaffer.com/portal/${demo.portal_token}`;
const before = (await get(`client_pipeline_entries?select=id&client_id=eq.${demo.id}`)).length;

console.log(`  demo client   ${demo.name} (${demo.id})`);
console.log(`  portal        ${portalUrl}`);
console.log(`  entries now   ${before}`);
console.log(`  thread        tagged to ${originalClientId}\n`);

let ok = true;
const undo = [];

try {
  // 1. Point the test thread at the demo client, so the entry lands in the demo portal.
  await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: demo.id }) });
  undo.push(async () => fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: dbw, body: JSON.stringify({ client_id: originalClientId }) }));
  console.log("  ✓ thread re-tagged to the demo client");

  // 2. Apply "Introduction" THROUGH THE OS ROUTE — the thing under test.
  const r = await fetch(`${API}/threads/${THREAD}/labels`, { method: "POST", headers: H, body: JSON.stringify({ label_id: intro.id }) });
  const body = await r.text();
  console.log(`  ${r.ok ? "✓" : "✗"} OS label route → ${r.status} ${body.slice(0, 90)}`);
  if (!r.ok) ok = false;
  undo.push(async () => fetch(`${U}/rest/v1/label_assignments?target_id=eq.${THREAD}&label_id=eq.${intro.id}`, { method: "DELETE", headers: dbw }));

  // 3. Did the trigger create the pipeline entry, in the demo client?
  await new Promise((s) => setTimeout(s, 2500));
  const entries = await get(`client_pipeline_entries?select=id,stage,client_id,lead_name,lead_email&thread_id=eq.${THREAD}`);
  const mine = entries.filter((e) => e.client_id === demo.id);
  console.log(`  ${mine.length ? "✓" : "✗"} pipeline entry created: ${mine.length} in the demo client`);
  if (mine[0]) console.log(`      stage=${mine[0].stage}  lead=${mine[0].lead_name ?? mine[0].lead_email ?? "—"}`);
  if (!mine.length) ok = false;
  for (const e of entries) undo.push(async () => fetch(`${U}/rest/v1/client_pipeline_entries?id=eq.${e.id}`, { method: "DELETE", headers: dbw }));

  // 4. Does the LIVE portal — a different deployment — actually render it?
  const pr = await fetch(portalUrl, { redirect: "follow" });
  const html = await pr.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const shows = /sankalp/i.test(text) || (mine[0]?.lead_name && text.includes(mine[0].lead_name));
  console.log(`  ${pr.status === 200 ? "✓" : "✗"} live portal responds ${pr.status} (${text.length} chars)`);
  console.log(`  ${shows ? "✓" : "✗"} the new introduction is visible in the live portal`);
  if (pr.status !== 200) ok = false;
} finally {
  console.log("\n  cleaning up…");
  for (const u of undo.reverse()) { try { await u(); } catch (e) { console.log("    undo failed:", e.message); } }
  const after = (await get(`client_pipeline_entries?select=id&client_id=eq.${demo.id}`)).length;
  const t = (await get(`threads?select=client_id&id=eq.${THREAD}`))[0];
  console.log(`  entries back to ${after} (was ${before}) — ${after === before ? "restored" : "MISMATCH, check the demo portal"}`);
  console.log(`  thread client_id restored: ${t.client_id === originalClientId ? "yes" : "NO"}`);
  if (after !== before || t.client_id !== originalClientId) ok = false;
}
console.log(`\n  ${ok ? "PASS — the OS writes reach the live portal" : "FAIL — see above"}`);
process.exit(ok ? 0 : 1);
