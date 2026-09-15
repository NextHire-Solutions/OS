/*
 * How long does switching feel?
 *
 * Measures what a person actually does: click a sidebar link and wait for the
 * new screen to be READABLE — not for the network to go quiet, and not a cold
 * full-page load. Server-rendered routes in this app fetch from upstream tools
 * during render, so a slow screen is usually a slow upstream call, and the
 * difference between 200ms and 3s is the whole complaint.
 *
 * Two numbers per screen:
 *   TTFB    how long the server took to start answering  (server work)
 *   READY   until the screen has real content on it      (what is felt)
 *
 * Each is measured twice: COLD (first visit this session) and WARM (second
 * visit), because anything cached upstream shows up as a big gap between them.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const PORT = process.env.PORT || 9494;
const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";

const SCREENS = process.env.SCREENS ? process.env.SCREENS.split(",") : [
  "/roster","/performance",
  "/inbox/all-email","/inbox/open-responses","/inbox/archive","/inbox/reminders","/inbox/portals",
  "/clients","/clients/biweekly","/clients/success",
  "/analytics/campaign","/analytics/campaigns","/analytics/attribution","/analytics/copy",
  "/analytics/clients","/analytics/schedule","/analytics/infrastructure",
  "/onboarding/pipeline","/onboarding/stages","/onboarding/templates",
  "/search/master","/search/accounts","/search/mls",
];

const t = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`,{method:"PUT"})).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id=0; const w=new Map();
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);}};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const raw=fs.readFileSync(`${B}/.env.local`,"utf8");
const pick=k=>{const m=raw.match(new RegExp(`^${k}=(.*)$`,"m"));return m?m[1].trim().replace(/^["']|["']$/g,""):undefined;};
const { mintSso, ALL_TOOLS } = await import(`${B}/src/lib/bs-auth.ts`);
await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
await send("Network.setCookie",{name:"bs_sso",value:await mintSso(pick("BS_SSO_SECRET")||pick("AUTH_SECRET"),{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1}),domain:"os.brokerstaffer.com",path:"/",secure:true});
await send("Emulation.setDeviceMetricsOverride",{width:1512,height:950,deviceScaleFactor:1,mobile:false});

/** Server time for the route itself, straight from the Navigation Timing API. */
const measure = async (path) => {
  const t0 = Date.now();
  await send("Page.navigate", { url: BASE + path });
  let ready = null;
  for (let i = 0; i < 120; i++) {
    const n = await ev(`(() => {
      const s = document.querySelector('section.screen.on') || document.body;
      const txt = (s.innerText || '');
      const rows = document.querySelectorAll('table tbody tr, .cli, .acard, [data-row]').length;
      if (document.querySelector('[aria-busy=true], .skeleton')) return 0;
      // A screen with a heading and any real text is readable; small pages
      // (Account, Team access) never reach 600 characters and read as -1.
      const heading = s.querySelector('h1, h2, .card-l');
      return (txt.length > 600 || rows > 3 || (heading && txt.length > 120)) ? 1 : 0;
    })()`);
    if (n === 1) { ready = Date.now() - t0; break; }
    await sleep(120);
  }
  const nav = await ev(`(() => {
    const e = performance.getEntriesByType('navigation')[0];
    return e ? JSON.stringify({ ttfb: Math.round(e.responseStart - e.requestStart),
                                dom: Math.round(e.domContentLoadedEventEnd) }) : 'null';
  })()`);
  const n = nav && nav !== "null" ? JSON.parse(nav) : { ttfb: -1, dom: -1 };
  return { ready: ready ?? -1, ttfb: n.ttfb };
};

console.log(`\nNAVIGATION TIMING — ${BASE}\n${"=".repeat(74)}`);
console.log(`  ${"screen".padEnd(30)} ${"cold ttfb".padStart(10)} ${"cold ready".padStart(11)} ${"warm ttfb".padStart(10)} ${"warm ready".padStart(11)}`);
const rows = [];
for (const s of SCREENS) {
  const cold = await measure(s);
  await send("Page.navigate", { url: BASE + "/performance" }); await sleep(900);
  const warm = await measure(s);
  rows.push({ s, cold, warm });
  const flag = warm.ready > 1500 ? "  ← slow" : "";
  console.log(`  ${s.padEnd(30)} ${String(cold.ttfb+"ms").padStart(10)} ${String(cold.ready+"ms").padStart(11)} ${String(warm.ttfb+"ms").padStart(10)} ${String(warm.ready+"ms").padStart(11)}${flag}`);
}
console.log("=".repeat(74));
const slow = rows.filter(r => r.warm.ready > 1500).sort((a,b)=>b.warm.ready-a.warm.ready);
console.log(`\n  ${slow.length} screen(s) over 1.5s when warm — the ones that feel laggy:`);
for (const r of slow) console.log(`      ${r.s.padEnd(30)} ${r.warm.ready}ms ready, ${r.warm.ttfb}ms server`);
const med = rows.map(r=>r.warm.ready).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
console.log(`\n  median warm ready: ${med}ms`);
ws.close();
