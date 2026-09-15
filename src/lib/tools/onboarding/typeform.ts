import { createHmac, timingSafeEqual } from "node:crypto";

import { TYPEFORM_FIELD_MAP } from "./typeform-field-map";

/*
 * Typeform webhook payload -> clients row. The tool's `lib/typeform.ts`, ported
 * verbatim. Pure: no server imports, so every rule here is under test.
 */

type TfAnswer = { type: string; field?: { ref?: string; id?: string; type?: string } } & Record<string, unknown>;
export type TfPayload = {
  form_response?: {
    token?: string;
    submitted_at?: string;
    answers?: TfAnswer[];
    definition?: { fields?: unknown[] };
  };
};

/** Verify Typeform-Signature: 'sha256=<base64 hmac>' over the raw body. */
export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function answerValue(a: TfAnswer): unknown {
  switch (a.type) {
    case "text": case "email": case "phone_number": case "url":
    case "short_text": case "long_text": return a[a.type] ?? a.text;
    case "number": return a.number;
    case "boolean": return a.boolean;
    case "choice": return (a.choice as { label?: string } | undefined)?.label;
    case "choices": return (a.choices as { labels?: string[] } | undefined)?.labels;
    case "date": return a.date;
    default: return a[a.type];
  }
}

/** { ref: value } from the response answers. */
function answersByRef(payload: TfPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of payload.form_response?.answers ?? []) {
    const ref = a.field?.ref;
    if (ref) out[ref] = answerValue(a);
  }
  return out;
}

/** Readable answer text for Slack/logs. */
function answerText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => answerText(x)).join(", ");
  if (typeof v === "object") return Object.values(v as object).filter(Boolean).map(String).join(", ");
  return String(v);
}

/**
 * Question/answer pairs in form order, titles from the payload's own definition
 * (contact_info subfields carry their titles under properties.fields).
 */
