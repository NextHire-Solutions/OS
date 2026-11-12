import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cleanEmail, customerNow, emailCall, emailRefusal, InvoiceEmailError, liveEmailRefusal, planEmail, sameEmail, sendEmail, type CustomerNow,
} from "./billing-email.ts";

/*
 * Where a client's Stripe emails go (12 Nov). Stripe is never called here: a fake fetch stands in. The route is run for
 * real in billing/email/route.test.ts; the real calls were proven in Stripe's TEST mode only.
 */

const CUS = "cus_TestAbCdEfGh";
const OLD = "jeffcook@jeffcookrealestate.com";
const NEW = "alma.nowatzke@jeffcookrealestate.com";
const now = (o: Partial<CustomerNow> = {}): CustomerNow => ({ id: CUS, email: OLD, deleted: false, ...o });
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("one address, as Stripe will get it", () => {
  assert.equal(cleanEmail(NEW), NEW);
  assert.equal(cleanEmail("  Alma.Nowatzke@JeffCookRealEstate.com \n"), NEW, "trimmed, one case");
  assert.equal(cleanEmail("billing+jeff@sub.jeffcookrealestate.co.uk"), "billing+jeff@sub.jeffcookrealestate.co.uk");
  for (const bad of ["", "   ", "alma", "alma@", "@jeffcookrealestate.com", "alma@jeffcookrealestate", "alma@jeffcookrealestate.c", "alma@.com",
    "alma nowatzke@jeffcookrealestate.com", `${NEW},${OLD}`, `${NEW}; ${OLD}`, `Alma <${NEW}>`, `"alma"@jeffcookrealestate.com`, "alma@@x.com",
    "alma..n@x.com", "alma@x..com", "alma,jeff@jeffcookrealestate.com", "alma;jeff@jeffcookrealestate.com", "alma@jeffcook,realestate.com", `${"a".repeat(247)}@abc.com`]) {
    assert.equal(cleanEmail(bad), null, bad);
  }
  assert.equal(cleanEmail(`${"a".repeat(246)}@abc.com`)?.length, 254, "the longest address a mail server takes still passes");
  // Invisible characters pasted with an address (it would look right on screen and bounce), and domains no mail server has.
  for (const bad of ["alma\u200b@jeffcookrealestate.com", "alma@jeffcookrealestate\u200b.com", "\u202ealma@jeffcookrealestate.com", "alma\u0000@x.com", "\ufeffalma@x.com\u200d",
    "a@.x.com", "a@-x.com", "a@x-.com", "a@b!c.com", "a@b_c.com", "a@x.c0m", ".alma@x.com", "alma.@x.com", `a@${"b".repeat(64)}.com`]) {
    assert.equal(cleanEmail(bad), null, JSON.stringify(bad));
  }
  for (const good of ["a@x-y.com", "o'brien@x.com", "a@mail.example.xn--p1ai", `a@${"b".repeat(63)}.com`, "first.last@sub.domain.io"]) {
    assert.equal(cleanEmail(good), good, good);
  }
});

test("the same address in other capitals is the same address; none and empty are the same", () => {
  assert.ok(sameEmail("Alma@X.com ", "alma@x.com"));
  assert.ok(sameEmail(null, ""));
  assert.ok(!sameEmail(null, "a@x.com"));
});

test("the checks before Stripe is asked", () => {
  assert.deepEqual(planEmail(now(), OLD, NEW), { kind: "send" });
  assert.deepEqual(planEmail(now({ email: "JeffCook@JeffCookRealEstate.com" }), OLD, NEW), { kind: "send" }, "the page's address in other capitals still matches");
  assert.deepEqual(planEmail(now({ email: null }), null, NEW), { kind: "send" }, "no address yet: one is added");
  assert.equal(planEmail(now({ email: NEW }), OLD, NEW).kind, "done", "Stripe has it already (a retry): nothing to send");
  assert.throws(() => planEmail(now({ email: "other@x.com" }), OLD, NEW), (e: unknown) => e instanceof InvoiceEmailError && e.status === 409 && /a different address for this customer than the page showed: it is now other@x\.com\. Nothing was changed/.test(e.message));
  assert.throws(() => planEmail(now({ email: null }), OLD, NEW), (e: unknown) => e instanceof InvoiceEmailError && e.status === 409 && /it is now empty/.test(e.message), "removed meanwhile");
  assert.throws(() => planEmail(now({ deleted: true }), OLD, NEW), (e: unknown) => e instanceof InvoiceEmailError && e.status === 409);
});

test("Stripe gets the address and who changed it from what, nothing else", () => {
  const c = emailCall(CUS, NEW, OLD, "amy@brokerstaffer.com");
  assert.equal(c.path, `customers/${CUS}`);
  assert.deepEqual(Object.fromEntries(c.form), { email: NEW, "metadata[os_email_by]": "amy@brokerstaffer.com", "metadata[os_email_before]": OLD });
  assert.equal(emailCall(CUS, NEW, null, "amy@brokerstaffer.com").form.get("metadata[os_email_before]"), "", "none before: an old value is cleared, not kept");
});

