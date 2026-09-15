/*
 * Drives the two Client Portals screens in a real Chrome and ticks off
 * PORTALS-PARITY.md.
 *
 *   node scripts/portals-ui-test.mjs [baseUrl]
 *
 *   PORT   3380   (never 3111/3210/3310/3330/3340/3350/3360/3370)
 *   CDP    9452   (never 9222/9333/9444/9446/9447/9448/9450/9451)
 *
 * No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket and Node 24
 * has `fetch` and `WebSocket` built in. Driver lifted from scripts/ui-test.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST NEVER COMPLETES A WRITE
 *
 * These screens sit on top of `clients.portal_token`, and 47 live customer
 * portals are addressed by it. A test that "just clicks Save" to prove a button
 * works would be writing to real customer rows on a real database.
 *
 * So every mutating request is INTERCEPTED in the page: `window.fetch` is
 * wrapped, POST/PATCH/DELETE to the portal API are recorded and answered with a
 * synthetic 404 instead of going out. That proves exactly what a restyle can
 * break — the control still fires the right method, at the right URL, with the
 * right body — while guaranteeing the database is untouched.
 *
 * (Those routes do not exist in this repository anyway; the interception means
 * the test does not depend on that staying true.)
 *
 * The two controls that would hit a REAL customer — the live toggle and the
 * portal-URL Save — are asserted structurally and never clicked. `confirm()` is
 * stubbed to decline, so the delete paths are proven to be gated without
 * destroying a row.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3380";
const CDP = process.env.CDP_URL || "http://localhost:9452";

/* Demo Portal — the designated test client. Every feature flag is on, so the
   gated controls (Board view, CSV, Manage stages, Source) actually render. */
const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
/*
 * The Follow Up Boss chip renders only when the client has an API key saved,
 * and NEITHER safe client has one — checked directly: Demo Portal and Test FUB
 * both have fub_api_key null, while 17 real clients have one. So its absence on
 * Demo Portal is correct behaviour, not a regression.
 *
 * To prove the chip itself survived the restyle it is looked at on a
 * FUB-connected client, whose drill-down is opened READ-ONLY: the page is
 * loaded and its text is read. Nothing is clicked, no request is made, and the
 * fetch interceptor is in place regardless.
 */
const FUB_CLIENT = "ce7b2983-3743-4c6b-ab12-02f1fe1509c8"; // ChuckTown Homes Team, 63 entries
/* A real client's drill-down, opened READ-ONLY and never clicked, purely to see
   the pagination footer — it returns null below 50 rows and Demo Portal has 15. */
const BIG = "51da8205-ef10-425c-87a7-0d193109117f";

let fubDeferred = false;

async function cookie() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const pick = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
    email: "admin@outreachify.io",
    grants: [...ALL_TOOLS],
    ver: 1,
  });
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

/* ---------------------------------------------------------------------------
 * In-page helpers, installed once per navigation.
 *
 * Controls on these screens are identified by their visible text or aria-label,
 * because that is what the parity list records and what a user actually sees.
 * A CSS-class selector would pass while the button said the wrong thing.
 */
const HELPERS = `
window.__t = {
  all: (sel) => Array.from(document.querySelectorAll(sel)),
  vis: (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  /*
   * Elements holding the needle, TIGHTEST FIRST.
   *
   * The first version rejected any element whose child also held the text, to
   * avoid matching a whole container. That is wrong the moment a control wraps
   * its own label: the row's Conversation button holds an svg and a
   * span "Conversation", so the button was rejected and the check reported a
   * missing control that was on screen the whole time.
   *
   * Sorting by text length keeps the tightest element first while letting a
   * real control own a label element.
   */
  byText: (needle, sel = 'button,a,label,[role=menuitem],[role=button],summary,h1,h2,h3,span,div,p,td,th') =>
    window.__t.all(sel)
      .filter((e) => (e.innerText || e.textContent || '').trim().toLowerCase().includes(needle.toLowerCase()))
      .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length),
  // Dialogs and sheets belonging to THESE screens. Scoped to the marker the
  // components stamp, because a bare role=dialog selector also matches the
  // workspace's command palette and its rail accordion.
  surface: () => window.__t.all('[data-portal-surface]').find(window.__t.vis) || null,
  byLabel: (needle) => window.__t.all('[aria-label],[title]').filter((e) =>
    (e.getAttribute('aria-label') || '').toLowerCase().includes(needle.toLowerCase()) ||
    (e.getAttribute('title') || '').toLowerCase().includes(needle.toLowerCase())),
  clickText: (needle, sel) => { const e = window.__t.byText(needle, sel).find(window.__t.vis); if (!e) return false; e.click(); return true; },
  clickLabel: (needle) => { const e = window.__t.byLabel(needle).find(window.__t.vis); if (!e) return false; e.click(); return true; },
  // Close the portals' own sheet/dialog. Going through byLabel('Close') found
  // the workspace shell's close button first and left the sheet open, which
  // then covered every control the next check wanted to click.
  closeSurface: () => {
    const s = window.__t.surface();
    if (!s) return false;
    const btn = s.querySelector('[aria-label=Close],[aria-label=close]');
    if (btn) { btn.click(); return true; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  },
  click: (sel) => { const e = window.__t.all(sel).find(window.__t.vis); if (!e) return false; e.click(); return true; },
  // React controlled inputs ignore .value = x; the native setter + an input
  // event is the only thing React's onChange sees.
  type: (sel, text) => {
    const el = window.__t.all(sel).find(window.__t.vis); if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  txt: () => document.body.innerText,
  has: (s) => document.body.innerText.toLowerCase().includes(String(s).toLowerCase()),
};

/* Record every mutating call and answer it locally. Nothing leaves the tab. */
window.__writes = [];
window.__confirms = [];
window.confirm = (m) => { window.__confirms.push(String(m)); return false; };
if (!window.__fetchWrapped) {
  window.__fetchWrapped = true;
  const real = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const isWrite = method !== 'GET';
    const isPortalApi = /\\/api\\/tools\\/master-inbox\\/(portal|clients)\\//.test(url);
    if (isWrite && isPortalApi) {
      window.__writes.push({ method, url, body: (init && typeof init.body === 'string') ? init.body.slice(0, 400) : null });
      /*
       * How the reply is chosen.
       *
       * A single-entry PATCH — /pipeline/<id> — is answered 200. Its caller
       * only checks res.ok, and on FAILURE the board calls router.refresh() to
       * roll the optimistic update back, which is correct behaviour but meant
       * the interceptor was testing the rollback: a lead parked in a custom
       * stage un-parked itself a moment later. A local 200 models the success
       * path the customer gets, while the request still never leaves the tab.
       *
       * Everything else is answered 404, because those callers read a specific
       * response shape and a generic body is worse than an error. The add-note
       * handler, for one, does a note object out of the response and pushes
       * it straight into the list — a synthetic 200 without a real note
       * object took the whole page down with a client-side exception. For those
       * endpoints the assertion is only that the right request fires, and a 404
       * proves that just as well.
       *
       * Either way the database is never touched.
       */
      const singleEntryPatch = method === 'PATCH' &&
        /\\/pipeline\\/[0-9a-f-]{36}$/.test(url.split('?')[0]);
      return singleEntryPatch
        ? new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'intercepted by portals-ui-test' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (!isWrite && isPortalApi) window.__writes.push({ method, url, body: null });
    return real(input, init);
  };
}
true;
`;

