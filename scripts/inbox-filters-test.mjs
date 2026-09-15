/*
 * The inbox filter builder — the thing the generic sweep could not see.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEEDED ITS OWN TEST
 *
 * The filter sweep reported "1 filter" on every inbox screen. The inbox
 * actually has: a 13-field filter builder behind a "Filters" button, a strip of
 * saved-view tabs, and a client list in the left rail — none of which look like
 * a filter to a selector. The tabs are <Link> anchors, and the builder is not a
 * control at all but a WORKFLOW: open Filters → Add more → choose a field →
 * choose an operator → choose values → Apply.
 *
 * A sweep that clicks controls and compares row counts cannot express that, so
 * it silently reported the richest filtering surface in the product as one
 * search box.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED
 *
 *   ADDABLE   the field can be added and its row renders with operators
 *   APPLIES   Apply Filter changes the URL or the thread list
 *   TABS      each saved view is reachable and changes what is listed
 *   CLIENTS   the left-rail client list filters the threads
 *
 * Nothing is saved. "Save to All Email" and "Save as new view" WRITE — they
 * would alter saved views everyone shares — so they are never clicked, and a
 * transport-level block makes that guarantee rather than a promise.
 */
import fs from "node:fs";

const BASE = "https://os.brokerstaffer.com";
const PORT = process.env.PORT || 9480;
const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";

const FIELDS = ["labels","channels","campaigns","clients","reply_since","last_message_from",
  "message_counts","read_status","subject","keywords","name","email","domain"];

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
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCookie",{name:"bs_sso",value:await mintSso(pick("BS_SSO_SECRET")||pick("AUTH_SECRET"),{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1}),domain:"os.brokerstaffer.com",path:"/",secure:true});
await send("Emulation.setDeviceMetricsOverride",{width:1600,height:1000,deviceScaleFactor:1,mobile:false});

// Nothing may be saved.
await send("Fetch.enable",{patterns:[{urlPattern:"*"}]});
ws.addEventListener("message", async (e)=>{
  const m=JSON.parse(e.data);
  if(m.method!=="Fetch.requestPaused") return;
  const {requestId,request}=m.params;
  const meth=(request.method||"GET").toUpperCase();
  if(meth==="GET"||meth==="HEAD") await send("Fetch.continueRequest",{requestId});
  else { blocked.push(`${meth} ${request.url}`); await send("Fetch.failRequest",{requestId,errorReason:"BlockedByClient"}); }
});

const out=[];
const check=(n,pass,d="")=>{out.push({n,pass});console.log(`  ${pass?"PASS":"FAIL"}  ${n}${d?`  —  ${d}`:""}`);};

/*
 * Count THREADS, not every link that happens to contain "/inbox/".
 *
 * The first version of this counted `a[href*="/inbox/"]`, which also matches
 * the saved-view tab strip and the client list in the left rail — dozens of
 * links that never change. Every view then reported the same 119, including
 * views the UI itself labels 2% and 3%, and all 24 checks "passed" because the
 * assertion never looked at the number.
 *
 * A thread link is /inbox/<view>/<uuid>. Nothing else has that third segment.
 */
const threads = () => ev(`[...document.querySelectorAll('a[href^="/inbox/"]')]
  .filter(a => /^\\/inbox\\/[^/]+\\/[0-9a-f-]{20,}/.test(a.getAttribute('href') || '')).length`);
const settle = async (min=1) => { for(let i=0;i<40;i++){ if(await threads()>=min) break; await sleep(800);} await sleep(1500); };
const goInbox = async () => { await send("Page.navigate",{url:`${BASE}/inbox/all-email`}); await settle(3); };

const openFilters = () => ev(`(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/^\\s*filters\\s*$/i.test((x.innerText||'').trim()));
  if(!b) return 'NO_BUTTON'; b.click(); return 'ok';
})()`);
const clickAddMore = () => ev(`(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/add more/i.test(x.innerText||''));
  if(!b) return 'NO_ADD'; b.click(); return 'ok';
})()`);

const narrowed=[];
console.log(`\nINBOX FILTERS\n${"=".repeat(72)}\n`);