test("reading and changing the customer, and what each Stripe answer means", async () => {
  let asked: { url: string; init?: RequestInit } | null = null;
  const spy = (async (url: string, init?: RequestInit) => { asked = { url, init }; return new Response(JSON.stringify({ id: CUS, email: NEW }), { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await sendEmail("sk_test_x", CUS, NEW, OLD, "amy@brokerstaffer.com", spy), { id: CUS, email: NEW, deleted: false });
  assert.equal(asked!.url, `https://api.stripe.com/v1/customers/${CUS}`);
  assert.equal(asked!.init?.method, "POST");
  assert.equal(new URLSearchParams(String(asked!.init?.body)).get("email"), NEW);

  assert.deepEqual(await customerNow("sk_test_x", CUS, reply(200, { id: CUS, email: OLD })), now());
  assert.deepEqual(await customerNow("sk_test_x", CUS, reply(200, { id: CUS, deleted: true })), { id: CUS, email: null, deleted: true });
  await assert.rejects(customerNow("sk_test_x", CUS, reply(404, { error: { message: "No such customer" } })), (e: unknown) => e instanceof InvoiceEmailError && e.status === 404);
  await assert.rejects(customerNow("sk_test_x", CUS, reply(500, {})), (e: unknown) => e instanceof InvoiceEmailError && e.status === 502);

  // Stripe said no: nothing changed (Stripe checks the address too).
  await assert.rejects(sendEmail("sk_test_x", CUS, NEW, OLD, "a", reply(400, { error: { message: "Invalid email address: x" } })),
    (e: unknown) => e instanceof InvoiceEmailError && e.status === 409 && /Invalid email address: x\. Nothing was changed/.test(e.message));
  assert.equal(emailRefusal(429, undefined).status, 503);
  assert.equal(emailRefusal(401, undefined).status, 503);
  // No clear answer: it may have gone through.
  assert.equal(emailRefusal(500, "boom").status, 502);
  await assert.rejects(sendEmail("sk_test_x", CUS, NEW, OLD, "a", reply(200, null)), (e: unknown) => e instanceof InvoiceEmailError && e.status === 502);
});

test("a live key changes a customer only on Railway and only when asked from os.brokerstaffer.com", () => {
  const site = "https://os.brokerstaffer.com";
  assert.equal(liveEmailRefusal("sk_test_x", {}, null, site), null, "test mode anywhere");
  assert.match(liveEmailRefusal("sk_live_x", {}, site, site)!, /only from os\.brokerstaffer\.com/, "a laptop, even asked from the site's origin");
  assert.match(liveEmailRefusal("rk_live_x", { RAILWAY_ENVIRONMENT_NAME: "production" }, "http://localhost:3000", site)!, /only from/);
  assert.match(liveEmailRefusal("sk_live_x", { RAILWAY_ENVIRONMENT_NAME: "production" }, null, site)!, /only from/);
  assert.equal(liveEmailRefusal("sk_live_x", { RAILWAY_ENVIRONMENT_NAME: "production" }, site, site), null);
});

test("the route: a bare 404 off the Billing tab, only from the OS's own page, the checks before the change", () => {
  const src = readFileSync("src/app/api/workspace/clients/billing/email/route.ts", "utf8");
  const order = ["billingTabUser(request)", "fromOwnPage(request)", "invoiceEmailRequest.safeParse", "cleanEmail(r.to)", "liveEmailRefusal(", "getAccountBilling()", "customerNow(", "planEmail(", "sent = true", "sendEmail("];
  let at = -1;
  for (const s of order) {
    const i = src.indexOf(s);
    assert.ok(i > at, `${s} comes after the checks before it`);
    at = i;
  }
  assert.doesNotMatch(src, /billingUser\(/, "not the Clients page's wider rule");
});

test("the button shows only when the server says so — for the Billing tab's people, by name", () => {
  const route = readFileSync("src/app/api/workspace/clients/billing/route.ts", "utf8");
  assert.match(route, /const canChangeEmail = canSeeBillingTab\(who\.email\);/);
  assert.equal(route.match(/canChangeEmail, account/g)?.length, 3, "on every answer the record's Stripe control reads");
  const ui = readFileSync("src/components/screens/client-record.tsx", "utf8");
  assert.match(ui, /canChangeEmail=\{state\.canChangeEmail === true\}/);
  assert.match(ui, /\{canChangeEmail \? \(\s*<button[^>]*data-mail-open/);
});

test("while a dialog is open over the record, ↑/↓ don't swap the client under it", () => {
  const ui = readFileSync("src/components/screens/client-record.tsx", "utf8");
  const keys = ui.slice(ui.indexOf("// Escape closes; ↑ / ↓"), ui.indexOf("document.addEventListener(\"keydown\", onKey);"));
  assert.ok(keys.indexOf('if (document.querySelector("[data-modal-dialog]")) return;') > 0 && keys.indexOf('if (document.querySelector("[data-modal-dialog]")) return;') < keys.indexOf("onNext()"));
  assert.match(readFileSync("src/components/ui/modal-dialog.tsx", "utf8"), /data-modal-dialog=""/);
});
