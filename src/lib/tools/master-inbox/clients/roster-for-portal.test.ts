import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A lead in ANY of a client's portals finds the client's roster record, so the
// Introduce button and the agent's handover work for P&E Florida as for Boston.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const TABLES: Record<string, Record<string, unknown>[]> = {
  os_clients: [
    { id: "pe", name: "Properties & Estates", aliases: ["Properties & Estates Florida", "Properties & Estates Boston"], mi_client_id: "bos", contact_name: "Pat" },
    { id: "keyes", name: "The Keyes Company", aliases: [], mi_client_id: "keyes-mi", contact_name: "Kim" },
    { id: "d1", name: "Twin Realty", aliases: ["Shared Name"], mi_client_id: null, contact_name: "A" },
    { id: "d2", name: "Other Realty", aliases: ["Shared Name"], mi_client_id: null, contact_name: "B" },
  ],
  os_campaign_portals: [] as Record<string, unknown>[],
};
const MISSING_COLUMNS: string[] = [];
const FAILS = { names: false, recordId: "" };
function from(table: string) {
  const eqs: [string, unknown][] = [];
  const rows = () => (TABLES[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v));
  let asked = "";
  const b = {
    select: (c?: string) => { asked = c ?? ""; return b; },
    eq: (k: string, v: unknown) => { eqs.push([k, v]); return b; },
    limit: () => b,
    maybeSingle: async () => {
      if (eqs.some(([k, v]) => k === "id" && v === FAILS.recordId)) return { data: null, error: { message: "record read failed" } };
      const gone = MISSING_COLUMNS.find((c) => asked.includes(c));
      return gone ? { data: null, error: { message: `column os_clients.${gone} does not exist` } } : { data: rows()[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve(FAILS.names ? { data: null, error: { message: "names read failed" } } : { data: rows(), error: null }).then(res),
  };
  return b;
}

let find: typeof import("./roster-for-portal").rosterRowForPortal;
test("setup", { skip }, async () => {
  mock.module("../../../supabase/admin", { namedExports: { createAdminSupabase: () => ({ from }) } });
  find = (await import("./roster-for-portal")).rosterRowForPortal;
});

test("the linked portal finds its record", { skip }, async () => {
  assert.equal((await find("bos", "Properties & Estates Boston", "id")).row?.id, "pe");
});

test("a second portal is found by its name among the client's aliases", { skip }, async () => {
  assert.equal((await find("fla", "Properties & Estates Florida", "id")).row?.id, "pe");
});

test("a second portal is found through a campaign → portal choice", { skip }, async () => {
  TABLES.os_campaign_portals = [{ mi_client_id: "fla2", os_client_id: "pe" }];
  assert.equal((await find("fla2", "Some Other Name", "id")).row?.id, "pe");
  TABLES.os_campaign_portals = [];
});

test("a name shared by two records finds nobody rather than guessing", { skip }, async () => {
  assert.equal((await find("x", "Shared Name", "id")).row, null);
  assert.equal((await find("x", "No Such Client", "id")).row, null);
});

test("the subject column not existing yet does not stop the Introduce button or the agent", { skip }, async () => {
  MISSING_COLUMNS.push("intro_subject");
  try {
    const found = await find("keyes-mi", "The Keyes Company", "name, contact_name, intro_subject");
    assert.equal(found.error, undefined);
    assert.equal(found.row?.id, "keyes");
  } finally {
    MISSING_COLUMNS.length = 0;
  }
});

test("a read that failed says so, for a caller that mustn't take it for nobody; the row and the error are as they were", { skip }, async () => {
  const before = TABLES.os_campaign_portals;
  const clean = await find("no-such-portal", "Nobody Here", "contact_name");
  assert.deepEqual(clean, { row: null }, "nothing found, nothing failed");
  Object.defineProperty(TABLES, "os_campaign_portals", { get() { throw new Error("no such table"); }, configurable: true });
  try {
    const failed = await find("no-such-portal", "Nobody Here", "contact_name");
    assert.deepEqual(failed, { row: null, readFailed: true });
    const stillFound = await find("no-such-portal", "The Keyes Company", "contact_name");
    assert.equal(stillFound.row?.name, "The Keyes Company", "the name is still tried, as before");
  } finally {
    Object.defineProperty(TABLES, "os_campaign_portals", { value: before, writable: true, configurable: true, enumerable: true });
  }

  // The route read answering with an error rather than throwing.
  MISSING_COLUMNS.push("os_client_id");
  try {
    assert.deepEqual(await find("no-such-portal", "Nobody Here", "contact_name"), { row: null, readFailed: true });
  } finally {
    MISSING_COLUMNS.length = 0;
  }
  // The route's record, then the names.
  TABLES.os_campaign_portals = [{ mi_client_id: "routed", os_client_id: "keyes" }];
  FAILS.recordId = "keyes";
  try {
    assert.deepEqual(await find("routed", "Nobody Here", "contact_name"), { row: null, readFailed: true });
  } finally {
    FAILS.recordId = "";
    TABLES.os_campaign_portals = before;
  }
  FAILS.names = true;
  try {
    assert.deepEqual(await find("no-such-portal", "Nobody Here", "contact_name"), { row: null, readFailed: true });
  } finally {
    FAILS.names = false;
  }
});

