import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { searchThreads } from "@/lib/tools/master-inbox/inbox/search";

// Thread search for the top-bar dropdown. Matches lead name/email/company,
// subject, campaign, client name, and message body — see lib/inbox/search.
// `?all=1` returns a larger set (used by the /inbox/search results page).

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await requireSession();
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const all = url.searchParams.get("all") === "1";
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const results = await searchThreads(
    session.activeWorkspace.id,
    q,
    all ? 200 : 10,
  );
  return NextResponse.json({ results });
}
