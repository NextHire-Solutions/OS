/*
 * The switch that lets a reply agent email a real lead. It is off.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TURNING IT ON
 *
 * Everything downstream of this file — the safety gate, the schedule, the
 * release job, the CC-handover — is built and tested. What is NOT authorised
 * is the last inch: an email leaving for a real lead with nobody having read
 * it. The plan itself puts that last: "live auto-send only turns on in Phase 3,
 * after shadow has been validated" (§11), and Phase 3's rollout is
 * "shadow-first per agent" (§12).
 *
 * So Live is gated on an environment variable that does not exist in any
 * environment, cannot be set from the UI, and is checked in three places:
 *
 *   1. HERE, by the safety gate, which reports `live_disabled` and holds.
 *   2. In the API that writes `run_mode`, which refuses to store "live"
 *      while this is off — so nobody can arm an agent from the screen.
 *   3. In send-transport.ts, again, before it touches the send path — so a
 *      caller that forgot the safety gate still cannot send.
 *
 * The transport itself IS wired: send-transport.ts hands the reply to the
 * composer's own send core (inbox/send-reply.ts). What stops it is this
 * variable, checked three times, and nothing else — which is why it must not
 * be set until a person has decided to.
 *
 * ---------------------------------------------------------------------------
 * WHAT A HUMAN MUST DO TO ENABLE IT
 *
 *   a. Validate shadow. Read what the agents actually wrote, for real threads,
 *      for long enough to believe it.
 *   b. Set MASTER_INBOX_REPLY_AGENT_LIVE_SEND=1 on the OS service in Railway.
 *   c. Only then switch an agent to run_mode='live'.
 *
 * The variable is namespaced MASTER_INBOX_ like every other Master Inbox
 * variable in this workspace — the OS shares one environment across five
 * deployments and an unprefixed name would be whichever tool set it last.
 * It is read through `process.env` directly rather than through
 * lib/tools/master-inbox/env.ts because that file is shared with work in
 * flight; the lookup is the same either way.
 */

export const LIVE_SEND_ENV_VAR = "MASTER_INBOX_REPLY_AGENT_LIVE_SEND";

/**
 * Exactly "1". Not truthy — the same rule the cron gate uses, and for the same
 * reason: silently starting irreversible work because somebody typed "true" is
 * worse than not starting it.
 */
export function liveSendingEnabled(): boolean {
  return process.env[LIVE_SEND_ENV_VAR]?.trim() === "1";
}

/** What the UI and the API say when someone tries to arm an agent. */
export const LIVE_DISABLED_MESSAGE =
  "Live sending is not enabled on this server. The full live path is built — " +
  "safety gate, schedule, release job, CC-handover and the send itself — but it " +
  `cannot send until ${LIVE_SEND_ENV_VAR}=1 is set by a person. ` +
  "Use Shadow to see exactly what the agent would send.";
