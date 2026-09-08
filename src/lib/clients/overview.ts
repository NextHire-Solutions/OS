import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { ROSTER, matchRoster, resolve, type CanonicalClient } from "./roster";

/*
 * One row per client, gathered from every tool.
 *
 * The roster is the spine: the workspace lists the 36 clients the business
 * has, and shows what each tool knows about them. A tool missing a client is a
 * gap in that tool, not a disagreement about who the clients are — which is
 * the whole point of having a canonical list.
 *
 * Every read is over a tool's own API, and every one may fail alone: a tool
 * being down costs its column, never the page.
 */

const TIMEOUT = 15_000;

export interface ClientRow {
  client: CanonicalClient;
  /** Client Health — the billed roster. */
  health: { present: boolean; plan: string | null; status: string | null; weeklyTarget: number | null };
  /** Master Inbox — introductions all time. */
  inbox: { present: boolean; intros: number | null; lastIntro: string | null };
  /** Campaign Analytics — attribution. */
  analytics: { present: boolean; campaigns: number | null; sent: number | null };
}

export interface ToolState {
  label: string;
  /** Rows the tool has that are not on the roster and are not known exemptions. */
  unknown: string[];
  /** Rows deliberately not clients, e.g. the demo portal. */
  exempt: { name: string; reason: string }[];
  unavailable: string | null;
}

export interface ClientsOverview {
  rows: ClientRow[];
  tools: Record<"health" | "inbox" | "analytics", ToolState>;
}

const rec = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function getClientsOverview(): Promise<ClientsOverview> {
  const [health, inbox, analytics] = await Promise.allSettled([
    readClientHealth(),
    readMasterInbox(),
    readAnalytics(),
  ]);

  const h = settled(health, "Client Health");
  const i = settled(inbox, "Master Inbox");
  const a = settled(analytics, "Campaign Analytics");

  const rows: ClientRow[] = ROSTER.map((client) => {
    const hr = h.byClient.get(client.name);
    const ir = i.byClient.get(client.name);
    const ar = a.byClient.get(client.name);

    return {
      client,
      health: {
        present: !!hr,
        plan: str(hr?.plan),
        // Derived the way the tool derives it: hidden wins over paused.
        status: hr
          ? hr.hidden === true ? "churned"
            : hr.client_paused === true ? "paused"
            : "active"
          : null,
        weeklyTarget: num(hr?.weekly_target),
      },
      inbox: {
        present: !!ir,
        intros: num(ir?.count),
        lastIntro: str(ir?.last_assigned_at),
      },
      analytics: {
        present: !!ar,
        campaigns: num(ar?.campaignCount),
        sent: num(ar?.sent),
      },
    };
  });

  return {
    rows,
    tools: {
      health: { label: "Client Health", unknown: h.unknown, exempt: h.exempt, unavailable: h.unavailable },
      inbox: { label: "Master Inbox", unknown: i.unknown, exempt: i.exempt, unavailable: i.unavailable },
      analytics: { label: "Campaign Analytics", unknown: a.unknown, exempt: a.exempt, unavailable: a.unavailable },
    },
  };
}

interface ToolRead {
  byClient: Map<string, Record<string, unknown>>;
  unknown: string[];
  exempt: { name: string; reason: string }[];
  unavailable: string | null;
}

function settled(outcome: PromiseSettledResult<ToolRead>, label: string): ToolRead {
  if (outcome.status === "fulfilled") return outcome.value;
  return {
    byClient: new Map(),
    unknown: [],
    exempt: [],
    unavailable:
      outcome.reason instanceof Error ? outcome.reason.message : `${label} unavailable`,
  };
}

/** Indexes a tool's rows by the canonical client each one refers to. */
function index(rows: Record<string, unknown>[], nameField: string): ToolRead {
  const byClient = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const name = str(row[nameField]);
    if (!name) continue;
    const client = resolve(name);
    // First row wins. A tool holding two rows for one client is itself a
    // finding, and surfaces as a duplicate in the Consistency screen rather
    // than being silently merged here.
    if (client && !byClient.has(client.name)) byClient.set(client.name, row);
  }
  const match = matchRoster(rows.flatMap((r) => (str(r[nameField]) ? [str(r[nameField])!] : [])));
  return { byClient, unknown: match.unknown, exempt: match.exempt, unavailable: null };
}

async function readClientHealth(): Promise<ToolRead> {
  const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
  if (!token) throw new Error("CLIENT_HEALTH_READ_TOKEN not set");
  const res = await httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}/api/clients`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });
  if (!res.ok) throw new Error(`returned ${res.status ?? "no response"}`);
  const clients = rec(res.json)?.clients;
  if (!Array.isArray(clients)) throw new Error("unexpected shape");
  return index(clients as Record<string, unknown>[], "name");
}

async function readMasterInbox(): Promise<ToolRead> {
  const token = optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
  if (!token) throw new Error("MASTER_INBOX_ADMIN_TOKEN not set");
  const res = await httpProbe(`${baseUrlEnv("MASTER_INBOX_URL")}/api/clients/intro-stats`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });
  if (res.status === 307 || res.status === 302) throw new Error("token rejected");
  if (!res.ok) throw new Error(`returned ${res.status ?? "no response"}`);
  const stats = rec(res.json)?.stats;
  if (!Array.isArray(stats)) throw new Error("unexpected shape");
  return index(stats as Record<string, unknown>[], "client_name");
}

async function readAnalytics(): Promise<ToolRead> {
  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
  const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
  const token = await mintAnalyticsSession(secret, email);
  const res = await httpProbe(`${baseUrlEnv("ANALYTICS_URL")}/api/clients`, {
    timeoutMs: TIMEOUT,
    headers: { cookie: `bsa_session=${token}` },
  });
  if (!res.ok) throw new Error(`returned ${res.status ?? "no response"}`);
  const body = res.json;
  const rows = Array.isArray(body) ? body : rec(body)?.clients ?? rec(body)?.rows;
  if (!Array.isArray(rows)) throw new Error("unexpected shape");
  return index(rows as Record<string, unknown>[], "name");
}
