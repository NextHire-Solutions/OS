/*
 * Does the client detail screen FIT? — its four tabs, at three widths.
 *
 *   node scripts/onboarding-client-layout-test.mjs [baseUrl] [width]
 *
 * A sibling of scripts/onboarding-layout-test.mjs, with its measurement
 * verbatim. Separate because the client screen has no address in the shell yet
 * (see ONBOARDING-CLIENT-WIRING.md), so it is reachable only through the preview
 * harness, and the shared scripts must keep testing the real routes.
 *
 * Every test before this one asked whether things existed. None asked whether
 * they were the right size, so a screen could pass everything while rows ran off
 * the side of the window. This measures:
 *
 *   - horizontal overflow of the document
 *   - elements that escape the viewport with nothing scrollable to contain them
 *
 * READ-ONLY. It opens a real client and clicks only the tab strip, because a
 * real client is a better layout test than a fixture — long names, hundreds of
 * leads, a full delivery log. Nothing is edited.
 *
 * Ports 3340 / 9447.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3340";
const CDP = "http://localhost:9447";
const WIDTHS = process.argv[3] ? [Number(process.argv[3])] : [1440, 1280, 1100];
const PREFIX = process.env.ONBOARDING_CLIENT_PREFIX || "/onboarding/clients";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

/* The client with the most leads — the widest table this screen can draw. */
const U = pick("AGENT_SEARCH_SUPABASE_URL");
const K = pick("AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY");
const head = { apikey: K, Authorization: `Bearer ${K}` };
const busiest = await (
  await fetch(`${U}/rest/v1/orch_clients?select=id,client_name&bison_leads_exported=is.true&limit=1`, { headers: head })
).json();
const anyClient = await (
  await fetch(`${U}/rest/v1/orch_clients?select=id,client_name&limit=1`, { headers: head })
).json();
const client = busiest[0] ?? anyClient[0];
if (!client) throw new Error("no client to measure against");
console.log(`  measuring against "${client.client_name}" (read-only)\n`);

let bad = 0;
let ran = 0;

for (const WIDTH of WIDTHS) {
  for (const tab of ["profile", "leads", "agents", "team"]) {
    const path = tab === "profile" ? `${PREFIX}/${client.id}` : `${PREFIX}/${client.id}/${tab}`;
    const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (mm, p = {}) =>
      new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
    const ev = async (x) =>
      (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
    await send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await ev("document.readyState")) === "complete" && (await ev("document.body.innerText.length")) > 600) break;
    }
    // The leads tab fetches its own data after mount; give it a moment to land.
    await new Promise((r) => setTimeout(r, tab === "leads" ? 2500 : 600));

    const report = await ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const docOverflow = document.documentElement.scrollWidth - vw;
      const screen = document.querySelector('section.screen.on') || document.body;

      /*
       * Content inside a horizontally SCROLLABLE ancestor is not overflow — it
       * is the point of the scroller. So: walk up from each element, and ignore
       * it if any ancestor scrolls horizontally or clips. What survives is
       * genuine — something that escapes the window with nothing to contain it.
       */
      const scrolls = (el) => {
        const s = getComputedStyle(el);
        return (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden');
      };
      const contained = (el) => {
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          if (scrolls(p)) return true;
        }
        return false;
      };

      const offenders = [];
      for (const el of screen.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= vw + 1) continue;
        if (contained(el)) continue;
        offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44), right: Math.round(r.right), w: Math.round(r.width) });
      }
      const seen = new Set(); const top = [];
      for (const o of offenders.sort((a, b) => b.right - a.right)) {
        const k = o.tag + '.' + o.cls;
        if (seen.has(k)) continue;
        seen.add(k); top.push(o);
        if (top.length >= 6) break;
      }
      const scrollers = [];
      for (const el of screen.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 2 && scrolls(el)) {
          scrollers.push(String(el.className || el.tagName).slice(0, 40) + ' (' + el.clientWidth + '→' + el.scrollWidth + ')');
        }
      }
      return { vw, docOverflow, count: offenders.length, top, scrollers: scrollers.slice(0, 3), chars: document.body.innerText.length };
    })()`);

    ran++;
    const ok = report.docOverflow <= 1 && report.count === 0;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${String(WIDTH).padStart(4)}px  ${tab.padEnd(8)} doc overflow ${String(report.docOverflow).padStart(4)}px  ` +
        `${report.count} past the edge  (${report.chars} chars)`,
    );
    for (const sc of report.scrollers) console.log(`        scrolls: ${sc}`);
    for (const o of report.top) console.log(`        ${String(o.right).padStart(5)}px right (w=${o.w})  <${o.tag} class="${o.cls}">`);
    await fetch(`${CDP}/json/close/${t.id}`);
  }
}

console.log(`\n  ${ran - bad}/${ran} views fit the viewport`);
process.exit(bad ? 1 : 0);