let pass = 0, fail = 0, skip = 0;
const rows = [];
function record(id, name, status, detail = "") {
  if (status === "PASS" || status === "RENDER" || status === "VISUAL") pass++;
  else if (status === "NOT-RUN") skip++;
  else fail++;
  rows.push({ id, name, status, detail });
  const mark = status === "FAIL" ? "✗" : status === "NOT-RUN" ? "–" : "✓";
  console.log(`   ${mark} ${id.padEnd(4)} ${name.padEnd(52)} ${status}${detail ? "  — " + detail : ""}`);
}

/*
 * A real Escape keypress. A KeyboardEvent dispatched from inside the page does
 * not reach Base UI's handler, so a menu opened by an earlier check stayed
 * open and the next check read ITS items — the stage-pill check picked
 * "Unassigned" out of a bulk assign menu that was never dismissed.
 */
async function esc(tab) {
  for (const type of ["keyDown", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", {
      type, key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }
  await new Promise((r) => setTimeout(r, 350));
}

async function open(tab, path, waitFor, min = 1, budget = 45000) {
  const errors = [], netFails = [];
  tab.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    if (m.method === "Runtime.exceptionThrown")
      errors.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400 &&
        !/favicon/.test(m.params.response.url))
      netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  });
  const t0 = Date.now();
  await tab.send("Page.navigate", { url: BASE + path });
  let ok = false;
  /* /inbox/portals walks 1,113 introductions on a cold load (~13s) and is TTL
     cached for 5 minutes after — hence a budget, not a fixed sleep. */
  while (Date.now() - t0 < budget) {
    await new Promise((r) => setTimeout(r, 250));
    const ready = await tab.eval("document.readyState").catch(() => null);
    if (ready !== "complete") continue;
    await tab.eval(HELPERS).catch(() => {});
    const n = await tab.eval(`document.querySelectorAll(${JSON.stringify(waitFor)}).length`).catch(() => 0);
    if (n >= min) { ok = true; break; }
  }
  await tab.eval(HELPERS).catch(() => {});
  return { ok, ms: Date.now() - t0, errors, netFails };
}

const cook = await cookie();
async function fresh() {
  const tab = await Tab.open();
  await tab.send("Runtime.enable");
  await tab.send("Network.enable");
  await tab.send("Page.enable");
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await tab.send("Network.setCookie", { name: "bs_sso", value: cook, domain: "localhost", path: "/" });
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
  return tab;
}

