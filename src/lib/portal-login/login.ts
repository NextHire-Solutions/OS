/*
 * Client sign-in for the new portal (21 Oct). The user: "enter email and then
 * a button saying send link to login. but we have to make sure client cannot
 * enter any email and can login. there should a fixed email address that is
 * allowed to login." Choices: the list is kept by the people with the Client
 * Portals switch in the OS; a sign-in lasts 30 days; the email carries a link
 * and a 6-digit code (company mail scanners open links and can use one up).
 *
 *   - Only an address on the list (os_portal_logins, not removed) is ever
 *     sent anything. The answer to "send link" is the same either way, so the
 *     page never tells anyone which addresses are on it.
 *   - A link or code works once, for 15 minutes, and only from the newest
 *     email; five wrong codes and that email's code stops working. At most 5 emails an hour to one address,
 *     20 an hour from one place.
 *   - Only hashes are stored: the link's (sha256) and the code's (an HMAC with
 *     the server's secret — a six-digit code is too short to hash bare).
 *   - A session is checked against the list on every use: an address taken
 *     off loses its portal at once, and its sessions end when it has none.
 *
 * Pure, apart from the database client and the mail sender handed in.
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const LINK_MINUTES = 15;
export const SESSION_DAYS = 30;
export const MAX_CODE_ATTEMPTS = 5;
export const PER_EMAIL_PER_HOUR = 5;
export const PER_IP_PER_HOUR = 20;

/** The slice of a Supabase client used here, so tests can hand in a fake one. */
type Db = { from(table: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Res = { data: unknown; error: { message: string } | null };

export const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i.test(e) && e.length <= 254;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const codeHash = (secret: string, email: string, code: string) => createHmac("sha256", secret).update(`${normEmail(email)}:${code}`).digest("hex");
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const iso = (d: Date) => d.toISOString();
const fail = (r: Res, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); };

/** The portals an address may open (not removed). */
export async function allowedPortals(db: Db, email: string): Promise<string[]> {
  const r: Res = await db.from("os_portal_logins").select("portal_id").eq("email", normEmail(email)).is("removed_at", null);
  fail(r, "os_portal_logins");
  return [...new Set(((r.data ?? []) as Array<{ portal_id: string }>).map((x) => x.portal_id))];
}

export interface SignInEmail {
  to: string;
  link: string;
  code: string;
  minutes: number;
}

export type RequestResult =
  /** What the page says in every case: a link is on its way IF the address may sign in. */
  { shown: "check-your-email"; sent: boolean; why?: "not-on-list" | "too-many" | "bad-email" };

/**
 * "Send link to log in". Sends only to an address on the list, within the
 * hourly limits; answers the same way whatever happened.
 */
export async function requestSignIn(
  db: Db,
  input: { email: string; ip: string | null; now: Date; secret: string; linkBase: string },
  send: (mail: SignInEmail) => Promise<void>,
): Promise<RequestResult> {
  const email = normEmail(input.email);
  if (!isEmail(email)) return { shown: "check-your-email", sent: false, why: "bad-email" };
  if (!(await allowedPortals(db, email)).length) return { shown: "check-your-email", sent: false, why: "not-on-list" };

  const hourAgo = iso(new Date(input.now.getTime() - 3_600_000));
  const byEmail: Res = await db.from("os_portal_login_tokens").select("id").eq("email", email).gte("created_at", hourAgo);
  fail(byEmail, "os_portal_login_tokens");
  if (((byEmail.data ?? []) as unknown[]).length >= PER_EMAIL_PER_HOUR) return { shown: "check-your-email", sent: false, why: "too-many" };
  if (input.ip) {
    const byIp: Res = await db.from("os_portal_login_tokens").select("id").eq("requested_ip", input.ip).gte("created_at", hourAgo);
    fail(byIp, "os_portal_login_tokens");
    if (((byIp.data ?? []) as unknown[]).length >= PER_IP_PER_HOUR) return { shown: "check-your-email", sent: false, why: "too-many" };
  }

  // Only the newest email works: earlier links and codes for this address stop here.
  const older: Res = await db.from("os_portal_login_tokens").update({ expires_at: iso(input.now) }).eq("email", email).is("used_at", null).gt("expires_at", iso(input.now));
  fail(older, "os_portal_login_tokens");

  const linkSecret = randomBytes(32).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const ins: Res = await db.from("os_portal_login_tokens").insert({
    email,
    link_hash: sha256(linkSecret),
    code_hash: codeHash(input.secret, email, code),
    created_at: iso(input.now),
    expires_at: iso(new Date(input.now.getTime() + LINK_MINUTES * 60_000)),
    // Explicit, not left to the column default: the wrong-code count is compared on update.
    attempts: 0,
    requested_ip: input.ip,
  });
  fail(ins, "os_portal_login_tokens");
  await send({ to: email, link: `${input.linkBase}?t=${encodeURIComponent(linkSecret)}`, code, minutes: LINK_MINUTES });
  return { shown: "check-your-email", sent: true };
}

export type SignedIn = { ok: true; email: string; session: string; expires: Date } | { ok: false; reason: "invalid" | "expired" | "used" | "not-on-list" | "too-many-tries" };

/** The link's own page ("Sign in" button) → a session. One use; the address must still be on the list. */
export async function signInWithLink(db: Db, input: { link: string; now: Date; userAgent: string | null; ip: string | null }): Promise<SignedIn> {
  if (!input.link || input.link.length > 200) return { ok: false, reason: "invalid" };
  const r: Res = await db.from("os_portal_login_tokens").select("id, email, expires_at, used_at").eq("link_hash", sha256(input.link)).maybeSingle();
  fail(r, "os_portal_login_tokens");
  const t = r.data as { id: string; email: string; expires_at: string; used_at: string | null } | null;
  if (!t) return { ok: false, reason: "invalid" };
  if (t.used_at) return { ok: false, reason: "used" };
  if (Date.parse(t.expires_at) <= input.now.getTime()) return { ok: false, reason: "expired" };
  return useToken(db, t.id, t.email, input);
}

/** The 6-digit code from the same email → a session. Five wrong codes and that email's code is spent. */
export async function signInWithCode(db: Db, input: { email: string; code: string; now: Date; secret: string; userAgent: string | null; ip: string | null }): Promise<SignedIn> {
  const email = normEmail(input.email);
  const code = input.code.replace(/\s+/g, "");
  if (!isEmail(email) || !/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const r: Res = await db
    .from("os_portal_login_tokens")
    .select("id, email, code_hash, expires_at, used_at, attempts")
    .eq("email", email)
    .is("used_at", null)
    .gt("expires_at", iso(input.now))
    .order("created_at", { ascending: false })
    .limit(1);
  fail(r, "os_portal_login_tokens");
  const t = ((r.data ?? []) as Array<{ id: string; email: string; code_hash: string; attempts: number }>)[0];
  if (!t) return { ok: false, reason: "expired" };
  if (t.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "too-many-tries" };
  if (!sameHex(t.code_hash, codeHash(input.secret, email, code))) {
    // Counted on the row it read: a second wrong guess racing this one cannot both pass the limit.
    const bump: Res = await db.from("os_portal_login_tokens").update({ attempts: t.attempts + 1 }).eq("id", t.id).eq("attempts", t.attempts);
    fail(bump, "os_portal_login_tokens");
    return { ok: false, reason: t.attempts + 1 >= MAX_CODE_ATTEMPTS ? "too-many-tries" : "invalid" };
  }
  return useToken(db, t.id, t.email, input);
}

async function useToken(db: Db, id: string, email: string, input: { now: Date; userAgent: string | null; ip: string | null }): Promise<SignedIn> {
  // Single use, even with two clicks at once: only the request that marks it used goes on.
  const used: Res = await db.from("os_portal_login_tokens").update({ used_at: iso(input.now) }).eq("id", id).is("used_at", null).select("id");
  fail(used, "os_portal_login_tokens");
  if (!((used.data ?? []) as unknown[]).length) return { ok: false, reason: "used" };
  // Taken off the list since the email went out: no session.
  if (!(await allowedPortals(db, email)).length) return { ok: false, reason: "not-on-list" };
  const session = randomBytes(32).toString("base64url");
  const expires = new Date(input.now.getTime() + SESSION_DAYS * 86_400_000);
  const ins: Res = await db.from("os_portal_sessions").insert({
    email: normEmail(email),
    secret_hash: sha256(session),
    created_at: iso(input.now),
    expires_at: iso(expires),
    user_agent: input.userAgent?.slice(0, 300) ?? null,
    ip: input.ip,
  });
  fail(ins, "os_portal_sessions");
  const seen: Res = await db.from("os_portal_logins").update({ last_sign_in_at: iso(input.now) }).eq("email", normEmail(email)).is("removed_at", null);
  fail(seen, "os_portal_logins");
  return { ok: true, email: normEmail(email), session, expires };
}

export type Viewer = { email: string; portals: string[] } | null;

/** Who a session cookie belongs to, and the portals they may open now — null when it is not a live session. */
export async function readSession(db: Db, session: string | null | undefined, now: Date): Promise<Viewer> {
  if (!session || session.length > 200) return null;
  const r: Res = await db.from("os_portal_sessions").select("id, email, expires_at, revoked_at").eq("secret_hash", sha256(session)).maybeSingle();
  fail(r, "os_portal_sessions");
  const s = r.data as { id: string; email: string; expires_at: string; revoked_at: string | null } | null;
  if (!s || s.revoked_at || Date.parse(s.expires_at) <= now.getTime()) return null;
  const portals = await allowedPortals(db, s.email);
  if (!portals.length) return null;
  return { email: normEmail(s.email), portals };
}

/** Sign out: this browser's session ends. */
export async function endSession(db: Db, session: string, now: Date): Promise<void> {
  const r: Res = await db.from("os_portal_sessions").update({ revoked_at: iso(now) }).eq("secret_hash", sha256(session)).is("revoked_at", null);
  fail(r, "os_portal_sessions");
}

/* ------------------------------------------------ the list (OS, Client Portals switch) */

export interface PortalLogin {
  id: string;
  email: string;
  name: string | null;
  added_by: string;
  added_at: string;
  last_sign_in_at: string | null;
}

export async function listLogins(db: Db, portalId: string): Promise<PortalLogin[]> {
  const r: Res = await db.from("os_portal_logins").select("id, email, name, added_by, added_at, last_sign_in_at").eq("portal_id", portalId).is("removed_at", null).order("added_at", { ascending: true });
  fail(r, "os_portal_logins");
  return (r.data ?? []) as PortalLogin[];
}

export type ListChange = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

export async function addLogin(db: Db, input: { portalId: string; email: string; name: string | null; by: string; now: Date }): Promise<ListChange> {
  const email = normEmail(input.email);
  if (!isEmail(email)) return { ok: false, status: 400, error: "That is not an email address." };
  const cur: Res = await db.from("os_portal_logins").select("id, removed_at").eq("portal_id", input.portalId).eq("email", email).maybeSingle();
  fail(cur, "os_portal_logins");
  const row = cur.data as { id: string; removed_at: string | null } | null;
  if (row && !row.removed_at) return { ok: false, status: 409, error: "That address can already sign in to this portal." };
  const name = input.name?.trim().slice(0, 120) || null;
  const w: Res = row
    // Added back: the same row, on the list again.
    ? await db.from("os_portal_logins").update({ removed_at: null, removed_by: null, name, added_by: input.by, added_at: iso(input.now) }).eq("id", row.id)
    : await db.from("os_portal_logins").insert({ portal_id: input.portalId, email, name, added_by: input.by, added_at: iso(input.now) });
  fail(w, "os_portal_logins");
  return { ok: true };
}

/** Off the list for this portal; and when the address is on no other portal, its sessions end too. */
export async function removeLogin(db: Db, input: { portalId: string; id: string; by: string; now: Date }): Promise<ListChange> {
  const r: Res = await db.from("os_portal_logins").update({ removed_at: iso(input.now), removed_by: input.by }).eq("id", input.id).eq("portal_id", input.portalId).is("removed_at", null).select("email");
  fail(r, "os_portal_logins");
  const gone = ((r.data ?? []) as Array<{ email: string }>)[0];
  if (!gone) return { ok: false, status: 404, error: "That address is not on this portal's list." };
  if (!(await allowedPortals(db, gone.email)).length) {
    const end: Res = await db.from("os_portal_sessions").update({ revoked_at: iso(input.now) }).eq("email", normEmail(gone.email)).is("revoked_at", null);
    fail(end, "os_portal_sessions");
  }
  return { ok: true };
}
