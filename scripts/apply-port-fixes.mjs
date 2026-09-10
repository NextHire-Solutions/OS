/*
 * Re-applies every deliberate modification the port needs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The Master Inbox here is the tool's code, copied. The live tool keeps
 * changing, so files get re-copied — and every re-copy reverts the handful of
 * changes the OS genuinely requires. Doing that by hand means remembering all
 * of them, every time, and the first re-copy already broke the build by
 * reverting one.
 *
 * Run this after any re-copy. It is idempotent: each fix checks whether it is
 * already applied.
 *
 *   node scripts/sync-from-tool.mjs      # copy what changed upstream
 *   node scripts/apply-port-fixes.mjs    # re-apply these
 *   npm run build && ./scripts/verify.sh
 *
 * Every fix below is forced by a real difference between the two environments,
 * and each says which.
 */
import fs from "node:fs";
import path from "node:path";

let changed = 0;
const note = (m) => { console.log(`  ${m}`); changed++; };

/* ---------------------------------------------------------------------------
 * FIX 1 — client components must not import `portal-data`.
 *
 * `portal-data` reaches the database through `@/lib/supabase/admin`, which is
 * `server-only` because it carries the service-role key. Nine client components
 * need only the stage vocabulary from it, which lives in `stages-shared`.
 * Importing the wrong one fails the build with "'server-only' cannot be
 * imported from a Client Component module".
 */
{
  const dir = "src/components/master-inbox/portals-ui";
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".tsx")) continue;
    const p = path.join(dir, f);
    const s = fs.readFileSync(p, "utf8");
    if (!s.trimStart().startsWith('"use client"')) continue;
    const out = s.replace(
      /from "@\/lib\/tools\/master-inbox\/portals\/portal-data"/g,
      'from "@/lib/tools/master-inbox/portals/stages-shared"',
    );
    if (out !== s) { fs.writeFileSync(p, out); note(`client component → stages-shared: ${f}`); }
  }
  // stage-config is imported BY those client components, so it inherits the rule.
  const sc = "src/lib/tools/master-inbox/portals/stage-config.ts";
  if (fs.existsSync(sc)) {
    const s = fs.readFileSync(sc, "utf8");
    const out = s
      .replace(/from "\.\/portal-data"/g, 'from "./stages-shared"')
      .replace(/from "@\/lib\/tools\/master-inbox\/portals\/portal-data"/g, 'from "@/lib/tools/master-inbox/portals/stages-shared"');
    if (out !== s) { fs.writeFileSync(sc, out); note("stage-config → stages-shared (client components import it)"); }
  }
}

/* ---------------------------------------------------------------------------
 * FIX 2 — `auth.getUser()` cannot succeed here.
 *
 * 23 copied routes gate on it. Against a service-role client it always returns
 * null, so each returned 401 to everybody. The adapter in
 * src/lib/supabase/server.ts answers it from the OS session — but only for
 * clients obtained via `createServerSupabase()`. A route that calls
 * `createAdminSupabase().auth.getUser()` still gets null, so flag those.
 */
{
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        const s = fs.readFileSync(p, "utf8");
        if (/createAdminSupabase\(\)[\s\S]{0,80}auth\.getUser\(\)/.test(s)) offenders.push(p);
      }
    }
  };
  walk("src/app/api/tools/master-inbox");
  for (const o of offenders) console.log(`  ⚠ ${o} calls auth.getUser() on the ADMIN client — it will always be null`);
}

/* ---------------------------------------------------------------------------
 * FIX 3 — dates must carry an explicit locale AND time zone.
 *
 * `toLocaleString()` with no arguments resolves to whatever the runtime is.
 * That is two bugs at once:
 *
 *   HYDRATION. Server-rendered on Node in en-US gives "Tue, Sep 8, 8:20 PM";
 *   re-rendered in an en-GB browser it gives "Tue 8 Sept, 20:20". React calls
 *   that a text mismatch and throws away the tree — error #418, on every thread
 *   anyone opened.
 *
 *   CORRECTNESS. BrokerStaffer runs on Eastern. Unpinned, a message sent at 4pm
 *   New York reads as 9pm in London, in a shared inbox where colleagues quote
 *   times to each other.
 *
 * Applied mechanically so a re-copy cannot quietly reintroduce it.
 */
{
  const ET = '"en-US", { timeZone: "America/New_York" }';
  const targets = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) targets.push(p);
    }
  };
  walk("src/components/master-inbox");

  /*
   * ONLY dates. `Intl.NumberFormat` has no `timeZone` option, so rewriting a
   * number's `.toLocaleString()` is a type error — the first version of this
   * did exactly that to `a.max_tokens.toLocaleString()` and produced 20 "No
   * overload matches this call" errors.
   *
   * So the receiver must be recognisably a Date: either a `new Date(...)`
   * expression, or an identifier whose name says so (sentAt, remindAt,
   * created_at, lastRunDate…).
   */
  const DATEY = String.raw`(new Date\([^()]*\)|[A-Za-z_$][\w$]*(?:At|_at|Date|Time|Stamp))`;
  for (const p of targets) {
    const s = fs.readFileSync(p, "utf8");
    let out = s
      .replace(new RegExp(DATEY + String.raw`\.toLocale(String|DateString|TimeString)\(\)`, "g"),
               `$1.toLocale$2(${ET})`)
      .replace(new RegExp(DATEY + String.raw`\.toLocale(String|DateString|TimeString)\(undefined,\s*\{`, "g"),
               '$1.toLocale$2("en-US", { timeZone: "America/New_York",');
    if (out !== s) { fs.writeFileSync(p, out); note(`dates pinned to en-US/Eastern: ${path.basename(p)}`); }
  }
}

/* ---------------------------------------------------------------------------
 * FIX 4 — introduction side effects go through the durable outbox.
 *
 * The tool fires n8n, Slack and Follow Up Boss with bare `after()`, which loses
 * them on a deploy with no trace. `enqueueIntroduction` records all three, then
 * runs the same three calls. See the note in the labels route.
 *
 * Checked rather than rewritten: the replacement spans a comment block, so a
 * blind regex would mangle it. If a sync reverts this, it is flagged loudly.
 */
{
  const p = "src/app/api/tools/master-inbox/threads/[threadId]/labels/route.ts";
  if (fs.existsSync(p)) {
    const s = fs.readFileSync(p, "utf8");
    if (!s.includes("enqueueIntroduction")) {
      console.log("  ⚠ labels route lost the outbox wiring — re-apply by hand:");
      console.log("     replace the three after(() => notify…/push…) calls with");
      console.log("     after(() => enqueueIntroduction(threadId));");
      console.log("     and import it from @/lib/tools/master-inbox/outbox");
    }
  }
}

console.log(changed ? `\n  ${changed} fix(es) applied` : "\n  nothing to re-apply — already clean");
