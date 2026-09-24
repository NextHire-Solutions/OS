import assert from "node:assert/strict";
import { test } from "node:test";

import { isPeopleResource, portalEndpoint, shapeAdd } from "./portal-people-write";

/*
 * The dangerous case throughout is a row that LOOKS like protection and isn't:
 * a do-not-contact entry with no address or domain is on the list, so somebody
 * believes that person is safe, while nothing was ever sent to Instantly or
 * EmailBison to block them.
 */

/* ---- the endpoint is a closed set, not a path fragment ---- */

test("the endpoint points at the client's own portal", () => {
  assert.equal(
    portalEndpoint("tok123", "dnc"),
    "https://portal.brokerstaffer.com/api/portal/tok123/dnc",
  );
  assert.equal(
    portalEndpoint("tok123", "team", "row-1"),
    "https://portal.brokerstaffer.com/api/portal/tok123/team/row-1",
  );
});

test("only the three resources exist — nothing else can be addressed", () => {
  assert.equal(isPeopleResource("team"), true);
  assert.equal(isPeopleResource("agents"), true);
  assert.equal(isPeopleResource("dnc"), true);
  for (const bad of ["clients", "pipeline", "../clients", "settings", ""]) {
    assert.equal(isPeopleResource(bad), false, bad);
    assert.throws(() => portalEndpoint("t", bad as never), /unknown resource/);
  }
});

test("token and id are URL-encoded, so neither can escape the path", () => {
  const url = portalEndpoint("a/../b", "team", "x y/z");
  assert.ok(!url.includes("/../"), url);
  assert.match(url, /a%2F\.\.%2Fb/);
  assert.match(url, /x%20y%2Fz/);
});

test("a missing token is refused rather than producing a valid-looking URL", () => {
  assert.throws(() => portalEndpoint("", "team"), /token is required/);
  assert.throws(() => portalEndpoint("   ", "dnc"), /token is required/);
});

/* ---- team ---- */

test("a team member needs a real email — the table is a notification roster", () => {
  assert.equal(shapeAdd("team", { name: "Nicole" }).ok, false);
  const bad = shapeAdd("team", { name: "Nicole", email: "nicole" });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /not a valid email/);
  const ok = shapeAdd("team", { name: " Nicole ", email: " nicole@oz.com " });
  assert.deepEqual(ok, { ok: true, body: { name: "Nicole", email: "nicole@oz.com" } });
});

test("optional team fields are sent only when given", () => {
  const r = shapeAdd("team", { name: "N", email: "n@o.com", title: "Broker", phone: "" });
  assert.deepEqual((r as { body: Record<string, unknown> }).body, {
    name: "N", email: "n@o.com", title: "Broker",
  });
});

/* ---- agents ---- */

test("an agent may have no email, but a malformed one is refused", () => {
  assert.equal(shapeAdd("agents", { name: "Jo Agent" }).ok, true);
  assert.equal(shapeAdd("agents", { name: "Jo", email: "nope" }).ok, false);
});

test("an agent's optional fields pass through, blank ones are dropped", () => {
  const r = shapeAdd("agents", { name: "Jo", email: "j@o.com", license: "SL123", phone: "   " });
  assert.deepEqual((r as { body: Record<string, unknown> }).body, {
    name: "Jo", email: "j@o.com", license: "SL123",
  });
});

/* ---- DNC: the one that must never be a no-op ---- */

test("a DNC agent with no email is REFUSED — it would block nobody", () => {
  const r = shapeAdd("dnc", { name: "Someone", kind: "agent" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /nothing is actually blocked/);
});

test("a DNC company with no domain is REFUSED for the same reason", () => {
  const r = shapeAdd("dnc", { name: "Rival Brokerage", kind: "company" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /nothing is actually blocked/);
});

test("a DNC agent with an email is shaped for the blocklist call", () => {
  const r = shapeAdd("dnc", { name: "Someone", email: "someone@rival.com" });
  assert.deepEqual((r as { body: Record<string, unknown> }).body, {
    kind: "agent", name: "Someone", email: "someone@rival.com",
  });
});

test("kind defaults to agent, and anything unrecognised is treated as agent", () => {
  const r = shapeAdd("dnc", { name: "X", email: "x@y.com", kind: "nonsense" as never });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.body.kind, "agent");
});

test("a DNC company blocks the DOMAIN, and carries its metadata", () => {
  const r = shapeAdd("dnc", {
    name: "Rival Brokerage", kind: "company", domain: "rival.com",
    brokerage: "Rival", notes: "competitor",
  });
  assert.deepEqual((r as { body: Record<string, unknown> }).body, {
    kind: "company", name: "Rival Brokerage", domain: "rival.com",
    brokerage: "Rival", notes: "competitor",
  });
});

/* ---- shared ---- */

test("a name is required everywhere, and whitespace is not a name", () => {
  for (const resource of ["team", "agents", "dnc"] as const) {
    assert.equal(shapeAdd(resource, { name: "   ", email: "a@b.com" }).ok, false, resource);
    assert.equal(shapeAdd(resource, {}).ok, false, resource);
  }
});

test("over-long names are refused before the portal has to", () => {
  assert.match(
    (shapeAdd("team", { name: "N".repeat(121), email: "a@b.com" }) as { error: string }).error,
    /120 characters/,
  );
  assert.match(
    (shapeAdd("agents", { name: "N".repeat(161) }) as { error: string }).error,
    /160 characters/,
  );
});