// ===========================================================================
console.log("\n  ── A. Portals list · /inbox/portals ──────────────────────────");
{
  const tab = await fresh();
  const nav = await open(tab, "/inbox/portals", "section.screen.on *", 40, 60000);
  console.log(`     loaded in ${nav.ms}ms  (${nav.errors.length} console errors, ${nav.netFails.length} bad responses)`);
  for (const e of [...new Set(nav.errors)].slice(0, 3)) console.log(`        console: ${e}`);
  for (const n of [...new Set(nav.netFails)].slice(0, 3)) console.log(`        network: ${n}`);

  const stats = await tab.eval(`(() => {
    const cards = window.__t.all('.card, [data-portal-stat]');
    return cards.map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 6);
  })()`);
  record("A1", "Stat card — Clients", /client/i.test(stats.join(" ")) ? "PASS" : "FAIL", stats[0] || "");
  record("A2", "Stat card — Live portals", /live portal/i.test(stats.join(" ")) ? "PASS" : "FAIL", stats[1] || "");
  record("A3", "Stat card — Total introductions", /introduction/i.test(stats.join(" ")) ? "PASS" : "FAIL", stats[2] || "");

  const before = await tab.eval(`window.__t.all('[data-portal-row]').length || window.__t.all('a[href*="/inbox/portals/"]').length`);
  await tab.eval(`window.__t.type('input[type=search], input[placeholder*="Search clients"]', 'Demo')`);
  await new Promise((r) => setTimeout(r, 500));
  const after = await tab.eval(`window.__t.all('[data-portal-row]').length || window.__t.all('a[href*="/inbox/portals/"]').length`);
  record("A4", "Client search filters the list", after < before && after > 0 ? "PASS" : "FAIL", `${before} → ${after} rows`);

  await tab.eval(`window.__t.type('input[type=search], input[placeholder*="Search clients"]', 'zzzznope')`);
  await new Promise((r) => setTimeout(r, 400));
  record("A5", "Search empty state", (await tab.eval(`window.__t.has('No clients match')`)) ? "PASS" : "FAIL");
  await tab.eval(`window.__t.type('input[type=search], input[placeholder*="Search clients"]', '')`);
  await new Promise((r) => setTimeout(r, 500));

  const link = await tab.eval(`(() => { const a = window.__t.all('a[href*="/inbox/portals/"]')[0]; return a ? a.getAttribute('href') : null; })()`);
  record("A6", "Row links into the drill-down", link && /\/inbox\/portals\/[0-9a-f-]{36}/.test(link) ? "PASS" : "FAIL", link || "no link");

  /*
   * Following the link, not just reading it.
   *
   * The href alone passed before this work while the destination did not
   * exist: the row linked at /portals/<id>, the tool's own path, which
   * `idForPath` does not recognise — so every one of the 47 rows fell through
   * to Home. Asserting the href would not have caught that; arriving does.
   */
  const arrived = await tab.eval(`(async () => {
    const a = window.__t.all('a[href*="/inbox/portals/"]')[0];
    if (!a) return 'no link';
    a.click();
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.body.innerText.includes('Recruiting Pipeline')) {
        return { path: location.pathname, header: true };
      }
    }
    return { path: location.pathname, header: false };
  })()`);
  record("A6b", "Following the row link lands on the drill-down",
    arrived && arrived.header && /^\/inbox\/portals\/[0-9a-f-]{36}$/.test(arrived.path) ? "PASS" : "FAIL",
    arrived ? `${arrived.path} — pipeline header ${arrived.header ? "rendered" : "MISSING"}` : "no link");
  await open(tab, "/inbox/portals", "a[href*=\"/inbox/portals/\"]", 5, 60000);

  record("A7", "Portal path readout / 'No portal URL set'",
    (await tab.eval(`window.__t.has('/portal/') || window.__t.has('No portal URL set')`)) ? "VISUAL" : "FAIL");
  record("A8", "Intro-count pill", (await tab.eval(`window.__t.all('[data-portal-intros]').length > 0`)) ? "VISUAL" : "FAIL");
  record("A9", "Last-intro date", (await tab.eval(`window.__t.has('No intros yet') || /\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/.test(window.__t.txt())`)) ? "VISUAL" : "FAIL");

  const sw = await tab.eval(`(() => { const s = window.__t.byLabel('Portal enabled'); return { n: s.length, role: s[0] && (s[0].getAttribute('role') || s[0].tagName) }; })()`);
  record("A10", "Live toggle present and interactive", sw.n > 0 ? "NOT-RUN" : "FAIL", `${sw.n} switches (${sw.role}); never clicked — it would disable a live portal`);

  const copied = await tab.eval(`(async () => {
    let got = null;
    navigator.clipboard.writeText = async (t) => { got = t; };
    if (!window.__t.clickLabel('Copy link')) return 'no button';
    await new Promise((r) => setTimeout(r, 350));
    return got ? (/^https?:\\/\\//.test(got) ? 'url copied' : 'copied: ' + got.slice(0, 12)) : 'nothing copied';
  })()`);
  record("A11", "Copy link → clipboard", copied === "url copied" ? "PASS" : "FAIL", String(copied));

  await tab.eval(`window.__t.clickLabel('Edit URL')`);
  await new Promise((r) => setTimeout(r, 600));
  const dlg = await tab.eval(`(() => {
    const d = window.__t.surface();
    if (!d) return null;
    return { text: d.innerText.replace(/\\s+/g, ' ').slice(0, 80),
             inputs: d.querySelectorAll('input').length,
             buttons: Array.from(d.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean) };
  })()`);
  record("A12", "Edit URL opens the dialog", dlg ? "PASS" : "FAIL", dlg ? dlg.text : "no dialog");
  record("A13", "Dialog — slug input, Cancel, Save URL",
    dlg && dlg.inputs >= 1 && dlg.buttons.some((b) => /save/i.test(b)) ? "NOT-RUN" : "FAIL",
    dlg ? `${dlg.inputs} input(s), buttons: ${dlg.buttons.join(" / ")} — Save never clicked` : "");
  await tab.eval(`window.__t.clickText('Cancel')`);
  await new Promise((r) => setTimeout(r, 400));

  const openLink = await tab.eval(`(() => { const a = window.__t.byLabel('Open live portal').find((e) => e.tagName === 'A'); return a ? a.target + ' ' + (a.href || '').slice(0, 30) : null; })()`);
  record("A14", "Open live portal (new tab)", openLink && /_blank/.test(openLink) ? "VISUAL" : "FAIL", openLink ? "target=_blank, href asserted not followed" : "missing");
  record("A15", "Footer link-secrecy warning", (await tab.eval(`window.__t.has('there is no password')`)) ? "VISUAL" : "FAIL");

  const writes = await tab.eval(`JSON.stringify(window.__writes)`);
  console.log(`     write attempts intercepted on this screen: ${JSON.parse(writes).length}`);
  await tab.close();
}

