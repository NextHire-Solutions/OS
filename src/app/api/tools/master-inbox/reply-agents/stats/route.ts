import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { requireSession } from "@/lib/auth/workspace";
import { loadAgentStats } from "@/lib/tools/master-inbox/ai/stats";

/*
 * GET /api/tools/master-inbox/reply-agents/stats — the per-agent feed. Plan §8.
 *
 *   Authorization: Bearer <MASTER_INBOX_REPLY_AGENT_STATS_TOKEN>
 *   ?updated_since=2026-08-01T00:00:00Z     incremental cursor (optional)
 *   &page=1&per_page=100                    per_page capped at 200
 *
 *   { "data": [ { agent_id, name, run_mode, client_ids, schedule,
 *                 qualification, handover, stats: { … }, updated_at } ],
 *     "meta": { current_page, last_page, per_page, total } }
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IS COPIED, DELIBERATELY
 *
 * Plan §10 lists "the external-feed API pattern (auth, pagination, shape)"
 * under reuse, and this follows the outcomes feed
 * (api/tools/master-inbox/outcomes) line for line: the same constant-time
 * bearer compare, the same ISO-8601 validation that rejects rather than
 * silently starting from the beginning, the same `{data, meta}` envelope and
 * the same `updated_since` cursor. A consumer that already polls outcomes can
 * point its existing paginator at this.
 *
 * ---------------------------------------------------------------------------
 * A DEDICATED TOKEN, AND WHAT IT IS NOT
 *
 * MASTER_INBOX_REPLY_AGENT_STATS_TOKEN is its own secret — not the
 * service-role key, not OUTCOMES_API_TOKEN. Whoever is given this can read how
 * every agent is configured and how it is performing, and nothing else; it can
 * be rotated without touching the outcomes consumer. Unset means nobody gets
 * in over a token (the endpoint fails CLOSED), which is the same choice the
 * outcomes feed makes.
 *
 * ---------------------------------------------------------------------------
 * TWO CALLERS, ONE ROUTE
 *
 * The in-app analytics panel calls this with a workspace session, which
 * `src/proxy.ts` has already verified at the front door. An external tool has
 * no session, so it presents the bearer instead.
 *
 * NOTE FOR WHOEVER DEPLOYS THIS: the external half does not work yet. The
 * proxy answers 401 to every /api/* request without a session unless the path
 * is listed in its allowlist, and this path is not listed — adding it is a
 * one-line change to src/proxy.ts, which is the front door of the whole
 * workspace and is deliberately not edited from here. Until that line exists,
 * this endpoint serves the app and refuses everyone else.
 */

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const TOKEN_ENV = "MASTER_INBOX_REPLY_AGENT_STATS_TOKEN";
const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 200;

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Constant-time compare that never throws on a length mismatch. */
function bearerMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const supplied = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (supplied) {
    const expected = process.env[TOKEN_ENV]?.trim();
    // Fail closed: an unconfigured token means a presented token is always
    // wrong, rather than being ignored in favour of the session path.
    if (!expected || !bearerMatches(supplied, expected)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  // No bearer: the caller is the app, and the proxy has already established
  // that they are signed in. `requireSession` supplies the workspace id.

  const url = new URL(request.url);
  const updatedSinceRaw = url.searchParams.get("updated_since");
  if (updatedSinceRaw && !ISO_RE.test(updatedSinceRaw)) {
    return NextResponse.json(
      { error: "updated_since must be ISO-8601 (e.g. 2026-08-01T00:00:00Z)" },
      { status: 400 },
    );
  }

  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const perPageRaw = Number(url.searchParams.get("per_page") ?? DEFAULT_PER_PAGE);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return NextResponse.json({ error: "page must be a positive integer" }, { status: 400 });
  }
  if (!Number.isInteger(perPageRaw) || perPageRaw < 1) {
    return NextResponse.json({ error: "per_page must be a positive integer" }, { status: 400 });
  }
  const perPage = Math.min(perPageRaw, MAX_PER_PAGE);

  const session = await requireSession();
  const read = await loadAgentStats({
    workspaceId: session.activeWorkspace.id,
    updatedSince: updatedSinceRaw,
    page: pageRaw,
    perPage,
  });

  if (!read.available) {
    /*
     * 503 rather than 500: the endpoint is correct and the database has not
     * caught up with it. The reason names the migration, so a consumer seeing
     * this in a log knows the fix is not in their code.
     */
    return NextResponse.json({ error: "stats unavailable", detail: read.reason }, { status: 503 });
  }

  const lastPage = Math.max(1, Math.ceil(read.page.total / perPage));
  return NextResponse.json({
    data: read.page.rows,
    meta: {
      current_page: pageRaw,
      last_page: lastPage,
      per_page: perPage,
      total: read.page.total,
    },
  });
}
