import "server-only";

import { osTable } from "./os-db";
import { getCoverage, setCoverage } from "./coverage-db";
import { codesToColumn, columnToCodes, deriveCodesFromList, type Board, type Derived } from "./markets-mls";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";

/*
 * Keeps orch_clients.mls in step with the master record's Markets. Why the
 * Markets are the one editor, and what "derived" means: markets-mls.ts.
 */

export async function mlsBoardsList(): Promise<Board[]> {
  const { data, error } = await getOnboardingDb().from("mls").select("code, name, state").limit(1000);
  if (error) throw new Error(`MLS boards: ${error.message}`);
  return ((data ?? []) as Board[]).filter((b) => b.code?.trim());
}

async function orchIdOf(masterId: string): Promise<string | null> {
  const { data, error } = await osTable("os_clients").select("orch_client_id").eq("id", masterId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { orch_client_id?: string | null } | null)?.orch_client_id) ?? null;
}

export interface MlsSync extends Derived {
  /** False when the client has no Database row to write to. */
  linked: boolean;
  /** Whether orch_clients.mls actually changed. */
  written: boolean;
}

/**
 * The MLS list changed: rewrite the Database row's codes from it. The master
 * wins outright — clearing a client's MLS clears the codes, because that is
 * what the person just did.
 */
export async function syncDatabaseMls(masterId: string): Promise<MlsSync> {
  const orchId = await orchIdOf(masterId);
  const coverage = await getCoverage(masterId);
  const derived = deriveCodesFromList(coverage.mls, await mlsBoardsList());
  if (!orchId) return { ...derived, linked: false, written: false };
  const db = getOnboardingDb();
  const { data, error } = await db.from("orch_clients").select("mls").eq("id", orchId).maybeSingle();
  if (error) throw new Error(error.message);
  const next = codesToColumn(derived.codes);
  const current = codesToColumn(columnToCodes((data as { mls?: string | null } | null)?.mls));
  if (current === next) return { ...derived, linked: true, written: false };
  const { error: e } = await db.from("orch_clients").update({ mls: next, updated_at: new Date().toISOString() }).eq("id", orchId);
  if (e) throw new Error(e.message);
  return { ...derived, linked: true, written: true };
}

/**
 * Onboarding just linked this client to its Database row. If the row arrived
 * with boards from the intake form and the master has no MLS yet, those
 * boards become its MLS. Never touches a client that already has MLS.
 */
export async function seedMarketsFromDatabase(masterId: string): Promise<number> {
  const orchId = await orchIdOf(masterId);
  if (!orchId) return 0;
  const coverage = await getCoverage(masterId);
  if (coverage.mls.length) return 0;
  const { data, error } = await getOnboardingDb().from("orch_clients").select("mls").eq("id", orchId).maybeSingle();
  if (error) throw new Error(error.message);
  const codes = columnToCodes((data as { mls?: string | null } | null)?.mls);
  if (!codes.length) return 0;
  await setCoverage(masterId, { mls: codes });
  return codes.length;
}
