import { test, mock } from "node:test";
import assert from "node:assert/strict";

// The subject branch of the save route, with the save itself stubbed.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let signedIn = true;
const calls: Array<{ fn: string; args: unknown[] }> = [];
class IntroOverrideError extends Error {}
let failWith: Error | null = null;

let PUT: (r: Request) => Promise<Response>;
const put = (body: unknown) => PUT(new Request("http://x/api/workspace/clients/intro", { method: "PUT", body: JSON.stringify(body) }));

test("setup", { skip }, async () => {
  mock.module("../../../../../lib/bs-auth", {
    namedExports: { readSsoCookie: () => "c", verifySso: async () => (signedIn ? { email: "a@example.com" } : null) },
  });
  mock.module("../../../../../lib/clients/after-change", { namedExports: { clientsChanged: () => {} } });
  mock.module("../../../../../lib/clients/intro-override", {
    namedExports: {
      IntroOverrideError,
      introView: async () => ({}),
      saveIntroOverride: async (...args: unknown[]) => { calls.push({ fn: "override", args }); return { view: { custom: null } }; },
      saveIntroVariants: async (...args: unknown[]) => { calls.push({ fn: "variants", args }); return { variants: [] }; },
      saveIntroSubject: async (...args: unknown[]) => {
        calls.push({ fn: "subject", args });
        if (failWith) throw failWith;
        return { subject: { custom: args[1], standard: "s", canSave: true } };
      },
    },
  });
  ({ PUT } = await import("./route"));
});

test("signed out: refused, nothing saved", { skip }, async () => {
  signedIn = false;
  calls.length = 0;
  assert.equal((await put({ clientId: "c1", subject: "x" })).status, 401);
  assert.equal(calls.length, 0);
  signedIn = true;
});

test("a subject saves as the subject and nothing else", { skip }, async () => {
  calls.length = 0;
  const res = await put({ clientId: "c1", subject: "Meet the team" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ fn: "subject", args: ["c1", "Meet the team"] }]);
  assert.equal(((await res.json()) as { view: { subject: { custom: string } } }).view.subject.custom, "Meet the team");
});

test("null goes back to the standard subject", { skip }, async () => {
  calls.length = 0;
  assert.equal((await put({ clientId: "c1", subject: null })).status, 200);
  assert.deepEqual(calls, [{ fn: "subject", args: ["c1", null] }]);
});

test("a subject that is not text is refused", { skip }, async () => {
  calls.length = 0;
  assert.equal((await put({ clientId: "c1", subject: 42 })).status, 400);
  assert.equal(calls.length, 0);
});

test("no client id: not treated as a subject save", { skip }, async () => {
  calls.length = 0;
  assert.equal((await put({ subject: "x" })).status, 400);
  assert.equal(calls.length, 0);
});

test("a refusal comes back as 400 with its reason", { skip }, async () => {
  failWith = new IntroOverrideError("Editing the subject needs database migration 0048 first.");
  const res = await put({ clientId: "c1", subject: "x" });
  failWith = null;
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /0048/);
});

test("the custom introduction still saves as before", { skip }, async () => {
  calls.length = 0;
  assert.equal((await put({ clientId: "c1", custom: "my words" })).status, 200);
  assert.equal(calls[0].fn, "override");
});
