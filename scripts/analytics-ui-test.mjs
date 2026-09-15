/*
 * Drives a real Chrome over the DevTools Protocol, against the Analytics
 * screens.
 *
 * No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket and Node has
 * both `fetch` and `WebSocket` built in, so the whole driver is the ~40 lines
 * below. Copied in shape from `scripts/ui-test.mjs`, with two additions this
 * port needed: a `click` helper scoped to the active screen, and a per-screen
 * `steps` list so a control can be pressed and its EFFECT asserted.
 *
 *   node scripts/analytics-ui-test.mjs [baseUrl]
 *
 * Reports, per screen: HTTP status, time to render, console errors, failed
 * network requests, and whether the screen actually drew rows rather than an
 * empty state. That last one matters most — every silent failure in this
 * project so far rendered a clean, empty, entirely wrong page.
 *
 * READ-ONLY: it clicks tabs, filters, sorts and expanders. It presses no button
 * that writes. Writes are `scripts/analytics-write-test.mjs`, which creates its
 * own rows and deletes them.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3350";
const CDP = process.env.CDP || "http://localhost:9448";

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
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
      this.#pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }
  /**
   * Clicks the first element matching `selector` whose text matches `text`.
   *
   * Always scoped to `section.screen.on`, the same discipline the repo's other
   * click helpers use: every screen is inside that section, and an unscoped
   * query would happily press a control on the rail.
   */
  async click(selector, text) {
    return this.eval(`(() => {
      const root = document.querySelector('section.screen.on') || document.body;
      const all = [...root.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text ? `all.find(e => new RegExp(${JSON.stringify(text)}, 'i').test(e.textContent || ''))` : "all[0]"};
      if (!el) return false;
      el.click();
      return true;
    })()`);
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Screen → `ready`, a JS expression that is true only once REAL DATA is on
 * screen, plus `steps`: things to press, each with an assertion about what
 * changed.
 *
 * `ready` is an expression rather than a selector-and-count for a reason this
 * file learned the hard way. Three of these screens paint a skeleton with the
 * right shape — twelve empty KPI tiles, three day cards reading "…" — so a gate
 * of "12 × .kpi > div" was satisfied a full second before any number arrived,
 * and every assertion after it failed against a loading state. A readiness
 * check that a skeleton can pass is not a readiness check.
 *
 * A step's `expect` runs AFTER the click and returns a string. `""` means it
 * passed; anything else is the failure, printed verbatim.
 */
const P = "/analytics";
const SCREENS = [
  {
    path: `${P}/campaign`,
    label: "Campaign",
    ready: `[...document.querySelectorAll('.kpi .v')].filter(e => e.textContent.trim()).length >= 12`,
    steps: [
      {
        name: "KPI band carries real numbers",
        expect: `(() => {
          const v = [...document.querySelectorAll('.kpi .v')].map(e => e.textContent.trim());
          if (v.length < 12) return 'only ' + v.length + ' tiles';
          const dashes = v.filter(t => t === '-' || t === '').length;
          return dashes > 3 ? dashes + ' of 12 tiles are a dash: ' + v.join(' | ') : '';
        })()`,
      },
      {
        name: "chart draws a line",
        expect: `document.querySelectorAll('.lchart path.lc-line').length ? '' : 'no .lc-line path'`,
      },
      {
        click: [".segfull button", "^Clients$"],
        settle: 1400,
        name: "Clients sub-view lists clients",
        expect: `(() => {
          const rows = document.querySelectorAll('.atbl tbody tr').length;
          return rows > 5 ? '' : 'only ' + rows + ' client rows';
        })()`,
      },
      {
        click: [".segfull button", "^Campaigns$"],
        settle: 1600,
        name: "Campaigns sub-view lists campaigns",
        expect: `(() => {
          const rows = document.querySelectorAll('.atbl tbody tr').length;
          return rows > 5 ? '' : 'only ' + rows + ' campaign rows';
        })()`,
      },
      {
        click: [".atbl tbody button[aria-label='Show steps']"],
        settle: 1600,
        name: "a campaign row expands into its sequence steps",
        expect: `(() => {
          const inner = document.querySelectorAll('.atbl .atbl tbody tr').length;
          return inner > 0 ? '' : 'the expanded row drew no step table';
        })()`,
      },
      {
        click: [".segfull button", "^Replies$"],
        settle: 2600,
        name: "Replies sub-view draws breakdown cards and a reply list",
        expect: `(() => {
          const bars = document.querySelectorAll('.bar-h').length;
          const rows = document.querySelectorAll('.atbl tbody tr').length;
          return bars > 5 && rows > 5 ? '' : bars + ' bars, ' + rows + ' rows';
        })()`,
      },
      {
        click: [".segfull button", "^Volume$"],
        settle: 1600,
        name: "Volume sub-view draws capacity and a ranked split",
        expect: `(() => {
          const t = document.body.innerText;
          const bars = document.querySelectorAll('.bar-h').length;
          return /Daily sending capacity/.test(t) && bars > 5 ? '' : 'capacity ' + /Daily sending capacity/.test(t) + ', ' + bars + ' bars';
        })()`,
      },
      {
        click: [".segfull button", "^Charts$"],
        settle: 800,
      },
      {
        click: [".qr button", "^7d$"],
        settle: 2000,
        name: "the 7d pill narrows the window and the URL follows",
        expect: `location.search.includes('preset=7d') ? '' : 'URL is ' + location.search`,
      },
    ],
  },
  {
    path: `${P}/infrastructure`,
    label: "Infrastructure",
    ready: `/inboxes sending/.test(document.body.innerText) && document.querySelectorAll('.atbl tbody tr').length > 10`,
    steps: [
      {
        name: "the estate totals are populated",
        expect: `/inboxes sending/.test(document.body.innerText) ? '' : 'no inbox total'`,
      },
      {
        click: [".seg button", "^Inbox$"],
        settle: 2000,
        name: "the inbox view pages rather than truncating at 100",
        expect: `(() => {
          // The LAST .abox is the estate table; the disconnected-inbox card
          // above it is also an .atbl and was being counted into this total.
          const boxes = [...document.querySelectorAll('.abox')];
          const rows = boxes[boxes.length - 1].querySelectorAll('tbody tr').length;
          const pager = /of [\\d,]+/.test(document.body.innerText);
          return rows === 100 && pager ? '' : rows + ' rows in the estate table, pager ' + pager;
        })()`,
      },
      {
        click: ["button", "^Next$"],
        settle: 2000,
        name: "page 2 loads different inboxes",
        expect: `/2 \\//.test(document.body.innerText) ? '' : 'pager did not advance'`,
      },
    ],
  },
  {
    path: `${P}/attribution`,
    label: "Attribution",
    ready: `/Credited to a campaign/.test(document.body.innerText) && document.querySelectorAll('.atbl tbody tr').length > 20`,
    steps: [
      {
        name: "the coverage strip and the funnel are drawn",
        expect: `(() => {
          const t = document.body.innerText;
          return /Credited to a campaign/.test(t) && /Where people stopped|The funnel/.test(t)
            ? '' : 'missing coverage or funnel';
        })()`,
      },
      {
        name: "every outcome is listed",
        expect: `document.querySelectorAll('.atbl tbody tr').length > 20 ? '' : 'the outcome list is short'`,
      },
    ],
  },
  {
    path: `${P}/copy`,
    label: "Copy & Offer",
    ready: `/of first-email sending is tagged/.test(document.body.innerText) && document.querySelectorAll('.atbl tbody tr').length > 1`,
    steps: [
      {
        name: "the copy table has groups with members",
        expect: `document.querySelectorAll('.atbl tbody tr').length > 1 ? '' : 'no copy rows'`,
      },
      {
        // The LAST .abox is "How the copy performs". The spintax card above it
        // is also an .atbl, and its rows do not expand.
        click: [".abox:last-of-type .atbl tbody tr"],
        settle: 500,
        name: "a copy row expands to the emails inside it",
        expect: `document.querySelectorAll('.atbl .atbl').length ? '' : 'the expanded row drew no member table'`,
      },
      {
        name: "coverage is stated, not implied",
        expect: `/of first-email sending is tagged/.test(document.body.innerText) ? '' : 'no coverage line'`,
      },
    ],
  },
  {
    path: `${P}/campaigns`,
    label: "Campaigns",
    ready: `document.querySelectorAll('.atbl tbody tr').length > 20`,
    steps: [
      {
        click: ["input[type=checkbox][aria-label^='Select ']"],
        settle: 400,
        name: "selecting a campaign offers the four actions with eligibility counts",
        expect: `(() => {
          const t = document.querySelector('.mi-selbar')?.innerText ?? '';
          return /Pause \\(/.test(t) && /Resume \\(/.test(t) && /Archive \\(/.test(t) && /Duplicate \\(/.test(t)
            ? '' : 'selection bar reads: ' + t.replace(/\\n/g, ' ');
        })()`,
      },
      {
        name: "Resume is a two-click arm, never a native confirm",
        expect: `(() => {
          const b = [...document.querySelectorAll('.mi-selbar button')].find(x => /^Resume/.test(x.textContent));
          if (!b) return 'no Resume button';
          return /queues these campaigns to SEND/i.test(b.title) ? '' : 'Resume has no consequence in its title';
        })()`,
      },
      { click: ["button", "^Clear$"], settle: 300 },
    ],
  },
  {
    /*
     * The drill-down has no nav destination — it is a row you open, not a place
     * you go — so it is reached here at the address the Campaigns list links to.
     */
    path: `${P}/campaigns/55`,
    label: "Campaign detail",
    ready: `/Lifetime totals/.test(document.body.innerText)`,
    steps: [
      {
        name: "the overview funnel carries real lifetime figures",
        expect: `/18,705|[\\d,]{4,}/.test(document.body.innerText) ? '' : 'no lifetime numbers'`,
      },
      {
        click: [".segfull button", "^Sequence$"],
        settle: 600,
        name: "the sequence shows the emails as written, spintax included",
        expect: `document.querySelectorAll('pre').length ? '' : 'no email body rendered'`,
      },
      {
        click: [".segfull button", "^Copy & Offer$"],
        settle: 1200,
        name: "the seven copy dimensions are editable inputs with known-value lists",
        expect: `(() => {
          const root = document.querySelector('section.screen.on');
          const inputs = root.querySelectorAll('input[list^=known-]').length;
          const lists = root.querySelectorAll('datalist').length;
          return inputs === 7 && lists === 7 ? '' : inputs + ' inputs, ' + lists + ' datalists';
        })()`,
      },
      {
        click: [".segfull button", "^Settings$"],
        settle: 500,
        name: "settings fields are writable, not read-only",
        expect: `(() => {
          const root = document.querySelector('section.screen.on');
          const inputs = [...root.querySelectorAll('input')];
          const editable = inputs.filter(i => !i.disabled && !i.readOnly).length;
          const boxes = inputs.filter(i => i.type === 'checkbox').length;
          return editable >= 6 && boxes === 4 ? '' : editable + ' editable, ' + boxes + ' checkboxes';
        })()`,
      },
      {
        name: "Save is disabled until something changes",
        expect: `(() => {
          const b = [...document.querySelectorAll('section.screen.on button')].find(x => /Save changes/.test(x.textContent));
          return b && b.disabled ? '' : 'Save is not gated on a change';
        })()`,
      },
      {
        click: [".segfull button", "^Activity$"],
        settle: 500,
        name: "the activity log renders",
        expect: `/Every change this workspace/.test(document.body.innerText) ? '' : 'no activity panel'`,
      },
    ],
  },
  {
    path: `${P}/schedule`,
    label: "Schedule",
    ready: `[...document.querySelectorAll('.card .card-n')].every(e => e.textContent.trim() && e.textContent.trim() !== '…') && document.querySelectorAll('.abox').length > 0`,
    steps: [
      {
        name: "all three days load their own total",
        expect: `(() => {
          const n = [...document.querySelectorAll('.card .card-n')].map(e => e.textContent.trim());
          return n.length >= 3 && n.every(x => x && x !== '…') ? '' : 'day totals: ' + n.join(' | ');
        })()`,
      },
      {
        click: [".card", "Tomorrow"],
        settle: 1800,
        name: "picking a day changes the client cards",
        /*
         * A day with nothing scheduled must show the empty state, not cards —
         * and which day that is depends on when the suite runs. This used to
         * assert `.abox > 0` unconditionally, so it passed midweek and failed
         * every Friday and Saturday, when tomorrow is a weekend and EmailBison
         * has no sends at all. That is correct product behaviour being
         * reported as a regression.
         *
         * So assert against the day's own total: campaigns > 0 means cards,
         * 0 means the "Nothing is scheduled to send" copy. Both are passes;
         * a blank pane with neither is the real failure.
         */
        expect: `(() => {
          const card = [...document.querySelectorAll('.card')].find(c => /Tomorrow/.test(c.innerText));
          const n = Number((card?.innerText.match(/([\\d,]+)\\s+campaigns/) || [0, '0'])[1].replace(/,/g, ''));
          const boxes = document.querySelectorAll('.abox').length;
          const empty = /Nothing is scheduled to send/.test(document.body.innerText);
          if (n > 0) return boxes > 0 ? '' : 'day has ' + n + ' campaigns but no client cards';
          return empty ? '' : 'day is empty but no empty-state message';
        })()`,
      },
    ],
  },
  {
    path: `${P}/clients`,
    label: "Clients",
    ready: `document.querySelectorAll('.atbl tbody tr').length > 20`,
    steps: [
      {
        name: "the unassigned queue is above the roster",
        expect: `(() => {
          const t = document.body.innerText;
          if (!/campaigns? with no client|Every campaign has a client/.test(t)) return 'no queue section';
          return '';
        })()`,
      },
      {
        click: ["button", "^Edit$"],
        settle: 900,
        name: "Edit opens a real form with a delete that arms before firing",
        expect: `(() => {
          const root = document.querySelector('section.screen.on');
          const del = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete');
          if (!del) return 'no Delete button';
          if (!/return to the unassigned queue/i.test(del.title)) return 'Delete does not state the consequence';
          const inputs = root.querySelectorAll('input.inp').length;
          return inputs >= 2 ? '' : 'the form has ' + inputs + ' inputs';
        })()`,
      },
      {
        name: "the reply-breakdown toggles are real checkboxes",
        expect: `document.querySelectorAll('section.screen.on input[type=checkbox]').length >= 6
          ? '' : 'only ' + document.querySelectorAll('section.screen.on input[type=checkbox]').length + ' toggles'`,
      },
      { click: ["button", "^Cancel$"], settle: 400 },
    ],
  },
];

const cookie = await token();
let fail = 0;
let stepFail = 0;

for (const s of SCREENS) {
  const tab = await Tab.open();
  const errors = [], netFails = [], aborted = [];
  const reqUrl = new Map();
  tab.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    if (m.method === "Runtime.exceptionThrown")
      errors.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
    if (m.method === "Network.requestWillBeSent") reqUrl.set(m.params.requestId, m.params.request.url);
    if (m.method === "Network.loadingFailed") {
      // ERR_ABORTED is a CANCELLED request, not a failed one — Next cancels
      // in-flight prefetches when a navigation supersedes them.
      const t = m.params.errorText || "";
      const url = (reqUrl.get(m.params.requestId) || "").replace(BASE, "");
      if (/ERR_ABORTED/.test(t)) aborted.push(url || t);
      else netFails.push(`${t} ${url}`);
    }
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
      netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  });
  await tab.send("Runtime.enable");
  await tab.send("Network.enable");
  await tab.send("Page.enable");
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await tab.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });

  const t0 = Date.now();
  await tab.send("Page.navigate", { url: BASE + s.path });

  // Wait for real data rather than a fixed sleep — a timer either flakes or
  // wastes seconds, and neither tells you when the screen was ready.
  let ready = false;
  for (let i = 0; i < 250; i++) {
    await wait(100);
    if ((await tab.eval("document.readyState")) !== "complete") continue;
    if (await tab.eval(s.ready)) { ready = true; break; }
  }
  const count = (await tab.eval("document.querySelectorAll('section.screen.on *').length")) ?? 0;
  const ms = Date.now() - t0;
  const bodyLen = await tab.eval("document.body.innerText.length");

  const ok = ready && errors.length === 0 && netFails.length === 0;
  if (!ok) fail++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${s.label.padEnd(16)} ${String(ms).padStart(5)}ms  ${String(count).padStart(4)} nodes  ${bodyLen} chars`,
  );
  for (const e of [...new Set(errors)].slice(0, 4)) console.log(`      console: ${e}`);
  for (const n of [...new Set(netFails)].slice(0, 4)) console.log(`      network: ${n}`);
  if (aborted.length) console.log(`      (${aborted.length} cancelled request(s), not failures)`);
  if (!ready) console.log(`      never became ready: ${s.ready}`);

  for (const step of s.steps ?? []) {
    if (step.click) {
      const hit = await tab.click(step.click[0], step.click[1]);
      if (!hit) {
        stepFail++;
        console.log(`      ✗ could not find ${step.click[1] ?? ""} ${step.click[0]}`);
        continue;
      }
      await wait(step.settle ?? 400);
    }
    if (!step.expect) continue;
    /*
     * Assertions RETRY for six seconds.
     *
     * Every one of these presses starts a fetch, and "the data has not landed
     * yet" is a different fact from "the control did nothing". A single
     * evaluation conflated them and reported three working screens as broken.
     * Six seconds is longer than the slowest route here (2.4s cold) and short
     * enough that a genuinely dead control still fails the run.
     */
    let verdict = "not evaluated";
    for (let i = 0; i < 30; i++) {
      try {
        verdict = await tab.eval(step.expect);
      } catch (e) {
        verdict = `threw: ${e.message}`;
      }
      if (verdict === "") break;
      await wait(200);
    }
    if (verdict === "") {
      console.log(`      ✓ ${step.name}`);
    } else {
      stepFail++;
      console.log(`      ✗ ${step.name} — ${verdict}`);
    }
  }

  await tab.close();
}

console.log(`\n  ${SCREENS.length - fail}/${SCREENS.length} screens clean · ${stepFail} failed interaction${stepFail === 1 ? "" : "s"}`);
process.exit(fail || stepFail ? 1 : 0);
