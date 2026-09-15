/*
 * The conversation view, driven in a real browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `thread-view.tsx` and `prospect-panel.tsx` were re-marked-up against the
 * mockup's stylesheet. That is exactly the kind of change that looks finished
 * and quietly drops a control: this repo has already shipped a settings page
 * where every field was read-only and 23 routes that 401'd everybody, both of
 * which rendered perfectly.
 *
 * So every row of CONVERSATION-PARITY.md is exercised here, in Chrome, against
 * the real database — not asserted by reading the source.
 *
 *   PORT=3360  node scripts/conversation-ui-test.mjs
 *
 * Chrome must be listening on 9450:
 *
 *   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
 *     --headless=new --remote-debugging-port=9450 --user-data-dir=/tmp/cdp-9450
 *
 * No Playwright, no Puppeteer — Node 24 has `fetch` and `WebSocket`, and the
 * driver below is the same ~40 lines `scripts/ui-test.mjs` uses.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND DOES NOT FIRE
 *
 * Reversible mutations are FIRED and then undone, because a control that is
 * merely present is the failure mode this file exists to catch:
 *
 *   · a label is removed and re-applied (the thread ends with the label it
 *     started with)
 *   · the thread is archived and moved straight back to the inbox
 *   · the panel is dragged wider and returned to its stored width
 *
 * Irreversible ones — sending an email, moving an agent to another client,
 * enrolling a lead in a sequence, writing a new address into the external
 * agents database — are opened, inspected and cancelled. Those rows are marked
 * "(code)" in the parity table.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3360";
const CDP = process.env.CDP || "http://localhost:9450";
const VIEW = "all-email";

/* ------------------------------ CDP driver ------------------------------ */

