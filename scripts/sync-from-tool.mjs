/*
 * Pull changes from the live Master Inbox into the OS.
 *
 * ---------------------------------------------------------------------------
 * THE SOURCE OF TRUTH
 *
 * `/Users/sankalpdutt/Desktop/Code/Corofy/Master Inbox` — the working copy of
 * github.com/NextHire-Solutions/Masterinbox.
 *
 * NOT `BrokerStaffer-SSO/apps/master-inbox`. That tree is a snapshot; its own
 * baseline commit says so. Porting from it silently missed two commits of
 * portal work — the No Response rework, the two no-show board stages, the
 * kanban view flag and the Interested funnel fix. Nothing about a stale copy
 * announces itself, which is why the path is pinned here and explained.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/sync-from-tool.mjs            # report what differs
 *   node scripts/sync-from-tool.mjs --apply    # copy it across
 *   node scripts/apply-port-fixes.mjs          # re-apply the OS's own changes
 *   npm run build && ./scripts/verify.sh
 *
 * Files the OS has DELIBERATELY modified are never overwritten silently — they
 * are listed as "needs manual merge", because a blind copy would revert a fix
 * the OS cannot run without. Each one says what it carries.
 */
import fs from "node:fs";
import path from "node:path";

const TOOL = "/Users/sankalpdutt/Desktop/Code/Corofy/Master Inbox";
const APPLY = process.argv.includes("--apply");

/** OS directory ← tool directory. */
const MAP = [
  ["src/components/master-inbox/settings", "components/settings"],
  ["src/components/master-inbox/portals-ui", "components/portals"],
  ["src/components/master-inbox", "components/inbox"],
  ["src/components/mi-ui", "components/ui"],
  ["src/lib/tools/master-inbox/inbox", "lib/inbox"],
  ["src/lib/tools/master-inbox/portals", "lib/portals"],
  ["src/lib/tools/master-inbox/ai", "lib/ai"],
  ["src/lib/tools/master-inbox/emailbison", "lib/emailbison"],
  ["src/lib/tools/master-inbox/instantly", "lib/instantly"],
  ["src/lib/tools/master-inbox/integrations", "lib/integrations"],
  ["src/lib/tools/master-inbox/webhooks", "lib/webhooks"],
  ["src/lib/tools/master-inbox/db", "lib/db"],
  ["src/app/api/tools/master-inbox", "app/api"],
];

/*
 * Files the OS changed on purpose. A sync must not clobber these; each note
 * says what would be lost.
 */
const MANUAL = new Map([
  ["src/lib/tools/master-inbox/portals/portal-data.ts",
   "split into stages-shared.ts so client components avoid `server-only`"],
  ["src/lib/tools/master-inbox/portals/stage-config.ts",
   "imports stages-shared, not portal-data (client components import it)"],
  ["src/components/master-inbox/realtime-refresher.tsx",
   "Supabase Realtime replaced by a poll — no Supabase session in the OS"],
  ["src/app/api/tools/master-inbox/clients/route.ts",
   "requireAuthedUser answers from the OS session, not auth.getUser()"],
  ["src/app/api/tools/master-inbox/clients/[id]/route.ts",
   "portal-token guard: an existing client's portal URL cannot change"],
  ["src/components/master-inbox/composer.tsx",
   "TipTap loaded lazily — it was the largest thing in the client bundle"],
  ["src/components/master-inbox/settings/templates-manager.tsx",
   "TipTap loaded lazily"],
  ["src/components/master-inbox/tab-bar.tsx", "stable DndContext id (React #418)"],
]);

/*
 * Things the OS deliberately does NOT have. A sync must not resurrect them.
 *
 * ROUTES: the client portals, provider webhooks and crons stay with the live
 * service — a second copy would double-process webhooks and put a second
 * writer on the portal tables. The admin backfills are destructive one-offs.
 *
 * COMPONENTS: the PUBLIC portal UI (the pages a customer sees) has no place
 * here. Only the staff drill-down's dependency closure was kept. The first
 * sync pulled all of it back and broke the build, which is what this list is
 * for.
 *
 * `workspaces/switch` is meaningless in a single-tenant workspace whose
 * `workspaceId()` throws if a second workspace appears.
 */
const EXCLUDE = [
  /^portal\//, /^webhooks\//, /^cron\//, /^workspaces\/switch\//,
  /^admin\/(backfill|cleanup|dedupe|reclassify|retag|sync-workspaces|inspect|diagnose|last-webhook|thread-counts|instantly)/,
  // public-portal components — not part of the staff drill-down
  /^(agents-list|client-portal|dnc-list|team-list|portal-shell|portal-ui|portals-admin|followup-boss-settings|ideal-agent-profile-form|calendly-banner|clarity-script|portal-refresher|welcome-redirect)\.tsx$/,
  /^tour\//,
];

const norm = (s) => s
  .replace(/@\/components\/portals\//g, "@/components/master-inbox/portals-ui/")
  .replace(/@\/components\/settings\//g, "@/components/master-inbox/settings/")
  .replace(/@\/components\/inbox\//g, "@/components/master-inbox/")
  .replace(/@\/components\/ui\//g, "@/components/mi-ui/")
  .replace(/@\/lib\/(inbox|portals|ai|emailbison|instantly|integrations|webhooks|db|agents|clients)\//g, "@/lib/tools/master-inbox/$1/")
  .replace(/@\/lib\/utils"/g, '@/lib/tools/master-inbox/utils"')
  /*
   * Every API path is namespaced. The components fetch absolute paths, and the
   * OS mounts the tool's routes under /api/tools/master-inbox — so a copied
   * component that still asks for /api/threads/… hits nothing.
   */
  .replace(/(["'`])\/api\/(?!tools\/)/g, "$1/api/tools/master-inbox/");

function walk(dir, base = dir, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(base, p));
  }
  return out;
}

const updated = [], manual = [], added = [];

for (const [osDir, toolDir] of MAP) {
  const from = path.join(TOOL, toolDir);
  for (const rel of walk(from)) {
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    const src = path.join(from, rel);
    const dst = path.join(osDir, rel);
    const incoming = norm(fs.readFileSync(src, "utf8"));
    if (!fs.existsSync(dst)) { added.push(dst); if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, incoming); } continue; }
    const current = fs.readFileSync(dst, "utf8");
    if (current === incoming) continue;
    if (MANUAL.has(dst)) { manual.push(dst); continue; }
    updated.push(dst);
    if (APPLY) fs.writeFileSync(dst, incoming);
  }
}

const show = (title, list, why) => {
  if (!list.length) return;
  console.log(`\n  ${title} (${list.length}):`);
  for (const f of list) console.log(`    ${f}${why ? `\n        ↳ ${MANUAL.get(f)}` : ""}`);
};
show(APPLY ? "UPDATED" : "would update", updated);
show("NEW", added);
show("NEEDS MANUAL MERGE — the OS changed these on purpose", manual, true);

if (!updated.length && !added.length && !manual.length) console.log("\n  in sync with the tool");
else if (!APPLY) console.log("\n  re-run with --apply to copy, then: node scripts/apply-port-fixes.mjs");
else console.log("\n  now run: node scripts/apply-port-fixes.mjs && npm run build");
