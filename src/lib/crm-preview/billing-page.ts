import "server-only";

import { getAccountBilling } from "@/lib/clients/billing-account";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "@/lib/tools/assistant/read-only";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

import { BILLING_REFUSAL, pickBillingCustomer } from "./billing-pick";
import { introductionsByPeriod, type BillingPeriod } from "./billing-periods";
import { clientForPortal, type OsClientRow } from "./market-model";

/*
 * The portal's Billing page (22 Oct): the client's billing periods and our
 * introductions in each. Read-only. The billing is the CLIENT's (one
 * subscription may cover several portals), so introductions are counted
 * across every portal of the client; the customer is the client's own
 * (billing-pick.ts — never one another client shares), as for the Billing
 * link.
 */

const mi = () => readOnly(createAdminSupabase());

export type BillingPage =
  | { ok: true; periods: BillingPeriod[]; portals: number }
  | { ok: false; reason: string };

export async function portalBillingPage(portalId: string, now: Date): Promise<BillingPage | null> {
  const [{ data: portalRows, error: pErr }, { data: osRows, error: oErr }] = await Promise.all([
    mi().from("clients").select("id, name, slug, portal_token"),
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id"),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (oErr) throw new Error(oErr.message);
  const portals = ((portalRows ?? []) as Array<{ id: string; name: string | null; slug: string | null; portal_token: string | null }>).filter((p) => p.slug !== "unknown" && p.portal_token);
  const records = (osRows ?? []) as unknown as OsClientRow[];
  const portal = portals.find((p) => p.id === portalId);
  if (!portal) return null;
  const record = clientForPortal({ id: portal.id, name: portal.name ?? "" }, records);
  if (!record) return { ok: false, reason: "This portal has no client record, so there is no billing to show." };

  const { byClient, snapshot } = await getAccountBilling();
  const pick = pickBillingCustomer(byClient.get(record.id), byClient.values());
  if (!pick.ok) return { ok: false, reason: BILLING_REFUSAL[pick.reason] };

  // Every portal of this client — the subscription pays for all of them.
  const mine = portals.filter((p) => clientForPortal({ id: p.id, name: p.name ?? "" }, records)?.id === record.id).map((p) => p.id);
  const entries = await fetchAllRows<{ source: string | null; introduced_at: string | null }>(({ from, to }) =>
    mi().from("client_pipeline_entries").select("id, source, introduced_at").in("client_id", mine).order("id").range(from, to),
  );
  const invoices = snapshot.invoices.filter((i) => i.customer === pick.customer);
  return { ok: true, periods: introductionsByPeriod(invoices, entries, now), portals: mine.length };
}
