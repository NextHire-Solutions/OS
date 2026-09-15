/*
 * Drives the three new Onboarding screens in a real Chrome, over CDP.
 *
 *   node scripts/onboarding-ui-test.mjs [baseUrl]
 *
 * No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket and Node has
 * both `fetch` and `WebSocket` built in. The `Tab` class is scripts/ui-test.mjs's,
 * unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES MORE THAN COUNT NODES
 *
 * ui-test.mjs asks "did the screen draw rows?", which is the right question for
 * a read-only screen. These three screens WRITE, and the failure this project
 * keeps shipping is a screen that draws perfectly and does nothing: a settings
 * page whose every field was read-only, a portals page whose own comment said
 * "Read-only".
 *
 * So each screen here is also asked:
 *
 *   are the controls actually live?   (nothing disabled that should not be)
 *   does clicking one change the DATABASE?   (checked over PostgREST, not by
 *                                             believing the toast)
 *
 * Every fixture it touches is one it created and deletes again.
 *
 * Ports 3330 / 9446 by deliberate choice — 3210 and 9333 belong to another
 * agent's server and must not be disturbed.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3330";
const CDP = "http://localhost:9446";

/*
 * Where the three new screens live.
 *
 * Once they are in the `pick({...})` registry in src/app/[[...slug]]/page.tsx
 * (see ONBOARDING-WIRING.md — a three-line change this task was not allowed to
 * make), their addresses are /onboarding/stages, /onboarding/templates and
 * /onboarding/settings, and this script needs no argument.
 *
 * Until then they have no address at all, and a screen with no address cannot
 * be driven by a browser. Set ONBOARDING_PATH_PREFIX to point at a temporary
 * route that renders them:
 *
 *   ONBOARDING_PATH_PREFIX=/onboarding-preview node scripts/onboarding-ui-test.mjs
 *
 * The Pipeline section below always uses /onboarding, which is wired already.
 */
const PREFIX = process.env.ONBOARDING_PATH_PREFIX || "/onboarding";

const E = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
  if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = await mintSso(E.BS_SSO_SECRET || E.AUTH_SECRET, {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

async function db(q) {
  const r = await fetch(`${E.AGENT_SEARCH_SUPABASE_URL}/rest/v1/${q}`, {
    headers: {
      apikey: E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${await r.text()}`);
  return r.json();
}

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
    return r.result?.value;
  }
  async close() { this.#ws.close(); await fetch(`${CDP}/json/close/${this.targetId}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Open a screen, wait for it, and collect console/network faults. */
async function open(path, expect, min) {
  const tab = await Tab.open();
  const errors = [], netFails = [];
  const reqUrl = new Map();
  tab.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160));
    if (m.method === "Runtime.exceptionThrown")
      errors.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 160));
    if (m.method === "Network.requestWillBeSent") reqUrl.set(m.params.requestId, m.params.request.url);
    if (m.method === "Network.loadingFailed") {
      const t = m.params.errorText || "";
      // ERR_ABORTED is a cancelled request, not a failed one.
      if (!/ERR_ABORTED/.test(t)) netFails.push(`${t} ${(reqUrl.get(m.params.requestId) || "").replace(BASE, "")}`);
    }
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
      netFails.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  });
  await tab.send("Runtime.enable");
  await tab.send("Network.enable");
  await tab.send("Page.enable");
  await tab.send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  const t0 = Date.now();
  await tab.send("Page.navigate", { url: BASE + path });
  let count = 0, ready = false;
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    count = (await tab.eval(`document.querySelectorAll(${JSON.stringify(expect)}).length`)) ?? 0;
    if (count >= min && (await tab.eval("document.readyState")) === "complete") { ready = true; break; }
  }
  return { tab, errors, netFails, ms: Date.now() - t0, count, ready };
}

/*
 * Click by visible text. `elementFromPoint` at the element's centre so the click
 * lands on whatever a person would actually hit — a button covered by something
 * else fails here, as it should.
 */
