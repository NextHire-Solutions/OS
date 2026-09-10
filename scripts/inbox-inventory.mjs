/*
 * Every Master Inbox surface, and whether the OS has it — properly.
 *
 * "Nothing should be left" is only checkable against a list. This builds that
 * list from the TOOL (the authority), then answers two questions per surface:
 *
 *   RUNS THE TOOL'S CODE?  is the OS rendering the tool's component, or
 *                          something hand-written that may have quietly
 *                          dropped features (the portals page was read-only
 *                          for exactly this reason)
 *
 *   MOCKUP STYLED?         does it use the design's semantic classes, or the
 *                          tool's Tailwind look
 *
 * Both must be yes. A surface that runs the tool's code but looks like the tool
 * is not done; nor is one that looks right but reimplements the behaviour.
 */
import fs from "node:fs";
import path from "node:path";

const TOOL = "/Users/sankalpdutt/Desktop/Code/Corofy/Master Inbox";

/* tool page → what the OS renders for it */
const SURFACES = [
  ["inbox list",            "app/(app)/inbox/[view]/page.tsx",            "src/components/screens/master-inbox/full-inbox.tsx"],
  ["conversation",          "app/(app)/inbox/[view]/[threadId]/page.tsx", "src/components/screens/master-inbox/thread-detail.tsx"],
  ["reminders",             "app/(app)/reminders/page.tsx",               "src/components/screens/master-inbox/reminders.tsx"],
  ["leads",                 "app/(app)/leads/page.tsx",                   null],
  ["portals list",          "app/(app)/portals/page.tsx",                 "src/components/screens/master-inbox/portals.tsx"],
  ["portal drill-down",     "app/(app)/portals/[clientId]/page.tsx",      "src/components/screens/master-inbox/portal-detail.tsx"],
  ["settings · labels",     "app/(app)/settings/labels/page.tsx",         "src/components/screens/master-inbox/settings-tabs/labels.tsx"],
  ["settings · templates",  "app/(app)/settings/templates/page.tsx",      "src/components/screens/master-inbox/settings-tabs/templates.tsx"],
  ["settings · agents",     "app/(app)/settings/reply-agents/page.tsx",   "src/components/screens/master-inbox/settings-tabs/reply-agents.tsx"],
  ["settings · AI labeling","app/(app)/settings/ai-labeling/page.tsx",    "src/components/screens/master-inbox/settings-tabs/ai-labeling.tsx"],
  ["settings · clients",    "app/(app)/settings/clients/page.tsx",        "src/components/screens/master-inbox/settings-tabs/clients.tsx"],
  ["settings · members",    "app/(app)/settings/members/page.tsx",        "src/components/screens/master-inbox/settings-tabs/members.tsx"],
  ["settings · personal",   "app/(app)/settings/personal/page.tsx",       "src/components/screens/master-inbox/settings-tabs/personal.tsx"],
  ["settings · webhooks",   "app/(app)/settings/webhooks/page.tsx",       "src/components/screens/master-inbox/settings-tabs/webhooks.tsx"],
];

/** Components the tool's page mounts, so we can tell if the OS mounts them too. */
function toolComponents(rel) {
  const p = path.join(TOOL, rel);
  if (!fs.existsSync(p)) return [];
  const s = fs.readFileSync(p, "utf8");
  return [...s.matchAll(/import \{([^}]+)\} from "@\/components\/[^"]+"/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/^type /, "")))
    .filter((x) => /^[A-Z]/.test(x));
}

/** The design's own class vocabulary — presence means mockup-styled. */
const MOCKUP = /className="[^"]*\b(mi-row|mi-tabs|mi-tab|mi-selbar|mi-filter|mi-list|sndr|subj|prev|chips|udot|cbx|tile|card|fp|ib|tnum|lc-)/;

console.log("  surface                    tool components mounted        mockup UI");
console.log("  " + "-".repeat(76));
let missingCode = 0, missingUi = 0;

for (const [name, toolRel, osPath] of SURFACES) {
  const want = toolComponents(toolRel);
  let mounts = [], styled = false, exists = false;
  if (osPath && fs.existsSync(osPath)) {
    exists = true;
    const s = fs.readFileSync(osPath, "utf8");
    mounts = want.filter((c) => new RegExp(`<${c}\\b`).test(s) || new RegExp(`\\b${c}\\b`).test(s));
    styled = MOCKUP.test(s);
  }
  const codeOk = want.length === 0 ? exists : mounts.length >= Math.ceil(want.length * 0.6);
  if (!codeOk) missingCode++;
  if (!styled) missingUi++;
  const frac = want.length ? `${mounts.length}/${want.length}` : (exists ? "n/a" : "—");
  console.log(`  ${name.padEnd(26)} ${codeOk ? "✓" : "✗"} ${frac.padEnd(28)} ${styled ? "✓ mockup" : "✗ tool styling"}`);
  if (!codeOk && want.length) {
    const gone = want.filter((c) => !mounts.includes(c));
    console.log(`      not mounted: ${gone.join(", ")}`);
  }
}
console.log(`\n  ${SURFACES.length - missingCode}/${SURFACES.length} run the tool's components · ${SURFACES.length - missingUi}/${SURFACES.length} use the mockup's UI`);
