/*
 * The relay's settings — what is switched on, and the answers to the plan's
 * open questions (§7). Pure: no I/O, so every default is tested.
 *
 * Where the plan left a decision to the client, the setting exists and its
 * default is the cautious answer:
 *
 *   mode                    'one_click'   — a person presses "Send to brokerage"
 *   forwardLaterReplies     false         — only the reply that was marked
 *   countsAsIntroduction    false         — a hand-off is not an introduction
 *   brokerage.enabled       false         — no pilot brokerage chosen yet
 *   brokerage.recipients    'intro_contacts' — the people introductions go to
 *                                           today, by territory (plan §3.4)
 *
 * And the two locks that make a send impossible by default:
 *
 *   enabled                 false         — the global switch
 *   practiceMode            true          — decide and record, never send
 */

export type RelayMode = "automatic" | "one_click";
export type RecipientMode = "intro_contacts" | "address";
export type PipelineEntry = "introduction" | "interested";

export interface GlobalRelaySettings {
  /** False when there is no settings row yet (nothing was ever switched on). */
  present: boolean;
  enabled: boolean;
  practiceMode: boolean;
  mode: RelayMode;
  forwardLaterReplies: boolean;
  countsAsIntroduction: boolean;
  hourlyCap: number;
  enabledSince: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_GLOBAL: GlobalRelaySettings = {
  present: false,
  enabled: false,
  practiceMode: true,
  mode: "one_click",
  forwardLaterReplies: false,
  countsAsIntroduction: false,
  hourlyCap: 5,
  enabledSince: null,
  updatedAt: null,
  updatedBy: null,
};

export const MIN_HOURLY_CAP = 1;
export const MAX_HOURLY_CAP = 100;

export interface BrokerageRelaySettings {
  /** The brokerage's own switch (the pilot). Off: practice only. */
  enabled: boolean;
  /** Overrides the global mode for this brokerage; null = the global one. */
  mode: RelayMode | null;
  recipients: RecipientMode;
  /** The one address used when `recipients` is 'address'. */
  address: string | null;
  /** Overrides the global hourly cap; null = the global one. */
  hourlyCap: number | null;
}

export const DEFAULT_BROKERAGE: BrokerageRelaySettings = {
  enabled: false,
  mode: null,
  recipients: "intro_contacts",
  address: null,
  hourlyCap: null,
};

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function isRelayMode(v: unknown): v is RelayMode {
  return v === "automatic" || v === "one_click";
}

export function clampCap(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_HOURLY_CAP, Math.max(MIN_HOURLY_CAP, Math.round(n)));
}

/** The os_relay_settings row, or null for "no row" — every missing value is the default. */
export function globalFromRow(row: Record<string, unknown> | null | undefined): GlobalRelaySettings {
  if (!row) return { ...DEFAULT_GLOBAL };
  return {
    present: true,
    enabled: bool(row.enabled, DEFAULT_GLOBAL.enabled),
    // Anything but an explicit false is practice.
    practiceMode: row.practice_mode === false ? false : true,
    mode: isRelayMode(row.mode) ? row.mode : DEFAULT_GLOBAL.mode,
    forwardLaterReplies: bool(row.forward_later_replies, false),
    countsAsIntroduction: bool(row.counts_as_introduction, false),
    hourlyCap: clampCap(row.hourly_cap, DEFAULT_GLOBAL.hourlyCap),
    enabledSince: str(row.enabled_since),
    updatedAt: str(row.updated_at),
    updatedBy: str(row.updated_by),
  };
}

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
export function isEmail(v: string | null | undefined): v is string {
  return !!v && EMAIL.test(v.trim());
}

/** os_clients.relay_settings (jsonb). Malformed values fall back to the defaults, never to "on". */
export function brokerageFromJson(value: unknown): BrokerageRelaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_BROKERAGE };
  const v = value as Record<string, unknown>;
  const address = str(v.address);
  const recipients: RecipientMode = v.recipients === "address" && isEmail(address) ? "address" : "intro_contacts";
  return {
    enabled: v.enabled === true,
    mode: isRelayMode(v.mode) ? v.mode : null,
    recipients,
    address: isEmail(address) ? address!.toLowerCase() : null,
    hourlyCap: v.hourly_cap == null || v.hourly_cap === "" ? null : clampCap(v.hourly_cap, DEFAULT_GLOBAL.hourlyCap),
  };
}

export function brokerageToJson(s: BrokerageRelaySettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    mode: s.mode,
    recipients: s.recipients,
    address: s.address,
    hourly_cap: s.hourlyCap,
  };
}

export function pipelineEntryFrom(value: unknown): PipelineEntry {
  // Absent (0036 not run) or anything unexpected reads as today's behaviour.
  return value === "interested" ? "interested" : "introduction";
}

/** The mode that applies to one brokerage. */
export function effectiveMode(global: GlobalRelaySettings, brokerage: BrokerageRelaySettings): RelayMode {
  return brokerage.mode ?? global.mode;
}

export function effectiveCap(global: GlobalRelaySettings, brokerage: BrokerageRelaySettings): number {
  return brokerage.hourlyCap ?? global.hourlyCap;
}

