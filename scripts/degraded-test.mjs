/*
 * What does the workspace do when a tool is DOWN?
 *
 *   node scripts/degraded-test.mjs [baseUrl]
 *
 * Every suite so far tested the happy path: all five tools up, all data
 * present. But these are five separate deployments and any of them can be
 * unreachable at any moment. The failure that matters is not "a screen is
 * empty" — it is "a screen is empty and looks exactly like a client with no
 * data", which is how somebody concludes a real client sent nothing.
 *
 * So each tool's origin is blocked in turn and every screen belonging to it is
 * checked for three things:
 *
 *   RENDERS      the shell is still there — not a blank page, not a crash
 *   EXPLAINS     the screen SAYS something is unavailable
 *   NOT A LIE    it does not show a confident zero where it means "unknown"
 *
 * The third is the one with teeth. `lib/clients/overview.ts` and
 * `lib/workspace/performance.ts` both go out of their way to return null
 * rather than 0 for this reason; this proves it reaches the screen.
 */
import fs from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const CDP = process.env.CDP || "http://localhost:9460";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const tok = await mintSso(env.BS_SSO_SECRET || env.AUTH_SECRET,
  { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const host = (u) => { try { return new URL(u).host; } catch { return null; } };

/*
 * Block the DATABASE, not the tool's website.
 *
 * The first version of this blocked `clients.brokerstaffer.com` and friends and
 * found every screen rendering full data — because the workspace does not call
 * those deployments to render. It reads each tool's Supabase project directly,
 * which is why a tool being down does not take its screens down with it. Good
 * architecture, and a test premise that was simply wrong.
 *
 * The real dependency is the database behind each tool. That is what is
 * blocked here.
 */
const TOOLS = [
  { name: "Client Health", origin: host(env.CLIENT_HEALTH_SUPABASE_URL), screens: ["/clients", "/clients/biweekly"] },
  { name: "Analytics",     origin: host(env.ANALYTICS_SUPABASE_URL),     screens: ["/analytics/campaign", "/analytics/clients"] },
  { name: "Onboarding",    origin: host(env.AGENT_SEARCH_SUPABASE_URL),  screens: ["/onboarding/pipeline"] },
];

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable"); await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: tok, domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https") });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`    ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

for (const tool of TOOLS) {
  if (!tool.origin) { console.log(`  (no URL configured for ${tool.name})`); continue; }
  console.log(`\n  ── ${tool.name} unreachable (${tool.origin}) ──`);
  await send("Network.setBlockedURLs", { urls: [`*${tool.origin}*`] });

  for (const path of tool.screens) {
    await send("Page.navigate", { url: BASE + path });
    await sleep(7000);
    const state = await ev(`(() => {
      const shell = document.querySelector('.rail') !== null;
      const screen = document.querySelector('section.screen.on');
      const text = (screen || document.body).innerText || '';
      return JSON.stringify({
        shell,
        chars: text.length,
        // Does it admit something is wrong, in words a person would read?
        explains: /unavailable|could not|couldn't|failed|unreachable|no response|error|not set|try again/i.test(text),
        // A confident zero where the honest answer is "we do not know".
        confidentZero: /\\b0\\b/.test(text) && !/—|unavailable|could not/i.test(text),
        sample: text.replace(/\\s+/g, ' ').slice(0, 110),
      });
    })()`);
    const s = JSON.parse(state || "{}");
    console.log(`    ${path}`);
    check(s.shell === true, "the workspace shell still renders");
    check(s.chars > 60, "the screen is not blank", `${s.chars} chars`);
    check(s.explains === true, "it says something is unavailable", s.sample.slice(0, 70));
    check(s.confidentZero === false, "it does not show a confident 0 for unknown");
  }
  await send("Network.setBlockedURLs", { urls: [] });
}

ws.close();
console.log(`\n  ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