class Tab {
  #ws; #id = 0; #pending = new Map(); #handlers = [];
  static async open() {
    const t = new Tab();
    const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    t.targetId = target.id;
    t.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { t.#ws.onopen = ok; t.#ws.onerror = no; });
    t.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && t.#pending.has(m.id)) { t.#pending.get(m.id)(m); t.#pending.delete(m.id); }
      else if (m.method) for (const h of t.#handlers) h(m);
    };
    return t;
  }
  on(fn) { this.#handlers.push(fn); }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Waits for a JS expression to become truthy rather than sleeping a fixed
   amount — a timer either flakes or wastes seconds, and neither reports when
   the page was actually ready. */
async function until(tab, expr, ms = 25_000, every = 120) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await tab.eval(`(() => { try { return (${expr}); } catch (e) { return false; } })()`); }
    catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
}

async function goto(tab, path) {
  await tab.send("Page.navigate", { url: BASE + path });
  await until(tab, `document.readyState === "complete" && document.body.innerText.length > 800`);
  await until(tab, `!!document.querySelector(".mi-conv, .mi-list, .mi-row")`, 20_000);
  await sleep(500);
}

/*
 * A real press, not `el.click()`.
 *
 * The tool's dropdowns are base-ui, and base-ui opens on POINTERDOWN. A bare
 * `click()` dispatches no pointer events at all, so Move agent, Labels and
 * Snooze all "did nothing" — which would have read as three broken controls
 * rather than one wrong test.
 */
const PRESS = `(function press(el){
  if(!el) return false;
  const o={bubbles:true,cancelable:true,composed:true,pointerId:1,button:0,isPrimary:true,pointerType:"mouse"};
  el.dispatchEvent(new PointerEvent("pointerover",o));
  el.dispatchEvent(new PointerEvent("pointerenter",o));
  el.dispatchEvent(new PointerEvent("pointerdown",o));
  el.dispatchEvent(new MouseEvent("mousedown",o));
  el.dispatchEvent(new PointerEvent("pointerup",o));
  el.dispatchEvent(new MouseEvent("mouseup",o));
  el.click();
  return true;
})`;

const pressSel = (sel) => `${PRESS}(document.querySelector(${JSON.stringify(sel)}))`;
/* Finds a clickable by its visible text — menu items have no stable class. */
const pressText = (sel, text) =>
  `${PRESS}([...document.querySelectorAll(${JSON.stringify(sel)})].find(e => (e.innerText||e.textContent||"").trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())})))`;

/* ------------------------------- reporting ------------------------------ */

const results = [];
let failures = 0;
function record(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${id.padEnd(5)} ${name}${detail ? `  — ${detail}` : ""}`);
}
async function check(id, name, fn) {
  try {
    const r = await fn();
    if (r === true) return record(id, name, true);
    if (r && typeof r === "object") return record(id, name, !!r.ok, r.detail ?? "");
    return record(id, name, false, String(r));
  } catch (e) {
    return record(id, name, false, "threw: " + String(e.message).slice(0, 180));
  }
}

/* --------------------------------- run ---------------------------------- */

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const envRaw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const pick = (k) => { const m = envRaw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1,
});

const tab = await Tab.open();
const consoleErrors = [];
const netFails = [];
const reqUrl = new Map();
tab.on((m) => {
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  if (m.method === "Runtime.exceptionThrown")
    consoleErrors.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
  if (m.method === "Network.requestWillBeSent") reqUrl.set(m.params.requestId, m.params.request.url);
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
    netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  if (m.method === "Network.loadingFailed") {
    const t = m.params.errorText || "";
    if (!/ERR_ABORTED/.test(t)) netFails.push(`${t} ${(reqUrl.get(m.params.requestId) || "").replace(BASE, "")}`);
  }
});
await tab.send("Runtime.enable");
await tab.send("Network.enable");
await tab.send("Page.enable");
await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await tab.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
/* Copy-to-clipboard needs the permission or it throws and the toast is the
   failure toast, which would look like a broken button. */
await tab.send("Browser.grantPermissions", {
  origin: BASE,
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
}).catch(() => {});

console.log(`\n  Master Inbox · conversation view — ${BASE}\n`);

/* Pick a real thread off the real list, and one that has an inbound message so
   Reply / Reply all / Forward are reachable. */
await goto(tab, `/inbox/${VIEW}`);
const threadHrefs = await tab.eval(
  `[...document.querySelectorAll('a[href^="/inbox/${VIEW}/"]')].map(a=>a.getAttribute("href")).slice(0,12)`,
);
if (!threadHrefs?.length) {
  console.error("  ✗ no conversations in the list — cannot test the conversation view");
  process.exit(1);
}

let THREAD = null;
for (const href of threadHrefs) {
  await goto(tab, href);
  const inbound = await tab.eval(`document.querySelectorAll(".mi-msg.in").length`);
  if (inbound > 0) { THREAD = href; break; }
}
if (!THREAD) { THREAD = threadHrefs[0]; await goto(tab, THREAD); }
console.log(`  thread under test: ${THREAD}\n  --- 1 · shell + design language ---`);

/* ===================== 1 · the design language ========================== */

await check("1.0", "three-pane frame (.mi-conv rail/main/prospect)", async () => {
  const n = await tab.eval(`(() => {
    const c = document.querySelector(".mi-conv");
    if (!c) return null;
    return {
      rail: !!c.querySelector(":scope > .mi-conv-rail"),
      main: !!c.querySelector(":scope > .mi-conv-main.pcol.mid"),
      pros: !!c.querySelector(":scope > .mi-prospect.pcol"),
      display: getComputedStyle(c).display,
    };
  })()`);
  return { ok: !!n && n.rail && n.main && n.pros && n.display === "flex", detail: JSON.stringify(n) };
});

await check("1.0b", "every pane is inside .mi-theme", async () => {
  /*
   * The portals screens were the only Master Inbox screens never wrapped in
   * `.mi-theme`, and that is why every token remap stopped at their edge.
   * Asserted here rather than assumed: `inbox-theme.css` scopes the whole
   * palette AND the composer-overlay rule to this class, so a pane outside it
   * silently loses both.
   */
  const r = await tab.eval(`(() => {
    const inTheme = (s) => { const e = document.querySelector(s); return e ? !!e.closest(".mi-theme") : null; };
    return { conv: inTheme(".mi-conv"), rail: inTheme(".mi-conv-rail"),
             main: inTheme(".mi-conv-main"), prospect: inTheme(".mi-prospect"),
             tabs: inTheme(".mi-tabs"), filter: inTheme(".mi-filter") };
  })()`);
  const bad = Object.entries(r).filter(([, v]) => v !== true).map(([k]) => k);
  return { ok: bad.length === 0, detail: bad.length ? "OUTSIDE .mi-theme: " + bad.join(",") : "conversation, rail, prospect panel, tabs and filter bar all inside" };
});

await check("1.1", "design classes present, tool classes gone", async () => {
  const r = await tab.eval(`(() => {
    const has = (s) => document.querySelectorAll(s).length;
    return {
      tabs: has(".mi-tabs .mi-tab"), filter: has(".mi-filter"),
      ptool: has(".ptool"), ib: has(".ptool .ib"),
      msgs: has(".msgs"), msg: has(".msgs .msg"), who: has(".msg-who"), ava: has(".ava"),
      hd: has(".msg-hd .msg-sub"), hdrs: has(".msg-hdrs"), body: has(".msg-body"),
      pp: has(".mi-prospect .pp"), pptab: has(".pp-tabs .pp-tab"),
      pcard: has(".pcard"), pcardh: has(".pcard .pcard-h"), prow: has(".pcard .prow"),
      leftoverRounded: has(".msgs [class*='rounded-xl']"),
    };
  })()`);
  const need = ["tabs","filter","ptool","ib","msgs","msg","who","ava","hd","hdrs","body","pp","pptab","pcard","pcardh","prow"];
  const missing = need.filter((k) => !r[k]);
  return { ok: missing.length === 0 && r.leftoverRounded === 0, detail: missing.length ? "missing " + missing.join(",") : `pp-tabs=${r.pptab} prow=${r.prow} msg=${r.msg}` };
});

await check("1.2", "tokens resolve (no unpainted CSS variables)", async () => {
  const r = await tab.eval(`(() => {
    const el = document.querySelector(".msgs .msg");
    const tool = document.querySelector(".ptool");
    const cs = getComputedStyle(el), ct = getComputedStyle(tool);
    return { msgBg: cs.backgroundColor, msgRadius: cs.borderRadius, toolBorder: ct.borderBottomWidth };
  })()`);
  // Chrome 152 serialises #FFFFFF as `lab(100 0 0)`, so compare the colour, not the string.
  const white = /^(rgb\(255, 255, 255\)|lab\(100 0 0\)|#fff)/i.test(r.msgBg);
  return { ok: white && parseFloat(r.msgRadius) >= 12, detail: JSON.stringify(r) };
});

/* ===================== 2 · the toolbar ================================== */
console.log("  --- 2 · toolbar ---");

await check("2.1", "Back link keeps the view (and any ?f/?list/?page/?q)", async () => {
  const href = await tab.eval(`document.querySelector('.ptool a[aria-label="Back"]')?.getAttribute("href")`);
  return { ok: typeof href === "string" && href.startsWith(`/inbox/${VIEW}`), detail: String(href) };
});

await check("2.2", "Previous / Next present, disabled state honest", async () => {
  const r = await tab.eval(`(() => {
    const p = document.querySelector('.ptool [aria-label="Previous"]');
    const n = document.querySelector('.ptool [aria-label="Next"]');
    const off = (e) => !e ? "absent" : (e.classList.contains("is-off") ? "off" : (e.getAttribute("href") || "on"));
    return { prev: off(p), next: off(n),
             prevPointer: p ? getComputedStyle(p).pointerEvents : null };
  })()`);
  const ok = r.prev !== "absent" && r.next !== "absent" &&
    (r.prev !== "off" || r.prevPointer === "none");
  return { ok, detail: JSON.stringify(r) };
});

await check("2.3", "Refresh re-renders the thread", async () => {
  const before = await tab.eval(`document.querySelectorAll(".msgs .msg").length`);
  await tab.eval(pressSel('.ptool [aria-label="Refresh"]'));
  await sleep(2500);
  const after = await tab.eval(`document.querySelectorAll(".msgs .msg").length`);
  return { ok: after === before && after > 0, detail: `${before} → ${after} messages` };
});

await check("2.4", "Move agent opens and lists clients", async () => {
  await tab.eval(pressSel('.ptool [aria-label="Move agent"]'));
  const n = await until(tab, `document.querySelectorAll('[data-slot="dropdown-menu-item"]').length`, 12_000);
  const sample = await tab.eval(`[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].slice(0,2).map(e=>e.innerText.trim())`);
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  return { ok: (n ?? 0) >= 2, detail: `${n} clients, e.g. ${JSON.stringify(sample)} (not fired)` };
});

await check("2.5", "Snooze opens with its presets", async () => {
  await tab.eval(pressSel('.ptool [aria-label="Snooze"], .ptool [aria-label="Snoozed (manage)"]'));
  const items = await until(tab, `(() => { const t=[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map(e=>e.innerText.trim()); return t.length ? t : false; })()`, 8000);
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  const list = items || [];
  const hasCustom = list.some((t) => /custom/i.test(t));
  return { ok: list.length >= 4 && hasCustom, detail: `${list.length} options incl. ${list.filter((t)=>/custom|tomorrow|weekend/i.test(t)).join(" / ")}` };
});

await check("2.6", "Labels: remove and re-apply, round-trip to the server", async () => {
  const before = await tab.eval(`[...document.querySelectorAll(".pp-chips > span")].map(e=>e.innerText.trim())`);
  await tab.eval(pressSel('.ptool [aria-label="Labels"]'));
  const opened = await until(tab, `document.querySelectorAll('[data-slot="dropdown-menu-content"] button').length >= 3`, 8000);
  if (!opened) return { ok: false, detail: "picker did not open" };
  const labelName = before[0];
  if (!labelName) {
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    const count = await tab.eval(`document.querySelectorAll('[data-slot="dropdown-menu-content"] button').length`);
    return { ok: count >= 3, detail: `thread carries no label; picker lists ${count} (nothing toggled)` };
  }
  const chips = `[...document.querySelectorAll(".pp-chips > span")].map(e=>e.innerText.trim())`;
  // OFF. `router.refresh()` re-runs twelve server loaders, which is seconds not
  // milliseconds — wait for the chip to go, never for a stopwatch.
  await tab.eval(pressText('[data-slot="dropdown-menu-content"] button', labelName));
  const wentOff = await until(tab, `!(${chips}).includes(${JSON.stringify(labelName)})`, 30_000);
  const mid = await tab.eval(chips);
  // ON again — restore the thread exactly as it was.
  await tab.eval(pressSel('.ptool [aria-label="Labels"]'));
  await until(tab, `document.querySelectorAll('[data-slot="dropdown-menu-content"] button').length >= 3`, 12_000);
  await tab.eval(pressText('[data-slot="dropdown-menu-content"] button', labelName));
  await until(tab, `(${chips}).includes(${JSON.stringify(labelName)})`, 30_000);
  const after = await tab.eval(chips);
  if (!wentOff) return { ok: false, detail: `label "${labelName}" never came off` };
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  return {
    ok: !mid.includes(labelName) && after.includes(labelName),
    detail: `"${labelName}" → ${JSON.stringify(mid)} → ${JSON.stringify(after)}`,
  };
});

await check("2.7", "Archive, then Move to inbox — icon and label flip", async () => {
  await tab.eval(pressSel('.ptool [aria-label="Archive"]'));
  const left = await until(tab, `!location.pathname.includes("${THREAD.split("/").pop()}")`, 30_000);
  await goto(tab, THREAD);
  const nowLabel = await tab.eval(`document.querySelector('.ptool [aria-label="Move to inbox"]') ? "Move to inbox" : (document.querySelector('.ptool [aria-label="Archive"]') ? "Archive" : "none")`);
  if (nowLabel === "Move to inbox") {
    await tab.eval(pressSel('.ptool [aria-label="Move to inbox"]'));
    await sleep(2500);
    await goto(tab, THREAD);
  }
  const restored = await tab.eval(`!!document.querySelector('.ptool [aria-label="Archive"]')`);
  return { ok: !!left && nowLabel === "Move to inbox" && restored, detail: `archived → toolbar said "${nowLabel}" → restored=${restored}` };
});

await check("2.8", "Mark unread fires and returns to the list", async () => {
  await tab.eval(pressSel('.ptool [aria-label="Mark unread"]'));
  const left = await until(tab, `!location.pathname.includes("${THREAD.split("/").pop()}")`, 30_000);
  await goto(tab, THREAD); // re-opening marks it seen again
  return { ok: !!left, detail: left ? "navigated back to the list; re-opened (seen restored)" : "did not navigate" };
});

await check("2.9", "Delete ARMS instead of calling window.confirm", async () => {
  const hasConfirm = await tab.eval(`(() => { let called=false; const o=window.confirm; window.confirm=()=>{called=true;return false;};
     ${PRESS}(document.querySelector('.ptool [aria-label="Delete"]'));
     window.confirm=o; return called; })()`);
  await sleep(250);
  const armed = await tab.eval(`(() => {
    const b = document.querySelector('.ptool [aria-label="Confirm delete"]');
    const note = document.querySelector(".ptool .mi-arm-note");
    return { armedBtn: !!b, armedClass: b ? b.classList.contains("is-armed") : false,
             note: note ? note.innerText.trim() : null,
             red: b ? getComputedStyle(b).color : null };
  })()`);
  const disarmed = await until(tab, `!document.querySelector('.ptool [aria-label="Confirm delete"]')`, 7000);
  return {
    ok: hasConfirm === false && armed.armedBtn && armed.armedClass && !!armed.note && !!disarmed,
    detail: `confirm()=${hasConfirm}, armed=${armed.armedBtn}, note="${armed.note}", auto-disarmed=${!!disarmed} (never fired)`,
  };
});

/* ===================== 3 · messages ===================================== */
console.log("  --- 3 · messages ---");

await check("3.1", "messages render, oldest first, aligned by direction", async () => {
  const r = await tab.eval(`(() => {
    const all = [...document.querySelectorAll(".msgs .mi-msg")];
    const inb = all.filter(e => e.classList.contains("in"));
    const outb = all.filter(e => e.classList.contains("out"));
    const box = document.querySelector(".msgs").getBoundingClientRect();
    const leftOf = (e) => Math.round(e.getBoundingClientRect().left - box.left);
    return { total: all.length, in: inb.length, out: outb.length,
      inLeft: inb[0] ? leftOf(inb[0]) : null, outLeft: outb[0] ? leftOf(outb[0]) : null };
  })()`);
  const aligned = r.in === 0 || r.out === 0 || r.outLeft > r.inLeft;
  return { ok: r.total > 0 && aligned, detail: `${r.total} messages (${r.in} in / ${r.out} out), inbound x=${r.inLeft} outbound x=${r.outLeft}` };
});

await check("3.2", "avatars: inbound green, outbound blue", async () => {
  const r = await tab.eval(`(() => {
    const i = document.querySelector(".ava.in"), o = document.querySelector(".ava.out");
    return { in: i ? getComputedStyle(i).backgroundColor : null, out: o ? getComputedStyle(o).backgroundColor : null };
  })()`);
  return { ok: r.out === "rgb(1, 101, 254)" && (!r.in || r.in.startsWith("rgb(223")), detail: JSON.stringify(r) };
});

await check("3.3", "From / To / Cc header block", async () => {
  const r = await tab.eval(`(() => {
    const h = document.querySelector(".msg-hdrs");
    if (!h) return null;
    return { keys: [...h.querySelectorAll("b")].map(b=>b.innerText.trim()), bg: getComputedStyle(h).backgroundColor, text: h.innerText.slice(0,80) };
  })()`);
  const keys = (r?.keys ?? []).map((k) => k.toLowerCase());
  return { ok: keys.includes("from"), detail: r ? `${JSON.stringify(r.keys)} on ${r.bg}` : "absent" };
});

await check("3.4", "collapse → expand → collapse", async () => {
  const read = `(() => { const m = document.querySelector(".msgs .msg");
    const b = m.querySelector(".msg-body");
    return { max: b.style.maxHeight, h: Math.round(b.getBoundingClientRect().height),
             fade: !!m.querySelector(".mi-msg-fade") }; })()`;
  const a = await tab.eval(read);
  await tab.eval(pressSel(".msgs .msg .mi-msg-more button"));
  await sleep(400);
  const b = await tab.eval(read);
  await tab.eval(pressSel(".msgs .msg .mi-msg-more button"));
  await sleep(400);
  const c = await tab.eval(read);
  return {
    ok: a.max === "140px" && a.fade && b.max === "none" && !b.fade && c.max === "140px" && c.fade,
    detail: `${a.max}/fade=${a.fade} → ${b.max} (h=${b.h}) /fade=${b.fade} → ${c.max}/fade=${c.fade}`,
  };
});

await check("3.5", "Reply / Reply all / Forward on inbound only", async () => {
  const r = await tab.eval(`(() => {
    const q = (e, s) => e.querySelectorAll(s).length;
    const inb = [...document.querySelectorAll(".mi-msg.in")];
    const out = [...document.querySelectorAll(".mi-msg.out")];
    return {
      inboundActions: inb.map(e => [...e.querySelectorAll(".msg-acts .ib")].map(b=>b.getAttribute("aria-label"))),
      outboundActions: out.map(e => q(e, ".msg-acts .ib")),
    };
  })()`);
  const first = r.inboundActions[0] ?? [];
  const ok = first.join(",") === "Reply,Reply all,Forward" && r.outboundActions.every((n) => n === 0);
  return { ok, detail: `inbound=${JSON.stringify(first)}, outbound button counts=${JSON.stringify(r.outboundActions)}` };
});

/* ===================== 4 · the composer ================================= */
console.log("  --- 4 · composer ---");

const composerSel = '[class*="lg:w-[480px]"]';
const closeComposer = async () => {
  await tab.eval(pressSel(`${composerSel} [aria-label="Close"]`));
  await until(tab, `!document.querySelector(${JSON.stringify(composerSel)})`, 5000);
  await sleep(250);
};

await check("4.1", "floating Reply opens the composer and hides itself", async () => {
  await tab.eval(pressSel(".mi-reply-fab"));
  const open = await until(tab, `!!document.querySelector(${JSON.stringify(composerSel)})`, 8000);
  const fab = await tab.eval(`!!document.querySelector(".mi-reply-fab")`);
  return { ok: !!open && fab === false, detail: `composer open=${!!open}, reply pill hidden=${fab === false}` };
});

await check("4.2", "composer OVERLAYS — the conversation keeps its width", async () => {
  const r = await tab.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(composerSel)});
    const msgs = document.querySelector(".msgs");
    const pros = document.querySelector(".mi-prospect");
    const cs = getComputedStyle(c);
    return {
      position: cs.position, z: cs.zIndex, width: Math.round(c.getBoundingClientRect().width),
      msgsWidth: Math.round(msgs.getBoundingClientRect().width),
      prospectZ: getComputedStyle(pros).zIndex, prospectPos: getComputedStyle(pros).position,
      prospectVisible: pros.getBoundingClientRect().width > 100,
    };
  })()`);
  const ok = r.position === "absolute" && r.msgsWidth > 300 && r.prospectVisible &&
    Number(r.prospectZ) > Number(r.z);
  return { ok, detail: `composer ${r.position} z=${r.z} w=${r.width}; conversation still ${r.msgsWidth}px; panel z=${r.prospectZ} visible=${r.prospectVisible}` };
});

