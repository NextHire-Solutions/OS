/*
 * Drives a real Chrome over the DevTools Protocol.
 *
 * No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket and Node
 * has both `fetch` and `WebSocket` built in, so the whole driver is the ~40
 * lines below.
 *
 *   node scripts/ui-test.mjs [baseUrl]
 *
 * Reports, per screen: HTTP status, time to render, console errors, failed
 * network requests, and whether the screen actually drew rows rather than an
 * empty state. That last one matters most — every silent failure in this
 * project so far rendered a clean, empty, entirely wrong page.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
const CDP = "http://localhost:9333";

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

class Tab {
  #ws; #id = 0; #pending = new Map(); #handlers = [];
  static async open() {
    const t = new Tab();
    const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    t.targetId = target.id;
    t.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { t.#ws.onopen = ok; t.#ws.onerror = no; });
    t.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && t.#pending.has(m.id)) { t.#pending.get(m.id)(m); t.#pending.delete(m.id); }
      else if (m.method) for (const h of t.#handlers) h(m);
    };
    return t;
  }
  on(fn) { this.#handlers.push(fn); }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

/* Screen → a selector that must match at least `min` elements once loaded. */
const SCREENS = [
  { path: "/",                    expect: null,             min: 0,  label: "Home" },
  { path: "/inbox/all-email",     expect: 'a[href^="/inbox/all-email/"]', min: 5, label: "Inbox · All Email" },
  { path: "/inbox/archive",       expect: 'a[href^="/inbox/archive/"]', min: 3, label: "Inbox · Archive" },
  { path: "/leads",               expect: "section.screen.on *", min: 3, label: "Inbox · Leads" },
  { path: "/inbox/reminders",     expect: "section.screen.on *", min: 3, label: "Inbox · Reminders" },
  { path: "/inbox/settings",      expect: ".mi-settings-tabs .fp", min: 8, label: "Inbox · Settings" },
  { path: "/inbox/portals",       expect: "section.screen.on *", min: 20, label: "Inbox · Portals" },
  { path: "/inbox/portals/c370499d-8cc4-4c1f-93b0-f75d363b108d", expect: "section.screen.on *", min: 50, label: "Portal · one client" },
  { path: "/inbox/settings/templates",   expect: 'input[placeholder*="emplate"]', min: 1, label: "Settings · Templates" },
  { path: "/inbox/settings/labels",      expect: '.mi-settings-body *', min: 20, label: "Settings · Labels" },
  { path: "/inbox/settings/reply-agents",expect: '.mi-settings-body *', min: 10, label: "Settings · Agents" },
  { path: "/inbox/settings/ai-labeling", expect: '.mi-settings-body *', min: 10, label: "Settings · AI" },
  { path: "/inbox/settings/members",     expect: '.mi-settings-body *', min: 5,  label: "Settings · Members" },
  { path: "/client-health",       expect: "table tr, [role=row]",     min: 5, label: "Client Health" },
  { path: "/clients",             expect: "table tr, [role=row]",     min: 5, label: "Clients roster" },
];

const cookie = await token();
let fail = 0;

for (const s of SCREENS) {
  const tab = await Tab.open();
  const errors = [], netFails = [], aborted = [];
  const reqUrl = new Map();
  tab.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160));
    if (m.method === "Runtime.exceptionThrown")
      errors.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 160));
    if (m.method === "Network.loadingFailed") {
      /*
       * ERR_ABORTED is a CANCELLED request, not a failed one — Next cancels
       * in-flight prefetches when a navigation supersedes them, and React
       * aborts fetches from unmounting components. Reporting it as a failure
       * made two healthy screens flap red.
       *
       * It is recorded rather than dropped, so a genuine abort storm is still
       * visible, but it does not fail the screen on its own.
       */
      const t = m.params.errorText || "";
      const url = (reqUrl.get(m.params.requestId) || "").replace(BASE, "");
      if (/ERR_ABORTED/.test(t)) aborted.push(url || t);
      else netFails.push(`${t} ${url}`);
    }
    if (m.method === "Network.requestWillBeSent") reqUrl.set(m.params.requestId, m.params.request.url);
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
      netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  });
  await tab.send("Runtime.enable");
  await tab.send("Network.enable");
  await tab.send("Page.enable");
  await tab.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });

  const t0 = Date.now();
  await tab.send("Page.navigate", { url: BASE + s.path });
  // Wait for the expected content rather than a fixed sleep — a timer either
  // flakes or wastes seconds, and neither tells you when the screen was ready.
  let count = 0, ready = false;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    count = (await tab.eval(s.expect ? `document.querySelectorAll(${JSON.stringify(s.expect)}).length` : "1")) ?? 0;
    if (count >= s.min && (await tab.eval("document.readyState")) === "complete") { ready = true; break; }
  }
  const ms = Date.now() - t0;
  const title = await tab.eval("document.title");
  const bodyLen = await tab.eval("document.body.innerText.length");

  const ok = ready && errors.length === 0 && netFails.length === 0;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${s.label.padEnd(16)} ${String(ms).padStart(5)}ms  ${String(count).padStart(4)} nodes  ${bodyLen} chars  "${String(title).slice(0, 30)}"`);
  for (const e of [...new Set(errors)].slice(0, 4))   console.log(`      console: ${e}`);
  for (const n of [...new Set(netFails)].slice(0, 4)) console.log(`      network: ${n}`);
  if (aborted.length) console.log(`      (${aborted.length} cancelled request(s), not failures: ${[...new Set(aborted)].slice(0, 2).join(", ")})`);
  if (!ready) console.log(`      never reached ${s.min}× "${s.expect}"`);
  await tab.close();
}

console.log(`\n  ${SCREENS.length - fail}/${SCREENS.length} screens clean`);
process.exit(fail ? 1 : 0);
