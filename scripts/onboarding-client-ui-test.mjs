/*
 * Drives the Onboarding client detail screen in a real Chrome, over CDP.
 *
 *   node scripts/onboarding-client-ui-test.mjs [baseUrl]
 *
 * No Playwright, no Puppeteer — Chrome speaks CDP over a WebSocket and Node has
 * both `fetch` and `WebSocket` built in. The `Tab` class is scripts/ui-test.mjs's,
 * unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ASKS THAT THE WRITE TEST CANNOT
 *
 * `onboarding-client-write-test.mjs` proves the ROUTES behave. This proves the
 * SCREEN does: that the controls exist, that they are not disabled, that
 * clicking one really changes the database, and — the reason this task exists —
 * that pressing a step button produces a refusal on screen and changes nothing.
 *
 * A screen that draws perfectly and does nothing is the failure this project
 * keeps shipping, and it is invisible to a route test.
 *
 * ---------------------------------------------------------------------------
 * SAFETY AND PORTS
 *
 * Every fixture is created by this script and deleted again; no real client is
 * opened, let alone edited.
 *
 * Ports 3340 / 9447 by deliberate choice — 3111, 3210, 3310, 9222, 9333 and 9444
 * belong to other agents' servers and must not be disturbed.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3340";
const CDP = "http://localhost:9447";
/*
 * The client screen has no address until three lines go into
 * src/app/[[...slug]]/page.tsx (see ONBOARDING-CLIENT-WIRING.md), and this task
 * may not edit that file. Point this at the real route once it is wired:
 *
 *   ONBOARDING_CLIENT_PREFIX=/some/other/prefix node scripts/onboarding-client-ui-test.mjs
 */
const PREFIX = process.env.ONBOARDING_CLIENT_PREFIX || "/onboarding/clients";

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

