import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { ttlCache } from "@/lib/cache/ttl";

import { gatherCountReport } from "./status-readers";
import type { ExtraRow, SecondRow } from "./counts";

/*
 * ONE ANSWER TO "HOW MANY CLIENTS DO WE HAVE?"
 *
 * The client, 30 Sep: "the Database shows 50, Analytics 54 and 35 active,
 * Health 31 active". Every number was true of its own table — Analytics
 * counts ROWS, and it holds a second row for two clients with a second portal
 * plus two rows that are not clients at all. What differed was what was being
 * counted.
 *
 * So every tool's client screen in the OS now leads with the same line: the
 * master record's count and statuses, and — where the tool's table holds
 * more or fewer rows — exactly which rows and why. Built from the same
 * reconciliation the Consistency page uses, so the two can never disagree.
 */

export type CountedTool = "master_inbox" | "client_health" | "analytics" | "onboarding";

export interface ToolCount {
  rows: number;
  present: number;
  secondRows: SecondRow[];
  extras: ExtraRow[];
  absent: { name: string; status: string }[];
}

export interface ClientCounts {
  total: number;
  byStatus: Record<"onboarding" | "active" | "paused" | "churned", number>;
  tools: Partial<Record<CountedTool, ToolCount>>;
  unreadable: string[];
}

async function load(): Promise<ClientCounts> {
  const [{ data, error }, report] = await Promise.all([
    osTable("os_clients").select("status").limit(1000),
    gatherCountReport(),
  ]);
  if (error) throw new Error(error.message);
  const byStatus = { onboarding: 0, active: 0, paused: 0, churned: 0 };
  for (const r of (data ?? []) as unknown as { status: keyof typeof byStatus }[]) {
    if (r.status in byStatus) byStatus[r.status]++;
  }
  const tools: ClientCounts["tools"] = {};
  for (const t of report.tools) {
    if (t.tool !== "master_inbox" && t.tool !== "client_health" && t.tool !== "analytics" && t.tool !== "onboarding") continue;
    tools[t.tool] = {
      rows: t.toolRows, present: t.present, secondRows: t.secondRows, extras: t.extras,
      absent: t.absent.map((a) => ({ name: a.name, status: a.status })),
    };
  }
  return { total: (data ?? []).length, byStatus, tools, unreadable: report.unreadable };
}

export const getClientCounts = ttlCache(load, { ttlMs: 60_000, staleMs: 5 * 60_000, shared: "client-counts" });
