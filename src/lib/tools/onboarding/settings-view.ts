import "server-only";

import { automationEnabled, getStepLabels } from "./settings";
import { getMailboxStatus, CONNECT_URL, type MailboxStatus } from "./mailbox";
import { schedulerStatus } from "./scheduler";
import { getPeople } from "./people";
import { getHealthPanel, type HealthPanel } from "./health";
import type { Person } from "./people-types";
import { stripeMode, type StripeMode } from "./stripe-mode";

/**
 * Everything the Settings screen shows, in one read.
 *
 * The orchestrator's `app/settings/page.tsx` is a server component that awaits
 * six things and renders five panels. This is the same six, shaped as JSON so the
 * workspace's client screen can fetch it and — the part that matters — refetch it
 * after a write. The mailbox read includes the tool's live connection check.
 */

export type { MailboxStatus } from "./mailbox";

export interface OnboardingSettings {
  automationEnabled: boolean;
  stepLabels: Record<string, string>;
  people: Person[];
  health: HealthPanel;
  mailbox: MailboxStatus;
  /** Test or live — the payment box warns before a real charge. */
  stripeMode: StripeMode;
  /** The in-process 10-minute ticker (lib/tools/onboarding/scheduler.ts). */
  scheduler: { enabled: boolean; running: boolean; startedAt: string | null };
  error: string | null;
}

const EMPTY_MAILBOX: MailboxStatus = {
  email: null, connectedAt: null, hasRefreshToken: false, configured: false, manageableHere: false,
  broken: false, error: null, invalidGrant: false, checkedAt: null, connectUrl: CONNECT_URL,
  redirectUri: "", toolUrl: null,
};

export async function getOnboardingSettings(): Promise<OnboardingSettings> {
  try {
    const [auto, labels, people, health, mailbox] = await Promise.all([
      automationEnabled(),
      getStepLabels(),
      getPeople(),
      getHealthPanel(),
      getMailboxStatus(),
    ]);
    return {
      automationEnabled: auto,
      stepLabels: labels,
      people,
      health,
      mailbox,
      stripeMode: stripeMode(),
      scheduler: schedulerStatus(),
      error: null,
    };
  } catch (error) {
    return {
      automationEnabled: false,
      stepLabels: {},
      people: [],
      health: { counts: {}, unmatched: [], lastSync: null, configured: false },
      mailbox: EMPTY_MAILBOX,
      stripeMode: stripeMode(),
      scheduler: schedulerStatus(),
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}
