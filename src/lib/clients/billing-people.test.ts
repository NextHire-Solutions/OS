/*
 * The Billing tab by title (24 Nov, Eddy: "Every Account Manager gets the whole Billing tab, including refunds and
 * cancel"): the named people, and every ACTIVE Account Manager. os_users is a fake; when it can't be read, only the
 * named people pass — it never opens wider by accident.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

for (const m of ["error"] as const) mock.method(console, m, () => {});
let rows: Array<{ email: string; is_account_manager: boolean; is_active: boolean }> = [];
let fail = false;
let reads = 0;
const chain = () => {
  const f: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => { f.push([k, v]); return b; },
    then: (ok: (v: unknown) => unknown) => {
      reads++;
      if (fail) return Promise.resolve({ data: null, error: { message: "down" } }).then(ok);
      const data = rows.filter((r) => f.every(([k, v]) => (r as Record<string, unknown>)[k] === v)).map((r) => ({ email: r.email }));
      return Promise.resolve({ data, error: null }).then(ok);
    },
  };
  return b;
};
mock.module("@/lib/clients/os-db", { namedExports: { osTable: () => chain() } });
const { canUseBillingTab, canCancelSubscription, _resetBillingPeopleCache } = await import("./billing-people.ts");

const team = [
  { email: "gabo075823532@gmail.com", is_account_manager: true, is_active: true },
  { email: "amy@brokerstaffer.com", is_account_manager: true, is_active: true },
  { email: "left@brokerstaffer.com", is_account_manager: true, is_active: false },
  { email: "sales@brokerstaffer.com", is_account_manager: false, is_active: true },
];

test("named people always; every active Account Manager; nobody else", async () => {
  rows = team; fail = false; _resetBillingPeopleCache();
  for (const e of ["admin@outreachify.io", "eddy@brokerstaffer.com", "Gabo075823532@gmail.com ", "amy@brokerstaffer.com"]) {
    assert.equal(await canUseBillingTab(e), true, e);
    assert.equal(await canCancelSubscription(e), true, `${e} can cancel`);
  }
  for (const e of ["left@brokerstaffer.com", "sales@brokerstaffer.com", "client@acme.com", "", null]) {
    assert.equal(await canUseBillingTab(e), false, String(e));
    assert.equal(await canCancelSubscription(e), false, String(e));
  }
});

test("the team list can't be read: only the named people pass", async () => {
  rows = team; fail = true; _resetBillingPeopleCache();
  assert.equal(await canUseBillingTab("eddy@brokerstaffer.com"), true);
  assert.equal(await canUseBillingTab("gabo075823532@gmail.com"), false);
  assert.equal(await canCancelSubscription("amy@brokerstaffer.com"), false);
});

test("read once a minute, not on every request; a title change applies after the minute", async () => {
  rows = team; fail = false; _resetBillingPeopleCache(); reads = 0;
  await Promise.all([canUseBillingTab("gabo075823532@gmail.com"), canUseBillingTab("amy@brokerstaffer.com"), canCancelSubscription("x@y.com")]);
  await canUseBillingTab("sales@brokerstaffer.com");
  assert.equal(reads, 1, "one read for all of them");
});
