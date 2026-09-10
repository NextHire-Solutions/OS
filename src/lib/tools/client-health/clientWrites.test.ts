import assert from "node:assert/strict";
import { test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createClientRow,
  deleteClientRow,
  insertValues,
  updateClientRow,
  updateValues,
  createSchema,
  updateSchema,
} from "./clientWrites.ts";

/*
 * The writes, without a database.
 *
 * These used to be somebody else's problem — the OS proxied them to the live
 * Client Health app. Now the OS performs them, so the two things that can go
 * quietly wrong are ours:
 *
 *   an update with no filter, which rewrites every client in the table;
 *   a payload that touches a column the sync worker owns.
 *
 * Both are asserted here against a recording fake, because the only other way
 * to find out is on real customer rows.
 */

interface Call {
  table: string;
  verb: "select" | "insert" | "update" | "delete";
  values?: unknown;
  filters: Array<[string, string, unknown]>;
}

interface Reply {
  data?: unknown;
  error?: { message?: string; code?: string } | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeDb(replies: Reply[]): { db: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;

  const chain = (call: Call): any => {
    const self: any = {
      select: () => self,
      limit: () => self,
      single: () => self,
      eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), self),
      contains: (column: string, value: unknown) =>
        (call.filters.push(["contains", column, value]), self),
      then: (resolve: any, reject: any) => {
        const reply = replies[next++] ?? {};
        return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null }).then(
          resolve,
          reject,
        );
      },
    };
    return self;
  };

  const record = (call: Call) => (calls.push(call), chain(call));

  const db = {
    from: (table: string) => ({
      select: () => record({ table, verb: "select", filters: [] }),
      insert: (values: unknown) => record({ table, verb: "insert", values, filters: [] }),
      update: (values: unknown) => record({ table, verb: "update", values, filters: [] }),
      delete: () => record({ table, verb: "delete", filters: [] }),
    }),
  };

  return { db: db as unknown as SupabaseClient, calls };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ID = "11111111-2222-3333-4444-555555555555";

const VALID_CREATE = {
  name: "Acme Realty",
  plan: "production",
  weekly_target: 5,
  monthly_target: 20,
  start_date: "2026-01-05",
  instantly_campaign_ids: ["i-1"],
  bison_campaign_ids: ["b-1"],
  billing_anchor_date: "2026-01-05",
  billing_interval: "biweekly",
  billing_interval_days: null,
  time_zone: "America/New_York",
};

/* ------------------------------------------------------------------ create */

test("create carries time_zone — the field the live tool drops", () => {
  const values = insertValues(createSchema.parse(VALID_CREATE));
  assert.equal(values.time_zone, "America/New_York");
});

test("create applies the live tool's own defaults for everything omitted", () => {
  const values = insertValues(
    createSchema.parse({ name: "Bare", plan: "minimum", weekly_target: 2 }),
  );
  assert.deepEqual(values, {
    name: "Bare",
    plan: "minimum",
    weekly_target: 2,
    start_date: null,
    instantly_campaign_ids: [],
    bison_campaign_ids: [],
    campaign_size: 0,
    billing_anchor_date: null,
    billing_interval: "biweekly",
    billing_interval_days: null,
    monthly_target: 0,
    time_zone: null,
  });
});

test("create writes one insert, to clients", async () => {
  const { db, calls } = fakeDb([{ data: { id: ID, name: "Acme Realty" } }]);
  const result = await createClientRow(db, VALID_CREATE);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "clients");
  assert.equal(calls[0].verb, "insert");
});

test("create refuses a plan the database's CHECK constraint would reject", async () => {
  const { db, calls } = fakeDb([]);
  const result = await createClientRow(db, { ...VALID_CREATE, plan: "enterprise" });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(calls.length, 0, "nothing should reach the database");
});

test("create refuses an empty name", async () => {
  const { db } = fakeDb([]);
  const result = await createClientRow(db, { ...VALID_CREATE, name: "   " });
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ update */

test("a pause touches exactly one column", () => {
  assert.deepEqual(updateValues(updateSchema.parse({ id: ID, client_paused: true })), {
    client_paused: true,
  });
});

test("update ignores columns the sync worker owns", () => {
  const values = updateValues(
    updateSchema.parse({
      id: ID,
      name: "Renamed",
      emails_today: 9999,
      portal_url: "https://evil.example",
      total_intros_corofy: 0,
      intros_this_month: 0,
    } as Record<string, unknown>),
  );
  assert.deepEqual(values, { name: "Renamed" });
});

test("update is scoped to one id", async () => {
  const { db, calls } = fakeDb([{ data: { id: ID } }]);
  await updateClientRow(db, { id: ID, hidden: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].verb, "update");
  assert.deepEqual(calls[0].filters, [["eq", "id", ID]]);
});

test("update with nothing to change never reaches the database", async () => {
  const { db, calls } = fakeDb([]);
  const result = await updateClientRow(db, { id: ID });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "No fields to update");
  assert.equal(calls.length, 0);
});

test("an id that is not there reads as 404, not as a bad request", async () => {
  const { db } = fakeDb([{ error: { code: "PGRST116", message: "0 rows" } }]);
  const result = await updateClientRow(db, { id: ID, hidden: true });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 404);
});

/* ------------------------------------------------------------------ delete */

test("delete removes the client by id and evicts unreferenced campaigns", async () => {
  const { db, calls } = fakeDb([
    { data: { instantly_campaign_ids: ["i-1"], bison_campaign_ids: ["b-1"] } }, // read links
    {}, // delete client
    { data: [] }, // i-1: nobody else links it
    {}, // delete i-1
    { data: [] }, // b-1: nobody else links it
    {}, // delete b-1
  ]);

  const result = await deleteClientRow(db, ID);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.value, { orphansRemoved: 2 });

  const writes = calls.filter((c) => c.verb === "delete");
  assert.deepEqual(
    writes.map((c) => [c.table, c.filters]),
    [
      ["clients", [["eq", "id", ID]]],
      ["instantly_campaigns", [["eq", "id", "i-1"]]],
      ["bison_campaigns", [["eq", "id", "b-1"]]],
    ],
  );
});

test("a campaign another client still uses is left alone", async () => {
  const { db, calls } = fakeDb([
    { data: { instantly_campaign_ids: ["shared"], bison_campaign_ids: [] } },
    {},
    { data: [{ id: "some-other-client" }] }, // still referenced
  ]);

  const result = await deleteClientRow(db, ID);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.value, { orphansRemoved: 0 });
  assert.deepEqual(
    calls.filter((c) => c.verb === "delete").map((c) => c.table),
    ["clients"],
  );
});

test("a failed link lookup keeps the campaign rather than guessing", async () => {
  const { db, calls } = fakeDb([
    { data: { instantly_campaign_ids: ["i-1"], bison_campaign_ids: [] } },
    {},
    { error: { message: "lookup exploded" } },
  ]);

  const result = await deleteClientRow(db, ID);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.value, { orphansRemoved: 0 });
  assert.deepEqual(
    calls.filter((c) => c.verb === "delete").map((c) => c.table),
    ["clients"],
  );
});

test("delete refuses an id that is not a uuid, before touching anything", async () => {
  const { db, calls } = fakeDb([]);
  const result = await deleteClientRow(db, "all");

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(calls.length, 0);
});

test("nothing is deleted when the client cannot be read first", async () => {
  const { db, calls } = fakeDb([{ error: { code: "PGRST116", message: "0 rows" } }]);
  const result = await deleteClientRow(db, ID);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 404);
  assert.equal(calls.filter((c) => c.verb === "delete").length, 0);
});
