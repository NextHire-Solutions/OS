import { NextResponse } from "next/server";
import { mintSso, readSsoCookie, safeEqual, sha256Hex, SSO_COOKIE, ssoCookieOptions, verifySso } from "@/lib/bs-auth";
import { changeUserPassword, grantStore } from "@/lib/identity/store";
import { validateNewPassword } from "@/lib/identity/password";

export const dynamic = "force-dynamic";

/*
 * A person's own password.
 *
 * GET says who they are. POST changes it — for invited people and for
 * AUTH_USERS accounts alike (an Owner's new hash lives in os_users and takes
 * over from the Railway one at sign-in): the
 * current password must match, the new one must pass validateNewPassword,
 * and the response re-mints THIS session with the bumped token_version so
 * the person stays signed in while every other session of theirs ends.
 */
async function who(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return { secret: null, session: null, user: null };
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return { secret, session: null, user: null };
  const user = await grantStore().findByEmail(session.email);
  return { secret, session, user };
}

export async function GET(request: Request) {
  const { secret, session, user } = await who(request);
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  if (!session || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    email: user.email,
    source: user.source ?? "env",
    canChange: true,
    mustChangePassword: user.mustChangePassword === true,
  });
}

export async function POST(request: Request) {
  const { secret, session, user } = await who(request);
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  if (!session || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { current?: unknown; next?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Malformed request." }, { status: 400 }); }
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (!safeEqual(await sha256Hex(current), user.passwordHash)) {
    return NextResponse.json({ error: "The current password is not right." }, { status: 401 });
  }
  const problem = validateNewPassword(next, current);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  let ver: number;
  try {
    ver = (await changeUserPassword(user.email, await sha256Hex(next), user.email)).tokenVersion;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change the password." }, { status: 500 });
  }
  const token = await mintSso(secret, { email: user.email, grants: user.grants, ver });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SSO_COOKIE, token, ssoCookieOptions({
    secure: new URL(request.url).protocol === "https:",
    domain: process.env.SSO_COOKIE_DOMAIN,
  }));
  return response;
}
