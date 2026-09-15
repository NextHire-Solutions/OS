/*
 * Does the CONVERSATION VIEW fit?
 *
 * `scripts/layout-test.mjs` measures overflow correctly — it walks up from
 * every element and ignores anything inside a legitimately scrollable
 * ancestor, which is why it reports 0 offenders on a tab strip that scrolls its
 * fifteen tabs inside 1122px. Its measurement block below is that file's,
 * copied verbatim rather than reinterpreted.
 *
 * Two things differ, and both are forced:
 *
 *   1. Its SCREENS list has no thread-detail route, so the screen this rebuild
 *      touched was the one screen it never measured. The list here is the
 *      conversation, at the three widths the brief names, plus the same inbox
 *      routes so a regression there is visible too.
 *
 *   2. Its CDP port is the literal `9333`, which belongs to another agent's
 *      browser. This one takes the port from the environment.
 *
 *   node scripts/conversation-layout-test.mjs [baseUrl] [width]
 *   CDP=http://localhost:9450 BASE=http://localhost:3360 node scripts/conversation-layout-test.mjs
 *
 * The conversation is measured twice at each width: at rest, and with the
 * composer open — the composer is an overlay, and an overlay that is 62% of a
 * pane at 1440px is a different sum at 1100px.
 */
import fs from "node:fs";

const BASE = process.argv[2] || process.env.BASE || "http://localhost:3360";
const CDP = process.env.CDP || "http://localhost:9450";
const WIDTHS = process.argv[3] ? [Number(process.argv[3])] : [1440, 1280, 1100];

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab() {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { id: t.id, send, ev, close: () => fetch(`${CDP}/json/close/${t.id}`) };
}

/* ---- layout-test.mjs's measurement, verbatim ---------------------------- */
const MEASURE = `(() => {
    const vw = document.documentElement.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - vw;
    const screen = document.querySelector('section.screen.on') || document.body;

    /*
     * Content inside a horizontally SCROLLABLE ancestor is not overflow — it is
     * the point of the scroller.
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

    const scrollers = [];
    for (const el of screen.querySelectorAll('*')) {
      if (el.scrollWidth > el.clientWidth + 2 && scrolls(el)) {
        scrollers.push(String(el.className || el.tagName).slice(0, 40) + ' (' + el.clientWidth + '→' + el.scrollWidth + ')');
      }
    }
    return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 3) };
  })()`;

const PRESS = `(function press(el){if(!el)return false;
  const o={bubbles:true,cancelable:true,composed:true,pointerId:1,button:0,isPrimary:true,pointerType:"mouse"};
  el.dispatchEvent(new PointerEvent("pointerdown",o));el.dispatchEvent(new MouseEvent("mousedown",o));
  el.dispatchEvent(new PointerEvent("pointerup",o));el.dispatchEvent(new MouseEvent("mouseup",o));el.click();return true;})`;

/* Find one real conversation so the thread route is measured with real data. */
let THREAD = null;
{
  const t = await tab();
  await t.send("Runtime.enable"); await t.send("Page.enable"); await t.send("Network.enable");
  await t.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await t.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  await t.send("Page.navigate", { url: BASE + "/inbox/all-email" });
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    const n = await t.ev(`document.querySelectorAll('a[href^="/inbox/all-email/"]').length`);
    if (n > 0) break;
  }
  THREAD = await t.ev(`document.querySelector('a[href^="/inbox/all-email/"]')?.getAttribute("href")`);
  await t.close();
}
if (!THREAD) { console.error("  no conversation to measure"); process.exit(1); }

const SCREENS = [
  { path: THREAD, label: "conversation", open: false },
  { path: THREAD, label: "conversation + composer", open: true },
  { path: "/inbox/all-email", label: "inbox list", open: false },
  { path: "/inbox/archive", label: "inbox archive", open: false },
];

let bad = 0;
for (const W of WIDTHS) {
  console.log(`\n  ── ${W}px ──`);
  for (const s of SCREENS) {
    const t = await tab();
    await t.send("Runtime.enable"); await t.send("Page.enable"); await t.send("Network.enable");
    await t.send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 1, mobile: false });
    await t.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
    await t.send("Page.navigate", { url: BASE + s.path });
    for (let i = 0; i < 300; i++) {
      await sleep(200);
      if ((await t.ev("document.readyState")) === "complete" && (await t.ev("document.body.innerText.length")) > 1500) break;
    }
    /* Wait out the screen's materialize animation — it scales the whole screen,
       so measuring mid-flight reports phantom overflow. */
    for (let i = 0; i < 40; i++) {
      const o = await t.ev(`getComputedStyle(document.querySelector('section.screen.on')||document.body).opacity`);
      if (Number(o) >= 0.999) break;
      await sleep(50);
    }
    await sleep(600);
    if (s.open) {
      await t.ev(`${PRESS}(document.querySelector(".mi-reply-fab"))`);
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        if (await t.ev(`!!document.querySelector('[class*="lg:w-[480px]"]')`)) break;
      }
      await sleep(900);
    }
    const r = await t.ev(MEASURE);
    const ok = r.docOverflow <= 1 && r.count === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${s.label.padEnd(24)} viewport ${r.vw}  doc overflow ${r.docOverflow}px  ${r.count} element(s) genuinely past the edge`);
    for (const sc of r.scrollers) console.log(`        scrolls: ${sc}`);
    for (const o of r.top) console.log(`        ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
    await t.close();
  }
}
console.log(`\n  ${WIDTHS.length * SCREENS.length - bad}/${WIDTHS.length * SCREENS.length} measurements fit the viewport`);
process.exit(bad ? 1 : 0);
