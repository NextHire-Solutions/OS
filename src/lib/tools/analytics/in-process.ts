import "server-only";

import { NextRequest } from "next/server";

import type { HttpResult } from "@/lib/connectors/types";

/*
 * ANALYTICS' READ ENDPOINTS, ANSWERED BY THE OS'S OWN COPIES.
 *
 * The overview, the roster and the consistency checks read Analytics by
 * calling the standalone app over HTTP with a minted session. That app is
 * being switched off. The OS already serves the same endpoints under
 * /api/tools/analytics/* — ports that differ from the tool's only in import
 * paths and team-id lookup (client-rows adds two columns) — and none of them
 * reads a session, only the URL. So the handler is called directly, and the
 * answer comes back in the HttpResult shape the readers already parse.
 *
 *   standalone                    OS route
 *   /api/clients                  /api/tools/analytics/clients
 *   /api/analytics/clients        /api/tools/analytics/client-rows
 *   /api/analytics/kpis           /api/tools/analytics/kpis
 *   /api/analytics/timeseries     /api/tools/analytics/timeseries
 */

type Handler = (req: NextRequest) => Promise<Response>;

const ROUTES: Record<string, () => Promise<{ GET: Handler }>> = {
  "/api/clients": async () => {
    const m = await import("@/app/api/tools/analytics/clients/route");
    return { GET: () => m.GET() };
  },
  "/api/analytics/clients": () => import("@/app/api/tools/analytics/client-rows/route"),
  "/api/analytics/kpis": () => import("@/app/api/tools/analytics/kpis/route"),
  "/api/analytics/timeseries": () => import("@/app/api/tools/analytics/timeseries/route"),
};

/** GET one of the four paths above (query string allowed), in-process. */
export async function analyticsRead(pathWithQuery: string): Promise<HttpResult> {
  const started = performance.now();
  const url = new URL(pathWithQuery, "http://os.internal");
  const load = ROUTES[url.pathname];
  if (!load) throw new Error(`no in-process Analytics route for ${url.pathname}`);
  try {
    const { GET } = await load();
    const res = await GET(new NextRequest(url));
    const bodyText = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(bodyText); } catch { /* left null, as httpProbe does */ }
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Math.round(performance.now() - started),
      bodyText,
      json,
      failure: null,
      location: null,
    };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      latencyMs: Math.round(performance.now() - started),
      bodyText: e instanceof Error ? e.message : String(e),
      json: null,
      failure: null,
      location: null,
    };
  }
}
