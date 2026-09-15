/*
 * Opens every popover in the workspace and proves it is actually visible.
 *
 *   node scripts/popover-clip-test.mjs [baseUrl]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The Analytics filter panels rendered perfectly and were still unusable: the
 * bar they live in is `overflow-x: auto`, and CSS does not allow one axis to
 * be `auto` while the other stays `visible` — when they disagree, `visible`
 * computes to `auto`. So the bar clipped VERTICALLY too, and a 300px client
 * list showed about 30px of itself.
 *
 * Nothing in the existing suite could see that. `ui-test.mjs` checks a screen
 * renders; it never clicks anything, and it did not cover Analytics or
 * Onboarding at all. A screenshot sweep would have needed someone to open each
 * panel first. So this drives the real thing: find every trigger, click it,
 * find the panel that appeared, and measure it.
 *
 * TWO FAILURES ARE CHECKED, because the screenshot showed both:
 *
 *   CLIPPED  — an ancestor's overflow cuts the panel. Measured by walking up
 *              and intersecting the rects of every clipping ancestor. No
 *              z-index can fix this: the pixels are gone before stacking is
 *              considered.
 *   COVERED  — the panel is painted over by something else. Measured with
 *              elementFromPoint at several points inside the panel; if the hit
 *              element is not the panel or one of its descendants, whatever is
 *              on top would also swallow the click.
 *
 * A panel pushed off the viewport counts as CLIPPED — the viewport is the
 * outermost clip rect.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
// Overridable, so it can share a Chrome with the other suites.
const CDP = process.env.CDP || "http://localhost:9333";

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
  #ws; #id = 0; #pending = new Map();
  static async open() {
    const t = new Tab();
    const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    t.targetId = target.id;
    t.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { t.#ws.onopen = ok; t.#ws.onerror = no; });
    t.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && t.#pending.has(m.id)) { t.#pending.get(m.id)(m); t.#pending.delete(m.id); }
    };
    return t;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Page-side helpers, installed once per navigation.
 *
 * Kept as one string rather than several because every one of them has to
 * exist before the first trigger is clicked, and a partially-installed helper
 * set fails in a way that looks like a passing test.
 */
const HELPERS = `
window.__pc = (() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' &&
           s.display !== 'none' && s.opacity !== '0';
  };
  const floaters = () => Array.prototype.filter.call(
    document.querySelectorAll('*'),
    (el) => {
      const s = getComputedStyle(el);
      return (s.position === 'absolute' || s.position === 'fixed') && vis(el);
    });

  // The rect a panel is actually allowed to paint in: the viewport, narrowed
  // by every clipping ancestor. A fixed panel ignores an ancestor's overflow
  // UNLESS that ancestor also establishes a containing block (transform /
  // filter / contain) -- the rule that put a dialog 292px below the fold.
  const clipRect = (el) => {
    let box = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    const fixed = getComputedStyle(el).position === 'fixed';
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
      const cb = s.transform !== 'none' || s.filter !== 'none' ||
                 (s.contain || '').indexOf('paint') >= 0 || (s.contain || '').indexOf('layout') >= 0;
      if (clips && (!fixed || cb)) {
        const r = p.getBoundingClientRect();
        box.l = Math.max(box.l, r.left); box.t = Math.max(box.t, r.top);
        box.r = Math.min(box.r, r.right); box.b = Math.min(box.b, r.bottom);
      }
      p = p.parentElement;
    }
    return box;
  };

  const measure = (el) => {
    const r = el.getBoundingClientRect();
    const c = clipRect(el);
    const iw = Math.max(0, Math.min(r.right, c.r) - Math.max(r.left, c.l));
    const ih = Math.max(0, Math.min(r.bottom, c.b) - Math.max(r.top, c.t));
    const area = r.width * r.height;
    const shown = area > 0 ? (iw * ih) / area : 1;

    // Covered: sample a grid inside the visible part. A panel whose own
    // children answer is fine; anything else on top would eat the click too.
    let covered = 0, sampled = 0;
    const x0 = Math.max(r.left, c.l), x1 = Math.min(r.right, c.r);
    const y0 = Math.max(r.top, c.t), y1 = Math.min(r.bottom, c.b);
    for (const fx of [0.15, 0.5, 0.85]) {
      for (const fy of [0.1, 0.5, 0.9]) {
        const x = x0 + (x1 - x0) * fx, y = y0 + (y1 - y0) * fy;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        sampled++;
        if (hit !== el && !el.contains(hit)) covered++;
      }
    }
    return {
      shown: Math.round(shown * 100),
      covered: sampled ? Math.round((covered / sampled) * 100) : 0,
      w: Math.round(r.width), h: Math.round(r.height),
      tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
    };
  };

  return { vis, floaters, measure };
})();
true`;

