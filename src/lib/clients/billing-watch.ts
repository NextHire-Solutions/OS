import "server-only";

import { osTable } from "@/lib/clients/os-db";

import { getAccountBilling } from "./billing-account";
import { campaignPortalView } from "./campaign-portals";

/*
 * FAILED PAYMENTS → notifications, and the portal block (client feedback, 6 Oct).
 *
 * Reads the cached Stripe snapshot (billing-account.ts); writes only the OS's
 * own tables (0030). It never touches Stripe and never touches a portal: the
 * standalone Master Inbox portal reads os_portal_blocks and holds back a
 * portal only for a row whose mode is 'blocked'.
 *
 *   Every failed attempt on an open invoice   → one notification (warning;
 *                                              critical from the threshold).
 *   Threshold reached (default 4 failed      → a block row: 'dry_run' unless
 *   attempts = the first + 3 recovery         OS_PORTAL_BLOCK_ENABLED=1, in
 *   retries; OS_PORTAL_BLOCK_AFTER_ATTEMPTS)  which case 'blocked'.
 *   The invoice is no longer open (paid,      → the block is lifted, with a
 *   voided, written off)                       notification.
 *
 * Decision (user, 6 Oct): dry run first — the OS lists who WOULD be blocked
 * and blocking is switched on with one setting. Alerts stay in the OS only.
 */

export function blockThreshold(): number {
  const n = Number(process.env.OS_PORTAL_BLOCK_AFTER_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}
export function blockingEnabled(): boolean {
  return process.env.OS_PORTAL_BLOCK_ENABLED === "1";
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (t: number | null) => (t ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(t * 1000)) : null);

export interface WatchResult { ready: boolean; notified: number; blocked: number; lifted: number; error?: string }

/** One pass. Safe to run any number of times: every write is keyed and idempotent. */
export async function runBillingWatch(): Promise<WatchResult> {
  const probe = await osTable("os_notifications").select("id", { head: true, count: "exact" }).limit(1);
  if (probe.error) return { ready: false, notified: 0, blocked: 0, lifted: 0, error: "Needs migrations/0030_billing_profile.sql run first." };

  const a = await getAccountBilling();
  const { data: clientRows } = await osTable("os_clients").select("id, name");
  const name = new Map(((clientRows ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const threshold = blockThreshold();
  const mode = blockingEnabled() ? "blocked" : "dry_run";
  let notified = 0, blocked = 0, lifted = 0;

  const notify = async (n: { kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; clientId: string | null; ref: string }) => {
    // ref is UNIQUE: an event already recorded is simply not inserted again.
    const { error } = await osTable("os_notifications").upsert(
      { kind: n.kind, severity: n.severity, title: n.title, body: n.body, os_client_id: n.clientId, ref: n.ref },
      { onConflict: "ref", ignoreDuplicates: true },
    );
    if (!error) notified++;
  };

  for (const [clientId, b] of a.byClient) {
    for (const inv of b.failedInvoices) {
      const who = name.get(clientId) ?? "A client";
      const reached = inv.attemptCount >= threshold;
      await notify({
        kind: "payment_failed",
        severity: reached ? "critical" : "warning",
        title: `Payment failed — ${who}`,
        body: `Invoice ${inv.number ?? inv.id}: ${money(inv.amountRemaining)} unpaid. Stripe has tried ${inv.attemptCount} time${inv.attemptCount === 1 ? "" : "s"}` +
          (inv.nextAttempt ? `; next try ${day(inv.nextAttempt)}.` : "; no more automatic tries.") +
          (reached ? (mode === "blocked" ? " The client's portal is now paused until it is paid." : " Dry run: the portal WOULD be paused now (blocking is switched off).") : ""),
        clientId,
        ref: `invoice:${inv.id}:attempt:${inv.attemptCount}`,
      });
      if (reached) {
        const { data: existing } = await osTable("os_portal_blocks").select("id, mode, lifted_at").eq("os_client_id", clientId).eq("invoice_id", inv.id).maybeSingle();
        const row = existing as { id: string; mode: string; lifted_at: string | null } | null;
        if (!row) {
          // Every portal the client has, so the portal can check its own id in one lookup.
          const portals = await campaignPortalView(clientId).then((v) => v.portals.map((p) => p.id)).catch(() => [] as string[]);
          await osTable("os_portal_blocks").insert({
            os_client_id: clientId, mi_client_ids: portals, invoice_id: inv.id, mode,
            reason: `Invoice ${inv.number ?? inv.id} unpaid after ${inv.attemptCount} attempts`,
            amount: inv.amountRemaining, pay_url: inv.url,
          });
          blocked++;
          await notify({
            kind: mode === "blocked" ? "portal_blocked" : "portal_block_dry_run",
            severity: "critical",
            title: mode === "blocked" ? `Portal paused — ${who}` : `Portal would be paused — ${who} (dry run)`,
            body: `${money(inv.amountRemaining)} on invoice ${inv.number ?? inv.id} is still unpaid after ${inv.attemptCount} attempts.` +
              (mode === "blocked" ? " The portal shows a payment notice until it is paid, then reopens by itself." : " Blocking is off, so nothing was changed. Switch it on with OS_PORTAL_BLOCK_ENABLED=1."),
            clientId,
            ref: `block:${clientId}:${inv.id}:${mode}`,
          });
        } else if (row.mode === "dry_run" && mode === "blocked" && !row.lifted_at) {
          // Blocking was switched on after a dry-run row: it now takes effect.
          await osTable("os_portal_blocks").update({ mode: "blocked", blocked_at: new Date().toISOString() }).eq("id", row.id);
          blocked++;
        }
      }
    }
  }

  // Lift: a block whose invoice is no longer open (paid, voided, written off).
  const { data: open } = await osTable("os_portal_blocks").select("id, os_client_id, invoice_id, mode").is("lifted_at", null);
  const invById = new Map(a.snapshot.invoices.map((i) => [i.id, i]));
  for (const r of (open ?? []) as Array<{ id: string; os_client_id: string; invoice_id: string; mode: string }>) {
    const inv = invById.get(r.invoice_id);
    if (inv && inv.status === "open") continue;
    await osTable("os_portal_blocks").update({ lifted_at: new Date().toISOString() }).eq("id", r.id);
    lifted++;
    await notify({
      kind: "portal_unblocked",
      severity: "info",
      title: `${inv?.status === "paid" ? "Paid" : "Invoice closed"} — ${name.get(r.os_client_id) ?? "a client"}`,
      body: `Invoice ${inv?.number ?? r.invoice_id} is ${inv?.status ?? "no longer open"}.` + (r.mode === "blocked" ? " The portal is open again." : ""),
      clientId: r.os_client_id,
      ref: `lift:${r.id}`,
    });
  }
  return { ready: true, notified, blocked, lifted };
}

/** The open blocks, for the record and Performance: who is (or in dry run would be) blocked. */
export async function openPortalBlocks(): Promise<Array<{ clientId: string; invoiceId: string; mode: string; since: string; reason: string | null }>> {
  const { data, error } = await osTable("os_portal_blocks").select("os_client_id, invoice_id, mode, blocked_at, reason").is("lifted_at", null);
  if (error) return [];
  return ((data ?? []) as Array<Record<string, string | null>>).map((r) => ({
    clientId: String(r.os_client_id), invoiceId: String(r.invoice_id), mode: String(r.mode), since: String(r.blocked_at), reason: r.reason ?? null,
  }));
}
