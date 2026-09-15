/*
 * A maintenance probe for the settings work: list what the settings APIs hold,
 * and remove any record whose name starts with the test prefix.
 *
 *   node scripts/settings-probe.mjs [baseUrl] [--sweep]
 *
 * The sweep exists because one write path can half-succeed: `saveAgent` INSERTS
 * the agent and only then encrypts its API key, so a failure in the key RPC
 * returns 400 to the browser with the row already in the table. A test that
 * only cleans up what the UI told it succeeded would leave that row behind.
 */
import fs from "node:fs";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3370";
const SWEEP = process.argv.includes("--sweep");
const PREFIX = "zz-mis-";

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});
const headers = { Cookie: `bs_sso=${cookie}` };

console.log(`  APP_ENCRYPTION_KEY in .env.local: ${pick("APP_ENCRYPTION_KEY") ? "set" : "MISSING"}`);

/*
 * `--diagnose` walks the clients endpoints with a throwaway record and prints
 * every response BODY.
 *
 * It earned its place twice. It showed that DELETE answers 409 for any client
 * with a live portal — correct, deliberate, and the reason a test client cannot
 * simply be deleted again afterwards. And it showed that the whole set answers
 * 500 under `next dev --webpack` (`requireAuthedUser` calls `headers()`, which
 * webpack-dev does not give a request scope) while being perfectly healthy
 * under Turbopack — which is what production runs. Without this the settings
 * test would have reported a product bug that does not exist.
 */
