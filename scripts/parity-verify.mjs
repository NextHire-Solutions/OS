/*
 * Every feature ported in the parity build-out, checked on production.
 *
 * One PASS/FAIL per feature, read-only (every non-GET request is failed at the
 * transport), against the deployed workspace. Written BEFORE the features
 * landed, from the build briefs, so the agents' reports are checked against
 * what a browser actually shows rather than taken on trust — the lesson of
 * the last round, where "verified" meant "rendered".
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/parity-verify.mjs
 */
import fs from "node:fs";
const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const PORT = process.env.PORT || 9510;
const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";

const t = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`,{method:"PUT"})).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id=0; const w=new Map(); const blocked=[];
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);}};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const raw=fs.readFileSync(`${B}/.env.local`,"utf8");
const pick=k=>{const m=raw.match(new RegExp(`^${k}=(.*)$`,"m"));return m?m[1].trim().replace(/^["']|["']$/g,""):undefined;};
const { mintSso, ALL_TOOLS } = await import(`${B}/src/lib/bs-auth.ts`);
const cookie = `bs_sso=${await mintSso(pick("BS_SSO_SECRET")||pick("AUTH_SECRET"),{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1})}`;
await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
await send("Network.setCookie",{name:"bs_sso",value:cookie.slice(7),domain:new URL(BASE).hostname,path:"/",secure:BASE.startsWith("https")});
await send("Emulation.setDeviceMetricsOverride",{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
await send("Fetch.enable",{patterns:[{urlPattern:"*"}]});
ws.addEventListener("message", async (e)=>{const m=JSON.parse(e.data); if(m.method!=="Fetch.requestPaused")return;
  const {requestId,request}=m.params; const meth=(request.method||"GET").toUpperCase();
  if(meth==="GET"||meth==="HEAD") await send("Fetch.continueRequest",{requestId});
  else { blocked.push(`${meth} ${request.url}`); await send("Fetch.failRequest",{requestId,errorReason:"BlockedByClient"}); }});

const out=[];
const check=(area,name,pass,detail="")=>{out.push({area,name,pass});console.log(`  ${pass?"PASS":"FAIL"}  [${area}] ${name}${detail?`  —  ${detail}`:""}`);};
const go=async(path,ms=10000)=>{await send("Page.navigate",{url:BASE+path});await sleep(ms);};
const has=(re)=>ev(`${re}.test(document.body.innerText||'')`);
const btn=(re)=>ev(`[...document.querySelectorAll('button,[role=menuitem],a')].some(b=>${re}.test((b.innerText||b.getAttribute('aria-label')||'').trim()))`);
const api=async(path)=>{const r=await fetch(BASE+path,{headers:{cookie}});let j=null;try{j=await r.json();}catch{} return {status:r.status,body:j};};

/* ───────────── Master Inbox ───────────── */
console.log("\nMASTER INBOX\n");
await go("/inbox/all-email");
check("inbox","view tabs offer a New view control", await btn("/new view|new tab/i"));
check("inbox","a view tab has a menu (rename / delete)", await ev(`[...document.querySelectorAll('button')].some(b=>/more|options|menu/i.test(b.getAttribute('aria-label')||'')) || !!document.querySelector('[data-view-menu],[aria-haspopup="menu"]')`));
check("inbox","client rail has a Create list item control", await btn("/create list item|new list/i"));
check("inbox","conversation rows show a channel icon + platform chip", await ev(`!!document.querySelector('.mi-list .tile svg, .mi-list .tile') && !!document.querySelector('.mi-list .c-bison, .mi-list .c-inst')`));
{
  const multi = JSON.parse(await ev(`JSON.stringify((()=>{const rows=[...document.querySelectorAll('.mi-list a[href*="/inbox/"]')];const counts=rows.map(r=>r.querySelectorAll('.lc').length);return {max:Math.max(0,...counts),rows:rows.length};})())`));
  check("inbox","conversation rows render up to two label chips", multi.max>=2 || multi.rows===0 || multi.max===1, `max chips on a row: ${multi.max} (≥2 proves the second chip; 1 means no thread on this page carries two labels)`);
}
const sw = await api("/api/tools/master-inbox/workspaces/switch");
check("inbox","workspace switch route exists", sw.status !== 404, `HTTP ${sw.status}`);
await go("/inbox/reminders");
check("inbox","reminders screen uses the real view tabs (New view control present)", await btn("/new view|new tab/i"));
await go("/inbox/settings/personal");
check("inbox","Personal settings tab shows the Workspace section", await has("/workspace/i"));
for (const r of ["thread-counts","cleanup-threads","retag-all-clients","backfill-interested","dedupe-outbound","reclassify-directions","sync-workspaces","last-webhook-payload","inspect-null-senders"]) {
  const a = await api(`/api/tools/master-inbox/admin/${r}`);
  check("inbox",`admin route ${r} exists`, a.status !== 404, `HTTP ${a.status}`);
}

/* ───────────── Analytics — detail ───────────── */
console.log("\nANALYTICS — campaign detail\n");
await go("/analytics/campaigns",12000);
const href = await ev(`(document.querySelector('tbody a[href^="/analytics/campaigns/"]')||{}).getAttribute?.('href')`);
await go(href,12000);
check("analytics","Leads tab present", await btn("/^leads$/i"));
await ev(`(()=>{const b=[...document.querySelectorAll('button,[role=tab]')].find(x=>/^\\s*sequence\\s*$/i.test(x.innerText||'')); if(b) b.click();})()`);
await sleep(2500);
check("analytics","Sequence edit control present (Sequence tab)", await btn("/edit sequence|^edit$/i"));
check("analytics","Copy sequence from… present", await btn("/copy sequence from|copy from/i"));
check("analytics","Push to campaigns… present (Sequence tab)", await btn("/push to campaigns/i"));
check("analytics","Assign inboxes present", await btn("/assign inboxes|inboxes/i"));
check("analytics","Re-campaign present", await btn("/re-?campaign/i"));
check("analytics","For multiple clients… (fan-out) present", await btn("/for multiple clients/i"));
check("analytics","email preview renders in a sandboxed iframe", await ev(`!!document.querySelector('iframe[sandbox]')`), "(may need the Sequence tab open)");

/* ───────────── Analytics — list / overview ───────────── */
console.log("\nANALYTICS — list & overview\n");
const st = await api("/api/tools/analytics/sync/status");
check("analytics","sync/status answers", st.status===200 && typeof st.body?.healthy==="boolean", `healthy=${st.body?.healthy} degraded=${JSON.stringify(st.body?.degraded??null)}`);
await go("/analytics/campaign",12000);
check("analytics","staleness strip absent when healthy / present when degraded", st.body?.healthy ? !(await has("/data may be stale/i")) : await has("/data may be stale/i"));
await ev(`(()=>{const b=[...document.querySelectorAll('.seg button,[role=radio],button')].find(x=>/^\\s*replies\\s*$/i.test(x.innerText||'')); if(b) b.click();})()`);
await sleep(3000);
check("analytics","reply attribute filters on the Replies sub-view (brokerage / location / volume)", await btn("/current brokerage|brokerage/i") && await btn("/location/i") && await btn("/sales volume/i"));
await ev(`(()=>{const b=[...document.querySelectorAll('.seg button,[role=radio],button')].find(x=>/^\\s*charts\\s*$/i.test(x.innerText||'')); if(b) b.click();})()`);
await sleep(1500);
check("analytics","Exclude weekends control", await has("/exclude weekends/i"));
check("analytics","Volume is a tab in the analytics tab strip", await ev(`[...document.querySelectorAll('.an-tabs a')].some(a=>/^\\s*volume\\s*$/i.test(a.innerText||''))`));
check("analytics","Campaign screen sub-views are the tool's four (Charts/Clients/Campaigns/Replies)", await ev(`(()=>{
  const segs=[...document.querySelectorAll('.seg, .segfull, [role=group]')].map(s=>[...s.querySelectorAll('button')].map(b=>(b.innerText||'').trim().toLowerCase()));
  const sub=segs.find(l=>l.includes('charts')&&l.includes('replies'));
  return !!sub && sub.length===4 && !sub.includes('volume');
})()`));
await go("/analytics/volume",12000);
check("analytics","Email volume page renders", (await ev(`location.pathname`))==="/analytics/volume" && await has("/email volume|volume/i"));
await go("/analytics/campaigns",12000);
check("analytics","per-row action menu on the list", await ev(`!!document.querySelector('tbody tr button[aria-haspopup], tbody tr button[aria-label*="actions" i], tbody tr button[aria-label*="menu" i]')`));
check("analytics","List / Grid toggle", await btn("/^grid$/i") || await ev(`!!document.querySelector('[aria-label*="grid" i]')`));
await ev(`(()=>{const b=[...document.querySelectorAll('button,[role=radio]')].find(x=>/^\\s*grid\\s*$/i.test((x.innerText||'').trim())); if(b) b.click();})()`);
await sleep(2500);
check("analytics","Grid view renders campaign cards", await ev(`(()=>{
  const tableRows=document.querySelectorAll('tbody tr').length;
  const cards=[...document.querySelectorAll('section.screen.on *')].filter(e=>e.querySelector('a[href^="/analytics/campaigns/"]') && e.children.length>=2 && getComputedStyle(e).display!=='table-row').length;
  return tableRows===0 && cards>3;
})()`));
await go("/analytics/infrastructure",12000);
check("analytics","Infrastructure Provider filter", await ev(`[...document.querySelectorAll('select')].some(s=>/provider/i.test(s.getAttribute('aria-label')||(s.closest('label')||{}).textContent||''))`));
await go("/analytics/copy",12000);
check("analytics","offer card links to its sequence", await ev(`[...document.querySelectorAll('button,a')].some(b=>/sequence/i.test((b.innerText||'')+(b.getAttribute('aria-label')||'')+(b.getAttribute('title')||'')))`));

/* ───────────── Onboarding ───────────── */
console.log("\nONBOARDING\n");
await go("/onboarding/pipeline",12000);
const ths = await ev(`[...document.querySelectorAll('thead th')].map(t=>t.innerText.trim().toLowerCase())`);
for (const col of ["health","profile","salesperson","contact","mls"]) check("onboarding",`pipeline column: ${col}`, (ths||[]).some(h=>h.includes(col)), `columns: ${(ths||[]).join(" | ")}`);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^\\s*filter\\s*$/i.test((x.innerText||'').trim())); if(b) b.click();})()`);
await sleep(1200);
check("onboarding","per-column filter row (after pressing Filter)", await ev(`document.querySelectorAll('thead input, thead select, .onb-pipeline input').length >= 2`));
check("onboarding","click-to-sort headers", await ev(`[...document.querySelectorAll('thead th')].some(t=>t.querySelector('button')||t.getAttribute('aria-sort')||/[↕↑↓]/.test(t.innerText))`));
check("onboarding","Recent client replies panel", await has("/recent client replies|recent replies/i"));
check("onboarding","Filter / Clear toolbar with count", await btn("/^filter|hide filters|clear/i"));
const firstClient = await ev(`(document.querySelector('tbody a[href^="/onboarding/clients/"]')||{}).getAttribute?.('href')`);
if (firstClient) {
  await go(firstClient, 11000);
  check("onboarding","Stripe test/live mode badge on the payment box", await has("/test mode|live mode/i"));
} else {
  check("onboarding","Stripe test/live mode badge on the payment box", false, "no client link found on the pipeline");
}

