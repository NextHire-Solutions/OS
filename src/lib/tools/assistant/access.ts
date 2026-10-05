import "server-only";

import type { SsoSession } from "@/lib/bs-auth";

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

/*
 * Admins only (Eddy, 5 Oct: teammates must not reach restricted areas). It
 * used to admit anyone holding every tool; a teammate with every tool is
 * still a teammate. `admin` is isAdminUser(session.email), decided by the
 * caller so this stays pure.
 */
export function canUseAssistant(session: SsoSession | null, admin: boolean): boolean {
  return !!session?.email && admin;
}

export function assistantForbiddenMessage(): string {
  return (
    "The assistant reads across every product, so it is limited to workspace admins."
  );
}