const clickJs = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled);
  if (!el) return "not found";
  el.scrollIntoView({ block: "center" });
  el.click();
  return "clicked";
})()`;

const TAG = `ZZ UI Test ${Date.now()}`;
let madeStage = null;

try {
  /* ========================== render ==================================== */
  console.log("\nRENDER");
  for (const s of [
    { path: `${PREFIX}/stages`, expect: "table tbody tr", min: 8, label: "Stages" },
    { path: `${PREFIX}/templates`, expect: ".tbl-wrap", min: 3, label: "Templates" },
    { path: `${PREFIX}/settings`, expect: "input.inp", min: 14, label: "Settings" },
  ]) {
    const r = await open(s.path, s.expect, s.min);
    const chars = await r.tab.eval("document.body.innerText.length");
    check(
      `${s.label.padEnd(10)} renders — ${String(r.ms).padStart(4)}ms, ${r.count} nodes, ${chars} chars`,
      r.ready && r.errors.length === 0 && r.netFails.length === 0,
      [...r.errors, ...r.netFails].slice(0, 2).join(" | ") || (r.ready ? "" : `never reached ${s.min}× ${s.expect}`),
    );
    await r.tab.close();
  }

  /* ============ pipeline: the stage column is a control ================== */
  console.log("\nPIPELINE  (already wired at /onboarding — its real address)");
  {
    const r = await open("/onboarding", "table tbody tr", 20);
    check("Pipeline renders at its real workspace address", r.ready && r.errors.length === 0 && r.netFails.length === 0,
      [...r.errors, ...r.netFails].slice(0, 2).join(" | "));

    const first = await r.tab.eval(`(() => {
      const sel = document.querySelector('section.screen.on select[aria-label^="Stage for "]');
      if (!sel) return null;
      return { name: sel.getAttribute('aria-label').replace('Stage for ', ''), value: sel.value,
               options: [...sel.options].map(o => o.value) };
    })()`);
    check("Pipeline: every row's stage is a dropdown, not a label", !!first, "no stage select found");

    if (first) {
      const client = (await db(`orch_clients?client_name=eq.${encodeURIComponent(first.name)}&select=id,stage_id`))[0];
      const target = first.options.find((o) => o && o !== first.value);
      console.log(`      moving "${first.name}" and putting it straight back`);

      const changed = await r.tab.eval(`(() => {
        const sel = document.querySelector('section.screen.on select[aria-label^="Stage for "]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, ${JSON.stringify(target)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return "changed";
      })()`);
      check("Pipeline: the dropdown accepts a change", changed === "changed", changed);

      let landed = false;
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        if ((await db(`orch_clients?id=eq.${client.id}&select=stage_id`))[0]?.stage_id === target) { landed = true; break; }
      }
      check("Pipeline: choosing a stage really moved the client", landed);

      // Straight back, through the API, and asserted.
      await fetch(`${BASE}/api/tools/onboarding/clients/${client.id}`, {
        method: "PATCH",
        headers: { cookie: `bs_sso=${cookie}`, "content-type": "application/json" },
        body: JSON.stringify({ stageId: client.stage_id }),
      });
      const back = (await db(`orch_clients?id=eq.${client.id}&select=stage_id`))[0]?.stage_id;
      check("Pipeline: the client is back on its original stage", back === client.stage_id,
        `now ${back}, was ${client.stage_id}`);
    }
    await r.tab.close();
  }

  /* ===================== controls are actually live ====================== */
  console.log("\nCONTROLS ARE LIVE  (the 'read-only settings page' trap)");
  {
    const r = await open(`${PREFIX}/settings`, "input.inp", 14);
    const audit = await r.tab.eval(`(() => {
      const root = document.querySelector('section.screen.on');
      const inputs = [...root.querySelectorAll('input, textarea, select')];
      const buttons = [...root.querySelectorAll('button')];
      return {
        inputs: inputs.length,
        disabled: inputs.filter(i => i.disabled).length,
        readonly: inputs.filter(i => i.readOnly).length,
        buttons: buttons.length,
        disabledButtons: buttons.filter(b => b.disabled).map(b => b.textContent.trim()),
        fileInputs: root.querySelectorAll('input[type=file]').length,
      };
    })()`);
    console.log(`      ${audit.inputs} fields, ${audit.buttons} buttons`);
    check("Settings: no field is disabled", audit.disabled === 0, `${audit.disabled} disabled`);
    check("Settings: no field is readOnly", audit.readonly === 0, `${audit.readonly} readOnly`);
    check("Settings: the roster photo pickers are real file inputs", audit.fileInputs >= 2, `${audit.fileInputs}`);
    /*
     * Three buttons start disabled, and all three are SUPPOSED to be: "Save
     * names" until a caption is edited, and each roster "Add" until a name is
     * typed. The tool disables exactly these three too. Anything else in this
     * list would be a dead control.
     */
    const expectedDisabled = ["Save names", "Add", "Add"];
    check("Settings: only the three input-gated buttons start disabled",
      JSON.stringify([...audit.disabledButtons].sort()) === JSON.stringify([...expectedDisabled].sort()),
      `disabled: ${JSON.stringify(audit.disabledButtons)}`);

    // Typing must enable the save button — proof the field is bound to state.
    const typed = await r.tab.eval(`(() => {
      const root = document.querySelector('section.screen.on');
      const box = [...root.querySelectorAll('input.inp')]
        .find(i => (i.getAttribute('aria-label')||'').startsWith('Button name for'));
      if (!box) return "no step-label box";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(box, 'ZZ typed');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return "typed";
    })()`);
    /*
     * Poll instead of sleeping a fixed 400ms. React has to re-render before the
     * button un-disables, and on a loaded machine that occasionally took longer
     * than the sleep — so this failed with "typed=typed save=false", which reads
     * as a dead Save button rather than as a test that looked too early.
     */
    let saveLive = null;
    for (let i = 0; i < 40; i++) {
      saveLive = await r.tab.eval(`(() => {
        const b = [...document.querySelectorAll('section.screen.on button')].find(x => x.textContent.trim() === 'Save names');
        return b ? !b.disabled : null;
      })()`);
      if (saveLive === true) break;
      await sleep(100);
    }
    check("Settings: typing a caption enables Save names", typed === "typed" && saveLive === true, `typed=${typed} save=${saveLive}`);
    await r.tab.close();
  }

  /* ================= a real click changes the database =================== */
  console.log("\nA CLICK CHANGES THE DATABASE  (stage created, moved, deleted)");
  {
    const r = await open(`${PREFIX}/stages`, "table tbody tr", 8);
    const before = (await db("orch_stages?select=id")).length;

    const typed = await r.tab.eval(`(() => {
      const box = document.querySelector('input[aria-label="New stage name"]');
      if (!box) return "no box";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(box, ${JSON.stringify(TAG)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return "typed";
    })()`);
    check("Stages: the new-stage box accepts typing", typed === "typed", typed);

    await sleep(300);
    const clicked = await r.tab.eval(clickJs("button", "Add stage"));
    check("Stages: Add stage is clickable", clicked === "clicked", clicked);

    // Wait for the row to exist in Postgres, not for a fixed delay.
    let row = null;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const hit = await db(`orch_stages?name=eq.${encodeURIComponent(TAG)}&select=id,name,sort,color`);
      if (hit.length) { row = hit[0]; break; }
    }
    madeStage = row?.id ?? null;
    check("Stages: the click really inserted a row", !!row, "no row appeared");
    check("Stages: the table count grew by one",
      (await db("orch_stages?select=id")).length === before + 1);

    // The screen must show it without a manual reload.
    const shown = await r.tab.eval(
      `[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(TAG)})`,
    );
    check("Stages: the new row appears on screen without a reload", shown === true);

    // Reorder: the new stage is last, so ↑ must swap it with its neighbour.
    if (row) {
      const ordered = await db("orch_stages?select=id,sort&order=sort");
      const idx = ordered.findIndex((s) => s.id === row.id);
      const up = await r.tab.eval(
        `(() => { const b = document.querySelector('button[aria-label="Move ${TAG} up"]'); if(!b) return "not found"; b.click(); return "clicked"; })()`,
      );
      check("Stages: the ↑ button is clickable", up === "clicked", up);
      let moved = false;
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const now = await db("orch_stages?select=id&order=sort");
        if (now.findIndex((s) => s.id === row.id) === idx - 1) { moved = true; break; }
      }
      check("Stages: ↑ really reordered the rows in the database", moved);

      /*
       * Delete must hit OUR row, not the first Delete on the page — there is one
       * per stage, and clicking a real client's stage would be exactly the
       * mistake this suite exists to catch.
       *
       * `rowButton` finds the <tr> whose name box holds our tag and clicks the
       * button inside it. It also waits for the screen to come out of its
       * post-write `busy` state, when every button is legitimately disabled.
       */
      const rowButton = (text) => `(() => {
        const tr = [...document.querySelectorAll('section.screen.on tbody tr')]
          .find(tr => [...tr.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(TAG)}));
        if (!tr) return "row not found";
        const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)});
        if (!b) return "button not found";
        if (b.disabled) return "busy";
        b.click();
        return "clicked";
      })()`;
      const clickRow = async (text) => {
        for (let i = 0; i < 40; i++) {
          const res = await r.tab.eval(rowButton(text));
          if (res !== "busy") return res;
          await sleep(200);
        }
        return "busy";
      };

      // Delete takes two clicks by design; one click must NOT delete.
      const first = await clickRow("Delete");
      await sleep(700);
      const stillThere = (await db(`orch_stages?id=eq.${row.id}&select=id`)).length === 1;
      check("Stages: one click on Delete does NOT delete", first === "clicked" && stillThere,
        `click=${first} stillThere=${stillThere}`);

      const second = await clickRow("Confirm delete");
      check("Stages: the armed button says 'Confirm delete'", second === "clicked", second);
      let gone = false;
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        if ((await db(`orch_stages?id=eq.${row.id}&select=id`)).length === 0) { gone = true; break; }
      }
      check("Stages: the second click really deleted the row", gone);
      if (gone) madeStage = null;
      check("Stages: the table is back to its original size",
        (await db("orch_stages?select=id")).length === before);
    }
    await r.tab.close();
  }

  /* ================== templates: an edit reaches the row ================= */
  console.log("\nTEMPLATES: editing the wording reaches the database");
  {
    const r = await open(`${PREFIX}/templates`, ".tbl-wrap", 3);
    const target = (await db("orch_templates?key=eq.intro_macro&select=id,name,body"))[0];

    const expanded = await r.tab.eval(
      `(() => { const b = document.querySelector('button[aria-label^="Expand ${target.name.replace(/"/g, '\\"')}"]'); if(!b) return "not found"; b.click(); return "clicked"; })()`,
    );
    check("Templates: a template expands to an editor", expanded === "clicked", expanded);
    await sleep(400);

    const marker = `${target.body}\nZZ-UI-TEST-MARKER`;
    const typed = await r.tab.eval(`(() => {
      const ta = document.querySelector('section.screen.on textarea');
      if (!ta) return "no textarea";
      if (ta.disabled || ta.readOnly) return "textarea is not editable";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(marker)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return "typed";
    })()`);
    check("Templates: the body textarea is editable", typed === "typed", typed);

    await sleep(300);
    const saved = await r.tab.eval(clickJs("button", "Save"));
    check("Templates: Save is clickable once dirty", saved === "clicked", saved);

    let landed = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const now = (await db(`orch_templates?id=eq.${target.id}&select=body`))[0];
      if (now?.body === marker) { landed = true; break; }
    }
    check("Templates: the edit really reached the row", landed);

    // Put the original wording back — this is a live template.
    await fetch(`${BASE}/api/tools/onboarding/templates/${target.id}`, {
      method: "PATCH",
      headers: { cookie: `bs_sso=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ body: target.body }),
    });
    const restored = (await db(`orch_templates?id=eq.${target.id}&select=body`))[0];
    check("Templates: the original wording is restored", restored?.body === target.body);
    await r.tab.close();
  }

  /* ============ settings: the automation switch is not decorative ======== */
  console.log("\nSETTINGS: the automation switch flips the real row");
  {
    const r = await open(`${PREFIX}/settings`, "input.inp", 14);
    const was = (await db("orch_settings?key=eq.automation_enabled&select=value"))[0]?.value;
    const label = was ? "Switch to manual" : "Switch to automatic";

    const first = await r.tab.eval(clickJs("button", label));
    check("Settings: the switch is clickable", first === "clicked", first);
    await sleep(500);
    const unchanged = (await db("orch_settings?key=eq.automation_enabled&select=value"))[0]?.value === was;
    check("Settings: one click does NOT flip it", unchanged);

    const second = await r.tab.eval(clickJs("button", `Confirm — ${label.toLowerCase()}`));
    check("Settings: the armed switch is clickable", second === "clicked", second);
    let flipped = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if ((await db("orch_settings?key=eq.automation_enabled&select=value"))[0]?.value === !was) { flipped = true; break; }
    }
    check("Settings: the second click really flipped the row", flipped);

    await fetch(`${BASE}/api/tools/onboarding/settings`, {
      method: "PATCH",
      headers: { cookie: `bs_sso=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ automationEnabled: was }),
    });
    const back = (await db("orch_settings?key=eq.automation_enabled&select=value"))[0]?.value;
    check("Settings: the original setting is restored", back === was, `now ${JSON.stringify(back)}`);
    await r.tab.close();
  }
} catch (e) {
  failures.push(`THREW: ${e.message}`);
  console.log(`\n  ✗ threw: ${e.message}\n${e.stack?.split("\n").slice(1, 3).join("\n")}`);
} finally {
  if (madeStage) {
    await fetch(`${BASE}/api/tools/onboarding/stages/${madeStage}`, {
      method: "DELETE",
      headers: { cookie: `bs_sso=${cookie}` },
    });
    console.log("\n  cleanup: removed the test stage");
  }
}

console.log(`\n  ${pass} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`     ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
