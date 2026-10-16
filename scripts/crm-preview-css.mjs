#!/usr/bin/env node
/*
 * Builds src/app/crm-preview/crm-preview.css from the client's CRM redesign
 * handoff (the "BrokerStaffer CRM" folder the client sent on 15 Oct).
 *
 *   node scripts/crm-preview-css.mjs ~/Downloads/brokerstaffer-crm
 *
 * The handoff's screens each carry one <style> block. They share a base; the
 * list view's is a subset of the board's, the My Agents / DNC / Team /
 * Integrations screens add page rules, and the empty states add theirs. This
 * merges them in that order and makes two changes, nothing else:
 *
 *   1. Every class gets the `crx-` prefix (`.rail` → `.crx-rail`). The OS
 *      loads its own `.app`, `.rail`, `.card`, `.btn`… on every page, some with
 *      !important, so unprefixed rules would mix with them. Prefixed, neither
 *      side can touch the other.
 *   2. The handoff's element rules (`body`, `a`, `button`…) are scoped under
 *      `.crx-root`, and "Inter Tight" points at the font next/font loads.
 *
 * The handoff is read as text only — nothing in it is executed.
 */
import fs from "node:fs";
import path from "node:path";

const handoff = process.argv[2];
if (!handoff) {
  console.error("usage: node scripts/crm-preview-css.mjs <handoff folder>");
  process.exit(1);
}
const out = path.join(process.cwd(), "src/app/crm-preview/crm-preview.css");

function styleOf(screen) {
  const html = fs.readFileSync(path.join(handoff, "screens", `${screen}.html`), "utf8");
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/** Flat rules (the handoff has no @media or other at-rules — checked below). */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@/.test(clean)) throw new Error("the handoff CSS now has an at-rule; teach this script about it");
  const list = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector) list.push({ selector, body });
  }
  return list;
}

const board = rules(styleOf("Pipeline-Board"));
const list = rules(styleOf("Pipeline-List"));

const base = new Map(board.map((r) => [r.selector, r.body]));
for (const r of list) {
  if (base.get(r.selector) !== r.body) throw new Error(`the list view's ${r.selector} differs from the board's`);
}

/*
 * The handoff's 55 screens come in families, each with its own stylesheet; a
 * few names mean different things in different families (checked: 17 of 432
 * selectors). Where a family's rule differs from the board's, that family's
 * name is renamed — in every one of its selectors — so each screen keeps its
 * own look and neither restyles the other:
 *   pages   (My Agents, DNC, Team, Integrations, Help, their dialogs): the bulk
 *           bar, select-all strip, dialog, overlay, two-column grid and drop
 *           zone → .abulk .aselall .adlg .aov .ag2 .adrop
 *   setup   (the Setup wizard): bulk bar, actions, lists, sections, form
 *           labels → .sbulk .sacts .snx .ssec .slb (the last only to keep it
 *           off My Agents' KPI labels, which are also .lb)
 *   market  (Market, Prospects): menus and links → .mmenu .mlnk
 *   reports its chart legend `.lg` (the board's `.lg` is the sidebar logo) → .rlg
 * The pipeline family (board, list, panels, its dialogs, chat) keeps the
 * names. Anything else that differs stops the script.
 */
const renamer = (pairs) => (s) => pairs.reduce((acc, [from, to]) => acc.replace(new RegExp(`\\.${from}(?![\\w-])`, "g"), `.${to}`), s);
const PAGES = renamer([["bulk", "abulk"], ["selall", "aselall"], ["dlg", "adlg"], ["ov", "aov"], ["g2", "ag2"], ["drop", "adrop"]]);
const SETUP = renamer([["bulk", "sbulk"], ["acts", "sacts"], ["nx", "snx"], ["sec", "ssec"], ["lb", "slb"]]);
const MARKET = renamer([["menu", "mmenu"], ["lnk", "mlnk"]]);
const REPORTS = (s) => s.replace(/^\.lg\b/, ".rlg");
const SAME = (s) => s;

