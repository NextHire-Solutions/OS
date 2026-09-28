import "server-only";

import { osTable } from "./os-db";
import { resolvePerson, type PersonRole, type Resolution, type TeamPerson } from "./people-link";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";

/*
 * Carries Salesperson, Account Manager and Sender between the master record and
 * the Database's client row. Why both directions exist: people-link.ts.
 *
 * Neither direction calls the other, so there is no loop: Edit writes the
 * master and then the Database row directly; the Onboarding page writes the
 * Database row and then the master directly.
 */

export interface PeopleEdit {
  salesperson?: string | null;
  accountManager?: string | null;
  sender?: string | null;
}

async function team(): Promise<TeamPerson[]> {
  const { data, error } = await getOnboardingDb().from("orch_salespeople").select("id, name, role");
  if (error) throw new Error(`the team list: ${error.message}`);
  return (data ?? []) as TeamPerson[];
}

export interface PeoplePlan {
  salesperson?: Resolution;
  accountManager?: Resolution;
  sender?: string | null;
  /** A name matching two people — refused before anything is written. */
  errors: string[];
}

/** Resolve the typed names first, so an ambiguous one refuses the whole edit. */
export async function planDatabasePeople(edit: PeopleEdit): Promise<PeoplePlan> {
  const plan: PeoplePlan = { errors: [] };
  if (edit.salesperson === undefined && edit.accountManager === undefined && edit.sender === undefined) return plan;
  const people = edit.salesperson !== undefined || edit.accountManager !== undefined ? await team() : [];
  const one = (field: "salesperson" | "accountManager", role: PersonRole, label: string) => {
    if (edit[field] === undefined) return;
    const r = resolvePerson(edit[field], people, role);
    if (r.kind === "ambiguous") plan.errors.push(`${label}: more than one person on the team is called “${r.names[0]}”. Rename one under Onboarding → Settings first.`);
    plan[field] = r;
  };
  one("salesperson", "salesperson", "Salesperson");
  one("accountManager", "account_manager", "Account Manager");
  if (edit.sender !== undefined) plan.sender = (edit.sender ?? "").trim() || null;
  return plan;
}

/** Write a resolved plan onto the Database's client row. Returns what changed, for the edit result. */
export async function writeDatabasePeople(orchClientId: string, plan: PeoplePlan): Promise<string[]> {
  const db = getOnboardingDb();
  const idFor = async (r: Resolution | undefined): Promise<string | null | undefined> => {
    if (!r) return undefined;
    if (r.kind === "clear") return null;
    if (r.kind === "found") return r.id;
    if (r.kind === "create") {
      const { data, error } = await db.from("orch_salespeople").insert({ name: r.name, role: r.role, active: true }).select("id").single();
      if (error) throw new Error(`adding ${r.name} to the team list: ${error.message}`);
      return (data as { id: string }).id;
    }
    throw new Error("ambiguous person"); // refused in planDatabasePeople
  };
  const patch: Record<string, unknown> = {};
  const sp = await idFor(plan.salesperson);
  if (sp !== undefined) patch.salesperson_id = sp;
  const am = await idFor(plan.accountManager);
  if (am !== undefined) patch.account_manager_id = am;
  if (plan.sender !== undefined) patch.sender_name = plan.sender;
  if (!Object.keys(patch).length) return [];
  patch.updated_at = new Date().toISOString();
  const { error } = await db.from("orch_clients").update(patch).eq("id", orchClientId);
  if (error) throw new Error(error.message);
  const added = [plan.salesperson, plan.accountManager].filter((r) => r?.kind === "create").map((r) => (r as { name: string }).name);
  return added;
}

/**
 * The other direction: the Onboarding page set a person on the Database row,
 * so the master record follows. `onlyIfEmpty` is for the campaign build's
 * sender, which fills a gap and must not overwrite a name someone chose.
 */
export async function mirrorPeopleToMaster(
  orchClientId: string,
  change: { salespersonId?: string | null; accountManagerId?: string | null; sender?: string | null },
  opts: { onlyIfEmpty?: boolean } = {},
): Promise<void> {
  try {
    await mirror(orchClientId, change, opts);
  } catch (e) {
    // Never fatal: the Onboarding write already succeeded, and failing the page
    // over the mirror would report the opposite of what happened.
    console.error("[people-sync] master mirror failed for", orchClientId, e instanceof Error ? e.message : e);
  }
}

async function mirror(
  orchClientId: string,
  change: { salespersonId?: string | null; accountManagerId?: string | null; sender?: string | null },
  opts: { onlyIfEmpty?: boolean },
): Promise<void> {
  const nameOf = async (id: string | null | undefined): Promise<string | null | undefined> => {
    if (id === undefined) return undefined;
    if (!id) return null;
    const { data } = await getOnboardingDb().from("orch_salespeople").select("name").eq("id", id).maybeSingle();
    return ((data as { name?: string } | null)?.name ?? "").trim() || null;
  };
  const patch: Record<string, unknown> = {};
  const sp = await nameOf(change.salespersonId);
  if (sp !== undefined) patch.salesperson = sp;
  const am = await nameOf(change.accountManagerId);
  if (am !== undefined) patch.account_manager = am;
  if (change.sender !== undefined) patch.sender_name = (change.sender ?? "").trim() || null;
  if (!Object.keys(patch).length) return;
  patch.updated_at = new Date().toISOString();
  let q = osTable("os_clients").update(patch).eq("orch_client_id", orchClientId);
  if (opts.onlyIfEmpty && "sender_name" in patch) q = q.is("sender_name", null);
  const { error } = await q;
  if (error) throw new Error(error.message);
}
