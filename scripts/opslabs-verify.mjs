/*
 * Did the two fixes actually land, on production, in the browser?
 *
 *   1  OpsLabs no longer shows "missing" in all three tool columns
 *   2  "Delete everywhere, including the portal" now LISTS the Analytics and
 *      Client Health rows under "Will remove", not under "Will keep"
 *
 * Check 2 opens the dialog and reads it. It never clicks the red button — the
 * point is to confirm what the dialog PROMISES before anything is destroyed.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const t = await (await fetch("http://localhost:9462/json/new?about:blank", { method: "PUT" })).json();
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
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });

const out = [];
const say = (id, pass, msg) => { out.push({ id, pass }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${id}\n        ${msg}`); };

await send("Page.navigate", { url: BASE + "/roster" });
// The Clients page reads three live tools; 12s was not enough and the row
// simply had not rendered yet, which reads identically to "the fix failed".
for (let i = 0; i < 40; i++) {
  const n = await ev(`document.querySelectorAll('tbody tr').length`);
  if (n > 5) break;
  await sleep(1500);
}
await sleep(2500);
console.log(`     roster rows on page: ${await ev(`document.querySelectorAll('tbody tr').length`)}`);
console.log(`     names sample: ${await ev(`[...document.querySelectorAll('.cname')].slice(0,3).map(x=>x.textContent).join(', ')`)}`);
console.log(`     OpsLabs present: ${await ev(`[...document.querySelectorAll('.cname')].some(x=>/opslabs/i.test(x.textContent||''))`)}`);

/* 1 — the OpsLabs row */
const row = JSON.parse(await ev(`(() => {
  const tr = [...document.querySelectorAll('tbody tr')]
    .find(r => /^opslabs\\b/i.test(((r.querySelector('.cname')||{}).textContent||'').trim()));
  if (!tr) return JSON.stringify({found:false});
  const cells = [...tr.querySelectorAll('td')].map(td => (td.innerText||'').replace(/\\s+/g,' ').trim());
  const gaps = tr.querySelectorAll('.tg').length;
  return JSON.stringify({found:true, cells, gaps});
})()`));
say("1 OpsLabs resolves in its tools instead of reading 'missing'",
    row.found && row.gaps === 0,
    row.found ? `${row.gaps} "missing" badge(s) · cells: ${row.cells.slice(0,8).join(" | ")}`
              : "row not found on the page");

/* 2 — the delete dialog's promise */
const opened = await ev(`(() => {
  const tr = [...document.querySelectorAll('tbody tr')]
    .find(r => /^opslabs\\b/i.test(((r.querySelector('.cname')||{}).textContent||'').trim()));
  if (!tr) return 'NO_ROW';
  const btns = [...tr.querySelectorAll('button')];
  const del = btns[btns.length-1];
  if (!del) return 'NO_BUTTON';
  del.click(); return 'opened';
})()`);
await sleep(2500);
// Choose the "everything" option — the last radio in the dialog.
await ev(`(() => {
  const p = document.querySelector('[data-anchored-panel], [role=dialog]');
  if (!p) return 'NO_PANEL';
  const radios = [...p.querySelectorAll('input[type=radio]')];
  const last = radios[radios.length-1];
  if (last) { last.click(); }
  return 'chose';
})()`);
await sleep(3500);
const dlg = await ev(`(() => {
  const p = document.querySelector('[data-anchored-panel], [role=dialog]');
  return p ? (p.innerText||'').replace(/\\n+/g,' | ') : 'NO_PANEL';
})()`);

const remove = dlg.slice(dlg.indexOf("Will remove"), dlg.indexOf("Will keep") > 0 ? dlg.indexOf("Will keep") : undefined);
const keep = dlg.indexOf("Will keep") > 0 ? dlg.slice(dlg.indexOf("Will keep")) : "";
const analyticsRemoved = /Analytics/i.test(remove);
const healthRemoved = /Client Health/i.test(remove);
const analyticsKept = /Analytics/i.test(keep);
say('2 "Delete everywhere" now promises to remove the Analytics + Client Health rows',
    analyticsRemoved && healthRemoved && !analyticsKept,
    `open=${opened}\n        WILL REMOVE: ${remove.slice(0,240)}\n        WILL KEEP:   ${keep.slice(0,160)}`);

console.log("\n" + "=".repeat(72));
const bad = out.filter((o) => !o.pass);
console.log(bad.length ? `  ${bad.length} FAILED: ${bad.map(b=>b.id).join("; ")}` : "  both fixes verified on production");
ws.close(); process.exit(bad.length ? 1 : 0);
