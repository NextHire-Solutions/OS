/*
 * The Introduce feature, end to end on the deployed site.
 *
 *   A. Storage and template sync, on a THROWAWAY client the test creates and
 *      deletes. No real client's details are touched.
 *   B. The thread endpoint, read-only, against real conversations.
 *   C. The button in a real browser: present, correctly disabled, and — with
 *      the endpoint stubbed so no client data is needed — inserting the body
 *      and merging the Cc without dropping what was already there.
 *
 * Writes: one temporary os_clients row, one reply_templates row, and possibly
 * one composer draft — every one of them removed before the script exits.
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const CDP = `http://localhost:${process.env.PORT || 9601}`;
const STAMP = Date.now();
const TEST_CLIENT = `ZZ Intro Macro Test ${STAMP}`;
const CONTACT = { name: "Nicole Collins", role: "Team Leader", brokerage: "Oz Group", email: `intro-test-${STAMP}@brokerstaffer.test` };

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const H = { cookie: `bs_sso=${TOKEN}`, "content-type": "application/json" };

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* some routes answer empty */ }
  return { status: r.status, body: j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\nINTRODUCE — the intro macro end to end\n${"=".repeat(74)}\n`);

/* ============================================================ A. storage */
console.log("A. Details are stored, and the template follows them\n");

let osClientId = null;
let templateId = null;
try {
  const made = await api("POST", "/api/workspace/clients/adopt", { name: TEST_CLIENT, aliases: [] });
  osClientId = made.body?.id ?? made.body?.client?.id ?? null;
  check("a throwaway client can be created", made.status === 200 && !!osClientId, `HTTP ${made.status}`);

  if (osClientId) {
    const bad = await api("POST", "/api/workspace/clients/edit", { id: osClientId, contactEmail: "not-an-address" });
    check("a contact email that is not an address is refused", bad.status === 400, `HTTP ${bad.status} ${bad.body?.error ?? ""}`);

    const saved = await api("POST", "/api/workspace/clients/edit", {
      id: osClientId,
      contactName: CONTACT.name, contactRole: CONTACT.role,
      brokerage: CONTACT.brokerage, contactEmail: CONTACT.email,
    });
    const updated = (saved.body?.updated ?? []).join(" · ");
    check("the introduction details save", saved.status === 200 && updated.includes("the OS record"),
      `HTTP ${saved.status} updated=[${updated}] failed=${JSON.stringify(saved.body?.failed ?? [])}`);
    check("the stored template is written in the same step",
      /introduction template/.test(updated), `updated=[${updated}]`);

    const list = await api("GET", "/api/tools/master-inbox/reply-templates");
    const rows = Array.isArray(list.body) ? list.body : (list.body?.templates ?? []);
    const tpl = rows.find((t) => t.name === `Intro Macro - ${TEST_CLIENT}`);
    templateId = tpl?.id ?? null;
    check("the template exists, named after the client", !!tpl, tpl ? tpl.name : `${rows.length} templates, none matching`);

    if (tpl) {
      const body = String(tpl.body ?? "");
      check("it names the contact, the role and the brokerage",
        body.includes(`${CONTACT.name}, ${CONTACT.role} at ${CONTACT.brokerage}`),
        body.split("\n")[2]?.slice(0, 80));
      check("the lead's values are still placeholders for insert time",
        ["{{lead.name}}", "{{lead.first_name}}", "{{lead.phone_number}}", "{{lead.company}}", "{{sender.name}}"].every((t) => body.includes(t)));
      check("it signs off with the brokerage", body.trimEnd().endsWith(`Talent Acquisition | ${CONTACT.brokerage}`));
      check("the contact email is the template's Cc", (tpl.cc ?? "") === CONTACT.email, `cc=${tpl.cc ?? "(none)"}`);
    }

    // The whole point of storing them: a correction reaches the template too.
    const changed = await api("POST", "/api/workspace/clients/edit", { id: osClientId, contactRole: "Managing Broker" });
    check("editing a role re-renders the stored template", changed.status === 200, `HTTP ${changed.status}`);
    const list2 = await api("GET", "/api/tools/master-inbox/reply-templates");
    const rows2 = Array.isArray(list2.body) ? list2.body : (list2.body?.templates ?? []);
    const tpl2 = rows2.find((t) => t.name === `Intro Macro - ${TEST_CLIENT}`);
    check("the template now says the new role",
      String(tpl2?.body ?? "").includes(`${CONTACT.name}, Managing Broker at ${CONTACT.brokerage}`),
      String(tpl2?.body ?? "").split("\n")[2]?.slice(0, 80));
  }
} catch (e) {
  check("part A ran without throwing", false, e instanceof Error ? e.message : String(e));
}

/* ====================================================== B. the endpoint */
console.log("\nB. The conversation endpoint\n");

let sampleThreadId = null;
try {
  // The inbox is server-rendered, so its HTML already holds the row links —
  // more reliable than guessing a search endpoint's response shape.
  const page = await fetch(`${BASE}/inbox/all-email`, { headers: { cookie: `bs_sso=${TOKEN}` } });
  const html = await page.text();
  sampleThreadId = (html.match(/\/inbox\/all-email\/([0-9a-f-]{36})/) ?? [])[1] ?? null;
} catch { /* reported by the check below */ }

if (sampleThreadId) {
  const r = await api("GET", `/api/tools/master-inbox/threads/${sampleThreadId}/intro-macro`);
  const b = r.body ?? {};
  check("it answers 200 with an available flag", r.status === 200 && typeof b.available === "boolean", `HTTP ${r.status}`);
  if (b.available) {
    check("an available answer carries a body and names the client",
      typeof b.body === "string" && b.body.includes("{{lead.name}}") && !!b.clientName, b.clientName);
  } else {
    check("an unavailable answer says why, in words a person can act on",
      typeof b.reason === "string" && b.reason.length > 10, b.reason);
  }
  const bogus = await api("GET", "/api/tools/master-inbox/threads/00000000-0000-0000-0000-000000000000/intro-macro");
  check("an unknown conversation is a 404, not a crash", bogus.status === 404, `HTTP ${bogus.status}`);
} else {
  check("a conversation could be sampled for the endpoint check", false, "no thread id found");
}

/* ======================================================== C. the button */
console.log("\nC. The button in the composer\n");

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

let threadId = null;
try {
  await send("Page.navigate", { url: `${BASE}/inbox/all-email` });
  for (let i = 0; i < 60; i++) { if ((await ev(`document.querySelectorAll('a.mi-row').length`)) > 3) break; await sleep(250); }
  const href = await ev(`(document.querySelector('a.mi-row')||{}).getAttribute?.('href')`);
  threadId = href ? href.split("/").pop() : null;
  check("a conversation opens", !!threadId, href ?? "no row");

  if (threadId) {
    await send("Page.navigate", { url: `${BASE}${href}` });
    for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('button[aria-label="Insert the introduction"], [data-composer], button')`)) break; await sleep(250); }
    await sleep(2500);
    // Open the composer — the floating Reply button.
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*reply\\s*$/i.test((x.innerText||'').trim())); if(b) b.click(); return !!b; })()`);
    await sleep(2500);

    const btn = JSON.parse(await ev(`(() => {
      const b = document.querySelector('button[aria-label="Insert the introduction"]');
      if (!b) return '{"found":false}';
      return JSON.stringify({ found: true, label: (b.innerText||'').trim(), disabled: b.disabled, title: b.getAttribute('title') || '' });
    })()`));
    check("the Introduce button is in the composer", btn.found, btn.found ? `"${btn.label}"` : "not found");
    check("it sits beside AI reply and reads Introduce", btn.label === "Introduce", btn.label);
    check("when it cannot be used it says why", btn.disabled ? btn.title.length > 10 : true, `disabled=${btn.disabled} title="${btn.title}"`);

    // Consistency: the button's state must match what the endpoint says.
    const apiSaid = (await api("GET", `/api/tools/master-inbox/threads/${threadId}/intro-macro`)).body ?? {};
    check("the button's state matches the endpoint's answer",
      btn.found && btn.disabled === !apiSaid.available,
      `button.disabled=${btn.disabled} api.available=${apiSaid.available}`);

    /*
     * The insert itself, with the endpoint stubbed.
     *
     * No real client has introduction details until someone fills them in, so
     * stubbing is what makes this assertable today — and it exercises the
     * whole client-side path: substitution, insertion at the caret, and the
     * Cc merge.
     */
    /*
     * Read Cc by its row LABEL.
     *
     * The field has no aria-label and its placeholder says "email addresses",
     * so matching on /cc/ found nothing and read "" — which looks exactly like
     * an empty Cc. Returning null when the field is absent is what makes a
     * broken selector fail the test instead of passing it vacuously.
     */
    const READ_CC = `(() => {
      for (const span of document.querySelectorAll('span')) {
        if ((span.textContent || '').trim() === 'Cc:') {
          const input = span.parentElement?.querySelector('input');
          if (input) return JSON.stringify({ found: true, value: input.value });
        }
      }
      return JSON.stringify({ found: false, value: null });
    })()`;
    const ccBeforeRead = JSON.parse(await ev(READ_CC));
    const ccBefore = ccBeforeRead.value ?? "";
    check("the Cc field can be read, and starts with the standing workspace copy",
      ccBeforeRead.found && /@/.test(ccBefore), `found=${ccBeforeRead.found} cc="${ccBefore}"`);
    await ev(`(() => {
      const real = window.fetch;
      window.fetch = (u, o) => (String(u).includes('/intro-macro')
        ? Promise.resolve(new Response(JSON.stringify({
            available: true, clientName: 'Oz Group',
            body: "Hey {{lead.name}},\\n\\nI'd like to introduce you to Nicole Collins, Team Leader at Oz Group\\n\\nBest,\\n{{sender.name}}",
            cc: 'stub-intro@brokerstaffer.test',
          }), { status: 200, headers: { 'content-type': 'application/json' } }))
        : real(u, o));
      return true;
    })()`);
    // Re-open the composer so the stubbed fetch runs on mount.
    await ev(`(() => { const x=[...document.querySelectorAll('button')].find(b=>/close|cancel/i.test(b.getAttribute('aria-label')||'')); if(x) x.click(); return true; })()`);
    await sleep(800);
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*reply\\s*$/i.test((x.innerText||'').trim())); if(b) b.click(); return !!b; })()`);
    await sleep(2200);

    const clicked = await ev(`(() => { const b=document.querySelector('button[aria-label="Insert the introduction"]'); if(!b) return 'MISSING'; if(b.disabled) return 'DISABLED'; b.click(); return 'ok'; })()`);
    await sleep(1500);
    const ccAfterRead = JSON.parse(await ev(READ_CC));
    const after = {
      body: (await ev(`((document.querySelector('.ProseMirror, [contenteditable="true"]')||{}).innerText || '').slice(0, 400)`)) ?? "",
      cc: ccAfterRead.value ?? "",
      ccFound: ccAfterRead.found,
    };

    check("pressing it inserts the introduction", clicked === "ok" && /introduce you to Nicole Collins, Team Leader at Oz Group/.test(after.body),
      clicked === "ok" ? after.body.replace(/\s+/g, " ").slice(0, 90) : clicked);
    check("the lead's placeholders are resolved, none left behind",
      clicked === "ok" && !/\{\{/.test(after.body), (after.body.match(/\{\{[^}]+\}\}/g) || []).join(" ") || "none left");
    check("the client's address is added to Cc",
      after.ccFound && after.cc.toLowerCase().includes("stub-intro@brokerstaffer.test"), `cc="${after.cc}"`);
    const wasThere = ccBefore.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    check("every Cc address that was already there is kept",
      after.ccFound && wasThere.length > 0 && wasThere.every((addr) => after.cc.toLowerCase().includes(addr.toLowerCase())),
      `before="${ccBefore}" after="${after.cc}"`);
  }
} catch (e) {
  check("part C ran without throwing", false, e instanceof Error ? e.message : String(e));
}

/* ========================================================== cleanup */
console.log("\nCleaning up\n");
try {
  if (threadId) {
    const d = await api("DELETE", `/api/tools/master-inbox/threads/${threadId}/composer-draft`);
    check("the draft the test created is removed", d.status === 200 || d.status === 204 || d.status === 404, `HTTP ${d.status}`);
  }
  if (templateId) {
    const d = await api("DELETE", `/api/tools/master-inbox/reply-templates/${templateId}`);
    check("the test template is removed", d.status === 200 || d.status === 204, `HTTP ${d.status}`);
  }
  if (osClientId) {
    // POST with the name as the confirmation, exactly as the dialog does.
    const d = await api("POST", "/api/workspace/clients/delete", { id: osClientId, scope: "os", confirm: TEST_CLIENT });
    check("the throwaway client is removed", d.status === 200 && (d.body?.failed ?? []).length === 0,
      `HTTP ${d.status} removed=${JSON.stringify(d.body?.removed ?? [])} failed=${JSON.stringify(d.body?.failed ?? [])}`);
  }
} catch (e) {
  check("cleanup ran", false, e instanceof Error ? e.message : String(e));
}

ws.close();
console.log(`\n${"=".repeat(74)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
process.exit(failed ? 1 : 0);