await check("4.3", "reply is pre-filled: To, locked Re: subject, quote", async () => {
  const r = await tab.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(composerSel)});
    const inputs = [...c.querySelectorAll("input")];
    const to = inputs.find(i => (i.placeholder||"").includes("email address"));
    const subj = inputs.find(i => (i.placeholder||"").includes("no subject")) || inputs.find(i => /Re:/i.test(i.value||""));
    return { to: to ? to.value : null, subject: subj ? subj.value : null,
             /* The composer deliberately keeps a reply's subject editable and
                warns in the tooltip instead of locking it — see its comment at
                composer.tsx "always editable". Assert the warning, not a lock. */
             threadWarning: subj ? /threading/i.test(subj.getAttribute("title") || "") : null,
             header: c.querySelector("h3") ? c.querySelector("h3").innerText.trim() : null };
  })()`);
  return { ok: !!r.to && r.to.includes("@") && /^re:/i.test(r.subject || "") && r.threadWarning === true, detail: JSON.stringify(r) };
});

await check("4.4", "composer controls: attach, templates, AI reply, send", async () => {
  // TipTap mounts a beat after the composer paints; waiting for the editor
  // rather than sleeping is the difference between "no rich text editor" and
  // "the test looked 200ms too early".
  await until(tab, `!!document.querySelector('.tiptap[contenteditable="true"], [contenteditable="true"]')`, 15_000);
  const r = await tab.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(composerSel)});
    const t = c.innerText;
    return {
      fileInputs: c.querySelectorAll('input[type="file"]').length,
      attach: !!c.querySelector('[aria-label="Attach file"]'),
      image: !!c.querySelector('[aria-label="Attach image"]'),
      ai: !!c.querySelector('[aria-label="Generate AI reply"]'),
      templates: !!c.querySelector('[aria-label="Insert template"]'),
      sender: !!c.querySelector('[aria-label="Choose sender mailbox"]'),
      send: /send/i.test(t),
      editor: !!c.querySelector('[contenteditable="true"], .tiptap, textarea'),
    };
  })()`);
  const missing = Object.entries(r).filter(([k, v]) => v === false || (k === "fileInputs" && v === 0)).map(([k]) => k);
  return { ok: missing.length === 0, detail: missing.length ? "missing " + missing.join(",") : JSON.stringify(r) };
});

