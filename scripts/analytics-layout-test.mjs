/*
 * Does the page FIT?
 *
 * Every other test asks whether things exist — nodes, controls, endpoints.
 * None asks whether they are the right size, so a screen can pass everything
 * while rows run off the side of the window and the filter bar is clipped.
 *
 * Measures, per screen and per width:
 *   - horizontal overflow of the document
 *   - elements escaping the viewport with nothing to contain them
 *   - the widest offenders, named, so a fix has a target
 *
 * Copied from `scripts/layout-test.mjs`. The measurement is unchanged, and the
 * exclusion that makes it meaningful is unchanged too: content inside a
 * horizontally SCROLLABLE ancestor is not overflow, it is the point of the
 * scroller. Analytics is full of them — the campaign table is 24 columns wide
 * on purpose — and without that rule every one of them would report hundreds
 * of "broken" elements.
 *
 *   node scripts/analytics-layout-test.mjs [baseUrl] [width]
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3350";
const CDP = process.env.CDP || "http://localhost:9448";

/*
 * Two widths, not one.
 *
 * 1440 is the design's reference. 1180 is a 13" laptop with the rail open,
 * which is what most of this team actually uses — and it is where a table's
 * `minWidth` stops fitting and has to start scrolling instead of pushing.
 */
const WIDTHS = process.argv[3] ? [Number(process.argv[3])] : [1440, 1180];

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

const P = "/analytics";
const SCREENS = [
  [`${P}/campaign`, "Campaign"],
  [`${P}/infrastructure`, "Infrastructure"],
  [`${P}/attribution`, "Attribution"],
  [`${P}/copy`, "Copy & Offer"],
  [`${P}/campaigns`, "Campaigns"],
  [`${P}/campaigns/55`, "Campaign detail"],
  [`${P}/schedule`, "Schedule"],
  [`${P}/clients`, "Clients"],
];

let bad = 0;
let checks = 0;

for (const width of WIDTHS) {
  console.log(`\n  ── ${width}px ─────────────────────────────────────────────`);
  for (const [path, label] of SCREENS) {
    checks++;
    const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (mm, p = {}) =>
      new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
    const ev = async (x) =>
      (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
        .result?.result?.value;

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
    await send("Page.navigate", { url: BASE + path });

    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await ev("document.readyState")) === "complete" && (await ev("document.body.innerText.length")) > 700) break;
    }
    // Settle: the screens fetch on mount, and the widest element on most of
    // them is a table that does not exist until its rows do.
    await new Promise((r) => setTimeout(r, 1800));

    const report = await ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const docOverflow = document.documentElement.scrollWidth - vw;
      const screen = document.querySelector('section.screen.on') || document.body;

      /*
       * Content inside a horizontally SCROLLABLE ancestor is not overflow — it
       * is the point of the scroller. So: walk up from each element, and ignore
       * it if any ancestor scrolls horizontally or clips. What survives is
       * genuine — something that escapes the window with nothing to contain it.
       */
      const scrolls = (el) => {
        const s = getComputedStyle(el);
        return (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden');
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
        offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44), right: Math.round(r.right), w: Math.round(r.width) });
      }
      const seen = new Set(); const top = [];
      for (const o of offenders.sort((a, b) => b.right - a.right)) {
        const k = o.tag + '.' + o.cls;
        if (seen.has(k)) continue;
        seen.add(k); top.push(o);
        if (top.length >= 6) break;
      }

      /* Scrollers are reported separately — useful, not failures. */
      const scrollers = [];
      for (const el of screen.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 2 && scrolls(el)) {
          scrollers.push(String(el.className || el.tagName).slice(0, 40) + ' (' + el.clientWidth + '→' + el.scrollWidth + ')');
        }
      }
      return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 3), chars: document.body.innerText.length };
    })()`);

    const ok = report.docOverflow <= 1 && report.count === 0;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${label.padEnd(16)} viewport ${report.vw}  doc overflow ${report.docOverflow}px  ${report.count} element(s) past the edge  ${report.chars} chars`,
    );
    for (const sc of report.scrollers) console.log(`        scrolls: ${sc}`);
    for (const o of report.top) console.log(`        ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
    ws.close();
    await fetch(`${CDP}/json/close/${t.id}`);
  }
}

console.log(`\n  ${checks - bad}/${checks} screen-widths fit the viewport`);
process.exit(bad ? 1 : 0);
