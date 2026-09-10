/*
 * Does Client Health actually WORK?
 *
 * Drives a real Chrome over the DevTools Protocol — no Playwright, no
 * Puppeteer; Chrome speaks CDP over a WebSocket and Node has `fetch` and
 * `WebSocket` built in, so the driver is the ~40 lines below.
 *
 *   node scripts/client-health-ui-test.mjs [baseUrl] [cdpUrl]
 *
 * The distinction this exists to make: a screen that RENDERS is not a screen
 * that WORKS. Every check below either counts something that must be there or
 * operates a control and asserts the page changed as a result. Clicking a sort
 * header and getting the same order back is a silent failure that a render
 * test cannot see.
 *
 * READ-ONLY against the database. It opens the client modal and the campaigns
 * popup and closes them again; it never saves, pauses, hides or deletes.
 * Verifying a delete would mean deleting a real client from a live product.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3310";
const CDP = process.argv[3] || "http://localhost:9444";
const WIDTH = 1440;

async function cookie() {
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result?.value;
  }
  close() { return fetch(`${CDP}/json/close/${this.targetId}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Our dialogs, addressed by their own title id.
 *
 * NOT `[role=dialog][aria-modal=true]`. The workspace's command palette is
 * mounted on every page — hidden, but present — and matches that selector, so
 * every "did it close?" check read as a failure while the product was fine.
 * A test that cannot tell its own dialog from someone else's is not a test.
 */
const POPUP = '[role=dialog][aria-labelledby="ch-camps-title"]';
const MODAL = '[role=dialog][aria-labelledby="ch-modal-title"]';

/** A real Escape, through the browser's input pipeline. */
async function pressEscape(tab) {
  await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
  await sleep(350);
}

/** A real click at a viewport point. */
async function clickAt(tab, x, y) {
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(300);
}

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`    ✓ ${name}${detail ? `  ${detail}` : ""}`); }
  else { fail++; failures.push(name); console.log(`    ✗ ${name}${detail ? `  ${detail}` : ""}`); }
}

/** Opens a screen and waits for its table to have drawn rows. */
async function openScreen(path, auth) {
  const tab = await Tab.open();
  const errors = [];
  tab.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    }
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(String(m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
    }
  });
  await tab.send("Runtime.enable");
  await tab.send("Page.enable");
  await tab.send("Network.enable");
  await tab.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 950, deviceScaleFactor: 1, mobile: false });
  await tab.send("Network.setCookie", { name: "bs_sso", value: auth, domain: "localhost", path: "/" });
  await tab.send("Page.navigate", { url: BASE + path });

  for (let i = 0; i < 400; i++) {
    await sleep(150);
    const ready = await tab.eval(`document.readyState === 'complete' && document.querySelectorAll('tbody tr').length > 0`).catch(() => false);
    if (ready) break;
  }
  await sleep(600);
  return { tab, errors };
}

// ---------------------------------------------------------------------------

const auth = await cookie();
console.log(`\n  Client Health · ${BASE}\n`);

