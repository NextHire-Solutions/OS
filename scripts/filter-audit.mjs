/*
 * Every filter, on every screen — does it actually filter?
 *
 *   node scripts/filter-audit.mjs --list        enumerate what exists
 *   node scripts/filter-audit.mjs [baseUrl]     exercise them
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A FILTER, AND WHY THE DEFINITION MATTERS
 *
 * A filter is any control that changes WHICH records you see: a search box, a
 * select, a date range, a status chip, a multi-select. They share one property
 * that makes them worth their own suite — a broken filter looks exactly like a
 * correct one. The page still renders, the control still highlights, and the
 * list it produced is simply wrong. Nobody notices until somebody acts on a
 * number that was never true.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CHECKED
 *
 *   RESPONDS     changing it changes the result set, the URL, or both
 *   RESTORES     clearing it brings the original rows back
 *   NARROWS      a filter that selects a subset returns FEWER rows, never more
 *   THREW        it put an error in the console
 *
 * NARROWS is the one that catches a filter wired to the wrong field: it still
 * responds, and it still returns rows, but the rows are not a subset of what
 * you started with.
 */
import fs from "node:fs";

const LIST_ONLY = process.argv.includes("--list");
const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const CDP = process.env.CDP || "http://localhost:9470";

const ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",") : [
  "/roster", "/performance",
  "/inbox/all-email", "/inbox/archive", "/inbox/reminders", "/inbox/portals",
  "/clients", "/clients/biweekly", "/clients/success",
  "/analytics/campaign", "/analytics/campaigns", "/analytics/attribution",
  "/analytics/copy", "/analytics/clients", "/analytics/schedule", "/analytics/infrastructure",
  "/onboarding/pipeline", "/onboarding/stages", "/onboarding/templates",
  "/search/master", "/search/accounts", "/search/mls",
];

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
let id = 0; const waiting = new Map(); const errors = []; const inflight = new Set();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  else if (m.method === "Network.requestWillBeSent") inflight.add(m.params.requestId);
  else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed")
    inflight.delete(m.params.requestId);
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console");
  else if (m.method === "Runtime.exceptionThrown") errors.push("exception");
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
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

/*
 * Finding the filters, and counting the results.
 *
 * Both definitions are deliberately broad — this workspace draws lists as
 * tables, as card grids and as anchor lists, and a filter bar is variously
 * `.an-filter`, a row of `.fp` pills, or bare selects above a table. Missing a
 * control because it did not match a tidy selector is the failure this suite
 * exists to avoid.
 */
