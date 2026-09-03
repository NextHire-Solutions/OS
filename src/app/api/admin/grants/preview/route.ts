import { NextResponse } from "next/server";
import { coerceTools, isAdmin } from "@/lib/identity/admin";
import { buildGrantsConfig } from "@/lib/identity/grants-config";
import { grantStore } from "@/lib/identity/store";
import { readSsoCookie, verifySso } from "@/lib/bs-auth";

export const dynamic = "force-dynamic";

/*
 * Turns the Team access grid into the BS_GRANTS value to paste into Railway.
 *
 * A preview, not a save. Permissions are a few dozen rows, which is not worth
 * a database project — so the screen edits locally and this renders the exact
 * environment value that produces what you see, along with the warnings worth
 * reading before a redeploy.
 *
 * Named `/preview` deliberately. A route called `/save` that only returned
 * text to copy would be a lie, and the one thing this feature must never do is
 * let someone believe access changed when it hasn't.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });

  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.email)) {
    return NextResponse.json(
      { error: "Forbidden", detail: "Only workspace admins can change team access." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const rawUsers = (body as { users?: unknown })?.users;
  if (!Array.isArray(rawUsers)) {
    return NextResponse.json(
      { error: "Expected { users: [{ email, grants: [] }] }" },
      { status: 400 },
    );
  }

  const desired = rawUsers.flatMap((entry) => {
    const email = typeof (entry as { email?: unknown })?.email === "string"
      ? (entry as { email: string }).email
      : "";
    if (!email.trim()) return [];
    return [{ email, grants: coerceTools((entry as { grants?: unknown })?.grants) }];
  });

  const current = (await grantStore().listUsers()).map((u) => ({
    email: u.email,
    grants: u.grants,
  }));

  const config = buildGrantsConfig(desired, current, { editorEmail: session.email });

  return NextResponse.json({
    variable: "BS_GRANTS",
    ...config,
    // The screen shows these verbatim rather than paraphrasing, so what a
    // person reads is what actually has to happen.
    instructions: [
      "Open the Railway project for the workspace and select the `os` service.",
      "Under Variables, set BS_GRANTS to the value above.",
      "Redeploy. Access changes as each person's session refreshes, within 30 minutes.",
    ],
  });
}
