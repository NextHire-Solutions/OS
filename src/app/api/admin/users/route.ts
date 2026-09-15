import { NextResponse } from "next/server";
import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { createUser, DbGrantStore, grantStore, resetUserPassword, setUserActive, writeGrant } from "@/lib/identity/store";
import { generateTemporaryPassword } from "@/lib/identity/user-table";
import { sha256Hex } from "@/lib/bs-auth";
import { coerceTools, describeAdmins, GRANTABLE_TOOLS, isAdmin } from "@/lib/identity/admin";

export const dynamic = "force-dynamic";

/*
 * Everyone with an account, and what each may open. Backs the Team access screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS READ-ONLY TODAY
 *
 * Grants currently come from the BS_GRANTS environment variable, which a
 * running process cannot write to. Rather than fake it — accept a PATCH,
 * return 200, and have the change vanish on the next request — this route
 * reports `writable: false` and the screen can render its switches disabled
 * with an honest explanation.
 *
 * A silent no-op would be worse than no feature at all: someone would toggle
 * access off, believe it, and be wrong about who can read the inbox.
 *
 * When the grants table lands, `writable` flips to true and PATCH is added
 * here. Nothing else in the response shape changes, so the screen does not
 * need rebuilding.
 *
 * ---------------------------------------------------------------------------
 * Password hashes are never returned. The screen has no use for them, and a
 * list of hashes is exactly the thing worth stealing from this endpoint.
 */
export async function GET(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  // The proxy has already gated this path, but an admin check is not the same
  // as a signed-in check, so it happens here where the identity is available.
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.email)) {
    return NextResponse.json(
      { error: "Forbidden", detail: "Only workspace admins can view team access." },
      { status: 403 },
    );
  }

  const store = grantStore();
  const users = store instanceof DbGrantStore ? await store.listMerged() : await store.listUsers();
  const storeInfo = store.describe();
  const admins = describeAdmins();
  // Ask the database, not the store's static description: "writable" was
  // reported true while os_tool_grants did not exist, and the screen promised
  // switches that saved on click when every click would have failed.
  const tables = store instanceof DbGrantStore ? await store.probeTables() : { grants: false, users: false };

  return NextResponse.json({
    users: users
      .map((u) => ({
        email: u.email,
        name: "name" in u ? u.name : null,
        source: "source" in u ? u.source : "env",
        grants: u.grants,
        isActive: u.isActive,
        isAdmin: isAdmin(u.email),
        // The design labels the account under its email ("· Owner"), so the
        // label is decided here rather than inferred from isAdmin in the UI.
        role: isAdmin(u.email) ? "Owner" : "Member",
        isSelf: u.email === session.email,
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),

    tools: GRANTABLE_TOOLS,

    // Everything the screen needs to explain itself instead of guessing.
    capabilities: {
      // True when the os_tool_grants table exists: a switch saves on click
      // and takes effect as each person's session refreshes (≤ 30 minutes).
      // False while migrations/0003 has not been run, in which case the
      // generate-and-paste path below still works.
      writable: tables.grants,
      // True when os_users exists (migrations/0004): people can be invited,
      // deactivated and given a new temporary password from this screen.
      canInvite: tables.grants && tables.users,
      editable: true,
      previewEndpoint: "/api/admin/grants/preview",
      reason: tables.grants
        ? "Switches save immediately. Each person's access updates as their session refreshes, within 30 minutes."
        : "Switches do not save yet — run migrations/0003_os_tool_grants.sql in the Master Inbox Supabase project. Until then, change the switches and paste the generated value into Railway.",
      inviteReason: tables.grants && tables.users
        ? null
        : "Inviting people needs migrations/0003_os_tool_grants.sql and migrations/0004_os_users.sql run in the Master Inbox Supabase project.",
    },

    governance: {
      // false = the bootstrap fail-open is active and everyone in AUTH_USERS
      // has every tool. The screen should say so, loudly.
      grantsGoverned: storeInfo.governed,
      adminsGoverned: admins.governed,
      store: storeInfo.kind,
      userCount: storeInfo.userCount,
    },
  });
}


/*
 * Save one person's tool access.
 *
 * One person per call, on purpose: the screen saves on every click, so the
 * failure mode is one switch that reverts with a message, never a whole grid
 * that half-applied. An admin cannot remove their own admin standing here —
 * that is ADMIN_EMAILS, not a grant.
 */
export async function PATCH(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.email)) {
    return NextResponse.json({ error: "Forbidden", detail: "Only workspace admins can change team access." }, { status: 403 });
  }
  const store = grantStore();
  const tables = store instanceof DbGrantStore ? await store.probeTables() : { grants: false, users: false };
  if (!tables.grants) {
    return NextResponse.json(
      { error: "Grants are not writable yet — run migrations/0003_os_tool_grants.sql in the Master Inbox Supabase project first." },
      { status: 409 },
    );
  }
  let body: { email?: unknown; grants?: unknown; active?: unknown; resetPassword?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Malformed request." }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  /*
   * Deactivate / reactivate / new temporary password — invited people only.
   * An AUTH_USERS address is managed in Railway, and an admin cannot lock
   * themselves out from here.
   */
  if (typeof body.active === "boolean" || body.resetPassword === true) {
    if (!tables.users) return NextResponse.json({ error: "Run migrations/0004_os_users.sql first." }, { status: 409 });
    if (email === session.email) return NextResponse.json({ error: "You cannot change your own account here." }, { status: 400 });
    const people = store instanceof DbGrantStore ? await store.listMerged() : [];
    const person = people.find((p) => p.email === email);
    if (!person) return NextResponse.json({ error: `${email} is not a workspace user.` }, { status: 404 });
    if (person.source !== "db") {
      return NextResponse.json({ error: `${email} signs in through AUTH_USERS; manage that account in Railway.` }, { status: 409 });
    }
    try {
      if (typeof body.active === "boolean") {
        await setUserActive(email, body.active);
        return NextResponse.json({ ok: true, email, active: body.active });
      }
      const temporaryPassword = generateTemporaryPassword();
      await resetUserPassword(email, await sha256Hex(temporaryPassword));
      // Shown once, never stored in the clear, never logged.
      return NextResponse.json({ ok: true, email, temporaryPassword });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save." }, { status: 500 });
    }
  }

  // Only someone who can sign in may hold grants; the table cannot invent users.
  const known = await store.findByEmail(email);
  if (!known) return NextResponse.json({ error: `${email} is not a workspace user.` }, { status: 404 });
  // An Owner's access is not a grant. It is ADMIN_EMAILS, and it is every tool.
  if (isAdmin(email)) {
    return NextResponse.json({ error: `${email} is an Owner and always has every tool.` }, { status: 409 });
  }
  const grants = coerceTools(body.grants);
  try {
    await writeGrant(email, grants, session.email);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email, grants });
}

