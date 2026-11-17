/*
 * Portal addresses: the old login-free link (portal.brokerstaffer.com) and the new client portal in the OS. The Demo
 * Portal's card on Client Portals shows, copies and opens the new one (17 Nov).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { newPortalPath, newPortalUrl, publicPortalUrl } from "./public-url.ts";

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";

test("the new portal's address is the OS's /crm-preview for that portal id", () => {
  assert.equal(newPortalUrl(DEMO), `https://os.brokerstaffer.com/crm-preview?client=${DEMO}`);
  assert.equal(newPortalPath(DEMO), `/crm-preview?client=${DEMO}`);
});

test("it is the same address the new portal itself and the portal page use", () => {
  // portal-detail.tsx's "Open new portal" and the sign-in redirect both build /crm-preview?client=<id>.
  assert.equal(newPortalUrl(DEMO).replace("https://os.brokerstaffer.com", ""), newPortalPath(DEMO));
});

test("an odd id can't break out of the address", () => {
  assert.equal(newPortalPath("a&view=billing#x"), "/crm-preview?client=a%26view%3Dbilling%23x");
});

test("the old link is unchanged", () => {
  assert.equal(publicPortalUrl("demo-portal-667f2214f24776ed"), "https://portal.brokerstaffer.com/portal/demo-portal-667f2214f24776ed");
  assert.equal(publicPortalUrl(null), null);
  assert.equal(publicPortalUrl(""), null);
});
