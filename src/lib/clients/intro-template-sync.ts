import "server-only";

import { env } from "@/lib/tools/master-inbox/env";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import {
  hasIntroDetails,
  introContactEmails,
  introTemplateName,
  renderIntroMacroTemplate,
  type IntroMacroClient,
} from "@/lib/tools/master-inbox/inbox/intro-macro";

/*
 * Keep a client's stored "Intro Macro - <name>" reply template in step with
 * the details on the roster.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NEEDED
 *
 * Onboarding bakes the client's contact, role and brokerage into a
 * `reply_templates` row as literal text. Correcting any of them afterwards
 * used to leave that row saying the old thing for ever — and it is what the
 * Templates picker inserts, and what the standalone Master Inbox shows.
 *
 * The composer's Introduce button renders from the roster instead, so it is
 * always current. This function stops the two from disagreeing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT WRITES THE TABLE DIRECTLY
 *
 * Master Inbox has no endpoint that updates a reply template by name, and its
 * app is deployed and must not be changed. Same direct-write path, and the
 * same reasoning, as the portal feature flags in lib/clients/onboard-run.ts.
 *
 * Never fatal. The caller reports the outcome as one line of its result; a
 * failure here leaves the roster correct and the stored template stale, which
 * is exactly where things stood before this existed.
 */

export type IntroTemplateOutcome =
  | "updated"
  | "created"
  | "no-details"
  | "no-workspace"
  | "unchanged";

/*
 * Nothing beyond the macro's own shape. The contacts' addresses become the
 * template's Cc, so the Templates picker copies the same people in that the
 * Introduce button does.
 */
export type IntroTemplateSyncInput = IntroMacroClient;

export async function syncIntroTemplate(
  client: IntroTemplateSyncInput,
): Promise<IntroTemplateOutcome> {
  // Nothing worth writing: a macro without a contact and a role is a sentence
  // with holes in it.
  if (!hasIntroDetails(client)) return "no-details";

  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) return "no-workspace";

  const db = getMasterInboxSupabase();
  const name = introTemplateName(client.name);
  const body = renderIntroMacroTemplate(client);
  // Every contact who has an address, in the order they are named in the body.
  const cc = introContactEmails(client).join(", ") || null;

  const { data: existing, error: readErr } = await db
    .from("reply_templates")
    .select("id, body, cc")
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  if (existing) {
    // A no-op write would still bump updated_at and show as "changed" in the
    // edit result, which reads as noise when someone edited only a plan.
    if (existing.body === body && ((existing.cc as string | null) ?? null) === cc) {
      return "unchanged";
    }
    const { error } = await db
      .from("reply_templates")
      .update({ body, cc, updated_at: new Date().toISOString() })
      .eq("id", existing.id as string);
    if (error) throw new Error(error.message);
    return "updated";
  }

  /*
   * No row yet — the client was onboarded before the macro existed, or
   * without it ticked. Create one, at the end of the list, in the client's
   * own category, exactly as the onboarding route does.
   */
  const { data: maxOrder } = await db
    .from("reply_templates")
    .select("sort_order")
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await db.from("reply_templates").insert({
    workspace_id: workspaceId,
    name,
    body,
    body_html: null,
    subject: null,
    cc,
    bcc: null,
    category: client.name,
    sort_order: (((maxOrder?.sort_order as number | null) ?? -1) + 1),
  });
  if (error) throw new Error(error.message);
  return "created";
}
