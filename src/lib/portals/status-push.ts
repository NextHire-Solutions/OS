/*
 * Tell MasterInbox to reconcile portals, right after the OS changes a
 * client's status.
 *
 * MasterInbox decides what a status means for a portal (active -> ON,
 * paused/churned -> OFF) by reading a status feed and applying it. Its
 * endpoint is a FULL, IDEMPOTENT reconcile, so this push carries no payload:
 * it only says "something moved, go and look". A lost push is therefore a
 * late update, never a missing one, and the scheduled run still self-corrects.
 *
 * DISABLED UNTIL DELIBERATELY CONFIGURED, and that is the important part.
 * MasterInbox currently reads its status feed from Client Health, not from
 * the OS. Nudging it while that is true would make it re-read Client Health,
 * which does not yet know about the change — so the push would do nothing
 * useful and could look as though the OS had been ignored. Both env vars are
 * therefore left unset until MasterInbox's CLIENT_STATUS_URL points at the
 * OS's own feed (/api/workspace/clients/status-feed). Until then this is a
 * no-op, by design rather than by accident.
 *
 * Everything else mirrors the Client Health push, for the same reasons:
 * portals are live, so a status save must never fail, hang, or storm.
 */

const PUSH_TIMEOUT_MS = 10_000;
const COALESCE_MS = 1_500;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReasons = new Set<string>();

function reconcileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.searchParams.set("apply", "1");
    return u.toString();
  } catch {
    return null;
  }
}

async function fire(url: string, token: string, reasons: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      // Header, not ?token=, so the secret stays out of access logs.
      method: "POST",
      headers: { "x-cron-token": token },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[portal-status-push] reconcile returned ${res.status} (${reasons})`);
      return;
    }
    const body = (await res.json().catch(() => null)) as
      | { changes?: unknown[]; matched?: number; reason?: string }
      | null;
    if (body?.reason) {
      // MasterInbox skipped on purpose — its fail-safe rules (feed down, feed
      // empty), not an error here, but worth seeing.
      console.warn(`[portal-status-push] reconcile skipped: ${body.reason} (${reasons})`);
      return;
    }
    console.log(
      `[portal-status-push] reconciled ${body?.matched ?? "?"} clients, ` +
        `${body?.changes?.length ?? 0} portal(s) flipped (${reasons})`,
    );
  } catch (error) {
    const why =
      error instanceof Error && error.name === "AbortError" ? "timed out" : String(error);
    console.warn(`[portal-status-push] push failed, reconcile will catch up: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget. Call AFTER the write has succeeded, never before: a push
 * that races the commit would make MasterInbox read the old status.
 */
export function pushPortalStatus(reason: string): void {
  const rawUrl = process.env.PORTAL_STATUS_SYNC_URL;
  const token = process.env.PORTAL_STATUS_SYNC_TOKEN;
  if (!rawUrl || !token) return; // not configured — see the note at the top

  const url = reconcileUrl(rawUrl);
  if (!url) {
    console.warn("[portal-status-push] PORTAL_STATUS_SYNC_URL is not a valid URL — skipping");
    return;
  }

  pendingReasons.add(reason);
  if (pendingTimer) return; // already scheduled; this reason rides along

  pendingTimer = setTimeout(() => {
    const reasons = [...pendingReasons].join("; ");
    pendingTimer = null;
    pendingReasons = new Set();
    void fire(url, token, reasons);
  }, COALESCE_MS);

  // A pending push must never be the reason the process stays alive.
  (pendingTimer as unknown as { unref?: () => void }).unref?.();
}
