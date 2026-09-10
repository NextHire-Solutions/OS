/* Screenshots a screen. `node scripts/shot.mjs <path> <out.png> [width]` */
import fs from "node:fs";
const [, , path = "/inbox/all-email", out = "/tmp/shot.png", width = "1600"] = process.argv;
const BASE = "http://localhost:3210", CDP = "http://localhost:9333";
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Network.setCookie", { name: "bs_sso", value: await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 }), domain: "localhost", path: "/" });
await send("Page.navigate", { url: BASE + path });
for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await ev("document.readyState")) === "complete" && (await ev("document.body.innerText.length")) > 3000) break; }
/*
 * Wait for the screen's fade-in to FINISH, not merely for the DOM to be ready.
 *
 * The shell fades a screen in on entry. Capturing while `.screen.on` is at
 * opacity 0.84 produces a washed-out image that reads as a styling bug — it
 * cost an investigation into a colour problem that did not exist.
 */
for (let i = 0; i < 60; i++) {
  const o = await ev(`getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`);
  if (Number(o) >= 0.999) break;
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 250));
const { data } = await send("Page.captureScreenshot", { format: "png" }).then((r) => r.result);
fs.writeFileSync(out, Buffer.from(data, "base64"));
console.log(`  ${out}  ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
await fetch(`${CDP}/json/close/${t.id}`);
