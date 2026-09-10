/*
 * How far has the OS drifted from the live Master Inbox?
 *
 * Every component, route and loader here was copied from the tool so that no
 * behaviour would be re-invented. That is only true for as long as the copies
 * stay copies, and "we copied it" decays into "we copied it once" without
 * something that checks.
 *
 * This diffs each file against its original, normalising the two kinds of
 * difference that are expected and harmless:
 *
 *   IMPORT PATHS — the OS namespaces everything under lib/tools/master-inbox
 *   and components/master-inbox. Rewriting those was the whole porting step.
 *
 *   COMMENTS — several files carry an added note explaining a forced
 *   difference. Prose does not change behaviour.
 *
 * What is left is real divergence, and each one should be explainable.
 */
import fs from "node:fs";
import path from "node:path";

/*
 * The SOURCE OF TRUTH is `Corofy/Master Inbox`, not the copy inside
 * BrokerStaffer-SSO.
 *
 * That second tree is a snapshot — its own baseline commit says so ("snapshot
 * of live working trees"). Porting from it silently missed two commits of the
 * user's portal work: the No Response rework, the two no-show board stages, the
 * kanban view flag and the Interested funnel fix.
 *
 * Nothing about the snapshot announces that it is stale, which is exactly why
 * this constant carries the warning rather than a comment somewhere else.
 */
const SB = "/Users/sankalpdutt/Desktop/Code/Corofy/Master Inbox";

/** OS path → the tool path it was copied from. */
const MAP = [
  ["src/components/master-inbox/settings", `${SB}/components/settings`],
  ["src/components/master-inbox/portals-ui", `${SB}/components/portals`],
  ["src/components/master-inbox", `${SB}/components/inbox`],
  ["src/components/mi-ui", `${SB}/components/ui`],
  ["src/lib/tools/master-inbox/inbox", `${SB}/lib/inbox`],
  ["src/lib/tools/master-inbox/portals", `${SB}/lib/portals`],
  ["src/lib/tools/master-inbox/ai", `${SB}/lib/ai`],
  ["src/lib/tools/master-inbox/emailbison", `${SB}/lib/emailbison`],
  ["src/lib/tools/master-inbox/instantly", `${SB}/lib/instantly`],
  ["src/lib/tools/master-inbox/integrations", `${SB}/lib/integrations`],
  ["src/lib/tools/master-inbox/webhooks", `${SB}/lib/webhooks`],
  ["src/lib/tools/master-inbox/db", `${SB}/lib/db`],
  ["src/lib/tools/master-inbox/agents", `${SB}/lib/agents`],
  ["src/app/api/tools/master-inbox", `${SB}/app/api`],
];

function normalise(src) {
  return src
    // the port's import rewrites, undone
    .replace(/@\/components\/master-inbox\/portals-ui\//g, "@/components/portals/")
    .replace(/@\/components\/master-inbox\/settings\//g, "@/components/settings/")
    .replace(/@\/components\/master-inbox\//g, "@/components/inbox/")
    .replace(/@\/components\/mi-ui\//g, "@/components/ui/")
    .replace(/@\/lib\/tools\/master-inbox\//g, "@/lib/")
    .replace(/@\/api\/tools\/master-inbox\//g, "@/api/")
    .replace(/\/api\/tools\/master-inbox\//g, "/api/")
    // comments and whitespace
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*$\n/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function originalFor(osPath) {
  for (const [osRoot, toolRoot] of MAP) {
    if (osPath.startsWith(osRoot + "/")) {
      const rel = osPath.slice(osRoot.length + 1);
      const cand = path.join(toolRoot, rel);
      if (fs.existsSync(cand)) return cand;
      return null;
    }
  }
  return null;
}

const seen = new Set();
let identical = 0;
const diverged = [];
const osOnly = [];

for (const [osRoot] of MAP) {
  for (const p of walk(osRoot)) {
    if (seen.has(p)) continue;
    seen.add(p);
    const orig = originalFor(p);
    if (!orig) { osOnly.push(p); continue; }
    const a = normalise(fs.readFileSync(orig, "utf8"));
    const b = normalise(fs.readFileSync(p, "utf8"));
    if (a === b) identical++;
    else {
      /*
       * A real diff, not a positional one.
       *
       * The first version compared line i to line i and counted mismatches.
       * One inserted line therefore shifted everything after it and reported
       * composer.tsx as "1165 lines differ" when the actual change was a
       * dynamic import. A metric that inflates with position is worse than no
       * metric — it hides the small real divergences among fake large ones.
       *
       * This is a plain LCS: count the lines that genuinely have no partner.
       */
      const al = a.split("\n"), bl = b.split("\n");
      const setB = new Map();
      for (const l of bl) setB.set(l, (setB.get(l) ?? 0) + 1);
      let onlyA = 0;
      for (const l of al) {
        const n = setB.get(l) ?? 0;
        if (n > 0) setB.set(l, n - 1); else onlyA++;
      }
      let onlyB = 0;
      for (const [, n] of setB) onlyB += n;
      diverged.push({ p, lines: onlyA + onlyB, added: onlyB, removed: onlyA });
    }
  }
}

console.log(`  files compared:    ${identical + diverged.length}`);
console.log(`  byte-identical:    ${identical}`);
console.log(`  diverged:          ${diverged.length}`);
console.log(`  OS-only (no original): ${osOnly.length}\n`);

if (diverged.length) {
  console.log("  DIVERGED — every one of these should have a reason:");
  for (const d of diverged.sort((x, y) => y.lines - x.lines))
    console.log(`    ${String(d.lines).padStart(4)} lines (+${d.added} −${d.removed})  ${d.p}`);
}
if (osOnly.length) {
  console.log("\n  OS-ONLY files (written here, no tool original):");
  for (const p of osOnly) console.log(`    ${p}`);
}
