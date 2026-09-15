/*
 * Every field in every dialog stays inside its dialog, and never overlaps the
 * field beside it.
 *
 * The UI audit sweeps screens, not dialogs — a dialog is only on the page once
 * something is clicked — and modal-center-test checks where a dialog SITS, not
 * what happens inside it. That gap hid a real fault: `.inp` carries
 * `min-width: 200px`, so in the auto-fit grids these dialogs use, inputs drew
 * wider than their column, overlapped each other by 38px and ran past the
 * dialog's right edge.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const CDP = `http://localhost:${process.env.PORT || 9536}`;

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["\']|["\']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: TOKEN, domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https") });
await send("Page.enable");

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

/* Every field's geometry, measured against its dialog and its neighbours. */
const MEASURE = `(() => {
  const ds = [...document.querySelectorAll('[data-modal-dialog]')];
  const d = ds[ds.length - 1];
  if (!d) return JSON.stringify({ found: false });
  const db = d.getBoundingClientRect();
  const fields = [...d.querySelectorAll('input, select, textarea')]
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2; })
    .map((e) => { const b = e.getBoundingClientRect();
      return { name: (e.placeholder || e.getAttribute('aria-label') || e.type || e.tagName).slice(0, 24),
               l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; });
  const escaped = fields.filter((f) => f.r > Math.round(db.right) + 1 || f.l < Math.round(db.left) - 1);
  const overlapping = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i], c = fields[j];
      const overX = Math.min(a.r, c.r) - Math.max(a.l, c.l);
      const overY = Math.min(a.b, c.b) - Math.max(a.t, c.t);
      if (overX > 2 && overY > 2) overlapping.push(a.name + " / " + c.name + " by " + overX + "px");
    }
  }
  return JSON.stringify({ found: true, count: fields.length, escaped: escaped.map((f) => f.name + " " + (f.r - Math.round(db.right)) + "px past"), overlapping });
})()`;

const open = async (which) => ev(`(() => {
  const rows = [...document.querySelectorAll('tbody tr')];
  if (${JSON.stringify(which)} === 'onboard') {
    const b = [...document.querySelectorAll('button')].find((x) => /onboard a client/i.test(x.textContent || ''));
    if (!b) return 'NO_TRIGGER'; b.click(); return 'ok';
  }
  if (${JSON.stringify(which)} === 'invite') {
    const b = [...document.querySelectorAll('button')].find((x) => /invite teammate/i.test(x.textContent || ''));
    if (!b || b.disabled) return 'NO_TRIGGER'; b.click(); return 'ok';
  }
  const tr = rows[0]; if (!tr) return 'NO_ROW';
  const btns = [...tr.querySelectorAll('button')];
  const b = btns[btns.length - 2]; // Edit sits before Delete
  if (!b) return 'NO_TRIGGER'; b.click(); return 'ok';
})()`);

console.log(`\nDIALOG FIELDS\n${"=".repeat(70)}\n`);

for (const [w, h, label] of [[1440, 900, "desktop"], [420, 820, "phone"]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  console.log(`  ${label} ${w}x${h}`);
  for (const which of ["onboard", "edit", "invite"]) {
    const url = which === "invite" ? "/team" : "/roster";
    await send("Page.navigate", { url: BASE + url });
    for (let i = 0; i < 60; i++) {
      const ready = which === "invite"
        ? await ev(`[...document.querySelectorAll('button')].some(b => /invite teammate/i.test(b.textContent || ''))`)
        : (await ev(`document.querySelectorAll('tbody tr').length`)) > 3;
      if (ready) break;
      await sleep(400);
    }
    await sleep(1200);
    const o = await open(which);
    await sleep(1600);
    const m = JSON.parse(await ev(MEASURE));
    if (!m.found) { check(`${which} @${label}`, false, `no dialog (trigger=${o})`); continue; }
    check(`${which} @${label} — ${m.count} fields, none past the edge, none overlapping`,
      m.escaped.length === 0 && m.overlapping.length === 0,
      [...m.escaped, ...m.overlapping].join(" · ") || `${m.count} fields`);
  }
}

console.log(`\n${"=".repeat(70)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
ws.close();
process.exit(failed ? 1 : 0);
