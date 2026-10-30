/*
 * Pay per lead — the Stripe calls (26 Oct 2026; live clients 31 Oct).
 *
 * Plain fetch, injected, so the unit tests never reach Stripe. Each client is
 * built for ONE mode: "test" (a test client, the test key) or "live" (a client
 * gone live, the OS's live key). The key is checked to be of that mode
 * (stripe-key.ts) before the client is built AND before every request, and an
 * answer from the other mode is refused. Making customers and card-setup pages
 * is test-only: a live client's card is the one already on file in Stripe.
 *
 * Every call that creates, finalizes or pays carries an Idempotency-Key
 * derived from the client and the period (model.ts periodKey): a retry — a
 * lost answer, a second server, a resumed run — gets back what the first call
 * made. Stripe keeps those keys for at least 24 hours; past that, a resumed
 * run first looks for the period's invoice by its metadata (findPeriodInvoice)
 * before making one.
 *
 * Endpoints used (Stripe API reference, https://docs.stripe.com/api):
 *   POST   /v1/customers                          create a customer
 *   DELETE /v1/customers/{id}                     delete one (test clean-up only)
 *   POST   /v1/customers/{id}                     invoice_settings[default_payment_method]
 *   POST   /v1/checkout/sessions                  mode=setup — the page where a card is saved
 *   GET    /v1/checkout/sessions/{id}             read it back (expand setup_intent.payment_method)
 *   POST   /v1/payment_methods/{id}/attach        attach a card (the E2E script's pm_card_visa)
 *   GET    /v1/payment_methods/{id}               the card's brand and last four
 *   POST   /v1/invoices                           a draft invoice, charge_automatically, auto_advance=false
 *   POST   /v1/invoiceitems                       one line per lead, on that invoice
 *   GET    /v1/invoices/{id}                      the invoice now
 *   DELETE /v1/invoices/{id}                      a draft that didn't match its leads (never finalized, never charged)
 *   GET    /v1/invoices/{id}/lines                its lines
 *   POST   /v1/invoices/{id}/finalize             finalize (auto_advance=false: we pay it ourselves)
 *   POST   /v1/invoices/{id}/pay                  charge the saved card now
 *   GET    /v1/invoices?customer=…                the customer's invoices (history, and the resume check)
 *   GET    /v1/customers                          test mode: the client's test customers (metadata os_client_id)
 *   GET    /v1/payment_methods?customer=…&type=card  the cards on file
 */

import { assertKeyFor, type UsageMode } from "./stripe-key.ts";
import { lineDescription, periodLabel, shortHash, type BillableLead, type Period } from "./model.ts";

const API = "https://api.stripe.com/v1";