await check("4.5", "Templates picker lists the workspace's templates", async () => {
  await tab.eval(pressSel(`${composerSel} [aria-label="Insert template"]`));
  const n = await until(tab, `document.querySelectorAll('[data-slot="popover-content"] button, [data-slot="dropdown-menu-content"] button').length`, 10_000);
  const search = await tab.eval(`!!document.querySelector('input[placeholder*="Search templates"]')`);
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  return { ok: (n ?? 0) > 0 || search, detail: `${n} entries, search box=${search}` };
});

await check("4.6", "Sender picker lists connected mailboxes", async () => {
  await tab.eval(pressSel(`${composerSel} [aria-label="Choose sender mailbox"]`));
  const search = await until(tab, `!!document.querySelector('input[placeholder^="Search "]')`, 8000);
  const n = await tab.eval(`document.querySelectorAll('[data-slot="popover-content"] button, [data-slot="dropdown-menu-content"] button').length`);
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  return { ok: !!search || n > 0, detail: `search=${!!search}, ${n} options` };
});

await check("4.7", "composer closes", async () => {
  await closeComposer();
  const gone = await tab.eval(`!document.querySelector(${JSON.stringify(composerSel)}) && !!document.querySelector(".mi-reply-fab")`);
  return { ok: gone, detail: gone ? "closed, reply pill back" : "still open" };
});

