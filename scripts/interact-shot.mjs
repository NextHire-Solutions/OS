/*
 * Open a thread, drive its INTERACTIVE surfaces, and photograph each one.
 *
 * Screens at rest were all that had been checked; the composer, the filter
 * panel, the label picker and the bulk-selection bar are where a person
 * actually spends their day, and none of them had ever been looked at.
 *
 * NOTHING IS SENT. The composer is opened and photographed and the draft is
 * discarded; Send is never pressed.
 */
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
 .map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim().replace(/^["']|["']$/g,"")]));
const {mintSso,ALL_TOOLS}=await import("../src/lib/bs-auth.ts");
const tok=await mintSso(process.env.AUTH_SECRET||env.AUTH_SECRET,{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1});
const CDP=process.env.CDP||"http://localhost:9460";
const OUT=process.env.OUT||"/private/tmp/claude-501/-Users-sankalpdutt-Desktop-Code-Corofy-Centralised-dashboard/974f1bc9-3e1c-42d6-9231-09624b95b027/scratchpad/shots";
const BASE="http://localhost:3210";
const THREAD=process.env.THREAD;

const t=await (await fetch(`${CDP}/json/new?about:blank`,{method:"PUT"})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map(); const errs=[];
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);return;}
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push(m.params.args.map(a=>a.value??a.description??"").join(" ").slice(0,140));};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shot=async n=>{const s=await send("Page.captureScreenshot",{format:"png"});
  fs.writeFileSync(`${OUT}/${n}.png`,Buffer.from(s.data,"base64")); console.log(`  ${OUT}/${n}.png`);};

await send("Network.enable");await send("Page.enable");await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride",{width:1512,height:950,deviceScaleFactor:1,mobile:false});
await send("Network.setCookie",{name:"bs_sso",value:tok,domain:"localhost",path:"/"});

/* ---- the thread list: filters + bulk selection ---------------------------- */
await send("Page.navigate",{url:`${BASE}/inbox/all-email`});
for(let i=0;i<80;i++){ if(await ev(`document.querySelectorAll('.mi-row').length>3`))break; await sleep(250);} await sleep(1200);

await ev(`[...document.querySelectorAll('button')].find(b=>/^\\s*Filters/.test(b.innerText))?.click()`);
await sleep(900); await shot("ix-filters");
await ev(`document.activeElement?.blur(); [...document.querySelectorAll('button')].find(b=>/^\\s*Filters/.test(b.innerText))?.click()`);
await sleep(500);

// tick two rows to raise the bulk bar
await ev(`[...document.querySelectorAll('.mi-row .cbx, .mi-row input[type=checkbox]')].slice(0,2).forEach(c=>c.click())`);
await sleep(800); await shot("ix-bulk");
await ev(`[...document.querySelectorAll('.mi-row .cbx, .mi-row input[type=checkbox]')].slice(0,2).forEach(c=>c.click())`);
await sleep(400);

/* ---- the thread: composer ------------------------------------------------- */
await send("Page.navigate",{url:`${BASE}/inbox/all-email/${THREAD}`});
for(let i=0;i<80;i++){ if(await ev(`document.body.innerText.length>800`))break; await sleep(250);} await sleep(2000);
await shot("ix-thread");

const openedWith=await ev(`(()=>{
  const b=[...document.querySelectorAll('button')].find(x=>/^\\s*(Reply|Reply all|Compose)\\b/i.test(x.innerText));
  if(b){b.click();return b.innerText.trim();}
  return null;})()`);
console.log("  reply control:", openedWith ?? "NOT FOUND");
await sleep(2200); await shot("ix-composer");

console.log("  composer present:", await ev(`!!document.querySelector('[class*=composer],[data-slot=composer],.mi-composer')`));
console.log("  console errors  :", errs.length?errs.slice(0,3):"none");
ws.close();
