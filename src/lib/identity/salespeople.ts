import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { easternDay, SALESPERSON_RATES, salespersonRate } from "@/lib/commissions/schedule";

import { cleanName, matchSalesperson, salespersonProblems, type Salesperson } from "./salesperson-match";

export { matchSalesperson, isSoldBy, type Salesperson } from "./salesperson-match";

/*
 * THE SALESPEOPLE LIST — Team access → Salespeople (os_salespeople, 0020).
 *
 * The one list a client's Salesperson is chosen from. The name is what the
 * client record stores (os_clients.salesperson) and what Onboarding mirrors,
 * so a rename here carries to both; deactivating someone takes them out of
 * the picker and leaves their clients as they are.
 */

type Row = {
  id: string; name: string; email: string | null; active: boolean; month_one_rate: number; residual_rate: number;
  updated_at?: string | null; inactive_since?: string | null;
};

const toPerson = (r: Row): Salesperson => {
  // When the role was switched off: recorded since 0031; before that, the
  // record's last change (for the records switched off so far, that change).
  const off = r.active ? null : r.inactive_since ?? r.updated_at ?? null;
  return {
    id: r.id, name: r.name, email: r.email ? r.email.toLowerCase() : null, active: r.active,
    // residual_rate holds the salesperson's rate (20% / 10%); the old 15% / 25% read as the default.
    rates: { rate: salespersonRate(r.residual_rate) },
    offSince: off ? easternDay(off) : null,
  };
};

export class SalespersonError extends Error {
  constructor(message: string) { super(message); this.name = "SalespersonError"; }
}

/** Everyone on the list. `available` is false until migration 0020 has been run. */
export async function listSalespeople(): Promise<{ available: boolean; people: Salesperson[] }> {
  const full = await osTable("os_salespeople")
    .select("id, name, email, active, month_one_rate, residual_rate, updated_at, inactive_since").order("name");
  // Before migration 0031 the column is missing: read without it.
  const read = full.error && /inactive_since/i.test(full.error.message)
    ? await osTable("os_salespeople").select("id, name, email, active, month_one_rate, residual_rate, updated_at").order("name")
    : full;
  const { data, error } = read as { data: unknown[] | null; error: { message: string } | null };
  if (error) {
    if (/does not exist|schema cache|relation/i.test(error.message)) return { available: false, people: [] };
    throw new Error(`the Salespeople list: ${error.message}`);
  }
  return { available: true, people: ((data ?? []) as unknown as Row[]).map(toPerson) };
}

/** The active salesperson a typed name means — the rule every client save goes through. */
export async function resolveSalesperson(input: string): Promise<ReturnType<typeof matchSalesperson>> {
  const { people } = await listSalespeople();
  return matchSalesperson(input, people.filter((p) => p.active));
}

const friendly = (message: string) =>
  /duplicate key|unique/i.test(message)
    ? (/email/i.test(message) ? "Someone on the list already has that email." : "Someone on the list already has that name.")
    : message;

export async function addSalesperson(input: { name: string; email?: string | null }, by: string): Promise<Salesperson> {
  const problems = salespersonProblems({ name: input.name, email: input.email ?? null });
  if (problems.length) throw new SalespersonError(problems.join(" "));
  const now = new Date().toISOString();
  const { data, error } = await osTable("os_salespeople")
    .insert({ name: cleanName(input.name), email: input.email?.trim().toLowerCase() || null, updated_at: now, updated_by: by })
    .select("id, name, email, active, month_one_rate, residual_rate").single();
  if (error) throw new SalespersonError(friendly(error.message));
  return toPerson(data as unknown as Row);
}

export interface SalespersonPatch {
  name?: string;
  email?: string | null;
  active?: boolean;
  /** 0.20 or 0.10 of every payment after Stripe's fee. */
  rate?: number;
}


/**
 * Change one salesperson. A rename is carried to every client that names them
 * (the master record) and to Onboarding's copy of the person, so the three
 * never disagree about who sold a client.
 */
export async function updateSalesperson(id: string, patch: SalespersonPatch, by: string): Promise<{ person: Salesperson; clientsRenamed: number }> {
  const problems = salespersonProblems({ name: patch.name, email: patch.email });
  if (problems.length) throw new SalespersonError(problems.join(" "));
  if (patch.rate !== undefined && !SALESPERSON_RATES.includes(patch.rate)) {
    throw new SalespersonError("A salesperson's rate is 20% or 10%.");
  }
  const { data: before, error: readErr } = await osTable("os_salespeople")
    .select("id, name, email, active, month_one_rate, residual_rate").eq("id", id).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!before) throw new SalespersonError("No such salesperson.");
  const old = toPerson(before as unknown as Row);

  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: by };
  const newName = patch.name !== undefined ? cleanName(patch.name) : undefined;
  if (newName !== undefined && newName !== old.name) row.name = newName;
  if (patch.email !== undefined) row.email = patch.email?.trim().toLowerCase() || null;
  if (patch.active !== undefined) row.active = patch.active;
  if (patch.rate !== undefined) row.residual_rate = patch.rate;

  const { data, error } = await osTable("os_salespeople").update(row).eq("id", id)
    .select("id, name, email, active, month_one_rate, residual_rate").single();
  if (error) throw new SalespersonError(friendly(error.message));
  const person = toPerson(data as unknown as Row);

  let clientsRenamed = 0;
  if (row.name) {
    // Stored names are the list's own spelling, so an exact match finds them;
    // ilike (with its wildcards escaped) also catches an older casing.
    const pattern = old.name.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data: moved, error: mErr } = await osTable("os_clients")
      .update({ salesperson: person.name, updated_at: new Date().toISOString() })
      .ilike("salesperson", pattern).select("id");
    if (mErr) throw new Error(`Renamed on the list, but the clients still say “${old.name}”: ${mErr.message}`);
    clientsRenamed = (moved ?? []).length;
    // Onboarding's person row, which its clients point at by id.
    const { error: oErr } = await getOnboardingDb().from("orch_salespeople")
      .update({ name: person.name }).ilike("name", pattern).eq("role", "salesperson");
    if (oErr) console.error("[salespeople] Onboarding rename failed:", oErr.message);
  }
  return { person, clientsRenamed };
}
