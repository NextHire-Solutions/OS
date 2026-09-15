import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { listClientRows } from "@/lib/tools/client-health/publish";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { ROSTER, matchRoster, type CanonicalClient } from "./roster";
import { indexByName, pickFor, keysForClient } from "./tool-index";
import { keyOf } from "./roster";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { publicPortalUrl } from "@/lib/tools/master-inbox/portals/public-url";
import { listOsClients, type OsClient } from "./os-clients";
import { type ClientStatus } from "./client-status";

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
  /*
   * The stored client: its id, the status the business set, and whether it
   * exists in the Onboarding tool. Null only when `os_clients` could not be
   * read — the page then falls back to the code roster rather than going
   * blank, which is the same rule every other column follows.
   */
  os: {
    id: string | null;
    status: ClientStatus;
    /** Onboarding is read from the stored link, not by name-matching again. */
    inOnboarding: boolean;
    /*
     * The introduction details, so Edit opens prefilled and the roster can
     * show at a glance which clients an agent can be introduced to. All null
     * for a client nobody has filled them in for.
     */
    contact: { name: string | null; role: string | null; email: string | null; brokerage: string | null };
  };
  /** Client Health — the billed roster. */
  /** The client's live portal, or null when it has none. */
  portalUrl: string | null;
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
  /*
   * Whether the canonical list came from the database or from the code roster.
   * Shown on screen: a page silently serving the fallback would hide the fact
   * that status edits are not being saved.
   */
  source: "os_clients" | "roster";
  sourceNote: string | null;
}

const rec = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function getClientsOverview(): Promise<ClientsOverview> {
  const [health, inbox, analytics, stored, portals] = await Promise.allSettled([
    readClientHealth(),
    readMasterInbox(),
    readAnalytics(),
    listOsClients(),
    readPortalTokens(),
  ]);
  const portalByKey: Map<string, string> =
    portals.status === "fulfilled" ? portals.value : new Map();

  const h = settled(health, "Client Health");
  const i = settled(inbox, "Master Inbox");
  const a = settled(analytics, "Campaign Analytics");

  /*
   * The spine: the stored list when it has rows, the code roster otherwise.
   *
   * The fallback matters. Before `os_clients` is seeded — and if the database
   * is ever unreachable — the page must still list the business's clients
   * rather than show nothing, so the roster remains a working default. What it
   * cannot do is pretend: `source` says which one is in use, because status
   * edits only persist against the stored list.
   */
  const osRows: OsClient[] = stored.status === "fulfilled" ? stored.value : [];
  const useStored = osRows.length > 0;
  const sourceNote = stored.status === "rejected"
    ? (stored.reason instanceof Error ? stored.reason.message : "os_clients unavailable")
    : !useStored
      ? "os_clients is empty — showing the code roster until it is seeded"
      : null;

  const osByName = new Map(osRows.map((r) => [r.name, r]));
  const spine: CanonicalClient[] = useStored
    ? osRows.map((r) => ({ name: r.name, aliases: r.aliases }))
    : [...ROSTER];

  const rows: ClientRow[] = spine.map((client) => {
    /*
     * Try the client's own name, then each alias it declares. Aliases are how
     * "BHGRE Base Camp" finds a tool row spelled "BHGRE Basecamp", and for an
     * os_clients spine they come from the database rather than the source file.
     */
    const portalToken = keysForClient(client)
      .map((k) => portalByKey.get(k))
      .find(Boolean);

    const hr = pickFor(client, h.byClient);
    const ir = pickFor(client, i.byClient);
    const ar = pickFor(client, a.byClient);

    const os = osByName.get(client.name);

    return {
      client,
      os: {
        id: os?.id ?? null,
        status: os?.status ?? "active",
        inOnboarding: Boolean(os?.links.onboarding),
        contact: os?.contact ?? { name: null, role: null, email: null, brokerage: null },
      },
      portalUrl: publicPortalUrl(portalToken),
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
    source: useStored ? "os_clients" : "roster",
    sourceNote,
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

/*
 * Indexes a tool's rows by NORMALISED NAME, not by canonical roster identity.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT resolve() HERE
 *
 * This used to call `resolve(name)` and key the map by the canonical client it
 * returned, which quietly meant: a tool row whose name is not in the ROSTER
 * array compiled into the build gets DROPPED.
 *
 * The page lists clients from `os_clients`, which is live, so the two lists can
 * disagree — and they disagree for precisely the clients that matter most. A
 * client onboarded through the OS is created correctly in all three tools, and
 * then shows "missing" in all three columns, because the roster in the source
 * file has never heard of it. The first client onboarded this way (OpsLabs) had
 * a valid Analytics id, a valid Client Health row with a plan and a weekly
 * target, and a valid Master Inbox row with a live portal — and the screen
 * reported it as set up nowhere.
 *
 * Keying by name means the lookup works for whatever spine is in use, and the
 * roster goes back to being what it is good at: telling the Consistency screen
 * which names nobody recognises.
 */
function index(rows: Record<string, unknown>[], nameField: string): ToolRead {
  const byClient = indexByName(rows, nameField);
  const match = matchRoster(rows.flatMap((r) => (str(r[nameField]) ? [str(r[nameField])!] : [])));
  return { byClient, unknown: match.unknown, exempt: match.exempt, unavailable: null };
}

/*
 * Client Health is read from its database, not over HTTP. `listClientRows`
 * returns exactly what the tool's GET /api/clients returned — every column of
 * every client — so `index` sees the same rows it always did. The tool is
 * being switched off; a read that went through it would go with it.
 */
async function readClientHealth(): Promise<ToolRead> {
  return index(await listClientRows(), "name");
}

/*
 * Portal token per client, read straight from the Master Inbox table.
 *
 * The roster already reads Master Inbox through /api/clients/intro-stats, but
 * that endpoint returns reply counts and no token, and the token is the only
 * thing a portal link needs. Read directly rather than adding a second HTTP
 * hop — this workspace already reads and writes that table for the delete and
 * for the portal feature flags.
 *
 * Failure is not fatal: a roster without portal links is still a roster, so
 * this resolves to an empty map rather than taking the page down.
 */
async function readPortalTokens(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const db = getMasterInboxSupabase();
    const { data } = await db
      .from("clients")
      .select("name, portal_token, portal_enabled")
      .not("portal_token", "is", null);
    for (const row of data ?? []) {
      const r = row as { name?: string; portal_token?: string; portal_enabled?: boolean };
      if (!r.name || !r.portal_token || r.portal_enabled === false) continue;
      const k = keyOf(r.name);
      if (!out.has(k)) out.set(k, r.portal_token);
    }
  } catch {
    // Reported by its absence — the column simply shows a dash.
  }
  return out;
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
