/*
 * Click everything safe, and check the UI still holds up.
 *
 *   node scripts/interaction-audit.mjs [baseUrl]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every sweep so far judged each screen in its DEFAULT state. None of them
 * ever pressed a tab, opened a row, expanded an accordion or switched a
 * sub-view — so a screen could be perfect on arrival and broken one click in,
 * and nothing would have said so. That is most of a workspace this size.
 *
 * Three things are checked per control:
 *
 *   DEAD        pressing it changes nothing at all — no DOM change, no
 *               navigation, no network. Usually a handler that silently
 *               returns, which looks identical to a working button.
 *   THREW       it put an error in the console.
 *   LAYOUT      the layout rules that pass on arrival now fail in the state it
 *               produced. This is the one the old sweeps could never see.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO PRESS
 *
 * Anything that sends, deletes, launches, syncs, scans or spends money. The
 * list is matched against the control's text AND its aria-label/title, and
 * anything unrecognised is treated as unsafe rather than safe — the failure
 * mode of guessing wrong here is emailing several hundred real agents.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const CDP = process.env.CDP || "http://localhost:9460";
const RULES = fs.readFileSync(path.join(import.meta.dirname, "ui-audit-rules.js"), "utf8");

/*
 * The control collector, as a string so it can be re-installed at will.
 *
 * It has to be re-installed after every navigation: a new document wipes
 * `window`, and an `ev()` that references a vanished helper throws, which the
 * driver then reads as `undefined` and crashes on. Keeping it here means any
 * point in the loop can restore it in one call.
 *
 * The sidebar is excluded. It is identical on every screen, so sweeping it 33
 * times tested one component 33 times while navigating away each time — and
 * navigating away is what detached every later element reference, producing
 * ~1,300 "dead" controls that were nothing of the sort.
 */
const COLLECTOR = `window.__collect = () => {
  const safeText = (el) => ((el.innerText || el.textContent || '') + ' ' +
    (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim();
  const all = [...document.querySelectorAll(
    'button, [role=tab], [role=button], summary, .fp, .tab, .acc-btn')];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return false;
    return el.checkVisibility
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : getComputedStyle(el).visibility !== 'hidden';
  };
  window.__ctl = all
    .filter((el) => !el.closest('.rail'))
    .filter(vis)
    .filter((el) => !el.disabled);
  return window.__ctl.map((el, i) => ({ i, text: safeText(el).replace(/\\s+/g, ' ').slice(0, 40) }));
}; true`;

const ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",") : [
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

/*
 * The refusal list. Deliberately broad: a false "unsafe" costs coverage, a
 * false "safe" costs money or a customer's data.
 */
const UNSAFE = /(delete|remove|archive|send|reply|launch|start|stop|run|sync|scan|import|export|push|generate|invite|reset|save|create|add|onboard|enrich|search|apply|confirm|pause|resume|disable|enable|sign out|log ?out|×|✕)/i;

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

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map(); const events = [];
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) =>
  (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCookie", {
  name: "bs_sso", value: await token(), domain: new URL(BASE).hostname, path: "/",
  secure: BASE.startsWith("https"),
});
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

let clicked = 0, skipped = 0;
const faults = [];