const FAMILY = {
  pipeline: ["Pipeline-List", "Pipeline-Board-Collapsed", "Pipeline-Board-Panel", "Stages", "Pipeline-Conversation", "Pipeline-Notes", "Pipeline-Add", "Pipeline-Upload", "Pipeline-Board-Edit", "Pipeline-Board-AddField", "Pipeline-List-Edit", "Pipeline-List-AddField", "Pipeline-Selected", "Pipeline-Selected-Move", "Pipeline-Selected-Assign", "Chat"],
  pages: ["Your-Agents", "Your-Agents-Add", "Your-Agents-Import", "Your-Agents-Selected", "Do-Not-Contact", "DNC-Add-Agent", "DNC-Add-Company", "DNC-Import", "DNC-Selected", "Team", "Team-Add", "Team-Import", "Team-Selected", "Integrations", "Help"],
  other: ["Pipeline-Empty", "MyAgents-Empty", "DNC-Empty", "Prospects-Empty", "Campaign"],
  reports: ["Reports", "Reports-Interested"],
  market: ["Market", "Market-Target", "Market-Row", "Market-Selected", "Market-NoResults"],
  setup: ["Setup-1-Team", "Setup-1-Team-Empty", "Setup-2-Agents", "Setup-2-Agents-Empty", "Setup-3-DNC", "Setup-3-DNC-Empty", "Setup-4-Target", "Setup-4-Target-Empty", "Setup-5-Offer", "Setup-5-Offer-Empty", "Setup-6-Done"],
};
const RENAME = { pipeline: SAME, pages: PAGES, other: SAME, reports: REPORTS, market: MARKET, setup: SETUP };
const SCREENS = Object.entries(FAMILY).flatMap(([family, screens]) => screens.map((screen) => ({ screen, rename: RENAME[family], unused: new Set() })));
// Every screen of the handoff, exactly once.
const listed = new Set(SCREENS.map((x) => x.screen).concat("Pipeline-Board"));
for (const f of fs.readdirSync(path.join(handoff, "screens"))) {
  const name = f.replace(/\.html$/, "");
  if (f.endsWith(".html") && !listed.has(name)) throw new Error(`the handoff has a screen this script does not know: ${name}`);
}

const merged = [...board];
const have = new Map(base);
for (const { screen, rename, unused } of SCREENS) {
  // A screen can declare one selector twice (Reports' `.br`: a colour, then a padding); in
  // order, the two are one rule — later declarations win — so they are joined before comparing.
  const own = new Map();
  for (const r of rules(styleOf(screen))) {
    if (unused.has(r.selector)) continue;
    const selector = rename(r.selector);
    own.set(selector, own.has(selector) ? `${own.get(selector)};${r.body}` : r.body);
  }
  for (const [selector, body] of own) {
    if (have.has(selector)) {
      if (have.get(selector) !== body) throw new Error(`${screen}: ${selector} differs from an earlier screen's and is not handled`);
      continue;
    }
    have.set(selector, body);
    merged.push({ selector, body });
  }
}

function transformSelector(sel) {
  return sel
    .split(",")
    .map((part) => {
      const s = part.trim();
      if (s === "body") return ".crx-root";
      const prefixed = s.replace(/\.([A-Za-z_][\w-]*)/g, ".crx-$1");
      // An element rule from the handoff (`a`, `button.pill`) applies inside the preview only —
      // scoped with :where() so it keeps the handoff's own specificity. (`.crx-root a` would
      // outrank `.ri`, and every link would take its parent's colour instead of its own.)
      if (/^[a-z]/.test(prefixed)) return `:where(.crx-root) ${prefixed}`;
      return prefixed;
    })
    .join(",");
}

function transformBody(body) {
  return body.replace(/"Inter Tight"/g, 'var(--crx-font),"Inter Tight"');
}

const header = `/*
 * GENERATED by scripts/crm-preview-css.mjs from the client's CRM redesign
 * handoff — do not edit by hand; re-run the script on a new handoff instead.
 *
 * The staff-only, read-only preview of the new client portal (/crm-preview).
 * Every class is prefixed crx- so these rules and the OS's own cannot meet.
 */
`;
const root = `.crx-root{min-height:100vh;font-feature-settings:normal}
`;
const css = header + root + merged.map((r) => `${transformSelector(r.selector)}{${transformBody(r.body)}}`).join("\n") + "\n";
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, css);
console.log(`wrote ${path.relative(process.cwd(), out)}: ${merged.length} rules`);