// == WEEKLY ==================================================================
{
  console.log("  /clients — Weekly");
  const { tab, errors } = await openScreen("/clients", auth);

  const shape = await tab.eval(`(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const text = (el) => (el.textContent || '').trim();
    return {
      groups: q('.grp-h').map(text),
      cards: q('.card').length,
      cardLabels: q('.card-l').map(text),
      headers: q('thead th').map((th) => text(th).replace(/[↕↓↑]\\s*$/, '').trim()),
      rows: q('tbody tr').length,
      pills: q('.pills .fp').map(text),
      selects: q('.tbl-head select').length,
      searchBox: q('.tbl-head input[type=search]').length,
      addBtn: q('button').filter((b) => text(b).includes('Add Client')).length,
      syncBtn: q('button').filter((b) => text(b) === 'Sync now').length,
      portalLinks: q('a[href*="http"]').filter((a) => text(a) === '↗').length,
      campaignButtons: q('button.cmeta').length,
      actionEdit: q('button[aria-label^="Edit "]').length,
      actionPause: q('button[aria-label^="Pause "], button[aria-label^="Resume "]').length,
      actionChurn: q('button[aria-label^="Mark "], button[aria-label^="Restore "]').length,
      actionDelete: q('button[aria-label^="Delete "]').length,
      progressSelects: q('td select').length,
      readonlyMetrics: q('input.mi[readonly]').length,
    };
  })()`);

  check("no console errors", errors.length === 0, errors[0] ?? "");
  check("rows rendered", shape.rows > 0, `${shape.rows} clients`);
  check("four card groups", shape.groups.length === 4, shape.groups.join(" · "));
  check("group labels are the tool's",
    shape.groups.join("|").includes("Status") &&
    shape.groups.some((g) => g.includes("Performance")) &&
    shape.groups.some((g) => g.includes("Lifetime")) &&
    shape.groups.some((g) => g.includes("This Week") || g.includes("Week of")),
    shape.groups.join(" · "));
  check("24 summary cards", shape.cards === 24, `${shape.cards} cards`);

  for (const label of ["Clients", "At Risk", "On Track", "Done", "Client Paused", "By Plan",
                       "Weekly Intros Sent", "Weekly Target", "Weekly Completion",
                       "Monthly Intros Sent", "Monthly Target", "Monthly Completion",
                       "Emails Sent", "Reply Rate", "Positive Reply", "Avg Conv.",
                       "Converted", "Int → Intro"]) {
    if (!shape.cardLabels.includes(label)) check(`card "${label}"`, false);
  }
  check("every expected card label present",
    ["Clients","At Risk","On Track","Done","Client Paused","By Plan","Weekly Intros Sent",
     "Weekly Target","Weekly Completion","Monthly Intros Sent","Monthly Target",
     "Monthly Completion","Emails Sent","Reply Rate","Positive Reply","Avg Conv.",
     "Converted","Int → Intro"].every((l) => shape.cardLabels.includes(l)));

  const WANT = ["Client","Time Zone","Monthly","Last Intro","Last Billing","Next Billing",
    "Days Until Billing","Daily Emails Sent","Intros This Week","Conv. Rate","Left This Week",
    "Campaign Progress","Status","Interested","Converted","Int → Intro","Plan","Portal","Actions"];
  check("19 columns, in the tool's order",
    JSON.stringify(shape.headers) === JSON.stringify(WANT),
    shape.headers.length === 19 ? "" : `got ${shape.headers.length}: ${shape.headers.join("|")}`);

  check("nine filter pills", shape.pills.length >= 9, shape.pills.join(" · "));
  check("renamed pills present",
    shape.pills.includes("Campaign Paused") && shape.pills.includes("Clients Churned"));
  check("three filter selects (plan, tz, billing)", shape.selects === 3, `${shape.selects}`);
  check("search box", shape.searchBox === 1);
  check("Add Client button", shape.addBtn >= 1);
  check("Sync now button", shape.syncBtn === 1);
  check("portal deep-links rendered", shape.portalLinks > 0, `${shape.portalLinks} ↗ links`);
  check("campaign popup triggers", shape.campaignButtons > 0, `${shape.campaignButtons} clickable`);
  check("row actions: edit/pause/churn/delete",
    shape.actionEdit === shape.rows && shape.actionPause === shape.rows &&
    shape.actionChurn === shape.rows && shape.actionDelete === shape.rows,
    `${shape.actionEdit}/${shape.actionPause}/${shape.actionChurn}/${shape.actionDelete} of ${shape.rows}`);
  check("metric inputs are read-only", shape.readonlyMetrics > 0, `${shape.readonlyMetrics}`);

  // -- BEHAVIOUR: search ----------------------------------------------------
  const searchResult = await tab.eval(`(async () => {
    const before = document.querySelectorAll('tbody tr').length;
    const input = document.querySelector('.tbl-head input[type=search]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const firstName = document.querySelector('tbody tr .cname')?.textContent.trim().split('\\n')[0] || '';
    setter.call(input, firstName.slice(0, 5));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const after = document.querySelectorAll('tbody tr').length;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const restored = document.querySelectorAll('tbody tr').length;
    return { before, after, restored, term: firstName.slice(0, 5) };
  })()`);
  check("search narrows the table", searchResult.after > 0 && searchResult.after < searchResult.before,
    `"${searchResult.term}": ${searchResult.before} → ${searchResult.after}`);
  check("clearing search restores it", searchResult.restored === searchResult.before);

  // -- BEHAVIOUR: filter pills ----------------------------------------------
  const pillResult = await tab.eval(`(async () => {
    const out = {};
    const pills = Array.from(document.querySelectorAll('.pills .fp'));
    for (const label of ['At Risk', 'On Track', 'Done', 'Active', 'Clients Churned', 'All']) {
      const p = pills.find(x => x.textContent.trim() === label);
      if (!p) { out[label] = 'missing'; continue; }
      p.click();
      await new Promise(r => setTimeout(r, 220));
      out[label] = document.querySelectorAll('tbody tr').length;
    }
    return out;
  })()`);
  check("filter pills each change the set",
    typeof pillResult["At Risk"] === "number" && pillResult["All"] > 0 &&
    new Set(Object.values(pillResult).filter(v => typeof v === 'number')).size > 1,
    Object.entries(pillResult).map(([k, v]) => `${k}:${v}`).join(" "));

  // -- BEHAVIOUR: selects ---------------------------------------------------
  const selectResult = await tab.eval(`(async () => {
    const setVal = async (idx, value) => {
      const s = document.querySelectorAll('.tbl-head select')[idx];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(s, value);
      s.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 220));
      return document.querySelectorAll('tbody tr').length;
    };
    const all = document.querySelectorAll('tbody tr').length;
    const plan = await setVal(0, 'partner');
    await setVal(0, 'all');
    const tz = await setVal(1, 'America/New_York');
    await setVal(1, 'all');
    const billing = await setVal(2, '7');
    await setVal(2, 'all');
    const back = document.querySelectorAll('tbody tr').length;
    return { all, plan, tz, billing, back };
  })()`);
  check("plan select filters", selectResult.plan < selectResult.all, `${selectResult.all} → ${selectResult.plan}`);
  check("time-zone select filters", selectResult.tz < selectResult.all, `${selectResult.all} → ${selectResult.tz}`);
  check("billing-window select filters", selectResult.billing < selectResult.all, `${selectResult.all} → ${selectResult.billing}`);
  check("clearing the selects restores every row", selectResult.back === selectResult.all);

  // -- BEHAVIOUR: date popover ----------------------------------------------
  const dateResult = await tab.eval(`(async () => {
    const btn = Array.from(document.querySelectorAll('.tbl-head button'))
      .find(b => b.textContent.trim() === 'Start date');
    if (!btn) return { opened: false };
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    const pop = document.querySelector('[role=dialog][aria-label="Filter by start date"]');
    const presets = pop ? Array.from(pop.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
    const dateInputs = pop ? pop.querySelectorAll('input[type=date]').length : 0;
    const before = document.querySelectorAll('tbody tr').length;
    const ytd = pop && Array.from(pop.querySelectorAll('button')).find(b => b.textContent.trim() === 'Year to Date');
    if (ytd) { ytd.click(); await new Promise(r => setTimeout(r, 250)); }
    const after = document.querySelectorAll('tbody tr').length;
    const clear = pop && Array.from(pop.querySelectorAll('button')).find(b => b.textContent.trim() === 'Clear');
    if (clear) { clear.click(); await new Promise(r => setTimeout(r, 250)); }
    const restored = document.querySelectorAll('tbody tr').length;
    return { opened: !!pop, presets, dateInputs, before, after, restored };
  })()`);
  check("date popover opens", dateResult.opened);
  check("three presets + From/To",
    dateResult.presets?.includes("Last 7 Days") && dateResult.presets?.includes("Last 30 Days") &&
    dateResult.presets?.includes("Year to Date") && dateResult.dateInputs === 2);
  check("a preset filters the table", dateResult.after <= dateResult.before, `${dateResult.before} → ${dateResult.after}`);
  check("Clear restores it", dateResult.restored === dateResult.before);

  // -- BEHAVIOUR: sorting ---------------------------------------------------
  const sortResult = await tab.eval(`(async () => {
    const names = () => Array.from(document.querySelectorAll('tbody tr .cname'))
      .map(e => e.textContent.trim().split('\\n')[0]);
    const th = (label) => Array.from(document.querySelectorAll('thead th'))
      .find(t => t.textContent.replace(/[↕↓↑]/g, '').trim() === label);
    const out = {};
    for (const label of ['Intros This Week', 'Daily Emails Sent', 'Time Zone', 'Int → Intro', 'Days Until Billing']) {
      const h = th(label);
      if (!h) { out[label] = 'missing header'; continue; }
      const base = names().join('|');
      h.click(); await new Promise(r => setTimeout(r, 220));
      const desc = names().join('|');
      h.click(); await new Promise(r => setTimeout(r, 220));
      const asc = names().join('|');
      h.click(); await new Promise(r => setTimeout(r, 220));
      const reset = names().join('|');
      out[label] = { changed: desc !== base || asc !== desc, reversed: desc !== asc, resets: reset === base };
    }
    return out;
  })()`);
  for (const [label, r] of Object.entries(sortResult)) {
    check(`sort "${label}" reorders, reverses and resets`,
      r && r.changed && r.reversed && r.resets,
      r && typeof r === "object" ? `changed=${r.changed} reversed=${r.reversed} resets=${r.resets}` : String(r));
  }

  // -- BEHAVIOUR: week navigation -------------------------------------------
  const weekResult = await tab.eval(`(async () => {
    const label = () => document.querySelector('button[aria-label="Selected week"]').textContent.trim();
    const prev = document.querySelector('button[aria-label="Previous week"]');
    const next = document.querySelector('button[aria-label="Next week"]');
    const start = label();
    const nextDisabledAtStart = next.disabled;
    prev.click(); await new Promise(r => setTimeout(r, 350));
    const past = label();
    const banner = !!Array.from(document.querySelectorAll('.anno'))
      .find(a => a.textContent.includes('Viewing a past week'));
    const todayBtn = !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Today');
    const funnelLabel = Array.from(document.querySelectorAll('.grp-h')).map(e => e.textContent.trim()).pop();
    const t = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Today');
    if (t) { t.click(); await new Promise(r => setTimeout(r, 350)); }
    return { start, past, back: label(), banner, todayBtn, nextDisabledAtStart, funnelLabel };
  })()`);
  check("next week is disabled on the current week", weekResult.nextDisabledAtStart);
  check("stepping back changes the week", weekResult.past !== weekResult.start, `${weekResult.start} → ${weekResult.past}`);
  check("a past week is announced", weekResult.banner);
  check("Today button appears and returns", weekResult.todayBtn && weekResult.back === weekResult.start);
  check("the week funnel is re-labelled for a past week",
    /Week of/.test(weekResult.funnelLabel), weekResult.funnelLabel);

  // -- BEHAVIOUR: campaigns popup -------------------------------------------
  await tab.eval(`document.querySelector('button.cmeta').click()`);
  await sleep(400);
  const popupResult = await tab.eval(`(() => {
    const dlg = document.querySelector('${POPUP}');
    if (!dlg) return { opened: false };
    const text = dlg.textContent;
    return {
      opened: true,
      bars: dlg.querySelectorAll('.track').length,
      hasReply: /Reply/.test(text),
      hasPositive: /Positive/.test(text),
      hasLeads: /leads/.test(text),
      hasSent: /emails sent/.test(text),
      hasStatusChip: /Running|Campaign Paused|Finished|Draft/.test(text),
    };
  })()`);
  await pressEscape(tab);
  popupResult.closedByEscape = !(await tab.eval(`!!document.querySelector('${POPUP}')`));

  // Backdrop dismissal, with a real click in the bottom-right of the scrim.
  await tab.eval(`document.querySelector('button.cmeta').click()`);
  await sleep(400);
  const reopened = await tab.eval(`!!document.querySelector('${POPUP}')`);
  await clickAt(tab, WIDTH - 12, 930);
  const closedByBackdrop = !(await tab.eval(`!!document.querySelector('${POPUP}')`));

  check("campaigns popup opens", popupResult.opened);
  check("popup shows a progress bar per campaign", popupResult.bars > 0, `${popupResult.bars}`);
  check("popup shows leads and emails sent", popupResult.hasLeads && popupResult.hasSent);
  check("popup shows per-campaign Reply and Positive rates", popupResult.hasReply && popupResult.hasPositive);
  check("popup shows a status chip", popupResult.hasStatusChip);
  check("Escape closes the popup", popupResult.closedByEscape);
  check("a backdrop click closes the popup", reopened && closedByBackdrop);

  // -- BEHAVIOUR: the client modal ------------------------------------------
  const modalResult = await tab.eval(`(async () => {
    const edit = document.querySelector('button[aria-label^="Edit "]');
    edit.click();
    await new Promise(r => setTimeout(r, 300));
    const dlg = document.querySelector('[role=dialog][aria-labelledby="ch-modal-title"]');
    if (!dlg) return { opened: false };
    const labels = Array.from(dlg.querySelectorAll('label > span:first-child')).map(s => s.textContent.trim());
    const nameInput = dlg.querySelector('input[type=text], input:not([type])');
    const selects = dlg.querySelectorAll('select').length;
    const dates = dlg.querySelectorAll('input[type=date]').length;
    const numbers = dlg.querySelectorAll('input[type=number]').length;
    const prefilled = nameInput && nameInput.value.length > 0;

    // The custom-interval field must appear only for the Custom option.
    const intervalSelect = Array.from(dlg.querySelectorAll('select'))
      .find(s => Array.from(s.options).some(o => /Custom/.test(o.textContent)));
    let customShown = null;
    if (intervalSelect) {
      const before = dlg.querySelectorAll('input[type=number]').length;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(intervalSelect, 'custom');
      intervalSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      customShown = dlg.querySelectorAll('input[type=number]').length > before;
    }

    // The auto-link preview must react to the name.
    const helpBefore = dlg.textContent.match(/auto-link[^.]*\\.|No campaign contains[^.]*\\./)?.[0] ?? '';
    const setInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setInput.call(nameInput, 'zzz-nothing-matches-this');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const helpAfter = dlg.textContent.match(/auto-link[^.]*\\.|No campaign contains[^.]*\\./)?.[0] ?? '';

    // Cancel — nothing is saved.
    const cancel = Array.from(dlg.querySelectorAll('button')).find(b => b.textContent.trim() === 'Cancel');
    cancel.click();
    await new Promise(r => setTimeout(r, 300));
    return {
      opened: true, labels, selects, dates, numbers, prefilled, customShown,
      helpBefore, helpAfter,
      closed: !document.querySelector('[role=dialog][aria-labelledby="ch-modal-title"]'),
    };
  })()`);
  check("edit modal opens", modalResult.opened);
  check("modal is prefilled from the client", modalResult.prefilled);
  const WANT_FIELDS = ["Client / Brokerage Name","Plan","Weekly Intros Target","Monthly Intros Target",
    "Start Date","Billing Anchor Date","Billing Interval","Time Zone"];
  check("all eight fields present",
    WANT_FIELDS.every((f) => modalResult.labels?.includes(f)),
    (modalResult.labels ?? []).join(" · "));
  check("plan, interval and time-zone selects", modalResult.selects === 3, `${modalResult.selects}`);
  check("two date inputs, two number inputs", modalResult.dates === 2 && modalResult.numbers === 2);
  check("custom-interval field appears only for Custom", modalResult.customShown === true);
  check("auto-link preview reacts to the name",
    modalResult.helpAfter !== modalResult.helpBefore && /No campaign contains/.test(modalResult.helpAfter),
    modalResult.helpAfter?.slice(0, 60));
  check("Cancel closes without saving", modalResult.closed);

  // -- LAYOUT ---------------------------------------------------------------
  const layout = await tab.eval(layoutProbe());
  check("nothing overflows the viewport", layout.docOverflow <= 1 && layout.count === 0,
    `doc +${layout.docOverflow}px · ${layout.count} escaping element(s)` +
    (layout.top?.[0] ? ` · worst <${layout.top[0].tag} class="${layout.top[0].cls}">` : ""));
  check("the wide table scrolls inside its own container",
    layout.scrollers?.some((s) => s.includes("tbl-scroll")), (layout.scrollers ?? []).join(" · "));

  await tab.close();
}