await check("4.8", "per-message Reply all carries the thread's Cc", async () => {
  await tab.eval(pressSel('.mi-msg.in .msg-acts [aria-label="Reply all"]'));
  const open = await until(tab, `!!document.querySelector(${JSON.stringify(composerSel)})`, 8000);
  const r = await tab.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(composerSel)});
    const inputs = [...c.querySelectorAll("input")];
    return { to: (inputs.find(i => (i.placeholder||"").includes("email address"))||{}).value,
             ccVisible: inputs.some(i => (i.placeholder||"").includes("email addresses")),
             text: c.innerText.slice(0, 60).replace(/\\n/g, " ") };
  })()`);
  await closeComposer();
  return { ok: !!open && !!r.to, detail: JSON.stringify(r) };
});

await check("4.9", "Forward seeds a quoted body and an EDITABLE subject", async () => {
  await tab.eval(pressSel('.mi-msg.in .msg-acts [aria-label="Forward"]'));
  const open = await until(tab, `!!document.querySelector(${JSON.stringify(composerSel)})`, 8000);
  const r = await tab.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(composerSel)});
    const inputs = [...c.querySelectorAll("input")];
    const subj = inputs.find(i => /^fwd:/i.test(i.value||""));
    const body = c.querySelector('[contenteditable="true"], textarea');
    const txt = body ? (body.innerText || body.value || "") : "";
    return { subject: subj ? subj.value.slice(0,40) : null,
             editable: subj ? !(subj.readOnly || subj.disabled) : null,
             quoted: /Forwarded message/i.test(txt),
             to: (inputs.find(i => (i.placeholder||"").includes("email address"))||{}).value };
  })()`);
  await closeComposer();
  return { ok: !!open && !!r.subject && r.editable === true && r.quoted, detail: JSON.stringify(r) };
});

