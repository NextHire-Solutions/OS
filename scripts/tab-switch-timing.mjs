/*
 * How long a TAB SWITCH takes — what people actually complain about.
 *
 * Not a cold page load: the workspace is already open, and clicking a rail item
 * is a client-side push that waits on a server render of the catch-all route.
 *
 * Three numbers per destination:
 *   FEEDBACK  click → the screen acknowledges it (skeleton, or the URL moving)
 *   READABLE  click → the destination is actually on screen and populated
 *   HOVERED   the same, having hovered the item first so prefetch has run
 *
 * FEEDBACK is "does it feel responsive". READABLE is "when can I use it".
 *
 * Detection keys on the URL, not on text changing: the topbar title updates
 * synchronously from the click, so "some text changed" fires in ~16ms and
 * measures nothing.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const PORT = process.env.PORT || 9495;
const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";

const TARGETS = [
  ["Clients",          "/roster"],
  ["All Email",        "/inbox/all-email"],
  ["Campaign",         "/analytics/campaign"],
  ["Client Portals",   "/inbox/portals"],
  ["Performance",      "/performance"],
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

const home = async () => {
  await send("Page.navigate",{url:BASE+"/analytics/copy"});
  for(let i=0;i<70;i++){ if(await ev(`!!document.querySelector('.rail')`)) break; await sleep(250); }
  await sleep(3000);
};

const run = async (label, path, hoverFirst) => {
  const ok = await ev(`(() => {
    const b=[...document.querySelectorAll('.rail button')]
      .find(x=>(x.innerText||'').replace(/\\s+/g,' ').trim().startsWith(${JSON.stringify(label)}));
    if(!b) return 'NO_ITEM'; window.__b=b; return 'ok';
  })()`);
  if (ok !== "ok") return { err: ok };
  if (hoverFirst) {
    await ev(`window.__b.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))`);
    await sleep(1600);
  }
  const t0 = Date.now();
  await ev(`window.__b.click()`);
  let feedback = null, readable = null;
  for (let i = 0; i < 300; i++) {
    const s = JSON.parse(await ev(`JSON.stringify({
      skel: !!document.querySelector('[data-screen-skeleton]'),
      url: location.pathname,
      len: ((document.querySelector('.stage')||document.body).innerText||'').length,
      rows: document.querySelectorAll('table tbody tr, .cli, .acard, [data-row]').length
    })`));
    if (feedback === null && (s.skel || s.url === path)) feedback = Date.now() - t0;
    if (s.url === path && !s.skel && (s.len > 500 || s.rows > 3)) { readable = Date.now() - t0; break; }
    await sleep(50);
  }
  return { feedback, readable };
};

console.log(`\nTAB SWITCH TIMING\n${"=".repeat(64)}`);
console.log(`  ${"destination".padEnd(18)} ${"feedback".padStart(9)} ${"readable".padStart(9)} ${"hovered".padStart(9)}`);
const out=[];
for (const [label, path] of TARGETS) {
  await home();
  const cold = await run(label, path, false);
  await home();
  const warm = await run(label, path, true);
  if (cold.err) { console.log(`  ${label.padEnd(18)}  (${cold.err})`); continue; }
  out.push({label, cold, warm});
  console.log(`  ${label.padEnd(18)} ${String(cold.feedback+"ms").padStart(9)} ${String(cold.readable+"ms").padStart(9)} ${String(warm.readable+"ms").padStart(9)}`);
}
console.log("=".repeat(64));
const avg=(xs)=>{const v=xs.filter(x=>typeof x==="number");return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):-1;};
console.log(`  feedback (click → acknowledged): ${avg(out.map(o=>o.cold.feedback))}ms`);
console.log(`  readable, cold:                  ${avg(out.map(o=>o.cold.readable))}ms`);
console.log(`  readable, hovered first:         ${avg(out.map(o=>o.warm.readable))}ms`);
ws.close();
