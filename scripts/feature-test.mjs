/*
 * Does the ported inbox actually carry the tool's features?
 *
 * The point of copying the original components was that nothing would be
 * missed. That claim is only worth anything if it is checked, so this opens a
 * real conversation and looks for each feature's control in the DOM.
 *
 * A feature is "present" when its control exists — not when a component file
 * exists on disk. The whole failure mode being guarded against here is a
 * component that was copied, compiled, and never rendered.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
const CDP = "http://localhost:9333";

/* label → predicate over the page's text and DOM */
/*
 * label → predicate.
 *
 * Written against `aria-label` as well as text, because the tool's toolbar is
 * icon buttons: Reply, Reply all and Forward carry no visible text at all. The
 * first version of this file matched on text only and reported six features
 * missing that were sitting right there — a test that is wrong in the safe
 * direction still costs an hour and still has to be believed the next time.
 */
const LABELS = `[...document.querySelectorAll('button,[role=button],a')].map(b=>((b.textContent||'')+' '+(b.getAttribute('aria-label')||'')+' '+(b.title||'')).trim()).join(' | ')`;

const FEATURES = [
  ["reply",               `/\\breply\\b/i.test(${LABELS})`],
  ["reply all",           `/reply\\s*all/i.test(${LABELS})`],
  ["forward",             `/\\bforward\\b/i.test(${LABELS})`],
  ["archive",             `/\\barchive\\b/i.test(${LABELS})`],
  ["delete / trash",      `/\\b(delete|trash)\\b/i.test(${LABELS})`],
  ["mark unread",         `/unread/i.test(${LABELS})`],
  ["label picker",        `/label/i.test(${LABELS})`],
  ["snooze",              `/snooze|remind/i.test(${LABELS})`],
  ["move agent",          `/move agent/i.test(${LABELS})`],
  /*
   * Sequencing is PROVIDER-SPECIFIC and the two are mutually exclusive —
   * prospect-panel.tsx renders SubsequenceSection for instantly threads and
   * FollowupCampaignPicker for emailbison ones. Asserting both on a single
   * thread can never pass; the first version of this file did, and reported a
   * missing feature that was correctly absent.
   *
   * So: assert that the thread offers the sequencing control its provider
   * uses.
   */
  ["sequencing (provider-appropriate)",
   `/subsequence|sequence|follow.?up campaign/i.test(${LABELS} + document.body.innerText)`],
  ["filters",             `/filter/i.test(${LABELS})`],
  ["prospect panel",      `/details/i.test(${LABELS}) && /notes/i.test(${LABELS})`],
  ["attachments tab",     `/attachment/i.test(${LABELS})`],
  ["prev / next nav",     `!!document.querySelector('a[href*="/inbox/"]')`],
  ["lead detail fields",  `/sales volume|closed transactions|brokerage|mls/i.test(document.body.innerText)`],
];

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
  const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
  return mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
}

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description ?? "").slice(0, 120));
  else if (m.method === "Network.responseReceived" && m.params.response.status >= 400) errors.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
await send("Network.setCookie", { name: "bs_sso", value: await token(), domain: "localhost", path: "/" });

// Find a real thread from the list rather than hardcoding an id.
await send("Page.navigate", { url: `${BASE}/inbox/all-email` });
for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (await ev(`document.querySelectorAll('a[href^="/inbox/all-email/"]').length`)) break; }
const href = await ev(`document.querySelector('a[href^="/inbox/all-email/"]')?.getAttribute('href')`);
if (!href) { console.log("  no threads in the list — cannot test the detail screen"); process.exit(1); }
console.log(`  opening ${href}\n`);

const t0 = Date.now();
await send("Page.navigate", { url: BASE + href });
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if ((await ev("document.readyState")) === "complete" && (await ev("document.body.innerText.length")) > 3000) break;
}
const ms = Date.now() - t0;
console.log(`  rendered in ${ms}ms · ${await ev("document.body.innerText.length")} chars\n`);

// The composer is not open until Reply is pressed, so press it. A feature
// behind one click is still a feature; one that never appears is not.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^reply$/i.test((x.getAttribute('aria-label')||'').trim()));if(b)b.click()})()`);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (await ev(`!!document.querySelector('[contenteditable="true"], textarea')`)) break;
}
const composerOpen = await ev(`!!document.querySelector('[contenteditable="true"], textarea')`);
console.log(`  ${composerOpen ? "✓" : "✗"} composer opens on Reply`);
const sendBtn = await ev(`[...document.querySelectorAll('button')].some(b=>/^send/i.test(b.textContent.trim()))`);
console.log(`  ${sendBtn ? "✓" : "✗"} send button`);
let missing = composerOpen && sendBtn ? 0 : (composerOpen ? 1 : sendBtn ? 1 : 2);
for (const [label, expr] of FEATURES) {
  const found = await ev(expr);
  if (!found) missing++;
  console.log(`  ${found ? "✓" : "✗"} ${label}`);
}
if (errors.length) { console.log("\n  page errors:"); for (const e of [...new Set(errors)].slice(0, 6)) console.log(`    ${e}`); }
console.log(`\n  ${FEATURES.length + 2 - missing}/${FEATURES.length + 2} features present`);
await fetch(`${CDP}/json/close/${t.id}`);
process.exit(missing ? 1 : 0);
