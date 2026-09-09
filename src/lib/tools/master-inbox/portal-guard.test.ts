/*
 * The portal guard.
 *
 * `portal.brokerstaffer.com` serves 48 live client portals from the database
 * this workspace now writes to. A portal resolves only while its client row
 * exists with a token, `portal_enabled` not false, and a slug that is not
 * 'unknown' — so exactly four writes can take one down.
 *
 * The realistic way that happens is not malice, it is a spread: one
 * `{ ...client, ...patch }` carrying `portal_token: undefined` into an update.
 * These tests exist because that mistake is silent — the write succeeds, and
 * the failure arrives as a client saying their link is dead.
 *
 *   node --test src/lib/tools/master-inbox/portal-guard.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertNoPortalColumns, refuseClientDelete, PortalGuardError } from "./portal-guard.ts";

test("the three portal-bearing columns are refused", () => {
  for (const column of ["portal_token", "portal_enabled", "slug"]) {
    assert.throws(
      () => assertNoPortalColumns({ [column]: "anything" }),
      (e: unknown) => e instanceof PortalGuardError && e.column === column,
      `${column} was allowed through`,
    );
  }
});

test("an UNDEFINED value is refused too — that is the spread accident", () => {
  // `{ ...client, ...patch }` where patch lacks the key yields undefined, and
  // an update carrying undefined blanks the column just as surely as a null.
  // Checking truthiness rather than presence would let exactly this through.
  assert.throws(() => assertNoPortalColumns({ portal_token: undefined }), PortalGuardError);
  assert.throws(() => assertNoPortalColumns({ portal_enabled: null }), PortalGuardError);
  assert.throws(() => assertNoPortalColumns({ slug: "" }), PortalGuardError);
});

test("it catches the column even when buried in a wide patch", () => {
  // The realistic shape: a big client edit that happens to carry one bad key.
  assert.throws(
    () =>
      assertNoPortalColumns({
        name: "Something Realty",
        plan: "production",
        weekly_target: 4,
        portal_enabled: false,
        time_zone: "America/New_York",
      }),
    (e: unknown) => e instanceof PortalGuardError && e.column === "portal_enabled",
  );
});

test("ordinary client fields pass", () => {
  // The guard must not become something people route around.
  assert.doesNotThrow(() =>
    assertNoPortalColumns({ name: "A", plan: "partner", weekly_target: 3, time_zone: null }),
  );
  assert.doesNotThrow(() => assertNoPortalColumns({}));
});

test("deleting a client is refused outright", () => {
  // It cascades — portal, pipeline, agents and team — and there is no undo.
  assert.throws(() => refuseClientDelete(), PortalGuardError);
});

test("the refusal says what to do instead, not just no", () => {
  // An error that only forbids gets worked around; one that redirects does not.
  try {
    assertNoPortalColumns({ portal_token: "x" });
    assert.fail("should have thrown");
  } catch (e) {
    const message = (e as Error).message;
    assert.match(message, /portal/i);
    assert.match(message, /Master Inbox/, "should point at where this belongs");
  }
});
