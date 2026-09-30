import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";

import { isEnvAccount } from "./admin";
import { adminsChanged, isOwner } from "./admin-db";
import { cleanName } from "./salesperson-match";
import { updateSalesperson } from "./salespeople";

/*
 * TEAM ROLES — edited on Team access, one person at a time (30 Sep).
 *
 *   Admin            os_users.is_admin (0021)
 *   Account Manager  os_users.is_account_manager (0021)
 *   Salesperson      an active os_salespeople row carrying the person's email
 *                    (0020). Kept there, not as a flag, so a salesperson who
 *                    was on the list before they had a sign-in (Ryan Jagdeo,
 *                    Scott Craigue) keeps their clients and rates when invited:
 *                    the invite links the existing record rather than making
 *                    a second one.
 */

export class TeamRoleError extends Error {
  constructor(message: string) { super(message); this.name = "TeamRoleError"; }
}

const MIGRATION = "Roles need migrations/0021_team_roles.sql run in the Master Inbox Supabase project.";
const missingColumn = (m: string) => /column .* does not exist|schema cache/i.test(m);

type SpRow = { id: string; name: string; email: string | null; active: boolean };

/** Salesperson records: by linked email, and those nobody has been invited for yet. */
export async function salespersonRecords(): Promise<{ byEmail: Map<string, SpRow>; notInvited: SpRow[] }> {
  const { data, error } = await osTable("os_salespeople").select("id, name, email, active").order("name");
  if (error) return { byEmail: new Map(), notInvited: [] };
  const rows = (data ?? []) as unknown as SpRow[];
  const byEmail = new Map<string, SpRow>();
  for (const r of rows) if (r.email) byEmail.set(r.email.toLowerCase(), r);
  return { byEmail, notInvited: rows.filter((r) => !r.email && r.active) };
}

async function setFlag(email: string, column: "is_admin" | "is_account_manager", on: boolean): Promise<void> {
  const { data, error } = await osTable("os_users").update({ [column]: on }).eq("email", email).select("email");
  if (error) throw new TeamRoleError(missingColumn(error.message) ? MIGRATION : error.message);
  if (!data?.length) throw new TeamRoleError(`${email} is not an invited team member.`);
  if (column === "is_admin") adminsChanged();
}

export const setAdmin = (email: string, on: boolean) => setFlag(email, "is_admin", on);
export const setAccountManager = (email: string, on: boolean) => setFlag(email, "is_account_manager", on);

/**
 * Make someone a salesperson, or stop. On: their own record if they have one,
 * else the uninvited record they were invited for (`linkId`), else one with
 * the same name and no sign-in yet, else a new one. Off: the record goes
 * inactive — their clients keep the name, and turning it back on restores it.
 */
export async function setSalesperson(person: { email: string; name: string | null }, on: boolean, linkId?: string | null, by = "team-access"): Promise<void> {
  const email = person.email.toLowerCase();
  const { data, error } = await osTable("os_salespeople").select("id, name, email, active");
  if (error) throw new TeamRoleError("The salesperson list needs migrations/0020_salespeople.sql.");
  const rows = (data ?? []) as unknown as SpRow[];
  const own = rows.find((r) => r.email?.toLowerCase() === email);
  const now = new Date().toISOString();
  if (!on) {
    if (own && own.active) await osTable("os_salespeople").update({ active: false, updated_at: now, updated_by: by }).eq("id", own.id);
    return;
  }
  if (own) {
    if (!own.active) await osTable("os_salespeople").update({ active: true, updated_at: now, updated_by: by }).eq("id", own.id);
    return;
  }
  const name = cleanName(person.name ?? email.split("@")[0]);
  const target = (linkId && rows.find((r) => r.id === linkId && !r.email))
    ?? rows.find((r) => !r.email && r.name.toLowerCase() === name.toLowerCase());
  if (target) {
    const { error: e } = await osTable("os_salespeople").update({ email, active: true, updated_at: now, updated_by: by }).eq("id", target.id);
    if (e) throw new TeamRoleError(e.message);
    return;
  }
  const { error: e } = await osTable("os_salespeople").insert({ name, email, updated_at: now, updated_by: by });
  if (e) throw new TeamRoleError(/duplicate|unique/i.test(e.message) ? `A salesperson called “${name}” already exists with another sign-in.` : e.message);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Rename a team member everywhere their name is written: their sign-in, the
 * clients they manage (os_clients.account_manager), Onboarding's copy of them,
 * and — through the salesperson rename — the clients they sold.
 */
export async function renameMember(email: string, oldName: string | null, newName: string, by: string): Promise<{ clients: number }> {
  const name = cleanName(newName);
  if (!name) throw new TeamRoleError("A name is required.");
  if (name.includes(",")) throw new TeamRoleError("A name cannot contain a comma.");
  const { error } = await osTable("os_users").update({ name }).eq("email", email);
  if (error) throw new TeamRoleError(error.message);
  let clients = 0;
  if (oldName && oldName !== name) {
    const { data: moved, error: mErr } = await osTable("os_clients")
      .update({ account_manager: name, updated_at: new Date().toISOString() })
      .ilike("account_manager", escapeLike(oldName)).select("id");
    if (mErr) throw new TeamRoleError(`Renamed, but their clients still say “${oldName}”: ${mErr.message}`);
    clients += (moved ?? []).length;
    const { error: oErr } = await getOnboardingDb().from("orch_salespeople")
      .update({ name }).ilike("name", escapeLike(oldName)).eq("role", "account_manager");
    if (oErr) console.error("[team-roles] Onboarding rename failed:", oErr.message);
  }
  const { byEmail } = await salespersonRecords();
  const sp = byEmail.get(email.toLowerCase());
  if (sp && sp.name !== name) clients += (await updateSalesperson(sp.id, { name }, by)).clientsRenamed;
  return { clients };
}

/**
 * Change someone's sign-in email. Everything keyed by it moves with it —
 * their tool access, their salesperson record and their commission rates —
 * and their sessions end, so they sign in again with the new address.
 */
export async function changeEmail(from: string, to: string): Promise<void> {
  const a = from.toLowerCase(), b = to.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b)) throw new TeamRoleError("Enter a valid email address.");
  if (a === b) return;
  // An Owner (ADMIN_EMAILS) or an AUTH_USERS address may have no os_users row
  // — the Owner here does not. Moving a member onto that address would hand
  // the member's password the Owner's sign-in and standing.
  if (isOwner(b) || isEnvAccount(b)) throw new TeamRoleError(`${b} is an Owner or Railway-managed account and cannot be taken.`);
  const { data: clash } = await osTable("os_users").select("email").eq("email", b).maybeSingle();
  if (clash) throw new TeamRoleError(`${b} already has an account.`);
  const { data: me, error: rErr } = await osTable("os_users").select("token_version").eq("email", a).maybeSingle();
  if (rErr || !me) throw new TeamRoleError(`${a} is not an invited team member.`);
  const ver = Number((me as { token_version?: number }).token_version ?? 1) + 1;
  const { error } = await osTable("os_users").update({ email: b, token_version: ver }).eq("email", a);
  if (error) throw new TeamRoleError(error.message);
  // Best effort after the sign-in moved: each keyed row follows.
  await osTable("os_tool_grants").update({ email: b }).eq("email", a);
  await osTable("os_salespeople").update({ email: b }).eq("email", a);
  await osTable("os_commission_reps").update({ email: b }).eq("email", a);
  adminsChanged();
}
