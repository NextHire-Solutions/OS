/*
 * Refunding an invoice from the client's Billing tab (22 Oct). Eddy's plan,
 * approved 22 Oct ("yes amy and I (eddy) can issue refunds. everything else
 * approved"):
 *   - full or partial, a reason and an optional note;
 *   - done the way Stripe recommends for invoices: a CREDIT NOTE on that
 *     invoice that refunds the money (refund_amount) — the invoice shows what
 *     was refunded, Stripe makes a credit-note PDF, and the total can never
 *     exceed what was paid (Stripe refuses it, and so do we first);
 *   - a confirmation step (Stripe's own preview of the credit note) before
 *     anything happens;
 *   - only the Billing tab's people (billing-access.ts);
 *   - who issued it is kept on the credit note (metadata os_refund_by) and
 *     shown in the history;
 *   - the client is emailed the credit note only when that box is ticked
 *     (email_type none otherwise — Stripe's default would email them).
 * Never twice by accident (23 Oct review): the confirmation's key goes to
 * Stripe as the Idempotency-Key AND onto the credit note, so a retry after a
 * lost answer finds the refund it already made; and a second refund of the same
 * amount on the same invoice within ten minutes is refused, so going Back and
 * confirming again after an unclear error cannot double it.
 * Tested only in Stripe's TEST mode. We never issue a refund ourselves.
 */

import { z } from "zod";

import { CREDIT_NOTE_REASONS, type BillingInvoiceRow } from "./billing-model.ts";

type StripeErr = { error?: { message?: string } };

/** What a person picks; Stripe's own reason codes behind them (one list, kept with the history that shows them). */
export const REFUND_REASONS = CREDIT_NOTE_REASONS;
export type RefundReason = keyof typeof REFUND_REASONS;

/** "1,250.5" / "$250" → cents; null when it is not an amount. A comma only between thousands: "1,50" is refused, not read as $150. */
export function dollarsToCents(s: string): number | null {
  const t = s.replace(/[$\s]/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t.replace(/,/g, "")) * 100);
}

/** On the invoice row and the dialog: "$250.00 refunded" — or "credited" when credit notes gave back more than its payments were refunded (a balance credit, say). */
export function givenBack(i: Pick<BillingInvoiceRow, "paid" | "refundable" | "refunded">): string | null {
  const back = Math.round((i.paid - i.refundable) * 100) / 100;
  if (back <= 0) return null;
  const usd = back.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `${usd} ${i.refunded + 0.005 >= back ? "refunded" : "credited"}`;
}

export const refundRequest = z.object({
  // Any 36-character id (os_clients ids are uuids; zod's uuid() also insists on the RFC version bits).
  clientId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  invoiceId: z.string().regex(/^in_[A-Za-z0-9]{8,64}$/),
  /** Cents. */
  amount: z.number().int().min(1).max(100_000_000),
  reason: z.enum(Object.keys(REFUND_REASONS) as [RefundReason, ...RefundReason[]]),
  note: z.string().trim().max(500).optional().default(""),
  emailClient: z.boolean().default(false),
  /** Made once per confirmation in the browser: a double click or a retry refunds once (Stripe's Idempotency-Key). */
  key: z.string().uuid(),
  /** true: Stripe's preview only — nothing is created. */
  preview: z.boolean().default(false),
});
export type RefundRequest = z.infer<typeof refundRequest>;

export class RefundError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A real refund (a live key) only from the deployed OS, asked for on
 * os.brokerstaffer.com itself — never from a copy running on a laptop (even
 * one started with `railway run`), where testing happens. Previews create
 * nothing and are not held back.
 */
export function liveRefundRefusal(key: string, env: Record<string, string | undefined>, origin: string | null, site: string): string | null {
  if (!/^(sk|rk)_live_/.test(key)) return null;
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
  return onRailway && origin === site ? null : "Real refunds are issued only from os.brokerstaffer.com.";
}

/** A credit note already on the invoice. */
export interface IssuedNote { id: string; number: string | null; created: number; amount: number; key: string | null; refund: string | null }

/** The invoice as Stripe has it NOW (the Billing tab's copy can be minutes old). */
export interface InvoiceNow {
  id: string;
  status: string;
  /** Dollars left to give back: paid, less the larger of what its payments were refunded (in Stripe or here) and what credit notes gave back. */
  refundable: number;
  notes: IssuedNote[];
}

