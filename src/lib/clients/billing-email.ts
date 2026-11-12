/*
 * Where a client's Stripe emails go (12 Nov). From the client, for Jeff Cook Real Estate: "Could you add the ability to
 * change to whom the invoices are delivered? I need alma.nowatzke@jeffcookrealestate.com to receive Jeff Cook Real
 * Estate invoices once their billing resumes next week."
 *
 * Stripe sends a customer's invoices, receipts and payment reminders to the customer's ONE email address. Its API has no
 * other recipients: extra (CC) addresses exist only in Stripe's dashboard, and the API can neither read nor set them.
 * So this changes that one address:
 *   - the Billing tab's people only (billing-access.ts), by name;
 *   - only a Stripe customer counted for this client, by the tab's own rules;
 *   - always a confirmation first, naming the old and the new address;
 *   - against the address the person saw: if Stripe has another by now, nothing is sent;
 *   - who changed it, and the address before, kept on the customer's metadata and in the OS log;
 *   - with a live key, only from os.brokerstaffer.com (a copy on a laptop changes nothing real).
 * Emails Stripe has sent are not sent again. An invoice not yet finalized (a draft) takes the new address; one already
 * finalized keeps the address it went to (both proven in TEST mode, 12 Nov: Stripe copies the address on finalizing).
 * Tested only in Stripe's TEST mode.
 */

import { z } from "zod";

type StripeErr = { error?: { message?: string } };

/** The longest address a mail server takes (RFC 5321). */
const MAX = 254;
/** Before the @: no spaces, no lists (commas, semicolons), no "Name <address>" form. */
const LOCAL = /^[^\s@,;:<>()[\]"]+$/;
/** A domain's part between dots: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Invisible characters (a zero-width space pasted from a web page, a reversing mark, NUL): the address would look right and bounce. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** The address as Stripe will get it, or null when it is not one email address. */
export function cleanEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (e.length > MAX || INVISIBLE.test(e)) return null;
  const parts = e.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!LOCAL.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  const top = labels[labels.length - 1];
  if (labels.length < 2 || !labels.every((l) => l.length <= 63 && LABEL.test(l)) || !/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(top)) return null;
  return e;
}

/** Stripe keeps an address as it was typed; the same address in other capitals is the same address. */
export const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export const invoiceEmailRequest = z.object({
  clientId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  customerId: z.string().regex(/^cus_[A-Za-z0-9]{8,64}$/),
  /** The address the person saw on the page (null: none). Refused when Stripe has another by now. */
  from: z.string().max(512).nullable(),
  /** The new address, as typed. */
  to: z.string().max(512),
});
export type InvoiceEmailRequest = z.infer<typeof invoiceEmailRequest>;

export class InvoiceEmailError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** With a live key, only the deployed OS changes a customer, asked on os.brokerstaffer.com itself. */
export function liveEmailRefusal(key: string, env: Record<string, string | undefined>, origin: string | null, site: string): string | null {
  if (!/^(sk|rk)_live_/.test(key)) return null;
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
  return onRailway && origin === site ? null : "Invoice emails are changed only from os.brokerstaffer.com.";
}

/** The customer as Stripe has it NOW. */
export interface CustomerNow {
  id: string;
  email: string | null;
  deleted: boolean;
}

type RawCustomer = { id?: string; email?: string | null; deleted?: boolean };

export async function customerNow(key: string, id: string, f: typeof fetch = fetch): Promise<CustomerNow> {
  const res = await f(`https://api.stripe.com/v1/customers/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json().catch(() => null)) as (RawCustomer & StripeErr) | null;
  if (res.status === 404) throw new InvoiceEmailError("Stripe has no such customer. Nothing was changed.", 404);
  if (!res.ok || !j?.id) throw new InvoiceEmailError(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`, 502);
  return { id: j.id, email: j.email ?? null, deleted: j.deleted === true };
}

export type EmailPlan = { kind: "send" } | { kind: "done"; message: string };

/** The checks before Stripe is asked, on the customer as Stripe has it now. */
export function planEmail(now: CustomerNow, from: string | null, to: string): EmailPlan {
  if (now.deleted) throw new InvoiceEmailError("This customer has been deleted in Stripe. Nothing was changed.", 409);
  if (sameEmail(now.email, to)) return { kind: "done", message: `Stripe already sends this customer's emails to ${to}.` };
  if (!sameEmail(now.email, from)) {
    throw new InvoiceEmailError(
      `Stripe has a different address for this customer than the page showed: it is now ${now.email ?? "empty"}. Nothing was changed. Close this to see it, and try again if it still needs changing.`,
      409,
    );
  }
  return { kind: "send" };
}

/** The request Stripe gets: the address, and who changed it from what (Stripe drops a metadata key set to ""). */
export function emailCall(customerId: string, to: string, from: string | null, who: string): { path: string; form: URLSearchParams } {
  const form = new URLSearchParams();
  form.set("email", to);
  form.set("metadata[os_email_by]", who);
  form.set("metadata[os_email_before]", from ?? "");
  return { path: `customers/${encodeURIComponent(customerId)}`, form };
}

export async function sendEmail(key: string, customerId: string, to: string, from: string | null, who: string, f: typeof fetch = fetch): Promise<CustomerNow> {
  const call = emailCall(customerId, to, from, who);
  const res = await f(`https://api.stripe.com/v1/${call.path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: call.form.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => null)) as (RawCustomer & StripeErr) | null;
  if (!res.ok || !j?.id) throw emailRefusal(res.status, j?.error?.message);
  return { id: j.id, email: j.email ?? null, deleted: j.deleted === true };
}

/* Stripe said no in a way that means nothing changed, or gave no clear answer (502: it may have gone through). */
export function emailRefusal(status: number, message: string | undefined): InvoiceEmailError {
  if (status === 400 || status === 402 || status === 404) return new InvoiceEmailError(`Stripe: ${message ?? `HTTP ${status}`}. Nothing was changed.`, 409);
  if (status === 429) return new InvoiceEmailError("Stripe is busy right now. Nothing was changed. Try again in a minute.", 503);
  if (status === 401 || status === 403) return new InvoiceEmailError("Stripe refused the OS's key. Nothing was changed.", 503);
  return new InvoiceEmailError(`Stripe: ${message ?? `HTTP ${status}`}`, 502);
}
