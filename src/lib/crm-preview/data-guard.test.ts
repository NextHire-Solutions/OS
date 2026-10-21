import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { admit, fromOwnClick, fromOwnPage, LIMITS, resetGuard, served } from "./data-guard.ts";

const own = new Headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

test("only the portal's own page may ask: a script, curl, a cross-site page or a typed URL is refused", () => {
  resetGuard();
  assert.equal(fromOwnPage(own), true);
  for (const h of [
    new Headers(), // curl, a script, a scraping tool
    new Headers({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }), // another site's page
    new Headers({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }), // the URL typed or opened
    new Headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }), // a link to the data route
  ]) {
    assert.equal(fromOwnPage(h), false);
    const r = admit("eddy@brokerstaffer.com", "staff", "market", h, T0);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 403);
  }
});

test("requests a minute (staff): the limit refuses, and a minute later it lets through again", () => {
  resetGuard();
  const who = "eddy@brokerstaffer.com";
  for (let i = 0; i < LIMITS.staff.perMinute; i++) assert.equal(admit(who, "staff", "market", own, T0 + i).ok, true, `request ${i + 1}`);
  const over = admit(who, "staff", "market", own, T0 + 100);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.status, 429);
  assert.equal(admit(who, "staff", "market", own, T0 + 61_000).ok, true, "a minute later");
  assert.equal(admit("amy@brokerstaffer.com", "staff", "market", own, T0 + 100).ok, true, "one person's limit is not another's");
});

test("agents served a day (staff): past the day's rows, refused until the next day", () => {
  resetGuard();
  const who = "eddy@brokerstaffer.com";
  served(who, "market", LIMITS.staff.rowsPerDay - 50, T0);
  assert.equal(admit(who, "staff", "market", own, T0 + 1_000).ok, true);
  served(who, "market", 50, T0 + 1_000);
  const over = admit(who, "staff", "market", own, T0 + 2_000);
  assert.equal(over.ok === false && over.reason, "rows-per-day");
  assert.equal(admit(who, "staff", "report", own, T0 + 2_000).ok, true, "reports count apart");
  assert.equal(admit(who, "staff", "market", own, T0 + 24 * 3_600_000 + 5_000).ok, true, "the next day");
});

test("a CLIENT is never refused for how much they read — only alerted on in the OS (21 Oct, the user)", () => {
  resetGuard();
  const who = "client@brokerage.com";
  for (const v of Object.values(LIMITS.client)) assert.equal(v, Infinity);
  for (let i = 0; i < 1_000; i++) assert.equal(admit(who, "client", "market", own, T0 + i).ok, true, `request ${i + 1}`);
  served(who, "market", 1_000_000, T0);
  for (let i = 0; i < 500; i++) served(who, "report", 0, T0);
  for (const kind of ["market", "report", "chat", "billing", "conversation"] as const) assert.equal(admit(who, "client", kind, kind === "billing" ? { get: (n: string) => ({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" } as Record<string, string>)[n] ?? null } : own, T0 + 5_000).ok, true, kind);
  // What still applies: only the portal's own pages may ask.
  assert.equal(admit(who, "client", "market", { get: () => null }, T0).ok, false);
});

test("both data routes admit before they read, count what they serve, and never let a response be cached or indexed", () => {
  for (const f of ["src/app/api/crm-preview/market/route.ts", "src/app/api/crm-preview/report/route.ts"]) {
    const src = readFileSync(f, "utf8");
    const gate = src.indexOf("admit(");
    assert.ok(gate > 0, `${f} admits`);
    assert.ok(gate < src.indexOf("marketContext("), `${f} admits before reading anything`);
    assert.ok(gate > src.indexOf("canSeeCrmPreview("), `${f} still checks who first (a bare 404)`);
    assert.match(src, /served\(/, `${f} counts what it serves`);
    assert.ok((src.match(/NO_STORE_HEADERS/g) ?? []).length >= 4, `${f} sends no-store on every response`);
  }
});

test("a market agent's or a prospect's email never reaches the browser — only agents on the client's own lists, only in the Setup tables", () => {
  const src = readFileSync("src/lib/crm-preview/market.ts", "utf8");
  assert.match(src, /q\.per === SETUP_PAGE_SIZE && OWN_LISTS\.has\(list\) \? \{ email:/);
  assert.match(src, /new Set\(\["My Agents", "DNC List", "In your pipeline"\]\)/);
  assert.equal((src.match(/email: str\(/g) ?? []).length, 1, "no other place sends an email");
});

/* ---------------------------------------------- the chat and Billing (19 Oct) --- */

const click = new Headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1", "sec-fetch-dest": "document" });

test("Billing opens only on a person's own click in the portal — not a prefetch, a script, a typed address or a fetch", () => {
  resetGuard();
  assert.equal(fromOwnClick(click), true);
  for (const h of [
    new Headers(), // curl, a script
    new Headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }), // a prefetch: no user activation
    new Headers({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" }), // typed into the address bar
    new Headers({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" }), // a link on another site
    own, // a fetch from the page
  ]) {
    assert.equal(admit("eddy@brokerstaffer.com", "staff", "billing", h, T0).ok, false);
  }
  assert.equal(admit("eddy@brokerstaffer.com", "staff", "billing", click, T0).ok, true);
  assert.equal(admit("eddy@brokerstaffer.com", "staff", "chat", click, T0).ok, false, "the chat is a fetch, never a navigation");
});

test("chat messages and Billing openings are capped per person per day (staff)", () => {
  resetGuard();
  const who = "eddy@brokerstaffer.com";
  for (let i = 0; i < LIMITS.staff.chatsPerDay; i++) served(who, "chat", 0, T0);
  const chat = admit(who, "staff", "chat", own, T0 + 1);
  assert.equal(chat.ok === false && chat.reason, "chats-per-day");
  for (let i = 0; i < LIMITS.staff.billingPerDay; i++) served(who, "billing", 0, T0);
  const bill = admit(who, "staff", "billing", click, T0 + 1);
  assert.equal(bill.ok === false && bill.reason, "billing-per-day");
  assert.equal(admit(who, "staff", "market", own, T0 + 1).ok, true, "each counts apart");
  assert.equal(admit(who, "staff", "chat", own, T0 + 24 * 3_600_000 + 5).ok, true, "the next day");
});

test("the chat and Billing routes check who, then admit, before they read anything", () => {
  const chat = readFileSync("src/app/api/crm-preview/chat/route.ts", "utf8");
  assert.ok(chat.indexOf("canSeeCrmPreview(") < chat.indexOf("admit("));
  assert.ok(chat.indexOf("admit(") < chat.indexOf("loadPortalChatData("), "the chat admits before loading the portal");
  assert.match(chat, /served\(who, "chat", 0\)/);
  assert.ok((chat.match(/NO_STORE_HEADERS/g) ?? []).length >= 4, "never cached");
  const bill = readFileSync("src/app/api/crm-preview/billing/route.ts", "utf8");
  assert.ok(bill.indexOf("admit(") > 0 && bill.indexOf("admit(") < bill.indexOf("portalClient("), "Billing admits before reading");
  assert.match(bill, /served\(who, "billing", 0\)/);
});
