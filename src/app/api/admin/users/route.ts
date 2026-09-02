import { NextResponse } from "next/server";
import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { grantStore } from "@/lib/identity/store";
import { describeAdmins, GRANTABLE_TOOLS, isAdmin } from "@/lib/identity/admin";

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
  const users = await store.listUsers();
  const storeInfo = store.describe();
  const admins = describeAdmins();

  return NextResponse.json({
    users: users
      .map((u) => ({
        email: u.email,
        grants: u.grants,
        isActive: u.isActive,
        isAdmin: isAdmin(u.email),
        isSelf: u.email === session.email,
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),

    tools: GRANTABLE_TOOLS,

    // Everything the screen needs to explain itself instead of guessing.
    capabilities: {
      writable: false,
      reason:
        "Grants are read from the BS_GRANTS environment variable, which cannot be changed from here. Editing requires the grants database.",
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
