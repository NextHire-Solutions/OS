/*
 * "Normalize" with TWO series selected.
 *
 * The sweep called it dead because the chart did not change. It doesn't — the
 * chart opens with one line (DEFAULT_SERIES = ["replies"]), and normalizing a
 * single line to its own scale is the same number as the shared maximum. The
 * control is a no-op by arithmetic, not by breakage.
 *
 * Which means the sweep never actually tested it. This does: add a second
 * series with a very different magnitude (Sent dwarfs Replies), then toggle.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const t = await (await fetch("http://localhost:9460/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const w = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); } };
const send = (me, p = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 }), domain: "os.brokerstaffer.com", path: "/", secure: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/analytics/campaign" });
await sleep(7000);

const paths = () => ev(`[...document.querySelectorAll('svg path')].map(x=>x.getAttribute('d')||'').filter(Boolean).join('|')`);
const clickChip = (name) => ev(`(() => {
  const el = [...document.querySelectorAll('button,[role=checkbox],label')]
    .find(x => (x.innerText||'').trim().toLowerCase() === ${JSON.stringify(name)}.toLowerCase());
  if (!el) return 'NOT_FOUND'; el.click(); return 'ok';
})()`);

const oneLine = await paths();
console.log(`  one series  : ${oneLine.split("|").length} path(s)`);
console.log(`  add "Sent"  : ${await clickChip("Sent")}`);
await sleep(3500);
const twoLines = await paths();
console.log(`  two series  : ${twoLines.split("|").length} path(s)`);

const toggle = () => ev(`(() => {
  const el = [...document.querySelectorAll('input[type=checkbox]')]
    .find(x => /normal/i.test((x.closest('label')||x.parentElement||{}).textContent||''));
  if (!el) return 'NOT_FOUND'; el.click(); return el.checked ? 'on' : 'off';
})()`);
const before = await paths();
console.log(`  normalize   : ${await toggle()}`);
await sleep(3500);
const after = await paths();

const changed = before !== after;
console.log(`\n  ${changed ? "PASS" : "FAIL"}  Normalize rescales the chart when 2 series are shown`);
console.log(`        paths ${changed ? "changed" : "IDENTICAL"} (${before.length} → ${after.length} chars)`);
ws.close(); process.exit(changed ? 0 : 1);