export class UsageStripeError extends Error {
  readonly status: number;
  readonly type: string | null;
  readonly code: string | null;
  constructor(message: string, status: number, type: string | null = null, code: string | null = null) {
    super(message);
    this.name = "UsageStripeError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

type Json = Record<string, unknown>;
type Params = Record<string, string | number | boolean | null | undefined>;

export interface InvoiceSummary {
  id: string;
  number: string | null;
  status: string;
  /** Cents. */
  total: number;
  amountPaid: number;
  amountDue: number;
  created: number;
  description: string | null;
  /** Stripe's page to pay it — only while it is open (unpaid). */
  payUrl: string | null;
  /** Stripe's page for it (any status), and its PDF. */
  hostedUrl: string | null;
  pdf: string | null;
  periodKey: string | null;
  test: boolean;
  /** The customer it is billed to. */
  customerId: string | null;
}

export interface InvoiceLine {
  id: string;
  description: string | null;
  amount: number;
  leadKey: string | null;
}

/** One card on a customer, as the screen shows it: "Visa •••• 4242", "08/27". */
export interface CardOnFile {
  id: string;
  label: string;
  expires: string | null;
  expired: boolean;
  /** The customer's default for invoices (or its default source). */
  isDefault: boolean;
}

export interface CustomerCards {
  id: string;
  name: string | null;
  email: string | null;
  cards: CardOnFile[];
}

export interface UsageStripe {
  /** Which Stripe this client talks to — every request's key, and every answer, is of this mode. */
  readonly mode: UsageMode;
  createCustomer(o: { osClientId: string; name: string; email?: string | null; idempotencyKey: string }): Promise<{ id: string }>;
  deleteCustomer(customerId: string): Promise<void>;
  setupCheckout(o: { customerId: string; osClientId: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
  readSetupSession(sessionId: string): Promise<{ id: string; status: string | null; customerId: string | null; paymentMethodId: string | null; cardLabel: string | null }>;
  attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<{ id: string; cardLabel: string | null }>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  /** A draft invoice for one period: charge_automatically, auto_advance=false, nothing on it yet. */
  createDraftInvoice(o: {
    customerId: string; paymentMethodId: string | null; osClientId: string; period: Period; periodKey: string;
    description: string; leadCount: number;
    /** Which claim of the period this is (billing.ts): a period opened again after its draft was removed gets a new invoice, not the old answer. */
    attempt?: string;
  }): Promise<{ invoiceId: string }>;
  /** One lead's line, on that invoice. */
  addLeadLine(o: { customerId: string; invoiceId: string; periodKey: string; lead: BillableLead; priceCents: number }): Promise<{ id: string }>;
  /** Both: the draft, then one line per lead. */
  createPeriodInvoice(o: {
    customerId: string; paymentMethodId: string | null; osClientId: string; period: Period; periodKey: string;
    description: string; leads: BillableLead[]; priceCents: number;
  }): Promise<{ invoiceId: string }>;
  getInvoice(invoiceId: string): Promise<InvoiceSummary>;
  /** Removes an invoice that is still a DRAFT (never finalized, so never charged). Stripe refuses any other. */
  deleteDraftInvoice(invoiceId: string): Promise<void>;
  invoiceLines(invoiceId: string): Promise<InvoiceLine[]>;
  finalizeInvoice(invoiceId: string, idempotencyKey: string): Promise<InvoiceSummary>;
  /**
   * Charges the saved card (or `paymentMethodId`). A refused card — or one whose bank wants the client to confirm the
   * payment (3-D Secure) — is an answer, not an error: { ok: false, error, code }.
   */
  payInvoice(invoiceId: string, idempotencyKey: string, paymentMethodId?: string | null): Promise<{ ok: true; invoice: InvoiceSummary } | { ok: false; error: string; code: string | null }>;
  /** A customer and its cards on file; null if it does not exist or was deleted. */
  cardsOnFile(customerId: string, now?: Date): Promise<CustomerCards | null>;
  /** TEST mode only: the customers made for this client (metadata os_client_id). */
  testCustomersOf(osClientId: string): Promise<string[]>;
  findPeriodInvoice(customerId: string, periodKey: string): Promise<InvoiceSummary | null>;
  listInvoices(customerId: string, limit?: number): Promise<InvoiceSummary[]>;
}

function form(params: Params): string {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) f.set(k, String(v));
  return f.toString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function cardLabelOf(pm: unknown): string | null {
  const card = (pm as { card?: { brand?: unknown; last4?: unknown } } | null)?.card;
  if (!card || typeof card.last4 !== "string") return null;
  const brand = typeof card.brand === "string" ? card.brand.replace(/^\w/, (c) => c.toUpperCase()) : "Card";
  return `${brand} •••• ${card.last4}`;
}

export function invoiceSummary(j: Json): InvoiceSummary {
  const status = str(j.status) ?? "unknown";
  const meta = (j.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(j.id ?? ""),
    number: str(j.number),
    status,
    total: num(j.total),
    amountPaid: num(j.amount_paid),
    amountDue: num(j.amount_due),
    created: num(j.created),
    description: str(j.description),
    payUrl: status === "open" ? str(j.hosted_invoice_url) : null,
    hostedUrl: str(j.hosted_invoice_url),
    pdf: str(j.invoice_pdf),
    periodKey: str(meta.os_usage_period),
    test: j.livemode === false,
    customerId: typeof j.customer === "string" ? j.customer : j.customer && typeof j.customer === "object" ? str((j.customer as Json).id) : null,
  };
}

/** A card from before Stripe's PaymentMethods (card_…, src_…): an invoice takes it as its default SOURCE. */
const isSourceId = (id: string) => /^(card|src)_/.test(id);

/** "08/27", and whether the card has expired by `now` (it works to the end of its month). */
function expiryOf(card: { exp_month?: unknown; exp_year?: unknown } | undefined, now: Date): { expires: string | null; expired: boolean } {
  const m = Number(card?.exp_month), y = Number(card?.exp_year);
  if (!Number.isInteger(m) || !Number.isInteger(y) || m < 1 || m > 12) return { expires: null, expired: false };
  const expired = y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1);
  return { expires: `${String(m).padStart(2, "0")}/${String(y).slice(-2)}`, expired };
}

/**
 * The client for one key, in one mode. Throws (UsageBillingKeyError) for a key
 * of another mode before a single request is built; `f` is the fetch it uses
 * (tests inject one).
 */
export function usageStripe(key: string, f: typeof fetch = fetch, mode: UsageMode = "test"): UsageStripe {
  assertKeyFor(mode, key);
  const testOnly = (what: string) => {
    if (mode !== "test") throw new UsageStripeError(`${what} is for test clients only — a live client's card is the one already on file in Stripe.`, 400);
  };

  async function call(method: "GET" | "POST" | "DELETE", path: string, params?: Params, idempotencyKey?: string): Promise<Json> {
    // Belt and braces: checked again at the moment of the request.
    const k = assertKeyFor(mode, key);
    const query = method === "GET" && params ? `?${form(params)}` : "";
    const headers: Record<string, string> = { Authorization: `Bearer ${k}` };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await f(`${API}${path}${query}`, {
      method,
      headers,
      body: method === "POST" ? form(params ?? {}) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok || !j) {
      const e = (j?.error ?? {}) as { message?: string; type?: string; code?: string };
      throw new UsageStripeError(`Stripe: ${e.message ?? `HTTP ${res.status}`}`, res.status, e.type ?? null, e.code ?? null);
    }
    // An object of the other mode can only come back for a key of the other mode, which never gets here — but never trust it silently.
    if (mode === "test" && j.livemode === true) throw new UsageStripeError("Stripe answered in LIVE mode for a test client — refused.", 500);
    if (mode === "live" && j.livemode === false) throw new UsageStripeError("Stripe answered in TEST mode for a live client — refused.", 500);
    return j;
  }

  const enc = encodeURIComponent;

  const api: UsageStripe = {
    mode,

    async createCustomer(o) {
      testOnly("Making a Stripe customer");
      const j = await call("POST", "/customers", {
        name: o.name.slice(0, 250),
        email: o.email ?? undefined,
        description: "BrokerStaffer pay per lead (test mode)",
        "metadata[os_client_id]": o.osClientId,
        "metadata[os_usage_billing]": "1",
      }, o.idempotencyKey);
      return { id: String(j.id) };
    },

    async deleteCustomer(customerId) {
      testOnly("Deleting a Stripe customer");
      await call("DELETE", `/customers/${enc(customerId)}`);
    },

    async setupCheckout(o) {
      testOnly("A card-setup page");
      const j = await call("POST", "/checkout/sessions", {
        mode: "setup",
        customer: o.customerId,
        "payment_method_types[0]": "card",
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
        "metadata[os_client_id]": o.osClientId,
        "metadata[os_usage_billing]": "1",
        "setup_intent_data[metadata][os_client_id]": o.osClientId,
      });
      if (typeof j.url !== "string") throw new UsageStripeError("Stripe returned no Checkout page.", 502);
      return { id: String(j.id), url: j.url };
    },

    async readSetupSession(sessionId) {
      testOnly("A card-setup page");
      const j = await call("GET", `/checkout/sessions/${enc(sessionId)}`, { "expand[0]": "setup_intent.payment_method" });
      const si = (j.setup_intent ?? null) as Json | string | null;
      const pm = si && typeof si === "object" ? si.payment_method : null;
      return {
        id: String(j.id),
        status: str(j.status),
        customerId: str(j.customer),
        paymentMethodId: typeof pm === "string" ? pm : pm && typeof pm === "object" ? str((pm as Json).id) : null,
        cardLabel: pm && typeof pm === "object" ? cardLabelOf(pm) : null,
      };
    },

    async attachPaymentMethod(paymentMethodId, customerId) {
      testOnly("Attaching a card");
      const j = await call("POST", `/payment_methods/${enc(paymentMethodId)}/attach`, { customer: customerId });
      return { id: String(j.id), cardLabel: cardLabelOf(j) };
    },

    async setDefaultPaymentMethod(customerId, paymentMethodId) {
      testOnly("Changing a customer's default card");
      await call("POST", `/customers/${enc(customerId)}`, { "invoice_settings[default_payment_method]": paymentMethodId });
    },

    async createDraftInvoice(o) {
      // The invoice first, as a draft — then each lead's line ON it (`invoice=`), so no stray
      // pending item of the customer's can ever ride along.
      const inv = await call("POST", "/invoices", {
        customer: o.customerId,
        currency: "usd",
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        // A card on file from before Stripe's PaymentMethods (card_…/src_…) is the invoice's default SOURCE.
        default_payment_method: o.paymentMethodId && !isSourceId(o.paymentMethodId) ? o.paymentMethodId : undefined,
        default_source: o.paymentMethodId && isSourceId(o.paymentMethodId) ? o.paymentMethodId : undefined,
        // Never the customer's own coupon: the invoice is exactly the leads approved (Stripe: "Pass an empty string to
        // avoid inheriting any discounts"). Without it a customer with a coupon gets a total the check refuses.
        discounts: "",
        description: o.description,
        "metadata[os_client_id]": o.osClientId,
        "metadata[os_usage_period]": o.periodKey,
        "metadata[os_usage_period_label]": periodLabel(o.period),
        "metadata[os_usage_leads]": o.leadCount,
        "metadata[os_usage_mode]": mode,
        "metadata[os_usage_test]": mode === "test" ? "1" : undefined,
      }, o.attempt ? `${o.periodKey}:invoice:${o.attempt}` : `${o.periodKey}:invoice`);
      return { invoiceId: String(inv.id) };
    },

    async addLeadLine(o) {
      const j = await call("POST", "/invoiceitems", {
        customer: o.customerId,
        invoice: o.invoiceId,
        currency: "usd",
        amount: o.priceCents,
        description: lineDescription(o.lead),
        "metadata[os_lead_key]": o.lead.key.slice(0, 500),
        "metadata[os_usage_period]": o.periodKey,
      // Per invoice and lead: a resume adds a missing line to the same invoice once; a new invoice for the period gets its own.
      }, `${o.periodKey}:item:${o.invoiceId}:${shortHash(o.lead.key)}`);
      return { id: String(j.id) };
    },

    async createPeriodInvoice(o) {
      const { invoiceId } = await api.createDraftInvoice({ ...o, leadCount: o.leads.length });
      for (const lead of o.leads) await api.addLeadLine({ customerId: o.customerId, invoiceId, periodKey: o.periodKey, lead, priceCents: o.priceCents });
      return { invoiceId };
    },

    async getInvoice(invoiceId) {
      return invoiceSummary(await call("GET", `/invoices/${enc(invoiceId)}`));
    },

    async deleteDraftInvoice(invoiceId) {
      await call("DELETE", `/invoices/${enc(invoiceId)}`);
    },

    async invoiceLines(invoiceId) {
      const out: InvoiceLine[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const j = await call("GET", `/invoices/${enc(invoiceId)}/lines`, { limit: 100, starting_after: after });
        const data = (j.data as Json[] | undefined) ?? [];
        for (const l of data) {
          out.push({ id: String(l.id), description: str(l.description), amount: num(l.amount), leadKey: str(((l.metadata ?? {}) as Json).os_lead_key) });
        }
        if (!j.has_more || !data.length) break;
        after = String(data[data.length - 1].id);
      }
      return out;
    },

    async finalizeInvoice(invoiceId, idempotencyKey) {
      return invoiceSummary(await call("POST", `/invoices/${enc(invoiceId)}/finalize`, { auto_advance: false }, idempotencyKey));
    },

    async payInvoice(invoiceId, idempotencyKey, paymentMethodId) {
      try {
        const card = paymentMethodId ? (isSourceId(paymentMethodId) ? { source: paymentMethodId } : { payment_method: paymentMethodId }) : {};
        return { ok: true, invoice: invoiceSummary(await call("POST", `/invoices/${enc(invoiceId)}/pay`, card, idempotencyKey)) };
      } catch (e) {
        // A refused card (402, card_error) — or 3-D Secure wanted (402, invoice_payment_intent_requires_action) — leaves the invoice open and payable by its link.
        if (e instanceof UsageStripeError && (e.status === 402 || e.type === "card_error")) {
          const error = e.code === "invoice_payment_intent_requires_action"
            ? "The client's bank wants them to confirm this payment themselves (3-D Secure) — send them the invoice's pay link."
            : e.message;
          return { ok: false, error, code: e.code };
        }
        throw e;
      }
    },

    async findPeriodInvoice(customerId, periodKey) {
      const j = await call("GET", "/invoices", { customer: customerId, limit: 100 });
      const hit = ((j.data as Json[] | undefined) ?? []).find((i) => ((i.metadata ?? {}) as Json).os_usage_period === periodKey && i.status !== "void");
      return hit ? invoiceSummary(hit) : null;
    },

    async listInvoices(customerId, limit = 24) {
      const j = await call("GET", "/invoices", { customer: customerId, limit: Math.max(1, Math.min(100, limit)) });
      return ((j.data as Json[] | undefined) ?? []).map(invoiceSummary);
    },

    async cardsOnFile(customerId, now = new Date()) {
      let c: Json;
      try {
        c = await call("GET", `/customers/${enc(customerId)}`);
      } catch (e) {
        if (e instanceof UsageStripeError && e.status === 404) return null;
        throw e;
      }
      if (c.deleted === true) return null;
      const settings = (c.invoice_settings ?? {}) as Json;
      const dpm = settings.default_payment_method;
      const defaults = new Set([typeof dpm === "string" ? dpm : dpm && typeof dpm === "object" ? str((dpm as Json).id) : null, str(c.default_source)].filter((x): x is string => !!x));
      const list = await call("GET", "/payment_methods", { customer: customerId, type: "card", limit: 20 });
      const cards = ((list.data as Json[] | undefined) ?? []).map((pm) => {
        const card = pm.card as { exp_month?: unknown; exp_year?: unknown } | undefined;
        return { id: String(pm.id), label: cardLabelOf(pm) ?? "Card", ...expiryOf(card, now), isDefault: defaults.has(String(pm.id)) };
      });
      // The default first, then the rest as Stripe lists them (newest first).
      cards.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      return { id: String(c.id), name: str(c.name), email: str(c.email), cards };
    },

    async testCustomersOf(osClientId) {
      testOnly("Looking up test customers");
      const out: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 3; page++) {
        const j = await call("GET", "/customers", { limit: 100, starting_after: after });
        const data = (j.data as Json[] | undefined) ?? [];
        for (const c of data) if (((c.metadata ?? {}) as Json).os_client_id === osClientId) out.push(String(c.id));
        if (!j.has_more || !data.length) break;
        after = String(data[data.length - 1].id);
      }
      return out;
    },
  };
  return api;
}
