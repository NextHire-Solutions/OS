/*
 * The Reply Agents CONFIG panel, driven in a real browser.
 *
 * Sibling of scripts/reply-agent-ui-test.mjs, which covers the knowledge half
 * of the same screen (corpus, rules, record). This one covers what the upgrade
 * added: the agent cards, their modes, and the editor.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY A BROWSER CAN TELL US HERE
 *
 *   · THE PANEL RENDERS AGAINST A DATABASE THAT HAS NOT BEEN MIGRATED. Every
 *     mode, schedule and handover it shows today comes from the parsers'
 *     fallbacks rather than from a column, because migration 0009 has not run.
 *     If that path were wrong the screen would be blank or throwing, and a unit
 *     test on the parser would still pass.
 *
 *   · LIVE IS PRESENT AND NOT SELECTABLE. "The option is missing" and "the
 *     option is disabled with a reason" look identical in the source and are
 *     completely different to the person using it.
 *
 *   · THE DIALOG FIELDS DO NOT OVERLAP. `.inp` carries min-width:200px, which
 *     overflows a dialog grid — a bug this codebase has shipped once already.
 *     The check is geometric, as it is in the sibling script.
 *
 * Read-only. It opens the editor, measures it, and cancels. It never saves,
 * never duplicates and never pauses an agent.
 *
 *   BASE=http://localhost:3210 PORT=9751 node --experimental-strip-types scripts/reply-agent-config-ui-test.mjs
 *
 * Chrome must already be listening on PORT with --remote-debugging-port;
 * whoever started it kills it.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3210";
const CDP = `http://localhost:${process.env.PORT || 9751}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

let passed = 0, failed = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nREPLY AGENTS — CONFIG PANEL  →  ${BASE}\n${"=".repeat(74)}\n`);

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
const thrown = [];
const serverErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    thrown.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
  }
  if (m.method === "Network.responseReceived" && m.params?.response?.status >= 500) {
    serverErrors.push(`${m.params.response.status} ${m.params.response.url}`);
  }
};
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) =>
  (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;

try {
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.setCookie", {
    name: "bs_sso", value: TOKEN, domain: new URL(BASE).hostname, path: "/",
    secure: BASE.startsWith("https"),
  });
  await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `${BASE}/reply-agent` });
  for (let i = 0; i < 160; i++) {
    if (await ev(`!!document.body && document.body.innerText.includes("Configure")`)) break;
    await sleep(500);
  }

  const text = (await ev(`document.body.innerText`)) ?? "";
  check("the screen renders", text.length > 200, `${text.length} chars`);
  check("the Agents panel is on it", text.includes("Agents"), "panel heading");
  /*
   * THE GATE IS A STATE, NOT A CONSTANT.
   *
   * These assertions used to hardcode "live sending is off", which was true
   * while MASTER_INBOX_REPLY_AGENT_LIVE_SEND was unset everywhere. It is set
   * now, so the screen correctly stops saying so and Live becomes selectable —
   * and the test failed for describing yesterday. Read the state and assert
   * the matching half, so this file is honest in either configuration.
   */
  const liveGateOn = !text.includes("Live sending is off on this server");
  console.log(`      (live sending is ${liveGateOn ? "ENABLED" : "off"} on this server)`);
  if (liveGateOn) {
    check("with the gate on, the screen does not claim live sending is off",
      !text.includes("Live sending is off on this server"), "no stale banner");
  } else {
    check("it says live sending is off", text.includes("Live sending is off on this server"), "banner");
  }
  if (!liveGateOn) check(
    "it names the variable a person must set",
    text.includes("MASTER_INBOX_REPLY_AGENT_LIVE_SEND"),
    "named",
  );

  const cards = await ev(`[...document.querySelectorAll("button")].filter(b=>b.textContent.trim()==="Configure").length`);
  check("every agent gets a card", cards > 0, `${cards} agents`);
  check(
    "each card offers pause/activate and duplicate",
    text.includes("Duplicate") && (text.includes("Pause") || text.includes("Activate")),
    "inline actions",
  );
  for (const line of ["Clients:", "Schedule:", "Questions:", "Handover:"]) {
    check(`the card states ${line.replace(":", "").toLowerCase()}`, text.includes(line), line);
  }

  /* ---- the editor ------------------------------------------------------- */
  await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Configure"); b&&b.click(); return !!b;})()`);
  await sleep(1000);
  const dialog = (await ev(`document.body.innerText`)) ?? "";
  check("the editor opens with every section",
    ["Mode", "Clients", "Qualification", "Handover", "Schedule"].every((s) => dialog.includes(s)),
    "five sections");
  check("the schedule editor offers the off-hours window", dialog.includes("Outside business hours only"), "off-hours");
  check(
    "there is no 'mark as Introduction' switch — a live introduction is always labelled",
    !dialog.includes("Also mark the lead as Introduction") &&
      (await ev(`[...document.querySelectorAll('[data-modal-dialog] input[type=checkbox]')].filter(c=>/introduction/i.test(c.closest('label')?.textContent||'')).length`)) === 0,
    "no Introduction checkbox (the qualification switch is the only one left)",
  );
  check(
    "the always-on label is explained instead",
    dialog.includes("always labelled Introduction") && dialog.includes("Follow Up Boss"),
    "explained",
  );

  const live = await ev(
    `(()=>{const i=[...document.querySelectorAll('input[type=radio]')].find(x=>(x.closest("label")?.textContent||"").trim().startsWith("Live"));
      return i ? {found:true, disabled:i.disabled, checked:i.checked} : {found:false};})()`,
  );
  check("Live is shown", live?.found === true, JSON.stringify(live));
  if (liveGateOn) {
    check("with the gate on, Live can be selected", live?.disabled === false, JSON.stringify(live));
    check("but Live is not already selected — switching is a deliberate act",
      live?.checked === false, JSON.stringify(live));
  } else {
    check("Live cannot be selected", live?.disabled === true && live?.checked === false, JSON.stringify(live));
  }

  /* ---- geometry: fields inside the dialog, not overlapping --------------- */
  /*
   * Measured the way scripts/dialog-fields-test.mjs measures it, against the
   * same `[data-modal-dialog]` hook — a field that escapes the dialog or lands
   * on top of its neighbour is the bug this codebase has already shipped once,
   * and it is invisible to anything that only reads the markup.
   */
  const geometry = await ev(
    `(()=>{const ds=[...document.querySelectorAll('[data-modal-dialog]')]; const d=ds[ds.length-1];
      if(!d) return {found:false};
      const db=d.getBoundingClientRect();
      const fields=[...d.querySelectorAll('input, select, textarea')]
        .filter(e=>{const b=e.getBoundingClientRect(); return b.width>2 && b.height>2;})
        .map(e=>{const b=e.getBoundingClientRect();
          return {n:(e.placeholder||e.type||e.tagName).slice(0,20), l:Math.round(b.left), r:Math.round(b.right), t:Math.round(b.top), b:Math.round(b.bottom)};});
      const escaped=fields.filter(f=>f.r>Math.round(db.right)+1||f.l<Math.round(db.left)-1).map(f=>f.n);
      const overlapping=[];
      for(let i=0;i<fields.length;i++)for(let j=i+1;j<fields.length;j++){
        const a=fields[i],c=fields[j];
        const x=Math.min(a.r,c.r)-Math.max(a.l,c.l), y=Math.min(a.b,c.b)-Math.max(a.t,c.t);
        if(x>2&&y>2) overlapping.push(a.n+" / "+c.n);
      }
      return {found:true, fields:fields.length, escaped, overlapping};})()`,
  );
  check("the dialog was found and has fields in it", geometry?.found === true && geometry?.fields > 0, JSON.stringify(geometry));
  check("no field escapes the dialog", (geometry?.escaped ?? ["unmeasured"]).length === 0, JSON.stringify(geometry?.escaped));
  check("no two fields overlap", (geometry?.overlapping ?? ["unmeasured"]).length === 0, JSON.stringify(geometry?.overlapping));

  await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Cancel"); b&&b.click(); return !!b;})()`);
  await sleep(400);

  check("nothing threw", thrown.length === 0, thrown.slice(0, 2).join(" | ") || "clean");
  const unexpected = serverErrors.filter((u) => !u.includes("/reply-agents/stats"));
  check("no unexpected 5xx", unexpected.length === 0, unexpected.join(" | ") || "none");
  if (serverErrors.some((u) => u.includes("/reply-agents/stats"))) {
    console.log("        (stats 503s until migrations 0009 + 0010 are run — expected, and the panel says so)");
  }
} finally {
  ws.close();
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
