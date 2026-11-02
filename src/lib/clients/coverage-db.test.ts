import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { setCoverage } = await import("./coverage-db.ts");
const { BROKERSTAFFER_PORTAL_ID } = await import("../crm-preview/market-model.ts");

test("MLS on save: BrokerStaffer's own record (known by its portal, whatever its name) takes every MLS; any other client at most 40", async () => {
  db.reset();
  db.seed("os_clients", [
    { id: "c-bs", name: "BrokerStaffer (renamed)", mi_client_id: BROKERSTAFFER_PORTAL_ID, market_count: null, mls_codes: ["BRIGHT"], areas: [] },
    { id: "c-keyes", name: "The Keyes Company", mi_client_id: "p-keyes", market_count: null, mls_codes: ["MFRMLS"], areas: [] },
  ]);
  const codes = Array.from({ length: 55 }, (_, i) => `MLS${i}`);
  const saved = await setCoverage("c-bs", { mls: codes });
  assert.equal(saved.mls.length, 55);
  await assert.rejects(setCoverage("c-keyes", { mls: codes.slice(0, 41) }), /MLS can list at most 40\./);
  assert.deepEqual(db.rows("os_clients").find((r) => r.id === "c-keyes")?.mls_codes, ["MFRMLS"], "refused: nothing saved");
  assert.equal((await setCoverage("c-keyes", { mls: codes.slice(0, 40) })).mls.length, 40);
});