// == BI-WEEKLY ===============================================================
{
  console.log("\n  /clients/biweekly — Bi-Weekly");
  const { tab, errors } = await openScreen("/clients/biweekly", auth);
  const shape = await tab.eval(`(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const text = (el) => (el.textContent || '').trim();
    return {
      headers: q('thead th').map((th) => text(th).replace(/[↕↓↑]\\s*$/, '').trim()),
      rows: q('tbody tr').length,
      cards: q('.card').length,
      pills: q('.pills .fp').length,
      selects: q('.tbl-head select').length,
      setLinks: q('tbody button').filter(b => /^Set/.test(text(b))).length,
    };
  })()`);

  check("no console errors", errors.length === 0, errors[0] ?? "");
  check("rows rendered", shape.rows > 0, `${shape.rows} clients`);
  const BW = ["Client","Time Zone","Billing Date","Days Until Billing","Introductions","Left This Cycle"];
  check("six columns, in the tool's order", JSON.stringify(shape.headers) === JSON.stringify(BW),
    shape.headers.join("|"));
  check("shares the Weekly filter row", shape.pills >= 9 && shape.selects === 3,
    `${shape.pills} pills · ${shape.selects} selects`);

  const sortBw = await tab.eval(`(async () => {
    const names = () => Array.from(document.querySelectorAll('tbody tr .cname')).map(e => e.textContent.trim());
    const th = Array.from(document.querySelectorAll('thead th'))
      .find(t => t.textContent.replace(/[↕↓↑]/g,'').trim() === 'Days Until Billing');
    const base = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    const desc = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    const asc = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    return { changed: desc !== base, reversed: desc !== asc, resets: names().join('|') === base };
  })()`);
  check("sorting works and resets", sortBw.changed && sortBw.reversed && sortBw.resets,
    `changed=${sortBw.changed} reversed=${sortBw.reversed} resets=${sortBw.resets}`);

  const layout = await tab.eval(layoutProbe());
  check("nothing overflows the viewport", layout.docOverflow <= 1 && layout.count === 0,
    `doc +${layout.docOverflow}px · ${layout.count} escaping`);
  await tab.close();
}

