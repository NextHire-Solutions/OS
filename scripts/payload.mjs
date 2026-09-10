/*
 * What each screen actually costs to load.
 *
 * The workspace is meant to feel fast, and the number that decides that is not
 * the server's render time — it is how many bytes the browser has to fetch and
 * parse before the screen is usable. Reported per screen so a regression is
 * attributable rather than a vague "it got slower".
 */
import fs from "node:fs";
const BASE = "http://localhost:3210", CDP = "http://localhost:9333";
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const SCREENS = ["/", "/inbox/all-email", "/inbox/settings/templates", "/client-health/weekly"];
for (const path of SCREENS) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const bytes = { doc: 0, script: 0, css: 0, other: 0 }; let n = 0;
  /*
   * Bytes come from `loadingFinished`, not `responseReceived`.
   *
   * `responseReceived.encodedDataLength` is the size known at header time and
   * is 0 for anything streamed or chunked — which is most of a Next.js page.
   * Reading it reported this app at "1KB", which is off by two orders of
   * magnitude. `loadingFinished` fires once the body is complete and carries
   * the real transferred size, so requestId has to be mapped to its type first.
   */
  const typeOf = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Network.responseReceived") {
      typeOf.set(m.params.requestId, m.params.type);
    } else if (m.method === "Network.loadingFinished") {
      n++;
      const t = typeOf.get(m.params.requestId);
      const k = t === "Document" ? "doc" : t === "Script" ? "script" : t === "Stylesheet" ? "css" : "other";
      bytes[k] += Number(m.params.encodedDataLength || 0);
    }
  };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
  /*
   * Cache OFF. With the shared Chrome profile the second run served every
   * asset from memory and `encodedDataLength` came back 0 — the report read
   * "1KB" for a page that is nowhere near 1KB. A performance number that is
   * wrong in the flattering direction is worse than none.
   */
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  const t0 = Date.now();
  await send("Page.navigate", { url: BASE + path });
  for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 100)); if ((await ev("document.readyState")) === "complete") break; }
  await new Promise((r) => setTimeout(r, 600));
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  const kb = (x) => (x / 1024).toFixed(0).padStart(5);
  console.log(`  ${path.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms  total ${kb(total)}KB  (js ${kb(bytes.script)}KB · css ${kb(bytes.css)}KB · html ${kb(bytes.doc)}KB)  ${n} requests`);
  await fetch(`${CDP}/json/close/${t.id}`);
}
