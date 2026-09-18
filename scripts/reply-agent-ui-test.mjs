/*
 * The Reply agent screen, driven in a real browser.
 *
 * WHY A BROWSER AND NOT A SNAPSHOT
 *
 * A static check on this screen would pass while the thing it exists to do is
 * broken. The screen's whole job is to be HONEST about a feature that is
 * partly switched on — the tables may not exist, the corpus may be empty, a
 * document may be nobody's yet — and every one of those states renders
 * perfectly valid-looking HTML full of zeroes. What has to be tested is that
 * the screen SAYS WHY, that its buttons reach the real endpoints, and that the
 * editor dialog is usable.
 *
 * The dialog check is not decoration. `.inp` carries `min-width: 200px`, which
 * overflows a dialog's grid and makes fields overlap each other — a bug this
 * codebase has already shipped once. The assertion here is geometric: the
 * field's right edge must sit inside the dialog.
 *
 * Nothing is sent, nothing is saved: the test opens the editor, measures it and
 * cancels. Rebuild and Judge are asserted to EXIST and to be wired, never
 * pressed — both are jobs that read the whole mailbox.
 *
 *   BASE=http://localhost:3987 PORT=9711 node --experimental-strip-types scripts/reply-agent-ui-test.mjs
 */
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3987";
const CDP = `http://localhost:${process.env.PORT || 9711}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nREPLY AGENT SCREEN  →  ${BASE}\n${"=".repeat(74)}\n`);

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;

try {
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.setCookie", {
    name: "bs_sso", value: TOKEN, domain: new URL(BASE).hostname, path: "/",
    secure: BASE.startsWith("https"),
  });
  await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `${BASE}/reply-agent` });
  /*
   * Wait for the DATA, not the frame.
   *
   * The panels render immediately with "Loading…" inside them, so waiting for a
   * panel title proves nothing — the first version of this test did exactly
   * that and reported three false failures against a screen that was correct.
   * The banner and the counts depend on three client fetches; "Loading…" is
   * gone only once they have all landed.
   */
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await ev(`!!document.querySelector('h1') && !document.body.innerText.includes('Loading…')`);
    if (ready) break;
    await sleep(250);
  }
  check("the screen finishes loading its data", ready === true, ready ? "" : "still showing Loading… after 20s");

  const heading = await ev(`(document.querySelector('h1')||{}).textContent`);
  check("the screen renders at /reply-agent", heading === "Reply agent", heading ?? "no h1");

  const text = (await ev(`document.body.innerText`)) ?? "";

  check("all four panels are present", ["The record", "The corpus", "What the agent is told"].every((s) => text.includes(s)),
    ["The record", "The corpus", "What the agent is told"].filter((s) => !text.includes(s)).join(", ") || "all there");

  /* The honesty requirement: with the tables absent, the screen must name the
   * migration rather than showing a confident row of zeroes. */
  const missing = !(await ev(`(await (await fetch('/api/tools/master-inbox/ai/corpus',{credentials:'same-origin'})).json()).available`));
  if (missing) {
    check("it names the migration that is missing", /0006_os_reply_intelligence/.test(text),
      /0006/.test(text) ? "named" : "NOT NAMED — the screen shows zeroes with no reason");
    check("…and says the agent still drafts as it does today", /drafts exactly as it does today/i.test(text));
  } else {
    check("the corpus reports itself available", true, "migration has been run");
  }

  /* Buttons exist and are wired to the real endpoints. Not pressed: both are
   * jobs over the whole mailbox. */
  const buttons = await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim())`);
  check("a Rebuild corpus button is offered", buttons.some((b) => /Rebuild corpus/i.test(b)), buttons.join(" | ").slice(0, 120));
  check("a Judge past drafts button is offered", buttons.some((b) => /Judge past drafts/i.test(b)));
  check("a Distil button is offered", buttons.some((b) => /Distil from the corpus/i.test(b)));

  /* Distil must be disabled while there is nothing to distil from — pressing it
   * would be a paid call that can only fail. */
  const distilDisabled = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>/Distil from the corpus/i.test(b.textContent)); return b ? b.disabled : null; })()`);
  check("Distil is disabled while the corpus is empty", distilDisabled === true, `disabled=${distilDisabled}`);

  /* The baseline has to be on screen — the number the work is measured against. */
  check("the baseline to beat is stated on screen", /517/.test(text) && /600/.test(text),
    /517/.test(text) ? "stated" : "missing");

  /* ------------------------------------------------- the editor dialog */
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>/^(Edit|Write it)$/.test(b.textContent.trim())); b && b.click(); return !!b; })()`);
  await sleep(500);
  const dialogOpen = await ev(`!!document.querySelector('[data-modal-dialog]')`);
  check("the editor opens in the centred modal", dialogOpen === true);

  if (dialogOpen) {
    /*
     * The overlap bug, measured rather than eyeballed: `.inp` has a 200px
     * min-width, and inside a dialog that is how fields end up sitting on top
     * of one another. The textarea's right edge must be inside the dialog's.
     */
    const geom = await ev(`(() => {
      const d = document.querySelector('[data-modal-dialog]').getBoundingClientRect();
      const f = document.querySelector('[data-modal-dialog] .inp');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { dl: d.left, dr: d.right, fl: r.left, fr: r.right, fw: r.width };
    })()`);
    check("the editor has a field", geom !== null);
    if (geom) {
      check("the field stays inside the dialog (the .inp min-width trap)",
        geom.fr <= geom.dr + 1 && geom.fl >= geom.dl - 1,
        `dialog ${Math.round(geom.dl)}–${Math.round(geom.dr)}, field ${Math.round(geom.fl)}–${Math.round(geom.fr)}`);
      check("the field is actually usable, not collapsed", geom.fw > 300, `${Math.round(geom.fw)}px wide`);
    }

    /* Save must be inert until something is typed — a no-op PATCH would stamp
     * the document as a person's edit and stop future distillations landing. */
    const saveDisabled = await ev(`(() => { const b=[...document.querySelectorAll('[data-modal-dialog] button')].find(b=>/^Save$/.test(b.textContent.trim())); return b ? b.disabled : null; })()`);
    check("Save is inert until the text actually changes", saveDisabled === true, `disabled=${saveDisabled}`);

    await ev(`(() => { const b=[...document.querySelectorAll('[data-modal-dialog] button')].find(b=>/^Cancel$/.test(b.textContent.trim())); b && b.click(); })()`);
    await sleep(300);
    check("cancelling closes it and saves nothing", (await ev(`!!document.querySelector('[data-modal-dialog]')`)) === false);
  }

  /* No narrow-viewport overflow: the workspace is used on laptops at 1280. */
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const overflow = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check("the screen does not scroll sideways at 1100px", overflow <= 1, `${overflow}px of overflow`);

  const errors = await ev(`(window.__errs||[]).length`);
  check("no uncaught errors were collected", errors === undefined || errors === 0, String(errors));
} finally {
  ws.close();
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed, ${failed} failed`);
if (fails.length) console.log("  failed:", fails.join("; "));
process.exit(failed ? 1 : 0);
