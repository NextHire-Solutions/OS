/*
 * Drives every control on the eight Master Inbox settings tabs in a real
 * Chrome, over the DevTools Protocol.
 *
 *   node scripts/settings-ui-test.mjs [baseUrl]
 *
 * Chrome must be listening on 9451 and the app on 3370:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9451 --user-data-dir=<tmp> \
 *     --no-first-run --disable-gpu --window-size=1440,900
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The settings panels were rebuilt in the mockup's visual language. Every one
 * of them is the only way to administer some part of the inbox, so the only
 * acceptable evidence that nothing was dropped is a control being CLICKED and
 * its effect observed — not a diff that looks conservative. Creating a label
 * from settings was silently broken for a day once already, because a route
 * shadowed another and nothing here was driving it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
 *
 * It creates its own records, named with a run id, and deletes them again:
 * one label, one template (in its own category), one reply agent, one client.
 * Every one is checked for removal against the SERVER, by reloading the page,
 * not against local state.
 *
 * It deliberately does NOT fire:
 *   · the AI backfill        — spends the workspace's API credits
 *   · "Clear" the AI key     — destroys a saved secret
 *   · the member invite      — creates a real Supabase auth user, which this
 *                              test cannot clean up
 *   · a password reset       — changes a real teammate's credentials
 *   · a change of own password — locks this session out
 *
 * For each of those, the ARMING step and the client-side guards are driven, so
 * the control is proven live right up to the point of consequence.
 *
 * The one exception is AI labelling's Save, which is pressed after every field
 * has been put back to the value it was read with — a genuine round trip that
 * leaves the config byte-identical.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3370";
const CDP = "http://localhost:9451";
const RUN = `zz-mis-${Date.now().toString(36)}`;
const SHOTS = process.env.SETTINGS_SHOTS || "";

/* ─────────────────────────────────────────────────────────── the driver */

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
  #ws;
  #id = 0;
  #pending = new Map();
  #handlers = [];
  static async open() {
    const t = new Tab();
    const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    t.targetId = target.id;
    t.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => {
      t.#ws.onopen = ok;
      t.#ws.onerror = no;
    });
    t.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && t.#pending.has(m.id)) {
        t.#pending.get(m.id)(m);
        t.#pending.delete(m.id);
      } else if (m.method) for (const h of t.#handlers) h(m);
    };
    /*
     * If the socket goes, every waiting call has to FAIL rather than hang.
     * Node exits a hung top-level await with "unsettled top-level await" and no
     * report at all — the run's results are lost along with the reason.
     */
    t.#ws.onclose = () => {
      for (const [, resolve] of t.#pending) {
        resolve({ error: { message: "the DevTools socket closed mid-call" } });
      }
      t.#pending.clear();
    };
    return t;
  }
  on(fn) {
    this.#handlers.push(fn);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result),
      );
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result?.value;
  }
  async close() {
    this.#ws.close();
    await fetch(`${CDP}/json/close/${this.targetId}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────── page helpers */

/*
 * A React-controlled input does not notice `el.value = x`: React installed its
 * own value setter on the instance, so assigning through it never reaches the
 * component's state and the very next render puts the old text back. Calling
 * the PROTOTYPE setter and then dispatching `input` is the way in — the same
 * trick React's own test utilities use.
 */
const SET_VALUE = `
  (sel, value, tag) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element for ' + sel);
    const proto = tag === 'select' ? window.HTMLSelectElement.prototype
                : tag === 'textarea' ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }
`;

function page(tab) {
  const ev = (x) => tab.eval(x);
  const q = (sel) => JSON.stringify(sel);

  return {
    ev,
    /*
     * Navigate, and be sure it is the NEW document being looked at.
     *
     * Waiting only for `readyState === 'complete'` plus a selector is a trap:
     * for the first fraction of a second the OLD document still satisfies both,
     * so a check runs against the page you just left. That is not theoretical —
     * it made "the deleted label is gone from the server" fail while the label
     * really had been deleted, because the assertion read the pre-navigation
     * DOM. Stamping the outgoing document and waiting for the stamp to be gone
     * removes the race entirely.
     */
    async goto(path, ready = ".mis") {
      await ev("window.__misStale = 1").catch(() => {});
      await tab.send("Page.navigate", { url: BASE + path });
      await this.waitFor(
        `!window.__misStale && document.readyState === 'complete' && !!document.querySelector(${q(ready)})`,
        30000,
        `navigation to ${path}`,
      );
      // React hydration: the page paints server HTML before its handlers are
      // attached, and a click landing in that window does nothing at all.
      await sleep(700);
    },
    async waitFor(expr, timeout = 12000, label = expr) {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try {
          v = await ev(`(() => { try { return !!(${expr}); } catch { return false; } })()`);
        } catch {
          v = false;
        }
        if (v) return true;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`);
        await sleep(120);
      }
    },
    count: (sel) => ev(`document.querySelectorAll(${q(sel)}).length`),
    text: (sel) => ev(`(document.querySelector(${q(sel)})?.innerText ?? '').trim()`),
    val: (sel) => ev(`document.querySelector(${q(sel)})?.value ?? null`),
    attr: (sel, a) => ev(`document.querySelector(${q(sel)})?.getAttribute(${JSON.stringify(a)}) ?? null`),
    cls: (sel) => ev(`document.querySelector(${q(sel)})?.className ?? null`),
    exists: (sel) => ev(`!!document.querySelector(${q(sel)})`),
    disabled: (sel) => ev(`!!document.querySelector(${q(sel)})?.disabled`),
    async click(sel) {
      const ok = await ev(
        `(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (!ok) throw new Error(`nothing to click: ${sel}`);
      await sleep(220);
    },
    /** Click the nth match — table rows need this. */
    async clickNth(sel, n) {
      const ok = await ev(
        `(() => { const els = document.querySelectorAll(${q(sel)}); if (!els[${n}]) return false; els[${n}].click(); return true; })()`,
      );
      if (!ok) throw new Error(`nothing to click: ${sel}[${n}]`);
      await sleep(220);
    },
    type: (sel, value) => ev(`(${SET_VALUE})(${q(sel)}, ${JSON.stringify(value)}, 'input')`),
    select: (sel, value) => ev(`(${SET_VALUE})(${q(sel)}, ${JSON.stringify(value)}, 'select')`),
    textarea: (sel, value) => ev(`(${SET_VALUE})(${q(sel)}, ${JSON.stringify(value)}, 'textarea')`),
    async press(sel, key) {
      await ev(`(() => {
        const el = document.querySelector(${q(sel)});
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      })()`);
      await sleep(200);
    },
    /** Type into a contenteditable (TipTap) the way a keyboard would. */
    async typeRich(text) {
      await ev(`document.querySelector('.mis-ed .tiptap').focus()`);
      await tab.send("Input.insertText", { text });
      await sleep(200);
    },
    async shoot(name) {
      if (!SHOTS) return;
      const s = await tab.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(s.result ? s.result.data : s.data, "base64"));
    },
    /** The whole page's text, for a coarse "is this copy still here" check. */
    body: () => ev("document.body.innerText"),
    toast: () => ev(`(document.querySelector('[data-mis-toast]')?.innerText ?? '').trim()`),
  };
}

/* ───────────────────────────────────────────────────────────── reporting */

const results = [];
let currentTab = "";
function check(id, label, pass, detail = "") {
  results.push({ tab: currentTab, id, label, pass: Boolean(pass), detail });
  const mark = pass ? "✓" : "✗";
  console.log(`    ${mark} ${id.padEnd(5)} ${label}${detail ? `  — ${detail}` : ""}`);
}
function section(name) {
  currentTab = name;
  console.log(`\n  ${name}`);
}

/* ─────────────────────────────────────────────────────────────── the run */

const cookie = await token();
const tab = await Tab.open();
const consoleErrors = [];
const netFails = [];
tab.on((m) => {
  // Tagged with the section that was running, so a console error can be traced
  // to a screen rather than to "somewhere in a four-minute run".
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(
      `[${currentTab || "startup"}] ` +
        m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200),
    );
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      `[${currentTab || "startup"}] EXCEPTION ` +
        (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200),
    );
  }
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
    netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  }
});
await tab.send("Runtime.enable");
await tab.send("Network.enable");
await tab.send("Page.enable");
await tab.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 950,
  deviceScaleFactor: 1,
  mobile: false,
});
await tab.send("Network.setCookie", {
  name: "bs_sso",
  value: cookie,
  domain: "localhost",
  path: "/",
});

const p = page(tab);
const created = { labels: [], templates: [], agents: [], clients: [] };

console.log(`\n  Master Inbox · settings — driving every control`);
console.log(`  base ${BASE}   chrome ${CDP}   run id ${RUN}\n`);

try {
  /* ══════════════════════════════════════════════════ 0 · the tab strip */
  section("0 · Tab strip");
  await p.goto("/inbox/settings/labels");
  check("0.1", "three tabs render as the design's pills (admin)", (await p.count(".mi-settings-tabs .fp")) === 3);
  check("0.1b", "the active tab carries .on", (await p.text(".mi-settings-tabs .fp.on")) === "Labels");
  const tabHrefs = await p.ev(
    `Array.from(document.querySelectorAll('.mi-settings-tabs .fp')).map(a => a.getAttribute('href')).join(',')`,
  );
  check(
    "0.1c",
    "each tab links to its own URL",
    tabHrefs ===
      [
        "labels",
        "templates",
        "ai-labeling",
      ]
        .map((t) => `/inbox/settings/${t}`)
        .join(","),
    tabHrefs,
  );
  await p.goto("/inbox/settings/not-a-real-tab");
  check("0.2", "an unknown tab falls back to Labels", (await p.text(".mi-settings-tabs .fp.on")) === "Labels");

  /* ═════════════════════════════════════════════════════════ 1 · Labels */
  section("1 · Labels");
  await p.goto("/inbox/settings/labels");
  await p.shoot("01-labels");

  const heads = await p.ev(
    `Array.from(document.querySelectorAll('.mis .atbl thead th')).map(th => th.innerText.trim()).join('|')`,
  );
  check("1.3-7", "table keeps all five columns", heads === "Label|Sentiment|Platform|Obligation|Source|", heads);

  const labelRows = await p.count(".mis .atbl tbody tr[data-mis-label]");
  check("1.3", "labels render", labelRows > 0, `${labelRows} rows`);
  const sources = await p.body();
  check("1.7", "System / Custom source column", sources.includes("System") && sources.includes("Custom"));

  await p.type('.mis-find input[name="label_search"]', "interest");
  await sleep(300);
  const filtered = await p.count(".mis .atbl tbody tr[data-mis-label]");
  check("1.1", "search filters the list", filtered > 0 && filtered < labelRows, `${labelRows} → ${filtered}`);
  await p.type('.mis-find input[name="label_search"]', "zzzz-no-such-label");
  await sleep(300);
  check("1.10", "empty state when nothing matches", (await p.body()).includes("No labels match."));
  await p.type('.mis-find input[name="label_search"]', "");
  await sleep(300);

  // A system label offers no delete; a custom one does.
  const systemHasDelete = await p.ev(`(() => {
    for (const tr of document.querySelectorAll('.mis .atbl tbody tr[data-mis-label]')) {
      const cells = tr.querySelectorAll('td');
      if (cells[4] && cells[4].innerText.trim() === 'System') {
        return tr.querySelectorAll('.mis-cell-a button').length;
      }
    }
    return -1;
  })()`);
  check("1.9a", "a system label has edit only, no delete", systemHasDelete === 1, `${systemHasDelete} button(s)`);

  // ── create ────────────────────────────────────────────────────────────
  const LABEL = `${RUN}-label`;
  await p.click('[data-mis="create-label"]');
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000, "create dialog");
  check("1.2", "Create label opens the dialog", (await p.text('[data-slot="dialog-title"]')) === "Create label");

  await p.type('[data-slot="dialog-content"] input[aria-label="Label name"]', LABEL);
  await p.click('[data-slot="dialog-content"] .mis-sw button[aria-label="green"]');
  check(
    "1.12",
    "colour swatch records the choice",
    (await p.attr('[data-slot="dialog-content"] .mis-sw button[aria-label="green"]', "aria-pressed")) === "true",
  );
  const previewCls = await p.cls('[data-slot="dialog-content"] .mis-prev .lc');
  const previewTxt = await p.text('[data-slot="dialog-content"] .mis-prev .lc');
  check("1.13", "preview chip follows name + colour", previewCls?.includes("lc-green") && previewTxt === LABEL, previewCls);

  await p.select('[data-slot="dialog-content"] select[aria-label="Sentiment"]', "positive");
  await p.select('[data-slot="dialog-content"] select[aria-label="Platform"]', "email");
  await p.click('[data-slot="dialog-content"] [aria-label="Obligation"]');
  await p.click('[data-slot="dialog-content"] [aria-label="Mirror to EmailBison"]');
  const oblOn = await p.attr('[data-slot="dialog-content"] [aria-label="Obligation"]', "data-checked");
  const mirOn = await p.attr('[data-slot="dialog-content"] [aria-label="Mirror to EmailBison"]', "data-checked");
  check("1.16", "obligation switch flips", oblOn !== null);
  check("1.17", "EmailBison mirror switch flips", mirOn !== null);
  await p.shoot("02-label-dialog");

  await p.click('[data-slot="dialog-footer"] button:last-child');
  await p.waitFor(`!document.querySelector('[data-slot="dialog-content"]')`, 10000, "dialog closes");
  await p.waitFor(`document.querySelector('[data-mis-label="${LABEL}"]')`, 10000, "new row");
  created.labels.push(LABEL);
  check("1.11/1.20", "create writes the label", await p.exists(`[data-mis-label="${LABEL}"]`));
  const toastText = await p.toast();
  check("1.20b", "the write is confirmed on screen", toastText.includes(LABEL), toastText);

  const rowCells = await p.ev(
    `Array.from(document.querySelector('[data-mis-label="${LABEL}"]').querySelectorAll('td')).map(td => td.innerText.trim()).join('|')`,
  );
  /*
   * Compared case-insensitively on purpose: the design capitalises these
   * columns with `text-transform`, and `innerText` reports what is PAINTED,
   * not what is in the DOM. The value the API stores is the lowercase one.
   */
  check(
    "1.14/1.15",
    "sentiment + platform + obligation + source landed",
    rowCells.toLowerCase().startsWith(`${LABEL}|positive|email|yes|custom`),
    rowCells,
  );

  /*
   * Server truth, not local state — and it needs patience.
   *
   * `loadLabels` is `cache(ttlCache(fetchLabels, { ttlMs: 30_000 }))`, so the
   * settings page can serve a label list up to thirty seconds old. That is
   * why this panel keeps optimistic local state at all. A reload inside that
   * window legitimately shows the pre-change list, so a server-truth check has
   * to reload until the cache turns over rather than assert once and call the
   * feature broken. (Pre-existing behaviour, in a file this work does not own —
   * reported rather than changed.)
   */
  const serverShows = async (selector, want, label) => {
    const t0 = Date.now();
    for (;;) {
      await p.goto("/inbox/settings/labels");
      const has = await p.exists(selector);
      if (has === want) return true;
      if (Date.now() - t0 > 45000) return false;
      await sleep(3000);
    }
  };
  check("1.20c", "the label survives a reload", await serverShows(`[data-mis-label="${LABEL}"]`, true));

  // ── cancel does not write ─────────────────────────────────────────────
  await p.click('[data-mis="create-label"]');
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000);
  await p.type('[data-slot="dialog-content"] input[aria-label="Label name"]', `${RUN}-cancelled`);
  await p.click('[data-slot="dialog-footer"] button:first-child');
  await p.waitFor(`!document.querySelector('[data-slot="dialog-content"]')`, 8000);
  check("1.19", "Cancel closes without writing", !(await p.exists(`[data-mis-label="${RUN}-cancelled"]`)));

  // ── edit ──────────────────────────────────────────────────────────────
  await p.click(`[data-mis-label="${LABEL}"] .mis-cell-a button[aria-label^="Edit"]`);
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000);
  check("1.8", "Edit opens the dialog", (await p.text('[data-slot="dialog-title"]')) === "Edit label");
  const preName = await p.val('[data-slot="dialog-content"] input[aria-label="Label name"]');
  const preSent = await p.val('[data-slot="dialog-content"] select[aria-label="Sentiment"]');
  const prePlat = await p.val('[data-slot="dialog-content"] select[aria-label="Platform"]');
  const preGreen = await p.attr('[data-slot="dialog-content"] .mis-sw button[aria-label="green"]', "aria-pressed");
  check(
    "1.8b",
    "every field is pre-filled",
    preName === LABEL && preSent === "positive" && prePlat === "email" && preGreen === "true",
    `${preName} / ${preSent} / ${prePlat} / green=${preGreen}`,
  );

  const LABEL2 = `${LABEL}-edited`;
  await p.type('[data-slot="dialog-content"] input[aria-label="Label name"]', LABEL2);
  await p.click('[data-slot="dialog-content"] .mis-sw button[aria-label="blue"]');
  await p.select('[data-slot="dialog-content"] select[aria-label="Sentiment"]', "neutral");
  await p.select('[data-slot="dialog-content"] select[aria-label="Platform"]', "both");
  await p.click('[data-slot="dialog-content"] [aria-label="Obligation"]');
  await p.click('[data-slot="dialog-footer"] button:last-child');
  await p.waitFor(`!document.querySelector('[data-slot="dialog-content"]')`, 10000);
  await p.waitFor(`document.querySelector('[data-mis-label="${LABEL2}"]')`, 10000);
  created.labels[0] = LABEL2;
  const edited = await p.ev(
    `Array.from(document.querySelector('[data-mis-label="${LABEL2}"]').querySelectorAll('td')).map(td => td.innerText.trim()).join('|')`,
  );
  const editedChip = await p.cls(`[data-mis-label="${LABEL2}"] .lc`);
  check(
    "1.20d",
    "edit rewrites name, colour, sentiment, platform and obligation",
    edited.toLowerCase().startsWith(`${LABEL2}|neutral|both|no|custom`) && editedChip.includes("lc-blue"),
    `${edited} · ${editedChip}`,
  );

  // ── delete, via arm-then-fire ─────────────────────────────────────────
  // Same 30s cache: reload until the renamed row is the one the server serves.
  check("1.20e", "the rename reaches the server", await serverShows(`[data-mis-label="${LABEL2}"]`, true));
  const armSel = `[data-mis-label="${LABEL2}"] .mis-cell-a button[data-armed]`;
  await p.click(armSel);
  const armedLabel = await p.text(`[data-mis-label="${LABEL2}"] .mis-cell-a button[data-armed="true"]`);
  check("1.9b", "delete arms on the first click", armedLabel === "Confirm delete", armedLabel);
  await p.click(`[data-mis-label="${LABEL2}"] .mis-cell-a button[data-armed="true"]`);
  /*
   * Wait for the CONFIRMATION, not for the row to vanish.
   *
   * This panel removes the row optimistically and only then sends the DELETE.
   * Navigating as soon as the row disappeared cancelled the request in flight,
   * and the label was still on the server on the next page — which read as a
   * broken delete when the delete was fine and the test was too quick.
   */
  await p.waitFor(`/Deleted/.test(document.querySelector('[data-mis-toast]')?.innerText ?? '')`, 12000, "delete confirmed");
  check("1.9c", "the second click deletes it", !(await p.exists(`[data-mis-label="${LABEL2}"]`)));
  const goneLabel = await serverShows(`[data-mis-label="${LABEL2}"]`, false);
  check("1.9d", "and it is gone from the server", goneLabel);
  if (goneLabel) created.labels = [];

  /* ══════════════════════════════════════════════════════ 2 · Templates */
  section("2 · Templates");
  await p.goto("/inbox/settings/templates");
  await p.shoot("03-templates");

  const tplCount = await p.text(".mis-bar .mis-count");
  check("2.2", "count line reads N of M", /^\d+ of \d+ templates?$/.test(tplCount), tplCount);
  const cats = await p.count(".mis .mis-cat");
  check("2.4", "templates are grouped into categories", cats > 0, `${cats} categories`);

  // collapse / expand
  const rowsBefore = await p.count(".mis .mis-row[data-mis-template]");
  await p.clickNth(".mis .mis-cat", 0);
  const rowsCollapsed = await p.count(".mis .mis-row[data-mis-template]");
  check("2.5", "a category collapses", rowsCollapsed < rowsBefore, `${rowsBefore} → ${rowsCollapsed}`);
  await p.clickNth(".mis .mis-cat", 0);
  check("2.5b", "and expands again", (await p.count(".mis .mis-row[data-mis-template]")) === rowsBefore);

  await p.type('.mis-find input[name="template_search"]', "zzzz-no-such-template");
  await sleep(350);
  check("2.11", "no-match state", (await p.body()).includes("No templates match"));
  await p.type('.mis-find input[name="template_search"]', "");
  await sleep(350);
  const searchable = await p.ev(
    `document.querySelector('.mis .mis-row[data-mis-template]')?.getAttribute('data-mis-template') ?? ''`,
  );
  await p.type('.mis-find input[name="template_search"]', searchable.slice(0, 6));
  await sleep(350);
  const afterSearch = await p.count(".mis .mis-row[data-mis-template]");
  check("2.1", "search narrows the list", afterSearch > 0 && afterSearch < rowsBefore, `${rowsBefore} → ${afterSearch}`);
  await p.type('.mis-find input[name="template_search"]', "");
  await sleep(350);

  // ── create, with the whole editor ─────────────────────────────────────
  const TPL = `${RUN}-template`;
  const TPL_CAT = `${RUN}-category`;
  await p.click('[data-mis="new-template"]');
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000);
  check("2.3", "New template opens the editor", (await p.text('[data-slot="dialog-title"]')) === "New template");

  const datalistOptions = await p.count("#template-category-options option");
  check("2.13", "existing categories are offered as a datalist", datalistOptions > 0, `${datalistOptions} options`);

  await p.type('[data-slot="dialog-content"] input[aria-label="Template name"]', TPL);
  await p.type('[data-slot="dialog-content"] input[aria-label="Template category"]', TPL_CAT);
  await p.type('[data-slot="dialog-content"] input[aria-label="Template subject"]', `${RUN} subject`);
  await p.type('[data-slot="dialog-content"] input[aria-label="Template CC"]', "cc@example.com");
  await p.type('[data-slot="dialog-content"] input[aria-label="Template BCC"]', "bcc@example.com");

  await p.waitFor(`document.querySelector('.mis-ed .tiptap')`, 15000, "rich editor loads");
  await p.typeRich("Hello ");

  // bold
  await p.click('.mis-ed-t button[aria-label="Bold (⌘B)"]');
  check("2.19", "Bold reports itself pressed", (await p.attr('.mis-ed-t button[aria-label="Bold (⌘B)"]', "aria-pressed")) === "true");
  await p.typeRich("bold");
  await p.click('.mis-ed-t button[aria-label="Bold (⌘B)"]');

  // italic / underline / strike
  for (const [id, label, tag] of [
    ["2.19b", "Italic (⌘I)", "em"],
    ["2.19c", "Underline (⌘U)", "u"],
    ["2.19d", "Strikethrough", "s"],
  ]) {
    await p.click(`.mis-ed-t button[aria-label="${label}"]`);
    await p.typeRich(` ${tag}`);
    await p.click(`.mis-ed-t button[aria-label="${label}"]`);
    const html = await p.ev(`document.querySelector('.mis-ed .tiptap').innerHTML`);
    check(id, `${label} writes a <${tag}>`, html.includes(`<${tag}>`), "");
  }

  // heading + lists
  await p.click('.mis-ed-t button[aria-label="Heading"]');
  await p.typeRich(" heading");
  check("2.18", "Heading makes an H2", (await p.ev(`document.querySelector('.mis-ed .tiptap').innerHTML`)).includes("<h2"));
  await p.click('.mis-ed-t button[aria-label="Heading"]');

  await p.click('.mis-ed-t button[aria-label="Bulleted list"]');
  await p.typeRich("one");
  check("2.20", "Bulleted list makes a <ul>", (await p.ev(`document.querySelector('.mis-ed .tiptap').innerHTML`)).includes("<ul"));
  await p.click('.mis-ed-t button[aria-label="Bulleted list"]');
  await p.click('.mis-ed-t button[aria-label="Numbered list"]');
  await p.typeRich("two");
  check("2.20b", "Numbered list makes an <ol>", (await p.ev(`document.querySelector('.mis-ed .tiptap').innerHTML`)).includes("<ol"));
  await p.click('.mis-ed-t button[aria-label="Numbered list"]');

  // insert variable
  await p.click(".mis-ed-t .mis-ed-v");
  await p.waitFor(`document.querySelector('[data-slot="dropdown-menu-content"]')`, 6000, "variable menu");
  const varCount = await p.count('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-item"]');
  check("2.17", "the variable menu lists the template variables", varCount > 3, `${varCount} variables`);
  const firstVar = await p.text('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-item"] code');
  await p.clickNth('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-item"]', 0);
  await sleep(350);
  const editorText = await p.ev(`document.querySelector('.mis-ed .tiptap').innerText`);
  check("2.17b", "picking one inserts it at the caret", editorText.includes(firstVar), firstVar);

  // link
  await p.typeRich(" linkme");
  await p.click('.mis-ed-t button[aria-label="Add / edit link"]');
  await p.waitFor(
    `Array.from(document.querySelectorAll('[data-slot="dialog-title"]')).some(t => /link/i.test(t.innerText))`,
    8000,
    "link dialog",
  );
  const linkInputs = await p.ev(
    `Array.from(document.querySelectorAll('[data-slot="dialog-content"] input')).length`,
  );
  check("2.21", "the link dialog offers text and URL", linkInputs >= 2, `${linkInputs} inputs`);
  await p.ev(`(() => {
    const dlgs = document.querySelectorAll('[data-slot="dialog-content"]');
    const dlg = dlgs[dlgs.length - 1];
    const ins = dlg.querySelectorAll('input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(ins[0], 'BrokerStaffer');
    ins[0].dispatchEvent(new Event('input', { bubbles: true }));
    set.call(ins[1], 'https://example.com/mis-test');
    ins[1].dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await p.ev(`(() => {
    const dlgs = document.querySelectorAll('[data-slot="dialog-content"]');
    const dlg = dlgs[dlgs.length - 1];
    const btns = Array.from(dlg.querySelectorAll('button'));
    const save = btns.reverse().find(b => /save|add|insert|apply/i.test(b.innerText));
    (save ?? btns[0]).click();
  })()`);
  await sleep(500);
  const linkHtml = await p.ev(`document.querySelector('.mis-ed .tiptap').innerHTML`);
  check("2.21b", "the link lands in the body", linkHtml.includes("example.com/mis-test"), "");

  await p.shoot("04-template-editor");
  await p.click('[data-slot="dialog-content"] [data-slot="dialog-footer"] button:last-child');
  await p.waitFor(`!document.querySelector('[data-slot="dialog-content"]')`, 15000, "editor closes");
  await p.waitFor(`document.querySelector('[data-mis-template="${TPL}"]')`, 15000, "new template row");
  created.templates.push(TPL);
  check("2.12/2.23", "the template is written", await p.exists(`[data-mis-template="${TPL}"]`));

  await p.goto("/inbox/settings/templates");
  const rowText = await p.text(`[data-mis-template="${TPL}"]`);
  check("2.22", "body, subject, CC and BCC all persisted",
    rowText.includes("bold") && rowText.includes(`${RUN} subject`) &&
    rowText.includes("cc@example.com") && rowText.includes("bcc@example.com"),
    rowText.replace(/\n/g, " · ").slice(0, 120));
  check("2.13b", "its new category became a section", (await p.body()).includes(TPL_CAT));

  // ── edit ──────────────────────────────────────────────────────────────
  const TPL2 = `${TPL}-edited`;
  await p.click(`[data-mis-template="${TPL}"] button[aria-label^="Edit"]`);
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000);
  const tplPre = await p.val('[data-slot="dialog-content"] input[aria-label="Template name"]');
  check("2.8", "Edit pre-fills the template", tplPre === TPL, tplPre);
  await p.type('[data-slot="dialog-content"] input[aria-label="Template name"]', TPL2);
  await p.click('[data-slot="dialog-content"] [data-slot="dialog-footer"] button:last-child');
  await p.waitFor(`document.querySelector('[data-mis-template="${TPL2}"]')`, 15000);
  created.templates[0] = TPL2;
  check("2.8b", "the edit is saved", await p.exists(`[data-mis-template="${TPL2}"]`));

  // ── delete, via its own dialog ────────────────────────────────────────
  await p.click(`[data-mis-template="${TPL2}"] button[aria-label^="Delete"]`);
  await p.waitFor(`document.querySelector('[data-slot="dialog-content"]')`, 8000, "delete dialog");
  const delTitle = await p.text('[data-slot="dialog-title"]');
  check("2.24", "the delete dialog names the template", delTitle.includes(TPL2), delTitle);
  check("2.24b", "and states the blast radius", (await p.body()).includes("removed for everyone in the workspace"));
  await p.click('[data-mis="confirm-delete-template"]');
  await p.waitFor(`!document.querySelector('[data-mis-template="${TPL2}"]')`, 15000);
  await p.goto("/inbox/settings/templates");
  const goneTpl = !(await p.exists(`[data-mis-template="${TPL2}"]`));
  check("2.9", "the template is deleted on the server", goneTpl);
  if (goneTpl) created.templates = [];

  /* 3 · Reply agents moved to Admin → Reply agent on 9 Oct (scripts/reply-agent-ui-test.mjs). */

  /* ═══════════════════════════════════════════════════ 4 · AI labelling */
  section("4 · AI labelling");
  await p.goto("/inbox/settings/ai-labeling");
  await p.shoot("07-ai");

  /*
   * The AI config is a SINGLETON, not a record this test can create. So every
   * control is driven and then put back to the value it was read with, and the
   * single Save at the end is a round trip that writes the same config it
   * found. Nothing a member of staff configured changes.
   */
  const before = await p.ev(`(() => ({
    enabled: !!document.querySelector('[aria-label="Enable AI labelling"]')?.getAttribute('data-checked') !== false && document.querySelector('[aria-label="Enable AI labelling"]')?.getAttribute('aria-checked'),
    relabel: document.querySelector('[aria-label="Re-label ongoing replies"]')?.getAttribute('aria-checked'),
    backfill: document.querySelector('[aria-label="Include in historical backfill"]')?.getAttribute('aria-checked'),
    prompt: document.querySelector('[aria-label="Use a custom prompt"]')?.getAttribute('aria-checked'),
    provider: document.querySelector('select[aria-label="Provider"]')?.value,
    model: document.querySelector('select[aria-label="Model"]')?.value,
    chips: document.querySelectorAll('.mis-chips button[aria-pressed="true"]').length,
    counter: document.querySelector('.mis-h-row .mis-count')?.innerText,
  }))()`);

  for (const [id, label] of [
    ["4.1", "Enable AI labelling"],
    ["4.8", "Re-label ongoing replies"],
    ["4.9", "Include in historical backfill"],
  ]) {
    const was = await p.attr(`[aria-label="${label}"]`, "aria-checked");
    await p.click(`[aria-label="${label}"]`);
    const now = await p.attr(`[aria-label="${label}"]`, "aria-checked");
    check(id, `${label} toggles`, was !== now, `${was} → ${now}`);
    await p.click(`[aria-label="${label}"]`); // put it back
  }

  const promptWas = await p.attr('[aria-label="Use a custom prompt"]', "aria-checked");
  await p.click('[aria-label="Use a custom prompt"]');
  const promptShown = await p.exists('textarea[aria-label="Custom system prompt"]');
  check("4.13", "the custom-prompt switch reveals its textarea", promptWas === "false" ? promptShown : !promptShown);
  await p.click('[aria-label="Use a custom prompt"]');

  await p.select('select[aria-label="Provider"]', "openrouter");
  await sleep(250);
  const orModel = await p.val('select[aria-label="Model"]');
  check("4.2/4.3", "provider drives the model list", orModel.startsWith("openai/") || orModel.includes("/"), orModel);
  await p.select('select[aria-label="Model"]', "__custom__");
  await p.waitFor(`document.querySelector('input[aria-label="Custom model id"]')`, 6000);
  check("4.4", "Custom… gives a free-text model, with a way back", await p.exists(".mis-f .mis-inline .btn"));
  await p.click(".mis-f .mis-inline .btn"); // "Use preset"
  await sleep(250);
  check("4.4b", "Use preset returns to the dropdown", await p.exists('select[aria-label="Model"]'));
  await p.select('select[aria-label="Provider"]', before.provider);
  await sleep(250);
  await p.select('select[aria-label="Model"]', before.model);
  await sleep(200);

  const chipCount = await p.count(".mis-chips button");
  check("4.10", "every workspace label is offered as a candidate chip", chipCount > 0, `${chipCount} chips`);
  const chipWas = await p.attr(".mis-chips button", "aria-pressed");
  const counterWas = await p.text(".mis-h-row .mis-count");
  await p.clickNth(".mis-chips button", 0);
  const chipNow = await p.attr(".mis-chips button", "aria-pressed");
  const counterNow = await p.text(".mis-h-row .mis-count");
  check("4.10b", "a chip toggles", chipWas !== chipNow, `${chipWas} → ${chipNow}`);
  check("4.11", "and the counter follows", counterWas !== counterNow, `${counterWas} → ${counterNow}`);
  await p.clickNth(".mis-chips button", 0); // put it back

  const keyType = await p.attr('input[aria-label="AI provider API key"]', "type");
  await p.click('[aria-label="Show key"]');
  const keyType2 = await p.attr('input[aria-label="AI provider API key"]', "type");
  check("4.5", "the API key field hides and reveals", keyType === "password" && keyType2 === "text");
  await p.click('[aria-label="Hide key"]');
  check("4.7", "the storage note is kept", (await p.body()).includes("Stored encrypted with pgcrypto"));
  check("4.12", "both candidate-label explanations are kept",
    (await p.body()).includes("Turned off") && (await p.body()).includes("No match"));
  check("4.17b", "the last-run stamp is rendered", true, (await p.text(".mis-stamp")) || "no previous run");

  // The two controls that must never be fired by a test — armed, not confirmed.
  const clearExists = await p.exists('.mis-inline button[data-armed]');
  if (clearExists) {
    await p.click('.mis-inline button[data-armed]');
    const clearArmed = await p.text('.mis-inline button[data-armed="true"]');
    check("4.6", "Clear arms rather than clearing on one click", clearArmed === "Confirm clear", clearArmed);
    await sleep(4300); // let it disarm on its own rather than confirming
  } else {
    check("4.6", "Clear is absent because no key is saved", true);
  }

  const runBtnSel = '.mis-act button[data-armed]';
  const runDisabled = await p.disabled(runBtnSel);
  if (!runDisabled) {
    await p.click(runBtnSel);
    const runArmed = await p.text('.mis-act button[data-armed="true"]');
    check("4.15", "the backfill arms rather than running on one click", runArmed.includes("Confirm"), runArmed);
    await sleep(4300); // disarm — running it would spend real API credits
  } else {
    check("4.15", "the backfill is refused with no API key", true, "disabled");
  }

  // The safe round trip.
  await p.click('[data-mis="save-ai"]');
  await p.waitFor(`document.querySelector('.mis-ok')`, 12000, "save confirmation");
  check("4.19", "Save round-trips the config", (await p.text(".mis-ok")) === "Saved.");
  await p.goto("/inbox/settings/ai-labeling");
  const after = await p.ev(`(() => ({
    relabel: document.querySelector('[aria-label="Re-label ongoing replies"]')?.getAttribute('aria-checked'),
    backfill: document.querySelector('[aria-label="Include in historical backfill"]')?.getAttribute('aria-checked'),
    provider: document.querySelector('select[aria-label="Provider"]')?.value,
    model: document.querySelector('select[aria-label="Model"]')?.value,
    chips: document.querySelectorAll('.mis-chips button[aria-pressed="true"]').length,
  }))()`);
  check(
    "4.19b",
    "and leaves the workspace's own config untouched",
    after.relabel === before.relabel &&
      after.backfill === before.backfill &&
      after.provider === before.provider &&
      after.model === before.model &&
      after.chips === before.chips,
    JSON.stringify(after),
  );

  /* 5 · Clients moved to the client record (Campaigns → In Master Inbox) on 9 Oct. */

  /* ═══════════════════════════════════════════════════════ 8 · Webhooks */
  section("8 · Webhooks");
  await p.goto("/inbox/settings/webhooks");
  await p.shoot("11-webhooks");
  const wh = await p.body();
  check("8.1", "the placeholder says what the live tool says",
    wh.includes("Webhook subscriptions") && wh.includes("This section will land in a later phase."));
} catch (err) {
  check("!!", "the run reached the end", false, err.message);
  console.log(`\n  ABORTED: ${err.stack}`);
} finally {
  /* ─────────────────────────────────────────────────── clean-up sweep
   *
   * Two jobs. First, anything the UI path did not manage to delete because the
   * run aborted. Second — and this one runs even on a clean pass — a sweep by
   * NAME PREFIX, because a create can half-succeed: `saveAgent` inserts the row
   * and only then encrypts the API key, so a failure in that second step
   * answers 400 with the row already in the table and the browser none the
   * wiser. Nothing named `zz-mis-` may survive this script.
   */
  const headers = { Cookie: `bs_sso=${cookie}` };
  const endpoints = {
    labels: { url: "/api/tools/master-inbox/labels", key: "labels", list: false },
    templates: { url: "/api/tools/master-inbox/reply-templates", key: "templates", list: true },
    agents: { url: "/api/tools/master-inbox/reply-agents", key: "agents", list: true },
    clients: { url: "/api/tools/master-inbox/clients", key: "clients", list: true },
  };

  console.log(`\n  clean-up`);
  let swept = 0;
  for (const [kind, ep] of Object.entries(endpoints)) {
    if (!ep.list) {
      // No GET on this endpoint — the UI path is the only way to enumerate,
      // and it already deleted what it created.
      if (created[kind].length) {
        console.log(`      ⚠ ${kind}: ${created[kind].join(", ")} — no list endpoint, delete by hand`);
      }
      continue;
    }
    const res = await fetch(BASE + ep.url, { headers }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    const rows = Array.isArray(json) ? json : (json?.[ep.key] ?? []);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (const row of rows) {
      if (typeof row.name !== "string" || !row.name.startsWith("zz-mis-")) continue;
      const del = await fetch(`${BASE}${ep.url}/${row.id}`, { method: "DELETE", headers });
      swept += 1;
      console.log(`      ${del.ok ? "removed" : `COULD NOT REMOVE (${del.status})`}  ${kind}  ${row.name}`);
    }
  }
  if (swept === 0) console.log(`      nothing left over — the UI deleted everything it made`);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  console.log(`\n  ─────────────────────────────────────────────────────────────`);
  console.log(`  ${pass}/${results.length} checks passed`);
  if (fail.length) {
    console.log(`\n  FAILED:`);
    for (const f of fail) console.log(`    ✗ [${f.tab}] ${f.id} ${f.label} ${f.detail}`);
  }
  const realErrors = [...new Set(consoleErrors)].filter(
    // React's dev-only "Download the React DevTools" and hydration-warning
    // noise from the shell is not this screen's business.
    (e) => !/DevTools|Fast Refresh|source map|Warning: /i.test(e),
  );
  if (realErrors.length) {
    console.log(`\n  console errors:`);
    for (const e of realErrors.slice(0, 8)) console.log(`    ${e}`);
  } else {
    console.log(`  no console errors`);
  }
  /*
   * The 409 on a client delete is EXPECTED and asserted above — it is the
   * portal guard refusing to dead-link a live portal. Reporting it as a failed
   * request would train the reader to ignore this list.
   */
  const realNet = [...new Set(netFails)].filter(
    (n) => !/_next|favicon/.test(n) && !/^409 \/api\/tools\/master-inbox\/clients\//.test(n),
  );
  if (realNet.length) {
    console.log(`\n  failed requests:`);
    for (const n of realNet.slice(0, 8)) console.log(`    ${n}`);
  } else {
    console.log(`  no failed requests`);
  }
  console.log(`\n  test records created this run, all removed above or by the UI:`);
  console.log(`    label     ${RUN}-label → ${RUN}-label-edited`);
  console.log(`    template  ${RUN}-template → ${RUN}-template-edited (category ${RUN}-category)`);
  console.log(`    agent     ${RUN}-agent`);
  console.log(`    client    ${RUN}-client → ${RUN}-client-edited`);

  await tab.close();
  process.exit(fail.length || realErrors.length ? 1 : 0);
}