// == CLIENT SUCCESS ==========================================================
{
  console.log("\n  /clients/success — Client Success");
  const { tab, errors } = await openScreen("/clients/success", auth);
  const shape = await tab.eval(`(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const text = (el) => (el.textContent || '').trim();
    return {
      headers: q('thead th').map((th) => text(th).replace(/[↕↓↑]\\s*$/, '').trim()),
      rows: q('tbody tr').length,
      cards: q('.card').length,
      pills: q('.pills .fp').length,
      selects: q('.tbl-head select').length,
    };
  })()`);

  check("no console errors", errors.length === 0, errors[0] ?? "");
  check("rows rendered", shape.rows > 0, `${shape.rows} clients`);
  const CS = ["Client","Plan","Score","Time Zone","Launch Date","Portal Updated",
    "Stagnant Intros","Hired","Last Hire","DNC","Agents"];
  check("eleven columns, in the tool's order", JSON.stringify(shape.headers) === JSON.stringify(CS),
    shape.headers.join("|"));
  check("shares the filter row, minus the redundant Plan select",
    shape.pills >= 9 && shape.selects === 2, `${shape.pills} pills · ${shape.selects} selects`);

  const sortCs = await tab.eval(`(async () => {
    const names = () => Array.from(document.querySelectorAll('tbody tr .cname')).map(e => e.textContent.trim());
    const th = Array.from(document.querySelectorAll('thead th'))
      .find(t => t.textContent.replace(/[↕↓↑]/g,'').trim() === 'Score');
    const base = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    const desc = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    const asc = names().join('|');
    th.click(); await new Promise(r => setTimeout(r, 220));
    return { changed: desc !== base, reversed: desc !== asc, resets: names().join('|') === base };
  })()`);
  check("sorting works and resets", sortCs.changed && sortCs.reversed && sortCs.resets,
    `changed=${sortCs.changed} reversed=${sortCs.reversed} resets=${sortCs.resets}`);

  const layout = await tab.eval(layoutProbe());
  check("nothing overflows the viewport", layout.docOverflow <= 1 && layout.count === 0,
    `doc +${layout.docOverflow}px · ${layout.count} escaping`);
  await tab.close();
}

