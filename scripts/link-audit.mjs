/*
 * Does every link in the workspace actually go somewhere?
 *
 *   node scripts/link-audit.mjs [baseUrl]
 *
 * Collects every internal href rendered on every screen and fetches it. A link
 * that 404s looks exactly like a link that works until someone clicks it, and
 * nothing in the other sweeps would ever notice — they judge the page the link
 * is ON, never the page it points TO.
 *
 * External links are reported but not fetched: a customer portal or a third
 * party being slow is not this workspace's fault, and hammering them from a
 * test is rude.
 */
import fs from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
  const pick = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"),
    { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
}

const ROUTES = [
  "/", "/performance", "/roster", "/admin/team",
  "/inbox/all-email", "/inbox/reminders", "/inbox/archive", "/inbox/portals",
  "/inbox/settings", "/inbox/settings/labels", "/inbox/settings/templates",
  "/inbox/settings/reply-agents", "/inbox/settings/ai-labeling", "/inbox/settings/members",
  "/clients", "/clients/biweekly", "/clients/success",
  "/analytics/campaign", "/analytics/infrastructure", "/analytics/attribution",
  "/analytics/copy", "/analytics/campaigns", "/analytics/schedule", "/analytics/clients",
  "/onboarding/pipeline", "/onboarding/stages", "/onboarding/templates", "/onboarding/settings",
  "/search/search", "/search/master", "/search/accounts", "/search/mls", "/search/import",
];

const CDP = process.env.CDP || "http://localhost:9460";
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const w = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); } };
const send = (me, p = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookie = await token();
await send("Page.enable"); await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https") });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const internal = new Map();   // href -> the routes it appears on
const external = new Set();

for (const route of ROUTES) {
  await send("Page.navigate", { url: BASE + route });
  for (let i = 0; i < 70; i++) {
    const n = await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`);
    if (n > 400) break;
    await sleep(200);
  }
  await sleep(700);
  const hrefs = await ev(`[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))`);
  for (const h of hrefs ?? []) {
    if (!h || h.startsWith("#") || h.startsWith("mailto:") || h.startsWith("tel:")) continue;
    if (/^https?:\/\//i.test(h)) { external.add(h); continue; }
    if (!internal.has(h)) internal.set(h, new Set());
    internal.get(h).add(route);
  }
}
ws.close();

console.log(`  ${internal.size} distinct internal links · ${external.size} external (not fetched)\n`);

let bad = 0;
for (const [href, routes] of [...internal].sort()) {
  const url = BASE + (href.startsWith("/") ? href : "/" + href);
  let status = 0;
  try {
    const res = await fetch(url, { headers: { cookie: `bs_sso=${cookie}` }, redirect: "manual", signal: AbortSignal.timeout(25_000) });
    status = res.status;
  } catch { status = 0; }
  const ok = status === 200 || (status >= 300 && status < 400);
  if (!ok) {
    bad++;
    console.log(`  ✗ ${String(status || "no response").padEnd(12)} ${href}`);
    console.log(`       linked from: ${[...routes].join(", ")}`);
  }
}
console.log(bad === 0 ? "\n  ✅ every internal link resolves\n" : `\n  ${bad} broken link(s)\n`);
process.exit(0);
