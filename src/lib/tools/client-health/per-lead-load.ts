import "server-only";

import { perLeadClients } from "@/lib/clients/usage-billing/caps";
import { easternDay, modeOf } from "@/lib/clients/usage-billing/model.ts";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import type { PerLead } from "./per-lead.ts";

/*
 * The clients billed per lead, keyed by their Client Health row id, with the Billing tab's own facts and leads
 * (per-lead.ts says why). Shared by Client Health's screens and the master record, so the two show one number.
 *
 * Cached like Client Health's own read: a minute, then served stale for five while it refreshes; the master client
 * list's four-minute warm-up keeps it filled, and a Billing tab change clears it (usage route). Throws only when
 * nobody's pay per lead can be read at all; one client's unreadable leads are that client's `error`.
 */
async function load(): Promise<Map<string, PerLead>> {
  const out = new Map<string, PerLead>();
  for (const r of await perLeadClients()) {
    if (!r.chClientId) continue;
    out.set(r.chClientId, {
      anchor: r.settings.anchor_date,
      everyDays: r.settings.every_days === 7 ? 7 : 14,
      priceCents: r.settings.price_cents,
      spendCapCents: r.spendCapCents,
      live: modeOf(r.settings) === "live",
      leads: r.leads
        ? r.leads.map((l) => ({ day: easternDay(l.at), at: l.at })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        : null,
      countedFrom: r.countedFrom,
      error: r.error,
    });
  }
  return out;
}

export const perLeadByHealthId = ttlCache(load, {
  ttlMs: 60_000,
  staleMs: 5 * 60_000,
  // Each client's windows are read in parallel; a cold read can take several seconds and must still be kept.
  inflightTimeoutMs: 60_000,
  shared: "client-health-per-lead",
});
