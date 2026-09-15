/*
 * Everything the real action checks before it does anything — as a pure
 * function over the client row and a "has this delivery happened?" lookup, so
 * the guards can be exercised under `node --test` with the lookup stubbed.
 *
 * Ported from the guards inside the tool's `app/actions.ts`,
 * `lib/client-email.ts` and `lib/connectors/bison.ts`.
 */

export interface PreconditionClient {
  id: string;
  primary_contact?: { email?: string } | null;
  portal_url?: string | null;
  client_name?: string | null;
  brand?: string | null;
  office_name?: string | null;
  mls?: string | null;
  bison_campaign_id?: string | null;
}

export type HasDelivery = (clientId: string, target: string, actions: string[]) => Promise<boolean>;

/** The reason it would refuse, or null if it would proceed. */
export async function stepPrecondition(
  key: string,
  c: PreconditionClient,
  hasDelivery: HasDelivery,
): Promise<string | null> {
  const [kind, name] = key.split(":");
  const email = c.primary_contact?.email;

  if (kind === "email") {
    if (!email) return "this client has no email address on file";
    // Welcome goes out exactly once per client, in either variant.
    if (name === "welcome" && (await hasDelivery(c.id, "email", ["welcome", "welcome_nobooking"]))) {
      return "the welcome email has already been sent to this client";
    }
    if ((name === "portal" || name === "dnc_reminder") && !c.portal_url) {
      return "this client has no portal yet — create the portal first";
    }
  }

  if (key === "push:client_portal" && c.portal_url) {
    return "this client already has a portal";
  }
  if (key === "push:health_dash" && (await hasDelivery(c.id, "health_dash", ["onboard_client"]))) {
    return "this client is already on the Health Dashboard";
  }
  if (key === "build:team" && !(c.client_name || c.brand || c.office_name)) {
    return "this client has no firm name to match agents against";
  }
  if (key === "build:leads" && !c.mls) {
    return "this client has no MLS set — pick one before building the list";
  }
  if (key === "campaign:build" && c.bison_campaign_id) {
    return `a campaign already exists for this client (id ${c.bison_campaign_id})`;
  }
  if ((key === "campaign:launch" || key === "campaign:pause") && !c.bison_campaign_id) {
    return "this client has no campaign yet — create the campaign first";
  }
  if (key === "payment:link" && !email) {
    return "this client has no email address on file";
  }

  return null;
}

/** The steps that stay switched off: everything that emails a client, and the Stripe link. */
export function isRefusedStep(key: string): boolean {
  return key.startsWith("email:") || key === "payment:link";
}

export const REFUSED_REASON =
  "It is switched off in the OS pending explicit enablement — no email leaves for a client and no Stripe link is created from here until someone turns it on deliberately.";
