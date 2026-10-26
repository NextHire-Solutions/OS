/*
 * A fake Stripe (test mode) behind an injected fetch — for the pay-per-lead
 * tests. No test reaches Stripe: the real stripe.ts is pointed at this, and
 * it answers the handful of endpoints pay per lead uses with the shapes
 * Stripe returns, keeps the objects in memory, and honours Idempotency-Key the
 * way Stripe does (same key + same request → the first answer again; same key
 * + a different request → 400 idempotency_error).
 *
 * Every request is recorded in `calls`; any request whose key is not a TEST
 * key is recorded in `liveKeySeen` (tests assert it stays empty) and refused.
 */

type Json = Record<string, unknown>;

export interface StripeCall {
  method: string;
  path: string;
  params: Record<string, string>;
  idempotencyKey: string | null;
}

interface Invoice extends Json {
  id: string;
  status: string;
  total: number;
  lines: Array<{ id: string; amount: number; description: string; metadata: Record<string, string> }>;
}

function nested(params: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const m = k.match(new RegExp(`^${prefix}\\[([^\\]]+)\\]$`));
    if (m) out[m[1]] = v;
  }
  return out;
}

export class FakeStripe {
  readonly calls: StripeCall[] = [];
  readonly liveKeySeen: string[] = [];
  readonly customers = new Map<string, Json>();
  readonly sessions = new Map<string, Json>();
  readonly invoices = new Map<string, Invoice>();
  readonly paymentMethods = new Map<string, Json>();
  private idem = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  private n = 0;
  /** The next /pay is refused as a declined card (consumed). */
  declineNextPay = false;
  /** Fail every request matching this (a lost answer, an outage). */
  failWhen: ((c: StripeCall) => boolean) | null = null;

  private id(prefix: string) {
    this.n += 1;
    return `${prefix}_test${String(this.n).padStart(6, "0")}`;
  }

  reset() {
    this.calls.length = 0;
    this.liveKeySeen.length = 0;
    this.customers.clear();
    this.sessions.clear();
    this.invoices.clear();
    this.paymentMethods.clear();
    this.idem.clear();
    this.declineNextPay = false;
    this.failWhen = null;
  }

  /** Stripe keeps idempotency keys for at least 24 hours; this is "a day later". */
  forgetIdempotencyKeys() {
    this.idem.clear();
  }

  creates(path: RegExp): StripeCall[] {
    return this.calls.filter((c) => c.method === "POST" && path.test(c.path));
  }

  /** The person finishes the Checkout page with Stripe's 4242 card. */
  completeSetup(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    const pm = { id: this.id("pm"), object: "payment_method", livemode: false, customer: s.customer, card: { brand: "visa", last4: "4242" } };
    this.paymentMethods.set(pm.id, pm);
    Object.assign(s, { status: "complete", setup_intent: { id: this.id("seti"), object: "setup_intent", payment_method: pm } });
  }

  /** The client pays an open invoice through its link. */
  payByLink(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error(`no invoice ${invoiceId}`);
    Object.assign(inv, { status: "paid", amount_paid: inv.total, amount_due: 0 });
  }

