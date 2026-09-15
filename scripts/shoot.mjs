/*
 * Screenshot a list of OS screens, and the matching mockup sections, at the
 * same viewport — so they can be put side by side and actually looked at.
 *
 *   node scripts/shoot.mjs os   /inbox/all-email:inbox  ...
 *   node scripts/shoot.mjs mock mi-inbox:inbox ...
 */
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
 .map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim().replace(/^["']|["']$/g,"")]));
const {mintSso,ALL_TOOLS}=await import("../src/lib/bs-auth.ts");
const TOK=await mintSso(process.env.AUTH_SECRET||env.AUTH_SECRET,{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1});
const CDP=process.env.CDP||"http://localhost:9460";
const OUT=process.env.OUT||"/private/tmp/claude-501/-Users-sankalpdutt-Desktop-Code-Corofy-Centralised-dashboard/974f1bc9-3e1c-42d6-9231-09624b95b027/scratchpad/shots";
const MOCK="file:///private/tmp/claude-501/-Users-sankalpdutt-Desktop-Code-Corofy-Centralised-dashboard/974f1bc9-3e1c-42d6-9231-09624b95b027/scratchpad/brokerstaffer-workspace.html";
const BASE=process.env.BASE||"http://localhost:3210";
const W=Number(process.env.W||1512), H=Number(process.env.H||950);

const t=await (await fetch(CDP+"/json/new?about:blank",{method:"PUT"})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map();
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);}};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride",{width:W,height:H,deviceScaleFactor:1,mobile:false});
await send("Network.setCookie",{name:"bs_sso",value:TOK,domain:"localhost",path:"/"});

const mode=process.argv[2];
const jobs=process.argv.slice(3).map(a=>{const i=a.lastIndexOf(":");return {target:a.slice(0,i),name:a.slice(i+1)};});

if (mode==="mock") { await send("Page.navigate",{url:MOCK}); await sleep(1200); }

for (const j of jobs) {
  if (mode==="os") {
    await send("Page.navigate",{url:BASE+j.target});
    /*
     * Wait for the screen to have real CONTENT, not merely text.
     *
     * The old rule was "more than 400 characters", which "Loading…" satisfies
     * the moment the shell paints. Analytics Infrastructure fires three
     * client-side fetches that take about a second each, so it was photographed
     * mid-load and looked broken — it is not. A screenshot that lies costs more
     * than one that takes two seconds longer.
     */
    for (let i = 0; i < 120; i++) {
      const state = await ev(`(() => {
        const s = document.querySelector('section.screen.on') || document.body;
        const t = s.innerText || "";
        return JSON.stringify({ n: t.length, loading: /Loading…|Loading\\.\\.\\./.test(t) });
      })()`);
      const { n, loading } = JSON.parse(state || '{"n":0,"loading":true}');
      if (n > 400 && !loading) break;
      await sleep(250);
    }
    await sleep(900);
  } else {
    // the mockup switches panes by clicking its rail; fall back to direct show()
    /*
     * Drive the mockup through its OWN rail button (`data-go="<id>"`), not by
     * toggling `.on` by hand. Hand-toggling landed on the annotation banner at
     * the top of each section instead of the screen, because the prototype's
     * `go()` also opens the right accordion, scrolls the pane to the top and
     * runs the per-screen setup that draws charts.
     */
    const r = await ev(`(()=>{const b=document.querySelector('[data-go=' + ${JSON.stringify(JSON.stringify(j.target))} + ']');
      if(!b) return 'missing'; b.click(); return 'ok';})()`);
    if (r !== "ok") console.log(`    (no rail button for ${j.target})`);
    await sleep(400);
    // Skip the "Removed for the workspace:" annotation so the shot frames the screen.
    await ev(`(()=>{const s=document.querySelector('section.screen.on');
      if(!s) return; const sc=document.getElementById('scroll')||s.parentElement;
      const note=s.querySelector('.anno,.viewport-note,.note');
      if(note && note.getBoundingClientRect().height < 220) note.style.display='none';
      if(sc) sc.scrollTop=0; })()`);
    await sleep(900);
  }
  const shot=await send("Page.captureScreenshot",{format:"png"});
  const file=`${OUT}/${mode}-${j.name}.png`;
  fs.writeFileSync(file, Buffer.from(shot.data,"base64"));
  console.log(`  ${file}`);
}
ws.close();
