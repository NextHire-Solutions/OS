import assert from "node:assert/strict";
import { test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { onboardClient } from "./onboard.ts";

/*
 * The inbound onboarding write, without a database.
 *
 * This is the tool's /api/clients/onboard reproduced in-process, and the
 * OS's own onboarding run now calls it instead of the live tool. Three things
 * it must keep doing are pinned here: refuse a duplicate name with the
 * existing id, link campaigns by the shared name rule, and hand the row to
 * createClientRow rather than inserting on its own.
 */

interface Call {
  table: string;
  verb: "select" | "insert";
  values?: unknown;
  filters: Array<[string, string, unknown]>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeDb(replies: Record<string, unknown[]>): { db: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  const next: Record<string, number> = {};

  const chain = (call: Call): any => {
    const self: any = {
      select: () => self,
      limit: () => self,
      single: () => self,
      eq: (c: string, v: unknown) => (call.filters.push(["eq", c, v]), self),
      ilike: (c: string, v: unknown) => (call.filters.push(["ilike", c, v]), self),
      then: (resolve: any, reject: any) => {
        const key = `${call.table}:${call.verb}`;
        const i = next[key] ?? 0;
        next[key] = i + 1;
        const reply = (replies[key] ?? [])[i] ?? { data: null, error: null };
        return Promise.resolve(reply).then(resolve, reject);
      },
    };
    return self;
  };
  const record = (call: Call) => (calls.push(call), chain(call));

  const db = {
    from: (table: string) => ({
      select: () => record({ table, verb: "select", filters: [] }),
      insert: (values: unknown) => record({ table, verb: "insert", values, filters: [] }),
    }),
  };
  return { db: db as unknown as SupabaseClient, calls };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const CAMPAIGNS = {
  "instantly_campaigns:select": [{ data: [
    { id: "i-1", name: "Acme Realty — Q3" },
    { id: "i-2", name: "Somebody Else" },
  ] }],
  "bison_campaigns:select": [{ data: [{ id: "b-1", name: "acme realty agents" }] }],
};

test("refuses a duplicate name, case-insensitively, with the existing id", async () => {
  const { db, calls } = fakeDb({
    "clients:select": [{ data: [{ id: "existing-1", name: "acme realty" }] }],
  });
  const r = await onboardClient(db, { name: "Acme Realty", plan: "production", weekly_target: 3 });

  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 409);
  assert.equal(r.ok === false && "existing_id" in r && r.existing_id, "existing-1");
  assert.deepEqual(calls[0].filters, [["ilike", "name", "Acme Realty"]]);
  assert.equal(calls.some((c) => c.verb === "insert"), false);
});

test("auto-links campaigns by the shared name rule and inserts through createClientRow", async () => {
  const { db, calls } = fakeDb({
    "clients:select": [{ data: [] }],
    ...CAMPAIGNS,
    "clients:insert": [{ data: { id: "new-1", name: "Acme Realty" } }],
  });
  const r = await onboardClient(db, {
    name: "  Acme Realty ", plan: "production", weekly_target: 3,
    start_date: "2026-09-01",
    // Server-managed fields a caller must not be able to set.
    instantly_campaign_ids: ["evil"], hidden: true, emails_today: 99,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.linked, { instantly: ["i-1"], bison: ["b-1"] });
  assert.equal(r.value.client.id, "new-1");

  const insert = calls.find((c) => c.verb === "insert")!;
  assert.equal(insert.table, "clients");
  const values = insert.values as Record<string, unknown>;
  assert.equal(values.name, "Acme Realty");
  assert.deepEqual(values.instantly_campaign_ids, ["i-1"]);
  assert.deepEqual(values.bison_campaign_ids, ["b-1"]);
  assert.equal(values.billing_interval, "biweekly");
  assert.equal("hidden" in values, false);
  assert.equal("emails_today" in values, false);
});

test("validates like the tool: plan, target, dates, custom interval", async () => {
  const { db } = fakeDb({});
  const base = { name: "X", plan: "production", weekly_target: 3 };
  const status = async (body: unknown) => {
    const r = await onboardClient(db, body);
    return r.ok ? 201 : r.status;
  };
  assert.equal(await status({ ...base, name: " " }), 400);
  assert.equal(await status({ ...base, plan: "enterprise" }), 400);
  assert.equal(await status({ ...base, weekly_target: -1 }), 400);
  assert.equal(await status({ ...base, start_date: "09/01/2026" }), 400);
  assert.equal(await status({ ...base, billing_interval: "weekly" }), 400);
  assert.equal(await status({ ...base, billing_interval: "custom" }), 400);
  assert.equal(await status({ ...base, billing_interval_days: 0 }), 400);
  assert.equal(await status("not an object"), 400);
});
