import "server-only";

import { osTable } from "./os-db";

/*
 * Onboarding date and churn date on the master record (os_clients, 0023),
 * and the pause date (0032, 9 Oct). The only reader and writer of those
 * columns — read on their own so a database without the migrations still
 * serves every other field.
 */

export interface ClientDates {
  onboardingDate: string | null;
  churnDate: string | null;
  /**
   * A pause entered by hand — for one the status history does not have (it
   * began 13 Sep 2026). Never stamped automatically. Null before 0032.
   */
  pauseDate?: string | null;
}

export const MIGRATION_0023 = "Onboarding and churn dates need migrations/0023_client_dates.sql run in the Master Inbox Supabase project.";
export const MIGRATION_0032 = "The pause date needs migrations/0032_client_pause_date.sql run in the Master Inbox Supabase project.";
const missing = (m: string) => /column .* does not exist|schema cache/i.test(m);

type DateRow = { id: string; onboarding_date: string | null; churn_date: string | null; pause_date?: string | null };

/** Every client's dates; null when the 0023 columns are not there yet. */
export async function listClientDates(): Promise<Map<string, ClientDates> | null> {
  // With the pause date; before 0032 the same read without it.
  let { data, error } = await osTable("os_clients").select("id, onboarding_date, churn_date, pause_date");
  if (error && missing(error.message)) ({ data, error } = await osTable("os_clients").select("id, onboarding_date, churn_date"));
  if (error) return null;
  return new Map(((data ?? []) as unknown as DateRow[])
    .map((r) => [r.id, { onboardingDate: r.onboarding_date, churnDate: r.churn_date, pauseDate: r.pause_date ?? null }]));
}

export class ClientDatesError extends Error {
  constructor(message: string) { super(message); this.name = "ClientDatesError"; }
}

/** Write any of the dates (YYYY-MM-DD, or null to clear). */
export async function setClientDates(id: string, dates: Partial<ClientDates>): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (dates.onboardingDate !== undefined) patch.onboarding_date = dates.onboardingDate;
  if (dates.churnDate !== undefined) patch.churn_date = dates.churnDate;
  if (dates.pauseDate !== undefined) patch.pause_date = dates.pauseDate;
  if (!Object.keys(patch).length) return;
  const { error } = await osTable("os_clients").update(patch).eq("id", id);
  if (error) {
    const which = /pause_date/.test(error.message) ? MIGRATION_0032 : MIGRATION_0023;
    throw new ClientDatesError(missing(error.message) ? which : error.message);
  }
}

/**
 * A status change just happened: record the day. Churned stamps the churn
 * date (a new churn replaces an old one); a new client stamps its onboarding
 * date only if none was entered. Never fatal — the status is saved either way.
 */
export async function stampStatusDate(id: string, status: string, day: string): Promise<void> {
  try {
    if (status === "churned") {
      await osTable("os_clients").update({ churn_date: day }).eq("id", id);
    } else if (status === "onboarding") {
      await osTable("os_clients").update({ onboarding_date: day }).eq("id", id).is("onboarding_date", null);
    }
  } catch {
    /* before 0023 there is nowhere to write it; the history still has it */
  }
}
