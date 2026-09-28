/*
 * What a delete would DESTROY, per scope — the rule, with no database attached.
 *
 * Pure so every combination can be tested with the code that runs, not a copy
 * of it. delete.ts imports this; delete-rule.test.ts pins it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DEPENDS ON THE SCOPE
 *
 * The acknowledgement gate ("I understand this will be destroyed") must fire
 * when — and only when — the chosen scope actually destroys something:
 *
 *   os          removes the OS record only. Every tool row, every portal and
 *               every lead survives. Destroys NOTHING, whatever the client holds.
 *   tools       also removes the Analytics, Client Health and Database rows.
 *               The Database row cascades its leads (orch_client_leads). The
 *               portal and its contents survive.
 *   everything  also removes the Master Inbox row, cascading the portal's
 *               pipeline entries, agents, DNC list and team.
 *
 * Getting this wrong in either direction is a real bug, and both happened:
 *
 *  - Before 28 Sep the gate only looked at "everything", so a "tools" delete
 *    could destroy thousands of leads unasked.
 *  - The first fix (28 Sep morning) counted the portal's contents at EVERY
 *    scope, so "remove from the OS list only" — which destroys nothing — was
 *    refused for any real client, because every real client's portal has
 *    agents. A test client with an empty portal could not show it.
 */

export type DeleteScope = "os" | "tools" | "everything";

export interface PortalContents {
  pipelineEntries: number;
  agents: number;
  dncEntries: number;
  teamMembers: number;
  /** Threads are SET NULL, not deleted — never a loss. */
  threads: number;
}

/** Does this scope drop the Analytics / Client Health / Database rows? */
export function dropsToolRows(scope: DeleteScope): boolean {
  return scope === "tools" || scope === "everything";
}

/** Does this scope drop the Master Inbox row and its portal? */
export function dropsPortal(scope: DeleteScope): boolean {
  return scope === "everything";
}

/** True when the portal holds anything a delete of it would destroy. */
export function portalHasContent(c: PortalContents | null): boolean {
  if (!c) return false;
  return c.pipelineEntries > 0 || c.agents > 0 || c.dncEntries > 0 || c.teamMembers > 0;
}

/**
 * Whether deleting at this scope destroys real data, and so needs the
 * explicit acknowledgement on top of the typed name.
 *
 * `orchLeads` is the lead count on the Database row; `portal` is what the
 * Master Inbox row holds. Each only counts at a scope that removes it.
 */
export function isDestructive(
  scope: DeleteScope,
  portal: PortalContents | null,
  orchLeads: number,
): boolean {
  const losesLeads = dropsToolRows(scope) && orchLeads > 0;
  const losesPortal = dropsPortal(scope) && portalHasContent(portal);
  return losesLeads || losesPortal;
}

/** The server-side gate: refuse a destructive delete unless acknowledged. */
export function needsAcknowledgement(destructive: boolean, acceptDataLoss: boolean): boolean {
  return destructive && !acceptDataLoss;
}

/* ---------------------------------------------------------------------------
 * PAUSING ON DELETE — whose campaigns and billing it is safe to touch.
 *
 * Deleting pauses the client's campaigns and Stripe billing first (28 Sep, the
 * user's rule: "delete should also pause the campaigns if any there and pause
 * the billing if there is any"). After any delete the OS record is gone, and
 * with it the only link to the subscription and the only place to pause from.
 *
 * But both are found indirectly, which makes a duplicate record dangerous:
 *
 *   campaigns  are found through Analytics client rows MATCHED BY NAME. Delete
 *              a duplicate sharing a name with a real client and a naive pause
 *              stops the real client's campaigns.
 *   billing    is the subscription on the record. A duplicate carrying the
 *              same subscription id would pause the real client's billing.
 *
 * So each is skipped — and said so — when another REMAINING client shares it.
 * ------------------------------------------------------------------------- */

/** Another remaining client has this exact subscription. */
export function subscriptionShared(
  subscriptionId: string | null,
  others: Array<{ stripeSubscriptionId: string | null }>,
): boolean {
  if (!subscriptionId) return false;
  return others.some((o) => o.stripeSubscriptionId === subscriptionId);
}

/**
 * Another remaining client answers to one of this client's names.
 * Keys are pre-normalised by the caller (roster keyOf), so this stays pure.
 */
export function nameKeyShared(mine: string[], others: string[][]): boolean {
  const m = new Set(mine.filter(Boolean));
  if (m.size === 0) return false;
  return others.some((keys) => keys.some((k) => k && m.has(k)));
}
