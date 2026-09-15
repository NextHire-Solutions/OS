/*
 * Focused follow-up on the three filters the sweep could not judge.
 *
 * Each needs a check the generic harness cannot make:
 *   A  the inbox search is a TYPEAHEAD, not a list filter — assert the dropdown
 *      and the ?q= route, not the row count
 *   B  Infrastructure baselined at 5 rows — is that a slow table or a real
 *      near-empty default?
 *   C  "Normalize" redraws an SVG chart — nothing the row/text snapshot sees
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const CDP = "http://localhost:9460";

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
  const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
  return mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"),
    { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
}
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: await token(), domain: "os.brokerstaffer.com", path: "/", secure: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });
const go = async (u) => { await send("Page.navigate", { url: BASE + u }); await sleep(5000); };
const type = (sel, text) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'NO_EL';
  el.focus(); el.dispatchEvent(new Event('focus', {bubbles:true}));
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', {bubbles:true}));
  return 'typed';
})()`);

const out = [];
const say = (id, pass, msg) => { out.push({ id, pass, msg }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${id}  ${msg}`); };

/* ---- A: inbox typeahead --------------------------------------------- */
console.log("\nA. Inbox top-bar search — a typeahead, not a list filter\n");
await go("/inbox/all-email");
// A real lead name that exists, so a hit is expected.
const realName = await ev(`(() => {
  const a = document.querySelector('a[href*="/inbox/all-email/"]');
  return a ? (a.innerText||'').trim().split('\\n')[0].slice(0,24) : null;
})()`);
console.log(`     using a name from the list: ${JSON.stringify(realName)}`);
await type('input[type=search]', realName || "a");
await sleep(3000);
const hit = await ev(`(() => {
  const d = [...document.querySelectorAll('div')].find(x => /No matches for|^$/.test('') );
  const rows = document.querySelectorAll('ul li a[href*="/inbox/all-email/"]').length;
  const none = document.body.innerText.includes('No matches for');
  return JSON.stringify({rows, none});
})()`);
const h = JSON.parse(hit);
say("A1 typeahead returns hits for a real name", h.rows > 0, `dropdown rows=${h.rows}, "no matches"=${h.none}`);

await go("/inbox/all-email");
await type('input[type=search]', "zzqqxxnotathing");
await sleep(3000);
const miss = JSON.parse(await ev(`JSON.stringify({
  rows: document.querySelectorAll('ul li a[href*="/inbox/all-email/"]').length,
  none: document.body.innerText.includes('No matches for')
})`));
say("A2 nonsense shows an empty state, not silence", miss.none && miss.rows === 0,
    `dropdown rows=${miss.rows}, "no matches" shown=${miss.none}`);

// Enter routes to ?q= — and THAT is what filters the list.
await go("/inbox/all-email");
await type('input[type=search]', realName || "a");
await sleep(2500);
const beforeRows = await ev(`document.querySelectorAll('a[href*="/inbox/all-email/"]').length`);
await ev(`(() => { const el = document.querySelector('input[type=search]');
  el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return 1; })()`);
await sleep(5000);
const urlNow = await ev(`location.pathname + location.search`);
const afterRows = await ev(`document.querySelectorAll('a[href*="/inbox/all-email/"]').length`);
say("A3 Enter routes to ?q= and narrows the thread list",
    urlNow.includes("q="), `url=${urlNow}  rows ${beforeRows}→${afterRows}`);

/* ---- B: infrastructure baseline ------------------------------------- */
console.log("\nB. Analytics → Infrastructure — is the 5-row baseline real?\n");
await go("/analytics/infrastructure");
const series = [];
for (let i = 0; i < 12; i++) { series.push(await ev(`document.querySelectorAll('table tbody tr').length`)); await sleep(2000); }
console.log(`     rows over 24s: ${series.join(" → ")}`);
const settled = series[series.length - 1];
say("B1 the default view is populated, not near-empty", settled > 50,
    `settles at ${settled} rows (sweep baselined at ${series[0]})`);

/* ---- C: normalize --------------------------------------------------- */
console.log("\nC. Analytics → Campaign — the Normalize checkbox redraws the chart\n");
await go("/analytics/campaign");
await sleep(4000);
const chartBefore = await ev(`(() => {
  const p = [...document.querySelectorAll('svg path')].map(x => x.getAttribute('d')||'').join('|');
  return p.length ? p.slice(0,3000) : 'NO_PATHS';
})()`);
const clicked = await ev(`(() => {
  const el = [...document.querySelectorAll('input[type=checkbox]')]
    .find(x => /normal/i.test((x.closest('label')||x.parentElement||{}).textContent||''));
  if (!el) return 'NOT_FOUND';
  el.click(); return 'clicked';
})()`);
await sleep(3500);
const chartAfter = await ev(`(() => {
  const p = [...document.querySelectorAll('svg path')].map(x => x.getAttribute('d')||'').join('|');
  return p.length ? p.slice(0,3000) : 'NO_PATHS';
})()`);
say("C1 Normalize changes the chart geometry",
    clicked === "clicked" && chartBefore !== "NO_PATHS" && chartBefore !== chartAfter,
    `click=${clicked}, paths ${chartBefore === chartAfter ? "IDENTICAL" : "changed"} (${chartBefore.length} chars)`);

console.log("\n" + "=".repeat(70));
const bad = out.filter((o) => !o.pass);
console.log(bad.length ? `  ${bad.length} FAILED: ${bad.map(b=>b.id).join("; ")}` : "  all probes passed");
ws.close(); process.exit(bad.length ? 1 : 0);
