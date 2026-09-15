/*
 * Are Onboard, Edit and Delete centred modals now?
 *
 * "It looks centred" is not the check. A dialog can render in roughly the
 * middle and still be the old anchored panel that happens to sit there, so each
 * one is measured:
 *
 *   CENTRED    its centre is within 2% of the viewport centre, both axes
 *   BACKDROP   a dimming layer covers the viewport behind it
 *   ON SCREEN  fully inside the viewport — the delete panel used to hang off
 *              the top-right corner and need its own scrollbar
 *   LOCKED     the page behind cannot be scrolled while it is open
 *   ESC        Escape closes it
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const PORT = process.env.PORT || 9464;
const t = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const w = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m.result); w.delete(m.id); } };
const send = (me, p = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 }), domain: "os.brokerstaffer.com", path: "/", secure: true });

// Never let a write leave the browser — these dialogs have real Save buttons.
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
const blocked = [];
ws.addEventListener("message", async (e) => {
  const m = JSON.parse(e.data);
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const meth = (request.method || "GET").toUpperCase();
  if (meth === "GET" || meth === "HEAD") await send("Fetch.continueRequest", { requestId });
  else { blocked.push(`${meth} ${request.url}`); await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
});

const SIZES = [{ w: 1512, h: 950, name: "desktop" }, { w: 420, h: 820, name: "phone" }];
const out = [];
const say = (id, pass, msg) => { out.push({ id, pass }); console.log(`    ${pass ? "PASS" : "FAIL"}  ${id}  ${msg}`); };

const open = async (which) => ev(`(() => {
  const rows = [...document.querySelectorAll('tbody tr')];
  const tr = rows.find(r => /^opslabs\\b/i.test(((r.querySelector('.cname')||{}).textContent||'').trim())) || rows[0];
  if (${JSON.stringify(which)} === 'onboard') {
    const b = [...document.querySelectorAll('button')].find(x => /onboard a client/i.test(x.textContent||''));
    if (!b) return 'NO_TRIGGER'; b.click(); return 'ok';
  }
  if (${JSON.stringify(which)} === 'invite') {
    const b = [...document.querySelectorAll('button')].find(x => /invite teammate/i.test(x.textContent||''));
    if (!b) return 'NO_TRIGGER'; if (b.disabled) return 'DISABLED'; b.click(); return 'ok';
  }
  if (!tr) return 'NO_ROW';
  const btns = [...tr.querySelectorAll('button')];
  const b = ${JSON.stringify(which)} === 'delete' ? btns[btns.length-1] : btns[btns.length-2];
  if (!b) return 'NO_TRIGGER'; b.click(); return 'ok';
})()`);

const measure = () => ev(`(() => {
  const d = document.querySelector('[data-modal-dialog]');
  const b = document.querySelector('[data-modal-backdrop]');
  if (!d) return JSON.stringify({ found: false, anchored: !!document.querySelector('[data-anchored-panel]') });
  const r = d.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  return JSON.stringify({
    found: true,
    dxPct: Math.abs((r.left + r.width/2) - vw/2) / vw * 100,
    dyPct: Math.abs((r.top + r.height/2) - vh/2) / vh * 100,
    onScreen: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
    backdrop: b ? (b.getBoundingClientRect().width >= vw - 1 && b.getBoundingClientRect().height >= vh - 1) : false,
    bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  });
})()`);

for (const s of SIZES) {
  await send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE + "/roster" });
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('tbody tr').length`) > 5) break; await sleep(1500); }
  await sleep(2500);
  console.log(`\n  ${s.name} ${s.w}x${s.h}`);

  for (const which of ["onboard", "edit", "delete", "invite"]) {
    // Invite lives on Team access; the other three on the roster.
    await send("Page.navigate", { url: BASE + (which === "invite" ? "/team" : "/roster") });
    for (let i = 0; i < 40; i++) {
      const n = which === "invite"
        ? await ev(`[...document.querySelectorAll('button')].some(b => /invite teammate/i.test(b.textContent||''))`)
        : (await ev(`document.querySelectorAll('tbody tr').length`)) > 5;
      if (n) break;
      await sleep(1500);
    }
    await sleep(2000);
    const o = await open(which);
    await sleep(1800);
    const m = JSON.parse(await measure());
    if (!m.found) {
      say(`${which} @${s.name}`, false, `no modal (trigger=${o}${m.anchored ? ", still an ANCHORED panel" : ""})`);
      continue;
    }
    const centred = m.dxPct <= 2 && m.dyPct <= 2;
    const ok = centred && m.onScreen && m.backdrop && m.bodyLocked;
    say(`${which} @${s.name}`, ok,
      `off-centre x${m.dxPct.toFixed(1)}% y${m.dyPct.toFixed(1)}% · onScreen=${m.onScreen} · backdrop=${m.backdrop} · pageLocked=${m.bodyLocked} · box=${m.box.join(",")}`);

    // Escape must close it.
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(900);
    const gone = await ev(`!document.querySelector('[data-modal-dialog]')`);
    say(`${which} @${s.name} — Escape closes`, gone, gone ? "closed" : "still open");
  }
}

console.log("\n" + "=".repeat(74));
if (blocked.length) console.log(`  writes blocked (none should have been attempted): ${[...new Set(blocked)].join(", ")}`);
const bad = out.filter((o) => !o.pass);
console.log(bad.length ? `  ${bad.length} FAILED:\n${bad.map(b=>"      "+b.id).join("\n")}` : "  all dialogs centred, backed, on-screen and dismissible");
ws.close(); process.exit(bad.length ? 1 : 0);
