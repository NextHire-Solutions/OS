import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Register a new Courted account, or update an existing one's password.
 *
 * The most consequential route in the tool. It validates the login against
 * Courted FIRST, and only then writes COURTED_EMAIL_n / COURTED_PASSWORD_n
 * into the Railway service — which triggers that service's redeploy. The
 * validate-first order is not incidental: it is the fix for a stale stored
 * password having silently replaced a good one (index.js:161).
 *
 * Proxied, necessarily. Nothing here can happen in this process: it needs a
 * Courted session and the Railway API token, and the variables it writes are
 * read by the OTHER service's next boot.
 *
 * The password is forwarded and never logged, stored or echoed.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const r = await scraper.addAccount(body);
  return NextResponse.json(r.body, { status: r.status });
}
