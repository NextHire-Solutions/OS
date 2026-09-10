import "server-only";

import { baseUrlEnv, optionalEnv } from "@/lib/env";

/*
 * The client for the live Agent Search service.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ROUTES ARE PROXIED AND NOT PORTED
 *
 * Agent Search is not a data app with a UI bolted on — it is a scraping worker.
 * Every endpoint below reaches something that physically cannot exist inside
 * Next.js:
 *
 *   /api/search           drives Playwright + Crawlee through a Bright Data
 *                         unblocker, in a Docker image carrying Chromium, on a
 *                         job that runs for minutes to hours.
 *   /api/courted/account  logs into Courted, then writes COURTED_EMAIL_n into
 *                         the Railway service with a Railway API token, which
 *                         triggers that service's own redeploy.
 *   /api/courted/mls-*    logs into all nine Courted accounts.
 *   /api/enrich           the same scraping stack, plus the reconcile pass
 *                         against the agents table.
 *
 * All of that state is *in the memory of that one container*: `jobs.js` keeps
 * jobs in a Map, so a job id means nothing anywhere else. Re-implementing the
 * endpoints here would not port the tool — it would fork it, and the fork would
 * have no scraper behind it.
 *
 * So the workspace drives the real service, and every request is passed through
 * shape-for-shape: same paths, same bodies, same status codes. What IS ported
 * is the logic that has rules worth keeping — merge.ts, sheet-source.ts,
 * columns.ts, identity.ts, format.ts — each copied verbatim and under test.
 *
 * ---------------------------------------------------------------------------
 * AUTH
 *
 * The live service is currently OPEN: BS_SSO_SECRET is unset on Railway, which
 * its own boot log calls out ("Auth: OPEN — every route is public"), and
 * `curl https://search.brokerstaffer.com/api/status` returns 200 with no
 * cookie. So no credential is needed today. `ADMIN_TOKEN` is a *separate*,
 * also-unset gate on the four mutating Courted routes; if it is ever set on
 * Railway, set AGENT_SEARCH_ADMIN_TOKEN here and it is forwarded.
 *
 * The workspace's own sign-in still gates these routes — every handler under
 * /api/tools/agent-search sits behind the workspace session, which is a
 * tightening, not a loosening.
 */

const SLOW_MS = 180_000;  // login + MLS enumeration across nine accounts
const FAST_MS = 30_000;

export interface ScraperReply<T> {
  ok: boolean;
  status: number;
  body: T;
}

function scraperBase(): string {
  return baseUrlEnv("SCRAPER_URL");
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const admin = optionalEnv("AGENT_SEARCH_ADMIN_TOKEN");
  if (admin) h["x-admin-token"] = admin;
  return h;
}

/**
 * One request to the live service, returned as `{ok, status, body}` rather
 * than thrown.
 *
 * The tool answers failures with a JSON `{error}` and a meaningful status —
 * 400 for a bad Courted password, 501 for "no unblocker configured", 502 for
 * "Railway write failed". Those are the messages the operator has to read, so
 * they are passed straight through instead of being collapsed into "upstream
 * error". A screen that says "request failed" when the service said "Courted
 * login failed — check the credentials" has thrown away the whole answer.
 */
export async function callScraper<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<ScraperReply<T>> {
  const { method = "GET", body, timeoutMs = FAST_MS } = init;

  let base: string;
  try {
    base = scraperBase();
  } catch {
    return {
      ok: false,
      status: 503,
      body: { error: "SCRAPER_URL is not set — Agent Search is not connected." } as T,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body from an Express app is an HTML error page or a proxy
      // notice. Surfacing the first 300 characters beats "Unexpected token <".
      parsed = { error: `Agent Search returned a non-JSON response (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: res.ok, status: res.status, body: parsed as T };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      body: {
        error: aborted
          ? `Agent Search did not respond within ${Math.round(timeoutMs / 1000)}s.`
          : error instanceof Error ? error.message : "Agent Search is unreachable",
      } as T,
    };
  }
}

/** A raw passthrough, for the CSV export — the body is not JSON. */
export async function streamScraper(path: string): Promise<Response> {
  let base: string;
  try {
    base = scraperBase();
  } catch {
    return new Response("SCRAPER_URL is not set", { status: 503 });
  }
  const res = await fetch(`${base}${path}`, { headers: headers(false), cache: "no-store" });
  // Content-Disposition carries the filename the tool chose
  // ("master-agents-deduped.csv"), so the browser saves the same name it would
  // have from the tool itself. Rebuilding the header here would lose that.
  const out = new Headers();
  for (const k of ["content-type", "content-disposition"]) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

/* ===========================================================================
   The endpoints, named. One function per route the tool exposes, so a caller
   never hand-builds a path and a typo cannot reach production as a 404.
   =========================================================================== */

export interface ScraperStatus {
  courted: boolean;
  courtedAccounts: number;
  unblocker: string | null;
}

export const scraper = {
  status: () => callScraper<ScraperStatus>("/api/status"),
  columns: () => callScraper<Record<string, string[]>>("/api/columns"),

  // --- search jobs ---
  startSearch: (body: unknown) => callScraper<{ jobId: string; params: unknown }>("/api/search", { method: "POST", body }),
  searchResults: (id: string, offsets: Record<string, number>) => {
    const q = new URLSearchParams(
      Object.entries(offsets).map(([k, v]) => [k, String(v)]),
    ).toString();
    return callScraper(`/api/search/${encodeURIComponent(id)}/results?${q}`);
  },
  stopSearch: (id: string) => callScraper(`/api/search/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} }),
  master: (id: string) => callScraper(`/api/search/${encodeURIComponent(id)}/master`, { timeoutMs: SLOW_MS }),
  exportCsv: (id: string, source: string) =>
    streamScraper(`/api/search/${encodeURIComponent(id)}/export?source=${encodeURIComponent(source)}`),

  // --- courted accounts ---
  addAccount: (body: unknown) => callScraper("/api/courted/account", { method: "POST", body, timeoutMs: SLOW_MS }),
  mlsList: (body: unknown) => callScraper("/api/courted/mls-list", { method: "POST", body, timeoutMs: SLOW_MS }),

  // --- mls monitor ---
  startMlsScan: () => callScraper<{ scanId: string; total: number; status: string; message: string }>(
    "/api/courted/mls-scan", { method: "POST", body: {} }),
  mlsScan: (id: string) => callScraper(`/api/courted/mls-scan/${encodeURIComponent(id)}`),
  stopMlsScan: (id: string) => callScraper(`/api/courted/mls-scan/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} }),
  runMlsMonitor: () => callScraper("/api/courted/mls-monitor/run", { method: "POST", body: {}, timeoutMs: SLOW_MS }),
  runRefresh: (email?: string) =>
    callScraper("/api/courted/refresh/run", { method: "POST", body: email ? { email } : {}, timeoutMs: SLOW_MS }),

  // --- import profile urls (enrichment) ---
  resolveEnrich: (body: unknown) => callScraper("/api/enrich/resolve", { method: "POST", body, timeoutMs: SLOW_MS }),
  startEnrich: (body: unknown) => callScraper("/api/enrich", { method: "POST", body, timeoutMs: SLOW_MS }),
  enrichJob: (id: string, offset: number) =>
    callScraper(`/api/enrich/${encodeURIComponent(id)}?offset=${offset}`),
  stopEnrich: (id: string) => callScraper(`/api/enrich/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} }),
};
