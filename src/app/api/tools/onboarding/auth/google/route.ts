import { NextResponse } from "next/server";

import { consentUrl } from "@/lib/tools/onboarding/google-oauth";

/*
 * "Connect Google account" -> redirect the browser to Google's consent screen.
 * The tool's `app/api/auth/google/route.ts`. Behind the workspace session, as
 * a person presses it; Google sends the browser back to ./callback, which is
 * the redirect URI registered in Google Cloud:
 *   https://os.brokerstaffer.com/api/tools/onboarding/auth/google/callback
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.redirect(consentUrl("connect"));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "not configured" }, { status: 500 });
  }
}
