import "server-only";

import { getOnboardingDb } from "./db";
import { isRole, validatePhoto, type Person, type PersonRole } from "./people-types";

export * from "./people-types";

/**
 * The team's roster — salespeople and account managers.
 *
 * Ported from the orchestrator's `lib/people.ts` and `app/people-actions.ts`.
 * Both roles live in `orch_salespeople` so there is one place to look up a
 * person; `role` separates them. Nothing automatic reads a person: they are
 * labels shown in the app and dropped into emails by name.
 */

const COLS = "id, name, email, active, role, photo_url";

/** Everyone on the roster, both roles, for the Settings editor. */
export async function getPeople(): Promise<Person[]> {
  const { data, error } = await getOnboardingDb()
    .from("orch_salespeople")
    .select(COLS)
    .order("role")
    .order("name");
  if (error) return [];
  return (data ?? []) as Person[];
}

/** Active people in one role — for the pickers on a client. */
export async function getPeopleByRole(role: PersonRole): Promise<Person[]> {
  const { data, error } = await getOnboardingDb()
    .from("orch_salespeople")
    .select(COLS)
    .eq("role", role)
    .eq("active", true)
    .order("name");
  if (error) return [];
  return (data ?? []) as Person[];
}

export async function createPerson(
  role: PersonRole,
  name: string,
  email: string,
  photo: string | null,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "name required" };
  if (!isRole(role)) return { ok: false, error: "unknown role" };

  const checked = validatePhoto(photo);
  if (!checked.ok) return { ok: false, error: checked.error };

  const { data, error } = await getOnboardingDb()
    .from("orch_salespeople")
    .insert({
      name: clean,
      email: email.trim() || null,
      role,
      photo_url: checked.value,
      active: true,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id as string };
}

export async function updatePerson(
  id: string,
  patch: { name?: string; email?: string; photo?: string | null; active?: boolean; role?: PersonRole },
): Promise<{ ok: boolean; error?: string }> {
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "name cannot be empty" };
    clean.name = patch.name.trim();
  }
  if (patch.email !== undefined) clean.email = patch.email.trim() || null;
  if (patch.active !== undefined) clean.active = patch.active;
  if (patch.role !== undefined) {
    if (!isRole(patch.role)) return { ok: false, error: "unknown role" };
    clean.role = patch.role;
  }
  if (patch.photo !== undefined) {
    const checked = validatePhoto(patch.photo);
    if (!checked.ok) return { ok: false, error: checked.error };
    clean.photo_url = checked.value;
  }
  if (!Object.keys(clean).length) return { ok: true };

  const { error } = await getOnboardingDb().from("orch_salespeople").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Removing someone must never rewrite history: if any client is still assigned to
 * them we hide them from the pickers instead of deleting, so past assignments
 * keep their name.
 */
export async function deletePerson(id: string): Promise<{ ok: boolean; error?: string; hidden?: number }> {
  const db = getOnboardingDb();
  const [{ count: asSales }, { count: asAm }] = await Promise.all([
    db.from("orch_clients").select("id", { count: "exact", head: true }).eq("salesperson_id", id),
    db.from("orch_clients").select("id", { count: "exact", head: true }).eq("account_manager_id", id),
  ]);
  const used = (asSales ?? 0) + (asAm ?? 0);

  if (used > 0) {
    const { error } = await db.from("orch_salespeople").update({ active: false }).eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, hidden: used };
  }

  const { error } = await db.from("orch_salespeople").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, hidden: 0 };
}

/** Assign the account manager on a client. A label, like the salesperson — it runs nothing. */
export async function setClientAccountManager(
  clientId: string,
  personId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await getOnboardingDb()
    .from("orch_clients")
    .update({ account_manager_id: personId || null, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
