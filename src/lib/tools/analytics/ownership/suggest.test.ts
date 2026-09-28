import { test } from "node:test";
import assert from "node:assert/strict";

import { disagreements, keyOf, ownersFromDatabase } from "./suggest";

const an = (m: Record<string, string>) => (id: string) => m[id] ?? null;

test("EmailBison campaigns are placed through bison_campaigns.orch_client_id", () => {
  const o = ownersFromDatabase({ byClient: new Map(), bisonOwner: new Map([["197", "db-jpar"]]) }, an({ "db-jpar": "an-jpar" }));
  assert.equal(o.get(keyOf("emailbison", 197)), "an-jpar");
});

test("Instantly campaigns are placed through the client's leads", () => {
  const o = ownersFromDatabase(
    { byClient: new Map([["db-de", [{ id: "c602b2b9", provider: "Instantly" }]]]), bisonOwner: new Map() },
    an({ "db-de": "an-de" }),
  );
  assert.equal(o.get("instantly:c602b2b9"), "an-de");
});

test("a campaign the Database files under two clients is not guessed", () => {
  const o = ownersFromDatabase(
    {
      byClient: new Map([
        ["db-a", [{ id: "x1", provider: "Instantly" }]],
        ["db-b", [{ id: "x1", provider: "Instantly" }]],
      ]),
      bisonOwner: new Map(),
    },
    an({ "db-a": "an-a", "db-b": "an-b" }),
  );
  assert.equal(o.has("instantly:x1"), false);
});

test("two Database rows for the SAME Analytics client still agree", () => {
  const o = ownersFromDatabase(
    { byClient: new Map([["db-a", [{ id: "5", provider: "EmailBison" }]]]), bisonOwner: new Map([["5", "db-a2"]]) },
    an({ "db-a": "an-a", "db-a2": "an-a" }),
  );
  assert.equal(o.get("emailbison:5"), "an-a");
});

test("a Database client with no Analytics link places nothing", () => {
  const o = ownersFromDatabase({ byClient: new Map(), bisonOwner: new Map([["9", "db-x"]]) }, an({}));
  assert.equal(o.size, 0);
});

test("the same id on the two platforms is two campaigns", () => {
  const o = ownersFromDatabase(
    { byClient: new Map([["db-a", [{ id: "7", provider: "Instantly" }]]]), bisonOwner: new Map([["7", "db-b"]]) },
    an({ "db-a": "an-a", "db-b": "an-b" }),
  );
  assert.equal(o.get("instantly:7"), "an-a");
  assert.equal(o.get("emailbison:7"), "an-b");
});

test("disagreements: only automatic matches the Database contradicts", () => {
  const owners = new Map([["emailbison:40", "an-serhant"], ["emailbison:41", "an-a"], ["emailbison:42", "an-a"], ["emailbison:43", "an-a"]]);
  const d = disagreements(
    [
      { campaignId: "40", platform: "emailbison", clientId: "an-serhant-15m", matchMethod: "auto", excluded: false },
      { campaignId: "41", platform: "emailbison", clientId: "an-a", matchMethod: "auto", excluded: false },
      { campaignId: "42", platform: "emailbison", clientId: "an-b", matchMethod: "manual", excluded: false },
      { campaignId: "43", platform: "emailbison", clientId: "an-b", matchMethod: "auto", excluded: true },
      { campaignId: "44", platform: "emailbison", clientId: null, matchMethod: "auto", excluded: false },
    ],
    owners,
  );
  assert.deepEqual(d, [{ campaignId: "40", platform: "emailbison", currentClientId: "an-serhant-15m", databaseClientId: "an-serhant" }]);
});
