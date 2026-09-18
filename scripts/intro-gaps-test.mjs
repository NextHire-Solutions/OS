/*
 * The Introduce button says when the lead is missing something.
 *
 * The complaint that caused this: a lead with no brokerage on file produced
 *   "... and is currently with ."
 * and nothing anywhere said so, so it was one click from going to a client.
 *
 * Two real conversations are used, read-only, chosen because one lead HAS a
 * brokerage and the other does not. Nothing is sent: the macro endpoint is
 * stubbed in the page and Send is never pressed.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const CDP = `http://localhost:${process.env.PORT || 9671}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const WITHOUT = process.env.THREAD_NO_CO || "d1669be7-839f-4b5b-8a9a-0e84378dee27";
const WITH = process.env.THREAD_CO || "f33e0656-cb81-4682-adca-d9dbf1ca89d0";

let passed = 0, failed = 0; const fails = [];
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  —  " + d : ""}`); ok ? passed++ : (failed++, fails.push(n)); };

console.log(`\nINTRODUCE — MISSING DETAILS ARE ANNOUNCED\n${"=".repeat(74)}\n`);

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

/* The macro, stubbed, so no client's real details are needed. It asks for the
   lead's brokerage and phone number, which is what the real macro does. */
const stub = `(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/\\/intro-macro$/.test(url)) {
      return new Response(JSON.stringify({
        available: true, clientName: "Oz Group",
        body: "Hey {{lead.name}},\\n\\nI'd like to introduce you to Nicole Collins, Team Leader at Oz Group\\n\\nNicole, I recently connected with {{lead.first_name}}, who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\\n\\nBest,\\n{{sender.name}}",
        cc: null, introductionLabelId: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\\/reply$/.test(url)) throw new Error("the test must never send");
    return real(input, init);
  };
  return true;
})()`;

const openAndIntroduce = async (threadId) => {
  await send("Page.navigate", { url: `${BASE}/inbox/all-email/${threadId}` });
  await sleep(4000);
  await ev(stub);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*reply\\s*$/i.test((x.innerText||'').trim())); if(b) b.click(); return !!b; })()`);
  await sleep(2500);
  const clicked = await ev(`(() => { const b=document.querySelector('button[aria-label="Insert the introduction"]'); if(!b||b.disabled) return false; b.click(); return true; })()`);
  await sleep(1500);
  return {
    clicked,
    banner: await ev(`(() => { const n=[...document.querySelectorAll('[role="status"]')].find(x=>/introduction has gaps/.test(x.innerText||'')); return n ? (n.innerText||'').replace(/\\s+/g,' ').trim() : null; })()`),
    body: await ev(`(() => { const e=document.querySelector('[contenteditable="true"]'); return e ? (e.innerText||'').replace(/\\s+/g,' ').trim() : null; })()`),
  };
};

try {
  /* ------------------------------------- the lead with nothing on file */
  const a = await openAndIntroduce(WITHOUT);
  check("the introduction goes in", a.clicked === true && !!a.body, String(a.clicked));
  check("a warning appears when the lead is missing details", !!a.banner, a.banner ?? "no banner");
  check("it names the brokerage, in words a person would use",
    /brokerage/i.test(a.banner ?? ""), a.banner ?? "");
  check("it tells the operator to read it before sending",
    /before sending/i.test(a.banner ?? ""), a.banner ?? "");
  check("the broken sentence really is there, which is what the warning is about",
    /currently with \.?$|currently with \./.test(a.body ?? "") || /with \./.test(a.body ?? ""),
    (a.body ?? "").slice(-70));
  const dismissed = await ev(`(() => { const b=document.querySelector('[aria-label="Dismiss the missing-details warning"]'); if(!b) return false; b.click(); return true; })()`);
  await sleep(600);
  const after = await ev(`(() => { const n=[...document.querySelectorAll('[role="status"]')].find(x=>/introduction has gaps/.test(x.innerText||'')); return n ? 1 : 0; })()`);
  check("it can be dismissed once the operator has decided", dismissed === true && after === 0, `dismissed=${dismissed} still=${after}`);

  /* --------------------------------------- the lead who has everything */
  const b = await openAndIntroduce(WITH);
  check("the introduction goes in for the complete lead", b.clicked === true && !!b.body, String(b.clicked));
  check("NO warning when the lead has what the macro asks for", !b.banner, b.banner ?? "(none)");
  check("that lead's brokerage is actually written into the sentence",
    /currently with RE\/MAX of Gulf Shores/i.test(b.body ?? ""), (b.body ?? "").slice(-90));
} catch (e) {
  check("the run completed", false, e instanceof Error ? e.message : String(e));
}

ws.close();
console.log(`\n${"=".repeat(74)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
process.exit(failed ? 1 : 0);