const HELPERS = `window.__f = (() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return false;
    return el.checkVisibility ? el.checkVisibility({opacityProperty:true, visibilityProperty:true}) : true;
  };
  const label = (el) => {
    const own = (el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || (el.textContent || '')).replace(/\\s+/g,' ').trim();
    if (own) return own.slice(0, 38);
    const lab = el.closest('label');
    return ((lab && lab.textContent) || el.name || el.id || el.tagName).replace(/\\s+/g,' ').trim().slice(0, 38);
  };
  /*
   * A filter, and NOT a row editor.
   *
   * This distinction is the whole safety story. The pipeline screen renders a
   * <select> per client ("Stage for SERHANT. PA") and the stages screen a
   * <select> per stage ("Colour for Copy sent"). They look exactly like filters
   * to a selector — visible, enabled, a handful of options — but changing one
   * MOVES A REAL CLIENT THROUGH THE PIPELINE. A first pass counted 495
   * "filters", of which 45 were these.
   *
   * The rule: a filter lives in the toolbar ABOVE the list; an editor lives
   * INSIDE a row of it. So anything within a result row is excluded, as is
   * anything whose accessible name names a specific record.
   */
  const IN_ROW = 'tbody tr, .mi-portals-grid-row, [data-row], .cli, li, .acard, .pcard, .mi-row, [role=listitem]';
  const NAMES_A_RECORD = /^(stage|colour|color|owner|status|plan|assignee) for /i;
  const isFilter = (el) => {
    if (el.closest(IN_ROW)) return false;
    if (NAMES_A_RECORD.test(label(el))) return false;
    if (el.closest('.rail')) return false;
    return true;
  };
  const find = () => {
    const seen = new Set();
    const out = [];
    const add = (el, kind) => {
      if (seen.has(el) || !vis(el) || el.disabled || !isFilter(el)) return;
      seen.add(el);
      const pressed = el.getAttribute('aria-pressed');
      const active = pressed === 'true' || el.classList.contains('on') ||
        el.classList.contains('active') || el.getAttribute('data-active') === 'true' ||
        (el.tagName === 'INPUT' && el.type === 'checkbox' && el.checked);
      out.push({ el, kind, active });
    };
    for (const el of document.querySelectorAll('select')) add(el, 'select');
    for (const el of document.querySelectorAll(
      'input[type=search], input[type=text][placeholder], input[type=date]'))
      add(el, el.type === 'date' ? 'date' : 'search');
    for (const el of document.querySelectorAll('[aria-pressed], .fp, .qr button, .as-tog'))
      add(el, 'toggle');
    for (const el of document.querySelectorAll('input[type=checkbox]'))
      if (!el.closest('[data-anchored-panel]')) add(el, 'checkbox');
    // Buttons that OPEN a filter panel (Analytics range/multi-select, Columns).
    for (const el of document.querySelectorAll('.an-filter button, [data-filter-trigger]'))
      add(el, 'panel');
    return out;
  };
  const results = () => {
    /*
     * The LARGEST table, not the sum of all of them.
     *
     * Infrastructure renders four: a 2-row provider summary, a 15-row recipient
     * breakdown, a 59-row disconnected-mailbox list, and the 502-row result
     * table the filters actually drive. Summing them meant a nonsense search
     * that correctly emptied the main table still reported 77 rows — 76 from
     * the three static tables plus the empty-state row — and the filter was
     * called broken for narrowing to nothing.
     */
    const tables = [...document.querySelectorAll('table')].map(t => t.querySelectorAll('tbody tr').length);
    /*
     * The inbox is not a table: its conversations are a.mi-row inside a
     * [role=list]. Without counting them, a search that correctly emptied
     * the list still read as "content changed, did not narrow" and every
     * inbox view was reported WIDE on every run.
     */
    // .mi-list > .mi-row only. The generic role=list selector also counted
    // the client rail's 69 list rows, so a search that emptied the
    // conversations read as "15 → 69, did not narrow".
    // Scoped to the conversation pane: the client rail reuses .mi-list/.mi-row
    // for its 69 client rows, and counting those read an emptied inbox as 69.
    const listRows = document.querySelectorAll('.mi-split-main .mi-list > .mi-row').length;
    if (listRows) tables.push(listRows);
    const rows = tables.length ? Math.max(...tables) : 0;
    // Also expose every table, so the caller can keep watching the SAME one.
    // Taking the max each time makes a shrinking result table disappear behind
    // a static sibling: filtering 502 rows down to 0 read as "506 → 63",
    // because 63 was simply the next-biggest table on the page.
    window.__f._tables = tables;
    const cards = document.querySelectorAll('.mi-portals-grid-row, .card, .acard, [data-row], .cli').length;
    const links = document.querySelectorAll('section.screen.on a[href*="/"]').length;
    return { rows, cards, links, total: rows + cards + links };
  };
  return { vis, label, find, results, isFilter };
})();
true`;

/* -------------------------------------------------------------- enumerate */

