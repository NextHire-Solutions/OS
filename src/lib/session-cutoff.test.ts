import assert from "node:assert/strict";
import { test } from "node:test";

import { mintSso, verifySsoDetailed } from "./bs-auth.ts";

test("log everyone out: a session minted before SSO_SESSIONS_NOT_BEFORE is refused, a later one works", async () => {
  const secret = "s".repeat(32);
  const old = await mintSso(secret, { email: "a@x.com", grants: ["inbox"], ver: 1, now: Date.parse("2026-10-02T10:00:00Z") });
  const fresh = await mintSso(secret, { email: "a@x.com", grants: ["inbox"], ver: 1, now: Date.parse("2026-10-02T10:20:00Z") });
  const at = Date.parse("2026-10-02T10:21:00Z");
  const prev = process.env.SSO_SESSIONS_NOT_BEFORE;
  try {
    delete process.env.SSO_SESSIONS_NOT_BEFORE;
    assert.equal((await verifySsoDetailed(secret, old, at)).ok, true, "no cut-off: both live");
    process.env.SSO_SESSIONS_NOT_BEFORE = "2026-10-02T10:10:00Z";
    assert.deepEqual(await verifySsoDetailed(secret, old, at), { ok: false, reason: "before-cutoff" });
    assert.equal((await verifySsoDetailed(secret, fresh, at)).ok, true);
    process.env.SSO_SESSIONS_NOT_BEFORE = "not a date";
    assert.equal((await verifySsoDetailed(secret, old, at)).ok, true, "an unreadable value never locks everyone out");
  } finally {
    if (prev === undefined) delete process.env.SSO_SESSIONS_NOT_BEFORE; else process.env.SSO_SESSIONS_NOT_BEFORE = prev;
  }
});
