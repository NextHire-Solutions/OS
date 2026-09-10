/*
 * Does every Agent Search screen FIT?
 *
 * Same rules as scripts/layout-test.mjs — content inside a horizontally
 * scrollable ancestor is not overflow, it is the point of the scroller — but
 * pointed at the five Agent Search screens, and run at three widths.
 *
 * This matters more here than anywhere else in the workspace: the full Courted
 * export is 77 columns and the master list is wider still, so these tables
 * WILL be wider than any window. The requirement is not that they be narrow,
 * it is that they scroll inside their own box and never push the page sideways.
 *
 *   node scripts/agent-search-layout-test.mjs [baseUrl] [cdpUrl]
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3320";
const CDP = process.argv[3] || "http://localhost:9445";
const WIDTHS = [1440, 1180, 1024];

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1,
});

/** The five real workspace addresses, measured through the real shell. */
const SCREENS = {
  search: "/search",
  master: "/search/master",
  accounts: "/search/accounts",
  mls: "/search/mls",
  import: "/search/import",
};
let bad = 0;

for (const width of WIDTHS) {
  console.log(`\n  ── ${width}px ──────────────────────────────────────────────`);
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  for (const [screen, route] of Object.entries(SCREENS)) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await ev("document.readyState")) === "complete" && (await ev("!!document.querySelector('section.screen.on .as-hd')"))) break;
    }
    for (let i = 0; i < 40; i++) {
      const o = await ev(`getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`);
      if (Number(o) >= 0.999) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 1800));
    // Open the Search screen's Options too — a collapsed panel proves nothing.
    if (screen === "search") {
      await ev(`(()=>{const b=[...document.querySelectorAll('section.screen.on .as-btn.ghost')].find(x=>/Options/.test(x.textContent)); if(b && b.getAttribute('aria-expanded')!=='true') b.click();})()`);
      await new Promise((r) => setTimeout(r, 500));
    }

    const report = await ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const docOverflow = document.documentElement.scrollWidth - vw;
      const root = document.querySelector('section.screen.on');
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
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= vw + 1) continue;
        if (contained(el)) continue;
        offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40), right: Math.round(r.right), w: Math.round(r.width) });
      }
      const seen = new Set(); const top = [];
      for (const o of offenders.sort((a, b) => b.right - a.right)) {
        const k = o.tag + '.' + o.cls;
        if (seen.has(k)) continue;
        seen.add(k); top.push(o);
        if (top.length >= 5) break;
      }
      const scrollers = [];
      for (const el of root.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 2 && scrolls(el)) {
          scrollers.push(String(el.className || el.tagName).slice(0, 36) + ' (' + el.clientWidth + '→' + el.scrollWidth + ')');
        }
      }
      return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 2) };
    })()`);

    const ok = report.docOverflow <= 1 && report.count === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${screen.padEnd(10)} doc overflow ${String(report.docOverflow).padStart(4)}px · ${report.count} element(s) past the edge`);
    for (const sc of report.scrollers) console.log(`       scrolls (correctly): ${sc}`);
    for (const o of report.top) console.log(`       ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
  }
  ws.close();
  await fetch(`${CDP}/json/close/${t.id}`);
}

const total = Object.keys(SCREENS).length * WIDTHS.length;
console.log(`\n  ${total - bad}/${total} screen×width combinations fit the viewport\n`);
process.exit(bad ? 1 : 0);