if (process.argv.includes("--diagnose")) {
  const name = `${PREFIX}diag-${Date.now().toString(36)}`;
  const say = async (label, res) => {
    const body = await res.text();
    console.log(`  ${String(res.status).padStart(3)} ${label}  ${body.slice(0, 300)}`);
    return body;
  };
  await say("GET  /clients", await fetch(`${BASE}/api/tools/master-inbox/clients`, { headers }));
  const created = await fetch(`${BASE}/api/tools/master-inbox/clients`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name, aliases: [`${name} alias`] }),
  });
  const createdBody = await say("POST /clients", created);
  const id = JSON.parse(createdBody || "{}")?.client?.id;
  if (id) {
    await say(
      `PATCH /clients/${id}`,
      await fetch(`${BASE}/api/tools/master-inbox/clients/${id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${name}-renamed` }),
      }),
    );
    // A live portal makes DELETE answer 409 — that IS the behaviour being
    // demonstrated, so it is shown first and then stood down, so this probe
    // cannot leave its own throwaway client behind.
    await say(
      `DELETE /clients/${id} (portal live)`,
      await fetch(`${BASE}/api/tools/master-inbox/clients/${id}`, { method: "DELETE", headers }),
    );
    await fetch(`${BASE}/api/tools/master-inbox/clients/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ portal_enabled: false }),
    });
    await say(
      `DELETE /clients/${id} (portal off)`,
      await fetch(`${BASE}/api/tools/master-inbox/clients/${id}`, { method: "DELETE", headers }),
    );
  }
  process.exit(0);
}

/*
 * `--hydration` loads a set of screens and reports each one's console errors.
 *
 * This repo has shipped a hydration mismatch three times, so "no console
 * errors" is not a nice-to-have here. Attributing them per URL — including two
 * screens OUTSIDE settings — is what tells you whether a warning belongs to the
 * work in hand or to the shell it is sitting in.
 */
if (process.argv.includes("--hydration")) {
  const CDP = "http://localhost:9451";
  const URLS = [
    "/",
    "/inbox/all-email",
    "/inbox/settings/labels",
    "/inbox/settings/templates",
    "/inbox/settings/reply-agents",
    "/inbox/settings/ai-labeling",
    "/inbox/settings/clients",
    "/inbox/settings/members",
    "/inbox/settings/personal",
    "/inbox/settings/webhooks",
    // The stale-bookmark path: an unknown tab renders Labels.
    "/inbox/settings/not-a-real-tab",
  ];
  for (const path of URLS) {
    const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    const errs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        errs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (m.method === "Runtime.exceptionThrown") {
        errs.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? ""));
      }
    };
    const send = (mm, pr = {}) =>
      new Promise((res) => {
        const i = ++id;
        pend.set(i, res);
        ws.send(JSON.stringify({ id: i, method: mm, params: pr }));
      });
    const ev = async (x) =>
      (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
        .result?.result?.value;
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
    await send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await ev("document.readyState")) === "complete") break;
    }
    await new Promise((r) => setTimeout(r, 2200));
    const real = [...new Set(errs)].filter((e) => !/DevTools|Fast Refresh|source map/i.test(e));
    console.log(`  ${real.length === 0 ? "✓" : "✗"} ${path.padEnd(32)} ${real.length} console error(s)`);
    for (const e of real.slice(0, 3)) console.log(`        ${e.replace(/\s+/g, " ").slice(0, 220)}`);
    await fetch(`${CDP}/json/close/${t.id}`);
  }
  process.exit(0);
}

/*
 * `--hydration-serial` is `--hydration` under the test's own conditions.
 *
 * `--hydration` opens a FRESH TAB per URL at the browser's default size. The
 * settings suite does neither: it drives one long-lived tab with a 1440x950
 * device-metrics override and walks every tab in sequence, twice over. A
 * hydration warning that only appears on a re-navigation inside a warm tab
 * would be invisible to the first mode and caught by this one.
 *
 * Each URL's errors are attributed to that URL by clearing the buffer at every
 * navigation, so a warning names the screen that produced it.
 */
if (process.argv.includes("--hydration-serial")) {
  const CDP = "http://localhost:9451";
  const URLS = [
    "/inbox/settings/labels",
    "/inbox/settings/templates",
    "/inbox/settings/reply-agents",
    "/inbox/settings/ai-labeling",
    "/inbox/settings/clients",
    "/inbox/settings/members",
    "/inbox/settings/personal",
    "/inbox/settings/webhooks",
  ];
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  let errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      errs.push("EXCEPTION " + (m.params.exceptionDetails?.exception?.description ?? ""));
    }
  };
  const send = (mm, pr = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method: mm, params: pr }));
    });
  const ev = async (x) =>
    (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });

  let bad = 0;
  for (let lap = 1; lap <= 2; lap++) {
    for (const path of URLS) {
      errs = [];
      await send("Page.navigate", { url: BASE + path });
      for (let i = 0; i < 250; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if ((await ev("document.readyState")) === "complete" && (await ev("!!document.querySelector('.mis')"))) break;
      }
      await new Promise((r) => setTimeout(r, 1400));
      const real = [...new Set(errs)].filter((e) => !/DevTools|Fast Refresh|source map/i.test(e));
      if (real.length) bad += 1;
      console.log(`  ${real.length === 0 ? "✓" : "✗"} lap ${lap}  ${path.padEnd(32)} ${real.length} console error(s)`);
      for (const e of real.slice(0, 2)) console.log(`        ${e.replace(/\s+/g, " ").slice(0, 240)}`);
    }
  }
  console.log(`\n  ${bad === 0 ? "clean" : bad + " screen load(s) warned"} across ${URLS.length * 2} navigations in one warm tab`);
  await fetch(`${CDP}/json/close/${t.id}`);
  process.exit(bad ? 1 : 0);
}

/*
 * `--hydration-ai-custom` reproduces the one hydration hazard these panels had.
 *
 * AI labelling's model picker has two modes, and the custom one is NOT
 * dialog-only markup: it renders on the SERVER whenever the saved model is not
 * a preset for the saved provider — which is exactly what saving a custom model
 * id does. While that input carried `autoFocus`, React serialised an
 * `autofocus` attribute into the SSR HTML and applied it as a property on the
 * client, and the trees disagreed on an attribute: "A tree hydrated but some
 * attributes of the server rendered HTML didn't match the client properties."
 *
 * A plain load of the tab never shows it, because this workspace's saved model
 * IS a preset. So this mode puts the config into the state that triggers it,
 * loads the page, reports, and puts the config back exactly as it found it.
 */
if (process.argv.includes("--hydration-ai-custom")) {
  const CDP = "http://localhost:9451";
  const cfgUrl = `${BASE}/api/tools/master-inbox/ai-labeling`;
  const before = await (await fetch(cfgUrl, { headers })).json();
  const original = before?.config?.model ?? before?.model ?? null;
  console.log(`  saved model is "${original}" — a preset, so the custom branch never renders`);

  const put = async (model) => {
    const r = await fetch(cfgUrl, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    return r.status;
  };
  console.log(`  PATCH model -> "zz-custom-model-probe": ${await put("zz-custom-model-probe")}`);

  const load = async (label) => {
    const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    const errs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        errs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    };
    const send = (mm, pr = {}) =>
      new Promise((res) => {
        const i = ++id;
        pend.set(i, res);
        ws.send(JSON.stringify({ id: i, method: mm, params: pr }));
      });
    const ev = async (x) =>
      (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
        .result?.result?.value;
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
    await send("Page.navigate", { url: `${BASE}/inbox/settings/ai-labeling` });
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await ev("document.readyState")) === "complete") break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const custom = await ev(`!!document.querySelector('input[aria-label="Custom model id"]')`);
    const auto = await ev(`document.querySelector('input[aria-label="Custom model id"]')?.hasAttribute('autofocus') ?? null`);
    const real = [...new Set(errs)].filter((e) => !/DevTools|Fast Refresh|source map/i.test(e));
    console.log(`  ${real.length === 0 ? "✓" : "✗"} ${label}: custom input rendered=${custom}  autofocus attr=${auto}  ${real.length} console error(s)`);
    for (const e of real.slice(0, 2)) console.log(`        ${e.replace(/\s+/g, " ").slice(0, 240)}`);
    await fetch(`${CDP}/json/close/${t.id}`);
    return real.length;
  };

  await load("with a custom model saved");
  if (original) console.log(`  PATCH model -> "${original}" (restored): ${await put(original)}`);
  const after = await (await fetch(cfgUrl, { headers })).json();
  console.log(`  model is now "${after?.config?.model ?? after?.model}"`);
  process.exit(0);
}

/*
 * `--sweep-ui` removes leftover LABELS.
 *
 * There is no `GET /api/tools/master-inbox/labels` — the settings page loads
 * them server-side — so a label's id never reaches the browser and an API sweep
 * has nothing to address. The screen itself is the list, so the sweep drives
 * the screen: open the tab, and work the arm-then-fire delete on any row whose
 * name carries the test prefix.
 */
if (process.argv.includes("--sweep-ui")) {
  const CDP = "http://localhost:9451";
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  };
  const send = (mm, pr = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method: mm, params: pr }));
    });
  const ev = async (x) =>
    (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  await send("Page.navigate", { url: `${BASE}/inbox/settings/labels` });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await ev(`document.readyState === 'complete' && !!document.querySelector('.mis .atbl tbody tr')`)) break;
  }
  await new Promise((r) => setTimeout(r, 900));

  // Capped: a delete that never sticks must not spin here forever. It can take
  // a few passes — `loadLabels` serves a 30-second cache, so the row can still
  // be on the reloaded page after a delete that really did land.
  for (let pass = 0; pass < 15; pass++) {
    const name = await ev(
      `(() => { const r = Array.from(document.querySelectorAll('[data-mis-label]')).find(x => x.getAttribute('data-mis-label').startsWith(${JSON.stringify(PREFIX)})); return r ? r.getAttribute('data-mis-label') : null; })()`,
    );
    if (!name) break;
    const sel = `[data-mis-label="${name}"] .mis-cell-a button[data-armed]`;
    const armed = await ev(`(() => { const b = document.querySelector('${sel}'); if (!b) return false; b.click(); return true; })()`);
    if (!armed) {
      console.log(`      ${name} has no delete control (system label?) — left alone`);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
    await ev(`document.querySelector('[data-mis-label="${name}"] .mis-cell-a button[data-armed="true"]').click()`);
    await new Promise((r) => setTimeout(r, 2500));
    console.log(`      delete fired for  ${name}`);
    await send("Page.navigate", { url: `${BASE}/inbox/settings/labels` });
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await ev(`document.readyState === 'complete' && !!document.querySelector('.mis .atbl tbody tr')`)) break;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  console.log(`  label sweep done`);
  await fetch(`${CDP}/json/close/${t.id}`);
  process.exit(0);
}

const SOURCES = [
  { kind: "labels", url: "/api/tools/master-inbox/labels", key: "labels" },
  { kind: "templates", url: "/api/tools/master-inbox/reply-templates", key: "templates" },
  { kind: "agents", url: "/api/tools/master-inbox/reply-agents", key: "agents" },
  { kind: "clients", url: "/api/tools/master-inbox/clients", key: "clients" },
];

for (const s of SOURCES) {
  const res = await fetch(BASE + s.url, { headers });
  const json = await res.json().catch(() => null);
  const rows = Array.isArray(json) ? json : (json?.[s.key] ?? []);
  const mine = rows.filter((r) => typeof r.name === "string" && r.name.startsWith(PREFIX));
  console.log(`  ${s.kind.padEnd(10)} ${String(rows.length).padStart(4)} rows, ${mine.length} test record(s)`);
  for (const r of mine) {
    if (!SWEEP) {
      console.log(`      leftover ${r.id}  ${r.name}`);
      continue;
    }
    /*
     * A client is created with a live portal, and the DELETE endpoint refuses
     * while one is live (409) — deliberately, because deleting the row
     * dead-links whatever the client has bookmarked. So a test client has to
     * have its portal switched off before it can be swept.
     */
    if (s.kind === "clients") {
      await fetch(`${BASE}${s.url}/${r.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ portal_enabled: false }),
      });
    }
    const del = await fetch(`${BASE}${s.url}/${r.id}`, { method: "DELETE", headers });
    console.log(`      ${del.ok ? "removed" : `FAILED (${del.status})`}  ${r.name}`);
  }
}
