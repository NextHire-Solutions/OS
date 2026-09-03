import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import type { NamedEntry } from "./names";

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
  unavailable?: string;
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
    entries: stats.flatMap((raw) => {
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
    }),
  };
}

/** Analytics — clients configured for campaign attribution. */
async function analytics(): Promise<Roster> {
  const base: Omit<Roster, "entries" | "unavailable"> = {
    tool: "analytics",
    label: "Campaign Analytics",
    definition:
      "Clients created to match campaign names. A client exists here only once someone set it up for attribution, so one with no campaigns is usually absent.",
  };

  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) return { ...base, entries: [], unavailable: "ANALYTICS_AUTH_SECRET not set" };

  const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
  const token = await mintAnalyticsSession(secret, email);

  const res = await httpProbe(`${baseUrlEnv("ANALYTICS_URL")}/api/analytics/clients`, {
    timeoutMs: TIMEOUT,
    headers: { cookie: `bsa_session=${token}` },
  });
  if (!res.ok) return { ...base, entries: [], unavailable: `returned ${res.status ?? "no response"}` };

  const rows = asRecord(res.json)?.rows;
  if (!Array.isArray(rows)) return { ...base, entries: [], unavailable: "unexpected response shape" };

  return {
    ...base,
    entries: rows.flatMap((raw) => {
      const row = asRecord(raw);
      const name = str(row?.name);
      if (!name) return [];
      return [{
        name,
        meta: {
          campaigns: typeof row?.campaignCount === "number" ? row.campaignCount : null,
          sent: typeof row?.sent === "number" ? row.sent : null,
        },
      }];
    }),
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

  const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
  const res = await httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}/api/clients`, {
    timeoutMs: TIMEOUT,
    headers: token ? { "x-admin-token": token } : {},
  });

  if (res.status === 401) {
    return {
      ...base,
      entries: [],
      // Names the fix precisely: this route only started refusing tokens when
      // the team password went on, and the patch that reopens it is written.
      unavailable: token
        ? "401 — token rejected"
        : "401 — needs CLIENT_HEALTH_READ_TOKEN, and the /api/clients auth patch applied",
    };
  }
  if (!res.ok) return { ...base, entries: [], unavailable: `returned ${res.status ?? "no response"}` };

  const clients = asRecord(res.json)?.clients;
  if (!Array.isArray(clients)) return { ...base, entries: [], unavailable: "unexpected response shape" };

  return {
    ...base,
    entries: clients.flatMap((raw) => {
      const row = asRecord(raw);
      const name = str(row?.name);
      if (!name) return [];
      return [{
        name,
        meta: {
          plan: str(row?.plan),
          status: row?.hidden ? "churned" : row?.client_paused ? "paused" : "active",
        },
      }];
    }),
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
