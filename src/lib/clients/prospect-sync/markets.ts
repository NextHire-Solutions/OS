import { osTable } from "@/lib/clients/os-db";
import { resolveMls, type MlsRow } from "@/lib/crm-preview/market-model";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

/*
 * A client's MLSs as the portal resolves them (crm-preview market-model resolveMls: the client record's codes matched to
 * the agent database's MLSs, by code or alias), in the client's order — the markets its Prospects campaigns are picked
 * for when it has several (the user, 3 Nov). Reads only.
 */
export async function clientMarkets(osClientId: string): Promise<Array<{ code: string; name: string }>> {
  const { data, error } = await osTable("os_clients").select("mls_codes").eq("id", osClientId).maybeSingle();
  if (error) throw new Error(`os_clients: ${error.message}`);
  const codes = Array.isArray((data as { mls_codes?: unknown } | null)?.mls_codes) ? ((data as { mls_codes: unknown[] }).mls_codes).map(String).filter(Boolean) : [];
  if (!codes.length) return [];
  const rows = await getCorofySupabase().from("mls").select("id, code, name, aliases");
  if (rows.error) throw new Error(`mls: ${rows.error.message}`);
  return resolveMls(codes, (rows.data ?? []) as MlsRow[]).matched;
}
