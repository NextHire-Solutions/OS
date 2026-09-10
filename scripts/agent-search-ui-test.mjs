/*
 * Drives the five Agent Search screens in a real Chrome over the DevTools
 * Protocol. No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket
 * and Node has fetch and WebSocket built in.
 *
 *   node scripts/agent-search-ui-test.mjs [baseUrl] [cdpUrl]
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT CLICKED
 *
 * Four controls in this tool spend money or hammer a third party:
 *   Search / Start enrichment      Bright Data traffic + Realtor credits
 *   Add account & start sweep      writes Railway vars, redeploys, re-scrapes
 *   Detect MLSs                    logs into Courted
 *   Scan all accounts              logs into all nine Courted accounts
 *   Re-scrape                      a full account sweep
 *
 * None of them are clicked. Their payloads are asserted instead, in
 * src/lib/tools/agent-search/agent-search.test.ts, against pure builders — see
 * payload.ts for why that is the only responsible way to test them.
 *
 * What IS exercised here: that every screen renders real data, that the
 * validation refusals fire, and that the free controls work (toggles, options,
 * the MLS baseline picker, CSV detection).
 *
 * These drive the REAL workspace routes — /search, /search/master, and so on —
 * through the real shell, not a harness. A screen that only works in a
 * purpose-built page is not wired.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3320";
const CDP = process.argv[3] || "http://localhost:9445";

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1,
});

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval threw");
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`    ok    ${label}${detail ? `  ${detail}` : ""}`); }
  else { fail++; console.log(`    FAIL  ${label}${detail ? `  ${detail}` : ""}`); }
};

const tab = await Tab.open();
const errors = [], netFails = [];
tab.on((m) => {
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  if (m.method === "Runtime.exceptionThrown")
    errors.push(String(m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
  if (m.method === "Network.loadingFailed" && !m.params.canceled)
    netFails.push(m.params.errorText);
});

await tab.send("Runtime.enable");
await tab.send("Page.enable");
await tab.send("Network.enable");
await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await tab.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
/** The five real workspace addresses. */
const ROUTE = {
  search: "/search",
  master: "/search/master",
  accounts: "/search/accounts",
  mls: "/search/mls",
  import: "/search/import",
};

/*
 * Go to a real route and wait for it to settle.
 *
 * The shell animates the screen in, so waiting on readyState alone catches a
 * half-painted page. It waits for the visible screen to reach full opacity and
 * for the .as header to exist, then gives the three read endpoints a moment.
 */
const show = async (id) => {
  await tab.send("Page.navigate", { url: `${BASE}${ROUTE[id]}` });
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if ((await tab.eval("document.readyState")) === "complete"
      && (await tab.eval("!!document.querySelector('section.screen.on .as-hd')"))) break;
  }
  for (let i = 0; i < 40; i++) {
    const o = await tab.eval(`getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`);
    if (Number(o) >= 0.999) break;
    await sleep(50);
  }
  await sleep(1800);
};
const q = (sel, prop = "textContent") =>
  tab.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).${prop} ?? null`);
const count = (sel) => tab.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = (sel) => tab.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText || ""`);

/* ------------------------------------------------------------------ SEARCH */
console.log("\n  Search");
await show("search");
{
  const hd = await text('section.screen.on .as-hd');
  check("header renders with live status badges", /Agent Search/.test(hd) && /Courted · 9 accts/.test(hd),
    `→ ${hd.replace(/\n+/g, " · ").slice(0, 74)}`);
  check("three source toggles", (await count('section.screen.on .as-tog')) === 3);
  check("Courted + Zillow on by default, Realtor off",
    (await count('section.screen.on .as-tog.on')) === 2);
  check("three result panels", (await count('section.screen.on .as-res')) === 3);
  check("Realtor panel dimmed (inactive)",
    Number(await tab.eval(`getComputedStyle(document.querySelectorAll('section.screen.on .as-res')[2]).opacity`)) < 0.5);

  // Options is collapsed; open it and confirm all nine controls exist.
  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn.ghost')].find(b=>/Options/.test(b.textContent)).click()`);
  await sleep(350);
  /*
   * Six numeric fields, not seven. index.html has seven type=number inputs in
   * total, but importConcurrency belongs to the Import card — the Search card
   * has courtedMax, minSalesVolume, zillowMaxPages, zillowConcurrency,
   * realtorMax, realtorConcurrency. Five checkboxes: showAll plus the four
   * enrich/all-agents toggles.
   */
  const nums = await count('section.screen.on input[type=number]');
  const boxes = await count('section.screen.on input[type=checkbox]');
  check("Options reveals 3 groups, 6 numeric fields and 5 checkboxes",
    nums === 6 && boxes === 5 && (await count('section.screen.on .as-tog')) === 3,
    `→ ${nums} numeric, ${boxes} checkboxes`);

  // Validation refusal — this makes NO request.
  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>b.textContent.trim()==='Search').click()`);
  await sleep(400);
  const err = await text('section.screen.on [role=alert]');
  check("empty search is refused, not sent", /at least one location/i.test(err), `→ "${err.slice(0, 58)}…"`);
  check("no scrape was started", (await tab.eval(`!!document.body.innerText.match(/Stop/)`)) === false);

  // Toggling a source is free.
  await tab.eval(`document.querySelectorAll('section.screen.on .as-tog')[2].click()`);
  await sleep(250);
  check("clicking Realtor.com activates it",
    (await count('section.screen.on .as-tog.on')) === 3);
}

/* ------------------------------------------------------------- MASTER LIST */
console.log("\n  Master List");
await show("master");
{
  const body = await text('section.screen.on');
  check("explains the matching rules", /shared phone|shared email|licence/i.test(body));
  const disabled = await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].map(b=>b.disabled)`);
  check("Build and Export are both disabled with no job", disabled.every(Boolean), `→ [${disabled}]`);
  check("prompts the reader to run a search first", /Run a search/i.test(body));
}

