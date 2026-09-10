import "server-only";

import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

/*
 * The tool's admin client, which was already service-role there.
 *
 * This is the one shim where nothing is lost in translation: the tool used
 * `createAdminSupabase()` precisely when it needed to bypass RLS, and that is
 * what it does here too. See `./server.ts` for the shim that DOES change
 * meaning, and why that is safe.
 *
 * Both names now return the same client. Keeping them distinct anyway is
 * deliberate: in the original, `createAdminSupabase` marks the handful of
 * places that intentionally reach past a user's permissions, and collapsing
 * the two would erase that signal from code we still want to read against the
 * tool's own.
 */
export function createAdminSupabase() {
  return getMasterInboxSupabase();
}
