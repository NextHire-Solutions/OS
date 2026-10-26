import "server-only";

import { analyticsRead } from "@/lib/tools/analytics/in-process";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { lifecycleOf, listClientRows } from "@/lib/tools/client-health/publish";
import type { NamedEntry } from "./names";
import { isPlaceholder } from "./placeholder";
import { isKnownNonClient, nonClientReason } from "@/lib/clients/roster";

/*
 * Each tool's client list, by name.
 *
 * The totals view answers "how many?" and stops there — 57 against 41 tells
 * you something is wrong and nothing about what. This answers "which ones?",
 * which is the only form anyone can act on.
 *
 * Every list is fetched over the tool's ordinary HTTP API. There is no database
 * connection in this app, so this can read and never write.
 */

const TIMEOUT = 12_000;

export interface Roster {
  tool: string;
  label: string;
  /** What this list actually contains — shown beside the diff, never assumed. */
  definition: string;
  entries: NamedEntry[];
  /** Placeholder rows removed before comparing. Reported, never silent. */
  excluded?: string[];
  unavailable?: string;
}

/*
 * Rows that are buckets rather than clients.
 *
 * Analytics carries an "Unassigned" row for campaigns matching no client, and
 * Master Inbox a "Unknown" one for replies it could not attribute. Neither is
 * a customer, and comparing them produces a difference that is real, permanent
 * and useless — the exact kind of entry that trains people to skim past the
 * list and miss the twenty-seven that matter.
 *
 * Matched loosely because these are display names and get retitled. Removed
 * rows are reported on the roster, so this can never quietly hide a real one.
 */

function withoutPlaceholders(entries: NamedEntry[]): {
  entries: NamedEntry[];
  excluded: string[];
} {
  const excluded: string[] = [];
  const kept = entries.filter((e) => {
    /*
     * Two kinds of non-customer, both excluded and both reported.
     *
     * A PLACEHOLDER is a bucket row whose name is the bucket word —
     * "Unassigned", "Unknown". A KNOWN NON-CLIENT is a named row that is
     * real but is not a customer, and roster.ts carries the reason for each:
     * "Demo Portal — backs the live demo client portal, keep".
     *
     * Before this, only the first was excluded, so "Test FUB", "Demo Portal",
     * "New client portal" and "ZZ Portal Delete Test ..." were reported as
     * genuine client differences on every comparison the screen drew — four
     * rows of permanent noise in a panel whose value is being quiet.
     */
    if (isPlaceholder(e.name) || isKnownNonClient(e.name)) {
      const why = nonClientReason(e.name);
      excluded.push(why ? `${e.name} (${why})` : e.name);
      return false;
    }
    return true;
  });
  return { entries: kept, excluded };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Master Inbox — every client replies can be tagged against. */
async function masterInbox(): Promise<Roster> {
  const base: Omit<Roster, "entries" | "unavailable"> = {
    tool: "inbox",
    label: "Master Inbox",
    definition:
      "Every client in the workspace, including those with no introductions yet. A client appears here once someone creates it, and stays after it goes quiet.",
  };

  const token = optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
  if (!token) return { ...base, entries: [], unavailable: "MASTER_INBOX_ADMIN_TOKEN not set" };

  const res = await httpProbe(`${baseUrlEnv("MASTER_INBOX_URL")}/api/clients/intro-stats`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });
  if (res.status === 307 || res.status === 302) {
    return { ...base, entries: [], unavailable: "token rejected — redirected to login" };
  }
  if (!res.ok) return { ...base, entries: [], unavailable: `returned ${res.status ?? "no response"}` };

  const stats = asRecord(res.json)?.stats;
  if (!Array.isArray(stats)) return { ...base, entries: [], unavailable: "unexpected response shape" };

  return {
    ...base,
    ...withoutPlaceholders(stats.flatMap((raw) => {
      const row = asRecord(raw);
      const name = str(row?.client_name);
      if (!name) return [];
      return [{
        name,
        meta: {
          intros: typeof row?.count === "number" ? row.count : 0,
          lastIntro: str(row?.last_assigned_at),
        },
      }];
    })),
  };
}

