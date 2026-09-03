import {
  DEFAULT_POLICY,
  defineConnector,
  metric,
  note,
  type MetricsResult,
  type Note,
  type ProbeContext,
  type ToolMetric,
} from "./types";
import { classifyReach } from "@/lib/http/classify";
import { NotConfiguredError, UnsupportedError, optionalEnv } from "@/lib/env";

/*
 * Master Inbox — Next 16, Supabase Auth, the unified reply inbox.
 *
 * Reachability uses GET /api/metrics/follow-up-time, which the upstream proxy
 * explicitly allows through unauthenticated. That choice buys a lot: the route
 * queries Supabase, so a 200 proves the app AND its database, not merely that
 * Railway's edge answered. It is aggregate-only (no PII), so polling it is
 * harmless — but the range is bounded to 7 days so we are not asking Postgres
 * to median the full history every minute.
 *
 * Thread counts are a separate, independently-failing probe. Be aware:
 * /api/admin/thread-counts gets past the upstream *proxy* with x-admin-token,
 * but its handler then calls requireSession(), which has no service-role
 * bypass and redirects to /login. So this probe is EXPECTED to fail against
 * the current deploy. It is wired anyway because (a) it costs nothing, (b) it
 * starts working the moment that route grows a token path, and (c) its failure
 * is reported as an INFO note that does NOT degrade the tool. No credential we
 * hold can satisfy that route, so marking Master Inbox amber forever over it
 * would make the status colour meaningless.
 */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoDay(date: Date, daysAgo = 0): string {
  const d = new Date(date.getTime() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Accepts both response shapes. Without `?all=1` the route returns
 * `{ counts: {...} }`; with it, `{ workspaces: [{ counts }] }`. We ask for the
 * single-workspace form, but parse both so a future upstream change doesn't
 * silently blank the card.
 */
function extractCounts(json: unknown): Record<string, unknown> | null {
  const body = asRecord(json);
  if (!body) return null;

  const direct = asRecord(body.counts);
  if (direct) return direct;

  if (Array.isArray(body.workspaces) && body.workspaces.length > 0) {
    return asRecord(asRecord(body.workspaces[0])?.counts);
  }
  return null;
}

async function loadFollowUpTime(ctx: ProbeContext) {
  const to = isoDay(ctx.now);
  const from = isoDay(ctx.now, 7);
  const res = await ctx.http(
    `${ctx.baseUrl}/api/metrics/follow-up-time?from=${from}&to=${to}`,
    { timeoutMs: ctx.policy.metricsTimeoutMs },
  );
  if (!res.ok) throw new Error(`follow-up-time returned ${res.status ?? "no response"}`);

  const overall = asRecord(asRecord(res.json)?.overall);
  if (!overall) throw new Error("follow-up-time returned an unexpected shape");
  return overall;
}

async function loadThreadCounts(ctx: ProbeContext) {
  const token = optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
  if (!token) throw new NotConfiguredError("MASTER_INBOX_ADMIN_TOKEN");

  const res = await ctx.http(`${ctx.baseUrl}/api/admin/thread-counts`, {
    timeoutMs: ctx.policy.metricsTimeoutMs,
    headers: { "x-admin-token": token },
  });

  // The handler redirects to /login when the session check fails, which
  // surfaces here as a 307 rather than a 401.
  if (res.status === 307 || res.status === 302) {
    throw new UnsupportedError(
      "not readable over HTTP — the route requires a user session, and has no service-role path",
    );
  }
  if (!res.ok) throw new Error(`thread-counts returned ${res.status ?? "no response"}`);

  const counts = extractCounts(res.json);
  if (!counts) throw new Error("thread-counts returned an unexpected shape");
  return counts;
}

/**
 * A metrics probe can fail for two very different reasons, and conflating them
 * makes the status colour meaningless:
 *
 *   OUR fault    — we have no credential for it. The tool is fine. Report it
 *                  as an `info` note and do NOT degrade the card.
 *   THEIR fault  — the upstream errored, timed out or changed shape. That is a
 *                  real signal and does degrade the card.
 */
function describeFailure(
  outcome: PromiseSettledResult<unknown>,
  fallback: string,
): { note: Note; degrades: boolean } {
  const error = outcome.status === "rejected" ? outcome.reason : null;

  if (error instanceof NotConfiguredError) {
    return {
      note: note("info", `${fallback} — set ${error.varName} to enable`, error.varName),
      degrades: false,
    };
  }

  // The upstream cannot serve this at all. The tool is healthy; one number is
  // unavailable. Degrading for it would be permanent and therefore useless.
  if (error instanceof UnsupportedError) {
    return { note: note("info", `${fallback} — ${error.message}`), degrades: false };
  }

  return {
    note: note("warn", error instanceof Error ? `${fallback} — ${error.message}` : fallback),
    degrades: true,
  };
}

export const masterInboxConnector = defineConnector({
  id: "master-inbox",
  name: "Master Inbox",
  shortName: "Inbox",
  description: "Unified sales inbox for cold outreach replies.",
  baseUrlEnv: "MASTER_INBOX_URL",
  home: "/inbox",

  deepLinks: [
    { id: "inbox", label: "Inbox", path: "/inbox", verified: true, keywords: ["threads", "replies", "email"] },
    { id: "all-email", label: "All email", path: "/inbox/all-email", verified: true },
    { id: "reminders", label: "Reminders", path: "/reminders", verified: true, keywords: ["snooze", "follow up"] },
    { id: "leads", label: "Leads", path: "/leads", verified: true },
    { id: "portals", label: "Portals", path: "/portals", verified: true, keywords: ["portal", "client"] },
    { id: "archive", label: "Archive", path: "/inbox/archive", verified: true },
  ],

  env: {
    required: ["MASTER_INBOX_URL"],
    optional: ["MASTER_INBOX_ADMIN_TOKEN"],
  },

  policy: { ...DEFAULT_POLICY },

  async reach(ctx) {
    const to = isoDay(ctx.now);
    const from = isoDay(ctx.now, 7);
    const res = await ctx.http(
      `${ctx.baseUrl}/api/metrics/follow-up-time?from=${from}&to=${to}`,
      { timeoutMs: ctx.policy.reachTimeoutMs },
    );
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(ctx): Promise<MetricsResult> {
    const metrics: ToolMetric[] = [];
    const notes: Note[] = [];
    let degraded = false;

    const [followUp, counts] = await Promise.allSettled([
      loadFollowUpTime(ctx),
      loadThreadCounts(ctx),
    ]);

    if (counts.status === "fulfilled") {
      const needsReply = num(counts.value.open_needs_reply);
      metrics.push(
        metric("open", "Open", num(counts.value.open), "compact"),
        metric("needs_reply", "Needs reply", needsReply, "compact", {
          intent: needsReply && needsReply > 0 ? "warn" : "neutral",
        }),
      );
    } else {
      const failure = describeFailure(counts, "Thread counts unavailable");
      degraded = degraded || failure.degrades;
      notes.push(failure.note);
    }

    if (followUp.status === "fulfilled") {
      metrics.push(
        metric("median_reply", "Median reply", num(followUp.value.median_seconds), "duration", {
          hint: "Median business-hours time to first human reply, last 7 days",
        }),
      );
      // Only surface the sample size when nothing else filled the strip —
      // three metrics is the cap, and "Replies (7d)" is the least useful.
      if (metrics.length < 3) {
        metrics.push(
          metric("sample", "Replies (7d)", num(followUp.value.sample_size), "compact"),
        );
      }
    } else {
      const failure = describeFailure(followUp, "Reply-time metrics unavailable");
      degraded = degraded || failure.degrades;
      notes.push(failure.note);
    }

    return { metrics, notes, degraded };
  },
});
