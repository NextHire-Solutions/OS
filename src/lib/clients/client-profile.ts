import "server-only";

import { osTable } from "./os-db";

/*
 * Sign up date, website, Zillow profile and point of contact on the master
 * record (os_clients, 0027). The only reader and writer of those columns —
 * read on their own so a database without the migration still serves every
 * other field, exactly like client-dates.ts.
 */

export interface ClientProfile {
  /** Entered on the record; when null the screen shows Stripe's customer-created day. */
  signupDate: string | null;
  website: string | null;
  zillowUrl: string | null;
  pocName: string | null;
  pocEmail: string | null;
}

export const MIGRATION_0027 = "Sign up date, website, Zillow profile and POC need migrations/0027_client_profile.sql run in the Master Inbox Supabase project.";
const missing = (m: string) => /column .* does not exist|schema cache/i.test(m);

type Row = { id: string; signup_date: string | null; website: string | null; zillow_url: string | null; poc_name: string | null; poc_email: string | null };

/** Every client's profile; null when the columns are not there yet. */
export async function listClientProfiles(): Promise<Map<string, ClientProfile> | null> {
  const { data, error } = await osTable("os_clients").select("id, signup_date, website, zillow_url, poc_name, poc_email");
  if (error) return null;
  return new Map(((data ?? []) as unknown as Row[]).map((r) => [r.id, {
    signupDate: r.signup_date, website: r.website, zillowUrl: r.zillow_url, pocName: r.poc_name, pocEmail: r.poc_email,
  }]));
}

export class ClientProfileError extends Error {
  constructor(message: string) { super(message); this.name = "ClientProfileError"; }
}

const COLUMN: Record<keyof ClientProfile, string> = {
  signupDate: "signup_date", website: "website", zillowUrl: "zillow_url", pocName: "poc_name", pocEmail: "poc_email",
};

/** Write any of the fields (already validated; null clears). */
export async function setClientProfile(id: string, patch: Partial<ClientProfile>): Promise<void> {
  const row: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(COLUMN) as [keyof ClientProfile, string][]) {
    if (patch[k] !== undefined) row[col] = patch[k];
  }
  if (!Object.keys(row).length) return;
  const { error } = await osTable("os_clients").update(row).eq("id", id);
  if (error) throw new ClientProfileError(missing(error.message) ? MIGRATION_0027 : error.message);
}
