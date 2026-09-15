/*
 * Every screen, every width, checked by rule.
 *
 *   node scripts/ui-audit.mjs --self-test      prove the rules still fire
 *   node scripts/ui-audit.mjs [baseUrl]        audit all screens
 *
 * ---------------------------------------------------------------------------
 * WHY --self-test EXISTS AND RUNS FIRST
 *
 * The auditor this replaces reported clean for weeks while being blind to
 * three of its five rules: OVERLAP was described in a comment and never
 * written, COLLAPSED could not fire because the visibility filter it ran
 * behind required height > 0, and ESCAPES was suppressed by the page's own
 * scroller. A blind auditor and a clean page produce identical output, so the
 * sweep refuses to run until each rule has been shown to fire on a planted
 * fault.
 */
import fs from "node:fs";
import path from "node:path";

const SELF_TEST = process.argv.includes("--self-test");
const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const CDP = process.env.CDP || "http://localhost:9460";
/*
 * Five widths, down to 768. The workspace was only ever checked at desktop
 * sizes, and "looks bad" almost always shows up first when a row has to wrap.
 */
const WIDTHS = (process.env.WIDTHS || "1512,1280,1100,960,768").split(",").map(Number);

// ROUTES=/a,/b,... narrows the sweep to a shard, so several Chromes can split
// the 42 screens between them; the full list below is the default.
const ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",").map((r) => r.trim()).filter(Boolean) : [
  "/", "/performance", "/roster", "/admin/team", "/account",
  "/inbox/all-email", "/inbox/reminders", "/inbox/archive", "/inbox/trash", "/inbox/settings/personal", "/inbox/portals",
  "/inbox/settings", "/inbox/settings/labels", "/inbox/settings/templates",
  "/inbox/settings/reply-agents", "/inbox/settings/ai-labeling", "/inbox/settings/members",
  "/clients", "/clients/biweekly", "/clients/success",
  "/analytics/campaign", "/analytics/volume", "/analytics/infrastructure", "/analytics/attribution",
  "/analytics/copy", "/analytics/campaigns", "/analytics/schedule", "/analytics/clients",
  "/onboarding/pipeline", "/onboarding/stages", "/onboarding/templates", "/onboarding/settings",
  "/search/search", "/search/master", "/search/accounts", "/search/mls", "/search/import",

  /*
   * DETAIL screens.
   *
   * These need an id in the URL, so a route list built from the sidebar never
   * reaches them — and that, not a judgement about risk, is the only reason
   * they went unswept. They are the densest screens in the workspace: one
   * conversation, a campaign's whole sequence, a client's onboarding steps and
   * sub-tabs, one portal's pipeline. If anything is going to overflow, it is
   * these.
   *
   * The ids are real rows, chosen as the most active of each kind so the screen
   * renders with content rather than an empty state. If one is ever deleted the
   * screen comes up empty, which the render suite reports.
   */
  "/inbox/all-email/4b29f335-4d19-4822-8b01-d30f1a98e6a3",
  "/inbox/portals/c370499d-8cc4-4c1f-93b0-f75d363b108d",
  "/analytics/campaigns/55",
  "/onboarding/clients/664c71d8-cc22-4a8b-9d53-781132373d89",
  "/onboarding/clients/664c71d8-cc22-4a8b-9d53-781132373d89/agents",
  "/onboarding/clients/664c71d8-cc22-4a8b-9d53-781132373d89/team",
];