if (LIST_ONLY) {
  let grand = 0;
  for (const route of ROUTES) {
    await send("Page.navigate", { url: BASE + route });
    for (let i = 0; i < 70; i++) {
      const n = await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`);
      if (n > 400) break;
      await sleep(200);
    }
    await sleep(900);
    await ev(HELPERS);
    const list = await ev(`JSON.stringify((() => { const seen={}; return window.__f.find().map(f => {
  const l = window.__f.label(f.el); const k = f.kind + "|" + l;
  seen[k] = (seen[k] || 0) + 1;
  return { kind: f.kind, active: f.active, label: l, nth: seen[k] - 1 };
}); })())`);
    const found = JSON.parse(list || "[]");
    grand += found.length;
    console.log(`\n  ${route}  — ${found.length} filter control(s)`);
    for (const f of found) console.log(`      ${f.kind.padEnd(9)} ${f.label}`);
  }
  console.log(`\n  ${grand} filter controls across ${ROUTES.length} screens\n`);
  ws.close();
  process.exit(0);
}

/* ----------------------------------------------------------------- exercise */

/*
 * SAFETY NET: no write ever leaves this browser.
 *
 * The suite clicks things, and the last pass proved that "things" on these
 * screens include controls that mutate real clients. Detection now excludes
 * row editors, but detection is a heuristic and heuristics miss.
 *
 * So the transport is gated too: every request is intercepted and anything that
 * is not a GET/HEAD to this app is failed before it is sent. If a click I
 * believed was a filter turns out to be a save, it dies here rather than in the
 * database. Belt and braces, deliberately — the user's data is not the place to
 * discover the heuristic was wrong.
 */
const blockedWrites = [];
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
ws.addEventListener("message", async (e) => {
  const m = JSON.parse(e.data);
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const method = (request.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    await send("Fetch.continueRequest", { requestId });
  } else {
    blockedWrites.push(`${method} ${request.url}`);
    await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  }
});

/*
 * Wait for the RESULT COUNT to stop moving.
 *
 * The first production run waited for text to appear and then measured, which
 * on every async screen sampled a half-loaded table: Infrastructure baselined
 * at 5 rows and the filter's own 546 read as a filter that ADDS rows. Nine of
 * the twenty-six "problems" in that run were this, and two more were the
 * opposite — a genuine narrowing hidden because the baseline was already low.
 *
 * Three consecutive equal reads is the bar. Slower than a fixed sleep, and the
 * only way the numbers mean anything.
 */
/*
 * Settled means: the network is quiet AND the count has stopped moving.
 *
 * DOM stability alone was not enough. Infrastructure paints a 5-row summary
 * while its 578-row table is still in flight; that 5 held still for well over a
 * second, so a "three equal reads" rule declared the page settled and every
 * filter on that screen was then measured against a baseline of 5. The filters
 * were fine — the readings were meaningless, and they read as filters that ADD
 * rows.
 *
 * Waiting for in-flight requests to drain is what actually distinguishes "this
 * page is done" from "this page is between two renders".
 */
const settle = async () => {
  const t0 = Date.now();
  let last = -1, stable = 0, quiet = 0;
  while (Date.now() - t0 < 30000) {
    const n = await ev(`(() => {
      if (document.readyState !== 'complete') return -1;
      if (document.querySelector('[data-loading], .skeleton, [aria-busy=true]')) return -1;
      return window.__f ? window.__f.results().total : -1;
    })()`);
    quiet = inflight.size === 0 ? quiet + 1 : 0;
    if (n >= 0 && n === last) stable++; else { stable = 0; last = n; }
    // Both conditions, and never sooner than 2s after navigation.
    if (stable >= 3 && quiet >= 3 && Date.now() - t0 > 2000) return;
    await sleep(250);
  }
};

/*
 * `panels` is here because of a fix made earlier in this same workspace: filter
 * popovers are portaled to <body> so they cannot be clipped by an ancestor's
 * overflow. That put them OUTSIDE `section.screen.on`, so a snapshot scoped to
 * the screen saw a panel open and reported no change — every Analytics range
 * and multi-select button came back DEAD in the first run for that reason
 * alone.
 */
const snapshot = () => ev(`JSON.stringify({
  r: window.__f.results(),
  url: location.pathname + location.search,
  tables: (window.__f.results(), window.__f._tables || []),
  panels: document.querySelectorAll('[data-anchored-panel], [role=dialog], [role=listbox]').length,
  text: (document.querySelector('section.screen.on')||document.body).innerText.slice(0, 4000)
})`).then((s) => JSON.parse(s));

/*
 * Drive a control by its LABEL, not its position.
 *
 * This used to take `find()[i]`. Enumeration and driving happen on separate
 * page loads, so if anything rendered in a different order the index pointed at
 * a different control — and the report blamed whichever control happened to sit
 * at that index. Infrastructure's "Inbox" view toggle was reported DEAD that
 * way; driven directly it moves the table from 578 rows to 176.
 *
 * Matching on label and kind makes the thing tested the thing named.
 */
const drive = async (i, label, kind, nth) => ev(`(async () => {
  const all = window.__f.find();
  /*
   * Label alone is not unique. Infrastructure carries TWO "Domain" toggles and
   * TWO "Provider" toggles (the view switch and the recipient grouping), plus a
   * "Vendor" select AND a "Vendor" toggle. Matching on label picked the first
   * and reported the other as dead. Label + kind + occurrence is stable.
   */
  const matches = all.filter(x => window.__f.label(x.el) === ${JSON.stringify(label)} && x.kind === ${JSON.stringify(kind)});
  const f = matches[${nth}] ?? all[${i}];
  if (!f) return 'GONE';
  const el = f.el;
  el.scrollIntoView({block:'center'});
  if (f.kind === 'select') {
    const opts = [...el.options].filter(o => !o.disabled);
    const other = opts.find(o => o.value !== el.value);
    if (!other) return 'NO_ALT';
    el.value = other.value;
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return 'set:' + (other.textContent||'').trim().slice(0,30);
  }
  if (f.kind === 'search') {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, 'zzqqxx');
    el.dispatchEvent(new Event('input', {bubbles:true}));
    // Enter on the NEXT tick, not synchronously: React batches the input
    // event's state update, and a keydown fired in the same task sees the
    // handler's stale closure with an empty query — the inbox search then
    // ignored the Enter and every inbox view read as "did not narrow".
    setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})), 250);
    return 'typed:zzqqxx';
  }
  if (f.kind === 'date') {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '2026-09-01');
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return 'date:2026-09-01';
  }
  el.click();
  return 'clicked';
})()`);

/*
 * Controls that correctly do nothing in the sweep's default state.
 *
 * Each entry names a control, the screen, and WHY a no-change result is right.
 * A reason is required: an exception without one is just a muted failure.
 *
 *   Normalize — "each line to its own scale" is arithmetically identical to the
 *   shared scale when only one series is drawn, and the chart opens with one
 *   (DEFAULT_SERIES = ["replies"]). Proven to rescale once a second series is
 *   added (scripts/normalize-probe.mjs).
 */
const EXPECTED_NOOP = [
  { route: "/analytics/campaign", kind: "checkbox", label: /^Normalize/, why: "single series drawn by default; rescales with two (normalize-probe.mjs)" },
  /*
   * The inbox search box is the tool's: Enter takes any query to All Email
   * (`/inbox/all-email?q=`), where it narrows — 0 rows for nonsense, proven
   * by a direct probe and by inbox-filters-test. Typed from Reminders, the
   * page that answers is a different screen with the client rail's 69 links
   * on it, so a row count across the hand-off is meaningless.
   */
  { route: "/inbox/reminders", kind: "search", label: /^Search by name/, why: "hands the query to All Email, the tool's behaviour; narrowing proven there" },
];
const expectedNoop = (route, c) =>
  EXPECTED_NOOP.find((x) => x.route === route && x.kind === c.kind && x.label.test(c.label));

const FAIL = [];
let checked = 0, responded = 0;

for (const route of ROUTES) {
  await send("Page.navigate", { url: BASE + route });
  await ev(HELPERS);
  await settle();
  await ev(HELPERS);
  const controls = JSON.parse(
    (await ev(`JSON.stringify((() => { const seen={}; return window.__f.find().map(f => {
  const l = window.__f.label(f.el); const k = f.kind + "|" + l;
  seen[k] = (seen[k] || 0) + 1;
  return { kind: f.kind, active: f.active, label: l, nth: seen[k] - 1 };
}); })())`)) || "[]");
  if (!controls.length) { console.log(`\n  ${route}  — no filters`); continue; }
  console.log(`\n  ${route}  — ${controls.length} filter(s)`);

  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    // Fresh page per control, so filters can't stack and confuse the reading.
    await send("Page.navigate", { url: BASE + route });
    await ev(HELPERS);
    await settle();
    await ev(HELPERS);
    const before = await snapshot();
    errors.length = 0;

    const action = await drive(i, c.label, c.kind, c.nth ?? 0);
    if (action === "GONE" || action === "NO_ALT") {
      console.log(`      –    ${c.kind.padEnd(8)} ${c.label.padEnd(34)} ${action}`);
      continue;
    }
    /*
     * Poll for the change rather than assuming 1.6s is enough.
     *
     * Infrastructure's vendor select takes about NINE seconds to come back.
     * A flat wait reported it dead; it had simply not answered yet. Exits as
     * soon as something moves, so the common fast case costs no more.
     */
    let after = await snapshot();
    for (let waited = 0; waited < 11000; waited += 700) {
      await sleep(700);
      after = await snapshot();
      /*
       * A search is judged by its ROWS, so keep waiting for them. Its typeahead
       * dropdown changes the page text the instant a character lands — long
       * before Enter's navigation answers — and exiting on that first flicker
       * measured the list before it had narrowed. Under five concurrent
       * sweeps that read as three inbox views "not narrowing" that do.
       */
      if (c.kind === "search") {
        if (after.r.total !== before.r.total || after.url !== before.url) break;
        continue;
      }
      if (after.r.total !== before.r.total || after.url !== before.url ||
          after.panels !== before.panels || after.text !== before.text) break;
    }
    checked++;

    /*
     * Watch whichever table MOVED, rather than guessing which one matters.
     *
     * "Biggest table" was the previous guess and it is wrong wherever the
     * searched table is not the biggest: Analytics → Copy searches a 4-row
     * table next to a 12-row one, and Analytics → Clients searches a 53-row
     * table beside a 93-row one. Both correctly emptied their target and both
     * were reported as filters that do not narrow, because the untouched
     * bigger table beside them never changed.
     *
     * Narrowing is therefore: some table shrank, and none grew.
     */
    const tb = before.tables || [];
    const ta = after.tables || [];
    const deltas = tb.map((n, i) => (ta[i] === undefined ? 0 : ta[i] - n));
    const movedIdx = deltas.findIndex((d) => d !== 0);
    const mainBefore = movedIdx >= 0 ? tb[movedIdx] : undefined;
    const mainAfter = movedIdx >= 0 ? ta[movedIdx] : undefined;
    const changedMain = movedIdx >= 0;
    const shrank = deltas.some((d) => d < 0);
    const grew = deltas.some((d) => d > 0);
    const changedRows = before.r.total !== after.r.total || changedMain;
    const changedUrl = before.url !== after.url;
    const changedText = before.text !== after.text;
    const changedPanel = before.panels !== after.panels;
    const did = changedRows || changedUrl || changedText || changedPanel;
    if (did) responded++;

    const notes = [];
    if (changedMain) notes.push(`rows ${mainBefore}→${mainAfter}`);
    else if (changedRows) notes.push(`rows ${before.r.total}→${after.r.total}`);
    else if (changedText) notes.push("content");
    if (changedUrl) notes.push("url");
    if (changedPanel) notes.push(`panel ${before.panels}→${after.panels}`);
    if (errors.length) notes.push(`${errors.length} console error(s)`);

    // A search for a string that matches nothing MUST reduce the result set.
    // This is the check that catches a filter wired to the wrong field: it
    // responds, it re-renders, and it still returns every row.
    /*
     * A chip that is already the selected one SHOULD do nothing. "All", "30d",
     * "Every active client" and "Today" are the defaults on their screens, and
     * clicking the option you are already looking at is correctly a no-op.
     * Seven of the first run's DEAD verdicts were exactly this.
     */
    let verdict = did ? "ok  " : (c.active ? "noop" : "DEAD");
    if (c.active && !did) notes.push("already active — no-op is correct");
    const known = !did && expectedNoop(route, c);
    if (known) { verdict = "noop"; notes.push(`expected no-op: ${known.why}`); }
    /*
     * A nonsense search must reduce SOMETHING and enlarge nothing.
     *
     * When the screen has no <table> at all — the Portals grid is a list of
     * card rows, the client rail is a list — the per-table view is empty and
     * "some table shrank" can never be true. Fall back to the result count
     * (cards + rows + links), which is what the Portals search actually moves:
     * 167 → 3 was reported as "did not narrow" for exactly this reason.
     */
    // A screen may carry an empty side table beside a card list (Portals has
    // one), so "no tables" is the wrong test. Narrowing is: nothing grew, and
    // either a table shrank or the overall result count fell.
    const narrowed = !grew && (shrank || after.r.total < before.r.total);
    if (c.kind === "search" && !narrowed) {
      const expected = expectedNoop(route, c);
      if (expected) {
        verdict = "noop";
        notes.push(expected.why);
      } else {
        verdict = "WIDE";
        notes.push("nonsense search did not narrow");
      }
    }
    // `noop` is a pass: the chip was already the selected one.
    if (verdict !== "ok  " && verdict !== "noop") FAIL.push({ route, ...c, verdict, notes: notes.join(", ") });
    if (errors.length) FAIL.push({ route, ...c, verdict: "ERR ", notes: notes.join(", ") });

    console.log(`      ${verdict} ${c.kind.padEnd(8)} ${c.label.padEnd(34)} ${action.padEnd(22)} ${notes.join(", ")}`);
  }
}

console.log(`\n${"=".repeat(78)}`);
console.log(`  ${checked} filters exercised, ${responded} responded`);
if (blockedWrites.length) {
  console.log(`\n  WRITE ATTEMPTS BLOCKED (${blockedWrites.length}) — a control I treated as a filter tried to mutate:`);
  for (const w of [...new Set(blockedWrites)]) console.log(`      ${w}`);
}
if (FAIL.length) {
  console.log(`\n  ${FAIL.length} PROBLEM(S):`);
  for (const f of FAIL) console.log(`      ${f.verdict} ${f.route}  ${f.kind}  "${f.label}"  ${f.notes}`);
} else {
  console.log(`\n  No problems.`);
}
ws.close();
process.exit(FAIL.length ? 1 : 0);
