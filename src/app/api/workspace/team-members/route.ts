import { NextResponse } from "next/server";

import { listTeamMembers } from "@/lib/identity/team-directory";

/*
 * The people who can be a client's Account Manager: the active members of
 * Team access, by name. Names only — addresses, grants and sign-in details
 * never leave the admin screen. The proxy has already verified the session.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const members = (await listTeamMembers())
      .filter((m) => m.active)
      .map((m) => ({ name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ members });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read Team access" }, { status: 502 });
  }
}