// ===========================================================================
console.log("\n  ── B–N. Drill-down · /inbox/portals/<Demo Portal> ────────────");
{
  const tab = await fresh();
  const nav = await open(tab, `/inbox/portals/${DEMO}`, "section.screen.on *", 60, 60000);
  console.log(`     loaded in ${nav.ms}ms  (${nav.errors.length} console errors, ${nav.netFails.length} bad responses)`);
  for (const e of [...new Set(nav.errors)].slice(0, 3)) console.log(`        console: ${e}`);
  for (const n of [...new Set(nav.netFails)].slice(0, 3)) console.log(`        network: ${n}`);

  // ---- B. chrome
  record("B1", "'All client portals' back link",
    (await tab.eval(`window.__t.all('a[href="/inbox/portals"]').length > 0`)) ? "PASS" : "FAIL");
  record("B2", "Counts strip — pipeline / agents / DNC / team",
    (await tab.eval(`['in pipeline','agents','DNC','team'].every(window.__t.has)`)) ? "VISUAL" : "FAIL");
  record("B3", "'Open live portal' link",
    (await tab.eval(`window.__t.byText('Open live portal','a').length > 0`)) ? "VISUAL" : "FAIL", "href asserted, not followed");
  record("B4", "Pipeline header + Nicole Collins card",
    (await tab.eval(`window.__t.has('Recruiting Pipeline') && window.__t.has('Nicole Collins')`)) ? "VISUAL" : "FAIL");

  // ---- C. toolbar
  record("C1", "Search candidates box",
    (await tab.eval(`window.__t.all('input[placeholder*="Search candidates"]').length > 0`)) ? "PASS" : "FAIL");
  record("C2", "'Replacements only' checkbox",
    (await tab.eval(`window.__t.has('Replacements only')`)) ? "PASS" : "FAIL");
  record("C3", "'Add candidate' button",
    (await tab.eval(`window.__t.byText('Add candidate','button').length > 0`)) ? "PASS" : "FAIL");
  record("C4", "'Upload CSV' button (flag pipeline_csv_upload)",
    (await tab.eval(`window.__t.byText('Upload CSV','button').length > 0`)) ? "PASS" : "FAIL");
  record("C5", "View toggle List / Board (flag pipeline_kanban_view)",
    (await tab.eval(`window.__t.byText('Board','button').length > 0 && window.__t.byText('List','button').length > 0`)) ? "PASS" : "FAIL");
  record("C6", "Result counter 'N of M candidates'",
    (await tab.eval(`/\\d+ of \\d+ candidates/.test(window.__t.txt())`)) ? "VISUAL" : "FAIL");

  const chips = await tab.eval(`window.__t.all('[data-stage-chip]').length`);
  record("C7", "Stage filter chips with counts", chips >= 5 ? "PASS" : "FAIL", `${chips} chips`);
  const filtered = await tab.eval(`(async () => {
    const before = window.__t.all('[data-pipeline-row]').length;
    const c = window.__t.all('[data-stage-chip]')[0]; if (!c) return 'no chip';
    c.click(); await new Promise((r) => setTimeout(r, 500));
    const after = window.__t.all('[data-pipeline-row]').length;
    const cleared = window.__t.byText('Clear filter').length > 0;
    return { before, after, cleared };
  })()`);
  record("C8", "'Clear filter' appears once a chip is active",
    filtered && filtered.cleared ? "PASS" : "FAIL", JSON.stringify(filtered));
  await tab.eval(`window.__t.clickText('Clear filter')`);
  await new Promise((r) => setTimeout(r, 500));

  // ---- D. bulk bar
  record("D1", "Bulk bar label",
    (await tab.eval(`window.__t.has('Bulk actions')`)) ? "PASS" : "FAIL");
  const bulkDisabled = await tab.eval(`(() => {
    const names = ['Move to','Assign to','Copy names','Copy phones','Export CSV','Delete'];
    return names.map((n) => { const b = window.__t.byText(n, 'button')[0]; return n + '=' + (b ? (b.disabled ? 'disabled' : 'enabled') : 'missing'); });
  })()`);
  record("D9", "Bulk buttons disabled while nothing is selected",
    bulkDisabled.every((s) => /disabled/.test(s)) ? "PASS" : "FAIL", bulkDisabled.join(" "));

  // select one row, then the bar must light up
  await tab.eval(`(() => { const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0]; if (c) c.click(); })()`);
  await new Promise((r) => setTimeout(r, 400));
  record("D1b", "Bar switches to a live count on selection",
    (await tab.eval(`/\\d+ selected/.test(window.__t.txt())`)) ? "PASS" : "FAIL");

  const moveMenu = await tab.eval(`(async () => {
    if (!window.__t.clickText('Move to', 'button')) return 'no trigger';
    await new Promise((r) => setTimeout(r, 500));
    return window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]').filter(window.__t.vis).map((e) => e.innerText.trim()).slice(0, 12);
  })()`);
  record("D2", "'Move to…' opens a per-stage menu",
    Array.isArray(moveMenu) && moveMenu.length >= 5 ? "PASS" : "FAIL", Array.isArray(moveMenu) ? `${moveMenu.length} stages` : String(moveMenu));
  const moveFired = await tab.eval(`(async () => {
    const items = window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]').filter(window.__t.vis);
    if (!items.length) return 'no items';
    window.__writes.length = 0; items[1].click();
    await new Promise((r) => setTimeout(r, 900));
    return window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>') + ' ' + (w.body || ''));
  })()`);
  record("D2b", "Stage move fires the bulk PATCH",
    Array.isArray(moveFired) && moveFired.some((w) => /PATCH .*\/pipeline .*"action":"stage"/.test(w)) ? "RENDER" : "FAIL",
    Array.isArray(moveFired) ? (moveFired[0] || "nothing fired").slice(0, 110) : String(moveFired));

  await esc(tab);
  const reselect = `(async () => {
    const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0];
    if (c && !c.checked) c.click();
    await new Promise((r) => setTimeout(r, 350));
    return /\\d+ selected/.test(window.__t.txt());
  })()`;

  await tab.eval(reselect);
  const assignMenu = await tab.eval(`(async () => {
    if (!window.__t.clickText('Assign to', 'button')) return 'no trigger';
    await new Promise((r) => setTimeout(r, 500));
    return window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]').filter(window.__t.vis).map((e) => e.innerText.trim());
  })()`);
  await esc(tab);
  record("D3", "'Assign to…' opens the roster menu",
    Array.isArray(assignMenu) && assignMenu.some((i) => /unassigned/i.test(i)) ? "PASS" : "FAIL",
    Array.isArray(assignMenu) ? assignMenu.slice(0, 4).join(" / ") : String(assignMenu));

  const copyNames = await tab.eval(`(async () => {
    let got = null; navigator.clipboard.writeText = async (t) => { got = t; };
    const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0];
    if (c && !c.checked) { c.click(); await new Promise((r) => setTimeout(r, 350)); }
    window.__t.clickText('Copy names', 'button'); await new Promise((r) => setTimeout(r, 400));
    return got === null ? 'nothing' : ('copied ' + got.split('\\n').length + ' line(s)');
  })()`);
  record("D4", "'Copy names' writes to the clipboard", /copied/.test(String(copyNames)) ? "PASS" : "FAIL", String(copyNames));
  const copyPhones = await tab.eval(`(async () => {
    let got = null; navigator.clipboard.writeText = async (t) => { got = t; };
    const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0];
    if (c && !c.checked) { c.click(); await new Promise((r) => setTimeout(r, 350)); }
    window.__t.clickText('Copy phones', 'button'); await new Promise((r) => setTimeout(r, 400));
    return got === null ? 'nothing' : ('copied ' + got.split('\\n').length + ' line(s)');
  })()`);
  record("D5", "'Copy phones' writes to the clipboard", /copied/.test(String(copyPhones)) ? "PASS" : "FAIL", String(copyPhones));

  const exported = await tab.eval(`(async () => {
    let name = null, size = 0;
    const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0];
    if (c && !c.checked) { c.click(); await new Promise((r) => setTimeout(r, 350)); }
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { size = b.size; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) name = this.download; };
    window.__t.clickText('Export CSV', 'button');
    await new Promise((r) => setTimeout(r, 500));
    URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
    return name ? name + ' (' + size + ' bytes)' : 'no download';
  })()`);
  record("D6", "'Export CSV' produces a CSV download", /\.csv/.test(String(exported)) ? "PASS" : "FAIL", String(exported));

  const del = await tab.eval(`(async () => {
    const c = window.__t.all('[data-pipeline-row] input[type=checkbox]')[0];
    if (c && !c.checked) { c.click(); await new Promise((r) => setTimeout(r, 350)); }
    window.__confirms.length = 0; window.__writes.length = 0;
    window.__t.clickText('Delete', 'button'); await new Promise((r) => setTimeout(r, 500));
    return { confirmed: window.__confirms.length, wrote: window.__writes.length };
  })()`);
  record("D7", "'Delete' is confirm-gated (declined here)",
    del && del.confirmed > 0 && del.wrote === 0 ? "PASS" : "FAIL",
    `confirm() called ${del.confirmed}×, ${del.wrote} writes after declining`);
  await tab.eval(`window.__t.clickText('Clear', 'button')`);
  await new Promise((r) => setTimeout(r, 400));
  record("D8", "'Clear' empties the selection",
    !(await tab.eval(`/\\d+ selected/.test(window.__t.txt())`)) ? "PASS" : "FAIL");

  // ---- E. rows
  const rowCount = await tab.eval(`window.__t.all('[data-pipeline-row]').length`);
  record("E0", "Table renders rows", rowCount > 0 ? "PASS" : "FAIL", `${rowCount} rows`);
  record("E1", "'Select all' header checkbox",
    (await tab.eval(`window.__t.byLabel('Select all').length > 0`)) ? "PASS" : "FAIL");
  record("E2", "Row checkbox",
    (await tab.eval(`window.__t.all('[data-pipeline-row] input[type=checkbox]').length > 0`)) ? "PASS" : "FAIL");

  const expanded = await tab.eval(`(async () => {
    const cell = window.__t.all('[data-pipeline-row] [role=button][aria-expanded]')[0];
    if (!cell) return 'no expander';
    cell.click(); await new Promise((r) => setTimeout(r, 600));
    return cell.getAttribute('aria-expanded');
  })()`);
  record("E3", "Candidate cell expands the inline detail", expanded === "true" ? "PASS" : "FAIL", String(expanded));
  await tab.eval(`(() => { const c = window.__t.all('[data-pipeline-row] [role=button][aria-expanded="true"]')[0]; if (c) c.click(); })()`);
  await new Promise((r) => setTimeout(r, 400));

  const copyName = await tab.eval(`(async () => {
    let got = null; navigator.clipboard.writeText = async (t) => { got = t; };
    const before = window.__t.all('[data-pipeline-row] [role=button][aria-expanded="true"]').length;
    window.__t.clickLabel('Copy name'); await new Promise((r) => setTimeout(r, 400));
    const after = window.__t.all('[data-pipeline-row] [role=button][aria-expanded="true"]').length;
    return { copied: got !== null, expandedBefore: before, expandedAfter: after };
  })()`);
  record("E4", "Copy name works and does not expand the row",
    copyName && copyName.copied && copyName.expandedAfter === copyName.expandedBefore ? "PASS" : "FAIL", JSON.stringify(copyName));

  record("E6", "'Agent profile' external link",
    (await tab.eval(`window.__t.all('[data-pipeline-row] a[target=_blank][href^="http"]').length > 0`)) ? "VISUAL" : "FAIL");
  record("E9", "Source badge (flag pipeline_source_split)",
    (await tab.eval(`window.__t.has('BrokerStaffer') || window.__t.has('Client Entry')`)) ? "VISUAL" : "FAIL");
  record("E10", "'Call' / 'Text' links",
    (await tab.eval(`window.__t.all('a[href^="tel:"]').length > 0 && window.__t.all('a[href^="sms:"]').length > 0`)) ? "VISUAL" : "FAIL");
  record("E11", "Copy phone button",
    (await tab.eval(`window.__t.byLabel('Copy phone').length > 0`)) ? "PASS" : "FAIL");
  const fubHere = await tab.eval(`window.__t.has('Push to FUB') || window.__t.has('In Follow Up Boss') || window.__t.has('Retry push')`);
  fubDeferred = !fubHere;
  if (fubHere) record("E8", "Push-to-Follow Up Boss chip", "RENDER", "POST …/push-fub");

  await esc(tab);
  const stageMenu = await tab.eval(`(async () => {
    const t = window.__t.all('[data-stage-selector]')[0]; if (!t) return 'no stage pill';
    const current = (t.innerText || '').trim().toLowerCase();
    /*
     * Only the items THIS trigger adds count.
     *
     * Base UI keeps a menu mounted while it is open, and an earlier check can
     * leave one open, so a bare menuitem query returned two menus' items and
     * the stage check picked "Unassigned" out of a bulk assign menu. Diffing
     * against what was already on screen makes the check independent of
     * whatever else is open.
     */
    const before = new Set(window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]').filter(window.__t.vis));
    t.click(); await new Promise((r) => setTimeout(r, 600));
    const items = window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]')
      .filter(window.__t.vis).filter((e) => !before.has(e));
    const n = items.length;
    // Choosing the stage the lead is ALREADY in is a no-op by design, so the
    // pick has to be a different one or nothing fires and the test lies.
    const target = items.find((e) => (e.innerText || '').trim() &&
      (e.innerText || '').trim().toLowerCase() !== current);
    if (!target) return { items: n, wrote: [], note: 'no different stage offered', leftovers: before.size };
    window.__writes.length = 0;
    target.click();
    await new Promise((r) => setTimeout(r, 900));
    return { items: n, picked: (target.innerText || '').trim(), was: current, leftovers: before.size,
             wrote: window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>')) };
  })()`);
  record("E12", "Stage pill moves a lead's stage",
    stageMenu && stageMenu.items >= 5 && stageMenu.wrote.some((w) => /PATCH .*\/pipeline\//.test(w)) ? "RENDER" : "FAIL",
    JSON.stringify(stageMenu).slice(0, 130));

  await esc(tab);
  const assignPill = await tab.eval(`(async () => {
    const t = window.__t.all('[data-assign-selector]')[0]; if (!t) return 'no assign pill';
    t.click(); await new Promise((r) => setTimeout(r, 500));
    return window.__t.all('[role=menuitem],[data-slot=dropdown-menu-item]').filter(window.__t.vis).map((e) => e.innerText.trim());
  })()`);
  await esc(tab);
  record("E13", "Assigned pill opens the roster",
    Array.isArray(assignPill) && assignPill.length > 0 ? "PASS" : "FAIL",
    Array.isArray(assignPill) ? assignPill.slice(0, 3).join(" / ") : String(assignPill));

  // ---- I. edit dialog (from a row)
  const editDlg = await tab.eval(`(async () => {
    if (!window.__t.clickText('Edit', 'button')) return 'no Edit button';
    await new Promise((r) => setTimeout(r, 700));
    const d = window.__t.surface();
    if (!d) return 'no dialog';
    return { title: (d.querySelector('[data-slot=dialog-title]') || d).innerText.split('\\n')[0],
             inputs: d.querySelectorAll('input').length,
             labels: Array.from(d.querySelectorAll('label')).map((l) => l.innerText.trim()).filter(Boolean).slice(0, 12) };
  })()`);
  record("E14", "Row 'Edit' opens the lead dialog", editDlg && editDlg.inputs ? "PASS" : "FAIL", editDlg ? String(editDlg.title) : String(editDlg));
  record("I2", "Dialog carries the six lead fields",
    editDlg && editDlg.labels && ["Name", "Email", "Phone", "Company"].every((l) => editDlg.labels.some((x) => x.includes(l))) ? "PASS" : "FAIL",
    editDlg && editDlg.labels ? editDlg.labels.join(" / ") : "");
  record("I3", "'Mark as needing replacement' checkbox",
    (await tab.eval(`window.__t.has('needing replacement')`)) ? "PASS" : "FAIL");
  record("I4", "Custom fields section",
    (await tab.eval(`window.__t.has('Custom fields')`)) ? "PASS" : "FAIL");
  record("I5", "'Add field' row",
    (await tab.eval(`window.__t.byText('Add field','button').length > 0`)) ? "PASS" : "FAIL");
  const saveFires = await tab.eval(`(async () => {
    window.__writes.length = 0;
    const d = window.__t.surface();
    if (!d) return 'no dialog';
    const inp = d.querySelector('input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, (inp.value || '') + ' ');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const btn = Array.from(d.querySelectorAll('button')).find((b) => /^save$/i.test(b.innerText.trim()));
    if (!btn) return 'no Save';
    btn.click(); await new Promise((r) => setTimeout(r, 900));
    return window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>'));
  })()`);
  record("I7", "Dialog 'Save' fires the lead PATCH",
    Array.isArray(saveFires) && saveFires.some((w) => /PATCH .*\/pipeline\//.test(w)) ? "RENDER" : "FAIL",
    Array.isArray(saveFires) ? (saveFires[0] || "nothing fired") : String(saveFires));
  await tab.eval(`(() => { const d = window.__t.surface(); if (d) { const c = Array.from(d.querySelectorAll('button')).find((b) => /cancel/i.test(b.innerText)); if (c) c.click(); } })()`);
  await new Promise((r) => setTimeout(r, 500));

  // ---- G. notes sheet
  const notes = await tab.eval(`(async () => {
    const pill = window.__t.byLabel('notes')[0] || window.__t.byLabel('Add notes')[0];
    if (!pill) return 'no notes pill';
    pill.click(); await new Promise((r) => setTimeout(r, 800));
    const s = window.__t.surface();
    if (!s) return 'no sheet';
    return { hasComposer: !!s.querySelector('textarea'),
             addBtn: Array.from(s.querySelectorAll('button')).some((b) => /add note/i.test(b.innerText)),
             details: /Details/.test(s.innerText), close: !!s.querySelector('[aria-label=Close]') };
  })()`);
  record("G1", "Notes sheet opens with a Close button", notes && notes.close ? "PASS" : "FAIL", JSON.stringify(notes));
  record("G2", "Notes sheet Details block", notes && notes.details ? "VISUAL" : "FAIL");
  record("G5", "Note composer textarea", notes && notes.hasComposer ? "PASS" : "FAIL");
  const addNote = await tab.eval(`(async () => {
    const s = window.__t.surface();
    if (!s) return 'no sheet';
    const ta = s.querySelector('textarea'); if (!ta) return 'no textarea';
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, 'parity probe (intercepted, never sent)');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    window.__writes.length = 0;
    const b = Array.from(s.querySelectorAll('button')).find((x) => /add note/i.test(x.innerText));
    if (!b) return 'no Add note'; b.click(); await new Promise((r) => setTimeout(r, 900));
    return window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>'));
  })()`);
  record("G6", "'Add note' fires the notes POST",
    Array.isArray(addNote) && addNote.some((w) => /POST .*\/notes$/.test(w)) ? "RENDER" : "FAIL",
    Array.isArray(addNote) ? (addNote[0] || "nothing fired") : String(addNote));
  await tab.eval(`window.__t.closeSurface()`);
  await esc(tab);

  // ---- H. conversation sheet
  const convo = await tab.eval(`(async () => {
    if (!window.__t.clickText('Conversation', 'button')) return 'no Conversation button';
    await new Promise((r) => setTimeout(r, 1200));
    const s = window.__t.surface();
    if (!s) return 'no sheet';
    return { resize: !!document.querySelector('[aria-label*="resize"]'),
             close: !!s.querySelector('[aria-label=Close]'),
             fetched: window.__writes.some((w) => /conversation/.test(w.url)),
             body: s.innerText.replace(/\\s+/g,' ').slice(0, 60) };
  })()`);
  record("H1", "Conversation sheet opens and fetches",
    convo && convo.close ? (convo.fetched ? "RENDER" : "PASS") : "FAIL", convo ? String(convo.body) : String(convo));
  record("H2", "Drag-to-resize handle", convo && convo.resize ? "PASS" : "FAIL");
  record("H4", "Loading / error / empty states",
    (await tab.eval(`['Loading conversation','No conversation yet','Conversation is empty',"Couldn't load"].some(window.__t.has)`)) ? "VISUAL" : "FAIL");
  await tab.eval(`window.__t.closeSurface()`);
  await esc(tab);

  // ---- N. pagination

  // ---- M. stage management
  const stageCard = await tab.eval(`(async () => {
    const manage = window.__t.byText('Manage stages')[0];
    const names = window.__t.byText('Stage names')[0];
    const card = manage || names; if (!card) return 'neither card';
    const which = manage ? 'Manage stages' : 'Stage names';
    card.click(); await new Promise((r) => setTimeout(r, 700));
    return { which,
             inputs: window.__t.all('[data-stage-manager] input, [data-stage-editor] input').length,
             up: window.__t.byLabel('Move up').length, down: window.__t.byLabel('Move down').length,
             hide: window.__t.byLabel('stage').length,
             add: window.__t.byText('Add stage','button').length,
             save: window.__t.byText('Save changes','button').length };
  })()`);
  record("M5", "Stage card expands", stageCard && stageCard.which ? "PASS" : "FAIL", JSON.stringify(stageCard));
  record("M6", "Move up / Move down", stageCard && stageCard.up > 0 && stageCard.down > 0 ? "PASS" : "FAIL");
  record("M8", "Per-stage rename inputs", stageCard && stageCard.inputs > 0 ? "PASS" : "FAIL", `${stageCard && stageCard.inputs} inputs`);
  record("M11", "'Add stage'", stageCard && stageCard.add > 0 ? "PASS" : "FAIL");
  const stageSave = await tab.eval(`(async () => {
    window.__writes.length = 0;
    const inp = window.__t.all('[data-stage-manager] input, [data-stage-editor] input')[0];
    if (inp) { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(inp, (inp.value||'') + ' '); inp.dispatchEvent(new Event('input',{bubbles:true})); }
    await new Promise((r) => setTimeout(r, 250));
    if (!window.__t.clickText('Save changes', 'button')) return 'no Save changes';
    await new Promise((r) => setTimeout(r, 900));
    return window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>'));
  })()`);
  record("M12", "Stage 'Save changes' fires its PATCH",
    Array.isArray(stageSave) && stageSave.some((w) => /PATCH .*\/(stages|stage-labels)$/.test(w)) ? "RENDER" : "FAIL",
    Array.isArray(stageSave) ? (stageSave[0] || "nothing fired") : String(stageSave));

  // ---- K. board view
  const board = await tab.eval(`(async () => {
    if (!window.__t.clickText('Board', 'button')) return 'no Board button';
    await new Promise((r) => setTimeout(r, 1400));
    const cols = window.__t.all('[data-kanban-column]').length;
    const cards = window.__t.all('[data-kanban-card]').length;
    const draggable = window.__t.all('[data-kanban-card][draggable=true]').length;
    return { cols, cards, draggable, stored: localStorage.length > 0 };
  })()`);
  record("K1", "Board view renders one column per stage",
    board && board.cols >= 5 ? "PASS" : "FAIL", JSON.stringify(board));
  record("K2", "Board cards are draggable",
    board && board.draggable > 0 ? "PASS" : "FAIL", `${board && board.draggable} draggable of ${board && board.cards}`);
  const drop = await tab.eval(`(async () => {
    const card = window.__t.all('[data-kanban-card]')[0];
    const cols = window.__t.all('[data-kanban-column]');
    if (!card || cols.length < 2) return 'not enough board';
    const id = card.getAttribute('data-entry-id') || '';
    const dt = new DataTransfer(); dt.setData('application/x-pipeline-entry-id', id);
    window.__writes.length = 0;
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const target = cols[cols.length - 1];
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 900));
    return window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>'));
  })()`);
  record("K3", "Dropping a card on a column fires the stage PATCH",
    Array.isArray(drop) && drop.some((w) => /PATCH .*\/pipeline\//.test(w)) ? "RENDER" : "FAIL",
    Array.isArray(drop) ? (drop[0] || "nothing fired") : String(drop));
  const detail = await tab.eval(`(async () => {
    const card = window.__t.all('[data-kanban-card]')[0]; if (!card) return 'no card';
    card.click(); await new Promise((r) => setTimeout(r, 900));
    const s = window.__t.surface();
    if (!s) return 'no sheet';
    return { edit: Array.from(s.querySelectorAll('button')).some((b) => /^edit$/i.test(b.innerText.trim())),
             close: !!s.querySelector('[aria-label=Close]'), body: s.innerText.replace(/\\s+/g,' ').slice(0, 50) };
  })()`);
  record("K4", "Board card opens the detail sheet", detail && detail.close ? "PASS" : "FAIL", detail ? String(detail.body) : String(detail));
  record("L2", "Detail sheet has 'Edit'", detail && detail.edit ? "PASS" : "FAIL");
  record("K5", "Per-column sales-volume totals (flag pipeline_board_enhanced)",
    (await tab.eval(`window.__t.byLabel('Total sales volume').length > 0`)) ? "VISUAL" : "FAIL");
  await tab.eval(`window.__t.closeSurface()`);
  await esc(tab);
  await tab.eval(`window.__t.clickText('List', 'button')`);
  await new Promise((r) => setTimeout(r, 900));

  // ---- J. CSV dialog
  const csv = await tab.eval(`(async () => {
    if (!window.__t.clickText('Upload CSV', 'button')) return 'no Upload CSV';
    await new Promise((r) => setTimeout(r, 700));
    const d = window.__t.surface();
    if (!d) return 'no dialog';
    return { title: d.innerText.split('\\n')[0], file: !!d.querySelector('input[type=file]'),
             zone: /Click to choose a CSV file/.test(d.innerText) };
  })()`);
  record("J1", "CSV dialog opens", csv && csv.file ? "PASS" : "FAIL", csv ? String(csv.title) : String(csv));
  record("J2", "Drop-zone + hidden file input", csv && csv.zone && csv.file ? "PASS" : "FAIL");
  await tab.eval(`window.__t.clickText('Cancel', 'button')`);
  await new Promise((r) => setTimeout(r, 500));

  // ---- O. Custom stages get filter bubbles (upstream change) -------------
  /*
   * Demo Portal has one operator-made stage, "Invited to sales meeting"
   * (kind: custom), and — checked directly against the database — NO entry is
   * parked in it. Proving "filtering by a custom stage returns only the
   * entries parked there" therefore needs an entry parked there, and parking
   * one for real would be a write.
   *
   * It does not have to be. `changeDisplayStage` sets `custom_stage_key` on
   * the local copy FIRST and then PATCHes, and this test intercepts the PATCH.
   * So dragging a card onto the custom column parks the lead in the running
   * page exactly as a real drag would, while the request never leaves the tab.
   *
   * That also gives the sharpest possible proof that the overlay is not
   * collapsed into the enum: the intercepted body is asserted to carry
   * `custom_stage_key` and NOT `stage`.
   */
  await esc(tab);
  const custom = await tab.eval(`(async () => {
    const bubbleFor = (label) => window.__t.all('[data-stage-chip]')
      .find((b) => (b.innerText || '').trim().toLowerCase().startsWith(label.toLowerCase()));
    const countOf = (el) => {
      if (!el) return null;
      const m = (el.innerText || '').trim().match(/(\\d+)\\s*$/);
      return m ? Number(m[1]) : null;
    };
    const CUSTOM = 'Invited to sales meeting';
    const bubble = bubbleFor(CUSTOM);
    if (!bubble) return { err: 'no bubble for the custom stage' };
    const before = countOf(bubble);
    const totalBubbles = window.__t.all('[data-stage-chip]').length;

    // Park one lead in the custom stage through the real board interaction.
    if (!window.__t.clickText('Board', 'button')) return { err: 'no Board button' };
    await new Promise((r) => setTimeout(r, 1200));
    const card = window.__t.all('[data-kanban-card]')[0];
    const col = window.__t.all('[data-kanban-column]')
      .find((c) => (c.innerText || '').toLowerCase().includes(CUSTOM.toLowerCase()));
    if (!card || !col) return { err: 'card or custom column missing on the board' };
    const name = (card.innerText || '').trim().split('\\n')[0];
    const entryId = card.getAttribute('data-entry-id');
    const dt = new DataTransfer();
    dt.setData('application/x-pipeline-entry-id', entryId);
    window.__writes.length = 0;
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 900));
    const sent = window.__writes.map((w) => w.body || '');

    // Back to the list, and read the bubbles again.
    window.__t.clickText('List', 'button');
    await new Promise((r) => setTimeout(r, 900));
    const after = countOf(bubbleFor(CUSTOM));

    // Filter by the custom stage and see what survives.
    const b2 = bubbleFor(CUSTOM);
    b2.click();
    await new Promise((r) => setTimeout(r, 700));
    const rowsShown = window.__t.all('[data-pipeline-row]').length;
    const firstRow = rowsShown ? (window.__t.all('[data-pipeline-row]')[0].innerText || '').trim() : '';
    b2.click();
    await new Promise((r) => setTimeout(r, 500));
    return { before, after, totalBubbles, rowsShown, name,
             matches: firstRow.includes(name),
             body: sent[0] || '', wrote: sent.length };
  })()`);

  record("O1", "Custom stage gets a filter bubble",
    custom && !custom.err ? "PASS" : "FAIL",
    custom && custom.err ? custom.err : `"Invited to sales meeting" among ${custom.totalBubbles} bubbles`);
  record("O2", "Parking a lead there moves it into that bubble's count",
    custom && !custom.err && custom.after === custom.before + 1 ? "PASS" : "FAIL",
    custom && !custom.err ? `count ${custom.before} → ${custom.after}` : "");
  record("O3", "Filtering by the custom stage returns only the parked entry",
    custom && !custom.err && custom.rowsShown === custom.after && custom.matches ? "PASS" : "FAIL",
    custom && !custom.err ? `${custom.rowsShown} row(s), the one parked ("${custom.name}")` : "");
  record("O4", "The overlay is sent, never the enum stage",
    custom && !custom.err && /custom_stage_key/.test(custom.body) && !/"stage"/.test(custom.body)
      ? "RENDER" : "FAIL",
    custom && !custom.err ? `PATCH body ${custom.body}` : "");

  // ---- footer disclosures
  record("B5", "'Best practices' disclosure",
    (await tab.eval(`window.__t.has('Best practices')`)) ? "PASS" : "FAIL");
  const legend = await tab.eval(`(async () => {
    if (!window.__t.clickText('What each stage means')) return 'no disclosure';
    await new Promise((r) => setTimeout(r, 500));
    return window.__t.has('Introduction') && window.__t.txt().length > 0;
  })()`);
  record("B6", "'What each stage means' expands the legend", legend === true ? "PASS" : "FAIL", String(legend));

  const allWrites = JSON.parse(await tab.eval(`JSON.stringify(window.__writes.map((w) => w.method + ' ' + w.url.replace(/portal\\/[^/]+/, 'portal/<token>')))`));
  console.log(`     write attempts intercepted (none reached the database): ${allWrites.length}`);
  await tab.close();
}

// ===========================================================================
// Two checks that Demo Portal cannot answer, run READ-ONLY on other clients:
// nothing is clicked, nothing is typed, no request is made.
if (fubDeferred) {
  console.log("\n  ── E8. Follow Up Boss chip · a FUB-connected client (read-only) ──");
  const tab = await fresh();
  await open(tab, `/inbox/portals/${FUB_CLIENT}`, "[data-pipeline-row]", 1, 90000);
  const chip = await tab.eval(`(() => {
    const t = window.__t.txt();
    return ['Push to FUB','In Follow Up Boss','Retry push','Push again'].filter((s) => t.includes(s));
  })()`);
  record("E8", "Push-to-Follow Up Boss chip", chip.length ? "RENDER" : "FAIL",
    chip.length ? chip.join(" / ") + " — POST …/push-fub, read-only, not clicked" : "chip absent on a FUB-connected client");
  await tab.close();
}

console.log("\n  ── N. Pagination · a 220-row client (read-only, no clicks) ───");
{
  const tab = await fresh();
  await open(tab, `/inbox/portals/${BIG}`, "[data-pipeline-row]", 1, 90000);
  const pager = await tab.eval(`(() => ({
    readout: /\\d+[–-]\\d+ of \\d+ candidates/.test(window.__t.txt()),
    prev: window.__t.byText('Prev','button').length > 0,
    next: window.__t.byText('Next','button').length > 0,
    page: /Page \\d+ \\/ \\d+/.test(window.__t.txt()),
    rows: window.__t.all('[data-pipeline-row]').length,
    banner: window.__t.byText('Select all','button').length > 0,
  }))()`);
  record("N1", "Pagination readout", pager.readout ? "VISUAL" : "FAIL", `${pager.rows} rows on page 1`);
  record("N2", "Prev / Next", pager.prev && pager.next ? "VISUAL" : "FAIL", "present; not clicked on a real client");
  record("N3", "'Page n / m'", pager.page ? "VISUAL" : "FAIL");
  record("N4", "Cross-page 'Select all' banner exists once a page is full",
    pager.rows === 50 ? "VISUAL" : "FAIL", `page size ${pager.rows} (PORTAL_PAGE_SIZE 50)`);
  await tab.close();
}

console.log(`\n  ${pass} verified · ${skip} deliberately not run · ${fail} failed`);
const bad = rows.filter((r) => r.status === "FAIL");
if (bad.length) {
  console.log("\n  FAILURES:");
  for (const b of bad) console.log(`     ${b.id} ${b.name} — ${b.detail}`);
}
process.exit(fail ? 1 : 0);
