import { NextResponse } from "next/server";

/*
 * Retired. This changed a Master Inbox Supabase auth password by calling
 * `signInWithPassword` and `updateUser` on `createServerSupabase()` — which
 * wraps the PROCESS-WIDE service-role client. supabase-js keeps the signed-in
 * session in memory even with persistSession off, and from then on sends that
 * user's JWT instead of the service key, so one password change made every
 * later inbox query in the process run as that person under row-level
 * security. It also changed a password nobody signs in to the OS with.
 *
 * Settings → Personal now posts to /api/auth/password, the OS sign-in.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Change your password on the Account page." },
    { status: 410 },
  );
}
