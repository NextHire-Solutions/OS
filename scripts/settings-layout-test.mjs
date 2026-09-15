/*
 * Does each settings tab FIT?
 *
 *   node scripts/settings-layout-test.mjs [baseUrl] [width]
 *
 * The measurement is `scripts/layout-test.mjs` verbatim — the same viewport
 * arithmetic, the same "content inside a horizontal scroller is not overflow"
 * rule, the same reporting. Two things differ and only two: the screens are the
 * eight settings tabs, and Chrome is on 9451 rather than 9333, because 9333 is
 * another piece of work's debugger and must not be disturbed. That is also why
 * this is a sibling file rather than an edit to `layout-test.mjs`, which is the
 * same shape `agent-search-layout-test.mjs` and `onboarding-layout-test.mjs`
 * already take in this repo.
 *
 * A settings panel is the easiest place in the product to push the workspace
 * sideways: it carries a six-column table, a two-step wizard inside a dialog,
 * and a card grid. Existence tests pass happily while a table runs off the
 * right edge, which is the failure this measures.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3370";
const CDP = "http://localhost:9451";
const WIDTH = Number(process.argv[3] || 1440);

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

const SCREENS = [
  "/inbox/settings/labels",
  "/inbox/settings/templates",
  "/inbox/settings/reply-agents",
  "/inbox/settings/ai-labeling",
  "/inbox/settings/clients",
  "/inbox/settings/members",
  "/inbox/settings/personal",
  "/inbox/settings/webhooks",
];
let bad = 0;

for (const path of SCREENS) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  };
  const send = (mm, p = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method: mm, params: p }));
    });
  const ev = async (x) =>
    (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  await send("Page.navigate", { url: BASE + path });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await ev("document.readyState")) === "complete" && (await ev("!!document.querySelector('.mis')"))) break;
  }
  // The screen materialises (blur + scale + opacity); measuring mid-animation
  // reports a transform, not a layout.
  for (let i = 0; i < 40; i++) {
    const o = await ev(
      `getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`,
    );
    if (Number(o) >= 0.999) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500));

  const report = await ev(`(() => {
    const vw = document.documentElement.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - vw;
    const screen = document.querySelector('.mi-settings-body') || document.querySelector('section.screen.on') || document.body;

    /*
     * Content inside a horizontally SCROLLABLE ancestor is not overflow — it is
     * the point of the scroller. Walk up from each element and ignore it if any
     * ancestor scrolls horizontally or clips. What survives is genuine.
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
    /*
     * Vertical clipping, which is the other way a settings panel goes wrong.
     *
     * .mi-theme is overflow:hidden — that is what stops the inbox pushing the
     * workspace sideways. On a settings tab it has auto height, so nothing is
     * cut off; but if a future change ever constrains that height, the bottom
     * of a 21-row table would silently become unreachable. This is the number
     * that would catch it. (No backticks in here: this whole block is itself
     * inside a template literal.)
     */
    const theme = document.querySelector('.mi-theme');
    const vClip = theme ? Math.max(0, theme.scrollHeight - theme.clientHeight) : 0;
    return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 3), vClip };
  })()`);

  const ok = report.docOverflow <= 1 && report.count === 0 && report.vClip === 0;
  if (!ok) bad++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${path.padEnd(30)} viewport ${report.vw}  doc overflow ${report.docOverflow}px  ` +
      `${report.count} element(s) genuinely past the edge  (${report.vClip}px clipped vertically)`,
  );
  for (const sc of report.scrollers) console.log(`        scrolls: ${sc}`);
  for (const o of report.top) console.log(`        ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
  await fetch(`${CDP}/json/close/${t.id}`);
}
console.log(`\n  ${SCREENS.length - bad}/${SCREENS.length} settings tabs fit ${WIDTH}px`);
process.exit(bad ? 1 : 0);