  private view(inv: Invoice): Json {
    const { lines, ...rest } = inv;
    return { ...rest, lines: { object: "list", data: lines.slice(0, 10), has_more: lines.length > 10 } };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "api.stripe.com") throw new Error(`fake-stripe: not Stripe: ${url.href}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    const path = url.pathname.replace(/^\/v1/, "");
    const params: Record<string, string> = {};
    const src = method === "GET" || method === "DELETE" ? url.searchParams : new URLSearchParams(String(init?.body ?? ""));
    for (const [k, v] of src) params[k] = v;
    const call: StripeCall = { method, path, params, idempotencyKey: headers.get("idempotency-key") };
    this.calls.push(call);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!/^Bearer (sk|rk)_test_/.test(auth)) {
      this.liveKeySeen.push(path);
      return reply(401, { error: { type: "invalid_request_error", message: "fake-stripe: only test keys" } });
    }
    if (this.failWhen?.(call)) return reply(500, { error: { type: "api_error", message: "injected failure" } });

    const fingerprint = `${method} ${path} ${JSON.stringify(params)}`;
    if (call.idempotencyKey) {
      const seen = this.idem.get(call.idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== fingerprint) return reply(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
        return reply(seen.status, seen.body);
      }
    }
    const [status, body] = this.handle(method, path, params);
    if (call.idempotencyKey && method === "POST") this.idem.set(call.idempotencyKey, { fingerprint, status, body });
    return reply(status, body);
  };

  private handle(method: string, path: string, p: Record<string, string>): [number, unknown] {
    const notFound: [number, unknown] = [404, { error: { type: "invalid_request_error", message: `No such resource: ${path}` } }];
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/customers") {
      const c = { id: this.id("cus"), object: "customer", livemode: false, name: p.name ?? null, email: p.email ?? null, metadata: nested(p, "metadata"), invoice_settings: { default_payment_method: null } };
      this.customers.set(c.id, c);
      return [200, c];
    }
    if ((m = path.match(/^\/customers\/([^/]+)$/))) {
      const c = this.customers.get(m[1]);
      if (!c) return notFound;
      if (method === "DELETE") { this.customers.delete(m[1]); return [200, { id: m[1], object: "customer", deleted: true }]; }
      if (method === "POST") {
        const pm = p["invoice_settings[default_payment_method]"];
        if (pm) (c.invoice_settings as Json).default_payment_method = pm;
        return [200, c];
      }
      return [200, c];
    }
    if (method === "POST" && path === "/checkout/sessions") {
      if (p.mode !== "setup") return [400, { error: { message: "fake-stripe: only setup sessions" } }];
      const id = this.id("cs");
      const s = { id, object: "checkout.session", livemode: false, mode: "setup", status: "open", customer: p.customer, url: `https://checkout.stripe.com/c/pay/${id}`, success_url: p.success_url, metadata: nested(p, "metadata"), setup_intent: null };
      this.sessions.set(id, s);
      return [200, s];
    }
    if ((m = path.match(/^\/checkout\/sessions\/([^/]+)$/)) && method === "GET") {
      const s = this.sessions.get(m[1]);
      return s ? [200, s] : notFound;
    }
    if ((m = path.match(/^\/payment_methods\/([^/]+)\/attach$/)) && method === "POST") {
      if (!this.customers.has(p.customer)) return notFound;
      const pm = { id: this.id("pm"), object: "payment_method", livemode: false, customer: p.customer, card: { brand: "visa", last4: "4242" } };
      this.paymentMethods.set(pm.id, pm);
      return [200, pm];
    }
    if ((m = path.match(/^\/payment_methods\/([^/]+)$/)) && method === "GET") {
      const pm = this.paymentMethods.get(m[1]);
      return pm ? [200, pm] : notFound;
    }
    if (method === "POST" && path === "/invoices") {
      if (!this.customers.has(p.customer)) return notFound;
      const inv: Invoice = {
        id: this.id("in"), object: "invoice", livemode: false, customer: p.customer, status: "draft", number: null, total: 0, amount_paid: 0, amount_due: 0,
        created: Math.floor(Date.now() / 1000), collection_method: p.collection_method, auto_advance: p.auto_advance === "true", description: p.description ?? null,
        default_payment_method: p.default_payment_method ?? null, pending_invoice_items_behavior: p.pending_invoice_items_behavior,
        metadata: nested(p, "metadata"), hosted_invoice_url: null, invoice_pdf: null, lines: [],
      };
      this.invoices.set(inv.id, inv);
      return [200, this.view(inv)];
    }
    if (method === "POST" && path === "/invoiceitems") {
      const inv = this.invoices.get(p.invoice);
      if (!inv) return notFound;
      if (inv.status !== "draft") return [400, { error: { message: "fake-stripe: invoice is not a draft" } }];
      const item = { id: this.id("ii"), amount: Number(p.amount), description: p.description, metadata: nested(p, "metadata") };
      inv.lines.push(item);
      inv.total += item.amount;
      inv.amount_due = inv.total;
      return [200, { ...item, object: "invoiceitem", livemode: false, invoice: inv.id }];
    }
    if ((m = path.match(/^\/invoices\/([^/]+)\/lines$/)) && method === "GET") {
      const inv = this.invoices.get(m[1]);
      if (!inv) return notFound;
      const limit = Number(p.limit ?? 10);
      const from = p.starting_after ? inv.lines.findIndex((l) => l.id === p.starting_after) + 1 : 0;
      const data = inv.lines.slice(from, from + limit).map((l) => ({ ...l, object: "line_item" }));
      return [200, { object: "list", data, has_more: from + limit < inv.lines.length }];
    }
    if ((m = path.match(/^\/invoices\/([^/]+)\/finalize$/)) && method === "POST") {
      const inv = this.invoices.get(m[1]);
      if (!inv) return notFound;
      if (inv.status !== "draft") return [400, { error: { message: "fake-stripe: already finalized" } }];
      Object.assign(inv, { status: "open", number: `TEST-${inv.id.slice(-4)}`, hosted_invoice_url: `https://invoice.stripe.com/i/${inv.id}`, invoice_pdf: `https://pay.stripe.com/invoice/${inv.id}/pdf`, amount_due: inv.total });
      return [200, this.view(inv)];
    }
    if ((m = path.match(/^\/invoices\/([^/]+)\/pay$/)) && method === "POST") {
      const inv = this.invoices.get(m[1]);
      if (!inv) return notFound;
      if (inv.status !== "open") return [400, { error: { message: `fake-stripe: invoice is ${inv.status}` } }];
      if (this.declineNextPay) {
        this.declineNextPay = false;
        return [402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }];
      }
      Object.assign(inv, { status: "paid", amount_paid: inv.total, amount_due: 0 });
      return [200, this.view(inv)];
    }
    if ((m = path.match(/^\/invoices\/([^/]+)$/)) && method === "GET") {
      const inv = this.invoices.get(m[1]);
      return inv ? [200, this.view(inv)] : notFound;
    }
    if (path === "/invoices" && method === "GET") {
      const data = [...this.invoices.values()].filter((i) => i.customer === p.customer).reverse().slice(0, Number(p.limit ?? 10)).map((i) => this.view(i));
      return [200, { object: "list", data, has_more: false }];
    }
    return notFound;
  }
}
