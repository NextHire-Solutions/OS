/*
 * Client sign-in (21 Oct): only the fixed list gets a link; links and codes
 * work once; limits; taking an address off ends its access — fake database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import {
  addLogin,
  allowedPortals,
  listLogins,
  MAX_CODE_ATTEMPTS,
  PER_EMAIL_PER_HOUR,
  readSession,
  removeLogin,
  requestSignIn,
  signInWithCode,
  signInWithLink,
  type SignInEmail,
} from "./login.ts";

const fake = new FakePostgrest();
globalThis.fetch = fake.fetch as typeof fetch;
const db = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: fake.fetch as typeof fetch } });
const SECRET = "test-server-secret";
const NOW = new Date("2026-10-22T15:00:00.000Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function seed() {
  fake.reset();
  for (const t of ["os_portal_logins", "os_portal_login_tokens", "os_portal_sessions"]) fake.seed(t, []);
}
const mails: SignInEmail[] = [];
const send = async (m: SignInEmail) => { mails.push(m); };
const ask = (email: string, now = NOW, ip: string | null = "203.0.113.5") => requestSignIn(db, { email, ip, now, secret: SECRET, linkBase: "https://portal.test/login/confirm" }, send);
const linkOf = (m: SignInEmail) => new URL(m.link).searchParams.get("t") ?? "";
const meta = { userAgent: "test", ip: "203.0.113.5" };

test("an address not on the list is never sent anything — and the page says the same either way", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "Angela@Brokerage.test", name: "Angela", by: "amy@brokerstaffer.com", now: NOW });
  const no = await ask("someone@else.test");
  const yes = await ask("angela@brokerage.test");
  assert.deepEqual([no.shown, no.sent, no.why], ["check-your-email", false, "not-on-list"]);
  assert.deepEqual([yes.shown, yes.sent], ["check-your-email", true]);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "angela@brokerage.test");
  assert.match(mails[0].code, /^\d{6}$/);
  // Only hashes are kept.
  const t = fake.rows("os_portal_login_tokens")[0];
  assert.notEqual(t.link_hash, linkOf(mails[0]));
  assert.ok(!String(t.code_hash).includes(mails[0].code));
  assert.deepEqual(fake.blocked, []);
});

test("a link works once, for 15 minutes, and only while the address is still on the list", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  await ask("angela@brokerage.test");
  const first = await signInWithLink(db, { link: linkOf(mails[0]), now: later(1), ...meta });
  assert.equal(first.ok, true);
  assert.deepEqual(await signInWithLink(db, { link: linkOf(mails[0]), now: later(2), ...meta }), { ok: false, reason: "used" });
  await ask("angela@brokerage.test", later(3));
  assert.deepEqual(await signInWithLink(db, { link: linkOf(mails[1]), now: later(3 + 16), ...meta }), { ok: false, reason: "expired" });
  // A newer email cancels the one before it.
  await ask("angela@brokerage.test", later(30));
  await ask("angela@brokerage.test", later(31));
  assert.deepEqual(await signInWithLink(db, { link: linkOf(mails[2]), now: later(32), ...meta }), { ok: false, reason: "expired" }, "only the newest email works");
  assert.equal((await signInWithLink(db, { link: linkOf(mails[3]), now: later(32), ...meta })).ok, true);
  await ask("angela@brokerage.test", later(40));
  const [row] = await listLogins(db, P1);
  await removeLogin(db, { portalId: P1, id: row.id, by: "amy", now: later(41) });
  assert.deepEqual(await signInWithLink(db, { link: linkOf(mails[4]), now: later(42), ...meta }), { ok: false, reason: "not-on-list" });
  assert.deepEqual(await signInWithLink(db, { link: "made-up", now: later(42), ...meta }), { ok: false, reason: "invalid" });
});

test("the code is the backup: right code signs in once; five wrong ones and it is spent", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  await ask("angela@brokerage.test");
  const wrong = mails[0].code === "000000" ? "111111" : "000000";
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) assert.deepEqual(await signInWithCode(db, { email: "angela@brokerage.test", code: wrong, now: later(1), secret: SECRET, ...meta }), { ok: false, reason: "invalid" });
  assert.deepEqual(await signInWithCode(db, { email: "angela@brokerage.test", code: wrong, now: later(1), secret: SECRET, ...meta }), { ok: false, reason: "too-many-tries" });
  assert.deepEqual(await signInWithCode(db, { email: "angela@brokerage.test", code: mails[0].code, now: later(1), secret: SECRET, ...meta }), { ok: false, reason: "too-many-tries" }, "even the right code, after five wrong");
  await ask("angela@brokerage.test", later(2));
  const ok = await signInWithCode(db, { email: " Angela@Brokerage.test ", code: mails[1].code, now: later(3), secret: SECRET, ...meta });
  assert.equal(ok.ok, true);
  assert.deepEqual(await signInWithCode(db, { email: "angela@brokerage.test", code: mails[1].code, now: later(3), secret: SECRET, ...meta }), { ok: false, reason: "expired" }, "used once");
  // A code is checked with the server's secret: the same code under another secret fails.
  await ask("angela@brokerage.test", later(4));
  assert.equal((await signInWithCode(db, { email: "angela@brokerage.test", code: mails[2].code, now: later(5), secret: "another", ...meta })).ok, false);
});

test("at most five emails an hour to one address", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  for (let i = 0; i < PER_EMAIL_PER_HOUR; i++) assert.equal((await ask("angela@brokerage.test", later(i))).sent, true);
  const sixth = await ask("angela@brokerage.test", later(10));
  assert.deepEqual([sixth.shown, sixth.sent, sixth.why], ["check-your-email", false, "too-many"]);
  assert.equal((await ask("angela@brokerage.test", later(61))).sent, true, "the next hour");
});

test("a session opens the address's portals, follows the list, and ends when the address is on none", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  await addLogin(db, { portalId: P2, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  await ask("angela@brokerage.test");
  const s = await signInWithLink(db, { link: linkOf(mails[0]), now: later(1), ...meta });
  assert.ok(s.ok);
  const session = s.ok ? s.session : "";
  assert.deepEqual((await readSession(db, session, later(2)))?.portals.sort(), [P1, P2].sort());
  const rows1 = await listLogins(db, P1);
  await removeLogin(db, { portalId: P1, id: rows1[0].id, by: "amy", now: later(3) });
  assert.deepEqual((await readSession(db, session, later(4)))?.portals, [P2], "P1 is gone at once");
  const rows2 = await listLogins(db, P2);
  await removeLogin(db, { portalId: P2, id: rows2[0].id, by: "amy", now: later(5) });
  assert.equal(await readSession(db, session, later(6)), null);
  assert.ok(fake.rows("os_portal_sessions").every((r) => r.revoked_at), "and its sessions are ended");
  assert.equal(await readSession(db, "made-up", later(6)), null);
});

test("a session lasts 30 days", async () => {
  seed(); mails.length = 0;
  await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "amy", now: NOW });
  await ask("angela@brokerage.test");
  const s = await signInWithLink(db, { link: linkOf(mails[0]), now: NOW, ...meta });
  assert.ok(s.ok);
  const session = s.ok ? s.session : "";
  assert.ok(await readSession(db, session, new Date(NOW.getTime() + 29 * 86_400_000)));
  assert.equal(await readSession(db, session, new Date(NOW.getTime() + 30 * 86_400_000 + 1)), null);
});

test("the list: an address once per portal; taken off and added back is the same row", async () => {
  seed();
  assert.deepEqual(await addLogin(db, { portalId: P1, email: "not an email", name: null, by: "amy", now: NOW }), { ok: false, status: 400, error: "That is not an email address." });
  assert.deepEqual(await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: "Angela", by: "amy", now: NOW }), { ok: true });
  assert.equal((await addLogin(db, { portalId: P1, email: "ANGELA@brokerage.test", name: null, by: "amy", now: NOW })).ok, false);
  const [row] = await listLogins(db, P1);
  await removeLogin(db, { portalId: P1, id: row.id, by: "amy", now: later(1) });
  assert.deepEqual(await allowedPortals(db, "angela@brokerage.test"), []);
  assert.deepEqual(await addLogin(db, { portalId: P1, email: "angela@brokerage.test", name: null, by: "eddy", now: later(2) }), { ok: true });
  assert.equal(fake.rows("os_portal_logins").length, 1);
  assert.deepEqual(await removeLogin(db, { portalId: P2, id: row.id, by: "amy", now: later(3) }), { ok: false, status: 404, error: "That address is not on this portal's list." }, "only from its own portal");
});
