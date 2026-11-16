import "server-only";

import { getAccountBilling } from "@/lib/clients/billing-account";
import { ttlCache } from "@/lib/cache/ttl";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "@/lib/tools/assistant/read-only";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

import { listPeriods, loadSettings, periodLeads } from "@/lib/clients/usage-billing/billing";
import { easternDay, modeOf, type SettingsRow } from "@/lib/clients/usage-billing/model";

import { BILLING_REFUSAL, invoiceScope } from "./billing-pick";
import { perLeadPeriods, startsToCount, type PerLeadPeriod } from "./billing-per-lead";
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
  /** `manage`: false when "Manage billing" can't open (a payment method shared with another client — 17 Nov). */
  | { ok: true; periods: BillingPeriod[]; portals: number; manage: boolean }
  /** A client billed per lead, live (16 Nov): its pay-per-lead periods and the leads billed in each (billing-per-lead.ts). */
  | { ok: true; kind: "per-lead"; periods: PerLeadPeriod[]; portals: number }
  | { ok: false; reason: string };

/**
 * A live pay-per-lead client's periods: charged ones as charged; the rest counted as the Billing tab counts them, each
 * on its own (one that can't be counted shows a dash, never the page an error). Kept two minutes per client: a count
 * reads Master Inbox's label history, and the page is opened and reopened.
 */
const perLeadPage = ttlCache(
  async (osClientId: string, s: SettingsRow, today: string, portals: number): Promise<BillingPage> => {
    const records = await listPeriods(osClientId, 52, false);
    const shape = { anchor: s.anchor_date, everyDays: s.every_days, today, records };
    const counts = new Map<string, number | null>();
    await Promise.all(
      startsToCount(shape).map(async (start) => {
        try {
          counts.set(start, (await periodLeads(osClientId, s, start)).leads.length);
        } catch (err) {
          console.error(`[crm-preview] billing: leads for ${osClientId} from ${start}`, err instanceof Error ? err.message : err);
          counts.set(start, null);
        }
      }),
    );
    return { ok: true, kind: "per-lead", periods: perLeadPeriods({ ...shape, counts }), portals };
  },
  { ttlMs: 2 * 60_000, key: (osClientId, s, today, portals) => `${osClientId}:${s.updated_at ?? ""}:${today}:${portals}`, shared: "crm-preview-per-lead-billing" },
);

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

  // Every portal of this client — one billing covers them all.
  const mine = portals.filter((p) => clientForPortal({ id: p.id, name: p.name ?? "" }, records)?.id === record.id).map((p) => p.id);

  // Billed per lead (live): its own periods, not a subscription's. A test row bills no one, so it is not this client's
  // billing. Settings that can't be read leave a subscription client's page as it was, never an error.
  const perLead = await loadSettings(record.id).catch((err) => {
    console.error(`[crm-preview] billing: pay-per-lead settings for ${record.id}`, err instanceof Error ? err.message : err);
    return null;
  });
  if (perLead && modeOf(perLead) === "live") return perLeadPage(record.id, perLead, easternDay(now), mine.length);

  const { byClient, snapshot } = await getAccountBilling();
  // The customer, when it is the client's alone; on a shared one, only the client's own subscriptions (billing-pick.ts).
  const scope = invoiceScope(byClient.get(record.id), byClient.values());
  if (!scope.ok) return { ok: false, reason: BILLING_REFUSAL[scope.reason] };

  const entries = await fetchAllRows<{ source: string | null; introduced_at: string | null }>(({ from, to }) =>
    mi().from("client_pipeline_entries").select("id, source, introduced_at").in("client_id", mine).order("id").range(from, to),
  );
  const own = scope.manage ? null : new Set(scope.subscriptions);
  const invoices = snapshot.invoices.filter((i) => (own ? i.subscription !== null && own.has(i.subscription) : i.customer === (scope as { customer: string }).customer));
  return { ok: true, periods: introductionsByPeriod(invoices, entries, now), portals: mine.length, manage: scope.manage };
}
