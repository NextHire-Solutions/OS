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
 * The page screens' rules that differ from the board's. Only the bulk bar is
 * used by the preview (read-only: no dialogs, drop zones or select-all), and it
 * is a different element there — a plain row, not a card — so it gets its own
 * name rather than overriding the board's.
 */
const PAGE_RENAMES = { ".bulk": ".abulk", ".bulk.on": ".abulk.on", ".bulk .acts": ".abulk .acts" };
const PAGE_UNUSED = new Set([".selall", ".selall b", ".selall button", ".ov", ".dlg", ".dlg .dh", ".dlg .dh h2", ".dlg .df", ".g2", ".drop", ".drop code", ".drop .dt", ".drop .dc"]);
const pageRename = (s) => PAGE_RENAMES[s] ?? s;

/*
 * The other screens, each merged onto the board's rules in turn. Where a screen
 * uses a name the board already uses for something else, its rules get a name
 * of their own, so neither restyles the other:
 *   Reports  `.lg` is its chart legend; the board's `.lg` is the sidebar logo
 *            (`.rail .lg`, kept as is) — the legend becomes `.rlg`.
 *   Market   its menus and links (`.menu`, `.lnk`) differ from the board's time
 *            menu — they become `.mmenu` and `.mlnk`.
 * Anything else that differs stops the script.
 */
const SCREENS = [
  { screen: "Your-Agents", rename: pageRename, unused: PAGE_UNUSED },
  { screen: "Pipeline-Empty", rename: (s) => s, unused: new Set() },
  { screen: "Campaign", rename: (s) => s, unused: new Set() },
  { screen: "Help", rename: pageRename, unused: PAGE_UNUSED },
  { screen: "Reports", rename: (s) => s.replace(/^\.lg\b/, ".rlg"), unused: new Set() },
  { screen: "Market", rename: (s) => s.replace(/\.menu\b/g, ".mmenu").replace(/\.lnk\b/g, ".mlnk"), unused: new Set([".toast", ".toast button"]) },
];

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
      // An element rule from the handoff (`a`, `button.pill`) applies inside the preview only.
      if (/^[a-z]/.test(prefixed)) return `.crx-root ${prefixed}`;
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
