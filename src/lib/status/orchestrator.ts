import "server-only";

import {
  type Connector,
  type Note,
  type ProbeContext,
  type ResolvedDeepLink,
  type ToolSnapshot,
} from "@/lib/connectors/types";
import { httpProbe } from "@/lib/http/probe";
import { deriveState } from "./derive";
import { NotConfiguredError, UnsupportedError, baseUrlEnv, isConfigured } from "@/lib/env";

/*
 * Runs one connector's two probes and assembles a snapshot.
 *
 * Reach and metrics run CONCURRENTLY, not in sequence. They are independent
 * questions and serialising them would double the worst-case wall time on the
 * exact cards that are already slowest.
 */
export async function probeConnector(connector: Connector): Promise<ToolSnapshot> {
  const now = new Date();
  const checkedAt = now.toISOString();

  const configured = isConfigured(...connector.env.required);

  const base = {
    id: connector.id,
    name: connector.name,
    shortName: connector.shortName,
    description: connector.description,
    checkedAt,
    stale: false,
    dataAsOf: null as string | null,
  };

  if (!configured) {
    const missing = connector.env.required.filter((v) => !isConfigured(v));
    return {
      ...base,
      href: "#",
      deepLinks: [],
      state: "unconfigured",
      reachable: false,
      latencyMs: null,
      httpStatus: null,
      metrics: [],
      notes: [{ level: "error", text: `Missing ${missing.join(", ")}` }],
      capabilities: {
        blackBox: Boolean(connector.blackBox),
        hasMetrics: Boolean(connector.metrics),
        metricsConfigured: false,
      },
    };
  }

  const resolvedBase = baseUrlEnv(connector.baseUrlEnv);
  const ctx: ProbeContext = {
    baseUrl: resolvedBase,
    http: httpProbe,
    policy: connector.policy,
    now,
  };

  const deepLinks: ResolvedDeepLink[] = connector.deepLinks.map((link) => ({
    ...link,
    href: `${resolvedBase}${link.path}`,
  }));

  const [reachOutcome, metricsOutcome] = await Promise.allSettled([
    connector.reach(ctx),
    connector.metrics ? connector.metrics(ctx) : Promise.resolve(null),
  ]);

  const reach =
    reachOutcome.status === "fulfilled"
      ? reachOutcome.value
      : {
          reachable: false,
          httpStatus: null,
          latencyMs: null,
          state: "down" as const,
          notes: [
            {
              level: "error" as const,
              text:
                reachOutcome.reason instanceof Error
                  ? reachOutcome.reason.message
                  : "Probe threw",
            },
          ],
        };

  const metrics = metricsOutcome.status === "fulfilled" ? metricsOutcome.value : null;

  const notes: Note[] = [...(reach.notes ?? []), ...(metrics?.notes ?? [])];

  /*
   * A metrics probe can fail for three very different reasons, and treating
   * them alike is how a status board becomes wallpaper:
   *
   *   no credential      our gap, the tool is fine     info, no degrade
   *   cannot be served   nobody's fault, permanent     info, no degrade
   *   it broke           worth investigating           warn, degrade
   *
   * The middle case is not hypothetical. Master Inbox's thread-counts route
   * needs a user session and has no service-role path; Onboarding publishes no
   * read endpoint at all. Both would sit amber forever over numbers that were
   * never once readable.
   *
   * This lives HERE rather than in each connector so every tool gets it. Two
   * connectors carried their own copy and the other three did not, which is
   * exactly why adding Onboarding turned the whole board amber on day one.
   */
  let metricsFault = false;

  if (metricsOutcome.status === "rejected") {
    const reason = metricsOutcome.reason;

    if (reason instanceof NotConfiguredError) {
      notes.push({
        level: "info",
        text: `Metrics unavailable — set ${reason.varName} to enable`,
        envVar: reason.varName,
      });
    } else if (reason instanceof UnsupportedError) {
      notes.push({ level: "info", text: `Metrics unavailable — ${reason.message}` });
    } else {
      metricsFault = true;
      notes.push({
        level: "warn",
        text: reason instanceof Error ? reason.message : "Metrics probe threw",
      });
    }
  }

  const metricsDegraded = Boolean(metrics?.degraded) || metricsFault;

  return {
    ...base,
    href: `${resolvedBase}${connector.home}`,
    deepLinks,
    state: deriveState({
      configured: true,
      reachState: reach.state,
      metricsDegraded,
    }),
    reachable: reach.reachable,
    latencyMs: reach.latencyMs,
    httpStatus: reach.httpStatus,
    metrics: metrics?.metrics ?? [],
    notes,
    dataAsOf: metrics?.dataAsOf ?? null,
    capabilities: {
      blackBox: Boolean(connector.blackBox),
      hasMetrics: Boolean(connector.metrics),
      metricsConfigured: connector.env.optional.every((v) => isConfigured(v)),
    },
  };
}