async function stripeRead<T>(key: string, path: string, f: typeof fetch): Promise<T> {
  const res = await f(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json().catch(() => null)) as (T & StripeErr) | null;
  if (!res.ok || !j) throw new RefundError(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`, 502);
  return j;
}

type RawNote = { id: string; number?: string | null; created?: number; amount?: number; metadata?: Record<string, string> | null; refunds?: Array<{ refund?: string | { id: string } | null }> | null; refund?: string | { id: string } | null };
const refundOf = (n: { refunds?: RawNote["refunds"]; refund?: RawNote["refund"] }): string | null => {
  const r = n.refunds?.[0]?.refund ?? n.refund ?? null;
  return typeof r === "string" ? r : r?.id ?? null;
};

/** Reads the invoice, its payments' refunds and its credit notes from Stripe at this moment. `chargeIds`: its payments, by the tab's rules. */
export async function invoiceNow(key: string, invoiceId: string, chargeIds: string[], f: typeof fetch = fetch): Promise<InvoiceNow> {
  const [inv, charges, notes] = await Promise.all([
    stripeRead<{ id?: string; status?: string; amount_paid?: number; post_payment_credit_notes_amount?: number }>(key, `invoices/${encodeURIComponent(invoiceId)}`, f),
    Promise.all(chargeIds.map((id) => stripeRead<{ amount_refunded?: number }>(key, `charges/${encodeURIComponent(id)}`, f))),
    stripeRead<{ data?: RawNote[] }>(key, `credit_notes?invoice=${encodeURIComponent(invoiceId)}&limit=100`, f),
  ]);
  if (!inv.id) throw new RefundError("Stripe: the invoice could not be read.", 502);
  const refunded = charges.reduce((t, c) => t + (c.amount_refunded ?? 0), 0);
  const returned = Math.max(refunded, inv.post_payment_credit_notes_amount ?? 0);
  return {
    id: inv.id,
    status: inv.status ?? "",
    refundable: Math.max(0, (inv.amount_paid ?? 0) - returned) / 100,
    notes: (notes.data ?? []).map((n) => ({
      id: n.id, number: n.number ?? null, created: n.created ?? 0, amount: n.amount ?? 0, key: n.metadata?.os_refund_key ?? null, refund: refundOf(n),
    })),
  };
}

/** How long a refund of the same amount on the same invoice is taken for a repeat. */
export const TWIN_WINDOW_S = 10 * 60;

/**
 * A credit note of the same amount on this invoice in the last ten minutes,
 * made under another confirmation: almost certainly the same refund confirmed
 * twice (after an error that hid that the first went through).
 */
export function recentTwin(notes: IssuedNote[], amountCents: number, key: string, nowS: number): IssuedNote | null {
  return notes.find((n) => n.key !== key && n.amount === amountCents && nowS - n.created < TWIN_WINDOW_S) ?? null;
}

export function twinRefusal(n: IssuedNote, nowS: number): RefundError {
  const mins = Math.max(1, Math.round((nowS - n.created) / 60));
  const again = Math.max(1, Math.ceil((n.created + TWIN_WINDOW_S - nowS) / 60));
  return new RefundError(
    `A refund of $${(n.amount / 100).toFixed(2)} was issued on this invoice ${mins} min ago${n.number ? ` (credit note ${n.number})` : ""}. Check the billing history — if a second one is really meant, it can be made in ${again} min.`,
    409,
  );
}

/** The checks before Stripe is asked: a paid invoice of THIS client, an amount it can still give back. */
export function checkRefundable(invoice: { id: string; status: string; refundable: number } | undefined, amountCents: number): void {
  if (!invoice) throw new RefundError("That invoice isn't one of this client's.", 404);
  if (invoice.status !== "paid") throw new RefundError("Only a paid invoice can be refunded.", 409);
  const max = Math.round(invoice.refundable * 100);
  if (max <= 0) throw new RefundError("This invoice has been refunded in full already.", 409);
  if (amountCents > max) throw new RefundError(`At most $${(max / 100).toFixed(2)} can be refunded on this invoice.`, 409);
}

/** The form Stripe's credit-note endpoints take, for one refund. */
export function creditNoteForm(r: Pick<RefundRequest, "invoiceId" | "amount" | "reason" | "note" | "emailClient" | "clientId" | "key">, who: string): URLSearchParams {
  const f = new URLSearchParams();
  f.set("invoice", r.invoiceId);
  f.set("amount", String(r.amount));
  f.set("refund_amount", String(r.amount));
  f.set("reason", r.reason);
  if (r.note) f.set("memo", r.note);
  f.set("email_type", r.emailClient ? "credit_note" : "none");
  f.set("metadata[os_refund_by]", who);
  f.set("metadata[os_client_id]", r.clientId);
  f.set("metadata[os_refund_key]", r.key);
  return f;
}

/** Stripe's own preview of the credit note — validates the amount against the invoice; creates nothing. */
export async function previewRefund(key: string, r: RefundRequest, who: string, f: typeof fetch = fetch): Promise<{ amount: number; total: number }> {
  const form = creditNoteForm(r, who);
  form.delete("email_type");
  const res = await f(`https://api.stripe.com/v1/credit_notes/preview?${form.toString()}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json().catch(() => null)) as ({ amount?: number; total?: number } & StripeErr) | null;
  if (!res.ok || !j) throw new RefundError(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`, res.status === 400 ? 409 : 502);
  return { amount: j.amount ?? r.amount, total: j.total ?? r.amount };
}

/** Issues it: one credit note that refunds `amount` to the original payment method. */
export async function issueRefund(key: string, r: RefundRequest, who: string, f: typeof fetch = fetch): Promise<{ creditNote: string; number: string | null; pdf: string | null; refund: string | null }> {
  const res = await f("https://api.stripe.com/v1/credit_notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `os-refund-${r.key}` },
    body: creditNoteForm(r, who).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => null)) as ({ id?: string; number?: string | null; pdf?: string | null } & Pick<RawNote, "refunds" | "refund"> & StripeErr) | null;
  if (!res.ok || !j?.id) throw new RefundError(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`, res.status === 400 ? 409 : 502);
  return { creditNote: j.id, number: j.number ?? null, pdf: j.pdf ?? null, refund: refundOf(j) };
}