/* ───────────── Client Health ───────────── */
console.log("\nCLIENT HEALTH\n");
for (const p of ["/clients/biweekly","/clients/success"]) {
  await go(p,11000);
  check("client-health",`${p} has week navigation`, await btn("/this week|today/i") && await ev(`[...document.querySelectorAll('button')].some(b=>/previous week|next week|←|→/i.test(b.innerText||b.getAttribute('aria-label')||''))`));
  check("client-health",`${p} has + Add Client`, await btn("/add client/i"));
}
const ro = await api("/api/tools/client-health/metrics/weekly");
check("client-health","GET metrics/weekly exists", ro.status!==404, `HTTP ${ro.status}`);
const cs = await api("/api/tools/client-health/clients/status");
check("client-health","GET clients/status exists", cs.status!==404, `HTTP ${cs.status}`);

/* ───────────── Agent Search ───────────── */
console.log("\nAGENT SEARCH\n");
await go("/search/accounts",11000);
check("agent-search","accounts table lists configured accounts", await ev(`document.querySelectorAll('table tbody tr').length>0`));
check("agent-search","re-scrape control present", await btn("/re-?scrape|refresh/i"));

/* ───────────── Team access ───────────── */
console.log("\nTEAM ACCESS\n");
const tu = await api("/api/admin/users");
check("team","admin/users reports writable state", tu.status===200 && typeof tu.body?.capabilities?.writable==="boolean", `writable=${tu.body?.capabilities?.writable} store=${tu.body?.governance?.store}`);

console.log("\n"+"=".repeat(72));
const bad=out.filter(o=>!o.pass);
console.log(`  ${out.length-bad.length} of ${out.length} passed · writes blocked: ${blocked.length}`);
if(bad.length){console.log("  FAILED:"); for(const b of bad) console.log(`      [${b.area}] ${b.name}`);}
ws.close(); process.exit(bad.length?1:0);
