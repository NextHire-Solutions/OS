/*
 * The delete rule, EXHAUSTIVELY: every scope x every portal state x every lead
 * state, against the code that runs (delete-rule.ts), not a copy of it.
 *
 * The test this replaces (delete-gate.test.ts) re-implemented the rule inside
 * the test file and asserted a portal with agents was destructive at any
 * scope. That was the bug: it made "remove from the OS list only" — which
 * destroys nothing — refuse every real client. The copy passed; the product
 * was wrong. Nothing here restates the rule; it states outcomes.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  dropsPortal,
  dropsToolRows,
  isDestructive,
  needsAcknowledgement,
  portalHasContent,
  type DeleteScope,
  type PortalContents,
} from "./delete-rule.ts";

const EMPTY: PortalContents = { pipelineEntries: 0, agents: 0, dncEntries: 0, teamMembers: 0, threads: 0 };
const PORTALS: Array<[string, PortalContents | null, boolean]> = [
  ["no Master Inbox row", null, false],
  ["an empty portal", EMPTY, false],
  ["a portal with only threads", { ...EMPTY, threads: 412 }, false],   // threads are SET NULL, not lost
  ["a portal with agents", { ...EMPTY, agents: 30 }, true],
  ["a portal with pipeline entries", { ...EMPTY, pipelineEntries: 5 }, true],
  ["a portal with a DNC list", { ...EMPTY, dncEntries: 2 }, true],
  ["a portal with a team", { ...EMPTY, teamMembers: 1 }, true],
];
const LEADS: Array<[string, number]> = [["no leads", 0], ["7,036 leads", 7036]];

/** What each scope removes — stated as the product's promise, per scope. */
const EXPECTED = (scope: DeleteScope, portalHas: boolean, leads: number): boolean =>
  scope === "os" ? false
  : scope === "tools" ? leads > 0
  : leads > 0 || portalHas;

describe("every scope x portal x leads combination", () => {
  for (const scope of ["os", "tools", "everything"] as const) {
    for (const [pDesc, portal, has] of PORTALS) {
      for (const [lDesc, leads] of LEADS) {
        const want = EXPECTED(scope, has, leads);
        test(`${scope}: ${pDesc}, ${lDesc} -> ${want ? "destructive" : "safe"}`, () => {
          assert.equal(isDestructive(scope, portal, leads), want);
        });
      }
    }
  }
});

describe("the cases that were actually wrong", () => {
  test("'OS list only' on a real client (portal full, leads present) destroys nothing", () => {
    // The regression of 28 Sep morning: refused for every real client.
    assert.equal(isDestructive("os", { ...EMPTY, agents: 30, teamMembers: 2 }, 7036), false);
  });

  test("'tools' with leads IS destructive, even with an empty portal", () => {
    // The original bug: the gate only looked at "everything".
    assert.equal(isDestructive("tools", EMPTY, 7036), true);
  });

  test("'tools' does NOT count the portal's agents — that scope keeps the portal", () => {
    assert.equal(isDestructive("tools", { ...EMPTY, agents: 30 }, 0), false);
  });

  test("'everything' with an empty portal and no leads is a clean delete (the test-client case)", () => {
    assert.equal(isDestructive("everything", EMPTY, 0), false);
  });
});

describe("what each scope removes", () => {
  test("os removes no tool rows and no portal", () => {
    assert.equal(dropsToolRows("os"), false);
    assert.equal(dropsPortal("os"), false);
  });
  test("tools removes tool rows but keeps the portal", () => {
    assert.equal(dropsToolRows("tools"), true);
    assert.equal(dropsPortal("tools"), false);
  });
  test("everything removes both — it is a superset of tools", () => {
    assert.equal(dropsToolRows("everything"), true);
    assert.equal(dropsPortal("everything"), true);
  });
});

describe("portalHasContent", () => {
  test("threads alone are not content — they are kept, untagged", () => {
    assert.equal(portalHasContent({ ...EMPTY, threads: 99 }), false);
  });
  test("no portal at all is not content", () => {
    assert.equal(portalHasContent(null), false);
  });
});

describe("the acknowledgement gate", () => {
  test("a destructive delete is refused without acknowledgement", () => {
    assert.equal(needsAcknowledgement(true, false), true);
  });
  test("an acknowledged destructive delete proceeds", () => {
    assert.equal(needsAcknowledgement(true, true), false);
  });
  test("a safe delete never needs one", () => {
    assert.equal(needsAcknowledgement(false, false), false);
  });
});

import { nameKeyShared, subscriptionShared } from "./delete-rule.ts";

describe("pausing on delete — never another client's campaigns or billing", () => {
  test("a subscription nobody else has is safe to pause", () => {
    assert.equal(subscriptionShared("sub_A", [{ stripeSubscriptionId: "sub_B" }, { stripeSubscriptionId: null }]), false);
  });
  test("a subscription another remaining client has is NOT paused", () => {
    // Deleting a duplicate record must not stop the real client's billing.
    assert.equal(subscriptionShared("sub_A", [{ stripeSubscriptionId: "sub_A" }]), true);
  });
  test("no subscription is never 'shared'", () => {
    assert.equal(subscriptionShared(null, [{ stripeSubscriptionId: null }]), false);
  });
  test("a unique name is safe for campaign pausing", () => {
    assert.equal(nameKeyShared(["keyescompany"], [["c21resultselite"], ["brooklyngroup"]]), false);
  });
  test("a name another client answers to — as name OR alias — blocks campaign pausing", () => {
    assert.equal(nameKeyShared(["keyescompany"], [["thekeyescompany", "keyescompany"]]), true);
    assert.equal(nameKeyShared(["dealias", "douglasellimanla"], [["douglasellimanla"]]), true);
  });
  test("empty keys never match each other", () => {
    assert.equal(nameKeyShared([""], [[""]]), false);
  });
});