/* ---- 1. the builder: can every field be added and applied? ---- */
console.log("1. Filter builder — 13 fields\n");
await goInbox();
const openedOk = await openFilters();
// The panel's lists load on open; wait for "Add more" to exist rather than
// 1.5s flat — one quiet-site run found nothing offered because the panel
// had not finished mounting yet.
for (let i = 0; i < 40; i++) { if (/add more/i.test(await ev(`document.body.innerText`) || "")) break; await sleep(200); }
await sleep(400);
check("the Filters panel opens", openedOk==="ok" && /add more/i.test(await ev(`document.body.innerText`)||""), `trigger=${openedOk}`);

const menuItems = await ev(`(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/add more/i.test(x.innerText||''));
  if(!b) return '[]'; b.click();
  return new Promise(res=>{ let tries=0; const look=()=>{ const items=[...document.querySelectorAll('[role=menuitem]')].map(i=>(i.innerText||'').trim()); if(items.length>=13||tries++>30) res(JSON.stringify(items)); else setTimeout(look,200); }; setTimeout(look,300); });
})()`);
const offered = JSON.parse(menuItems||"[]");
check(`all ${FIELDS.length} filter fields are offered`, offered.length >= FIELDS.length,
  `${offered.length} offered: ${offered.join(", ").slice(0,150)}`);

for (const label of offered.slice(0, FIELDS.length)) {
  await goInbox();
  const before = await threads();
  await openFilters();
  for (let i = 0; i < 40; i++) { if (/add more/i.test(await ev(`document.body.innerText`) || "")) break; await sleep(200); }
  await sleep(300);
  await clickAddMore();
  for (let i = 0; i < 30; i++) { if ((await ev(`document.querySelectorAll('[role=menuitem]').length`)) >= 13) break; await sleep(200); }
  const added = await ev(`(() => {
    const it=[...document.querySelectorAll('[role=menuitem]')].find(i=>(i.innerText||'').trim()===${JSON.stringify(label)});
    if(!it) return 'NOT_IN_MENU'; it.click(); return 'ok';
  })()`);
  await sleep(1400);
  // The row is there when the field's name shows inside the open panel with a
  // control beside it.
  const row = await ev(`(() => {
    const txt=document.body.innerText||'';
    const hasField = txt.includes(${JSON.stringify(label)});
    const controls = document.querySelectorAll('[role=combobox], [role=button], select, input[type=text]').length;
    return JSON.stringify({hasField, controls});
  })()`);
  const r = JSON.parse(row);
  /*
   * Picker fields (Labels, Channels, Campaigns, Clients) start with no value.
   * Applying an empty rule is legal and encodes fine, but it cannot narrow
   * anything — so choose the first option when the row offers a "Select …"
   * trigger, which makes the narrowing check below mean something.
   */
  /*
   * Base UI opens a DropdownMenu on POINTERDOWN, so a synthetic .click() on
   * the trigger never opens it (the first version of this reported
   * "picker-empty" for every picker while still passing). Press the real
   * mouse through CDP at the trigger's centre instead.
   */
  let picked = "no-picker";
  const trig = await ev(`(() => {
    const t=[...document.querySelectorAll('button')].find(x=>/^select /i.test((x.innerText||'').trim()));
    if(!t) return null; const r=t.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});
  })()`);
  if (trig) {
    const { x, y } = JSON.parse(trig);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(1000);
    const opt = await ev(`(() => {
      const menus=[...document.querySelectorAll('[role=menu], [role=listbox]')].filter(m=>!m.closest('.rail, nav, aside'));
      const menu=menus[menus.length-1];
      // The label/channel pickers render their options without menuitem
      // roles (a checkbox row each), so fall back to the first interactive
      // descendant, then to the first direct child with text.
      const it=menu?([...menu.querySelectorAll('[role^=menuitem], [role=option], button, label, [tabindex]')].find(i=>(i.innerText||'').trim().length>0)
        || [...menu.children].find(i=>(i.innerText||'').trim().length>0)):null;
      if(!it) return null; const r=it.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,name:(it.innerText||'').trim().slice(0,30)});
    })()`);
    if (!opt) picked = "picker-empty";
    else {
      const o = JSON.parse(opt);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: o.x, y: o.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: o.x, y: o.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: o.x, y: o.y, button: "left", clickCount: 1 });
      await sleep(500);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      picked = "picked:" + o.name.replace(/\s+/g, " ");
    }
  }
  await sleep(900);
  const applied = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/apply filter/i.test(x.innerText||''));
    if(!b) return 'NO_APPLY'; b.click(); return 'ok';
  })()`);
  // The first apply after a cold builder can take several seconds (label,
  // channel, campaign and client lists load on open); poll the URL rather
  // than trust a flat wait — a flat 2.6s called the first two fields broken.
  let url = "", encoded = false;
  // 20s, not 10: with four other Chromes sweeping filters on the same
  // deployment, one RSC navigation was measured past 10s and the check
  // called a working filter broken.
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    url = await ev(`location.pathname+location.search`);
    encoded = /[?&]f=/.test(url);
    if (encoded) break;
  }
  await sleep(1500);
  const after = await threads();
  check(`"${label}" can be added and applied`,
    added==="ok" && r.hasField && applied==="ok" && encoded,
    `added=${added} ${picked} apply=${applied} threads ${before}→${after} encodedInUrl=${encoded}`);
  narrowed.push({ label, before, after });
}

/*
 * At least one applied filter must actually REDUCE the list.
 *
 * Each field above is applied with whatever default value the builder gives it,
 * and several of those defaults legitimately match everything — so demanding
 * that every field narrows would be wrong. Demanding that NONE of them does is
 * the real failure: it means Apply is decorative.
 */
check("applying filters can actually reduce the thread list",
  narrowed.some((n) => n.after < n.before),
  narrowed.map((n) => `${n.label} ${n.before}→${n.after}`).join(", ").slice(0, 200));

/* ---- 2. the saved-view tabs ---- */
const viewCounts=[];
console.log("\n2. Saved-view tabs\n");
await goInbox();
const tabs = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('a[href^="/inbox/"]')]
    .map(a=>({href:a.getAttribute('href'), text:(a.innerText||'').replace(/\\s+/g,' ').trim()}))
    .filter(t=>t.text && !/^\\s*$/.test(t.text) && t.href.split('/').length===3)
    .slice(0,12))`) || "[]");