/*
 * Invite a teammate.
 *
 * Nothing is emailed. The OS mints a temporary password, stores only its
 * hash, and returns the password ONCE to the admin who asked — they hand it
 * over however they like. The response is the only place it ever exists in
 * the clear.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.email)) {
    return NextResponse.json({ error: "Forbidden", detail: "Only workspace admins can invite people." }, { status: 403 });
  }
  const store = grantStore();
  const tables = store instanceof DbGrantStore ? await store.probeTables() : { grants: false, users: false };
  if (!tables.grants || !tables.users) {
    return NextResponse.json(
      { error: "Inviting people needs migrations/0003_os_tool_grants.sql and migrations/0004_os_users.sql run in the Master Inbox Supabase project." },
      { status: 409 },
    );
  }
  let body: { email?: unknown; name?: unknown; grants?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Malformed request." }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : null;
  const grants = coerceTools(body.grants);
  if (grants.length === 0) {
    return NextResponse.json({ error: "Switch on at least one tool, or the person will sign in to an empty workspace." }, { status: 400 });
  }
  // findByEmail hides deactivated people (they cannot sign in), but their row
  // still exists — inviting the same address again hit the primary key with
  // a bare 500. Look at the full list, and say which case it is.
  const everyone = store instanceof DbGrantStore ? await store.listMerged() : await store.listUsers();
  const existing = everyone.find((u) => u.email === email);
  if (existing) {
    return NextResponse.json(
      {
        error: existing.isActive
          ? `${email} already has an account.`
          : `${email} already has an account, currently deactivated — use Reactivate on their row instead.`,
      },
      { status: 409 },
    );
  }
  const temporaryPassword = generateTemporaryPassword();
  try {
    await createUser({ email, name, passwordHash: await sha256Hex(temporaryPassword), by: session.email });
    await writeGrant(email, grants, session.email);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not invite." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email, name, grants, temporaryPassword });
}