/* ===================== 5 · the prospect panel =========================== */
console.log("  --- 5 · prospect panel ---");

await check("5.1", "identity block, labels, and the three tabs", async () => {
  const r = await tab.eval(`(() => {
    const p = document.querySelector(".mi-prospect");
    return {
      head: p.querySelector(".phd") ? p.querySelector(".phd").innerText.trim() : null,
      avatar: p.querySelector(".pp-av") ? p.querySelector(".pp-av").innerText.trim() : null,
      name: p.querySelector(".pp-id .who b") ? p.querySelector(".pp-id .who b").innerText.trim() : null,
      email: p.querySelector(".pp-id .mail span") ? p.querySelector(".pp-id .mail span").innerText.trim() : null,
      chips: [...p.querySelectorAll(".pp-chips > span")].map(e=>[e.innerText.trim(), e.className]),
      tabs: [...p.querySelectorAll(".pp-tab")].map(e=>e.innerText.trim()),
    };
  })()`);
  const tabs = r.tabs.map((t) => t.toLowerCase()).join(",");
  const ok = r.head === "Prospect details" && !!r.name && !!r.avatar && tabs === "details,attachments,notes" &&
    r.chips.every(([, cls]) => cls.includes("lc"));
  return { ok, detail: `${r.name} <${r.email}> · ${r.avatar} · chips=${JSON.stringify(r.chips.map(c=>c[0]))} · tabs=${r.tabs.join("/")}` };
});

await check("5.2", "tabs switch to Attachments and Notes and back", async () => {
  await tab.eval(pressText(".mi-prospect .pp-tab", "attachments"));
  await sleep(300);
  const att = await tab.eval(`document.querySelector(".mi-prospect .pp-empty")?.innerText.trim()`);
  await tab.eval(pressText(".mi-prospect .pp-tab", "notes"));
  await sleep(300);
  const notes = await tab.eval(`document.querySelector(".mi-prospect .pp-empty")?.innerText.trim()`);
  await tab.eval(pressText(".mi-prospect .pp-tab", "details"));
  await sleep(300);
  const back = await tab.eval(`document.querySelectorAll(".mi-prospect .pcard").length`);
  return { ok: /attachment/i.test(att || "") && /note/i.test(notes || "") && back > 0,
           detail: `"${att}" / "${notes}" / back to ${back} card(s)` };
});

await check("5.3", "agent card rows carry real values", async () => {
  const rows = await tab.eval(`[...document.querySelectorAll(".mi-prospect .pcard .prow")].map(r => [
      r.querySelector(".k") ? r.querySelector(".k").innerText.trim() : "",
      r.querySelector(".v") ? r.querySelector(".v").innerText.trim().replace(/\\n+/g," ").slice(0,44) : "",
    ])`);
  const keys = rows.map((r) => r[0]);
  const lower = keys.map((k) => k.toLowerCase());
  const missing = ["name", "email", "phone"].filter((k) => !lower.includes(k));
  return { ok: missing.length === 0 && rows.length >= 4, detail: `${rows.length} rows: ${keys.slice(0, 9).join(", ")}` };
});

await check("5.4", "card collapses and re-opens", async () => {
  const rowsIn = `document.querySelectorAll(".mi-prospect .pcard .prow").length`;
  const before = await tab.eval(rowsIn);
  await tab.eval(pressSel(".mi-prospect .pcard .pcard-h"));
  await sleep(400);
  const mid = await tab.eval(rowsIn);
  const expanded = await tab.eval(`document.querySelector(".mi-prospect .pcard .pcard-h").getAttribute("aria-expanded")`);
  await tab.eval(pressSel(".mi-prospect .pcard .pcard-h"));
  await sleep(400);
  const after = await tab.eval(rowsIn);
  return { ok: before > 0 && mid < before && after === before && expanded === "false",
           detail: `${before} rows → ${mid} (aria-expanded=${expanded}) → ${after}` };
});

await check("5.5", "+ Add email opens an inline form and cancels", async () => {
  await tab.eval(pressText(".mi-prospect .pp-link", "add email"));
  await sleep(350);
  const r = await tab.eval(`(() => {
    const f = document.querySelector('.mi-prospect input[aria-label="New email address"]');
    if (!f) return null;
    const add = f.closest(".pp-add");
    return { placeholder: f.placeholder, width: Math.round(f.getBoundingClientRect().width),
             save: !!add.querySelector(".pp-btn.pri"), cancel: !!add.querySelector(".pp-btn:not(.pri)"),
             panelWidth: Math.round(document.querySelector(".mi-prospect").getBoundingClientRect().width) };
  })()`);
  if (!r) return { ok: false, detail: "form did not open" };
  await tab.eval(pressText(".mi-prospect .pp-add .pp-btn", "cancel"));
  await sleep(300);
  const closed = await tab.eval(`!document.querySelector('.mi-prospect input[aria-label="New email address"]')`);
  return { ok: r.save && r.cancel && closed && r.width < r.panelWidth,
           detail: `input ${r.width}px inside a ${r.panelWidth}px panel, save+cancel present, cancelled=${closed} (not saved)` };
});

