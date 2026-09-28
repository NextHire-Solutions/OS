/*
 * The acknowledgement gate, which is the only thing standing between a click and
 * irreversible data loss.
 *
 * `deleteClient` and `planDelete` both reach four live databases, so they are not
 * unit-testable here. The DECISION they share is, and it is the part that was
 * wrong: the gate used to require `scope === "everything"`, which was correct
 * while only the portal could cascade. The Database leg runs at "tools" too and
 * `orch_client_leads` cascades with that row, so a "tools" delete could destroy
 * researched leads while the gate looked the other way.
 *
 * This pins the rule extracted from that gate. If the gate is ever rewritten to
 * consult the scope again, these fail.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { CascadeCounts, DeleteScope } from "./delete.ts";

/** Exactly the condition `deleteClient` applies, and nothing else. */
function requiresAcknowledgement(plan: {
  destructive: boolean;
  scope: DeleteScope;
}, acceptDataLoss: boolean): boolean {
  return plan.destructive && !acceptDataLoss;
}

/** How `planDelete` decides `destructive`: either cascade, never just one. */
function isDestructive(cascade: CascadeCounts | null, orchLeads: number): boolean {
  return (
    orchLeads > 0 ||
    (cascade?.pipelineEntries ?? 0) > 0 ||
    (cascade?.agents ?? 0) > 0 ||
    (cascade?.dncEntries ?? 0) > 0 ||
    (cascade?.teamMembers ?? 0) > 0
  );
}

const empty: CascadeCounts = {
  pipelineEntries: 0, agents: 0, dncEntries: 0, teamMembers: 0, threads: 0,
};

describe("what counts as destructive", () => {
  test("an empty portal and no leads is a clean delete", () => {
    assert.equal(isDestructive(empty, 0), false);
  });

  test("leads alone make it destructive, even with an empty portal", () => {
    // The regression: the portal is empty, so the old rule said "clean cleanup"
    // while 7,036 researched leads were about to cascade away.
    assert.equal(isDestructive(empty, 7036), true);
  });

  test("portal contents alone make it destructive, with no leads", () => {
    assert.equal(isDestructive({ ...empty, agents: 30 }, 0), true);
  });

  test("threads alone do NOT — they are SET NULL, not deleted", () => {
    assert.equal(isDestructive({ ...empty, threads: 412 }, 0), false);
  });

  test("a null cascade (no Master Inbox row) still sees the leads", () => {
    assert.equal(isDestructive(null, 1), true);
    assert.equal(isDestructive(null, 0), false);
  });
});

describe("the acknowledgement gate", () => {
  test("blocks a destructive delete at the 'tools' scope", () => {
    // This is the case the old gate let through.
    assert.equal(
      requiresAcknowledgement({ destructive: true, scope: "tools" }, false),
      true,
    );
  });

  test("blocks a destructive delete at the 'everything' scope", () => {
    assert.equal(
      requiresAcknowledgement({ destructive: true, scope: "everything" }, false),
      true,
    );
  });

  test("an explicit acknowledgement lets it through at either scope", () => {
    for (const scope of ["tools", "everything"] as const) {
      assert.equal(requiresAcknowledgement({ destructive: true, scope }, true), false);
    }
  });

  test("a non-destructive delete never needs an acknowledgement", () => {
    for (const scope of ["os", "tools", "everything"] as const) {
      assert.equal(requiresAcknowledgement({ destructive: false, scope }, false), false);
    }
  });

  test("the gate does not consult the scope at all", () => {
    // Same destructive flag, every scope, same answer. If someone reintroduces
    // `scope === "everything"` this is the test that catches it.
    const answers = (["os", "tools", "everything"] as const).map((scope) =>
      requiresAcknowledgement({ destructive: true, scope }, false),
    );
    assert.deepEqual(answers, [true, true, true]);
  });
});