/**
 * Analytics — every client set up for campaign attribution.
 *
 * Its own clients table (27 Oct). This used to read the Clients REPORT
 * (/api/analytics/clients), which lists only the clients with campaign
 * activity in the default date range — 32 of 54 that day — so the card read
 * "32" while every client had a row (the count table proved 54 of 54). The
 * report's figures are kept as each entry's detail when it answers.
 */
async function analytics(): Promise<Roster> {
  const base: Omit<Roster, "entries" | "unavailable"> = {
    tool: "analytics",
    label: "Campaign Analytics",
    definition:
      "Every client set up for campaign attribution — since 28 Sep, every client, whether or not it has campaigns.",
  };

  let rows: { id: string; name: string | null }[];
  try {
    const { data, error } = await getAnalyticsSupabase().from("clients").select("id, name").limit(1000);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as { id: string; name: string | null }[];
  } catch (error) {
    return { ...base, entries: [], unavailable: error instanceof Error ? error.message : "Analytics is unreachable" };
  }

  // Campaign figures for the default range — detail only; a client without activity simply has none.
  const figures = new Map<string, { campaigns: number | null; sent: number | null }>();
  const res = await analyticsRead("/api/analytics/clients").catch(() => null);
  const reportRows = res?.ok ? asRecord(res.json)?.rows : null;
  if (Array.isArray(reportRows)) {
    for (const raw of reportRows) {
      const row = asRecord(raw);
      const name = str(row?.name);
      if (!name) continue;
      figures.set(name.toLowerCase(), {
        campaigns: typeof row?.campaignCount === "number" ? row.campaignCount : null,
        sent: typeof row?.sent === "number" ? row.sent : null,
      });
    }
  }

  return {
    ...base,
    ...withoutPlaceholders(rows.flatMap((row) => {
      const name = str(row.name);
      if (!name) return [];
      return [{ name, meta: figures.get(name.toLowerCase()) ?? { campaigns: 0, sent: 0 } }];
    })),
  };
}

/** Client Health — the billed roster. */
async function clientHealth(): Promise<Roster> {
  const base: Omit<Roster, "entries" | "unavailable"> = {
    tool: "clients",
    label: "Client Health",
    definition:
      "The billed roster: clients someone onboarded here, each with a plan and a weekly target. Hidden and paused clients are included.",
  };

  // Client Health's own database, through the workspace's loader — the same
  // rows its GET /api/clients returned. The tool is being switched off, and
  // this roster must not go with it.
  let clients: Record<string, unknown>[];
  try {
    clients = await listClientRows();
  } catch (error) {
    return {
      ...base,
      entries: [],
      unavailable: error instanceof Error ? error.message : "Client Health is unreachable",
    };
  }

  return {
    ...base,
    ...withoutPlaceholders(clients.flatMap((raw) => {
      const row = asRecord(raw);
      const name = str(row?.name);
      if (!name) return [];
      return [{
        name,
        meta: {
          plan: str(row?.plan),
          // The status column, not the booleans: they cannot say "onboarding",
          // so every onboarding client showed as a conflict (active vs onboarding).
          status: lifecycleOf(row ?? {}),
        },
      }];
    })),
  };
}

/**
 * All three, in parallel.
 *
 * `allSettled` because one tool having a bad day must cost that one roster,
 * never the comparison between the other two.
 */
export async function fetchRosters(): Promise<Roster[]> {
  const settled = await Promise.allSettled([masterInbox(), analytics(), clientHealth()]);
  const labels = [
    { tool: "inbox", label: "Master Inbox" },
    { tool: "analytics", label: "Campaign Analytics" },
    { tool: "clients", label: "Client Health" },
  ];

  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          ...labels[i],
          definition: "",
          entries: [],
          unavailable:
            outcome.reason instanceof Error ? outcome.reason.message : "read failed",
        },
  );
}