const RULES = fs.readFileSync(path.join(import.meta.dirname, "ui-audit-rules.js"), "utf8");

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
  const pick = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"),
    { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
}

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) =>
  (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

/* ----------------------------------------------------------------- self-test */

if (SELF_TEST) {
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  // One planted fault per rule. Every one is a shape seen for real in this
  // project: a clipped label chip, a table escaping a card, a zero-height row,
  // two buttons stacked on each other, a page wider than the screen.
  const html = `<style>
    body{margin:0;font:14px system-ui}
    .clip{width:110px;overflow:hidden;white-space:nowrap;border:1px solid #333}
    .card{width:200px;height:60px;overflow:hidden;border:1px solid #333;margin-top:16px}
    .inner{width:420px;height:40px;background:#ddd}
    .wide{width:1900px;height:20px;background:#eee;margin-top:16px}
    .flat{height:0;overflow:hidden}
    .a{position:absolute;left:40px;top:420px;width:90px;height:30px}
    .b{position:absolute;left:70px;top:432px;width:90px;height:30px}
    .noname{position:absolute;left:400px;top:420px;width:40px;height:40px}
    .tiny{position:absolute;left:460px;top:420px;width:10px;height:10px;font-size:6px;padding:0}
    .ghost{position:absolute;left:500px;top:420px;color:#fff;background:#fff}
    .flush{position:absolute;left:0;top:520px;width:200px}
    .nan{position:absolute;left:300px;top:520px}
    .emptycard{position:absolute;left:600px;top:520px;width:220px;height:90px;border:1px solid #333;border-radius:8px}
  </style>
  <div class="clip">This text is definitely cut off hard with no ellipsis</div>
  <div class="card"><div class="inner">escapes a clipping parent</div></div>
  <div class="wide">page overflow</div>
  <div class="flat">collapsed but has text</div>
  <button class="a">One</button><button class="b">Two</button>
  <button class="noname"><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg></button>
  <button class="tiny">x</button>
  <div class="ghost">invisible text</div>
  <img class="broke" src="/definitely-not-a-real-image-9f2a.png" alt="broken">
  <div class="flush">text hard against the screen edge with no gutter</div>
  <div class="nan">Total: NaN%</div>
  <div class="emptycard"></div>`;
  await ev(`document.write(${JSON.stringify(html)});document.close();true`);
  // The image has to finish failing before BROKEN-IMAGE can see it.
  await sleep(700);
  await ev(RULES);
  const out = await ev("JSON.stringify(window.__audit())");
  const kinds = [...new Set(JSON.parse(out).faults.map((f) => f.kind))];
  const want = ["PAGE-OVERFLOW", "COLLAPSED", "CLIPPED-TEXT", "ESCAPES-PARENT", "OVERLAP",
                "NO-NAME", "TINY-TARGET", "INVISIBLE-TEXT", "BROKEN-IMAGE",
                "EDGE-FLUSH", "BAD-TEXT", "EMPTY-BOX"];
  let blind = 0;
  for (const k of want) {
    const hit = kinds.includes(k);
    console.log(`  ${hit ? "✓" : "✗"} ${k}`);
    if (!hit) blind++;
  }
  console.log(blind
    ? `\n  ✗ BLIND to ${blind}/${want.length} rules — its results mean nothing\n`
    : `\n  ✅ all ${want.length} rules fire\n`);
  ws.close();
  process.exit(blind ? 1 : 0);
}

/* ---------------------------------------------------------------- the sweep */

await send("Network.setCookie", {
  name: "bs_sso", value: await token(), domain: new URL(BASE).hostname, path: "/",
  secure: BASE.startsWith("https"),
});

let total = 0;
const byKind = new Map();

for (const route of ROUTES) {
  const hits = [];
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE + route });
    // Screens fetch after mount; wait for real content rather than a fixed nap.
    for (let i = 0; i < 80; i++) {
      const n = await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`);
      if (n > 400) break;
      await sleep(200);
    }
    await sleep(900);
    await ev(RULES);
    const raw = await ev("JSON.stringify(window.__audit())");
    const out = raw ? JSON.parse(raw) : { faults: [] };

    /*
     * BROKEN-IMAGE is the one racy rule, so it has to prove itself twice.
     *
     * `naturalWidth === 0` on a complete image is a reliable signal — but an
     * image still in flight when the rules run reads the same way. It reported
     * `/portal/nicole-collins.png` as broken at one width, and that URL returns
     * 200 both locally and from the deployed tool. A second look after a pause
     * keeps only the ones that are genuinely missing; every other rule is
     * measuring geometry that has already settled and needs no retry.
     */
    if (out.faults.some((f) => f.kind === "BROKEN-IMAGE")) {
      await sleep(1800);
      await ev(RULES);
      const again = await ev("JSON.stringify(window.__audit())");
      const second = again ? JSON.parse(again) : { faults: [] };
      const stillBroken = new Set(
        second.faults.filter((f) => f.kind === "BROKEN-IMAGE").map((f) => f.el + f.detail),
      );
      out.faults = out.faults.filter(
        (f) => f.kind !== "BROKEN-IMAGE" || stillBroken.has(f.el + f.detail),
      );
    }

    const seen = new Set();
    for (const f of out.faults) {
      const key = f.kind + f.el + f.detail;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ width, ...f });
      byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
      total++;
    }
  }
  const mark = hits.length === 0 ? "✓" : "✗";
  console.log(`  ${mark} ${route.padEnd(30)} ${hits.length === 0 ? "clean" : hits.length + " issue(s)"}`);
  for (const h of hits) {
    console.log(`      ${String(h.width).padStart(4)}px  ${h.kind.padEnd(14)} ${h.el.slice(0, 40).padEnd(42)} ${h.detail}`);
    if (h.text) console.log(`              "${h.text}"`);
  }
}

console.log(`\n  ${ROUTES.length} screens x ${WIDTHS.length} widths — ${total} issue(s)`);
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${n}`);
if (total === 0) console.log("  ✅ nothing overflowing, clipped, collapsed or overlapping\n");
ws.close();
process.exit(0);
