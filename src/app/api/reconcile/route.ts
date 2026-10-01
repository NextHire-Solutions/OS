import { NextResponse } from "next/server";
import { reconcile } from "@/lib/reconcile/engine";
import { pageGuard } from "@/lib/identity/viewer-roles";

// Never cached by Next: the whole point is the numbers as they are right now.
// The upstream calls are the expensive part, and the client polls this rarely.
export const dynamic = "force-dynamic";

/*
 * Where the tools disagree, and why.
 *
 * Gated by the proxy like every other /api/* route, because the readings carry
 * client counts and campaign volumes.
 */
export async function GET(request: Request) {
  // Behind a page some roles may not see (Eddy, 2 Oct) — see viewer-roles.ts.
  const refused = await pageGuard(request, "consistency");
  if (refused) return refused;
  const report = await reconcile();

  return NextResponse.json(report, {
    headers: { "cache-control": "private, max-age=30, stale-while-revalidate=120" },
  });
}