await check("5.6", "+ Add phone opens an inline form and cancels", async () => {
  await tab.eval(pressText(".mi-prospect .pp-link", "add phone"));
  await sleep(350);
  const r = await tab.eval(`(() => {
    const f = document.querySelector('.mi-prospect input[aria-label="New phone number"]');
    if (!f) return null;
    const add = f.closest(".pp-add");
    return { placeholder: f.placeholder, save: !!add.querySelector(".pp-btn.pri") };
  })()`);
  if (!r) return { ok: false, detail: "form did not open" };
  await tab.eval(pressText(".mi-prospect .pp-add .pp-btn", "cancel"));
  await sleep(300);
  const closed = await tab.eval(`!document.querySelector('.mi-prospect input[aria-label="New phone number"]')`);
  return { ok: r.save && closed, detail: `placeholder "${r.placeholder}", cancelled=${closed} (not saved)` };
});

await check("5.7", "copy writes to the clipboard", async () => {
  await tab.eval(`navigator.clipboard.writeText("__before__")`).catch(() => {});
  await tab.eval(pressSel('.mi-prospect .pp-id .cp'));
  await sleep(700);
  const r = await tab.eval(`navigator.clipboard.readText().then(t => t).catch(e => "ERR:" + e.message)`);
  const toast = await tab.eval(`document.body.innerText.includes("Copied to clipboard")`);
  return { ok: (typeof r === "string" && r.includes("@")) || toast, detail: `clipboard="${String(r).slice(0,40)}", toast=${toast}` };
});

await check("5.8", "sequencing picker matches the thread's provider", async () => {
  const r = await tab.eval(`(() => {
    const foot = document.querySelector(".mi-prospect .pcard-foot");
    const src = [...document.querySelectorAll(".mi-prospect .prow")].find(p => p.querySelector(".k") && p.querySelector(".k").innerText.trim().toLowerCase() === "source");
    return { provider: src ? src.querySelector(".v").innerText.trim() : null,
             foot: foot ? foot.innerText.trim().replace(/\\n+/g, " ").slice(0, 70) : null };
  })()`);
  const p = (r.provider || "").toLowerCase();
  const ok = p === "instantly" ? /subsequence/i.test(r.foot || "")
    : p === "emailbison" ? /follow-?up|campaign/i.test(r.foot || "")
    : !!r.foot;
  return { ok, detail: `source=${r.provider} → "${r.foot}"` };
});

await check("5.9", "panel resizes by drag and persists the width", async () => {
  const start = await tab.eval(`(() => { const p=document.querySelector(".mi-prospect");
    const g=p.querySelector(".mi-prospect-grip").getBoundingClientRect();
    return { w: Math.round(p.getBoundingClientRect().width), x: Math.round(g.left+g.width/2), y: Math.round(g.top+200) }; })()`);
  const drag = async (dx) => {
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1, buttons: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + dx, y: start.y, button: "left", buttons: 1 });
    await sleep(200);
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + dx, y: start.y, button: "left", buttons: 0 });
    await sleep(300);
  };
  await drag(-80);
  const wider = await tab.eval(`Math.round(document.querySelector(".mi-prospect").getBoundingClientRect().width)`);
  const stored = await tab.eval(`window.localStorage.getItem("inbox-prospect-panel-width")`);
  // Put it back where it was.
  await tab.eval(`window.localStorage.setItem("inbox-prospect-panel-width", "${start.w}")`);
  return { ok: wider > start.w + 40 && Number(stored) === wider,
           detail: `${start.w}px → ${wider}px, localStorage="${stored}" (restored to ${start.w})` };
});

/* ===================== 6 · navigation between threads =================== */
console.log("  --- 6 · navigation ---");

await check("6.1", "Next moves to the next conversation, Previous comes back", async () => {
  const here = await tab.eval(`location.pathname`);
  const nextHref = await tab.eval(`document.querySelector('.ptool [aria-label="Next"]')?.getAttribute("href")`);
  if (!nextHref) return { ok: false, detail: "no next link" };
  await tab.eval(pressSel('.ptool [aria-label="Next"]'));
  const moved = await until(tab, `location.pathname !== ${JSON.stringify(here)}`, 15_000);
  await until(tab, `!!document.querySelector(".mi-conv")`, 15_000);
  const there = await tab.eval(`location.pathname`);
  await tab.eval(pressSel('.ptool [aria-label="Previous"]'));
  const backOk = await until(tab, `location.pathname === ${JSON.stringify(here)}`, 15_000);
  await until(tab, `!!document.querySelector(".mi-conv")`, 15_000);
  return { ok: !!moved && !!backOk, detail: `${here.split("/").pop().slice(0,8)} → ${there.split("/").pop().slice(0,8)} → back` };
});

await check("6.2", "Back / Prev / Next preserve ?q= and ?page= (buildSuffix)", async () => {
  /* The SERHANT. bug: navigating out of a thread dropped the active filter and
     dumped the operator into the unfiltered inbox. `?q=` and `?page=` run
     through the same `buildSuffix` as `?list=` and need no ids to set up. */
  await goto(tab, `${THREAD}?q=zillow&page=1`);
  const r = await tab.eval(`(() => {
    const g = (s) => document.querySelector(s)?.getAttribute("href") ?? null;
    return { back: g('.ptool a[aria-label="Back"]'), next: g('.ptool a[aria-label="Next"]'), prev: g('.ptool a[aria-label="Previous"]') };
  })()`);
  const hrefs = Object.values(r).filter(Boolean);
  const ok = hrefs.length > 0 && hrefs.every((h) => h.includes("q=zillow") && h.includes("page=1"));
  await goto(tab, THREAD);
  return { ok, detail: `${hrefs.length} link(s): ${JSON.stringify(r)}` };
});

