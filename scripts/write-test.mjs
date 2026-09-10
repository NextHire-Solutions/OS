/*
 * Exercises the WRITE paths on one designated test thread.
 *
 * Every check here changes real data in the live database — that is the point:
 * a copied route that renders is not a route that works, and the failures that
 * matter (a 401 gate, a missing column, a trigger that fires) only appear on a
 * write.
 *
 * Two rules this file follows:
 *
 *   ONE THREAD, named explicitly. Never a thread picked from the top of the
 *   inbox — that is somebody's live conversation.
 *
 *   EVERY CHANGE IS REVERSED. Each check records the prior value, makes the
 *   change, asserts it took, and puts it back. A failure mid-run leaves a
 *   printed record of what was not restored.
 *
 * Labelling is deliberately NOT exercised: applying "Introduction" creates a
 * pipeline row visible in a client's LIVE portal and fires n8n, Slack and Follow
 * Up Boss. That needs a human deciding, not a test loop.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
const API = `${BASE}/api/tools/master-inbox`;
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31"; // sankalp@outreachify.io — the designated test thread

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const db = { apikey: K, Authorization: `Bearer ${K}` };

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;
const H = { cookie, "content-type": "application/json" };

async function thread() {
  const r = await fetch(`${U}/rest/v1/threads?select=id,status,seen&id=eq.${THREAD}`, { headers: db });
  return (await r.json())[0];
}

const before = await thread();
if (!before) { console.log("  test thread not found — aborting"); process.exit(1); }
console.log(`  test thread ${THREAD}\n  before: status=${before.status} seen=${before.seen}\n`);

let pass = 0, fail = 0;
const unrestored = [];

async function check(name, act, verify, restore) {
  try {
    const res = await act();
    const ok = await verify();
    if (ok) { pass++; console.log(`  ✓ ${name.padEnd(34)} ${res}`); }
    else { fail++; console.log(`  ✗ ${name.padEnd(34)} ${res} — the write did not take`); }
  } catch (e) {
    fail++; console.log(`  ✗ ${name.padEnd(34)} ${e.message}`);
  } finally {
    try { await restore(); } catch (e) { unrestored.push(`${name}: ${e.message}`); }
  }
}

/*
 * The bulk route's contract is snake_case and action-tagged — `thread_ids`,
 * not `threadIds`, and `{action:"seen", seen:false}` rather than an "unread"
 * action. Worth stating because the first version of this file guessed, got a
 * 400, and briefly looked like a broken route.
 */
await check("mark unread (bulk route)",
  async () => { const r = await fetch(`${API}/threads/bulk`, { method: "POST", headers: H, body: JSON.stringify({ action: "seen", thread_ids: [THREAD], seen: false }) }); return `${r.status}`; },
  async () => (await thread()).seen === false,
  async () => { await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: { ...db, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ seen: before.seen }) }); });

// 2. archive, then back to its original status
await check("archive (bulk route)",
  async () => { const r = await fetch(`${API}/threads/bulk`, { method: "POST", headers: H, body: JSON.stringify({ action: "status", thread_ids: [THREAD], status: "archived" }) }); return `${r.status}`; },
  async () => (await thread()).status === "archived",
  async () => { await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: { ...db, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: before.status }) }); });

// 3. snooze, then dismiss — the reminders table, not the thread
await check("snooze (thread route)",
  async () => {
    const remind = new Date(Date.now() + 3600_000).toISOString();
    const r = await fetch(`${API}/threads/${THREAD}/snooze`, { method: "POST", headers: H, body: JSON.stringify({ remind_at: remind, note: "automated write-path check" }) });
    return `${r.status} ${(await r.text()).slice(0, 60)}`;
  },
  async () => {
    const r = await fetch(`${U}/rest/v1/reminders?select=id&thread_id=eq.${THREAD}`, { headers: db });
    return (await r.json()).length > 0;
  },
  async () => {
    /*
     * Snoozing also moves the thread to status "reminder" — that is what the
     * tool does, and the first run of this file left the test thread sitting in
     * "reminder" because the restore only cleaned the reminders table.
     */
    await fetch(`${U}/rest/v1/reminders?thread_id=eq.${THREAD}`, { method: "DELETE", headers: { ...db, Prefer: "return=minimal" } });
    await fetch(`${U}/rest/v1/threads?id=eq.${THREAD}`, { method: "PATCH", headers: { ...db, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: before.status }) });
  });

// 4. composer draft — saves and reads back, touches nothing else
await check("save composer draft",
  // PUT, not POST — the route defines PUT and DELETE only.
  async () => { const r = await fetch(`${API}/threads/${THREAD}/composer-draft`, { method: "PUT", headers: H, body: JSON.stringify({ body: "write-path check", subject: "check" }) }); return `${r.status}`; },
  /*
   * Verified against `composer_drafts` directly: the route defines PUT and
   * DELETE only, so a GET returns 405 and reads as a failure when the write
   * actually succeeded. Check the effect, not a method that does not exist.
   */
  async () => {
    const r = await fetch(`${U}/rest/v1/composer_drafts?select=thread_id&thread_id=eq.${THREAD}`, { headers: db });
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  },
  async () => { await fetch(`${API}/threads/${THREAD}/composer-draft`, { method: "DELETE", headers: H }); });

const after = await thread();
console.log(`\n  after:  status=${after.status} seen=${after.seen}`);
const restored = after.status === before.status && after.seen === before.seen;
console.log(`  restored to its original state: ${restored ? "yes" : "NO — check this thread"}`);
if (unrestored.length) { console.log("\n  NOT RESTORED:"); for (const u of unrestored) console.log("    " + u); }
console.log(`\n  ${pass} passed · ${fail} failed`);
process.exit(fail || !restored ? 1 : 0);
