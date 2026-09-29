/*
 * Server boot hook. Runs once per Node process before any request.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The tools this workspace absorbed each ran their background work from a
 * separate Railway cron service. The OS has no cron service, so their
 * schedulers run in-process — and an in-process scheduler that starts lazily,
 * from the first request that happens to import it, does nothing until
 * somebody opens the right screen after a deploy. Overnight, nobody does.
 *
 * Starting them here means a deploy at 05:59 still fires the 06:00 sweep, which
 * is exactly what a fresh cron container used to guarantee.
 *
 * Each `ensure*` is idempotent (a process-wide guard) and gated by its own
 * ENABLE flag, so this file is safe to call and cheap when everything is off.
 * Only the Node runtime runs schedulers; the Edge runtime (the proxy) does not.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureScheduler } = await import("./lib/tools/analytics/sync/scheduler");
  ensureScheduler();

  const { ensureClientHealthScheduler } = await import("./lib/tools/client-health/sync/scheduler");
  ensureClientHealthScheduler();

  const { ensureCronScheduler } = await import("./lib/tools/master-inbox/sync/scheduler");
  ensureCronScheduler();

  const { ensureOnboardingScheduler } = await import("./lib/tools/onboarding/scheduler");
  ensureOnboardingScheduler();

  /*
   * §16's drift check. Unlike the four above it belongs to no single tool — it
   * reads all of them and reports where they disagree. Daily, and off unless
   * OS_RECONCILE_ALERT_ENABLED=1; see lib/reconcile/schedule.ts.
   */
  const { ensureReconcileScheduler } = await import("./lib/reconcile/scheduler");
  ensureReconcileScheduler();

  /*
   * Warm the one cache whose first miss is unbearable.
   *
   * Open Responses walks every open thread's labels and last message: 12–13
   * seconds, measured on every deploy's first visit. The cache serves stale
   * results while refreshing, but only once it holds a result — so the first
   * person after each deploy still waited. Compute it here, for every
   * workspace, a few seconds after boot, and nobody ever sees the cold path.
   * Fire-and-forget, never fatal: a failure here only means the old behaviour.
   */
  setTimeout(async () => {
    try {
      if (!process.env.MASTER_INBOX_SUPABASE_URL) return;
      const { createAdminSupabase } = await import("./lib/supabase/admin");
      const { openResponsesThreadIds } = await import("./lib/tools/master-inbox/inbox/open-responses");
      const admin = createAdminSupabase();
      const { data } = await admin.from("workspaces").select("id");
      for (const row of (data ?? []) as Array<{ id: string }>) {
        openResponsesThreadIds(admin as never, row.id).catch(() => {});
      }
    } catch {
      /* warm-up is best effort */
    }
  }, 5_000).unref?.();

  /*
   * The master client list (Clients page) spans six databases — ~15s cold.
   * Warm it after boot, then every four minutes so its stale-while-refresh
   * window never lapses; the first person to open Clients never waits.
   */
  const warmClients = async () => {
    try {
      if (!process.env.MASTER_INBOX_SUPABASE_URL) return;
      const { getMasterClientList } = await import("./lib/clients/master-list");
      await getMasterClientList();
    } catch {
      /* warm-up is best effort */
    }
  };
  setTimeout(warmClients, 8_000).unref?.();
  setInterval(warmClients, 240_000).unref?.();

  /*
   * What EVERY page waits on: the rail's status dots (a probe of each tool),
   * the rail's unread and reminder counts, and Home's numbers. Each is served
   * stale-while-refresh for ten minutes, so keeping them no older than four
   * means no click ever waits on them — measured, the first click after an
   * idle spell waited ~2s on the counts and ~2.4s on the probes.
   */
  const warmShell = async () => {
    if (!process.env.MASTER_INBOX_SUPABASE_URL) return;
    const [{ getAllSnapshots }, { loadRailBadges }, { getOverview }, { getPerformance }] = await Promise.all([
      import("./lib/status/store"),
      import("./lib/workspace/badges"),
      import("./lib/workspace/overview"),
      import("./lib/workspace/performance"),
    ]);
    // Performance reads every linked Stripe subscription; warm it so opening the page never waits on Stripe.
    await Promise.allSettled([getAllSnapshots(), loadRailBadges(), getOverview(), getPerformance()]);
  };
  const warmShellSafely = () => { warmShell().catch(() => { /* best effort */ }); };

  /*
   * Payment links created from a client's record (0024): a paid one becomes
   * that client's subscription within a few minutes, even if nobody opens
   * the record. Reads Stripe only; links a subscription only once it is paid.
   */
  const settleLinks = async () => {
    if (!process.env.MASTER_INBOX_SUPABASE_URL) return;
    const { settle } = await import("./lib/clients/payment-links");
    await settle();
  };
  setInterval(() => { settleLinks().catch(() => { /* best effort */ }); }, 180_000).unref?.();
  setTimeout(warmShellSafely, 6_000).unref?.();
  setInterval(warmShellSafely, 240_000).unref?.();
}
