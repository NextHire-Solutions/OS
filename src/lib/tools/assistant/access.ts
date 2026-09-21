import "server-only";

import { ALL_TOOLS, type SsoSession } from "@/lib/bs-auth";
import { isAdmin } from "@/lib/identity/admin";

/*
 * Who may use the assistant.
 *
 * It answers across every client's numbers at once — targets, intros, reply
 * rates, what was scraped for whom — so it is not a per-tool feature that a
 * Master Inbox grant should unlock. The rule the owner asked for: the owner,
 * and anyone holding ALL the tools. Someone granted only Master Inbox can
 * already see Master Inbox; they should not gain Client Health's figures by
 * asking a chat window for them.
 *
 * Checked in one place so the page, the chat list and the ask endpoint cannot
 * drift apart — the usual way a feature ends up visible to someone whose POST
 * is refused, or worse, the other way round.
 */

export function canUseAssistant(session: SsoSession | null): boolean {
  if (!session?.email) return false;
  if (isAdmin(session.email)) return true;
  const held = new Set(session.grants ?? []);
  return ALL_TOOLS.every((tool) => held.has(tool));
}

export function assistantForbiddenMessage(): string {
  return (
    "The assistant reads across every product, so it is limited to the owner " +
    "and to people who already have access to all the tools."
  );
}
