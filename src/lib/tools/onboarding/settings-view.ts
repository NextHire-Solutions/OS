import "server-only";

import { optionalEnv } from "@/lib/env";

import { getOnboardingDb } from "./db";
import { automationEnabled, getStepLabels } from "./settings";
import { getPeople } from "./people";
import { getHealthPanel, type HealthPanel } from "./health";
import type { Person } from "./people-types";

/**
 * Everything the Settings screen shows, in one read.
 *
 * The orchestrator's `app/settings/page.tsx` is a server component that awaits
 * six things and renders five panels. This is the same six, shaped as JSON so the
 * workspace's client screen can fetch it and — the part that matters — refetch it
 * after a write.
 */

export interface MailboxStatus {
  /** The connected Gmail address, when there is one. */
  email: string | null;
  connectedAt: string | null;
  /**
   * Whether a refresh token is stored. Not the same as "working" — Google can
   * revoke it at any time, and only a live call finds out. The workspace does not
   * make that call; see `manageableHere`.
   */
  hasRefreshToken: boolean;
  /**
   * FALSE, always, and deliberately.
   *
   * Connecting a mailbox is an OAuth round trip that ends at a redirect URI
   * registered with Google for the orchestrator's own domain. The workspace is a
   * different origin and holds no GOOGLE_OAUTH_CLIENT_ID, so a Connect button
   * here could not complete — it would bounce the user to a consent screen that
   * refuses the redirect.
   *
   * Rendering the status and sending the reader to the tool for the one action we
   * cannot perform is honest. A dead button is not.
   */
  manageableHere: boolean;
  /** Where to go to change it. */
  toolUrl: string | null;
}

export interface OnboardingSettings {
  automationEnabled: boolean;
  stepLabels: Record<string, string>;
  people: Person[];
  health: HealthPanel;
  mailbox: MailboxStatus;
  error: string | null;
}

async function getMailbox(): Promise<MailboxStatus> {
  const base = optionalEnv("ONBOARDING_URL")?.replace(/\/+$/, "") ?? null;
  const empty: MailboxStatus = {
    email: null,
    connectedAt: null,
    hasRefreshToken: false,
    manageableHere: false,
    toolUrl: base ? `${base}/settings` : null,
  };
  try {
    const { data } = await getOnboardingDb()
      .from("orch_email_account")
      .select("email, refresh_token, connected_at")
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return empty;
    const row = data as { email: string | null; refresh_token: string | null; connected_at: string | null };
    return {
      ...empty,
      email: row.email ?? null,
      connectedAt: row.connected_at ?? null,
      // The token itself never leaves the server — only whether one exists.
      hasRefreshToken: !!row.refresh_token,
    };
  } catch {
    return empty;
  }
}

export async function getOnboardingSettings(): Promise<OnboardingSettings> {
  try {
    const [auto, labels, people, health, mailbox] = await Promise.all([
      automationEnabled(),
      getStepLabels(),
      getPeople(),
      getHealthPanel(),
      getMailbox(),
    ]);
    return {
      automationEnabled: auto,
      stepLabels: labels,
      people,
      health,
      mailbox,
      error: null,
    };
  } catch (error) {
    return {
      automationEnabled: false,
      stepLabels: {},
      people: [],
      health: { counts: {}, unmatched: [], lastSync: null, configured: false },
      mailbox: { email: null, connectedAt: null, hasRefreshToken: false, manageableHere: false, toolUrl: null },
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}
