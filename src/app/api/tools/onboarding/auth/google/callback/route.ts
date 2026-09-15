import { NextResponse } from "next/server";

import { appBaseUrl } from "@/lib/tools/onboarding/env";
import { connectFromCode } from "@/lib/tools/onboarding/google-oauth";

/*
 * Google redirects here after consent with ?code=... — exchange it and store the
 * refresh token. The tool's `app/api/auth/google/callback/route.ts`, landing on
 * the OS's own settings screen (/onboarding/settings) instead of /settings.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const settings = `${appBaseUrl()}/onboarding/settings`;

  if (error) return NextResponse.redirect(`${settings}?error=${encodeURIComponent(error)}`);
  if (!code) return NextResponse.redirect(`${settings}?error=missing_code`);

  try {
    const { email } = await connectFromCode(code);
    return NextResponse.redirect(`${settings}?connected=${encodeURIComponent(email)}`);
  } catch (e) {
    return NextResponse.redirect(`${settings}?error=${encodeURIComponent(e instanceof Error ? e.message : "exchange_failed")}`);
  }
}