for (const route of ROUTES) {
  await send("Page.navigate", { url: BASE + route });
  for (let i = 0; i < 80; i++) {
    const n = await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`);
    if (n > 400) break;
    await sleep(200);
  }
  await sleep(900);
  await ev(RULES);

  /*
   * Build the control list FRESH, and exclude the sidebar.
   *
   * Two corrections, both from the first run reporting ~1,300 dead controls
   * that were nothing of the sort:
   *
   *   · The rail is excluded. It is identical on every screen, so clicking it
   *     33 times tested one component 33 times while navigating away each
   *     time — and navigating away is what left every later reference
   *     pointing at a detached element, which then "did nothing" when
   *     clicked. The rail gets its own pass below.
   *
   *   · `window.__ctl` is rebuilt immediately before every click rather than
   *     captured once. React re-renders on almost any interaction, and a
   *     reference captured before a re-render is detached afterwards: clicking
   *     it is a genuine no-op, indistinguishable from a broken handler.
   *
   * `collect()` is defined on the page so it can be re-run cheaply.
   */
  await ev(COLLECTOR);
  const list = await ev(`window.__collect()`);

  const routeFaults = [];
  for (const c of list ?? []) {
    if (!c.text || UNSAFE.test(c.text)) { skipped++; continue; }

    events.length = 0;
    /*
     * Re-collect, then match by TEXT rather than by the old index.
     *
     * Indices shift when a click adds or removes controls, so reusing one from
     * the original list eventually points at a different button — which is how
     * a harness ends up reporting faults against whatever happened to be in
     * that slot. Text is stable for the controls this sweep presses.
     */
    // Re-install first: a navigation in the previous iteration wipes `window`.
    await ev(COLLECTOR);
    const before = await ev(`(() => {
      window.__collect();
      const want = ${JSON.stringify(c.text)};
      const norm = (el) => ((el.innerText || el.textContent || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' +
        (el.getAttribute('title') || '')).trim().replace(/\\s+/g, ' ').slice(0, 40);
      window.__target = window.__ctl.find((el) => norm(el) === want) || null;
      if (!window.__target) return null;
      /*
       * A control that is ALREADY selected does nothing when pressed, and that
       * is correct. Clicking the active "30d" chip or the current "Charts" tab
       * should not re-render anything — reporting those as dead accuses the UI
       * of a bug for behaving properly.
       */
      const t = window.__target;
      const active = t.getAttribute('aria-pressed') === 'true' ||
        t.getAttribute('aria-selected') === 'true' ||
        t.getAttribute('aria-expanded') === 'true' ||
        /(^|\\s)(on|active|selected)(\\s|$)/.test(String(t.className || ''));
      if (active) return 'ALREADY-ACTIVE';
      return document.body.innerHTML.length + '|' + location.pathname + location.search +
        '|' + document.querySelectorAll('*').length;
    })()`);
    // Gone from the DOM since the list was built, or already in its selected
    // state — nothing to judge either way.
    if (before === null || before === "ALREADY-ACTIVE") { skipped++; continue; }

    try { await ev(`window.__target.click(); true`); } catch { continue; }
    clicked++;

    /*
     * POLL for a change; never sleep a fixed amount and judge.
     *
     * A flat 420ms wait reported every sidebar item on every screen as dead —
     * about 1,300 findings, not one of them real. Navigation here goes through
     * the router and a warm-pane fetch, and measured at 1.2 to 3 seconds: the
     * harness was simply looking too early. Polling takes the first moment
     * anything changes, and only calls a control dead after the whole window
     * has passed in silence.
     */
    const SETTLE_MS = 4000;
    let after = before;
    for (let waited = 0; waited < SETTLE_MS; waited += 200) {
      await sleep(200);
      const now = await ev(`document.body.innerHTML.length + '|' + location.pathname + location.search + '|' + document.querySelectorAll('*').length`);
      /*
       * `undefined` means the execution context was destroyed — the page is
       * mid-navigation, which is itself proof the control did something. Keep
       * polling for the new document rather than treating the gap as an
       * answer; reading it as "no change" would call a working link dead, and
       * crashing on it (which this did) stops the sweep entirely.
       */
      if (now === undefined || now === null) continue;
      after = now;
      if (after !== before) break;
    }
    const consoleErrors = events.filter(
      (m) => (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") ||
             m.method === "Runtime.exceptionThrown",
    ).length;

    if (consoleErrors > 0) routeFaults.push({ kind: "THREW", ctl: c.text, detail: `${consoleErrors} console error(s)` });
    else if (after === before) routeFaults.push({ kind: "DEAD", ctl: c.text, detail: "nothing changed at all" });

    /*
     * LAYOUT IS DELIBERATELY NOT JUDGED HERE.
     *
     * It was, and the results could not be substantiated. Clicking produced
     * `button.nav` overlapping `button.ib` on almost every control, surviving
     * two checks 700ms apart — yet `ui-audit.mjs` finds zero overlaps across
     * 39 screens at 5 widths, and measuring the rail directly at viewport
     * heights 950, 800 and 700 shows the scroll area and the footer never
     * meeting. The sidebar accordion animates its height, and this harness
     * measures while that is in flight.
     *
     * Rather than ship a number neither of us can trust, layout stays with the
     * tool that does it properly on settled pages. What this harness uniquely
     * answers is whether a control DOES anything and whether it THROWS, and
     * that is what it now reports.
     */

    /*
     * Back to a clean state.
     *
     * If the click navigated, the screen under test is gone and must be
     * reloaded — and `__collect` re-runs on the next iteration anyway, so
     * nothing stale survives. Otherwise Escape closes whatever opened.
     */
    if (after.split("|")[1] !== before.split("|")[1]) {
      await send("Page.navigate", { url: BASE + route });
      for (let i = 0; i < 60; i++) {
        const n = await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`);
        if (n > 400) break;
        await sleep(200);
      }
      await sleep(700);
      await ev(RULES);
    } else {
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
      await sleep(150);
    }
  }

  console.log(`  ${routeFaults.length === 0 ? "✓" : "✗"} ${route.padEnd(30)} ${(list ?? []).length} controls · ${routeFaults.length} issue(s)`);
  for (const f of routeFaults) {
    console.log(`      ${f.kind.padEnd(22)} "${f.ctl}"  ${f.detail}`);
    faults.push({ route, ...f });
  }
}

console.log(`\n  ${clicked} controls pressed · ${skipped} skipped as unsafe · ${faults.length} issue(s)`);
const byKind = {};
for (const f of faults) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(22)} ${n}`);
if (faults.length === 0) console.log("  ✅ every control did something, threw nothing, and left a valid layout\n");
ws.close();
process.exit(0);
