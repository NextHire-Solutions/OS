/*
 * INSTANTLY IS SWITCHED OFF IN CAMPAIGN ANALYTICS (19 November 2026).
 *
 * BrokerStaffer stopped using Instantly: its last send and last reply in the
 * synced data are 8 September 2026, and no Instantly campaign is active. On the
 * user's word ("they have stopped using instantly … do not delete the code as we
 * can use that later") the analytics tool stops syncing Instantly and stops
 * showing it: no Instantly sync jobs, no Instantly campaigns, inboxes, filters,
 * estate or numbers on any analytics screen, and totals are EmailBison's alone.
 *
 * NOTHING IS DELETED. The Instantly tables keep every row synced up to now, and
 * all the Instantly code (jobs, routes, screens, tests) stays. To turn it back
 * on, set this to true and deploy: the jobs resume where their watermarks left
 * off and every screen shows Instantly again.
 *
 * Scope: Campaign Analytics (its screens, its API and its sync) and the
 * Assistant tools that read the same screens. Master Inbox, Client Health,
 * client lifecycle pauses and the portals' blocklists are separate tools and do
 * not read this switch.
 *
 * Typed as `boolean`, not the literal `false`, so the compiler does not treat
 * the Instantly branches as unreachable and they keep being type-checked.
 *
 * Kept free of `@/` imports on purpose: client screens and plain Node tests
 * import it directly.
 */
export const ANALYTICS_INSTANTLY_ON: boolean = false;

/** Every analytics job that talks to Instantly is named sync-instantly-*. */
export function isInstantlyJob(job: string): boolean {
  return job.startsWith("sync-instantly");
}

/** A job the switch keeps from running, and from counting in sync health. */
export function jobSwitchedOff(job: string, instantlyOn: boolean = ANALYTICS_INSTANTLY_ON): boolean {
  return !instantlyOn && isInstantlyJob(job);
}

/** What a refused Instantly request says. */
export const INSTANTLY_OFF_MESSAGE =
  "Instantly is switched off in Campaign Analytics: BrokerStaffer no longer sends through it.";

/** What a skipped Instantly read answers: an empty table, no error. */
export const NO_INSTANTLY_ROWS = { data: [] as never[], error: null, count: 0 } as const;

/**
 * Runs an Instantly read only while the switch is on; otherwise answers like an
 * empty table without asking the database. The read is passed as a function so
 * that, switched off, no query is even built.
 */
export function instantlyRead<T>(
  read: () => PromiseLike<T>,
  instantlyOn: boolean = ANALYTICS_INSTANTLY_ON,
): Promise<T | typeof NO_INSTANTLY_ROWS> {
  return instantlyOn ? Promise.resolve(read()) : Promise.resolve(NO_INSTANTLY_ROWS);
}

/**
 * The `p_platforms` a sending-data function is given (sends, replies, capacity):
 * null means every platform. Switched off, it is EmailBison alone, whatever an
 * old link asks for (the user, 19 Nov: past Instantly numbers leave the totals
 * too).
 */
export function sendingPlatformsParam(
  platforms: readonly string[],
  instantlyOn: boolean = ANALYTICS_INSTANTLY_ON,
): string[] | null {
  if (!instantlyOn) return ["emailbison"];
  return platforms.length ? [...platforms] : null;
}

/**
 * The `p_platforms` an OUTCOME function is given. Outcomes have a third source,
 * "direct" (no campaign at all), which is not a sending platform and must stay
 * in: switched off, the filter is "everything but Instantly".
 */
export function outcomePlatformsParam(
  platforms: readonly string[],
  instantlyOn: boolean = ANALYTICS_INSTANTLY_ON,
): string[] | null {
  if (!instantlyOn) return ["emailbison", "direct"];
  return platforms.length ? [...platforms] : null;
}
