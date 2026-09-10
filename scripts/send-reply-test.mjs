/*
 * Sends ONE real reply through the route the composer actually calls.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE EARLIER SEND TEST
 *
 * A reply was verified end-to-end earlier in the project and confirmed
 * delivered. But that went through `/api/tools/master-inbox/threads/reply` —
 * a hand-written port that takes threadId as a query param. The composer now
 * calls `/api/tools/master-inbox/threads/[threadId]/reply`, the tool's own
 * route, copied.
 *
 * Diffed with comments stripped, the two differ by 29 code lines and every one
 * is plumbing: route params instead of query params, and the shimmed Supabase
 * clients. The send logic — the EmailBison and Instantly branches, the auto-CC,
 * the subject handling — is identical.
 *
 * That is a good reason to expect it to work and not a reason to believe it
 * does. The 23 routes that returned 401 to everybody also "just" differed in
 * plumbing. This route mails a real person; it gets exercised, once, on the
 * thread designated for testing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SENDS, AND TO WHOM
 *
 * The thread is sankalp@outreachify.io — internal. The route's own auto-CC adds
 * nicole.c@brokerstaffer.com, which is the tool's behaviour and is the point:
 * a reply missing that CC is the operationally significant bug this project
 * already hit once.
 *
 * There is no undo. Run it deliberately.
 */
import fs from "node:fs";

const OS = process.argv[2] || "http://localhost:3210";
const THREAD = "b225cfc3-14d7-4084-b38a-952bedc76d31";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const db = { apikey: K, Authorization: `Bearer ${K}` };
const get = async (q) => await (await fetch(`${U}/rest/v1/${q}`, { headers: db })).json();

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;

const before = await get(`messages?select=id&thread_id=eq.${THREAD}&direction=eq.outbound`);
const thread = (await get(`threads?select=subject,source_provider,outbound_sender_email&id=eq.${THREAD}`))[0];
console.log(`  thread    ${thread.subject}`);
console.log(`  provider  ${thread.source_provider}  ·  sender ${thread.outbound_sender_email}`);
console.log(`  outbound messages before: ${before.length}\n`);

// Reproduce exactly what the composer would place in the Cc field.
const { mergeAlwaysCcString } = await import("../src/lib/tools/master-inbox/inbox/auto-cc.ts");
const lead = (await get(`leads?select=email&id=eq.${(await get(`threads?select=lead_id&id=eq.${THREAD}`))[0].lead_id}`))[0];
const leadEmail = lead?.email ?? "sankalp@outreachify.io";
const ccString = mergeAlwaysCcString("", leadEmail);
console.log(`  composer would Cc: ${JSON.stringify(ccString)}\n`);

const stamp = new Date().toISOString();
const res = await fetch(`${OS}/api/tools/master-inbox/threads/${THREAD}/reply`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  /*
   * The COMPOSER's payload shape, not a minimal one.
   *
   * The first run of this file posted only { body, subject } and the reply
   * arrived with no Cc. That looked like the auto-CC regression this project
   * hit once before — it was not. `auto-cc.ts` claims the reply route performs
   * "final server-side enforcement" of the CC, and that claim is FALSE in all
   * three routes, the live tool's included. The CC is added by the composer,
   * which seeds its Cc field with `mergeAlwaysCcString`.
   *
   * So a bare API call legitimately has no CC, and testing with one proves
   * nothing about what staff actually send. This mirrors what the composer
   * posts: html body, content_type, explicit to/cc arrays.
   */
  body: JSON.stringify({
    body: `<p>Automated check of the BrokerStaffer OS composer route — composer payload shape.</p><p>Sent ${stamp}. No action needed.</p>`,
    content_type: "html",
    subject: `Re: ${thread.subject?.replace(/^Re:\s*/i, "") ?? "Testing the new custom MasterInbox"}`,
    to: [{ email_address: leadEmail }],
    cc: ccString ? ccString.split(",").map((e) => ({ email_address: e.trim() })).filter((r) => r.email_address) : [],
    bcc: [],
  }),
});
const text = await res.text();
console.log(`  ${res.ok ? "✓" : "✗"} POST .../threads/<id>/reply → ${res.status}`);
console.log(`      ${text.slice(0, 220)}\n`);

// The provider accepting is one thing; the message being recorded is another.
await new Promise((s) => setTimeout(s, 3000));
const after = await get(`messages?select=id,direction,sender,recipients,created_at&thread_id=eq.${THREAD}&order=created_at.desc&limit=3`);
/*
 * Count against the FULL set, not the `limit=3` peek used for display — the
 * first version compared 19 against 3 and reported a regression that was
 * entirely its own arithmetic.
 */
const afterAll = await get(`messages?select=id&thread_id=eq.${THREAD}&direction=eq.outbound`);
const grew = afterAll.length > before.length;
console.log(`  ${grew ? "✓" : "✗"} an outbound message was recorded (${before.length} → ${afterAll.length})`);
if (after[0]) {
  console.log(`      sender     ${after[0].sender}`);
  console.log(`      recipients ${JSON.stringify(after[0].recipients)}`);
  const blob = JSON.stringify(after[0].recipients ?? {});
  const toOk = /sankalp@outreachify\.io/i.test(blob);
  const ccOk = /nicole\.c@brokerstaffer\.com/i.test(blob);
  console.log(`  ${toOk ? "✓" : "✗"} recorded To  sankalp@outreachify.io`);
  console.log(`  ${ccOk ? "✓" : "✗"} recorded Cc  nicole.c@brokerstaffer.com  (the oversight copy)`);
  if (!toOk || !ccOk) process.exitCode = 1;
}
process.exit(res.ok && grew ? 0 : 1);
