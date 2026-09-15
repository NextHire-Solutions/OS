/*
 * Open every menu, dialog, popover and sheet on a screen and photograph it.
 *
 * Written because a screen that LOOKS right can still hide a surface that is
 * completely broken: the Filters panel rendered fully transparent — its buttons
 * floating over the thread rows — and nothing about the page at rest showed it.
 * `bg-card` and `bg-popover` were not the wrong colour, they did not exist as
 * Tailwind utilities at all, and eleven files use them.
 *
 * SAFETY. This clicks things on real data, so it refuses any control whose
 * label matches DESTRUCTIVE. It opens, photographs, and presses Escape. It
 * never confirms a dialog, never sends, never deletes.
 */
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
 .map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim().replace(/^["']|["']$/g,"")]));
const {mintSso,ALL_TOOLS}=await import("../src/lib/bs-auth.ts");
const tok=await mintSso(process.env.AUTH_SECRET||env.AUTH_SECRET,{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1});
const CDP=process.env.CDP||"http://localhost:9460";
const OUT=process.env.OUT||"/private/tmp/claude-501/-Users-sankalpdutt-Desktop-Code-Corofy-Centralised-dashboard/974f1bc9-3e1c-42d6-9231-09624b95b027/scratchpad/surfaces";
const BASE="http://localhost:3210";
const URL_=process.argv[2], TAG=process.argv[3]||"s";
fs.mkdirSync(OUT,{recursive:true});

const t=await (await fetch(`${CDP}/json/new?about:blank`,{method:"PUT"})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map(); const errs=[];
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);return;}
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push(m.params.args.map(a=>a.value??a.description??"").join(" ").slice(0,120));};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shot=async n=>{const s=await send("Page.captureScreenshot",{format:"png"});
  fs.writeFileSync(`${OUT}/${n}.png`,Buffer.from(s.data,"base64")); return `${OUT}/${n}.png`;};

