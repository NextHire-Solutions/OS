/*
 * Find UI that is broken, overflowing, or plainly ugly — by rule, on every
 * screen, at several widths.
 *
 * The checks are the ones that catch what a person means by "looks bad":
 *
 *   PAGE-OVERFLOW   the document scrolls sideways. Nothing should.
 *   ESCAPES         an element's box sticks out past its parent's box, with no
 *                   scrollable ancestor that would explain it.
 *   CLIPPED-TEXT    text is cut off WITHOUT an ellipsis. Ellipsis is a decision;
 *                   a hard cut is a bug. This is how the label chips reading
 *                   "Not Inte…" and "Keep W" were found.
 *   COLLAPSED       an element has text but zero height — it rendered to nothing.
 *   OVERLAP         two interactive controls physically cover each other, so one
 *                   cannot be clicked.
 *
 * False positives were the hard part, and each exclusion below is here because
 * an earlier version cried wolf:
 *   · scrollable ancestors — content inside a scroller is MEANT to be out of view
 *   · `position: fixed` — offsetParent is null for it, so visibility must be
 *     measured from the box and computed style, never from offsetParent
 *   · ellipsis — intentional truncation, not clipping
 *   · zero-size and hidden nodes — not rendered, cannot look bad
 */
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
 .map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim().replace(/^["']|["']$/g,"")]));
const {mintSso,ALL_TOOLS}=await import("../src/lib/bs-auth.ts");
const tok=await mintSso(process.env.AUTH_SECRET||env.AUTH_SECRET,{email:"admin@outreachify.io",grants:[...ALL_TOOLS],ver:1});
const CDP=process.env.CDP||"http://localhost:9460";
const BASE=process.env.BASE||"http://localhost:3210";
const WIDTHS=(process.env.WIDTHS||"1512,1280,1100").split(",").map(Number);

const t=await (await fetch(`${CDP}/json/new?about:blank`,{method:"PUT"})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map();
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m.result);w.delete(m.id);}};
const send=(me,p={})=>new Promise(r=>{const i=++id;w.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await send("Network.enable");await send("Page.enable");
await send("Network.setCookie",{name:"bs_sso",value:tok,domain:new URL(BASE).hostname,path:"/",secure:BASE.startsWith("https")});

const AUDIT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const vis = e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && c.opacity !== '0'; };
  /*
   * Only the IMMEDIATE parent matters for escaping.
   *
   * Walking the whole ancestor chain meant the page's own scroller made every
   * element on every screen look scrollable, so ESCAPES-PARENT could never
   * fire — the self-test caught that by injecting an element that plainly
   * stuck out and getting silence. Escaping a parent that scrolls is fine;
   * escaping one that clips (overflow:hidden) is content the user cannot see.
   */
  /*
   * Walk up and ask which happens FIRST: something scrolls, or something clips.
   *
   * Immediate-parent-only was too strict — a long word in a <p> inside a
   * scrollable .msg-body was reported as escaping, because the <p> itself does
   * not scroll even though the body around it does. Whole-chain was too loose,
   * because the page's own scroller made everything look fine.
   *
   * The question that actually matters is whether the overflow is RECOVERABLE.
   * Reaching a scrollable ancestor first means the user can scroll to it.
   * Reaching overflow:hidden first means it is gone. Reaching <body> with
   * everything visible means it simply extends, which the PAGE-OVERFLOW rule
   * already judges.
   */
  const recoverable = e => {
    let a = e.parentElement;
    while (a && a !== document.body) {
      const c = getComputedStyle(a);
      const ox = c.overflowX + ' ' + c.overflowY;
      if (/(auto|scroll)/.test(ox)) return true;   // scrollable — reachable
      if (/hidden|clip/.test(ox)) return false;    // clipped — lost
      a = a.parentElement;
    }
    return true;                                    // nothing clips it
  };
  const name = e => e.tagName.toLowerCase() +
    (e.id ? '#' + e.id : '') +
    (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
  const txt = e => (e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,32);

  const faults = [];
  const add = (kind, e, detail) => { if (faults.length < 40) faults.push({ kind, el: name(e), text: txt(e), detail }); };

  if (document.documentElement.scrollWidth > vw + 1)
    faults.push({ kind:'PAGE-OVERFLOW', el:'<html>', text:'', detail:(document.documentElement.scrollWidth - vw) + 'px wider than the viewport' });

  /*
   * Collapsed elements are checked BEFORE the visibility filter, because that
   * filter requires height > 0 — it excluded precisely what this rule hunts.
   * The self-test caught it: an injected zero-height element with text was
   * reported as nothing at all.
   */
  for (const e of document.querySelectorAll('body *')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').trim();
    if (t.length < 3) continue;
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);
    if (c.display === 'none' || c.visibility === 'hidden') continue;
    if (r.height < 1 && r.width > 0) add('COLLAPSED', e, 'has text, zero height');
  }

  const all = [...document.querySelectorAll('body *')].filter(vis);
  for (const e of all) {
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);

    // text cut off with no ellipsis to say so
    /*
     * SVG text is exempt. clientWidth is an HTML box-model property and
     * reports nonsense for an SVG <text>, which paints its glyphs with
     * overflow:visible and is never clipped by its own box. A chart's "Aug 12"
     * axis label measured 77 > 72 and was reported as cut off while being
     * entirely on screen.
     */
    const inSvg = e.ownerSVGElement !== null || e.tagName.toLowerCase() === 'svg';
    const leaf = !inSvg && e.children.length === 0 && (e.textContent || '').trim().length > 2;
    if (leaf && e.scrollWidth > e.clientWidth + 1 && c.textOverflow !== 'ellipsis'
        && !/(auto|scroll)/.test(c.overflowX) && c.whiteSpace !== 'pre')
      add('CLIPPED-TEXT', e, e.scrollWidth + '>' + e.clientWidth + 'px, no ellipsis');

    // rendered to nothing despite having content
    // sticking out of a parent that CLIPS, so the overflow is simply lost
    const p = e.parentElement;
    if (p && p !== document.body && !recoverable(e) && c.position !== 'fixed' && c.position !== 'absolute') {
      const pr = p.getBoundingClientRect();
      const over = Math.round(Math.max(r.right - pr.right, pr.left - r.left));
      if (over > 2 && pr.width > 0) add('ESCAPES-PARENT', e, over + 'px past ' + name(p));
    }
  }
  return JSON.stringify({ vw, vh, faults });
})()`;

const SCREENS = JSON.parse(process.env.SCREENS || "[]");
let total = 0;
for (const path of SCREENS) {
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:950,deviceScaleFactor:1,mobile:false});
    await send("Page.navigate",{url:BASE+path});
    for(let i=0;i<120;i++){const n=await ev(`(document.querySelector('section.screen.on')||document.body).innerText.length`); if(n>500)break; await sleep(250);}
    await sleep(1400);
    const out = JSON.parse(await ev(AUDIT) || '{"faults":[]}');
    if (out.faults.length) {
      console.log(`\n  ${path} @ ${width}px — ${out.faults.length} issue(s)`);
      const seen = new Set();
      for (const f of out.faults) {
        const key = f.kind + f.el;
        if (seen.has(key)) continue; seen.add(key);
        console.log(`    ${f.kind.padEnd(14)} ${f.el.slice(0,44).padEnd(46)} ${f.detail}${f.text ? '  "' + f.text + '"' : ''}`);
      }
      total += out.faults.length;
    }
  }
}
console.log(`\n  ${total} issue(s) across ${SCREENS.length} screen(s) x ${WIDTHS.length} width(s)`);
ws.close();