/* --------------------------------------------------------- COURTED ACCOUNTS */
console.log("\n  Courted accounts");
await show("accounts");
{
  const rows = await count('section.screen.on tbody tr');
  check("nine live Courted accounts listed", rows === 9, `→ ${rows} rows`);
  const body = await text('section.screen.on');
  check("real account emails rendered", /jeffcook@jeffcookrealestate\.com/.test(body));
  check("agent reach shown", /Agent reach/.test(body) && /2,\d{3},\d{3}|1,\d{3},\d{3}/.test(body));
  check("MLS names resolved, not raw codes", /Canopy MLS|Georgia MLS|First MLS/.test(body));
  check("refresh recency shown", /days? ago|hours? ago/.test(body));
  check("add-account form present (email, password, detect)",
    (await count('section.screen.on input[type=email]')) === 1
    && (await count('section.screen.on input[type=password]')) === 1);

  // Refusal path — makes NO request to Courted.
  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Detect MLSs/.test(b.textContent)).click()`);
  await sleep(400);
  check("Detect refuses without credentials",
    /Enter the Courted email and password first/.test(await text('section.screen.on [role=alert]')));

  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Add account/.test(b.textContent)).click()`);
  await sleep(400);
  check("Add refuses without credentials",
    /Enter the Courted email and password\./.test(await text('section.screen.on [role=alert]')));
}

/* -------------------------------------------------------------- MLS MONITOR */
console.log("\n  MLS monitor");
await show("mls");
{
  const body = await text('section.screen.on');
  const blocks = await count('section.screen.on .as-card:last-of-type > div > div');
  check("the scheduler's last scan is shown without scanning", blocks >= 9, `→ ${blocks} account blocks`);
  check("server baseline is the default comparison",
    /Server baseline/.test(body) && (await tab.eval(`document.querySelectorAll('section.screen.on .as-tog.on').length`)) === 1);
  check("both baselines offered", /Server baseline/.test(body) && /This browser/.test(body));
  check("browser baseline reports none saved", /none saved/.test(body));
  check("per-account MLS detail rendered", /CANOPY|GAMLS|CHSMLS/.test(body));
  check("no-baseline accounts are not falsely marked changed",
    !/CHANGED/.test(body) && /no change|no baseline/.test(body));
  check("the scheduler's own monitor can be run on demand",
    await tab.eval(`!![...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Run monitor now/.test(b.textContent))`));
  check("Save as baseline disabled until a scan exists",
    await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Save as baseline/.test(b.textContent)).disabled`));

  // Switching to the browser baseline is free and must not error.
  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-tog')].find(b=>/This browser/.test(b.textContent)).click()`);
  await sleep(350);
  check("switching to the browser baseline re-renders", /This browser/.test(await text('section.screen.on')));
}

/* ------------------------------------------------------------------ IMPORT */
console.log("\n  Import Profile URLs");
await show("import");
{
  check("sheet input, CSV textarea and file picker all present",
    (await count('section.screen.on input[type=text]')) === 1
    && (await count('section.screen.on textarea')) === 1
    && (await count('section.screen.on input[type=file]')) === 1);
  check("Start is disabled before Detect",
    await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Start enrichment/.test(b.textContent)).disabled`));

  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Detect URLs/.test(b.textContent)).click()`);
  await sleep(400);
  check("Detect refuses empty input", /Paste a Google Sheet link or a CSV/.test(await text('section.screen.on [role=alert]')));

  /*
   * A real Detect against a pasted CSV. This is safe: /enrich/resolve is
   * reimplemented natively and only parses text — it scrapes nothing and
   * costs nothing.
   */
  await tab.eval(`(() => {
    const ta = document.querySelector('section.screen.on textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, "Full Name,Email Address,Mobile Phone,Agent Profile\\nJane Doe,jane@acme.com,(305) 555-0101,https://www.zillow.com/profile/janedoe\\nBob Smith,,,https://www.realtor.com/realestateagents/abc123\\nNo URL Row,,,\\n");
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Detect URLs/.test(b.textContent)).click()`);
  await sleep(1400);
  const detected = await text('section.screen.on [role=status], section.screen.on [role=alert]');
  check("Detect parses the CSV: 2 URLs, 1 Zillow, 1 Realtor, cost estimated",
    /Found 2 profile URLs/.test(detected) && /1 Zillow/.test(detected) && /1 Realtor/.test(detected) && /\$0\.003/.test(detected),
    `→ "${detected.replace(/\n+/g, " ").slice(0, 96)}…"`);
  check("the row with no URL was dropped", !/Found 3/.test(detected));
  check("Start enrichment is now enabled (NOT clicked — it costs money)",
    (await tab.eval(`[...document.querySelectorAll('section.screen.on .as-btn')].find(b=>/Start enrichment/.test(b.textContent)).disabled`)) === false);
}

/* ------------------------------------------------------------------ health */
console.log("\n  Page health");
const realErrors = errors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
check("no console errors", realErrors.length === 0, realErrors.length ? `→ ${realErrors[0]}` : "");
const realNetFails = netFails.filter((e) => !/ERR_ABORTED/.test(e));
check("no failed requests", realNetFails.length === 0, realNetFails.length ? `→ ${realNetFails.join(", ")}` : "");

await tab.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