/*
 * Live or practice, for one brokerage. EVERY lock must be open for "live":
 * the server's env switch, the global switch, practice mode off, and the
 * brokerage's own switch. Anything else is practice — decided and recorded,
 * never sent. (The Postmark transport checks the env switch again itself.)
 */
export function deliveryMode(
  global: GlobalRelaySettings,
  brokerage: BrokerageRelaySettings,
  liveSendAllowed: boolean,
): "live" | "practice" {
  return liveSendAllowed && global.enabled && !global.practiceMode && brokerage.enabled ? "live" : "practice";
}

export class RelaySettingsError extends Error {}

/** A PUT of the global switches, validated. Unknown keys are ignored; a wrong type is refused. */
export function parseGlobalPatch(body: unknown): Partial<Omit<GlobalRelaySettings, "present" | "enabledSince" | "updatedAt" | "updatedBy">> {
  if (!body || typeof body !== "object") throw new RelaySettingsError("Send the settings as an object.");
  const b = body as Record<string, unknown>;
  const out: ReturnType<typeof parseGlobalPatch> = {};
  for (const [key, field] of [
    ["enabled", "enabled"],
    ["practiceMode", "practiceMode"],
    ["forwardLaterReplies", "forwardLaterReplies"],
    ["countsAsIntroduction", "countsAsIntroduction"],
  ] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") throw new RelaySettingsError(`${key} must be true or false.`);
    out[field] = b[key] as boolean;
  }
  if (b.mode !== undefined) {
    if (!isRelayMode(b.mode)) throw new RelaySettingsError("mode must be 'automatic' or 'one_click'.");
    out.mode = b.mode;
  }
  if (b.hourlyCap !== undefined) {
    const n = Number(b.hourlyCap);
    if (!Number.isInteger(n) || n < MIN_HOURLY_CAP || n > MAX_HOURLY_CAP) {
      throw new RelaySettingsError(`hourlyCap must be a whole number from ${MIN_HOURLY_CAP} to ${MAX_HOURLY_CAP}.`);
    }
    out.hourlyCap = n;
  }
  return out;
}

/** The os_relay_settings row to write, from the current settings plus a patch. */
export function globalToRow(
  workspaceId: string,
  current: GlobalRelaySettings,
  patch: ReturnType<typeof parseGlobalPatch>,
  by: string | null,
  now: Date,
): Record<string, unknown> {
  const next = { ...current, ...patch };
  // Switching on (again) starts the clock: nothing labelled while it was off is relayed.
  const switchingOn = next.enabled && !current.enabled;
  return {
    workspace_id: workspaceId,
    enabled: next.enabled,
    practice_mode: next.practiceMode,
    mode: next.mode,
    forward_later_replies: next.forwardLaterReplies,
    counts_as_introduction: next.countsAsIntroduction,
    hourly_cap: next.hourlyCap,
    enabled_since: switchingOn ? now.toISOString() : next.enabled ? current.enabledSince ?? now.toISOString() : current.enabledSince,
    updated_at: now.toISOString(),
    updated_by: by,
  };
}

/** A PUT of one brokerage's settings, validated against what it had. */
export function parseBrokeragePatch(body: unknown, current: BrokerageRelaySettings): { settings: BrokerageRelaySettings; pipelineEntry: PipelineEntry | null } {
  if (!body || typeof body !== "object") throw new RelaySettingsError("Send the settings as an object.");
  const b = body as Record<string, unknown>;
  const next: BrokerageRelaySettings = { ...current };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new RelaySettingsError("enabled must be true or false.");
    next.enabled = b.enabled;
  }
  if (b.mode !== undefined) {
    if (b.mode !== null && !isRelayMode(b.mode)) throw new RelaySettingsError("mode must be 'automatic', 'one_click' or null.");
    next.mode = b.mode as RelayMode | null;
  }
  if (b.address !== undefined) {
    const a = str(b.address);
    if (a && !isEmail(a)) throw new RelaySettingsError("The relay address is not an email address.");
    next.address = a ? a.toLowerCase() : null;
  }
  if (b.recipients !== undefined) {
    if (b.recipients !== "intro_contacts" && b.recipients !== "address") {
      throw new RelaySettingsError("recipients must be 'intro_contacts' or 'address'.");
    }
    next.recipients = b.recipients;
  }
  if (next.recipients === "address" && !next.address) {
    throw new RelaySettingsError("Give the address to send to, or choose the introduction contacts.");
  }
  if (b.hourlyCap !== undefined) {
    if (b.hourlyCap === null || b.hourlyCap === "") next.hourlyCap = null;
    else {
      const n = Number(b.hourlyCap);
      if (!Number.isInteger(n) || n < MIN_HOURLY_CAP || n > MAX_HOURLY_CAP) {
        throw new RelaySettingsError(`hourlyCap must be a whole number from ${MIN_HOURLY_CAP} to ${MAX_HOURLY_CAP}, or empty.`);
      }
      next.hourlyCap = n;
    }
  }
  let pipelineEntry: PipelineEntry | null = null;
  if (b.pipelineEntry !== undefined) {
    if (b.pipelineEntry !== "introduction" && b.pipelineEntry !== "interested") {
      throw new RelaySettingsError("pipelineEntry must be 'introduction' or 'interested'.");
    }
    pipelineEntry = b.pipelineEntry;
  }
  return { settings: next, pipelineEntry };
}