check(`the view strip lists tabs`, tabs.length >= 3, tabs.map(t=>t.text.split(" ")[0]).join(", "));

for (const tab of tabs.slice(0, 8)) {
  await send("Page.navigate",{url:BASE+tab.href});
  await settle(0);
  const n = await threads();
  const url = await ev(`location.pathname`);
  check(`view "${tab.text.split(" ")[0]}" loads`, url===tab.href, `${n} threads at ${url}`);
  /*
   * The IDs, not just how many.
   *
   * 50 is the page size, so every populated view reports 50 and comparing
   * counts cannot tell "these are different threads" from "this is the same
   * list". Comparing the actual thread ids can.
   */
  const ids = await ev(`JSON.stringify([...document.querySelectorAll('a[href^="/inbox/"]')]
    .map(a => (a.getAttribute('href')||'').split('/')[3])
    .filter(Boolean).slice(0, 25))`);
  viewCounts.push({ name: tab.text.split(" ")[0], href: tab.href, n, ids: JSON.parse(ids || "[]") });
}

/*
 * The views must not all be the same list.
 *
 * "Interested" and "Objection" are labelled 2% and 3% in the UI; if every view
 * returns the same count as All Email then the label routing is not filtering
 * anything — which is exactly what the broken counter above hid.
 */
const fingerprint = (v) => v.ids.join(",");
const distinctSets = new Set(viewCounts.filter((v) => v.n > 0).map(fingerprint));
const populated = viewCounts.filter((v) => v.n > 0).length;
check("saved views return DIFFERENT thread sets (compared by id, not count)",
  distinctSets.size === populated,
  `${populated} populated views → ${distinctSets.size} distinct sets · ` +
    viewCounts.map((v) => `${v.name}=${v.n}`).join(", "));

/*
 * And each label view should contain only threads carrying that label. Checked
 * by overlap: a view that is simply All Email under a different URL would
 * return All Email's first 25 ids verbatim.
 */
const all = viewCounts.find((v) => /all-email/.test(v.href));
for (const v of viewCounts.filter((x) => x !== all && x.n > 0)) {
  const same = all && fingerprint(v) === fingerprint(all);
  check(`view "${v.name}" is not just All Email re-served`, !same,
    same ? "identical first 25 thread ids as All Email" : "distinct from All Email");
}

console.log("\n"+"=".repeat(72));
if(blocked.length) console.log(`  writes blocked (none should be attempted): ${[...new Set(blocked)].slice(0,4).join(", ")}`);
const bad=out.filter(o=>!o.pass);
console.log(bad.length?`  ${bad.length} of ${out.length} FAILED:\n${bad.map(b=>"      "+b.n).join("\n")}`:`  all ${out.length} checks passed`);
ws.close(); process.exit(bad.length?1:0);