async function db(query, init) {
  const res = await fetch(`${E.AGENT_SEARCH_SUPABASE_URL}/rest/v1/${query}`, {
    ...init,
    headers: {
      apikey: E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`db ${res.status} ${query}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

const TAG = `ZZ Client UI Test ${Date.now()}`;
let CLIENT = null;

async function cleanup() {
  if (!CLIENT) return;
  for (const t of ["orch_client_fields", "orch_client_leads", "orch_client_team", "orch_connector_deliveries"]) {
    await db(`${t}?client_id=eq.${CLIENT}`, { method: "DELETE" }).catch(() => {});
  }
  await db(`orch_clients?id=eq.${CLIENT}`, { method: "DELETE" }).catch(() => {});
}

try {
  /* ============================ the fixture ============================== */
  console.log(`\nFIXTURE  ("${TAG}" — created here, deleted at the end)`);
  const stages = await db("orch_stages?select=id,name&order=sort");
  const agents = await db("agents?select=id&limit=4");
  const made = await db("orch_clients", {
    method: "POST",
    body: JSON.stringify({
      client_name: TAG, brand: "ZZ UI Brokerage", office_name: "ZZ UI Office",
      status: "new", copy_status: "pending", primary_contact: {},
      location: "Testville, ZZ", timezone: "EST",
      filters: { sales_volume_min: 2000000, closed_transactions_min: 8 },
      stage_id: stages[0].id,
    }),
  });
  CLIENT = made[0].id;
  await db("orch_client_team", {
    method: "POST",
    body: JSON.stringify([
      { client_id: CLIENT, name: "ZZ UI Filler", email: "zz-ui@example.invalid", phone: null, role: "Owner", source: "typeform", is_dnc: false },
      { client_id: CLIENT, name: "ZZ UI Agent", email: null, phone: null, role: "Agent", source: "db", is_dnc: true },
      { client_id: CLIENT, name: "ZZ UI Excluded", email: null, phone: null, role: null, source: "typeform", is_dnc: true },
    ]),
  });
  if (agents.length) {
    await db("orch_client_leads", {
      method: "POST",
      body: JSON.stringify(agents.map((a) => ({ client_id: CLIENT, agent_id: a.id }))),
    });
  }
  await db("orch_connector_deliveries", {
    method: "POST",
    body: JSON.stringify({ client_id: CLIENT, target: "email", action: "welcome", status: "ok", request: { note: TAG }, response: null, error: null }),
  });
  console.log(`      client ${CLIENT}`);

  /* ============================== profile ================================ */
  console.log("\nPROFILE");
  const r = await open(`${PREFIX}/${CLIENT}`, "button[data-step]", 14);
  const chars = await r.tab.eval("document.body.innerText.length");
  check(`Profile renders — ${r.ms}ms, ${r.count} step buttons, ${chars} chars`,
    r.ready && r.errors.length === 0 && r.netFails.length === 0,
    [...r.errors, ...r.netFails].slice(0, 3).join(" | ") || (r.ready ? "" : "never drew 14 step buttons"));

  check("the client's name is on the page", (await r.tab.eval(`document.body.innerText.includes(${JSON.stringify(TAG)})`)) === true);

  const steps = await r.tab.eval(`(() => {
    const b = [...document.querySelectorAll('button[data-step]')];
    return { total: b.length, disabled: b.filter(x => x.disabled).length,
             disabledKeys: b.filter(x => x.disabled).map(x => x.dataset.step),
             keys: b.map(x => x.dataset.step), ticked: b.filter(x => x.textContent.includes('✓')).map(x => x.dataset.step) };
  })()`);
  check("all 14 catalogue steps are rendered as buttons",
    ["email:welcome","email:confirmations","push:client_portal","email:how_intros_work","email:meet_team",
     "email:portal","email:dnc_reminder","build:team","push:health_dash","campaign:build","build:leads",
     "campaign:launch","email:campaign_launched","email:followup_call"].every((k) => steps.keys.includes(k)),
    JSON.stringify(steps.keys));
  check("…plus pause, payment link and the run-remaining chain",
    ["campaign:pause","payment:link","setup:remaining"].every((k) => steps.keys.includes(k)), JSON.stringify(steps.keys));
  /*
   * Every step button must be LIVE. A greyed-out button says "broken"; these are
   * not broken, they are refusing on purpose, and the reader has to be able to
   * press one and be told so.
   *
   * `payment:link` is the single exception and is checked separately below: it
   * is disabled until an amount is typed, exactly as the tool's own is.
   */
  check("no step button is disabled — they are visible and pressable",
    steps.disabled === 0 || (steps.disabled === 1 && steps.disabledKeys?.[0] === "payment:link"),
    `${steps.disabled} disabled: ${JSON.stringify(steps.disabledKeys)}`);
  check("…and the payment link is the one that waits for an amount",
    steps.disabledKeys?.length === 0 || steps.disabledKeys?.[0] === "payment:link", JSON.stringify(steps.disabledKeys));
  check("the welcome step shows its ✓ from the delivery row", steps.ticked.includes("email:welcome"), JSON.stringify(steps.ticked));
  check("progress reads 1 of 14", (await r.tab.eval(`document.body.innerText.includes('1 of 14 steps done')`)) === true);

  /* ============ THE POINT: a step button refuses, visibly =============== */
  console.log("\nSTEP BUTTONS  (pressed for real, in a real browser)");
  {
    // campaign:launch is the dangerous one. Press it.
    const clicked = await r.tab.eval(`(() => {
      const b = document.querySelector('button[data-step="campaign:launch"]');
      if (!b) return "not found";
      b.scrollIntoView({ block: "center" }); b.click(); return "clicked";
    })()`);
    check("“Launch campaign” is clickable", clicked === "clicked", clicked);

    let shown = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      shown = await r.tab.eval(`(() => {
        const a = [...document.querySelectorAll('.anno')].map(x => x.innerText).join(" | ");
        return a.includes("did not run") || a.includes("Not enabled") ? a : null;
      })()`);
      if (shown) break;
    }
    check("…and pressing it shows a refusal on screen", !!shown, "no refusal panel appeared");
    check("…that says why", /no campaign/i.test(shown ?? ""), (shown ?? "").slice(0, 120));

    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=bison_campaign_id,bison_campaign_status`))[0];
    check("…and NOTHING was launched", !row.bison_campaign_id && !row.bison_campaign_status, JSON.stringify(row));
  }
  {
    // push:client_portal has every precondition met, so it reaches the 501 that
    // explains what would have happened.
    await r.tab.eval(`document.querySelector('button[data-step="push:client_portal"]').click()`);
    let shown = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      shown = await r.tab.eval(`(() => {
        const a = [...document.querySelectorAll('.anno')].map(x => x.innerText).join(" | ");
        return a.includes("Not enabled in the OS yet") ? a : null;
      })()`);
      if (shown) break;
    }
    check("a valid step says “Not enabled in the OS yet”", !!shown, "never appeared");
    check("…and names the service it would have called", /Client Portal/i.test(shown ?? ""), (shown ?? "").slice(0, 160));
    check("…and what that call does", /portal account/i.test(shown ?? ""), (shown ?? "").slice(0, 200));

    const row = (await db(`orch_clients?id=eq.${CLIENT}&select=portal_url`))[0];
    check("…and no portal was created", !row.portal_url, String(row.portal_url));
  }

  /* ========================== live controls ============================== */
  console.log("\nLIVE CONTROLS  (verified in Postgres, not by believing the toast)");
  {
    const target = stages.find((s) => s.id !== stages[0].id) ?? stages[0];
    const clicked = await r.tab.eval(`(() => {
      const b = document.querySelector('button[data-stage="${target.id}"]');
      if (!b) return "not found";
      b.click(); return "clicked";
    })()`);
    check(`the stage ribbon offers "${target.name}"`, clicked === "clicked", clicked);
    let landed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if ((await db(`orch_clients?id=eq.${CLIENT}&select=stage_id`))[0]?.stage_id === target.id) { landed = true; break; }
    }
    check("clicking a stage really moved the client", landed);
  }
  {
    // Add a custom field entirely through the UI.
    const typed = await r.tab.eval(`(async () => {
      const set = (el, v) => {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a field');
      if (!addBtn) return "no Add a field button";
      addBtn.click();
      await new Promise(r => setTimeout(r, 250));
      const label = document.querySelector('input[aria-label="New field name"]');
      const value = document.querySelector('input[aria-label="New field value"]');
      if (!label || !value) return "form did not open";
      set(label, "ZZ UI Field"); set(value, "https://example.invalid/ui");
      await new Promise(r => setTimeout(r, 100));
      const save = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add field' && !b.disabled);
      if (!save) return "Add field stayed disabled";
      save.click();
      return "submitted";
    })()`);
    check("the custom-field form fills in and submits", typed === "submitted", typed);

    let field = null;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const rows = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id,label,type,value`);
      if (rows.length) { field = rows[0]; break; }
    }
    check("…and the field is in the database", !!field, "nothing landed");
    check("…with the label and value that were typed",
      field?.label === "ZZ UI Field" && field?.value === "https://example.invalid/ui", JSON.stringify(field));
  }
  {
    // The row only appears once the screen has refetched, which happens after
    // the insert lands — so wait for the control rather than for the row.
    let editReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      editReady = await r.tab.eval(
        `!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit the ZZ UI Field field')`,
      );
      if (editReady) break;
    }
    check("the saved field appears in the list with its own Edit control", editReady);

    // The two-click arm-then-fire delete, in place of window.confirm.
    const armed = await r.tab.eval(`(async () => {
      const edit = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit the ZZ UI Field field');
      if (!edit) return "no Edit button";
      edit.click();
      await new Promise(r => setTimeout(r, 250));
      const del = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete');
      if (!del) return "no Delete button";
      del.click();
      await new Promise(r => setTimeout(r, 150));
      const armedBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete for good');
      return armedBtn ? "armed" : "did not arm";
    })()`);
    check("the delete arms on the first click rather than opening a dialog", armed === "armed", armed);

    const still = await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id`);
    check("…and one click alone deletes nothing", still.length === 1, `${still.length} left`);

    await r.tab.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete for good').click()`);
    let gone = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if ((await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id`)).length === 0) { gone = true; break; }
    }
    check("…and the second click really deletes it", gone);
  }
  {
    const clicked = await r.tab.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Mark approved');
      if (!b) return "not found"; b.click(); return "clicked";
    })()`);
    check("copy approval is a live control", clicked === "clicked", clicked);
    let approved = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if ((await db(`orch_clients?id=eq.${CLIENT}&select=copy_status`))[0]?.copy_status === "approved") { approved = true; break; }
    }
    check("…and marking approved writes the flag", approved);
  }

  /* ================================ tabs ================================= */
  console.log("\nTABS");
  {
    const switched = await r.tab.eval(`(() => {
      const b = document.querySelector('button[data-tab="team"]');
      if (!b) return "no tab"; b.click(); return "clicked";
    })()`);
    check("the Team tab is clickable", switched === "clicked", switched);
    await sleep(500);
    check("…and shows the client's own people, not their roster",
      (await r.tab.eval(`document.body.innerText.includes("ZZ UI Filler") && !document.body.innerText.includes("ZZ UI Agent")`)) === true);
    check("…and the address bar followed",
      (await r.tab.eval("location.pathname")).endsWith("/team"), await r.tab.eval("location.pathname"));
  }
  {
    await r.tab.eval(`document.querySelector('button[data-tab="agents"]').click()`);
    await sleep(500);
    check("the Agents tab shows the roster and the DNC list separately",
      (await r.tab.eval(`document.body.innerText.includes("ZZ UI Agent") && document.body.innerText.includes("ZZ UI Excluded")`)) === true);
    check("…and does not show the team contact",
      (await r.tab.eval(`!document.body.innerText.includes("ZZ UI Filler")`)) === true);
  }
  {
    await r.tab.eval(`document.querySelector('button[data-tab="leads"]').click()`);
    let rows = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      rows = await r.tab.eval(`document.querySelectorAll('table tbody tr').length`);
      if (rows >= agents.length) break;
    }
    check(`the Lead list tab loads its own data — ${rows} rows for ${agents.length} leads`, rows === agents.length, String(rows));
  }
  {
    await r.tab.eval(`document.querySelector('button[data-tab="profile"]').click()`);
    await sleep(400);
    check("and back to the profile", (await r.tab.eval(`document.querySelectorAll('button[data-step]').length`)) === 17);
  }

  const late = [...r.errors, ...r.netFails].filter((x) => !/ 501 /.test(x) && !/501 /.test(x) && !/ 400 /.test(x) && !/400 /.test(x));
  check("no console error or unexpected network failure across the whole session",
    late.length === 0, late.slice(0, 3).join(" | "));

  await r.tab.close();

  /* ============================== cleanup ================================ */
  console.log("\nCLEANUP");
  await cleanup();
  const left = await db(`orch_clients?id=eq.${CLIENT}&select=id`);
  const kids = (await db(`orch_client_team?client_id=eq.${CLIENT}&select=id`)).length
    + (await db(`orch_client_fields?client_id=eq.${CLIENT}&select=id`)).length
    + (await db(`orch_client_leads?client_id=eq.${CLIENT}&select=id`)).length
    + (await db(`orch_connector_deliveries?client_id=eq.${CLIENT}&select=id`)).length;
  check(`the test client ${CLIENT} is gone`, left.length === 0, `${left.length} left`);
  check("…and everything attached to it", kids === 0, `${kids} rows left`);
  CLIENT = null;
} catch (e) {
  failures.push(`THREW: ${e?.message ?? e}`);
  console.error("\n  ✗ threw:", e);
} finally {
  await cleanup().catch(() => {});
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`     ✗ ${f}`);
  process.exit(1);
}
