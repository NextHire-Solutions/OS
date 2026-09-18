/*
 * The Introduce button tags the thread — on SEND, never on the click.
 *
 * Applying the Introduction label is not bookkeeping: it messages the client,
 * posts to Slack, opens a portal pipeline entry and pushes it to Follow Up
 * Boss. So the timing is the thing under test, and the two properties that
 * matter are opposites:
 *
 *   clicking Introduce must NOT label     (the draft may still be abandoned)
 *   sending that draft MUST label         (the introduction really happened)
 *
 * Nothing real is sent and nothing real is labelled: window.fetch is patched
 * inside the page so the reply and the label calls are recorded and answered
 * locally. The thread's true label is read from the database before and after
 * to prove the run left it alone.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const CDP = `http://localhost:${process.env.PORT || 9601}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const SB = pick("MASTER_INBOX_SUPABASE_URL"), SK = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const sb = async (p) => (await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: SK, Authorization: `Bearer ${SK}` } })).json();

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nINTRODUCE → INTRODUCTION LABEL\n${"=".repeat(74)}\n`);

/* The label the whole feature turns on. */
const [introLabel] = await sb("labels?select=id,name&name=ilike.introduction&limit=1");
check("the workspace has an Introduction label", !!introLabel?.id, introLabel?.id ?? "missing");
const LABEL_ID = introLabel?.id;

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;

await send("Network.enable");
await send("Network.setCookie", { name: "bs_sso", value: TOKEN, domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https") });
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

let threadId = null, labelBefore = null;
try {
  await send("Page.navigate", { url: `${BASE}/inbox/all-email` });
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelectorAll('a.mi-row').length`)) > 3) break; await sleep(250); }
  const href = await ev(`(document.querySelector('a.mi-row')||{}).getAttribute?.('href')`);
  threadId = href ? href.split("/").pop() : null;
  check("a conversation opens", !!threadId, href ?? "no row");
  if (!threadId) throw new Error("no thread");

  const rowsBefore = await sb(`label_assignments?select=label_id&target_type=eq.thread&target_id=eq.${threadId}`);
  labelBefore = JSON.stringify(rowsBefore);
  console.log(`\n  thread ${threadId}\n  labels before the run: ${labelBefore}\n`);

  await send("Page.navigate", { url: `${BASE}${href}` });
  await sleep(3500);

  /*
   * Everything the composer talks to, intercepted in the page.
   *
   * intro-macro is stubbed because no real conversation's client has
   * introduction details yet, and the reply and label calls are stubbed so the
   * test can assert what WOULD happen without it happening.
   */
  const install = `(() => {
    window.__calls = [];
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (/\\/intro-macro$/.test(url)) {
        return new Response(JSON.stringify({
          available: true, clientName: "Oz Group",
          body: "Hey {{lead.name}},\\n\\nI'd like to introduce you to Nicole Collins, Team Leader at Oz Group\\n\\nNicole, I recently connected with {{lead.first_name}}, who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\\n\\n{{lead.first_name}}, Nicole will be in touch directly to learn more about your business and discuss the opportunity in greater detail.\\n\\nI hope you have a productive conversation!\\n\\nBest,\\n{{sender.name}}\\nTalent Acquisition | Oz Group",
          cc: "nicole@ozgroup.test",
          introductionLabelId: ${JSON.stringify(LABEL_ID)},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/\\/reply$/.test(url) && method === "POST") {
        window.__calls.push({ what: "reply", method });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/\\/labels$/.test(url) && method === "POST") {
        let body = null; try { body = JSON.parse(init && init.body); } catch {}
        window.__calls.push({ what: "labels", method, body });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    };
    return true;
  })()`;
  await ev(install);

  const openComposer = `(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*reply\\s*$/i.test((x.innerText||'').trim())); if(b) b.click(); return !!b; })()`;
  await ev(openComposer);
  await sleep(2500);

  const clickIntro = `(() => { const b=document.querySelector('button[aria-label="Insert the introduction"]'); if(!b||b.disabled) return false; b.click(); return true; })()`;
  const clickSend  = `(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*send\\s*$/i.test((x.innerText||'').trim())); if(!b||b.disabled) return false; b.click(); return true; })()`;
  const bodyOf     = `(() => { const e=document.querySelector('[contenteditable="true"]'); return e ? (e.innerText||'').trim() : null; })()`;
  const callsOf    = `JSON.stringify(window.__calls||[])`;

  /* ------------------------------------------- 1. the click must not label */
  const clicked = await ev(clickIntro);
  check("the Introduce button is usable once the client has details", clicked === true, String(clicked));
  await sleep(1500);
  const bodyAfterInsert = await ev(bodyOf);
  check("the introduction lands in the body",
    !!bodyAfterInsert && bodyAfterInsert.includes("introduce you to Nicole Collins"),
    (bodyAfterInsert || "").slice(0, 60).replace(/\n/g, " "));
  const afterClick = JSON.parse(await ev(callsOf));
  check("clicking Introduce labels NOTHING — the draft can still be abandoned",
    afterClick.filter((c) => c.what === "labels").length === 0,
    JSON.stringify(afterClick));

  /* ------------------------------------------------ 2. the send must label */
  const sent = await ev(clickSend);
  check("the reply can be sent", sent === true, String(sent));
  await sleep(3000);
  const afterSend = JSON.parse(await ev(callsOf));
  const labelCalls = afterSend.filter((c) => c.what === "labels");
  check("sending the introduction tags the thread", labelCalls.length === 1, JSON.stringify(afterSend));
  check("it applies the Introduction label, not some other one",
    labelCalls[0]?.body?.label_id === LABEL_ID, labelCalls[0]?.body?.label_id ?? "none");
  check("the label goes out only after the reply itself",
    afterSend.findIndex((c) => c.what === "reply") < afterSend.findIndex((c) => c.what === "labels"),
    afterSend.map((c) => c.what).join(" → "));

  /* --------------------------- 3. a draft that is no longer an introduction */
  await send("Page.navigate", { url: `${BASE}${href}` });
  await sleep(3500);
  await ev(install);
  await ev(openComposer);
  await sleep(2500);
  await ev(clickIntro);
  await sleep(1200);
  await ev(`(() => { const e=document.querySelector('[contenteditable="true"]'); if(!e) return false;
    e.focus(); document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, "Thanks for getting back to me - I'll follow up next week with some times.");
    return true; })()`);
  await sleep(1200);
  const replaced = await ev(bodyOf);
  check("the operator can replace the draft entirely",
    !!replaced && !replaced.includes("introduce you to Nicole Collins"),
    (replaced || "").slice(0, 60));
  await ev(clickSend);
  await sleep(3000);
  const afterReplace = JSON.parse(await ev(callsOf));
  check("a reply that is no longer the introduction is NOT tagged",
    afterReplace.filter((c) => c.what === "labels").length === 0,
    afterReplace.map((c) => c.what).join(" → ") || "(nothing)");

  /* ------------------------------------------------ 4. nothing really moved */
  const rowsAfter = await sb(`label_assignments?select=label_id&target_type=eq.thread&target_id=eq.${threadId}`);
  check("the real conversation's labels are exactly as they were",
    JSON.stringify(rowsAfter) === labelBefore, `${labelBefore} → ${JSON.stringify(rowsAfter)}`);
} catch (e) {
  check("the run completed", false, e instanceof Error ? e.message : String(e));
}

ws.close();
console.log(`\n${"=".repeat(74)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
process.exit(failed ? 1 : 0);
