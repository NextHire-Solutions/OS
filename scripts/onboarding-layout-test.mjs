/*
 * Does the page FIT? — the three new Onboarding screens.
 *
 * A sibling of scripts/layout-test.mjs, with its measurement verbatim. It is a
 * separate file rather than three more entries in that one because these
 * screens have no address in the shell yet (see ONBOARDING-WIRING.md); until
 * they are wired, they are reachable only through the preview harness, and the
 * shared script must keep testing the real routes.
 *
 * Ports 3330 / 9446, so the other agent's server on 3210 / 9333 is untouched.
 *
 * ORIGINAL HEADER FOLLOWS
 *
 * Does the page FIT?
 *
 * Every test so far asked whether things existed — nodes, controls, endpoints.
 * None asked whether they were the right size or in the right place, so a
 * screen could pass everything while rows ran off the side of the window and
 * the tab strip was clipped. That is exactly what happened.
 *
 * Measures, per screen:
 *   - horizontal overflow of the document and of the inbox's own containers
 *   - elements wider than their parent
 *   - the widest offenders, named, so the fix has a target
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3330";
const CDP = "http://localhost:9446";
const WIDTH = Number(process.argv[3] || 1440);

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

/* Same ONBOARDING_PATH_PREFIX contract as scripts/onboarding-ui-test.mjs. */
const PREFIX = process.env.ONBOARDING_PATH_PREFIX || "/onboarding";
const SCREENS = [`${PREFIX}/stages`, `${PREFIX}/templates`, `${PREFIX}/settings`];
let bad = 0;

for (const path of SCREENS) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  await send("Page.navigate", { url: BASE + path });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await ev("document.readyState")) === "complete" && (await ev("document.body.innerText.length")) > 600) break;
  }
  for (let i = 0; i < 40; i++) {
    const o = await ev(`getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`);
    if (Number(o) >= 0.999) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 400));

  const report = await ev(`(() => {
    const vw = document.documentElement.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - vw;
    const screen = document.querySelector('section.screen.on') || document.body;

    /*
     * Content inside a horizontally SCROLLABLE ancestor is not overflow — it is
     * the point of the scroller. The tab strip holds 15 tabs in 1122px of
     * visible width with 2558px of scroll; measuring its children against the
     * viewport reported 139 "broken" elements when nothing was wrong.
     *
     * So: walk up from each element, and ignore it if any ancestor scrolls
     * horizontally or clips. What survives is genuine — something that escapes
     * the window with nothing to contain it.
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
    return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 3) };
  })()`);

  const ok = report.docOverflow <= 1 && report.count === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${path.padEnd(28)} viewport ${report.vw}  doc overflow ${report.docOverflow}px  ${report.count} element(s) genuinely past the edge`);
  for (const sc of report.scrollers) console.log(`        scrolls: ${sc}`);
  for (const o of report.top) console.log(`        ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
  await fetch(`${CDP}/json/close/${t.id}`);
}
console.log(`\n  ${SCREENS.length - bad}/${SCREENS.length} screens fit the viewport`);
process.exit(bad ? 1 : 0);
