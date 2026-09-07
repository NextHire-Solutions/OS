/*
 * Config-builder tests.
 *
 * The generated line is what someone will paste into production, so the
 * failure that matters is not a formatting slip — it is a warning that does
 * not fire. Every check below is about catching a change BEFORE the redeploy,
 * because afterwards the feedback loop is "nobody can log in".
 *
 *   node --test src/lib/identity/grants-config.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGrantsConfig } from "./grants-config.ts";
import type { ToolId } from "../bs-auth.ts";

const ALL: ToolId[] = ["inbox", "clients", "analytics", "search", "onboarding"];
const row = (email: string, grants: ToolId[]) => ({ email, grants });

/** A baseline where everyone already has everything, i.e. BS_GRANTS unset. */
const bootstrap = [row("sam@x.com", ALL), row("nicole@x.com", ALL)];

// --- the output --------------------------------------------------------------

test("renders one line per person, tools in a stable order", () => {
  const c = buildGrantsConfig(
    [row("sam@x.com", ["search", "inbox"]), row("nicole@x.com", ["clients"])],
    [row("sam@x.com", []), row("nicole@x.com", [])],
  );
  assert.equal(c.value, "nicole@x.com:clients\nsam@x.com:inbox,search");
});

test("the same grants in a different order produce identical output", () => {
  const a = buildGrantsConfig([row("s@x.com", ["search", "inbox"])], [row("s@x.com", [])]);
  const b = buildGrantsConfig([row("s@x.com", ["inbox", "search"])], [row("s@x.com", [])]);
  assert.equal(a.value, b.value, "so a no-op edit never looks like a change");
});

test("emails are lower-cased and trimmed", () => {
  const c = buildGrantsConfig([row("  SAM@X.com ", ["inbox"])], [row("sam@x.com", [])]);
  assert.equal(c.value, "sam@x.com:inbox");
});

test("unknown tools are dropped on the way out, not just on the way in", () => {
  const c = buildGrantsConfig(
    [row("s@x.com", ["inbox", "database" as ToolId, "admin" as ToolId])],
    [row("s@x.com", [])],
  );
  assert.equal(c.value, "s@x.com:inbox", "a typo must never widen access at any hop");
});

test("someone with no tools still gets a line, so their row is explicit", () => {
  const c = buildGrantsConfig([row("s@x.com", []), row("n@x.com", ["inbox"])],
    [row("s@x.com", ["inbox"]), row("n@x.com", ["inbox"])]);
  assert.match(c.value, /^n@x\.com:inbox\ns@x\.com:$/);
});

// --- change detection --------------------------------------------------------

test("no change is reported as unchanged", () => {
  const live = [row("s@x.com", ["inbox"])];
  const c = buildGrantsConfig([row("s@x.com", ["inbox"])], live);
  assert.equal(c.unchanged, true);
  assert.equal(c.changed.length, 0);
});

test("a change reports both sides, so the screen can show a diff", () => {
  const c = buildGrantsConfig(
    [row("s@x.com", ["inbox", "clients"])],
    [row("s@x.com", ["inbox"])],
  );
  assert.equal(c.unchanged, false);
  assert.deepEqual(c.changed, [{ email: "s@x.com", from: ["inbox"], to: ["inbox", "clients"] }]);
});

// --- the warnings that matter ------------------------------------------------

test("warns when a tool would have no one at all", () => {
  const c = buildGrantsConfig(
    [row("s@x.com", ["inbox"]), row("n@x.com", ["inbox"])],
    [row("s@x.com", ALL), row("n@x.com", ALL)],
  );
  const orphaned = c.warnings.filter((w) => w.level === "danger" && /Nobody would have access/.test(w.message));
  assert.equal(orphaned.length, 4, "clients, analytics, search and onboarding all lose everyone");
});

test("warns when a listed person is dropped from the paste entirely", () => {
  // The silent one: absence from BS_GRANTS means no access, and a row that
  // simply isn't there looks like nothing happened.
  const c = buildGrantsConfig([row("s@x.com", ALL)], [row("s@x.com", ALL), row("n@x.com", ALL)]);
  assert.ok(
    c.warnings.some((w) => w.level === "danger" && w.message.includes("n@x.com")),
    "the dropped person must be named",
  );
});

test("warns when the editor removes their own access", () => {
  const c = buildGrantsConfig(
    [row("sam@x.com", ["inbox"])],
    [row("sam@x.com", ["inbox", "analytics"])],
    { editorEmail: "SAM@x.com" },
  );
  const own = c.warnings.find((w) => /your own access/.test(w.message));
  assert.ok(own, "must be flagged");
  assert.match(own.message, /analytics/);
  assert.equal(own.level, "caution", "not danger — they can still sign in and undo it");
});

test("warns that setting BS_GRANTS for the first time ends the fail-open", () => {
  // The biggest change of all, and the least visible in a diff: before, absence
  // meant everything; after, absence means nothing.
  const c = buildGrantsConfig([row("sam@x.com", ["inbox"]), row("nicole@x.com", ALL)], bootstrap);
  assert.ok(c.warnings.some((w) => /authoritative/.test(w.message)));
});

test("does NOT warn about the fail-open once grants are already governed", () => {
  const governed = [row("sam@x.com", ["inbox"]), row("nicole@x.com", ["clients"])];
  const c = buildGrantsConfig([row("sam@x.com", ["inbox", "clients"]), row("nicole@x.com", ["clients"])], governed);
  assert.equal(c.warnings.some((w) => /authoritative/.test(w.message)), false,
    "repeating it every edit would train people to ignore warnings");
});

test("warns when the result would grant nobody anything", () => {
  const c = buildGrantsConfig([row("s@x.com", []), row("n@x.com", [])], bootstrap);
  assert.ok(c.warnings.some((w) => w.message === "No one would have access to any tool."));
});

test("a clean, fully-covered change produces no danger warnings", () => {
  const live = [row("sam@x.com", ALL), row("nicole@x.com", ALL)];
  const c = buildGrantsConfig(
    [row("sam@x.com", ALL), row("nicole@x.com", ["inbox", "clients"])],
    live,
    { editorEmail: "sam@x.com" },
  );
  assert.equal(c.warnings.filter((w) => w.level === "danger").length, 0);
  assert.equal(c.unchanged, false);
});