console.log(`\n  ${pass} passed · ${fail} failed`);
if (fail) { console.log("\n  failed:"); for (const f of failures) console.log(`    · ${f}`); }
process.exit(fail ? 1 : 0);

/*
 * Content inside a horizontally SCROLLABLE ancestor is not overflow — it is
 * the point of the scroller. So walk up from each element and ignore it if any
 * ancestor scrolls or clips; what survives genuinely escapes the window.
 */
function layoutProbe() {
  return `(() => {
    const vw = document.documentElement.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - vw;
    const screen = document.querySelector('section.screen.on') || document.body;
    const scrolls = (el) => {
      const s = getComputedStyle(el);
      return s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden';
    };
    const contained = (el) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (scrolls(p)) return true;
      }
      return false;
    };
    const offenders = [];
    for (const el of screen.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1) continue;
      if (contained(el)) continue;
      offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44), right: Math.round(r.right) });
    }
    const scrollers = [];
    for (const el of screen.querySelectorAll('*')) {
      if (el.scrollWidth > el.clientWidth + 2 && scrolls(el)) {
        scrollers.push(String(el.className || el.tagName).slice(0, 40) + ' (' + el.clientWidth + '→' + el.scrollWidth + ')');
      }
    }
    return { vw, docOverflow, count: offenders.length, top: offenders.sort((a,b)=>b.right-a.right).slice(0,3), scrollers: scrollers.slice(0,4) };
  })()`;
}