export function intakeQA(payload: TfPayload): { q: string; a: string; ref?: string }[] {
  const titles = new Map<string, string>();
  const walk = (fields?: unknown[]) => {
    for (const raw of fields ?? []) {
      const f = raw as { title?: string; id?: string; ref?: string; properties?: { fields?: unknown[] } };
      const t = (f.title ?? "").trim();
      if (t) { if (f.id) titles.set(f.id, t); if (f.ref) titles.set(f.ref, t); }
      walk(f.properties?.fields);
    }
  };
  walk(payload.form_response?.definition?.fields);

  const FALLBACK: Record<string, string> = { email: "Email", phone_number: "Phone number", url: "Website" };
  // contact_info subfields may lack titles in some payloads — label by answer type, not "Question".
  const CONTACT_FALLBACK: Record<string, string> = { text: "Name", email: "Email", phone_number: "Phone number" };
  return (payload.form_response?.answers ?? []).map((ans) => {
    const f = ans.field ?? {};
    const q = (f.id && titles.get(f.id)) ?? (f.ref && titles.get(f.ref))
      ?? (f.type === "contact_info" ? CONTACT_FALLBACK[ans.type] : undefined)
      ?? FALLBACK[ans.type] ?? "Question";
    return { q, a: answerText(answerValue(ans)), ref: f.ref };
  });
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
/** "Jane Smith jane@x.com" / "jane@x.com (Jane)" -> { name, email }. */
function parseContact(s: string): { name: string; email: string | null } | null {
  const email = s.match(EMAIL_RE)?.[0] ?? null;
  const name = s.replace(EMAIL_RE, "").replace(/[<>()|,;:–—-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name && !email) return null;
  return { name: name || (email as string), email };
}

export type IntakePerson = { name: string; email: string | null; role: string | null; is_dnc: boolean };

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
const M = TYPEFORM_FIELD_MAP as Record<string, unknown>;
const REFS = {
  intro: new Set(asList(M["_team.intro_contacts"])),
  title: new Set(asList(M["_team.intro_titles"])),
  office: new Set(asList(M["_team.office_contacts"])),
  dnc: new Set(asList(M["_dnc_exclude_list"])),
};

/**
 * People the client named in the Typeform: introduction contacts (+ their titles
 * from the follow-up question) and the do-not-contact exclusion list. Questions
 * are matched by stable field ref first (rewording-proof), title regex as fallback.
 */
export function teamFromIntake(payload: TfPayload): IntakePerson[] {
  const out: IntakePerson[] = [];
  let last: IntakePerson | null = null;
  for (const { q, a, ref } of intakeQA(payload)) {
    if (!a || a === "—") continue;
    const is = (set: Set<string>, re: RegExp) => (!!ref && set.has(ref)) || re.test(q);

    if (is(REFS.intro, /who (else )?should we introduce candidates to/i)) {
      const c = parseContact(a);
      if (c) { last = { ...c, role: null, is_dnc: false }; out.push(last); }
    } else if (is(REFS.title, /what title should we use/i)) {
      if (last) last.role = a.trim();
    } else if (is(REFS.office, /full name and email address for the contact at each office/i)) {
      for (const line of a.split(/\r?\n/)) {
        const c = parseContact(line);
        if (c) out.push({ ...c, role: null, is_dnc: false });
      }
      last = null;
    } else if (is(REFS.dnc, /list the names of the offices or agents to exclude/i)) {
      // Lines split on newline/semicolon. A comma line is kept WHOLE (offices like
      // "Keller Williams Realty, Inc." must exact-match) and multi-word comma parts
      // are added too (people lists like "John Smith, Jane Doe").
      for (const line of a.split(/\r?\n|;/)) {
        const whole = line.trim();
        if (!whole) continue;
        const parts = whole.includes(",")
          ? whole.split(",").map((s) => s.trim()).filter((s) => /\s/.test(s))
          : [];
        for (const name of [whole, ...parts]) {
          out.push({ name, email: null, role: "DNC (from intake)", is_dnc: true });
        }
      }
      last = null;
    }
  }
  return out;
}

// Q6 sales-volume buckets -> [min, max] ($). null max = open (no upper bound).
const SALES_VOLUME: Record<string, [number, number | null]> = {
  "$0 to $5M": [0, 5_000_000],
  "$5M to $10M": [5_000_000, 10_000_000],
  "$10M to $20M": [10_000_000, 20_000_000],
  "$20M to $50M": [20_000_000, 50_000_000],
  "Open to all profiles.": [0, null],
  "Other": [0, null],
};

const stringRef = (path: string): string => {
  const v = M[path];
  return typeof v === "string" ? v : "";
};

/** The "Who helped you get started?" answer, if it's a real salesperson (not "I did it myself"). */
export function referralSalesperson(payload: TfPayload): string | null {
  const v = answersByRef(payload);
  const val = v[stringRef("_referral")];
  if (typeof val !== "string") return null;
  return /myself/i.test(val) ? null : val.trim() || null;
}

// MLS dropdown answers arrive as "Name (CODE)" — extract the CODE for exact DB matching.
function mlsCode(label: unknown): string | null {
  if (typeof label !== "string" || !label.trim()) return null;
  const m = label.match(/\(([^)]+)\)\s*$/);
  return (m ? m[1] : label).trim();
}

export interface ClientRowInput {
  typeform_response_id: string | null;
  status: "new";
  client_name: string | null;
  brand: string | null;
  office_name: string | null;
  primary_contact: { name: string | null; email: string | null; phone: null; role: string | null };
  mls: string | null;
  location: string | null;
  timezone: null;
  filters: {
    sales_volume_min: number;
    sales_volume_max: number | null;
    closed_transactions_min: number;
    closed_transactions_max: number;
  };
  sender_name: null;
  raw_typeform: TfPayload;
}

/** Build the orch_clients row from a Typeform submission. */
export function toClientRow(payload: TfPayload): ClientRowInput {
  const v = answersByRef(payload);
  const g = (path: string) => v[stringRef(path)];
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

  const clientName = str(g("client.client_name"));
  const sv = SALES_VOLUME[g("_sales_volume_choice") as string] ?? undefined;

  return {
    typeform_response_id: payload.form_response?.token ?? null,
    status: "new",
    client_name: clientName,
    brand: clientName,       // brokerage name doubles as brand/office for DNC exact-exclude
    office_name: clientName,
    primary_contact: {
      name: str(g("client.primary_contact.name")),
      email: str(g("client.primary_contact.email")),
      phone: null,
      role: str(g("client.primary_contact.role")),  // title for intro macro
    },
    mls: mlsCode(g("client.mls")),                         // store MLS CODE for matching
    location: str(g("client.location")),                   // counties/cities they recruit in
    timezone: null,                                        // not asked; derived later
    filters: {
      sales_volume_min: sv ? sv[0] : 0,
      sales_volume_max: sv ? sv[1] : 5_000_000,
      closed_transactions_min: 0,                          // not asked in form; spec default
      closed_transactions_max: 5,
    },
    sender_name: null,       // Nicole/Sarah/Ashley assigned internally (step 3)
    raw_typeform: payload,
  };
}
