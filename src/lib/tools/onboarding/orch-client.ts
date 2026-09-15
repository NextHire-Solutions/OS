import "server-only";

import { getOnboardingDb } from "./db";
import type { ClientRow } from "./client-detail";

/*
 * The whole `orch_clients` row, for the actions that need more than the screen
 * shows — the portal token for the team push, the raw Typeform for the intake
 * people, the Stripe link id for the payment webhook. The tool's `getClient`.
 *
 * Server-only on purpose: `portal_token` is a login-free credential and must
 * never reach a screen payload (client-detail.ts selects around it).
 */

export interface OrchClient extends ClientRow {
  portal_token: string | null;
  raw_typeform: unknown;
  stripe_payment_link_id: string | null;
  stripe_customer_id: string | null;
  health_client_id: string | null;
}

export const CLIENT_SELECT =
  "*, salespeople:orch_salespeople!orch_clients_salesperson_id_fkey(id, name, photo_url)";

export async function getOrchClient(id: string): Promise<OrchClient | null> {
  const { data, error } = await getOnboardingDb()
    .from("orch_clients")
    .select(CLIENT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as OrchClient | null;
}

export const nowIso = () => new Date().toISOString();