const SNAPSHOT = `window.__before = new Set(window.__pc.floaters()); true`;

// Find the panel that appeared, and measure it.
const MEASURE_NEW = `(() => {
  const fresh = window.__pc.floaters().filter((el) => !window.__before.has(el));
  if (fresh.length === 0) return null;
  // The outermost fresh element is the panel; its children came with it.
  const outer = fresh.filter((el) => !fresh.some((o) => o !== el && o.contains(el)));
  // Biggest one, in case a trigger reveals a chip as well as a panel.
  const panel = outer.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  })[0];
  return window.__pc.measure(panel);
})()`;

async function run() {
  const tok = await token();
  const tab = await Tab.open();
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Network.enable");
  // Domain follows the target, so the same suite runs against production.
  await tab.send("Network.setCookie", {
    name: "bs_sso", value: tok, domain: new URL(BASE).hostname, path: "/",
  });
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const problems = [];
  const measured = [];
  let opened = 0, screens = 0;

  for (const route of ROUTES) {
    await tab.send("Page.navigate", { url: BASE + route });
    // Screens are lazy and fetch after mount; give them room to settle.
    await sleep(2200);
    try { await tab.eval(HELPERS); } catch { continue; }
    screens++;

    const triggers = await tab.eval(`(() => {
      const t = Array.prototype.filter.call(
        document.querySelectorAll('button[aria-expanded], [role="combobox"]'),
        (el) => window.__pc.vis(el));
      window.__triggers = t;
      return t.map((el, i) => ({ i, text: (el.textContent || '').trim().slice(0, 28) }));
    })()`);

    for (const t of triggers ?? []) {
      try {
        // Scroll it into view BEFORE snapshotting. A trigger sitting 2600px
        // down can still be .click()ed, and the panel then anchors correctly
        // to an off-screen trigger — which measures as 0% visible and is a
        // property of the test, not of the UI.
        await tab.eval(`window.__triggers[${t.i}].scrollIntoView({ block: 'center' }); true`);
        await sleep(220);
        await tab.eval(SNAPSHOT);
        await tab.eval(`window.__triggers[${t.i}].click(); true`);
        await sleep(420);
        const m = await tab.eval(MEASURE_NEW);
        if (m) {
          opened++;
          measured.push({ route, trigger: t.text, shown: m.shown, covered: m.covered, size: `${m.w}x${m.h}` });
          // 2% tolerance absorbs sub-pixel rounding and a 1px border.
          if (m.shown < 98) {
            problems.push({ route, trigger: t.text, kind: "CLIPPED", detail: `only ${m.shown}% visible · ${m.w}x${m.h} · ${m.tag}` });
          } else if (m.covered > 33) {
            problems.push({ route, trigger: t.text, kind: "COVERED", detail: `${m.covered}% of samples hit something on top · ${m.tag}` });
          }
        }
        // Close it again so the next trigger's diff is clean.
        await tab.eval(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const el = window.__triggers[${t.i}];
          if (el && el.getAttribute('aria-expanded') === 'true') el.click();
          return true;
        })()`);
        await sleep(160);
      } catch {
        /* a trigger that navigates away takes the rest of the screen with it */
      }
    }
    process.stdout.write(`  ${route.padEnd(30)} ${String(triggers?.length ?? 0).padStart(2)} triggers\n`);
  }

  await tab.close();

  console.log(`\n  ${screens} screens · ${opened} panels opened and measured\n`);
  for (const m of measured) {
    const ok = m.shown >= 98 && m.covered <= 33;
    console.log(`  ${ok ? "✓" : "✗"} ${m.route.padEnd(24)} ${String(m.trigger).padEnd(20)} ${String(m.shown).padStart(3)}% visible  ${m.size}`);
  }
  if (problems.length === 0) {
    console.log("  ✅ every panel fully visible and unobstructed\n");
    return 0;
  }
  console.log(`\n  ${problems.length} PROBLEM${problems.length === 1 ? "" : "S"}:\n`);
  for (const p of problems) {
    console.log(`  ✗ ${p.kind}  ${p.route}  "${p.trigger}"`);
    console.log(`      ${p.detail}`);
  }
  console.log("");
  return 1;
}

process.exit(await run());