await check("6.3", "the thread rail is the tool's, restyled — and still works", async () => {
  const r = await tab.eval(`(() => {
    const rail = document.querySelector(".mi-conv-rail");
    const rows = rail.querySelectorAll("li > a");
    const active = rail.querySelector('li > a[class~="bg-accent"]');
    const inactive = [...rows].find(a => !a.matches('[class~="bg-accent"]'));
    const head = rail.firstElementChild;
    const scroller = [...rail.querySelectorAll("div")].find(d => d.scrollHeight > d.clientHeight + 5);
    return {
      rows: rows.length,
      pad: rows[0] ? getComputedStyle(rows[0]).padding : null,
      activeBg: active ? getComputedStyle(active).backgroundColor : null,
      nonActiveBg: inactive ? getComputedStyle(inactive).backgroundColor : null,
      headText: head ? head.innerText.trim().replace(/\\n+/g, " ").slice(0, 40) : null,
      pager: rail.querySelectorAll("a[href*='page='], button").length,
      scrolls: !!scroller,
    };
  })()`);
  const ok = r.rows > 3 && r.pad === "12px 14px" && r.activeBg !== r.nonActiveBg && /of/.test(r.headText || "");
  return { ok, detail: `${r.rows} rows, pad ${r.pad}, header "${r.headText}", active ${r.activeBg} vs ${r.nonActiveBg}` };
});

await check("6.4", "Back returns to the conversation list", async () => {
  await tab.eval(pressSel('.ptool a[aria-label="Back"]'));
  const there = await until(tab, `location.pathname === "/inbox/${VIEW}"`, 15_000);
  await until(tab, `document.querySelectorAll('a[href^="/inbox/${VIEW}/"]').length > 3`, 15_000);
  return { ok: !!there, detail: await tab.eval(`location.pathname`) };
});

/* ------------------------------- verdict -------------------------------- */

/*
 * Two console messages are EXPECTED, and both are named here rather than
 * filtered silently — a test that quietly swallows errors is how the 23 routes
 * that 401'd everybody got through.
 *
 *   "Connection closed" — an RSC stream aborted because Archive and Mark unread
 *   navigate away while `router.refresh()` is still in flight. Dev-only; the
 *   navigation is the point.
 *
 *   the hydration attribute warning — base-ui's <Checkbox> inside the tool's
 *   `thread-list.tsx` renders `data-unchecked` on the client that the server
 *   did not. Neither file is part of this rebuild; see CONVERSATION-PARITY.md
 *   "Pre-existing defects found while testing".
 */
const KNOWN = [
  { re: /Connection closed/i, why: "RSC stream aborted by a navigation (Archive / Mark unread) — dev only" },
  { re: /A tree hydrated but some attributes/i, why: "base-ui <Checkbox> in the tool's thread-list.tsx — pre-existing, not this rebuild" },
];
const allErrors = [...new Set(consoleErrors)].filter((e) => !/favicon|Download the React DevTools/i.test(e));
const knownErrors = allErrors.filter((e) => KNOWN.some((k) => k.re.test(e)));
const realErrors = allErrors.filter((e) => !KNOWN.some((k) => k.re.test(e)));
/* The composer's unmount flush uses navigator.sendBeacon, which is always a
   POST, against a route that only exports PUT and DELETE. Pre-existing, in
   composer.tsx — reported, not swallowed. */
const allNetFails = [...new Set(netFails)].filter((n) => !/favicon/i.test(n));
/*
 * A request to somewhere that is not this app is EMAIL CONTENT, not the inbox:
 * `cid:` references to inline attachments the sender did not include, and
 * expired googleusercontent signature images. They 404 in Gmail too. Counted
 * and named, never failed on — otherwise the suite's verdict depends on which
 * conversation the list happened to put first.
 */
const foreign = (n) => /https?:\/\/(?!localhost)|cid:/.test(n);
const emailAssets = allNetFails.filter(foreign);
const appFails = allNetFails.filter((n) => !foreign(n));
const knownNetFails = appFails.filter((n) => /405 .*composer-draft/.test(n));
const realNetFails = appFails.filter((n) => !/405 .*composer-draft/.test(n));

console.log(`\n  ${results.length - failures}/${results.length} checks passed`);
if (realErrors.length) {
  console.log(`\n  console errors (${realErrors.length}):`);
  for (const e of realErrors.slice(0, 6)) console.log(`    ${e}`);
}
if (realNetFails.length) {
  console.log(`\n  failed requests (${realNetFails.length}):`);
  for (const n of realNetFails.slice(0, 6)) console.log(`    ${n}`);
}
if (emailAssets.length) {
  console.log(`\n  ${emailAssets.length} remote asset(s) inside the email bodies did not load — sender's content, not the inbox:`);
  for (const n of emailAssets.slice(0, 3)) console.log(`    ${n.slice(0, 110)}…`);
}
if (!realErrors.length && !realNetFails.length) console.log("  no unexpected console errors, no unexpected failed requests");
if (knownErrors.length || knownNetFails.length) {
  console.log("\n  known, pre-existing, NOT introduced by this rebuild:");
  for (const e of knownErrors) console.log(`    · ${KNOWN.find((k) => k.re.test(e)).why}`);
  for (const n of knownNetFails) console.log(`    · ${n} — composer.tsx flushes its draft with sendBeacon (POST); the route exports PUT/DELETE only`);
}

await tab.close();
process.exit(failures || realErrors.length ? 1 : 0);
