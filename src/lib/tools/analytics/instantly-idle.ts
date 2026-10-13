/*
 * Did Instantly do anything in this window?
 *
 * Positive and Bounces cannot be added across the two platforms: Master Inbox's
 * labels decide Positive and key on EmailBison replies, and Instantly has no
 * per-day bounce figure for older windows. So whenever Instantly is "in scope"
 * those two tiles — and Positive Rate and Lead to Email, which are built on
 * Positive — go to a dash rather than show the EmailBison half as the whole.
 *
 * "In scope" used to mean "the Platform filter does not exclude it", and an
 * empty Platform filter means both. So with nothing filtered, four of the
 * twelve tiles were a dash on every load — reported on 13 Oct as "metrics not
 * showing" — even though no campaign has run on Instantly for weeks and its
 * half of the window is nothing at all.
 *
 * A platform that sent nothing and received nothing in the window has no half
 * to be missing. EmailBison's Positive and Bounces ARE the whole, and are
 * shown. The moment Instantly has a single send or reply in the window, the
 * old rule applies again, exactly as before.
 */
export interface InstantlyWindow {
  sent: number | null;
  replies: number | null;
  human_replies: number | null;
}

export function instantlyIdle(i: InstantlyWindow | null | undefined): boolean {
  if (!i) return true;
  return Number(i.sent ?? 0) === 0 && Number(i.replies ?? 0) === 0 && Number(i.human_replies ?? 0) === 0;
}

/** Positive across both platforms: EmailBison's when Instantly was idle, unknown otherwise. */
export function mergedPositive(emailbison: number | null | undefined, i: InstantlyWindow | null | undefined): number | null {
  return instantlyIdle(i) ? (emailbison ?? null) : null;
}

/**
 * Bounces across both platforms: the sum where Instantly has a figure;
 * EmailBison's alone where Instantly was idle (it bounced nothing because it
 * sent nothing); unknown where Instantly sent and has no bounce figure.
 */
export function mergedBounces(
  emailbison: number | null | undefined,
  i: (InstantlyWindow & { bounces: number | null }) | null | undefined,
): number | null {
  if (i && i.bounces != null) return Number(emailbison ?? 0) + Number(i.bounces);
  return instantlyIdle(i) ? (emailbison ?? null) : null;
}
