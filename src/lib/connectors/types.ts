/*
 * One registry entry per tool. Everything the dashboard knows about an upstream
 * lives here: where it is, how to open it, how to tell whether it is alive, and
 * how to get numbers out of it. Adding a sixth tool must never require touching
 * the orchestrator, the cache, the API route or the UI.
 *
 * The split between `reach` and `metrics` is load-bearing. Reachability is the
 * ONLY thing every tool can answer — two of the five are black boxes with no
 * source access. Metrics are optional and fail independently: a tool whose KPI
 * call 401s is `degraded`, not `down`, and its card still opens in a new tab.
 */

export type ToolId =
  | "master-inbox"
  | "client-health"
  | "analytics"
  | "scraper"
  | "onboarding";

/**
 * The five states a card can be in.
 *
 * `unknown` is a first-class citizen, not an error: two of the five tools are
 * black boxes that will live here permanently, so it must read as neutral and
 * must never colour the page amber.
 *
 * `unconfigured` says the failure is OURS — a missing env var — which is a
 * different action than "the tool is down" and deserves a different word.
 */
export type HealthState =
  | "down"
  | "degraded"
  | "unknown"
  | "unconfigured"
  | "up"
  | "checking";

export type MetricFormat =
  | "number"
  | "compact"
  | "percent"
  | "duration"
  | "text"
  | "relative-time";

export interface ToolMetric {
  /** Stable across renders and deploys; the UI keys off this, not the label. */
  key: string;
  label: string;
  /** null means "no data" and must NEVER render as 0. */
  value: number | string | null;
  format: MetricFormat;
  intent?: "neutral" | "good" | "warn" | "bad";
  hint?: string;
}

export interface DeepLink {
  id: string;
  label: string;
  /** Path only. The orchestrator joins it to the resolved baseUrl. */
  path: string;
  keywords?: string[];
  /**
   * false = we inferred this route and have not confirmed it exists.
   * The command palette hides unverified links rather than advertise a 404.
   */
  verified: boolean;
}

export interface Note {
  level: "info" | "warn" | "error";
  text: string;
  /**
   * Set when the note is "you haven't configured this yet". Carrying the
   * variable name as a field rather than burying it in prose lets the setup
   * cell render a tight, actionable list instead of three sentences.
   */
  envVar?: string;
}

/** A deep link with its base URL already applied. */
export interface ResolvedDeepLink extends DeepLink {
  href: string;
}

/** What one probe round produced. Serialisable — this IS the wire format. */
export interface ToolSnapshot {
  id: ToolId;
  name: string;
  shortName: string;
  description: string;
  /** Absolute, ready for <a target="_blank" rel="noopener noreferrer">. */
  href: string;
  deepLinks: ResolvedDeepLink[];

  state: HealthState;
  reachable: boolean;
  latencyMs: number | null;
  httpStatus: number | null;

  metrics: ToolMetric[];
  notes: Note[];

  /** Freshness of the upstream's DATA, from its own payload, when it says. */
  dataAsOf: string | null;
  /** When WE last completed a probe. */
  checkedAt: string;
  /** True when this came from the last-good store after a failed refresh. */
  stale: boolean;

  capabilities: {
    /** No source access — reachability + deep link only. */
    blackBox: boolean;
    /** Has a metrics probe wired at all. */
    hasMetrics: boolean;
    /** Metrics probe exists but its env is missing. */
    metricsConfigured: boolean;
  };
}

export interface ConnectorPolicy {
  /** Reachability budget. Keep tight — this runs on every cache miss. */
  reachTimeoutMs: number;
  /** Metrics budget. May be generous; it fails independently. */
  metricsTimeoutMs: number;
  /** Above this latency the tool is `degraded` even on a 200. */
  slowMs: number;
  /** How long a snapshot is fresh. */
  ttlMs: number;
  /** How long a stale snapshot may still be served while we refresh. */
  staleMs: number;
  /** Upstream data older than this ⇒ degraded. Omit when unknowable. */
  dataStaleAfterMs?: number;
}

export interface HttpResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  bodyText: string | null;
  json: unknown;
  failure: "timeout" | "network" | null;
  location: string | null;
}

export type HttpProbe = (
  url: string,
  opts?: { timeoutMs?: number; headers?: Record<string, string>; method?: "GET" | "HEAD" },
) => Promise<HttpResult>;

export interface ProbeContext {
  /** Resolved, trailing-slash-stripped base URL for THIS tool. */
  baseUrl: string;
  http: HttpProbe;
  policy: ConnectorPolicy;
  now: Date;
}

export interface ReachResult {
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  state: Exclude<HealthState, "unconfigured" | "checking">;
  notes?: Note[];
}

export interface MetricsResult {
  metrics: ToolMetric[];
  notes?: Note[];
  dataAsOf?: string | null;
  /** Downgrade the card even though it is reachable. */
  degraded?: boolean;
}

export interface Connector {
  id: ToolId;
  name: string;
  shortName: string;
  description: string;
  /** Env var holding the base URL. */
  baseUrlEnv: string;
  /** Path opened when the card itself is clicked. */
  home: string;
  deepLinks: DeepLink[];
  env: { required: readonly string[]; optional: readonly string[] };
  policy: ConnectorPolicy;
  blackBox?: boolean;

  reach(ctx: ProbeContext): Promise<ReachResult>;
  metrics?(ctx: ProbeContext): Promise<MetricsResult>;
}

/** Identity function: gives inference plus one place to assert invariants. */
export function defineConnector(c: Connector): Connector {
  if (!c.home.startsWith("/")) throw new Error(`${c.id}: home must be a path`);
  for (const link of c.deepLinks) {
    if (!link.path.startsWith("/")) {
      throw new Error(`${c.id}/${link.id}: deep link path must start with "/"`);
    }
  }
  return c;
}

// --- small builders, so connectors read as data rather than plumbing --------

export function metric(
  key: string,
  label: string,
  value: number | string | null,
  format: MetricFormat,
  extra: Omit<ToolMetric, "key" | "label" | "value" | "format"> = {},
): ToolMetric {
  return { key, label, value, format, ...extra };
}

export function note(level: Note["level"], text: string, envVar?: string): Note {
  return envVar ? { level, text, envVar } : { level, text };
}

/** Default policy. Connectors override only what genuinely differs. */
export const DEFAULT_POLICY: ConnectorPolicy = {
  reachTimeoutMs: 4_000,
  metricsTimeoutMs: 8_000,
  slowMs: 2_500,
  ttlMs: 60_000,
  staleMs: 10 * 60_000,
};