await send("Network.enable");await send("Page.enable");await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride",{width:1512,height:950,deviceScaleFactor:1,mobile:false});
await send("Network.setCookie",{name:"bs_sso",value:tok,domain:"localhost",path:"/"});
await send("Page.navigate",{url:BASE+URL_});
for(let i=0;i<120;i++){const n=await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`); if(n>500)break; await sleep(250);}
await sleep(2500);

/*
 * Triggers, found precisely rather than by clicking every button.
 *
 * The first version clicked all 106 visible controls, which included the
 * navigation rail — so the third click navigated away and every click after it
 * landed on a dead node. These primitives mark themselves: `data-slot` ending
 * in "trigger", or `aria-haspopup`. That is the actual set of things that open
 * something, and it excludes links entirely.
 */
/*
 * Menus mark themselves with data-slot/aria-haspopup, but DIALOGS are usually
 * opened by an ordinary button — "Create label", "Edit", "Columns". Selecting
 * only the self-marking ones found a single trigger on a Settings screen that
 * has a create dialog and an edit dialog per row.
 */
/*
 * Visibility, correctly.
 *
 * Every earlier version of this used \`offsetParent !== null\`, which is WRONG
 * for exactly the elements this script exists to find: offsetParent is null for
 * anything \`position: fixed\`, and dialogs and popovers are fixed. So the sweep
 * could only ever see the one non-fixed listbox on the page, reported the same
 * 596x367 for every surface on every screen, and then said "nothing opened" for
 * dialogs I had screenshots of. Three rounds of false findings came from this
 * single wrong predicate.
 */
const VISIBLE = "(e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && c.opacity !== '0'; })";

const TRIGGER_SEL = [
  '[data-slot$="trigger"]',
  '[aria-haspopup]',
  'button',
].join(',');
const OPENER = /create|new |add |edit|columns|options|invite|change|manage|filter|choose|select|move|label|snooze|assign|\+/i;
const OPEN_SEL = '[data-slot$="-content"],[role=dialog],[role=menu],[role=listbox]';

const scan = async () => JSON.parse(await ev(`(() => {
  const DESTRUCTIVE = /delete|remove|archive|spam|trash|send|launch|pause|resume|sync|scan|import|export|start|run |confirm|revoke/i;
  const OPENER = ${OPENER};
  const els = [...document.querySelectorAll(${JSON.stringify(TRIGGER_SEL)})]
    .filter(e => ${VISIBLE}(e) && !e.closest('.rail'))
    .filter(e => e.hasAttribute('aria-haspopup')
      || (e.getAttribute('data-slot') || '').endsWith('trigger')
      || OPENER.test((e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '')));
  window.__trig = els;
  return JSON.stringify(els.map((el, i) => {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40);
    return { i, label: label || '(icon)', destructive: DESTRUCTIVE.test(label) };
  }));
})()`) || "[]");

const list = await scan();
console.log(`\n${URL_}  — ${list.length} menu/dialog triggers`);

const FAULTS = [];
let n = 0;
for (let k = 0; k < list.length; k++) {
  const fresh = await scan();
  const tr = fresh[k];
  if (!tr) break;
  if (tr.destructive) { console.log(`  skip  ${tr.label}  (destructive)`); continue; }

  /*
   * Mark what is already present, so the surface that OPENS can be identified
   * by difference rather than by guessing.
   *
   * Taking the last match instead picked up a page-level container whose
   * buttons include the navigation rail's "Pipeline" — far below the fold — so
   * every surface on every screen was reported unreachable, including dialogs
   * I had looked at and confirmed were fine. A check that fails everything is
   * as useless as one that passes everything.
   */
  // Mark only what is VISIBLE now. Portalled dialogs already exist in the DOM
  // while closed, so marking those too made every one of them read as
  // "pre-existing" and the sweep reported that nothing ever opened.
  await ev(`document.querySelectorAll(${JSON.stringify(OPEN_SEL)}).forEach(e => { if (${VISIBLE}(e)) e.setAttribute('data-sweep-pre',''); })`);
  /*
   * Scroll the trigger into view first, the way a person reaches it.
   *
   * Clicking a button that is below the fold opens its menu below the fold,
   * and the sweep then reports the menu as off-screen — a fault of the test,
   * not the product. A real user scrolls to the control before pressing it.
   */
  await ev(`(() => { const t = window.__trig[${tr.i}]; if (!t) return;
    t.scrollIntoView({ block: 'center', inline: 'nearest' }); })()`);
  await sleep(350);
  await ev(`window.__trig[${tr.i}]?.click()`);
  await sleep(850);

  const state = await ev(`(() => {
    const fresh = [...document.querySelectorAll(${JSON.stringify(OPEN_SEL)})]
      .filter(e => ${VISIBLE}(e) && !e.hasAttribute('data-sweep-pre'));
    // The innermost newly-appeared surface: a portal wrapper may match too.
    const p = fresh.filter(e => !fresh.some(o => o !== e && e.contains(o))).pop() || fresh.pop();
    if (!p) return JSON.stringify({ open: false });
    /*
     * Assertions, not eyeballing.
     *
     * 315 surfaces were photographed and roughly ten were actually looked at.
     * The two worst bugs of the day would BOTH have survived a glance at the
     * rest: the Filters panel painted nothing, and the Client Health modal
     * rendered perfectly but 292px below the fold with its Save button
     * unreachable. Neither logged a console error. So the things that made them
     * broken are checked here by rule, for every surface:
     *
     *   PAINT   — something between the panel and <body> must paint, or it is
     *             see-through like the Filters panel was.
     *   ONSCREEN— the panel must lie inside the viewport, or its controls are
     *             unreachable like the client modal's were.
     *   REACH   — its own buttons must be inside the viewport too, which is the
     *             failure the client modal actually had.
     */
    const r = p.getBoundingClientRect();
    /*
     * Walk UP for the painted surface rather than testing the matched node.
     *
     * The first version flagged the command palette as transparent: it matched
     * .cmdk-list, the inner scroll list, which is CORRECTLY see-through
     * inside its painted .cmdk panel. A detector that cannot tell that apart
     * from the genuinely-unpainted Filters panel is worse than no detector,
     * because every real finding then has to be re-checked by hand.
     *
     * Genuinely broken means: nothing between this node and <body> paints.
     */
    const TRANSPARENT = /rgba\(0, 0, 0, 0\)|^transparent$/;
    let painter = p, bg = '', depth = 0;
    while (painter && painter !== document.body && depth < 8) {
      const c = getComputedStyle(painter).backgroundColor;
      if (!TRANSPARENT.test(c)) { bg = c; break; }
      painter = painter.parentElement; depth++;
    }
    const vw = innerWidth, vh = innerHeight;
    const offscreen = [];
    if (r.left < -2) offscreen.push('left');
    if (r.top < -2) offscreen.push('top');
    if (r.right > vw + 2) offscreen.push('right');
    if (r.bottom > vh + 2) offscreen.push('bottom');
    // Its own actions must be reachable, not merely present.
    const actions = [...p.querySelectorAll('button,[role=button],a[href]')].filter(b => ${VISIBLE}(b));
    /*
     * Out of view is only a fault when you cannot SCROLL to it.
     *
     * The command palette lists every screen in the workspace and scrolls its
     * own result list; flagging the rows below its fold reported the palette as
     * broken when it is working exactly as designed. So an action inside a
     * scrollable ancestor is reachable by definition — what matters is an
     * action pushed outside the viewport with no way to bring it back, which is
     * what the Client Health modal's Save button actually was.
     */
    const scrollable = (el) => {
      let a = el;
      while (a && a !== p.parentElement) {
        const c = getComputedStyle(a);
        if (/(auto|scroll)/.test(c.overflowY + c.overflowX) && a.scrollHeight > a.clientHeight + 4) return true;
        a = a.parentElement;
      }
      return false;
    };
    const unreachable = actions.filter(b => {
      const br = b.getBoundingClientRect();
      const out = br.bottom > vh + 2 || br.top < -2 || br.right > vw + 2 || br.left < -2;
      return out && !scrollable(b);
    }).map(b => (b.innerText || b.getAttribute('aria-label') || '?').replace(/\s+/g, ' ').trim().slice(0, 18));
    return JSON.stringify({ open: true, slot: p.getAttribute('data-slot') || p.getAttribute('role'),
      bg: bg || 'NONE', paintedBy: bg ? (painter.getAttribute('data-slot') || painter.className || painter.tagName).toString().slice(0, 24) : null,
      w: Math.round(r.width), h: Math.round(r.height),
      offscreen, unreachable: unreachable.slice(0, 4), actions: actions.length });
  })()`);
  const st = JSON.parse(state || '{"open":false}');

  if (st.open) {
    n++;
    const file = await shot(`${TAG}-${String(n).padStart(2, "0")}-${(tr.label || "icon").replace(/[^a-z0-9]+/gi, "-").slice(0, 24).toLowerCase()}`);
    const faults = [];
    if (st.bg === "NONE") faults.push("TRANSPARENT");
    if (st.w < 40 || st.h < 20) faults.push(`TINY ${st.w}x${st.h}`);
    if (st.offscreen?.length) faults.push(`OFFSCREEN-${st.offscreen.join("/")}`);
    if (st.unreachable?.length) faults.push(`UNREACHABLE[${st.unreachable.join(",")}]`);
    const bad = faults.length > 0;
    if (bad) console.log(`  ✗ ${tr.label.padEnd(26)} ${faults.join(" ")}  ${file.split("/").pop()}`);
    else if (process.env.VERBOSE) console.log(`  ok ${tr.label.padEnd(26)} ${st.slot} ${st.w}x${st.h}`);
    if (bad) FAULTS.push({ screen: URL_, label: tr.label, faults, file });
  } else {
    console.log(`  --       ${tr.label.padEnd(26)} nothing opened`);
  }

  await ev(`document.querySelectorAll('[data-sweep-pre]').forEach(e => e.removeAttribute('data-sweep-pre'))`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  const url = await ev("location.pathname");
  if (url !== URL_) { await send("Page.navigate", { url: BASE + URL_ }); await sleep(2500); }
}
if (FAULTS.length) { fs.appendFileSync(OUT + "/FAULTS.jsonl", FAULTS.map(f => JSON.stringify(f)).join("\n") + "\n"); }
console.log(`  opened ${n} surfaces · ${FAULTS.length} FAULTY · console errors: ${errs.length ? errs.slice(0,2).join(" | ") : "none"}`);
ws.close();
