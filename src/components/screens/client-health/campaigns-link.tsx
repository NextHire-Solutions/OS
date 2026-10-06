"use client";

import type { DashboardClient } from "@/lib/tools/client-health/types";

/*
 * One click from a Client Health row to THAT client's campaigns in Campaign
 * Analytics (client ask, 6 Oct). Filtered by the client's Analytics id; a
 * client not linked there falls back to its own campaign ids, so the link
 * still opens just its campaigns.
 */
export function campaignsHref(c: Pick<DashboardClient, "analytics_client_id" | "campaigns" | "bisonCampaigns">): string | null {
  const q = new URLSearchParams({ view: "campaigns", preset: "30d" });
  if (c.analytics_client_id) {
    q.set("client_ids", c.analytics_client_id);
  } else {
    const ids = [...(c.bisonCampaigns ?? []).map((x) => x.id), ...(c.campaigns ?? []).map((x) => x.id)].filter(Boolean);
    if (!ids.length) return null;
    q.set("campaign_ids", ids.join(","));
  }
  return `/analytics?${q.toString()}`;
}

/** The client's name, linking to its campaigns. Plain text when it has none to show. */
export function ClientCampaignsName({ client, className }: { client: DashboardClient; className?: string }) {
  const href = campaignsHref(client);
  if (!href) return <span className={className}>{client.name}</span>;
  return (
    <a className={`${className ?? ""} ds-name-link`} href={href}
      title={`Open ${client.name}’s campaigns in Campaign Analytics`}>
      {client.name}
    </a>
  );
}
