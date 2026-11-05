/*
 * A domain block belongs to the whole sending workspace, not one client. So a public email domain is never blocked,
 * however it arrives: one company row with jo@gmail.com on it would stop every Gmail agent for every client.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const asked: string[] = [];
mock.module("../instantly/client", { namedExports: { createInstantlyClient: () => ({ blockDomain: async (d: string) => { asked.push(`instantly ${d}`); }, blockEmail: async () => {} }) } });
mock.module("../emailbison/client", { namedExports: { createEmailBisonClient: () => ({ blacklistDomain: async (d: string) => { asked.push(`bison ${d}`); }, blacklistEmail: async () => {} }), EmailBisonError: class extends Error {} } });
mock.module("./stop-person", { namedExports: { selectBrokerStafferWorkspace: async () => {} } });
mock.module("./stop-person-plan", { namedExports: { alreadyBlacklisted: () => false } });

const { enforceDomainBlocklist, isPublicEmailDomain, normalizeDomain } = await import("./enforce-blocklist.ts");

test("a public email domain never reaches a provider, however it's written", async () => {
  for (const d of ["gmail.com", "GMAIL.COM", "https://www.gmail.com/", "@gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "comcast.net"]) {
    asked.length = 0;
    const r = await enforceDomainBlocklist(d);
    assert.deepEqual(asked, [], d);
    assert.equal(r.pushedInstantly, false, d);
    assert.equal(r.pushedEmailBison, false, d);
    assert.match(String(r.error), /public email domain/, d);
  }
});

test("a company's own domain is blocked at both providers, as ever", async () => {
  asked.length = 0;
  const r = await enforceDomainBlocklist("https://www.acmerealty.com/about");
  assert.deepEqual(asked, ["instantly acmerealty.com", "bison acmerealty.com"]);
  assert.equal(r.error, null);
});

test("only exact public domains: a brokerage whose name merely has one in it is fine", () => {
  for (const d of ["gmail.com.acme.com", "mygmail.com", "kw.com", "c21connect.com", "compass.com"]) assert.equal(isPublicEmailDomain(d), false, d);
  assert.equal(isPublicEmailDomain(normalizeDomain("www.Gmail.com")!), true);
});
