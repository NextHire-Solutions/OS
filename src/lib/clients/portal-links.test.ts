/*
 * The client record's Portal buttons (24 Nov, client): open the NEW client portal, and the correct one for the client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { clientPortalLinks, linkedRows } from "./portal-links.ts";

const row = (id: string, name: string, extra: Partial<{ slug: string; portal_enabled: boolean | null; portal_token: string | null }> = {}) =>
  ({ id, name, slug: "x", portal_enabled: true, portal_token: `tok-${id}`, ...extra });
const NONE = new Set<string>();

test("a button opens the NEW portal (/crm-preview?client=<portal id>) and never carries the portal token", () => {
  const { url, links } = clientPortalLinks({ id: "c1", name: "Jeff Cook Real Estate", miClientId: "p1" }, [row("p1", "Jeff Cook Real Estate")], NONE);
  assert.equal(url, "/crm-preview?client=p1");
  assert.deepEqual(links.map((l) => l.url), ["/crm-preview?client=p1"]);
  assert.doesNotMatch(JSON.stringify({ url, links }), /tok-|portal\.brokerstaffer\.com/, "no token, no old address");
});

test("several markets: one button each, each opening that market's own portal; the single button is the linked one", () => {
  const rows = [row("pB", "Properties & Estates Boston"), row("pF", "Properties & Estates Florida"), row("other", "Somebody Else")];
  const r = clientPortalLinks({ id: "c1", name: "Properties & Estates", aliases: ["Properties & Estates Boston", "Properties & Estates Florida"], miClientId: "pF" }, rows, NONE);
  assert.deepEqual(r.links.map((l) => [l.name, l.url, l.main]), [
    ["Properties & Estates Florida", "/crm-preview?client=pF", true],
    ["Properties & Estates Boston", "/crm-preview?client=pB", false],
  ]);
  assert.equal(r.url, "/crm-preview?client=pF");
});

test("the correct portal: the linked row even when renamed; never a row another client is linked to, nor 'unknown', nor a row with no portal", () => {
  const rows = [
    row("mine", "Old Name LLC"),                       // linked by id, name no longer matches
    row("theirs", "Acme Realty"),                      // same name, but another client's linked portal
    row("u", "Acme Realty", { slug: "unknown" }),
    row("notoken", "Acme Realty", { portal_token: null }),
    row("second", "Acme Realty"),                      // a second market by name: kept
  ];
  const linked = linkedRows([{ id: "c1", miClientId: "mine" }, { id: "c2", miClientId: "theirs" }]);
  const elsewhere = new Set([...linked].filter(([, owner]) => owner !== "c1").map(([r]) => r));
  const r = clientPortalLinks({ id: "c1", name: "Acme Realty", miClientId: "mine" }, rows, elsewhere);
  assert.deepEqual(r.links.map((l) => l.id).sort(), ["mine", "second"]);
  assert.equal(r.url, "/crm-preview?client=mine");
});

test("a switched-off portal: listed as closed, and the single button goes to an open one (or none)", () => {
  const r = clientPortalLinks({ id: "c1", name: "Acme", miClientId: "a" }, [row("a", "Acme", { portal_enabled: false }), row("b", "Acme")], NONE);
  assert.equal(r.url, "/crm-preview?client=b");
  assert.deepEqual(r.links.map((l) => [l.id, l.enabled]), [["b", true], ["a", false]]);
  const off = clientPortalLinks({ id: "c1", name: "Acme", miClientId: "a" }, [row("a", "Acme", { portal_enabled: false })], NONE);
  assert.equal(off.url, null);
});

test("every Portal link on the record and the Clients list is built from the new address, never the old token link", () => {
  for (const f of ["master-list.ts", "inbox-rows.ts", "campaign-portals.ts", "add-portal.ts"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /publicPortalUrl\(/, `${f}: no old portal address`);
  }
  for (const f of ["../../components/screens/client-record.tsx", "../../components/clients/cells.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /usePortalAccess\(\)/, `${f}: links only for people the new portal lets in`);
  }
});
